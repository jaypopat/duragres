import { connect as dial } from "cloudflare:sockets";
import "../runtime/wasm_exec.js";
import goTls from "../runtime/tls.wasm";
import { byteStreams, refuse } from "../../src/postgres/socket";
import { msg } from "../../src/postgres/wire";

const SSL_REQUEST = 80_877_103;
const GSSENC_REQUEST = 80_877_104;
const TLS_HANDSHAKE = 0x16;
const HANDSHAKE_TIMEOUT_MS = 10_000;

function startGo() {
  if (!globalThis.duragresTlsAccept) {
    const go = new Go();
    void go.run(new WebAssembly.Instance(goTls, go.importObject)).finally(() => {
      globalThis.duragresTlsAccept = undefined;
    });
  }
  if (!globalThis.duragresTlsAccept) throw new Error("tls.wasm did not register duragresTlsAccept");
  return globalThis.duragresTlsAccept;
}

const hostOf = (address: string) => address.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");

async function negotiate(reader: ReadableStreamDefaultReader<Uint8Array>, writer: WritableStreamDefaultWriter<Uint8Array>): Promise<{ early: Uint8Array; direct: boolean } | undefined> {
  let buf = new Uint8Array(0);
  const need = async (n: number) => {
    while (buf.length < n) {
      const { value, done } = await reader.read();
      if (done) return false;
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
    }
    return true;
  };
  for (;;) {
    if (!(await need(1))) return undefined;
    if (buf[0] === TLS_HANDSHAKE) return { early: buf, direct: true };
    if (!(await need(8))) return undefined;
    const view = new DataView(buf.buffer, buf.byteOffset);
    if (view.getInt32(0) !== 8) return undefined;
    const code = view.getInt32(4);
    if (code === SSL_REQUEST) {
      await writer.write(Uint8Array.of(0x53));
      return { early: buf.slice(8), direct: false };
    }
    if (code !== GSSENC_REQUEST) return undefined;
    await writer.write(Uint8Array.of(0x4e));
    buf = buf.slice(8);
  }
}

export default {
  async connect(socket: Socket, env: Env) {
    const { remoteAddress } = await socket.opened;
    if (!remoteAddress) return refuse(socket, "08004", "duragres: connection without a client address");
    if (!(await env.CONNECT_LIMIT.limit({ key: hostOf(remoteAddress) })).success) {
      return refuse(socket, "53400", "duragres: too many new connections from this address, try again in a minute");
    }

    const client = byteStreams(socket);
    const reader = client.readable.getReader();
    const writer = client.writable.getWriter();
    const timeout = setTimeout(() => void reader.cancel().catch(() => {}), HANDSHAKE_TIMEOUT_MS);
    const negotiated = await negotiate(reader, writer).catch(() => undefined);
    if (!negotiated) {
      clearTimeout(timeout);
      await writer.write(msg.fatal("28000", "duragres requires TLS: connect with sslmode=require or stronger")).catch(() => {});
      await writer.close().catch(() => {});
      return;
    }

    let toClient = Promise.resolve();
    let toDatabase = Promise.resolve();
    let upstream: Socket | undefined;
    let database: WritableStreamDefaultWriter<Uint8Array> | undefined;
    let fromDatabase = Promise.resolve();
    const { promise: finished, resolve: finish } = Promise.withResolvers<string | null>();

    const connectDatabase = () => {
      const options = { allowHalfOpen: true, secureTransport: "off" } as const;
      upstream = env.LOCAL_UPSTREAM ? dial(env.LOCAL_UPSTREAM, options) : env.DURAGRES.connect("duragres:5432", options);
      database = byteStreams(upstream).writable.getWriter();
      const from = byteStreams(upstream).readable;
      fromDatabase = (async () => {
        for await (const chunk of from) plain(chunk);
      })().catch(() => {}).finally(() => plain(null));
    };

    const session = startGo()(
      env.TLS_CERT,
      env.TLS_KEY,
      negotiated.direct,
      (bytes) => {
        toClient = toClient.then(() => writer.write(bytes)).catch(() => {});
      },
      (bytes) => {
        clearTimeout(timeout);
        if (!database) connectDatabase();
        const to = database;
        toDatabase = toDatabase.then(() => (bytes ? to?.write(bytes) : to?.close())).catch(() => {});
      },
      finish,
    );
    if (!session) {
      clearTimeout(timeout);
      await writer.close().catch(() => {});
      return;
    }

    let open = true;
    const cipher = (b: Uint8Array | null) => open && session.cipher(b);
    const plain = (b: Uint8Array | null) => open && session.plain(b);

    if (negotiated.early.length) cipher(negotiated.early);
    const fromClient = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        cipher(value);
      }
    })().catch(() => {}).finally(() => cipher(null));

    await finished;
    clearTimeout(timeout);
    open = false;
    session.release();
    await reader.cancel().catch(() => {});
    await Promise.allSettled([toClient, toDatabase]);
    await Promise.allSettled([writer.close(), upstream?.close(), database?.close()]);
    await Promise.allSettled([fromClient, fromDatabase]);
    await socket.close().catch(() => {});
  },
} satisfies ExportedHandler<Env>;
