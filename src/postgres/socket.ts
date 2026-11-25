import { msg } from "./wire";

interface ByteStreams { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }

export function byteStreams(socket: Socket): ByteStreams {
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- workerd TCP sockets read and write Uint8Array chunks
  return { readable: socket.readable, writable: socket.writable };
}

export async function closeQuietly(socket: Socket) {
  try {
    await socket.close();
  } catch {
    // socket.close() throws when already closed
  }
}

export async function refuse(socket: Socket, code: string, message: string) {
  const w = socket.writable.getWriter();
  await w.write(msg.fatal(code, message)).catch(() => {});
  await w.close().catch(() => {});
  await closeQuietly(socket);
}
