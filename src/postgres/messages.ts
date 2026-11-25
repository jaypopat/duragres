// The few frontend/backend message fields Duragres reads. Everything else passes to Postgres untouched.
import { PgError } from "./wire";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** The transaction status of the last ReadyForQuery in a backend reply: 'I' idle, 'T' in a transaction, 'E' failed. */
export function readyStatus(reply: Uint8Array): string | undefined {
  const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
  let status: string | undefined;
  for (let i = 0; i + 5 <= reply.length; i += 1 + view.getInt32(i + 1)) {
    if (reply[i] === 0x5a) status = String.fromCharCode(reply[i + 5]);
  }
  return status;
}

/**
 * Puts `prefix` on named prepared statements and portals in Parse, Bind, Describe, Close and Execute,
 * so clients sharing one backend never collide. Unnamed ("") ones are left alone: the pool never
 * switches clients between a Parse and its Sync. `onParse` sees each prefixed statement name created.
 */
export function renameStatements(msg: Uint8Array, prefix: string, onParse: (name: string) => void): Uint8Array {
  const body = msg.subarray(5);
  const rename = (name: string) => (name ? prefix + name : "");
  switch (msg[0]) {
    case 0x50: { // Parse: statement, query, parameter types
      const [name, rest] = cstr(body, 0);
      if (!name) return msg;
      onParse(rename(name));
      return message(0x50, encode(rename(name)), body.subarray(rest));
    }
    case 0x42: { // Bind: portal, statement, the rest
      const [portal, a] = cstr(body, 0);
      const [statement, b] = cstr(body, a);
      if (!portal && !statement) return msg;
      return message(0x42, encode(rename(portal)), encode(rename(statement)), body.subarray(b));
    }
    case 0x44: // Describe and Close: 'S' or 'P', then a name
    case 0x43: {
      const [name] = cstr(body, 1);
      if (!name) return msg;
      return message(msg[0], body.subarray(0, 1), encode(rename(name)));
    }
    case 0x45: { // Execute: portal, row limit
      const [portal, rest] = cstr(body, 0);
      if (!portal) return msg;
      return message(0x45, encode(rename(portal)), body.subarray(rest));
    }
    default:
      return msg;
  }
}

/** The SQL text of a simple Query ('Q') or a Parse ('P'), else undefined. */
export function sqlText(msg: Uint8Array): string | undefined {
  if (msg[0] === 0x51) return decoder.decode(msg.subarray(5, msg.length - 1));
  if (msg[0] === 0x50) return cstr(msg.subarray(5), cstr(msg.subarray(5), 0)[1])[0];
  return undefined;
}

export type DatabaseCommand =
  | { kind: "create"; name: string; template?: string }
  | { kind: "drop"; name: string; ifExists: boolean; force: boolean };

/**
 * CREATE DATABASE and DROP DATABASE, which act on other Durable Objects instead of this backend.
 * Returns undefined for any other statement. Supports TEMPLATE, IF EXISTS and WITH (FORCE).
 */
export function databaseCommand(sql: string): DatabaseCommand | undefined {
  const t = tokens(sql);
  let i = 0;
  const peek = (word?: string) => (word ? t[i]?.word === word : t[i]);
  const take = (word: string) => (peek(word) ? (i++, true) : false);
  const name = () => {
    const token = t[i++];
    if (!token || token.symbol) throw new PgError("42601", "syntax error: expected a database name");
    return token.ident;
  };
  const end = () => {
    while (t[i]?.symbol === ";") i++;
    if (i < t.length) throw new PgError("25001", "CREATE DATABASE and DROP DATABASE must be the only statement in their query");
  };

  if (take("create")) {
    if (!take("database")) return undefined;
    const command: DatabaseCommand = { kind: "create", name: name() };
    take("with");
    while (i < t.length && !t[i].symbol) {
      if (!take("template")) throw new PgError("0A000", `CREATE DATABASE option ${t[i].ident.toUpperCase()} is not supported; only TEMPLATE is`);
      if (t[i]?.symbol === "=") i++;
      command.template = name();
    }
    end();
    return command;
  }
  if (take("drop")) {
    if (!take("database")) return undefined;
    const ifExists = take("if") && take("exists");
    const command: DatabaseCommand = { kind: "drop", ifExists, name: name(), force: false };
    take("with");
    if (t[i]?.symbol === "(") {
      for (i++; t[i] && t[i].symbol !== ")"; i++) {
        if (t[i].word === "force") command.force = true;
        else if (t[i].symbol !== ",") throw new PgError("42601", `unrecognized DROP DATABASE option "${t[i].ident}"`);
      }
      i++;
    }
    end();
    return command;
  }
  return undefined;
}

type Token = { ident: string; word?: string; symbol?: string };

/** Identifiers (quoted or not), keywords and punctuation. Unquoted identifiers fold to lower case. */
function tokens(sql: string): Array<Token> {
  const out: Array<Token> = [];
  const re = /\s+|--[^\n]*|\/\*[\s\S]*?\*\/|"((?:[^"]|"")*)"|([A-Za-z_][A-Za-z0-9_$]*)|([=(),;])|(.)/gy;
  for (let m; (m = re.exec(sql));) {
    if (m[1] !== undefined) out.push({ ident: m[1].replaceAll('""', '"') });
    else if (m[2] !== undefined) out.push({ ident: m[2].toLowerCase(), word: m[2].toLowerCase() });
    else if (m[3] !== undefined) out.push({ ident: m[3], symbol: m[3] });
    else if (m[4] !== undefined) out.push({ ident: m[4], symbol: m[4] });
  }
  return out;
}

function cstr(bytes: Uint8Array, at: number): [string, number] {
  const end = bytes.indexOf(0, at);
  return [decoder.decode(bytes.subarray(at, end)), end + 1];
}
const encode = (s: string) => encoder.encode(s + "\0");

function message(type: number, ...parts: Array<Uint8Array>): Uint8Array {
  const length = parts.reduce((n, p) => n + p.length, 4);
  const out = new Uint8Array(1 + length);
  out[0] = type;
  new DataView(out.buffer).setInt32(1, length);
  let at = 5;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
