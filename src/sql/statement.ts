// A client query, split into statements and classified. Each statement is either
// answered without storage, controls the transaction, or runs on SQLite.
//
// Utility statements (transaction control, SET, SHOW) are classified by their
// leading keyword, since Polyglot doesn't parse every form of them; psql's catalog
// queries are answered from their text; everything else is classified from its AST.
// Rewrites are token edits on the original text, because Polyglot's PostgreSQL
// generator is not lossless.
import type { Result } from "../postgres/wire";
import { QUERY_KINDS, isQuery } from "./catalog";
import { findNodes, kindOf, parse, tokenize, type Expression, type Token } from "./polyglot";
import { answerCatalogQuery } from "./psql-meta";
import { SERVER_VERSION, type Session } from "./session";

export type Statement =
  | { kind: "transaction"; op: "begin" | "commit" | "rollback" }
  | { kind: "show"; name: string }
  | { kind: "noop"; tag: string } // SET, RESET, DISCARD, CREATE/DROP SCHEMA: SQLite has no settings or schemas
  | { kind: "catalog"; result: Result }
  | { kind: "addConstraint"; table: string; constraint: string }
  // clock: inside a transaction, the start time every reading of the current time returns (determinism.ts)
  | { kind: "sql"; node: Expression; pg: string; tag: string; dml: boolean; ddl: boolean; readOnly: boolean; clock?: number };

export function prepare(query: string, s: Session): Statement[] {
  return splitAndRewrite(query, s).flatMap(({ pg, words, readsCatalog }): Statement[] => {
    const utility = classifyUtility(words);
    if (utility) return [utility];
    if (readsCatalog) return [{ kind: "catalog", result: answerCatalogQuery(pg, s) }];
    // A comment-only statement parses to nothing.
    return parse(pg).map((node) => classify(node, pg));
  });
}

/** Classifies a statement by its first two keywords, upper-cased. */
function classifyUtility([first, second = ""]: string[]): Statement | undefined {
  switch (first) {
    case "BEGIN":
    case "START":
      return { kind: "transaction", op: "begin" };
    case "COMMIT":
    case "END":
      return { kind: "transaction", op: "commit" };
    case "ROLLBACK":
    case "ABORT":
      return { kind: "transaction", op: "rollback" };
    case "SHOW":
      return { kind: "show", name: second.toLowerCase() };
    case "SET":
    case "RESET":
      return { kind: "noop", tag: first };
    case "DISCARD":
      return { kind: "noop", tag: `DISCARD ${second}` };
  }
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
const commandTag = (kind: string) => (QUERY_KINDS.has(kind) ? "SELECT" : kind.replace(/_/g, " ").toUpperCase());

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

interface Split { pg: string; words: string[]; readsCatalog: boolean }

/**
 * Non-empty statements of `query` with their first two keywords, flattened schema
 * qualifiers dropped and session functions replaced by their values.
 */
function splitAndRewrite(query: string, s: Session): Split[] {
  const tokens = tokenize(query);
  const statements: Split[] = [];
  let text = "";
  let words: string[] = [];
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
