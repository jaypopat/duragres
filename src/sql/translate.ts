import { pgToSqlite } from "./polyglot";

// UUIDv4 from randomblob(): version nibble 4, variant nibble in [89ab].
// DO SQLite can't register custom functions, so this is an inline expression.
const UUID_V4 =
  "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || " +
  "substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || " +
  "substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))))";

export function stripSchema(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|(?:"(?:public|drizzle)"|\b(?:public|drizzle))\.(?=["A-Za-z_])|"(?:[^"]|"")*"/g,
    token => token.endsWith(".") ? "" : token);
}

// Consume quoted values and identifiers as whole tokens before matching emitted SQL syntax.
const SQLITE_TOKENS = /'(?:[^']|'')*'|"(?:[^"]|"")*"|\bDEFAULT\s+CURRENT_TIMESTAMP\b|\b(?:BIG|SMALL)?SERIAL\s+PRIMARY\s+KEY\b|\bUUID\(\)|\bCURRENT_TIMESTAMP\s*([+-])\s*INTERVAL\s+'(\d+)\s+(second|minute|hour|day|month|year)s?'/gi;

function sqliteSyntax(sql: string): string {
  return sql.replace(SQLITE_TOKENS, (token, sign, amount, unit) => {
    if (token.startsWith("'") || token.startsWith('"')) return token;
    if (sign) return `datetime('now', '${sign}${amount} ${unit.toLowerCase()}')`;
    if (/^DEFAULT/i.test(token)) return "DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))";
    if (/^UUID/i.test(token)) return UUID_V4;
    return "INTEGER PRIMARY KEY AUTOINCREMENT";
  });
}

export function translate(pg: string): string[] {
  return pgToSqlite(stripSchema(pg)).map(sqliteSyntax);
}
