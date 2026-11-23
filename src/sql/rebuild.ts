// ALTER TABLE ... ADD CONSTRAINT, which SQLite lacks, via SQLite's documented
// table rebuild: create the new shape, copy rows, drop, rename, recreate indexes.
// drizzle-kit emits FOREIGN KEY constraints this way in every migration.
import { tokenize } from "./polyglot";
import type { Session } from "./session";

/** Adds `constraint` (PostgreSQL text, e.g. "CONSTRAINT fk FOREIGN KEY ...") to `table`. */
export function addConstraint(table: string, constraint: string, s: Session) {
  if (s.inSync) rebuildTable(s.sql, table, constraint);
  else s.storage.transactionSync(() => rebuildTable(s.sql, table, constraint));
}

function rebuildTable(sql: SqlStorage, table: string, constraint: string) {
  const def = sql.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table).raw().next().value?.[0];
  if (typeof def !== "string") throw new Error(`no such table: ${table}`);
  const indexes = [...sql.exec("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL", table).raw()].map(([q]) => String(q));
  // The stored definition is "CREATE TABLE <name> (...)": rename it and add the constraint before the last ")".
  const tokens = tokenize(def);
  const name = tokens[tokens.findIndex((t) => t.type === "TABLE") + 1];
  const close = tokens.findLast((t) => t.type === "R_PAREN")!;
  const tmp = `${table}__duragres_rebuild`;
  sql.exec(`${def.slice(0, name.start)}"${tmp}"${def.slice(name.end, close.start)}, ${constraint})`);
  sql.exec(`INSERT INTO "${tmp}" SELECT * FROM "${table}"`);
  sql.exec(`DROP TABLE "${table}"`);
  sql.exec(`ALTER TABLE "${tmp}" RENAME TO "${table}"`);
  for (const q of indexes) sql.exec(q);
}
