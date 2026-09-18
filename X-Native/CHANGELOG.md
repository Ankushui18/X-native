# Changelog

Notable changes to the engine, the editor, the CLI and the MCP surface. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the version numbers
are the crate versions in `Cargo.toml`, which still drift (see
[docs/KNOWN_DEBT.md](docs/KNOWN_DEBT.md) §8) until a release decision is made.

## [Unreleased] — 2026-09-18 (Brush)

Figma Draw's **Brush** — the tool beside the Pencil in the same toolbar — is now on the
canvas: ⇧B selects it, the gesture is the pencil's, and the mark it leaves is a painted
outline whose width, taper and edge grain come from the selected style.

- `x_core::brush_outline(points, width, taper, grain, eps)` turns a freehand stroke into a
  CLOSED path: the centreline is simplified, resampled at a uniform pitch, smoothed, then
  offset to both sides by a half-width that tapers toward the ends and carries a
  deterministic bristle grain (no randomness — the same points and style always give the
  same mark). `x_core::path_bounds` / `shift_path` re-origin it onto its own box.
- `Tool::Brush` (⇧B, design-only like the Pencil) is the dock's fourteenth tool, a palette
  row ("Brush tool"), and Esc leaves it; it stays active between strokes.
- One mark = one `NodeKind::Vector`, named "Brush n", filled with the brush's ink and
  stroked with nothing (the mark IS the outline), selected when it lands, drawn inside the
  frame it was drawn in (Space opts out), and one insert = one undo step.
- `state::BrushStyle` — Ink, Marker, Dry — is the one table the live preview and the landed
  layer read; the Design column shows a **BRUSH STYLE** block while the brush is active
  (Figma keeps the style in the secondary toolbar and in the right sidebar's stroke
  settings), and the palette carries one row per style.
- The layer's box is the MARK's own: the ink reaches half a width past the centreline, so a
  box taken from the sampled points alone would be smaller than the geometry it describes
  (the selection box, the panel's W/H and a frame's clip all read it).
- Documented divergence: Figma's brush styles are user-made shapes stretched or scattered
  along a stroke ("Create brush" from a closed vector layer, file-scoped); this build ships
  three styles rather than a library, and does not sample a style off an existing stroke.

## [Unreleased] — 2026-09-18 (Constraints)

Figma's **Constraints** block — the beginner course's fourth chapter, "Frame presets and
constraints" — is the two-dropdown table in the Design tab that decides how a layer
answers the resize of the frame it sits in. The engine had the table
(`x_editor::constraints::apply_constraints`, Phase 2.12) and one caller, the inspector's
W/H fields; the canvas never answered it, and nothing in the app could set a pin.

### Added
- **The panel's CONSTRAINTS block** — one row per axis, Figma's five answers each
  (Left / Right / Left & Right / Center / Scale, Top / Bottom / Top & Bottom / Center /
  Scale), from the single table in `state.rs::CONSTRAINT_H` / `CONSTRAINT_V`; picking one
  writes `Node::pin` through `Editor::set_pin` (undoable) and the block only appears for a
  layer inside a frame, which is what the course describes.
- **`x_editor::pin_deltas`** — the pin table as one solver, shared by both writers.
- **`x_editor::pin_commands`** — the same solver as `Move`/`Resize` commands, so a frame's
  corner drag carries its pinned layers inside the same undo entry.
- **`Editor::resize_with_constraints`** — the resize the canvas uses (a multi-layer drag
  included) when a frame is in the selection.

### Changed
- **`apply_constraints` recurses into nested frames only** — a child that actually
  changed size hands the resize on to its own pinned children, and a group (which
  resizes with its own contents) is refused, matching what Figma's table covers.

## [Unreleased] — 2026-09-18 (The Pencil tool)

Figma's **Pencil (⇧P)** is a freehand stroke that lands as an editable vector path. The
engine had the first half of it — `simplify_polyline`, whose doc comment has said
"(pencil tool)" since the vector pass — with no caller, and the canvas had no freehand
tool at all.

### Added
- **`Tool::Pencil` (⇧P)** — design-only (a board keeps freehand on its own pen), the
  thirteenth tool in the dock, a palette row, and a tool that stays active between
  strokes the way Figma's does, leaving only for another tool or `Esc`.
- **`x_core::freehand_path(points, eps)`** — the tested half of the fit: the samples are
  simplified with `simplify_polyline` and each surviving point becomes a smooth cubic
  through its neighbours (a Catmull-Rom pass with 1/6 control offsets), so a sketch is
  curves the vector editor can edit point by point rather than a chain of segments.
- **The stroke is a normal vector layer**: `NodeKind::Vector`, named for the layers
  panel, selected when it lands, drawn inside the frame it was drawn in (the same
  draw-it-in rule as every other creation tool, Space included), and one insert = one
  undo step. Holding ⇧ while drawing collapses the stroke to a straight line, the tip
  on the same help page. Its stroke is Figma's default — a round 3px ink — materialized
  as an ordered stroke layer, so the inspector shows the stroke the sketch actually has
  (`the_pencil_draws_a_smoothed_stroke`, plus three engine tests for the fit).

## [Unreleased] — 2026-09-18 (The Slice tool)

Figma's **Slice tool (S)** had an engine behind it and no door: `NodeKind::Slice`,
`build_render_tree_slice` and the `.x` round-trip were all there, but nothing on the
canvas could draw a slice, so the export path could never be reached from a layer that
exists only to be exported.

### Added
- **`Tool::Slice` (S)** — drag a region; it lands as a slice named for the layers panel,
  selected, and the tool returns to Move (`V`/`Esc` leave it like the other drawing
  tools). The toolbar has a twelfth tool, the palette has "Slice tool", and the layers
  row carries the scissors icon a slice deserves.
- **Slice chrome**: every visible slice is drawn as a dashed outline with its name above
  it — the region is a region, not a layer, and a slice drag previews dashed and unfilled
  for the same reason.
- **A slice exports the region it covers.** `prepare_export` now builds the slice's tree
  through `build_render_tree_slice`: the flattened page content inside its bounds,
  re-origined to (0, 0), with the slice's own size as the canvas — Figma's "anything that
  overlaps the slice will be exported". An empty slice still exports its size (a
  transparent image); a selection that mixes a slice with other layers is refused with a
  reason instead of silently exporting half of it
  (`a_slice_exports_the_content_inside_its_bounds`, `an_empty_slice_still_exports_its_size`,
  `a_mixed_selection_refuses_to_guess`, `the_slice_tool_draws_an_export_region`).

## [Unreleased] — 2026-09-18 (The Scale tool, and Frame selection)

Figma's **Scale tool (K)** and **Frame selection (⌥⌘G)** were already in the engine —
`Editor::scale_node` carried a test, `Editor::frame_selection` carried two — with **no
caller anywhere in the app**: no tool, no shortcut, no palette entry. Both are reachable
now, and the scale was taught Figma's own list of what travels with the box.

### Added
- **`Tool::Scale` (K) — the box scales, and everything inside it scales with it.** The
  Scale tool sits beside Move in the toolbar and in the palette, `K` selects it (`V` and a
  bare `Esc` bring Move back, selection intact), and the
  same four corner handles the Move tool uses now grow the layer itself: child offsets,
  stroke weight and dash patterns, corner radii, text size and leading, effect distances,
  and auto-layout padding/gap. The anchor is the corner **diagonally opposite** the
  handle you grabbed — Figma's fixed point, so the layer grows from the corner you are
  not holding — and one rule (`state::scale_drag_factor`, plus `scaled_box` for the paint)
  drives both the live ratio chip and the commit
  (`the_scale_tool_grows_a_layer_from_the_corner_you_are_not_holding`,
  `scale_tool_takes_text_effects_and_layout_with_it`). `apps/x-designer`,
  `crates/x-editor`.
- **⌥⌘G frames the selection.** Figma's Frame selection shortcut now reaches
  `Editor::frame_selection`: the selection goes into a new Frame sized to the members'
  collective bounds, a single layer included, and the members keep their page positions
  (`option_command_g_wraps_the_selection_in_a_frame_like_figma`). An empty selection is
  refused with a reason instead of making an empty frame, and ⌘G without ⌥ still groups.
- **`Editor::scale_nodes_about`** — a multi-layer scale is ONE gesture: one
  `ReplaceNode` per selected root, pushed as a single undo step, and a listed node whose
  ancestor is listed too is skipped rather than scaled twice
  (`scale_about_an_anchor_pins_it_and_is_one_undo_step`).

### Fixed
- **A locked layer is not scaled.** Figma's scale article is explicit ("with the
  exception of locked layers"); the rule is enforced in the engine, not only in the
  selection.

## [Unreleased] — 2026-09-18 (Canvas chrome: one rule for names, real double-click)

Follow-up to the owner's report — *"why is the page name shown as the canvas frame
name, and it stays after I delete the frame"*, *"why is the page name used for
renaming pages, the pages are not getting deleted properly"*, *"double-clicking is
not selecting the elements in the right panel"*. The audit behind the fixes
(Figma vs X-Native, and why this class of bug kept coming back) is
[docs/AUDIT_2026-09-18_FIGMA_PARITY.md](docs/AUDIT_2026-09-18_FIGMA_PARITY.md).

### Removed
- **The page name is no longer painted on the artboard.** A canvas name label was
  emitted for *every* frame, including the render root — and on the canvas the
  root is the PAGE. That is the "frame name" that stayed after everything on the
  page was deleted. The root of a render is now unlabelled in both encoders, so
  the page's name lives only in the pages list (and, on an export or a thumbnail,
  the exported object's name no longer lands in its own artwork).
  `crates/x-render`.
- **Frames nested inside other frames are unnamed**, matching Figma ("when nesting
  frames to organize them, only the top-level / outermost frame title is shown").
  A frame inside a **Section** keeps its name (Figma: frame names stay visible in
  sections), as do master-internal frames' absence — an instance's internals are
  silent. `crates/x-render`.
- **The empty-frame name watermark** (`frame_watermarks` / `watermark_shadows` /
  `watermark_labels`): it painted a node's name in 28px `black/10` across every
  empty top-level frame in demo mode — the same defect class as the page-name
  label, one layer up. `apps/x-designer`.
- **`build_render_tree_bucket_shell`**: the second lowering entry existed only to
  disagree with the first about the root's label. `build_render_tree_with_hidden`
  is now the sole entry, used by the canvas buckets, exports and previews alike.

### Fixed
- **Names are chrome, so they sit above the frame, not on it.** A frame or section
  name is drawn in the gutter above its top-left corner (`LABEL_ABOVE_Y = -26`)
  instead of inside the artwork at `(14, 10)`, and one constant (`LABEL_SIZE`)
  replaces the 14/18/20 px disagreement between the two encoders and the two arms.
- **Renaming a page is a page operation.** `commit_page_rename` writes
  `doc.pages[i].name` and mirrors it onto the root frame (some surfaces read a
  root's name directly — flow labels, thumbnails, SVG ids); the guard compares the
  PAGE's name, so the no-op case is "the page already says this" instead of
  comparing against the mirror.
- **Deleting a page deletes the page you clicked.** One implementation
  (`App::delete_page`) serves the rail's ✕ and the page menu; it no longer selects
  the row first, the ✕ appears on the active row too (Figma allows both), and the
  last page is still protected. The ✕ hit zone now wins over the row's
  `SelectPage` (zones are scanned in reverse; the row must be pushed first).
- **Every page is reachable.** The Pages band windows over the list
  (`PAGES_MAX_ROWS`) instead of replacing its last row with a sentinel whose index
  was the page COUNT — pages past the 3rd had no row and could not be selected,
  renamed or deleted.
- **A double-click in the chrome is a single click.** Toggle-class rows (the fill
  colour swatch, the fill/stroke variable-style library, component prop switches,
  disclosure toggles, popover buttons) are counted once per double-click window,
  so the popover the first press opened is not shut by the second. Steppers and
  Add-row still repeat. `apps/x-designer`.
- **Re-opening the field you are already editing keeps your text** — the second
  press of a double-click in a numeric or hex field used to re-seed the buffer
  from the document and discard what had been typed.
- **Canvas double-click drills one level**, as Figma documents ("double-click …
  to select one level of nesting down"), instead of jumping to the deepest leaf in
  one gesture; ⌘/Ctrl-click still deep-selects in one press.

### Fixed
- **One owner per design decision.** Three decisions were written out at more than
  one site and had already drifted or were held together by a comment: the canvas
  name label's ink (four sites across two encoders — one arm faded a name to 70%
  while the other three did not, so the same frame's name was a different grey on
  the canvas than in an export), the missing-asset grey (three sites, one of them
  annotated *"matches the Vello sink"*), and the pattern fallback grey (two sites).
  Each is now one definition — `ir.rs::label_ink()` and
  `crates/x-core/src/fallbacks.rs` — used everywhere. `crates/x-core`,
  `crates/x-render`.

### Added
- **A Section's name is the chip Figma draws, not a frame-style label.** It was a
  grey 18px label in the gutter, identical to a frame's; it is now a rounded chip in
  the section's own colour, sized to the name (with a per-character estimate that
  the direct encoder shares, so the canvas and an export draw the same chip) and
  clamped so it never grows past the section it names. Two consequences worth
  naming: a section's chip and its title **export** with the section, while a frame
  name stays chrome — the two therefore have different slots (`/pill` + `/chip` vs
  `/label`), because stripping a chip's text would have left a solid, wordless tag
  in the output; and the section hue now has ONE owner (`x_core::section_hue()`),
  which the conformance guard demanded the moment the renderer needed it too.
  `crates/x-render`, `crates/x-core`, `crates/x-native`.
- **Figma's per-frame "Show name" switch.** `Node::show_name` (default `true`) is
  the third and last gate on a frame's name label — after "not the render root" and
  "not nested inside another frame" — applied in both encoders, so the canvas, the
  exports and the thumbnails agree about it. The inspector paints a **Show name**
  checkbox beside **Clip content** in the same dense band (no geometry moved) and
  only for frames, because a Section always shows its own name; toggling it is
  undoable (`Editor::set_show_name`) and reports itself in the status line. The
  flag is written to the document **only when it is off**, so every file saved
  before this existed is unchanged, and the reader defaults to `true`
  (`a_frame_that_switches_its_name_off_emits_no_label`,
  `the_show_name_row_toggles_a_frame_name_undoably_and_only_for_frames`,
  `show_name_roundtrips_and_defaults_to_true_for_older_files`).

### Added
- **A new layer joins the container you draw it in.** Figma's rule ("click inside an
  existing frame to add a nested frame"; the shape tools behave the same way) was not
  this build's: a rect drawn on top of a frame landed *beside* it unless the frame
  happened to be selected. The canvas now decides — `run.rs::container_under` finds the
  deepest **visible, unlocked** frame or section under the point the drag started from,
  a nested frame beats the frame that holds it, and a group or an instance never
  captures a layer (their structure is not theirs to change). Holding **space** while
  dragging is Figma's documented "prevent nesting", so the shape stays on the page. The
  selected-container path remains as the fallback, which is what keeps a group and an
  auto-layout frame behaving exactly as before
  (`a_shape_drawn_over_a_frame_joins_that_frame`,
  `the_deepest_container_wins_and_a_group_does_not_capture`,
  `a_hidden_or_locked_frame_does_not_take_the_shape`,
  `holding_space_while_drawing_keeps_the_shape_on_the_page`).
- **The shape tools' modifiers, and a live size readout.** ⇧ already constrained a drag
  to a square or circle; **⌥ now draws from the centre**, and one function
  (`state::create_rect`) builds the rect for both the pending shape on screen and the
  node that lands, so the two cannot disagree. While a shape tool drags, the canvas
  paints the rect and its size under it, the way Figma does
  (`shape_tool_modifiers_build_the_rect_the_preview_shows`). `apps/x-designer`.
- **Presentation mode, and a Present control that means it.** The ▶ in the panel
  header used to be a shortcut to the Prototype *tab*; it now starts the file's
  prototype the way Figma's Present does, and a presentation paints the artwork
  alone: `FrameCache::set_presenting` + `ir::strip_canvas_chrome` drop the canvas
  chrome — a frame's name (`/label`) and a Section's title chip (`/pill` +
  `/chip`) — from the canvas render and from the prototype's relocated overlays.
  The engine's lowering still runs once for both pictures; only the gate differs,
  and the flag is a render mode, not a document property, so nothing is written to
  the file. Flipping it drops the cached scene instead of serving the editor's
  labelled one (`presenting_invalidates_the_cached_scene`). The two encoder rules
  now share one owner: `ir::is_frame_name_label` is what the exporter strips and
  what a presentation hides, `ir::is_canvas_chrome` adds the section chip that
  only a presentation hides. `crates/x-render`, `crates/x-native`,
  `apps/x-designer`.
- **The layers panel's eye and padlock are pinned.** They appear on the row you
  hover, stay while the state is on, and a locked layer stops answering the
  canvas — Figma's behaviour, now a test rather than a habit
  (`a_layer_row_hides_and_locks_the_layer_like_figmas_eye_and_padlock`).
  `apps/x-designer`.

### Changed
- **The status message got a row of its own instead of a bar over the artwork.**
  The band was painted last, over the bottom 22px of the canvas — the canvas
  region ran to the window's bottom edge, so a status line could sit on top of
  the document (the owner's "painted through the artwork"). The band is now a
  chrome row that everything yields to: `App::status_band()` is the one rect,
  `ED_STATUS_H` is the one height, and every region of the window (canvas,
  panels, board) ends at its top edge, so nothing can be drawn underneath it.
  The chrome that anchored to the window's bottom edge now anchors to the band
  instead — the layers tree, the right panel's scroll clip, the notification
  bell, the notifications panel and every popover clamp — so no control is
  painted (and clickable) where the band covers it, and a test asserts that no
  chrome hit zone crosses into the band. Two things fell out of giving the band
  an owner: the flow viewer is
  chrome-less (`App::paints_status_band()` gates `paint_feedback`), so a
  prototype preview keeps every pixel; and the reported *red* bar does not
  exist — the one `C_DANGER_FILL` in the chrome is the 10px unread badge on the
  notification bell, and the guard test now asserts it stays that way
  (`the_status_band_is_chrome_and_the_artwork_stops_above_it`,
  `the_status_band_is_a_panel_row_and_never_a_danger_fill`,
  `the_flow_viewer_paints_no_status_band_over_the_prototype`).
  `apps/x-designer`.

### Added
- **A design + Figma conformance guard** (`tools/design-sheet/guard.mjs`, run by
  `scripts/check.sh` on every push): a colour literal in two files is two owners of
  one decision and fails; engine-chrome literals are bounded by per-file ceilings
  that only go down (the app chrome already had this in `design_tokens_test.rs`);
  every icon name the chrome asks for must exist (a typo ships as a blank space);
  and every row of the parity contract must name the test that pins it.
- **`docs/FIGMA_PARITY.md`** — the behaviours we claim to copy from Figma, each with
  its source, the file that owns the decision in our code, and the test that pins
  it; plus the honest list of what is claimed but not yet pinned.
- **The design sheet's own 60 assertions now run in the gate.** `check.mjs` (40)
  and `check_screens.mjs` (20) — the ladders read back against
  `design_system.rs`, orphan roles, contrast pairs, `var()` coverage, no raw colour
  literals in the gallery, every screen's landmarks — needed jsdom and were
  therefore run by hand. `tools/design-sheet/package.json` plus an `npm ci` step in
  CI put them inside `scripts/check.sh`: a missing jsdom *fails* the gate in CI
  (locally it prints how to install it).
- **A `Screenshots (software Vulkan)` CI job** — installs lavapipe, runs the six
  `#[ignore]`d GPU/screenshot tests, and uploads the PNGs the fixtures write as
  artifacts, so a visual design regression is a download away instead of
  unverifiable. This is the layer `scripts/check.sh` cannot reach on a CPU runner.
- **Double-click a page name to rename it** (Figma's second rename path, next to
  the page menu) and **double-click a layer name in the Layers panel to rename it
  inline** (`FieldId::LayerName`, `Action::LayerRename`): Enter commits through the
  engine's undoable `rename_node`, Esc cancels without touching the document, and
  a single press still selects the row and arms the reorder drag.
- Regression tests for all of the above, in the form that fails if the old
  behaviour returns: the renderer's root/nesting/section label rules, the page
  rename + delete paths, the ✕-beats-the-row hit order, the windowed page list,
  the counted-once panel toggle, and both rename gestures.
- **The canvas name rules are verified on pixels, not only on the command list**:
  a non-`#[ignore]`d `RasterSink` (tiny-skia) test rasterizes a page holding an
  outermost frame, a nested frame and a Section and reads the bands back — the page
  and its top edge clean, the outermost frame and the Section named, the nested
  frame silent. It is proven to bite: a one-line control that removed the root gate
  failed it with `above the page: expected no name, darkest 229` alongside eight
  other tests guarding the same rule. `crates/x-render`.
- **Three canvas gestures now do what Figma documents, each pinned by a test.**
  Shift-click adds a layer to the selection and a second Shift-click takes it back
  out (`shift_click_adds_and_a_second_shift_click_removes_from_the_selection`); a
  marquee drag on empty canvas answers with the page's **top-level** objects, while
  holding ⌘/Ctrl is what lets the layers nested inside a frame answer
  (`hit_test_rect(.., deep)`, `Editor::marquee_deep`, `Drag::Marquee { deep }`) —
  a plain drag over a frame used to select the frame *and* everything inside it,
  and a Group answers like any other layer now that the scan stopped skipping it
  at every depth (only a *click* passes through a group's empty area, as before);
  and a press inside the text field you are already editing moves the caret
  instead of re-opening the field and discarding the typed buffer
  (`pressing_inside_the_open_text_field_keeps_what_was_typed`). The parity
  contract moves those rows from *open* to *pinned*.
- **⌥⌘A selects matching layers, and the rule is Figma's.** The shortcut this
  app documented was ⇧⌥⌘M while the variant's own comment claimed Figma's ⌥⌘A,
  so ⌥⌘A now works (⇧⌥⌘M stays as an alias). The rule underneath was
  kind + child-count + dimensions, which matched any two same-sized frames and
  missed the matching layer in a frame that had been resized: it is now the same
  layer **by name and by place in the structure**, scoped the way Figma scopes it
  — a layer inside a **Section** only matches layers in that section, and a
  page's own top-level layer is inside no frame or group to match across
  (`find_matching_nodes`; `select_matching_finds_the_same_layer_and_never_crosses_a_section`,
  `select_matching_never_crosses_a_section_boundary`,
  `option_command_a_selects_the_matching_layer_in_the_other_frame`).
- **Figma's layer walk works, end to end: ⏎ child, ⇧⏎ parent, ⇥/⇧⇥ sibling.**
  Two defects made it untrue. ⏎ was claimed by the vector-anchor editor for ANY
  single selection and then returned — on a frame the dispatch did nothing and the
  key was swallowed, so `Action::SelectChild` was unreachable for every
  non-vector layer; the key is now claimed only when the layer really is a vector.
  And ⇧⏎ walked one step too far: from a top-level object the parent is the PAGE,
  so the page root became the selection and the inspector described the canvas
  instead of a layer
  (`enter_tab_and_shift_enter_walk_the_layers_the_way_figma_documents`).
- The parity contract is now **24 pinned, 4 open**, and the open list is exactly
  what is still not built: the per-frame "Show name" switch, presentation mode,
  the Section title pill, and the canvas status row.
- **The audit** — root causes, a Figma-vs-X-Native behaviour table with sources,
  and the honest list of what is still open.

### Changed
- `GOLDEN_COMMANDS` in `crates/x-native/tests/golden_project.rs` drops 52 → 51
  (the document's `/golden/label` command is gone) and `GOLDEN_KIND_HASH` is
  re-pinned to `0xcd25_0bff_fae4_f4a6` — the value the gate itself printed
  (`commands=51 (pinned 51)` in the drift listing).
- **The gate is green on CI**: `scripts/check.sh` runs `cargo fmt --check`,
  `cargo clippy --workspace --all-targets` (**dead code 55 / ceiling 82**),
  `cargo test --workspace --locked`, the docs-reference check, the design-sheet
  regenerate-and-diff step and the CLI smoke in one pass. Four test expectations
  and one `///`-on-a-parameter error in this change were found and fixed by that
  run, not by inspection — the table is in
  [docs/FIXES_2026-09-18_PAGE_NAMES_AND_DOUBLECLICK.md](docs/FIXES_2026-09-18_PAGE_NAMES_AND_DOUBLECLICK.md).

## [Unreleased] — 2026-09-18 (Typography: the Inspector Meets the Engine)

Part of the UI/UX Refinement v1 milestone (see
[docs/REFINEMENT_V1_PLAN.md](docs/REFINEMENT_V1_PLAN.md)).

### Removed
- **High Contrast is gone — the product ships two palettes.** The owner asked
  for "just graphite and day mode", so the third palette is *deleted*, not
  hidden: `ThemeId::HighContrast`, `ColorTokens::HIGH_CONTRAST`, the
  `DesignSystem::high_contrast` flag and `high_contrast()` constructors, the
  context-menu row, the command-palette verb, the CLI's sample output and the
  design sheet's swatch/`hc` tokens. `ThemeId::ALL` is `[Graphite, Daylight]`,
  `parse`/`next`/`label`/`slug` walk those two, and `check.mjs` fails the build
  if a retired palette ever reappears in `tokens.json`. A settings file written
  by an older build (`~/.config/x-native/theme` = `high-contrast`) parses to
  `None` and falls back to Graphite rather than resolving to a palette that no
  longer exists. `crates/x-ui`, `apps/x-designer`, `tools/design-sheet`, docs.

### Fixed
- **Daylight: chrome that was inked as if it were dark.** Twelve sites painted
  a fill and an ink that only agreed in Graphite; the worst were an icon on an
  accent *wash* (white on a pale tint, 1.42:1 in Daylight), a black glyph on a
  solid accent fill (2.49:1) and an `accent_ink` glyph on the accent itself
  (1.09:1 — invisible). Each now names the role its fill implies: wash →
  `C_ACCENT_INK` (6.49:1), solid accent → `C_ON_ACCENT` (8.42:1), hover fills →
  `C_FIELD_2`. Full table in
  [docs/FIXES_2026-09-18_THEMES_AND_LEFT_RAIL.md](docs/FIXES_2026-09-18_THEMES_AND_LEFT_RAIL.md).
- **The left rail: every row's text and glyphs on the row's centre line.** The
  rail placed labels and icons by hand-computed offsets, and a third of them
  were a fraction of a pixel to several pixels off the middle of the row they
  belong to (the DRAFTS glyph sat on its box's bottom edge, the LAYERS label
  2.5px below the two buttons beside it, the PAGES `+` 0.7px low, a page glyph
  2px right of its thumbnail's centre, the search-field ✕ 2px low). The rail now
  derives every vertical placement from the box that contains it
  (`paint::line_top` / `glyph_top` / `glyph_left`, `paint.rs:210-229`), and
  the values are pinned by `paint::centring_tests`. `apps/x-designer`.

### Added
- **The engine renders what the inspector edits — for every text property.**
  `TextBlockStyle` (and therefore every shaped cache key) gains `max_lines`,
  `paragraph_indent` and `decoration`, and the outline entry points take the
  node's horizontal alignment:
  - **Alignment** Left/Center/Right shifts every laid-out line; `Justified`
    degrades to Left (the shaper does not stretch lines — a phantom state is
    better than a false one).
  - **Max lines** drops lines beyond the cap *before* placement, so the block
    height covers exactly what is emitted (CSS `max-lines`).
  - **Paragraph indent** shifts the first line of each paragraph
    (CSS `text-indent`); wrapped continuation lines stay at the margin.
  - **Decoration** draws one rect per line — underline ~0.1em below the
    baseline, strikethrough ~0.5em above it, thickness ~5% of the line size.
  - **Vertical alignment** Top/Middle/Bottom places the shaped block inside
    the node box in every sink (canvas vello, PDF, PNG/JPG raster, SVG
    outline), so exports agree with the screen.
  12 new/updated tests: alignment offsets, cap height, per-baseline indent
  pattern, one rect per line, and cache-key separation for each new field.
  `crates/x-text`, `crates/x-render`, `crates/x-native`.
- **`C_FOCUS`** (the `focus_ring` role) as the distinct input-focus colour.
  Canvas selection now derives from the `selection` role (`#7C5CFC` in
  Graphite & Signal) instead of `focus_ring`, so selection, focus and hover
  are three distinguishable states. Dashboard focus ring and open-dropdown
  border use `C_FOCUS`; the card hover ring drops to `C_LINE_2`. The
  regression test pins the role mapping. `apps/x-designer`.

### Added
- **The dashboard speaks X-Native (P0-4).** The sidebar's empty lower half
  now paints THE WORKFLOW — Compose / Flow / Ship with a one-line sub each —
  in the local-first and demo variants (informational only, no affordance).
  The "New design file" quick card now says "Compose, flow, ship — from one
  file." Phantom affordances are out: the three `more-horizontal` icons
  that had no hit region and no menu (recents card, list row, drafts row),
  the "Personal" row's hover fill + chevron with no hit region (now a plain
  scope label), and the recents view chip's `chevron-down` — it cycles the
  view, it doesn't drop down, so it now draws `rotate-cw`. The non-demo
  "Open in this session" list gets the same container idiom as the Drafts
  panel (rounded card, hline rows, hover wash, file icon, count). The design
  sheet's dashboard mocks are re-synced to the non-demo reality they had
  drifted from (sheet-only "All changes saved" chip, demo-only TEAMS,
  "Recently viewed", old bulk buttons). `apps/x-designer`,
  `tools/design-sheet`.
- **First-time workflow narrative (P0-10).** The first-launch onboarding
  card now names the primary loop **Compose / Flow / Ship** (it said
  "Design / Prototype / Ship") and names the supporting surfaces once —
  "Structure, Library, Tokens, Variables, Agents and UX analysis live in
  the editor docks" — so they can be found later. A blank file used to
  open to a bare canvas with no affordance; the canvas now shows a
  centre hint ("Add your first frame — pick the frame tool in the dock
  below, then drag. Then connect screens in FLOW, and export from
  SHIP.") that is pure paint keyed on the page having no frames, so it
  leaves the moment the first frame lands — no flag, no dismiss button.
  `apps/x-designer`.
- **One control-height and spacing scale for the inspector (P0-9).**
  `theme.rs` now declares `DENSE_H` (24, disclosure / summary rows) and
  `CHIP_H` (16, checkboxes / switches / inline chips) alongside the
  existing `INPUT_H` (28) / `SQ_BTN` (28), plus the rhythm constants
  `ROW_GAP` (8), `LABEL_GAP` (6) and `SECTION_GAP` (12). The COMPOSE
  inspector is re-gridded onto it: every property row is 28px, disclosure
  rows 24px, chips 16px, with 8/6/12 gaps throughout; the
  fill/stroke/effects tail's cursor math uses the same constants.
  `apps/x-designer`.
- **Progressive disclosure in the inspector (P0-8).** The typography
  section's secondary properties — letter/word spacing, paragraph
  spacing / baseline shift, text case, and the variable-font axes
  (optical size / width) — now sit behind an "Advanced" disclosure
  (closed by default); the primary set is Font / Weight / Size /
  Line height / Alignment / Vertical alignment / Decoration / Wrap
  style / Max lines / Paragraph indent. The Auto Layout section's
  secondary rows — Wrap for layout frames, Fixed|Fill + Absolute for
  layout children — sit behind the same disclosure language in their
  band, with the open state collapsible from the band's right edge.
  Nothing was removed: every advanced control is the same engine-backed
  control as before. `apps/x-designer`.

### Changed
- **Inspector control heights de-outliered (P0-9).** The 19px sizing
  chip, 20px appearance eye button, 22px text-style buttons and 32px
  gap/padding rows all sit on the 28/24/16 scale now, and the
  alignment card no longer overlaps the Auto Layout advanced band
  (a measured-reference leftover from before the disclosure pass).
  The design sheet's COMPOSE mirror is re-synced to the same geometry;
  the line-height row (grid 774–802) sits at the scroll fold, so the
  sheet's scroll-0 mock ends at weight/size.
- **Inspector typography section, no more phantom controls.** Horizontal
  alignment is three working buttons (active state mirrors the render);
  vertical alignment, decoration, max lines and paragraph indent now reach
  the engine; the **Wrap style** control was re-wired from the
  serialization-only `wrap_style` field (Normal/BreakWord — the engine never
  read it) to the engine's real paragraph wrap strategy (`tw` binding:
  Auto → Balance → Pretty). **Truncation** and **List style** — editable
  but unrenderable — are out of the inspector; their model fields stay in
  the format. Word spacing was being silently dropped by the canvas scene
  path; it now reads the same `ws` binding as every other sink.
- **Inspector layout fix.** The fill/stroke/effects tail started at
  `y0+1041.5`, above the typography rows it was meant to follow, and painted
  over them. The typography section now ends at 1178, divider at 1190.5,
  tail at 1202.5, scroll clamp updated to match.
- **Wording.** Comments describing the UI as a "pixel clone" of a measured
  HTML reference now say what the constants are: hand-tuned for a 1440px
  composition. No behaviour change.

### Added
- **The screen & component contract, in `x-ui` (P0-1/P0-2).** `x-ui` was a
  token crate: the app imported its palette, type ladder and spacing scale, and
  then defined its own control heights, hover colours and widgets — which is how
  one inspector ended up with 19px, 20px, 22px and 32px rows. It now owns the
  contract the screens are held to:
  - **`metrics`** — the control-height and rhythm standard (28 / 24 / 16;
    8 / 6 / 12) with `is_control_height` / `nearest_control_height`. The
    designer's `INPUT_H`, `DENSE_H`, `CHIP_H`, `SQ_BTN`, `ROW_GAP` and
    `SECTION_GAP` are derived from it — same values, one source — and
    `app_row_heights_are_the_component_layers` holds the app to it.
  - **`state`** — selection, hover and focus as three palette roles, with
    focus an *additive* ring rather than a replacement for the base state.
    Every role it names is checked against `ColorTokens`.
  - **`screens`** — the 3 screens and their 31 surfaces: kind, the label it
    shows, whether it owns property rows, what it says when empty, how it
    scrolls. Banned labels keep the pre-rename vocabulary (`design`,
    `prototype`, `layers`, …) out of a panel title.
  - **`contract`** — the 22-component inventory: height, scale step, states,
    hit region, focus ring, and who paints it today.
  Four ratchets turn the cross-screen pass into a work list the gate can count:
  `OFF_STANDARD_SURFACES` 3 (FLOW / SHIP / UX ANALYSIS),
  `OFF_STANDARD_COMPONENTS` 2 (the 22px tree row, the 32px dropdown row),
  `SILENT_EMPTY_STATES` 6, `MIGRATED_TO_X_UI` 0. The rules these fields mean
  are in `docs/SCREEN_CONTRACT.md` and `docs/COMPONENT_CONTRACT.md`.
  `crates/x-ui`, `apps/x-designer`.

### Changed
- **The design sheet's audit generator follows constants it can no longer read
  off `theme.rs`.** `build_audit.mjs` parses the chrome's constants instead of
  retyping them; a constant the app now imports from `x-ui::metrics`
  (`INPUT_H`) is resolved through `metrics.rs`, so the sheet cannot report the
  number the app used to have. The sheet was regenerated — one usage count
  moved (`SP_3`, once `ROW_GAP` stopped naming it) and no audit value changed.
  `X-Native/tools/design-sheet`.

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
