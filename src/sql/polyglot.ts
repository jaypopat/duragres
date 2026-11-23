// Polyglot: PostgreSQL parsing, type annotation and PostgreSQL -> SQLite translation.
// In workerd it is initialised from the precompiled WebAssembly.Module wrangler gives a `.wasm` import.
import polyglot, { Dialect, findAll, getInferredType } from '@polyglot-sql/sdk/manual';
import type { Schema, TokenInfo } from '@polyglot-sql/sdk/manual';
import wasmModule from "@polyglot-sql/sdk/polyglot_sql.wasm";
import { PgError } from "../postgres/wire";

// The SDK exports functions over its AST types but not the types; recover them from the signatures.
/** One AST node: an object with a single key naming its kind, e.g. `{ select: Select }`. */
export type Expression = Extract<ReturnType<typeof polyglot.parse>, { success: true }>["ast"][number];
/** The node of kind K, e.g. `Variant<"select">` is `{ select: Select }`. */
export type Variant<K extends string> = Extract<Expression, Record<K, unknown>>;
/** The body of a node of kind K, e.g. `Body<"select">` is `Select`. */
export type Body<K extends string> = Variant<K>[K & keyof Variant<K>];
export type DataType = Parameters<typeof polyglot.generateDataType>[0];

export const kindOf = (node: Expression): string => Object.keys(node)[0];

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
export function tokenize(sql: string): Array<Token> {
  // The SDK types the field as `tokenType`; the WASM returns `token_type`.
  const tokens = check(polyglot.tokenize(sql, Dialect.PostgreSQL)).tokens as Array<TokenInfo & { token_type: string }>;
  return tokens.map((t) => ({ type: t.token_type, text: t.text, start: t.span.start, end: t.span.end }));
}

/** PostgreSQL statements as AST nodes. */
export const parse = (sql: string): Array<Expression> => check(polyglot.parse(sql, Dialect.PostgreSQL)).ast ?? [];

/** Like parse, with each value-producing node annotated with its type from `schema`. */
export const annotate = (sql: string, schema: Schema): Array<Expression> => check(polyglot.annotateTypes(sql, Dialect.PostgreSQL, schema)).ast ?? [];

/** PostgreSQL text for one statement node. Not lossless (SERIAL becomes an identity column), so only for rewritten DML. */
export const generate = (node: Expression): string => check(polyglot.generate([node], Dialect.PostgreSQL)).sql!.join(";\n");

/** SQLite statements for one PostgreSQL statement. */
export const transpile = (sql: string): Array<string> => check(polyglot.transpile(sql, Dialect.PostgreSQL, Dialect.SQLite)).sql ?? [];

/** PostgreSQL spelling of a data type node, e.g. "TIMESTAMPTZ" or "VARCHAR(20)". */
export function dataTypeSql(dataType: DataType): string | undefined {
  const r = polyglot.generateDataType(dataType, Dialect.PostgreSQL);
  return r.success ? (r.sql ?? undefined) : undefined;
}

/** The type annotate() inferred for a node, as PostgreSQL type text. */
export function inferredType(node: Expression): string | undefined {
  const type = getInferredType(node);
  return type ? dataTypeSql(type) : undefined;
}

export const findNodes = (node: Expression, predicate: (n: Expression) => boolean): Array<Expression> => findAll(node, predicate);
