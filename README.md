# Duragres

Connect any PostgreSQL client to a Cloudflare Durable Object. The database name in the connection string picks the object, and connecting to a new name creates it. Each database runs PostgreSQL 19, compiled to WebAssembly by [PGlite](https://pglite.dev), inside its object. Postgres's data directory is stored in the object's SQLite storage.

## Try it

Pick any database name (3–63 chars, `a-z`, `0-9`, `-`) and connect directly:

```sh
psql 'postgres://demo@duragres.jaypopat.me/mydb'
```

For coding agents, install the skill:

```sh
npx skills add jaypopat/duragres
```

## Claim a database

A new database is deleted 72 hours after it is created, unless you claim it. To claim it, give a role a password:

```sql
ALTER ROLE demo PASSWORD 'correct horse battery staple';
```

From then on, every connection to that database authenticates with SCRAM-SHA-256 against `pg_catalog.pg_authid` (roles with `NOLOGIN`, an expired `VALID UNTIL`, or a non-SCRAM password cannot sign in). Before a database is claimed, anyone who knows its name can connect.

Roles authenticate who can connect to a database, but they are **not** a security boundary inside it: every connection shares one Postgres backend and session state.

## Branch a database

Connected to a database, copy it into a new one and drop the copy when you're done:

```sql
CREATE DATABASE "try-migration" TEMPLATE "mydb";  -- copies mydb's committed data
DROP DATABASE "try-migration";                    -- WITH (FORCE) closes its connections first
```

The copy gets its own storage, roles, and passwords: if the source has passwords, the copy inherits them and requires authentication immediately. Inheriting passwords protects the copy, but does **not** claim it — a branch still expires after 72 hours unless you set a password on the copy itself.

An unprotected database (no passwords) can be dropped by anyone who knows its name. Once a database has passwords, it can be dropped **only** from the database it was copied from (which can always drop its copies, even after a copy sets its own password); any other `DROP DATABASE` fails with SQLSTATE `42501`. Neither statement can run inside a transaction.

## Alchemy

Install [`@duragres/alchemy`](alchemy/) for an Alchemy v2 resource that provisions and branches Duragres databases, plus a standalone Postgres client (`@duragres/alchemy/client`) with no Alchemy or Effect dependency:

```sh
bun add @duragres/alchemy
```

```ts
import * as Duragres from "@duragres/alchemy";
import * as Alchemy from "alchemy";
import { Effect } from "effect";

export default Alchemy.Stack(
  "MyApp",
  { providers: Duragres.providers({ host: "duragres.jaypopat.me" }), state: Alchemy.localState() },
  Effect.gen(function* () {
    const db = yield* Duragres.Database("PreviewDatabase", {
      name: stage,
      template: { name: "staging-seed", user: "demo", password: seedPassword },
    });
    // db.origin matches Cloudflare.Hyperdrive and Neon.PostgresOrigin
    return { origin: db.origin, connectionUri: db.connectionUri };
  }),
);
```

If `password` is omitted, a random password is generated once and kept in state; setting it claims and protects the database. On destroy, a branched database is dropped immediately from its template (`DROP DATABASE ... WITH (FORCE)`), while a standalone database has its passwords cleared so it expires on TTL. Workers and Functions can also bind a database via `Duragres.Connect(db)` with `Duragres.ConnectHttp`. See `examples/alchemy/` for a runnable stack.

## Connections share one backend

PGlite runs one Postgres backend per database. Duragres shares it between connections the way PgBouncer's transaction mode shares a server connection, so the same rules apply:

- A connection holds the backend from its first statement until its transaction ends. Other connections' statements wait meanwhile, reads included.
- A transaction left idle for 5 seconds while another connection waits is ended with SQLSTATE 25P03. With nobody waiting, the limit is 30 seconds.
- Plain `SET`, temporary tables, `LISTEN` and session advisory locks are shared by every connection. Use `SET LOCAL` inside a transaction.
- Prepared statements are per connection, as usual.

Code that holds a transaction on one connection and waits for a query on another, such as using `db` instead of `tx` inside a Drizzle transaction, waits until the 5-second rule ends the transaction.

## TLS

Production traffic hits the `duragres-tls` Worker in `tls/`, which runs Go's `crypto/tls` compiled to WebAssembly (`tls/main.go`) because Workers have no server-side TLS, then forwards plaintext to `duragres` over a service binding. It supports both Postgres `SSLRequest` and libpq 17 direct TLS (`ALPN: postgresql`), refuses plaintext with SQLSTATE `28000`, and rate-limits new connections per client IP.

<details>
<summary>Self-hosting TLS</summary>

1. Issue a cert for your hostname (e.g. via Let's Encrypt DNS-01) and deploy both Workers (building `tls/` requires Go; first deploy supplies `TLS_CERT` and `TLS_KEY` via `--secrets-file`):

   ```sh
   bun run deploy
   bun tls/build.ts
   cd tls && bunx wrangler deploy --experimental-new-config --secrets-file /path/to/tls-secrets.json
   ```

2. Point a Cloudflare Spectrum TCP application on port 5432 at `duragres-tls` (not `duragres`), with Edge TLS Termination off.

3. Rotate the cert before expiry with `wrangler secret put TLS_CERT` and `wrangler secret put TLS_KEY` in `tls/`.

Clients connect with `postgres://demo:<password>@db.example.com/mydb?sslmode=verify-full`.

</details>

## Limits

- `COPY ... FROM STDIN` fails with SQLSTATE 0A000. `COPY ... TO STDOUT` works.
- PL/pgSQL and the Snowball full-text dictionaries are available. Other extensions are not.
- A query that needs more than about 100 MiB of memory fails with SQLSTATE 53200, and the database keeps working.
- Bulk inserts into large indexed tables are slow: about 24 seconds for 200,000 rows, deployed.

## The engine

`engine/` builds the PGlite package Duragres uses: upstream PGlite at the commits in `engine/pglite.lock.ts`, plus the patches in `engine/patches/`:

- `postgres-pglite/0001-initial-memory-64mb.patch` starts the WebAssembly heap at 64 MiB instead of 128 MiB, which leaves room under the Workers memory limit.
- `postgres-pglite/0002-export-wal-insert-position.patch` exports `GetXLogInsertRecPtr`, so Duragres can flush the write-ahead log before every reply, even with `synchronous_commit = off`.
- `pglite/0001-max-memory-option.patch` adds a `maxMemory` option, so a query that needs too much memory fails in Postgres instead of ending the isolate.

The built package is committed as `engine/dist/electric-sql-pglite-0.6.0-duragres.2.tgz`, so `bun install` needs no build. To rebuild it after changing a patch or the lock:

```sh
bun run engine:build            # Docker; compiles Postgres and its extensions in PGlite's builder image
bun engine/build.ts --check     # also fails if the tarball differs from engine/pglite.lock.ts
```

`bun engine/prepare.ts` turns the installed package into `engine/runtime/`, the files the Worker imports. `dev`, `test` and `deploy` run it first.

## Checks

```sh
bun run typecheck   # both Workers, engine/'s scripts, then the tests
bun run test        # starts its own Workers on ports 8787/8788, 8789/8790 (TLS) and 8797/8798
```

Stop any dev server on those ports first. The tests need Go (to build `tls/`) and openssl (for a test certificate).

## Configuration

`cloudflare.config.ts` defines the Worker, its Durable Object, bindings and limits. Wrangler reads it with `--experimental-new-config` and generates the `Env` type into `.cloudflare/types`. `wrangler dev --env test` evaluates it in test mode, with short limits for the lifecycle tests.

New connections are limited per client IP by the `CONNECT_LIMIT` rate-limit binding. Refused connections get SQLSTATE 53400.

## Layout

- `src/gateway.ts` reads the StartupMessage, picks the Durable Object by database name and pipes bytes to it.
- `src/database/` is the Durable Object: authentication, create-on-connect, expiry, claiming and branching.
- `src/engine/postgres.ts` boots PGlite on `src/engine/page-fs.ts`, which stores Postgres's data directory as 8 KiB pages in SQLite. It makes each message's writes durable before the reply goes out.
- `src/engine/pool.ts` shares the backend between connections.
- `src/postgres/` reads and writes the few protocol messages Duragres handles itself.
- `tls/` is the `duragres-tls` Worker: `src/index.ts` negotiates TLS, and `main.go` implements it with Go's `crypto/tls`.
- `alchemy/` is `@duragres/alchemy`: the plain Postgres client and the Alchemy v2 `Duragres.Database` resource and `Duragres.Connect` binding.
- `skills/duragres/SKILL.md` is an agent skill (`npx skills add jaypopat/duragres`) covering branching, claiming, single-backend pooling rules, and `@duragres/alchemy`.
