// INSERT ... VALUES (DEFAULT, $1, ...): SQLite has no DEFAULT keyword in VALUES.
// ORMs (Drizzle) emit it for every column you didn't set. Rewrite on the AST:
// drop DEFAULT columns, one INSERT per row when rows differ, DEFAULT VALUES when
// a row is all defaults. RETURNING / ON CONFLICT are kept on every statement.
import { generatePg } from "./polyglot";

// biome-ignore lint: Polyglot AST is untyped JSON at this boundary
type Node = any;
const isDefault = (v: Node) => typeof v?.var?.this === "string" && v.var.this.toUpperCase() === "DEFAULT";

/** Postgres statements to run instead of `stmt`, or undefined when no rewrite is needed. */
export function expandDefaults(stmt: Node): string[] | undefined {
  const ins = stmt?.insert;
  if (!ins?.values?.length || !ins.values.some((row: Node[]) => row.some(isDefault))) return undefined;
  const rows: Node[][] = ins.values;
  const pattern = (row: Node[]) => row.map((v) => (isDefault(v) ? "d" : "v")).join("");
  const groups = rows.every((r) => pattern(r) === pattern(rows[0])) ? [rows] : rows.map((r) => [r]);
  return groups.flatMap((group) => {
    const keep = group[0].map((v, i) => (isDefault(v) ? -1 : i)).filter((i) => i >= 0);
    const out = structuredClone(stmt);
    out.insert.columns = keep.map((i) => ins.columns[i]);
    out.insert.values = keep.length ? group.map((row) => keep.map((i) => row[i])) : [];
    out.insert.default_values = keep.length === 0;
    return generatePg([out]);
  });
}
