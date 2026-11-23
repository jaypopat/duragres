// Statements answered without Polyglot/SQLite: session/config queries,
// transaction control, and the catalog queries psql's meta-commands send.
import { OID, PgError, type Field, type Result } from "../postgres/wire";
import { META_HANDLERS } from "./psql-meta";
import type { Tx } from "./transactions";

export const SERVER_VERSION = "16.4";

export interface Session {
  sql: SqlStorage;
  storage: DurableObjectStorage;
  database: string;
  user: string;
  tx?: Tx; // open transaction (transactions.ts)
  inSync?: boolean; // already inside transactionSync: DDL must not open its own
}

export interface Handler {
  name: string;
  re: RegExp;
  run(m: RegExpExecArray, s: Session): Result;
}

export function table(cols: [string, number][], rows: unknown[][], tag = `SELECT ${rows.length}`): Result {
  const fields: Field[] = cols.map(([name, oid]) => ({ name, oid }));
  return { kind: "rows", fields, rows: rows.map((r) => r.map((v) => (v === null || v === undefined ? null : String(v)))), tag };
}

const SETTINGS: Record<string, string> = {
  server_version: SERVER_VERSION,
  server_version_num: "160004",
  server_encoding: "UTF8",
  client_encoding: "UTF8",
  standard_conforming_strings: "on",
  transaction_isolation: "serializable",
  search_path: '"$user", public',
  timezone: "UTC",
  datestyle: "ISO, MDY",
  integer_datetimes: "on",
  max_identifier_length: "63",
};

const one = (name: string, value: string) => table([[name, OID.text]], [[value]]);
const END = String.raw`\s*;?\s*$`;

const SESSION_HANDLERS: Handler[] = [
  {
    name: "version()",
    re: new RegExp(String.raw`^\s*select\s+(pg_catalog\.)?version\(\)` + END, "i"),
    run: () => one("version", `PostgreSQL ${SERVER_VERSION} (do-postgres showcase: Cloudflare Durable Object + SQLite, SQL via Polyglot)`),
  },
  {
    name: "current_*()",
    re: new RegExp(String.raw`^\s*select\s+(pg_catalog\.)?(current_schema|current_database|current_user|session_user|user)(\(\))?` + END, "i"),
    run: (m, s) => {
      const fn = m[2].toLowerCase();
      return one(fn, fn === "current_schema" ? "public" : fn === "current_database" ? s.database : s.user);
    },
  },
  {
    name: "SHOW",
    re: new RegExp(String.raw`^\s*show\s+(\w+)` + END, "i"),
    run: (m) => {
      const key = m[1].toLowerCase();
      if (key === "all") return table([["name", OID.text], ["setting", OID.text]], Object.entries(SETTINGS), "SHOW");
      const v = SETTINGS[key];
      if (v === undefined) throw new PgError("42704", `unrecognized configuration parameter "${m[1]}"`);
      return { ...one(key, v), tag: "SHOW" };
    },
  },
  {
    // SQLite has no schemas; "public" and "drizzle" qualifiers are stripped during translation.
    name: "CREATE/DROP SCHEMA",
    re: /^\s*(create|drop)\s+schema\b/i,
    run: (m) => ({ kind: "command", tag: `${m[1].toUpperCase()} SCHEMA` }),
  },
  { name: "SET", re: /^\s*(set|reset)\b/i, run: (m) => ({ kind: "command", tag: m[1].toUpperCase() }) },
];

const HANDLERS: Handler[] = [...SESSION_HANDLERS, ...META_HANDLERS];

export function intercept(sql: string, s: Session): Result | undefined {
  for (const h of HANDLERS) {
    const m = h.re.exec(sql);
    if (m) return h.run(m, s);
  }
  return undefined;
}
