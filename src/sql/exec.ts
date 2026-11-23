// Runs one prepared statement on SQLite and builds its PostgreSQL result.
// DDL and its shadow-catalog update commit together in one transactionSync.
import { PgError, type Field, type Result } from "../postgres/wire";
import { annotate } from "./polyglot";
import { applyChanges, changesOf, loadCatalog, outputTypes, paramTypes, schemaOf } from "./catalog";
import { expandDefaults } from "./defaults";
import { addConstraint } from "./rebuild";
import { show, type Session } from "./session";
import type { Statement } from "./statement";
import { translate } from "./translate";
import { decodeParam, encodeValue, inferType, typeByOid, type PgType } from "./types";

export type Runnable = Exclude<Statement, { kind: "transaction" }>;
export type Params = (string | null)[];

export function sqliteErrorToPg(e: unknown): PgError {
  if (e instanceof PgError) return e;
  const m = String((e as Error)?.message ?? e).replace(/: SQLITE_\w+.*$/, "");
  if (/UNIQUE constraint failed/.test(m)) return new PgError("23505", `duplicate key value violates unique constraint (${m})`);
  if (/NOT NULL constraint failed/.test(m)) return new PgError("23502", `null value violates not-null constraint (${m})`);
  if (/FOREIGN KEY constraint failed/.test(m)) return new PgError("23503", `violates foreign key constraint (${m})`);
  if (/no such table/.test(m)) return new PgError("42P01", `relation does not exist (${m})`);
  if (/no such column/.test(m)) return new PgError("42703", m);
  return new PgError("42601", m);
}

export function run(stmt: Runnable, params: Params, s: Session, paramOids: number[] = []): Result {
  try {
    switch (stmt.kind) {
      case "show":
        return show(stmt.name);
      case "noop":
        return { kind: "command", tag: stmt.tag };
      case "catalog":
        return stmt.result;
      case "addConstraint":
        addConstraint(stmt.table, stmt.constraint, s);
        return { kind: "command", tag: "ALTER TABLE" };
      case "sql":
        return runSql(stmt, params, s, paramOids);
    }
  } catch (e) {
    throw sqliteErrorToPg(e);
  }
}

/** PostgreSQL `$n` -> SQLite `?n` (numbered, so reuse and reordering work). Skips string literals. */
const numberParams = (sql: string) => sql.replace(/'(?:[^']|'')*'|\$(\d+)/g, (m, n) => (n ? `?${n}` : m));

/** SQLite wants exactly as many values as the highest ?n in the statement. */
const highestParam = (sql: string) => Math.max(0, ...[...sql.matchAll(/'(?:[^']|'')*'|\?(\d+)/g)].map((m) => Number(m[1] ?? 0)));

function runSql(stmt: Extract<Statement, { kind: "sql" }>, rawParams: Params, s: Session, paramOids: number[]): Result {
  const catalog = loadCatalog(s.sql);
  const [typed] = annotate(stmt.pg, schemaOf(catalog));
  const inferred = paramTypes(typed, catalog);
  const params = rawParams.map((v, i) => decodeParam(v, typeByOid(paramOids[i] ?? 0) ?? inferred.get(i + 1)));
  const sqlite = (expandDefaults(stmt.node) ?? [stmt.pg]).flatMap(translate).map(numberParams);

  // A translation can be several SQLite statements; rows from all of them form the result.
  const execute = () => {
    let names: string[] = [];
    const rows: unknown[][] = [];
    let changed = 0;
    for (const q of sqlite) {
      const cursor = s.sql.exec(q, ...params.slice(0, highestParam(q)));
      const batch = [...cursor.raw()] as unknown[][];
      if (cursor.columnNames.length) {
        names = cursor.columnNames;
        rows.push(...batch);
      }
      if (stmt.dml) changed += Number(s.sql.exec("SELECT changes()").one()["changes()"]);
    }
    return { names, rows, changed };
  };

  const changes = changesOf(stmt.node);
  let res: ReturnType<typeof execute>;
  if (changes.length) {
    const existed = new Set([...s.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").raw()].map(([n]) => String(n)));
    const ddl = () => {
      const r = execute();
      applyChanges(s.sql, changes, (t) => existed.has(t));
      return r;
    };
    res = s.inSync ? ddl() : s.storage.transactionSync(ddl);
  } else res = execute();

  const tag = stmt.tag === "INSERT" ? `INSERT 0 ${res.changed}`
    : stmt.dml ? `${stmt.tag} ${res.changed}`
    : stmt.tag === "SELECT" ? `SELECT ${res.rows.length}`
    : stmt.tag;
  if (!res.names.length) return { kind: "command", tag };
  return rowsResult(res.names, res.rows, tag, outputTypes(typed, catalog, res.names.length));
}

/** PostgreSQL names an unaliased `COUNT(*)` column `count`; SQLite names it `COUNT(*)`. */
function pgColumnName(name: string): string {
  const m = /^(\w+)\(.*\)$/s.exec(name);
  return m ? m[1].toLowerCase() : name;
}

/** Result columns typed from the catalog where known, otherwise from their values. */
function rowsResult(names: string[], raw: unknown[][], tag: string, known?: (PgType | undefined)[]): Result {
  const types = names.map((_, i) => known?.[i] ?? inferType(raw.find((r) => r[i] !== null && r[i] !== undefined)?.[i] ?? null));
  const fields: Field[] = names.map((name, i) => ({ name: pgColumnName(name), oid: types[i].oid }));
  return { kind: "rows", fields, rows: raw.map((r) => r.map((v, i) => encodeValue(v, types[i]))), tag };
}
