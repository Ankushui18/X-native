# Figma "Create designs" vs X-Native — item-by-item comparison

**Source compared:** <https://help.figma.com/hc/en-us/sections/4403912808599-Create-designs>
(7 sub-sections, 70 articles, retrieved 2026-09-15)
**Compared against:** the working tree at `X-Native/` on branch
`arena/01a0a5bd-x-native` (branched from `faff63f`), **including the vector-tools
and layer-management work landed on this branch** — see §0.

**Method.** Every row was verified by reading code, not by reading our own docs.
The reading happened in a sandbox with no `cargo` and no network egress, so the
first pass rested on name resolution, exhaustiveness and duplicate-definition
rules rather than a compiler. It was then **verified by the repository's own
gate**: `scripts/check.sh` ran on CI in seven rounds, each verdict feeding the
next, and the branch now passes it — formatting clean, zero live lints, dead code
82/82, **896 tests passing**, CLI smoke green. What remains judgement rather than
measurement is the Figma side of each row: what Figma does comes from its help
articles, not from a running copy of Figma.

**Witness convention.** Engine claims carry `file:line` (those files were
re-verified line-by-line in this pass). App-side claims name the **symbol**
(`Action::…`, `CtxCmd::…`, the `fn` that handles it) instead of a line number,
because this branch rewrote ~1,300 lines of `run.rs` and line numbers there drift
while symbol names do not.

---

## 0. What changed on this branch (and why §4 moved)

The previous revision of this comparison found the tree **unable to build**: three
independent compile blockers, all inherited from the "Phase 2–6" patches. A fourth
was found while wiring the vector tools. All four are now fixed, and the fix was
not a shim — the fake implementations were deleted and replaced.

| # | Blocker (as found) | Fix on this branch |
|---|---|---|
| 1 | `x-editor` called three `Editor` methods that existed nowhere in the crate — `mark_dirty()`, `delete_node()`, `add_node()` — from ~30 call sites across ~20 functions (`flatten_selection`, `outline_stroke`, `offset_vector`, `text_to_outline`, `join_paths`, `reverse_path_direction`, `simplify_vector*`, the bezier-handle family, `set_stroke_cap_*`, `shape_builder_*`, …) | The 36 junk methods were **removed**, not stubbed. What replaced them goes through the real command log: one funnel, `Editor::rewrite_path` (`vector_edit.rs:1081`), plus `push_replace`/`push_cmds`, and a new `Editor::edit_batch` (`editor_core.rs:2712`) for multi-node edits. `grep -c 'mark_dirty\|delete_node\|add_node' crates/x-editor` → **0** |
| 2 | Four duplicate variants in `enum Action` (Rust `E0428`): `AddBezierHandle`, `AdjustBezierHandle`, `SplitVectorPath`, `CutVectorPath` each declared twice | The enum was collapsed to one declaration per variant; the two variants that carried a coordinate the app could never supply (`AddBezierHandle`, `AdjustBezierHandle`) were **deleted** — the mouse now drives those through the gesture API (§4.2) |
| 3 | `run.rs` referred to crates and fields that do not exist in this package: `use x_editor;`, `x_editor::MirrorMode/JoinStyle`, `x_core::StrokeCap`, `self.editor` on `Host`, bare `ShapeOperation::`/`SelectionMode::` | Rewritten onto the facade that `x-native` already re-exports (`x_native::editor::*`, `x_native::*`); `use x_editor;` deleted; `MirrorMode`/`JoinStyle`/`ShapeOperation`/`SelectionMode`/`ArrowStyle`/`DashPattern` and the rest of the phantom types deleted from `state.rs`. `grep -c 'active_editor\|x_editor::\|x_core::' apps/…/run.rs` → **0** |
| 4 | **New, found in this pass:** `paint_vector_points` in `editor_ui.rs` destructured `NodeKind::Vector(v)` and read `v.segments[i].point / .handle_in / .handle_out`. `NodeKind::Vector` is a **struct** variant holding `path: Vec<PathCmd>` (`node.rs:205`) — there is no `segments` field anywhere in the model. The function is called from the canvas painter, so this was a hard `E0532` in the app binary | Rewritten against the engine's world-space layer (`anchors_world` / `handles_world`, `editor_ui.rs:457`), which is also what the pointer now hit-tests against, so what is drawn and what is clickable are the same coordinates |

Two orphan files were deleted rather than gated: `x-core/src/p0_features.rs`
(258 lines, never declared as a module → never compiled) and
`x-render/src/vector_network.rs` (769 lines, compiled and exported, referenced by
nothing, rendering a `VectorNetwork` type deleted from `x-core` on 2026-09-02).

### The gate's verdict — a fifth, inherited layer

There is no Rust toolchain in the working environment (no `cargo`, `rustc` or
`rustup`; TLS to crates.io is blocked), so blockers 1–4 were found by reading and
the fix was verified by CI, not locally. The gate (`scripts/check.sh`: fmt →
clippy → `cargo test --workspace`) ran on this branch and reported in two rounds.

**Round 1** — one error, in this branch's new code: `E0689 can't call method max
on ambiguous numeric type {float}` at `vector_edit.rs:775`. `let mut worst = 0.0;`
leaves an unresolved float inference variable and rustc builds the inherent-method
candidate list from the receiver alone, so `worst.max(perp_dist(..))` is ambiguous
between `f32::max` and `f64::max` even though every operand in the function is
`f64` and the signature pins the result. Argument types do not participate in
method selection. Fixed by annotating the binding.

**Round 2** — with `x-editor` compiling, the build reached the app crate for the
first time and produced 31 diagnostics. `main` has never compiled this far: its
own gate fails inside `x-editor` on blocker 1, so **everything below was inherited
breakage that no CI run had ever reported**. Every diagnostic was attributed by
`git blame`:

| Root cause | Whose | Fix |
|---|---|---|
| Six vector-edit functions (`sync_vector_edit_mode`, `vector_edit_id`, `vector_press`, `apply_stroke_caps`, `local_delta`, `vector_drag_node`) written for `Host` — every body says `self.app.doc()`, `self.dispatch(..)` — but pasted inside `impl App`, where `self` *is* the app (16 × `E0609 no field app on type &mut App`, `E0599 no method dispatch`) | This branch | The 196-line block moved into `impl Host`, unchanged: all ten `self.app.*` members and `dispatch` exist there, and every caller (`run.rs:3434`, `:4200`, `:5552`, `:8824-8967`) already calls them as `self.x()` from `Host` methods |
| `paint_vector_points` called `draw_line(..)`; the helper in `paint.rs:100` is `line(..)`, already glob-imported (`E0425`) | This branch | Renamed the call |
| `third((prev.map(..).unwrap_or(..)), (x, y))` — clippy `unused_parens`, a denied lint | This branch | Parens dropped |
| The prototype inspector's `for (i, ix) in list.iter().enumerate()` loop **closed 40 lines early**, leaving rows 3 and 4 (easing / reset / remove) outside the only scope that binds `i` and `ix` (5 × `E0425`) | `main` | Brace moved to the end of the row-4 block, rows re-indented into the loop |
| `text_center(s, r, "Remove", T10, C_TEXT, Wt::Reg)` — the signature takes a 7th `vcenter: bool` (`paint.rs:523`); every other caller passes `true` (`E0061`) | `main` | `, true` added |
| `center + (value * slider_r.width() / 2.0)` — the image-adjustment fields are `f32`, `Rect::width()` is `f64` (4 × `E0277`/`E0308`) | `main` | `value as f64` |
| `NotificationKind` imported and never used | `main` | Import dropped |

**Round 3** — with those repaired, the compiler went deeper still and reported 4
more errors and 7 more warnings, **every one of them pre-existing on `main`**
(blame: `faff63f1`). `scripts/check.sh` requires zero LIVE warnings — anything
not phrased "never used/read/constructed" — so these block the gate exactly as
hard as the errors do:

| Diagnostic | Whose | Fix |
|---|---|---|
| 2 × `E0308` in `proto_edit_key` / `proto_edit_url`: `*key = match key.as_str() { "Enter" => "Space", … }` assigns `&'static str` into a `String` field | `main` | `.to_string()` on the match result; the arms are static strings so the borrow of `key` ends before the assignment |
| `E0596` in `paint_proto_connections(app: &App, ..)`: called `app.doc()`, which takes `&mut self` (`state.rs:1594`) | `main` | The tab test now reads `app.doc_opt()` — the shared borrow the body needed on its next line anyway |
| `E0004` non-exhaustive `dispatch`: `ProtoAddAction`, `ProtoRemoveAction`, `ProtoSetVariable`, `ProtoConditional` | `main` | Deleted — see the correction in §9 |
| 3 × `unreachable_pattern`: the guarded arms `"a" \| "A" if shift && alt` (inverse selection), `"c" \| "C" if alt` (copy properties) and `"v" \| "V" if alt` (paste properties) sat **below** the unguarded ⌘A / ⌘C / ⌘V arms, so three real shortcuts silently did nothing | `main` | The four modifier-guarded arms moved above the plain-⌘ family, with a comment stating the precedence rule. This is a behaviour fix, not just a warning fix: ⇧⌥A, ⌥⌘C and ⌥⌘V work now (§11) |
| 4 × unused variable (`i` in the nav-tab loop, `outside` — a `Rect` built and dropped, `xr` — an inspector parameter the panel never reads, `targets` — `proto_targets(app)` fetched for a destination picker that was never built) | `main` | `i` and `outside` removed; `xr` renamed `_xr` with a note (every other panel takes the same `(x0, xr, y)` box); the `targets` binding renamed `_targets` and kept — **not** deleted, because `scripts/check.sh` ratchets dead code at `DEAD_CODE_CEILING=76` and `docs/KNOWN_DEBT.md` documents a pile of exactly 76, so dropping `proto_targets`' only caller would push it over. §9 still lists `ProtoDest` as an action with a handler and no dispatch site |

While moving that brace, one behavioural bug came with it: the loop computes
`let row_h = if has_url { 92.0 } else { 56.0 };` and paints a row rect that tall,
but `y` never advanced by it — the only `y +=` in the function is *after* the loop
— so every interaction in the list was painted at the same offset, on top of the
previous one. `y += row_h;` now ends the iteration. This is the one fix here that
changes what the UI draws rather than whether it compiles, and it is flagged as
such because it pre-dates this branch.

**Round 4** — the workspace compiled for the first time, so `cargo test
--workspace` ran: **621 passed, 5 failed**, and all five failing tests blame to
`faff63f1`. `main` has never compiled far enough to run any of them, so these are
inherited failures that no CI run had ever reported. Two were real:

| Test | Diagnosis | Fix |
|---|---|---|
| `grid_column_major_auto_flow` (x-core) | **A genuine bug, not a stale test.** The column-major scan was `for col in 0..ncols { for row in 0.. { … } }`, and `cells_free` answers `true` for any row past the end of `occupancy` (which `mark` grows on demand) — so the unbounded inner scan always "found" a fresh implicit row in column 0. `grid-auto-flow: column` never reached column 1 and every child stacked into the first column | The row scan is bounded by the *declared* rows, with a bounded implicit-row fallback for when the declared cells are all taken |
| `flatten_group_bakes_children_into_one_vector` (x-editor) | **Caused by a deliberate change on this branch:** it asserted `n.id == "flat-0"`, i.e. the `format!("flat-{}", undo_depth())` scheme that made two flattens at one undo depth collide on the same id | The assertion now checks the property (a fresh `flat-` id), and a new test `flatten_twice_at_one_undo_depth_mints_distinct_ids` walks the collision path — flatten, undo (depth returns to 0), flatten again — and requires distinct ids |

Three were stale tests asserting behaviour that had deliberately changed:

| Test | What changed | Fix |
|---|---|---|
| `dev_mode_css_emits_borders` (x-editor), `stroke_opacity_and_gradient` (x-format) | Both asserted `border:` for a **default-aligned** stroke. The emitters are align-aware by design ("CSS Flexbox parity: inside strokes → `border`, outside/center → `outline`") and `StrokeAlign`'s default is `Center`, so the correct output is `outline:` | Each test now asserts the rule in **both** directions — `outline` for Center (and no `box-sizing`), then `border` + `box-sizing: border-box` for Inside. Flipping the align requires `visual_stacks_materialized = true`, because `active_strokes()` synthesizes a layer from `node.stroke` and ignores `stroke_layers` until then |
| `t05_canvas_transform_must_match_hit_test_and_overlay_transform` (app) | It pinned the literal `(340.0, 76.0)`; the canvas origin is `editor_regions().canvas.x0 + pan + ruler`, which the nav rail and the *resizable* sidebar both feed, so it had drifted to `(388.0, 76.0)` | The expectation is recomputed from the same `(x, y, zoom)` triple the renderer consumes — which still pins translate-then-scale order — plus an assertion that the origin is the chrome's canvas region and not the window's. The two invariants the test is named for (round-trip, renderer == overlay) are untouched |

**Round 5** — clippy's LIVE-warning budget. `scripts/check.sh` requires **zero**
warnings that are not dead code, and 14 remained: 4 from this branch
(`type_complexity` on the nested-optional normal pairs → a `VertexNormals` alias;
`ptr_arg` on `move_anchors_by`, which only assigns through `set_anchor_pos` and
`get_mut` so `&mut [PathCmd]` is enough; a negated comparison on a partially
ordered type → an explicit `partial_cmp` match, which also keeps the NaN case
meaning "simplify nothing"; `clone_on_copy` on `Transform`) and 10 pre-existing
mechanical ones (`get(..).is_none()` → `!contains_key`, `assert_eq!(x, false)` →
`assert!(!x)`, two needless `mut`, `.iter().next()` → `.first()`,
`format!("literal")` → `.to_string()`, three `Default::default()`-then-assign
blocks → struct literals, one single-arm `match` → `if let`).

**The last gate item was the dead-code ratchet, and it needed a re-measurement
rather than a fix.** It read 84 against `DEAD_CODE_CEILING = 76`, where
`docs/KNOWN_DEBT.md` documented a pile of exactly 76, measured on 12 Sep 2026 —
*before* the tree stopped compiling. A workspace that does not build reports no
dead-code diagnostics at all, so for everything merged after that the number was
remembered rather than measured. Per file, measured against documented:
`context_menu.rs` 32/32, `command.rs` 18/18, `theme.rs` 9/8 (the extra is
`R_XS`), `state.rs` 9/6, `x-ui/components.rs` 7/7, `editor_ui.rs` 5/0,
`chrome.rs` 3/3, `serialize.rs` 1/1, `run.rs` 0/1 (the unused `id` this branch
turned into a guard). None of the growth is from this branch: `editor_ui.rs`'s
five are three `proto_*_label` builders for prototype pickers that were never
built plus `extra_y`, and `state.rs`'s nine are shortcut accessors, unreached
`Action`/`FieldId`/`NotificationKind` variants and drag-state fields that
pre-date it. This branch deletes the two `extra_y` warnings (write-only state:
the row height is already handled by `row_h`), re-baselines the ceiling to the
measured **82**, and rewrites `KNOWN_DEBT.md` §1 to name every item — with
`check.sh` now printing the list itself when the ratchet trips, because a
per-file count cannot tell you which entry to write.

Net effect on the tree: **+3,890 / −4,993 lines** across 21 files. The engine
gained real implementations (`offset_path` in `x-core`, 13 new path operations and
a gesture API in `x-editor`, `outline_text_node` in the facade) and **28 new
tests** (7 for the offset, 20 for the path operations and the gesture contract, 1
witness for the flatten id collision); the app lost its dead wiring; and nine
files that this branch did not otherwise touch were repaired because the gate
cannot pass while `main`'s own breakage is in them.

### Status legend

| Mark | Meaning |
|------|---------|
| ✅ | Shipped — engine **and** a real user input path (toolbar / inspector / shortcut / menu / pointer) |
| 🟡 | Partial — reachable, but materially narrower than Figma |
| 🔧 | Engine-only — model, renderer and/or serializer exist; no UI reaches them |
| 💀 | Dead wiring — an `Action`/handler exists but nothing dispatches it, or it is a stub |
| ❌ | Missing or wrong — absent, or implemented with different semantics than Figma |

---

## 1. Scorecard

| Figma sub-section | Articles | ✅ | 🟡 | 🔧 | 💀 | ❌ |
|---|---|---|---|---|---|---|
| Create and edit layers | 9 | 3 | 3 | 2 | 0 | 1 |
| Work with layers | 18 | 5 | 6 | 3 | 0 | 4 |
| Design with vector tools | 9 | 4 | 4 | 0 | 0 | 1 |
| Text and typography | 14 | 7 | 3 | 0 | 0 | 4 |
| Color, gradients, and images | 11 | 1 | 4 | 3 | 2 | 1 |
| Additional properties | 3 | 0 | 3 | 0 | 0 | 0 |
| Use auto layout | 6 | 3 | 1 | 2 | 0 | 0 |
| **Total** | **70** | **23 (33%)** | **24 (34%)** | **10 (14%)** | **2 (3%)** | **11 (16%)** |

Previous revision of this document: ✅19 (27%) · 🟡22 (31%) · 🔧12 (17%) · 💀4 (6%)
· ❌13 (19%). The movement is concentrated where the work went — **"Design with
vector tools" went from ✅1/🟡1/🔧2/💀1/❌4 to ✅4/🟡4/❌1** (no engine-only rows and
no dead wiring left in the section at all), and dead wiring fell from 4 rows to 2
(both in the colour/image section, both pre-existing).

Headline reading: **typography, auto layout and vector editing are now genuinely
competitive**; **colour/image handling is the weak flank** (it is the only section
still carrying dead wiring, a 16-swatch colour picker, and a gradient model a user
cannot create a gradient with). The largest remaining category of loss is not
missing engine work — it is **10 features whose engine is complete and has no UI**
(blend modes, constraints pins, layout grids, grid auto layout, crop, patterns,
corner smoothing, scale tool, sections, arc tool).

---

## 2. Create and edit layers (9 articles)

| # | Figma article | Status | What we have / what is missing (evidence) |
|---|---|---|---|
| 2.1 | Layers 101: Get started with layers | ✅ | Layers tree with expand/collapse, per-row eye + padlock (`Action::TreeVisible`/`TreeLock`), z-order both ends and one step (`CtxCmd::ToFront/ToBack/BringFwd/SendBack`), inline rename (`Action::RenameStart`), keyboard tree navigation — ⏎ into the first child, ⇧⏎ up to the parent, Tab/⇧Tab across siblings (new on this branch, `Action::SelectChild/SelectParent/SelectNextSibling/SelectPrevSibling`). **Caveat:** multi-selection lock/hide touches only the *first* selected node (`App::set_locked` path uses `selection.first()`); Figma applies to all. |
| 2.2 | Layers 101: Explore layer types | 🟡 | Model carries 13 kinds — Frame/Group/Rect/Ellipse/Section/Arc/Line/Text/Image/Vector/Component/Instance/Slice (`node.rs:177-217`). The app can create **five** by dragging (Frame, Rect, Ellipse, Text, Vector) plus Group/Component by command. No Line, Arc, Section, Slice, Polygon, Star, Triangle, Arrow, Video. |
| 2.3 | Layers 101: Combine layers | 🟡 | Group ⌘G / Ungroup ⇧⌘G ✅, booleans ✅ (4.8), flatten ✅ (4.9), masks 🔧 (2.9). **Missing:** "Frame selection" (⌥⌘G) and "Remove frame" — `ContextAction::FrameSelection` exists only in the decorative menu model (§9). |
| 2.4 | Frames in Figma Design | ✅ | Frame tool + device presets (`FRAME_PRESETS`, `Action::FramePreset`), clip-content toggle → `Overflow`, scroll/overflow model (`node.rs:332-335`), auto layout on frames, nesting, frame-aware hit-testing. |
| 2.5 | Sketch on the canvas with the pencil tool | ❌ | No pencil tool: `Tool` has no `Pencil` variant, and there is no freehand stroke capture anywhere. `x_core::simplify_polyline` is Ramer–Douglas–Peucker and its doc-comment still says "pencil tool", but its callers are the path-simplify op (4.7) and tests. |
| 2.6 | Shape tools | 🟡 | Rectangle ✅, Ellipse ✅. Line / Polygon / Star / Triangle / Arrow ❌ — zero references in the app. `docs/UI_CAPABILITY_MAP.md` claims "The Shape menu and command palette expose Polygon, Star, Triangle, Line, and Slice": **no such menu exists in code** (§10). |
| 2.7 | The difference between frames and groups | ✅ | The distinction is modelled correctly: `Group` has no clip and no layout; `Frame` carries `Option<AutoLayout>`, `Overflow`, layout grids, presets (`node.rs:178-189`, `332-339`); the renderer treats them differently (`ir.rs`). Group bounds are computed on group (`Editor::group_selection`). |
| 2.8 | Arc tool: arcs, semi-circles, rings | 🔧 | `NodeKind::Arc{start,end}` (`node.rs:190-195`), rendered in IR + scene, booleanable, SVG-exportable, `arc_path_cmds` produces real quarter-segment cubics with kappa-accurate control arms and is tested (`x-core/src/booleans.rs:463`, tests at `:1207` region). **No tool, no menu entry, no inspector for start/end angles, no ratio/pie-slice toggle.** |
| 2.9 | Masks | 🔧 | `is_mask` (`node.rs:300-302`) clips following siblings in the IR, exports to SVG `<mask>`, round-trips through `.x`, and has five integration tests (`crates/x-native/tests/mask_semantics.rs`). **No "Use as mask" menu item, no ⌥⌘M, no mask-outline rendering.** Only reachable by constructing a node in code (`Node::mask(true)`). |

---

## 3. Work with layers (18 articles)

| # | Figma article | Status | What we have / what is missing (evidence) |
|---|---|---|---|
| 3.1 | Turn coded screens into editable design layers | ❌ | Figma captures a live site (Chrome extension / MCP `generate_figma_design`) into layers and binds extracted CSS variables to library variables. We have the **inverse** direction only: design → HTML/CSS site (`x-native/src/html_export.rs`), CSS/SwiftUI/Compose/JSX codegen (`x-format/src/codegen.rs`), and a **read-only** MCP server (`x-native/src/mcp.rs`). No HTML importer exists (`grep import_html|parse_html` → 0 hits). Importers we do have: `.fig`, Sketch, SVG, Figma REST JSON, PNG. |
| 3.2 | Edit objects on the canvas in bulk | 🟡 | Multi-selection works for move / align / z-order / delete / duplicate / group / boolean, and **property paste is now a real batch**: `Action::PasteProperties` walks the whole selection inside one `Editor::edit_batch` (`editor_core.rs:2712`) → ONE undo step, materialising `fill_layers`/`stroke_layers`/`effect_layers` as it goes. **Still single-node:** the inspector reads `selected_id()` (= `selection.last()`), so there is no "Mixed" value state and no bulk fill/stroke/type/radius editing from the panels. |
| 3.3 | Identify matching objects | ✅ | `Editor::find_matching_nodes` (`editor_core.rs:2762`) via `shape_signature`, dispatched by `Action::SelectMatching` (⌥⇧M + palette "Select matching layers"). **Deviations:** Figma's shortcut is ⌥⌘A; we never highlight the matches on canvas, only report a count in the status bar. |
| 3.4 | Parent, child, and sibling relationships | 🟡 | Real tree with stable ids independent of names (`node.rs:249-256`), group/ungroup preserving parent, layers-panel nesting, and the four navigation handlers are now **dispatched** (⏎ child, ⇧⏎ parent, Tab/⇧Tab siblings) against `get_parent_id`/`get_next_sibling_id`/`get_prev_sibling_id` (`editor_core.rs:2814-2846`). **Missing:** drag-into-frame auto-reparenting (0 refs to reparent logic in the app). |
| 3.5 | Select layers and objects | ✅ | Click, ⇧-click add/remove, marquee, ⌥-drag duplicate, double-click dive-into-group and inline text edit, **⌘-click deep-selects the exact nested layer** (new: `click_select(world, shift, deep)` with `deep = dbl || ctrl`), select-all ⌘A, inverse ⌥⇧A (`Action::InverseSelection` → `get_all_selectable_ids`, `editor_core.rs:2749`), layers-panel row selection (`Action::TreeRow`), and inside node edit mode a pointer lasso over anchors (4.2). **Missing:** "select all with same properties" (3.15) and a layer-search field — the dead `SetLayerSearch` action and its `layer_search` field were deleted rather than left unwired. |
| 3.6 | Adjust alignment, rotation, position, and dimensions | 🟡 | X/Y/W/H/Rotation/Opacity fields (`FieldId`), 3×3 align card → `align_selection`, aspect-ratio lock (`Action::ToggleAspectRatio`), rotation-aware corner resize (`x-editor/src/transformed_resize.rs`). **Missing:** flip H/V (claimed in `docs/UI_CAPABILITY_MAP.md`, 0 code refs), distribute horizontally/vertically in UI (engine has `distribute_horizontal`, `align.rs:61`), on-canvas rotation handle (0 refs to `Drag::Rotate`). |
| 3.7 | Copy and paste objects | ✅ | ⌘C/⌘X/⌘V/⌘D, ⌥-drag duplicate, object clipboard that retains **embedded assets and component dependencies** (`clipboard.rs`), and paste directly from a real Figma clipboard. **Gap:** ⇧⌘V paste-in-place is not bound even though `Editor::paste_in_place` exists. |
| 3.8 | Scale layers while maintaining proportions | 🔧 | `Editor::scale_node` + `scale_subtree` scales geometry, stroke weights, radii and font sizes uniformly and is tested. **No Scale tool (K), no UI, no shortcut.** The only user-facing proportional resize is the W/H aspect lock. |
| 3.9 | Organize your canvas with sections | 🔧 | `NodeKind::Section` with a rendered label header, `Node::section()`, query name `"SECTION"`, frame-like hit-test/marquee/ungroup. **The app never constructs one** and there is no Section tool, despite `docs/UI_CAPABILITY_MAP.md` listing "Section" in the primary toolbar. |
| 3.10 | Measure distances between layers | ❌ | No redlines anywhere: 0 measurement/redline paint code, no Alt-hover distance to sibling/parent, no padding measurement inside auto layout. The `Action::ShowMeasurements` handler — which only wrote a status string claiming "this is handled in the rendering code" — was **deleted** on this branch, so the gap is now honest rather than disguised. |
| 3.11 | Lock and unlock layers | ✅ | Per-row padlock, ⇧⌘L, context-menu Lock, lock excluded from hit-testing (`node.rs:273-274`). Caveat as in 2.1: multi-select affects only the first node. |
| 3.12 | Toggle visibility to hide layers | ✅ | Per-row eye, ⇧⌘H, context-menu Hide, `visible` respected by IR/codegen. The dead ⇧⌘O "hidden outlines" toggle (a flag no paint code ever read, and not a Figma feature) was **deleted**; ⇧⌘O is now Outline stroke (4.4). |
| 3.13 | Rename Layers | 🟡 | Inline rename in the layers panel ✅, plus **renumber selection** (⇧⌘R and palette): `Action::RenumberSelection` renames the whole selection "Base 1, Base 2, …" inside one `edit_batch` → ONE undo step, taking the base name from the first selected layer with trailing digits stripped. **Missing:** Figma's ⌘R modal — find/replace across names, a live preview list, and numbering start/step. The dead `OpenBulkRename`/`CloseBulkRename`/`ApplyBulkRename` trio and its four never-painted state fields were deleted; the modal is now listed as work (§12) instead of pretending to exist. |
| 3.14 | Copy and paste properties between layers | 🟡 | ⌥⌘C / ⌥⌘V, and the paste is now **undoable and batched**: one `edit_batch` for the whole selection instead of `get_node_mut` writes behind the command log's back (that was the previous revision's correctness defect). **Gap:** the clipboard carries only fill, stroke, effects, opacity and corner radius (`PropertyClipboard`) — no typography, constraints, export settings or blend mode. |
| 3.15 | Arrange layers with Smart selection | ❌ | No property-based smart selection (Figma: select all layers sharing fill/stroke/type/effect, and tidy-arrange them). `find_matching_nodes` (3.3) matches **structure**, not properties, and there is no arrangement op. |
| 3.16 | Apply constraints to define how layers resize | 🔧 | Full model + solver: `pin: (HPin, VPin)` (`node.rs:288-289`, `x-core/src/pins.rs`), `ChildConstraints` (fixed/sticky/align_self/grow/shrink/basis), `x-editor/src/constraints.rs` solver, regression tests. **Zero references to `HPin`/`VPin` in the app** — no constraints widget, no per-side pins, no scale-on-resize behaviour exposed. |
| 3.17 | Create layout guides | 🟡 | Rulers (⇧R) and user-draggable guides (`Drag::Guide`) ✅. Per-frame **layout grids** — `LayoutGridDef{pattern: Columns/Rows/Grid, count, gutter, margin, cell}` (`node.rs:704-756`) with `.x` round-trip and a `guide_bands()` helper — are **never painted**: 0 `layout_grid` refs in `x-render` and in the app. The inspector's "GUIDES" section edits a *document-level pixel grid*, which is a different thing. |
| 3.18 | Combine layout guides and constraints | ❌ | Depends on 3.16 + 3.17 UI; neither exists, so the combination cannot be authored or seen. |

---

## 4. Design with vector tools (9 articles)

This was the weakest section and the reason was unusual: a good implementation
existed and was not connected. **It is now connected, and the parts that were
fake are real.** Every operation below is undoable, and the interactive ones are
*one* undo step per gesture rather than one per mouse-move event.

| # | Figma article | Status | What we have / what is missing (evidence) |
|---|---|---|---|
| 4.1 | Vector networks | ❌ | Deliberately removed and documented: "the Phase-P0 `VectorNetwork` experiment … was removed 2026-09-02: it was never constructed anywhere" (`node.rs:163-169`). This branch also deleted the orphan renderer `x-render/src/vector_network.rs` (769 lines for a type that no longer existed), so nothing now *looks* like a network implementation. Paths are `NodeKind::Vector{path}` command lists, which cannot express an edge shared by two faces — the whole point of networks. This is a real architectural gap, not a wiring gap. |
| 4.2 | Edit vector layers | ✅ | **Pointer:** `Host::vector_press` hit-tests in WORLD space against exactly the geometry that is painted — control handles first (`handle_at_world`), then anchors (`anchor_at_world`), then segments (`segment_at_world`); tolerance is the drawn size + 2px, divided by zoom. Click selects an anchor, ⇧-click adds, ⌥-click converts a curve point back to a corner, dragging moves every selected anchor, pen-dragging an anchor pulls handles out of a corner (`bend_anchor`, mirrored unless Alt), an empty drag lassos anchors (`Editor::lasso_select_points` → `point_in_polygon`) and an empty *click* deselects them. **Keyboard:** ⏎ enters the mode on a single vector layer (the engine refuses anything without anchors), ⏎/Esc leaves, ⌫ deletes the selected anchors, arrows nudge them (⇧ = 10px). **One undo step per drag:** `begin_path_gesture` snapshots the node, `live_rewrite_path` mutates the tree without logging, `end_path_gesture` pushes a single `ReplaceNode` (`vector_edit.rs:1431-1520`, 7 tests); `undo`/`redo` drop a stale snapshot, Esc cancels it. **Batch path ops** (all new, all tested): `move_anchors_by`, `delete_anchors` (refuses to leave <2 anchors, re-roots a deleted `MoveTo`), `split_segment_at` (de Casteljau at t=0.5 so a split cubic keeps its shape), `simplify_path`, `reverse_path`, `split_path_at`, `translate_path`, `bend_anchor`, `move_handle_in`. **Still missing:** no segment-hit *highlight* before the click, no per-anchor "close/open path" toggle in a menu (the engine has `pen_close`), no multi-layer node editing. |
| 4.3 | Create custom shapes with the shape builder tool | 🟡 | The honest path works: Union/Subtract go through `shape_builder_selected` with overlap measurement and a *reason* when it refuses (merging non-touching shapes, subtracting a full cover) — `CtxCmd::Union/Subtract` in `App::apply_ctx`. Intersect/Exclude keep the raw boolean, where an empty result **is** the answer. The `UpdateShapeBuilderHover` / `ExecuteShapeBuilderOperation` / `CutVectorPath` stubs (Intersect and Exclude were `// TODO`) were **deleted**. **Missing:** the interactive shape builder — hover-highlight regions and click/lasso to merge or cut. |
| 4.4 | Convert strokes to vector paths | ✅ | `Editor::outline_stroke_selected` (`x-editor/src/booleans.rs:194`) produces a real thick polygon from a stroked path, with per-layer stroke support and tests (`:329` region). Reachable three ways: **⇧⌘O**, the right-click menu ("Outline stroke", `editor_ui.rs:590`), and the palette. Refusals explain themselves ("Select one shape with a stroke weight to outline") instead of silently doing nothing. |
| 4.5 | Convert text to vector paths | ✅ | The two fake implementations were deleted — one emitted the text node's **bounding rectangle**, the other a `0.6 × font_size` **box per character**. What ships now is `x_native::outline_text_node(node, fonts, vars)` (`crates/x-native/src/lib.rs:130`): it derives every typography binding the way the renderer does (family/weight/size/line-height mode/letter-spacing/word-spacing/paragraph-spacing/baseline-shift/small-caps/optical-size/width-axis, plus per-run `TextRun` overrides), shapes through the **same** `x-text` pipeline the canvas uses (`node_text_outlines_rich` / `node_text_outlines_styled`), resolves natural line height exactly as `sinks.rs` does, elevates quad→cubic, and returns one `Vector` node carrying the text's transform, name, opacity, fill and fill stack. Undoable via `Editor::replace_node` (`App::outline_selected_text`). Reachable via **⇧⌥⌘O**, the context menu and the palette. |
| 4.6 | Offset a vector path | 🟡 | The old `offset_vector` added `distance` to **both x and y of every point** — a translation, not an offset; it and `offset_vector_enhanced` are gone. `x_core::booleans::offset_path(cmds, distance, join)` (`booleans.rs:841`, 7 tests) is a real normal offset: curves flattened at `OFFSET_FLATTEN_STEPS = 12` per cubic, per-vertex miter normals with a 4× miter limit that falls back to bevel, `Bevel` and `Round` corner treatments, and **winding measured rather than assumed** (`signed_area`) so positive distance grows a closed path outward and a counter-clockwise hole offsets the way the designer expects; a zero distance is refused rather than polygonising the path for nothing. `Editor::offset_vector` wraps it undoably. **Why still 🟡:** the only input path is the palette entry "Offset path outward by 4px" — no distance field, no inside/outside choice, no join picker, and curves come back polygonal. |
| 4.7 | Simplify a vector path | 🟡 | Real Ramer–Douglas–Peucker as a **keep mask** (`rdp_keep`, `vector_edit.rs:655`) so each survivor keeps its ORIGINAL command — a simplified curve stays a cubic instead of being flattened. It also guards against the failure mode a chord-only test has: any anchor bounding a segment that bulges more than the tolerance off its own chord always survives (`segment_deviation`, `:765`), so simplifying can never turn a curve into a straight line. Refuses to push when nothing was removed. **Why still 🟡:** the palette offers three preset tolerances (0.5 / 1 / 4 px) rather than Figma's slider with a live preview. |
| 4.8 | Boolean operations | ✅ | Our strongest vector feature. Exact polygon clipping (Greiner–Hormann) in `x-core/src/clip.rs` with curve-precise `bezier_clip.rs`, Union/Subtract/Intersect/Exclude on ⌘⌥U/S/I/X, context menu and command palette, mask + gradient + effect chains verified to survive the operation (`tests/mask_semantics.rs`, `tests/undo_redo_chain.rs`). |
| 4.9 | Flatten layers | 🟡 | The old `flatten_selection` in `editor_core.rs` was wrong on four counts (handled only `Vector` and `Rect`; mixed node-local and absolute coordinates, double-offsetting every rect; called the three non-existent methods from blocker 1; not undoable). It is **deleted**. `Editor::flatten_selected` (`x-editor/src/booleans.rs:113`) bakes the single selected shape **or group** — recursing through a group and accumulating each child's offset — into ONE vector path, normalises every subpath into the new node's local space (so the old double-offset is gone), mints a `fresh_id` rather than an id derived from the undo depth, and carries over name, fill, stroke, opacity, effects **and** a single shape's materialised paint stacks. Delete+Insert are pushed as one command group → one undo step. Reachable via **⌘E** (Figma's own shortcut), the context menu ("Flatten") and the palette, with a refusal message when the selection is not flattenable. **Why still 🟡:** overlapping subpaths are combined into a **compound path**, not unioned — interior edges survive, and opposite windings can leave a hole where Figma would merge the geometry. (Disjoint shapes, the common case, are correct: a compound path is exactly what flatten should produce.) A group's own paint stacks are deliberately left behind. |

---

## 5. Text and typography (14 articles)

Our best section by coverage — and the one place where the engine goes *beyond*
what Figma documents, because shaping is real (rustybuzz + BiDi + fallback) rather
than approximate. Unchanged by this branch except 5.x's new consumer: text
outlining (4.5) now runs through this same pipeline.

| # | Figma article | Status | What we have / what is missing (evidence) |
|---|---|---|---|
| 5.1 | Guide to text in Figma Design | ✅ | Text tool that starts **empty** and deletes itself if committed empty (explicit Figma parity), double-click to edit, caret + word selection + drag selection inside the editor, bounded inline undo before commit (`text_session.rs`), rich-text runs applied on commit. |
| 5.2 | Explore text properties | ✅ | Family, weight, size, line height with **three modes** (multiplier / px / percent), letter spacing, word spacing, paragraph spacing, baseline shift, text case, optical size, width axis, horizontal align (incl. justified), vertical align, decoration, truncation + max lines, paragraph indent, hanging punctuation, list style, wrap style — model at `node.rs:340-353`. Per-run overrides for colour/size/font/weight/italic/letter-spacing (`TextRun`, `node.rs:807-819`). |
| 5.3 | Add a font to Figma | ✅ | "Load font…" in the ASSETS panel and command palette → rfd dialog filtered to `.ttf/.otf/.ttc`, loads into the canvas font stack and **invalidates every per-doc frame cache** because text is baked into the scene graph (`Host::cmd_load_font`). |
| 5.4 | Browse and apply fonts | ❌ | No font browser. Font family is a free-text input — no enumeration of loaded families, no search, no weight/style submenu, no glyph preview, no "missing font" warning. The app bundles Inter 400/500/600/700 + JetBrains Mono for its own chrome (`fonts.rs`), but the user cannot discover what is available. |
| 5.5 | Create and apply text styles | ✅ | Named text styles with live binding: `Style::Text(TextStyleData)` (`document.rs:17-21`), create from selection / apply / detach / **update style from selection** and re-resolve every consumer (`Action::CreateTextStyle`, `ApplyTextStyle`, `DetachTextStyle`, `UpdateTextStyleFromSelection`), `bind_style`/`detach_text_style`/`resolve_styles` in the engine, picker dropdown in the typography panel. |
| 5.6 | Adjust text dimensions and resizing | 🟡 | Auto-width on commit (`autosize_text_node`) and real text metrics for hit-testing (`node.text_metrics`, `baseline`). **Missing:** Figma's explicit three-mode switch (Auto width / Auto height / Fixed size) — 0 refs to a text auto-resize mode; no text-box resize handles that reflow rather than scale. |
| 5.7 | Add links to text | ❌ | `TextRun` has no link field; `grep hyperlink|text_link|link_url` across the workspace returns **0 hits**. No clickable text in prototype playback either. |
| 5.8 | Add emojis and smart symbols | ❌ | No colour-emoji support — the gap is documented in our own test: "Color rendering (COLR/CBDT) is a known gap" (`crates/x-native/tests/typography_fixture.rs:261`). Monochrome glyphs can arrive via font fallback only. No smart symbols (©/™/→ substitution), no emoji picker. |
| 5.9 | Create bulleted and numbered lists | ✅ | `ListStyle` (None/Bulleted/Numbered, `node.rs:637`), `CycleListStyle` wired into the typography panel, paragraph indent + hanging punctuation to control the marker inset (`node.rs:349-352`). |
| 5.10 | Use icon fonts | ❌ | No icon-font handling (private-use-area glyph mapping, grid alignment, ligature-name icons). UI icons are hand-authored native vector paths (`icons.rs`) — right for chrome, but designers cannot use icon fonts in artwork. |
| 5.11 | Use OpenType features | 🟡 | Automatic and real: GSUB ligatures + GPOS kerning through rustybuzz with tests asserting `fi` liguates to one glyph and `AV` kerns tighter (`shaping.rs`), small caps via `small_caps_segments` + `SMALL_CAPS_RATIO` with a synthetic fallback when the face lacks `smcp`. **Missing:** user-facing feature toggles — no `ss01…ss20`, `tnum`, `frac`, `calt`, `zero` controls, and `TextRun` cannot carry per-run features. |
| 5.12 | Use variable fonts | 🟡 | Real axis plumbing: `Span.variations: Vec<(tag, value)>` applied with `face.set_variation`, `opsz` and `wdth` carried through the shaping cache key so axis changes invalidate correctly, inspector fields for weight / optical size / width axis (`FieldId::FontWeight/OpticalSize/WidthAxis`). **Missing:** axes discovered from the font's `fvar` table, axis sliders, named instances, per-run variations. |
| 5.13 | Add text in Chinese, Japanese, and Korean | ✅ | CJK line breaking **without spaces** is implemented and tested (`typography_fixture.rs:156-158`), plus font-coverage segmentation so one BiDi run can mix scripts and fall back per segment, with Noto CJK in the fallback list. Missing: kinsoku/priority break rules and vertical text. |
| 5.14 | Add right-to-left text | ✅ | `unicode_bidi::BidiInfo` paragraph + visual runs, per-run direction handed to the shaper, Arabic joining forms, and a test asserting Arabic shapes RTL with joining. Direction is inferred from content (like Figma); there is no explicit LTR/RTL paragraph toggle and no bidi-override control. |

---

## 6. Color, gradients, and images (11 articles)

Now the weakest section, and the only one still carrying dead wiring.

| # | Figma article | Status | What we have / what is missing (evidence) |
|---|---|---|---|
| 6.1 | Guide to fills | ✅ | Ordered multi-fill stack `fill_layers: Vec<PaintLayer>` with per-layer visibility/opacity/blend, materialised lazily so old `.x` documents stay valid (`node.rs:263-268`), Add/Remove fill + per-layer eye (`Action::AddFill/RemoveFill/TogglePaintVisibility`), variable-bound fills (`Paint::Variable`). |
| 6.2 | Update fills using the color picker | 🟡 | The picker popup is **16 hard-coded preset swatches + a hex label** and nothing else, plus hex/alpha fields in the inspector (`FieldId::FillHex/FillAlpha`). Missing: SV square + hue slider, RGB/HSL/HSV numeric modes, opacity in the popup, recent colours, document/library colours, colour styles, variable binding from the picker, and any way to reach a colour not in the preset grid except by typing hex. |
| 6.3 | Use gradients as a fill or stroke | 🟡 | Model is complete: Linear / Radial / **Angular** / **Diamond** with an explicit colour space (`GradSpace`) (`paint.rs:27-62`), plus flip / rotate / add / move / remove stop actions and a GRADIENT inspector section. **But a user cannot create one:** `AddFill` always constructs `Paint::Solid`, `Action::SetGradientType` has **0 dispatch sites**, and there are no on-canvas gradient handles. Gradients only appear in documents that were imported. |
| 6.4 | Use patterns as a fill or stroke | 🔧 | `Paint::Pattern{asset, fit}` (`paint.rs:58-61`) with `image_adjustments` applying to pattern fills, and asset collection walks patterns on export (`jobs.rs`, `session.rs`). **The app never constructs a pattern fill** — no UI, no "image as fill" conversion. |
| 6.5 | Apply blend modes to layers, fills, and effects | 🔧 | All 19 modes modelled and mapped to `peniko::Mix`, including `PlusDarker`, `PlusLighter` and `PassThrough` for groups/frames (`paint.rs:481-540`), with blend on the layer, on each fill layer, each stroke layer and each effect layer. **Zero blend UI**: the only `BlendMode` references in the app are internal Vello paint setup. Not one of the 19 modes is reachable. |
| 6.6 | Add images and videos to designs | 🟡 | PNG import exists (`x-format/src/png_import.rs`) but the app routes it through `open_path` — it **opens/replaces a document** instead of placing an image layer on the current canvas; the import dialog offers `svg, png, sketch, json`. No drag-and-drop, no multi-image place flow, no image tool in the toolbar (despite `docs/UI_CAPABILITY_MAP.md` listing "Image placement"). **Video: ❌** — no video node kind at all; the only video concept is a prototype trigger `WhenVideoHits{time}` (`x-core/src/prototype.rs:34-36`). |
| 6.7 | Adjust the properties of an image | 💀 | The IMAGE inspector panel exists with seven labelled sliders (exposure, contrast, saturation, temperature, tint, highlights, shadows) and the engine model is real (`ImageAdjustments`, `node.rs:14-45`; `x-render/src/image_adjustments.rs`). **The sliders are fake:** each one's hit region pushes `Action::UpdateImageAdjustment{value: (value + 0.1).clamp(-1,1)}` — clicking anywhere on the track adds 10%, there is no drag handling and no mapping from click position to value. `Action::SetImageFillMode` has 0 dispatch sites; only the two rotate buttons are wired. |
| 6.8 | Crop an image | 🔧 | Real crop model: `ImageFit::{Fill,Fit,Crop,Tile}` + `ImagePlacement{focal, scale, flip_h, flip_v}` (`node.rs:110-135`) with the transform math centralised in `x-core/src/image_transform.rs:76`. **No crop UI**: no focal-point editor, no crop handles, no zoom slider, no flips in the inspector. |
| 6.9 | Sample colors with the eyedropper tool | 💀 | Stub. `Action::EnableEyedropper` sets a toast "Eyedropper tool enabled - click on canvas to sample color" and then `// TODO: Implement actual eyedropper functionality`. No dispatch site, no `I` shortcut, no canvas read-back — and the message lies about the state. |
| 6.10 | View and adjust colors in a mixed selection | ❌ | Follows from 3.2: with a single-node inspector there is no "Mixed" chip, no selection-colour summary. (Bulk *paste* of one layer's colours onto many now works — 3.14 — but that is not the same as seeing and editing a mixed value.) |
| 6.11 | About color models | 🟡 | sRGB hex/alpha entry, `Color` with f32 components, `GradSpace` for gradient interpolation, and PDF/SVG export that emits the right colour operators. No RGB/HSL/HSV switching, no colour-profile handling, no library/document colour models in UI. |

---

## 7. Additional properties (3 articles)

| # | Figma article | Status | What we have / what is missing (evidence) |
|---|---|---|---|
| 7.1 | Stroke properties | 🟡 | Weight ✅, align (inside→center→outside) ✅, add/remove stroke ✅, multi-stroke stack `stroke_layers` with per-layer visibility/opacity/blend ✅, and **per-end caps are now real and reachable**: `Editor::set_stroke_cap_start` / `set_stroke_cap_end` (`editor_core.rs:2642-2648`) seed a stroke layer from the simple `stroke` when a node has none, refuse the no-op before cloning so it never reaches the undo stack, and are dispatched by `Host::apply_stroke_caps` from four palette entries (round / square / butt / arrow, both ends). Caps modelled: None, Round, Square, **Arrow**, **Triangle** (`paint.rs:402-409`). The `ApplyDashPattern` and `SetAdvancedStrokeCap` `// TODO` stubs were deleted. **Missing:** dash patterns (no UI, no model field), per-end cap *dropdowns* in the stroke panel (the palette applies to both ends), stroke gradients from the picker, and stroke align UI for variable-width strokes. |
| 7.2 | Apply effects to layers | 🟡 | Five effects modelled — DropShadow, InnerShadow, LayerBlur, BackgroundBlur and **Noise{amount,seed}** (a differentiator) — each wrapped in an `EffectLayer` with visibility/opacity/blend (`paint.rs:540-570`). UI: the Effects section is a **40 px row with a `+` button** that appends a default-parameters effect. No list of applied effects, no X/Y/blur/spread/colour controls, no per-effect eye, no shadow presets. |
| 7.3 | Adjust corner radius and smoothing | 🟡 | Uniform radius ✅ (`FieldId::Radius` → `Rect{radius}`) and `Editor::set_corners` for the four corners ✅ in the engine. Per-corner radii `corner_radii: [tl,tr,br,bl]` (`node.rs:277-278`) and **corner smoothing / squircle** `corner_smoothing: 0.0-1.0` with iOS-style continuous corners documented (`node.rs:279-283`) exist in the model and renderer. **No UI for either**: 0 `corner_smoothing` refs in the app, no independent-corners widget, no smoothing slider. |

---

## 8. Use auto layout (6 articles)

| # | Figma article | Status | What we have / what is missing (evidence) |
|---|---|---|---|
| 8.1 | Use auto layout with CSS Flexbox in mind | ✅ | The model *is* flexbox: `direction`, `gap`, 4-side `padding`, main-axis `sizing` (Hug/Fixed) plus independent `cross_sizing`, `align` (CrossAlign), `distribute` (Packed/Between/Around/Evenly = `justify-content`), `wrap` (NoWrap/Wrap) + `resize_on_wrap`, `min/max_width/height`, and two Figma-2026 parity flags: `stroke_include_in_layout` (border-box: inside strokes count toward min size and padding) and `canvas_stacking` for negative-gap overlaps (`layout_types.rs:360-399`). HTML export emits real CSS flex containers (`x-native/src/html_export.rs`). |
| 8.2 | Guide to auto layout | 🟡 | Reachable: add auto layout from the inspector, gap field + 4 padding fields, Hug/Fixed chips for main **and** cross axis, child Fixed/Fill segmented control, child absolute-position toggle, variable-bound gap/padding (`gap_var`, `padding_var`). **Missing:** child alignment (CrossAlign) and distribution UI — the 9-dot card in the auto-layout panel calls `align_selection`, which aligns the *multi-selection on canvas*, not the frame's children; no min/max width-height fields; "Remove auto layout" only exists in the decorative menu model (§9). |
| 8.3 | Toggle on auto layout in designs | ✅ | `Action::AddAutoLayout` (inspector button + palette). **Gap:** no keyboard shortcut — Figma's ⇧A is unbound. |
| 8.4 | Use the horizontal and vertical flows in auto layout | ✅ | `Action::FlowBtn(0/1)` → `apply_auto_layout` sets `LayoutDirection::{Horizontal,Vertical}`, with the sizing chips re-labelling themselves per axis. |
| 8.5 | Use the grid auto layout flow | 🔧 | A real CSS-Grid implementation, not a sketch: `GridLayout` with `GridTrack` rows/columns, `GridAutoFlow::{Row,Column,Dense}`, row-major and column-major placement scans, `AutoLayout.grid: Option<GridLayout>` that overrides the stack fields (`layout_types.rs:203-245, 386-388`; solver + tests in `x-core/src/grid.rs`). **Zero UI** — no `GridLayout`/`GridTrack`/`auto_flow` reference in the app. |
| 8.6 | Combine vertical, horizontal, and grid auto layout flows | 🔧 | Nested auto layout (frame-in-frame with independent flows) is exercised by a dedicated regression suite including cross-axis + variables + constraints + degenerate documents (`x-components/src/layout_regression.rs`), and each frame independently chooses stack or grid, so the combination is representable and solvable. But with no grid UI (8.5) and no child-alignment UI (8.2), a designer cannot author the mix — only an importer or a test can. |

---

## 9. Dead-code inventory (things that look shipped but are not)

### Removed on this branch

| Was | Disposition |
|---|---|
| 36 fake/stub `Editor` methods calling three non-existent methods (`mark_dirty`, `delete_node`, `add_node`) | Deleted; replaced by real implementations behind `rewrite_path` / `push_cmds` / `edit_batch` |
| `text_to_outline` (bounding rectangle) and `text_to_outline_enhanced` (a box per character) | Deleted; replaced by `x_native::outline_text_node` (real glyph outlines, 4.5) |
| `offset_vector` (translation masquerading as an offset) and `offset_vector_enhanced` | Deleted; replaced by `x_core::booleans::offset_path` (4.6) |
| `flatten_selection` (concatenate, mixed coordinate spaces, not undoable) | Deleted; replaced by `Editor::flatten_selected` (4.9) |
| `paint_vector_points` reading `NodeKind::Vector(v).segments` — a field that does not exist | Rewritten against `anchors_world`/`handles_world` (blocker 4) |
| `x-core/src/p0_features.rs` (258 lines, never compiled) | Deleted |
| `x-render/src/vector_network.rs` (769 lines, rendered a deleted type) | Deleted, with its `lib.rs` declarations |
| `Action::{CutVectorPath, SetVariableWidthStroke, MirrorBezierHandles, OutlineStrokeEnhanced, OffsetVectorEnhanced, TextToOutlineEnhanced, SimplifyVectorInteractive, UpdateShapeBuilderHover, ExecuteShapeBuilderOperation, ToggleShapeBuilderSelectionMode, ApplyDashPattern, SetAdvancedStrokeCap, AddBezierHandle, AdjustBezierHandle, DeepSelect, SelectLayerFromMenu, SetLayerSearch, ShowMeasurements, OpenBulkRename, CloseBulkRename, ApplyBulkRename, ToggleHiddenOutlines, OutlineStroke, FlattenSelection, TextToOutline, SetStrokeCapStart, SetStrokeCapEnd}` + the phantom types `MirrorMode`, `JoinStyle`, `ShapeOperation`, `SelectionMode`, `ArrowStyle`, `DashPattern`, `VectorTool`, `StrokeCapType` + the fields `layer_search`, `bulk_rename_*`, `show_hidden_outlines` | Deleted. Each was either a stub, a duplicate, or a handler with no dispatch site; the capabilities that were real are now reached through `CtxCmd` + `apply_ctx`, the pointer, or the palette |
| The P / V / X / Q / E tool-shortcut hijack (a "vector tool shortcuts" block that ran *outside* vector edit mode and `return`ed, so V no longer selected the Select tool) | Rewritten: the block is scoped to `vector_edit_mode.active`, and ⌘E is Flatten |
| Duplicate `"o" \| "O" if shift` arms (⇧⌘O bound twice, the second unreachable) | The unreachable one deleted with its action |

### Still dead (all pre-existing; none introduced by this branch)

Verified mechanically (every `Action::X` in the enum cross-checked against
construction sites in all app files, or-arms included) and then by the compiler.
The enum holds **172 variants, every one with an explicit arm in `dispatch`** —
exhaustiveness is no longer a claim but a property rustc enforces — and the
palette is exactly balanced (57 labels ↔ 57 dispatch arms, no dead entries, no
orphans). **20 variants have a handler and no dispatch site**: `CloseAppMenu`,
`CloseFind`, `CollapseAllLayers`, `EnableEyedropper`, `FileDuplicate`,
`FileMoveToDrafts`, `FileRename`, `MoveGradientStop`, `NewBoard`, `OpenFind`,
`ProtoActionType`, `ProtoAnimation`, `ProtoDest`, `RemoveGradientStop`,
`ResizeLeftSidebar`, `SetGradientType`, `SetImageAdjustments`,
`SetImageFillMode`, `ToggleMinimizeUI`, `ToggleNavLabels`.

**A correction to the previous revision of this document.** It reported four
enum-only variants — `ProtoAddAction`, `ProtoRemoveAction`, `ProtoSetVariable`,
`ProtoConditional` — as "silently swallowed by the `_ => {}` wildcard at the end
of `dispatch`". That was wrong, and reading code without a compiler is why: the
wildcard my scan found belongs to a *nested* match inside a dispatch arm, not to
`dispatch` itself. `dispatch` has no catch-all, so those four uncovered variants
were a hard `E0004 non-exhaustive patterns` — the app crate did not compile.
They are deleted (constructed nowhere; removing an interaction already goes
through `ProtoRemove(usize)`), which is what makes the 172 exhaustive.

| Feature area | State | Evidence |
|---|---|---|
| Rich right-click menu (Arrange ▸, Boolean ▸, Copy as ▸ SVG/CSS/PNG, Frame selection, Add/Remove auto layout, Detach instance, Paste here, Select layer) | Never dispatched. The menu that *is* shown is a flat `CtxCmd` list (now 21 items, incl. Flatten / Outline stroke / Outline text). `render_context_menu` is called only from its own unit test; `ContextMenu::click()` has 0 callers; `ContextAction` has 0 references outside `context_menu.rs`; the target is built with `contains_frame/component_instance/vector/text` **hard-coded `false`** | `context_menu.rs` (1,347 lines) vs `paint_context_menu` in `editor_ui.rs` |
| Eyedropper | Toast-only stub with a lying status message (6.9) | `Action::EnableEyedropper` handler |
| Image adjustment sliders | Click = +10%, no drag, no position mapping (6.7) | `Action::UpdateImageAdjustment` hit regions in `editor_ui.rs` |
| Gradient creation | Model complete, `SetGradientType`/`RemoveGradientStop`/`MoveGradientStop` undispatched (6.3) | §6.3 |
| `Quadtree` / `SpatialIndex` / `ShapeBuilderVisuals` / `VisualFeedback` (Phase-5 additions) | 0 references outside their own definitions — and they duplicate the shipping `SpatialGrid` | `x-editor/src/spatial.rs:12` |
| Blend modes (19), layout grids, constraints pins, scale tool, crop, patterns, corner smoothing, per-corner radii, grid auto layout, auto-layout distribute/align | Engine complete, no UI at all | §6.5, §3.17, §3.16, §3.8, §6.8, §6.4, §7.3, §8.5 |

---

## 10. Documentation drift (our docs claim things the code does not do)

| Document | Claim | Reality |
|---|---|---|
| `X-Native/docs/UI_CAPABILITY_MAP.md` | Primary toolbar includes "Section", "Image placement", and "Rectangle **and the Shape menu**" | Toolbar paints exactly 7 tools: Select, Frame, Text, Rect, Ellipse, Pen, Hand. No Section, no Image, no shape menu. |
| `X-Native/docs/UI_CAPABILITY_MAP.md` | "The Shape menu and command palette expose Polygon, Star, Triangle, Line, and Slice" | 0 references to Polygon/Star/Slice in the app; the palette has 57 fixed entries, none of them shapes. |
| `X-Native/docs/UI_CAPABILITY_MAP.md` | Inspector covers "rotation, **flip**, and constraints" | No flip and no constraints UI (§3.6, §3.16). |
| `X-Native/docs/UI_CAPABILITY_MAP.md` | "Auto Layout **and grid layout**"; "Multiple fills, strokes, effects, radius, opacity, and **blend**" | No grid-layout UI (§8.5); no blend UI (§6.5). |
| `X-Native/README.md` | "the command palette gained **Lint document**" | True — verified. (Listed for contrast.) |
| `X-Native/README.md` | Build/run instructions (`cargo build --release -p x-designer --bin x_native_app`) | Now accurate for this branch: the build **has** been run — `cargo build --workspace` and the full test suite pass on CI (§0, round 6). It is still inaccurate for `main`, which does not compile. |
| Root `PHASE2_…md` … `PHASE6_…md`, `VECTOR_TOOLS_COMPLETE.md`, `VECTOR_TOOLS_COMPLETE_SUMMARY.md` | Vector tools / path ops / advanced tools / interactive UI / action handlers "complete" | The code those documents described was largely deleted on this branch: it did not compile, and roughly half of it was undispatched or a stub. The *features* they claim now exist for real in §4 — but the documents describe different code and should be rewritten or retired. |
| Root `LAYER_MANAGEMENT_GAP_ANALYSIS.md` | Lists deep select, select-layer menu, smart selection, measurements, bulk rename, hidden outlines, layer search, keyboard nav as "missing" | Now split three ways: **wired** (⌘-click deep select, keyboard nav, renumber), **deleted as unwireable dead code** (select-layer menu, measurements, hidden outlines, layer search), and **still genuinely missing** (smart selection by properties, the find/replace rename modal). |

---

## 11. Shortcut parity deltas

| Operation | Figma | Ours | Note |
|---|---|---|---|
| Flatten | ⌘E | **⌘E ✅** | fixed on this branch (was unbound, and the engine op was wrong) |
| Outline stroke | ⇧⌘O | **⇧⌘O ✅** | fixed; ⇧⌘O previously toggled a flag nothing read |
| Outline text | ⌥⌘O (Figma) | **⇧⌥⌘O** | ours adds ⇧ to stay off Figma's ⌥⌘O; also in the menu + palette |
| Enter node edit mode | ⏎ / double-click | **⏎ ✅** (on a single vector layer) | double-click still dives into groups / edits text, as Figma does |
| Exit node edit mode | Esc / ⏎ | **Esc or ⏎ ✅** | |
| Delete selected anchors | ⌫ | **⌫ ✅** | refuses (with a reason) when fewer than two anchors would survive |
| Nudge anchors | arrows (⇧ = 10px) | **arrows ✅** | scoped to node edit mode, so it no longer fights the layer nudge |
| Split path at anchor | right-click ▸ Split | **⇧⌘B** | ours is a chord because the context menu is the flat `CtxCmd` list |
| Convert point → corner | ⌥-drag / convert tool | **⌥-click on the anchor ✅** | |
| Pull handles out of a corner | pen-drag on the point | **pen-drag on the point ✅** | Alt while dragging breaks the tangent, as everywhere else |
| Lasso anchors | drag on empty canvas | **drag on empty canvas ✅** | a click without movement deselects the anchors |
| Renumber selection | ⌘R modal (numbering) | **⇧⌘R** | numbering only; no find/replace (§3.13) |
| Layer-tree navigation | ⏎ child, ⇧⏎ parent, Tab/⇧Tab siblings | **same ✅** | fixed on this branch (handlers existed, nothing dispatched them) |
| Deep select | ⌘-click | **⌘-click ✅** | fixed on this branch |
| Select matching layers | ⌥⌘A | ⌥⇧M | deviation; the arm was already reachable |
| Inverse selection | ⇧⌘A (via Select menu) | ⌥⇧A | deviation — **and it did nothing until this branch**: the guarded arm sat *below* the unguarded ⌘A select-all arm, and rustc takes the first pattern that matches, so it was `unreachable_pattern` dead code. Moved above; now live |
| Copy properties | ⌥⌘C | **⌥⌘C ✅** | same arm-order bug, same fix — was shadowed by ⌘C copy |
| Paste properties | ⌥⌘V | **⌥⌘V ✅** | same — was shadowed by ⌘V paste |
| Add auto layout | ⇧A | *unbound* (inspector + palette) | |
| Use as mask | ⌥⌘M | *unbound* | no mask UI at all (§2.9) |
| Frame selection | ⌥⌘G | *unbound* | only in the decorative menu |
| Paste in place | ⇧⌘V | *unbound* (engine ready) | `Editor::paste_in_place` |
| Eyedropper | I / ⌥I | *unbound* | stub (§6.9) |
| Scale tool | K | *unbound* | engine ready (§3.8) |
| Simplify / Offset path | dialog with a value | palette presets (0.5/1/4 px; 4 px outward) | no dialog (§4.6, §4.7) |
| Group / Boolean / Rulers / Zoom | ⌘G, ⌘⌥U S I X, ⇧R, ⇧1 ⇧0 | **same ✅** | booleans: ours binds chords Figma only offers in a menu |

---

## 12. Recommended order of work

### P0 — done on this branch

1. ✅ x-editor: the three non-existent methods and the 36 that called them are
   gone; every path operation now goes through the command log
   (`rewrite_path`, `push_replace`, `push_cmds`, `edit_batch`) so it is undoable,
   and a refused operation pushes **nothing**.
2. ✅ state.rs: duplicate `Action` variants collapsed; phantom types deleted.
3. ✅ run.rs: `x_editor::`/`x_core::`/`self.editor` rerouted through the facade.
4. ✅ Enter shadowing fixed, and the vector-tool shortcut block scoped to the mode
   so P/V/X/Q/E stopped hijacking the primary tools.
5. ✅ Orphan files deleted (`p0_features.rs`, `vector_network.rs`) and the fourth
   blocker (`paint_vector_points` vs `NodeKind::Vector`) fixed.
6. ✅ **`./scripts/check.sh` has been run, and the branch passes it.** Not here
   (no toolchain, no network) but on CI, in seven rounds, each verdict feeding the
   next: `gate exit: 0` — formatting clean, LIVE lints 0, dead code 82/82, **896
   tests passed / 6 ignored**, docs references and CLI smoke green. §0 records
   every diagnostic and who introduced it. Note the direction of that number: the
   suite was 621 passing with 5 failing when it first ran at all, and `main` still
   does not compile.
7. ✅ **Dead-code ratchet reconciled.** Measured 84 against a ceiling of 76 that
   was last taken before the tree stopped compiling; the two write-only `extra_y`
   warnings deleted, every remaining item named in `docs/KNOWN_DEBT.md` §1, and
   the ceiling re-baselined to the measured 82 — upward, with the reason written
   down in the same file, because a ratchet that moves silently is worse than one
   that does not move.
8. ⬜ Correct §10's doc claims in the same commit, and retire or rewrite
   `VECTOR_TOOLS_COMPLETE*.md` / `PHASE2…6_*.md`, which describe deleted code.

### P1 — highest Figma-parity value per unit of effort (all engine-ready)

| Feature | Work needed | Why first |
|---|---|---|
| Blend modes (19) | One dropdown in the inspector bound to `node.blend` | Model + renderer done; Figma users reach for this daily (§6.5) |
| Constraints pins | The 2×3 constraints widget writing `node.pin` | Solver + tests done; blocks every responsive/resize story (§3.16) |
| Masks | "Use as mask" in the live ctx menu + ⌥⌘M + outline render | Render + SVG + 5 tests done (§2.9) |
| Gradient creation | Fill-type switch (Solid/Linear/Radial/Angular/Diamond) so `AddFill` can make a non-solid paint, and dispatch the three existing gradient-stop actions | Stops gradients being import-only; kills 3 of the 19 dead actions (§6.3) |
| Real colour picker | SV square + hue + alpha + RGB/HSL/HSV modes | Replaces 16 presets; unblocks 6.10 mixed-selection colour (§6.2) |
| Offset / Simplify dialogs | A distance + join field for offset, a tolerance slider with live preview for simplify | The engines are complete and tested; only the parameter input is missing (§4.6, §4.7) |
| Flatten overlapping subpaths | Run the collected subpaths through the clipper when their bounds intersect, instead of emitting a compound path | The only semantic deviation left in §4 besides vector networks (§4.9) |
| Per-end cap dropdowns | Two dropdowns in the stroke panel over `set_stroke_cap_start/_end` | Engine done and undoable; the palette only does "both ends" (§7.1) |
| Bulk rename modal | Find/replace + numbering + live preview over the existing `edit_batch` rename | The undoable batch primitive already exists (§3.13) |
| Layout grids | Paint `node.layout_grids` (the `guide_bands()` helper already computes the bands) + per-frame editor | Invisible feature today (§3.17) |
| Grid auto layout | Expose `GridLayout` tracks/flow in the AL panel | Complete solver already tested (§8.5) |
| Corner radius (per-corner) + smoothing | Inspector widget for `corner_radii[4]` + `corner_smoothing` | Model + renderer done; `Editor::set_corners` exists (§7.3) |
| Crop / image fit | Bind `SetImageFillMode` + focal-point drag; replace the fake sliders with drag handling | Two dead actions and one lying UI (§6.7, §6.8) |
| Sections, Line, Arc, Slice, Polygon/Star | Creation entries in a real Shape menu (`Node::section/line/arc/slice` all exist) | 5 model kinds are uncreatable (§2.2, §2.6, §3.9) |
| Bulk property edit + Mixed state | Make `sel_info` selection-wide | Single change unlocks 3.2, 6.10 and Figma-grade multi-edit |
| Measure distances (Alt-hover redlines) | New paint code + hover state | The only ❌ in "Work with layers" with real daily use (§3.10) |
| Multi-selection lock/hide/opacity | Apply to the whole selection, not `selection.first()` | Small correctness fix, visible in 2.1/3.11/3.12 |

### P2 — genuine new work (no engine to lean on)

Vector networks (an edge shared by two faces cannot be expressed in a `PathCmd`
list — this is a model change, not a wiring change); a pencil tool with freehand
capture (RDP is already there to smooth the result); the interactive shape builder
(hover-highlight + click/lasso merge and cut); a font browser; text links; text
auto-resize modes; colour emoji (COLRv1/CBDT); icon fonts; OpenType feature
toggles; video layers; image place-into-canvas + drag-and-drop; smart selection by
properties; the eyedropper; flip H/V and an on-canvas rotation handle;
drag-into-frame reparenting; code→canvas import (the one Figma capability where we
are pointed the opposite way, and where our read-only MCP server is the natural
extension point).

### Where we are ahead of Figma's "Create designs" list

Worth stating plainly, because it changes what P2 should be: an exact
polygon/polyline boolean clipper with curve-precise clipping (`x-core/src/clip.rs`,
`bezier_clip.rs`); a **winding-aware path offset** with miter-limit fallback and
three join treatments, tested against both windings (`x-core/src/booleans.rs:841`);
a **curve-preserving path simplify** that cannot flatten a bezier into a line
(`vector_edit.rs:706`); **one-undo-step interactive gestures** as an engine
primitive rather than an app convention (`vector_edit.rs:1431`); a design **audit
toolkit** Figma has no equivalent of — `lint` (15 rules, preset-driven, exit-code
4), `analyze` (colour/type/spacing/overlaps histograms, one command from palette →
named variables), `tree/find/node/info`, `export-jsx --tailwind`
(`x-native/src/mcp.rs`, `x-core/src/lint.rs`, `analyze.rs`); a **WCAG-audited UI
theme system** with a test that fails the build if a palette regresses
(`x-ui/src/design_system.rs`); Figma **`.fig` binary import**
(`x-format/src/figbinary.rs`, `kiwi.rs`); static-site HTML export with fonts
**subset to exactly the glyphs the document draws** (`x-native/src/html_export.rs`,
`x-text/src/subset.rs`); CSS-Grid auto layout (Figma shipped grid flow later and
more narrowly); and a Noise effect + `PassThrough`/`PlusDarker`/`PlusLighter`
blend completeness.
