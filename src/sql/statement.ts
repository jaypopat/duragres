// A client query, split into statements and classified. Each statement is either
// answered without storage, controls the transaction, or runs on SQLite.
//
// Utility statements (transaction control, SET, SHOW) are classified by their
// leading keyword, since Polyglot doesn't parse every form of them; psql's catalog
// queries are answered from their text; everything else is classified from its AST.
// Rewrites are token edits on the original text, because Polyglot's PostgreSQL
// generator is not lossless.
import { PgError } from '../postgres/wire';
import type { Result } from '../postgres/wire';
import { QUERY_KINDS, isQuery } from "./catalog";
import { findNodes, kindOf, parse, tokenize } from './polyglot';
import type { Expression, Token } from './polyglot';
import { answerCatalogQuery } from "./psql-meta";
import { ISOLATION_LEVELS, SERVER_VERSION, checkSetting } from './session';
import type { Isolation, Session } from './session';

export type Statement =
  | { kind: "transaction"; op: "begin"; isolation?: Isolation }
  | { kind: "transaction"; op: "commit" | "rollback" }
  // SET [SESSION CHARACTERISTICS AS] TRANSACTION ISOLATION LEVEL, and RESET of it; no level: back to the default
  | { kind: "isolation"; scope: "transaction" | "session"; level?: Isolation; tag: string }
  | { kind: "show"; name: string }
  | { kind: "noop"; tag: string } // SET of a setting with no effect, DISCARD, CREATE/DROP SCHEMA: SQLite has no schemas
  | { kind: "catalog"; result: Result }
  | { kind: "createDatabase"; name: string; template?: string }
  | { kind: "dropDatabase"; name: string; ifExists: boolean; force: boolean }
  | { kind: "addConstraint"; table: string; constraint: string }
  // clock: inside a transaction, the start time every reading of the current time returns (determinism.ts)
  | { kind: "sql"; node: Expression; pg: string; tag: string; dml: boolean; ddl: boolean; readOnly: boolean; clock?: number };

export function prepare(query: string, s: Session): Array<Statement> {
  return splitAndRewrite(query, s).flatMap(({ pg, words, readsCatalog }): Array<Statement> => {
    const utility = classifyUtility(words, pg) ?? classifyDatabaseCommand(words, pg);
    if (utility) return [utility];
    if (readsCatalog) return [{ kind: "catalog", result: answerCatalogQuery(pg, s) }];
    // A comment-only statement parses to nothing.
    return parse(pg).map((node) => classify(node, pg));
  });
}

/** Classifies a statement by its first two keywords, upper-cased. */
function classifyUtility([first, second = ""]: Array<string>, pg: string): Statement | undefined {
  switch (first) {
    case "BEGIN":
    case "START":
      return { kind: "transaction", op: "begin", isolation: isolationLevel(tokenize(pg)) };
    case "COMMIT":
    case "END":
      return { kind: "transaction", op: "commit" };
    case "ROLLBACK":
    case "ABORT":
      return { kind: "transaction", op: "rollback" };
    case "SHOW":
      return { kind: "show", name: second.toLowerCase() };
    case "SET":
      return classifySet(tokenize(pg).slice(1));
    case "RESET":
      return second === "ALL" || second === "DEFAULT_TRANSACTION_ISOLATION" ? { kind: "isolation", scope: "session", tag: "RESET" } : { kind: "noop", tag: "RESET" };
    case "DISCARD":
      return second === "ALL" ? { kind: "isolation", scope: "session", tag: "DISCARD ALL" } : { kind: "noop", tag: `DISCARD ${second}` };
  }
}

/** The level after ISOLATION LEVEL in BEGIN, START TRANSACTION or SET TRANSACTION, if any. */
function isolationLevel(tokens: Array<Token>): Isolation | undefined {
  const at = tokens.findIndex((t, i) => t.text.toUpperCase() === "ISOLATION" && tokens[i + 1]?.text.toUpperCase() === "LEVEL");
  if (at < 0) return undefined;
  const [a = "", b = ""] = tokens.slice(at + 2, at + 4).map((t) => t.text.toLowerCase());
  const level = ISOLATION_LEVELS.find((l) => l === a || l === `${a} ${b}`);
  if (!level) throw new PgError("42601", `syntax error at or near "${a}"`);
  return level;
}

/**
 * SET [SESSION | LOCAL] name {TO | =} value[, ...], plus the special forms TIME ZONE,
 * NAMES, SCHEMA, TRANSACTION and SESSION CHARACTERISTICS AS TRANSACTION.
 * `tokens` follow the SET keyword.
 */
function classifySet(tokens: Array<Token>): Statement {
  const word = (i: number) => tokens[i]?.text.toUpperCase();
  if (word(0) === "SESSION" && word(1) !== "CHARACTERISTICS" && word(1) !== "AUTHORIZATION") tokens = tokens.slice(1);
  else if (word(0) === "LOCAL") tokens = tokens.slice(1);

  if (word(0) === "TRANSACTION" || (word(0) === "SESSION" && word(1) === "CHARACTERISTICS")) {
    const level = isolationLevel(tokens);
    // SET TRANSACTION READ ONLY and the like change nothing Duragres enforces.
    if (!level) return { kind: "noop", tag: "SET" };
    return { kind: "isolation", scope: word(0) === "TRANSACTION" ? "transaction" : "session", level, tag: "SET" };
  }

  const special: Record<string, [string, number]> = { TIME: ["timezone", 2], NAMES: ["client_encoding", 1], SCHEMA: ["search_path", 1] };
  let [name, skip] = special[word(0) ?? ""] ?? ["", 0];
  if (!name) {
    // A name is identifiers joined by dots (custom settings are "prefix.name").
    while (skip < tokens.length && !["TO", "="].includes(word(skip)!)) name += tokens[skip++].text.toLowerCase();
    skip++; // TO or =
  }
  // The value: comma-separated items, each one or more tokens (strings arrive unquoted).
  const items: Array<string> = [];
  let item: Array<string> = [];
  for (const t of tokens.slice(skip)) {
    if (t.type === "COMMA") {
      items.push(item.join(" "));
      item = [];
    } else item.push(t.text);
  }
  items.push(item.join(" "));
  checkSetting(name, items);
  if (name === "transaction_isolation" || name === "default_transaction_isolation") {
    const level = items.join(" ").toLowerCase();
    return { kind: "isolation", scope: name === "transaction_isolation" ? "transaction" : "session", level: level === "default" ? undefined : (level as Isolation), tag: "SET" };
  }
  return { kind: "noop", tag: "SET" };
}

/**
 * CREATE DATABASE name [[WITH] TEMPLATE [=] template]
 * DROP DATABASE [IF EXISTS] name [[WITH] (FORCE)]
 */
function classifyDatabaseCommand([first, second]: Array<string>, pg: string): Statement | undefined {
  if (second !== "DATABASE" || (first !== "CREATE" && first !== "DROP")) return undefined;
  const tokens = tokenize(pg).slice(2);
  const word = () => tokens[0]?.text.toUpperCase();
  const take = (...expected: Array<string>) => {
    if (!expected.includes(word() ?? "")) return false;
    tokens.shift();
    return true;
  };
  const name = () => {
    const t = tokens.shift();
    if (!isIdentifier(t)) throw new PgError("42601", `syntax error in ${first} DATABASE: expected a database name`);
    return t!.type === "VAR" ? t!.text.toLowerCase() : t!.text; // unquoted names fold to lower case
  };
  const end = () => {
    if (tokens.length) throw new PgError("0A000", `duragres does not support "${tokens[0].text}" in ${first} DATABASE`);
  };

  if (first === "CREATE") {
    const db = name();
    take("WITH");
    const template = take("TEMPLATE") ? (take("="), name()) : undefined;
    end();
    return { kind: "createDatabase", name: db, template };
  }
  const ifExists = take("IF") && take("EXISTS");
  const db = name();
  take("WITH");
  const force = take("(") && take("FORCE") && take(")");
  end();
  return { kind: "dropDatabase", name: db, ifExists, force };
}

function classify(node: Expression, pg: string): Statement {
  const kind = kindOf(node);
  if (kind === "create_schema" || kind === "drop_schema") return { kind: "noop", tag: commandTag(kind) };
  if ("alter_table" in node) {
    // SQLite cannot add a constraint to a table; rebuild.ts recreates the table with it.
    const [action, ...rest] = node.alter_table.actions;
    if (!rest.length && typeof action === "object" && "AddConstraint" in action) {
      const add = tokenize(pg).find((t) => t.type === "ADD")!;
      return { kind: "addConstraint", table: node.alter_table.name.name.name, constraint: pg.slice(add.end).trim() };
    }
  }
  const dml = kind === "insert" || kind === "update" || kind === "delete";
  const writes = findNodes(node, (n) => "insert" in n || "update" in n || "delete" in n);
  const ddl = /^(create|alter|drop)_/.test(kind);
  return { kind: "sql", node, pg, tag: commandTag(kind), dml, ddl, readOnly: isQuery(node) && !writes.length };
}

/** "create_table" -> "CREATE TABLE"; every query reports SELECT. */
const commandTag = (kind: string) => (QUERY_KINDS.has(kind) ? "SELECT" : kind.replaceAll('_', " ").toUpperCase());

// --- Splitting and rewriting

/** SQLite has one schema; these qualifiers are dropped. drizzle-kit keeps its journal in "drizzle". */
const FLAT_SCHEMAS = new Set(["public", "drizzle"]);

/** Session functions SQLite lacks, and whether they are called with parentheses. */
const SESSION_FUNCTIONS: Record<string, "call" | "bare" | "either"> = {
  current_database: "call", version: "call", current_schema: "either", current_user: "bare", session_user: "bare", user: "bare",
};

const isIdentifier = (t?: Token) => t?.type === "VAR" || t?.type === "QUOTED_IDENTIFIER";
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

function sessionValue(fn: string, s: Session): string {
  if (fn === "current_database") return s.database;
  if (fn === "current_schema") return "public";
  if (fn === "version") return `PostgreSQL ${SERVER_VERSION} (Duragres: Cloudflare Durable Object + SQLite, SQL via Polyglot)`;
  return s.user;
}

interface Split { pg: string; words: Array<string>; readsCatalog: boolean }

/**
 * Non-empty statements of `query` with their first two keywords, flattened schema
 * qualifiers dropped and session functions replaced by their values.
 */
function splitAndRewrite(query: string, s: Session): Array<Split> {
  const tokens = tokenize(query);
  const statements: Array<Split> = [];
  let text = "";
  let words: Array<string> = [];
  let readsCatalog = false;
  let at = tokens[0]?.start ?? 0; // query[at, edit) is copied verbatim before each edit
  const emit = (end: number, replacement: string) => {
    text += query.slice(at, end) + replacement;
  };
  const finish = () => {
    if (text.trim()) statements.push({ pg: text.trim(), words, readsCatalog });
    text = "";
    words = [];
    readsCatalog = false;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const prev = tokens[i - 1];
    const next = tokens[i + 1];

    if (t.type === "SEMICOLON") {
      emit(t.start, "");
      finish();
      at = t.end;
      continue;
    }
    if (words.length < 2) words.push(t.text.toUpperCase());
    // pg_catalog.current_database() and friends are session functions, rewritten below.
    const catalogName = tokens[i + 2]?.text.toLowerCase() ?? "";
    if (isIdentifier(t) && t.text.toLowerCase() === "pg_catalog" && next?.type === "DOT" && !SESSION_FUNCTIONS[catalogName]) readsCatalog = true;

    if (isIdentifier(t) && next?.type === "DOT" && prev?.type !== "DOT" && FLAT_SCHEMAS.has(t.text.toLowerCase())) {
      emit(t.start, "");
      at = next.end;
      i++;
      continue;
    }

    const fn = t.type === "STRING" || t.type === "QUOTED_IDENTIFIER" ? "" : t.text.toLowerCase();
    const style = SESSION_FUNCTIONS[fn];
    const called = next?.type === "L_PAREN" && tokens[i + 2]?.type === "R_PAREN";
    // pg_catalog.current_database() is the same function; anything else qualified is not.
    const qualified = prev?.type === "DOT" && tokens[i - 2]?.text.toLowerCase() === "pg_catalog";
    if (style && (prev?.type !== "DOT" || qualified) && (style === "either" || (style === "call") === called)) {
      const first = qualified ? i - 2 : i;
      const last = called ? i + 2 : i;
      const before = tokens[first - 1];
      const after = tokens[last + 1];
      // A bare select-list item keeps Postgres' column name, which is the function name.
      const item = (before?.type === "SELECT" || before?.type === "COMMA") && (!after || ["COMMA", "FROM", "SEMICOLON"].includes(after.type));
      emit(tokens[first].start, quote(sessionValue(fn, s)) + (item ? ` AS ${fn}` : ""));
      at = tokens[last].end;
      i = last;
    }
  }
  emit(query.length, "");
  finish();
  return statements;
}
