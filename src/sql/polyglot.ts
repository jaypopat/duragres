// Polyglot: PostgreSQL parsing, type annotation and PostgreSQL -> SQLite translation.
// In workerd it is initialised from the precompiled WebAssembly.Module wrangler gives a `.wasm` import.
import polyglot, { Dialect, findAll, getInferredType, type Schema, type TokenInfo } from "@polyglot-sql/sdk/manual";
import wasmModule from "@polyglot-sql/sdk/polyglot_sql.wasm";
import { PgError } from "../postgres/wire";

/** Polyglot's AST is plain JSON; accessors in this directory keep the shape assumptions local. */
// biome-ignore lint: untyped JSON at the Polyglot boundary
export type Node = any;

let ready: Promise<void> | undefined;
export function initPolyglot(): Promise<void> {
  // init() is typed as taking a URL; wasm-bindgen also accepts a Module.
  return (ready ??= polyglot.init({ wasmUrl: wasmModule }));
}

function check<T extends { success: boolean; error?: string | null }>(r: T): T {
  if (!r.success) throw new PgError("42601", r.error ?? "syntax error");
  return r;
}

export interface Token { type: string; text: string; start: number; end: number }

/** PostgreSQL tokens with their source offsets; strings and quoted identifiers are one token each. */
export function tokenize(sql: string): Token[] {
  // The SDK types the field as `tokenType`; the WASM returns `token_type`.
  const tokens = check(polyglot.tokenize(sql, Dialect.PostgreSQL)).tokens as (TokenInfo & { token_type: string })[];
  return tokens.map((t) => ({ type: t.token_type, text: t.text, start: t.span.start, end: t.span.end }));
}

/** PostgreSQL statements as AST nodes. */
export const parse = (sql: string): Node[] => check(polyglot.parse(sql, Dialect.PostgreSQL)).ast as Node[];

/** Like parse, with each value-producing node annotated with its type from `schema`. */
export const annotate = (sql: string, schema: Schema): Node[] => check(polyglot.annotateTypes(sql, Dialect.PostgreSQL, schema)).ast as Node[];

/** PostgreSQL text for one statement node. Not lossless (SERIAL becomes an identity column), so only for rewritten DML. */
export const generate = (node: Node): string => check(polyglot.generate([node], Dialect.PostgreSQL)).sql!.join(";\n");

/** SQLite statements for one PostgreSQL statement. */
export const transpile = (sql: string): string[] => check(polyglot.transpile(sql, Dialect.PostgreSQL, Dialect.SQLite)).sql ?? [];

/** PostgreSQL spelling of a data type node, e.g. "TIMESTAMPTZ" or "VARCHAR(20)". */
export function dataTypeSql(dataType: Node): string | undefined {
  const r = polyglot.generateDataType(dataType, Dialect.PostgreSQL);
  return r.success ? (r.sql ?? undefined) : undefined;
}

/** The type annotate() inferred for a node, as PostgreSQL type text. */
export function inferredType(node: Node): string | undefined {
  const type = getInferredType(node);
  return type ? dataTypeSql(type) : undefined;
}

export const findNodes = (node: Node, predicate: (n: Node) => boolean): Node[] => findAll(node, predicate);
