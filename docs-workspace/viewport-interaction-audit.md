# Viewport & Interaction Audit — X-Native Editor (2026-09-16)

Scope: full-viewport responsive/margin/alignment review + core-interaction
verification, against the user screenshots (177% and 100%) and the engine
source. Findings cite file:line at `d30923e`. This is the working document for
the redesign request; phases P1–P4 below are the proposed execution order.

## A. Root-cause findings (viewport / chrome)

### A1. The editor chrome is a fixed-coordinate port of an HTML mock
Every panel is painted with absolute pixel offsets baked from a 1440×900 mock
(e.g. `editor_ui.rs` "A3/A4 row: … mock geometry unchanged", `y0 + 447.7`,
`x0 + 141.5 * i`, `x0 + 283.0`). There is **no layout engine**: no flow, no
reflow, no elide, no wrapping, no min/max negotiation between panels and
canvas.

- Panel widths are constants: `ED_LEFT_W = 280`, `ED_RIGHT_W = 340`
  (`theme.rs:184-187`). `right_w`/`left_sidebar_w` are never resized at runtime
  (no drag handle exists; `editor_regions()` in `state.rs:1528` just subtracts
  the constants).
- Consequences:
  - Below ~980 logical width (the min window, `run.rs:86`) the canvas can
    shrink to ~300px while both panels keep full width — the workspace, not
    the chrome, is what flexes, backwards from what a design tool needs.
  - Any content wider than 340−26px of padding is hard-clipped at the panel
    edge (the "Wrapi…", "100% .un", "Position" cuts in screenshot 1).
  - At larger widths the panels stay 280/340 and dead space accumulates.
- **Root fix**: replace the coordinate port with a small column/row layout
  pass (measured row heights, panel min/max widths, canvas as the flexible
  region, panel widths persisted per user). This is P2 and is the single
  largest lever for "professional, consistent, scalable".

### A2. Status bar shows transient GPU-surface loss as a load error
`run.rs:9587`: `get_current_texture()` returning Lost/Timeout during the
loading "Presenting" phase increments `surface_failures`; 3 strikes → full
load failure ("The document is loaded, but its window surface is
unavailable. Try Again to prepare it again."). In steady state (screenshot 2)
the same path just sets `app.status` — and the message then **persists**
because nothing clears it after the next successful present.
- **Root fix**: a transient surface loss is self-healing (the code already
  reconfigures) — it should not surface as an error at all. Only repeated,
  non-recovering failures (existing 3-strike rule) should fail; and any
  rendered frame clears the stale status. Small, P1.

### A3. "0 × 0" size badge for degenerate selections
`editor_ui.rs:4740+`: the selection size badge unions per-node
`transform + (w,h)` boxes and prints `{w} × {h}` even when the union is
degenerate — a zero-size selected node prints "0 × 0" on empty canvas.
- **Root fix**: hide the badge when the union has no area (and consider
  resolving auto-layout content sizes instead of raw `w/h`). P1, small.

### A4. Right panel is empty with no-selection state
Screenshot 2: nothing selected → the whole right panel is blank. No
"no selection" affordance, no document-level defaults section.
- **Root fix** (pairs with the default-font work, P3): when nothing is
  selected, show document defaults (default font, canvas bg) — this is the
  "dynamic default font" surface.

## B. Hardcoded "functionality" that must become dynamic (user-named)

### B1. Default font is an app constant, not a document property
`typo_val()` (`editor_ui.rs`, no-selection branch) hardcodes `"Inter"`.
New text nodes carry `font: None` → resolved against the font manager's
default. There is no `Document.default_font` field: the "document's default
font" is aspirational in a comment, not in the model.
- **Root fix**: add `Document.default_font: String` (serde default "Inter" so
  old files migrate), render it in the no-selection inspector, and have new
  text nodes + the text tool read it. P3.

### B2. Canvas grid auto-enabled on every new file
`state.rs:1169/1221`: `guides_visible: true` in **both** `demo_blank` and
`from_document` — every new and every opened document starts with the grid
on (`editor_ui.rs:102/134` draw it).
- **Root fix**: default `guides_visible: false`; keep the eye toggle
  (`run.rs:8503`). One-line-per-constructor, but the decision (grid off by
  default, opt-in via the toolbar) is the point. P1.

## C. Core interactions — verification results

| Interaction | Status | Evidence / fix |
|---|---|---|
| Create / open / close file | close fixed in PR #9 (tab ✕ zone ordering, t17) | `run.rs` close handlers; `t17_*` |
| Frames (create, name on canvas) | name-on-canvas fixed in PR #9 (QA-004 label, now painted exactly once by the shell scene) | `ir.rs` Frame arm, `frame_cache.rs` bucket loop |
| **Placing items inside artboards** | **BROKEN (root cause found)** | `finish_create()` (`run.rs:4388`) always calls `insert_node(&root_id, …)` — every drawn node lands at the page root, never inside the selected/hovered frame. Fix: resolve parent = single selected frame (Figma semantics), convert world→local coords. P2. |
| **Group / ungroup** | **NOT IMPLEMENTED** | No `Action::Group`/`Ungroup` exists anywhere in the app; `NodeKind::Group` exists in the engine + codec + IR but has no editor entry point. Fix: Group = wrap selection in a group node (undoable), Ungroup = promote children, both in the context menu + ⌘G/⌘⇧G. P2. |
| Pages — create / rename / duplicate / move | implemented (`PageMenuCmd`, `state.rs:2099-2230`) | — |
| **Pages — list & delete UX** | **BROKEN (UX root cause found)** | The PAGES section shows ONE field (the active page) — there is no list of pages; delete is a hover-only trash icon + context menu (`editor_ui.rs:1687-1745`). Users can't see other pages or discover deletion. Fix: real page list (all pages, click to switch, per-row hover menu: rename/duplicate/delete/move, disabled on last page). P2 (part of the "two page areas" redesign). |
| Layers / hierarchy tree | works (expand/collapse, search, scroll) | `editor_ui.rs:1745+` |
| Grid | works, but auto-on (B2) | `guides_visible` |
| Fonts / defaults | hardcoded (B1) | `typo_val` |
| Viewport behavior | pan/zoom correct (`t05`, camera tests); min window 980×680 | `run.rs:86` |
| Selection states | outlines/handles correct (`t05` transform parity); degenerate badge (A3) | `paint_canvas_overlays` |
| Undo/merge, clipping, masks | green (900-test suite) | regression_tests.rs |

## D. The "two page areas" redesign (user-named)

Left panel today: DRAFTS row → file row → LAYERS/ASSETS/TOKENS pills →
**PAGES** (single active-page field + hover trash + ⋯ menu) → **LAYERS**
(tree). Problems: (1) PAGES is a single-value field, not a collection — no
overview, no reorder-by-drag, delete hidden behind hover; (2) the LAYERS
tree has no group/layer-section affordances and no page context; (3) the
pills + PAGES + LAYERS are three stacked fixed-height bands inside a fixed
280px column (A1).
**Target** (original, not Figma): one **Pages** list (compact rows: name +
page-type glyph, click to switch, hover menu, add at end; reorder by drag)
above one **Layers** tree; the pills move into the panel header as a
segmented control; both bands get measured (not fixed) heights so the tree
gets all remaining vertical space. P2.

## E. Execution plan

- **P1 (small, mechanical — land first, each behind its own gate run)**
  - A2: transient surface loss: no scary status; stale status cleared on
    present. + regression test (status cleared after a lost frame).
  - A3: hide 0×0 size badge for degenerate selections. + test.
  - B2: grid off by default (both constructors). + test asserting a fresh
    doc has `guides_visible == false`.
- **P2 (layout + interaction core)**
  - A1: column/row layout pass for editor chrome (min/max panels, canvas
    flexible, persisted widths); replace fixed offsets in the Design tab
    first (the panel that clips), then the rest of the chrome incrementally.
  - C: artboard placement (parent = selected frame, world→local).
  - C: group/ungroup (engine op + context menu + shortcuts + tests).
  - D: pages list + layers band redesign.
- **P3 (document model: dynamic defaults)**
  - B1: `Document.default_font` (serde-default migration), inspector
    no-selection panel (A4) shows it; new text uses it.
  - B4 (from A4): no-selection right panel = document defaults view.
- **P4 (consistency pass)**
  - Original visual language audit: spacing scale, type scale, icon set —
    one design token table for the whole chrome (keeps it "professional,
    consistent, scalable" without converging on Figma's look).

Each phase is a separate commit series; the 900-test suite + gate (fmt,
clippy, dead-code ratchet 82/82, golden re-pin discipline) is the safety
net for every change.

## F. UI maturity audit (Figma "Explore" benchmark, 2026-09-16)

Figma's Explore section (help.figma.com) is the capability benchmark —
toolbar tool access, navigation-bar/left-sidebar structure, the
properties panel, canvas background — used as a maturity reference,
NOT a visual template (original language stays ours).

### Findings (all reproduced in code, not from memory)

- **F1 — 22 icon names referenced by the UI have no `src()` entry**
  (icons.rs silently no-ops a miss, so these render as empty slots):
  - toolbar tools: `eraser`, `reflect-vertical`, `sticky-note`,
    `arrow-right` (state.rs `Tool::icon`)
  - image controls: `repeat` (flip), `rotate-ccw` (editor_ui)
  - command palette: `arrow-up`, `download`, `file-plus`,
    `folder-open`, `frame`, `keyboard`, `layout-list`, `maximize`,
    `mouse-pointer`, `redo`, `save`, `target`, `trash`, `undo`,
    `zoom-in`, `zoom-out`
  Fix: add all 22 (Lucide geometry, 24x24) + a census test asserting
  every referenced name resolves AND every path of every referenced
  icon parses (catches a single broken subpath, not just a missing
  icon). — P6.
- **F2 — three toolbar tools are GUI-unreachable**: `Comment`,
  `Eraser`, `Symmetry` exist in `Tool` (with shortcuts) and the board
  mode has its own set, but the design toolbar lists only 7 of the 10
  design tools. Figma exposes every tool from the toolbar.
  Fix: add the three to the design toolbar (relayout the pill: 311→
  415 wide, divider + search follow). — P7.
- **F3 — `Tool::shortcut()` is a dead duplicate of a working map**
  (correction to the initial read): the shortcuts DO work — the real
  map is written inline in `run::on_character` (V/F/T/R/O/P/H/C,
  board S/C/R/O, ⇧E eraser, M symmetry, even ⇧1/⇧2/⇧0 zoom). The
  `pub fn Tool::shortcut()` is never called: two sources of truth for
  one fact, and the fn documents shortcuts the inline map only
  half-matches (e.g. M-symmetry is mode-blind on boards there).
  Fix: single source of truth — `Tool::from_shortcut(c, shift, board)`
  consumed by on_character, unit-tested; delete the dead fn. — P7.
- **F4 — no on-screen zoom controls**: the zoom % in the right-panel
  header is static text; zooming works by keyboard (⇧1 fit, ⇧2 100%,
  ⇧0 selection) and palette commands, but there is no visible control.
  Figma's 100% dropdown is the hub for this.
  Fix: make the label a button → dropdown (zoom in, zoom out, 100%,
  zoom to selection, zoom to fit). — P8.
- **F5 — dead button in the right-panel header**: the `history` icon
  pushes no hit action (`_ => {}`).
  Fix: remove it (no undo-history feature exists; a dead button is
  worse than no button). — P8.
- **F6 — layers panel has no collapse-all**: per-row chevrons exist,
  but a 200-layer document stays fully expanded until toggled one by
  one. Figma has Collapse layers in the panel header.
  Fix: small button right of the LAYERS micro-label; collapses all
  expanded nodes except the selection's ancestors (Figma parity). — P9.

- **F7 — four advertised palette zoom commands ran nothing**
  (found while doing F4): "Zoom In" and "Zoom Out" had no arms in
  run_palette, and the Fit/100% arms were misspelled against their
  labels ("Zoom to fit" vs "Zoom to Fit", "Zoom 100%" vs "Zoom to
  100%"). The ⌘=/⌘-/⌘0 shortcuts they advertised were never in the
  key handler either. Fix: wire all four commands + the three
  shortcuts. — P8.
- **F8 — the LAYERS search icon was dead** (no handler, no search):
  "the tree works (expand/collapse, search, scroll)" was true of the
  v45 mock, not the real tree. Fix: the icon opens a real search
  field above the tree; the query lives in OpenDoc::tree_search and
  collect_tree_rows renders matches + ancestor chain only
  (descends through collapsed nodes); x clears, Enter keeps it
  open. — P9.

Already at parity (checked, no action): resizable sidebars, UI
minimize (⇧⌘\), canvas background color (hex field, no-selection
panel), pages list w/ add/rename/delete (P2), find & replace (⇧⌘F),
context menu (P4), hover highlight, tool shortcuts (they work — see
the F3 correction).

Deferred (bigger features, not "issues"): tooltips (no hover-label
system at all), property-labels toggle, canvas background
opacity/visibility, drag-reorder in the tree, type/spacing-scale
refactor, dead UI code cleanup (chrome.rs Palette/XNativeApp,
command.rs constants — inside the dead-code budget).

### P6–P9 status

P6 icons (+ root-cause: one ICONS table) · P7 toolbar + shortcut
table · P8 zoom menu · P9 collapse-all + tree search — each behind
its own gate run; all findings above are covered.
