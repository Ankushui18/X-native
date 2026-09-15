# Changelog

Notable changes to the engine, the editor, the CLI and the MCP surface. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the version numbers
are the crate versions in `Cargo.toml`, which still drift (see
[docs/KNOWN_DEBT.md](docs/KNOWN_DEBT.md) §8) until a release decision is made.

## [Unreleased] — 2026-09-16 (Vector Tools, and the Build They Needed)

### Added
- **A real vector offset.** `x_core::booleans::offset_path(cmds, distance, join)`
  flattens each cubic at 12 steps, builds per-vertex miter normals with a 4×
  miter limit that falls back to bevel, applies `Bevel`/`Round` corner
  treatments, and measures winding with `signed_area` rather than assuming it —
  so a positive distance grows a closed path outward and a counter-clockwise
  hole offsets the way the designer expects. A zero distance is refused instead
  of polygonising the path for nothing. `Editor::offset_vector` wraps it
  undoably. 7 tests. `crates/x-core/src/booleans.rs`.
  Reference: [Create designs](https://help.figma.com/hc/en-us/sections/4403912808599-Create-designs) — *Offset a vector path*.
- **One undo step per vector gesture.** `begin_path_gesture` snapshots the node,
  `live_rewrite_path` mutates the tree without logging, `end_path_gesture` pushes
  a single `ReplaceNode`; `undo`/`redo` drop a stale snapshot and Esc cancels it.
  A drag used to be one history entry per mouse-move event.
  `crates/x-editor/src/vector_edit.rs`.
- **Batch path operations**, all tested: `move_anchors_by`, `delete_anchors`
  (refuses to leave fewer than two anchors, re-roots a deleted `MoveTo`),
  `split_segment_at` (de Casteljau at t=0.5, so a split cubic keeps its shape),
  `simplify_path`, `reverse_path`, `split_path_at`, `translate_path`,
  `bend_anchor`, `move_handle_in`. Simplification is Ramer–Douglas–Peucker as a
  *keep mask*, so a survivor keeps its original command and a simplified curve
  stays a cubic; a bulge guard means it can never straighten a curve. 20 tests.
- **Text outlining goes through the real shaper.**
  `x_native::outline_text_node(node, fonts, vars)` derives every typography
  binding the renderer does, shapes through the same `x-text` pipeline the canvas
  uses, resolves natural line height exactly as `sinks.rs` does, elevates
  quad→cubic, and returns one `Vector` node carrying the text's transform, name,
  opacity, fill and fill stack. `crates/x-native/src/lib.rs`.
- **What you click is what is drawn.** `crates/x-editor/src/vector_handles.rs`
  hit-tests anchors, handles and segments in world space, and both the pointer
  and `paint_vector_points` now consume it, with tolerance scaling by zoom.
- **Vector-edit shortcuts:** ⌘E flatten, ⇧⌘O outline stroke, ⇧⌥⌘O outline text,
  ⇧⌘B split path at an anchor, ⏎/Esc in and out of node edit mode, ⌫ to delete
  selected anchors, arrows to nudge them (⇧ = 10px), ⌥-click to convert a curve
  point back to a corner, Tab/⇧Tab/⇧⏎/⏎ for layer-tree navigation, ⌘-click to
  deep-select. Palette presets for simplify at 0.5 / 1 / 4 px.
- **`FIGMA_CREATE_DESIGNS_COMPARISON.md`** — all 70 articles in Figma's *Create
  designs* help section compared against this codebase, one row each with
  `file:line` evidence and a five-level grade (23 match, 24 partial, 10
  engine-only, 2 dead-wired, 11 absent), ending in a P0/P1/P2 plan.

### Fixed
- **The workspace did not compile.** `x-editor` called `mark_dirty()`,
  `delete_node()` and `add_node()` from ~30 sites; none of the three existed on
  `Editor`. The 36 junk methods that called them are gone rather than stubbed,
  and every path operation now goes through the command log
  (`rewrite_path`, `push_replace`, `push_cmds`, `edit_batch`) so it is undoable
  and a refused operation pushes nothing.
- **`grid-auto-flow: column` never left column 0.** The scan was
  `for col { for row in 0.. }`, and `cells_free` answers true for any row past
  the end of `occupancy` — which `mark` grows on demand — so the unbounded inner
  scan always "found" a fresh implicit row in the first column and every child
  stacked vertically. The row scan is bounded by the declared rows, with a
  bounded implicit-row fallback. `crates/x-core/src/grid.rs`.
- **Three shortcuts were dead code.** ⇧⌥A (inverse selection), ⌥⌘C (copy
  properties) and ⌥⌘V (paste properties) had modifier-guarded arms *below* the
  unguarded ⌘A/⌘C/⌘V arms; rustc takes the first arm whose pattern matches, so
  the guards were never consulted and `unreachable_pattern` was reporting a real
  bug. The guarded family now precedes the plain one.
- **The prototype inspector's interaction loop closed 40 lines early**, leaving
  its easing / reset / remove rows outside the only scope that binds `i` and
  `ix`. While moving the brace: the loop computed `row_h` and painted a row that
  tall but never advanced `y`, so every interaction drew on top of the previous
  one. `y += row_h;` now ends the iteration.
- **Two flattens at one undo depth minted the same id.** `flatten_selected` used
  `format!("flat-{}", undo_depth())`; flatten pushes one group, so undoing a
  flatten put the depth back and the next flatten collided — and a duplicate id
  makes every `find` in the engine ambiguous. Now `fresh_id("flat")`, with a
  regression test that walks the collision path. Flatten also carries over name,
  opacity, effects and effect layers, plus a single shape's materialised paint
  stacks (a group's describe the group, not the baked geometry).
- **`offset_vector` was a translation, not an offset** — it added `distance` to
  both x and y of every point. Deleted in favour of `offset_path`.
- **Two fake text outliners deleted**: one emitted the text node's bounding
  rectangle, the other a `0.6 × font_size` box per character.
- **`paint_vector_points` destructured `NodeKind::Vector(v)` and read
  `v.segments`** — `Vector` is a struct variant holding `path: Vec<PathCmd>`, and
  there is no `segments` field in the model. Rewritten onto `anchors_world` /
  `handles_world`.
- **The P / V / X / Q / E "vector tool shortcuts" block ran outside vector edit
  mode and `return`ed**, so V no longer selected the Select tool. Scoped to the
  mode; ⌘E is flatten.
- `Action::SetGradientType` bound `let Some(id)` and never read it; the selection
  is a precondition there, so it is an `is_none()` guard now.

### Removed
- `x-core/src/p0_features.rs` (258 lines, never declared as a module) and
  `x-render/src/vector_network.rs` (769 lines rendering a type deleted from
  `x-core` on 2026-09-02); 32 unreachable `Action` variants, 8 phantom types
  (`MirrorMode`, `JoinStyle`, `ShapeOperation`, `SelectionMode`, `ArrowStyle`,
  `DashPattern`, `VectorTool`, `StrokeCapType`) and 3 unused fields. `dispatch`
  is now exhaustive over all 172 variants — four prototype variants that nothing
  constructed were a hard `E0004`, not dead weight.

### Changed
- **`DEAD_CODE_CEILING` re-measured 76 → 82**, upward, because the previous
  number was measured on 12 Sep and the tree stopped compiling afterwards: a
  workspace that does not build reports no dead-code diagnostics at all, so the
  count was remembered rather than measured. The first gate run that could see
  the whole workspace again reported 84; this branch deletes two of them
  (`extra_y`, write-only state in the prototype panel) on top of 1,027 lines of
  orphan files. `docs/KNOWN_DEBT.md` §1 now names every item, and
  `scripts/check.sh` prints the list when the ratchet trips — a count that does
  not say *which* warning cannot be acted on from a PR comment, which for a
  checkout without a toolchain is the only channel there is. It also prints each
  failing test's panic payload, for the same reason.

## [Unreleased] — 2026-09-15 (Text Styles & Variable Typography)

### Added
- **Text styles are reachable from the inspector.** `Document.styles` was
  already serialized in `.x` and already applied through `LegacyStyle::Text`,
  but nothing in the UI could create, apply, update or detach one. The
  Typography header's two icons now own hit rects: the styles button opens a
  picker that lists the registry (the applied style highlighted), and the plus
  creates a style from the selection. Rows offer *Update '<name>' from
  selection* and *Detach style* when the selection is linked, and *Create text
  style* when it is a text layer. A style carries typography only — family,
  weight, size, line-height mode + value, letter spacing, paragraph spacing and
  indent, case, synthesized small caps, decoration, list style, wrap and wrap
  style, hanging punctuation — which is Figma's included/excluded split:
  alignment, fill and resizing are deliberately not part of a style. Editing a
  definition re-resolves every consumer on every page through
  `mutate_visual_stack`, so propagation is undoable per node.
  `App::{apply_text_style, create_text_style_from_selection,
  detach_text_style_from_selection, update_text_style_from_selection}` in
  `apps/x-designer/src/bin/x_native_app/run.rs`; `x_native::detach_text_style`
  and the registry façade on `Document` in `crates/x-core/src/document.rs`;
  picker in `apps/x-designer/src/bin/x_native_app/editor_ui.rs`.
  Reference: [Create and apply text styles](https://help.figma.com/hc/en-us/articles/360039957034-Create-and-apply-text-styles).
- **Variables bound to typography resolve at render time.** `fontsize`,
  `lineheight` and `letterspacing` bindings now reach both render paths
  (`crates/x-render/src/ir.rs`, `crates/x-render/src/scene.rs`), mirroring the
  existing `w`/`h`/`radius` parametric pattern: the variable supplies the
  number, the node's `lhm` still owns the line-height *mode*, and a missing
  token falls back to the literal, so unbound documents render exactly as
  before.

### Fixed
- **The Line-height dropdown painted 89px above its field.**
  `paint_lh_dropdown` anchored on `ED_TITLE_H` instead of the panel's `y_entry`
  — the chrome sum `paint_frame_dropdown` builds (`8 + 24 + 10 + PILL_H + 10 +
  1`, plus 12 to the first row) — so the menu floated over the rows above it.
  Both typography dropdowns now derive one anchor from `y_entry`.

## [Unreleased] — 2026-09-15 (Text Formatting)

### Added
- **Comprehensive text formatting properties (Figma Design parity).** 11 new
  fields on `Node` matching Figma's typography system:
  - **Text alignment.** Horizontal (`left` / `center` / `right` / `justified`)
    and vertical (`top` / `middle` / `bottom`). Enums: `TextAlign`,
    `TextAlignVertical`. Persisted as `"text_align":"center"` etc.
  - **Text decoration.** `underline` and `strikethrough` via `TextDecoration`
    enum. Persisted as `"text_decoration":"underline"`.
  - **Text case transformation.** `original` / `upper` / `lower` / `title`
    via `TextCase` enum. Non-destructive display transform (underlying text
    unchanged). Persisted as `"text_case":"upper"`.
  - **Text truncation.** `disabled` / `end` (with ellipsis) / `middle` via
    `TextTruncation` enum, plus optional `max_lines: Option<usize>` to limit
    visible lines. Persisted as `"text_truncation":"end"` and `"max_lines":3`.
  - **Paragraph spacing.** `f64` value in pixels for inter-paragraph distance.
    Persisted as `"paragraph_spacing":8.0`.
  - **Paragraph indent.** `f64` value in pixels for first-line indent.
    Persisted as `"paragraph_indent":16.0`.
  - **Hanging punctuation.** `HangingPunctuation` struct with `quotes: bool`
    and `lists: bool` to allow marks to hang outside the text box. Persisted
    as `"hanging_punctuation":{"quotes":true,"lists":true}`.
  - **List styles.** `none` / `bulleted` / `numbered` via `ListStyle` enum.
    Persisted as `"list_style":"bulleted"`.
  - **Wrap style.** `normal` / `break-word` via `WrapStyle` enum for
    controlling line-breaking behavior. Persisted as `"wrap_style":"break-word"`.
  All properties serialize only when non-default (backward compatible with
  old `.x` files). Full implementation guide: `TEXT_FORMATTING_IMPLEMENTATION.md`.
  Reference: [Figma text properties](https://help.figma.com/hc/en-us/articles/360039956634-Explore-text-properties).

## [Unreleased] — 2026-09-14 (Follow-up: Figma Design Feature Parity)

### Added
- **SmartAnimate interpolation engine.** New `smart_animate` module in `x-core`
  provides frame-to-frame morphing for prototype transitions. `interpolate_frames()`
  collects all nodes from two frames, matches by ID, and interpolates position,
  size, opacity, rotation, corner radius, and fill color. Nodes present in one
  frame but not the other fade in/out. Includes easing functions (linear, ease-in,
  ease-out, ease-in-out, cubic variants). 6 unit tests.
- **Corner smoothing (squircle).** New `Node::corner_smoothing: f64` field
  (0.0–1.0) enables Figma-style continuous corners (superellipse geometry).
  The renderer generates squircle paths using a parametric superellipse formula
  `|x/a|^n + |y/b|^n = 1` where `n = 2 + 4 * smoothing`. Builder method:
  `node.smooth_corners(0.6)`. Persisted in `.x` format as `"smoothing":0.6`
  and emitted in dev-mode CSS as a comment (CSS has no native squircle).
- **Multiple actions per interaction.** `Interaction` struct now carries
  `actions: Vec<Action>` in addition to the legacy `action: Action` field.
  When `actions` is non-empty, `all_actions()` returns all actions for
  sequential execution. Figma parity: a single trigger can now navigate,
  set variables, and play sounds in sequence. Serialized as `"actions":[...]`
  when more than one action is present (backward compatible with old files).
  Builder: `Interaction::with_actions(trigger, vec![...], ms, anim)`.

## [Unreleased] — 2026-09-14 (Follow-up: Real Gap Fixes)

### Added
- **Grid dense auto-flow (CSS `grid-auto-flow: dense`).** New `GridAutoFlow`
  enum with `Row` (default), `Column`, and `Dense` variants. Dense mode
  backfills empty cells by re-scanning from the origin on every placement,
  matching CSS's dense packing algorithm. Column-major fills top-to-bottom
  then wraps to the next column. Persisted in `.x` format and emitted in
  dev-mode CSS as `grid-auto-flow`.
- **Z-index for auto-layout children.** New `Node::z_index: Option<i32>`
  field controls paint order within auto-layout frames. Higher values paint
  on top of siblings; `None` uses document order. The renderer now sorts
  children by z_index before encoding (stable sort preserving document order
  for equal z-levels). Persisted in `.x` format and emitted in dev-mode CSS
  as `z-index`.
- **CRDT architecture document.** `docs/CRDT_ARCHITECTURE.md` describes the
  planned path to collaborative editing: CRDT type selection (Loro tree CRDT
  for hierarchy, LWW registers for properties, RGA for children arrays),
  operation model, network protocol, 5-phase rollout plan, and migration
  strategy. Not yet implemented — architecture only.

## [Unreleased] — 2026-09-14

### Added
- **CSS Flexbox parity (Figma Jul-2026 auto-layout update).** The auto-layout
  solver now matches the updated Figma behavior where inside strokes, padding
  minimums, and border-box fill-container distribution work like CSS flexbox
  out of the box:
  - **Inside strokes included in layout.** A frame's inside stroke width adds
    to its effective padding — hug frames grow to include it, fixed frames
    clamp to at least their padding + stroke total. Outside and center strokes
    never affect layout (they behave like CSS `outline`).
  - **Padding minimum enforced.** A frame can no longer be sized smaller than
    its padding total (matching CSS `border-box` where padding always gets its
    room).
  - **Border-box fill-container distribution.** Children set to fill container
    share the available content area (not total width), so a child with a
    thicker inside stroke gets proportionally more total space, keeping content
    areas equal across siblings.
  - **Auto-gap stacks never overlap.** Gap in auto-spacing (Between/Around/
    Evenly) stacks clamps at 0 — children collapse to the start instead of
    overlapping when they don't fit.
  - **Canvas stacking order.** New `CanvasStacking` enum (`LastOnTop` /
    `FirstOnTop`) on `AutoLayout` controls paint order in negative-gap
    (overlapping) stacks, matching Figma's canvas stacking setting.
  - **Stroke-aware dev-mode CSS.** Inside strokes emit `border` with
    `box-sizing: border-box`; outside/center strokes emit `outline`.

### Changed
- `AutoLayout` now carries `stroke_include_in_layout: bool` (default `true`)
  and `canvas_stacking: CanvasStacking` (default `LastOnTop`). The manual
  `Default` impl replaces the derived one to set `stroke_include_in_layout`
  to `true` (matching Figma's new-frame default).
- `Node` gains `inside_stroke_width()` — returns the maximum width among
  visible inside-aligned stroke layers, for layout calculations.

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
- **Prototype player (Figma parity) in `x_editor::prototype` + the app's
  chrome-less flow viewer.** 9 triggers / 10 actions — `MouseUp` and
  `OpenLink { url }` are new, and both round-trip through `.x` (`"mouseup"`,
  `"link"`) — driven by one shared engine (`fire_action`, `Player`, `Overlay`,
  `WhileSpan`) that the editor player, the app preview and the panel all use,
  so playback cannot disagree with the panel. Figma's "while hovering" /
  "while pressing" auto-reverse: leaving the hotspot or lifting the pointer
  undoes the navigate/overlay the span armed, and only if the player still sits
  in that result. `ScrollTo` pans within the screen (no history, no overlay
  churn), swap-from-a-bare-frame navigates without pushing history, overlays
  anchor to the frame (`overlay_offset`) and are hit-tested at their rendered
  position, and preview playback runs against a copy of the document variables
  so a prototype can never edit the file. Links open in the system browser only
  when a window exists (headless hosts just report the URL).
- **`Elevation` tokens and shared design scales.** `x_ui::Elevation`
  (Flat/Raised/Floating/Overlay/Modal) turns an intent token into twelve
  normalised translucent shells — the alphas sum to the token's alpha — and
  every shadowed surface now names its intent instead of a blur radius.
  `theme.rs` derives its radii from `RadiusScale` and its type steps from
  `TypographyScale` (T10/T20 replacing the ad-hoc 9/24/28px steps), tracked
  labels collapse into `TextUi::micro_label` / `caps_label`, icons stroke at a
  constant 1.5 device px (`IconScale`) at any size, and the rulers show the
  selection's extent plus a pointer marker clamped to the canvas.

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
- The prototype-player pass did not compile on the workspace's Rust 2021
  edition: nine `if`/`while` **let chains** (`if a && let Some(b) = c`) are a
  Rust 2024 feature (E0658) and are now plain nested guards, which also
  un-breaks `cargo fmt` (rustfmt refuses to parse the file); `Trigger::label`
  carried `MouseUp` twice (unreachable pattern, E0416); and a test had one
  closing paren too many. `cargo test --workspace` now reaches the new engine
  (10 host + 12 engine + 1 format suites).
- The prototype player's own semantics, once those suites could run:
  `Player::drag_to` answered "an `OnDrag` was found" rather than "the drag
  fired", so an inert `Back` (empty history) swallowed the whole
  press-drag-release cycle — it now keys on `FireEffect::fired()`, exactly
  like `click` / `key` / `tick`, and the flow viewer's `flow_fire_trigger`
  mirrors it. `Player::enter` reset the hover/drag state and the overlays but
  not the navigation history, so a "while hovering" span abandoned by a
  re-entry left its push on the stack and a later `Back` popped a screen the
  player had already left; `enter` is a fresh session now, the way the host's
  `flow_enter` (a fresh `FlowState`) always was. `leave_hover_span` /
  `release_press_span` also took their span out of `self` before handing it to
  `revert_span` — the double mutable borrow (E0499) that stopped the crate
  compiling.
- `cargo build --workspace` / `cargo test --workspace` failed before reaching a
  single test: the app crate held four errors nothing had ever compiled — a
  `match *i` on a `usize` (E0614), a `&mut self` call inside a borrow of
  `self.variables` while drawing the Variables panel (E0502), an `app` borrow
  inside `sq_btn_small`'s own argument list (E0499), and a call to
  `App::has_clipboard_content`, a method the QA-001 comment promised but that
  was never written (E0599) — plus an `Affine::transform_point` call in
  `x_editor::transformed_resize` that does not exist in kursbo.
- Frame/section name labels are drawn on the canvas (QA-004), so every glyph of
  a frame's name is a path in the scene stats. The render tests that asserted
  exact path counts predated that and are now label-aware instead of
  hardcoding sums that only hold for unnamed frames.
- `clippy::neg_cmp_op_on_partial_ord` on the `!(a > b)` / `!(a >= b)` guards in
  `x_editor::shape_builder` and `x_editor::transformed_resize`. The checks are
  intentionally NaN-rejecting (a NaN size reaches the document and every
  export), so they now read `gt`/`ge` helpers instead of the negated
  comparison; the naive `a <= b` rewrite would have accepted NaN.
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

- A component **color property bound to `stroke`** repainted the interior of
  the node it was bound to: `OverrideValue` had no stroke arm, so both write
  sites (`x_core::PropRegistry::apply`, `Editor::set_prop_value`) emitted a
  `Fill` (docs/KNOWN_DEBT.md §4). `OverrideValue::Stroke` now encodes
  `stroke:#rrggbb` — decoded before the bare-hex fallback, which still means
  fill — `x_core::color_override` picks the arm from the property's
  `target_property`, and `x_core::apply_stroke_paint` gives a zero-width
  stroke a 1px width and recolors materialized stroke layers so the write is
  visible. Both appliers and the two renderer encoders (`ir::lower`,
  `scene::encode`) honour the override; §4 records what is left (the duplicate
  enum's missing `Number` variant, Sketch export dropping `stroke:` overrides).

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
