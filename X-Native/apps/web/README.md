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
of them in TypeScript. Optional WASM import and geometry bridges now reach Rust,
but neither replaces the TypeScript command engine.

**This package is the production engine as well as the UI.** TypeScript is still
the authority for imports and geometry until native parity is proven. See
[docs/ARCHITECTURE_BOUNDARY.md](../../docs/ARCHITECTURE_BOUNDARY.md) for the
boundary rule, the per-capability ownership table, and the migration sequence.

## Split

| Layer | Owner | Status |
| --- | --- | --- |
| Separate native/CLI document model, layout, undo, `.x` | `crates/x-core`, `x-editor`, `x-format` | not the web command engine |
| Headless GPU canvas, export | `crates/x-render`, `render_headless` | CLI / tests |
| Command API | `apps/web/src/engine/types.ts` | this package |
| In-memory web engine (production) | `apps/web/src/engine/memory.ts` | this package |
| Optional import and geometry bridges | `apps/web/src/engine/{wasmBridge,geoBridge}.ts` | guarded by TypeScript parity checks |
| Designer chrome | React (this package) | Figma UI3 light |

`MemoryEngine` is **not** replaced by WASM today. `npm run build:wasm` packages
the optional generated `x-wasm` import glue and `x-geo.wasm`; without them the
web app still works via TypeScript. Native import results are accepted only when
the entire converted result matches the TypeScript importer. Geometry in `auto`
mode falls back when its native result differs (the current corpus does not pass
native promotion). Run `npm run test:wasm` after packaging to test the real
modules. See [WASM bridge verification](../../docs/WASM_BRIDGES_2026-09-27.md).

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

## Experimental Rust document preview

With the optional WASM artifacts installed (`npm run build:wasm` in a Rust-enabled
environment), open a stored, flat rectangle-only file at
`#/file/<id>?engine=rust`. The standard `#/file/<id>` editor and its TypeScript
document engine remain unchanged. The preview has Rust-owned move, rename,
resize and undo/redo commands; it does not autosave or support the full editor
toolset. The resize control uses the version-2 command ABI and requires both
rectangle dimensions to be at least 1; older WASM session artifacts refuse the
preview while leaving guarded imports available.
"Prepare download" gives you a copy, not an update to the stored file. You will
be prompted before leaving with edits. An unsupported file or unavailable WASM
stays read-only and offers an explicit return to the standard editor; there is
no automatic fallback after Rust editing starts.

To verify the genuine module after packaging, run `npm run test:wasm`. The CI
smoke mounts the React preview over real generated WASM in jsdom, but it does
not prove browser rendering or production editor parity.
