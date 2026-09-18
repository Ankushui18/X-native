# Fixes — page names on the artboard, page rename/delete, panel double-click (2026-09-18)

Report for the owner's four complaints after the theme/rail pass, plus the
stability request. The reasoning behind the fixes — *why* this class of bug kept
coming back, and a full Figma-vs-X-Native behaviour table with sources — is in
[`AUDIT_2026-09-18_FIGMA_PARITY.md`](AUDIT_2026-09-18_FIGMA_PARITY.md); this
document is the what-changed / how-to-check companion.

---

## 1. "Why is the page name shown as the canvas frame name? If I delete the frame, the frame name still remains."

**What was happening.** Two separate chrome strings could land on the artboard:

1. The renderer drew a **name label for every frame, including the root of the
   render** — and on the canvas the root IS the page (`doc.pages[i]` and
   `editors[i].root` are the same object, cloned). So the page's name was painted
   at the canvas origin and nothing on the page could remove it: it belonged to
   the page, not to anything you could select and delete.
2. In demo mode, a second pass painted an **empty top-level frame's own name in
   28px `black/10` across the frame** (`frame_watermarks` / `watermark_shadows` /
   `watermark_labels` in `run.rs`). Delete the contents of a frame and the name
   stayed — literally the reported symptom.

**What changed.**

* The root of a render is never labelled, in **both** encoders
  (`crates/x-render/src/ir.rs`, `crates/x-render/src/scene.rs`): `!path.is_empty()`
  / `depth > 0`. On an export or a thumbnail the root is the exported object, and
  Figma does not put a name in the exported artwork either.
* Frames nested inside other frames are unlabelled (`in_frame`), matching Figma's
  "only the outermost frame title is shown"; a **Section** resets that rule
  (Figma: frame names stay visible in sections) and instance/master internals are
  silent.
* Names moved from *inside* the artwork (`14, 10`) to the **gutter above the
  frame's top-left corner** (`LABEL_ABOVE_Y = -26`), which is where Figma paints
  them, with one shared `LABEL_SIZE = 18.0` instead of three disagreeing sizes.
* The watermark pass is **deleted**, and `build_render_tree_bucket_shell` — the
  second lowering entry that existed only to disagree with the first about the
  root's label — is gone. `build_render_tree_with_hidden` is now the single entry
  used by the canvas buckets, the exports and the previews.
* Exports stay name-free for every format: `crates/x-native/src/export.rs` strips
  any `/label` Glyphs command, and the new assertion in
  `build_render_tree_of_renders_subtree_at_origin` pins that an exported subtree
  carries no `/label` at all.

## 2. "Why is the page name used for renaming pages? The pages are not getting deleted properly."

**What was happening.** The page and its root frame are one object each side of a
pair (`doc.pages[i]`, `editors[i].root`), and the rename guard compared the
FRAME's name while writing the PAGE's. Two implementations of "delete page"
existed (the rail's ✕ and the page menu); the rail's selected the page first and
then deleted "the active page", and its trash was only painted on *inactive* rows —
so ✕ on a background page stole the selection before deleting anything, and the
page you were looking at could not be deleted at all. Past the fourth page there
was no row either: the list collapsed into a `+N more` sentinel whose index was
the page COUNT, i.e. an out-of-range entry that could not be selected, renamed or
deleted.

**What changed.**

* `App::commit_page_rename` writes `doc.pages[i].name` and mirrors it onto the
  root frame; the guard now compares the PAGE's name, so "the page already says
  this" is what refuses a rename. **Why both sides**: the page list is a derived
  view. `OpenDoc::snapshot` — called by every `checkpoint`, i.e. at every
  transaction boundary — calls `sync()`, which rebuilds `doc.pages` from the
  editors' roots, so writing only one of the two copies loses the name at the next
  transaction (the CI run caught exactly that in this pass's own fixture). The
  durable fix for the model is to stop keeping two copies; until then, every
  rename writes both and the *editor root* is the source of truth.
* `App::delete_page(i)` is the single delete: it removes the clicked page, never
  the last one, clamps the active index, drops that page's comments and shifts the
  rest. Both the rail's ✕ and the page menu call it.
* The rail's ✕ is painted on any hovered row (the active one included) and its hit
  zone is registered **after** the row's `SelectPage`, so the reverse scanner finds
  the ✕ first.
* `App::pages_rows` windows the list over `PAGES_MAX_ROWS = 4` rows (shared with
  `pages_band_bottom`); every page therefore has a row at some scroll position and
  is selectable, renamable and deletable.

## 3. "Double-clicking is not selecting the elements in the right panel, such as colors and the other boxes/components that we have created."

**What was happening.** Panel rows that *flip* a piece of state (the fill colour
swatch, the paint-library button, a component prop switch, the font-family row)
were dispatched twice by a double-click. The first press opened the popover, the
second reached it and hit the "a press outside closes me" rule, so the popover
appeared and vanished — which is what "it doesn't select" looks like. A
double-click in a numeric/hex field also re-seeded the buffer from the document
and threw away what had been typed.

**What changed.**

* `App::last_chrome` + `is_repeat_chrome_click` (350 ms, 4 px) and a repeat guard at
  the **top** of `Host::on_press`: a repeat press of a toggle-class row
  (`Action::is_toggle_row`, ~30 variants, audited against the enum) is counted
  once. Steppers (zoom, alignment, gap, duplicate) still repeat, and pressing a
  field you are already editing keeps your text.
* The two gestures that *are* double-clicks now exist, as in Figma:
  * **canvas**: double-click drills exactly one nesting level down
    (`Editor::drill_into`); ⌘/Ctrl-click still deep-selects in one press.
  * **Layers panel**: double-click a layer's NAME to rename it inline —
    `Action::LayerRename`, `FieldId::LayerName`, `App::layer_edit_id`,
    `App::begin_layer_rename`; Enter commits through the engine's undoable
    `rename_node`, Esc cancels without touching the document, and a single press
    still selects the row and arms the reorder drag.
  * **Pages list**: double-click a page's name to rename it (next to the page
    menu's Rename).
* Every one of these has a regression test that fails if the behaviour returns:
  `double_click_on_a_panel_toggle_counts_once`,
  `double_click_on_a_page_name_opens_its_rename_field`,
  `double_click_on_a_layer_name_renames_it`.

## 4. "First do research on how these functions work in Figma vs us"

Done, and it is in the audit document rather than this one:
`docs/AUDIT_2026-09-18_FIGMA_PARITY.md` §2 compares pages, canvas names, canvas
gestures, the panels and the visual language against Figma, with the sources
(Help Center *Select layers and objects*, *Create and manage pages*, *Explore
component properties*, the designilo "Hide frame name" write-up, and the Figma
forum threads on nested frame names, instance names, section titles in exports and
frame names in presentation mode). The load-bearing facts: double-click or Enter
selects **one nesting level** down (⌘/Ctrl selects the exact nested layer),
Shift-click adds and a second Shift-click removes, frame names are painted as
canvas chrome above only the outermost frames and never in an export, and in
sections frame names stay visible.

## 5. "We can make one build but we never reach stable."

The pass was re-read line by line after it was written (audit §5). Three defects in
the pass itself came out and are fixed:

1. `App::pages_rows` scrolled with `self.active` — the active **document**, not the
   active page (`OpenDoc::page`). On any document where the two differ, the band
   showed the wrong four rows, so the "every page is reachable" claim only held for
   pages 0–4. Now `doc_ref().page`, with
   `every_page_in_the_window_is_clickable_and_the_window_follows_the_page` pinning
   the window at the head, after one step, and clamped at the tail.
2. The band rect was read from `rows[0]`, which would panic the paint pass on an
   empty document (a state the app cannot reach — `editor_ref` requires one editor —
   so the guard is defensive only).
3. Two comments described rules the code no longer had (`is_toggle_row`'s
   "at the bottom of this file", and a stray line in the middle of the variant
   list). Reworded: in this codebase a stale comment is how the next pass gets
   something wrong.

### Verification actually executed here

| Check | Command | Result |
| --- | --- | --- |
| Static balance / string-and-comment-safe brace sweep over every changed file | `python /tmp/check.py` (this session's tooling) | all balanced; the one flagged file (`crates/x-format/src/tests_mod.rs`) is a pre-existing checker artifact, identical at HEAD |
| Variant audit (`Action`, `FieldId`) | `python /tmp/variant_audit.py` | 215/45 variants; **0** unresolved variant names |
| Design-sheet generators (incl. the git-clean check `scripts/check.sh` performs) | `SHEET_COMMIT=$STAMP node build_tokens.mjs && node build_audit.mjs && node extract_icons.mjs` | regenerated and committed; second run is byte-identical (fixed point) |
| Design sheet assertions | `node check.mjs` | **40 PASS, 0 FAIL** |
| Screen assertions | `node check_screens.mjs` | **20 PASS, 0 FAIL** |
| NaN-ordering guard | `rg 'partial_cmp\(.*\)\.unwrap\(' crates apps` | clean |
| Docs references | every `docs/*.md` named in Rust sources | all exist |

### Verified by the real gate (CI), not by inspection

This sandbox has no Rust toolchain and cannot install one — `static.rust-lang.org`
and `crates.io` are unreachable from it — so the repository's own
[`Fix` workflow](.github/workflows/fix.yml), which exists for exactly this case,
was started with a `[ci-fix]` commit. It ran `cargo fmt --all` (this tree had
**never** been through rustfmt; the formatting-only commit is
`f2123e3 "Apply cargo fmt to the workspace"`), re-ran the whole gate, and
published the log to this PR.

That log is where the pass's real defects were found — three of them in the tests,
one in the source:

| what failed | what it actually was | fix |
| --- | --- | --- |
| `cargo test` — 10 errors, `ir.rs` + `scene.rs` | `///` on a function *parameter* ("documentation comments cannot be applied to function parameters") | the `in_frame` text documents the function, not the parameter |
| `every_page_in_the_window_…` expected `[1,2,3,4]` | the window is `top = min(page, n − PAGES_MAX_ROWS)` = 2, so `[2,3,4,5]`: the active page is visible *and* the tail is aligned | expectation corrected, and the selected page is asserted to have a row |
| `page_delete_removes_the_clicked_page_…` saw `Some(SelectPage(0))` | the ✕ is a **hover** affordance (as in Figma) and its zone only exists for a hovered row, so the reverse scan found the row | the test hovers the row before painting |
| the same test then read `"Page 2"` where it wrote `"Detail"` | **a real property of the model**, not a test artefact: `OpenDoc::snapshot` (run by every `checkpoint`, including the one inside `delete_page`) calls `sync()`, which rebuilds `doc.pages` from the editors' roots. The page list is a *derived* view — the editor root is the source of truth, which is why `commit_page_rename` writes both | the fixture names both sides, like the app does |
| `a_frame_name_labels_…` pinned `/Hero/label` | a key is the node's PATH plus the slot, and the path carries ancestor names: `/Page 1/Hero/label` | assertion corrected |
| `golden_render_ir_matches_pinned_shape` | the stale hash, as documented | re-pinned to `0xcd250bfffae4f4a6`, the value that run printed, alongside `commands=51 (pinned 51)` |

The gate is now **green on this pull request**:

```
scripts/check.sh   pass   1m20s
```

which covers, in one run: `cargo fmt --check`, `cargo clippy --workspace
--all-targets` with the dead-code ratchet reported as **55 / ceiling 82** (the
watermark removal and the sentinel row are inside the budget), `cargo test
--workspace --locked`, the docs-reference check, the design-sheet
regenerate-and-diff, and the CLI smoke (`--version`, `--help`,
`theme audit` — both palettes WCAG AA — `lint --list-rules`, and the exit-2 usage
path). The only step that was skipped is `Fix`'s optional clippy autofix, by
design.

On your own machine the same claim is one command:

```
cd X-Native
bash scripts/check.sh
```

### Manual check-list for a build (each line is one of the complaints)

1. Open a file, delete every frame on the page: the canvas is empty — no name is
   left behind anywhere on the artboard.
2. Rename a page from the rail (right-click → Rename, or double-click its name):
   the PAGES row changes, the page's own canvas label was never there to change,
   and no other page's name moves.
3. Repeat with a page that is not the active one: the rename applies to the row
   you clicked.
4. Add six pages. Every page is reachable by clicking its row (the band windows);
   delete the 5th and the 6th — both go, the last page stays.
5. Click the ✕ on a *background* page: that page disappears and the page you were
   viewing stays on screen.
6. Select a frame, double-click the fill colour swatch in the right panel: the
   picker opens and stays open. Do it on a component prop switch: it ticks once,
   not twice.
7. Double-click a layer name in the Layers panel: an inline field opens with the
   name selected; Enter applies (⌘Z undoes), Esc cancels.
8. On the canvas, double-click a group inside a frame: the selection goes exactly
   one level deeper per double-click; ⌘-click jumps straight to the leaf.
9. Type a number into X, then click it again: your digits are still there.
10. Export a selection that contains frames: the PNG/SVG/PDF has no frame name
    printed on it.
