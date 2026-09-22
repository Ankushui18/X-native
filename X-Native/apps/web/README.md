# X-Native web chrome

React + TypeScript designer shell that talks to the document through a
**command API** (`src/engine/types.ts`). This is the **only product UI**.
The GPU native window (`x_native_app`) was removed.

## Why this exists

Immediate-mode Vello chrome is the wrong layer for Figma-density panels:
layout, focus, text fields, and CSS hover states fight the scene graph.
Chrome belongs in the DOM.

The intent was that the document, undo and auto layout stay in Rust. That is
**not yet true**: `src/engine/` currently implements all of them in
TypeScript and nothing here calls into the Rust crates. See
[docs/ARCHITECTURE_BOUNDARY.md](../../docs/ARCHITECTURE_BOUNDARY.md) for the
decided boundary, the verified gap, and the order of work to close it.

## Split

| Layer | Owner | Status |
| --- | --- | --- |
| Document model, layout, undo, `.x` | `crates/x-core`, `x-editor`, `x-format` | untouched |
| Headless GPU canvas, export | `crates/x-render`, `render_headless` | CLI / tests |
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
dock. Shortcuts: V F T R O L H, ⌘Z / ⌘⇧Z, ⌘D, arrows, Delete.
