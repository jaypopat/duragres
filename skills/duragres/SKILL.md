---
name: duragres
description: Use Duragres (PostgreSQL 19 on Cloudflare Durable Objects) for disposable databases, copy-on-write-style preview branches, safe migration testing, and Alchemy v2 stacks.
---

# Duragres

Duragres routes every PostgreSQL connection by database name to a Cloudflare Durable Object running PostgreSQL 19 (PGlite) on DO SQLite. Postgres itself is the control plane—no separate REST API or API key is required.

## Core rules

- **Database names:** 3–63 chars, `a-z`, `0-9`, and `-`, starting with a letter or digit (`template0` and `template1` are reserved).
- **Create on connect:** connecting to a new database name creates it immediately with a 72-hour TTL.
- **Claiming & auth:** run `ALTER ROLE demo PASSWORD '...'` to claim a database. Once any login role has a password, the database survives its TTL and every connection authenticates with SCRAM-SHA-256 (`NOLOGIN`, expired `VALID UNTIL`, and non-SCRAM passwords cannot sign in). Roles authenticate access but are not a security boundary inside one database.
- **Branching:** connected to a source database, copy its committed data into a new database and drop it when done:
  ```sql
  CREATE DATABASE "try-migration" TEMPLATE "mydb";
  DROP DATABASE "try-migration" WITH (FORCE);
  ```
  - Neither statement can run inside a transaction.
  - A copy inherits the source's passwords (protected immediately), **but is not claimed**—it still expires after 72 hours unless you set a password on the copy itself.
  - An unprotected database can be dropped from anywhere; a protected database can be dropped **only** from the database it was copied from (which can always drop its copies, even if the copy sets its own password). Any other `DROP DATABASE` fails with `42501`.

## Single-backend pooling limits

Each database has one Postgres backend shared in PgBouncer-style transaction mode:

- **Never hold a transaction on one connection while querying another** (e.g. using `db` instead of `tx`, or running a second `pg.Pool` inside `sql.withTransaction`). A transaction left idle for **5 seconds** while another connection waits is terminated with SQLSTATE `25P03` (30 seconds with nobody waiting).
- Use `SET LOCAL` inside transactions instead of session-level `SET`.
- `COPY ... FROM STDIN` is not supported (`0A000`); use `INSERT` or `COPY ... TO STDOUT`.
- Available extensions: `plpgsql` and Snowball full-text dictionaries only.
- Queries exceeding ~100 MiB fail cleanly with `53200`.

## Safe migration workflow for agents

When testing a schema migration against an existing database:

1. Branch from the source database: `CREATE DATABASE "test-mig-<id>" TEMPLATE "<source>"`.
2. Run the migration and tests against the branch URL.
3. Drop the branch from the source database: `DROP DATABASE "test-mig-<id>" WITH (FORCE)`.

## Alchemy v2 (`@duragres/alchemy`)

```ts
import * as Duragres from "@duragres/alchemy";
import * as Alchemy from "alchemy";
import { Effect } from "effect";

export default Alchemy.Stack(
  "MyApp",
  { providers: Duragres.providers({ host: "db.example.com" }), state: Alchemy.localState() },
  Effect.gen(function* () {
    const db = yield* Duragres.Database("PreviewDatabase", {
      name: stage,
      template: { name: "staging-seed", user: "demo", password: seedPassword },
    });
    // db.origin matches Cloudflare.Hyperdrive.PublicOrigin and Neon.PostgresOrigin
    return { origin: db.origin, connectionUri: db.connectionUri };
  }),
);
```

- Omit `password` to auto-generate and persist a random password in Alchemy state.
- Use `Duragres.Database.ref("PreviewDatabase")` inside Workers (`globalThis.__ALCHEMY_RUNTIME__`).
- Use `Duragres.Connect(db)` with `Duragres.ConnectHttp` to bind `connectionString` into a Worker/Function.
- For non-Alchemy scripts/CI, import `ensureDatabase`, `dropDatabase`, and `connectionString` from `@duragres/alchemy/client`.
