// Builds Duragres's PGlite: upstream PGlite at the commits in pglite.lock.ts plus engine/patches/,
// compiled in PGlite's own builder image, packed as an npm tarball in engine/dist/.
//
//   bun engine/build.ts            build, verify, and print the tarball's SHA-256
//   bun engine/build.ts --check    also fail if the SHA-256 differs from pglite.lock.ts
//
// Builds in $ENGINE_BUILD_DIR (default: $TMPDIR/duragres-engine) and reuses the compiled Wasm there
// while pglite.lock.ts and engine/patches/ are unchanged.
//
// Needs Docker, git and network. Takes a while: the first run compiles Postgres and its extensions.
import { $ } from "bun";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { lock } from "./pglite.lock";

const engine = import.meta.dir;
// Outside the repo: TypeScript reads node_modules/@types in every parent directory, and ours
// (bun-types, a newer @types/node) break PGlite's declaration build. ENGINE_BUILD_DIR overrides it.
const build = process.env.ENGINE_BUILD_DIR ?? `${tmpdir()}/duragres-engine`;
const src = `${build}/pglite`;
const pg = `${src}/postgres-pglite`;
const pkg = `${src}/packages/pglite`;
const version = lock.version;

$.throws(true);

// The Wasm depends only on the lock and the patches; reuse a compiled tree for the same inputs.
const key = createHash("sha256").update(JSON.stringify(lock));
for (const patch of [...new Bun.Glob("*/*.patch").scanSync(`${engine}/patches`)].sort()) {
  key.update(patch).update(await Bun.file(`${engine}/patches/${patch}`).text());
}
const inputs = key.digest("hex");
const compiled = (await Bun.file(`${build}/inputs`).exists()) && (await Bun.file(`${build}/inputs`).text()) === inputs;

if (!compiled) {
// 1. Sources at the pinned commits.
await $`rm -rf ${src} ${build}/inputs`;
await $`git clone --quiet --filter=blob:none --no-checkout ${lock.repo} ${src}`;
await $`git -C ${src} checkout --quiet ${lock.commit}`;
// --recursive: the extensions under postgres-pglite/pglite/other_extensions are submodules too, pinned there.
await $`git -C ${src} submodule update --quiet --init --recursive --filter=blob:none postgres-pglite`;
const sub = (await $`git -C ${pg} rev-parse HEAD`.text()).trim();
if (sub !== lock.postgresPgliteCommit) throw new Error(`postgres-pglite is at ${sub}, expected ${lock.postgresPgliteCommit}`);

// 2. Our patches.
for (const [dir, repo] of [["postgres-pglite", pg], ["pglite", src]] as const) {
  for (const patch of new Bun.Glob("*.patch").scanSync(`${engine}/patches/${dir}`)) {
    await $`git -C ${repo} apply ${engine}/patches/${dir}/${patch}`;
    console.log(`applied ${dir}/${patch}`);
  }
}

// 3. The Wasm, in PGlite's builder image (build-with-docker.sh mounts the checkout).
{
  const digest = (await $`docker image inspect ${lock.builderImage} --format ${"{{index .RepoDigests 0}}"}`.text()).trim();
  if (!digest.endsWith(lock.builderImageDigest)) throw new Error(`builder image is ${digest}, expected ${lock.builderImageDigest}`);
}
try {
  await $`cd ${pg} && PGLITE_VERSION=${version} bash ./build-with-docker.sh`; // the script has no shebang
} finally {
  // The container writes as root; hand the tree back to this user, even after a failed build.
  await $`docker run --rm -v ${src}:/src ${lock.builderImage} chown -R ${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0} /src`;
}
await Bun.write(`${build}/inputs`, inputs);
} else {
  console.log(`reusing the compiled Wasm in ${build} (same lock and patches)`);
}

// 4. The TypeScript package around it, with the release files copied in as upstream's scripts do.
await $`cd ${src} && bunx pnpm@9.7.0 install --frozen-lockfile --silent`;
await $`mkdir -p ${pkg}/release && cp ${pg}/dist/bin/pglite.* ${pg}/dist/bin/initdb.* ${pkg}/release/ && cp ${pg}/dist/extensions/*.tar.gz ${pkg}/release/`;
await $`cd ${src} && bunx pnpm@9.7.0 --filter @electric-sql/pg-protocol --filter @electric-sql/pglite-utils --filter @electric-sql/pglite build`;
const manifest = await Bun.file(`${pkg}/package.json`).text();
const versioned = manifest.replace(/"version": "[^"]+"/, `"version": "${version}"`);
if (versioned === manifest) throw new Error("packages/pglite/package.json has no version field");
await Bun.write(`${pkg}/package.json`, versioned);

// 5. Verify what the patches are for, on the built artifacts.
const wasm = new WebAssembly.Module(await Bun.file(`${pkg}/release/pglite.wasm`).arrayBuffer());
const exports = new Set(WebAssembly.Module.exports(wasm).map((e) => e.name));
for (const name of ["GetXLogInsertRecPtr", "XLogFlush"]) if (!exports.has(name)) throw new Error(`pglite.wasm does not export ${name}`);
const minPages = memoryImportMinimum(new Uint8Array(await Bun.file(`${pkg}/release/pglite.wasm`).arrayBuffer()));
if (minPages !== 1024) throw new Error(`pglite.wasm needs ${minPages} pages initially, expected 1024 (64 MiB)`);
const declarations = await Promise.all([...new Bun.Glob("*.d.ts").scanSync(`${pkg}/dist`)].map((f) => Bun.file(`${pkg}/dist/${f}`).text()));
if (!declarations.some((d) => d.includes("maxMemory?: number"))) throw new Error("built types lack the maxMemory option");
const code = await Promise.all([...new Bun.Glob("*.js").scanSync(`${pkg}/dist`)].map((f) => Bun.file(`${pkg}/dist/${f}`).text()));
if (!code.some((c) => c.includes("maxMemory"))) throw new Error("built code lacks the maxMemory option");

// 6. Pack.
await $`mkdir -p ${engine}/dist`;
await $`cd ${pkg} && npm pack --silent --pack-destination ${engine}/dist`;
const tarball = `${engine}/dist/electric-sql-pglite-${version}.tgz`;
const sha256 = createHash("sha256").update(new Uint8Array(await Bun.file(tarball).arrayBuffer())).digest("hex");
console.log(`\n${tarball}\nsha256 ${sha256}\nsize ${(Bun.file(tarball).size / 2 ** 20).toFixed(1)} MiB`);
if (process.argv.includes("--check") && sha256 !== lock.sha256) throw new Error(`tarball sha256 ${sha256} differs from pglite.lock.ts`);

/** The declared minimum, in pages, of the env.memory import. */
function memoryImportMinimum(bytes: Uint8Array): number {
  let p = 8;
  const uleb = () => {
    let r = 0, s = 0, b;
    do { b = bytes[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80);
    return r >>> 0;
  };
  const name = () => { const n = uleb(); const t = new TextDecoder().decode(bytes.subarray(p, p + n)); p += n; return t; };
  while (p < bytes.length) {
    const id = bytes[p++];
    const end = uleb() + p;
    if (id !== 2) { p = end; continue; }
    for (let n = uleb(); n--;) {
      const field = `${name()}.${name()}`;
      const kind = bytes[p++];
      if (kind === 0) uleb();
      else if (kind === 1) { p++; const f = bytes[p++]; uleb(); if (f & 1) uleb(); }
      else if (kind === 3) p += 2;
      else if (kind === 2) {
        const flags = bytes[p++];
        const initial = uleb();
        if (field === "env.memory") return initial;
        if (flags & 1) uleb();
      }
    }
  }
  throw new Error("no env.memory import");
}
