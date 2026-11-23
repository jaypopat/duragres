// ALTER TABLE ... ADD CONSTRAINT, which SQLite lacks, via SQLite's documented
// table rebuild: create the new shape, copy rows, drop, rename, recreate indexes.
// drizzle-kit emits FOREIGN KEY constraints this way in every migration.
import type { Session } from "./intercept";

const ADD_CONSTRAINT = /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?("?)(\w+)\1\s+ADD\s+(CONSTRAINT\s+(?:"[^"]+"|\w+)\s+[\s\S]+?)\s*;?\s*$/i;

/** Returns true if the statement was an ADD CONSTRAINT and has been applied. */
export function addConstraint(pg: string, s: Session): boolean {
  const m = ADD_CONSTRAINT.exec(pg);
  if (!m) return false;
  const [, , table, constraint] = m;
  if (s.inSync) rebuildTable(s.sql, table, constraint);
  else s.storage.transactionSync(() => rebuildTable(s.sql, table, constraint));
  return true;
}

function rebuildTable(sql: SqlStorage, table: string, constraint: string) {
  const def = sql.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table).raw().next().value?.[0];
  if (typeof def !== "string") throw new Error(`no such table: ${table}`);
  const indexes = [...sql.exec("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL", table).raw()].map(([q]) => String(q));
  const tmp = `${table}__duragres_rebuild`;
  const created = def
    .replace(/^(CREATE\s+TABLE\s+)("?)\w+\2/i, `$1"${tmp}"`)
    .replace(/\)\s*$/, `, ${constraint})`);
  sql.exec(created);
  sql.exec(`INSERT INTO "${tmp}" SELECT * FROM "${table}"`);
  sql.exec(`DROP TABLE "${table}"`);
  sql.exec(`ALTER TABLE "${tmp}" RENAME TO "${table}"`);
  for (const q of indexes) sql.exec(q);
}
