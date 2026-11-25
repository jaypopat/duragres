// Go's wasm_exec.js (copied into runtime/ by tls/build.ts) defines this global.
declare class Go {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
declare module "../runtime/wasm_exec.js";

interface TlsSession {
  cipher(bytes: Uint8Array | null): void;
  plain(bytes: Uint8Array | null): void;
  release(): void;
}
/** Registered by tls/main.go when its main() runs; see the contract there. Returns null for a bad certificate. */
// oxlint-disable-next-line no-var -- only a var declaration types a property of globalThis, which is where Go puts it
declare var duragresTlsAccept: ((certPem: string, keyPem: string, direct: boolean, sendCipher: (b: Uint8Array) => void, receivePlain: (b: Uint8Array | null) => void, done: (error: string | null) => void) => TlsSession | null) | undefined;
