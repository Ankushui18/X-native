# Changelog

Notable changes to the engine, the editor, the CLI and the MCP surface. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the version numbers
are the crate versions in `Cargo.toml`, which still drift (see
[docs/KNOWN_DEBT.md](docs/KNOWN_DEBT.md) §8) until a release decision is made.

## [Unreleased] — 2026-09-20 (Clean up layers — master row 5.9, wave 1 closes its last behaviour)

Item 15, scoped with the owner to the **chapter-4 framing**: flatten redundant
group nests; **rename stays manual** (Figma's layer-namer is an AI agent and is
not copied). Row 5.9 goes `MISSING` → `PARTIAL`; section 5 to **12 / 2 / 0**; the
grand total is re-derived (**339 / 261 / 48 / 11 / 16 / 3**).

- **`Editor::clean_up_layers`** unwraps any `Group` holding exactly one child
  that is *visually inert* (visible, unlocked, unmasked, opacity 1.0, Normal
  blend, no effects), applied bottom-up so a chain of single-child groups
  collapses in one pass; each lifted child inherits its group's offset so world
  positions are unchanged. Frames and sections are never touched, and a
  translucent/blended/effected group is left alone because unwrapping it would
  change what is drawn. The whole pass is **one undo entry**, mirroring
  `ungroup`'s snapshot idiom.
- **Reachable two ways**: the right-click menu's **Clean up layers** row (offered
  wherever *Ungroup* is, since it only ever unwraps redundant nests) and the
  command palette's "Clean up layers" entry; both route through
  `CtxCmd::CleanupLayers` so the status line ("Cleaned up N redundant group(s)" /
  "Nothing to clean up…") and the undo entry match.
- **Pinned** by `clean_up_layers_flattens_redundant_nests_in_one_undo`: a
  two-deep redundant chain collapses (chip keeps its world position), a
  translucent group survives, and one undo restores the nests.
- **Not built (documented remainder):** renaming (manual by owner choice) and
  FD4B's chapter-16 smart-selection tidy-up / `distribute_vertical`
  ([help 30979556779159](https://help.figma.com/hc/en-us/articles/30979556779159),
  [help 360040450233](https://help.figma.com/hc/en-us/articles/360040450233)).
  The engine already has `align` + `distribute_horizontal`.

*Rust gate note: `cargo`/`crates.io` remain unreachable in this sandbox, so the
new test runs in CI; the Node gates (`guard.mjs`, `check.mjs`,
`check_screens.mjs`) are the local check and stay green.*

## [Unreleased] — 2026-09-20 (Wave 2 opens: the chrome wears Figma's palette)

Master list Wave 2 item 16, partly delivered — rows **18.1, 18.4, 18.9** to
`MATCH` and **18.2, 18.3, 18.7** from `MISSING`/`PARTIAL` to `PARTIAL` with the
divergence named. Section 18 goes **1 / 5 / 6** → **4 / 6 / 2**; the grand total
is re-derived (**339 / 261 / 46 / 13 / 16 / 3**).

- **Graphite is Figma's dark chrome, not our own hues.** Canvas `#1E1E1E` —
  Figma's documented dark-mode default, *"In dark mode, the background defaults
  to an off-black color: #1E1E1E"* (help.figma.com 360041064814) — panels
  `#2C2C2C`, dividers `#383838`, strong edge `#4F4F4F`, and the greys neutral
  instead of the old blue-tinted ramp, because Figma's chrome is neutral. The
  purple accent (`#6B49F5`) is gone. Daylight's canvas is `#F5F5F5`, Figma's
  documented light-mode default.
- **Two of Figma's values are unreachable, and are now pinned rather than
  drifted.** White on Figma's `#0D99FF` measures **2.99:1** — under the 4.5:1
  floor `ColorTokens::contrast_audit` enforces, i.e. Figma ships that pair
  sub-AA — so the accent *fill* is `#0B77C9` (4.67:1), a deeper cut of the same
  hue, while `selection` and `focus_ring` keep Figma's `#0D99FF` exactly, where
  the 3:1 indicator floor admits it. Likewise Figma's dim `#8C8C8C` is 2.9:1 on
  `#2C2C2C`, and on this surface ladder the floor admits no grey darker than
  `#B3`, so the ramp sits `#FFFFFF`/`#C9C9C9`/`#BCBCBC`/`#B6B6B6`. Both
  decisions are asserted by `graphite_carries_figmas_chrome_values`, so neither
  can be "corrected" back into a sub-AA pair by accident.
- **The layer row is Figma's 24 px** (`TREE_ROW_H` 22 → 24), which is also the
  component scale's `DENSE_H` — the two owners finally agree, so the contract
  counts the tree row on-standard and `OFF_STANDARD_COMPONENTS` comes down
  2 → 1, with `on_standard_components_sit_exactly_on_their_step` and
  `app_row_heights_are_the_component_layers` updated to match.
- **The left dock is 240 px.** The right dock stays 340: at 240, 300 inspector
  boxes escape the panel, which `check_screens.mjs` measures and fails on. It
  moves with the inspector reflow (Wave 2 item 18), not before it.
- **Four tool glyphs redrawn to Figma's metaphors** (row 18.10). The icon
  *metrics* already matched — every glyph is on a 24 grid stroked at a constant
  1.5 px with round caps, which is Figma's — so the gap was vocabulary, not
  geometry. `Tool::Poly` now wears `polygon` (a regular pentagon: Figma's
  toolbar shows five sides even though the tool's default is a triangle),
  `Tool::Scale` wears `scale` (box + diagonal double arrow; Lucide's `maximize`
  reads as fullscreen), `Tool::Slice` wears `slice` (a bracketed region cut by a
  blade — it had been wearing Lucide's `scissors`, which is Figma's *Cut*
  action, so one metaphor meant two things in our chrome), and `section` is
  redrawn as Figma's dashed square rather than a solid rounded one that read as
  a frame. Set grows 93 → 96 keys; the census still reports 62 named, 0
  missing, and `the_polygon_and_star_tools_count_their_sides` moves to the new
  key.
- **`tools/design-sheet/figma_palette_probe.py`** re-implements
  `ColorTokens::contrast_audit` (8 text roles × 6 surfaces + 3 accent fills + 1
  label fill + 2 indicators = 54 pairs) so a palette can be audited on a host
  with no Rust toolchain. It reproduces the shipping palette's 54 / 0 result,
  which is what makes the new numbers trustworthy; the retuned palettes measure
  0 failures at 1.026× (Graphite) and 1.118× (Daylight) headroom.

## [Unreleased] — 2026-09-19 (Outlines mode)

[Designlab Figma 101 — Tips and Tricks](https://designlab.com/figma-101-course/tips-and-tricks)
— master row 17.7, the last row of wave-1b item 14. *"Show outlines — to
toggle outlines on and off, **⌘Y**"*.

- **The strip is one copy, never a document edit.** `x_render::outline_view(root,
  width)` clones the page and, per node, clears the fill, stroke and effect
  stacks (and the legacy single-paint fallback), puts the blend back to Normal
  and sets the stroke to a solid hairline in `OUTLINE_COLOR` (white — the
  wireframe ink) at `width`. Image and Text nodes paint themselves and would
  swallow the stroke, so they become the plain box they own — the named delta:
  Figma outlines the glyphs, we outline the text layer's box. Children are
  stripped recursively, so an instance resolves from the STRIPPED registry.
  The render root (the page — not a layer) keeps no outline of its own, so the
  canvas does not ring the whole window.
- **The canvas renders the copy, at `1.0 / zoom`.** `Host::canvas_scene`
  builds the stripped copy while `app.outlines` is on — the width follows the
  zoom, so the line stays ≈1 screen pixel at any zoom (a different picture,
  so the frame cache re-renders rather than serving the old width). It is a
  render mode on the app, like `presenting` on the `FrameCache`: no undo
  entry, no dirty mark, the document bytes untouched — undo, selection and
  the exporters keep their meaning.
- **⌘Y is the key again — redo keeps ⇧⌘Z.** The old `⌘Y`-as-redo arm (nothing
  pinned it; Figma's redo is ⇧⌘Z, which stays) is replaced by
  `Action::ToggleOutlines` with its status line ("Outline view on / off") and
  a row in the keyboard-shortcuts panel. The text editor's ⌃Y redo is a
  different branch and stays.
- **Not built:** Figma renders text as glyph outlines in outline view; we
  render the text layer's box.

Docs in the same change: row 17.7 `MATCH`, section 17 at **10 / 1**, the grand
total re-derived (**339 / 258 / 45 / 17 / 16 / 3**), a `FIGMA_PARITY.md` row
and the wave-1b item-14 note closed.

## [Unreleased] — 2026-09-19 (Image flip)

[Adjust alignment, rotation, position, and dimensions](https://help.figma.com/hc/en-us/articles/360039956914)
— master row 9.7, the item-14 row that was engine-only. *"Use the right-click menu to apply a flip
transformation, or the keyboard shortcuts: **Flip horizontal: ⇧ Shift H** · **Flip vertical: ⇧ Shift
V**"*.

- **⇧H / ⇧V are the transform's keys, not the tool table's.** `Tool::from_shortcut` had been handing
  the shifted forms to the Hand and the Move tool; it answers the plain keys now, and the flip arms
  run before the table — which is Figma's own assignment (`H` hand, `V` move, the shifted keys for
  the transform).
- **One write, three ways in.** `App::flip_images` toggles `ImagePlacement::flip_h` / `flip_v`
  through `Editor::set_image_placement` and folds a multi-layer selection into ONE undo entry. The
  ⇧H / ⇧V keys, the selection menu's **Flip horizontal** / **Flip vertical** rows (shown when the
  selection carries an image) and the two buttons the Image section paints beside Rotate 90° all
  reach it; the buttons record their row so a test or a screenshot can scroll the section into view
  the way a user does.
- **Not built:** flipping a vector or a group — the engine's flip lives on the image placement, so
  the shortcut is inert for the rest of the document.

Two glyphs land with it (`flip-horizontal`, `flip-vertical` — Lucide's pair, in `icons.rs` and its
census). Docs in the same change: row 9.7 `MATCH`, section 9 at **7 / 2**, the grand total
re-derived (**339 / 257 / 46 / 17 / 16 / 3**), a `FIGMA_PARITY.md` row and the wave-1b note.

## [Unreleased] — 2026-09-19 (Advanced stroke settings)

[Apply and adjust stroke properties](https://help.figma.com/hc/en-us/articles/360049283914)
— master row 8.15, the third of wave-1b item 14. *"Navigate to the **Stroke** section in
the right sidebar and select **Advanced stroke settings**"*: the panel Figma puts behind
the style icon, with named rows that show what they paint.

- **The panel's rows are one list.** `state::stroke_panel_rows(kind, join)` is what the
  card draws AND what its height comes from, so a row cannot go missing from either —
  and it follows the stroke it describes: the three style rows always, the **Dash** and
  **Gap** pair only for **Dashed**, the **Dashes** pattern field only for **Custom**, the
  three joins always, the **Miter angle** only for a **Miter** join, and both end-point
  rows.
- **The style is derived, not stored.** `StrokeStyleKind::of` reads the model's own
  shape — an empty pattern is Solid, a pair is Dashed, anything longer is Custom — so a
  pattern typed into the Dashes field can never leave the panel claiming a style the
  layer has not got. `StrokeStyleKind::pattern` carries the numbers over when a designer
  moves between the rows (a pair repeats into a Custom pattern, which draws the same
  line).
- **One writer.** `Host::edit_stroke_options` materializes the visual stacks, seeds the
  stroke layer from `stroke` when the layer has none, and **skips** a layer that already
  carries the options the row would write, so clicking the row a stroke already answers
  with never lands an undo entry. The Dash/Gap/Dashes/Miter-angle fields commit through
  the same writer, and the Miter angle the field speaks is `1 / sin(angle / 2)` — the
  relation the renderer's miter limit is.
- **Previews that cannot lie.** Every row that shows a line draws it through
  `paint::stroke_path_options`, built from the same caps/join/miter/dash pieces
  `x_render::text_geometry::stroke_style` builds for the canvas. The **Start point** and
  **End point** rows open `paint_stroke_cap_menu`, whose rows are named (None / Round /
  Square) and show the end each one paints; picking one writes only that end.
- **Row 8.13 corrected.** Building the cap menu turned up a claim the canvas cannot
  honour: `Arrow` and `Triangle` are stored in the model and round-trip through the file
  format, but both renderers map them to a butt end, and a head here is geometry
  (`arrow_path`, what the Arrow tool draws). The row now says `PARTIAL` with that named,
  which is the same scoreboard arithmetic — 8.15 up, 8.13 down.
- Docs in the same change: row 8.15 `MATCH`, row 8.13 `PARTIAL` (named), wave-1b item 14
  updated, a `FIGMA_PARITY.md` row, this entry, the sheet regenerated with `guard.mjs` at
  **10 checks / 67 pinned / 0 open / 0 failed**. **Not built:** Figma's separate **Dash
  cap**, its **Individual strokes** list, its Dynamic/Brush tabs, and the two head caps
  a line cannot yet end in.

## [Unreleased] — 2026-09-19 (Space moves the box mid-resize)

[Edit vector layers](https://help.figma.com/hc/en-us/articles/360039957634) — master
row 2.12, the second half of the canvas-gesture item: *"Hold Space while in the middle
of another action to move the points. Release Space to return to the previous action"*,
the rule the design-file shortcut tables carry as **Move while resizing**.

- **`Drag::ResizeSel`** gained its two riders. `space` is the pointer the last
  move-with-`Space` event landed on — `None` until the first one, so the box travels
  from where `Space` went down instead of jumping when it does — and `offset` is how
  far that travel has carried the box.
- While `Space` is held the box moves with the pointer and keeps the size the resize
  gave it, through `smart_move`, the call the plain layer drag uses: one snapping rule
  for both gestures. Letting `Space` go adds `offset` to the drag's `orig` and `start`,
  so the resize re-bases on the box's new place and the pointer keeps its grip on the
  corner it took hold of. With `Space` never used the offset is zero and the
  arithmetic is byte for byte what it was.
- Pinned by `space_moves_the_box_mid_resize_and_the_resize_resumes_from_there`, which
  drives both the single-layer path (the engine's own frame resize) and the
  box-arithmetic path a multi-selection takes.

## [Unreleased] — 2026-09-19 (Measure with ⌥)

[Measure distances between layers](https://help.figma.com/hc/en-us/articles/360039956974)
— master row 2.24. *"Select the first object in the canvas"*, *"Hold down the
modifier key"* (⌥), *"hover over the second object"* and *"Figma will display a red
line between the two objects, as well as horizontal and vertical measurements"*:

- **`App::measure_spans`** is the one answer to what is being measured right now: the
  selected layer against the layer under the cursor (the one the canvas already
  outlines), and nothing at all unless ⌥ is held with no drag, field or inline edit
  open. `state::measure_between` is the geometry — each axis measured between the
  edges the pair faces and anchored on the band the two share, with no line where the
  projections overlap, because Figma draws none there — and `world_rect_of` gives a
  nested or rotated layer its world bounding box.
- **`paint_measure`** draws that list and nothing else: the red line, its short end
  ticks and the value at the middle, in the app's own red (`C_MEASURE`). The hover
  outline takes the same ink while ⌥ is held, so the layer being read is the layer
  outlined.
- Pinned by `option_measures_the_gap_to_the_layer_under_the_cursor` and the
  geometry's own `measure_reads_both_axes_of_a_diagonal_pair` /
  `a_shared_band_anchors_the_line_and_an_overlap_reads_nothing`. **Not built:** the
  drag-time spacing numbers Figma shows while moving a layer, and measuring between
  two guides.

## [Unreleased] — 2026-09-19 (Keyboard completions)

Figma's [Keyboard shortcuts](https://help.figma.com/hc/en-us/articles/360040328653)
article, rows 3.23-3.31 of the master list — the last nine keyboard rows, every one
of them now `MATCH`. Row 3.28 (`⌘⌥M`, use as mask) was already built by the masks
increment; this one adds the rest:

- **`⇧E`** toggles the **Design** and **Prototype** tabs
  ([Guide to prototyping](https://help.figma.com/hc/en-us/articles/360040314193)).
  The vector eraser — ours, and Figma-Draw-only per master rows 1.19 / 20.5 — moves
  to the plain `E` rather than keep a key Figma gives to the tab toggle.
- **`⌘R`** renames the selected layer through `App::begin_layer_rename`, the entry
  the layers panel's double-click already used; `⇧⌘R` keeps this host's renumber.
- **`⇧A`** adds auto layout and **`⌥⌘K`** creates a component — each dispatching the
  path the panel or the context menu already takes, so a key and a menu row cannot
  drift. Row 3.25's key was wrong: `⇧⌘K` is Figma's *Place image*, which has been
  ours since row 9.6.
- **`N` / `⇧N`** zoom to the next / previous frame and wrap at either end, walking
  the page's top-level frames from the one the canvas centre is inside.
- **`⌘\`** hides the UI and **`⇧⌘\`** hides the **left panel only** — two states,
  because Figma has two keys; the left dock yields its width in `editor_regions`.
- **`⌘/`** opens the command palette Figma calls Quick Actions (`⌘K` still works),
  and **`⇧?`** opens a keyboard-shortcuts panel, painted from the same table.

## [Unreleased] — 2026-09-19 (Text lists and resize-to-fit)

Figma's [Create bulleted and numbered lists](https://help.figma.com/hc/en-us/articles/360040449773)
and [Adjust text dimensions and resizing](https://help.figma.com/hc/en-us/articles/27378154668951):
*"You can use ⌘ Command Shift 8 to turn an individual text selection or
multiple text layers into a bulleted list"*, the **List style** property in
the type details, *"When you manually change a layer's dimensions in the
canvas, Figma will also update the resizing property to Fixed size"*, and the
handle gesture that hands the box back to **Auto width**.

- **The property.** `ListStyle` (none / bulleted / numbered) was in the model
  and nowhere else; `Editor::set_list_style` is now its writer (a no-op is
  refused, so an unchanged style is not an undo entry) behind the Typography
  block's **List style** field, whose picker lists Figma's three rows, and
  behind `⌘⇧8` / `⌘⇧7` — the same shortcut pressed again gives the style
  back, which is the picker's own **None** row.
- **The markers.** One owner, in the shaper: `TextBlockStyle::list` takes the
  marker column (`LIST_MARKER_GAP`) off the wrap width, indents the text into
  it and shapes the item's bullet or its **1-based counter** in the column, in
  the line's own ink and at the line's type size — *"changes to the weight of
  your text will apply to the bullet or the counter"*. Because it lives inside
  `glyph_outlines`, the canvas, the raster sink, the PDF sink and the SVG
  exporter draw the same list, and `TextLayoutKey::list` keeps a bulleted
  block from being served a plain cached layout. A `ListStyle::None` block is
  byte-identical to the layout it had before this change.
- **Resize to fit.** `tm` is the resizing property (**Fixed size** when it
  says `fixed`, absent means auto width). Every hand-resize of a text layer
  writes it, and the way back is Figma's gesture: a second press on the
  layer's box handle inside the double-click window (`Host::fit_text_at`)
  clears it and re-fits the box to the text through `autosize_text_node`,
  which now carries the marker column too. The Layout section's **Resizing**
  chip shows the mode for a text layer and flips the two modes
  (`Action::ToggleTextResize`).
- **Not built:** list indentation levels (`Tab` / `⌘]`), **List spacing**, the
  hanging-quotes / hanging-lists toggles, counters rotating
  numbers → letters → roman per level and `⌥8`; and **Auto height** as a third
  mode of the resizing control.

## [Unreleased] — 2026-09-19 (Corner radius and smoothing)

Figma's
[Adjust corner radius and smoothing](https://help.figma.com/hc/en-us/articles/360050986854):
*"Hover just inside a corner until the white circle icon appears, then drag"*,
**Independent corners** in the right sidebar opening a value per corner, and
*"Click iOS to set corner smoothing to 60%"*.

- **The row.** The Appearance section's **Corner radius** field now carries
  Figma's leading icon — a square with one rounded corner — and the field is
  named **Corner radius**. The icon is the **Independent corners** toggle: it
  opens the **Corner radius details** panel under the row.
- **The panel.** `paint_corner_popover` paints Figma's four fields in the tl/tr
  over bl/br grid — each one edits ITS corner (`FieldId::CornerRadius(i)`) —
  and the corner-smoothing slider with the `iOS` chip at 60%. The row keeps the
  shape's single value, and the model keeps each corner's radius.
- **Rects and frames.** Figma's radius applies to rectangles *and* frames
  (polygons, stars and closed vector networks are still the open half, 6.15):
  `Editor::set_uniform_radius`, `set_corner_radius` and `set_corner_smoothing`
  are the three writers, each one undo entry with a no-op refused. A frame has
  no radius field of its own, so `Editor::set_corners` gives its uniform radius
  four equal corners; `Command::SetCorners` applies literally what it is handed,
  which is what lets undo put a frame back to carrying none.
- **The canvas dot.** Hovering just inside a corner of a single rectangle or
  frame shows Figma's white dot on that corner's arc
  (`state::radius_handle_at` / `radius_handle_point`); a drag rounds the whole
  shape along the corner's inward diagonal — the travel is relative, so a press
  a pixel off the dot never jumps the value — and `⌥` rounds that corner alone
  (rectangles, as Figma's own canvas gesture is). The corner's own square stays
  the resize handles', so on the outline you resize and just inside you round.
  `Drag::RadiusCorner` folds the gesture into ONE undo entry.
- **Not built:** the **Apply variable** slot on each corner field, a typeable
  smoothing value (slider + `iOS`), the Small/Big nudge keys on the radius,
  `⌥`-drag on a frame's corner, and per-point radius in vector-edit mode.

## [Unreleased] — 2026-09-19 (Crop)

Figma's [Crop an image](https://help.figma.com/hc/en-us/articles/360040675194):
*"Select a layer with an image fill"*, *"Double-click the image layer to enter
crop mode"*, *"Click on the canvas or press Enter to apply your changes"*,
*"Aspect ratio is maintained by default when cropping"*, *"Option/Alt also
modifies the opposite sides"*, and **Resize to fit** in the crop section.

- **The mode.** `App::crop` is the session: the layer, the placement and the
  fill mode from before it opened, and how many engine writes it has made.
  Entering switches the fill mode to **Crop**, which is what cropping an image
  does in Figma, and it opens from a **double-click on the image layer** or
  from the fill mode becoming **Crop** in the panel.
- **The gesture.** `Drag::Crop` + `state::crop_placement_from` resolve, in the
  LAYER's own space, the picture's new zoom and focal point: the picture scales
  about the corner **opposite** the one being held — `⌥` moves both sides, so
  the anchor is the frame's centre — and the image pixel under that anchor does
  not move, which is what makes it a crop and not a pan. One zoom for both axes
  keeps the aspect ratio; a drag inside the frame repositions the picture.
  `paint_crop_chrome` draws the frame, its four corner handles and the
  picture's own edges, and reads the zoom out in a chip while a corner is held.
- **Apply and cancel.** ⏎ or a click anywhere outside the frame applies
  (`App::crop_apply`), folding the whole session into ONE undo entry
  (`merge_last`); Esc (`App::crop_cancel`) writes the placement and the fill
  mode back and folds the session including the putting back.
- **The panel.** The **IMAGE** section grows Figma's **CROP** block while the
  mode is open: **Resize to fit** (`Editor::fit_image_to_picture` — the layer
  becomes the size of the whole picture with a clean crop, box, focal point and
  zoom in one entry).
- **Engine.** `Editor::set_image_fit` and `Editor::set_image_placement` join
  `set_image_asset` as the image writers: each swaps the node through
  `replace_node`, so each is one undo entry and a no-op write is refused.
- **Not built:** the faded uncropped surround (the frame's clip is all the
  canvas shows), `Control`'s free aspect (our crop zoom is uniform), the
  **Aspect ratio** picker, the crop-value slider, the `⌘`-drag quick crop, and
  the rotate/resize gestures inside the mode — a press there belongs to the
  crop until it is applied.

## [Unreleased] — 2026-09-19 (Place image)

Figma's **Place image/video** (`360040028034`): *"Select Image/video from the
Shape tools menu … or use the keyboard shortcut ⇧⌘K"*, *"Click on the canvas to
place the image or video in a new layer, using its original dimensions"*,
*"Select an existing object on the canvas to replace its fill with the image or
video"*, and *"To discard any remaining images or videos, press Delete"*.

- **The cursor.** `Tool::PlaceImage` is not a rail button — it is the pending
  placement. `App::placing_images` holds the asset ids a pick left behind, one
  file leaves the queue per placement, and the last one hands the rail back to
  Select. `⇧⌘K` (the ⌘K command palette keeps its own key), the File menu's
  **Place image…** row and the command search all reach `Host::cmd_place_image`;
  `Host::place_images` is the half a test can drive without a dialog.
- **Click or drag.** A click places the file at the size its header reports —
  `probe_dimensions`, never a decode — scaled down proportionally when the file
  is past Figma's 4096 px cap (`PLACE_MAX_DIM`); a drag reuses the ordinary
  create gesture and draws the image at the box you drew. Either way the
  placement is ONE undo entry and the layer takes the file's name.
- **Images are fills.** A click that lands on a layer fills that layer instead
  of stacking a new one; an image layer takes the new picture through the new
  `Editor::set_image_asset`, which keeps its fit mode, focal point, scale and
  flips (`replace_node`, so it is one undo step), exactly as the help page asks
  of a replaced fill. A pick made with a selection already standing fills it
  straight away.
- **Esc and Delete.** Esc drops the placement; `Delete` — the documented
  discard — throws the rest of a bulk pick away without touching the layers.
- **Not built:** the crop half of the same article (crop mode, handles,
  **Aspect ratio**, **Resize to fit**, the `⌘`-drag quick crop — master rows
  2.25/9.5), **Place all**, the cursor's count badge, HEIC/TIFF/video, and OS
  drag-and-drop (`WindowEvent::DroppedFile` is still unhandled).

## [Unreleased] — 2026-09-19 (Masks)

Figma's masks (`360040450253`): *"Masks sit below the layers they affect, and apply
to all layers above them"*, *"any layer can be a mask"*, and the design panel's
**Mask** section switches the mask's **type** — *Alpha*, *Vector*, *Luminance*. The
model, the file format and the renderer already carried `is_mask` and pinned it with
tests; there was no way to set it from the UI at all.

- **Authoring.** `Editor::use_as_mask` is the ONE writer: `⌘⌥M` (Figma's own
  shortcut), the canvas menu's **Use as mask** row and the sidebar row all call it.
  One layer selected flips its own flag; several are wrapped in the mask object
  Figma creates — a group whose bottom layer is the mask — in ONE undo entry
  (`merge_last`), and the mask object is what the gesture selects. Pressing it again
  on a mask object clears its mask, so one gesture is the toggle.
- **The stack survives.** The selection is z-ordered before grouping, because
  `group_selection` keeps the caller's order: the mask has to land at the bottom
  (paint order is document order) or the clip would hide the wrong layers.
- **The type.** `x_core::MaskType` (Alpha, the default; Vector; Luminance) rides on
  `Node::mask_type`, on the file as `maskType`, into the frame cache's hash, and into
  the right panel's **Mask** section — the dropdown Figma puts there, with the current
  type checked. A layer that is not a mask yet gets Figma's *Use as mask* row in that
  same slot.
- **What the types do.** The IR's mask scope is the clip *plus* the mask's own
  opacity: **Vector** ignores translucency (the documented *"any translucency is
  ignored"*), **Alpha** scales by the mask fill's alpha × the layer's opacity, and
  **Luminance** by the fill's relative luminance — a black mask hides everything, a
  white one hides nothing. Exact for a single solid fill; a gradient, blur or image
  mask clips hard instead of per pixel, which is the named delta.
- **Any layer.** `mask_path_of` fell back to `None` for text, images, groups and
  frames, so those masks silently did nothing; it now clips them to their bounds — a
  superset of Figma's per-pixel coverage, and the second named delta.
- **Not built.** *View → Mask outlines* (the green boundaries), the layers-panel mask
  glyph and the arrows Figma draws over the masked layers, and per-pixel mask
  compositing.

## [Unreleased] — 2026-09-19 (Rotate on canvas)

Figma's canvas rotate (`360039956914`): *"Hover just outside one of the layer's
bounds until the icon appears. Click and drag to rotate your selection … Hold
down Shift to snap rotation values to increments of 15."* Ours had the angle in
the object panel and nothing on the canvas at all.

- **The zone sits outside the corners.** `state::rotate_corner_at` owns it: it
  reaches `ROTATE_RING` (22 screen px) out from a corner and starts past the
  resize handle's own 6 px (`HANDLE_TOL`), so one press is a resize or a rotate
  and never both. A point *inside* the bounds is never a rotate, so selecting,
  marqueeing and the move drag are untouched.
- **The pivot.** `state::rotation_pivot` is one layer's own transform origin when
  a single layer is selected — the thing `⌥R` moves — and the centre of the
  selection box otherwise, which is the documented default: *"Figma uses the
  horizontal and vertical center of the current selection as the point of
  rotation by default."*
- **The gesture.** `Drag::RotateSel` records the selection at the press and the
  angle swept so far, so every move asks for the TOTAL delta — the last move wins
  instead of compounding — and a pointer that crosses ±180° keeps turning rather
  than jumping a circle. `⇧` snaps the resulting angle to 15°; the release merges
  the drag into ONE undo entry and reports `Rotated N°`.
- **The field takes Figma's range.** `Editor::set_selection_rotation` applies the
  angle to every selected layer as one entry and normalizes the way the help page
  describes — *"going 15° past 180° will give you an angle of -165°"* — with
  `x_core::normalize_degrees` the one owner of that convention and
  `Transform::rotate_about` the orbit itself.
- **`⌥R`.** `Action::ToggleRotationOrigin` reveals Figma's **rotation origin**
  (*"use the keyboard shortcut ⌥R to reveal the rotation origin"*); the target on
  the layer is dragged through `Drag::RotationOrigin` → `Editor::set_origin`, and
  the next rotate turns about it. The arm is asked for before the tool table, so
  `⌥R` never reads as the Rectangle tool.
- **Named deltas.** Figma's bespoke rotate *cursor* over the ring is not drawn —
  winit has no rotate glyph and this canvas shows no hover cursors for its other
  handles either — and the ring follows a transformed layer's rendered corners
  rather than a glyph that animates as you hover. The stored angle's **sign**
  follows the renderer's own convention (`linear` is `Affine::rotate` on a y-down
  canvas), so our field counts *clockwise-positive* where Figma's counts
  counter-clockwise; the gesture's direction is right either way (the layer
  follows the pointer). Master list 6.1 is now PARTIAL on that, and the display
  conversion is a Wave-2 design-parity task, because flipping the stored sign
  would move the renderer, the exporters and the hit test together.

## [Unreleased] — 2026-09-19 (Effects list and blend modes)

Figma's Effects section is a **list**, and `360041488473` says exactly how to
work it: add one of the types from the `+`, switch a row's type from its own
dropdown, hide an individual effect, edit the settings the *Effect settings*
discloses, duplicate it (*"⌘D … duplicate the effect"*), reorder it by dragging a
row. Ours was a header and a `+` that added one fixed drop shadow: no list, no
edit, and Figma's other four types unreachable from the UI.

- **One list, one owner per fact.** `Effect::kind` / `Effect::fields` /
  `Effect::field` / `Effect::set_field` / `Effect::color` / `Effect::set_color`
  describe what each type carries, and `EffectKind::{all, label, icon}` own the
  five types in Figma's dropdown order. The panel builds every row and settings
  block from those, so a type can never grow a field the model has no place for —
  a Blur shows **Radius**, Noise shows **Density**, a shadow shows **X / Y /
  Blur** plus its **Fill**.
- **The writers.** `set_effect_kind`, `set_effect_field`, `set_effect_color`,
  `set_effect_layer_visible`, `duplicate_effect_layer`,
  `set_effect_layer_blend` and the existing add / remove / move. Each refuses
  before pushing an undo entry when the row or setting does not exist, so a click
  on a stale row changes nothing at all (`effect_at`).
- **The legacy list follows.** `mutate_visual_stack` now mirrors the ordered
  `effect_layers` stack into the flat `effects` list the `.x` format and the
  direct sink read, so an effect added, retyped, hidden or reordered in the panel
  paints that way on every path.
- **Blend modes** (`360040667874`): `BlendKind::{label, layer_modes, paint_modes,
  row_in}` hold Figma's words and its two lists — the layer menu is the paint menu
  with **Pass through** in front, because *"Pass through cannot be applied to
  fills or effects"* while it is the default for layers. Writable on the layer
  (Appearance row), on a fill/stroke (the colour popover's **Apply blend mode**
  row) and on a shadow or noise effect (the effect row's own blend).
- **The app.** The Effects section paints the list: type dropdown, settings,
  the shadow's Fill swatch (which opens the real colour popover, now targeted by
  `PaintTarget` instead of a bool), the effect's blend, and its own eye /
  duplicate / remove. A press-and-drag on a row reorders the stack, one undo
  entry per reorder (`Drag::EffectRow`).
- Tests: `the_effects_list_is_the_stack_and_every_write_is_one_undo_step`,
  `an_effect_write_past_the_end_changes_nothing`, `only_a_shadow_carries_a_fill`,
  `pass_through_is_a_layer_mode_only`,
  `the_blend_lists_are_figmas_and_pass_through_is_layer_only`,
  `the_effect_kinds_are_figmas_five_with_their_own_fields`,
  `the_effects_section_lists_every_effect_with_figmas_controls`,
  `the_blend_menus_offer_figmas_modes_and_write_the_choice`,
  `dragging_an_effect_row_reorders_the_stack`,
  `an_effect_colour_never_lands_on_the_layer_fill`.
- Still open, and now listed as such: Figma's **Glass** and **Texture** types,
  and the per-type caps (*"up to eight drop shadows … one layer blur"*).

## [Unreleased] — 2026-09-19 (Component sets)

Figma's component set is not a fourth kind of node: it is a **frame that holds
nothing but components** (`360056440594`). This engine only had variant *names*
(`Set/Variant`), so "combine as variants" renamed masters wherever they lay and
the result was a set in name only — the tree showed loose frames, and nothing
stopped a rect from living among the variants.

- **The predicate.** `x_core::variant_set_members(frame)` answers the set a frame
  *is*: every child a `Component` named `Set/Variant`, all with one set prefix.
  `is_variant_set` is the same question with a bool answer, and it is what the
  "a set can contain only components" rule falls out of.
- **Combine builds the node.** `Editor::combine_as_variants` now creates the set
  frame around the selection (or reuses a frame that already holds nothing but the
  selection), moves the masters in with their positions made relative, renames them
  `{set}/{variant}` and rewrites every instance reference — **one undo entry** for
  the whole combine. `Editor::rename_component` keeps its behaviour and now shares
  the same `rename_master_in` / `rename_component_refs` helpers.
- **The tree.** A set reads as one row with the component-set glyph, its variants
  as the rows inside it, and each variant by its own value (`Primary`, not
  `Button/Primary`).
- **The canvas.** `paint_variant_chrome` draws Figma's default look for a set: a
  dashed violet stroke with no fill, the same stroke around each variant, and the
  set's name on a chip under its bottom-left corner. `C_SET` is the themed alias
  (the design system's accent *is* the violet), so no theme can leave it stale.
- Tests: `combining_two_masters_builds_a_set_frame_that_holds_them`,
  `a_frame_holding_only_the_selection_becomes_the_set`,
  `a_set_is_all_variants_and_nothing_else`,
  `a_component_set_reads_as_one_row_and_its_variants_by_value`,
  `a_component_set_paints_its_dashed_outline_and_name`.

## [Unreleased] — 2026-09-19 (Instances: select inside)

Figma lets you reach *into* an instance: *"you can change the properties of any
layer within an instance"* — the change is stored on the instance, the master and
every other instance keep their own value. An instance carries no children of its
own here (its subtree resolves from the master at render time), so "inside" had to
become a place the editor can be: a scope.

- **The scope.** `Editor::instance_scope: Option<(instance, layer)>`.
  `enter_instance(point, vars)` finds the instance under the cursor, swaps it for
  its resolved subtree (the same resolution the renderer uses) and answers the
  point again, so the layer selected is the master layer an override will name;
  `exit_instance()` puts the instance back under the cursor; `scoped_layer(vars)`
  returns that layer as the canvas paints it.
- **The write rule, in one place.** `scope_gate` sits in `set_fill`, `set_text`,
  `set_opacity` and `set_visible`: inside an instance the write becomes the
  instance's override in one undo step, and a property the override model has no
  shape for (a gradient, a variable reference) is refused rather than written into
  the master. Position and size are refused too — Figma's own list of what an
  instance does not let you override starts with position, constraints and text
  bounds — so `move_node`, `move_selection` and `resize` are inert inside a scope.
- **The gestures.** A double-click inside an instance enters it (the existing
  one-level drill-in is the fallback for everything else); while inside, a click
  moves the scope to the layer under the cursor and a click outside leaves it; Esc
  steps out to the instance. The status line names the path: `Inside Button - lbl
  (Esc to leave)`.
- **The panel.** `sel_info` reads the instance's resolved copy of the layer while
  the scope holds it, so the fields show the values the canvas is painting — and
  the writes they dispatch land back as overrides.
- **Known limit, now pinned.** `Node::overrides` holds *one* encoded value per
  layer (the `.x` string form), so a second property written on the same layer
  replaces the first: Figma keeps a text change and a fill change side by side.
  `a_second_write_on_the_same_layer_replaces_its_override` states it, the master
  list carries it as row 12.21 `PARTIAL`, and lifting it is a file-format change.
- Tests: `selecting_inside_an_instance_picks_the_layer_under_the_cursor`,
  `editing_inside_an_instance_stores_an_override`,
  `position_is_not_overridable_inside_an_instance`,
  `a_fill_that_cannot_be_an_override_inside_an_instance_is_refused`,
  `an_override_written_inside_an_instance_is_one_undo_step`,
  `a_second_write_on_the_same_layer_replaces_its_override`,
  `double_clicking_inside_an_instance_selects_the_layer_there`,
  `the_panel_shows_the_instance_copy_of_a_layer_inside_it`.

Still open on this item: component sets as a first-class node (12.19).

## [Unreleased] — 2026-09-19 (Instances: go to main, push changes, reset one change)

An instance's *More actions* menu in Figma is where its three master-level
operations live: **Go to main component**, **Push changes to main component**,
and a **Reset** flyout that — in Figma's own words — *"only lists properties
that have changes applied"*. The engine could already store overrides per
instance; nothing could name them, clear one, or send them back to the master.

- **The change list.** `x-core::instance_changes` reads an instance's overrides
  and answers with one entry per change — the layer it sits on and the property
  that changed (Fill, Text, Visible, Opacity, Swap, Width). Overrides live in a
  map, so the list imposes Figma's own order and sorts within a group: the same
  menu every render.
- **Reset one change.** `Editor::reset_one_override` clears a single layer's
  override (Figma's *"Reset > Reset [property]"*), and `reset_layer_overrides`
  clears one layer *and its subtree* for the layer-selected case. Both are one
  command-log step, so ⌘Z takes them back.
- **Push changes to main component.** `x-core::push_overrides_to_master` writes
  the instance's *appearance* overrides into its master, which is what makes
  every other instance of that component follow. A swap override is not pushed
  (it names another component), matching Figma, which only allows pushes for
  components in the same file.
- **The canvas menu.** A selection that is an instance now carries Figma's three
  rows: *Go to main component* (selects the master and brings it into view),
  *Push changes to main component* (inert until something has changed), and a
  *Reset* submenu listing the changes plus *Reset all changes*. The rows are
  built by `context_menu.rs` from data, and the painter learned one thing: a row
  label can be data (`ContextAction::dynamic_label`).
- Tests: `the_canvas_menu_carries_figmas_instance_actions`,
  `go_to_main_selects_the_master_and_pushing_reaches_every_instance`,
  `resetting_one_change_leaves_the_others_alone`,
  `pushing_changes_to_main_and_resetting_one_change_are_undoable`,
  `the_change_list_names_every_override_and_reset_clears_one`,
  `resetting_a_layer_clears_its_subtree_and_nothing_else`,
  `pushing_overrides_writes_the_master_for_every_instance`,
  `pushing_from_an_instance_whose_master_is_gone_changes_nothing`.

Still open on this row: selecting *inside* an instance (12.11) and component
sets as a first-class node (12.19).

## [Unreleased] — 2026-09-19 (Auto layout: min/max dimensions and canvas stacking)

Two rows of Figma's auto-layout block were carried by the model but reachable
from nothing — min/max dimensions and canvas stacking. Both are now in the
panel, in Figma's words, with the engine rule behind each one named in one
place.

- **The Width/Height dropdown.** Figma's sizing control is a dropdown, not a
  toggle: *"Open the Width dropdown to find Add min width and Add max width."*
  The panel's Hug/Fixed chip now opens that menu, with the two sizing rows
  ("Fixed width" / "Hug contents", and the height's own words) and the min/max
  rows beneath them, ticking the ones in force.
- **Min/max dimensions.** *"Minimum and maximum dimensions is an additional
  setting that can be used at the same time as other resizing properties"* — an
  Add row writes the frame's current size as the limit and opens the field that
  edits it (*"From the new field that appears, enter a value"*), the axis icon
  gains *"two lines, one on each side"*, **Remove min and max** clears the pair,
  and an empty field drops its own limit. `apply_auto_layout` now clamps
  min/max for every sizing rather than only for Hug — a Fixed frame is bounded
  the same way — while the padding floor still wins over a maximum that is
  smaller than the padding.
- **Canvas stacking.** *"When multiple layers have negative spacing creating a
  stack, the last object … will be on top by default"*, and the auto-layout
  settings offer **First on top** / **Last on top** instead. The rule lives in
  `x_core::auto_layout::paint_order` — the ONE owner of child paint order —
  which the Vello scene, the render IR and `hit_test` all walk, so the layer
  you see on top is the layer you click. It is a canvas-only setting: "the
  order of layers in the layers panel stays the same."
- **Tests.** `min_and_max_dimensions_clamp_either_sizing`,
  `canvas_stacking_reverses_the_paint_order_and_never_the_layer_list`,
  `canvas_stacking_decides_which_layer_paints_on_top` (pixels, through the
  tiny-skia sink), `the_hit_test_follows_canvas_stacking`,
  `the_width_menu_carries_figmas_sizing_and_min_max_rows`,
  `a_min_and_max_width_are_added_from_the_menu_and_clamp_the_frame`,
  `the_canvas_stacking_menu_writes_figmas_two_orders`.

## [Unreleased] — 2026-09-19 (Sections)

A Section is Figma's labelled container for a region of the canvas — "a great
way to organize and label areas of your canvas, making it easier to navigate
and present your work". The model, the renderer and the hit test already knew
the kind; what was missing was any way to make one, and the rules that make a
section a section rather than a frame.

- **The tool.** `Tool::Section`, Figma's `⇧S`: *"Click Section in the toolbar or
  use the keyboard shortcut ⇧ Shift S. Click and drag the location of the canvas
  where you'd like the section to go."* It draws on the canvas whatever
  container is under the drag — a section is a top-level element, so the draw
  cannot land it inside a frame.
- **One key, two tools, one memory.** Figma keeps Section in the same toolbar
  slot as Frame; press `F` after `⇧S` and you get the Frame back, press `⇧S`
  again and you get the Section. `App::frame_slot` is that memory and
  `App::select_tool` is the one door every tool choice goes through (the
  toolbar, the palette rows, the keyboard, `Action::Tool`); the palette carries
  `Section tool` beside `Frame tool`.
- **Cannot be nested.** *"Sections in Figma Design are a top-level element on
  the canvas by default. Sections can contain all layer types, including other
  sections, but cannot be contained within frames or groups."* `Editor::insert_nodes`
  refuses a Section into a Frame or a Group, and the reorder command refuses to
  move one there, so no path in the app can build the forbidden tree — the page
  is itself a frame in this model, so the canvas is exempt by identity, not by
  kind, and a drawn section reaches it.
- **Wrap in new section.** The canvas's right-click menu carries Figma's own
  row. A selection already on the canvas — or inside another section — is
  wrapped where it stands; one inside a frame or a group is **lifted** to the
  canvas with its place kept: the members' page positions are computed first,
  the section is drawn around them, and each member is moved by the difference,
  as one undo step. A rotated or scaled ancestor stops the lift and changes
  nothing, because that subtree's page position is a matrix rather than a point.
- **A section takes in what it covers.** *"You can also click and drag a section
  over the objects you want to add to it."* The drag that drew the section did
  exactly that: `Editor::section_absorb` moves every unlocked sibling the section
  fully covers into it, keeping its place, merged with the draw into one undo.
  The same take-in runs when a move gesture ends — a single section dragged on
  top of a layer absorbs it, and the drag plus the take-in are one undo step.
- **Two deletes.** `Delete` takes the section and its contents; `Ctrl+Backspace`
  (`⌘⌫` on a Mac) takes the container and keeps its contents, promoted to the
  canvas with their place on it. Plain layers answer the ordinary delete either
  way. The status line reports how many layers were kept.
- **Tests.** `the_section_tool_is_shift_s_and_shares_the_frame_slot`,
  `the_section_tool_draws_on_the_canvas_and_takes_what_it_covers`,
  `the_canvas_menu_wraps_a_selection_in_a_section`,
  `a_section_lifts_layers_out_of_a_frame_and_keeps_their_place`,
  `a_section_never_lands_inside_a_frame_or_a_group`,
  `a_section_takes_in_the_layers_it_covers`,
  `deleting_a_section_can_keep_its_layers`.

## [Unreleased] — 2026-09-19 (Prototype: Animate matching layers)

Figma's Prototype tab has a tick in the interaction's animation section and one
sentence of behaviour behind it. The tick is now ours, the sentence is the
engine's, and the preview runs the part of it a single-screen viewer can show
honestly.

- **The rule, in one place.** `x_core::prototype::matching_layers` decides each
  destination layer by Figma's own test — **name** *and* **hierarchy** (the
  chain of ancestor names), never by id: a match smart-animates its differences
  (`LayerTransition::SmartAnimate { from }`), a layer that matched nothing
  dissolves in (`Dissolve`), and a matched **fixed or sticky** layer gets no
  transition at all (`Hold`) — all four cases of help 360039818874, including
  the one that reads backwards at first: a *fixed* layer with nothing to match
  dissolves rather than holding, because it has no position to hold.
- **The transition itself.** `x_core::smart_animate::interpolate_matching_layers`
  is the in-between state at any progress: matched pairs morph (position, size,
  opacity, rotation, corner radius, fill) through the existing SmartAnimate
  interpolators, arriving layers fade from transparent in their own place, and
  a held layer is simply absent from the map. The module's old `interpolate_frames`
  matched by id, which two different screens never share; this is the matching
  Figma documents, and the id-matched engine is left untouched for the callers
  that key on identity.
- **The tick is part of the interaction.** `Interaction::animate_matching_layers`
  is off by default, panel-writable, undoable, and on the file as
  `"smartmatch":true` — written only when it is on, so files that predate the
  tick keep meaning what they meant and load as off rather than as an error.
- **The clock.** `x_native::editor::arm_smart_tick` freezes the plan at the
  navigation (overlays excepted: Figma gives them no smart animate) and
  `SmartTick` runs it for the interaction's own `transition_ms`. The app
  advances one 16 ms frame at a time in the idle loop and repaints while it
  runs; a navigation that does not ask for a tick clears whatever was running.
- **What the viewer paints.** `editor_ui::paint_tick_tree` multiplies the
  arriving layers' alpha into a *clone* of the page — the tick is preview state
  and never touches the file — so new layers dissolve in over the interaction's
  own duration. The morph of a matched pair is computed but not painted yet:
  the viewer shows one screen at a time, so there is no outgoing screen to
  animate against. That single delta is what keeps row 14.12 at `PARTIAL`.
- **Panel.** A full-width checkbox row — `Animate matching layers`, Figma's
  words — under the URL field, so it never crowds the pill, the four direction
  arrows and the duration on the motion row; the status line reports the new
  state (`Animate matching layers: on`).
- **Tests.** `matching_layers_follows_names_hierarchy_and_fixed`,
  `matching_layers_interpolate_by_name_not_id`,
  `the_matching_layers_tick_survives_the_round_trip_and_stays_off_when_absent`,
  `the_interaction_row_carries_figmas_matching_layers_tick`,
  `the_matching_layers_tick_arms_on_a_navigation_and_dissolves_new_layers`.

## [Unreleased] — 2026-09-19 (Prototype: the trigger control, in Figma's words)

The panel's first control was a cycle through six triggers whose words lived in
two places. It is Figma's dropdown now, in Figma's words — and the trigger the
engine was missing (Mouse down) and the kinds the panel could not reach (delay,
key, video, drag) came with it.

- **One owner for the trigger's name.** `Trigger::label` (x-core) is the table;
  the panel's duplicate `proto_trigger_label` is deleted. The words are Figma's
  own list (help 360040315773), and three of ours were wrong: "Key pressed" →
  **Key/Gamepad**, "Video hits" → **When video hits**, "Video ends" → **When
  video ends**.
- **The bug behind them.** `Trigger::label` returned an *empty string* for any
  delay with a non-zero `ms` ("handled specially with ms"), and `label_with`
  spelled "Key down" — a second name for a trigger whose row said "Key pressed".
  The short form never carries the parameter now, and the one-line spelling is
  built from the same words.
- **A menu, not a cycle.** Figma's trigger control is a dropdown; ours cycled
  On click → While hovering → Mouse enter → Mouse leave → While pressing →
  Mouse up and back, so a design could not be given an *On drag*, a delay, a
  key/gamepad or a video trigger at all. `Trigger::all` is the twelve-entry list
  the menu paints; a press writes that trigger *kind and the value its row
  starts from* (800 ms, a blank key, 0.0 s), and the parameter field beside the
  pill edits it from there. The menu flips above the pill when the window has no
  room below it.
- **Mouse down exists now.** Figma splits the press in two: *While pressing* is
  temporary — releasing reverts it, which is our `press_span` — while *Mouse
  down / Touch press* is permanent and one-way (help 360040315773 lists it;
  the plugin API says "MOUSE_UP and MOUSE_DOWN are permanent, one-way
  navigation"). The engine gains the variant, the player fires it on the press
  between While pressing and On click, and it never arms the auto-reverse that
  the press's end unwinds.
- **The wire keeps all twelve.** The serializer wrote "video-hit"/"video-end"
  but the reader knew nine words, so both video triggers came back as On click,
  and a video hit's time was never written at all. Kind and parameter now round
  trip, pinned by a test that walks the whole list.
- **The pill fits its words.** It was a fixed 70 px box painted with whatever
  the label said — "When video hits" is wider than that and ran into the field
  beside it. It is measured now, clamped so the parameter keeps its room and
  truncated rather than overdrawing: the "no design issue" half of the owner's
  directive.

**Tests:** `the_trigger_words_are_figmas_and_the_menu_lists_every_one`,
`every_trigger_word_and_its_parameter_survive_the_round_trip`,
`the_trigger_menu_offers_figmas_list_and_the_pill_fits_its_words`,
`player_mouse_down_navigates_on_press_and_release_keeps_it`. Master list rows
14.4 (trigger list, now twelve kinds and reachable) and 14.5 (trigger row
wording, one owner) close: 223 MATCH · 54 PARTIAL.

## [Unreleased] — 2026-09-19 (Prototype: the per-frame scroll behavior)

The last functional gap in the prototyping chapter of the course, and delta 3 of the
owner's prototype comparison: Figma's **Scroll behavior** block.

- **The frame's Overflow menu is real.** A selected frame's Prototype tab gets the
  block Figma shows — `SCROLL BEHAVIOR` with an **Overflow** field — and the menu is
  Figma's own list: *No scrolling / Horizontal / Vertical / Both directions*
  (help 360039818734). The field writes the frame's `Overflow`, which the renderer
  already honoured, so this connects the setting that existed to the UI that never
  did it.
- **"No scrolling" is the clip state, not `Visible`.** Figma keeps clipping and
  scrolling in two places; our `Overflow` enum carries both, so the translation is
  explicit in one function (`proto_overflow_for_row`) and a frame that was scrolling
  returns to *clipping*, not to a frame with content spilling out of it.
- **The Position menu, only where Figma shows it.** *Scroll with parent / Fixed /
  Sticky* — "You can only apply one scroll position to each layer", and only for "an
  object … on a frame that has scroll overflow applied". `scrollable_ancestor` owns
  that rule: no scrolling frame above the layer, no Position row. The flags it writes
  are the `fixed`/`sticky` pair the renderer has honoured all along, and
  `ScrollPosition::of/apply` is the one view of the two, so the menu and the field
  cannot disagree.
- **The preview really scrolls.** In the flow viewer the wheel now moves the frame's
  content — the deepest scrolling frame under the pointer, clamped to the range the
  content sticks out past the frame's box (`x_core::scroll_extent`, which excludes
  fixed and sticky children because they do not scroll). A Vertical frame ignores the
  horizontal delta and the other way round; a "No scrolling" frame falls through.
- **Scroll offsets belong to the preview, not the document.** `Editor::set_scroll_preview`
  writes them in place — no command, no undo entry — and every offset is handed back
  when the preview opens or closes (the chip, `Q`, `Esc` past the first screen).
  `Editor::set_scroll_position` is the document edit and is one undo step, like every
  other layer property.
- **"Reset scroll position" now does something.** The interaction's own switch (the
  panel's `Reset: On`) clears the preview's offsets when it navigates: Figma — "Without
  Preserve scroll position checked, Frame 2 will load from the top of the frame".
  Our default stays *preserve* ("Reset: Off"), which is a documented divergence from
  Figma's default; the switch itself is now honoured either way.
- **`ScrollTo` inside a scrolling frame scrolls the frame** to bring its destination to
  the top of the box, camera untouched, instead of panning the viewer — "you can select
  direct children of scrollable frames" (forum, 2024). Outside a scrolling frame it
  still pans, as before.

**Tests:** `the_scroll_behaviour_rows_write_the_frames_overflow_and_a_layers_position`
(panel rows, both menus, the writes, the preview's wheel and its clamp, the reset
switch), `scroll_position_is_a_document_edit_and_the_preview_offset_is_not` (the undo
split), `content_past_the_frame_decides_the_range`,
`the_position_menu_reads_and_writes_the_two_flags`, and the master list's row 14.13 is
closed.

## [Unreleased] — 2026-09-19 (The master list: everything, matched to Figma)

The owner asked for one list: *"every tool, every feature, even drag too, function
etc, and match them to Figma … to 100% match … and match our design to Figma's
design as well … use Figma-type exact icons."*

- **`docs/FIGMA_PARITY_MASTER_LIST.md`** is that list — **334 rows** across 20
  surfaces (tools, canvas gestures/drag, keyboard, menus, layers/pages/sections,
  frame properties, auto layout, fill/stroke/effects/colour, images, text, vector
  editing, components/instances/styles, variables, prototype, inspect/codegen,
  export/import, view & navigation, the app's own design language, comments, and
  what we have beyond Figma). Each row names Figma's behaviour with a source, where
  ours lives, and one status: **MATCH 221 · PARTIAL 55 · MISSING 39 · EXTRA 16 ·
  OUT 3**. `MATCH` is claimed only where a test pins it; every divergence inside
  `PARTIAL` and every `MISSING` row is spelled out.
- **The list corrects three of our own assumptions while writing it.** The effects
  section is a header and a `+` that adds one drop shadow — `LayerBlur`,
  `BackgroundBlur` and `Noise` are in the model and unreachable from the UI; masks
  are honoured by the renderer and pinned by `mask_semantics.rs` but nothing sets
  `is_mask`; and `corner_radii`, `corner_smoothing` and `TextList` are model-only.
  Those, plus the blend-mode picker, are now Wave 1b of the queue.
- **`docs/FIGMA_PARITY.md`** points at the list and keeps its own §2 rows as the
  subset strong enough to name an owner and a test, so the two can never drift into
  two different pictures of the same product.

## [Unreleased] — 2026-09-19 (Prototype panel: the row's words, the direction arrows)

The owner's reference screenshots of Figma's prototype editor name every field —
**Trigger: On drag**, **Action: Navigate to**, **Destination: footer_section**,
**Animation: Move In**, **Direction: ← → ↓ ↑**, **Easing: Ease out**,
**Duration: 300ms** — and two of those were not the words on our panel.

- **The interaction row reads Figma's way.** The second pill used to repeat the
  destination; it now names the *action* — "Navigate to", "Scroll to", "Open
  overlay", "Swap overlay", "Close overlay", "Open link", "Go back", "Set
  variable", "Set mode", "Conditional" — and an arrow introduces the thing it
  acts on. An action with nothing to point at (Go back, Close overlay, Conditional)
  has no destination control at all, where a "Choose destination" placeholder used
  to sit. `proto_action_label`, the old second source of truth for those strings,
  is gone with it.
- **Figma's four direction arrows.** The animation row shows the animation's own
  name ("Move in") and, beside it, ← → ↓ ↑. Only a Move in / Move out has a side,
  so only then do the arrows light up and take a press; the lit one is the side in
  force, and a press sets it (`Action::ProtoDirection` → `Host::proto_direction_set`).
  The pill still cycles animation and direction together for the fast path.
- **"Flow starting point".** The start-point row in the panel says Figma's phrase
  instead of "Start flow here".

## [Unreleased] — 2026-09-19 (Polygon and Star)

Figma's shape menu carries two shapes that count their own geometry, and both were
missing here: the **Polygon** ("an enclosed shape that is made up of any number of
straight lines", "the default shape for the polygon tool is a triangle") and the
**Star** ("polygons that are arranged in a star shape … the default will be a five
pointed star with ten sides"). There was no `NodeKind` for either, so nothing could
draw, hit-test, export or round-trip one.

- **Two tools in the shape menu.** Polygon and Star sit on the toolbar beside the
  shapes and in the command palette ("Polygon tool", "Star tool"); a drag draws one —
  three sides, or five points with the inner ones at Figma's default ratio. ⇧ keeps
  the box square and ⌥ draws from the centre, the shared shape-tool rule.
- **Count and Ratio in the Appearance section.** A polygon shows Count; a star shows
  Count and Ratio — "How many points there are to the star. The minimum is three and
  the maximum is 60" and "The distance of the inner points of the star from the
  center. This is represented as percentage of the star's diameter". Typing 200
  clamps to 60, typing 1 clamps to 3.
- **The canvas handles.** The Count handle rides the shape's rightmost vertex and the
  star's Ratio handle its rightmost inner vertex. Dragging the Count inwards removes
  points and out past the rim adds them (the number reads out in a chip while you
  drag); the Ratio handle sets the inner fraction. Both are appearance only: "the blue
  bounding box around the shape is below the bottom of the shape … to remain a
  consistent shape or size, when additional points are added" — the box never moves,
  Flatten is still what makes it hug (the arc's own rule).
- **Everything downstream knows them.** The renderer and mask path, the hit test
  (the shape's own ink answers, not its box), SVG / Figma / Sketch export, codegen
  (`clipPath: 'polygon(…)'`), the `.x` format (`{"t":"poly","sides":n}` and
  `{"t":"star","points":n,"ratio":r}`) and the MCP kind labels.

**Divergences:** Figma's star also has a **Radius** handle ("allows you to round the
points of the star") and double-click **Edit object** point editing; this build has
neither, so a star's points stay sharp and the vertices are not editable one by one.
A `.fig` binary still drops `STAR`/`REGULAR_POLYGON` on import (it did before this
change), and JSON import flattens both to a Vector — Polygon and Star are exported,
and round-trip through our own format.

## [Unreleased] — 2026-09-18 (Prototype connections on the canvas)

Figma's connections are drawn ON the canvas — the course's chapter "Add prototype
connections" walks through the whole gesture — and until now ours could only be
built from the sidebar's plus button. This is the gesture, the flow label and the
deletion, i.e. the parts of the chapter that are canvas behaviour.

- **The plus on the layer's edge.** On the Prototype tab a blue circle sits on the
  selected layer's right edge; with the pointer on it, it becomes the plus you
  drag. "Hover over the blue circle on the button layer's edge until a blue plus
  icon appears" — and this build's plus is the first step of the drag itself.
- **Drag it to another frame.** The noodle follows the pointer, and it SNAPS to
  the top-level frame under it; the frame is outlined while it is the candidate.
  Release writes `On click → <frame>` (smart animate, 350ms), the same interaction
  the sidebar's "+ Add" writes. A drop on empty canvas writes nothing.
- **The flow label.** "Figma also added a small blue label to our home page frame
  and named it Flow 1" — the label rides the first frame a flow starts from, and
  is numbered in page order, so it appears with the flow's first connection.
- **Select it and press Delete.** A press on a noodle selects that connection
  (drawn bold) and Delete removes it — not the layer under it — in one undo step.

## [Unreleased] — 2026-09-18 (The arc properties on an ellipse)

The engine has carried `NodeKind::Arc` — the geometry the renderer, the hit
test, SVG/Figma/Sketch export and flatten all read — since the vector pass,
with no way to make one. Figma's route is on the ellipse itself: the course's
chapter 26, "Turn an ellipse into an arc".

- **The Sweep handle, on hover.** Figma: "When you hover over the circle, a
  single handle will appear on the right-hand side" — and dragging it up or
  down changes the sweep, "a positive percentage" one way and a negative one
  the other. Ours is drawn, hit-tested and dragged through the layer's world
  transform, so a nested or rotated ellipse's handle sits on its arc.
- **Start and Ratio**, once the sweep is broken: the Start handle "has a dot
  inside it", and the Ratio handle starts "at the center of the circle" and
  turns it into a ring.
- **The three fields** in the right sidebar's Appearance section — Figma's own
  Start / Sweep / Ratio, in degrees (a `%` on the sweep is a share of the
  circle) and as a percentage for the ratio. Both halves write the same
  properties, and one gesture is one undo step.
- **The box never moves.** Figma: "Changing the ellipse's arc properties only
  altered its appearance on the canvas, not the shape's actual dimensions …
  the shape's bounding box stayed the same size to preserve space in case we
  wanted to change the arc again." A solid ellipse becomes an arc on the first
  drag, and its 100x100 box is still 100x100 afterwards; Flatten (⇧⌘E's
  command, ⌘E) is what makes the box hug the geometry.
- `x_core::booleans::arc_path_cmds(w, h, start, end, ratio)` is now the whole
  shape: the outer arc, the seam to the inner edge and the inner arc back, the
  other way round so NonZero winding leaves the ring's hole. A wedge closes
  through the centre; equal angles are still the full circle, and the sweep is
  SIGNED rather than folded with `rem_euclid`, which is what makes a handle
  dragged the other way round read negative.
- `arc_point` is the one place the geometry and the handles agree, and the arc
  answers clicks as the filled region it is: the gap passes through to whatever
  is under it, and a ring's hole does too.

## [Unreleased] — 2026-09-18 (The Scale panel, and the body drag)

Figma's Scale tool is a panel as much as a gesture: while **K** is the active tool the
right sidebar shows the **Scale** section — a width and a height field, a scale
multiplier, and a nine-point anchor box — and the object's own bounding box answers a
drag. Ours had the four corner handles and nothing else.

- **The panel** — `FieldId::ScaleFactor` / `ScaleW` / `ScaleH`, painted by
  `editor_ui::paint_scale_block` and shown only while the Scale tool is active, like
  Figma's own. The multiplier takes a percentage ("150%", or a bare "150") or an
  explicit factor ("1.5x"); the W and H fields take a dimension and the OTHER field
  follows, because a scale is proportional — both commit through the same
  `Editor::scale_nodes_about` the drag uses, so panel and canvas cannot disagree.
- **The anchor box** — `state::scale_cell_anchor`, nine cells, centre by default — is the
  fixed point of every panel scale: the panel paints the nine points, `Action::ScaleCell`
  moves it, and the multiplier and the dimension fields both read it.
- **The body drag** — `Drag::ScaleBody`: with K, a press INSIDE the box scales it instead
  of moving it. The anchor is the corner opposite the nearest one to the press and the
  press point itself rides the pointer; `state::scale_grab_factor` is the ONE projection
  rule, with the handle grab expressed as its special case (`state::corner_point`), so the
  two gestures cannot drift apart. One gesture is still one undo entry.
- `run.rs::selection_box` is the one place the selection's box is measured — for the
  handles, the body drag and the panel — and `state::nearest_corner` is the small table
  that decides which corner a body press scales about.

## [Unreleased] — 2026-09-18 (Line and Arrow)

Figma's shape menu keeps the **Line** and the **Arrow** on one key — L draws the line, ⇧L
the arrow — and both are now on the canvas: the segment IS the geometry, so a horizontal
line is a layer 0 units high rather than a box, and the arrow closes that same spine with
a solid head.

- `x_core::line_path(a, b)` is the two endpoints; `x_core::arrow_path(a, b, weight)` closes
  the shaft with a filled triangular head — `4 × weight` long, never under 12 units, never
  longer than the segment itself, so a short drag stays an arrow and a degenerate one is a
  plain line.
- `Tool::Line` / `Tool::Arrow` (L / ⇧L, design-only like the Scale, Slice, Pencil and Brush
  tools) are the dock's fifteenth and sixteenth tools, two palette rows, and Esc leaves them.
- One drag = one `NodeKind::Vector` named "Line n" / "Arrow n", in the tool's 1px ink (the
  arrow's fill is that ink, a line's fill is transparent), re-origined onto
  `x_core::path_bounds` so the layer's box wraps the ink, drawn inside the frame it was
  drawn in (Space opts out), and one insert = one undo step.
- ⌥ draws from the centre like the shape tools; ⇧ snaps the drag's DIRECTION to 45° steps
  and keeps the pointer's length — a line's proportion is an angle, not a square.
- `x_editor::hit_test` answers a stroke-only path (a line's box has no height to click) by
  the distance to the path's ink, and keeps the box test for filled paths, so the pencil's
  and brush's marks still click anywhere inside their box.
- The live preview builds the same `PathCmd`s the commit does, one transform apart, so the
  arrow on screen while dragging is the arrow that lands. The icon set gains the `line`
  glyph (the arrow reuses `arrow-up-right`), and its census moves to 75.

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
