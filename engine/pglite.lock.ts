// What engine/build.ts builds: upstream PGlite at these commits, plus engine/patches/, in this builder image.
export const lock = {
  repo: "https://github.com/electric-sql/pglite.git",
  tag: "@electric-sql/pglite@0.6.0",
  commit: "9ac4fff690f0d0af9dee942f692e79047731d83f",
  postgresPgliteCommit: "5ff171ef79498935854ddbdcfe9cb40456e309dd",
  builderImage: "electricsql/pglite-builder:6.0.13-3",
  builderImageDigest: "sha256:2b075d6b563fd15a913afed7948065d33c5e3b18e5922448f498d1f7664a7c36",
  version: "0.6.0-duragres.2",
  /** SHA-256 of engine/dist/electric-sql-pglite-<version>.tgz; `bun engine/build.ts --check` compares it. */
  sha256: "c97a9d8c02b23be6adcefe4867aed3b048c519a15d12a5e9f2abaa54ecaf2b71",
} as const;
