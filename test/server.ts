// Starts `wrangler dev` for the tests on their own ports and storage directories.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Server { http: string; database(name: string): string; stop(): Promise<void> }

interface Wrangler { cwd: string; name: string; httpPort: number; args: Array<string> }

/** Runs `wrangler dev` until it reports Ready; `stop()` ends it and removes its storage. */
async function startWrangler({ cwd, name, httpPort, args }: Wrangler) {
  const state = await mkdtemp(join(tmpdir(), "duragres-test-"));
  const proc = Bun.spawn(["bunx", "wrangler", "dev", "--experimental-new-config", "--ip", "127.0.0.1", "--port", String(httpPort),
    "--inspector-port", String(httpPort + 440), "--persist-to", state, ...args], {
    cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
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
    if (process.env.TEST_SERVER_LOG) await Bun.write(`${process.env.TEST_SERVER_LOG}.${name}`, log);
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
  return stop;
}

/** The duragres Worker. `mode: "test"` runs cloudflare.config.ts with short limits; its TCP port comes from that config. */
export async function startServer(mode: "default" | "test" = "default"): Promise<Server> {
  const httpPort = mode === "test" ? 8797 : 8787;
  const tcpPort = mode === "test" ? 8798 : 8788;
  const stop = await startWrangler({ cwd: ".", name: mode, httpPort, args: mode === "test" ? ["--env", "test"] : [] });
  return {
    http: `http://127.0.0.1:${httpPort}`,
    database: (name) => `postgres://demo@127.0.0.1:${tcpPort}/${name}?sslmode=disable`,
    stop,
  };
}

/** The duragres-tls Worker in local mode (TCP 8789), in front of the default duragres Worker on 8788. */
export async function startTls(envFile: string): Promise<{ port: number; stop(): Promise<void> }> {
  const stop = await startWrangler({ cwd: "tls", name: "tls", httpPort: 8790, args: ["--env", "local", "--env-file", envFile] });
  return { port: 8789, stop };
}
