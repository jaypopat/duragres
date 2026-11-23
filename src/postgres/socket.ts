import { msg } from "./wire";

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
