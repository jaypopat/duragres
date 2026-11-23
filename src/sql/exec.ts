// One Postgres statement -> Result.
// Order: intercept -> analyze (AST) -> Polyglot + patches -> SQLite, with
// DDL and its shadow-catalog update in one transactionSync.
import { translate, stripSchema } from "./translate";
import { intercept, type Session } from "./intercept";
import { analyze, applyChanges, loadCatalog, outputTypes, paramTypes } from "./catalog";
import { decodeParam, encodeValue, inferType, typeByOid, type PgType } from "./types";
import { PgError, type Field, type Result } from "../postgres/wire";
import { addConstraint } from "./rebuild";
import { expandDefaults } from "./defaults";

/** Split a simple-query string into statements, respecting quotes and comments. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const end = sql.indexOf(c, i + 1);
      const stop = end < 0 ? sql.length : end;
      cur += sql.slice(i, stop + 1);
      i = stop;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
    } else if (c === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Postgres `$n` -> SQLite `?n` (numbered, so reuse and reordering work). Skips string literals. */
function numberParams(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|\$(\d+)/g, (m, n) => (n ? `?${n}` : m));
}

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

/** current_database() etc. inside larger queries become string literals (SQLite has no session). */
function withSessionValues(pg: string, s: Session): string {
  const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
  // In a select list (after SELECT or a comma, no alias given) keep Postgres' column name.
  const functions = /'(?:[^']|'')*'|"(?:[^"]|"")*"|\b(?:pg_catalog\.)?(current_database\(\)|current_schema(?:\(\))?|current_user\b|session_user\b)/gi;
  return pg.replace(functions, (token, fn: string | undefined, offset: number) => {
    if (!fn) return token;
    const col = fn.toLowerCase().replace("()", "");
    const value = col === "current_database" ? s.database : col === "current_schema" ? "public" : s.user;
    const before = pg.slice(0, offset);
    const after = pg.slice(offset + token.length);
    const needsAlias = /(?:\bselect|,)\s*$/i.test(before) && /^\s*(?:,|from\b|;|$)/i.test(after);
    return needsAlias ? `${lit(value)} AS ${col}` : lit(value);
  });
}

/** Postgres names an unaliased `COUNT(*)` column `count`; SQLite names it `COUNT(*)`. */
function pgColumnName(name: string): string {
  const m = /^(\w+)\(.*\)$/s.exec(name);
  return m ? m[1].toLowerCase() : name;
}

/** Result columns typed from the shadow catalog where the AST says where they come from, else from the values. */
function rowsResult(names: string[], raw: unknown[][], tag: string, known?: (PgType | undefined)[]): Result {
  const types = names.map((_, i) => {
    if (known?.[i]) return known[i]!;
    const sample = raw.find((r) => r[i] !== null && r[i] !== undefined)?.[i];
    return inferType(sample ?? null);
  });
  const fields: Field[] = names.map((name, i) => ({ name: pgColumnName(name), oid: types[i].oid }));
  return { kind: "rows", fields, rows: raw.map((r) => r.map((v, i) => encodeValue(v, types[i]))), tag };
}

const COMMAND = /^\s*(\w+)(?:\s+(TABLE|INDEX|UNIQUE\s+INDEX|VIEW|SCHEMA))?/i;

export function runStatement(pg: string, rawParams: (string | null)[], s: Session, paramOids: number[] = []): Result {
  if (!pg.trim()) return { kind: "empty" };
  const hit = intercept(pg, s);
  if (hit) return hit;

  const source = withSessionValues(pg, s);
  try {
    if (addConstraint(stripSchema(source), s)) return { kind: "command", tag: "ALTER TABLE" };
  } catch (e) {
    throw sqliteErrorToPg(e);
  }
  const a = analyze(source);
  const cat = loadCatalog(s.sql);
  const inferred = paramTypes(a, cat);
  const params = rawParams.map((v, i) => decodeParam(v, typeByOid(paramOids[i] ?? 0) ?? inferred.get(i + 1)));
  const sql = (expandDefaults(a.stmt) ?? [source]).flatMap(translate);
  const [, verb0 = "", obj] = COMMAND.exec(pg) ?? [];
  const verb = verb0.toUpperCase();
  try {
    // A translation can be several SQLite statements; rows from all of them form the result.
    const run = () => {
      let names: string[] = [];
      const raw: unknown[][] = [];
      let changed = 0;
      for (const stmt of sql) {
        const q = numberParams(stmt);
        // SQLite wants exactly as many values as the highest ?n in this statement.
        const used = Math.max(0, ...[...q.matchAll(/'(?:[^']|'')*'|\?(\d+)/g)].map((m) => Number(m[1] ?? 0)));
        const cursor = s.sql.exec(q, ...params.slice(0, used));
        const rows = [...cursor.raw()] as unknown[][];
        if (cursor.columnNames.length) { names = cursor.columnNames; raw.push(...rows); }
        if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE") changed += Number(s.sql.exec("SELECT changes()").raw().next().value?.[0] ?? 0);
      }
      return { names, raw, changed };
    };
    let res: ReturnType<typeof run>;
    if (a.changes.length) {
      // DDL and its catalog rows commit or fail together (inside the caller's transactionSync if there is one).
      const existed = new Set([...s.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").raw()].map(([n]) => String(n)));
      const ddl = () => {
        const r = run();
        applyChanges(s.sql, a.changes, (t) => existed.has(t));
        return r;
      };
      res = s.inSync ? ddl() : s.storage.transactionSync(ddl);
    } else res = run();

    const tag =
      verb === "INSERT" ? `INSERT 0 ${res.changed}`
      : verb === "UPDATE" || verb === "DELETE" ? `${verb} ${res.changed}`
      : verb === "SELECT" || verb === "WITH" || verb === "VALUES" ? `SELECT ${res.raw.length}`
      : obj ? `${verb} ${obj.toUpperCase().replace(/\s+/, " ").replace("UNIQUE INDEX", "INDEX")}`
      : verb;
    return res.names.length ? rowsResult(res.names, res.raw, tag, outputTypes(a, cat, res.names.length)) : { kind: "command", tag };
  } catch (e) {
    throw sqliteErrorToPg(e);
  }
}
