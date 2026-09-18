# Figma parity — the contract, and how it is enforced (2026-09-18)

Two questions from the owner, in one message:

> *"can we not design the design properly so we will not get design errors"*
> *"the function is not proper working like how they behave in figma"*

Both are the same problem. Until now the design decisions and the Figma behaviours
lived in prose, in comments and in whoever's memory was freshest — so every phase
re-found one of them as a *bug report*, fixed it at the one site the report named,
and left the other sites alone. The fix for a decision that has two owners is not a
better memory; it is a check that fails when a second owner appears.

That check is `tools/design-sheet/guard.mjs`, and `scripts/check.sh` runs it on
every push, next to the design-sheet regeneration. It is dependency-free (node:fs
only) so a bare CI runner can run it, unlike the two jsdom sheets.

## 1. One owner per decision, enforced

A decision that appears twice will drift. Three examples from this repository, all
of them shipped:

| decision | how many owners it had | what drifted |
| --- | --- | --- |
| the name-label point size | three (two encoders, two arms) | 14px, 18px and 20px in the same canvas |
| the name-label offset | two | one encoder drew the label inside the artwork, the other above it |
| the name-label ink | four (2 × `ir.rs`, 2 × `scene.rs`) | the scene's Frame arm faded a name to 70% while the other three sites did not, so the same frame's name was a different grey on the canvas than in an export |

The guard now reads the renderer's production source and fails when **one colour
literal appears in two files** — the mechanical form of "one owner". The label ink
is one function, `crates/x-render/src/ir.rs::label_ink()`, called from both encoders
and both arms; the offset and size are `LABEL_ABOVE_Y` / `LABEL_SIZE` in the same
file.

A second ratchet bounds the literals that remain, per file, like
`DEAD_CODE_CEILING` in `scripts/check.sh`:

```
fallbacks.rs 2/2, node.rs 3/3, ir.rs 1/1, raster.rs 1/1, stress.rs 2/2
```

The first run of the guard found two more duplicated decisions in the engine, both
older than this pass and neither reported by anyone: the **missing-asset grey** was
written out at three sites (`Node::image`'s default fill, the Vello scene sink, and
the tiny-skia raster sink — whose comment promised it "matches the Vello sink"), and
the **pattern fallback grey** at two (`Variables::flat_color` and the renderer's
brush resolution). Both now live once, in `crates/x-core/src/fallbacks.rs`.

The numbers only go down. A deliberate new literal raises a ceiling in a diff a
reviewer can see; an accidental one fails the gate.

The application chrome has had exactly this ratchet since the Daylight pass
(`apps/x-designer/src/bin/x_native_app/design_tokens_test.rs` — raw colours, corner
radii and icon sizes per painted file, with ink roles). This closes the same loop
for the canvas renderer, which is where the owner's complaints keep landing.

## 2. The behaviours we claim to copy from Figma

Every row says which Figma behaviour we are copying, where it is decided in *our*
code, and the test that pins it. Rows with no test say so — that is the point of
the table: an unpinned claim is visible instead of implied.

| behaviour | Figma source | our rule (owner) | pinned by |
| --- | --- | --- | --- |
| A frame's name is chrome: in the gutter above the frame, aligned to its left edge, never on the artwork | [Frame name on canvas](https://designilo.com/figma/how-to-hide-frame-name-in-figma/) · [Show names of nested frames](https://forum.figma.com/t/show-names-of-nested-frames/41949) | `crates/x-render/src/ir.rs` `LABEL_ABOVE_Y`, `LABEL_SIZE`, `label_ink()` | `a_frame_name_labels_the_gutter_above_it_and_never_the_root`, `canvas_pixels_name_the_outermost_frames_and_never_the_page` |
| Only a page's outermost frame is named; a frame nested inside another frame is silent | [Show names of nested frames](https://forum.figma.com/t/show-names-of-nested-frames/41949) · [Option to hide frame labels](https://forum.figma.com/t/option-to-hide-frame-labels/10420) | `ir.rs::child_in_frame`, `scene.rs` same rule | `a_frame_name_labels_the_gutter_above_it_and_never_the_root`, `canvas_pixels_name_the_outermost_frames_and_never_the_page` |
| A Section always shows its own name, and frames *inside* a Section keep theirs | [Option to hide frame labels](https://forum.figma.com/t/option-to-hide-frame-labels/10420) | the Section arms + the `in_frame` reset in both encoders | `a_frame_name_labels_the_gutter_above_it_and_never_the_root` |
| The page — the render root — is never named; the page's name lives in the pages list | owner report, 2026-09-18 | `!path.is_empty()` in both encoders | `canvas_pixels_name_the_outermost_frames_and_never_the_page`, `t13_canvas_and_export_must_encode_the_same_fill_stack` |
| A name is canvas chrome and is not part of an export | [Section titles export?](https://forum.figma.com/t/section-titles-are-exporting-as-part-of-the-image/13338) | the export path drops `/label` glyph commands (`x-native/src/export.rs`) | `t13_canvas_and_export_must_encode_the_same_fill_stack` |
| Canvas and reference lowering agree: a name is one decision, not two | our own invariant | `crates/x-render/src/frame_cache.rs`, `LABEL_*` constants | `nested_master_is_available_in_every_bucket_and_painted_once` |
| An instance's internals carry no names | [Instance names are not displayed](https://forum.figma.com/t/why-isnt-the-name-of-an-instance-being-displayed/34665) | instance seeding sets `in_frame` | `slot_content_replaces_anchor_in_rendered_instance` |
| Pages are a list in the left sidebar: click selects, double-click renames, the menu deletes | [Create and manage pages](https://help.figma.com/hc/en-us/articles/360038511293-Create-and-manage-pages) | `run.rs` `pages_rows`, `commit_page_rename`, `App::delete_page` | `pages_add_switch_delete`, `every_page_in_the_window_is_clickable_and_the_window_follows_the_page`, `double_click_on_a_page_name_opens_its_rename_field` |
| Renaming a page renames the page — never a frame | owner report, 2026-09-18 | `commit_page_rename` (writes both copies: the list is derived from the editor roots) | `page_rename_names_the_page_and_mirrors_the_root`, `page_rename_survives_save_and_reload` |
| Deleting a page deletes the page that was aimed at; the last page is refused | [Create and manage pages](https://help.figma.com/hc/en-us/articles/360038511293-Create-and-manage-pages) | `App::delete_page` | `page_delete_removes_the_clicked_page_and_never_the_last_one` |
| Every page is reachable in the list, however many there are | our own invariant (Figma scrolls its page list) | `pages_rows` + `PAGES_MAX_ROWS` windowing | `pages_list_windows_beyond_four_pages_and_keeps_every_page_reachable`, `pages_past_the_fourth_are_selectable_and_deletable` |
| Page edits, comments and reordering are one undo history | our own invariant | `x-editor` history | `document_history_orders_page_edits_comments_and_reordering` |
| Double-click selects one level of nesting down; repeat to go deeper | [Select layers and objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects) | `drill_into` / `click_select` | `figma_click_selects_top_level_then_drills` |
| ⌘/Ctrl-click deep-selects the leaf in one press | [Select layers and objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects) | `deep_click = app.ctrl` | `figma_click_selects_top_level_then_drills` |
| A double-click on a panel row acts once: the popover it opens is not shut by the second press | [Component properties](https://help.figma.com/hc/en-us/articles/5579474826519-Explore-component-properties) | `App::is_repeat_chrome_click` in `on_press` | `double_click_on_a_panel_toggle_counts_once` |
| Double-clicking a name renames it where it is written (Layers panel, panel property rows) | [Create and manage pages](https://help.figma.com/hc/en-us/articles/360038511293-Create-and-manage-pages) · [Component properties](https://help.figma.com/hc/en-us/articles/5579474826519-Explore-component-properties) | `FieldId::LayerName`, `Action::LayerRename` | `double_click_on_a_layer_name_renames_it` |
| Clicking a layer name in the Layers panel selects that layer | [Select layers and objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects) | the Layers tree rows | `section_selection_wraps_labels_and_ungroups` |

## 3. Open — claimed, not yet pinned (or not yet built)

The guard counts these rows and prints the number, so the list cannot quietly
shrink by deletion. Closing one means adding the test that pins it, or the code.

| behaviour | status |
| --- | --- |
| Re-opening a text field you are already editing keeps what you typed | fixed in `run.rs` (the press re-seeds the buffer only for a *different* field); **no test pins it yet** |
| Shift-click adds to, and second shift-click removes from, the selection | not implemented |
| ⌘-drag marquee selects nested layers | not implemented |
| Select matching layers (⌥⌘A) | not implemented |
| Per-frame "Show name" checkbox (Figma's right-sidebar Layer section) | not implemented; our rule is the two rules above |
| Frame names are hidden in presentation mode | no presentation mode |
| A Section's title is a filled pill in the section's own colour, not a grey label | our difference, deliberate for now: one label style for frames and sections |

## 4. Running it

```
node tools/design-sheet/guard.mjs          # 7 checks: literals, owners, icons, parity
bash scripts/check.sh                      # the same checks inside the gate
```

A failing canvas literal prints the file and the value; a failing parity row prints
the test name it could not find.

The gate cannot see the screen, so the *visual* half runs as its own CI job,
`Screenshots (software Vulkan)`: it installs lavapipe (Mesa's software Vulkan
driver), runs the six `#[ignore]`d GPU/screenshot tests, and uploads the PNGs the
fixtures write (`apps/x-designer/screenshots`, plus the loading previews the job
tells `loading_screen_visuals` to write with `X_NATIVE_LOADING_PREVIEW_DIR`) as the
`screenshots` artifact. A design regression is then a picture in the run, not a
sentence in a report. Three of the fixtures render the canvas, the inspector and
the board; `gpu_target.rs` pins the render-target contract they run on.
