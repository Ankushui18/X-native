#!/usr/bin/env bash
# Build both EXISTING bridge boundaries. No checked-in binaries; Vite copies
# these optional public assets into dist. Run from any working directory.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v cargo >/dev/null || { echo 'Missing Rust toolchain (see rust-toolchain.toml).' >&2; exit 1; }
command -v wasm-bindgen >/dev/null || { echo 'Install: cargo install wasm-bindgen-cli --version 0.2.127 --locked' >&2; exit 1; }
[[ "$(wasm-bindgen --version)" == 'wasm-bindgen 0.2.127' ]] || {
  echo 'wasm-bindgen CLI must match the locked crate: 0.2.127' >&2; exit 1;
}
# Install the target once: rustup target add wasm32-unknown-unknown
cargo build --locked --release --target wasm32-unknown-unknown -p x-wasm -p x-geo
# Respect CARGO_TARGET_DIR, including absolute paths supplied by CI.
target_dir="${CARGO_TARGET_DIR:-target}"
stage=$(mktemp -d "$target_dir/wasm-package.XXXXXX")
trap 'rm -rf "$stage"' EXIT
wasm-bindgen "$target_dir/wasm32-unknown-unknown/release/x_wasm.wasm" \
  --target web --no-typescript --out-dir "$stage/wasm" --out-name x_wasm
mkdir -p apps/web/public/wasm
cp -R "$stage/wasm/." apps/web/public/wasm/
cp "$target_dir/wasm32-unknown-unknown/release/x_geo.wasm" apps/web/public/x_geo.wasm
printf 'Packaged: apps/web/public/wasm/{x_wasm.js,x_wasm_bg.wasm} and public/x_geo.wasm\n'
printf 'Next: cd apps/web && npm run test:wasm && npm run build\n'
