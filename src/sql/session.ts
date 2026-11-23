// Per-connection state and the server settings clients ask about with SHOW.
import { OID, PgError, rows } from '../postgres/wire';
import type { Result } from '../postgres/wire';
import type { WriterLock } from "./lock";
import type { Tx } from "./transactions";

export const SERVER_VERSION = "16.4";

export interface Session {
  sql: SqlStorage;
  storage: DurableObjectStorage;
  database: string;
  user: string;
  lock: WriterLock; // shared by every connection to this database
  databases: Databases;
  tx?: Tx; // open transaction (transactions.ts)
  inSync?: boolean; // already inside transactionSync: DDL must not open its own
  isolation: Isolation; // default for new transactions (SET SESSION CHARACTERISTICS)
}

export const ISOLATION_LEVELS = ["read uncommitted", "read committed", "repeatable read", "serializable"] as const;
export type Isolation = (typeof ISOLATION_LEVELS)[number];

/**
 * What each level gets (transactions.ts). Repeatable read and serializable hold the
 * database's writer lock from BEGIN, so transactions at those levels run one at a time.
 * Lower levels take it at their first write and read the latest committed state until then.
 */
export const lockedFromBegin = (level: Isolation) => level === "repeatable read" || level === "serializable";

/** Other databases, as seen from this one (implemented by the Durable Object). */
export interface Databases {
  /** Creates `name` with a copy of this database's committed contents, or empty. */
  create(name: string, copy: boolean): Promise<"created" | "exists">;
  /** Deletes `name`; with `force`, closes its connections first. */
  drop(name: string, force: boolean): Promise<"dropped" | "missing" | "in-use">;
}

const SETTINGS: Record<string, string> = {
  server_version: SERVER_VERSION,
  server_version_num: "160004",
  server_encoding: "UTF8",
  client_encoding: "UTF8",
  standard_conforming_strings: "on",
  search_path: '"$user", public',
  timezone: "UTC",
  datestyle: "ISO, MDY",
  intervalstyle: "postgres",
  integer_datetimes: "on",
  max_identifier_length: "63",
};

const settingsOf = (s: Session): Record<string, string> => ({
  ...SETTINGS,
  transaction_isolation: s.tx?.isolation ?? s.isolation,
  default_transaction_isolation: s.isolation,
});

export function show(name: string, s: Session): Result {
  const settings = settingsOf(s);
  if (name === "all") return { ...rows([["name", OID.text], ["setting", OID.text]], Object.entries(settings)), tag: "SHOW" };
  const value = settings[name];
  if (value === undefined) throw new PgError("42704", `unrecognized configuration parameter "${name}"`);
  return { ...rows([[name, OID.text]], [[value]]), tag: "SHOW" };
}

/** The values SET accepts for a setting Duragres can't change: true when `items` say what it already is. */
const FIXED: Record<string, (items: Array<string>) => boolean> = {
  timezone: ([v, ...rest]) => !rest.length && /^(utc|etc\/utc|gmt|etc\/gmt|z|zulu|0|[+-]?00(:?00)?|local)$/i.test(v),
  client_encoding: ([v, ...rest]) => !rest.length && /^(utf-?8|unicode)$/i.test(v),
  search_path: (items) => items.every((v) => ["public", "$user", "pg_catalog", "drizzle"].includes(v.toLowerCase())),
  datestyle: (items) => items.every((v) => /^(iso|mdy)$/i.test(v)),
  intervalstyle: ([v, ...rest]) => !rest.length && v.toLowerCase() === "postgres",
  standard_conforming_strings: ([v, ...rest]) => !rest.length && /^(on|true|1)$/i.test(v),
};

/**
 * Checks SET `name` to `items` (the comma-separated value, unquoted). Settings with no
 * effect on results (application_name, statement_timeout, ...) are accepted and ignored.
 */
export function checkSetting(name: string, items: Array<string>) {
  if (items.length === 1 && items[0].toLowerCase() === "default") return;
  if (name === "transaction_isolation" || name === "default_transaction_isolation") {
    if (!ISOLATION_LEVELS.includes(items.join(" ").toLowerCase() as Isolation)) {
      throw new PgError("22023", `invalid value for parameter "${name}": "${items.join(" ")}"`);
    }
    return;
  }
  const fixed = FIXED[name];
  if (fixed && !fixed(items)) {
    throw new PgError("0A000", `duragres cannot change ${name}: it is always ${SETTINGS[name]}`);
  }
}
