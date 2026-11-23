// Drizzle ORM against duragres: inserts with .returning(), a typed join, an
// update, an upsert, and runtime type checks on what comes back.
import { drizzle } from "drizzle-orm/node-postgres";
import { desc, eq, ilike, sql } from "drizzle-orm";
import pg from "pg";
import assert from "node:assert/strict";
import { posts, users } from "../schema.ts";

const url = process.env.DATABASE_URL ?? "postgres://demo@localhost:8788/drizzledb?sslmode=disable";
const client = new pg.Client(url);
client.on("notice", (n) => console.log(`NOTICE: ${n.message}`));
await client.connect();
const db = drizzle(client);
const show = (label: string, v: unknown) => console.log(`\n▸ ${label}\n`, v);

// Clean slate so the demo is repeatable
await db.delete(posts);
await db.delete(users);

const [ada] = await db.insert(users).values({ name: "Ada Lovelace", email: "ada@example.com", prefs: { theme: "dark" } }).returning();
const [alan] = await db.insert(users).values({ name: "Alan Turing", email: "alan@example.com", active: false }).returning({ id: users.id, name: users.name });
const grace = await db.insert(users).values([
  { name: "Grace Hopper", email: "grace@example.com", prefs: { theme: "light", beta: true } },
  { name: "Linus Torvalds", email: "linus@example.com", active: false },
]).returning();
show("insert ... returning()", { ada, alan, grace });

assert.equal(typeof ada.id, "number");
assert.equal(typeof ada.active, "boolean");
assert.ok(ada.createdAt instanceof Date && !Number.isNaN(+ada.createdAt), "createdAt is a Date");
assert.deepEqual(ada.prefs, { theme: "dark" });
assert.match(ada.publicId, /^[0-9a-f-]{36}$/);

await db.insert(posts).values([
  { userId: ada.id, title: "Notes on the Analytical Engine", views: 120 },
  { userId: ada.id, title: "Bernoulli numbers", views: 45 },
  { userId: alan.id, title: "Computing Machinery and Intelligence", views: 300 },
]);

const rows = await db
  .select({ author: users.name, active: users.active, title: posts.title, views: posts.views, joined: users.createdAt })
  .from(posts)
  .innerJoin(users, eq(posts.userId, users.id))
  .where(eq(users.active, true))
  .orderBy(desc(posts.views));
show("select ... innerJoin ... where active = true", rows);
assert.equal(rows.length, 2);
assert.ok(rows.every((r) => typeof r.active === "boolean" && r.active === true && r.joined instanceof Date && typeof r.views === "number"));

const updated = await db.update(users).set({ active: true, prefs: { theme: "solarized" } }).where(ilike(users.name, "%turing%")).returning({ name: users.name, active: users.active, prefs: users.prefs });
show("update ... where ilike ... returning()", updated);
assert.deepEqual(updated, [{ name: "Alan Turing", active: true, prefs: { theme: "solarized" } }]);

const upserted = await db
  .insert(users)
  .values({ name: "Ada King, Countess of Lovelace", email: "ada@example.com" })
  .onConflictDoUpdate({ target: users.email, set: { name: sql`excluded.name` } })
  .returning({ id: users.id, name: users.name, email: users.email });
show("insert ... onConflictDoUpdate (upsert)", upserted);
assert.equal(upserted[0].id, ada.id, "upsert must update the existing row");

const [{ count }] = await db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(users);
show("select count(*)", count);
assert.equal(count, 4);

await client.end();
console.log("\n✓ Drizzle demo OK: booleans are booleans, timestamps are Dates, jsonb is objects");
