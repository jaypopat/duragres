import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { client, freshDb, url } from "./helpers.mjs";

const token = process.env.FORK_TOKEN;
assert.ok(token, "Set FORK_TOKEN to the same value as Wrangler");
const source = freshDb("fork-source");
const migrations = mkdtempSync(join(process.cwd(), "examples/drizzle/.fork-"));
let parent;
let fork;

function runDrizzle(args, databaseUrl) {
  return execFileSync("bun", args, {
    cwd: "examples/drizzle",
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
}

try {
  cpSync("examples/drizzle/drizzle", migrations, { recursive: true });
  assert.match(runDrizzle(["x", "drizzle-kit", "migrate"], url(source)), /migrations applied successfully/);
  assert.match(runDrizzle(["test/fixture.ts"], url(source)), /Drizzle demo OK/);

  parent = await client(source);
  const readUsers = "SELECT id, name, active, prefs FROM users ORDER BY id";
  const baseline = (await parent.query(readUsers)).rows;
  assert.equal(baseline.length, 4);
  assert.equal(typeof baseline[0].active, "boolean");
  assert.deepEqual(baseline[0].prefs, { theme: "dark" });

  await parent.query("BEGIN");
  await parent.query("UPDATE users SET name = 'Pending source write' WHERE id = 1");
  const endpoint = new URL("http://127.0.0.1:8787/forks");
  endpoint.searchParams.set("source", source);
  const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  assert.ok(response.ok, `fork failed (${response.status}): ${response.ok ? "" : await response.text()}`);
  const { databaseUrl, name } = await response.json();
  fork = new pg.Client(databaseUrl);
  await fork.connect();
  assert.deepEqual((await fork.query(readUsers)).rows, baseline);
  assert.equal((await fork.query("SELECT id FROM posts")).rowCount, 3);
  console.log(`Fork ${name} restored four typed users and three posts, excluding the pending write`);

  await parent.query("COMMIT");
  assert.equal((await parent.query("SELECT name FROM users WHERE id = 1")).rows[0].name, "Pending source write");
  assert.deepEqual((await fork.query(readUsers)).rows, baseline);

  const journalPath = join(migrations, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const previous = journal.entries.at(-1);
  const next = { ...previous, idx: previous.idx + 1, when: previous.when + 1, tag: "0001_add_nickname" };
  journal.entries.push(next);
  writeFileSync(journalPath, JSON.stringify(journal));
  writeFileSync(join(migrations, next.tag + ".sql"), 'ALTER TABLE "users" ADD COLUMN "nickname" text;\n');
  const config = join(migrations, "drizzle.config.ts");
  writeFileSync(config, `export default {
    dialect: "postgresql", out: ${JSON.stringify(migrations)},
    dbCredentials: { url: process.env.DATABASE_URL },
  };\n`);
  assert.match(runDrizzle(["x", "drizzle-kit", "migrate", "--config", config], databaseUrl), /migrations applied successfully/);
  assert.equal((await fork.query("SELECT nickname FROM users WHERE id = 1")).rows[0].nickname, null);
  await assert.rejects(parent.query("SELECT nickname FROM users"), { code: "42703" });
  console.log("Drizzle applied only the new migration on the fork. The parent schema was unchanged.");

  await fork.query("DELETE FROM posts");
  await fork.query("DELETE FROM users");
  await fork.end();
  fork = new pg.Client(databaseUrl);
  await fork.connect();
  assert.equal((await fork.query(readUsers)).rowCount, 0);
  assert.equal((await parent.query(readUsers)).rowCount, 4);
  assert.equal((await parent.query("SELECT id FROM posts")).rowCount, 3);
  console.log("After reconnecting, the fork was empty and the parent still had four users and three posts.");
} finally {
  await Promise.allSettled([parent?.end(), fork?.end()]);
  rmSync(migrations, { recursive: true, force: true });
}
