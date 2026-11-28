# @duragres/alchemy

[Alchemy v2](https://alchemy.run) provider and standalone Postgres client for [Duragres](https://github.com/jaypopat/duragres) (PostgreSQL 19 on Cloudflare Durable Objects).

## Install

```sh
bun add @duragres/alchemy
```

## Alchemy v2 stack

```ts
import * as Duragres from "@duragres/alchemy";
import * as Alchemy from "alchemy";
import { Effect } from "effect";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Duragres.providers({ host: "duragres.jaypopat.me" }),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const seed = yield* Duragres.Database("SeedDatabase", { name: "my-seed" });
    const preview = yield* Duragres.Database("PreviewDatabase", {
      name: `preview-${stage}`,
      template: seed.origin,
    });
    // preview.origin matches Cloudflare.Hyperdrive.PublicOrigin and Neon.PostgresOrigin
    return { origin: preview.origin, connectionUri: preview.connectionUri };
  }),
);
```

- Omit `password` to generate and persist a random password in Alchemy state (claiming and protecting the database).
- On `destroy`, branched databases are dropped immediately via `DROP DATABASE ... WITH (FORCE)` from their template; standalone databases clear their passwords so they expire on TTL.
- Bind `connectionUri` into Workers/Functions with `Duragres.Connect(db)` and `Duragres.ConnectHttp`, or reference an existing resource with `Duragres.Database.ref("PreviewDatabase")`.

## Standalone client (no Alchemy or Effect)

```ts
import { connectionString, dropDatabase, ensureDatabase } from "@duragres/alchemy/client";

const server = { host: "duragres.jaypopat.me" };
const owner = { user: "demo", password: "secret" };

await ensureDatabase(server, { name: "my-seed", owner });
const url = connectionString(server, "my-seed", owner);
await dropDatabase(server, { name: "my-seed", owner });
```
