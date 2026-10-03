# Phase 7 — Emerald Pushed Further (TS track) — 2026-09-25

Direction (a): keep the emerald identity, push it through the shell with
signature details. No engine changes; styles + rail markup only.

## What shipped

**Rail signature restyle**
- Consolidated the duplicated rail rules (two blocks fought; later won) into
  one: 44px buttons, idle icons in `--muted`, hover lifts to text, active is
  an emerald wash pill with an inset accent ring + semibold label.
- Divider above the bottom cluster; the "Saved" button is now an autosave
  status pill — breathing emerald dot + label — instead of a third icon.

**Headers & rhythm**
- Panel hairlines under both `file-head` and `right-head`.
- Avatar: off-brand yellow → emerald gradient.
- Dev Mode toggle gets a real active state (emerald wash + ring).
- Active inspector tabs get an emerald underline indicator.

**Controls & feedback**
- 120ms transitions on icon buttons, rail nav, and dock hits; Share/primary
  CTAs share one emerald gradient language in both themes (the dashboard
  primary was black in light mode, blue in dark — now emerald everywhere).
- Toast: accent-ring border + slide-in (covered by the reduced-motion
  kill-switch).
- Emerald `::selection`; scrollbar hover → accent ring; base `kbd` chip.
- Auto-layout dot on-theme in dark mode; file cards gain an emerald hover
  ring; empty-state art tinted emerald.

**Consolidation**
- Duplicate `.dock` and `.menu` blocks folded into their canonical rules
  (winning values kept — no visual change, one source of truth).

## Verification

- `tsc` clean, `vite build` clean, dev server 200, tests 1112/0.

## Notes

- A suspected `:::-webkit-scrollbar` typo turned out to be a grep artifact
  (line-number colon); scrollbars were fine.
- A mid-phase scare — `file-card` CSS thought deleted in Phase 6 — was a
  false alarm: the refined scan had kept it, and it was verified intact.
- Canvas selection blue intentionally untouched (awaiting a seen decision).
