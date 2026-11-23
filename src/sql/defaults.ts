// INSERT ... VALUES (DEFAULT, $1, ...): SQLite has no DEFAULT keyword in VALUES.
// ORMs (Drizzle) emit it for every column you didn't set. Rewrite on the AST:
// drop DEFAULT columns, one INSERT per row when rows differ, DEFAULT VALUES when
// a row is all defaults. RETURNING / ON CONFLICT are kept on every statement.
import { generate, type Expression } from "./polyglot";

const isDefault = (v: Expression) => "var" in v && v.var.this.toUpperCase() === "DEFAULT";

/** Postgres statements to run instead of `stmt`, or undefined when no rewrite is needed. */
export function expandDefaults(stmt: Expression): string[] | undefined {
  if (!("insert" in stmt)) return undefined;
  const insert = stmt.insert;
  const rows = insert.values;
  if (!rows.some((row) => row.some(isDefault))) return undefined;
  const pattern = (row: Expression[]) => row.map((v) => (isDefault(v) ? "d" : "v")).join("");
  const groups = rows.every((r) => pattern(r) === pattern(rows[0])) ? [rows] : rows.map((r) => [r]);
  return groups.map((group) => {
    const keep = group[0].flatMap((v, i) => (isDefault(v) ? [] : [i]));
    const values = keep.length ? group.map((row) => keep.map((i) => row[i])) : [];
    const columns = keep.map((i) => insert.columns[i]);
    return generate({ insert: { ...insert, columns, values, default_values: keep.length === 0 } });
  });
}
