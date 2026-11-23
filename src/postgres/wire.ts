// Postgres v3 backend message encoding and frontend message decoding.
// pg-gateway handles startup/auth/framing; everything after auth lands here.

export const OID = { bool: 16, bytea: 17, int8: 20, int4: 23, text: 25, oid: 26, float8: 701, name: 19, char: 18 } as const;

export interface Field { name: string; oid: number }

export type Result =
  | { kind: "rows"; fields: Array<Field>; rows: Array<Array<string | null>>; tag: string }
  | { kind: "command"; tag: string }
  | { kind: "empty" };

export class PgError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

class Body {
  private parts: Array<Uint8Array> = [];
  private len = 0;
  private push(b: Uint8Array) { this.parts.push(b); this.len += b.length; return this; }
  byte(n: number) { return this.push(Uint8Array.of(n)); }
  int16(n: number) { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, n); return this.push(b); }
  int32(n: number) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n); return this.push(b); }
  cstr(s: string) { return this.push(enc.encode(s + "\0")); }
  bytes(b: Uint8Array) { return this.push(b); }
  message(type: string): Uint8Array {
    const out = new Uint8Array(5 + this.len);
    out[0] = type.charCodeAt(0);
    new DataView(out.buffer).setInt32(1, this.len + 4);
    let o = 5;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

const TYPLEN = new Map<number, number>([[OID.bool, 1], [OID.int8, 8], [OID.int4, 4], [OID.float8, 8], [OID.oid, 4], [OID.name, 64], [OID.char, 1]]);

export const msg = {
  parameterStatus: (k: string, v: string) => new Body().cstr(k).cstr(v).message("S"),
  readyForQuery: (status: "I" | "T" | "E") => new Body().byte(status.charCodeAt(0)).message("Z"),
  commandComplete: (tag: string) => new Body().cstr(tag).message("C"),
  emptyQuery: () => new Body().message("I"),
  parseComplete: () => new Body().message("1"),
  bindComplete: () => new Body().message("2"),
  closeComplete: () => new Body().message("3"),
  noData: () => new Body().message("n"),
  portalSuspended: () => new Body().message("s"),
  parameterDescription: (oids: Array<number>) => {
    const b = new Body().int16(oids.length);
    for (const o of oids) b.int32(o);
    return b.message("t");
  },
  rowDescription(fields: Array<Field>) {
    const b = new Body().int16(fields.length);
    for (const f of fields) b.cstr(f.name).int32(0).int16(0).int32(f.oid).int16(TYPLEN.get(f.oid) ?? -1).int32(-1).int16(0);
    return b.message("T");
  },
  dataRow(values: Array<string | null>) {
    const b = new Body().int16(values.length);
    for (const v of values) {
      if (v === null) { b.int32(-1); continue; }
      const bytes = enc.encode(v);
      b.int32(bytes.length).bytes(bytes);
    }
    return b.message("D");
  },
  error(e: PgError, severity: "ERROR" | "FATAL" = "ERROR") {
    return new Body().byte(0x53).cstr(severity).byte(0x56).cstr(severity).byte(0x43).cstr(e.code).byte(0x4d).cstr(e.message).byte(0).message("E");
  },
  fatal: (code: string, message: string) => msg.error(new PgError(code, message), "FATAL"),
  notice: (message: string) => new Body().byte(0x53).cstr("NOTICE").byte(0x56).cstr("NOTICE").byte(0x43).cstr("00000").byte(0x4d).cstr(message).byte(0).message("N"),
};

/** A result built in code rather than read from SQLite; values are sent as text. */
export function rows(cols: Array<[string, number]>, values: Array<Array<unknown>>, tag = `SELECT ${values.length}`): Extract<Result, { kind: "rows" }> {
  const fields: Array<Field> = cols.map(([name, oid]) => ({ name, oid }));
  return { kind: "rows", fields, rows: values.map((r) => r.map((v) => (v === null || v === undefined ? null : String(v)))), tag };
}

/** Messages for a full result (no ReadyForQuery). `describe` controls RowDescription. */
export function encodeResult(r: Result, describe = true): Array<Uint8Array> {
  if (r.kind === "empty") return [msg.emptyQuery()];
  if (r.kind === "command") return [msg.commandComplete(r.tag)];
  const out = describe ? [msg.rowDescription(r.fields)] : [];
  for (const row of r.rows) out.push(msg.dataRow(row));
  out.push(msg.commandComplete(r.tag));
  return out;
}

/** Cursor over one frontend message (type byte + int32 length + body). */
export class Reader {
  private dv: DataView;
  private o = 5;
  readonly type: string;
  constructor(private buf: Uint8Array) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.type = String.fromCharCode(buf[0]);
  }
  byte() { return this.buf[this.o++]; }
  int16() { const v = this.dv.getInt16(this.o); this.o += 2; return v; }
  int32() { const v = this.dv.getInt32(this.o); this.o += 4; return v; }
  cstr() { const end = this.buf.indexOf(0, this.o); const s = dec.decode(this.buf.subarray(this.o, end)); this.o = end + 1; return s; }
  bytes(n: number) { const b = this.buf.subarray(this.o, this.o + n); this.o += n; return b; }
}

export const decodeText = (b: Uint8Array) => dec.decode(b);
