// Postgres types: name -> OID, text-format encoding of SQLite values, and
// decoding of text-format bound parameters into what SQLite should store.

export interface PgType { oid: number; name: string } // name = format_type() spelling, e.g. "timestamp with time zone"

export const T = {
  bool: { oid: 16, name: "boolean" },
  bytea: { oid: 17, name: "bytea" },
  int8: { oid: 20, name: "bigint" },
  int2: { oid: 21, name: "smallint" },
  int4: { oid: 23, name: "integer" },
  text: { oid: 25, name: "text" },
  json: { oid: 114, name: "json" },
  float4: { oid: 700, name: "real" },
  float8: { oid: 701, name: "double precision" },
  varchar: { oid: 1043, name: "character varying" },
  date: { oid: 1082, name: "date" },
  timestamp: { oid: 1114, name: "timestamp without time zone" },
  timestamptz: { oid: 1184, name: "timestamp with time zone" },
  numeric: { oid: 1700, name: "numeric" },
  uuid: { oid: 2950, name: "uuid" },
  jsonb: { oid: 3802, name: "jsonb" },
} satisfies Record<string, PgType>;

const BY_DECLARED: Array<[RegExp, PgType]> = [
  [/^(SERIAL4?|INT4?|INTEGER)$/, T.int4],
  [/^(BIGSERIAL|SERIAL8|BIGINT|INT8)$/, T.int8],
  [/^(SMALLSERIAL|SERIAL2|SMALLINT|INT2)$/, T.int2],
  [/^BOOL(EAN)?$/, T.bool],
  [/^(TIMESTAMPTZ|TIMESTAMP(\(\d+\))? WITH TIME ZONE)$/, T.timestamptz],
  [/^TIMESTAMP(\(\d+\))?( WITHOUT TIME ZONE)?$/, T.timestamp],
  [/^DATE$/, T.date],
  [/^JSONB$/, T.jsonb],
  [/^JSON$/, T.json],
  [/^UUID$/, T.uuid],
  [/^(DOUBLE PRECISION|FLOAT8|FLOAT)$/, T.float8],
  [/^(REAL|FLOAT4)$/, T.float4],
  [/^(DECIMAL|NUMERIC)\b/, T.numeric],
  [/^(VARCHAR|CHARACTER VARYING)\b/, T.varchar],
  [/^BYTEA$/, T.bytea],
];

/** Declared Postgres type text (as Polyglot generates it, e.g. "VARCHAR(20)") -> type. Arrays and unknowns -> text. */
export function typeFromDeclared(declared: string): PgType {
  const d = declared.trim().toUpperCase().replaceAll(/\s+/g, " ");
  const hit = BY_DECLARED.find(([re]) => re.test(d))?.[1] ?? T.text;
  const mods = /\(([\d,\s]+)\)$/.exec(d)?.[1]?.replaceAll(/\s/g, "");
  return mods && (hit === T.varchar || hit === T.numeric) ? { ...hit, name: `${hit.name}(${mods})` } : hit;
}

export const typeByOid = (oid: number): PgType | undefined => Object.values(T).find((t) => t.oid === oid);

const TS = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** Canonical stored timestamp: UTC "YYYY-MM-DD HH:MM:SS.fff" (sorts and compares as text). */
function canonicalTimestamp(s: string): string {
  const m = TS.exec(s.trim());
  if (m && (!m[4] || /^(Z|\+00(:?00)?)$/i.test(m[4]))) return `${m[1]} ${m[2]}.${(m[3] ?? "").padEnd(3, "0").slice(0, 3)}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString().replace("T", " ").replace("Z", "");
}

function formatTimestamp(v: string, withZone: boolean): string {
  const m = TS.exec(canonicalTimestamp(v));
  if (!m) return v;
  return `${m[1]} ${m[2]}.${(m[3] ?? "").padEnd(6, "0").slice(0, 6)}${withZone ? "+00" : ""}`;
}

/** SQLite value -> Postgres text format for the given type. */
export function encodeValue(v: unknown, type: PgType): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof ArrayBuffer) return "\\x" + [...new Uint8Array(v)].map((b) => b.toString(16).padStart(2, "0")).join("");
  switch (type.oid) {
    case T.bool.oid:
      return v === 1 || v === "1" || v === true || v === "t" || v === "true" ? "t" : v === 0 || v === "0" || v === false || v === "f" || v === "false" ? "f" : String(v);
    case T.timestamptz.oid:
      return formatTimestamp(String(v), true);
    case T.timestamp.oid:
      return formatTimestamp(String(v), false);
    default:
      return String(v);
  }
}

/** Text-format bound parameter -> value to bind in SQLite. */
export function decodeParam(text: string | null, type: PgType | undefined): unknown {
  if (text === null || !type) return text;
  switch (type.oid) {
    case T.bool.oid: {
      const t = text.toLowerCase();
      return ["t", "true", "1", "y", "yes", "on"].includes(t) ? 1 : ["f", "false", "0", "n", "no", "off"].includes(t) ? 0 : text;
    }
    case T.int2.oid:
    case T.int4.oid:
    case T.int8.oid:
      return /^-?\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : text;
    case T.float4.oid:
    case T.float8.oid:
    case T.numeric.oid:
      return text.trim() !== "" && !Number.isNaN(Number(text)) ? Number(text) : text;
    case T.timestamptz.oid:
    case T.timestamp.oid:
      return canonicalTimestamp(text);
    default:
      return text;
  }
}

/** Type for a value SQLite returned when no column origin is known. */
export function inferType(v: unknown): PgType {
  if (typeof v === "number") return Number.isInteger(v) ? T.int8 : T.float8;
  if (v instanceof ArrayBuffer) return T.bytea;
  return T.text;
}
