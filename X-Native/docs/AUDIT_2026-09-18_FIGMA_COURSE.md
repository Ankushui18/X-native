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
| **Slice** | an object whose only job is to be exported | not built (any selection can be exported) |
| **Rectangle** (R) / **Ellipse** (O) | drag creates; ⇧ square/circle; ⌥ from the centre; the size is shown while dragging; **drawn over a frame it joins that frame**; space while dragging prevents nesting | `Tool::Rect` / `Tool::Ellipse`; all four rules now, via `state::create_rect` + `container_under` + `space_pan` |
| **Line** (L) / **Arrow** (⇧L) | drag in any direction; stroke settings in the right panel | `Tool::Pen` + line nodes; no arrow caps yet |
| **Pen** (P) | click to place points, drag for curves, click the first point to close, Esc leaves it open; draws INSIDE a frame | `Tool::Pen` (click = anchor, drag = handle, close on the anchor); nests by the same rule now |
| **Pencil / Brush** | freehand drawing, and the strokes can be smoothed into a vector network | not built (listed below) |
| **Text** (T) | drag makes a fixed-size text box, click makes one that grows with the text; double-click a text layer to edit in place | `Tool::Text` (drag = box, click = auto width); in-place editing with caret, selection and wrapping |
| **Hand** (H) / space | pan; space held anywhere gives the hand cursor | `Tool::Hand`, `space_pan`, `Drag::Pan` |
| **Comment** (C) | drop a pin, thread replies | `Tool::Comment` + pages' comment pins |
| **Zoom** | ⌘/Ctrl + wheel, ⌘0 / ⌘1 / ⌘2, or the zoom menu | wheel zoom at the pointer, `Action::ZoomMenu` (in / out / 100% / selection / fit) |
| **Nudge** | arrow keys move 1px, ⇧ 10px | arrow-key nudge with ⇧ big-nudge |

Three rows changed since this table was written (see §4): a new layer joins the
container you draw it in, the shape tools' modifiers (⇧ constrain, ⌥ from the centre,
live size readout), and the two tools that were engine-only — the Scale tool (K) and
Frame selection (⌥⌘G), which now have a tool, a palette entry and a shortcut.

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
* **The layers row toggles are pinned**: hover shows the eye and the padlock, they stay
  while the state is on, and a locked layer stops answering canvas clicks.
* **The Scale tool (K) exists** — the engine could always scale a subtree
  (`Editor::scale_node`, Phase 2.3), but nothing on the canvas reached it. `Tool::Scale`
  now sits beside Move in the toolbar and in the palette, `K` selects it, and the same
  four corner handles the Move tool uses now scale the box *and* everything inside it:
  child offsets, stroke weight and dashes, corner radii, text size/leading, effect
  distances, auto-layout padding/gap. The anchor is the corner diagonally opposite the
  handle you grabbed — Figma's fixed point — and the whole drag is one undo step. A
  locked layer is skipped, because Figma's own article refuses it.
* **⌥⌘G frames the selection** — `Editor::frame_selection` and `Command::FrameSelection`
  had been in the engine since the wrap-selection refactor with tests and no caller; the
  shortcut and the palette entry now reach them. The frame is the members' collective
  AABB, single layers included, and the members keep their page positions.
* **Two engine rules came out of this pass**: `scale_nodes_about` refuses a factor of
  zero or less (a drag past the anchor must not mirror the layer) and skips a listed
  node whose ANCESTOR is listed too — scaling both would scale the child twice.

## 5. Honestly not built

Ordered by how visible they are, not by how hard they are:

1. **Slice tool** — an object whose only job is to be exported. We export any selection,
   which covers the use case but not the layer.
2. **Pencil / Brush tool** — freehand (and Figma's "smooth" pass that turns a freehand
   stroke into a vector network). `Tool::Eraser` and `Tool::Symmetry` exist; freehand
   does not.
3. **Line / Arrow tools** (L / ⇧L) — a one-drag line or arrow. Stroke caps exist
   (`Stroke cap: round / square / butt / arrow`), but the tools themselves do not.
4. **The Scale panel's numbers, and the scale tool's body drag** — Figma's help says
   "Hover over the object's bounding box to make the [scale] cursor appear. Then,
   click-and-drag to resize", plus a *multiplier* and an *anchor box* in the right
   sidebar. Ours scales from the four corner handles (the same ones the Move tool
   resizes with) and dragging the body of an object still moves it, so the gesture is
   there but not the whole surface; typing "50%" or picking an anchor is not.
5. **Community and Teams** in the file browser, and sharing in the editor. These need a
   backend; the build is local-first.
