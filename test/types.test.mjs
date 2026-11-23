// Shadow catalog typing: values arrive as the JS types node-postgres maps Postgres OIDs to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { client, freshDb } from "./helpers.mjs";

test("bool, timestamptz, jsonb, uuid, int4 come back typed; params are converted", async () => {
  const c = await client(freshDb("types"));
  try {
    await c.query(`CREATE TABLE users (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, active BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now(), prefs JSONB, public_id UUID DEFAULT gen_random_uuid(), score DOUBLE PRECISION)`);
    await c.query("INSERT INTO users (name, active, prefs, score) VALUES ($1, $2, $3, $4)", ["ada", true, { theme: "dark", n: 1 }, 1.5]);
    await c.query("INSERT INTO users (name, active, created_at) VALUES ($1, $2, $3)", ["alan", false, new Date("2026-01-02T03:04:05.678Z")]);

    const { rows, fields } = await c.query("SELECT id, name, active, created_at, prefs, public_id, score FROM users ORDER BY id");
    assert.deepEqual(fields.map((f) => [f.name, f.dataTypeID]), [["id", 23], ["name", 25], ["active", 16], ["created_at", 1184], ["prefs", 3802], ["public_id", 2950], ["score", 701]]);
    const [ada, alan] = rows;
    assert.equal(typeof ada.id, "number");
    assert.equal(ada.active, true);
    assert.equal(alan.active, false);
    assert.ok(ada.created_at instanceof Date && !Number.isNaN(ada.created_at.getTime()), "created_at should be a valid Date");
    assert.ok(Math.abs(Date.now() - ada.created_at.getTime()) < 60_000, `default now() far from now: ${ada.created_at.toISOString()}`);
    assert.equal(alan.created_at.toISOString(), "2026-01-02T03:04:05.678Z", "timestamptz param round-trip");
    assert.deepEqual(ada.prefs, { theme: "dark", n: 1 });
    assert.match(ada.public_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(ada.score, 1.5);

    // Bool params: 'true'/'t'/false are stored as 1/0 so comparisons work
    assert.equal((await c.query("SELECT name FROM users WHERE active = $1", [true])).rows[0].name, "ada");
    assert.equal((await c.query("SELECT name FROM users WHERE active = $1", ["f"])).rows[0].name, "alan");
    assert.equal((await c.query("SELECT COUNT(*) AS n FROM users WHERE created_at > $1", [new Date("2026-01-01T00:00:00Z")])).rows[0].n, "2");

    // Aliases, qualified columns, joins, *, RETURNING, casts
    await c.query("CREATE TABLE posts (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), published BOOLEAN DEFAULT true)");
    await c.query("INSERT INTO posts (user_id) VALUES (1)");
    const j = await c.query("SELECT u.active AS on_, p.published, p.* FROM users u JOIN posts p ON p.user_id = u.id");
    assert.deepEqual(j.rows[0], { on_: true, published: true, id: 1, user_id: 1 });
    const ret = await c.query("UPDATE users SET active = NOT active WHERE id = $1 RETURNING active, created_at", [1]);
    assert.equal(ret.rows[0].active, false);
    assert.ok(ret.rows[0].created_at instanceof Date);
    const star = await c.query("SELECT * FROM users WHERE id = 2");
    assert.equal(star.rows[0].active, false);
    assert.ok(star.rows[0].created_at instanceof Date);
    assert.equal((await c.query("SELECT id::text AS t FROM users WHERE id = 1")).rows[0].t, "1");

    // Expressions without a column origin fall back to value inference (count -> int8 -> string in node-pg)
    assert.equal((await c.query("SELECT COUNT(*) FROM users")).fields[0].dataTypeID, 20);

    // ALTER TABLE ADD/DROP COLUMN keeps the catalog in sync
    await c.query("ALTER TABLE users ADD COLUMN verified BOOLEAN DEFAULT true");
    assert.equal((await c.query("SELECT verified FROM users WHERE id = 1")).rows[0].verified, true);
    await c.query("ALTER TABLE users DROP COLUMN verified");
    await c.query("DROP TABLE posts");
    const cat = await c.query("SELECT COUNT(*) AS n FROM _pg_columns WHERE table_name = 'posts'");
    assert.equal(cat.rows[0].n, "0", "DROP TABLE should remove catalog rows");
  } finally {
    await c.end();
  }
});
