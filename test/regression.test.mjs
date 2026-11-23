import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { client, freshDb } from "./helpers.mjs";

test("all 27 SQL corpus statements run over the Postgres protocol", async () => {
  const sql = readFileSync("test/fixtures/demo.sql", "utf8").replace(/^--.*$/gm, "");
  const statements = sql.split(/;\s*$/m).map(s => s.trim()).filter(Boolean);
  assert.equal(statements.length, 27);
  const connection = await client(freshDb("corpus"));
  try {
    for (const statement of statements) await connection.query(statement);
  } finally {
    await connection.end();
  }
});

test("node-postgres extended query protocol", () => {
  assert.match(execFileSync("node", ["test/node-pg.mjs"], { encoding: "utf8" }), /^OK$/m);
});

test("SQL-looking string values survive translation and session substitution", async () => {
  const c = await client(freshDb("strings"));
  try {
    const text = "UUID() DEFAULT CURRENT_TIMESTAMP SERIAL PRIMARY KEY current_database()";
    assert.deepEqual((await c.query(`SELECT '${text}' AS value`)).rows, [{ value: text }]);
  } finally {
    await c.end();
  }
});

test("an open client sees column types created by another client", async () => {
  const name = freshDb("catalog");
  const reader = await client(name);
  const writer = await client(name);
  try {
    await reader.query("SELECT 1");
    await writer.query("CREATE TABLE flags (enabled BOOLEAN)");
    await writer.query("INSERT INTO flags VALUES (true)");
    assert.deepEqual((await reader.query("SELECT enabled FROM flags")).rows, [{ enabled: true }]);
  } finally {
    await Promise.all([reader.end(), writer.end()]);
  }
});
