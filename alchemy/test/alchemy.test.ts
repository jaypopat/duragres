// Plain client and Alchemy v2 Duragres.Database lifecycle against the local Duragres Worker.
import { expect, test } from "bun:test";
import { inMemoryState, Stack } from "alchemy";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { AuthProvidersLive } from "alchemy/Auth/Registry";
import { deploy } from "alchemy/Deploy";
import { destroy } from "alchemy/Destroy";
import { layerNonInteractive } from "alchemy/Interaction";
import { literal } from "alchemy/Output";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Effect, Layer, Redacted } from "effect";
import pg from "pg";
import {
  Connect,
  connectEnvKey,
  ConnectHttp,
  connectionString,
  Database,
  dropDatabase,
  ensureDatabase,
  providers as duragresProviders,
} from "../src/index.ts";
import type { Server } from "../src/index.ts";
import { freshDb } from "../../test/setup.ts";

const LOCAL: Server = { host: "127.0.0.1", port: 8788, sslmode: "disable" };

async function query(url: string, sql: string) {
  const c = new pg.Client(url);
  const notices: Array<string> = [];
  c.on("notice", (n) => notices.push(n.message ?? ""));
  await c.connect();
  try {
    const res = await c.query(sql);
    return { rows: res.rows, notices };
  } finally {
    await c.end();
  }
}

test("client: ensureDatabase, branching, password rotation, and dropDatabase", async () => {
  const seed = freshDb("alc-seed");
  const branch = freshDb("alc-branch");
  const seedOwner = { user: "demo", password: "seed-password-1" };
  const branchOwner = { user: "app", password: "branch-password-1" };
  const branchRotated = { user: "app", password: "branch-password-2" };

  await expect(ensureDatabase(LOCAL, { name: "Bad_Name", owner: seedOwner })).rejects.toThrow(/not a Duragres database name/);

  // Create and claim the seed database; re-running is idempotent.
  await ensureDatabase(LOCAL, { name: seed, owner: seedOwner });
  await ensureDatabase(LOCAL, { name: seed, owner: seedOwner });
  await query(connectionString(LOCAL, seed, seedOwner), "CREATE TABLE items (name TEXT); INSERT INTO items VALUES ('from-seed');");

  // Unauthenticated connection to the protected seed is rejected.
  await expect(query(connectionString(LOCAL, seed, { user: "demo" }), "SELECT 1")).rejects.toThrow(/password must be a string/);

  // Branch from seed with its own role and password; re-running is idempotent.
  const template = { name: seed, ...seedOwner };
  await ensureDatabase(LOCAL, { name: branch, template, owner: branchOwner });
  await ensureDatabase(LOCAL, { name: branch, template, owner: branchOwner });
  const branchRows = await query(connectionString(LOCAL, branch, branchOwner), "SELECT name FROM items");
  expect(branchRows.rows).toEqual([{ name: "from-seed" }]);

  // Rotate the branch's password using previousOwner.
  await ensureDatabase(LOCAL, { name: branch, template, owner: branchRotated, previousOwner: branchOwner });
  await expect(query(connectionString(LOCAL, branch, branchOwner), "SELECT 1")).rejects.toMatchObject({ code: "28000" });
  expect((await query(connectionString(LOCAL, branch, branchRotated), "SELECT name FROM items")).rows).toEqual([{ name: "from-seed" }]);

  // Dropping the branch from its template works even though the branch set its own password.
  expect(await dropDatabase(LOCAL, { name: branch, template, owner: branchRotated })).toBe("dropped");
  // Reconnecting creates it afresh (with NOTICE and no `items` table); seed is untouched.
  const recreated = await query(connectionString(LOCAL, branch, { user: "demo" }), "SELECT 1 AS ok");
  expect(recreated.notices).toHaveLength(1);
  expect((await query(connectionString(LOCAL, seed, seedOwner), "SELECT name FROM items")).rows).toEqual([{ name: "from-seed" }]);

  // Dropping a standalone database clears its passwords so it expires on TTL.
  expect(await dropDatabase(LOCAL, { name: seed, owner: seedOwner })).toBe("expiring");
  expect((await query(connectionString(LOCAL, seed, { user: "demo" }), "SELECT name FROM items")).rows).toEqual([{ name: "from-seed" }]);
});

test("alchemy: full Stack deploy, noop, in-place password update, template replace, and destroy", async () => {
  const seedA = freshDb("alc-sa");
  const seedB = freshDb("alc-sb");
  const preview = freshDb("alc-prev");
  const state = inMemoryState({}, {});
  const providers = duragresProviders(LOCAL);
  const stage = "pr-42";
  const runtime = Layer.mergeAll(
    state,
    Layer.succeed(ArtifactStore, createArtifactStore()),
    AuthProvidersLive,
    layerNonInteractive(),
  );
  const run = <A, E>(eff: Effect.Effect<A, E, Layer.Success<typeof runtime>>) =>
    Effect.runPromise(eff.pipe(Effect.provide(runtime)));

  const makeStack = (opts: { template: "a" | "b"; previewPassword?: string; previewUser?: string }) =>
    Stack(
      "DuragresTest",
      { providers, state },
      Effect.gen(function* () {
        const a = yield* Database("SeedA", { name: seedA });
        const b = yield* Database("SeedB", { name: seedB });
        const branch = yield* Database("PreviewDatabase", {
          name: preview,
          template: opts.template === "a" ? a.origin : b.origin,
          user: opts.previewUser,
          password: opts.previewPassword,
        });
        return {
          aUri: a.connectionUri,
          bUri: b.connectionUri,
          previewName: branch.name,
          previewOrigin: branch.origin,
          previewUri: branch.connectionUri,
        };
      }),
    );

  // 1. Initial deploy: creates SeedA, SeedB (auto-generated passwords) and branches PreviewDatabase from SeedA.
  const first = await run(deploy({ stack: makeStack({ template: "a" }), stage }));
  expect(first.previewName).toBe(preview);
  expect(first.previewOrigin.scheme).toBe("postgres");
  expect(first.previewOrigin.host).toBe("127.0.0.1");
  expect(first.previewOrigin.port).toBe(8788);
  expect(first.previewOrigin.database).toBe(preview);
  expect(first.previewOrigin.user).toBe("demo");
  expect(Redacted.isRedacted(first.previewOrigin.password)).toBe(true);
  expect(Redacted.value(first.previewOrigin.password)).toHaveLength(64);

  // Seed distinct rows into SeedA and SeedB, and write a preview-only row to verify in-place updates keep data.
  await query(Redacted.value(first.aUri), "CREATE TABLE tag (v TEXT); INSERT INTO tag VALUES ('from-a');");
  await query(Redacted.value(first.bUri), "CREATE TABLE tag (v TEXT); INSERT INTO tag VALUES ('from-b');");
  await query(Redacted.value(first.previewUri), "CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('kept');");

  // 2. No-op redeploy keeps the same auto-generated password and data.
  const second = await run(deploy({ stack: makeStack({ template: "a" }), stage }));
  expect(Redacted.value(second.previewOrigin.password)).toBe(Redacted.value(first.previewOrigin.password));
  expect((await query(Redacted.value(second.previewUri), "SELECT v FROM marker")).rows).toEqual([{ v: "kept" }]);

  // 3. In-place password + user update keeps existing tables/rows and rotates credentials.
  const updated = await run(
    deploy({ stack: makeStack({ template: "a", previewUser: "preview_app", previewPassword: "rotated-secret" }), stage }),
  );
  expect(updated.previewOrigin.user).toBe("preview_app");
  expect(Redacted.value(updated.previewOrigin.password)).toBe("rotated-secret");
  expect((await query(Redacted.value(updated.previewUri), "SELECT v FROM marker")).rows).toEqual([{ v: "kept" }]);

  // 4. Changing template on a fixed-name branch replaces it (deleteFirst: true) with SeedB's data.
  const replaced = await run(
    deploy({ stack: makeStack({ template: "b", previewUser: "preview_app", previewPassword: "rotated-secret" }), stage }),
  );
  expect((await query(Redacted.value(replaced.previewUri), "SELECT v FROM tag")).rows).toEqual([{ v: "from-b" }]);
  await expect(query(Redacted.value(replaced.previewUri), "SELECT v FROM marker")).rejects.toMatchObject({ code: "42P01" });

  // 5. Destroy drops the branched preview DB immediately and unprotects the standalone seeds.
  await run(destroy({ stack: makeStack({ template: "b", previewUser: "preview_app", previewPassword: "rotated-secret" }), stage }));
  const afterDrop = await query(connectionString(LOCAL, preview, { user: "demo" }), "SELECT 1 AS ok");
  expect(afterDrop.notices).toHaveLength(1);
});

test("alchemy: Duragres.Connect binds connectionUri through RuntimeContext", async () => {
  const uriText = "postgres://demo:secret@127.0.0.1:8788/preview?sslmode=disable";
  const env: RuntimeContext["Service"]["env"] = {};
  const mockRuntimeContext = Layer.succeed(RuntimeContext, {
    Type: "TestHost",
    id: "test",
    env,
    set: (key, value) =>
      Effect.sync(() => {
        env[key] = value;
        return key;
      }),
    get: (key) => Effect.succeed(env[key]),
  });

  const fakeDb = {
    FQN: "DuragresTest/PreviewDatabase",
    connectionUri: literal(Redacted.make(uriText)),
  };

  const client = await Effect.runPromise(
    Connect(fakeDb).pipe(Effect.provide(ConnectHttp), Effect.provide(mockRuntimeContext)),
  );
  const key = connectEnvKey(fakeDb);
  expect(key in env).toBe(true);

  // Simulate runtime reading the resolved string back out of the host environment.
  env[key] = uriText;
  const uri = await Effect.runPromise(client.connectionString.pipe(Effect.provide(mockRuntimeContext)));
  expect(Redacted.value(uri)).toBe(uriText);
});
