# Figma parity — what we claim, who owns it, and the test that proves it

This repo has one recurring failure mode: a decision gets taken twice, the two
copies drift, and the owner finds the drift by *looking at the screen* — a page
name painted over the artwork, a right-panel row that will not select, a status
line that is unreadable. Every fix in that pattern started with "which of the two
owners is right?".

So the rule is now mechanical instead of remembered:

1. **One owner per decision.** A design decision lives in exactly one place.
   `tools/design-sheet/guard.mjs` fails the gate when a hardcoded canvas colour
   appears in two files, when a new literal appears without a declared ceiling,
   or when the chrome asks for an icon the icon set does not have.
2. **A behaviour is a test, not a sentence.** Every Figma behaviour we claim
   below names the test that pins it, and the guard fails if that test no longer
   exists. A behaviour with no test is listed as *open*, never quietly dropped.
3. **A decision that is visual is checked on pixels.** `raster.rs` owns a
   tiny-skia sink, so canvas chrome is asserted by rasterizing it and reading the
   pixels back (no GPU, runs in the ordinary gate). See
   `canvas_pixels_name_the_outermost_frames_and_never_the_page`.

## 1. The owners

| decision | owner |
| --- | --- |
| the app's role palette (Graphite + Daylight), text/background/state colours | `tools/design-sheet/tokens.mjs` → `x-ui` → `every_role_named_here_is_a_role_the_palette_defines` |
| window chrome colours and row geometry (panels, dashboard, popovers) | `x-ui` roles + the ratchet in `apps/x-designer/src/bin/x_native_app/design_tokens_test.rs` |
| the canvas renderer's chrome: name labels, placeholders, board grids | `crates/x-render/src/ir.rs` (`LABEL_ABOVE_Y`, `LABEL_SIZE`, `label_ink()`) and the ceilings in `tools/design-sheet/guard.mjs` |
| which canvas name is painted at all | `ir.rs::child_in_frame` + the same walk in `crates/x-render/src/scene.rs` |
| the page payload vs the page list | `run.rs::commit_page_rename`, `App::delete_page`, `pages_rows` |

**Adding a Figma behaviour, start to finish:**

```
1. put the rule in its one owner (never at the call site);
2. write the test that pins it, named after the behaviour;
3. add the row below with the Figma URL and that test name;
4. node tools/design-sheet/guard.mjs   # fails if the row and the test disagree
```

## 2. What we say we copy from Figma

| behaviour | Figma source | our rule (owner) | pinned by |
| --- | --- | --- | --- |
| A click selects the top-level object; a double-click goes one level down; ⌘/Ctrl-click is the deep one-press select | [Select layers and objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects) | `selection.rs::top_level_ancestor`, `editor_core.rs::click_select` / `drill_into`, `run.rs::on_press` | `figma_click_selects_top_level_then_drills` |
| Shift-click adds a layer to the selection | [Select layers and objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects) | `editor_core.rs::click_select` (shift toggles membership) | `shift_click_adds_and_a_second_shift_click_removes_from_the_selection` |
| A second Shift-click on the same layer removes it again | [Select layers and objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects) | `editor_core.rs::click_select` | `shift_click_adds_and_a_second_shift_click_removes_from_the_selection` |
| A marquee drag on empty canvas answers with the page's top-level objects | [Selection marquee](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects) | `selection.rs::hit_test_rect(.., deep=false)`, `editor_core.rs::marquee` | `command_drag_marquee_reaches_nested_layers_while_a_plain_drag_stops_at_the_frame`, `a_plain_marquee_stops_at_the_page_top_level_and_the_deep_one_does_not` |
| Holding ⌘/Ctrl and dragging the marquee reaches layers nested inside a frame | [Selection marquee](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects) | `selection.rs::hit_test_rect(.., deep=true)`, `editor_core.rs::marquee_deep`, `Drag::Marquee { deep }` | `command_drag_marquee_reaches_nested_layers_while_a_plain_drag_stops_at_the_frame`, `a_plain_marquee_stops_at_the_page_top_level_and_the_deep_one_does_not` |
| **Select matching layers (⌥⌘A)**: the same layer — by name and place, not by size — in the page's other frames and groups, and only within the same Section | [Select matching objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects) | `editor_core.rs::find_matching_nodes` (name+structure, section-scoped), `Action::SelectMatching` | `select_matching_finds_the_same_layer_and_never_crosses_a_section`, `select_matching_never_crosses_a_section_boundary`, `option_command_a_selects_the_matching_layer_in_the_other_frame` |
| ⏎ selects one level down, ⇧⏎ the parent, ⇥/⇧⇥ the next/previous sibling — and the page is not a layer to walk up into | [Select layers and objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects) | `Action::SelectChild` / `SelectParent` / `SelectNextSibling` / `SelectPrevSibling` | `enter_tab_and_shift_enter_walk_the_layers_the_way_figma_documents` |
| An instance's internals carry no names | [Instance names are not displayed](https://forum.figma.com/t/why-isnt-the-name-of-an-instance-being-displayed/34665) | instance seeding sets `in_frame` | `slot_content_replaces_anchor_in_rendered_instance` |
| A **frame** name is canvas chrome and never part of an export, while a **Section's** title chip exports with the section | [Section titles export?](https://forum.figma.com/t/section-titles-are-exporting-as-part-of-the-image/13338) | `x-native/src/export.rs`: `/label` is stripped, `/pill` + `/chip` are kept | `export_strips_frame_names_and_keeps_a_sections_title_chip`, `t13_canvas_and_export_must_encode_the_same_fill_stack` |
| A Section's title is a **filled chip in the section's own colour** above its top-left corner — not a grey frame-style label — sized to the name it carries | [Show names of nested frames](https://forum.figma.com/t/show-names-of-nested-frames/41949) | `ir.rs::SECTION_PILL_*` + `section_pill_rect` (the one geometry rule), the Section arms of both encoders, `x_core::section_hue()` | `a_section_name_is_a_chip_sized_to_the_name`, `canvas_pixels_name_the_outermost_frames_and_never_the_page` |
| A frame carries its own **"Show name"** switch in the right sidebar's Layer section — the third and last gate on a frame label, after "not the root" and "not nested in a frame" | [Hide frame names in Figma](https://designilo.com/figma/how-to-hide-frame-name-in-figma/) | `Node::show_name`, the frame arms of `ir.rs` and `scene.rs`, `Action::ToggleShowName` (inspector, frames only), `Editor::set_show_name` | `a_frame_that_switches_its_name_off_emits_no_label`, `the_show_name_row_toggles_a_frame_name_undoably_and_only_for_frames`, `show_name_roundtrips_and_defaults_to_true_for_older_files` |
| A Group answers a marquee like any other layer — it has bounds; only a *click* passes through its empty area | [Select layers and objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects) | `selection.rs::hit_test_rect` (no Group exception), `hit_test` (a Group has no body) | `a_group_answers_a_marquee_like_any_other_layer` |
| A frame's name is chrome on the canvas: in the band above the frame, aligned to its left edge, never on the artwork | [Frame names on the canvas](https://designilo.com/figma/how-to-hide-frame-name-in-figma/) | `ir.rs::LABEL_ABOVE_Y`, `LABEL_SIZE` + the same constants in `scene.rs` | `a_frame_name_labels_the_gutter_above_it_and_never_the_root`, `canvas_pixels_name_the_outermost_frames_and_never_the_page` |
| Only a page's outermost frame is named; a frame nested in another frame is silent; a Section is always named and the frames inside it keep theirs | [Show names of nested frames](https://forum.figma.com/t/show-names-of-nested-frames/41949) | `ir.rs::child_in_frame` + `scene.rs` | `a_frame_name_labels_the_gutter_above_it_and_never_the_root`, `canvas_pixels_name_the_outermost_frames_and_never_the_page` |
| The page — the render root — is never named; its name lives in the page list | owner report, 2026-09-18 | `ir.rs` root guard (`!in_frame` is false for a root that has no parent), `scene.rs` | `canvas_pixels_name_the_outermost_frames_and_never_the_page`, `a_frame_name_labels_the_gutter_above_it_and_never_the_root` |
| A name is drawn in one colour, the same on the canvas and in an export, and fades only with the node's own opacity | owner report, 2026-09-18 (the 70%-cap drift) | `ir.rs::label_ink()`, the single owner for all four label sites | `canvas_pixels_name_the_outermost_frames_and_never_the_page` |
| The canvas name band and the page hit-zone are one geometry: the page's own top-left band, 26px above it, 18px tall | owner report, 2026-09-18 | `ir.rs::LABEL_ABOVE_Y` / `LABEL_SIZE`; the page band in `editor_ui.rs` | `every_page_in_the_window_is_clickable_and_the_window_follows_the_page` |
| Pages are a list in the left sidebar: click selects, double-click renames, the menu deletes | [Create and manage pages](https://help.figma.com/hc/en-us/articles/360038511293-Create-and-manage-pages) | `run.rs::pages_rows`, `commit_page_rename`, `App::delete_page` | `pages_add_switch_delete`, `double_click_on_a_page_name_opens_its_rename_field` |
| Renaming a page renames the page — never a frame | owner report, 2026-09-18 | `run.rs::commit_page_rename` (writes the list and the editor root) | `page_rename_names_the_page_and_mirrors_the_root`, `page_rename_survives_save_and_reload` |
| Deleting a page deletes the page that was aimed at; the last page is refused | [Create and manage pages](https://help.figma.com/hc/en-us/articles/360038511293-Create-and-manage-pages) | `run.rs::App::delete_page` | `page_delete_removes_the_clicked_page_and_never_the_last_one` |
| Every page is reachable in the list, however many there are (Figma scrolls its page list) | [Create and manage pages](https://help.figma.com/hc/en-us/articles/360038511293-Create-and-manage-pages) | `run.rs::pages_rows` + the `PAGES_MAX_ROWS` window | `pages_list_windows_beyond_four_pages_and_keeps_every_page_reachable`, `pages_past_the_fourth_are_selectable_and_deletable`, `every_page_in_the_window_is_clickable_and_the_window_follows_the_page` |
| Page edits, comments and page reordering are one undo history | owner report, 2026-09-18 | `x-editor` history | `document_history_orders_page_edits_comments_and_reordering` |
| A double-click on a panel row acts once: the popover the first press opened is not shut by the second | [Component properties](https://help.figma.com/hc/en-us/articles/5579474826519-Explore-component-properties) | `run.rs::App::is_repeat_chrome_click` (350 ms / 4 px) | `double_click_on_a_panel_toggle_counts_once` |
| Double-clicking a name renames it where it is written (page rows, layer rows) | [Create and manage pages](https://help.figma.com/hc/en-us/articles/360038511293-Create-and-manage-pages) | `FieldId::LayerName`, `Action::LayerRename` | `double_click_on_a_layer_name_renames_it`, `double_click_on_a_page_name_opens_its_rename_field` |
| A panel row's height and its hit zone are the same box, so a click cannot land in a gap | owner report, 2026-09-18 | `editor_ui.rs` row geometry | `app_row_heights_are_the_component_layers` |
| Clicking inside the text field you are already editing moves the caret; it does not re-open the field and throw the typed buffer away | owner report, 2026-09-18 | `run.rs::on_press` returns from the in-editor caret branch before any re-seed | `pressing_inside_the_open_text_field_keeps_what_was_typed` |

## 3. Open — claimed, or fixed, but not pinned yet

The list is the point: an unpinned claim is visible instead of implied, and the
guard counts it.

| behaviour | Figma source | our rule (owner) | pinned by |
| --- | --- | --- | --- |

| Frame names are not drawn in presentation mode | [Show frame name in prototype](https://forum.figma.com/suggest-a-feature-11/show-frame-name-in-prototype-32523) | not built: there is no presentation mode yet — the preview chrome is a device frame only | open |
| A status message is readable on the canvas background, not painted as a red bar through the artwork | owner report, 2026-09-18 | `run.rs::status`, `editor_ui.rs` status row | open |

## 4. Running it

```
node tools/design-sheet/guard.mjs          # 6 checks: ceilings, one owner, icons, parity
node tools/design-sheet/check.mjs          # the sheet's own assertions (jsdom-free)
node tools/design-sheet/check_screens.mjs  # the screen assertions (needs jsdom)
bash scripts/check.sh                      # the gate: all of the above plus fmt, clippy, tests, docs
```

`scripts/check.sh` runs the guard, so a duplicated canvas colour, an unknown icon
name, or a parity row whose test was renamed fails a push instead of reaching the
owner's screen.

The gate cannot see the screen, so the *visual* half of the design system runs as
its own CI job, `Screenshots (software Vulkan)`: it installs lavapipe (Mesa's
software Vulkan driver), runs the six `#[ignore]`d GPU/screenshot tests, and
uploads the PNGs they write (`apps/x-designer/screenshots`, plus the loading
previews the job tells `loading_screen_visuals` to write with
`X_NATIVE_LOADING_PREVIEW_DIR`) as the `screenshots` artifact. A design
regression is then a picture in the run, not a sentence in a report.
