// TCP entry point. Reads the StartupMessage to learn the database name, then
// pipes the connection to the Durable Object of that name. No SQL is parsed here.
import { DB_NAME } from "./database/lifecycle";
import { byteStreams, closeQuietly, refuse } from "./postgres/socket";

const SSL_REQUEST = 80_877_103;
const GSSENC_REQUEST = 80_877_104;
const CANCEL_REQUEST = 80_877_102;
const MAX_STARTUP_LENGTH = 10_000;

interface Startup { bytes: Uint8Array; params: Record<string, string> }

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Reads until the StartupMessage, answering SSLRequest/GSSENCRequest with 'N'. */
async function readStartup(socket: Socket): Promise<Startup | undefined> {
  const streams = byteStreams(socket);
  const reader = streams.readable.getReader();
  const writer = streams.writable.getWriter();
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
      const view = new DataView(buf.buffer, buf.byteOffset);
      const length = view.getInt32(0);
      const code = view.getInt32(4);
      if (length < 8 || length > MAX_STARTUP_LENGTH || !(await need(length))) return undefined;
      if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
        await writer.write(Uint8Array.of(0x4e)); // 'N': no TLS, no GSS
        buf = buf.slice(length);
        continue;
      }
      if (code === CANCEL_REQUEST) return undefined;
      const fields = new TextDecoder().decode(buf.subarray(8, length - 1)).split("\0");
      const params: Record<string, string> = {};
      for (let i = 0; i + 1 < fields.length; i += 2) params[fields[i]] = fields[i + 1];
      return { bytes: buf, params }; // the StartupMessage plus anything sent after it
    }
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
}

/** "203.0.113.7:5432" or "[2001:db8::1]:5432" -> the address without the port. */
const hostOf = (address: string) => address.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");

export async function connect(socket: Socket, env: Env) {
  const startup = await readStartup(socket);
  if (!startup) return;

  // Behind Spectrum, remoteAddress is the original client address.
  const { remoteAddress = "" } = await socket.opened;
  if (!(await env.CONNECT_LIMIT.limit({ key: hostOf(remoteAddress) })).success) {
    return refuse(socket, "53400", "duragres: too many new connections from this address, try again in a minute");
  }

  const database = startup.params.database || startup.params.user || "";
  if (!DB_NAME.test(database)) {
    return refuse(socket, "3D000", `database "${database}" does not exist (duragres names: 3-63 chars, a-z 0-9 and "-", starting with a letter or digit)`);
  }

  const upstream = env.PG.getByName(database).connect("pg:5432", { allowHalfOpen: true, secureTransport: "off" });
  await upstream.opened;
  // Pipe DO -> client first: the DO may refuse (FATAL) and close before reading the
  // replayed StartupMessage, and that FATAL must still reach the client.
  const down = upstream.readable.pipeTo(socket.writable);
  let up: Promise<void> = Promise.resolve();
  try {
    const writer = upstream.writable.getWriter();
    await writer.write(startup.bytes);
    writer.releaseLock();
    up = socket.readable.pipeTo(upstream.writable);
  } catch {
    // The DO already closed its side; `down` delivers whatever it sent.
  }
  await Promise.allSettled([down, up]);
  await Promise.all([closeQuietly(socket), closeQuietly(upstream)]);
}
