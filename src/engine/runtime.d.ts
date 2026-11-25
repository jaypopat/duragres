// engine/runtime/ files, imported with wrangler's default module rules: .wasm as a compiled module, .bin as data.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
declare module "*.bin" {
  const data: ArrayBuffer;
  export default data;
}
