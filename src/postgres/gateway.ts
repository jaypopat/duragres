import type { Env } from "../env";
import { DB_NAME } from "../database/lifecycle";
import { closeQuietly, refuse } from "./socket";

const SOCKET_OPTIONS = { allowHalfOpen: true, secureTransport: "off" } as const;

const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;
const CANCEL_REQUEST = 80877102;

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Reads until the StartupMessage, answering SSLRequest/GSSENCRequest with 'N'. */
async function readStartup(socket: Socket) {
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  let buf = new Uint8Array(0);
  const need = async (n: number) => {
    while (buf.length < n) {
      const { value, done } = await reader.read();
      if (done) return false;
      buf = concat(buf, value);
    }
    return true;
  };
  try {
    for (;;) {
      // A client that closes before a full StartupMessage (port probes, health checks) is not an error.
      if (!(await need(8))) return undefined;
      const dv = new DataView(buf.buffer, buf.byteOffset);
      const len = dv.getInt32(0);
      const code = dv.getInt32(4);
      if (len < 8 || len > 10_000 || !(await need(len))) return undefined;
      if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
        await writer.write(Uint8Array.of(0x4e)); // 'N': no TLS, no GSS
        buf = buf.slice(len);
        continue;
      }
      if (code === CANCEL_REQUEST) return undefined;
      const params: Record<string, string> = {};
      const fields = new TextDecoder().decode(buf.subarray(8, len - 1)).split("\0");
      for (let i = 0; i + 1 < fields.length; i += 2) params[fields[i]] = fields[i + 1];
      return { bytes: buf, params }; // bytes = StartupMessage + anything after it
    }
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
}

export async function connect(socket: Socket, env: Env) {
  const startup = await readStartup(socket);
  if (!startup) return;
  const database = startup.params.database || startup.params.user || "";
  if (env.LOG_CONNECTIONS) {
    // Behind Spectrum, remoteAddress is the original client IP:port (docs: handlers/connect).
    const { remoteAddress, localAddress } = await socket.opened;
    console.log(JSON.stringify({ event: "connect", database, remoteAddress, localAddress }));
  }
  if (!DB_NAME.test(database)) {
    return refuse(socket, "3D000", `database "${database}" does not exist (duragres names: 3-63 chars, a-z 0-9 and "-", starting with a letter or digit)`);
  }
  const upstream = env.PG.getByName(database).connect("pg:5432", SOCKET_OPTIONS);
  await upstream.opened;
  // Pipe DO -> client first: the DO may refuse (FATAL) and close before reading the
  // replayed StartupMessage, and that FATAL must still reach the client.
  const down = upstream.readable.pipeTo(socket.writable);
  let up: Promise<void> = Promise.resolve();
  try {
    const w = upstream.writable.getWriter();
    await w.write(startup.bytes);
    w.releaseLock();
    up = socket.readable.pipeTo(upstream.writable);
  } catch {
    // DO already closed its side; `down` delivers whatever it sent.
  }
  await Promise.allSettled([down, up]);
  await Promise.all([closeQuietly(socket), closeQuietly(upstream)]);
}
