// Shadow catalog: the declared PostgreSQL type of every column, kept in `_pg_columns`
// next to the SQLite tables. Polyglot annotates statements against it to type result
// columns; parameters are typed from the column they are compared with or stored in.
import type { Schema } from "@polyglot-sql/sdk/manual";
import { dataTypeSql, findNodes, inferredType, kindOf, type Body, type DataType, type Expression } from "./polyglot";
import { T, typeByOid, typeFromDeclared, type PgType } from "./types";

export const CATALOG_DDL =
  "CREATE TABLE IF NOT EXISTS _pg_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, pg_type TEXT NOT NULL, oid INTEGER NOT NULL, ordinal INTEGER NOT NULL, PRIMARY KEY (table_name, column_name))";

interface CatalogColumn { name: string; declared: string; type: PgType }
type Catalog = Map<string, Array<CatalogColumn>>; // table -> columns in ordinal order

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

const declaredOf = (dataType: DataType) => dataTypeSql(dataType) ?? "TEXT";

type CatalogChange =
  | { kind: "create"; table: string; ifNotExists: boolean; columns: Array<{ name: string; declared: string }> }
  | { kind: "drop"; tables: Array<string> }
  | { kind: "add"; table: string; column: string; declared: string }
  | { kind: "dropColumn"; table: string; column: string };

export function changesOf(node: Expression): Array<CatalogChange> {
  if ("create_table" in node) {
    const c = node.create_table;
    const columns = c.columns.map((col) => ({ name: col.name.name, declared: declaredOf(col.data_type) }));
    return [{ kind: "create", table: c.name.name.name, ifNotExists: c.if_not_exists, columns }];
  }
  if ("drop_table" in node) return [{ kind: "drop", tables: node.drop_table.names.map((t) => t.name.name) }];
  if ("alter_table" in node) {
    const table = node.alter_table.name.name.name;
    // Some actions are bare strings ("Force"); the ones that change columns are objects.
    return node.alter_table.actions.flatMap((a): Array<CatalogChange> =>
      typeof a !== "object" ? []
      : "AddColumn" in a ? [{ kind: "add", table, column: a.AddColumn.column.name.name, declared: declaredOf(a.AddColumn.column.data_type) }]
      : "DropColumn" in a ? [{ kind: "dropColumn", table, column: a.DropColumn.name.name }]
      : [],
    );
  }
  return [];
}

export function applyChanges(sql: SqlStorage, changes: Array<CatalogChange>, existedBefore: (table: string) => boolean) {
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

type TableRef = Body<"table">;

/** The table a write targets. */
function targetOf(node: Expression): TableRef | undefined {
  if ("insert" in node) return node.insert.table;
  if ("update" in node) return node.update.table;
  if ("delete" in node) return node.delete.table;
}

const returningOf = (node: Expression): Array<Expression> | undefined =>
  "insert" in node ? node.insert.returning : "update" in node ? node.update.returning : "delete" in node ? node.delete.returning : undefined;

/** Tables a statement reads, by name and alias, for expanding `*` and `t.*`. */
function tablesInScope(node: Expression): Map<string, string> {
  const scope = new Map<string, string>();
  const add = (table?: TableRef) => {
    if (!table) return;
    scope.set(table.name.name, table.name.name);
    if (table.alias) scope.set(table.alias.name, table.name.name);
  };
  const tableOf = (e: Expression | null) => (e && "table" in e ? e.table : undefined);
  if ("select" in node) {
    for (const from of node.select.from?.expressions ?? []) add(tableOf(from));
    for (const join of node.select.joins ?? []) add(tableOf(join.this));
  } else add(targetOf(node));
  return scope;
}

function literalType(e: Expression): PgType | undefined {
  // Postgres types integer literals int4 (int8 past 32 bits), other numbers numeric, strings text.
  const inner = "alias" in e ? e.alias.this : e;
  if (!("literal" in inner)) return undefined;
  const literal = inner.literal;
  if (literal.literal_type === "string") return T.text;
  if (literal.literal_type !== "number") return undefined;
  const v = literal.value;
  return /^-?\d+$/.test(v) ? (Math.abs(Number(v)) <= 2 ** 31 - 1 ? T.int4 : T.int8) : T.numeric;
}

const typeOf = (e: Expression): PgType | undefined => {
  const declared = inferredType(e);
  return declared ? typeFromDeclared(declared) : literalType(e);
};

export interface OutputColumn { name: string; type?: PgType } // no type: infer from the value

const AGGREGATES = new Set(["count", "sum", "avg", "min", "max"]);

/** The column name Postgres gives a select-list item. */
function columnName(e: Expression): string {
  if ("alias" in e) return e.alias.alias.name;
  if ("column" in e) return e.column.name.name;
  if ("function" in e) return e.function.name.toLowerCase();
  if ("cast" in e && ("column" in e.cast.this || "function" in e.cast.this)) return columnName(e.cast.this);
  const kind = kindOf(e);
  return AGGREGATES.has(kind) ? kind : "?column?";
}

/**
 * The result columns of a SELECT or RETURNING, worked out without running it, or
 * undefined when they can't be (a set operation, or `*` over a table not in the catalog).
 */
export function outputColumns(typed: Expression, catalog: Catalog): Array<OutputColumn> | undefined {
  const outputs = "select" in typed ? typed.select.expressions : returningOf(typed);
  if (!outputs) return undefined;
  const scope = tablesInScope(typed);
  const out: Array<OutputColumn> = [];
  for (const e of outputs) {
    if (!("star" in e)) {
      out.push({ name: columnName(e), type: typeOf(e) });
      continue;
    }
    const tables = e.star.table ? [scope.get(e.star.table.name)] : [...new Set(scope.values())];
    for (const table of tables) {
      const columns = table ? catalog.get(table) : undefined;
      if (!columns) return undefined;
      out.push(...columns.map((c) => ({ name: c.name, type: c.type })));
    }
  }
  return out;
}

export const QUERY_KINDS = new Set(["select", "values", "union", "intersect", "except"]);
export const isQuery = (node: Expression) => QUERY_KINDS.has(kindOf(node));

/** Whether a statement returns rows: a query, or a write with RETURNING. */
export const returnsRows = (node: Expression) => isQuery(node) || Boolean(returningOf(node)?.length);

/** Types for $n parameters from where they appear: compared with a column, in INSERT VALUES, in SET, in LIMIT/OFFSET. */
export function paramTypes(typed: Expression, catalog: Catalog): Map<number, PgType> {
  const types = new Map<number, PgType>();
  const set = (e: Expression | null | undefined, type: PgType | undefined) => {
    const index = e && "parameter" in e ? e.parameter.index : null;
    if (index && type && !types.has(index)) types.set(index, type);
  };
  const table = targetOf(typed)?.name.name ?? [...tablesInScope(typed).values()][0];
  const column = (name: string) => catalog.get(table)?.find((c) => c.name === name)?.type;

  if ("insert" in typed) {
    const columns = typed.insert.columns.map((c) => c.name);
    for (const row of typed.insert.values) row.forEach((v, i) => set(v, column(columns[i])));
  }
  if ("update" in typed) for (const [col, v] of typed.update.set) set(v, column(col.name));
  if ("select" in typed) {
    set(typed.select.limit?.this, T.int8);
    set(typed.select.offset?.this, T.int8);
  }
  for (const node of findNodes(typed, () => true)) {
    const body = Object.values(node)[0] as unknown;
    if (isBinary(body)) {
      set(body.right, typeOf(body.left));
      set(body.left, typeOf(body.right));
    }
    if ("in" in node) for (const v of node.in.expressions) set(v, typeOf(node.in.this));
  }
  return types;
}

/** A comparison or other binary operator: a node body with `left` and `right` operands. */
const isBinary = (body: unknown): body is Body<"eq"> => typeof body === "object" && body !== null && "left" in body && "right" in body;
