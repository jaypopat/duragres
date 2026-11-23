#!/bin/sh
# Run with Rust 1.99.1, its wasm32-unknown-unknown target, and wasm-bindgen-cli 0.2.108.
set -eu
vendor_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
revision=2bcb55445f83e7d7dfd2ec3bb10018a39fef7150
if [ "$(wasm-bindgen --version)" != 'wasm-bindgen 0.2.108' ]; then
  echo "Install wasm-bindgen-cli 0.2.108 to match Polyglot's Cargo.lock." >&2
  exit 1
fi
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT
git clone --quiet --depth 1 --branch v0.14.3 https://github.com/tobilg/polyglot.git "$build_dir/source"
cd "$build_dir/source"
test "$(git rev-parse HEAD)" = "$revision"
git apply "$vendor_dir/generator.patch"
cargo build --release --locked --target wasm32-unknown-unknown -p polyglot-sql-wasm
wasm-bindgen --target web --out-dir "$build_dir/bindings" \
  target/wasm32-unknown-unknown/release/polyglot_sql_wasm.wasm
cp "$build_dir/bindings/polyglot_sql_wasm_bg.wasm" "$vendor_dir/polyglot_sql.wasm"
