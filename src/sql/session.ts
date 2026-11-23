// Per-connection state and the server settings clients ask about with SHOW.
import { OID, PgError, rows, type Result } from "../postgres/wire";
import type { WriterLock } from "./lock";
import type { Tx } from "./transactions";

export const SERVER_VERSION = "16.4";

export interface Session {
  sql: SqlStorage;
  storage: DurableObjectStorage;
  database: string;
  user: string;
  lock: WriterLock; // shared by every connection to this database
  tx?: Tx; // open transaction (transactions.ts)
  inSync?: boolean; // already inside transactionSync: DDL must not open its own
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

export function show(name: string): Result {
  if (name === "all") return { ...rows([["name", OID.text], ["setting", OID.text]], Object.entries(SETTINGS)), tag: "SHOW" };
  const value = SETTINGS[name];
  if (value === undefined) throw new PgError("42704", `unrecognized configuration parameter "${name}"`);
  return { ...rows([[name, OID.text]], [[value]]), tag: "SHOW" };
}
