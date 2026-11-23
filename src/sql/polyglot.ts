// Polyglot in workerd: use the "manual" entry and hand wasm-bindgen a
// precompiled WebAssembly.Module (what wrangler gives a `.wasm` import).
import polyglot, { Dialect } from "@polyglot-sql/sdk/manual";
import wasmModule from "@polyglot-sql/sdk/polyglot_sql.wasm";

let ready: Promise<void> | undefined;
export function initPolyglot(): Promise<void> {
  // init() is typed as taking a URL; wasm-bindgen also accepts a Module.
  return (ready ??= polyglot.init({ wasmUrl: wasmModule }));
}

export function pgToSqlite(sql: string): string[] {
  const r = polyglot.transpile(sql, Dialect.PostgreSQL, Dialect.SQLite);
  if (!r.success) throw new Error(r.error ?? "transpile failed");
  return r.sql ?? [];
}

/** Postgres AST (array of statements), or undefined if Polyglot can't parse it. */
export function parsePg(sql: string): any[] | undefined {
  const r = polyglot.parse(sql, Dialect.PostgreSQL);
  return r.success ? (r.ast as any[]) : undefined;
}

/** Declared Postgres type text for an AST data_type node, e.g. "TIMESTAMPTZ", "VARCHAR(20)". */
export function dataTypeSql(dataType: unknown): string | undefined {
  const r = polyglot.generateDataType(dataType as never, Dialect.PostgreSQL);
  return r.success ? (r.sql ?? undefined) : undefined;
}

/** Postgres SQL text for AST statements. */
export function generatePg(ast: unknown[]): string[] {
  const r = polyglot.generate(ast as never, Dialect.PostgreSQL);
  if (!r.success) throw new Error(r.error ?? "generate failed");
  return r.sql ?? [];
}
