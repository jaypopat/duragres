// Steps 4-5: create-on-connect NOTICE, TTL expiry via alarm, name validation,
// idle timeout, per-database connection cap, global creation cap.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { LIMITS, start, url } from "./server.mjs";

let server;
before(async () => { server = await start(); });
after(async () => { await server?.stop(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function open(db) {
  const notices = [];
  const errors = [];
  const c = new pg.Client(url(db));
  c.on("notice", (n) => notices.push(n.message));
  c.on("error", (e) => errors.push(e));
  await c.connect();
  await sleep(50); // notices arrive with the startup burst
  return { c, notices, errors };
}

test("first connect creates the database with a NOTICE; reconnect is silent; TTL deletes it", { timeout: 90_000 }, async () => {
  const db = `ttl-${Date.now().toString(36)}`;
  const a = await open(db);
  assert.equal(a.notices.length, 1, `expected one create NOTICE, got ${JSON.stringify(a.notices)}`);
  assert.equal(a.notices[0], `duragres: created database "${db}" — expires in 30 seconds unless claimed`);
  await a.c.query("CREATE TABLE notes (id SERIAL PRIMARY KEY, body TEXT)");
  await a.c.query("INSERT INTO notes (body) VALUES ('hello')");
  const meta = (await a.c.query("SELECT claimed, expires_at FROM _duragres_meta")).rows[0];
  assert.equal(Number(meta.claimed), 0);
  await a.c.end();

  const b = await open(db);
  assert.deepEqual(b.notices, [], "reconnect before expiry must not NOTICE");
  assert.equal((await b.c.query("SELECT body FROM notes")).rows[0].body, "hello", "data intact before expiry");
  await b.c.end();

  await sleep((Number(LIMITS.TTL_SECONDS) + 3) * 1000);
  const c = await open(db);
  assert.equal(c.notices.length, 1, "after expiry the name is fresh again (new create NOTICE)");
  await assert.rejects(c.c.query("SELECT * FROM notes"), (e) => e.code === "42P01", "expired data must be gone");
  await c.c.end();
});

test("invalid database names get FATAL 3D000", async () => {
  for (const bad of ["ab", "Upper", "under_score", "-leading", "x".repeat(64)]) {
    const c = new pg.Client(url(bad));
    await assert.rejects(c.connect(), (e) => e.code === "3D000" && e.severity === "FATAL", `name ${bad}`);
  }
});

test("idle connections are closed with FATAL 57P05", { timeout: 30_000 }, async () => {
  const s = await open(`idle-${Date.now().toString(36)}`);
  await s.c.query("SELECT 1");
  await sleep((Number(LIMITS.IDLE_TIMEOUT_SECONDS) + 2) * 1000);
  assert.equal(s.errors[0]?.code, "57P05", `expected 57P05, got ${s.errors[0]?.code} ${s.errors[0]?.message}`);
  assert.match(s.errors[0].message, /idle-session timeout/);
  await s.c.end().catch(() => {});
});

test("per-database connection cap refuses extras with 53300 and frees slots on close", async () => {
  const db = `cap-${Date.now().toString(36)}`;
  const max = Number(LIMITS.MAX_CONNECTIONS);
  const held = [];
  for (let i = 0; i < max; i++) held.push(await open(db));
  const extra = new pg.Client(url(db));
  await assert.rejects(extra.connect(), (e) => e.code === "53300", "connection over the cap");
  await held.pop().c.end();
  await sleep(100); // slot must free promptly, not at idle timeout
  const again = await open(db);
  assert.equal((await again.c.query("SELECT 1 AS one")).rows[0].one, 1, "slot freed after close");
  for (const h of [...held, again]) await h.c.end();
});

test("global new-database cap refuses with 53400 (runs last: uses up the hourly budget)", async () => {
  const limit = Number(LIMITS.MAX_NEW_DBS_PER_HOUR);
  let created = 0;
  let refused;
  for (let i = 0; i < limit + 2 && !refused; i++) {
    const c = new pg.Client(url(`burst-${i}-${Date.now().toString(36)}`));
    try { await c.connect(); created++; await c.end(); } catch (e) { refused = e; }
  }
  assert.equal(refused?.code, "53400", `expected refusal, created ${created}`);
  assert.match(refused.message, /creation limit reached/);
  // Earlier tests created 3 databases (ttl, ttl again after expiry, idle) + cap db = 4; the rest fit the budget.
  assert.ok(created >= 1 && created < limit, `created ${created} before refusal`);
});
