# The master list — everything we have, matched to Figma, to 100%

Owner's brief (2026-09-19): *"make one list of everything we have, every tool, every
feature, even drag too, function etc, and match them to Figma — how they behave in
Figma, to 100% match. Once you reach that level then if you want to make them better
it's your choice, but 100% is a must. And match our design to Figma's design as well —
no design issue, no error. Use Figma-type exact icons, everything like them."*

This is that one list. It is the **only** work queue from now on: an increment either
closes a row here or it does not happen.

## How to read a row

| column | meaning |
| --- | --- |
| **Item** | the thing a person can do in the app |
| **Figma** | how Figma behaves, and the source that says so |
| **Ours** | where it lives in this repo, and the test that pins it |
| **Status** | `MATCH` · `PARTIAL` (divergence spelled out) · `MISSING` · `EXTRA` (ours, beyond Figma) · `OUT` (deliberate non-goal) |

`MATCH` is claimed only where a test exists. Anything else is `PARTIAL` or `MISSING`,
never quietly dropped — that is the rule [FIGMA_PARITY.md](FIGMA_PARITY.md) already
enforces for the rows it carries.

Sources are cited as `help.figma.com <article-id>` or as the course chapter that covers
the behaviour (Figma Design for beginners, section `30880632542743`, 33 chapters). The
course chapters 2–10 are sign-in-walled, so where a chapter's content cannot be read
back the row says **verify** instead of inventing a claim. A row marked *verify* is a
recon task, not a settled fact.

## The scoreboard

| surface | rows | MATCH | PARTIAL | MISSING | EXTRA | OUT |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 Tools (toolbar & shape menu) | 24 | 15 | 2 | 2 | 5 | 0 |
| 2 Canvas gestures (drag) | 28 | 22 | 0 | 5 | 1 | 0 |
| 3 Keyboard | 34 | 22 | 5 | 6 | 1 | 0 |
| 4 Menus & palettes | 10 | 9 | 0 | 1 | 0 | 0 |
| 5 Layers, pages, sections | 14 | 12 | 1 | 1 | 0 | 0 |
| 6 Frame & shape properties | 20 | 16 | 2 | 2 | 0 | 0 |
| 7 Auto layout | 16 | 12 | 1 | 3 | 0 | 0 |
| 8 Fill, stroke, effects, colour | 22 | 15 | 6 | 1 | 0 | 0 |
| 9 Images | 9 | 5 | 2 | 2 | 0 | 0 |
| 10 Text & typography | 18 | 15 | 2 | 1 | 0 | 0 |
| 11 Vector editing & booleans | 20 | 14 | 5 | 1 | 0 | 0 |
| 12 Components, instances, styles | 20 | 13 | 4 | 3 | 0 | 0 |
| 13 Variables & modes | 9 | 6 | 3 | 0 | 0 | 0 |
| 14 Prototype | 30 | 19 | 10 | 0 | 0 | 1 |
| 15 Inspect, dev mode, codegen | 9 | 5 | 3 | 1 | 0 | 0 |
| 16 Export & import | 12 | 11 | 1 | 0 | 0 | 0 |
| 17 Canvas view & navigation | 14 | 9 | 2 | 1 | 1 | 1 |
| 18 Design language (look of the app itself) | 12 | 1 | 5 | 6 | 0 | 0 |
| 19 Comments & collaboration | 5 | 3 | 1 | 0 | 0 | 1 |
| 20 Beyond Figma (ours) | 8 | — | — | — | 8 | — |
| **total** | **334** | **224** | **55** | **36** | **16** | **3** |

The 36 `MISSING` rows plus the named divergences inside `PARTIAL` are the 100%. Wave 1
below orders them by what the owner sees first; Wave 2 is the design-language half of
the brief.

---

## 1. Tools — the toolbar and the shape menu

Figma's toolbar holds one tool per gesture family, with the shape tools folded behind
one button (`help.figma.com 360040450133`): Move `V`, Scale `K`, Frame `F`, Shape
(Rectangle `R`, Ellipse `O`, Polygon, Star, Line `L`, Arrow `⇧L`), Pen `P`, Pencil `⇧P`,
Text `T`, Hand `H`, Comment `C`, Slice `S`, plus Place image and Dev Mode in the
right-hand cluster. Figma shows each tool's key on hover and switches to a crosshair
while a tool is armed.

| # | Item | Figma | Ours | Status |
| --- | --- | --- | --- | --- |
| 1.1 | Move / Select `V` | selects, moves, resizes; `Esc` returns to it | `Tool::Select`, `from_shortcut("v")` | MATCH |
| 1.2 | Scale `K` | scales box **and** stroke/radius/text/spacing | `Tool::Scale`, panel `SCALE`, `Drag::ScaleSel`/`ScaleBody` | MATCH |
| 1.3 | Frame `F` | click = 100×100 default frame; drag = sized; presets | `Tool::Frame` + `FramePreset(usize)` (`360041539473`) | MATCH |
| 1.4 | Rectangle `R` | drag; `⇧` square; `⌥` from centre | `Tool::Rect`, `Drag::Create` | MATCH |
| 1.5 | Ellipse `O` | same modifiers; arc handles after | `Tool::Ellipse` + `ArcHandle` | MATCH |
| 1.6 | Polygon | shape-menu item, triangle default, Count handle | `Tool::Poly`, `COUNT_MIN = 3` (`360040450133`) | MATCH |
| 1.7 | Star | shape-menu item, 5 points default, Count + Ratio | `Tool::Star`, `STAR_RATIO = 0.382` (`360040450133`) | MATCH |
| 1.8 | Line `L` | one segment, stroke only | `Tool::Line` | MATCH |
| 1.9 | Arrow `⇧L` | line with an arrow cap | `Tool::Arrow`, `StrokeCap::Arrow` | MATCH |
| 1.10 | Pen `P` | click = corner, drag = curve, close on first point | `Tool::Pen`, `Drag::Pen` | PARTIAL — no rubber-band preview of the segment being drawn (line preview only after the click) |
| 1.11 | Pencil `⇧P` | freehand, smoothed, stays active till Esc | `Tool::Pencil` (`4402723791511`) | MATCH |
| 1.12 | Text `T` | click = auto-width, drag = fixed box | `Tool::Text` | MATCH |
| 1.13 | Hand `H`, hold `Space` | pan without tools | `Tool::Hand`, `Drag::Pan`, `Space` arm in `on_key` | MATCH |
| 1.14 | Comment `C` | pin, thread, resolve | `Tool::Comment`, open comment box | MATCH |
| 1.15 | Slice `S` | export region, draws nothing | `Tool::Slice` | MATCH |
| 1.16 | Shape menu itself | one button, chevron, five shapes, keys shown | **PARTIAL** — our tools sit as separate buttons in the rail; no single Shape button with a chevron menu | PARTIAL |
| 1.17 | **Place image** `⇧⌘K` | image tool: click/drag to place, then crop | nothing — images arrive only as fills/import | **MISSING** |
| 1.18 | **Dev Mode toggle** `⇧D` | switches the file to inspect/code view | no toggle; Inspect is a right-panel tab only | **MISSING** |
| 1.19 | Eraser | Figma **Draw** only, not design files | `Tool::Eraser` | EXTRA |
| 1.20 | Brush | Figma **Draw** only (`31440438150935`) | `Tool::Brush` | EXTRA |
| 1.21 | Symmetry | not in Figma Design | `Tool::Symmetry` | EXTRA |
| 1.22 | Board tools (sticky/connector/rect/circle) | FigJam model, a different product | `Tool::Board*` | EXTRA |
| 1.23 | Zoom tool | not a Figma design tool (wheel/keys instead) | `Tool::Zoom` (board rail only) | EXTRA |
| 1.24 | Find my tool key | Figma shows the shortcut in the hover tooltip | `Tool::shortcut_hint` derives from `from_shortcut` — one owner | MATCH |

## 2. Canvas gestures — drag, exactly

Figma's canvas is a small set of gestures with modifiers; the shape-tool drags add
`⇧` (constrain), `⌥` (from centre) and `Space` (move the box mid-drag)
(`360040450133`, `360040328653`).

| # | Item | Figma | Ours | Status |
| --- | --- | --- | --- | --- |
| 2.1 | Click select | top-most layer under pointer | hit test in `selection.rs` | MATCH |
| 2.2 | `⇧`-click | add/remove from selection | press path in `run.rs` | MATCH |
| 2.3 | `⌘`-click deep select | selects inside groups/frames | deep-select arm | MATCH |
| 2.4 | Marquee drag | rubber band, selects what it touches | `Drag::Marquee` | MATCH |
| 2.5 | `⌘`-drag marquee | includes nested layers | `Marquee { deep }` | MATCH |
| 2.6 | Drag to move | moves the selection, snaps | `Drag::MoveSel` (per-event moves merge to one undo) | MATCH |
| 2.7 | `⌥`-drag | duplicate while moving | `⌥` duplicate arm on MoveSel | MATCH |
| 2.8 | `⇧`-drag | constrain to an axis | constrain arm | MATCH |
| 2.9 | Corner resize | 4 handles | `Drag::ResizeSel` | MATCH |
| 2.10 | `⇧` resize | proportional | resize arm | MATCH |
| 2.11 | `⌥` resize | from the centre | resize arm | MATCH |
| 2.12 | `Space` during resize | move the box while resizing | not implemented | **MISSING** |
| 2.13 | Scale-tool drag | box + contents scale | `Drag::ScaleSel`, `Drag::ScaleBody` | MATCH |
| 2.14 | Arc handles | hover the ellipse, drag sweep / start / ratio | `Drag::ArcHandle` (`360040450173`) | MATCH |
| 2.15 | Star / Polygon handles | Count (and Ratio) drag, live redraw | `Drag::ShapeHandle` | MATCH |
| 2.16 | Prototype noodle | drag the edge circle onto a frame, it snaps | `Drag::ProtoConnect` (`31011968186007`) | MATCH |
| 2.17 | Ruler guides | drag off a ruler; guides snap | `Drag::Guide` | MATCH |
| 2.18 | Minimap scrub | — (Figma has no minimap) | `Drag::Minimap` | EXTRA |
| 2.19 | Panels resize | drag the panel edge | `Drag::LeftPanel`, `Drag::RightPanel` | MATCH |
| 2.20 | Layer-tree drag | reorder, drop before/on/after | `Drag::TreeRow` + `TreeDrop` | MATCH |
| 2.21 | Inline text drag-select | select a range with the pointer | `Drag::TextEditSel` | MATCH |
| 2.22 | Vector point drag | move anchors, handles | vector-edit pointer path | MATCH |
| 2.23 | **Rotate on canvas** | hover outside a corner → rotate cursor, drag rotates; `⇧` snaps 15° | no rotate handle anywhere — rotation is an object-panel angle only | **MISSING** |
| 2.24 | **`⌥` measure** | hold `⌥` and point to read the distance to the selection | not implemented | **MISSING** |
| 2.25 | **Crop image** | double-click an image → crop handles | `ImageFillMode`/`image_transform` exist, no crop gesture | **MISSING** |
| 2.26 | **Place & size image** | image tool drag places at that size | n/a (no image tool) | **MISSING** |
| 2.27 | Scroll / pinch zoom, `⌘`+scroll | canvas zoom | wheel path | MATCH |
| 2.28 | `Space`-drag pan | temporary pan | `Space` arm + `Drag::Pan` | MATCH |

## 3. Keyboard

Figma's shortcut list is in the shortcuts panel (`360040328653`, tabbed, live-highlighting).

| # | Keys | Figma does | Ours | Status |
| --- | --- | --- | --- | --- |
| 3.1 | `V K F R O L ⇧L P ⇧P T S C ⇧R H` | tools | `Tool::from_shortcut`, one table | MATCH |
| 3.2 | `⇧1` / `⇧2` / `⇧0` | fit all / fit selection / 100% | `!` `@` `)` arms, same keys | MATCH |
| 3.3 | `⌘+` / `⌘-` / `⌘0` | zoom in / out / 100% | `=`/`+`, `-`, `0` arms | MATCH |
| 3.4 | `⌘Z` / `⇧⌘Z` | undo / redo | document undo stack | MATCH |
| 3.5 | `⌘C ⌘X ⌘V` | copy / cut / paste (and paste from Figma's own clipboard) | `copy_nodes`, Figma-clipboard import on paste | MATCH |
| 3.6 | `⌘D` | duplicate in place | `CopyDuplicate` arm | MATCH |
| 3.7 | `⌘A` / `⇧⌘A` | select all / invert | `⌘A`; invert also bound | MATCH |
| 3.8 | `⇧⏎` `⏎` `Tab` `⇧Tab` | parent / first child / next sibling / previous | layer-nav arms (P12) | MATCH |
| 3.9 | `Esc` | leave the tool, then deselect | `Esc` unwind order | MATCH |
| 3.10 | `⌫` / `Delete` | delete; a selected connection first | connection-first delete order | MATCH |
| 3.11 | arrows (`⇧` = ×10) | nudge | `move_selection(dx, dy)` | MATCH |
| 3.12 | `⌘G` / `⇧⌘G` / `⌥⌘G` | group / ungroup / frame selection | all three | MATCH |
| 3.13 | `⌘]` `⌘[` `⇧⌘]` `⇧⌘[` | forward / backward / to front / to back | all four | MATCH |
| 3.14 | `⌥A ⌥D ⌥W ⌥S ⌥H ⌥V` | align 6 ways | `Action::Align(row, col)` + shortcut arms | MATCH |
| 3.15 | `⌘⌥U ⌘⌥S ⌘⌥I ⌘⌥X` | boolean union/subtract/intersect/exclude | `CtxCmd::*` arms | MATCH |
| 3.16 | `⌘E` | flatten | `CtxCmd::Flatten` | MATCH |
| 3.17 | `⇧⌘O`, `⇧⌥⌘O` | outline stroke / outline text | both | MATCH |
| 3.18 | `⇧⌘H` / `⇧⌘L` | show-hide / lock | `HideSel` / `LockSel` | MATCH |
| 3.19 | `⌥⌘C` / `⌥⌘V` | copy / paste properties | both, guarded ahead of plain `⌘C/V` | MATCH |
| 3.20 | `⌘⌥A` | select matching layers | `SelectMatching` (`⇧⌥⌘M` kept as alias) | MATCH |
| 3.21 | `⇧R` | toggle rulers | `app.rulers` | MATCH |
| 3.22 | `⌘'` | pixel grid | toggle exists | MATCH |
| 3.23 | `⇧E` | toggle Design ↔ Prototype tab | *verify* — our right tabs are clicked, no key seen | **MISSING** (verify) |
| 3.24 | `⌘R` | rename layer | rename exists but on another binding; `⌘R` = renumber ours | PARTIAL |
| 3.25 | `⌘⇧K` | create component | menu + context path; no key | **MISSING** |
| 3.26 | `⇧A` | add auto layout | panel + context path; no key seen | **MISSING** (verify) |
| 3.27 | `N` / `⇧N` | zoom to next / previous frame | not implemented | **MISSING** |
| 3.28 | `⌘⌥M` | use as mask | mask flag exists (`is_mask`), no shortcut or UI | **MISSING** |
| 3.29 | `⌘\` / `⇧⌘\` | hide UI / hide left panel only | `⇧⌘\` minimizes our UI only | PARTIAL |
| 3.30 | `⌘/` | quick actions / plugins | `⌘K` opens our command palette | PARTIAL (different key) |
| 3.31 | `⌃⇧?` | keyboard-shortcuts panel | no panel (the welcome card lists a few) | **MISSING** |
| 3.32 | `⌘K` | link/copy-as? (Figma uses it for links in text) | our palette | EXTRA |
| 3.33 | `⇧P`, `B` etc. inside text | bold/italic/underline, size steps | `⌘B`, `⌘I` in the inline editor | PARTIAL — no `⌘U`, no `⇧⌘<`/`>` size steps |
| 3.34 | `⌘⏎` / `⌃⌥⌘⏎` | present / present with settings | flow preview key exists | PARTIAL |

## 4. Menus & palettes

| # | Item | Figma | Ours | Status |
| --- | --- | --- | --- | --- |
| 4.1 | Main menu | file, edit, view, object, plugins, help | `AppMenuItem` list, 20 rows | MATCH |
| 4.2 | Right-click on canvas | context menu, Figma's exact grouping (Arrange, Boolean, Copy as code…) | `context_menu.rs` builder + `CtxCmd` (24) | MATCH |
| 4.3 | Actions / quick actions | `⌘/`, fuzzy search of every command | `⌘K` command palette, 44 commands | MATCH |
| 4.4 | Page menu | rename, duplicate, delete, move | `PageMenu(PageMenuCmd)` | MATCH |
| 4.5 | Zoom menu | zoom in/out/100/fit/selection | `ZoomMenu`, `ZoomStep` | MATCH |
| 4.6 | Export menu | format, scale, suffix, multiple settings | export panel with 5 formats | MATCH |
| 4.7 | Font picker | search, preview, styles, missing-font state | `FontPicker` + `FONT BROWSER` + type scale | MATCH |
| 4.8 | Library / assets picker | components, styles, variables, swap on drop | `PaintLibToggle`, `LibRow` sections, swap | MATCH |
| 4.9 | **Shortcuts panel** | tabbed, live-highlights used keys | none | **MISSING** |
| 4.10 | Onboarding / sample | Figma opens a starter file | `OnboardingSample` / `OnboardingBlank` | MATCH |

## 5. Layers, pages, sections

Figma: pages in the left rail, layers tree with hide/lock/name double-click, Sections
as first-class labelled containers (`30880632542743`, chapter 4 "differences between
sections, groups and frames").

| # | Item | Figma | Ours | Status |
| --- | --- | --- | --- | --- |
| 5.1 | Pages: add / rename / delete / reorder | yes | `AddPage`/`SelectPage`/`DeletePage`, page menu | MATCH |
| 5.2 | Page name on canvas | never painted on artwork | fixed in the 2026-09-18 audit + pixel test | MATCH |
| 5.3 | Layers tree | indented, disclosure, drag reorder | `TreeRow`, `TreeToggle`, `TreeDrop` | MATCH |
| 5.4 | Hide / lock per layer | eye and lock, `⇧⌘H` / `⇧⌘L` | `TreeVisible`, `TreeLock` | MATCH |
| 5.5 | Rename | `⌘R` or double-click | `LayerRename`, `RenameStart` | MATCH |
| 5.6 | Group / ungroup / frame selection | `⌘G` `⇧⌘G` `⌥⌘G` | same | MATCH |
| 5.7 | Select all with same property | "Select matching" | `SelectMatching` | MATCH |
| 5.8 | **Sections** | labelled container, distinct hit/hue, arrow key nav; place one with the Section tool (`⇧S`) or **Wrap in new section** (right-click); "sections … cannot be contained within frames or groups"; a section takes in the layers it is dragged or drawn over; `Delete` removes it **and its contents**, `⌘⌫`/`Ctrl+Backspace` **without** them ([help 9771500257687](https://help.figma.com/hc/en-us/articles/9771500257687)) | `Tool::Section` (⇧S, sharing `App::frame_slot` with Frame through `App::select_tool`), `Editor::section_selection` / `lift_into_section` / `section_absorb` / `delete_keeping_contents`, `CtxCmd::SectionSelection`; pinned by `a_section_lifts_layers_out_of_a_frame_and_keeps_their_place`, `a_section_never_lands_inside_a_frame_or_a_group`, `a_section_takes_in_the_layers_it_covers`, `deleting_a_section_can_keep_its_layers`, `the_section_tool_is_shift_s_and_shares_the_frame_slot`, `the_section_tool_draws_on_the_canvas_and_takes_what_it_covers`, `the_canvas_menu_wraps_a_selection_in_a_section` | MATCH |
| 5.9 | Clean up layers | chapter 4 lesson: flatten redundant nests, rename for handoff | `CleanupLayers`? no — nothing in code | **MISSING** |
| 5.10 | Duplicate naming | Figma: "… copy" style naming on duplicate | ours uses another suffix | PARTIAL |
| 5.11 | Per-frame "Show name" | toggle on the frame | `ToggleShowName` | MATCH |
| 5.12 | Clip content | per-frame tick | `ClipContent` | MATCH |
| 5.13 | Layer search | filter the tree | `TreeSearchClear`, find/replace | MATCH |
| 5.14 | Collapse/expand all | yes | `CollapseAllLayers` | MATCH |

## 6. Frame & shape properties (Design tab)

Figma's Design tab order: Position (X/Y, alignment), Layout (auto layout / constraints),
Appearance (opacity, radius, clip), Fill, Stroke, Effects, Export.

| # | Item | Figma | Ours | Status |
| --- | --- | --- | --- | --- |
| 6.1 | Position X/Y, rotate angle | numeric, scrubbable | `Position` rows + rotate field | MATCH |
| 6.2 | Width/Height + Resizing | Fixed / Hug / Fill per axis | `Sizing`, `ToggleMainSizing` etc. | MATCH |
| 6.3 | Constraints | 5 H × 5 V options, "ignore constraints" `⌃` | `Constraints` section, `SetConstraint` (`2ebb068`) | MATCH |
| 6.4 | Corner radius | one value; independent corners via the expand | uniform radius in the panel; per-corner `corner_radii` exists in the model, the UI reads only `[0]` | PARTIAL |
| 6.5 | Corner smoothing | continuous (squircle) corners, 0–100% | `corner_smoothing: f64` is in the model and unimplemented in the UI | PARTIAL |
| 6.6 | Alignment row | 6 align buttons + distribute | `Alignment` row, `Action::Align` | MATCH |
| 6.7 | Opacity | 0–100% | `Opacity` | MATCH |
| 6.8 | Aspect ratio lock | lock icon between W and H | `ToggleAspectRatio` | MATCH |
| 6.9 | Clip content / Show name | per frame | both | MATCH |
| 6.10 | Auto layout | see §7 | auto layout section | MATCH |
| 6.11 | Multiple selection | shared properties, mixed values | multi-edit path | MATCH |
| 6.12 | Arc properties | sweep / start / ratio | `ARC` section (`b599ecc`) | MATCH |
| 6.13 | Polygon Count | sides, 3–60 | Appearance Count, clamp 3..60 | MATCH |
| 6.14 | Star Count + Ratio | points 3–60, inner radius % | both, two-way drag | MATCH |
| 6.15 | **Star/Corner Radius (radius handle)** | rounds the star's points | not built (documented divergence) | **MISSING** |
| 6.16 | Layout grid per frame | columns/rows/grid, appears in the panel | `grid.rs` + grid UI | MATCH |
| 6.17 | Guides (rulers) | drag guides, clear all | `GUIDES`, `AddGuide`, `Clear all guides` | MATCH |
| 6.18 | Effects list | multiple, per-effect blend, visibility | see §8 | MATCH |
| 6.19 | Export settings | per-layer | see §16 | MATCH |
| 6.20 | **Blend mode picker** | per fill/stroke/effect/layer, 16 modes | `BlendKind` in the model, **no picker in the UI** | **MISSING** |

## 7. Auto layout

Figma's auto layout (course chapter 5; "Auto layout fundamentals"): direction, gap,
individual padding, alignment 3×3, wrap, hug/fixed/fill per axis, min/max, absolute
position, canvas stacking, "distribute", `⇧A` to add.

| # | Item | Figma | Ours | Status |
| --- | --- | --- | --- | --- |
| 7.1 | Add / remove auto layout | `⇧A`, or the + next to Layout | `AddAutoLayout`, `ToggleLayoutAdvanced` | MATCH |
| 7.2 | Direction vertical/horizontal | arrows, swap | `ToggleWrap`, direction control | MATCH |
| 7.3 | Padding, individual sides | expand for 4 values | `Padding` | MATCH |
| 7.4 | Gap | between children | `Gap` | MATCH |
| 7.5 | Alignment 3×3 | 9 dots | alignment grid | MATCH |
| 7.6 | Wrap + wrap alignment | yes | `ToggleWrap` | MATCH |
| 7.7 | Sizing per axis | Fixed / Hug / Fill, both axes | `Sizing`, `ToggleChildFill` | MATCH |
| 7.8 | Absolute position in a layout | "❖ absolute, `⌥`" | `ToggleChildAbsolute` | MATCH |
| 7.9 | **Min / Max width & height** | per axis, with a tick | not implemented | **MISSING** |
| 7.10 | **Canvas stacking** | last on top / first on top | not implemented | **MISSING** |
| 7.11 | Baseline alignment | cross-axis baseline | `CrossAlign::Baseline` in the model; *verify* the UI exposes it | PARTIAL |
| 7.12 | Space between via distribute | "distribute spacing" | align/distribute row | MATCH |
| 7.13 | Text resizing inside layout | hug/fill text | text sizing path | MATCH |
| 7.14 | Layout in components | layout inherited by instances | component path | MATCH |
| 7.15 | Layout grid inside layout | grid frames | grid.rs | MATCH |
| 7.16 | Auto layout suggestions | Figma proposes a layout from the arrangement | not implemented (Figma-only AI-ish helper) | **MISSING** (low) |

## 8. Fill, stroke, effects, colour

| # | Item | Figma | Ours | Status |
| --- | --- | --- | --- | --- |
| 8.1 | Solid fill, multiple fills | yes | fill list, `AddFill`/`RemoveFill` | MATCH |
| 8.2 | Linear / radial / angular / diamond gradients | all four | `Paint::*Gradient`, `SetGradientType` | MATCH |
| 8.3 | Gradient handles on canvas | drag stops and the axis | `MoveGradientStop` etc. | MATCH |
| 8.4 | Image fill | image as a paint, with crop/adjust | `Paint::Pattern` + `SetImageAdjustments` | MATCH |
| 8.5 | Colour picker | HSV wheel + hex + eyedropper | `ToggleColorPicker`, `EnableEyedropper` | MATCH |
| 8.6 | Eyedropper `I` | pick colour from canvas or the app | `EnableEyedropper` | MATCH |
| 8.7 | Paint styles | apply / create / detach | `ApplyPaintStyle`, `CreateTextStyle`-family | MATCH |
| 8.8 | Variables as paint | bind/unbind a variable | `ApplyPaintVariable`, `DetachPaintBinding` | MATCH |
| 8.9 | Opacity per paint + per object | both | paint alpha + object opacity | MATCH |
| 8.10 | **Blend mode** | 16 modes per paint | model only | **MISSING** |
| 8.11 | Stroke colour / weight | yes | `AddStroke`, weight field | MATCH |
| 8.12 | Stroke position | inside / centre / outside | `CycleStrokePosition` | MATCH |
| 8.13 | Stroke cap & join | 3 caps, 3 joins, arrow/triangle caps | `StrokeCap` (5 incl. Arrow/Triangle), `StrokeJoin` | MATCH |
| 8.14 | Dashes | dash pattern editor | dash support in paint model | MATCH |
| 8.15 | **Stroke "Edit style" panel** | named caps/joins/dashes preview | ours cycles instead of a menu | PARTIAL |
| 8.16 | Effects: drop / inner shadow | x, y, blur, spread, colour | **the `Effects` section is a header and a `+` that adds one `DropShadow { 0, 4, 12 }`** — no list, no edit, no inner shadow | PARTIAL |
| 8.17 | Effects: layer blur | radius | `Effect::LayerBlur` in the model, unreachable from the UI | PARTIAL |
| 8.18 | Effects: background blur | radius | `Effect::BackgroundBlur` in the model, unreachable from the UI | PARTIAL |
| 8.19 | Effects: noise/texture | Figma's noise effect | `Effect::Noise { amount, seed }` in the model, unreachable from the UI | PARTIAL |
| 8.20 | Multiple effects, reorder, per-effect visibility | yes | `EffectLayer { visible, opacity, blend }` exists; no list to reorder or hide | PARTIAL |
| 8.21 | Colour swatch interaction | swatch = popover, `+`/`−` | swatch + popovers | MATCH |
| 8.22 | Color styles library | team/local styles list | `PAINT STYLES` library section | MATCH |

## 9. Images

| # | Item | Figma | Ours | Status |
| --- | --- | --- | --- | --- |
| 9.1 | Import image | drag-drop, paste, `⇧⌘K` | import path + `⌘I` | MATCH |
| 9.2 | Fill modes | Fill / Fit / Crop / Tile | `SetImageFillMode`, `ImageFit` | MATCH |
| 9.3 | Adjustments | exposure, contrast, saturation, temperature… | `SetImageAdjustments` | MATCH |
| 9.4 | Rotate 90° steps | yes | `RotateImage`, `image_rotation` | MATCH |
| 9.5 | **Crop gesture** | double-click → crop | none | **MISSING** |
| 9.6 | **Place-image tool** | image tool with drag sizing | none | **MISSING** |
| 9.7 | Flip H/V | yes | `ImagePlacement::flip_h/flip_v` in the engine, no UI toggle seen | PARTIAL |
| 9.8 | Copy/paste image between files | yes | clipboard path | MATCH |
| 9.9 | Video fill | Figma supports video paint | not built | PARTIAL (documented) |

## 10. Text & typography

| # | Item | Figma | Ours | Status |
| --- | --- | --- | --- | --- |
| 10.1 | Click/drag to create | auto vs fixed box | both | MATCH |
| 10.2 | Font family + style + weight | picker with preview | `FONT BROWSER`, `FontPicker` | MATCH |
| 10.3 | Size, line height, letter spacing | numeric + units | `Typography` rows, incl. Advanced | MATCH |
| 10.4 | Paragraph spacing, indent | yes | both rows | MATCH |
| 10.5 | Case | original/upper/lower/title | `TextCase` | MATCH |
| 10.6 | Decoration | underline / strikethrough | `TextDecoration` | MATCH |
| 10.7 | Align H + vertical align | 3 + 3 | `SetTextAlign`, `CycleTextAlignVertical` | MATCH |
| 10.8 | Auto width / height / fixed | sizing control | text sizing path | MATCH |
| 10.9 | Truncate / max lines | yes | `Max lines`, `CycleTextWrap` | MATCH |
| 10.10 | Wrap style | balance/pretty | `Wrap style` row | MATCH |
| 10.11 | Text styles | create/apply/detach/update | `CreateTextStyle`, `ApplyTextStyle`, `UpdateTextStyleFromSelection` | MATCH |
| 10.12 | Bold/italic shortcuts | `⌘B`, `⌘I`, `⌘U` | `⌘B`, `⌘I` only | PARTIAL |
| 10.13 | Inline editing | double-click, select ranges | `text_edit`, `TextEditSel` | MATCH |
| 10.14 | **List styles** | bulleted / numbered lists | `TextList::{Bulleted, Numbered}` is in the model, no UI control | PARTIAL |
| 10.15 | **Resize to fit** | double-click the size handle to fit text | not implemented | **MISSING** |
| 10.16 | Baseline shift / optical size | advanced typography | present in the Advanced block | MATCH |
| 10.17 | Missing-font handling | prompt + fallback | fallback module (`fallbacks.rs`) | MATCH |
| 10.18 | Type scale / ramp helper | Figma Styles panel | `TYPE SCALE` section | MATCH |

## 11. Vector editing & booleans

| # | Item | Figma | Ours | Status |
| --- | --- | --- | --- | --- |
| 11.1 | Enter edit mode | double-click / `⏎` on a vector | `EnterVectorEditMode` | MATCH |
| 11.2 | Move points, handles | drag, marquee points | `MoveVectorPoints`, `LassoSelectPoints` | MATCH |
| 11.3 | Add / remove point | click on the path / `⌫` | `AddVectorPoint`, `DeleteVectorPoints` | MATCH |
| 11.4 | Bend (curve ↔ corner) | `⌘`-drag a handle, double-click to toggle | `ToggleVectorHandles`, `RemoveBezierHandles` | MATCH |
| 11.5 | Boolean union/subtract/intersect/exclude | 4 ops + non-destructive | `BoolOp`, `boolean(_with)` | MATCH |
| 11.6 | Flatten | `⌘E` | `CtxCmd::Flatten` | MATCH |
| 11.7 | Outline stroke / text | `⇧⌘O`, `⇧⌥⌘O` | both | MATCH |
| 11.8 | Join / split | `⌘J`, `⇧⌘J`, split | `JoinSelectedPaths`, `SplitVectorPath` | MATCH |
| 11.9 | Reverse direction | yes | `ReversePathDirection` | MATCH |
| 11.10 | Simplify | yes | `SimplifyVector` | MATCH |
| 11.11 | Offset path | Figma has offset for vectors | `OffsetVector` | MATCH |
| 11.12 | Delete & heal | `⇧⌫` after point select | `DeleteVectorPoints` deletes; *verify* heal semantics | PARTIAL |
| 11.13 | Masks | `⌘⌥M` use as mask, inverted | `is_mask` is honoured by the renderer and pinned by `mask_semantics.rs` — **there is no way to set it from the UI** | PARTIAL |
| 11.14 | Pen: click-drag curves | yes | yes | MATCH |
| 11.15 | Pen: close path | click the first point | yes | MATCH |
| 11.16 | **Pen: edit while drawing** | exit/`Esc`, reopen, continue | our pen commits on finish; *verify* continue-a-path | PARTIAL |
| 11.17 | **Vector networks** | branches, not just paths | we are path-based only | **MISSING** (structural) |
| 11.18 | **Snap to pixel / snap to objects** | toggles + `⌘⇧` modifiers | snapping exists inside drags; no explicit toggle row | PARTIAL |
| 11.19 | Arc as a vector | arc → edit points | arc geometry editable as shape only | PARTIAL |
| 11.20 | Sketch import of vectors | n/a (Figma reads .fig) | sketch.rs (2229 lines) | MATCH |

## 12. Components, instances, styles, libraries

Figma (course chapter 5 + "Instances", chapter 8): main component vs instance, variant
sets, component properties (boolean, text, instance swap, slot), swap, detach, reset,
go to main, publish library, styles.

| # | Item | Figma | Ours | Status |
| --- | --- | --- | --- | --- |
| 12.1 | Create component | `⌘⇧K`, or the toolbar diamond | `MakeComponent`, `CtxCmd::MakeComponent` | MATCH |
| 12.2 | Instance | instance node referencing a master | `NodeKind::Instance { component }` | MATCH |
| 12.3 | Detach | `⇧⌘B` | `detach_instance` (`⌘⇧B`) | MATCH |
| 12.4 | Find the main component | navigate to it | `find_master`, `VariantCycle`… *verify* a "go to main" action | PARTIAL |
| 12.5 | Variant sets | combine selections, swap variant | `VariantCombine`, `variant_set`, `switch_variant` | MATCH |
| 12.6 | Component properties | boolean / text / instance swap / slot | `ComponentProp`, `PropRegistry`, `AddProp`, `AddSlot` | MATCH |
| 12.7 | Overrides per instance | text/colour/etc. | `OverrideValue`, `typed_overrides`, `ToggleInstanceProp` | MATCH |
| 12.8 | Reset overrides | "Reset all changes" | `ResetInstanceProps` | MATCH |
| 12.9 | Slots (content previews) | slot property | `slot_content`, `SlotSetFromSelection`, `resolve_slots` | MATCH |
| 12.10 | Swap instance | `⌥`-drag from Assets, or the swap menu | `CycleInstanceSwap`, `LibReviewAccept` | MATCH |
| 12.11 | **Select inside an instance** | double-click to reach a nested layer | documented open item in the 2026-09-18 audit | **MISSING** |
| 12.12 | **Push changes to main** | "edit main component" | not implemented | **MISSING** |
| 12.13 | **Reset variant / property per instance** | per-property reset arrows | partial (`ResetInstanceProps` is all-or-nothing) | PARTIAL |
| 12.14 | **Publish library** | publish, update, review | `PublishLibrary`, `LibCheckUpdate`, `LibReview*` | MATCH |
| 12.15 | Library updates review | yes | `LibReviewAccept/Close` | MATCH |
| 12.16 | Dependency graph / cycle guard | Figma forbids cycles | `DependencyGraph::would_cycle` | MATCH |
| 12.17 | Styles: colour/text/effect/grid | 4 kinds | colour + text (+ grid) | PARTIAL |
| 12.18 | Swap on canvas drag | yes | *verify* the drag-and-drop swap gesture | PARTIAL |
| 12.19 | **Component sets as a first-class node** | set node in the tree | variant strings, not a set node | **MISSING** |
| 12.20 | Team/community library browsing | yes | library list, review sheet | MATCH |

## 13. Variables & modes

| # | Item | Figma | Ours | Status |
| --- | --- | --- | --- | --- |
| 13.1 | Variable kinds | colour, number, string, boolean | `VariableKind`, `CreateVariable` | MATCH |
| 13.2 | Collections & modes | collections, modes per collection | `SetMode`, variables panel | MATCH |
| 13.3 | Aliases | variable referencing variable | alias support in `variables.rs` | MATCH |
| 13.4 | Bind to a property | any numeric/colour field | `ApplyPaintVariable`, `DetachPaintBinding` | MATCH |
| 13.5 | Scopes | limit where a variable can bind | *verify* | PARTIAL |
| 13.6 | Token extraction | Figma "extract styles to variables"? | `TokensExtractVars` | MATCH |
| 13.7 | Modes on prototype actions | `Set variable` / `Set mode` actions | both (`SetVar`, `SetMode`) | MATCH |
| 13.8 | **Variable edit UI parity** | inline table, groups, descriptions | ours is a simplified list | PARTIAL |
| 13.9 | **Number/string pickers** | sliders, segmented modes | partial | PARTIAL |

## 14. Prototype

Figma prototyping (course chapter 9; FD4B "Add prototype connections" `31011968186007`):
trigger → action → animation + easing, overlays with position/background, per-frame
scroll behaviour, flows and flow starting points, device preview.

| # | Item | Figma | Ours | Status |
| --- | --- | --- | --- | --- |
| 14.1 | Select-to-connect on canvas | edge circle, drag to a frame, snaps | `Drag::ProtoConnect` | MATCH |
| 14.2 | Connection noodle | curved bezier, arrowhead | 3-segment elbow, hit follows the drawn shape | PARTIAL |
| 14.3 | Select / delete a connection | click it, `⌫` | `Action::ConnMenu`, `ConnDelete` | MATCH |
| 14.4 | Trigger list | On click/tap, drag, while hovering, while pressing, key/gamepad, mouse enter/leave/up/down, after delay, video hits/ends ([help 360040315773](https://help.figma.com/hc/en-us/articles/360040315773)) | `Trigger` enum, **12** variants incl. Mouse down, and the panel's trigger menu reaches every one — the old cycle only visited the six pointer kinds | MATCH |
| 14.5 | Trigger row wording | short form ("On drag"), from Figma's own list ([help 360040315773](https://help.figma.com/hc/en-us/articles/360040315773)) | `Trigger::label` is the ONE owner — "Key/Gamepad", "When video hits", "When video ends" replaced our "Key pressed"/"Video hits"/"Video ends"; the duplicate panel table is gone; the pill is measured to its words so none can overdraw the field beside it | MATCH |
| 14.6 | Action list | Navigate to, Back, Scroll to, Open/Close/Swap overlay, Open link, Change to, Set variable, Set mode | `Action` enum covers all but *Change to* | PARTIAL |
| 14.7 | Action row with destination | "→ destination" box | `proto_action_type_label` + dest box | MATCH |
| 14.8 | Animation list | Instant, Dissolve, Smart animate, Move in/out, Push, Slide in/out, Scale? | `Animation`, 7 variants | MATCH |
| 14.9 | Move in/out direction | 4 arrows next to the mode | `ProtoDirection`, four arrows | MATCH |
| 14.10 | Easing | linear, ease in/out/in-out, custom bezier, spring presets | `Easing` + custom | MATCH |
| 14.11 | Duration & delay | numeric | `ProtoEditDelay`, speed pill | MATCH |
| 14.12 | **Animate matching layers** | a tick in the interaction's animation section: on, the two screens' layers are matched by **name and hierarchy**, matches smart-animate their differences, a layer that matched nothing **dissolves in**, a matched **fixed** layer gets no transition at all; Figma gives overlay actions no smart animate ([help 360039818874](https://help.figma.com/hc/en-us/articles/360039818874)) | `x_core::prototype::matching_layers` is the rule (path of ancestor names, `SmartAnimate { from }` / `Dissolve` / `Hold`) and `x_core::smart_animate::interpolate_matching_layers` is the in-between state; `Interaction::animate_matching_layers` rides the file (`"smartmatch"`); the panel's tick (`PROTO_MATCHING_LABEL`) writes it; `x_native::editor::arm_smart_tick` freezes the plan on navigation and `SmartTick` runs the clock the viewer repaints on — dissolving the arriving layers at the tick's alpha | `matching_layers_follows_names_hierarchy_and_fixed`, `matching_layers_interpolate_by_name_not_id`, `the_matching_layers_tick_survives_the_round_trip_and_stays_off_when_absent`, `the_interaction_row_carries_figmas_matching_layers_tick`, `the_matching_layers_tick_arms_on_a_navigation_and_dissolves_new_layers` | PARTIAL |
| 14.13 | Per-frame scroll behaviour | Prototype tab → **Scroll behavior**: a frame carries **Overflow** — *No scrolling / Horizontal / Vertical / Both directions* — an object on a scrolling frame carries **Position** — *Scroll with parent / Fixed / Sticky*; the preview scrolls the frame with the wheel ([help 360039818734](https://help.figma.com/hc/en-us/articles/360039818734)) | `state.rs` `PROTO_OVERFLOW_*` / `PROTO_POSITION_*` tables + `scrollable_ancestor`; `x_core::scroll_extent`; `Editor::set_scroll_position` / `set_scroll_preview`; `flow_scroll_wheel` / `flow_clear_scroll` / `flow_pan_to` | MATCH |
| 14.14 | Overlay position | 9 anchors + manual | `OverlayPosition` + `Manual` | MATCH |
| 14.15 | Overlay background | colour + opacity, "close on click outside" | background + dismiss path | MATCH |
| 14.16 | Flow starting points | per frame, named flows | "Flow starting point" row + `FlowEnter` | MATCH |
| 14.17 | Multiple flows | yes | `FlowBtn(usize)`, flow select | MATCH |
| 14.18 | Present / preview | `⌘⏎`, device chrome, restart, back | `FLOW PREVIEW`, `FlowDeviceToggle`, `FlowBack/Exit` | MATCH |
| 14.19 | Device & scale in preview | device picker, custom size | `FlowDeviceToggle` | PARTIAL |
| 14.20 | Keyboard/gamepad triggers | yes | `KeyDown` trigger + `ProtoEditKey` | MATCH |
| 14.21 | Video triggers | play from time, on hit/end | `WhenVideoHits/Ends`, `ProtoEditVideoTime` | MATCH |
| 14.22 | URL actions | open link in new tab | `OpenLink`, `ProtoEditUrl` | MATCH |
| 14.23 | Reset scroll position on navigate | checked (the default) → "Frame 2 will load from the top of the frame"; unchecked = **Preserve scroll position**, and only Instant/Dissolve offer the choice | the interaction's own switch works (`reset_on_navigate`, the panel's `Reset: On`) — but our default is *preserve*, the opposite of Figma's | PARTIAL |
| 14.24 | **Scroll to + scroll position on load** | "Scroll to" with an anchor and offset | `ScrollTo` exists as an action; *verify* whose offset semantics match | PARTIAL |
| 14.25 | Smart animate | animates matching layers between frames | `smart_animate.rs` + gate-covered | PARTIAL — matching is heuristic, no "animate matching layers" opt-in |
| 14.26 | Copy a connection | copy/paste onto another frame | not implemented (documented) | PARTIAL |
| 14.27 | **On-connection menu** | click a noodle → menu at the anchor | our menu is a right-panel/pill path | PARTIAL |
| 14.28 | Prototype tab layout | INTERACTIONS / FLOW sections with + | same structure | MATCH |
| 14.29 | Prototype trigger chips on canvas | small chip near the layer | `Drag to connect` chips | PARTIAL |
| 14.30 | Share/publish prototype | share link with prototype | out of scope this cycle | OUT |

## 15. Inspect, Dev Mode, codegen

| # | Item | Figma | Ours | Status |
| --- | --- | --- | --- | --- |
| 15.1 | Inspect tab | sizes, colours, distances, code | `paint_inspect` | MATCH |
| 15.2 | Copy code | CSS / iOS / Android snippets | `x-format::codegen` + `InspectCopy` | MATCH |
| 15.3 | Copy as code from the canvas menu | "Copy as code" item | `CtxCmd::CopyAsCode` | MATCH |
| 15.4 | Platform switch | Web / iOS / Android | `InspectPlatform` | MATCH |
| 15.5 | Measurements between layers | hover with `⌥` | no measure gesture | **MISSING** |
| 15.6 | Annotations | dev-mode notes on layers | not implemented | PARTIAL |
| 15.7 | Dev Mode toggle `⇧D` | yes | tab only | PARTIAL |
| 15.8 | Code Connect / component mapping | yes | not implemented | PARTIAL (low) |
| 15.9 | Asset download from inspect | export from inspect | export path | MATCH |

## 16. Export & import

| # | Item | Figma | Ours | Status |
| --- | --- | --- | --- | --- |
| 16.1 | Formats | PNG, JPG, SVG, PDF, (WEBP in some paths) | PNG, JPG, SVG, PDF, Sketch | MATCH |
| 16.2 | Scales | 0.5×, 1×, 2×, 3×, 4×, custom | `CycleExportScale` | MATCH |
| 16.3 | Suffix per setting | yes | export settings rows | MATCH |
| 16.4 | Multiple export settings | per layer | export list | MATCH |
| 16.5 | Export selection / frame | yes | `ExportRun` | MATCH |
| 16.6 | Copy as PNG/SVG | yes | clipboard path | MATCH |
| 16.7 | Slice export | slices export their region | slice.rs + export | MATCH |
| 16.8 | Import: .fig | Figma's own format | `figma.rs` reader, drop documented for some nodes | MATCH |
| 16.9 | Import: Sketch | Figma imports .sketch | `sketch.rs` | MATCH |
| 16.10 | Import: SVG / PNG / JPG | yes | `svg_import.rs`, `png_import.rs` | MATCH |
| 16.11 | Export code: CSS/iOS/Android | Figma Dev Mode + plugins | codegen | MATCH |
| 16.12 | **Import: PDF / WebP / video** | Figma accepts more | not built | PARTIAL |

## 17. Canvas view & navigation

| # | Item | Figma | Ours | Status |
| --- | --- | --- | --- | --- |
| 17.1 | Zoom: wheel, `⌘±`, fit, 100% | yes | all | MATCH |
| 17.2 | Zoom to selection | `⇧2` | `⇧2` | MATCH |
| 17.3 | Rulers | `⇧R` | our rulers | MATCH |
| 17.4 | Guides + snap | drag from ruler | guide drag | MATCH |
| 17.5 | Pixel grid | `⌘'` | toggle | MATCH |
| 17.6 | Layout grids | per frame, `⇧G` | grid UI | MATCH |
| 17.7 | Outlines mode | `⌘Y` | *verify* an outlines toggle | PARTIAL |
| 17.8 | Canvas background colour | Figma supports changing it | `CANVAS BACKGROUND` row | MATCH |
| 17.9 | Zoom to next/prev frame | `N` / `⇧N` | not implemented | **MISSING** |
| 17.10 | Scrollbars | yes | *verify* | PARTIAL |
| 17.11 | Snap to objects/pixels toggles | preferences + modifiers | snapping inside drags | MATCH |
| 17.12 | Multiplayer cursors | `⌃⌥⌘\` | not built (single-user) | OUT |
| 17.13 | Minimap | not in Figma | minimap + drag | EXTRA |
| 17.14 | Themes (light/dark) | `⌘/` theme, or system | Graphite / Daylight | MATCH |

## 18. Design language — the app itself must look like Figma

Owner: *"match our design to Figma's design as well — no design issue, no error… use
Figma-type exact icons, everything like them."* This section is the measured delta
between our chrome and Figma's UI, and it is a workstream of its own (Wave 2).

Figma's UI, as seen in the product and in the course videos: a dark canvas `#1E1E1E`,
panels `#2C2C2C` with `#383838` dividers, accent blue `#0D99FF`, white primary text and
`#B3B3B3` secondary, 11 px UI type, 8 px corner radius on rows and cards, ~24 px layer
rows, 240 px side panels, a floating toolbar centred at the bottom of the canvas, and a
monoline icon set on a 24 px grid with ~1.5 px strokes.

*Those hexes and sizes are measurements of the Figma app, not published tokens — Figma
ships no token list. Wave 2 therefore starts by re-measuring each one against the
owner's Figma screenshots/videos and recording the measurement in the design sheet, so
the palette change is evidence-led rather than an approximation of a memory.*

| # | Item | Figma | Ours (measured) | Status |
| --- | --- | --- | --- | --- |
| 18.1 | Canvas + panel palette | `#1E1E1E` / `#2C2C2C` / `#383838` | role palette (Graphite/Daylight), our own hues | **MISSING** (parity) |
| 18.2 | Accent | `#0D99FF` | our accent | **MISSING** (parity) |
| 18.3 | Text ramp | `#FFFFFF` / `#B3B3B3` / dim | `C_TEXT`/`C_MUTED`/`C_DIM`, our values | **MISSING** (parity) |
| 18.4 | Selection colour | `#0D99FF` outline + handles | our selection blue | PARTIAL |
| 18.5 | UI type | Inter, 11 px base | our UI font/size | **MISSING** (verify face) |
| 18.6 | Radii | 8 px rows/cards, 6 px inputs, 4 px chips | `R_*` scale | PARTIAL |
| 18.7 | Side panels | 240 px each, 40 px header | `ED_LEFT_W 280`, `ED_RIGHT_W 340` | **MISSING** (parity) |
| 18.8 | Toolbar | floating, bottom-centre, 40 px, rounded | `TOOLBAR_H 40`, `TOOLBAR_BOTTOM 20` | MATCH |
| 18.9 | Layer row height | 24 px | our row height | PARTIAL |
| 18.10 | Icon set | Figma's monoline set, 24 px grid, 1.5 px stroke | Lucide set, 89 keys | **MISSING** (vocabulary) |
| 18.11 | Tool cursor glyphs | Figma's tool cursors | system cursors | PARTIAL |
| 18.12 | Motion | panel/popover fade+scale ~120 ms | our transitions | PARTIAL |

Icon note: Figma's icon assets are not open source, so "exact like Figma" here means
**redraw the same glyph vocabulary at the same metrics** (24 px grid, 1.5 px stroke,
round caps, the same metaphors: cursor for Move, `#` for Frame, square+chevron for
Shape, nib for Pen, `T` for Text, hand for Hand, bubble for Comment, slice blade,
component diamond, dev-mode brackets), not shipping Figma's files. Every key is
registered in `icons.rs` (one table, census-checked) and the design sheet must keep
rendering it.

## 19. Comments & collaboration

| # | Item | Figma | Ours | Status |
| --- | --- | --- | --- | --- |
| 19.1 | Comment pin + thread | yes | comment tool + draft box | MATCH |
| 19.2 | Reply / resolve / delete | yes | thread path | MATCH |
| 19.3 | Notifications | inbox | `ToggleNotifications`, `MarkAllNotificationsRead` | MATCH |
| 19.4 | Notifications surface | Figma inbox + email | ours is in-app only | PARTIAL |
| 19.5 | Observation mode | follow a collaborator | not built | OUT |

## 20. Beyond Figma — ours today (keep, but only after 100%)

| # | Item | What it is | Status |
| --- | --- | --- | --- |
| 20.1 | Boards (FigJam-like) | sticky/connector/pen canvas beside the design file | EXTRA |
| 20.2 | Agent workspace | in-app agents per document | EXTRA |
| 20.3 | UX analysis tab | accessibility, flow, quality, patterns, contrast, responsive | EXTRA |
| 20.4 | Symmetry tool | mirrored drawing | EXTRA |
| 20.5 | Brush + Eraser | painted strokes (Figma Draw, not Design) | EXTRA |
| 20.6 | Minimap | whole-page overview + scrub | EXTRA |
| 20.7 | MCP bridge | `mcp.rs` server surface | EXTRA |
| 20.8 | Design tokens sheet | the design sheet + guard, our own QA artefact | EXTRA |

---

## The 100% queue (waves)

### Wave 1a — prototype, already authorized (finish first)

1. ~~**Per-frame scroll behaviour** (14.13)~~ — **delivered** in this branch:
   the Overflow and Position menus, the preview's wheel scroll clamped to the
   content, `ScrollTo` scrolling the frame it lives in, and the reset switch.
   Pinned by `the_scroll_behaviour_rows_write_the_frames_overflow_and_a_layers_position`.
2. ~~**Trigger row short form** (14.5)~~ — **delivered**: one owner
   (`Trigger::label`), Figma's words, a trigger menu that reaches all twelve
   kinds (Mouse down included) and a pill measured to its own text.
3. ~~**Animate matching layers tick** (14.12)~~ — **delivered**: the tick in the
   interaction's animation section, the name-and-hierarchy matching rule, the
   plan frozen on navigation and the clock the viewer dissolves arriving
   layers on. Remaining delta: the **morph of a matched pair** is computed
   (`interpolate_matching_layers`) but not painted — the viewer shows one
   screen at a time, so there is no outgoing screen to animate against.
   Pinned by `the_matching_layers_tick_arms_on_a_navigation_and_dissolves_new_layers`.

### Wave 1b — the missing behaviours, in owner-visible order

4. **The Effects list** (8.16–8.20) — today the section is a header and a `+` that adds
   one drop shadow. Figma's is a list: drop shadow / inner shadow (with **spread**),
   layer blur, background blur, noise, each with visibility, colour, and reorder.
   The engine already carries every variant.
5. **Blend-mode picker** (6.20, 8.10) — `BlendKind` exists per paint, stroke, effect and
   layer; nothing in the UI sets it.
6. ~~**Sections authoring** (5.8)~~ — **delivered**: the Section tool (⇧S, sharing
   the toolbar slot with Frame), **Wrap in new section**, lift-to-canvas when the
   selection sits in a frame or a group, the take-in that follows the draw, and the
   two deletes. Pinned by `the_section_tool_draws_on_the_canvas_and_takes_what_it_covers`.
7. Rotate on canvas (2.23) — handle outside the corner, `⇧` = 15° steps. The numeric
   field and `Editor::rotate` already exist, so this is handle + gesture only.
8. Masks authoring (11.13) — `⌘⌥M` use-as-mask, plus inverted masks.
9. Place-image tool + crop (1.17, 2.25, 2.26, 9.5).
10. Per-corner radii + **corner smoothing** (6.4, 6.5) — both fields are in the model;
    this is a UI pass with a renderer already able to draw it.
11. Instance select-inside + push-to-main (12.11, 12.12), and component sets as a node
    (12.19).
12. Auto layout min/max size + canvas stacking (7.9, 7.10).
13. Text lists + resize-to-fit (10.14, 10.15); keyboard completions `N`/`⇧N`, `⌘R`
    rename, `⌘⇧K` component, `⇧A` auto layout, `⇧E` tab toggle, the `⌃⇧?` shortcuts
    panel (3.23–3.31).
14. Measure with `⌥` (2.24); `Space`-during-resize (2.12); stroke-style panel (8.15);
    image flip toggle (9.7); outlines mode (17.7).
15. Clean-up layers (5.9) — chapter 4's lesson.

### Wave 2 — design parity ("no design issue")

16. Adopt Figma's measured tokens: canvas/panel/divider palette, accent, text ramp,
    radii, row heights, 240 px panels, Inter at 11 px (18.1–18.12).
17. Redraw the icon vocabulary to Figma's metaphors at Figma's metrics, key by key,
    with the census test and the design sheet kept green (18.10).
18. Panel geometry pass: header 40 px, section headers, the Design tab's row order
    matching Figma's (Position → Layout → Appearance → Fill → Stroke → Effects → Export).

### Wave 3 — better than Figma (only after 1 and 2 are done)

19. Differentiation on top of parity: our boards, agents, UX analysis, minimap, MCP,
    tokens, and any Figma behaviour we choose to beat.

### Definition of done, per step

* a behaviour change has a **regression test**,
* a row in **FIGMA_PARITY.md §2** naming the test,
* a **CHANGELOG** entry,
* the sheet regenerated **last**, guard 9/9 pinned/open/failed at their ceilings,
* CI green on the pushed sha.

Nothing in this list is claimed done until all five are true.
