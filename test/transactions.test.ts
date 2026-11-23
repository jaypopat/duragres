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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("values a transaction returns are the values it commits", async () => {
  const name = freshDb("tx-values");
  const c = await client(name);
  const other = await client(name);
  try {
    await c.query("CREATE TABLE items (id SERIAL PRIMARY KEY, uid UUID DEFAULT gen_random_uuid(), at TIMESTAMPTZ DEFAULT now(), tag UUID)");
    await c.query("BEGIN");
    const first = (await c.query("INSERT INTO items (tag) VALUES (gen_random_uuid()) RETURNING *")).rows[0];
    const rest = (await c.query("INSERT INTO items (tag) VALUES (NULL), (gen_random_uuid()) RETURNING *")).rows;
    const [{ now }] = (await c.query("SELECT now()")).rows;
    await Bun.sleep(20);
    expect((await c.query("SELECT now()")).rows[0].now).toEqual(now); // now() is the transaction's start time
    await c.query("COMMIT");

    expect(first.uid).toMatch(UUID);
    expect(first.tag).toMatch(UUID);
    expect(first.at).toEqual(now);
    expect((await other.query("SELECT * FROM items ORDER BY id")).rows).toEqual([first, ...rest]);
  } finally {
    await Promise.all([c.end(), other.end()]);
  }
});

test("a write waits for another connection's open write transaction", async () => {
  const name = freshDb("tx-lock");
  const a = await client(name);
  const b = await client(name);
  try {
    await a.query("CREATE TABLE t (id SERIAL PRIMARY KEY, who TEXT)");
    await a.query("BEGIN");
    expect((await a.query("INSERT INTO t (who) VALUES ('a') RETURNING id")).rows).toEqual([{ id: 1 }]);

    let bDone = false;
    const bInsert = b.query("INSERT INTO t (who) VALUES ('b') RETURNING id").then((r) => { bDone = true; return r; });
    await Bun.sleep(200);
    expect(bDone).toBe(false);
    await a.query("COMMIT");
    expect((await bInsert).rows).toEqual([{ id: 2 }]);
    expect((await a.query("SELECT id, who FROM t ORDER BY id")).rows).toEqual([{ id: 1, who: "a" }, { id: 2, who: "b" }]);
  } finally {
    await Promise.all([a.end(), b.end()]);
  }
});

test("read committed sees other commits until its first write; serializable runs alone", async () => {
  const name = freshDb("tx-isolation");
  const a = await client(name);
  const b = await client(name);
  const count = async () => Number((await a.query("SELECT COUNT(*) AS n FROM t")).rows[0].n);
  try {
    await a.query("CREATE TABLE t (id SERIAL PRIMARY KEY)");
    await a.query("BEGIN");
    expect((await a.query("SHOW transaction_isolation")).rows).toEqual([{ transaction_isolation: "read committed" }]);
    expect(await count()).toBe(0);
    await b.query("INSERT INTO t DEFAULT VALUES");
    expect(await count()).toBe(1);
    await a.query("COMMIT");

    await a.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    expect((await a.query("SHOW transaction_isolation")).rows).toEqual([{ transaction_isolation: "serializable" }]);
    expect(await count()).toBe(1);
    let bDone = false;
    const bInsert = b.query("INSERT INTO t DEFAULT VALUES").then(() => (bDone = true));
    await Bun.sleep(200);
    expect(bDone).toBe(false);
    expect(await count()).toBe(1);
    await a.query("COMMIT");
    await bInsert;
    expect(await count()).toBe(2);

    // Raising the level after BEGIN works until the first query.
    await a.query("BEGIN");
    await a.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    expect((await a.query("SHOW transaction_isolation")).rows).toEqual([{ transaction_isolation: "repeatable read" }]);
    await expect(a.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")).rejects.toMatchObject({ code: "25001" });
    await a.query("ROLLBACK");
  } finally {
    await Promise.all([a.end(), b.end()]);
  }
});

test("a connection that disconnects mid-transaction releases the writer lock", async () => {
  const name = freshDb("tx-drop");
  const a = await client(name);
  const b = await client(name);
  try {
    await a.query("CREATE TABLE t (v INT)");
    await a.query("BEGIN");
    await a.query("INSERT INTO t VALUES (1)");
    await a.end();
    await b.query("INSERT INTO t VALUES (2)");
    expect((await b.query("SELECT v FROM t")).rows).toEqual([{ v: 2 }]);
  } finally {
    await b.end();
  }
});

test("randomness that can't be fixed is refused inside a transaction", async () => {
  const c = await client(freshDb("tx-random"));
  try {
    await c.query("CREATE TABLE t (id INT, uid UUID)");
    await c.query("INSERT INTO t VALUES (1, NULL), (2, NULL)");
    await c.query("BEGIN");
    await expect(c.query("UPDATE t SET uid = gen_random_uuid()")).rejects.toMatchObject({ code: "0A000" });
    await c.query("ROLLBACK");
    expect((await c.query("UPDATE t SET uid = gen_random_uuid()")).rowCount).toBe(2); // fine outside a transaction
  } finally {
    await c.end();
  }
});
