# Audit Claim Review — X-Native vs Figma audit (2026-09-17) — REV. 2

**Scope.** The submitted "X-Native vs Figma Design — Feature-by-Feature Audit" was checked
claim-by-claim against the actual repository at **HEAD `9bc3d4c`** (branch `arena/01a0ab04-x-native`),
via exhaustive source search across all 9 crates under `X-Native/crates/`.

**Rev. 2 correction (important).** Rev. 1 wrongly *confirmed* the audit's "no PNG/PDF export"
finding — because it, like the audit, only searched `crates/x-format/`. Raster export lives in
**`crates/x-render/`** and is surfaced through `x-native`. Verdict corrected below: the audit's
Critical finding #2 is **false**, making it **3 of 4 critical findings false** for this tree.

**Rev. 3 (superseded in part — see `CANVAS_DASHBOARD_UI_AUDIT_2026-09-17.md`).** Rev. 1/2 also
searched only `crates/` and missed the application layer `apps/x-designer` (37.5k lines). There
the nav rail **does** exist and is fully wired at HEAD (panel switching, ⌥1–5, Agents panel,
variable creation in the Tokens panel) — the submitted audit's finding #1 was substantially
right for its (still-absent) commit `bc46c9f`. The export finding remains false even in the app.

**Headline.** The audit cannot be used as-is before "the fixes." It cites commit `bc46c9f`,
which **does not exist** in this repository's history. Three of its four "critical findings"
describe code that exists and is tested here; the fourth (font browser) is real. Its overall
"~65% of Figma's surface" framing materially undersells the engine layer.

---

## 1. The four "critical findings" — re-verified (Rev. 2)

| # | Audit claim | Verdict | Evidence in this tree |
|---|---|---|---|
| 🔴1 | Nav rail with 5 tabs (File, Agents, Assets, Tools, Variables); `app.nav_tab` read in exactly one place; tabs decorative | **FALSE — UI does not exist here** | `grep -rn nav_tab crates/` → **0 hits**. No `"File"/"Agents"/"Tools"/"Variables"` tab labels anywhere; `x-ui/src/` = components, containers, design_system, status_bar, theme — no nav rail module. You cannot "wire the tabs" — there are no tabs to wire. |
| 🔴2 | No PNG/PDF export; "confirmed absent from crates/x-format/"; "a designer cannot hand off a raster asset today" | **FALSE — checked the wrong crate** | `x-render/src/raster.rs`: full CPU rasterizer — `export_raster` / `export_raster_cancellable` (@1x/@2x/@3x scale), `encode_png`, `encode_rgba_png`, `encode_jpg` (quality knob), `optimize_png`/`optimize_images`; doc comment: *"This is the backend for Figma's 'Export' surface"*. `x-render/src/sinks.rs`: `export_pdf`, `export_pdf_with_assets`, `export_pdf_full`. `x-native/src/export.rs`: unified `prepare_export` (selection scope, frame-name stripping, text outlining — explicitly "for every export format (PNG / SVG / PDF / clipboard image)"). All re-exported via `x-native/src/lib.rs` and exercised by tests (`html_export.rs`, `mask_semantics.rs:240`, `text_export_parity.rs:157`). PNG **import** also exists (`x-format/png_import.rs`). |
| 🔴3 | No library publish flow; "receive-only" | **FALSE** | `x-core/src/library.rs` implements the full lifecycle: `library_from_parts()` (doc: *"The 'publish' half of the library lifecycle"*, line 158), `diff_library()` (272), `accept_update()` (323), `refresh_library_masters()` (350), `freeze_unverified()` (388), plus `publish_tests` (195). |
| 🟡4 | No font browser UI | **TRUE (gap narrowing)** | No picker/browser UI in `x-editor`/`x-ui`. But the backend exists: `x-text/src/font.rs` — `family_names()`, `find_family()` (scored fuzzy match), `resolve_font_name()`, `load_system_fonts()`. **New in this session:** `family_of_face()` / `group_families()` / `FontManager::families()` added (family→faces grouping for a browser UI). |

## 2. Claims that are **wrong in the other direction** (we're better than audited)

- **PNG / JPG / PDF export** — all implemented and wired (see finding #2). The audit's Tier-1
  item #1 is already done.
- **Sketch**: audit says Sketch import missing. Reality: `x-format/src/sketch.rs` has both
  `import_sketch()` / `import_sketch_with_report()` (1077, 1082) **and** `export_sketch()` (314).
- **Prototype triggers**: audit says hover/delay/back triggers "author but don't fire in preview".
  Reality: the player in `x-editor/src/prototype.rs` has `fire_action()`, `hit_overlay()`,
  `Player::arm_delays()`, `Player::click()` — delay arms and actions fire. Treat debt #6 as
  **stale until proven otherwise at runtime**.
- **Variables**: audit scores 30% ("engine yes, no creation UI at all"). The model is deep
  (collections, aliases, exposed-to-viewers, 4 mode table types, active mode) with authoring
  primitives (`set`, `set_mode`, `catalog`) AND a live binding pipeline (`parametric.rs`:
  resize⇄variable write-back, one undoable step). **New in this session:** undoable authoring
  commands (`x-editor/src/variable_commands.rs`) close the history gap. What remains missing is
  only the visual panel itself.
- **MCP server**: confirmed real (`x-native/src/mcp.rs`).
- **`.fig` import**: confirmed — real Kiwi parser (`x-format/src/kiwi.rs`, `figbinary.rs`) with
  fixture (`tests/fixtures/OpenFigs.fig`).
- **`.x` plain-JSON format**: confirmed (`serialize.rs::save_x`, `v2.rs::save_x_v2`,
  `deserialize.rs::save_x_file`).

## 3. Scorecard rows — engine-level verification

| Audit claim | Verdict | Evidence |
|---|---|---|
| Corner smoothing / squircle | ✅ CONFIRMED | `x-core/src/node.rs`, `x-render/src/scene.rs`, serialize/deserialize |
| Shape builder | ✅ CONFIRMED | `x-editor/src/shape_builder.rs` |
| Vector networks | ✅ CONFIRMED (model) | `x-core/src/node.rs`, `x-editor/src/vector_edit.rs` |
| Auto layout incl. grid | ✅ CONFIRMED (engine) | `x-core/src/auto_layout.rs`, `x-components/src/layout.rs` |
| SmartAnimate | ✅ CONFIRMED | `x-core/src/smart_animate.rs` |
| Overlays, conditionals, easing (prototype model) | ✅ CONFIRMED | `x-core/src/prototype.rs` (`Trigger::{OnClick,OnHover,OnPress,OnDrag,AfterDelay,video}`, `Action::{OpenOverlay,SwapOverlay,CloseOverlay}`, nested `Cond`) |
| Fills/gradients/patterns/blend modes/image fills | ✅ CONFIRMED (model) | `x-core/src/paint.rs`, `node.rs` |
| Variables ~30% | ⬆️ UNDERSCORED — engine + bindings + (now) undoable authoring | `x-core/src/variables.rs`, `x-editor/src/parametric.rs`, **new** `x-editor/src/variable_commands.rs` |
| Import/export ~65%, "no PNG/PDF" | ⬆️ UNDERSCORED — SVG, PNG, JPG, PDF, Sketch (both ways), JSX/Tailwind, CSS/Swift/Compose/XML codegen, `.x`, `.fig` in | `x-format/*`, `x-render/raster.rs`, `x-render/sinks.rs`, `x-native/export.rs` |
| Comments (pins, resolve) | 🟡 PARTIAL — model exists, **no threads** | `x-core/src/document.rs:183` `struct Comment {id,page,x,y,author,text,resolved}`; flat list — no thread/parent/reply field |
| Components + variants + instances | ✅ CONFIRMED | `x-components/src/model.rs`; `count_instances()` in library.rs |
| Component **slots** missing | ✅ TRUE | only a planning comment (`x-components/src/lib.rs:9`); no slot mechanism |
| Component descriptions missing | ✅ TRUE | no `description` field in component model |
| Multiplayer 0% | ✅ TRUE | precise grep → 0 hits |
| Branching 0% (as feature) | ✅ TRUE | "branch" hits are prototype `Cond` branches only |
| HTML/CSS export | 🟡 PARTIAL | JSX + Tailwind (`codegen.rs`), CSS/Swift/Compose/XML via `devmode.rs`; not a standalone HTML exporter |
| Device frames absent | ✅ TRUE | 0 hits |

**Unverifiable from this tree:** "Tour the interface" rows (toolbar, canvas bg, keyboard nav,
nudge values, actions menu, hide-UI) — there is no application shell in this tree to inspect
(`x-ui` is a widget library; `x-editor` is headless logic). Neither confirmed nor refuted.

## 4. Overall verdict on the audit

1. **Provenance broken**: checked against `bc46c9f`, a commit that doesn't exist here (HEAD is
   `9bc3d4c`). The audit describes a different tree than the one fixes will land on.
2. **3 of 4 critical findings are false here** (nav rail / export / publish); the fourth (font
   browser) is real but its backend just got completed.
3. **The engine-level picture is far stronger than ~65%**: export formats, variables, prototype
   runtime, and libraries are all substantially implemented. The genuinely missing pieces this
   tree confirms: **comment threads, component slots/descriptions, device frames, multiplayer,
   and the visual panels themselves** (variables panel, font browser) — there is no app shell in
   this repo at all, which is the context the audit never states.
4. **Real Tier-1 for THIS tree (revised)**: (a) Variables *panel* — data, commands, and history
   now all exist behind `x-editor::variable_commands`; (b) font browser UI — backend complete
   behind `x_text::FontManager::families()`; (c) comment threads (schema change); (d) component
   slots + descriptions (schema change).

## 5. New code landed with this review (this session)

- `X-Native/crates/x-editor/src/variable_commands.rs` (+ lib wiring): undoable variable
  authoring — `VariableCommand`, `apply_variable`/`invert_variable`, `VariableHistory`
  (commit/undo/redo, bounded, clear-redo-on-commit), snapshot constructors
  (`set_number/set_color/set_string/set_bool/set_alias/set_collection/set_exposed/
  set_active_mode/set_mode_value/remove_*`), `VarValue`, 9 inline tests covering create/undo/
  redo, mode overrides, alias resolution, type moves, exact-restore deletes, collection
  normalization, redo-clearing, and batch application.
- `X-Native/crates/x-text/src/font.rs` (+ tests): `family_of_face()`, `group_families()`,
  `FontManager::families()` — the font-browser listing backend.

*Every verdict above is reproducible with the cited paths/greps. Rev. 1 superseded.*
