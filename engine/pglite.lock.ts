// What engine/build.ts builds: upstream PGlite at these commits, plus engine/patches/, in this builder image.
export const lock = {
  repo: "https://github.com/electric-sql/pglite.git",
  tag: "@electric-sql/pglite@0.6.0",
  commit: "9ac4fff690f0d0af9dee942f692e79047731d83f",
  postgresPgliteCommit: "5ff171ef79498935854ddbdcfe9cb40456e309dd",
  builderImage: "electricsql/pglite-builder:6.0.13-3",
  builderImageDigest: "sha256:2b075d6b563fd15a913afed7948065d33c5e3b18e5922448f498d1f7664a7c36",
  version: "0.6.0-duragres.1",
  /** SHA-256 of engine/dist/electric-sql-pglite-<version>.tgz; `bun engine/build.ts --check` compares it. */
  sha256: "d6de4bcc829543b4aaba716d535ce1b48282020150f6a63bb0d88686f17a9e82",
} as const;
