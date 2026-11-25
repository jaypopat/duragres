// Compiles tls/main.go to tls/runtime/tls.wasm and copies Go's wasm_exec.js beside it. Needs Go.
import { $ } from "bun";

const dir = import.meta.dir;
await $`mkdir -p ${dir}/runtime`;
await $`cd ${dir} && GOOS=js GOARCH=wasm go build -trimpath -ldflags=-s\ -w -o runtime/tls.wasm .`;
const goroot = (await $`go env GOROOT`.text()).trim();
await $`cp ${goroot}/lib/wasm/wasm_exec.js ${dir}/runtime/wasm_exec.js`;
