# Duragres

Connect any PostgreSQL client to a Cloudflare Durable Object. The database name in the connection string picks the object, and connecting to a new name creates it. Each database runs PostgreSQL 19, compiled to WebAssembly by [PGlite](https://pglite.dev), inside its object. Postgres's data directory is stored in the object's SQLite storage.

## Local development

```sh
bun install --frozen-lockfile
bun run dev
psql 'postgres://demo@localhost:8788/mydb?sslmode=disable'
```

`bin/psql` runs psql 18 from Docker if you don't have it installed.

To try Drizzle, export that URL as `DATABASE_URL`, then run `bun run migrate` and `bun run demo` in `examples/drizzle`.


## Claim a database

A new database is deleted 72 hours after it is created, unless you claim it. To claim it, give a role a password:

```sql
ALTER ROLE demo PASSWORD 'correct horse battery staple';
```

From then on, every connection to that database authenticates with SCRAM-SHA-256 against the passwords its roles have. Before a database is claimed, anyone who knows its name can connect.

## Branch a database

Connected to a database, copy it into a new one and drop the copy when you're done:

```sql
CREATE DATABASE "try-migration" TEMPLATE "mydb";  -- copies mydb's committed data
DROP DATABASE "try-migration";                    -- WITH (FORCE) closes its connections first
```

The copy gets its own storage, roles, passwords and expiry. Connected to a database, you can copy it; knowing a name, you can connect to that database or drop it. Neither statement can run inside a transaction.

## Connections share one backend

PGlite runs one Postgres backend per database. Duragres shares it between connections the way PgBouncer's transaction mode shares a server connection, so the same rules apply:

- A connection holds the backend from its first statement until its transaction ends. Other connections' statements wait meanwhile, reads included.
- A transaction left idle for 5 seconds while another connection waits is ended with SQLSTATE 25P03. With nobody waiting, the limit is 30 seconds.
- Plain `SET`, temporary tables, `LISTEN` and session advisory locks are shared by every connection. Use `SET LOCAL` inside a transaction.
- Prepared statements are per connection, as usual.

Code that holds a transaction on one connection and waits for a query on another, such as using `db` instead of `tx` inside a Drizzle transaction, waits until the 5-second rule ends the transaction.

## Limits

- Connections are plaintext. Passwords travel as SCRAM-SHA-256 proofs, never in the clear, but queries and results do not.
- `COPY ... FROM STDIN` fails with SQLSTATE 0A000. `COPY ... TO STDOUT` works.
- Extensions that Postgres loads at runtime are not available yet, which includes PL/pgSQL.
- A query that needs more than about 100 MiB of memory fails with SQLSTATE 53200, and the database keeps working.
- Bulk inserts into large indexed tables are slow: about 24 seconds for 200,000 rows, deployed.

## The engine

`engine/` builds the PGlite package Duragres uses: upstream PGlite at the commits in `engine/pglite.lock.ts`, plus the patches in `engine/patches/`:

- `postgres-pglite/0001-initial-memory-64mb.patch` starts the WebAssembly heap at 64 MiB instead of 128 MiB, which leaves room under the Workers memory limit.
- `postgres-pglite/0002-export-wal-insert-position.patch` exports `GetXLogInsertRecPtr`, so Duragres can flush the write-ahead log before every reply, even with `synchronous_commit = off`.
- `pglite/0001-max-memory-option.patch` adds a `maxMemory` option, so a query that needs too much memory fails in Postgres instead of ending the isolate.

The built package is committed as `engine/dist/electric-sql-pglite-0.6.0-duragres.1.tgz`, so `bun install` needs no build. To rebuild it after changing a patch or the lock:

```sh
bun run engine:build            # Docker; compiles Postgres and its extensions in PGlite's builder image
bun engine/build.ts --check     # also fails if the tarball differs from engine/pglite.lock.ts
```

`bun engine/prepare.ts` turns the installed package into `engine/runtime/`, the files the Worker imports. `dev`, `test` and `deploy` run it first.

## Checks

```sh
bun run typecheck   # the Worker, then the tests
bun run test        # starts its own Workers on ports 8787/8788 and 8797/8798
```

Stop any dev server on those ports first.

## Configuration

`cloudflare.config.ts` defines the Worker, its Durable Object, bindings and limits. Wrangler reads it with `--experimental-new-config` and generates the `Env` type into `.cloudflare/types`. `wrangler dev --env test` evaluates it in test mode, with short limits for the lifecycle tests.

New connections are limited per client IP by the `CONNECT_LIMIT` rate-limit binding. Refused connections get SQLSTATE 53400.

## Layout

- `src/gateway.ts` reads the StartupMessage, picks the Durable Object by database name and pipes bytes to it.
- `src/database/` is the Durable Object: authentication, create-on-connect, expiry, claiming and branching.
- `src/engine/postgres.ts` boots PGlite on `src/engine/page-fs.ts`, which stores Postgres's data directory as 8 KiB pages in SQLite. It makes each message's writes durable before the reply goes out.
- `src/engine/pool.ts` shares the backend between connections.
- `src/postgres/` reads and writes the few protocol messages Duragres handles itself.
