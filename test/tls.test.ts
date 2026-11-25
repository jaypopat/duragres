// The duragres-tls Worker: TLS the way Postgres clients negotiate it, in front of the duragres Worker.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import pg from "pg";
import { startTls } from "./server";
import { freshDb } from "./setup";

/** A PEM block on one line with \n escaped, as .env files take it. */
const pem = (text: string) => JSON.stringify(text.trim());

let dir: string;
let ca: string;
let tls: Awaited<ReturnType<typeof startTls>>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "duragres-tls-"));
  await $`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost -keyout ${dir}/key.pem -out ${dir}/cert.pem`.quiet();
  ca = await Bun.file(`${dir}/cert.pem`).text();
  await Bun.write(`${dir}/.env`, `TLS_CERT=${pem(ca)}\nTLS_KEY=${pem(await Bun.file(`${dir}/key.pem`).text())}\n`);
  tls = await startTls(`${dir}/.env`);
});
afterAll(async () => {
  await tls?.stop();
  await rm(dir, { recursive: true, force: true });
});

const connect = (database: string, ssl: pg.ClientConfig["ssl"]) =>
  new pg.Client({ host: "localhost", port: tls.port, user: "demo", database, ssl });

test("verified TLS carries Postgres traffic both ways", async () => {
  const c = connect(freshDb("tls"), { ca, servername: "localhost", rejectUnauthorized: true });
  await c.connect();
  try {
    await c.query("CREATE TABLE t (v text); INSERT INTO t SELECT repeat('x', 100000)");
    expect((await c.query("SELECT length(v) AS n FROM t")).rows).toEqual([{ n: 100_000 }]);
  } finally {
    await c.end();
  }
});

test("a client that doesn't trust the certificate refuses it", async () => {
  await expect(connect(freshDb("tls-untrusted"), { rejectUnauthorized: true }).connect()).rejects.toThrow(/self.signed certificate/);
});

test("plaintext connections are refused with 28000", async () => {
  await expect(connect(freshDb("tls-plain"), false).connect()).rejects.toMatchObject({ code: "28000", message: expect.stringContaining("requires TLS") });
});

test("a failed handshake does not wedge the TLS Worker", async () => {
  const garbage = await Bun.connect({ hostname: "localhost", port: tls.port, socket: { data() {} } });
  garbage.write(new Uint8Array([0, 0, 0, 8, 4, 210, 22, 47])); // SSLRequest
  await Bun.sleep(100);
  garbage.write(new TextEncoder().encode("this is not a TLS ClientHello"));
  await Bun.sleep(200);
  garbage.end();
  const c = connect(freshDb("tls-after"), { ca, servername: "localhost", rejectUnauthorized: true });
  await c.connect();
  expect((await c.query("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
  await c.end();
});
