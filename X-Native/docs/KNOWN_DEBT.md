# Known debt

What this repository knowingly leaves open, and what it costs. Everything here
is either measured by a command in the tree or gated by a ratchet in
`scripts/check.sh` — no folklore.

If you fix one of these, delete its entry and lower the relevant ceiling.

## 1. Dead code (ratcheted: `DEAD_CODE_CEILING`, currently 76)

`cargo clippy --workspace --all-targets` reports warnings that are *not*
errors, and `scripts/check.sh` fails if the count grows past the ceiling above.
Everything else (correctness, suspicious, `unsafe_code`, `unused_must_use`,
`dbg_macro`, `todo`) is denied in `[workspace.lints]`, so the pile below is the
only noise the gate tolerates.

Where it lives (measured 12 Sep 2026, `--message-format short`):

| Count | File | Why it is still there |
|---|---|---|
| 32 | `apps/x-designer/src/bin/x_native_app/context_menu.rs` | `render_context_menu()` builds a display list (`ContextPaintCommand`) that no painter consumes — the live right-click menu is `editor_ui::paint_context_menu()`. Either port the renderer onto the command list (it is easier to test) or delete the module's paint half. |
| 18 | `apps/x-designer/src/bin/x_native_app/command.rs` | The command-palette view layer (`XNativeApp::command_palette` and friends) from an earlier chrome iteration; `CommandPalette`/`CommandCategory` logic *is* used, the painter is not. |
| 8 | `apps/x-designer/src/bin/x_native_app/theme.rs` | Role aliases no live widget calls yet (`C_ACCENT_*`, state colors). They exist so the next panel does not hand-type a hex; delete when a call site appears, not before. |
| 7 | `crates/x-ui/src/components.rs` | Builder structs (`ButtonBuilder`, `TabBuilder`, …) that paint without reading their own fields back. Half-finished widget-kit API. |
| 6 | `apps/x-designer/src/bin/x_native_app/state.rs` | Action variants (`NewBoard`, `Inspect`, `Text`, …) the palette/keyboard paths no longer route through. |
| 3 | `apps/x-designer/src/bin/x_native_app/chrome.rs` | Legacy `XNativeApp` chrome struct, kept because its command-palette layout code is the reference for the rewritten panel. |
| 1 | `crates/x-format/src/serialize.rs` | `style_json` — superseded by `x_core`'s serializer, retained as the format's fallback encoder. |
| 1 | `apps/x-designer/src/bin/x_native_app/run.rs` | Helper awaiting its call site. |

## 2. `.fig` is read, never written

`crates/x-format/src/kiwi.rs` decodes the kiwi container and
`encode_message` can re-emit a message, but a *document* → `.fig` writer needs
the full schema (glyph tables, image encoding, variable mode blobs) plus a
node-key allocator. `encode_message` is `pub(crate)` with `#[allow(dead_code)]`
so the encoder does not rot while this is unimplemented. Import works
(`x_native import-fig file.fig out.x`); export is `.x`, SVG, HTML/CSS, JSX.

## 3. UI themes: painted, not persisted

`x_native::ui::ColorTokens` holds three audited palettes (Graphite, Daylight,
High Contrast) and the app switches between them (TOKENS panel button,
command palette, `Action::SetTheme`/`CycleTheme`), remapping every chrome color
at paint time through `theme::resolve`. Still open:

- the choice is not written to disk, so a restart returns to Graphite;
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

## 10. Figma parity: deferred sub-features

The reconciliation pass (2026-09-15, `arena/01a0a37b-x-native`) wired or
verified the headline features from the Figma Design help center — text
properties (typed fields, renderer, exports, Code panel), stroke caps /
joins / dashes / alignment, auto-layout min-max + grid flows, prototype
triggers (`AfterDelay`, `OnDrag`, `KeyDown`, multi-action). Still open, by
choice, each needing a real design pass rather than a patch:

- Drop/inner shadow **spread** and per-property blur (Figma has x/y blur).
- Stroke **weight distribution** (independent per-side widths).
- **Video layers** (fills + `WhenVideoHits` + GIF playback in the player).
- Rich-run styling beyond size/color/font/weight/italic (per-run case,
  decoration, bullets); underline details panel (style/thickness/offset).
- **Text on a path** and vertical CJK writing modes.

When one ships, delete its line here and extend the matching test module.
