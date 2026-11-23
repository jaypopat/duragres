// Shadow catalog: the declared PostgreSQL type of every column, kept in `_pg_columns`
// next to the SQLite tables. Polyglot annotates statements against it to type result
// columns; parameters are typed from the column they are compared with or stored in.
import type { Schema } from "@polyglot-sql/sdk/manual";
import { dataTypeSql, inferredType, type Node } from "./polyglot";
import { T, typeByOid, typeFromDeclared, type PgType } from "./types";

export const CATALOG_DDL =
  "CREATE TABLE IF NOT EXISTS _pg_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, pg_type TEXT NOT NULL, oid INTEGER NOT NULL, ordinal INTEGER NOT NULL, PRIMARY KEY (table_name, column_name))";

interface CatalogColumn { name: string; declared: string; type: PgType }
type Catalog = Map<string, CatalogColumn[]>; // table -> columns in ordinal order

export function loadCatalog(sql: SqlStorage): Catalog {
  const catalog: Catalog = new Map();
  for (const [table, column, declared, oid] of sql.exec("SELECT table_name, column_name, pg_type, oid FROM _pg_columns ORDER BY table_name, ordinal").raw()) {
    const type = { ...(typeByOid(Number(oid)) ?? T.text), name: typeFromDeclared(String(declared)).name };
    const columns = catalog.get(String(table)) ?? [];
    columns.push({ name: String(column), declared: String(declared), type });
    catalog.set(String(table), columns);
  }
  return catalog;
}

/** The catalog in the shape Polyglot's type annotation expects. */
export function schemaOf(catalog: Catalog): Schema {
  return { tables: [...catalog].map(([name, columns]) => ({ name, columns: columns.map((c) => ({ name: c.name, type: c.declared })) })) };
}

// --- DDL: how a statement changes the catalog, applied in the same transaction as the DDL.

const nameOf = (n: Node): string | undefined => n?.name?.name ?? n?.name;
const declaredOf = (dataType: Node) => dataTypeSql(dataType) ?? "TEXT";

type CatalogChange =
  | { kind: "create"; table: string; ifNotExists: boolean; columns: { name: string; declared: string }[] }
  | { kind: "drop"; tables: string[] }
  | { kind: "add"; table: string; column: string; declared: string }
  | { kind: "dropColumn"; table: string; column: string };

export function changesOf(node: Node): CatalogChange[] {
  if (node.create_table) {
    const c = node.create_table;
    return [{
      kind: "create",
      table: nameOf(c.name.name)!,
      ifNotExists: Boolean(c.if_not_exists),
      columns: (c.columns ?? []).map((col: Node) => ({ name: nameOf(col.name)!, declared: declaredOf(col.data_type) })),
    }];
  }
  if (node.drop_table) return [{ kind: "drop", tables: node.drop_table.names.map((n: Node) => nameOf(n.name)!) }];
  if (node.alter_table) {
    const table = nameOf(node.alter_table.name.name)!;
    return (node.alter_table.actions ?? []).flatMap((a: Node): CatalogChange[] =>
      a.AddColumn ? [{ kind: "add", table, column: nameOf(a.AddColumn.column.name)!, declared: declaredOf(a.AddColumn.column.data_type) }]
      : a.DropColumn ? [{ kind: "dropColumn", table, column: nameOf(a.DropColumn.name)! }]
      : [],
    );
  }
  return [];
}

export function applyChanges(sql: SqlStorage, changes: CatalogChange[], existedBefore: (table: string) => boolean) {
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

// --- Typing, on a statement annotated against the catalog.

const bodyOf = (node: Node): Node => node.select ?? node.insert ?? node.update ?? node.delete;

/** Tables a statement reads, by name and alias, for expanding `*` and `t.*`. */
function tablesInScope(node: Node): Map<string, string> {
  const scope = new Map<string, string>();
  const add = (table: Node) => {
    const name = nameOf(table?.name);
    if (!name) return;
    scope.set(name, name);
    const alias = nameOf(table.alias);
    if (alias) scope.set(alias, name);
  };
  const body = bodyOf(node);
  for (const from of body?.from?.expressions ?? []) add(from.table);
  for (const join of body?.joins ?? []) add(join.this?.table);
  if (!node.select) add(body?.table);
  return scope;
}

function literalType(e: Node): PgType | undefined {
  // Postgres types integer literals int4 (int8 past 32 bits), other numbers numeric, strings text.
  const literal = e.literal ?? e.alias?.this?.literal;
  if (literal?.literal_type === "string") return T.text;
  if (literal?.literal_type !== "number") return undefined;
  const v = String(literal.value);
  return /^-?\d+$/.test(v) ? (Math.abs(Number(v)) <= 2 ** 31 - 1 ? T.int4 : T.int8) : T.numeric;
}

const typeOf = (e: Node): PgType | undefined => {
  const declared = inferredType(e);
  return declared ? typeFromDeclared(declared) : literalType(e);
};

export interface OutputColumn { name: string; type?: PgType } // no type: infer from the value

const AGGREGATES = new Set(["count", "sum", "avg", "min", "max"]);

/** The column name Postgres gives a select-list item. */
function columnName(e: Node): string {
  if (e.alias) return nameOf(e.alias.alias) ?? "?column?";
  if (e.column) return nameOf(e.column.name) ?? "?column?";
  if (e.function) return String(e.function.name).toLowerCase();
  if (e.cast && (e.cast.this.column || e.cast.this.function)) return columnName(e.cast.this);
  const key = Object.keys(e)[0];
  return AGGREGATES.has(key) ? key : "?column?";
}

/**
 * The result columns of a SELECT or RETURNING, worked out without running it, or
 * undefined when they can't be (a set operation, or `*` over a table not in the catalog).
 */
export function outputColumns(typed: Node, catalog: Catalog): OutputColumn[] | undefined {
  const outputs: Node[] | undefined = typed.select ? typed.select.expressions : bodyOf(typed)?.returning;
  if (!outputs) return undefined;
  const scope = tablesInScope(typed);
  const out: OutputColumn[] = [];
  for (const e of outputs) {
    if (!e.star) {
      out.push({ name: columnName(e), type: typeOf(e) });
      continue;
    }
    const tables = e.star.table ? [scope.get(nameOf(e.star.table)!)] : [...new Set(scope.values())];
    for (const table of tables) {
      const columns = table ? catalog.get(table) : undefined;
      if (!columns) return undefined;
      out.push(...columns.map((c) => ({ name: c.name, type: c.type })));
    }
  }
  return out;
}

/** Whether a statement returns rows: a query, or a write with RETURNING. */
export const returnsRows = (node: Node) => Boolean(node.select || node.values || node.union || node.intersect || node.except || bodyOf(node)?.returning?.length);

/** Types for $n parameters from where they appear: compared with a column, in INSERT VALUES, in SET, in LIMIT/OFFSET. */
export function paramTypes(typed: Node, catalog: Catalog): Map<number, PgType> {
  const types = new Map<number, PgType>();
  const set = (n: Node, type: PgType | undefined) => {
    const index = n?.parameter?.index;
    if (index && type && !types.has(index)) types.set(index, type);
  };
  const table = [...new Set(tablesInScope(typed).values())][0];
  const column = (name: string) => catalog.get(table)?.find((c) => c.name === name)?.type;

  if (typed.insert) {
    const columns: string[] = (typed.insert.columns ?? []).map((c: Node) => nameOf(c));
    for (const row of typed.insert.values ?? []) row.forEach((v: Node, i: number) => set(v, column(columns[i])));
  }
  for (const [col, v] of typed.update?.set ?? []) set(v, column(nameOf(col)!));
  set(typed.select?.limit?.this, T.int8);
  set(typed.select?.offset?.this, T.int8);

  const walk = (n: Node) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.left && n.right) {
      set(n.right, typeOf(n.left));
      set(n.left, typeOf(n.right));
    }
    if (n.in?.expressions) for (const v of n.in.expressions) set(v, typeOf(n.in.this));
    for (const child of Object.values(n)) walk(child);
  };
  walk(typed);
  return types;
}
