# Known debt

What this repository knowingly leaves open, and what it costs. Everything here
is either measured by a command in the tree or gated by a ratchet in
`scripts/check.sh` — no folklore.

If you fix one of these, delete its entry and lower the relevant ceiling.

## 1. Dead code (ratcheted: `DEAD_CODE_CEILING`, currently 82)

`cargo clippy --workspace --all-targets` reports warnings that are *not*
errors, and `scripts/check.sh` fails if the count grows past the ceiling above.
Everything else (correctness, suspicious, `unsafe_code`, `unused_must_use`,
`dbg_macro`, `todo`) is denied in `[workspace.lints]`, so the pile below is the
only noise the gate tolerates.

Where it lives (measured 16 Sep 2026, `--message-format short`, every item named
— the gate prints this list itself when the ratchet trips):

Reproduce the number instead of trusting this file. Both filters matter: the
first drops clippy's per-crate summary lines (such as
"warning: `x-ui` (lib) generated 7 warnings"), which would otherwise be counted
as items, and the second is the
dead-code rule `scripts/check.sh:55` applies.

```sh
cargo clippy --workspace --all-targets --message-format short 2>&1 \
  | grep -E '\.rs:[0-9]+:[0-9]+: (warning|error)' \
  | grep -cE 'never (used|read|constructed)'   # → 82
```

Swap `-c` for nothing and you get the list below. If your count differs from 82,
this table is stale — fix the table and the ceiling together, never one alone.

| Count | File | Why it is still there |
|---|---|---|
| 32 | `apps/x-designer/src/bin/x_native_app/context_menu.rs` | `render_context_menu()` builds a display list (`ContextPaintCommand`) that no painter consumes — the live right-click menu is `editor_ui::paint_context_menu()`. Either port the renderer onto the command list (it is easier to test) or delete the module's paint half. |
| 18 | `apps/x-designer/src/bin/x_native_app/command.rs` | The command-palette view layer (`XNativeApp::command_palette` and friends) from an earlier chrome iteration; `CommandPalette`/`CommandCategory` logic *is* used, the painter is not. |
| 9 | `apps/x-designer/src/bin/x_native_app/theme.rs` | Role aliases no live widget calls yet — `C_BASE`, `C_RAISED`, `C_EDGE`, `C_ACCENT_MUTED`, `C_ON_ACCENT`, `C_FAINT`, `R_XS`, plus the `argb`/`argba` hex helpers. They exist so the next panel does not hand-type a hex; delete when a call site appears, not before. (`R_XS` is the one added since the previous measurement.) |
| 9 | `apps/x-designer/src/bin/x_native_app/state.rs` | Vocabulary ahead of its UI, item by item: `Tool::shortcut()` and `NavTab::shortcut()` (nothing renders shortcut hints yet); `Action`'s unreachable variants — 20 have a handler and no dispatch site, listed in `FIGMA_CREATE_DESIGNS_COMPARISON.md` §9; `FieldId::{TextAlign, TextAlignVertical, TextDecoration, TextTruncation, ListStyle, TextWrapStyle}` (the text inspector's paragraph block); `NotificationKind::{OfflineStatus, ComponentUpdate}` and `Notification.timestamp`; the `start` field of two drag-state variants; and `App::{sidebar_resizing, left_sidebar_width, symmetry_axis}` — written and never read, which is the same reason `Action::ResizeLeftSidebar` is unreachable. |
| 7 | `crates/x-ui/src/components.rs` | Builder structs (`ButtonBuilder`, `TabBuilder`, …) that paint without reading their own fields back. Half-finished widget-kit API. |
| 3 | `apps/x-designer/src/bin/x_native_app/editor_ui.rs` | `proto_action_label`, `proto_action_type_label`, `proto_animation_label` — label builders for the prototype inspector's action-type and animation pickers, which are not built (`Action::ProtoActionType`, `ProtoAnimation` and `ProtoDest` all have handlers and no dispatch site). Same family as `proto_targets`, which the panel does call. |
| 3 | `apps/x-designer/src/bin/x_native_app/chrome.rs` | Legacy `XNativeApp` chrome struct, kept because its command-palette layout code is the reference for the rewritten panel. |
| 1 | `crates/x-format/src/serialize.rs` | `style_json` — superseded by `x_core`'s serializer, retained as the format's fallback encoder. |

### Why the ceiling moved 76 → 82 (16 Sep 2026)

Upward, which is the opposite of what a ratchet is for, so it is worth being
exact about what happened. The 76 was measured on 12 Sep. The tree then stopped
compiling — `x-editor` called three `Editor` methods that existed nowhere — and a
workspace that does not build produces **no dead-code diagnostics at all**, so
from that moment the number was not measurable, only remembered. Everything
merged in between was never counted. The first gate run that could see the whole
workspace again reported 84.

This branch is net-negative on the pile: it deleted 1,027 lines of orphan files
(`x-core/p0_features.rs`, `x-render/vector_network.rs`), 32 unreachable `Action`
variants, 8 phantom types, and the write-only `extra_y` in the prototype panel
(−2 warnings, hence 82 rather than 84). Deleting the variants did not lower the
count further because rustc groups unused variants **per enum** — one warning
covers all twenty — so removing variants shrinks a warning, not the tally.

The `run.rs` row is gone rather than grown: its single entry ("helper awaiting
its call site") was the unused `id` in `Action::SetGradientType`, which is now an
`is_none()` guard.

## 2. `.fig` is read, never written

`crates/x-format/src/kiwi.rs` decodes the kiwi container and
`encode_message` can re-emit a message, but a *document* → `.fig` writer needs
the full schema (glyph tables, image encoding, variable mode blobs) plus a
node-key allocator. `encode_message` is `pub(crate)` with `#[allow(dead_code)]`
so the encoder does not rot while this is unimplemented. Import works
(`x_native import-fig file.fig out.x`); export is `.x`, SVG, HTML/CSS, JSX.

## 3. UI themes: two audited palettes, persisted

`x_native::ui::ColorTokens` holds two audited palettes (Graphite, Daylight) and
the app switches between them (TOKENS panel button, command palette,
`Action::SetTheme`/`CycleTheme`), remapping every chrome color at paint time
through `theme::resolve`. The choice is written to `~/.config/x-native/theme`
as a slug and read back at startup (`theme::persist_theme` /
`load_persisted_theme`); a slug nothing parses — including the retired
`high-contrast` one — falls back to Graphite. Still open:

- the right-click menu's *unwired* renderer (§1) carries its own `u32` palette
  derived from the roles — consistent today, but dead code;
- content colors (artwork, smart guides, watermarks, avatars) are
  deliberately **not** theme-mapped: a UI theme switch must never repaint what
  the user drew.

## 4. The duplicate `OverrideValue` / `ComponentProp` pairs still diverge

Fixed: a component color property bound to `target_property: "stroke"` now
writes `OverrideValue::Stroke`, so it paints the stroke of the bound node
instead of recoloring its interior (the variant exists on both copies —
`crates/x-core/src/components.rs`, `crates/x-components/src/model.rs`). What is
left of this entry:

- `x-components`' copy of the enum has no `Number` variant, so a `"num:..."`
  override decodes to `None` there and the instance-layout pass drops it,
  while `x-core`'s applier honours it — by writing `node.w`, whatever the
  property's `target_property` says (`"height"`, `"radius"` and `"opacity"`
  number properties are all stored as the same `num:` string and land on the
  width). Deciding what `Number` means per target property comes first; the
  duplicate can be collapsed after that.
- `x-components`' `ComponentProp` (the shape the app's property panel and
  `ComponentPropEntry` use) has no `Color` variant, so color properties are
  reachable only through `Editor::set_prop_value` and the `.x` format.
- Sketch export (`crates/x-format/src/sketch.rs`) maps text / fill / swap /
  opacity overrides; a `stroke:` override is dropped on that path.

## 5. Deliberately not ported from OpenPencil

Decided while matching their feature surface, each with a reason:

- **in-app AI chat** — we keep the MCP server (`x_native mcp`) as the agent
  surface instead of shipping a BYOK key store in a design file editor;
- **P2P WebRTC collaboration** — needs signalling infrastructure we do not run;
- **HTML/CSS → document import** — our export is one-way;
- **XPath queries** — `find`'s filters (`--type/--name/--under/--min-w/…`)
  cover the use cases without a path grammar.

## 6. Preview-only prototype semantics

`hover` / `delay` / `navigate back` are authored and drawn as flow arrows, and
the preview plays `onClick` navigation, but pointer-enter/leave events are not
fired in the preview. The data model carries them; the player ignores them.

## 7. Font subsetting: TrueType only

`crates/x-text/src/subset.rs` rewrites `glyf` outlines. A CFF/OTF font is
detected and reported, and the export falls back to copying the whole font
(`x_native export-html --fonts` prints the fallback in its report). Writing a
CFF charstring subsetting path is the missing piece.

## 8. Crate metadata drifts (needs a product decision)

`x-board` says `0.1.0`, most crates `0.34.0`, `x-components` `0.40.0`; only
`x-board/Cargo.toml` declares `license = "MIT"` and there is **no `LICENSE`
file** at the root. `[workspace.package]` therefore carries no version or
license: consolidating them is a legal + release decision, not a cleanup.
Suggested default: `version.workspace = true` at the tip's number, and
`license = "MIT OR Apache-2.0"` (Rust ecosystem convention) with both texts
committed — confirm before anyone publishes a crate.

## 9. CI is a file, not a badge

`.github/workflows/ci.yml` and `scripts/check.sh` are in-tree and the script is
the single source of the gate, but this working copy has no reachable remote, so
no badge currently runs. Push the branch and the pipeline is live; until then
`scripts/check.sh` is the honest claim, and `docs/VERIFICATION.md` records what
was actually run locally.

## 10. Style definitions are not undoable

Undo lives per editor (`Editor::undo_stack` of `Command`s,
`crates/x-editor/src/editor_core.rs`), and `Document.styles` — the
text/paint/effect style registry — is not part of any `Command`. Applying or
detaching a style *is* undoable (the consumers are mutated through
`Editor::mutate_visual_stack`), but editing a definition is not: undoing the
app's "Update style" restores every consumer's old values while the registry
still holds the new ones, so the next re-resolve writes them back. Propagation
is also N undo steps (one per consumer), not one batched step — `Command::Group`
exists and is unused here. The fix is to snapshot the registry into the same
step, or to move the registry behind the editor; until then the behaviour that
*does* hold is pinned by
`text_styles_create_apply_update_and_detach_end_to_end` in
`apps/x-designer/src/bin/x_native_app/regression_tests.rs`.

## 11. Two row heights, three panels and six empty states are off the contract

The component contract (`crates/x-ui/src/contract.rs`) and the screen contract
(`crates/x-ui/src/screens.rs`) count what the cross-screen pass (P0-5) still
owes, as four ratchets the gate enforces — the registry and the count have to
agree, so neither can be edited alone:

| Ratchet | Value | What it is |
|---|---|---|
| `OFF_STANDARD_SURFACES` | 3 | FLOW, SHIP and UX ANALYSIS own property rows that are not on the control-height scale. |
| `OFF_STANDARD_COMPONENTS` | 2 | The 22px layer-tree row (should be 24) and the 32px dropdown row (should be 28). |
| `SILENT_EMPTY_STATES` | 6 | Surfaces that can be empty and say nothing: drafts, STRUCTURE, TOKENS, the SHIP code panel, notifications, the board canvas. |
| `MIGRATED_TO_X_UI` | 0 | Components whose painter lives in `x-ui`. Every widget is still painted by the designer's chrome. |
| `DISABLEABLE_COMPONENTS` | 1 | Components that can be unavailable. Only the square icon button can be dimmed; every other control is drawn as always-actionable. |

What it costs: a tree row and a dropdown row are 2px and 4px off the rows they
sit between, so a panel that mixes them is visibly uneven, and a surface that
can be empty without saying so leaves the user looking for a control that is
not there — the failure mode P0-4 and P0-10 were written to remove. The widget
painters being in the app is not itself a bug; it is why the same component can
drift apart in two places, which the contract now catches but cannot prevent.

One question the contract surfaced, recorded here so it is answered on purpose:
a hovered **row** is painted `surface_elevated` (`C_ROW_HOVER`), the same role a
resting **field** uses (`C_FIELD`), while the state language says hover is
`surface_hover` — as inputs already do. Either a row hover is its own wash step
or the contract needs a second hover entry.
