// It is PostgreSQL: features a translation layer would have to emulate just work.
import { expect, test } from "bun:test";
import { client, freshDb } from "./setup";

test("JSONB operators, functions and indexes", async () => {
  const c = await client(freshDb("jsonb"));
  try {
    await c.query(`CREATE TABLE docs (id serial PRIMARY KEY, data jsonb NOT NULL)`);
    await c.query(`INSERT INTO docs (data) VALUES ('{"name":"a","tags":["x","y"],"meta":{"n":1}}'), ('{"name":"b","tags":["z"],"meta":{"n":2}}')`);
    await c.query("CREATE INDEX ON docs USING gin (data)");
    await c.query("CREATE INDEX ON docs ((data->>'name'))");
    type Doc = { name: string; meta: { n: number }; tags?: Array<string>; extra?: boolean };
    const one = async (sql: string) => (await c.query<{ v: string | number | Doc | Array<string> }>(sql)).rows;
    expect(await one(`SELECT data#>>'{meta,n}' AS v FROM docs WHERE data @> '{"name":"b"}'`)).toEqual([{ v: "2" }]);
    expect(await one(`SELECT count(*)::int AS v FROM docs WHERE data ? 'meta'`)).toEqual([{ v: 2 }]);
    expect(await one(`SELECT jsonb_set(data, '{meta,n}', '5') - 'tags' AS v FROM docs WHERE id = 1`)).toEqual([{ v: { name: "a", meta: { n: 5 } } }]);
    expect(await one(`SELECT data || '{"extra":true}' AS v FROM docs WHERE id = 2`)).toEqual([{ v: { extra: true, name: "b", tags: ["z"], meta: { n: 2 } } }]);
    expect(await one(`SELECT jsonb_agg(data->'name' ORDER BY id) AS v FROM docs`)).toEqual([{ v: ["a", "b"] }]);
    expect(await one(`SELECT '{"a":1}'::jsonb ->> 'a' AS v`)).toEqual([{ v: "1" }]);
    expect((await c.query(`SELECT jsonb_array_elements_text(data->'tags') AS t FROM docs WHERE id = 1`)).rows).toEqual([{ t: "x" }, { t: "y" }]);
  } finally {
    await c.end();
  }
});

test("COPY TO STDOUT works; COPY FROM STDIN is refused without disturbing the connection", async () => {
  const c = await client(freshDb("copy"));
  try {
    await c.query("CREATE TABLE t (v INT); INSERT INTO t VALUES (1)");
    expect((await c.query("COPY t TO STDOUT")).command).toBe("COPY");
    await expect(c.query("COPY t FROM STDIN")).rejects.toMatchObject({ code: "0A000" });
    expect((await c.query("SELECT COUNT(*)::int AS n FROM t")).rows).toEqual([{ n: 1 }]);
  } finally {
    await c.end();
  }
});

test("PL/pgSQL: DO blocks, functions and triggers", async () => {
  const c = await client(freshDb("plpgsql"));
  try {
    await c.query("CREATE TABLE t (id serial PRIMARY KEY, body text, updated_at timestamptz)");
    await c.query(`DO $$ BEGIN FOR i IN 1..3 LOOP INSERT INTO t (body) VALUES ('row ' || i); END LOOP; END $$`);
    await c.query(`CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at := now(); RETURN NEW; END $$`);
    await c.query("CREATE TRIGGER t_touch BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION touch()");
    await c.query("UPDATE t SET body = 'changed' WHERE id = 2");
    expect((await c.query("SELECT id, updated_at IS NOT NULL AS touched FROM t ORDER BY id")).rows)
      .toEqual([{ id: 1, touched: false }, { id: 2, touched: true }, { id: 3, touched: false }]);
    await c.query(`CREATE FUNCTION add(a int, b int) RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN a + b; END $$`);
    expect((await c.query("SELECT add(2, 3) AS v")).rows).toEqual([{ v: 5 }]);
  } finally {
    await c.end();
  }
});

test("full-text search with the English dictionary", async () => {
  const c = await client(freshDb("fts"));
  try {
    expect((await c.query(`SELECT to_tsvector('english', 'The quick brown foxes jumped')::text AS v`)).rows)
      .toEqual([{ v: "'brown':3 'fox':4 'jump':5 'quick':2" }]);
    expect((await c.query(`SELECT to_tsvector('english', 'running dogs') @@ to_tsquery('english', 'run & dog') AS v`)).rows).toEqual([{ v: true }]);
  } finally {
    await c.end();
  }
});

test("statements Duragres refuses leave the connection usable", async () => {
  const c = await client(freshDb("refusals"));
  try {
    await c.query("CREATE TABLE t (v text); INSERT INTO t VALUES ('x')");
    // Extended protocol (a named statement): refused, and the batch is discarded up to its Sync.
    await expect(c.query({ name: "cd", text: `CREATE DATABASE "${freshDb("x")}"` })).rejects.toMatchObject({ code: "0A000" });
    expect((await c.query("SELECT v FROM t")).rows).toEqual([{ v: "x" }]);
    // COPY FROM STDIN is found behind comments; text that only mentions it is not refused.
    await expect(c.query("/* load */ COPY t FROM STDIN")).rejects.toMatchObject({ code: "0A000" });
    expect((await c.query("COPY (SELECT 'from stdin') TO STDOUT")).command).toBe("COPY");
  } finally {
    await c.end();
  }
});
