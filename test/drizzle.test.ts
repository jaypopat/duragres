// drizzle-kit and Drizzle ORM against Duragres, and branching with CREATE DATABASE ... TEMPLATE.
import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { client, databaseUrl, freshDb } from "./setup";

const EXAMPLE = "examples/drizzle";

function run(args: Array<string>, url: string) {
  const r = Bun.spawnSync(["bun", ...args], { cwd: EXAMPLE, env: { ...process.env, DATABASE_URL: url } });
  const out = r.stdout.toString() + r.stderr.toString();
  if (!r.success) throw new Error(out);
  return out;
}

test("CREATE DATABASE ... TEMPLATE copies committed data, and the copy migrates on its own", async () => {
  const source = freshDb("fork-source");
  const branch = freshDb("fork-branch");
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

    expect((await parent.query(`CREATE DATABASE "${branch}" TEMPLATE "${source}"`)).command).toBe("CREATE");
    // Writes after the copy stay in the source.
    await parent.query("UPDATE users SET name = 'Written after the copy' WHERE id = 1");
    fork = await client(branch);
    expect((await fork.query(readUsers)).rows).toEqual(baseline);
    expect((await fork.query("SELECT id FROM posts")).rowCount).toBe(3);

    // A new migration applied only to the branch.
    const journalFile = Bun.file(join(migrations, "meta/_journal.json"));
    const journal: { entries: Array<{ idx: number; when: number; tag: string }> } = await journalFile.json();
    const previous = journal.entries.at(-1)!;
    const next = { ...previous, idx: previous.idx + 1, when: previous.when + 1, tag: "0001_add_nickname" };
    journal.entries.push(next);
    await Bun.write(journalFile, JSON.stringify(journal));
    await Bun.write(join(migrations, `${next.tag}.sql`), 'ALTER TABLE "users" ADD COLUMN "nickname" text;\n');
    const config = join(migrations, "drizzle.config.ts");
    await Bun.write(config, `export default { dialect: "postgresql", out: ${JSON.stringify(migrations)}, dbCredentials: { url: process.env.DATABASE_URL } };\n`);
    expect(run(["x", "drizzle-kit", "migrate", "--config", config], databaseUrl(branch))).toContain("migrations applied successfully");
    expect((await fork.query("SELECT nickname FROM users WHERE id = 1")).rows).toEqual([{ nickname: null }]);
    await expect(parent.query("SELECT nickname FROM users")).rejects.toMatchObject({ code: "42703" });

    // The agent is done with its branch.
    await fork.end();
    fork = undefined;
    expect((await parent.query(`DROP DATABASE "${branch}"`)).command).toBe("DROP");
    expect((await parent.query(readUsers)).rows[0].name).toBe("Written after the copy");
  } finally {
    await Promise.allSettled([parent.end(), fork?.end()]);
    await rm(migrations, { recursive: true, force: true });
  }
});

test("CREATE and DROP DATABASE follow Postgres' rules", async () => {
  const name = freshDb("dbcmd");
  const other = freshDb("dbcmd-other");
  const c = await client(name);
  const elsewhere = await client(other);
  try {
    await expect(c.query(`CREATE DATABASE "${freshDb("x")}" TEMPLATE "${other}"`)).rejects.toMatchObject({ code: "0A000" });
    await expect(c.query(`CREATE DATABASE "${other}"`)).rejects.toMatchObject({ code: "42P04" });
    await expect(c.query("CREATE DATABASE Bad_Name")).rejects.toMatchObject({ code: "42602" });
    await expect(c.query(`DROP DATABASE "${name}"`)).rejects.toMatchObject({ code: "55006" });
    await expect(c.query(`DROP DATABASE "${freshDb("missing")}"`)).rejects.toMatchObject({ code: "3D000" });
    expect((await c.query(`DROP DATABASE IF EXISTS "${freshDb("missing")}"`)).command).toBe("DROP");

    await c.query("BEGIN");
    await expect(c.query(`DROP DATABASE "${other}"`)).rejects.toMatchObject({ code: "25001" });
    await c.query("ROLLBACK");

    await elsewhere.query("CREATE TABLE t (v INT)");
    await expect(c.query(`DROP DATABASE "${other}"`)).rejects.toMatchObject({ code: "55006" });
    const errors: Array<unknown> = [];
    elsewhere.on("error", (e) => errors.push(e)); // the FATAL, then the closed socket
    await c.query(`DROP DATABASE "${other}" WITH (FORCE)`);
    await Bun.sleep(50);
    expect(errors[0]).toMatchObject({ code: "57P01" });
    const again = await client(other); // connecting creates it afresh
    await expect(again.query("SELECT * FROM t")).rejects.toMatchObject({ code: "42P01" });
    await again.end();
  } finally {
    await Promise.allSettled([c.end(), elsewhere.end()]);
  }
});
