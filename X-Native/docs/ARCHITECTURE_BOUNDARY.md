# Rust / TypeScript boundary

Status: **decided**, partially **aspirational**. Read the "Where we actually
are" section before relying on any of it.

## The rule

> If behaviour belongs to the design engine, implement it once in Rust.
> If behaviour exists only to drive or test this environment, TypeScript may
> model it locally.

Rust is the engine authority. TypeScript must not become a second production
implementation of the engine.

This document exists to stop architectural drift: every future change that adds
engine behaviour to TypeScript is a violation unless it is listed under
"Sanctioned TypeScript" below, or the boundary is renegotiated here first.

## Where we actually are

The rule above describes the target. It does **not** describe the repository
today, and the gap is large enough that pretending otherwise would be the
drift it is meant to prevent.

Verified on this branch:

| Claim | Reality |
| --- | --- |
| Rust is the production engine | **No.** Nothing in `apps/web` calls it |
| The web app is a thin UI over the engine | **No.** `apps/web/src/engine/` is ~4,900 lines and owns the document model, undo, Auto Layout, snapping, hit-testing and persistence |
| A native UI exists | **No.** All six `x-designer` binaries are headless CLIs; the GPU window was removed (`apps/web/README.md`) |
| Rust reaches production | **No.** No build step compiles Rust into the shipped bundle — no wasm, no IPC, no network calls |

Searching the web app for every engine entry point — `import_fig`,
`import_sketch`, `load_x`, `apply_layout`, `export_pdf` — returns **zero**
calls. The single textual hit is a comment in `pdf.ts` pointing at the Rust
equivalent.

So today the shipped product is the TypeScript app, and the 88k lines of Rust
are unreachable from it.

### The TypeScript engine predates this branch

Worth stating because it affects who owns the decision: `apps/web/src/engine/`
was not introduced by the recent import work. At the branch base commit
(`de232fe`, before any change in this session) `memory.ts` was already 1,536
lines and already contained Auto Layout. The duplication is pre-existing
architecture, not drift introduced by the import ports.

That makes the Auto Layout example in the brief already true in the codebase:
there *are* two implementations (`crates/x-components/src/layout.rs` and
`memory.ts`), and the TypeScript one is the one that runs.

## Sanctioned TypeScript

These are allowed to live in `apps/web` and are not counted as engine
duplication:

- **UI, interaction and rendering to canvas.** Panels, tools, gestures,
  selection chrome, the 2D canvas painter.
- **View state.** Zoom, pan, rulers, comments visibility, panel geometry,
  inspector section folding.
- **Browser-only capability** that has no meaning in a native build:
  `clipboard.ts`, `persist.ts` (localStorage), `zip.ts`,
  `pdf.ts` (browser PDF writer), `toast`, theming.
- **The behaviour suite** (`apps/web/e2e/`), which asserts observable
  behaviour and is a safety net, not an engine.

## Not sanctioned — existing violations

These implement engine behaviour in TypeScript and duplicate Rust that already
exists. They are listed so the debt is visible and bounded, not because they
should be deleted today — they are the running product.

| TypeScript | Rust authority | Notes |
| --- | --- | --- |
| `memory.ts` document model, commands, undo | `x-core`, `x-editor` | ~1,764 lines |
| `memory.ts` Auto Layout (`relayout`) | `x-components/src/layout.rs` | the brief's own example |
| `snapping.ts` | `x-editor/src/snapping.rs` | comment already says "ported in spirit" |
| `geometry.ts` boolean/simplify/erase | `x-editor/src/booleans.rs`, `eraser.rs` | |
| `svgImport.ts` | `x-format/src/svg_import.rs` | added this session |
| `sketchImport.ts` | `x-format/src/sketch.rs` | added this session |
| `kiwi.ts` + `figImport.ts` | `x-format/src/kiwi.rs`, `figbinary.rs` | added this session |

The three import ports were written knowing this. They were the only way to
open a design file in an environment where the bridge cannot be built (see
below), and each one names its Rust counterpart in its header comment so the
authority relationship is recorded in the source.

## Why the bridge does not exist yet

Not a decision — an environment limit, verified rather than assumed:

- no `cargo` / `rustc` on the machine
- `static.rust-lang.org`, `sh.rustup.rs`, `crates.io` unreachable
- the `wasm-pack` npm package installs but fetches its binary from a blocked host
- `apt` requires root

No Rust in this repository has been compiled or executed in this environment.
The 914 `#[test]` annotations in `crates/` are real code, but no one has run
them here — any claim that they pass is unverified.

## Doing this properly

Ordered, and each step is verifiable:

1. **Provision a Rust toolchain in CI and in the dev environment.** Everything
   else is blocked on this. Until it exists, the boundary cannot be enforced,
   only documented.
2. **Build the wasm bridge for one narrow slice** — suggested: `.fig`/`.sketch`
   import, because the behaviour suite already pins the expected output, so the
   bridge can be proven equivalent before anything is deleted.
3. **Delete the TypeScript port it replaces**, not before. The e2e checks stay
   and must keep passing across the swap; that is exactly what they are for.
4. **Repeat for Auto Layout, then the document model.** Largest and riskiest
   last.
5. **Classify the 88k lines** only once something calls into them, since
   reachability is meaningless while nothing is connected.

### Classifying the Rust

The requested buckets, with the honest caveat that today almost everything
lands in the third:

- **Used by the current app** — nothing. No call path exists.
- **Real future use** — `x-core`, `x-editor`, `x-components`, `x-format`,
  `x-render`, `x-text`. These are the engine the bridge would expose.
- **Duplicated by the TS port** — the table above. Rust stays authoritative on
  paper; TypeScript is authoritative in the running product until step 3.
- **Dead / unreachable** — cannot be determined yet. Reachability analysis
  requires an entry point, and there is none.
- **Old / experimental** — the removed GPU window is already gone; no other
  candidate identified.

**Do not delete Rust before step 2.** It is currently the only implementation
of `.fig` binary parsing, Sketch round-tripping, PDF vector export, HTML export
and `.x` persistence that has ever been tested by its own suite.

## Enforcement

Until the bridge exists, this is a review rule rather than a build gate:

- A new file in `apps/web/src/engine/` needs a line in this document saying
  which bucket it is in.
- Anything that duplicates existing Rust must name its counterpart in a header
  comment, as the three import ports do.
- Prefer extending the behaviour suite over adding engine logic to TypeScript.

Once a toolchain exists, step 2 should add a CI job that builds the wasm
artifact, so the boundary becomes mechanically checkable instead of social.
