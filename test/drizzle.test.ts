// drizzle-kit and Drizzle ORM against Duragres, including a fork that takes a migration the parent never sees.
import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { client, databaseUrl, forkToken, freshDb, httpUrl } from "./setup";

const EXAMPLE = "examples/drizzle";

function run(args: string[], url: string) {
  const r = Bun.spawnSync(["bun", ...args], { cwd: EXAMPLE, env: { ...process.env, DATABASE_URL: url } });
  const out = r.stdout.toString() + r.stderr.toString();
  if (!r.success) throw new Error(out);
  return out;
}

test("drizzle-kit migrate is repeatable and the ORM round-trips types", () => {
  const url = databaseUrl(freshDb("drizzle"));
  for (let i = 0; i < 2; i++) expect(run(["x", "drizzle-kit", "migrate"], url)).toContain("migrations applied successfully");
  expect(run(["demo.ts"], url)).toContain("Ada");
  for (let i = 0; i < 2; i++) expect(run(["test/fixture.ts"], url)).toContain("Drizzle demo OK");
});

test("a fork copies committed data and migrates independently of its parent", async () => {
  const source = freshDb("fork-source");
  const migrations = await mkdtemp(join(process.cwd(), EXAMPLE, ".fork-"));
  const parent = await client(source);
  let fork: Awaited<ReturnType<typeof client>> | undefined;
  try {
    await cp(join(EXAMPLE, "drizzle"), migrations, { recursive: true });
    run(["x", "drizzle-kit", "migrate"], databaseUrl(source));
    run(["test/fixture.ts"], databaseUrl(source));
    const readUsers = "SELECT id, name, active, prefs FROM users ORDER BY id";
    const baseline = (await parent.query(readUsers)).rows;
    expect(baseline).toHaveLength(4);

    // An open transaction on the parent is not part of the fork.
    await parent.query("BEGIN");
    await parent.query("UPDATE users SET name = 'Pending source write' WHERE id = 1");
    const response = await fetch(`${httpUrl()}/forks?source=${source}`, { method: "POST", headers: { authorization: `Bearer ${forkToken()}` } });
    expect(response.status, await response.clone().text()).toBe(201);
    const { name } = await response.json() as { name: string };
    fork = await client(name);
    expect((await fork.query(readUsers)).rows).toEqual(baseline);
    expect((await fork.query("SELECT id FROM posts")).rowCount).toBe(3);
    await parent.query("COMMIT");
    expect((await fork.query(readUsers)).rows).toEqual(baseline);

    // A new migration applied only to the fork.
    const journalFile = Bun.file(join(migrations, "meta/_journal.json"));
    const journal = await journalFile.json();
    const previous = journal.entries.at(-1);
    const next = { ...previous, idx: previous.idx + 1, when: previous.when + 1, tag: "0001_add_nickname" };
    journal.entries.push(next);
    await Bun.write(journalFile, JSON.stringify(journal));
    await Bun.write(join(migrations, `${next.tag}.sql`), 'ALTER TABLE "users" ADD COLUMN "nickname" text;\n');
    const config = join(migrations, "drizzle.config.ts");
    await Bun.write(config, `export default { dialect: "postgresql", out: ${JSON.stringify(migrations)}, dbCredentials: { url: process.env.DATABASE_URL } };\n`);
    expect(run(["x", "drizzle-kit", "migrate", "--config", config], databaseUrl(name))).toContain("migrations applied successfully");
    expect((await fork.query("SELECT nickname FROM users WHERE id = 1")).rows).toEqual([{ nickname: null }]);
    await expect(parent.query("SELECT nickname FROM users")).rejects.toMatchObject({ code: "42703" });

    await fork.query("DELETE FROM posts");
    await fork.query("DELETE FROM users");
    expect((await parent.query(readUsers)).rowCount).toBe(4);
  } finally {
    await Promise.allSettled([parent.end(), fork?.end()]);
    await rm(migrations, { recursive: true, force: true });
  }
});

test("forks require the token and an existing source", async () => {
  const post = (source: string, token = forkToken()) =>
    fetch(`${httpUrl()}/forks?source=${source}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  expect((await post("whatever", "wrong")).status).toBe(401);
  expect((await post("Not_Valid")).status).toBe(400);
  expect((await post(freshDb("missing"))).status).toBe(404);
});
