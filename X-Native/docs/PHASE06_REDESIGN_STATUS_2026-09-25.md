# Phase 6 — Design System Redesign (TS track) — 2026-09-25

The app-chrome redesign: every concrete complaint (missing/mismatched icons,
clutter, visibility, random colors) traced to a root cause and fixed at the
system level, with compile-time guards so it cannot regress.

## Audit findings (all fixed)

- **6 icons rendered as empty circles.** Unknown names fall through to a bare
  `○` default, and six were referenced: `layout` (Add auto layout menu),
  `eye-closed` (layers visibility toggle), `volume` / `volume-x` (present
  mode sound toggle), `cap-reverse-triangle` / `cap-diamond` (stroke caps —
  found by the new type checker, invisible before).
- **126 of 281 icons dead** (45%), incl. near-duplicate families
  (`check`/`checkmark`/`check-large`, `align-left`/`align-left-alt`,
  `code`/`code-block`/`code-snippet`…) — the "random icon in random places"
  supply chain.
- **11 undefined CSS variables** in live use: `--border` (35×!),
  `--fg(-muted)`, `--bg-subtle`, `--input-bg`, `--panel-2`, `--text-3`,
  `--mono`, `--font-mono`, `--green`, `--red`. Every declaration using one
  silently failed — invisible dividers, wrong text colors.
- **Contrast below bar:** `--muted` ≈ 3.9:1, `--dim` ≈ 2:1 on white.
- **Off-identity strays:** indigo `#6366f1` badge/glows in chrome + player.
- **Dead CSS:** 13 classes incl. a duplicated v1 box-model block.

## What shipped

**Icons (`ui/icons.tsx`, 281 → 163 cases)**
- Added the 5 missing glyphs in the 16px grid style; unified
  `eye-closed` → `eye-off` (one hidden metaphor everywhere).
- Deleted the 126 dead cases/aliases (shared blocks kept, dead lines cut).
- `IconName` union enforced on `Icon`, `TOOL_ICON`, `TEMPLATE_ICON`,
  `MenuItem`, `PresetCategory`, Quick Open entries, x-ui props, and field
  icons — a wrong icon name is now a **compile error**, and the cleanup
  already caught 2 live bugs this way.
- Base stroke 1.25 → 1.5 (12px glyphs render under a pixel otherwise);
  size stragglers (11/13/15) unified to 12/14/16; contributor rules in the
  header comment.

**Tokens (`styles.css`, both themes)**
- All 11 undefined vars defined as documented aliases; new `--amber`,
  `--accent-wash`, `--accent-ring`.
- `--muted` → 0.68, `--dim` → 0.48/0.50 alpha (readable secondary text).
- Global `:focus-visible` ring; status colors (lint, sync, health) themed.

**Declutter**
- `.insp-group-title` / `.insp-label` replace repeated inline header styles;
  indigo chrome → emerald theme; 13 dead CSS classes removed (~120 lines).

## Verification

- `tsc` clean, `vite build` clean, dev server 200.
- Tests untouched, still 1112/0 (no engine changes).

## Deliberately not touched (needs eyes, propose next)

- Canvas selection/overlay blue: conventional even in custom themes; changing
  the most-visible pixel in the app should be a seen decision.
- Bigger visual-identity moves (rail/topbar restyle, new accent direction,
  density rework): foundation is now coherent enough that these are taste
  calls, not bug fixes — happy to take a direction and run.
