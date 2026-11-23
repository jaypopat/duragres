// Extended-protocol check: node-postgres sends Parse/Bind/Describe/Execute/Sync for $n params.
import pg from "pg";

const db = process.env.DB ?? `nodepg-${Date.now().toString(36)}`;
const client = new pg.Client(`postgres://demo@localhost:8788/${db}?sslmode=disable`);
client.on("notice", () => {});
await client.connect();
// Self-contained fixture (same shape as corpus/demo.sql)
await client.query(`CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, active BOOLEAN DEFAULT false)`);
await client.query(`CREATE TABLE posts (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, views INTEGER DEFAULT 0)`);
await client.query(`INSERT INTO users (email, name, active) VALUES ('ada@example.com', 'Ada Lovelace', true), ('alan@example.com', 'Alan Turing', true), ('grace@example.com', 'Grace Hopper', true), ('linus@example.com', 'Linus Torvalds', false)`);
await client.query(`INSERT INTO posts (user_id, title, views) VALUES (1, 'Notes on the Analytical Engine', 121), (2, 'Computing Machinery and Intelligence', 300), (3, 'COBOL tips', 80)`);
const show = (label, r) => console.log(label, JSON.stringify({ command: r.command, rowCount: r.rowCount, fields: r.fields.map((f) => `${f.name}:${f.dataTypeID}`), rows: r.rows }));

show("param select ", await client.query("SELECT id, name, active FROM users WHERE email = $1", ["alan@example.com"]));
show("two params   ", await client.query("SELECT name FROM users WHERE id > $1 AND name ILIKE $2 ORDER BY id", [1, "%o%"]));
show("insert ret   ", await client.query("INSERT INTO posts (user_id, title, views) VALUES ($1, $2, $3) RETURNING id, title", [2, "Hello from node-postgres", 7]));
show("named prep   ", await client.query({ name: "by-id", text: "SELECT title FROM posts WHERE id = $1", values: [1] }));
show("named again  ", await client.query({ name: "by-id", text: "SELECT title FROM posts WHERE id = $1", values: [3] }));
show("simple query ", await client.query("SELECT COUNT(*) FROM posts"));
try {
  await client.query("INSERT INTO users (email, name) VALUES ($1, $2)", ["ada@example.com", "dup"]);
} catch (e) {
  console.log("unique error  ", JSON.stringify({ code: e.code, message: e.message }));
}
show("after error  ", await client.query("SELECT $1::text AS still_alive", ["yes"]));
await client.end();
console.log("OK");
