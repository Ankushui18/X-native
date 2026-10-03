# Rust/WASM command bridge POC

## What already existed

This repository already has `crates/x-wasm`, the import/session WASM bridge, generated-asset loading in `apps/web/src/engine/wasmBridge.ts`, and an opt-in Rust document preview. The Phase 1 addition is an **isolated typed command POC** on top of that bridge; it does not replace the production TypeScript `MemoryEngine` or claim full-editor parity.

## Phase 1 API

- Rust `Command` accepts a JS object shaped as `{ type: "createNode", nodeType: "rect", x, y }`.
- `init_wasm_engine()` creates an isolated `x_editor::Editor` and returns an empty `DocumentState`.
- `dispatch_command(command)` uses `serde_wasm_bindgen::from_value` and returns the updated state through `serde_wasm_bindgen::to_value`. It creates a 100 × 80 rectangle and rejects unsupported node types or non-finite coordinates.
- The snapshot is a deliberately small projection (`revision`, `canUndo`, and rectangle `nodes`); the existing `x_core::Node` does not need new Serde derives.
- `apps/web/src/engine/WasmEngine.ts` exposes `initialize()`, `createRectangle(x, y)`, `dispatch()`, `subscribe()`, and `snapshot()`. This is a minimal adapter, not a drop-in implementation of the full `MemoryEngine` command API.
- In development, the dashboard has a **WASM POC** button. It runs `createRectangle(100, 100)` and logs the returned Rust state in the browser console. The ordinary editor continues using `MemoryEngine` until command coverage and document equivalence are proven.

The new object-based POC exports are optional in the shared loader, so older generated artifacts continue to serve the existing import/session paths. Rebuild the generated assets before using the button.

## Build and run

From the repository's `X-Native` directory:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --version 0.15.0 --locked
cargo install wasm-bindgen-cli --version 0.2.127 --locked
cd apps/web
npm ci
npm run wasm:build
npm run dev
```

`npm run wasm:build` calls `scripts/build-wasm.sh`. It uses `wasm-pack build -t web` for `x-wasm`, builds the separate raw-WASM `x-geo` consumer with Cargo, then stages `x_wasm.js` and `x_wasm_bg.wasm` under `apps/web/public/wasm/` (and `x_geo.wasm` at the public root). The packager and bindgen CLI versions are pinned to keep output reproducible. No generated binaries are committed. The same script is used by repository CI.

## Automated verification

From `X-Native`:

```sh
cargo test --locked -p x-wasm
cd apps/web
npm ci
npm run wasm:build
npm run test:wasm  # real generated WASM bridge; run after packaging
npm test            # full web suite
npm run build       # TypeScript check and production bundle
```

For a production bundle, package WASM first, then run `npm run build` from `apps/web`.

## Verify the proof

1. Open the Vite development app and stay on the dashboard.
2. Click **WASM POC** in the dashboard header. The button is development-only.
3. Open the browser console. The log `[X-Native] Rust WASM DocumentState:` should show `revision: 1`, `canUndo: true`, and one rectangle at `(100, 100)` with size `100 × 80`.
4. The toast confirms the command returned state. If the generated artifact is missing or too old, the toast reports that the POC exports are unavailable; build the assets and reload.

The `wasmEngine.test.mjs` test uses an injected bindgen-shaped module to verify the typed wrapper and backward-compatible handling of older bridge artifacts. Rust host tests cover the command/state projection; the wasm-bindgen boundary itself must be verified by `scripts/build-wasm.sh`/CI or a local wasm build.
