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
