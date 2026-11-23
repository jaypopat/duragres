// Per-database lifecycle: create-on-first-connect with a TTL, expiry via DO
// alarm, and the connection guards (concurrency cap, idle timeout).

export interface LifecycleEnv {
  TTL_SECONDS?: string; // unclaimed databases are deleted this long after creation (default 72 h)
  IDLE_TIMEOUT_SECONDS?: string; // close connections idle this long (default 600)
  MAX_CONNECTIONS?: string; // per database (default 10)
  MAX_NEW_DBS_PER_HOUR?: string; // global, enforced by LimitsDO (default 100)
  CREATE_NOTICE?: string; // {db} and {ttl} are substituted
}

export const config = (env: LifecycleEnv) => ({
  ttlSeconds: Number(env.TTL_SECONDS ?? 72 * 3600),
  idleSeconds: Number(env.IDLE_TIMEOUT_SECONDS ?? 600),
  maxConnections: Number(env.MAX_CONNECTIONS ?? 10),
  maxNewPerHour: Number(env.MAX_NEW_DBS_PER_HOUR ?? 100),
  notice: env.CREATE_NOTICE ?? 'duragres: created database "{db}" — expires in {ttl} unless claimed',
});

export const DB_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/;

export function humanDuration(seconds: number): string {
  const units: [number, string][] = [[86400, "day"], [3600, "hour"], [60, "minute"], [1, "second"]];
  // Prefer hours up to 4 days ("72 hours" reads better than "3 days")
  const [size, unit] = units.find(([s]) => (s === 86400 ? seconds >= 4 * 86400 : seconds >= s) && seconds % s === 0) ?? [1, "second"];
  const n = seconds / size;
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

const META_DDL =
  "CREATE TABLE IF NOT EXISTS _duragres_meta (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, claimed INTEGER NOT NULL DEFAULT 0)";

export interface Meta { name: string; createdAt: string; expiresAt: string; claimed: boolean }

export function readMeta(sql: SqlStorage): Meta | undefined {
  sql.exec(META_DDL);
  const row = sql.exec("SELECT name, created_at, expires_at, claimed FROM _duragres_meta WHERE id = 1").raw().next().value;
  return row ? { name: String(row[0]), createdAt: String(row[1]), expiresAt: String(row[2]), claimed: Boolean(row[3]) } : undefined;
}

/** First connection: record metadata and schedule expiry. Returns the metadata. */
export async function initialise(storage: DurableObjectStorage, name: string, ttlSeconds: number): Promise<Meta> {
  const now = Date.now();
  const meta: Meta = { name, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlSeconds * 1000).toISOString(), claimed: false };
  storage.sql.exec(META_DDL);
  storage.sql.exec("INSERT INTO _duragres_meta (id, name, created_at, expires_at, claimed) VALUES (1, ?, ?, ?, 0)", name, meta.createdAt, meta.expiresAt);
  await storage.setAlarm(now + ttlSeconds * 1000);
  return meta;
}
