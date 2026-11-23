// Simple and extended query protocol behaviour, as node-postgres sees it.
import { expect, test } from "bun:test";
import { client, freshDb } from "./setup";

test("the SQL corpus runs over the simple query protocol", async () => {
  const sql = (await Bun.file("test/fixtures/demo.sql").text()).replace(/^--.*$/gm, "");
  const statements = sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
  expect(statements).toHaveLength(27);
  const c = await client(freshDb("corpus"));
  try {
    for (const statement of statements) await c.query(statement);
  } finally {
    await c.end();
  }
});

test("parameters, named statements, RETURNING and errors over the extended protocol", async () => {
  const c = await client(freshDb("extended"));
  try {
    await c.query("CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, active BOOLEAN DEFAULT false)");
    await c.query("CREATE TABLE posts (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, views INTEGER DEFAULT 0)");
    await c.query(`INSERT INTO users (email, name, active) VALUES ('ada@example.com', 'Ada Lovelace', true),
      ('alan@example.com', 'Alan Turing', true), ('grace@example.com', 'Grace Hopper', true), ('linus@example.com', 'Linus Torvalds', false)`);
    await c.query("INSERT INTO posts (user_id, title, views) VALUES (1, 'Notes on the Analytical Engine', 121), (2, 'Computing Machinery', 300), (3, 'COBOL tips', 80)");

    expect((await c.query("SELECT id, name, active FROM users WHERE email = $1", ["alan@example.com"])).rows)
      .toEqual([{ id: 2, name: "Alan Turing", active: true }]);
    expect((await c.query("SELECT name FROM users WHERE id > $1 AND name ILIKE $2 ORDER BY id", [1, "%o%"])).rows)
      .toEqual([{ name: "Grace Hopper" }, { name: "Linus Torvalds" }]);
    expect((await c.query("INSERT INTO posts (user_id, title, views) VALUES ($1, $2, $3) RETURNING id, title", [2, "Hello", 7])).rows)
      .toEqual([{ id: 4, title: "Hello" }]);
    for (const [id, title] of [[1, "Notes on the Analytical Engine"], [3, "COBOL tips"]] as const) {
      expect((await c.query({ name: "by-id", text: "SELECT title FROM posts WHERE id = $1", values: [id] })).rows).toEqual([{ title }]);
    }
    expect((await c.query("SELECT COUNT(*) FROM posts")).rows).toEqual([{ count: "4" }]);
    await expect(c.query("INSERT INTO users (email, name) VALUES ($1, $2)", ["ada@example.com", "dup"])).rejects.toMatchObject({ code: "23505" });
    expect((await c.query("SELECT $1::text AS still_alive", ["yes"])).rows).toEqual([{ still_alive: "yes" }]);
  } finally {
    await c.end();
  }
});

test("every extended-protocol Execute runs its statement exactly once", async () => {
  const c = await client(freshDb("once"));
  try {
    await c.query("CREATE TABLE hits (id SERIAL PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, label TEXT)");
    const count = async () => Number((await c.query("SELECT COUNT(*) AS n FROM hits")).rows[0].n);

    expect((await c.query("INSERT INTO hits (label) VALUES ($1)", ["unnamed"])).rowCount).toBe(1);
    expect(await count()).toBe(1);
    for (let i = 0; i < 3; i++) {
      expect((await c.query({ name: "ins", text: "INSERT INTO hits (label) VALUES ($1)", values: [`named-${i}`] })).rowCount).toBe(1);
    }
    expect(await count()).toBe(4);

    await c.query("INSERT INTO hits (label, n) VALUES ('counter', 0)");
    for (let i = 1; i <= 3; i++) {
      const r = await c.query({ name: "bump", text: "UPDATE hits SET n = n + 1 WHERE label = $1 RETURNING n", values: ["counter"] });
      expect(r.rows).toEqual([{ n: i }]);
    }
    expect((await c.query("UPDATE hits SET n = n + 1 WHERE label = $1 RETURNING n", ["counter"])).rows).toEqual([{ n: 4 }]);

    const del = { name: "del", text: "DELETE FROM hits WHERE label = $1", values: ["named-0"] };
    expect((await c.query(del)).rowCount).toBe(1);
    expect((await c.query(del)).rowCount).toBe(0);
    expect((await c.query("DELETE FROM hits WHERE label LIKE $1 RETURNING id", ["named-%"])).rowCount).toBe(2);
    expect(await count()).toBe(2);
  } finally {
    await c.end();
  }
});

test("SQL-looking string values survive translation", async () => {
  const c = await client(freshDb("strings"));
  try {
    const text = "UUID() DEFAULT CURRENT_TIMESTAMP SERIAL PRIMARY KEY current_database()";
    expect((await c.query(`SELECT '${text}' AS value`)).rows).toEqual([{ value: text }]);
  } finally {
    await c.end();
  }
});

test("session functions, SHOW and SET are answered without SQLite support", async () => {
  const name = freshDb("session");
  const c = await client(name);
  try {
    expect((await c.query("SELECT current_database(), upper(current_user) AS who, current_schema")).rows)
      .toEqual([{ current_database: name, who: "DEMO", current_schema: "public" }]);
    expect((await c.query("SELECT version()")).rows[0].version).toStartWith("PostgreSQL 16.4");
    expect((await c.query("SHOW search_path")).rows).toEqual([{ search_path: '"$user", public' }]);
    expect((await c.query("SET client_min_messages TO warning")).command).toBe("SET");
    await expect(c.query("SHOW nonsense")).rejects.toMatchObject({ code: "42704" });
  } finally {
    await c.end();
  }
});

test("a simple query can hold several statements, comments, or nothing", async () => {
  const c = await client(freshDb("multi"));
  try {
    const results = await c.query("CREATE TABLE a (x INT); -- make it\nINSERT INTO a VALUES (1), (2); SELECT x FROM public.a ORDER BY x;") as unknown as { command: string; rows: unknown[] }[];
    expect(results.map((r) => r.command)).toEqual(["CREATE", "INSERT", "SELECT"]);
    expect(results[2].rows).toEqual([{ x: 1 }, { x: 2 }]);
    for (const empty of ["", ";", "-- nothing here"]) expect((await c.query(empty)).rows).toEqual([]);
  } finally {
    await c.end();
  }
});

test("utility statements Polyglot can't parse are still classified by keyword", async () => {
  const c = await client(freshDb("utility"));
  try {
    for (const q of ["SET TIME ZONE 'UTC'", "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE", "RESET ALL"]) {
      await c.query(q);
    }
    expect((await c.query("DISCARD ALL")).command).toBe("DISCARD");
    await c.query("CREATE TABLE t (v INT)");
    await c.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await c.query("INSERT INTO t VALUES (1)");
    await c.query("ABORT");
    expect((await c.query("SELECT COUNT(*) AS n FROM t")).rows).toEqual([{ n: "0" }]);
  } finally {
    await c.end();
  }
});

test("set operations report SELECT, and pg_catalog-qualified session functions work", async () => {
  const name = freshDb("setops");
  const c = await client(name);
  try {
    const union = await c.query("SELECT 1 AS n UNION SELECT 2 ORDER BY n");
    expect([union.command, union.rowCount]).toEqual(["SELECT", 2]);
    expect((await c.query("SELECT pg_catalog.current_database(), user")).rows).toEqual([{ current_database: name, user: "demo" }]);
    const results = await c.query("CREATE TABLE a (id INT); SELECT 'pg_catalog.x' AS s") as unknown as { command: string }[];
    expect(results.map((r) => r.command)).toEqual(["CREATE", "SELECT"]);
    expect((await c.query("SELECT COUNT(*) AS n FROM a")).rows).toEqual([{ n: "0" }]);
  } finally {
    await c.end();
  }
});
