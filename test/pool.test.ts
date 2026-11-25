// Many connections share each database's single Postgres backend (src/engine/pool.ts).
import { expect, test } from "bun:test";
import pg from "pg";
import { client, databaseUrl, freshDb } from "./setup";

test("each connection keeps its own role, and roles are created on first connect", async () => {
  const name = freshDb("pool-roles");
  const a = await client(name);
  const alice = new pg.Client(databaseUrl(name).replace("demo@", "alice@"));
  await alice.connect();
  try {
    expect((await a.query("SELECT current_database() AS db, current_user AS u")).rows).toEqual([{ db: name, u: "demo" }]);
    expect((await alice.query("SELECT current_user AS u")).rows).toEqual([{ u: "alice" }]);
    expect((await a.query("SELECT current_user AS u")).rows).toEqual([{ u: "demo" }]);
  } finally {
    await Promise.all([a.end(), alice.end()]);
  }
});

test("two connections can prepare statements with the same name", async () => {
  const name = freshDb("pool-names");
  const a = await client(name);
  const b = await client(name);
  try {
    await a.query("CREATE TABLE t (id INT, v TEXT); INSERT INTO t VALUES (1, 'one'), (2, 'two')");
    const [ra, rb] = await Promise.all([
      a.query({ name: "get", text: "SELECT v FROM t WHERE id = $1", values: [1] }),
      b.query({ name: "get", text: "SELECT COUNT(*)::int AS v FROM t WHERE id > $1", values: [0] }),
    ]);
    expect([ra.rows, rb.rows]).toEqual([[{ v: "one" }], [{ v: 2 }]]);
    expect((await a.query({ name: "get", text: "SELECT v FROM t WHERE id = $1", values: [2] })).rows).toEqual([{ v: "two" }]);
  } finally {
    await Promise.all([a.end(), b.end()]);
  }
});

test("a pool of connections can write and run transactions concurrently", async () => {
  const name = freshDb("pool-load");
  const pool = new pg.Pool({ connectionString: databaseUrl(name), max: 8 });
  try {
    await pool.query("CREATE TABLE t (id INT PRIMARY KEY, v TEXT)");
    await Promise.all(Array.from({ length: 200 }, (_, i) => pool.query("INSERT INTO t VALUES ($1, $2)", [i, `row ${i}`])));
    await Promise.all(Array.from({ length: 20 }, async (_, i) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const { rows } = await c.query("SELECT COUNT(*)::int AS n FROM t");
        await c.query("INSERT INTO t VALUES ($1, $2)", [1000 + i, `seen ${rows[0].n}`]);
        await c.query("COMMIT");
      } finally {
        c.release();
      }
    }));
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM t")).rows).toEqual([{ n: 220 }]);
  } finally {
    await pool.end();
  }
});

test("a transaction left idle while others wait is ended with 25P03", async () => {
  const name = freshDb("pool-idle");
  const holder = await client(name);
  const waiter = await client(name);
  const errors: Array<unknown> = [];
  holder.on("error", (e) => errors.push(e));
  try {
    await holder.query("CREATE TABLE t (v INT)");
    await holder.query("BEGIN");
    await holder.query("INSERT INTO t VALUES (1)");
    const started = Date.now();
    // The holder never commits, so the waiter would wait forever without the idle rule.
    expect((await waiter.query("SELECT COUNT(*)::int AS n FROM t")).rows).toEqual([{ n: 0 }]);
    expect(Date.now() - started).toBeGreaterThan(4000);
    await Bun.sleep(50);
    expect(errors[0]).toMatchObject({ code: "25P03" });
  } finally {
    await Promise.allSettled([holder.end(), waiter.end()]);
  }
});
