# Duragres

Connect any PostgreSQL client to a Cloudflare Durable Object. The database name in the connection string picks the object, and connecting to a new name creates it. Each database lives in that object's SQLite storage, and an unclaimed one deletes itself after 72 hours.

![psql connects to a database that doesn't exist yet, and Duragres creates it](docs/demo.gif)

## Try it

```sh
bun install --frozen-lockfile
bun run dev
psql postgres://demo@localhost:8788/mydb
```

Any name works in place of `mydb`.

To try an ORM, run the Drizzle example against the same server:

```sh
cd examples/drizzle
export DATABASE_URL=postgres://demo@localhost:8788/mydb
bun run migrate
bun run demo
```

## Branching

While connected to a database, copy it into a new one, and drop the copy when you're done:

```sql
CREATE DATABASE "try-migration" TEMPLATE "mydb";  -- copies mydb's committed data
DROP DATABASE "try-migration";                    -- WITH (FORCE) closes its connections first
```

The copy gets its own storage and expiry. You can only copy a database you're connected to; knowing a name is enough to connect to it or drop it. Neither statement can run inside a transaction.

## How it works

The Worker accepts raw TCP connections and speaks the Postgres wire protocol.

- `src/gateway.ts` reads the StartupMessage, picks the Durable Object by database name and pipes bytes to it.
- `src/database/` is the Durable Object: connections, create-on-connect, expiry, and the snapshots `CREATE DATABASE ... TEMPLATE` sends to the new database over RPC.
- `src/postgres/` encodes and decodes wire-protocol messages.
- `src/sql/` translates PostgreSQL to SQLite with Polyglot and answers the catalog queries psql and ORMs send.

`cloudflare.config.ts` defines the Worker, its Durable Object, bindings and limits. Wrangler reads it with `--experimental-new-config` and generates the `Env` type into `.cloudflare/types`. `wrangler dev --env test` evaluates it in test mode, with short limits for the lifecycle tests.

The `CONNECT_LIMIT` rate-limit binding caps new connections per client IP. Refused connections get SQLSTATE 53400.

## Development

```sh
bun run typecheck   # the Worker, then the tests
bun run test        # starts its own Workers on ports 8787/8788 and 8797/8798
```

Stop any dev server on those ports first. The psql test needs Docker.

`demo/` renders the demo video and records the GIF above. See `demo/record.ts`.

## Limits

Duragres is a prototype.

- **Connections** are plaintext with trust authentication. Parameters must be sent in text format.
- **SQL** translation covers a subset of PostgreSQL. psql's `\dt`, `\d` and `\l` work; other `pg_catalog` queries fail with SQLSTATE 0A000.
- **Session settings** are fixed: the server is always UTC, UTF8 and ISO dates, with one schema. `SET` to another time zone, encoding, date style or `search_path` fails with SQLSTATE 0A000. Settings that don't change results, such as `application_name` or `statement_timeout`, are accepted and ignored.
- **Branch size** is bounded: a copy is sent between Durable Objects in one RPC message.

### Transactions

Durable Object SQLite has no interactive transactions: it rejects `BEGIN` and `SAVEPOINT`, and an open `storage.transaction()` blocks the object until it ends. So a transaction's writes are logged, previewed in a rolled-back `transactionSync` for each statement, and replayed at COMMIT.

Two rules make the replay commit exactly what the client saw:

- A transaction holds the database's single writer lock from its first write to COMMIT, so other writes wait.
- Each write is made deterministic first. `now()` is the transaction's start time, and omitted volatile defaults and `gen_random_uuid()` in `INSERT ... VALUES` become literal values. Other randomness in a write inside a transaction fails with SQLSTATE 0A000.

The default isolation level is read committed: until its first write, a transaction sees other connections' commits. `REPEATABLE READ` and `SERIALIZABLE` take the writer lock at `BEGIN`, so those transactions are truly serializable but run one at a time, and block writers even when they only read.
