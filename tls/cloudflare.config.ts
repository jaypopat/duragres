import { bindings, defineConfig, defineWorker, triggers } from "@cloudflare/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// The TLS front for Duragres (README: "TLS"). Spectrum's TCP application points at this Worker, which
// reaches the duragres Worker over a service binding. Locally (`--env local`) there is no cross-process
// service binding for TCP, so it dials the duragres Worker's local port instead.
const worker = defineWorker(({ mode }) => {
  const local = mode === "local";
  return {
    name: "duragres-tls",
    compatibilityDate: "2026-11-19",
    entrypoint,
    triggers: [triggers.connect({ protocol: "tcp", port: 8789, address: "localhost" })],
    env: {
      DURAGRES: bindings.worker({ worker: "duragres" }),
      LOCAL_UPSTREAM: local ? bindings.text("localhost:8788") : null,
      CONNECT_LIMIT: bindings.rateLimit({ namespace: "1002", simple: { limit: 60, period: 60 } }),
      TLS_CERT: bindings.secret(), // PEM certificate chain for the public hostname
      TLS_KEY: bindings.secret(), // its PEM private key
    },
  };
});

export default defineConfig({ worker });
