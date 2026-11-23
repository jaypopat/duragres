import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import polyglot, { Dialect } from "@polyglot-sql/sdk/manual";

const binary = readFileSync(new URL("../vendor/polyglot/polyglot_sql.wasm", import.meta.url));
await polyglot.init({ wasmUrl: await WebAssembly.compile(binary) });

function sqlite(sql) {
  const result = polyglot.transpile(sql, Dialect.PostgreSQL, Dialect.SQLite);
  assert.ok(result.success, result.error);
  return result.sql[0];
}

test("the pinned generator emits executable serial, UUID and timestamp defaults", () => {
  const db = new Database(":memory:");
  try {
    for (const type of ["smallserial", "serial", "bigserial"]) {
      db.exec(sqlite(`CREATE TABLE t (id ${type} NOT NULL PRIMARY KEY, u uuid DEFAULT gen_random_uuid(), created timestamptz DEFAULT now())`));
      const row = db.query("INSERT INTO t DEFAULT VALUES RETURNING *").get();
      assert.equal(row.id, 1);
      assert.match(row.u, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
      assert.match(row.created, /\.\d{3}$/);
      db.exec("DELETE FROM t");
      assert.equal(db.query("INSERT INTO t DEFAULT VALUES RETURNING id").get().id, 2);
      db.exec("DROP TABLE t");
    }
  } finally {
    db.close();
  }
});

test("timestamp arithmetic is generated from expressions and preserves quoted text", () => {
  const db = new Database(":memory:");
  try {
    const row = db.query(sqlite(`SELECT now() - interval '2 days' AS yesterday,
      CURRENT_TIMESTAMP + INTERVAL '1' HOUR AS later, 'UUID() SERIAL PRIMARY KEY' AS original`)).get();
    const expected = db.query("SELECT datetime('now', '-2 days') AS yesterday, datetime('now', '+1 hour') AS later").get();
    for (const key of ["yesterday", "later"]) {
      assert.ok(Math.abs(Date.parse(row[key] + "Z") - Date.parse(expected[key] + "Z")) <= 1000);
    }
    assert.equal(row.original, "UUID() SERIAL PRIMARY KEY");
  } finally {
    db.close();
  }
});
