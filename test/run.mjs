import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { start } from "./server.mjs";

process.env.FORK_TOKEN = crypto.randomUUID();
const server = await start(false);
try {
  const files = readdirSync("test").filter(f => f.endsWith(".test.mjs")).map(f => "test/" + f);
  const tests = spawnSync("bun", ["test", "--timeout", "90000", ...files], { stdio: "inherit" });
  process.exitCode = tests.status ?? 1;
  if (!process.exitCode) process.exitCode = spawnSync("bun", ["test/fork.mjs"], { stdio: "inherit" }).status ?? 1;
} finally {
  await server.stop();
}
