// Makes engine/runtime/, the files the Worker imports, from the installed @electric-sql/pglite
// (our build, engine/dist/*.tgz). Runs before dev, test and deploy; skips work that is up to date.
//
//   pglite.wasm      Postgres (compiled Wasm module import)
//   pglite-fs.bin    PGlite's filesystem bundle: share/ and lib/ (Data import)
//   seed.bin         an empty cluster, checkpointed at shutdown, with 1 MiB WAL segments (Data import)
//   callback-N.wasm  the adapters Emscripten would compile at runtime, which Workers forbids
import { PGlite } from "@electric-sql/pglite";
import { EmscriptenBuiltinFilesystem } from "@electric-sql/pglite/basefs";
import { createHash } from "node:crypto";

const runtime = `${import.meta.dir}/runtime`;
const pkg = `${import.meta.dir}/../node_modules/@electric-sql/pglite`;
const version = /"version":\s*"([^"]+)"/.exec(await Bun.file(`${pkg}/package.json`).text())?.[1] ?? "unknown";
if (!version.includes("duragres")) throw new Error(`@electric-sql/pglite is ${version}; install engine/dist's build (bun install)`);

const stamp = createHash("sha256").update(version).update(await Bun.file(import.meta.path).text()).digest("hex");
if ((await Bun.file(`${runtime}/stamp`).exists()) && (await Bun.file(`${runtime}/stamp`).text()) === stamp) process.exit(0);

await Bun.write(`${runtime}/pglite.wasm`, Bun.file(`${pkg}/dist/pglite.wasm`));
await Bun.write(`${runtime}/pglite-fs.bin`, Bun.file(`${pkg}/dist/pglite.data`));

// Modules importing e.f, a function of `argc` i32 arguments returning i32, and exporting it as f.
for (const argc of [1, 2]) {
  const type = [0x60, argc, ...Array<number>(argc).fill(0x7f), 1, 0x7f];
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    1, type.length + 1, 1, ...type, // type section: one function type
    2, 7, 1, 1, 0x65, 1, 0x66, 0, 0, // import "e" "f", function of type 0
    7, 5, 1, 1, 0x66, 0, 0, // export "f", function 0
  ]);
  if (!WebAssembly.validate(bytes)) throw new Error(`callback-${argc}.wasm is invalid`);
  await Bun.write(`${runtime}/callback-${argc}.wasm`, bytes);
}

// The empty cluster, dumped after Postgres's shutdown checkpoint so it boots without recovery.
const fs = new EmscriptenBuiltinFilesystem();
fs.closeFs = async () => {
  await Bun.write(`${runtime}/seed.bin`, await fs.dumpTar("pgdata", "gzip"));
};
const db = await PGlite.create({ fs, initDbStartParams: ["--wal-segsize=1"] });
await db.close();

await Bun.write(`${runtime}/stamp`, stamp);
console.log(`engine/runtime ready for @electric-sql/pglite ${version}`);
