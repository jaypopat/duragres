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

## Connections share one backend

PGlite runs one Postgres backend per database. Duragres shares it between connections the way PgBouncer's transaction mode shares a server connection, so the same rules apply:

- A connection holds the backend from its first statement until its transaction ends. Other connections' statements wait meanwhile, reads included.
- A transaction left idle for 5 seconds while another connection waits is ended with SQLSTATE 25P03. With nobody waiting, the limit is 30 seconds.
- Plain `SET`, temporary tables, `LISTEN` and session advisory locks are shared by every connection. Use `SET LOCAL` inside a transaction.
- Prepared statements are per connection, as usual.

Code that holds a transaction on one connection and waits for a query on another, such as using `db` instead of `tx` inside a Drizzle transaction, waits until the 5-second rule ends the transaction.

## TLS

Production clients connect to the `duragres-tls` Worker in `tls/`, not to the `duragres` Worker. It negotiates TLS the way a Postgres server does, then forwards plaintext to `duragres` over a service binding:

- A client that sends an SSLRequest, as node-postgres and libpq do, gets `S` and then a TLS handshake.
- A client that starts with TLS directly (libpq 17's `sslnegotiation=direct`) gets one too, with the ALPN protocol `postgresql`.
- A plaintext connection is refused with SQLSTATE 28000.

Go's `crypto/tls` does the TLS work. `tls/main.go` compiles to WebAssembly because Workers have no server-side TLS. `duragres-tls` also rate-limits new connections per client IP, because `duragres` cannot see the client's address behind the service binding.

To set it up for a hostname such as `db.example.com`:

1. Get a certificate for the hostname, for example with certbot's Cloudflare DNS plugin:

   ```sh
   certbot certonly --dns-cloudflare --dns-cloudflare-credentials ~/.secrets/cloudflare.ini -d db.example.com
   ```

2. Deploy both Workers and give `duragres-tls` the certificate. `deploy:tls` needs Go.

   ```sh
   bun run deploy
   bun run deploy:tls
   cd tls
   bunx wrangler secret put TLS_CERT < /etc/letsencrypt/live/db.example.com/fullchain.pem
   bunx wrangler secret put TLS_KEY < /etc/letsencrypt/live/db.example.com/privkey.pem
   ```

3. Create a Spectrum TCP application for `db.example.com` on port 5432 with the `duragres-tls` Worker as its origin. Leave Edge TLS Termination off, because the Worker negotiates TLS after the SSLRequest.

Point Spectrum only at `duragres-tls`. The `duragres` Worker accepts plaintext and rate-limits only connections that carry a client address.

Renew the certificate before it expires, every 90 days for Let's Encrypt, and put the new files with the same two commands.

Clients then connect with `postgres://demo:<password>@db.example.com:5432/mydb?sslmode=verify-full`.

To run TLS locally, put a certificate for `localhost` in `tls/.dev.vars` as `TLS_CERT="…"` and `TLS_KEY="…"` (PEM, with `\n` for line breaks). Run `bun run dev` and `bun run dev:tls`, then connect to port 8789. Locally, `duragres-tls` dials `duragres` on port 8788, because wrangler cannot run a TCP service binding between two dev processes.

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

## Alchemy

`alchemy/` (`@duragres/alchemy`) provides an Alchemy v2 resource for provisioning and branching Duragres databases, plus a standalone Postgres client (`@duragres/alchemy/client`) with no Alchemy or Effect dependency:

```ts
import * as Alchemy from "alchemy";
import * as Duragres from "@duragres/alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "MyApp",
  { providers: Duragres.providers({ host: "db.example.com" }), state: Alchemy.localState() },
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

## Layout

- `src/gateway.ts` reads the StartupMessage, picks the Durable Object by database name and pipes bytes to it.
- `src/database/` is the Durable Object: authentication, create-on-connect, expiry, claiming and branching.
- `src/engine/postgres.ts` boots PGlite on `src/engine/page-fs.ts`, which stores Postgres's data directory as 8 KiB pages in SQLite. It makes each message's writes durable before the reply goes out.
- `src/engine/pool.ts` shares the backend between connections.
- `src/postgres/` reads and writes the few protocol messages Duragres handles itself.
- `tls/` is the `duragres-tls` Worker: `src/index.ts` negotiates TLS, and `main.go` implements it with Go's `crypto/tls`.
- `alchemy/` is `@duragres/alchemy`: the plain Postgres client and the Alchemy v2 `Duragres.Database` resource and `Duragres.Connect` binding.
