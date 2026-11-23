// A scripted session in real psql 18, from the official postgres:18 Docker image.
import { expect, test } from "bun:test";
import { databaseUrl, freshDb } from "./setup";

// Mounts the repo at /w so psql can read the fixture by its relative path.
const PSQL = ["docker", "run", "--rm", "-i", "--network", "host", "-v", `${process.cwd()}:/w`, "-w", "/w", "-e", "PAGER=cat", "postgres:18", "psql"];

test("psql runs test/fixtures/session.sql with only its three intentional errors", async () => {
  const proc = Bun.spawn([...PSQL, databaseUrl(freshDb("psql")), "-f", "test/fixtures/session.sql"], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  const errors = out.split("\n").filter((line) => line.includes("ERROR:")).map((line) => line.match(/ERROR:\s+(\w+)/)?.[1]);
  expect(errors, out).toEqual(["23505", "23502", "42P01"]);
  expect(out).toContain("List of tables");
  expect(out).toContain("timestamp with time zone");
});
