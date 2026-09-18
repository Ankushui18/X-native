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
| A new layer joins the container you DRAW IT IN — the deepest visible, unlocked frame or section under the point the drag started from (a nested frame beats its parent; a group or an instance never captures) | [Frames in Figma Design](https://help.figma.com/hc/en-us/articles/360041539473-Frames-in-Figma-Design) (*"Click inside an existing frame to add a 100 x 100 nested frame"*), [Shape tools](https://help.figma.com/hc/en-us/articles/360040450133-Shape-tools) | `run.rs::container_under` + `finish_create` | `a_shape_drawn_over_a_frame_joins_that_frame`, `the_deepest_container_wins_and_a_group_does_not_capture`, `a_hidden_or_locked_frame_does_not_take_the_shape` |
| Space while dragging prevents nesting: the new layer stays on the page even when it is drawn over a frame | [Figma tip](https://twitter.com/figmadesign/status/1229872874325831680) (*"To prevent an object from being nested, hold the Spacebar while dragging"*) | `run.rs::finish_create` reads `space_pan` | `holding_space_while_drawing_keeps_the_shape_on_the_page` |
| Shape-tool modifiers: ⇧ constrains to a square/circle and ⌥ draws from the centre, and the pending shape shows its size while dragging | [Shape tools](https://help.figma.com/hc/en-us/articles/360040450133-Shape-tools) | `state.rs::create_rect` is the ONE rule the live preview (`editor_ui.rs`) and `finish_create` share | `shape_tool_modifiers_build_the_rect_the_preview_shows` |
| The **Scale tool (K)** — `K` selects it, `V`/`Esc` go back to Move — resizes proportionally and takes the layer's own distances with it — stroke weight, corner radius, text size, effect offsets and auto-layout padding/gap — and a locked layer is refused | [Scale layers while maintaining proportions](https://help.figma.com/hc/en-us/articles/360040451453-Scale-layers-while-maintaining-proportions) | `Tool::Scale` + `state::scale_drag_factor` / `scaled_box` (one rule for the drag preview and the commit); `Editor::scale_nodes_about` (one undo step) | `the_scale_tool_grows_a_layer_from_the_corner_you_are_not_holding`, `scale_tool_takes_text_effects_and_layout_with_it` |
| A scale is uniform and pinned to the corner you are NOT holding, and a multi-layer selection scales against ONE combined box | [Scale layers while maintaining proportions](https://help.figma.com/hc/en-us/articles/360040451453-Scale-layers-while-maintaining-proportions) | `Editor::scale_nodes_about(parts, factor)` — the anchor is the fixed point of the mapping, so it never moves; nested ids are never scaled twice | `scale_about_an_anchor_pins_it_and_is_one_undo_step` |
| **⌥⌘G (Frame selection)** wraps the selection in a new Frame sized to the members' collective bounds, works with a single layer, and keeps their positions | [Frames in Figma Design](https://help.figma.com/hc/en-us/articles/360041539473-Frames-in-Figma-Design) | `CtxCmd::FrameSelection` → `Editor::frame_selection` → `Command::FrameSelection` (`wrap_selection` builds the AABB and re-offsets the members) | `option_command_g_wraps_the_selection_in_a_frame_like_figma`, `frame_selection_wraps_and_is_undoable`, `frame_selection_wraps_single_node` |
| The **Pencil tool (⇧P)** draws freehand — "Click and drag on the canvas to sketch" — "with a round 3px stroke weight", and it "stays active until you select another tool or press Esc" | [Sketch on the canvas with the pencil tool](https://help.figma.com/hc/en-us/articles/4402723791511-Sketch-on-the-canvas-with-the-pencil-tool) | `Tool::Pencil` + `freehand_path` (RDP simplify, then a Catmull-Rom pass) turns the sampled stroke into editable curves: one insert is one undo step, the ink and weight are one source for the preview and the node, and the stroke joins the frame it was drawn in | `the_pencil_draws_a_smoothed_stroke`, `samples_become_smooth_cubics`, `the_wobble_a_bigger_eps_cannot_see_is_dropped`, `two_points_are_a_path_and_fewer_are_not` |
| The **Slice tool (S)** draws an export region: "a specific region of the screen for export, even if it's not organized into a single group", and with Contents Only off "anything that overlaps the slice will be exported" | [Using the Slice Tool](https://help.figma.com/hc/en-us/articles/360040028394-Using-the-Slice-Tool), [Export from Figma Design](https://help.figma.com/hc/en-us/articles/360040028114-Export-from-Figma-Design) | `Tool::Slice` + `NodeKind::Slice`: the editor draws the region dashed with its name, and `prepare_export` builds the region's tree through `x_render::ir::build_render_tree_slice` — one slice per export, an empty slice still exporting its size, and a mixed selection refusing to guess | `the_slice_tool_draws_an_export_region`, `a_slice_exports_the_content_inside_its_bounds` |
| **Present** starts a presentation of the file's prototype, and a presentation paints the artwork alone — no frame names, no section chips, no canvas chrome at all | [Figma Design for beginners](https://help.figma.com/hc/en-us/sections/30880632542743) (the toolbar's Present) · [Show frame name in prototype](https://forum.figma.com/suggest-a-feature-11/show-frame-name-in-prototype-32523) | `FrameCache::set_presenting` + `ir::strip_canvas_chrome`; the → `Action::FlowEnter` control and `run.rs::canvas_scene` | `the_header_play_button_presents_the_prototype`, `a_presentation_strips_the_canvas_chrome_and_keeps_the_artwork`, `presenting_invalidates_the_cached_scene` |
| A layer row carries Figma's eye and padlock: they appear on the row you hover, stay while the state is on, and a locked layer stops answering the canvas | [Figma Design for beginners](https://help.figma.com/hc/en-us/sections/30880632542743) · [Figma interface — basic information](https://firmbee.com/figma-interface-basic-information-figma-for-beginners-2) | `editor_ui.rs` row toggles (`Action::TreeVisible` / `Action::TreeLock`), `x-editor::hit_test` | `a_layer_row_hides_and_locks_the_layer_like_figmas_eye_and_padlock` |
| A status message gets a row of its own: the chrome reserves the window's bottom band for it, no danger fill is painted in the chrome, and the flow viewer paints no band at all | owner report, 2026-09-18 | `state.rs::status_band` (the one rect) + `paints_status_band`, `run.rs::paint_feedback` (the one painter) | `the_status_band_is_chrome_and_the_artwork_stops_above_it`, `the_status_band_carries_the_running_jobs_controls`, `the_flow_viewer_paints_no_status_band_over_the_prototype` |

## 3. Open — claimed, or fixed, but not pinned yet

The list is the point: an unpinned claim is visible instead of implied, and the
guard counts it.

| behaviour | Figma source | our rule (owner) | pinned by |
| --- | --- | --- | --- |

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
