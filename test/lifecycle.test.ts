// Create-on-connect, TTL expiry, name validation, idle timeout and connection limits,
// against a Worker started with the short limits of `--env test` (cloudflare.config.ts).
import { afterAll, beforeAll, expect, test } from "bun:test";
import pg from "pg";
import { startServer } from "./server";
import type { Server } from "./server";

const TTL_SECONDS = 30;
const IDLE_SECONDS = 6;
const MAX_CONNECTIONS = 3;

let server: Server;
beforeAll(async () => {
  server = await startServer("test");
});
afterAll(() => server?.stop());

async function open(name: string) {
  const notices: Array<string> = [];
  const errors: Array<Error & { code?: string }> = [];
  const c = new pg.Client(server.database(name));
  c.on("notice", (n) => notices.push(n.message ?? ""));
  c.on("error", (e) => errors.push(e));
  await c.connect();
  await Bun.sleep(50); // notices arrive with the startup burst
  return { c, notices, errors };
}

const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}`;

test("the first connect creates the database with a NOTICE, and the TTL deletes it", async () => {
  const name = unique("ttl");
  const first = await open(name);
  expect(first.notices).toEqual([`duragres: created database "${name}" — deleted in 30 seconds unless claimed with ALTER ROLE ... PASSWORD`]);
  await first.c.query("CREATE TABLE notes (id SERIAL PRIMARY KEY, body TEXT)");
  await first.c.query("INSERT INTO notes (body) VALUES ('hello')");
  await first.c.end();

  const again = await open(name);
  expect(again.notices).toEqual([]);
  expect((await again.c.query("SELECT body FROM notes")).rows).toEqual([{ body: "hello" }]);
  await again.c.end();

  await Bun.sleep((TTL_SECONDS + 3) * 1000);
  const expired = await open(name);
  expect(expired.notices).toHaveLength(1);
  await expect(expired.c.query("SELECT * FROM notes")).rejects.toMatchObject({ code: "42P01" });
  await expired.c.end();
});

test("setting a password claims the database: it survives its TTL and connections must authenticate", async () => {
  const name = unique("claim");
  const owner = await open(name);
  await owner.c.query("CREATE TABLE kept (v TEXT)");
  await owner.c.query("INSERT INTO kept VALUES ('mine')");
  await owner.c.query("ALTER ROLE demo PASSWORD 'correct horse'");
  await owner.c.end();

  // No password: the server asks for SCRAM, and node-postgres refuses to continue without one.
  await expect(new pg.Client(server.database(name)).connect()).rejects.toThrow(/password must be a string/);
  // The password goes in the URL: node-postgres lets a connection string override a separate password option.
  const as = (user: string, password: string) => server.database(name).replace("demo@", `${user}:${encodeURIComponent(password)}@`);
  // pg-gateway reports a failed SCRAM exchange as 28000; Postgres itself would say 28P01.
  const refused = { code: "28000", severity: "FATAL", message: expect.stringContaining("password authentication failed") };
  await expect(new pg.Client(as("demo", "wrong")).connect()).rejects.toMatchObject(refused);
  await expect(new pg.Client(as("stranger", "correct horse")).connect()).rejects.toMatchObject(refused);

  // A copy inherits the password, so it is protected too, but it is not claimed: it still expires.
  const branch = unique("claim-branch");
  const authed = new pg.Client(as("demo", "correct horse"));
  await authed.connect();
  await authed.query(`CREATE DATABASE "${branch}" TEMPLATE "${name}"`);
  await authed.end();
  await expect(new pg.Client(server.database(branch)).connect()).rejects.toThrow(/password must be a string/);

  await Bun.sleep((TTL_SECONDS + 3) * 1000);
  const back = new pg.Client(as("demo", "correct horse"));
  await back.connect();
  expect((await back.query("SELECT v FROM kept")).rows).toEqual([{ v: "mine" }]);
  await back.end();
  const recreated = await open(branch); // expired and deleted, so connecting creates it afresh
  expect(recreated.notices).toHaveLength(1);
  await recreated.c.end();
});

test("invalid database names get FATAL 3D000", async () => {
  for (const bad of ["ab", "Upper", "under_score", "-leading", "x".repeat(64), "template1"]) {
    await expect(new pg.Client(server.database(bad)).connect()).rejects.toMatchObject({ code: "3D000", severity: "FATAL" });
  }
});

test("idle connections are closed with FATAL 57P05", async () => {
  const s = await open(unique("idle"));
  await s.c.query("SELECT 1");
  await Bun.sleep((IDLE_SECONDS + 2) * 1000);
  expect(s.errors[0]).toMatchObject({ code: "57P05", message: expect.stringContaining("idle-session timeout") });
  await s.c.end().catch(() => {});
});

test("the per-database connection cap refuses extras with 53300 and frees slots on close", async () => {
  const name = unique("cap");
  const held = [];
  for (let i = 0; i < MAX_CONNECTIONS; i++) held.push(await open(name));
  await expect(new pg.Client(server.database(name)).connect()).rejects.toMatchObject({ code: "53300" });
  await held.pop()!.c.end();
  await Bun.sleep(100); // the slot frees promptly, not at the idle timeout
  const again = await open(name);
  expect((await again.c.query("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
  await Promise.all([...held, again].map((h) => h.c.end()));
});

test("too many new connections from one address are refused with 53400", async () => {
  let refused: unknown;
  for (let i = 0; i < 50 && !refused; i++) {
    const c = new pg.Client(server.database(unique(`burst-${i}`)));
    try {
      await c.connect();
      await c.end();
    } catch (error) {
      refused = error;
    }
  }
  expect(refused).toMatchObject({ code: "53400", message: expect.stringContaining("too many new connections") });
});
