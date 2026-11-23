import pg from "pg";
export const url = (db) => `postgres://demo@localhost:8788/${db}?sslmode=disable`;
/** Fresh, valid database name per test so tests never share state. */
export const freshDb = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
export async function client(db) {
  const c = new pg.Client(url(db));
  c.on("notice", () => {});
  await c.connect();
  return c;
}
