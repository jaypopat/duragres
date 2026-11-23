import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [cloudflare],
  env: cloudflare.env,
  // Turned off for the migration; each is re-enabled with its fixes or a reason.
  rules: {
    "@nkzw/no-instanceof": "off",
    "curly": "off",
    "no-console": "off",
    "import/no-namespace": "off",
    "quality/no-array-filter-map": "off",
    "quality/no-object-parameters": "off",
    "quality/no-unknown-returns": "off",
    "quality/no-unsafe-dictionary-type": "off",
    "typescript/await-thenable": "off",
    "unicorn/catch-error-name": "off",
    "unicorn/text-encoding-identifier-case": "off",
  },
  ignorePatterns: [...cloudflare.ignorePatterns, ".agents/**", ".claude/**", ".cloudflare/**", ".wrangler/**"],
});
