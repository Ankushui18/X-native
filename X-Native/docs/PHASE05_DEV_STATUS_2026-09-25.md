# Phase 5 — Dev Mode & Integration (TS track) — 2026-09-25

P1.9 (Dev Mode codegen), P1.10 (component → code mapping), P1.11 (design API).
Roadmap: 14 boxes flipped; 1 deliberately left open (see follow-ups).

## What shipped

**P5-A Subtree codegen (`engine/codegen.ts`, ~950 lines)** — the roadmap's
"critical improvement". A node subtree compiles to an intermediate tree and
then to framework code:
- Layout inference: Auto Layout → flex (incl. auto-gap → justify,
  wrap, padding, align), grid direction → `grid-template-*` with track
  modes, freeform frames → relative parent + absolute children.
- Six tree emitters: TSX (inline styles), HTML+CSS, Tailwind utilities,
  class-based CSS, Vue SFC, Svelte. Class names slug + dedupe.
- Honest output: vectors/images/effects without equivalents become comments,
  never fake CSS. Blur effects map to `backdrop-filter`/`filter`, truncation
  to line-clamp, text-case/decorations to real properties.
- Em-dash-free, rem-capable, `maxDepth: 0` renders the root alone (the Layer
  scope for formats with no single-node generator).

**Tokens → code** — live `variableBindings` resolve to `var(--…)` first
(even when the value drifts from the variable), exact value matches second
(type-gated: colors, numbers, font families). DevTokens gains a **TW** button
copying a `tailwind.config` `theme.extend` built from the file's variables.

**P5-B Component → code mapping (P1.10)** — `CodeMapping` on masters
(framework, component name, import path, file, version, prop map with
prop/children/omit kinds), persisted, undoable, with three commands
(`setCodeMapping`, `deleteCodeMapping`, `syncCodeMapping`). Mapped instances
render as `<Button variant="primary" />` with imports; unmapped instances
expand inline with a note; cross-framework fallback is flagged. The
Component/Instance panel gets a `Code mappings` editor with auto-map-all and
a sync indicator (`synced`/`stale`/`never` + Verify, hash-based).

**Native emitters completing the P1.9 list** — UIKit (`UIView`/`UILabel`/
`UIStackView`) and Android XML (`LinearLayout`/`TextView`/`View`)
single-node generators; Dev Mode now offers 13 languages.

**P5-C Dev Mode integration** — Inspect code view gains a Layer/Subtree
scope toggle (persisted pref); HTML/Vue/Svelte join the language menu;
⌥⇧C, the Copy/paste-as menu, and the panel all copy through one scoped
renderer.

**P5-D Design API (`engine/designApi.ts`, P1.11)** — 25 methods over the live
session: selection, layers, find (9 filters), variables/tokens + usage,
components/instances/properties/variants, code mapping/component, auto
layout, constraints, spacing, colors, typography, assets, annotations,
version, codegen. Enveloped (`{ ok, data|error }`), error codes, pagination,
machine-readable `describe()`. Live at `window.__xNativeDesignApi`;
reference in `docs/DESIGN_API.md`.

## Verification

- `tsc --noEmit` clean, `vite build` clean, dev server 200.
- Tests: 890 + 64 + 46 + **63** (codegen) + **49** (designApi) = **1112
  passed, 0 failed** (`npm test`).

## Behaviour notes

- Placed instances keep their master's `kind`; instance identity is
  `componentId && !isComponent` (same test the canvas uses).
- Token priority is document order: the first variable with a matching value
  wins (built-in `spacing-sm` beats `radius-md` at 8).
- The API's `getComponents`/`getInstances` are the plural-list form of the
  roadmap's `get_component_set`/`get_instance`.

## Follow-ups (deliberately out of scope)

- P1.10 "Works with MCP" left unchecked: mappings live in the TS snapshot;
  the Rust stdio MCP server needs `.x` format + `mcp.rs` support (cross-track).
- Earlier phases' open items still stand: cross-file variable libraries,
  per-mode value grid, Quick Open thumbnails, canvas keyboard nav, UI scaling.
