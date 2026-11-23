// Runs one prepared statement on SQLite and builds its PostgreSQL result.
// DDL and its shadow-catalog update commit together in one transactionSync.
import { PgError, type Field, type Result } from "../postgres/wire";
import { annotate } from "./polyglot";
import { applyChanges, changesOf, loadCatalog, outputColumns, paramTypes, returnsRows, schemaOf, type OutputColumn } from "./catalog";
import { expandDefaults } from "./defaults";
import { freezeClock, usesRandomness } from "./determinism";
import { addConstraint } from "./rebuild";
import { show, type Session } from "./session";
import type { Statement } from "./statement";
import { translate } from "./translate";
import { T, decodeParam, encodeValue, inferType, typeByOid } from "./types";

/** Statements that run synchronously against this database. */
export type Runnable = Exclude<Statement, { kind: "transaction" | "isolation" | "createDatabase" | "dropDatabase" }>;
export type Params = Array<string | null>;

// SQLite error messages -> SQLSTATE. Anything unrecognised is an internal error, not a syntax error.
const SQLITE_ERRORS: Array<[RegExp, string, string]> = [
  [/UNIQUE constraint failed/, "23505", "duplicate key value violates unique constraint"],
  [/NOT NULL constraint failed/, "23502", "null value violates not-null constraint"],
  [/FOREIGN KEY constraint failed/, "23503", "violates foreign key constraint"],
  [/CHECK constraint failed/, "23514", "violates check constraint"],
  [/no such table/, "42P01", "relation does not exist"],
  [/no such column/, "42703", "column does not exist"],
  [/no such function/, "42883", "function does not exist"],
  [/already exists/, "42P07", "relation already exists"],
  // Polyglot translates constructs SQLite can't express into a call to sqlite_fail().
  [/sqlite_fail/, "0A000", "not supported by duragres"],
  [/syntax error|incomplete input|unrecognized token/, "42601", "syntax error"],
  [/datatype mismatch/, "42804", "datatype mismatch"],
  [/too many SQL variables|wrong number of arguments/, "42601", "wrong number of parameters"],
];

export function sqliteErrorToPg(e: unknown): PgError {
  if (e instanceof PgError) return e;
  const m = (e instanceof Error ? e.message : String(e)).replace(/: SQLITE_\w+.*$/, "");
  const hit = SQLITE_ERRORS.find(([re]) => re.test(m));
  return hit ? new PgError(hit[1], `${hit[2]} (${m})`) : new PgError("XX000", m);
}

export function run(stmt: Runnable, params: Params, s: Session, paramOids: Array<number> = []): Result {
  try {
    switch (stmt.kind) {
      case "show":
        return show(stmt.name, s);
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

function runSql(stmt: Extract<Statement, { kind: "sql" }>, rawParams: Params, s: Session, paramOids: Array<number>): Result {
  const catalog = loadCatalog(s.sql);
  const [typed] = annotate(stmt.pg, schemaOf(catalog));
  const inferred = paramTypes(typed, catalog);
  const params = rawParams.map((v, i) => decodeParam(v, typeByOid(paramOids[i] ?? 0) ?? inferred.get(i + 1)));
  let sqlite = (expandDefaults(stmt.node) ?? [stmt.pg]).flatMap(translate).map(numberParams);
  if (stmt.clock !== undefined && !stmt.ddl) {
    // DDL keeps 'now' in its defaults: they are evaluated when rows are inserted.
    sqlite = sqlite.map((q) => freezeClock(q, stmt.clock!));
    if (!stmt.readOnly && sqlite.some(usesRandomness)) {
      throw new PgError("0A000", "duragres cannot keep a random value consistent inside a transaction; generate it in the client or in INSERT ... VALUES");
    }
  }

  // A translation can be several SQLite statements; rows from all of them form the result.
  const execute = () => {
    let names: Array<string> = [];
    const rows: Array<SqlStorageValue>[] = [];
    let changed = 0;
    for (const q of sqlite) {
      const cursor = s.sql.exec(q, ...params.slice(0, highestParam(q)));
      const batch = [...cursor.raw()];
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
  const known = outputColumns(typed, catalog);
  const columns = known?.length === res.names.length ? known : res.names.map((name) => ({ name }));
  return rowsResult(columns, res.rows, tag);
}

/** Result columns named and typed as Postgres would where known; other types are inferred from the values. */
function rowsResult(columns: Array<OutputColumn>, raw: Array<unknown>[], tag: string): Result {
  const types = columns.map((c, i) => c.type ?? inferType(raw.find((r) => r[i] !== null && r[i] !== undefined)?.[i] ?? null));
  const fields: Array<Field> = columns.map((c, i) => ({ name: c.name, oid: types[i].oid }));
  return { kind: "rows", fields, rows: raw.map((r) => r.map((v, i) => encodeValue(v, types[i]))), tag };
}

/**
 * The RowDescription fields of a statement, without running anything that writes:
 * null when it returns no rows, undefined when they can only be learnt by running it.
 * A column whose type is unknown is described as text.
 */
export function describe(stmt: Runnable, s: Session): Array<Field> | null | undefined {
  switch (stmt.kind) {
    case "show":
    case "catalog": {
      const r = run(stmt, [], s);
      return r.kind === "rows" ? r.fields : null;
    }
    case "noop":
    case "addConstraint":
      return null;
    case "sql": {
      if (!returnsRows(stmt.node)) return null;
      const catalog = loadCatalog(s.sql);
      const [typed] = annotate(stmt.pg, schemaOf(catalog));
      return outputColumns(typed, catalog)?.map((c) => ({ name: c.name, oid: (c.type ?? T.text).oid }));
    }
  }
}
