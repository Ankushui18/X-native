# Changelog

Notable changes to the engine, the editor, the CLI and the MCP surface. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the version numbers
are the crate versions in `Cargo.toml`, which still drift (see
[docs/KNOWN_DEBT.md](docs/KNOWN_DEBT.md) §8) until a release decision is made.

## [Unreleased] — 2026-09-12

### Added
- **Transformed (rotation-aware) corner resize.** `x_editor::transformed_resize`
  does the corner-drag math in the node's own frame and solves for the position
  that keeps the corner the user is NOT dragging pinned in world space —
  `plan_resize`, `world_corners`, `local_point`/`local_to_world`, `corner_at`,
  plus `Editor::resize_transformed` and a new `Command::ResizeTransformed` so a
  rotated resize is one undo step that restores size AND position. Previously
  `Command::Resize` wrote only `w`/`h`, so a rotated layer slid off its own
  selection outline while being resized.
- **Shape Builder overlap validation.** `x_editor::shape_builder` measures
  `|A ∩ B| / min(|A|, |B|)` from the real boolean geometry (the same
  "fraction of the smaller box" the audit toolkit reports) and refuses with a
  reason: `NotEnoughSelection`, `UnsupportedNode` (naming the layer),
  `DegenerateGeometry`, `Disjoint`, `FullyNested`. Union/Subtract in the canvas
  menu now go through it, so merging two shapes that never touch no longer
  yields a compound path of unrelated islands, and subtracting a shape that
  fully covers the other no longer silently deletes a layer — the status bar
  says why instead.
- **Parametric resize synchronization.** `Node::bind("w" | "h" | "radius" |
  "opacity", var)` round-tripped through the file format but nothing ever read
  it back. `x_editor::parametric` now resolves those bindings (variable → node)
  and writes them back on a manual resize (node → variable), so every other
  node bound to the same token follows in the same undo step; pinned children
  re-sync via `apply_constraints` and corner radii clamp to the new box.
  Wired into the inspector's W/H fields and the frame presets.
- **World-space vector handles.** `x_editor::vector_handles` is the coordinate
  layer `vector_edit` was missing: `anchors_world`, `handles_world`,
  `anchor_at_world`, `handle_at_world`, `segment_at_world` and world-space
  `drag_anchor_world` / `drag_handle_world` / `pen_add_anchor_world` /
  `split_segment_world`. Path data is node-local, the pointer is world — hit
  testing in local coordinates missed every handle on a placed node, and was
  outright wrong once the node was rotated. The canvas paints anchors, control
  handles and tangent lines through this layer when the Pen tool is active.
- **UI themes with a contrast audit.** `x_native::ui::ColorTokens` is now the
  single source of truth for interface color: 22 semantic roles across three
  palettes — Graphite (dark, default), Daylight (light), High Contrast.
  `crates/x-ui/src/theme.rs` adds `ThemeId`, the WCAG 2.1 relative-luminance
  and contrast-ratio functions, and `contrast_audit()`, which checks every text
  role against every surface it can be painted on (47 pairs per palette, plus
  labels on accent fills and the 3:1 indicator floors).
- **Runtime theme switching.** The application derives its `theme::C_*`
  constants from `ColorTokens::GRAPHITE` at compile time and maps them through
  `theme::resolve` at paint time, so a palette switch repaints every panel,
  row, border and label — while content colors (artwork, smart guides,
  watermarks, avatars) are deliberately never remapped. Reachable from the
  TOKENS panel button, the command palette, and `Action::SetTheme` /
  `Action::CycleTheme`.
- **`x_native theme audit | theme tokens`.** Audit the shipped palettes from a
  shell (exit 4 on any pair below its floor) and export one as W3C DTCG JSON to
  keep a design file's variables in step with the app theme.
- **Workspace lint policy** (`[workspace.lints]` + `[lints] workspace = true`
  in every member): `unsafe_code = "deny"`, `unused_must_use = "deny"`, clippy
  `correctness`/`suspicious` denied, `dbg_macro`/`todo` denied. The one file
  that legitimately needs `unsafe` — the counting allocator in
  `bench_scale.rs` — carries a documented `#![allow(unsafe_code)]`.
- **`scripts/check.sh`** — one script for fmt, clippy (with a dead-code
  ratchet), tests, dangling `docs/*.md` references and a CLI smoke run;
  `--quick` for pre-commit, `--fix` to run the mechanical repairs.
- **`.github/workflows/ci.yml`** runs that script on push/PR and imports
  `crates/x-format/tests/fixtures/circle.fig` end-to-end (`import-fig` →
  `lint` → `analyze` → `info` → `export -f svg`), then runs the CLI and MCP
  unit tests in release.

### Changed
- Lint is preset-driven: one rule table (15 rules) feeds `recommended` /
  `strict` / `a11y` / `all`, `--rule` / `--ignore` compose on top,
  `--fail-on error|warning|never` decides the exit code, `--json` emits counts,
  rules fired and findings, and `--list-rules` prints the table the MCP
  `list_lint_rules` tool returns from the same source.
- `analyze` gained `adoption` (defined vs bound vs dead variables), `--top`,
  `--min-overlap`, `--min-cluster` and `--emit-variables OUT.x`, which writes a
  document copy carrying one typed variable per extracted token and only ever
  adds the missing tail.
- `find` filters: `--type`, `--name`, `--name-is`, `--id`, `--under`,
  `--min-w/--min-h/--max-w/--max-h`, `--visible`, `--static`, `--limit`; exit 3
  when nothing matched.
- MCP server is at parity with the CLI (11 tools), including `inspect_tree`,
  `lint_design`, `list_lint_rules`, `analyze_design` and a dry-run
  `extract_variables`; `node_code` now also emits Tailwind.
- CLI verbs live in `apps/x-designer/src/bin/x_native/toolkit.rs`; the driver
  handles help/version/dispatch. Output goes through an EPIPE-safe emitter, so
  `| head` never panics, and every verb has `--help` that cannot drift from the
  parser.

### Fixed
- Rotated layers drew an axis-aligned selection outline and corner handles
  (taken from `transform.x/y` + `w/h`) while the renderer drew the shape
  through `transform.matrix` — the box was nowhere near the artwork, and
  grabbing a handle missed. Outline, handles and resize hit-testing now share
  one transform-aware geometry (`editor_ui::is_transformed`).
- `Editor::move_handle` did not regrow the node's bounds, so dragging a bezier
  control handle outside the box left the curve clipped by stale `w`/`h` and
  invisible to hit-testing and marquee. `move_anchor` already did this;
  handles now match.
- A dead block in `vector_edit::set_anchor_pos` computed the anchor position
  and discarded it (`let _ = (ax, ay)`); removed, with the comment pointing at
  `move_anchor`, which owns the outgoing control point.
- Contrast failures in the default dark theme: secondary text (was 3.87:1 on
  active rows), destructive labels painted in the danger red (was 2.6–4.6:1),
  and the accent fill under white button labels (4.38 → 5.39:1 by deepening
  `#7C5CFC` to `#6B49F5`). `#7C5CFC` survives as the `selection` role and a new
  `accent_ink` role carries accent-colored text at 7.78:1.
- `hairline border` and `text_placeholder` are exempt from the 4.5:1 text floor
  (WCAG excludes disabled content); selection and focus indicators are held to
  3:1 instead of being reported as failures.
- A stale comment and a tautological `assert!(true)` in
  `crates/x-core/src/styles.rs`: `StyleUsage::get_users` was described as a stub
  while the test that proved it works asserted nothing. It now checks that
  removal is observable and that the last user drops the entry.
- Duplicate theme vocabularies: the command palette and the (unwired) context
  menu each carried their own hexes — the menu was a blue-on-`#111` theme
  inside a violet-on-`#1B1D23` application. Both now derive from the roles.
- `x_native lint --list-rules` printed the table only when a document was
  supplied (it demanded a file first, then unwrapped an absent document). The
  rule table is a lookup, so it now works in a fresh checkout — with `--json`
  too — while `lint` without a file still exits 2 with a usage message.
- Dead constants `TEXT_PRIMARY` / `TEXT_SECONDARY` / `ACCENT` / `ICON_SIZE` and
  thirteen unused brand aliases removed; UI code names a role instead.

## [0.34.0] — 2026-09-12 (`69315b0`)

Headless toolkit at parity with the reference implementation: `tree`, `find`,
`node`, `info`, `lint`, `analyze`, `tokens`, `convert`, `validate`,
`export-jsx`; Tailwind arbitrary-value codegen; the TOKENS panel;
`kiwi::decode_root` visibility tightened.

## [0.34.0] — 2026-09-12 (`360c5ac`)

Prototype authoring (interactions, flow arrows, play preview), variant
switching on instances, and `Load Font…` for the canvas font stack.

## [0.34.0] — 2026-09-12 (`f64ee9a`)

`.fig` binary import through the kiwi container, static HTML/CSS site export
with `@font-face` subsetting (`glyf` only; CFF falls back to a whole-font
copy), and a PNG optimizer pass.

## [0.34.0] — 2026-09-11 (`6248cb8`)

Repository audit: build artifacts stripped, `.gitignore` extended, and the full
workspace build repaired (`cargo check --workspace --all-targets` green again).
