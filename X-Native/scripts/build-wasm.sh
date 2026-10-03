#!/usr/bin/env bash
# Build both EXISTING bridge boundaries. No checked-in binaries; Vite copies
# these optional public assets into dist. Run from any working directory.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$(pwd -P)
command -v cargo >/dev/null || { echo 'Missing Rust toolchain (see rust-toolchain.toml).' >&2; exit 1; }
command -v wasm-pack >/dev/null || { echo 'Install: cargo install wasm-pack --version 0.15.0 --locked' >&2; exit 1; }
[[ "$(wasm-pack --version)" == 'wasm-pack 0.15.0' ]] || {
  echo 'wasm-pack must be version 0.15.0' >&2; exit 1;
}
command -v wasm-bindgen >/dev/null || { echo 'Install: cargo install wasm-bindgen-cli --version 0.2.127 --locked' >&2; exit 1; }
[[ "$(wasm-bindgen --version)" == 'wasm-bindgen 0.2.127' ]] || {
  echo 'wasm-bindgen CLI must match the locked crate: 0.2.127' >&2; exit 1;
}
# Install the target once: rustup target add wasm32-unknown-unknown
# Resolve the target directory before passing it to wasm-pack: its output path
# is interpreted relative to the crate when a relative path is supplied.
target_dir="${CARGO_TARGET_DIR:-$root/target}"
[[ "$target_dir" = /* ]] || target_dir="$root/$target_dir"
export CARGO_TARGET_DIR="$target_dir"
mkdir -p "$target_dir"
stage=$(mktemp -d "$target_dir/wasm-package.XXXXXX")
trap 'rm -rf "$stage"' EXIT

# Use wasm-pack for the command/snapshot bridge and keep its temporary package
# output isolated from the web app's checked-in source.
wasm-pack build crates/x-wasm --target web --release --no-typescript \
  --out-dir "$stage/wasm" --out-name x_wasm -- --locked

# x-geo has a separate raw-WASM consumer and does not use wasm-bindgen glue.
cargo build --locked --release --target wasm32-unknown-unknown -p x-geo
mkdir -p apps/web/public/wasm
cp "$stage/wasm/x_wasm.js" apps/web/public/wasm/
cp "$stage/wasm/x_wasm_bg.wasm" apps/web/public/wasm/
cp "$target_dir/wasm32-unknown-unknown/release/x_geo.wasm" apps/web/public/x_geo.wasm
printf 'Packaged: apps/web/public/wasm/{x_wasm.js,x_wasm_bg.wasm} and public/x_geo.wasm\n'
printf 'Next: cd apps/web && npm run test:wasm && npm run build\n'
