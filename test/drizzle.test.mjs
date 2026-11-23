// drizzle-kit migrate (twice: second is a no-op) + examples/drizzle/fixture.ts (twice: repeatable) on a fresh database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { freshDb, url } from "./helpers.mjs";

test("drizzle-kit migrate + Drizzle demo", () => {
  const env = { ...process.env, DATABASE_URL: url(freshDb("drizzle")) };
  const run = (args) => execFileSync("bun", args, { cwd: "examples/drizzle", env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  for (let i = 0; i < 2; i++) assert.match(run(["x", "drizzle-kit", "migrate"]), /migrations applied successfully/);
  assert.match(run(["demo.ts"]), /Ada/);
  for (let i = 0; i < 2; i++) assert.match(run(["test/fixture.ts"]), /Drizzle demo OK/);
});
