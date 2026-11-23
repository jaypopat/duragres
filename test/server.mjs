import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import config from "../wrangler.jsonc";

export const LIMITS = { TTL_SECONDS: "30", IDLE_TIMEOUT_SECONDS: "6", MAX_CONNECTIONS: "3", MAX_NEW_DBS_PER_HOUR: "6" };
export const url = db => `postgres://demo@127.0.0.1:8798/${db}?sslmode=disable`;

export async function start(shortLimits = true) {
  const dir = mkdtempSync(join(tmpdir(), "duragres-test-"));
  const port = shortLimits ? 8797 : 8787;
  const path = join(dir, "wrangler.json");
  writeFileSync(path, JSON.stringify({
    ...config, main: resolve(config.main),
    connect: [{ protocol: "tcp", port: port + 1, address: "localhost" }],
    vars: { ...config.vars, FORK_TOKEN: process.env.FORK_TOKEN, ...(shortLimits ? LIMITS : {}) },
  }));
  const proc = spawn("node_modules/.bin/wrangler", ["dev", "--local", "-c", path, "--ip", "127.0.0.1",
    "--port", String(port), "--inspector-port", String(port + 440), "--persist-to", dir], {
    detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  let log = "";
  const finished = new Promise(resolve => proc.once("close", resolve));
  const stop = async () => {
    if (proc.exitCode === null && proc.signalCode === null) process.kill(-proc.pid, "SIGTERM");
    await finished;
    rmSync(dir, { recursive: true, force: true });
  };
  for (const stream of [proc.stdout, proc.stderr]) stream.on("data", chunk => { log += chunk; });
  for (let i = 0; i < 200 && proc.exitCode === null; i++) {
    if (log.includes(`Ready on http://127.0.0.1:${port}`)) return { stop };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await stop();
  throw new Error(log);
}
