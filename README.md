# Duragres

Connect any PostgreSQL client to a Cloudflare Durable Object. The database name in the connection string picks the object, and connecting to a new name creates it. Each database is stored in that object's SQLite storage. An unclaimed database deletes itself after 72 hours.

## Local development

```sh
bun install --frozen-lockfile
bun run dev
psql 'postgres://demo@localhost:8788/mydb?sslmode=disable'
```

`bin/psql` runs psql 18 from Docker if you don't have it installed.

To try Drizzle, export that URL as `DATABASE_URL`, then run `bun run migrate` and `bun run demo` in `examples/drizzle`. To fork a database, set `FORK_TOKEN` in `.dev.vars`, export the same value in your shell, and run `bun run demo:fork`. It prints the fork's connection URL.

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
- `src/database/` is the Durable Object: connections, create-on-connect, expiry and snapshots.
- `src/postgres/` encodes and decodes wire-protocol messages.
- `src/sql/` translates PostgreSQL to SQLite with Polyglot and answers the catalog queries psql and ORMs send.
- `src/fork.ts` handles `POST /forks?source=<name>`, which copies a database through an R2 snapshot.

## Prototype limits

Connections are plaintext with trust authentication. SQL translation and catalog introspection cover a subset of PostgreSQL. Extended-protocol Describe runs the statement before Execute. Interactive transactions replay their writes at COMMIT, so generated values can differ from the ones returned earlier. Forks accept snapshots up to 1 MiB.
