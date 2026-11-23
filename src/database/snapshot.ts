type Cell = string | number | null | { bytes: number[] };
type Table = { name: string; ddl: string; columns: string[]; rows: Cell[][] };
type Snapshot = { version: 1; tables: Table[]; indexes: string[]; sequences: [string, number][] };

const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';

export function capture(storage: DurableObjectStorage): Snapshot {
  return storage.transactionSync(() => {
    const sql = storage.sql;
    const schema = sql.exec<{ name: string; type: string; sql: string }>(`
      SELECT name, type, sql FROM sqlite_schema
      WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*'
        AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*'
        AND name NOT IN ('__miniflare_do_name', '_duragres_meta')
      ORDER BY name
    `).toArray();

    const tables: Table[] = [];
    const indexes: string[] = [];
    for (const entry of schema) {
      if (entry.type === "index") {
        indexes.push(entry.sql);
        continue;
      }
      if (entry.type !== "table" || !/^CREATE TABLE\s/i.test(entry.sql)) {
        throw new Error(`Snapshot does not support ${entry.type} ${entry.name}`);
      }
      const name = quote(entry.name);
      const columns = sql.exec<{ name: string; hidden: number }>(`PRAGMA table_xinfo(${name})`)
        .toArray().filter((column) => column.hidden === 0).map((column) => column.name);
      const rows = Array.from(sql.exec(`SELECT ${columns.map(quote).join(", ")} FROM ${name}`).raw(),
        (row) => row.map((value) => value instanceof ArrayBuffer ? { bytes: Array.from(new Uint8Array(value)) } : value));
      tables.push({ name: entry.name, ddl: entry.sql, columns, rows });
    }

    const sequences = sql.exec("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence'").toArray().length
      ? Array.from(sql.exec("SELECT name, seq FROM sqlite_sequence").raw<[string, number]>())
      : [];
    return { version: 1, tables, indexes, sequences };
  });
}

export function restore(storage: DurableObjectStorage, snapshot: Snapshot) {
  if (snapshot.version !== 1) throw new Error("Unsupported snapshot version");
  const sql = storage.sql;
  storage.transactionSync(() => {
    sql.exec("PRAGMA defer_foreign_keys = ON");
    for (const table of snapshot.tables) sql.exec(table.ddl);
    for (const table of snapshot.tables) {
      const insert = `INSERT INTO ${quote(table.name)} (${table.columns.map(quote).join(", ")})
        VALUES (${table.columns.map(() => "?").join(", ")})`;
      for (const row of table.rows) {
        sql.exec(insert, ...row.map((value) => typeof value === "object" && value !== null
          ? Uint8Array.from(value.bytes).buffer : value));
      }
    }
    for (const ddl of snapshot.indexes) sql.exec(ddl);
    for (const [name, sequence] of snapshot.sequences) {
      sql.exec("DELETE FROM sqlite_sequence WHERE name = ?", name);
      sql.exec("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", name, sequence);
    }
  });
}
