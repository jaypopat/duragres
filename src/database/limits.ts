import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

export class LimitsDO extends DurableObject<Env> {
  tryCreateDatabase(limit: number): boolean {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS creations (hour TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    const hour = new Date().toISOString().slice(0, 13);
    sql.exec("DELETE FROM creations WHERE hour < ?", hour);
    const n = Number(sql.exec("SELECT n FROM creations WHERE hour = ?", hour).raw().next().value?.[0] ?? 0);
    if (n >= limit) return false;
    sql.exec("INSERT INTO creations (hour, n) VALUES (?, 1) ON CONFLICT (hour) DO UPDATE SET n = n + 1", hour);
    return true;
  }
}
