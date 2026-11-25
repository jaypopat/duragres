// Starts `wrangler dev` for the tests on its own ports and storage directory.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Server { http: string; database(name: string): string; stop(): Promise<void> }

/** `mode: "test"` runs cloudflare.config.ts with short limits; its TCP port comes from that config. */
export async function startServer(mode: "default" | "test" = "default"): Promise<Server> {
  const httpPort = mode === "test" ? 8797 : 8787;
  const tcpPort = mode === "test" ? 8798 : 8788;
  const state = await mkdtemp(join(tmpdir(), "duragres-test-"));
  const args = ["wrangler", "dev", "--experimental-new-config", "--ip", "127.0.0.1", "--port", String(httpPort),
    "--inspector-port", String(httpPort + 440), "--persist-to", state, ...(mode === "test" ? ["--env", "test"] : [])];
  const proc = Bun.spawn(["bunx", ...args], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });

  let log = "";
  const ready = `Ready on http://127.0.0.1:${httpPort}`;
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) log += decoder.decode(chunk, { stream: true });
  };
  void read(proc.stdout);
  void read(proc.stderr);

  const stop = async () => {
    proc.kill();
    await proc.exited;
    // TEST_SERVER_LOG=<file> keeps wrangler's output, for when a test sees the server go away.
    if (process.env.TEST_SERVER_LOG) await Bun.write(`${process.env.TEST_SERVER_LOG}.${mode}`, log);
    await rm(state, { recursive: true, force: true });
  };
  for (let i = 0; i < 300 && !log.includes(ready); i++) {
    if (proc.exitCode !== null) break;
    await Bun.sleep(100);
  }
  if (!log.includes(ready)) {
    await stop();
    throw new Error(`wrangler dev did not start:\n${log}`);
  }
  return {
    http: `http://127.0.0.1:${httpPort}`,
    database: (name) => `postgres://demo@127.0.0.1:${tcpPort}/${name}?sslmode=disable`,
    stop,
  };
}
