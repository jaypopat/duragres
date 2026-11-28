# Duragres + Alchemy v2 example

Provisions a claimed seed database and a per-stage preview branch on Duragres using [`@duragres/alchemy`](../../alchemy).

## Run against the hosted endpoint

```sh
DURAGRES_HOST=duragres.jaypopat.me bun run deploy --stage pr-123
DURAGRES_HOST=duragres.jaypopat.me bun run destroy --stage pr-123
```

To target your own Duragres deployment, swap `DURAGRES_HOST` (and optionally set `DURAGRES_PORT` / `DURAGRES_SSLMODE`). Without `DURAGRES_HOST`, the example defaults to `127.0.0.1:8788` (`sslmode=disable`).

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
