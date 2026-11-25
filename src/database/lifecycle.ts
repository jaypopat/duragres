// Create-on-connect and TTL expiry. A database exists once its metadata is written; the alarm set at
// creation deletes it unless it was claimed by then (a role has a password; see PgDO.claimed).

const DB_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/;
const RESERVED = new Set(["template0", "template1"]); // Postgres's own, inside every cluster

/** Duragres names: 3-63 chars, a-z 0-9 and "-", starting with a letter or digit, not template0/1. */
export const validName = (name: string) => DB_NAME.test(name) && !RESERVED.has(name);
export const NAME_RULE = 'duragres names: 3-63 chars, a-z 0-9 and "-", starting with a letter or digit; not template0 or template1';

/**
 * `importing` is set while CREATE DATABASE ... TEMPLATE copies another database into this one. A copy
 * records its `source` and the password verifiers it `inherited`: those protect the copy, but only a
 * password set on the copy itself claims it (keeps it past its TTL).
 */
export interface Meta { name: string; createdAt: number; expiresAt: number; importing: boolean; source?: string; inherited?: Array<string> }

const META_KEY = "duragres:meta";

export const readMeta = (storage: DurableObjectStorage) => storage.kv.get<Meta>(META_KEY);
export const writeMeta = (storage: DurableObjectStorage, meta: Meta) => storage.kv.put(META_KEY, meta);

/** Records a new database. Synchronous up to the alarm, so concurrent connects cannot both create it. */
export function createDatabase(storage: DurableObjectStorage, name: string, ttlSeconds: number, importing = false): Meta {
  const now = Date.now();
  const meta: Meta = { name, createdAt: now, expiresAt: now + ttlSeconds * 1000, importing };
  writeMeta(storage, meta);
  void storage.setAlarm(meta.expiresAt);
  return meta;
}

export function createNotice(name: string, ttlSeconds: number) {
  return `duragres: created database "${name}" — deleted in ${humanDuration(ttlSeconds)} unless claimed with ALTER ROLE ... PASSWORD`;
}

function humanDuration(seconds: number): string {
  const units: Array<[number, string]> = [[86_400, "day"], [3600, "hour"], [60, "minute"], [1, "second"]];
  // Hours up to 4 days: "72 hours" reads better than "3 days".
  const [size, unit] = units.find(([s]) => (s === 86_400 ? seconds >= 4 * 86_400 : seconds >= s) && seconds % s === 0) ?? [1, "second"];
  const n = seconds / size;
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}
