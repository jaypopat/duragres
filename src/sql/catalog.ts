// Shadow catalog: the declared Postgres type of every column, kept in
// `_pg_columns` next to the SQLite tables, plus AST analysis that uses it to
// type result columns and bound parameters.
import { dataTypeSql, parsePg } from "./polyglot";
import { T, typeByOid, typeFromDeclared, type PgType } from "./types";

interface CatalogColumn { name: string; type: PgType }
type Catalog = Map<string, CatalogColumn[]>; // table -> columns in ordinal order

export const CATALOG_DDL =
  "CREATE TABLE IF NOT EXISTS _pg_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, pg_type TEXT NOT NULL, oid INTEGER NOT NULL, ordinal INTEGER NOT NULL, PRIMARY KEY (table_name, column_name))";

export function loadCatalog(sql: SqlStorage): Catalog {
  const cat: Catalog = new Map();
  for (const [t, c, declared, oid] of sql.exec("SELECT table_name, column_name, pg_type, oid FROM _pg_columns ORDER BY table_name, ordinal").raw()) {
    const type = { ...(typeByOid(Number(oid)) ?? T.text), name: typeFromDeclared(String(declared)).name };
    const cols = cat.get(String(t)) ?? [];
    cols.push({ name: String(c), type });
    cat.set(String(t), cols);
  }
  return cat;
}

// --- AST helpers. Polyglot's AST is plain JSON; these accessors keep the shape assumptions in one place.
// biome-ignore lint: the Polyglot AST is untyped JSON at this boundary
type Node = any;

const nameOf = (n: Node): string | undefined => n?.name?.name ?? n?.name;
/** DDL effects on the shadow catalog, computed before execution and applied in the same transaction. */
type CatalogChange =
  | { kind: "create"; table: string; ifNotExists: boolean; columns: { name: string; declared: string }[] }
  | { kind: "drop"; tables: string[] }
  | { kind: "add"; table: string; column: string; declared: string }
  | { kind: "dropColumn"; table: string; column: string };

interface Analysis {
  stmt?: Node;
  changes: CatalogChange[];
  scope: Map<string, string>; // alias or name -> table
  outputs?: Node[]; // select list / RETURNING list
  params: Map<number, PgType>;
}

function declaredOf(dt: Node): string {
  const r = dataTypeSql(dt);
  return r ?? "TEXT";
}

function scopeOf(stmt: Node): Map<string, string> {
  const scope = new Map<string, string>();
  const add = (ref: Node) => {
    const t = ref?.table;
    if (!t) return;
    const name = nameOf(t.name);
    if (!name) return;
    scope.set(name, name);
    const alias = nameOf(t.alias);
    if (alias) scope.set(alias, name);
  };
  const s = stmt.select ?? stmt.update ?? stmt.delete ?? stmt.insert;
  if (!s) return scope;
  for (const ref of s.from?.expressions ?? []) add(ref);
  for (const j of s.joins ?? []) add(j.this);
  if (stmt.update || stmt.delete || stmt.insert) add({ table: s.table });
  return scope;
}

function changesOf(stmt: Node): CatalogChange[] {
  if (stmt.create_table) {
    const c = stmt.create_table;
    return [{
      kind: "create",
      table: nameOf(c.name.name)!,
      ifNotExists: Boolean(c.if_not_exists),
      columns: (c.columns ?? []).map((col: Node) => ({ name: nameOf(col.name)!, declared: declaredOf(col.data_type) })),
    }];
  }
  if (stmt.drop_table) return [{ kind: "drop", tables: stmt.drop_table.names.map((n: Node) => nameOf(n.name)!) }];
  if (stmt.alter_table) {
    const table = nameOf(stmt.alter_table.name.name)!;
    return (stmt.alter_table.actions ?? []).flatMap((a: Node): CatalogChange[] =>
      a.AddColumn ? [{ kind: "add", table, column: nameOf(a.AddColumn.column.name)!, declared: declaredOf(a.AddColumn.column.data_type) }]
      : a.DropColumn ? [{ kind: "dropColumn", table, column: nameOf(a.DropColumn.name)! }]
      : [],
    );
  }
  return [];
}

export function analyze(pg: string): Analysis {
  const ast = parsePg(pg);
  const stmt = ast?.[0];
  if (!stmt) return { changes: [], scope: new Map(), params: new Map() };
  const s = stmt.select ?? stmt.update ?? stmt.delete ?? stmt.insert;
  return {
    stmt,
    changes: changesOf(stmt),
    scope: scopeOf(stmt),
    outputs: stmt.select ? s.expressions : s?.returning,
    params: new Map(),
  };
}

/** Apply catalog changes. Call inside the same transactionSync as the DDL. */
export function applyChanges(sql: SqlStorage, changes: CatalogChange[], existedBefore: (t: string) => boolean) {
  for (const ch of changes) {
    if (ch.kind === "create") {
      if (ch.ifNotExists && existedBefore(ch.table)) continue;
      sql.exec("DELETE FROM _pg_columns WHERE table_name = ?", ch.table);
      ch.columns.forEach((c, i) => {
        sql.exec("INSERT INTO _pg_columns VALUES (?, ?, ?, ?, ?)", ch.table, c.name, c.declared, typeFromDeclared(c.declared).oid, i + 1);
      });
    } else if (ch.kind === "drop") {
      for (const t of ch.tables) sql.exec("DELETE FROM _pg_columns WHERE table_name = ?", t);
    } else if (ch.kind === "add") {
      sql.exec(
        "INSERT OR REPLACE INTO _pg_columns VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM _pg_columns WHERE table_name = ?))",
        ch.table, ch.column, ch.declared, typeFromDeclared(ch.declared).oid, ch.table,
      );
    } else {
      sql.exec("DELETE FROM _pg_columns WHERE table_name = ? AND column_name = ?", ch.table, ch.column);
    }
  }
}

// --- Typing

function columnType(ref: Node, a: Analysis, cat: Catalog): PgType | undefined {
  const col = ref.column ?? ref.identifier;
  if (!col) return undefined;
  const name = nameOf(col.name) ?? col.name;
  const qualifier = nameOf(col.table);
  const tables = qualifier ? [a.scope.get(qualifier)].filter(Boolean) : [...new Set(a.scope.values())];
  const hits = tables.map((t) => cat.get(t!)?.find((c) => c.name === name)?.type).filter(Boolean) as PgType[];
  return hits.length && hits.every((h) => h.oid === hits[0].oid) ? hits[0] : undefined;
}

function exprType(e: Node, a: Analysis, cat: Catalog): PgType | undefined {
  if (e.alias) return exprType(e.alias.this, a, cat);
  if (e.column) return columnType(e, a, cat);
  if (e.cast) return typeFromDeclared(declaredOf(e.cast.to));
  if (e.count) return T.int8;
  // Postgres types integer literals int4 (int8 past 32 bits), others numeric; text literals are text.
  if (e.literal?.literal_type === "number") {
    const v = String(e.literal.value);
    return /^-?\d+$/.test(v) ? (Math.abs(Number(v)) <= 2 ** 31 - 1 ? T.int4 : T.int8) : T.numeric;
  }
  if (e.literal?.literal_type === "string") return T.text;
  return undefined; // inferred from the value
}

/**
 * One type (or undefined = infer from value) per result column, aligned with SQLite's
 * columns. Returns undefined when the shape can't be aligned (e.g. subqueries in *).
 */
export function outputTypes(a: Analysis, cat: Catalog, columnCount: number): (PgType | undefined)[] | undefined {
  if (!a.outputs) return undefined;
  const out: (PgType | undefined)[] = [];
  for (const e of a.outputs) {
    if (e.star) {
      const tables = e.star.table ? [a.scope.get(nameOf(e.star.table)!)] : [...new Set(a.scope.values())];
      for (const t of tables) {
        const cols = t ? cat.get(t) : undefined;
        if (!cols) return undefined;
        out.push(...cols.map((c) => c.type));
      }
    } else out.push(exprType(e, a, cat));
  }
  return out.length === columnCount ? out : undefined;
}

/** Types for $n parameters from where they appear: next to a column, in INSERT VALUES, SET, LIMIT/OFFSET. */
export function paramTypes(a: Analysis, cat: Catalog): Map<number, PgType> {
  const types = new Map<number, PgType>();
  const param = (n: Node): number | undefined => n?.parameter?.index;
  const setFrom = (n: Node, t: PgType | undefined) => { const i = param(n); if (i && t && !types.has(i)) types.set(i, t); };
  const table = [...new Set(a.scope.values())][0];
  const byName = (name: string) => (table ? cat.get(table)?.find((c) => c.name === name)?.type : undefined);
  const stmt = a.stmt;
  if (stmt?.insert) {
    const cols: string[] = (stmt.insert.columns ?? []).map((c: Node) => nameOf(c) ?? c.name);
    for (const row of stmt.insert.values ?? []) row.forEach((v: Node, i: number) => setFrom(v, byName(cols[i])));
  }
  if (stmt?.update) for (const [col, v] of stmt.update.set ?? []) setFrom(v, byName(nameOf(col) ?? col.name));
  const s = stmt?.select;
  if (s) { setFrom(s.limit?.this, T.int8); setFrom(s.offset?.this, T.int8); }
  const walk = (n: Node) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.left && n.right) {
      setFrom(n.right, columnType(n.left, a, cat));
      setFrom(n.left, columnType(n.right, a, cat));
    }
    if (n.in?.expressions) for (const v of n.in.expressions) setFrom(v, columnType(n.in.this, a, cat));
    for (const v of Object.values(n)) walk(v);
  };
  walk(stmt);
  return types;
}
