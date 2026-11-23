// Correctness gate: every extended-protocol Execute runs the statement exactly once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { client, freshDb } from "./helpers.mjs";

test("INSERT/UPDATE/DELETE via extended protocol execute exactly once", async () => {
  const c = await client(freshDb("once"));
  try {
    await c.query("CREATE TABLE hits (id SERIAL PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, label TEXT)");
    const count = async () => Number((await c.query("SELECT COUNT(*) AS n FROM hits")).rows[0].n);

    // Unnamed statement (Parse/Bind/Describe/Execute/Sync each time)
    const ins = await c.query("INSERT INTO hits (label) VALUES ($1)", ["unnamed"]);
    assert.equal(ins.rowCount, 1);
    assert.equal(await count(), 1, "unnamed INSERT ran more than once");

    // Named prepared statement executed 3 times
    for (let i = 0; i < 3; i++) {
      const r = await c.query({ name: "ins-named", text: "INSERT INTO hits (label) VALUES ($1)", values: [`named-${i}`] });
      assert.equal(r.rowCount, 1);
    }
    assert.equal(await count(), 4, "named INSERT ran more or less than 3 times");

    // UPDATE ... RETURNING: counter must step by exactly 1 per execution
    await c.query("INSERT INTO hits (label, n) VALUES ('counter', 0)");
    for (let i = 1; i <= 3; i++) {
      const r = await c.query({ name: "bump", text: "UPDATE hits SET n = n + 1 WHERE label = $1 RETURNING n", values: ["counter"] });
      assert.equal(r.rowCount, 1);
      assert.equal(Number(r.rows[0].n), i, `UPDATE RETURNING ran twice (n=${r.rows[0].n} after ${i} calls)`);
    }
    const unnamedUpd = await c.query("UPDATE hits SET n = n + 1 WHERE label = $1 RETURNING n", ["counter"]);
    assert.equal(Number(unnamedUpd.rows[0].n), 4);

    // DELETE: exactly the matching rows, once
    const del = await c.query({ name: "del", text: "DELETE FROM hits WHERE label = $1", values: ["named-0"] });
    assert.equal(del.rowCount, 1);
    const del2 = await c.query({ name: "del", text: "DELETE FROM hits WHERE label = $1", values: ["named-0"] });
    assert.equal(del2.rowCount, 0, "second DELETE should find nothing");
    const delRet = await c.query("DELETE FROM hits WHERE label LIKE $1 RETURNING id", ["named-%"]);
    assert.equal(delRet.rowCount, 2);
    assert.equal(await count(), 2);
  } finally {
    await c.end();
  }
});
