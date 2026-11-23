// Create-on-connect and TTL expiry. A database exists once its metadata is
// written; the alarm set at creation deletes it unless it has been claimed.
import { CATALOG_DDL } from "../sql/catalog";

export const DB_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/;

interface Meta { name: string; createdAt: number; expiresAt: number; claimed: boolean }

const META_KEY = "duragres:meta";

export const readMeta = (storage: DurableObjectStorage) => storage.kv.get<Meta>(META_KEY);

export const isLive = (meta: Meta, now = Date.now()) => meta.claimed || now < meta.expiresAt;

/** Records a new database. Synchronous up to the alarm, so concurrent connects cannot both create it. */
export function createDatabase(storage: DurableObjectStorage, name: string, ttlSeconds: number, withCatalog = true): Meta {
  const now = Date.now();
  const meta: Meta = { name, createdAt: now, expiresAt: now + ttlSeconds * 1000, claimed: false };
  storage.transactionSync(() => {
    if (withCatalog) storage.sql.exec(CATALOG_DDL);
    storage.kv.put(META_KEY, meta);
  });
  void storage.setAlarm(meta.expiresAt);
  return meta;
}

export function createNotice(name: string, ttlSeconds: number) {
  return `duragres: created database "${name}" — expires in ${humanDuration(ttlSeconds)} unless claimed`;
}

function humanDuration(seconds: number): string {
  const units: Array<[number, string]> = [[86400, "day"], [3600, "hour"], [60, "minute"], [1, "second"]];
  // Hours up to 4 days: "72 hours" reads better than "3 days".
  const [size, unit] = units.find(([s]) => (s === 86400 ? seconds >= 4 * 86400 : seconds >= s) && seconds % s === 0) ?? [1, "second"];
  const n = seconds / size;
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}
