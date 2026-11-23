import { expect, test } from "bun:test";
import type pg from "pg";
import { client, freshDb } from "./setup";

test("ROLLBACK undoes writes and DDL, COMMIT persists, and an error aborts the transaction", async () => {
  const name = freshDb("tx");
  const c = await client(name);
  const other = await client(name);
  const count = async (cl: pg.Client = c) => Number((await cl.query("SELECT COUNT(*) AS n FROM t")).rows[0].n);
  try {
    await c.query("CREATE TABLE t (id SERIAL PRIMARY KEY, v TEXT UNIQUE)");

    await c.query("BEGIN");
    await c.query("INSERT INTO t (v) VALUES ('a'), ('b')");
    expect(await count()).toBe(2);
    expect(await count(other)).toBe(0);
    await c.query("CREATE TABLE scratch (x INT)");
    await c.query("ROLLBACK");
    expect(await count()).toBe(0);
    await expect(c.query("SELECT * FROM scratch")).rejects.toThrow(/does not exist/);

    await c.query("BEGIN");
    expect((await c.query("INSERT INTO t (v) VALUES ($1) RETURNING id", ["kept"])).rows).toEqual([{ id: 1 }]);
    await c.query("UPDATE t SET v = 'kept2' WHERE id = 1");
    await c.query("COMMIT");
    expect((await other.query("SELECT v FROM t")).rows).toEqual([{ v: "kept2" }]);

    await c.query("BEGIN");
    await c.query("INSERT INTO t (v) VALUES ('x')");
    await expect(c.query("INSERT INTO t (v) VALUES ('kept2')")).rejects.toMatchObject({ code: "23505" });
    await expect(c.query("SELECT 1")).rejects.toMatchObject({ code: "25P02" });
    expect((await c.query("COMMIT")).command).toBe("ROLLBACK");
    expect(await count()).toBe(1);
  } finally {
    await Promise.all([c.end(), other.end()]);
  }
});
