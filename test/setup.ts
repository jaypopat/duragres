// Preloaded by bun test: one Worker for every test file. lifecycle.test.ts starts its own in test mode.
import { afterAll, beforeAll } from "bun:test";
import pg from "pg";
import { startServer, type Server } from "./server";

process.env.FORK_TOKEN ??= crypto.randomUUID();

let server: Server;
beforeAll(async () => {
  server = await startServer();
});
afterAll(() => server?.stop());

export const forkToken = () => process.env.FORK_TOKEN!;
export const httpUrl = () => server.http;
export const databaseUrl = (name: string) => server.database(name);

/** A fresh, valid database name, so tests never share state. */
export const freshDb = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export async function client(name: string) {
  const c = new pg.Client(databaseUrl(name));
  c.on("notice", () => {});
  await c.connect();
  return c;
}
