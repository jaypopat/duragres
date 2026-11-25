import { bindings, defineConfig, defineWorker, exports, triggers } from "@cloudflare/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// The static half of the Worker. The PG binding points at it, which types env.PG as PgDO's namespace.
const duragres = {
  name: "duragres",
  compatibilityDate: "2026-11-19",
  entrypoint,
  exports: {
    PgDO: exports.durableObject({ storage: "sqlite" }),
  },
};

// `wrangler dev --env test` evaluates this with mode "test": short limits and a separate port.
const worker = defineWorker(({ mode }) => {
  const test = mode === "test";
  return {
    ...duragres,
    // Locally this is a raw TCP listener; in production Spectrum (tcp/5432) delivers to the same handler.
    // "localhost" makes workerd listen on both ::1 and 127.0.0.1, so psql never sees "Connection refused".
    triggers: [triggers.connect({ protocol: "tcp", port: test ? 8798 : 8788, address: "localhost" })],
    env: {
      PG: bindings.durableObject({ worker: duragres, exportName: "PgDO" }),
      // New connections per client IP, and new databases per source database, per minute.
      CONNECT_LIMIT: bindings.rateLimit({ namespace: "1001", simple: { limit: test ? 30 : 60, period: 60 } }),
      LIMITS: bindings.json({
        ttlSeconds: test ? 30 : 72 * 3600, // unclaimed databases are deleted this long after creation
        idleSeconds: test ? 6 : 600, // idle connections are closed (57P05)
        maxConnections: test ? 3 : 10, // per database (53300)
      }),
    },
  };
});

export default defineConfig({ worker });
