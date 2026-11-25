// PostgreSQL (our PGlite build, see engine/) running in this Durable Object, with its data directory in
// the object's SQLite storage. One backend; src/engine/pool.ts shares it between client connections.
import { PGlite } from "@electric-sql/pglite";
import { exportChunks, PageFs } from "./page-fs";
import type { Chunk } from "./page-fs";
import { walInsertEnd } from "./wal";
import pgliteWasmModule from "../../engine/runtime/pglite.wasm";
import callback1 from "../../engine/runtime/callback-1.wasm";
import callback2 from "../../engine/runtime/callback-2.wasm";
import dictSnowball from "../../engine/runtime/dict_snowball.wasm";
import plpgsql from "../../engine/runtime/plpgsql.wasm";
import fsBundle from "../../engine/runtime/pglite-fs.bin";
import seed from "../../engine/runtime/seed.bin";

const MIB = 2 ** 20;
const INITIAL_MEMORY = 64 * MIB; // the build's minimum (engine/patches)
const MAX_MEMORY = 100 * MIB; // past this Postgres raises 53200 instead of the isolate exceeding 128 MB
const WAL_SEGMENT_BYTES = 1n * BigInt(MIB); // engine/prepare.ts runs initdb with --wal-segsize=1
const CONF = [
  "shared_buffers=8MB", "work_mem=2MB", "maintenance_work_mem=8MB", "temp_buffers=1MB",
  "wal_buffers=256kB", "min_wal_size=4MB", "max_wal_size=32MB",
];
// PGlite's start parameters, except search_path: PGlite sets "public", Postgres's default is '"$user", public'.
const START_PARAMS = PGlite.defaultStartParams.map((p) => (p === "search_path=public" ? 'search_path="$user", public' : p));

type Callback = (...args: Array<number>) => number;
const isCallback = (value: unknown): value is Callback => typeof value === "function";

/** The engine exports our patches add (engine/patches/postgres-pglite/0002), checked at boot. */
interface Wal {
  _GetXLogInsertRecPtr(): bigint;
  _XLogFlush(upto: bigint): void;
}
type Module = PGlite["Module"];
const isWal = (module: Module): module is Module & Wal =>
  "_GetXLogInsertRecPtr" in module && typeof module._GetXLogInsertRecPtr === "function" && "_XLogFlush" in module && typeof module._XLogFlush === "function";
function walExports(module: Module): Wal {
  if (isWal(module)) return module;
  throw new Error("this PGlite build does not export GetXLogInsertRecPtr and XLogFlush; build engine/ (bun run engine:build)");
}

// Emscripten compiles tiny Wasm adapters at runtime to call JS callbacks, which Workers forbids.
// PGlite registers four, all i32 functions of one or two arguments, so instantiate precompiled ones.
const ADAPTERS = new Map([["pi", callback1], ["ppp", callback2], ["ipi", callback2], ["ppi", callback2]]);
function precompiledCallbacks(mod: { addFunction(fn: Callback, sig: string): number }) {
  const add = mod.addFunction.bind(mod);
  mod.addFunction = (fn, sig) => {
    const adapter = ADAPTERS.get(sig);
    if (!adapter) throw new Error(`no precompiled callback adapter for signature "${sig}"`);
    const wrapped = new WebAssembly.Instance(adapter, { e: { f: fn } }).exports.f;
    if (!isCallback(wrapped)) throw new Error(`callback adapter for "${sig}" exports no function`);
    return add(wrapped, sig);
  };
}

// Postgres dlopen()s these from $libdir, and Emscripten compiles the bytes it reads there, which Workers
// forbid. Our build exposes the dynamic linker (engine/patches/postgres-pglite/0003), so register each
// library as a lazy entry in its preloaded table: the first dlopen() links the module wrangler precompiled.
// Nothing dlopen()s during boot, so registering after PGlite.create() is early enough.
const LIBRARIES = new Map([["/pglite/lib/postgresql/plpgsql.so", plpgsql], ["/pglite/lib/postgresql/dict_snowball.so", dictSnowball]]);
/** A linked side module's exports. Only Emscripten reads them; we hand them back unopened. */
interface LinkedLibrary { readonly linked: unique symbol }
interface Linker {
  preloadedWasm: object;
  loadWebAssemblyModule(binary: WebAssembly.Module, flags: { loadAsync: false; nodelete: true }, libName: string, localScope: Record<string, never>): LinkedLibrary;
}
const isLinker = (mod: Module): mod is Module & Linker =>
  "preloadedWasm" in mod && typeof mod.preloadedWasm === "object" && mod.preloadedWasm !== null && "loadWebAssemblyModule" in mod && typeof mod.loadWebAssemblyModule === "function";
function precompiledLibraries(mod: Module) {
  if (!isLinker(mod)) throw new Error("this PGlite build does not expose its dynamic linker; build engine/ (bun run engine:build)");
  for (const [path, module] of LIBRARIES) {
    let linked: LinkedLibrary | undefined;
    Object.defineProperty(mod.preloadedWasm, path, {
      configurable: true,
      enumerable: true,
      get: () => (linked ??= mod.loadWebAssemblyModule(module, { loadAsync: false, nodelete: true }, path, {})),
    });
  }
}

/** Thrown when the engine itself failed: its memory state is gone and the object must restart. */
export class EngineFailure extends Error {}

export class Postgres {
  private constructor(
    private db: PGlite,
    private wal: Wal,
    readonly fs: PageFs,
    private storage: DurableObjectStorage,
    /** ParameterStatus messages from the backend's own startup, replayed to every client. */
    readonly parameterStatus: Array<Uint8Array>,
  ) {}

  /**
   * Boots Postgres into the database `name`. A new object is seeded from the empty cluster in
   * engine/runtime/seed.bin; a seeded or copied data directory whose database has another name
   * (the seed's "postgres", or a branch's source) is renamed first.
   */
  static async open(storage: DurableObjectStorage, name: string): Promise<Postgres> {
    let fs = pageFs(storage);
    if (fs.fresh || fs.database !== name) {
      const setup = await boot(fs, "template1", fs.fresh);
      if (fs.fresh) fs.markInitialized("postgres");
      const current = fs.database ?? "postgres";
      if (current !== name) await setup.exec(`ALTER DATABASE ${quoteIdent(current)} RENAME TO ${quoteIdent(name)}`);
      await setup.close();
      fs.flush(name); // the renamed catalog and the name it now holds commit together
      await storage.sync();
      fs = pageFs(storage);
    }
    const db = await boot(fs, name, false);
    const segment = (await db.query<{ wal_segment_size: string }>("SHOW wal_segment_size")).rows[0]?.wal_segment_size;
    if (segment !== "1MB") throw new Error(`WAL segment size is ${segment}, expected 1MB`);
    const startup = await db.execProtocolRaw(startupMessage({ user: "postgres", database: name }), { syncToFs: false });
    const pg = new Postgres(db, walExports(db.Module), fs, storage, [...messages(startup)].flatMap((m) => (m[0] === 0x53 ? [m.slice()] : [])));
    await pg.persist();
    return pg;
  }

  /** Runs one client protocol message. Its effects are durable before the reply is returned. */
  async run(message: Uint8Array): Promise<Uint8Array> {
    let reply: Uint8Array;
    try {
      reply = await this.db.execProtocolRaw(message, { syncToFs: false });
    } catch (error) {
      throw new EngineFailure(`engine failure: ${String(error)}`, { cause: error });
    }
    await this.persist();
    return reply;
  }

  /** SQL the server runs for itself, between client transactions. A SQL error is thrown as is. */
  async exec(sql: string) {
    await this.db.exec(sql);
    await this.persist();
  }

  /** Stops Postgres (a shutdown checkpoint) before the object deletes its storage. */
  async close() {
    await this.db.close();
  }

  async query<T>(sql: string, params: Array<unknown> = []): Promise<Array<T>> {
    const { rows } = await this.db.query<T>(sql, params);
    await this.persist();
    return rows;
  }

  /** The data directory as RPC-sized chunks. The caller holds the backend so nothing writes meanwhile. */
  async *chunks(): AsyncGenerator<Chunk> {
    await this.exec("CHECKPOINT");
    yield* exportChunks(this.storage.sql);
  }

  /**
   * Makes everything Postgres wrote durable: WAL through the last record (a client may have SET
   * synchronous_commit = off), then the buffered pages. A failure here leaves committed state only in
   * the engine's memory, so it is an engine failure: the object restarts and recovers from storage.
   */
  private async persist() {
    try {
      this.wal._XLogFlush(walInsertEnd(this.wal._GetXLogInsertRecPtr(), WAL_SEGMENT_BYTES));
      this.fs.flush();
      await this.storage.sync();
    } catch (error) {
      throw new EngineFailure(`engine failure while persisting: ${String(error)}`, { cause: error });
    }
  }
}

function pageFs(storage: DurableObjectStorage) {
  const fs = new PageFs(storage);
  const init = fs.init.bind(fs);
  fs.init = async (pg, opts) => {
    const result = await init(pg, opts);
    result.emscriptenOpts.preRun = [...(result.emscriptenOpts.preRun ?? []), precompiledCallbacks];
    return result;
  };
  return fs;
}

async function boot(fs: PageFs, database: string, seedIt: boolean) {
  const db = await PGlite.create({
    pgliteWasmModule,
    fsBundle: new Blob([fsBundle]),
    loadDataDir: seedIt ? new Blob([seed]) : undefined,
    fs,
    database,
    initialMemory: INITIAL_MEMORY,
    maxMemory: MAX_MEMORY,
    postgresqlconf: CONF,
    startParams: START_PARAMS,
  });
  precompiledLibraries(db.Module); // after create(): the linker is exposed once the module has loaded
  return db;
}

export const quoteIdent = (s: string) => `"${s.replaceAll('"', '""')}"`;

/** Backend messages in a reply (type byte, int32 length, body). */
export function* messages(bytes: Uint8Array): Generator<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i + 5 <= bytes.length;) {
    const end = i + 1 + view.getInt32(i + 1);
    yield bytes.subarray(i, end);
    i = end;
  }
}

function startupMessage(params: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const pairs = Object.entries(params).flatMap(([k, v]) => [...enc.encode(`${k}\0${v}\0`)]);
  const out = new Uint8Array(8 + pairs.length + 1);
  const view = new DataView(out.buffer);
  view.setInt32(0, out.length);
  view.setInt32(4, 196_608); // protocol 3.0
  out.set(pairs, 8);
  return out;
}
