// A client query, split into statements and classified. Each statement is either
// answered without storage, controls the transaction, or runs on SQLite.
//
// Rewrites are token edits on the original text, because Polyglot's PostgreSQL
// generator is not lossless; the AST is used to classify.
import { findNodes, parse, tokenize, type Node, type Token } from "./polyglot";
import { SERVER_VERSION, type Session } from "./session";

export type Statement =
  | { kind: "transaction"; op: "begin" | "commit" | "rollback" }
  | { kind: "show"; name: string }
  | { kind: "noop"; tag: string } // SET, RESET, CREATE/DROP SCHEMA: SQLite has no settings or schemas
  | { kind: "addConstraint"; table: string; constraint: string }
  | { kind: "sql"; node: Node; pg: string; tag: string; dml: boolean; readOnly: boolean };

export function prepare(query: string, s: Session): Statement[] {
  // A comment-only statement parses to nothing.
  return splitAndRewrite(query, s).flatMap((pg) => parse(pg).map((node) => classify(node, pg)));
}

function classify(node: Node, pg: string): Statement {
  const kind = Object.keys(node)[0];
  switch (kind) {
    case "transaction":
      return { kind: "transaction", op: "begin" };
    case "commit":
      return { kind: "transaction", op: "commit" };
    case "rollback":
      return { kind: "transaction", op: "rollback" };
    case "show":
      return { kind: "show", name: String(node.show.this).toLowerCase() };
    case "set_statement":
      return { kind: "noop", tag: "SET" };
    case "command":
      if (/^reset\b/i.test(node.command.this)) return { kind: "noop", tag: "RESET" };
      break;
    case "create_schema":
    case "drop_schema":
      return { kind: "noop", tag: commandTag(kind) };
    case "alter_table": {
      // SQLite cannot add a constraint to a table; rebuild.ts recreates the table with it.
      const actions: Node[] = node.alter_table.actions ?? [];
      if (actions.length === 1 && actions[0].AddConstraint) {
        const add = tokenize(pg).find((t) => t.type === "ADD")!;
        return { kind: "addConstraint", table: node.alter_table.name.name.name, constraint: pg.slice(add.end).trim() };
      }
    }
  }
  const dml = kind === "insert" || kind === "update" || kind === "delete";
  const writes = findNodes(node, (n) => n?.insert || n?.update || n?.delete);
  const readOnly = (kind === "select" || kind === "values") && !writes.length;
  return { kind: "sql", node, pg, tag: commandTag(kind), dml, readOnly };
}

/** "create_table" -> "CREATE TABLE"; queries report SELECT. */
const commandTag = (kind: string) => (kind === "values" ? "SELECT" : kind.replace(/_/g, " ").toUpperCase());

// --- Splitting and rewriting

/** SQLite has one schema; these qualifiers are dropped. drizzle-kit keeps its journal in "drizzle". */
const FLAT_SCHEMAS = new Set(["public", "drizzle"]);

/** Session functions SQLite lacks, and whether they are called with parentheses. */
const SESSION_FUNCTIONS: Record<string, "call" | "bare" | "either"> = {
  current_database: "call", version: "call", current_schema: "either", current_user: "bare", session_user: "bare",
};

const isIdentifier = (t?: Token) => t?.type === "VAR" || t?.type === "QUOTED_IDENTIFIER";
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

function sessionValue(fn: string, s: Session): string {
  if (fn === "current_database") return s.database;
  if (fn === "current_schema") return "public";
  if (fn === "version") return `PostgreSQL ${SERVER_VERSION} (Duragres: Cloudflare Durable Object + SQLite, SQL via Polyglot)`;
  return s.user;
}

/** Non-empty statements of `query`, with flattened schemas dropped and session functions replaced by their values. */
function splitAndRewrite(query: string, s: Session): string[] {
  const tokens = tokenize(query);
  const statements: string[] = [];
  let text = "";
  let at = tokens[0]?.start ?? 0; // copy query[at, token.start) verbatim before each edit
  const emit = (end: number, replacement: string) => {
    text += query.slice(at, end) + replacement;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const prev = tokens[i - 1];
    const next = tokens[i + 1];

    if (t.type === "SEMICOLON") {
      emit(t.start, "");
      if (text.trim()) statements.push(text.trim());
      text = "";
      at = t.end;
      continue;
    }

    if (isIdentifier(t) && next?.type === "DOT" && prev?.type !== "DOT" && FLAT_SCHEMAS.has(t.text.toLowerCase())) {
      emit(t.start, "");
      at = next.end;
      i++;
      continue;
    }

    const fn = t.type === "VAR" ? t.text.toLowerCase() : "";
    const style = SESSION_FUNCTIONS[fn];
    const called = next?.type === "L_PAREN" && tokens[i + 2]?.type === "R_PAREN";
    if (style && prev?.type !== "DOT" && (style === "either" || (style === "call") === called)) {
      const last = called ? i + 2 : i;
      const after = tokens[last + 1];
      // A bare select-list item keeps Postgres' column name, which is the function name.
      const item = (prev?.type === "SELECT" || prev?.type === "COMMA") && (!after || ["COMMA", "FROM", "SEMICOLON"].includes(after.type));
      emit(t.start, quote(sessionValue(fn, s)) + (item ? ` AS ${fn}` : ""));
      at = tokens[last].end;
      i = last;
    }
  }
  emit(query.length, "");
  if (text.trim()) statements.push(text.trim());
  return statements;
}
