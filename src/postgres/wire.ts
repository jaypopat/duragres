export class PgError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const enc = new TextEncoder();

function message(type: string, ...fields: Array<string | number>): Uint8Array {
  const parts = fields.map((f) => (typeof f === "number" ? Uint8Array.of(f) : enc.encode(f + "\0")));
  const length = parts.reduce((n, p) => n + p.length, 4);
  const out = new Uint8Array(1 + length);
  out[0] = type.charCodeAt(0);
  new DataView(out.buffer).setInt32(1, length);
  let at = 5;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const report = (type: "E" | "N", severity: string, code: string, text: string) =>
  message(type, 0x53, severity, 0x56, severity, 0x43, code, 0x4d, text, 0);

export const msg = {
  error: (e: PgError) => report("E", "ERROR", e.code, e.message),
  fatal: (code: string, text: string) => report("E", "FATAL", code, text),
  notice: (text: string) => report("N", "NOTICE", "00000", text),
  commandComplete: (tag: string) => message("C", tag),
  parameterStatus: (name: string, value: string) => message("S", name, value),
  readyForQuery: (status: string) => message("Z", status.charCodeAt(0)),
};
