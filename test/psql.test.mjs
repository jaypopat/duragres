// The scripted psql session (real psql 18 via Docker) runs with only its 3 intentional errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { freshDb, url } from "./helpers.mjs";

test("psql runs test/fixtures/session.sql: only the 3 intentional errors", () => {
  const r = spawnSync("bin/psql", [url(freshDb("psql")), "-f", "test/fixtures/session.sql"], { encoding: "utf8" });
  const out = r.stdout + r.stderr;
  const errors = out.split("\n").filter((l) => /ERROR:/.test(l));
  assert.deepEqual(errors.map((l) => l.match(/ERROR:\s+(\w+)/)?.[1]), ["23505", "23502", "42P01"], out);
  assert.match(out, /List of tables/);
  assert.match(out, /timestamp with time zone/);
});
