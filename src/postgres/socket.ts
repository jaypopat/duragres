import { msg } from "./wire";

interface ByteStreams { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }

/** A TCP socket's streams, typed as the bytes they carry. Workers types declare them as streams of `any`. */
export function byteStreams(socket: Socket): ByteStreams {
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- workerd TCP sockets read and write Uint8Array chunks
  return { readable: socket.readable, writable: socket.writable };
}

/** socket.close() throws synchronously on an already-closed socket; never let that surface. */
export async function closeQuietly(socket: Socket) {
  try {
    await socket.close();
  } catch {
    // already closed
  }
}

/** Write a FATAL error to a socket nobody else is writing to, then close it. */
export async function refuse(socket: Socket, code: string, message: string) {
  const w = socket.writable.getWriter();
  await w.write(msg.fatal(code, message)).catch(() => {});
  await w.close().catch(() => {});
  await closeQuietly(socket);
}
