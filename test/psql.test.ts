// A scripted session in real psql 18 (via Docker, see bin/psql).
import { expect, test } from "bun:test";
import { databaseUrl, freshDb } from "./setup";

test("psql runs test/fixtures/session.sql with only its three intentional errors", async () => {
  const proc = Bun.spawn(["bin/psql", databaseUrl(freshDb("psql")), "-f", "test/fixtures/session.sql"], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  const errors = out.split("\n").filter((line) => line.includes("ERROR:")).map((line) => line.match(/ERROR:\s+(\w+)/)?.[1]);
  expect(errors, out).toEqual(["23505", "23502", "42P01"]);
  expect(out).toContain("List of tables");
  expect(out).toContain("timestamp with time zone");
});
