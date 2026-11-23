// A minimal PostgreSQL frontend for tests that need protocol messages drivers don't expose.
import { connect } from "node:net";

export interface Message { type: string; body: Buffer }

const cstr = (s: string) => Buffer.from(`${s}\0`);
const int16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const int32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const message = (type: string, ...parts: Array<Buffer>) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
};

export const frontend = {
  parse: (sql: string, name = "") => message("P", cstr(name), cstr(sql), int16(0)),
  bind: (params: Array<string | null> = [], portal = "", statement = "") =>
    message("B", cstr(portal), cstr(statement), int16(0), int16(params.length),
      ...params.map((p) => (p === null ? int32(-1) : Buffer.concat([int32(Buffer.byteLength(p)), Buffer.from(p)]))), int16(0)),
  describeStatement: (name = "") => message("D", Buffer.from("S"), cstr(name)),
  describePortal: (name = "") => message("D", Buffer.from("P"), cstr(name)),
  execute: (maxRows = 0, portal = "") => message("E", cstr(portal), int32(maxRows)),
  sync: () => message("S"),
};

/** Connects with trust auth and returns a function that sends messages and collects replies up to ReadyForQuery. */
export async function open(host: string, port: number, database: string) {
  const socket = connect({ host, port });
  let buffer = Buffer.alloc(0);
  let waiting: (() => void) | undefined;
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    waiting?.();
  });
  const next = async (): Promise<Message> => {
    while (buffer.length < 5 || buffer.length < 1 + buffer.readInt32BE(1)) await new Promise<void>((r) => {
      waiting = r;
    });
    const length = buffer.readInt32BE(1);
    const msg = { type: String.fromCharCode(buffer[0]), body: buffer.subarray(5, 1 + length) };
    buffer = buffer.subarray(1 + length);
    return msg;
  };
  const untilReady = async () => {
    const out: Array<Message> = [];
    for (let m = await next(); ; m = await next()) {
      if (m.type === "Z") return out;
      out.push(m);
    }
  };
  await new Promise<void>((r) => {
    socket.once("connect", () => r());
  });
  const startup = Buffer.concat([int32(196_608), cstr("user"), cstr("demo"), cstr("database"), cstr(database), Buffer.from([0])]);
  socket.write(Buffer.concat([int32(startup.length + 4), startup]));
  await untilReady();
  return {
    async send(...messages: Array<Buffer>) {
      socket.write(Buffer.concat(messages));
      return untilReady();
    },
    close: () => socket.end(),
  };
}

/** Message types in order, e.g. "1 2 T D D s". */
export const types = (messages: Array<Message>) => messages.map((m) => m.type).join(" ");
