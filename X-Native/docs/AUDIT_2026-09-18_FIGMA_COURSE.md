# What Figma's beginner course says the interface does — and where this build stands

Two sources were read end to end, on the owner's request:

* **Figma Design for beginners** — <https://help.figma.com/hc/en-us/sections/30880632542743>
  (published May 2025; 33 chapters / 180 minutes). The chapter videos themselves are
  behind a Figma sign-in, so what is taken from this source is the **course map**: the
  ten parts and their chapters are Figma's own list of what the interface does —
  layers and frames, frame presets and constraints, auto layout and components,
  vector editing, instances, prototyping — plus the two free articles linked from it
  (the tour of the file browser, and the first design file).
* **Firmbee, "Figma interface – basic information"** —
  <https://firmbee.com/figma-interface-basic-information-figma-for-beginners-2> — the
  free write-up of the same interface, element by element: the file browser, the file
  interface, the layers panel, the properties panel. This is the source that states
  behaviours in words, so most rows below quote it.

Every "in this tree" cell was checked in the source at the line named, not assumed from
a screenshot. "not reproduced" means the source claims something the code does the other
way, or does not do at all.

## 0. How the tools behave on the canvas

The question behind the file-interface table below is not *which buttons exist* but
*what a tool does when you use it on the canvas*. That is what this table answers, and
every "in this tree" cell is the source that implements it.

| tool (Figma) | what it does on Figma's canvas | in this tree |
| --- | --- | --- |
| **Move / select** (V) | click selects the top-level object, drag moves it, shift-click adds, marquee on empty canvas, double-click or ⏎ descends one level, ⌘-click deep-selects | `Tool::Select`; `x-editor::hit_test` + `hit_test_rect`; `drill_into`; parity rows 1–7 |
| **Scale** (K) | resize WITHOUT distortion — "Any blurs or strokes will scale as well", text sizes follow the box, a locked layer is refused, and the box grows from the corner you are not holding | `Tool::Scale` + `state::scale_drag_factor` / `scaled_box` + `Editor::scale_nodes_about` (w/h, child offsets, strokes and dashes, radii, text size/leading, effect distances, auto-layout padding/gap) |
| **Frame** (F) | click on empty canvas = a top-level frame (100×100, then the last size used); **click INSIDE a frame = a nested frame there**; drag = custom size; ⌥⌘G frames the selection | `Tool::Frame`; nesting now by *where you draw* (`container_under`); ⌥⌘G now frames the selection |
| **Slice** (S) | a region whose only job is to be exported — "even if it's not organized into a single group"; with Contents Only off, anything overlapping it is exported | `Tool::Slice` draws one; the editor marks it dashed and names it, and `prepare_export` exports the flattened content inside its bounds (one slice per export) |
| **Rectangle** (R) / **Ellipse** (O) | drag creates; ⇧ square/circle; ⌥ from the centre; the size is shown while dragging; **drawn over a frame it joins that frame**; space while dragging prevents nesting | `Tool::Rect` / `Tool::Ellipse`; all four rules now, via `state::create_rect` + `container_under` + `space_pan` |
| **Line** (L) / **Arrow** (⇧L) | drag in any direction; stroke settings in the right panel | `Tool::Pen` + line nodes; no arrow caps yet |
| **Pen** (P) | click to place points, drag for curves, click the first point to close, Esc leaves it open; draws INSIDE a frame | `Tool::Pen` (click = anchor, drag = handle, close on the anchor); nests by the same rule now |
| **Pencil** (⇧P) | freehand: click and drag to sketch, smoothed as you go, with "a round 3px stroke weight"; the tool STAYS active until another tool or Esc | `Tool::Pencil` samples the pointer, `x_core::freehand_path` fits the samples into editable curves, and one stroke is one undo step |
| **Pencil / Brush** | freehand drawing, and the strokes can be smoothed into a vector network | not built (listed below) |
| **Text** (T) | drag makes a fixed-size text box, click makes one that grows with the text; double-click a text layer to edit in place | `Tool::Text` (drag = box, click = auto width); in-place editing with caret, selection and wrapping |
| **Hand** (H) / space | pan; space held anywhere gives the hand cursor | `Tool::Hand`, `space_pan`, `Drag::Pan` |
| **Comment** (C) | drop a pin, thread replies | `Tool::Comment` + pages' comment pins |
| **Zoom** | ⌘/Ctrl + wheel, ⌘0 / ⌘1 / ⌘2, or the zoom menu | wheel zoom at the pointer, `Action::ZoomMenu` (in / out / 100% / selection / fit) |
| **Nudge** | arrow keys move 1px, ⇧ 10px | arrow-key nudge with ⇧ big-nudge |

Five rows changed since this table was written (see §4): a new layer joins the
container you draw it in, the shape tools' modifiers (⇧ constrain, ⌥ from the centre,
live size readout), the two tools that were engine-only — the Scale tool (K) and Frame
selection (⌥⌘G), which now have a tool, a palette entry and a shortcut — the Slice tool
(S), which had a node kind and an export path but no way to draw one, and the Pencil
(⇧P), whose freehand fit had been sitting in the engine under a "(pencil tool)" note.

## 1. The file interface, element by element

| what the source says | in this tree | verdict |
| --- | --- | --- |
| **Canvas** — "the main area … the space where you will work" | `state.rs::view_canvas`, `editor_regions` (the canvas is the region between the two docks and above the status band) | have |
| **Toolbar file name / users / share** | file tabs with a renameable name (`paint_title`), single-user app: no presence, no share dialog | have, by design |
| **Present** — "allows you to preview the file and interact with the created prototypes" | the ▶ in the panel header was a shortcut to the Prototype *tab*; it now **presents** (`Action::FlowEnter`, tooltip "Present") | **fixed this pass** |
| **Zoom / view options** | `Action::ZoomMenu` — in / out / 100% / selection / fit | have |
| **Move and scale tools** | `Tool::Select` is the move/select tool; there is **no scale tool** | gap |
| **Frame and slice tools** | `Tool::Frame`; there is **no slice tool** | gap |
| **Shape tools + place image** | `Tool::Rect`, `Tool::Ellipse`, image import (`Action::ImportFile`) | have |
| **Pen and pencil tools** | `Tool::Pen` (+ vector edit mode, boolean ops); there is **no pencil (freehand) tool** | gap |
| **Text tool** | `Tool::Text` | have |
| **Hand tool**, **Comment tool** | `Tool::Hand`, `Tool::Comment` (+ comment pins per page) | have |
| **Layers panel: every object is a layer, with a type icon** | `state.rs::kind_icon` (the v45 mapping), rows built from the document in `editor_ui.rs::paint_left` | have |
| **Renaming a layer by double-clicking it in the panel** | `Action::LayerRename` + `FieldId::LayerName`; pinned by `double_click_on_a_layer_name_renames_it` | have |
| **New objects are placed in the parent frame or group** | `run.rs::finish_create`: with exactly one container (frame / group / section) selected, the new node lands inside it in its local space | have, partly — Figma also drops a shape into the frame **under the pointer** when nothing is selected; ours stays on the page root (recorded below) |
| **Collapse and expand a frame's or group's layers** | `Action::TreeToggle`, chevron on every row with children | have |
| **Hover padlock locks, eye hides; locked and hidden layers are marked with an icon** | row toggles `Action::TreeLock` / `Action::TreeVisible`, painted on hover and kept while the state is on; `x-editor::hit_test` skips a locked node (a hidden node and its subtree are not hit at all) | have — **pinned this pass** |
| **Assets tab** — components searchable in the file and its libraries | `NavTab::Assets`, the LIBRARY band | have |
| **Pages: unlimited per file, each with its own canvas backdrop** | the pages list in the sidebar; parity rows 18–22 pin add / switch / rename / delete / windowing | have |
| **Constraints** — "Constraints define how any object will behave if its containing Frame is resized"; the Design tab shows two dropdowns, "the first dropdown … tells Figma how to manage the object's horizontal position, while the second dropdown … sets its vertical position" | `state.rs::CONSTRAINT_H` / `CONSTRAINT_V` + the panel's CONSTRAINTS block write `Node::pin`; `x_editor::pin_deltas` is the one solver behind both the inspector's W/H fields (`apply_constraints`) and the frame's corner drag (`pin_commands`), each in one undo step | **fixed this pass** |
| **The layers panel width can be dragged** | `editor_ui.rs::paint_resizers` + `Drag::LeftPanel` / `LeftRight` clamps in `editor_regions` | have (not pinned) |
| **Properties panel with three tabs: Design, Prototype, Inspect** | `state.rs::RightTab` = Design / Prototype / Inspect / UX (the UX tab is ours) | have |
| **Inspect shows how to put an object in code: CSS, Android, iOS** | `state.rs::inspect_code` — CSS, Swift (iOS), Compose (Android), XML, Tailwind; platform pills + "Copy code" | have |

## 2. The file browser

| what the source says | in this tree | verdict |
| --- | --- | --- |
| **Navigation bar**: user name, search, notifications, account menu | dashboard top bar: user cell, search field, notifications panel with an unread badge, account/app menu | have |
| **Sidebar**: Recents, Drafts (+ Deleted), Community, Teams | `DashView` = Home / Recents / Starred / Trash. There is no Community or Teams: this build has no sharing backend, and inventing a feed would be a fake control | partial, by design |
| **Files: grid or list, filter, sort, new design file** | `DashLayout` (Grid / List), `DashSort` (Edited / Name / Starred first), search filter, `Action::NewFile` | have |

## 3. Prototyping (the course's part 9)

| what the source says | in this tree | verdict |
| --- | --- | --- |
| **Add prototype connections** between frames | `Action::ProtoAdd`, `proto_targets` (top-level frames + explicit flow starting points, across pages), `x-core` `Interaction::click(destination)` | have |
| **Page scrolling behaviour and animations** | `x-core/prototype.rs` actions include `ScrollTo`; transitions carry `transition_ms` with `ProtoSpeed` / `ProtoEasing` per interaction | have |
| **Present and interact with the prototype** | the flow viewer: chrome-less canvas, hit targets live, chip with Back / Exit (Q), Esc steps back; overlays render relocated over the current screen with the preview's own variables | have |

## 4. What this pass changed

* **A new layer joins the container you draw it in.** The rule was "the shape lands
  inside the selected container, else on the page", so drawing a rect on top of a
  frame put it beside the frame (and Figma builds the frame you are working on).
  `run.rs::container_under` now answers from the canvas instead: the deepest
  **visible, unlocked** frame or section under the point the drag started from — a
  nested frame beats its parent, a group or an instance never captures, and paint
  order settles overlaps, exactly like a click. Holding **space** while dragging is
  Figma's own "prevent nesting" modifier, so the escape hatch is the documented one
  rather than a new binding. The selected-container path stays as the fallback, which
  is what keeps a group and an auto-layout frame behaving as before.
* **The shape tools' modifiers are Figma's, and the preview proves it.** ⇧ was already
  constraining the drag to a square/circle; **⌥ now draws from the centre**, and one
  function (`state::create_rect`) builds the rect for both the live preview and the
  node that lands — so ⌥ cannot mean one thing while dragging and another on release.
  While a shape tool is dragging, the canvas now shows the pending rect **and its
  size** underneath it, which is what Figma shows and what this build was missing.
* **Present** now means present (the ▶ in the panel header), and a presentation paints
  the artwork alone: `FrameCache::set_presenting` + `ir::strip_canvas_chrome` remove the
  canvas chrome — frame names (`/label`) and section title chips (`/pill` + `/chip`) —
  from the canvas render and from the prototype overlays. Figma does not draw frame
  names in presentation mode, and the canvas around a presented frame is not on screen
  at all. The document is untouched (a render mode, not a document property), and one
  test asserts that presenting **invalidates** the cached scene instead of serving the
  editor's labelled one.
* **Constraints are now a canvas behaviour, not an engine table.** `x_editor::constraints::apply_constraints` has existed since Phase 2.12 with a test and exactly one caller — the inspector's W/H fields — and no way at all to SET a pin: no `HPin` appears anywhere in the app. The Design column now ends with Figma's **CONSTRAINTS** block (Horizontal and Vertical, the five answers each), the rows come from one table (`CONSTRAINT_H` / `CONSTRAINT_V`), and the table is what the solver reads. `pin_deltas` is that solver written once; `apply_constraints` applies it in place for the inspector and `pin_commands` writes it as `Move`/`Resize` commands so the frame's own corner drag carries its pinned layers in the SAME undo entry (one Ctrl+Z puts the whole picture back). A child whose size actually changed hands the resize on to its own children, so a nested frame is pinned inside a pinned frame, and a group is refused: Figma's table is about layers inside frames, which is also why the block does not appear for a layer sitting on the page.
* **Figma Draw's Brush is built, as an outline.** The article's brush "add[s] texture
  and color" on top of the pencil's line, sets the stroke's fill/weight/style in the
  secondary toolbar, and repeats the brush styles in the right sidebar's advanced stroke
  settings. `Tool::Brush` (⇧B) shares the pencil's gesture, sampler and draw-it-in
  landing, and differs in the mark: `x_core::brush_outline` closes the freehand centreline
  into a filled outline whose half-width tapers with the style and whose two edges carry a
  deterministic grain; `state::BrushStyle` (Ink / Marker / Dry) is the one table the live
  preview, the panel's BRUSH STYLE block and the landed layer read. **Divergence**: Figma's
  styles are user-made shapes stretched or scattered along a stroke (a brush library, with
  "Create brush" from a closed vector layer, file-scoped). This build has three styles that
  ship, not a library — the outline is the style — and it has no ⇧⌘-style brush sampling
  (⌘/Ctrl-click on an existing stroke).
* **The layers row toggles are pinned**: hover shows the eye and the padlock, they stay
  while the state is on, and a locked layer stops answering canvas clicks.
* **The Scale tool (K) exists** — the engine could always scale a subtree
  (`Editor::scale_node`, Phase 2.3), but nothing on the canvas reached it. `Tool::Scale`
  now sits beside Move in the toolbar and in the palette, `K` selects it, and the same
  four corner handles the Move tool uses now scale the box *and* everything inside it —
  `V` or a bare `Esc` goes back to Move, with the selection still there:
  child offsets, stroke weight and dashes, corner radii, text size/leading, effect
  distances, auto-layout padding/gap. The anchor is the corner diagonally opposite the
  handle you grabbed — Figma's fixed point — and the whole drag is one undo step. A
  locked layer is skipped, because Figma's own article refuses it.
* **⌥⌘G frames the selection** — `Editor::frame_selection` and `Command::FrameSelection`
  had been in the engine since the wrap-selection refactor with tests and no caller; the
  shortcut and the palette entry now reach them. The frame is the members' collective
  AABB, single layers included, and the members keep their page positions.
* **The Slice tool (S) draws the export region Figma's article describes.** `NodeKind::Slice`
  and `x_render::ir::build_render_tree_slice` had both existed since Phase 2 with tests and no
  caller; now the tool draws a slice, the tool returns to Move, `Esc` leaves it, the layers row
  carries the scissors icon, and the canvas marks every slice with a dashed outline and its
  name. The export side is wired too: a selected slice flattens whatever overlaps it into its
  own bounds (and a slice with nothing under it still exports its size), while a selection that
  mixes a slice with other layers is refused with a reason — this build writes one file per
  export, so it must not silently drop half the selection.
* **The Pencil (⇧P) draws freehand.** Figma's own page for it is short and exact: the
  toolbar's creation-tools menu (⇧P), "Click and drag on the canvas to sketch", "a round
  3px stroke weight ... unless you're sketching on a dark canvas or frame", and "the
  pencil tool stays active until you select another tool or press Esc" — all three are
  what the tool does here, with the ink flipped to the light one because this canvas is
  dark. `x_core::freehand_path` is the second half of the engine's `simplify_polyline`
  (which has said "(pencil tool)" since the vector pass, with no caller); the stroke it
  produces is a normal `NodeKind::Vector`, so the existing vector edit mode edits it
  point by point — and holding ⇧ while drawing collapses the stroke to a straight line,
  which is the page's own tip.
* **A slice answers canvas clicks like any other layer** — the engine's hit test was left
  alone; the dashed outline and the name chip are how you find one. (Our rule, not Figma's:
  their slices are reached through the Layers panel and their edge.)
* **Two engine rules came out of this pass**: `scale_nodes_about` refuses a factor of
  zero or less (a drag past the anchor must not mirror the layer) and skips a listed
  node whose ANCESTOR is listed too — scaling both would scale the child twice.
* **The arc properties on an ellipse** (course chapter 26, "Turn an ellipse into an
  arc"). The engine's `NodeKind::Arc` had been rendered, hit-tested and exported since
  the vector pass with no caller; the course's route to it — the Sweep handle on hover,
  then Start and Ratio, or the three fields in the Appearance section — is now on the
  canvas, and the properties stay what Figma says they are: appearance. The layer's box
  does not move when the arc changes; Flatten is the documented way to make it hug the
  geometry, and the flattened shape is the `Vector` the engine's own flatten produces.
* **The Scale tool's panel, its anchor box and its body drag.** Figma's article describes
  three ways to scale, and this pass adds the two the build was missing: the right sidebar's
  **Scale** section while K is active (a multiplier, W/H fields that keep the ratio, and the
  nine-point anchor box) and a drag on the object's **bounding box** itself. `state.rs::scale_grab_factor`
  is the one projection rule — the corner grab is its special case — and `run.rs::selection_box`
  is the one box the panel, the handles and the body drag all measure, so the three surfaces
  cannot drift apart.

## 5. Honestly not built

Ordered by how visible they are, not by how hard they are:

1. **Community and Teams** in the file browser, and sharing in the editor. These need a
   backend; the build is local-first.
