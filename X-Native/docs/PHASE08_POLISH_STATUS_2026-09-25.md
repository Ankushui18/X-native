# Phase 8 polish — status 2026-09-25 (`track=ts`, P1)

Follow-up to Phase 7 (`d33c825`). Canvas selection needed no conversion —
already emerald via `BRAND_ACCENT` (44 use sites). Red `#ff3b6b` (guides /
measure) and purple `#a855f7` (overlays / components) are intentional canvas
semantics and were kept; the wave instead unified the meanings across CSS.

## Changes (3 files, +22/−8)
- `apps/web/src/styles.css`
  - `--comp` token: `#a855f7` (light) / `#c4b5fd` (dark); `.row.comp`
    now uses it — layer rows match the canvas component color exactly.
  - `.row.sel` selection rail: `inset 2px 0 0 var(--accent)`.
  - `.fly` / `.ctx` / `.menu` get `1px solid var(--line)` floating-surface borders.
  - `.actions` (Quick Open) gets border + `actions-in` rise/fade entrance.
- `apps/web/src/ui/Canvas.tsx` — `COMP_PURPLE` constant with pairing comment
  (`--comp` in CSS is its twin; change both). 4 use sites converted; sole
  remaining `#a855f7` literal is the definition.
- `apps/web/src/ui/FigInspectorModal.tsx` — last `#0d99ff` fallback → `#10b981`.

## Verification
`tsc` clean · tests 1112/0 (890+64+46+63+49) · `vite build` clean ·
dev 200 (port 5203).

## Deferred
P1.10 "Works with MCP" — still untouched, needs decision.
