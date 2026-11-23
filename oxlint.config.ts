import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [cloudflare],
  env: cloudflare.env,
  // Turned off for the migration; each is re-enabled with its fixes or a reason.
  rules: {
    "@nkzw/no-instanceof": "off",
    "curly": "off",
    "typescript/await-thenable": "off",
    "unicorn/text-encoding-identifier-case": "off",
  },
  overrides: [
    // The example prints what it does.
    { files: ["examples/**"], rules: { "no-console": "off" } },
    // @cloudflare/config takes the Worker entrypoint as a module namespace (with { type: "cf-worker" }).
    { files: ["cloudflare.config.ts"], rules: { "import/no-namespace": "off" } },
  ],
  ignorePatterns: [...cloudflare.ignorePatterns, ".agents/**", ".claude/**", ".cloudflare/**", ".wrangler/**"],
});
