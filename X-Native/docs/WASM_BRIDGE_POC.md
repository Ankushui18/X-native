# Rust/WASM command bridge POC

## What already existed

This repository already has `crates/x-wasm`, the import/session WASM bridge, generated-asset loading in `apps/web/src/engine/wasmBridge.ts`, and an opt-in Rust document preview. The Phase 1 addition is an **isolated typed command POC** on top of that bridge; it does not replace the production TypeScript `MemoryEngine` or claim full-editor parity.

## Phase 1–8 API

- Rust `Command` accepts JS objects shaped as:
  - `{ type: "createNode" | "CreateNode", nodeType: "rect" | "frame" | "text" | "ellipse", x, y, width, height, parentId?, text? }` (`width` and `height` default to `100 × 80` when omitted for Phase 1 backward compatibility; `text` defaults to `"Text"` for text nodes when omitted).
  - `{ type: "moveNode" | "MoveNode", id, dx, dy, parentId? }`.
  - `{ type: "resizeNode" | "ResizeNode", id, x?, y?, width, height }`.
  - `{ type: "deleteNode" | "DeleteNode", id }`.
  - `{ type: "booleanOperation" | "BooleanOperation", targetIds, operation: "union" | "subtract" | "intersect" | "exclude" }`.
  - `{ type: "applyAutoLayout" | "ApplyAutoLayout", frameId, axis: "horizontal" | "vertical", padding, gap }`.
  - `{ type: "updateNode" | "UpdateNode", id, name?, fill?, stroke?, strokeWidth?, opacity?, rotation?, radius?, text?, fillVariable? }`.
  - `{ type: "outlineStroke" | "OutlineStroke", id }`.
  - `{ type: "offsetPath" | "OffsetPath", id, distance, join?: "miter" | "round" | "bevel" }`.
  - `{ type: "duplicateNode" | "DuplicateNode", id, dx?, dy? }`.
  - `{ type: "updateVariable" | "UpdateVariable", id, value }`.
  - `{ type: "setVariableMode" | "SetVariableMode", collectionId, modeId }`.
  - `{ type: "updateComponentProperty" | "UpdateComponentProperty", instanceId, propertyName, value }`.
  - `{ type: "undo" | "Undo" }` and `{ type: "redo" | "Redo" }`.
- `NodeSnapshot` includes `id`, `name`, `kind` (`"rect" | "frame" | "text" | "ellipse" | "boolean" | "path"`), `x`, `y`, `w`, `h`, `parent_id` (`parentId`), `rotation` (default `0.0`), `opacity` (default `1.0`), `fill` (hex color representation), `stroke`, `stroke_width` (`strokeWidth`), `radius`, `text` (`string` for text nodes), `visible`, `component_properties` (`componentProperties`), `path_commands` (`pathCommands`: `M`, `L`, `C`, `Z` cubic Bezier contours), `boolean_op` (`booleanOp`), and `auto_layout` (`autoLayout`: `{ axis, padding, gap }`). `DocumentState` also projects `variables`, `activeModes`, and `componentOverrides` when mutated.
- `init_wasm_engine()` creates an isolated `x_editor::Editor`, resets the frame render cache, and returns an empty `DocumentState`.
- `dispatch_command(command)` uses `serde_wasm_bindgen::from_value`, executes `Editor::insert_node`, `Editor::move_node`, `Editor::resize`, `Editor::delete_selection`, `x_core::booleans::boolean` (`Backend::BezierExact`), `Editor::set_auto_layout`, `Editor::replace_node`, `Editor::outline_stroke_node`, `x_core::offset_path::offset_filled_path`, `x_editor::variable_commands::apply_variable`, `Editor::set_prop_value` / `x_core::components::set_exclusive_override`, `Editor::undo`, or `Editor::redo`, and returns the updated hierarchical `DocumentState` through `serde_wasm_bindgen::Serializer::json_compatible()`.
- `render_frame(canvas_id, state)` deserializes `DocumentState`, resolves the target `<canvas>` and `CanvasRenderingContext2d` via `web-sys`, scales the backing store by `devicePixelRatio` (`window.devicePixelRatio` or `state.devicePixelRatio`), lowers `state.nodes` (including nested `parent_id` hierarchies, text glyphs, ellipses, and cubic Bezier paths) through `x_render::build_render_tree`, and executes the resulting `x_render::RenderCommand` list directly on the 2D canvas context. A revision-keyed `RenderFrameCache` skips redundant lowering and redraws when neither the document revision/nodes nor the viewport/DPR changed.
- `apps/web/src/engine/WasmEngine.ts` exposes `initialize()`, `getOrCreate()`, `isReady()`, `createNode(type, x, y, width, height, parentId?, text?)`, `moveNode(id, dx, dy, parentId?)`, `resizeNode(id, x, y, width, height)`, `deleteNode(id)`, `booleanOperation(ids, operation)`, `applyAutoLayout(frameId, axis, padding, gap)`, `updateNode(id, patch)`, `outlineStroke(id)`, `offsetPath(id, distance, join?)`, `duplicateNode(id, dx?, dy?)`, `updateVariable(id, value)`, `setVariableMode(collectionId, modeId)`, `updateComponentProperty(instanceId, propertyName, value)`, `undo()`, `redo()`, `renderFrame(canvasId, state)`, `createRectangle(x, y)`, `dispatch()`, and `snapshot()`.
- In the live editor (`apps/web/src/ui/Canvas.tsx`, `apps/web/src/ui/layoutActions.ts`, `apps/web/src/ui/inspector.tsx`, `apps/web/src/ui/chrome.tsx`, `apps/web/src/ui/ContextMenu.tsx`, and `apps/web/src/engine/memory.ts`), creating, moving, resizing, deleting, boolean operations (`⌥⇧U/S/I/E`), Auto-Layout (`⇧A` and Inspector controls), styling/property mutations (`updateNode`), outlining strokes (`⇧⌘O`), offsetting paths, duplicating nodes (`⌘D`), updating variables and switching variable modes (`VarsPane` / `VarRow`), updating component instance properties (`Inspector`), and undoing/redoing dispatch commands to `WasmEngine`, synchronize hierarchical `parent_id`, `rotation`, `opacity`, `fill`, `stroke`, `strokeWidth`, `radius`, `text`, `visible`, `componentProperties`, exact Bezier `pathCommands`, `autoLayout`, `variables`, `activeModes`, `componentOverrides`, and deleted/restored nodes into `MemoryEngine` via `syncWasmState` (triggering `evaluateExpressionsInTree()` and `relayout()`), and delegate frame painting in `useEffect` to `wasmEngine.renderFrame("x-native-canvas", currentDocumentState)`. If WASM is uninitialized or fails, the editor falls back gracefully to `MemoryEngine` and the TypeScript 2D renderer.

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
