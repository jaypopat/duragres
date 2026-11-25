import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [cloudflare],
  env: cloudflare.env,
  rules: {
    // One realm (workerd), and the checks are on runtime classes: ArrayBuffer values from SQLite, Date, our own Error subclass.
    "@nkzw/no-instanceof": "off",
    // The codebase writes guards as one-line `if (...) return ...;`; braces would add 180 lines and no safety.
    "curly": "off",
    // "UTF8" is PostgreSQL's spelling of the encoding that clients read in ParameterStatus and SHOW.
    "unicorn/text-encoding-identifier-case": "off",
  },
  overrides: [
    // The example, the demo recorder and the engine build scripts print what they do.
    { files: ["examples/**", "demo/**", "engine/**"], rules: { "no-console": "off" } },
    // @cloudflare/config takes the Worker entrypoint as a module namespace (with { type: "cf-worker" }).
    // bun-types declares expect(...).rejects matchers as returning void; they return a promise that must be awaited.
    { files: ["test/**", "alchemy/test/**", "examples/drizzle/test/**"], rules: { "typescript/await-thenable": "off" } },
    { files: ["cloudflare.config.ts"], rules: { "import/no-namespace": "off" } },
  ],
  ignorePatterns: [...cloudflare.ignorePatterns, ".agents/**", ".claude/**", ".cloudflare/**", ".wrangler/**"],
});
