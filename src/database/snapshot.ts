// A database's tables, rows and indexes, sent to another Durable Object over RPC
// (structured clone, so BLOBs travel as ArrayBuffers).
type Table = { name: string; ddl: string; columns: Array<string>; rows: Array<Array<SqlStorageValue>> };
export type Snapshot = { tables: Array<Table>; indexes: Array<string>; sequences: Array<[string, number]> };

const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';

export function capture(storage: DurableObjectStorage): Snapshot {
  return storage.transactionSync(() => {
    const sql = storage.sql;
    const schema = sql.exec<{ name: string; type: string; sql: string }>(`
      SELECT name, type, sql FROM sqlite_schema
      WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*'
        AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*'
        AND name != '__miniflare_do_name'
      ORDER BY name
    `).toArray();

    const tables: Array<Table> = [];
    const indexes: Array<string> = [];
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
      const rows = [...sql.exec(`SELECT ${columns.map(quote).join(", ")} FROM ${name}`).raw()];
      tables.push({ name: entry.name, ddl: entry.sql, columns, rows });
    }

    const sequences = sql.exec("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence'").toArray().length
      ? Array.from(sql.exec("SELECT name, seq FROM sqlite_sequence").raw<[string, number]>())
      : [];
    return { tables, indexes, sequences };
  });
}

export function restore(storage: DurableObjectStorage, snapshot: Snapshot) {
  const sql = storage.sql;
  storage.transactionSync(() => {
    sql.exec("PRAGMA defer_foreign_keys = ON");
    for (const table of snapshot.tables) sql.exec(table.ddl);
    for (const table of snapshot.tables) {
      const insert = `INSERT INTO ${quote(table.name)} (${table.columns.map(quote).join(", ")})
        VALUES (${table.columns.map(() => "?").join(", ")})`;
      for (const row of table.rows) sql.exec(insert, ...row);
    }
    for (const ddl of snapshot.indexes) sql.exec(ddl);
    for (const [name, sequence] of snapshot.sequences) {
      sql.exec("DELETE FROM sqlite_sequence WHERE name = ?", name);
      sql.exec("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", name, sequence);
    }
  });
}
