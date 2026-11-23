# Duragres

Connect a PostgreSQL client to a SQLite-backed Cloudflare Durable Object. The database name selects the object. An unclaimed database expires after 72 hours. A local R2 bucket holds a temporary snapshot while creating an independent fork.

## Local development

Install with `bun install --frozen-lockfile`, then start the Worker with `bun run dev`.

```sh
export DATABASE_URL='postgres://demo@localhost:8788/mydb?sslmode=disable'
psql "$DATABASE_URL"
```

In `examples/drizzle`, run `bun run migrate` and `bun run demo` using that URL. The example inserts a user and prints the returned ID and name. To fork, configure `FORK_TOKEN` in the Worker's local `.dev.vars`, export the same token in the client shell, and run `bun run demo:fork` from the project root.

Run `bun run typecheck` and `bun run verify`. Verification starts local Workers on ports 8787/8788 and 8797/8798 and uses Docker for psql 18. Stop any dev server on those ports first.

## Implementation

- `src/postgres/` handles startup, routing, sessions and wire messages.
- `src/sql/` translates supported PostgreSQL queries, records column types, and answers the catalog queries used by psql.
- `src/database/` owns SQLite storage, expiry, creation limits and snapshot import/export.
- `src/fork.ts` handles authenticated fork requests. Each fork has its own name, storage and expiry.

### Polyglot generator

Duragres pins the SDK and builds its SQLite generator from Polyglot v0.14.3. The Rust source changes are in `vendor/polyglot/generator.patch`. They emit SQLite serial primary keys, UUIDv4 expressions and supported timestamp interval arithmetic directly. This build also emits Duragres's millisecond timestamp default. Schema-name mapping belongs to the Worker.

The prepared WASM module is included in `vendor/polyglot/`. To rebuild it, install the Rust toolchain and wasm-bindgen CLI versions listed in `vendor/polyglot/rebuild.sh`, then run that script. On an SDK upgrade, rebase the patch and run `bun run verify` to check both generated SQL and the Worker.

## Local prototype limits

Connections use plaintext and trust authentication. SQL translation and catalog introspection cover a subset of PostgreSQL. Extended-protocol Describe can execute a statement before Execute. Interactive transactions replay writes at commit, so generated values can differ from the values returned earlier. Forks materialize the snapshot in memory and accept serialized snapshots up to 1 MiB.
