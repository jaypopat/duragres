// Inside a transaction, statements are replayed at COMMIT (see transactions.ts), so
// a write must produce the same rows every time it runs. This module makes the
// common volatile parts fixed, and rejects the rest:
//
// - the clock: now(), CURRENT_TIMESTAMP and SQLite's 'now' become the transaction's
//   start time, which is also what PostgreSQL's now() means inside a transaction;
// - volatile column defaults (UUIDs, timestamps) omitted by an INSERT ... VALUES are
//   evaluated once and written into the statement;
// - gen_random_uuid() in INSERT ... VALUES becomes a literal UUID per occurrence.
//
// Any other randomness in a write inside a transaction fails with 0A000.
import { PgError } from "../postgres/wire";
import { findNodes, generate, parse, tokenize } from './polyglot';
import type { Expression, Variant } from './polyglot';
import type { Session } from "./session";
import type { Statement } from "./statement";

type Sql = Extract<Statement, { kind: "sql" }>;

const DATE_FUNCTIONS = new Set(["date", "time", "datetime", "julianday", "strftime", "unixepoch", "timediff"]);
const CLOCK_KEYWORDS: Record<string, (iso: string) => string> = {
  current_timestamp: (iso) => iso,
  current_date: (iso) => iso.slice(0, 10),
  current_time: (iso) => iso.slice(11, 19),
};

/** "2026-11-23 10:00:00.123": the UTC text format Duragres stores timestamps in. */
const sqliteTime = (clock: number) => new Date(clock).toISOString().replace("T", " ").slice(0, 23);

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** SQLite text with every reading of the current time replaced by `clock`. */
export function freezeClock(sqlite: string, clock: number): string {
  const iso = sqliteTime(clock);
  const tokens = tokenize(sqlite);
  let out = "";
  let at = 0;
  const replace = (start: number, end: number, text: string) => {
    out += sqlite.slice(at, start) + text;
    at = end;
  };
  tokens.forEach((t, i) => {
    const keyword = t.type === "STRING" || t.type === "QUOTED_IDENTIFIER" ? undefined : CLOCK_KEYWORDS[t.text.toLowerCase()];
    if (keyword && tokens[i + 1]?.type !== "L_PAREN") return replace(t.start, t.end, quote(keyword(iso)));
    if (t.type === "STRING" && t.text.toLowerCase() === "now" && DATE_FUNCTIONS.has(enclosingFunction(tokens, i))) {
      replace(t.start, t.end, quote(iso));
    }
  });
  return out + sqlite.slice(at);
}

/** The name of the function whose argument list contains token i, or "". */
function enclosingFunction(tokens: ReturnType<typeof tokenize>, i: number): string {
  for (let depth = 0, j = i - 1; j >= 0; j--) {
    if (tokens[j].type === "R_PAREN") depth++;
    else if (tokens[j].type === "L_PAREN" && depth-- === 0) return tokens[j - 1]?.text.toLowerCase() ?? "";
  }
  return "";
}

/** Whether SQLite text calls a random function. */
export const usesRandomness = (sqlite: string) =>
  tokenize(sqlite).some((t, i, all) => /^random(blob)?$/i.test(t.text) && t.type !== "STRING" && all[i + 1]?.type === "L_PAREN");

const VOLATILE_DEFAULT = /\brandom(blob)?\s*\(|'now'|\bcurrent_(timestamp|date|time)\b/i;

/**
 * A copy of an INSERT ... VALUES in which omitted volatile defaults and gen_random_uuid()
 * calls are literal values, so running it again inserts the same rows.
 */
export function materializeInsert(stmt: Sql, s: Session, clock: number): Sql {
  if (!("insert" in stmt.node)) return stmt;
  const insert = stmt.node.insert;
  const volatile = [...s.sql.exec<{ name: string; dflt_value: string | null }>("SELECT name, dflt_value FROM pragma_table_info(?)", insert.table.name.name)]
    .filter((c) => c.dflt_value && VOLATILE_DEFAULT.test(c.dflt_value));
  const usesUuid = insert.values.flat().some((v) => findNodes(v, isUuidCall).length > 0);
  if (!volatile.length && !usesUuid) return stmt;
  if (insert.query) throw new PgError("0A000", "duragres cannot keep volatile defaults of INSERT ... SELECT consistent inside a transaction");

  const columns = [...insert.columns];
  // INSERT ... DEFAULT VALUES is one row with every column defaulted.
  const rows = insert.values.length ? insert.values.map((row) => row.map(fixUuids)) : [[]];
  for (const column of volatile) {
    const at = columns.findIndex((c) => c.name === column.name);
    const value = () => literal(s.sql.exec(`SELECT ${freezeClock(column.dflt_value!, clock)} AS v`).one().v);
    if (at < 0) {
      columns.push(identifier(column.name));
      for (const row of rows) row.push(value());
    } else {
      for (const row of rows) if (isDefault(row[at])) row[at] = value();
    }
  }
  const node: Variant<"insert"> = { insert: { ...insert, columns, values: rows, default_values: false } };
  return { ...stmt, node, pg: generate(node) };
}

const isDefault = (e: Expression) => "var" in e && e.var.this.toUpperCase() === "DEFAULT";

const isUuidCall = (e: Expression) => "function" in e && e.function.name.toLowerCase() === "gen_random_uuid";

/** A VALUES item runs once per row, so a gen_random_uuid() item can be one literal UUID. Nested calls are left to fail. */
const fixUuids = (e: Expression): Expression => (isUuidCall(e) ? literal(crypto.randomUUID()) : e);

/** AST nodes built by parsing, so they carry every field Polyglot's generator expects. */
function literal(value: SqlStorageValue): Expression {
  if (value instanceof ArrayBuffer) throw new PgError("0A000", "duragres cannot materialize a binary column default");
  const sql = value === null ? "NULL" : typeof value === "number" ? String(value) : quote(value);
  const [select] = parse(`SELECT ${sql}`);
  if (!("select" in select)) throw new Error("unreachable: SELECT parses as select");
  return select.select.expressions[0];
}

function identifier(name: string) {
  const [insert] = parse(`INSERT INTO t ("${name.replaceAll('"', '""')}") VALUES (1)`);
  if (!("insert" in insert)) throw new Error("unreachable: INSERT parses as insert");
  return insert.insert.columns[0];
}
