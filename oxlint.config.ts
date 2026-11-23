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
    "no-promise-executor-return": "off",
    "import/no-namespace": "off",
    "quality/no-array-filter-map": "off",
    "quality/no-known-value-widening": "off",
    "quality/no-object-parameters": "off",
    "quality/no-unknown-returns": "off",
    "quality/no-unsafe-dictionary-type": "off",
    "typescript/await-thenable": "off",
    "typescript/no-non-null-assertion": "off",
    "typescript/no-unnecessary-type-assertion": "off",
    "typescript/no-unsafe-argument": "off",
    "typescript/no-unsafe-assignment": "off",
    "typescript/no-unsafe-call": "off",
    "typescript/no-unsafe-member-access": "off",
    "typescript/no-unsafe-type-assertion": "off",
    "unicorn/catch-error-name": "off",
    "unicorn/consistent-function-scoping": "off",
    "unicorn/text-encoding-identifier-case": "off",
  },
  // The preset's TypeScript override turns this back on, so it is disabled after it.
  overrides: [{ files: ["**/*.ts"], rules: { "typescript/only-throw-error": "off" } }],
  ignorePatterns: [...cloudflare.ignorePatterns, ".agents/**", ".claude/**", ".cloudflare/**", ".wrangler/**"],
});
