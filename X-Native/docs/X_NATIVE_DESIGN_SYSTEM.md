# X-Native Design System (Graphite & Signal, evolved)

- Date: 2026-09-26. Status: DOCUMENTED from verified source (`src/styles.css`, `src/ui/x-ui.tsx`,
  `src/ui/Tooltip.tsx`, `src/ui/ContextMenu.tsx`, `src/ui/icons.tsx`, inspector `Section`/`Field`/
  `ColorRow`); gaps marked PROPOSED. Visuals NOT VERIFIED (no browser) — tokens/components verified
  structurally. Identity: Graphite & Signal kept; this doc evolves, not replaces.

## Colors (tokens, light + dark verified)

| Role | Token | Light | Dark |
|---|---|---|---|
| App bg / canvas / panel / elevated | --bg/--canvas/--panel/--elevated | #fcfcfa/#eef1f4/#fff/#fff | #0f1419/#0a0e13/#171c22/#1e252e |
| Hover / active / selected wash | --hover/--active/--sel | #f1f5f1/#e6efe9/emerald .12 | #212c2a/#2a3530/green .18 |
| Lines | --line/--line-2 (+--border alias) | slate .07/.12 | white .07/.12 |
| Text 1/2/3 | --text/--muted/--dim (+--fg*) | #111827/.68/.60 | #f1f5f3/.68/.64 |
| Accent + hover/ink/on | --accent* | #0e9f6e | #10b981 |
| Fields | --input/--field-focus (+aliases) | #f3f7f4/#fff | #1e2a22/#171c22 |
| Dock/tool | --dock/--tool-* | white .94 | dark .92 |
| Canvas aids | --grid/--canvas-label/--dot | emerald .07/grey/#cbd5d1 | emerald .09/grey/#2d3a33 |
| Semantic | --green/--red/--amber | #12a150/#d92d20/#d97706 | #34d399/#f87171/#fbbf24 |

Debt: `--blue` is a legacy alias OF the green accent (rename, don't reuse); canvas consts
(`BRAND_ACCENT #10b981`, `#a855f7`, `#ff3b6b`, chip `#18181b`) bypass tokens incl. dark mode (FR-U2).

Debt, measured and ratcheted (2026-09-26): `src/ui/*.tsx` still carries **414 inline `style={{`
objects, 195 quoted hex literals, 340 native `title=`, 363 raw `<button` and 49 raw `<select`** —
`inspector.tsx` alone is 179/44/221/192/41. `src/ui/__tests__/drift.test.mjs` pins those per file and
fails if any grows, so rules 1 and 2 below are enforced rather than aspirational; each round lowers a
row. The dock and the inspector's vector card are the two surfaces already at zero inline layout
(§4q of `PRODUCT_UI_AUDIT_2026-09-26.md`), which is what a finished surface looks like: classes in the
sheet, colours from tokens, controls from the primitives.

## Typography / icons / elevation (verified)

- Type scale: `--t-control` 500 11px/14 · `--t-label` 600 10px/13 · `--t-body` 400 11px/15 ·
  `--t-section` 600 11px/16, Inter/system. Canvas labels constant 11px.
- Icons: Lucide direction, 12 (rows) / 14 (controls) / 16 (toolbar) via `caretSize()`/`rowIconSize()`;
  20px reserved for marks. Never oversized in inspector.
- Elevation: `--elev-flat/raised/floating/overlay/modal` + `--shadow`; popover → floating/overlay,
  dialog → modal.

## Spacing / radii (PROPOSED — no scales exist; adopt, then migrate)

- Space: 2/4/6/8/12/16/24 (`--sp-1…6`); control gap 4, section gap 8, panel pad 8–12.
- Radius: fields/rows 6, popovers/menus 8–12, dialogs 12, dock 16, pills/full-round for badges/chips.

## Components (source of truth → adoption)

- Button/input/numeric/select/segmented/popover/dialog/tabs: `x-ui.tsx` (`XButton`/`XInput`/
  `XNumericInput`/`XSelect`/`XSegmentedControl`/`XPopover`/`XDialog`/`XTabs`) + `PropertyField`,
  `XSection`, `ContextToolbar`. ADOPTION (measured 2026-09-26, `<X…` call sites outside `x-ui.tsx`):
  `XButton` 14 (DialogHost + the inspector's vector card), `XSegmentedControl` 5 (dev-seg, the vector
  card's mirroring + offset join), `XPopover` 2 (EffectPopover, the bind picker), `XDialog` 2,
  `XTabs` 1, `ContextToolbar` 1 — and still **0** for `XInput`, `XNumericInput`, `XSelect`,
  `PropertyField` and `XSection`, which the inspector's own `Field`/`Section` predate and outclass
  (arithmetic, Mixed, multi-value, scrub, fold + persistence). The migration is therefore *not*
  "replace Field with XNumericInput"; it is either promote `Field`/`Section` into x-ui or retire the
  five orphans — decide before adopting them anywhere new.
- Action rows vs switches: a segmented control is for a value the layer has (`role="tab"` + one
  `aria-selected` + one tab stop). A row of one-shot actions — align, distribute, tidy — is the
  panel's `.align > .g` idiom of plain buttons behind `Tooltip`, with no selection claim. Passing
  `value=""` to `XSegmentedControl` for such a row is a defect, not a shortcut: its roving tabindex
  then gives every tab `tabindex="-1"` and the row leaves the tab order.
- Inspector: `Section` (collapse + persist + `openSection` bus) + `Field` (arithmetic, Mixed,
  multi-values, tokens, disabled-reasons) + `ColorRow` (swatch/hex/opacity/visibility/export/remove +
  anchored picker) + `BindingChip`. All new rows compose these; no bespoke headers (IN-U3/U4).
- Tooltip: `Tooltip.tsx` (label + shortcut, 380ms + chaining, portal, clamped) — replaces ALL native
  `title=` on controls (§2.3); add focus trigger (TY-U6).
- Menus: `ContextMenu.tsx` (clamped, Esc, arrows + submenus) for all right-click + "more" menus.
- Toast: inverted chip, bottom-center, 1.6–4s; failures always carry reasons.
- Tabs: ONE system — `XTabs` styling for text tabs; one seg primitive for icon segs (PM-U5/IN-U7).
- Canvas overlays: selection ring + kind-dialect handles (frame 7px / shape 6px / vector diamond /
  hug-text sides / line ends), purple for components, rotate zone 6–22px + angle badge, size badge
  (add viewport clamp, FR-U4), locked dialect REQUIRED (FR-U1), top-level-only labels.

## Rules

1. No new raw `<button>`/`<select>`/tooltip/`title=` in product surfaces — compose the primitives.
2. No hardcoded colors/geometry in chrome — tokens (or canvas-fed tokens) only.
3. Every icon-only control: Tooltip label + shortcut, focus-visible, aria-label.
4. Every popover: anchor + viewport clamp + Esc + outside-click + initial focus.
5. Every dialog: `XDialog` (or pattern twin), focus in, Esc/outside-close, no native prompt/confirm.
6. Multi-select: Mixed-or-aggregate everywhere; first-layer values must never masquerade (IN-U1/TY-U3).
7. Bound props: visible indicator + "explicit edit wins" (FS-U1/U5/U6).
