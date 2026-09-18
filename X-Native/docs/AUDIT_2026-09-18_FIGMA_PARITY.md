# Audit — why these bugs keep appearing, X-Native vs Figma, and what changed

Date: 2026-09-18 · Branch: `arena/01a0b2ee-x-native` · Owner report: *"why is the page
name shown as the canvas frame name", "why is the page name used for renaming
pages, the pages are not getting deleted properly", "double-clicking is not
selecting the elements in the right panel", "why do we have this type of issue —
audit us properly against Figma"*.

This document is the audit. It has four parts:

1. **Root causes** — the structural reasons the same *class* of bug keeps coming
   back. This is the part that answers "why do we have this type of issue".
2. **Figma vs X-Native** — how the reference tool behaves, side by side with
   what our code did, with sources.
3. **What this pass changed** — file by file, with the invariant each change
   enforces.
4. **Still open** — honestly, with the reason each item is deferred.

Nothing here is a guess about intent. Every claim about our behaviour cites the
code that produced it; every claim about Figma cites a Figma source.

---

## 1. Why these bugs keep happening

### 1.1 One rule, two renderers — and nothing forced them to agree

There are two independent scene builders:

| path | file | used by |
|---|---|---|
| IR lowering (`lower` → `RenderCommand`) | `crates/x-render/src/ir.rs` | canvas buckets, exports, previews, `FrameCache` |
| direct encoder (`encode` → `VelloSink`) | `crates/x-render/src/scene.rs` | thumbnails, PDFs, headless renders |

The QA-004 "frame name on canvas" feature was written into **both**, and both were
written the same wrong way: paint the name of *any* Frame, in the top-left corner
inside the frame, including the render root — which on the canvas is the **page**.
So the page name was painted across the artboard, and because the page root is a
node that stays even when its children are deleted, the name "survived deleting
the frame". Two encoders meant two places to be wrong, and no test compared them
against a written rule.

**Fix in this pass:** the rule is now stated once and enforced in both encoders
from shared constants (`ir::LABEL_ABOVE_Y`, `ir::LABEL_SIZE`), and there is exactly
one lowering entry point (`build_render_tree_with_hidden`) — the second entry
(`build_render_tree_bucket_shell`) existed only to disagree about the root's label
and is gone.

### 1.2 The page and the canvas root are the same object, so "page" and "frame" blur

There are **three** things called "page" in this codebase, and two of them are the
same value:

| name | what it is |
| --- | --- |
| `doc.pages[i]` | the page list in the document — a **derived** copy |
| `editors[i].root` | the actual page frame the canvas renders — the **source of truth** |
| `OpenDoc::page` | which index is active (`App::active` is a different thing again: the active *document*) |

`OpenDoc::sync()` is one line — `self.doc.pages = self.editors.iter().map(|e|
e.root.clone()).collect()` — and `snapshot()` calls it, so **every `checkpoint`**
(a document transaction, an undo point, a page delete, a page add) rebuilds the
page list from the editors' roots. A rename that writes only `doc.pages[i].name`
is therefore undone by the next transaction; `App::commit_page_rename` writes both
sides for that reason. This is the mechanism behind "why is the page name used for
renaming pages" — the two copies blur, and the *editor root* wins. It is also the
mechanism a first version of this pass's own delete test tripped over, which the
CI log caught (see §4.5).

`doc.pages[i]` is a `Node::frame`, and `doc.editors[i].root` is a **clone** of it.
Consequences that produced the owner's second complaint:

* `commit_page_rename` wrote `pages[i].name` **and** `editors[i].root.name`, so
  renaming a page was, literally, renaming the artboard frame.
* The rename guard compared `doc.editor_ref().root.name` (the frame) against the
  new text, not the page, so a legitimate rename could be silently refused.
* The QA-004 label then painted that same string on the canvas, so a "page
  rename" looked like a "frame rename" too.

**Fix in this pass:** the page list is the single source of truth for the page
name; the root frame's name is a one-way mirror (some surfaces read a root's name
directly — flow labels, thumbnails, SVG ids); the guard compares page names; and
the root is no longer labelled on the canvas, so the two can no longer be confused
visually.

### 1.3 Chrome is hit-tested by "last rect pushed wins", with no discipline

`hit` is a `Vec<(Rect, Action)>` scanned in reverse. Every overlapping control
therefore depends on push order, and **push order is not documented anywhere**.
This is the direct cause of two separate bugs:

* the page row's ✕ was pushed *before* the row's `SelectPage`, so the reverse scan
  found `SelectPage` first — "clicking Delete selects the page instead of deleting
  it";
* the layer row's chevron had the same defect earlier (the comment in the code
  even says so).

**Fix in this pass:** the rule is now written at the site
("the row is registered FIRST, the specific zones on top of it"), the page ✕ is
pushed after `SelectPage`, and a regression test asserts that a click on the ✕
resolves to `Action::DeletePage(i)` — not to `SelectPage(i)`.

### 1.4 One action had two implementations, one of them unreachable

Deleting a page existed twice:

* `Host::on_press` → `Action::DeletePage(i)` set `doc.page = i` and then called
  the menu command "delete the active page";
* `App::page_menu_cmd(Delete)` held the only real delete body.

So ✕ on a background page *stole the selection* and then deleted a different row
than the one clicked, and ✕ on the active page was unreachable because the trash
was only painted for inactive rows.

**Fix in this pass:** one implementation, `App::delete_page(i)`, used by both the
rail's ✕ and the page menu; it deletes the clicked row, keeps the selection where
possible, refuses only on the last page, and is exercised by tests.

### 1.5 Lists were capped with a sentinel instead of windowed

`pages_rows()` handled "more pages than fit" by **replacing the last row** with a
sentinel whose index was the page *count* — one past the end of `doc.pages`. The
paint layer drew a "+N more" row for it and the hit layer skipped it, so with more
than three pages the 4th page had no row at all: it could not be selected,
renamed, or deleted. That is the mechanical cause of "the pages are not getting
deleted properly".

**Fix in this pass:** the band windows over the list, following the active page
and clamping at the tail (`PAGES_MAX_ROWS`), and a test walks every page to prove
each one gets a real, clickable row at some scroll position.

### 1.6 Chrome had no double-click semantics at all

`last_click` (350 ms / 4 px) was recorded **only on the canvas**. The panels
dispatched every press, so a double-click on any chrome control was two full
actions: a colour popover opened and closed, a component prop ticked and unticked,
a font picker opened and shut. To the user this reads as "double-clicking does not
select the colours and the other boxes/components" — the selection visibly
flickers back to where it started.

**Fix in this pass:** chrome keeps its own press record (`App::last_chrome`); a
repeat press on a *toggle-class* control is counted once (so the single click's
effect stands), while steppers, Add-row and friends still repeat because
repeating them is the intent; and the two Figma *double-click* affordances were
added for real — rename a page name in the Pages list, rename a layer name in the
Layers panel.

### 1.7 Tests pinned the buggy behaviour

`label_paths()` helpers in three test files existed to *expect* the canvas labels,
including the root's. So the page-name-on-canvas defect was encoded as expected
behaviour, and any fix would have looked like a regression. The golden test pinned
a command count that included the root label.

**Fix in this pass:** the label expectations are rewritten around the rule
("the root of a render is never labelled"), the golden count is re-pinned with the
reason in the comment, and new tests assert the *absence* of a root label — so
re-introducing the bug fails the suite.

### 1.8 Features were built per screenshot, not per model

The QA-004 label came from matching a mock, not from a written rule about what a
canvas label *is*; the "+N more" row likewise. When there is no model, each new
surface invents its own semantics and the next change breaks a different one. The
Figma comparison in §2 is the first version of that model for canvas chrome; it is
now the thing to check against, not a screenshot.

**The general rule this audit installs:** a behaviour belongs to the *product*, not
to the surface it was first noticed on. If the canvas, the exporter, the
thumbnail and the PDF must agree, they must share one function and one rule, and
there must be a test that fails when they disagree.

---

## 2. Figma vs X-Native

Sources: [Create and manage pages](https://help.figma.com/hc/en-us/articles/360038511293-Create-and-manage-pages),
[Select layers and objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects),
[Explore component properties](https://help.figma.com/hc/en-us/articles/5579474826519-Explore-component-properties),
[Show names of nested frames (forum)](https://forum.figma.com/t/show-names-of-nested-frames/41949),
[How to hide frame name in Figma](https://designilo.com/2025/07/15/how-to-hide-frame-name-in-figma/),
[Section titles export with the image (forum)](https://forum.figma.com/suggest-a-feature-11/section-titles-are-exporting-as-part-of-the-image-13338).

### 2.1 Pages

| behaviour | Figma | X-Native before | X-Native now |
|---|---|---|---|
| Where the list lives | a dropdown that opens from the current page name at the top of the left rail | always-expanded band in the rail | unchanged (see §4.1) |
| Rename | right-click → **Rename**, or **double-click the page name**; apply by clicking outside | menu → Rename only; the field edited the page **and** the artboard frame name | menu → Rename **and** double-click on the row; writes the page name, mirrors the root |
| Delete | right-click → **Delete** (one page at a time; no confirm) | ✕ only on the *active* page's row (`!active` gate), plus a menu item; deleting a background page selected it first | ✕ on any row including the active one, menu unchanged; the clicked row is the one deleted; last page protected |
| Delete semantics | deleting a page deletes all of its content | same (editors + pages + comments re-indexed) | same, one implementation |
| Duplicate | right-click → Duplicate, named "Copy of …" | menu → Duplicate, named "… copy" | unchanged (naming difference noted in §4.2) |
| Reorder | drag a page | menu → Move up/down | unchanged |
| More pages than fit | list scrolls | **4th page and beyond had no row at all** | windowed band; every page reachable |
| Selected page | the page you are viewing is the selected one | same (`doc.page`, `app.active`) | same |

### 2.2 Names on the canvas

| behaviour | Figma | X-Native before | X-Native now |
|---|---|---|---|
| Frame name | drawn at the **top-left, above** the frame; hideable with Layer → "Show name" (canvas only, never in exports) | drawn **inside** the frame's top-left corner (14, 10/20) | drawn **above** the corner at y = −26 |
| Which frames are named | only a page's **outermost** frames; frames nested in frames are silent — *"When nesting frames to organize them, only the top-level / outermost frame title is shown"* | every frame, at every depth | outermost frames only (a frame inside a frame is silent in both encoders) |
| Frames inside a Section | *"In sections, frame name is always visible!"* | named like any frame | named (a Section resets the nesting flag) |
| Sections | always named; the name pill is even included when a Section is exported (intended, and controversial) | named at (14, 10) | named above the corner |
| The page itself | a page has a name in the page list; a page is **not** an object on the canvas, so it has no canvas label | **the page name was painted as the artboard's name and survived deleting everything on the page** | the render root is never labelled (canvas, export or thumbnail) |
| Instance internals | a master's inner layers are not named on the canvas | master frames were named | silent |
| Label size | ✓ consistent | 14 px (Frame arm of the direct encoder) vs 18 px (Section arm) vs 18 px (IR) | one constant (`LABEL_SIZE = 18`) in both encoders, both arms |

### 2.3 Canvas selection gestures

| gesture | Figma | X-Native before | X-Native now |
|---|---|---|---|
| click | selects the top-level object under the cursor | same | same |
| **double-click** | *"Double-click on the object — or press the enter key — to select one level of nesting down"* | jumped straight to the **deepest** hit (`deep = dbl`), so one double-click skipped every intermediate group | drills **one level** per double-click (`Editor::drill_into`) |
| ⌘/Ctrl-click | deep select onto the exact nested layer | `ctrl` → deep select | unchanged |
| double-click a text node | enters text editing | enters inline editing | unchanged |
| shift-click | add/remove from the selection | same | same (shift-double-click still means "extend", not "drill") |

### 2.4 The panels (the owner's third complaint)

| behaviour | Figma | X-Native before | X-Native now |
|---|---|---|---|
| Layer name | **double-click the name in the Layers panel** to rename inline | no rename at all outside of nothing | double-click the name → inline field, Enter commits (undoable), Esc cancels; a single press still selects and still arms the reorder drag |
| Property name in the right panel | *"Rename: Double-click a property name"* (component properties) | double-click dispatched twice | repeat press on a toggle-class row is counted once |
| Fill / stroke swatch | one click opens the picker; the second click of a double-click must not close it | opened, then the second press reached the "click-away closes" rule and shut it again | the repeat press is swallowed; the popover stays open |
| Add / steppers / align | repeat is meaningful | repeat | unchanged (repeat still applies) |
| Numeric / hex fields | click into the value | the second press re-seeded the buffer from the document, discarding what was typed | the second press keeps the buffer and selects it |
| Page name in the list | double-click to rename | nothing | double-click to rename |

### 2.5 Visual language (design vs us)

This is the part where we are *deliberately* not Figma, and it should stay that
way — but the differences have to be intentional, not accidental:

| element | Figma | X-Native (Graphite / Daylight) |
|---|---|---|
| Right sidebar tabs | Design / Prototype / Inspect (+ Dev Mode) | COMPOSE / FLOW / SHIP / UX ANALYSIS — the X-Native workflow tabs |
| Left rail | Layers + Assets as tabs; Pages in a dropdown | PAGES band above LAYERS; ASSETS/TOKENS replace the tree in place |
| Palette | light and dark, redrawn per platform | two curated palettes (Graphite, Daylight), contrast-audited |
| Frame labels | grey, above the frame, hideable per frame | grey, above the frame, not hideable (see §4.3) |
| Empty states | illustrative | sketch thumbnails per page + empty-frame names on the canvas |

The rule that matters: **our differences are the workflow, not the mechanics.**
Selecting, renaming, deleting, drilling and labelling behave like Figma; the
chrome around them is ours.

---

## 3. What this pass changed

Renderer (one rule, two encoders kept in lockstep):

* `crates/x-render/src/ir.rs`
  * `pub const LABEL_ABOVE_Y: f64 = -26.0`, `pub const LABEL_SIZE: f64 = 18.0`.
  * `lower()` lost `label_root`; gained `in_frame` (a frame already encloses this
    node → no name).
  * Root gate `!path.is_empty()` in the Frame and Section arms; the Frame arm also
    requires `!in_frame`.
  * Names move from inside the corner `(14, 10)` to above it `(0, -26)`.
  * `build_render_tree_bucket_shell` deleted: one lowering entry
    (`build_render_tree_with_hidden`) for canvas buckets, exports and previews.
* `crates/x-render/src/scene.rs` — the same two rules (`depth > 0 && !in_frame`,
  `LABEL_ABOVE_Y`, `LABEL_SIZE`) so thumbnails/PDFs cannot drift from the canvas.
* `crates/x-render/src/frame_cache.rs` — the bucket shell calls the single entry;
  the fingerprint still hashes a frame's name (a rename must invalidate).
* Exports: `build_render_tree_of` (export one layer) seeds `in_frame = false` at the
  exported node and the exported node IS the render root, so its whole subtree is
  name-free — a frame nested in it gets `child_in_frame = true` from its parent and
  is suppressed too. `crates/x-native/src/export.rs` additionally strips any
  `/label` Glyphs command for every format (PNG/JPG/SVG/PDF/clipboard), which is the
  belt and braces for Sections, whose own name is emitted at any depth. A new
  assertion in `build_render_tree_of_renders_subtree_at_origin` pins "no `/label`
  in an exported tree"; the open question in the last report is therefore closed,
  in the direction of Figma (a frame's name is canvas chrome, never artwork).
* `apps/.../run.rs` — the empty-frame watermark passes (`frame_watermarks`,
  `watermark_shadows`, `watermark_labels`) are deleted: they painted a **node name
  in 28px black/10 across empty top-level frames** in demo mode, which is the same
  defect class as the page-name label (a chrome string drawn on the artboard).

Pages:

* `App::commit_page_rename` compares and writes page names (root stays a mirror).
* `App::delete_page(i)` — one implementation for the rail's ✕ and the page menu.
* `App::pages_rows` windows over the list (`PAGES_MAX_ROWS`); the sentinel row is
  gone from both paint and hit-testing; `pages_band_bottom` uses the same constant.
* `editor_ui::paint_left` registers the row before the ✕ and paints the trash on
  the active row too.

Chrome clicks:

* `App::last_chrome` + `is_repeat_chrome_click`; toggle-class repeats are counted
  once at the top of `on_press` (`Action::is_toggle_row`).
* `Action::Field` re-opened on the same field keeps the buffer.
* Double-click a page name → rename (`begin_page_rename`); double-click a layer
  name → rename (`begin_layer_rename`, `FieldId::LayerName`, `Action::LayerRename`).
* `Host::on_press` canvas double-click drills one level.

Tests (all of them fail if the old behaviour comes back):

* `x-render`: `a_frame_name_labels_the_gutter_above_it_and_never_the_root` (root,
  nesting, sections), `slot_content…` (no labels inside an instance),
  `frame_cache` bucket count + hidden-text expectations.
* `x-editor` / `x-format`: the `label_paths` helpers are removed; scenes are
  counted without a root label.
* `x-native/tests/golden_project.rs`: count re-pinned 52 → 51 with the reason; the
  kind hash needs one `cargo test` run to re-pin (see §4.4).
* `apps/x-designer` regression suite: `every_page_in_the_window_is_clickable_and_the_window_follows_the_page`
  (see §5), `pages_rename_…`, `page_delete_…`,
  `double_click_on_a_panel_toggle_counts_once`, `double_click_on_a_page_name_…`,
  `double_click_on_a_layer_name_…`, `pages_past_the_fourth_…`, and t13 now asserts
  the canvas equals the export path-for-path.

---

## 4. Still open (deliberately, with reasons)

### 4.1 The Pages band is permanent, Figma's is a dropdown

Figma's page list only exists while the dropdown is open, so it can scroll freely
and needs no row cap. Ours is a permanent band between PAGES and LAYERS, which is
why a cap (and the sentinel hack) ever existed. The windowing fix makes every page
reachable, but the *design* question — permanent band vs dropdown — is a product
decision, not a bug fix, and changing the rail again while these four complaints
are being closed would work against the "one build, no half-fixes" instruction.

### 4.2 Duplicate naming ("… copy" vs Figma's "Copy of …")

Cosmetic, and it touches serialization-adjacent tests; noted here so it is a
decision rather than an oversight.

### 4.3 No per-frame "Show name" toggle

Figma can hide an individual frame's canvas label (Layer → Show name). We now draw
the right labels in the right place, but cannot hide one. It needs a document
field (serialized), a checkbox in the inspector and both encoders to honour it —
a feature, not a defect fix.

### 4.4 Golden kind hash — closed

Both constants are re-pinned from a real run: `GOLDEN_COMMANDS = 51` and
`GOLDEN_KIND_HASH = 0xcd25_0bff_fae4_f4a6`, which is what the gate printed —
`GOLDEN DRIFT: commands=51 (pinned 51), kind_hash=0xcd250bfffae4f4a6 (pinned
0xe1560b27ca1a6fbd)`. The document itself did not move (no geometry, no paint);
only the removed root label.

### 4.5 Where the verification actually happened

Not in this sandbox: it has no Rust toolchain and cannot install one
(`static.rust-lang.org` and `crates.io` are unreachable). So the repository's own
`Fix` workflow — which exists for exactly this case and which the second half of
the honest version of this section is about — was started with a `[ci-fix]`
commit. It ran `cargo fmt --all` (the tree had never been through rustfmt: that
commit is `f2123e3`), re-ran the whole gate, and published the log to the PR.

That log found five things, four of them in this pass's own tests and one in the
source (`///` on a function parameter — rejected by rustc). All five are fixed,
and the gate is **green on the PR**: `scripts/check.sh — pass (1m20s)`, covering
`cargo fmt --check`, `cargo clippy --workspace --all-targets` with **dead code
55 / ceiling 82**, `cargo test --workspace --locked`, the docs-reference check,
the design-sheet regenerate-and-diff, and the CLI smoke. The per-item table is in
[`FIXES_2026-09-18_PAGE_NAMES_AND_DOUBLECLICK.md`](FIXES_2026-09-18_PAGE_NAMES_AND_DOUBLECLICK.md).

The four owner complaints each have at least one test that fails if the fix is
reverted, and those tests now run on CI — which is the cheapest way to prove them
fixed. For the visual claims, on a machine with a GPU:

```
cargo test -p x-designer --bin x_native_app -- --ignored   # screenshots
```

### 4.6 Selection *inside* an instance

Figma selects layers inside an instance (the master's children) and shows their
overrides in the inspector. Our `hit_test` walks the document tree, where an
instance is a single node whose children are resolved at render time, so clicking
inside an instance selects the instance. The right panel then offers the
component's props/slots (`InstanceProp`, `CycleInstanceSwap`, `SlotSet…`), which
is why the owner could still see those controls "not selecting". Making nested
instance layers selectable is a real feature (selection model + override
authoring); it is listed here rather than half-built.

---

## 5. Self-audit of this pass (what re-reading my own diff found)

The owner asked for an actual audit rather than another round of patches, so the
diff was re-read line by line after it was written, against the two encoders and
the hit-zone order. Three defects in the pass itself came out of that:

1. **`App::pages_rows` followed the wrong index.** The window was scrolled with
   `self.active` — which is the active *document* (`App::active`, the tab), not the
   active page (`OpenDoc::page`). On any document where the two differ (a second
   file open, or page 5 of a 6-page document after a tab switch) the band showed
   the wrong four rows, and the "every page is reachable" claim this fix rests on
   was only true for pages 0..4. Now `doc_ref().page`. This is exactly the class of
   bug §1.2 describes — two things called "page" in one struct — so it is worth
   noticing that the fix for the symptom reproduced the cause.
   Test: `every_page_in_the_window_is_clickable_and_the_window_follows_the_page`
   asserts the window at the head, after one step, and clamped at the tail, and
   clicks a row to prove the hit zone selects *its own* page.
2. **The band rect was read from `rows[0]`.** `paint_left` did
   `let (bx0, by0) = (rows[0].1.x0, rows[0].1.y0)`, so a document with no pages —
   which `pages_rows` explicitly guards against — would panic the whole paint pass
   instead of painting nothing. Now a `first/last` match. (A page-less document is
   not reachable through the UI: `App::editor_ref` requires one editor, so
   `delete_page` refuses to remove the last page. The guard is therefore defensive
   only, and deliberately has no test asserting an unreachable state.)
3. **A leftover comment claimed a rule the code no longer had** — `is_toggle_row`'s
   doc comment said "at the bottom of this file" for a function directly above it,
   and a stray line explained what is *not* in the list from the middle of the
   list. Both reworded; §1.7 is the reason this matters (comments are what the next
   pass believes).

What the self-audit also checked and found *correct*: every `Action` variant added
by this pass is handled in the dispatcher (no exhaustive match left stale — the
`Variant` audit script walks the enum and the `match a` sites); the repeat guard is
armed only by `is_toggle_row` presses (the third tuple field), so rename
double-clicks, steppers and text fields still receive their second press; `Esc`
clears `layer_edit_id` and `commit_field` clears it for every field that is not a
layer name; and `tree_row_press` is the same body the layers row used before the
refactor, so single-press select + reorder-drag behaviour is unchanged.
