// BEGIN/COMMIT/ROLLBACK are real: rollback undoes, commit persists, errors abort the transaction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { client, freshDb } from "./helpers.mjs";

test("ROLLBACK undoes writes and DDL; COMMIT persists; aborted tx rejects until ROLLBACK", async () => {
  const db = freshDb("tx");
  const c = await client(db);
  const other = await client(db);
  try {
    await c.query("CREATE TABLE t (id SERIAL PRIMARY KEY, v TEXT UNIQUE)");
    const n = async (cl = c) => Number((await cl.query("SELECT COUNT(*) AS n FROM t")).rows[0].n);

    await c.query("BEGIN");
    await c.query("INSERT INTO t (v) VALUES ('a'), ('b')");
    assert.equal(await n(), 2, "transaction sees its own writes");
    assert.equal(await n(other), 0, "other connection must not see uncommitted rows");
    await c.query("CREATE TABLE scratch (x INT)");
    await c.query("ROLLBACK");
    assert.equal(await n(), 0, "ROLLBACK must undo inserts");
    await assert.rejects(c.query("SELECT * FROM scratch"), /does not exist/, "ROLLBACK must undo CREATE TABLE");

    await c.query("BEGIN");
    const r = await c.query("INSERT INTO t (v) VALUES ($1) RETURNING id", ["kept"]);
    assert.equal(r.rows[0].id, 1);
    await c.query("UPDATE t SET v = 'kept2' WHERE id = 1");
    await c.query("COMMIT");
    assert.deepEqual((await other.query("SELECT v FROM t")).rows, [{ v: "kept2" }], "COMMIT visible to others");

    await c.query("BEGIN");
    await c.query("INSERT INTO t (v) VALUES ('x')");
    await assert.rejects(c.query("INSERT INTO t (v) VALUES ('kept2')"), (e) => e.code === "23505");
    await assert.rejects(c.query("SELECT 1"), (e) => e.code === "25P02");
    const end = await c.query("COMMIT");
    assert.equal(end.command, "ROLLBACK", "COMMIT of a failed transaction reports ROLLBACK");
    assert.equal(await n(), 1, "failed transaction leaves nothing behind");
  } finally {
    await c.end();
    await other.end();
  }
});
