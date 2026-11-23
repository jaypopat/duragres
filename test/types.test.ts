// Values arrive as the JS types node-postgres maps Postgres OIDs to.
import { expect, test } from "bun:test";
import { client, freshDb } from "./setup";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("columns come back typed and parameters are converted", async () => {
  const c = await client(freshDb("types"));
  try {
    await c.query(`CREATE TABLE users (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, active BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now(), prefs JSONB, public_id UUID DEFAULT gen_random_uuid(), score DOUBLE PRECISION)`);
    await c.query("INSERT INTO users (name, active, prefs, score) VALUES ($1, $2, $3, $4)", ["ada", true, { theme: "dark", n: 1 }, 1.5]);
    await c.query("INSERT INTO users (name, active, created_at) VALUES ($1, $2, $3)", ["alan", false, new Date("2026-01-02T03:04:05.678Z")]);

    const { rows, fields } = await c.query("SELECT id, name, active, created_at, prefs, public_id, score FROM users ORDER BY id");
    expect(fields.map((f) => [f.name, f.dataTypeID])).toEqual([
      ["id", 23], ["name", 25], ["active", 16], ["created_at", 1184], ["prefs", 3802], ["public_id", 2950], ["score", 701],
    ]);
    const [ada, alan] = rows;
    expect(ada).toMatchObject({ id: 1, active: true, prefs: { theme: "dark", n: 1 }, score: 1.5 });
    expect(alan.active).toBe(false);
    expect(ada.created_at).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - ada.created_at.getTime())).toBeLessThan(60_000);
    expect(alan.created_at.toISOString()).toBe("2026-01-02T03:04:05.678Z");
    expect(ada.public_id).toMatch(UUID_V4);

    expect((await c.query("SELECT name FROM users WHERE active = $1", [true])).rows).toEqual([{ name: "ada" }]);
    expect((await c.query("SELECT name FROM users WHERE active = $1", ["f"])).rows).toEqual([{ name: "alan" }]);
    expect((await c.query("SELECT COUNT(*) AS n FROM users WHERE created_at > $1", [new Date("2026-01-01T00:00:00Z")])).rows).toEqual([{ n: "2" }]);

    // Aliases, qualified columns, joins, *, RETURNING and casts keep their column types.
    await c.query("CREATE TABLE posts (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), published BOOLEAN DEFAULT true)");
    await c.query("INSERT INTO posts (user_id) VALUES (1)");
    expect((await c.query("SELECT u.active AS on_, p.published, p.* FROM users u JOIN posts p ON p.user_id = u.id")).rows)
      .toEqual([{ on_: true, published: true, id: 1, user_id: 1 }]);
    const returned = (await c.query("UPDATE users SET active = NOT active WHERE id = $1 RETURNING active, created_at", [1])).rows[0];
    expect(returned.active).toBe(false);
    expect(returned.created_at).toBeInstanceOf(Date);
    expect((await c.query("SELECT * FROM users WHERE id = 2")).rows[0]).toMatchObject({ active: false, created_at: expect.any(Date) });
    expect((await c.query("SELECT id::text AS t FROM users WHERE id = 1")).rows).toEqual([{ t: "1" }]);
    expect((await c.query("SELECT COUNT(*) FROM users")).fields[0].dataTypeID).toBe(20);

    await c.query("ALTER TABLE users ADD COLUMN verified BOOLEAN DEFAULT true");
    expect((await c.query("SELECT verified FROM users WHERE id = 1")).rows).toEqual([{ verified: true }]);
    await c.query("ALTER TABLE users DROP COLUMN verified");
    await c.query("DROP TABLE posts");
    await c.query("CREATE TABLE posts (id INTEGER, title TEXT)");
    expect((await c.query("SELECT id, title FROM posts")).fields.map((f) => f.dataTypeID)).toEqual([23, 25]);
  } finally {
    await c.end();
  }
});

test("an open connection sees column types created by another", async () => {
  const name = freshDb("catalog");
  const reader = await client(name);
  const writer = await client(name);
  try {
    await reader.query("SELECT 1");
    await writer.query("CREATE TABLE flags (enabled BOOLEAN)");
    await writer.query("INSERT INTO flags VALUES (true)");
    expect((await reader.query("SELECT enabled FROM flags")).rows).toEqual([{ enabled: true }]);
  } finally {
    await Promise.all([reader.end(), writer.end()]);
  }
});
