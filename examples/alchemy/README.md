# Duragres + Alchemy v2 example

Provisions a claimed seed database and a per-stage preview branch on Duragres using [`@duragres/alchemy`](../../alchemy).

## Run locally

1. Start Duragres in the repo root:

   ```sh
   bun run dev
   ```

2. Deploy and tear down a preview stage from this directory:

   ```sh
   bun run deploy --stage pr-123
   bun run destroy --stage pr-123
   ```

To target a deployed Duragres host over TLS instead of localhost, set `DURAGRES_HOST=db.example.com` (and optionally `DURAGRES_PORT` / `DURAGRES_SSLMODE`).

## Wiring into Cloudflare Hyperdrive or a Worker

`db.origin` has the same shape as `Cloudflare.Hyperdrive.PublicOrigin` and `Neon.PostgresOrigin`:

```ts
const hd = yield* Cloudflare.Hyperdrive.Connection("PreviewHyperdrive", {
  origin: preview.origin,
});
```

Or bind the connection URI directly into an Alchemy Worker/Function with `Duragres.Connect`:

```ts
const conn = yield* Duragres.Connect(preview);
// inside fetch (with Duragres.ConnectHttp provided on the Worker Effect):
const url = yield* conn.connectionString;
```
