import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { users } from "./schema";

const client = new pg.Client(process.env.DATABASE_URL);
await client.connect();
try {
  const db = drizzle(client);
  const [user] = await db.insert(users)
    .values({ name: "Ada", email: "ada@example.com", prefs: { theme: "dark" } })
    .onConflictDoUpdate({ target: users.email, set: { name: "Ada" } })
    .returning();
  console.log(user);
  console.log("typeof active:", typeof user!.active);
  console.log("createdAt instanceof Date:", user!.createdAt instanceof Date);
  console.log("typeof prefs:", typeof user!.prefs);
} finally {
  await client.end();
}
