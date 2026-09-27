# X-Native web chrome

React + TypeScript designer shell that talks to the document through a
**command API** (`src/engine/types.ts`). This is the **only product UI**.
The GPU native window (`x_native_app`) was removed.

## Why this exists

Immediate-mode Vello chrome is the wrong layer for Figma-density panels:
layout, focus, text fields, and CSS hover states fight the scene graph.
Chrome belongs in the DOM.

An earlier version of this file said the document, undo and auto layout "stay
in Rust". That was never true of the shipped app: `src/engine/` implements all
of them in TypeScript and nothing here calls into the Rust crates.

**This package is the production engine as well as the UI.** Rust is a future
candidate, not the current authority. See
[docs/ARCHITECTURE_BOUNDARY.md](../../docs/ARCHITECTURE_BOUNDARY.md) for the
boundary rule, the per-capability ownership table, and the migration sequence.

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

## Verify

Three tiers, each covering what the one below it cannot:

```bash
npm test          # engine + headless UI (no browser needed)
npm run build     # tsc -b && vite build
npm run test:e2e  # behaviour suite — needs a Chromium and a running dev server
```

| Tier | What it proves | Where |
| --- | --- | --- |
| Engine / model | commands, geometry, layout, undo, importers, exporters | `src/engine/__tests__/*.test.mjs` |
| Headless UI | a real DOM: which node renders, with what class, name, role and state, and what a click dispatches | `src/ui/__tests__/*.dom.test.mjs` over `domEnv.mjs` (jsdom) |
| Source contract | what a file may *contain*: which literals survived triage, which classes a component names, and whether a module's fallbacks still equal the sheet | `src/ui/__tests__/{drift,vectorcard,canvasChrome}.test.mjs` |
| Browser | computed styles, geometry, focus, hover, canvas pixels, keyboard chords | `e2e/behaviour.mjs` (puppeteer-core) |

`domEnv.mjs` mounts `RightPanel` / `Toolbar` on an engine document the way
`App.tsx` does (snapshot from the store, so a dispatch re-renders). It exists
because a development sandbox often has no browser at all — without it, every
UI fix could only be shipped as "code-traced, NOT VERIFIED". jsdom has no
stylesheet and no canvas backend, so anything about *appearance* (sizes,
colours, focus rings, painted pixels) still belongs to the e2e tier; a finding
is closed when both halves are checked, and the audit ledger says which tier
closed which half.

The e2e suite points `CHROMIUM_PATH` / `CHROMIUM_LIBS` at a local Chromium
(e.g. the binary inside `@sparticuz/chromium`) and `APP_URL` at the dev server.
