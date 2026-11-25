import type pg from "pg";

export interface Server {
  host: string;
  port?: number;
  sslmode?: "verify-full" | "disable";
}

export interface Credentials {
  user: string;
  password?: string;
}

export interface OwnerCredentials {
  user: string;
  password: string;
}

export interface EnsureDatabase {
  name: string;
  template?: { name: string } & Credentials;
  owner: OwnerCredentials;
  previousOwner?: Credentials;
}

const DUPLICATE_DATABASE = "42P04";
const AUTH_FAILED = "28000";

export const DATABASE_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/;

export function connectionString(server: Server, database: string, { user, password }: Credentials): string {
  const host = server.host.includes(":") && !server.host.startsWith("[") ? `[${server.host}]` : server.host;
  const url = new URL(`postgres://${host}:${server.port ?? 5432}/${encodeURIComponent(database)}`);
  url.username = user;
  if (password !== undefined && password !== "") url.password = password;
  url.searchParams.set("sslmode", server.sslmode ?? "verify-full");
  return url.toString();
}

async function withClient<T>(server: Server, database: string, credentials: Credentials, work: (c: pg.Client) => Promise<T>): Promise<T> {
  // Imported lazily so Worker bundles that import @duragres/alchemy for `.ref()` never pull in `pg`.
  const { default: pgModule } = await import("pg");
  const c = new pgModule.Client({ connectionString: connectionString(server, database, credentials), connectionTimeoutMillis: 15_000 });
  c.on("notice", () => {});
  c.on("error", () => {});
  await c.connect();
  try {
    return await work(c);
  } finally {
    await c.end().catch(() => {});
  }
}

const code = (error: unknown) => (typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined);
const ident = (s: string) => `"${s.replaceAll('"', '""')}"`;

export async function ensureDatabase(server: Server, { name, template, owner, previousOwner }: EnsureDatabase): Promise<void> {
  if (!DATABASE_NAME.test(name)) throw new Error(`"${name}" is not a Duragres database name (3-63 characters, a-z 0-9 and "-")`);
  if (template) {
    await withClient(server, template.name, template, async (c) => {
      await c.query(`CREATE DATABASE ${ident(name)} TEMPLATE ${ident(template.name)}`).catch((error: unknown) => {
        if (code(error) !== DUPLICATE_DATABASE) throw error;
      });
    });
  }
  const setPassword = (c: pg.Client) =>
    c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = ${c.escapeLiteral(owner.user)}) THEN
      CREATE ROLE ${ident(owner.user)} LOGIN SUPERUSER; END IF; END $$;
      ALTER ROLE ${ident(owner.user)} PASSWORD ${c.escapeLiteral(owner.password)};
      GRANT ALL ON SCHEMA public TO ${ident(owner.user)};`);
  const candidates = [owner, previousOwner, template].filter((c): c is Credentials => c !== undefined);
  let lastError: unknown;
  for (const creds of candidates) {
    try {
      await withClient(server, name, creds, setPassword);
      return;
    } catch (error) {
      if (code(error) !== AUTH_FAILED) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

export async function dropDatabase(server: Server, { name, template, owner }: EnsureDatabase): Promise<"dropped" | "expiring"> {
  if (template) {
    await withClient(server, template.name, template, (c) => c.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`));
    return "dropped";
  }
  await withClient(server, name, owner, (c) =>
    c.query(`DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT rolname FROM pg_catalog.pg_authid WHERE rolpassword IS NOT NULL LOOP
        EXECUTE format('ALTER ROLE %I PASSWORD NULL', r.rolname);
      END LOOP; END $$`),
  ).catch((error: unknown) => {
    if (code(error) !== AUTH_FAILED) throw error;
  });
  return "expiring";
}
