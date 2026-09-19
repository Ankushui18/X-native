# Owner report — six defects from the 2026‑09‑18 review

What was reported, what the source actually does, and what changed. Every claim
below is anchored to a file:line in this tree; nothing here is inferred from a
screenshot.

| # | Reported | Verdict |
|---|----------|---------|
| 1 | Frame / SVG name stays after the frame is deleted | **Root-caused & fixed** — the left panel was rendering a hardcoded array, not the document |
| 2 | Left layers panel does not open/close like Figma | **Fixed** — the chevron was unreachable (the row rect swallowed it) |
| 3 | Dark mode has 3 styles | **Checked** — three palettes, all AA; the *menu row* was the bug (see §5) |
| 4 | Design broken in most places | **Measured** — numbers in §6; the structural checks are green after the change |
| 5 | Right-click + drag shows at a different position | **Fixed** — the marquee was drawn in world coordinates, and right-drag had no gesture at all |
| 6 | Help text shows once, then never again | **Fixed** — the welcome card was gated by an on-disk marker with no way back |

---

## 1 + 2 — The layers panel was a mock, not the document

`OpenDoc::demo_doc()` seeded `mock_layers` with an eleven-row *fictional* list
(`Board`, `order-details`, `pay-row`, `Vector` …) and `editor_ui::paint_left`
rendered that array **instead of the real tree** whenever it was non-empty:

```rust
// before
if !app.doc().mock_layers.is_empty() {
    let mocks = app.doc().mock_layers.clone();   // ← hardcoded rows
    …
    hit.push((r, Action::TreeRow(format!("mock:{mi}"))));
} else {
    let (rows, total_h) = collect_tree_rows(app, scroll, tree_bottom - tree_top);
```

Consequences that match the report exactly:

* deleting a frame (or an imported SVG's row) on the canvas left its **name in
  the panel** — the panel was not reading the document at all;
* clicking a row selected *nothing* (the code comment admitted it: "selection is
  purely visual … independent of the document");
* the chevrons toggled `mock.expanded`, never `doc.expanded`, so open/close did
  not behave like Figma's tree.

**Fix.** The mock list is gone: `MockLayer`, `demo_layers()`, the `mock_layers`
field and every `"mock:"` branch were removed from `state.rs`, `run.rs`,
`editor_ui.rs` and the tests. The panel now always renders `collect_tree_rows`
over the live document, so a deleted node leaves the panel in the same frame
its row is removed from the canvas, and `doc.expanded` (the real per-node
disclosure state) is the only expansion model.

**Chevron fix.** In the real tree the disclosure triangle sat *inside* the row
rect but was registered **before** it, and hit zones are resolved in reverse
(`app.hit.iter().rev()` — most specific last), so the row always won and the
triangle never worked. The chevron now registers after the row:

```rust
hit.push((r, Action::TreeRow(row.id.clone())));
if let Some(cr) = chevron {
    hit.push((cr, Action::TreeToggle(row.id.clone())));
}
```

## 5 — Right-click + drag

Two defects, one gesture:

* **The band was drawn in the wrong space.** `Drag::Marquee` stores *world*
  corners (`screen_to_world` on press/move, and `marquee()` hit-tests them in
  world space on release), but the paint pass drew them raw — so the rubber band
  appeared somewhere other than the cursor as soon as the canvas was panned or
  zoomed. It now goes through `world_to_screen`, exactly like the sibling
  `VectorLasso` band two lines below:

```rust
let a = app.world_to_screen(*start);
let b = app.world_to_screen(*cur);
```

* **A right-drag had no meaning.** `MouseButton::Right` only ever called
  `on_right_press`, so the menu stayed where the press happened while the
  pointer travelled. Figma's gesture is now implemented: a right **click**
  (≤4 px of travel) opens the context menu; a right **drag** dismisses it and
  marquees, committing on release through the same path a left drag uses
  (`Host::right_drag_move`, wired into `CursorMoved` / `MouseInput`).

## 6 — The help text that appears once

`dashboard::paint_first_launch` returned early forever once
`~/.config/x-native/onboarding-complete` existed, and `Action::OnboardingDismiss`
was the only thing that could write it — there was **no way to re-open the
guide**, in any menu, palette or shortcut. It is now on demand:

* `Action::ShowWelcome` + `App::welcome_open`;
* **Help ▸ Welcome & shortcuts** in the app menu (`?`);
* the same command in ⌘K (`Help: welcome & shortcuts`);
* the first-launch card still appears on a fresh install and its buttons still
  mark onboarding complete — it simply is reachable afterwards.

## 3 — "Dark mode has 3 styles": checked

There are exactly three palettes (`ThemeId` in `crates/x-ui/src/theme.rs`):
Graphite (dark, default), Daylight (light), High Contrast (dark). Measured from
the regenerated `tokens.json`:

* **every** text role × surface pair passes WCAG AA in **all three** palettes
  (0 failing pairs out of 8 roles × 6 surfaces each);
* label-on-fill pairs: on-accent 5.39 / 8.42 / 14.67, on-danger 5.44 / 5.44 / 10.27;
* two of the three are dark by construction (backgrounds `#090909`, `#000000`,
  versus Daylight's `#EEF0F4`).

The defect was in the *menu*: one row labelled **"Dark mode"** whose handler ran
`active_theme().next()` — a **cycle**, so from Graphite a click meant to darken
the app landed on **Daylight**, and a third click landed on High Contrast. The
row is now three named rows (with a ✓ on the active one) routed to
`Action::SetTheme`, matching what ⌘K already offered.

## 4 — "Design broken in most places": what is measured

Re-ran the project's own tooling against the changed tree:

* `tools/design-sheet/check.mjs` — **39/39 PASS**
* `tools/design-sheet/check_screens.mjs` — **20/20 PASS** (26 screens,
  1 377 boxes inside their panels)
* `build_tokens.mjs` / `build_audit.mjs` / `extract_icons.mjs` re-run; the
  regenerated artifacts are in this commit so the CI "generators changed" gate
  cannot fire.
* Spacing audit after the fix: **701 offsets, 335 on the ladder = 47.8 %**
  (editor_ui 531, dashboard 129, board_ui 21, loading 20) — i.e. the same
  "roughly half the paint offsets are off-ladder" figure the previous audit
  reported, now two literals lighter because the mock tree is gone.
* Dead tokens are unchanged and still real: `T16`, `R_FULL`, `ICON_XL`, six
  spacing steps, `STROKE_ICON` have zero call sites in `tokens.json` usage.

## Verification limits (please read)

This sandbox has **no Rust toolchain and no way to install one** (rustup,
static.rust-lang.org, crates.io and index.crates.io are all unreachable; `cargo`
/`rustc`/`rustup` are absent). I therefore could not compile, run the binary, or
run `cargo test`. What I did instead:

* re-read every edited region and checked brace/bracket/paren balance against
  `HEAD` for all five files (identical before and after);
* re-ran the jsdom design-sheet suites (above) which parse the same sources the
  app ships;
* kept the change surface to one behaviour per fix.

**Still unverified:** the Canvas side of item 1. Frame and Section labels are
painted by the *node itself* (`crates/x-render/src/scene.rs` Frame/Section arms
and the `{key}/label` Glyphs command in `ir.rs`), the frame cache mixes the
node's name into its subtree hash (`frame_cache.rs`), and `delete_selection`
removes the node from the tree — so a deleted frame cannot paint its own label
in this code. If a ghost label still reproduces after this build, the repro
(screenshot or exact gesture) would let me find the remaining path quickly.

## Cross-reference to `BUG_FIX_PLAN.md` (QA-001…QA-018)

* **QA-007 "Pages vs. Layers hierarchy issue"** — the plan's note ("the presence
  of `mock_layers` suggests the UI may be rendering mock data instead of actual
  document structure") was right; this change removes the mock entirely.
* **QA-004 "Frame name not visible in the viewport"** — already fixed in the
  tree (`scene.rs` Frame arm, "QA-004 FIX"): frames paint their name like
  Sections, and the frame-cache hash mixes the name in so a rename re-renders.
* **QA-014 "Theme toggle not propagating to canvas background/grid"** — the
  pixel grid is painted from the *user's* `grid_color` (editor data, correctly
  theme-independent); the ruler ticks are still the raw `0x666666` literal at
  `theme.rs:265`, which is the one canvas-chrome color that does not follow the
  palette. Small, but it is a real leftover.
* Everything else in that plan (clipboard, close-file, undo/redo scene sync,
  pen tool, pages ids, shadows, right-tab double click, selection handles) is
  untouched by this change set.

## Not done on purpose

* **Node disclosure still defaults to collapsed.** Figma shows children when a
  container is created; changing the default would invalidate the existing
  editor_ui tests (`collapsed containers hide their children`) and is a
  behaviour decision, not a bug fix. One line when you want it.
* **`ThemeId::next()` still cycles through High Contrast** on the ⌘⇧-style
  "flip the UI" shortcut. That is a documented cycle; the menu no longer hides
  behind it.
