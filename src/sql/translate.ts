// PostgreSQL -> SQLite through Polyglot, plus the SQLite rewrites the stock
// Polyglot generator lacks. Delete each rewrite once Polyglot emits it upstream.
import { transpile } from "./polyglot";

// UUIDv4 from randomblob(): version nibble 4, variant nibble in [89ab].
// DO SQLite can't register custom functions, so this is an inline expression.
const UUID_V4 =
  "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || " +
  "substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || " +
  "substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))))";

// Quoted values and identifiers are consumed whole, so text inside them is never rewritten.
const SQLITE_TOKENS = /'(?:[^']|'')*'|"(?:[^"]|"")*"|\bDEFAULT\s+CURRENT_TIMESTAMP\b|\b(?:BIG|SMALL)?SERIAL\s+PRIMARY\s+KEY\b|\bUUID\(\)|\bCURRENT_TIMESTAMP\s*([+-])\s*INTERVAL\s+'(\d+)\s+(second|minute|hour|day|month|year)s?'/gi;

function sqliteSyntax(sql: string): string {
  return sql.replaceAll(SQLITE_TOKENS, (token, sign, amount, unit) => {
    if (token.startsWith("'") || token.startsWith('"')) return token;
    if (sign) return `datetime('now', '${sign}${amount} ${unit.toLowerCase()}')`;
    // Millisecond precision, so stored timestamps sort and round-trip like timestamptz.
    if (/^DEFAULT/i.test(token)) return "DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))";
    if (/^UUID/i.test(token)) return UUID_V4;
    return "INTEGER PRIMARY KEY AUTOINCREMENT";
  });
}

export const translate = (pg: string): Array<string> => transpile(pg).map(sqliteSyntax);
