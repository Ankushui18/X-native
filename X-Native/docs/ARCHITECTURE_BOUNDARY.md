# Rust / TypeScript boundary

Status: **provisional by design.** This document describes what the repository
does today, not what earlier audits assumed it did.

## The rule

> There must be one authoritative production implementation of each engine
> capability. The Rust ↔ TypeScript boundary remains provisional until Rust can
> be built, connected, and equivalence-tested.

Note what this does **not** say. It does not say "Rust owns the engine". That
would be a claim about the present tense, and it would be false: Rust is not
currently connected to anything shipped. The rule constrains duplication
without pre-judging which language wins each capability.

## Current state, verified

**TypeScript is the production runtime engine for the web application. Rust is
an unconnected headless codebase whose future role has not yet been proven.**

```
TypeScript                      Rust
    ↓                            ↓
production web engine       headless / unconnected
  document model                 ↓
  undo                      future candidate engine
  Auto Layout
  snapping
  persistence
  import / export
```

Checked on this branch, not inferred:

| Claim | Reality |
| --- | --- |
| Rust is the production engine | **No.** Nothing in `apps/web` calls it |
| The web app is a thin UI over the engine | **No.** `apps/web/src/engine/` is ~4,900 lines and owns the document model, undo, Auto Layout, snapping, hit-testing and persistence |
| A native UI exists | **No.** All six `x-designer` binaries are headless CLIs; the GPU window was removed |
| Rust reaches production | **No.** No build step compiles Rust into the shipped bundle — no wasm, no IPC, no network calls |

Searching the web app for every engine entry point — `import_fig`,
`import_sketch`, `load_x`, `apply_layout`, `export_pdf` — returns **zero**
calls. The single textual hit is a comment in `pdf.ts` pointing at the Rust
equivalent.

### The TypeScript engine predates this branch

At the branch base commit (`de232fe`, before any change in this session)
`memory.ts` was already 1,536 lines and already contained Auto Layout. The
duplication is pre-existing architecture, not drift introduced by the recent
import ports.

This matters for how the situation is described: there *are* already two Auto
Layout implementations (`crates/x-components/src/layout.rs` and `memory.ts`),
and the TypeScript one is the one that runs.

## What TypeScript owns today

All of it, in practice. Listed so that "one authoritative implementation" can be
checked per capability rather than argued in the abstract.

| Capability | TypeScript (authoritative today) | Rust counterpart (unconnected) |
| --- | --- | --- |
| Document model, commands, undo | `memory.ts` (~1,764 lines) | `x-core`, `x-editor` |
| Auto Layout | `memory.ts` `relayout()` | `x-components/src/layout.rs` |
| Snapping | `snapping.ts` | `x-editor/src/snapping.rs` |
| Boolean / simplify / erase | `geometry.ts` | `x-editor/src/booleans.rs`, `eraser.rs` |
| SVG import | `svgImport.ts` | `x-format/src/svg_import.rs` |
| Sketch import | `sketchImport.ts` | `x-format/src/sketch.rs` |
| `.fig` import | `kiwi.ts`, `figImport.ts` | `x-format/src/kiwi.rs`, `figbinary.rs` |
| PDF export | `pdf.ts` (raster) | `x-render` `export_pdf` (vector) |
| Persistence | `persist.ts` (localStorage) | `x-format` `.x` |

Browser-only concerns with no native counterpart — `clipboard.ts`, `zip.ts`,
`toast`, theming, view state, the canvas painter and all UI — are not
duplication and are not in scope for migration.

The three import ports each name their Rust counterpart in a header comment, so
the relationship is recorded in the source and not only here.

## Two tracks, running in parallel

A local Rust toolchain would make migration work comfortable, but it is not a
prerequisite: CI already builds and tests the workspace. Neither track blocks
the other, and freezing product work around an architecture that has not yet
been demonstrated would be the wrong trade.

```
TYPESCRIPT PRODUCT              RUST MIGRATION TRACK
   UI / UX maturity                provision toolchain
   behaviour tests (59+)           build
   strokes[]                       connect narrow bridge
   shared styles                   equivalence tests
   effects popover                 CI artifact
   draggable guides                migrate incrementally
   minimap
```

Both tracks are live. Neither waits on the other.

## Bridge status

**Slice 1 is built.** `crates/x-wasm` compiles to `wasm32-unknown-unknown` in
CI and uploads a ~298 KB `x_wasm.wasm` artifact on every run. It exposes
`importFigToX`, `importSketchToX`, `importSvgToX` and `engineVersion`: bytes in,
`.x` JSON out, via `x-format`'s existing importers and `save_x`. The crate owns
no document logic, and the dependency-graph test declares it a leaf — it may
depend on the engine, nothing may depend on it.

**It is not yet loaded by the web app.** Nothing in `apps/web` imports the
artifact, so the shipped product still runs entirely on TypeScript. The next
slice is to load it behind a flag and run the existing `.fig`/`.sketch`/SVG
import checks against both paths; the behaviour suite already pins the expected
output, which is why import was chosen as the first capability.

## Migration sequence

```
TypeScript production
        │  59 E2E checks pin observable behaviour
        ↓
  bridge ONE slice in Rust
        ↓
  build + run + equivalence test
        ↓
   ┌────┴────┐
 PASS       FAIL
   │          │
   ↓          ↓
migrate   investigate
   │
   ↓
remove the TS duplicate
   │
   ↓
repeat
```

Suggested first slice: `.fig` / `.sketch` import. The behaviour suite already
pins the expected output, so equivalence can be proven before anything is
removed.

**Remove the TypeScript implementation only after the Rust one passes the same
checks.** The e2e suite must keep passing across the swap; that is what it is
for.

## Classifying the 88k lines of Rust

The accurate status today is **unreachable in the current verified product
environment**. That is not the same as unnecessary, and the difference is the
whole point:

- **Used by the current app** — nothing. No call path exists.
- **Real future use** — `x-core`, `x-editor`, `x-components`, `x-format`,
  `x-render`, `x-text`. The engine a bridge would expose.
- **Duplicated by TypeScript** — the table above. TypeScript is authoritative
  in the running product; Rust is a candidate, not yet an authority.
- **Dead / obsolete** — **cannot be determined.** Reachability analysis needs
  an entry point and there is none. Anything that compiles and is referenced by
  another crate is live as far as this repository can tell.
- **Old / experimental** — the removed GPU window is already gone; no other
  candidate identified.

**Do not delete Rust before a slice has been bridged and proven.** It is
currently the only implementation of `.fig` binary parsing, Sketch
round-tripping, PDF *vector* export, HTML export and `.x` persistence that has
ever been exercised by its own test suite.

## Why the bridge does not exist yet

An environment limit, not a decision. Every route to a toolchain was probed;
the results are recorded here so nobody repeats the search.

**Reachable:** `registry.npmjs.org`, `pypi.org`, `github.com` (API + `git
clone`).

**Blocked:** `static.rust-lang.org`, `sh.rustup.rs`, `forge.rust-lang.org`,
`crates.io`, `static.crates.io`, `index.crates.io`, the tuna and rsproxy
mirrors, `cdn.jsdelivr.net`, `unpkg.com`, and — decisively —
`objects.githubusercontent.com`, `raw.githubusercontent.com` and
`release-assets.githubusercontent.com`.

Routes tried and why each fails:

| Route | Result |
| --- | --- |
| `rustup` / official installer | host blocked |
| `apt install rustc` | needs root |
| npm `wasm-pack` | installs, then fetches its binary from a blocked host |
| PyPI `maturin`, `setuptools-rust` | install fine, but both are *drivers*: neither bundles a compiler |
| GitHub release assets (`gh release download`) | API lists them, download fails — the asset CDN returns EOF |
| Build rustc from source | needs a bootstrap rustc, which comes from the blocked host |
| Bootstrap via `mrustc` (gcc/g++/make are present) | would still need crates.io for dependencies |

The dependency problem is independent of the compiler problem: `Cargo.lock`
pins **218 packages** and the workspace declares **37 direct** external crates
including `wgpu` and `vello`. There is no `vendor/` directory and no `.cargo/`
config, so a build would have to fetch all of them from crates.io. Even a
working rustc would not produce a build here.

**What would unblock local work**, in order of preference:

1. Allowlist `static.rust-lang.org` and `crates.io` (plus `index.crates.io`,
   `static.crates.io`) in the sandbox egress rules.
2. Or bake `cargo`/`rustc` into the dev image and commit a `vendor/` directory
   (`cargo vendor`) so builds are offline-capable.

Neither is needed to *begin*. CI already compiles and tests the workspace, so
the first slice can be proven there. Local access decides whether the work is
comfortable, not whether it is possible.

No Rust in this repository has been compiled or executed **in this sandbox**.

**CI is a different story, and it changes the plan.**
`.github/workflows/ci.yml` installs the pinned 1.98.1 toolchain and runs
`scripts/check.sh`, which does `cargo fmt --check`, `cargo clippy --workspace
--all-targets` and `cargo test --workspace --locked`. Those runs pass on this
branch. So the Rust does compile and its tests do run — just not here.

The toolchain is therefore not a blocker for *evaluating* the Rust
architecture. It only blocks doing that work interactively. The first bridge
slice can be built and proven in CI today.

## Enforcement

This is a review rule rather than a build gate, because no CI job yet compares
the two implementations:

- A new file in `apps/web/src/engine/` should say which capability it owns and
  whether a Rust counterpart exists.
- Anything duplicating existing Rust must name its counterpart in a header
  comment, as the three import ports do.
- Prefer extending the behaviour suite over adding engine logic anywhere.
- Adding a *second* implementation of a capability that already has an
  authoritative one requires a migration plan, not just a patch.

The migration track should add a CI job that builds the wasm artifact and runs
the equivalence checks, so the boundary becomes mechanically checkable instead
of social. CI already has the toolchain, so this is buildable now.
