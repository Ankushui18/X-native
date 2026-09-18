# Owner report — two themes, Daylight colour, the left rail

What was asked, what the source actually did, and what changed. Every claim
below is anchored to a file:line in this tree (or to a measured contrast ratio
computed from `tools/design-sheet/tokens.json`, which is generated from the
crate and the app — not copied by hand).

| # | Asked | Verdict |
|---|-------|---------|
| 1 | "Remove Balck mode we just need graphite and day mode" | **Done** — High Contrast is deleted, not hidden: 2 palettes in the crate, the menu, the palette, the CLI and the sheet; not reachable even through a stale settings file |
| 2 | "for day mode has some color issue" | **Root-caused & fixed** — the palette itself is AA-clean; the bugs were 12 *fill × ink* mismatches that only read correctly on a dark surface (worst: 1.09:1) |
| 3 | "the left pannel has design issue to many thing is not properly in there place check all the text is in center" | **Fixed** — LIBRARY/TOKENS were painting over the nav rail *and* under the layer tree; every label/glyph in the rail now derives its placement from the row it lives in |

---

## 1 — High Contrast is gone; two palettes ship

`ThemeId` (`crates/x-ui/src/theme.rs`) had three variants, and the third one was
reachable from six places. All of it is deleted:

| Where | Before | Now |
|---|---|---|
| `crates/x-ui/src/theme.rs` | `HighContrast` variant, `ALL: [ThemeId; 3]`, `label`/`slug`/`parse`/`next` arms | 2 variants, `ALL: [Graphite, Daylight]` (`theme.rs:34`), both cycles flip dark ↔ light |
| `crates/x-ui/src/design_system.rs` | `ColorTokens::HIGH_CONTRAST`, `for_theme` arm, `high_contrast()` ctors, `DesignSystem::high_contrast` field, `From<&DesignSystem> for Theme` arm | all removed; `for_theme` matches two variants (`design_system.rs:187`) |
| `crates/x-ui/src/lib.rs` | `Theme::high_contrast()`, `Theme.high_contrast` field | removed; `Theme::flipped` doc now says "the two shipped palettes, nothing else" |
| context menu (`editor_ui.rs:1653-1667`) | rows 12/13/14 = Graphite / Daylight / High Contrast | two theme rows; the Welcome row behind them is index **15** (`run.rs:9460-9466`) |
| command palette (`run.rs:6370-6385`) | "Theme: High Contrast" verb + gate entry | verb gone; the two remaining verbs stay |
| CLI / docs / sheet | `--theme high-contrast`, `hc` swatch, three-palette prose | `x_native theme audit --help`, README, DESIGN_SYSTEM, CLI, KNOWN_DEBT §3 and the design sheet all state two palettes; `tokens.css` only carries `data-theme=graphite|daylight` |

**What a user with an old settings file sees.** `~/.config/x-native/theme` is
read at startup (`apps/…/theme.rs:77 load_persisted_theme` → `state.rs:2053`).
`ThemeId::parse("high-contrast")` — slug *or* the old `"High Contrast"` label —
now returns `None`, the loader returns `None`, and the app keeps its Graphite
default (`theme.rs:418-419` pins that with a test). Nothing has to be cleaned up
by hand: the next theme switch rewrites the file with a live slug.

**Guards.** `theme.rs:402` asserts `ThemeId::ALL.len() == 2`; `parse` rejects
the retired slug; `check.mjs` fails the build if a retired palette reappears in
`tokens.json` ("two themes offered", "the sheet ships no retired palette —
graphite, daylight"); `design_tokens_test.rs` keeps `C_ACCENT`-family tokens out
of ink slots (the High Contrast palette was the reason that ratchet existed).
A repo-wide grep for `HighContrast`/`high_contrast` finds no Rust code — only
three "retired" comments, the negative test, and the historical owner report
from the previous pass.

## 2 — Daylight: the palette was fine, the pairings were not

`ThemeId::Graphite.palette().contrast_audit()` and the Daylight one are both
empty, *before* and after: every text role passes AA against every surface it
can be painted on (Daylight `text_primary` on `surface` = 16.85:1). So the
"colour issue" was never a bad token — it was chrome that picked a *fill* and an
*ink* which only agree on a dark surface. Twelve sites; measured ratios,
Graphite / Daylight:

| Site (file:line) | Fill | Ink before → after | Before (G/D) | After (G/D) |
|---|---|---|---|---|
| Dashboard template rows, quick card (`dashboard.rs:120,743`) | accent wash (`accent` @ 51) | `C_ON_ACCENT` → `C_ACCENT_INK` | 14.12 / **1.42** | 6.52 / 6.49 |
| Toolbar active tool (`editor_ui.rs:6324`) | `C_TEXT` (inverted chip) | black literal → `C_BG` | 18.94 / **1.25** | 17.96 / 14.76 |
| Eyedropper armed (`editor_ui.rs:5743`) | `C_SEL` | `C_TEXT` → `C_ON_ACCENT` | 3.95 / **2.00** | 4.38 / 8.42 |
| Paint-library open (`editor_ui.rs:5760`) | `C_SEL` | `C_ACCENT_INK` → `C_ON_ACCENT` | 2.02 / **1.09** | 4.38 / 8.42 |
| Library dropdown bound row (`editor_ui.rs:6224`) | `C_SEL` → **`C_SEL_WASH`** | `C_TEXT` | 3.95 / **2.00** | 11.32 / 10.66 |
| Marquee size badge (`editor_ui.rs:6392+`) | `C_SEL` → **`C_ACCENT`** | `C_TEXT` → `C_ON_ACCENT` | 3.95 / **2.00** | 5.39 / 8.42 |
| "Reply" pill (`editor_ui.rs:7427`) | `C_FIELD_2` | `C_SEL` → `C_ACCENT_INK` | **3.45** / 7.92 | 6.97 / 8.65 |
| "Post" pill (`editor_ui.rs:7488-7490`) | hover `C_SEL` → `C_FIELD_2` | `C_SEL` → `C_ACCENT_INK` | **3.85** / 8.42 | 7.78 / 9.20 |
| Comment thread state label (`editor_ui.rs:7267`) | panel | `C_SEL` → `C_ACCENT_INK` | **3.85** / 8.42 | 7.78 / 9.20 |
| Slot clear ✕, hovered (`editor_ui.rs:4895`) | `C_LINE_2` | `C_DIM` → `C_TEXT` | 3.83 / **2.90** | 9.78 / 8.02 |
| Tokens "Generate variables…" (`editor_ui.rs:8753`) | hover `C_LINE_2` | `C_MUTED` (2.9:1 glyph, but the button did nothing) | — | hover now only repaints when there is something to extract |
| Fonts / LIBRARIES rows (`editor_ui.rs:8573,8645-8649`) | none | row label boxes recentred (§3) | — | — |

The rule the fixes follow is the one already written down in
`docs/DESIGN_SYSTEM.md §Ink`: a **wash** takes `C_ACCENT_INK`, a **solid accent
fill** takes `C_ON_ACCENT`, a **hover wash** takes `C_FIELD_2`, and a *selected /
pressed* chip is a solid accent, not a wash. Two Graphite-only failures
(3.45:1 and 3.83:1 labels) got fixed on the way through.

**Left as-is, deliberately:** the dashboard's free-badge icon
(`C_SUCCESS` on `C_SUCCESS_WASH`) is 4.15:1 in the worst Daylight composite —
above the 3:1 glyph floor, below the 4.5:1 body-text floor it does not have to
meet at 12px. Everything else the sheet's ratchets measure is inside its
ceiling (0 raw colour literals added; the whole change is role-to-role).

## 3 — The left rail: one band at a time, everything on the row's centre

### 3.1 The structural bug

`paint_left` called the LIBRARY and TOKENS bands as *overlays*
(`git show HEAD:…/editor_ui.rs` line 2198-2202):

```rust
if app.doc().left_tab == LeftTab::Assets { paint_assets(app, s, hit, y0 + 108.0, lw); }
```

Two things were wrong with that. The bands were given `lw` and no `sx`, so they
painted at **absolute x = 12** — over the 48px nav rail, and 48px narrower than
the dock (their right-hand column, including the NEW VARIABLE grid, ran off the
panel edge). And because the call sat *before* the pages/layers code, the PAGES
list, the LAYERS header and the whole layer tree were painted **on top of them**
— two panels in one rectangle.

Now the tab selects the band and returns:

```rust
let y = y0 + 120.5;                       // PAGES label top 156.5
match app.doc().left_tab {
    LeftTab::Assets => { paint_assets(app, s, hit, y, sx, lw); return; }
    LeftTab::Tokens => { paint_tokens(app, s, hit, y, sx, lw); return; }
    LeftTab::Layers => {}
}
```

Both painters take `(app, s, hit, y0, sx, lw)`, start at `x0 = sx + 12.0`
(`editor_ui.rs:8557, 8673`) and use the dock's own right edge (`lw - 12.0`), so
the NEW VARIABLE 2×2 grid is `((lw − 12) − x0 − 4) / 2` = 120px per cell inside
a 268px dock instead of 166px (which overflowed by ~48px).

### 3.2 Centring

The rail placed labels and glyphs by hand-computed offsets, and a third of them
were off the middle of the row they sit in. `paint.rs` now owns the arithmetic:

```rust
pub fn centre_in(size: f64, height: f64) -> f64 { (height - size) / 2.0 }
pub fn line_top(r: Rect, size: f64) -> f64 { r.y0 + centre_in(size * CSS_LH, r.height()) } // text
pub fn glyph_top(r: Rect, size: f64) -> f64 { r.y0 + centre_in(size, r.height()) }        // a glyph has no line box
```

and 53 call sites in `editor_ui.rs` use them. What actually moved (HEAD → now):

| Element | Before | Now | Row |
|---|---|---|---|
| DRAFTS glyph | `(sx+16, y0+16)` | `(sx+14, y0+14)` | 16px box (glyph was on its bottom-right quarter) |
| DRAFTS label | `y0+13.3` | `y0+12.5` | same box, 15px line box |
| File-name text | `ny` (top edge) | `ny+0.5` | 23.5px row, 16.5px line box |
| Draft dot | `ny+8.3` | `ny+8.75` | row centre |
| Rename pencil | `ny+2.3` | `ny+2.75` | 12px glyph in the 23.5px row |
| PAGES `+` | `(addp.x0, y+0.8)` | `(addp.x0+1, y+1.5)` | 14×15 button |
| Page row label | `r.y0+5.2` | `r.y0+4.75` | 26px row, 16.5px line box |
| Page thumbnail glyph | `(sx+21, r.y0+7)` | `(sx+19, r.y0+7)` | 22×18 thumbnail (2px right of centre) |
| Page trash glyph | `(tr.x0, r.y0+6)` | `(tr.x0+3, r.y0+7)` | 18×16 button |
| LAYERS label | `ly` | `line_top(hrow, T10)` = `ly−2.5` | shares a centre line with the two 16px buttons beside it |
| LAYERS search / collapse glyphs | `(lw−25, ly)` / `(lw−43, ly)` | `(lw−26, ly−1)` / `(lw−44, ly−1)` | 16px hover buttons |
| Tree-search text | `sr.y0+6.5` | `sr.y0+3.75` | 24px field, 16.5px line box |
| Tree-search clear ✕ | `(clr.x0+2, clr.y0+2)` | `(clr.x0+1, clr.y0+4)` | 14×20 button |
| Find & replace overlay | search icon `+5`, query `+4`, count `+5`, chevrons `(x0,+2)`, close `(+4,+4)`, Replace `+3`, Replace-all `+3`, Aa `+0` | `+4`, `+2.75`, `+3.5`, `(+3,+3)`, `(+2,+2)`, `+1.5`, `+1.5`, `+0.25` | each control's own box |
| LIBRARY rows (FONTS / LIBRARIES) | `row_t+3.0` | `row_t+2.5` | 20px row, 15px line box |
| TOKENS rows + swatch | text `+3.0`, swatch `+1.0`, count `+1.6` | text `+2.5`, swatch `+1.5`, count rides the hex baseline | 20px row |
| Tree rows (structure) | glyphs `r.y0+5`, label `(22−16.5)/2` inline | derived from the row / the 18px hover buttons | 22px row |

`paint::centring_tests` pins the arithmetic that the rail depends on (a 12px
glyph in a 22px row at +5; a T11 line box at +2.75; glyph and label landing on
the same centre line; the 18px thumbnail and its glyph).

---

## 4 — Verification, and what is *not* verified

Ran in this tree (X-Native/):

```
node tools/design-sheet/build_tokens.mjs   → 2 palettes × 24 roles, tokens.css carries only graphite|daylight
node tools/design-sheet/build_audit.mjs    → ok
node tools/design-sheet/check.mjs          → 40 PASS, 0 FAIL
node tools/design-sheet/check_screens.mjs  → 20 PASS, 0 FAIL
```

`check.mjs` is the interesting one for this change: it re-derives the sheet from
`crates/x-ui/src/{theme,design_system}.rs` and the app's paint code and fails on
drift — including "two themes offered", "no retired palette", the colour/ink
ceilings and the spacing census. In `editor_ui.rs` the rail now
counts 504 hand-offset sites (531 before, most of them in the rail; 258 on the
documented 4/6/8/12/16/20/24/32/40/48 ladder, 49.7% → 51.2%), and across the app
674 sites / 329 on the ladder.

**Not run: `cargo build`, `cargo test`, `cargo clippy`.** This sandbox has no
Rust toolchain (`rustup`, `crates.io` and `static.rust-lang.org` are all
unreachable from it), so the Rust edits — including the new
`paint::centring_tests` and the retargeted `crates/x-ui` theme tests — are
reviewed statically: delimiters balance, every changed call keeps its argument
order, the sheet's source scanners (icon sizes, radii, colour literals, ink
slots) parse the same calls and are green, and every numeric claim above was
recomputed from the generated token file. The three commands that must run on a
machine with the toolchain are:

```
cargo test -p x-ui                       # ThemeId::ALL == 2, parse("high-contrast") == None, both palettes AA
cargo test --workspace                   # + paint::centring_tests
./scripts/check.sh                       # fmt/clippy/dead-code ratchet/docs
```

## 5 — Notes and leftovers

* `docs/VERIFICATION.md` and `docs/FIXES_2026-09-18_OWNER_REPORT.md` are dated
  records and still describe three palettes; the first now carries a
  "superseded" pointer, the second is the previous pass's report.
  `docs/KNOWN_DEBT.md §3` was rewritten (two palettes; the choice *is* persisted
  now — that item was stale) and the roadmap's High Contrast backlog row is
  marked dropped.
* The design sheet's LIBRARY / TOKENS mocks were rewritten to mirror the new
  bands (they had drifted from the app's earlier layout).
* Still open from the previous pass, unchanged: the item-#1 repro request, and
  the "?" shortcut that is advertised but not bound.
