# Duragres

Connect any PostgreSQL client to a Cloudflare Durable Object. The database name in the connection string picks the object, and connecting to a new name creates it. Each database is stored in that object's SQLite storage. An unclaimed database deletes itself after 72 hours.

## Local development

```sh
bun install --frozen-lockfile
bun run dev
psql 'postgres://demo@localhost:8788/mydb?sslmode=disable'
```

`bin/psql` runs psql 18 from Docker if you don't have it installed.

To try Drizzle, export that URL as `DATABASE_URL`, then run `bun run migrate` and `bun run demo` in `examples/drizzle`.

## Branching

Connected to a database, copy it into a new one and drop the copy when you're done:

```sql
CREATE DATABASE "try-migration" TEMPLATE "mydb";  -- copies mydb's committed data
DROP DATABASE "try-migration";                    -- WITH (FORCE) closes its connections first
```

The copy gets its own storage and expiry. Being connected to a database is what lets you copy it; knowing a name is what lets you connect to it or drop it. Neither statement can run inside a transaction.

## Checks

```sh
bun run typecheck   # the Worker, then the tests
bun run test        # starts its own Workers on ports 8787/8788 and 8797/8798
```

Stop any dev server on those ports first. The psql test needs Docker.

## Configuration

`cloudflare.config.ts` defines the Worker, its Durable Object, bindings and limits. Wrangler reads it with `--experimental-new-config` and generates the `Env` type into `.cloudflare/types`. `wrangler dev --env test` evaluates it in test mode, with short limits for the lifecycle tests.

New connections are limited per client IP by the `CONNECT_LIMIT` rate-limit binding. Refused connections get SQLSTATE 53400.

## Layout

- `src/gateway.ts` reads the StartupMessage, picks the Durable Object by database name and pipes bytes to it.
- `src/database/` is the Durable Object: connections, create-on-connect, expiry, and the snapshots `CREATE DATABASE ... TEMPLATE` sends to the new database over RPC.
- `src/postgres/` encodes and decodes wire-protocol messages.
- `src/sql/` translates PostgreSQL to SQLite with Polyglot and answers the catalog queries psql and ORMs send.

## Prototype limits

Connections are plaintext with trust authentication. Parameters must be sent in text format. SQL translation covers a subset of PostgreSQL. psql's `\dt`, `\d` and `\l` work; other `pg_catalog` queries fail with SQLSTATE 0A000.

Durable Object SQLite has no interactive transactions: it rejects `BEGIN` and `SAVEPOINT`, and an open `storage.transaction()` blocks the object until it ends. So a transaction's writes are logged, previewed in a rolled-back `transactionSync` for each statement, and replayed at COMMIT. Two rules make the replay commit exactly what the client saw. A transaction holds the database's single writer lock from its first write to COMMIT, so other writes wait. Each write is made deterministic first: `now()` is the transaction's start time, and omitted volatile defaults and `gen_random_uuid()` in `INSERT ... VALUES` become literal values. Other randomness in a write inside a transaction fails with SQLSTATE 0A000.

A copy is sent between Durable Objects in one RPC message, which bounds the size of a database that can be copied.
