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

## 5. Honestly not built

Ordered by how visible they are, not by how hard they are:

1. **A shape drawn over a frame joins that frame** (Figma's frame-first rule). Ours joins
   the page root unless the frame is the selection. Changing it moves existing
   behaviour, so it wants its own pass with the ⌘-override (draw above the frame) and a
   test per case.
2. **Scale tool** — resize without distortion (Figma's Scale resizes text and stroke
   widths with the box). Ours scales only the box.
3. **Slice tool** — an object whose only job is to be exported. We export any selection,
   which covers the use case but not the layer.
4. **Pencil tool** — freehand. `Tool::Eraser` and `Tool::Symmetry` exist; freehand does
   not.
5. **Community and Teams** in the file browser, and sharing in the editor. These need a
   backend; the build is local-first.
