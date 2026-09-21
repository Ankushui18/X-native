# X-Native web chrome

React + TypeScript designer shell that talks to the document through a
**command API** (`src/engine/types.ts`). The GPU native app
(`apps/x-designer` / Vello) is unchanged and remains the shipping renderer.

## Why this exists

Immediate-mode Vello chrome (`editor_ui.rs` ~13k lines, `run.rs` ~18k) is the
wrong layer for Figma-density panels: layout, focus, text fields, and CSS
hover states fight the scene graph. Chrome belongs in the DOM. The document,
undo, auto layout, and (later) canvas raster stay in Rust.

## Split

| Layer | Owner | Status |
| --- | --- | --- |
| Document model, layout, undo, `.x` | `crates/x-core`, `x-editor`, `x-format` | untouched |
| GPU canvas, export | `crates/x-render`, `x_native_app` | untouched |
| Command API | `apps/web/src/engine/types.ts` | this package |
| In-memory engine (dev) | `apps/web/src/engine/memory.ts` | this package |
| Designer chrome | React (this package) | Figma UI3 light |

When `wasm-bindgen` is available, `MemoryEngine` is replaced by a WASM
`x-editor` that implements the same `Engine.dispatch(Command)` interface.
The UI does not import node internals.

## Run

```bash
cd apps/web
npm install
npm run dev
```

Figma UI3: Design / Prototype / Inspect tabs, layers tree, **bottom** tool
dock, Graphite palette (`#090909` / `#060606` / `#1b1d23`). Shortcuts: V F T R O
L H, ⌘Z / ⌘⇧Z, ⌘D, arrows, Delete.
