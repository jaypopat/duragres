import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { users } from "./schema";

const client = new pg.Client(process.env.DATABASE_URL);
await client.connect();
try {
  const db = drizzle(client);
  const [user] = await db.insert(users)
    .values({ name: "Ada", email: "ada@example.com" })
    .onConflictDoUpdate({ target: users.email, set: { name: "Ada" } })
    .returning({ id: users.id, name: users.name });
  console.log(user);
} finally {
  await client.end();
}
