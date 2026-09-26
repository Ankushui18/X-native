# X-Native — Full Product UI/UX, Code↔UI Integration & Design Maturity Audit

- Date: 2026-09-26. Branch: `arena/01a0d904-x-native`. Base for this phase: `a5b28e1`
  (Figma behavior-parity audit shipped: 224 fixes, suite 1776/0).
- References: Figma (interaction maturity) + Framer (visual polish) + Sketch (native ergonomics,
  inspector density) + Penpot (structured systems thinking). Principles only — output stays
  original X-Native on the Graphite & Signal identity.
- This file is the running ledger. Final deliverables at phase end: `X_NATIVE_DESIGN_SYSTEM.md`
  (§28), `PRODUCT_UI_AUDIT.md`, `PRODUCT_UI_FIXES.md` (all in `X-Native/docs/`; no root `docs/`).

## §0. Phase rules & assumptions (correct me if any is wrong)

1. The previous "Emerald UI/UX locked / do not change UI" constraint is SUPERSEDED for this phase by
   the new prompt's §1 ("make X-Native substantially better than the current UI"). Guardrail kept:
   do NOT blindly replace Graphite & Signal — evolve it (§6 of the prompt).
2. The pasted prompt ends mid-word ("moder…"); §§31+ (if any) were not received. Deliverables mirror
   the previous phase (audit + fixes + design-system docs, tests, verification) unless told otherwise.
3. Sandbox honesty: no browser here, so visual outcomes CANNOT be screenshotted; every visual change
   ships structurally verified (tokens consumed, shared components used, headless tests) and is marked
   NOT VERIFIED visually (needs runtime/manual check). Code↔UI integrity is fully verifiable headless.
4. All work stays on `arena/01a0d904-x-native`; behavior-parity suite (1776) must stay green.

## §1. UI inventory (prompt §3) — from source inspection

App shell (`App.tsx`, 651 lines): Dashboard (file route) → editor route = LeftPanel | Canvas (+ZenHUD,
PresentationPlayer overlay) | RightPanel; Toolbar floats over canvas; overlays: export, nudge, actions
(command palette), figInspector (dev modal), find.

| Surface | File | Size | Notes |
|---|---|---|---|
| Canvas + overlays | `ui/Canvas.tsx` | 7866 lines | selection, handles, guides, rulers, grid, snap, labels, measurements, proto conns, vector nodes, gradient handles, crop, drag previews, minimap mount? (Minimap.tsx separate) |
| Left panel + toolbar + palette + dialogs | `ui/chrome.tsx` | 4248 lines | NavRail, LeftPanel (pages/layers/assets/components/libs/vars/search), Toolbar, Actions palette, NudgeDialog, HelpBtn, FindReplaceBar, hotkeys |
| Right inspector | `ui/inspector.tsx` | 9184 lines | RightPanel + layerCode/copy/export helpers; the monolith |
| Context menus | `ui/ContextMenu.tsx` | 26KB | right-click menus |
| Color/gradient | `ui/FillPicker.tsx` | 32KB | picker popover |
| Prototype player | `ui/PresentationPlayer.tsx` | 30KB | preview overlay |
| Dev inspect modal | `ui/FigInspectorModal.tsx` | 32KB | types search modal |
| Dashboard | `ui/Dashboard.tsx` | 31KB | files home, search |
| Comments | `ui/Comments.tsx` | 8KB | comment threads |
| Minimap | `ui/Minimap.tsx` | 6KB | canvas minimap |
| Rulers | `ui/Rulers.tsx` | 4KB | ruler chrome |
| Guides | `ui/Guides.tsx` | 9KB | guide interaction |
| ZenHUD | `ui/ZenHUD.tsx` | 6KB | minimal HUD |
| RadialMenu | `ui/RadialMenu.tsx` | 6KB | radial menu |
| Tooltip | `ui/Tooltip.tsx` | 3KB | shared tooltip (see §2.3: split system) |
| toast | `ui/toast.ts` | <1KB | adopted by 7 files ✓ |
| a11y | `ui/a11y.ts` | 1KB | |
| Shared UI layer | `ui/x-ui.tsx` | 21KB | XButton XInput XNumericInput XSelect XSegmentedControl XPopover PropertyField XSection XDialog ContextToolbar XTabs + elevation/type — see §2.1: near-zero adoption |
| Theme | `ui/theme.tsx` + `themeModel.ts` | 4KB | light/dark/system + localStorage ✓ |
| Icons | `ui/icons.tsx` | 40KB | Lucide direction |
| Tokens | `src/styles.css` | 4554 lines | `:root` + `data-theme`: bg/canvas/panel/elevated/hover/active/sel/line/text/muted/dim/accent(+hover)/input/field-focus/dock/tool/elev-flat→modal/type scale ✓ foundation exists |
| Devices | `ui/devices.tsx` | 18KB | frame presets |
| Models | color.ts cropModel.ts devPrefs.ts effectModel.ts exportModel.ts fieldExpr.ts layoutActions.ts nudgePrefs.ts scaleModel.ts search.ts selectSame.ts textLayout.ts selectionColors.ts zoom.ts round.ts popoverGuard.ts penDraft.ts | — | inspector/canvas support modules |

No TODO/FIXME/"coming soon"/lorem markers in UI code (only legitimate input `placeholder=` attrs and
engine comments). Dead Ends from prior phases retained: no browser/Rust; E2E unwired here.

## §2. Code↔UI integration — structural findings (prompt §2)

### §2.1 FINDING: shared x-ui layer ~unadopted (MISSING UI-consistency; §29 drift) — P1
- Importers of `./x-ui`: only `Canvas.tsx`, `inspector.tsx`. `chrome.tsx` (66 raw `<button`),
  `Dashboard.tsx` (33), `FillPicker.tsx` (19), `PresentationPlayer.tsx` (9), `FigInspectorModal.tsx` (8)
  import zero shared components.
- Shared-component usages: inspector 3, chrome 0, Canvas 0 — vs 207 raw `<button` in inspector alone.
- `XDialog` adopted NOWHERE except its own file → every modal is bespoke (§§17/29 risk).
- Direction: migrate surfaces to x-ui incrementally (highest-traffic first: toolbar, inspector rows,
  menus, pickers); do NOT restyle everything at once.

### §2.2 FINDING: token foundation exists — document & enforce (§6/§28) — P2
- styles.css already defines surface/text/accent/input/elevation/type tokens for light (+ dark theme
  to verify). Next: audit for hardcoded colors/geometry bypassing tokens (grep `#` hex + `px` in tsx).

### §2.3 FINDING: two tooltip systems (§21) — P1
- `Tooltip.tsx` imported by Dashboard/chrome/inspector, but native `title=` still dominates: chrome 40,
  inspector 205, Canvas 10. Native titles lack shortcut display + consistent design. Direction: single
  Tooltip system with action + shortcut; migrate incrementally.

### §2.4 Next traces (per-surface tables in following turns)
Toolbar buttons → handlers → commands → engine → undo (§9) · Inspector rows §10–11 · Fill/stroke/type/
effects flows §§13–15 · Prototype mode §16 · Modals §17 · Popovers §18 · Tabs §19 · States §20 ·
Context menus §22 · Left-panel IA §23 · Responsive §24 (code-only: panel drag mins exist 180–420/
200–420) · First-run §25 (code walk of clean-state components).

## §3. Plan
1. Per-surface code↔UI traces + integration tables (§2.4 order). 2. Senior critique (§26) with concrete
   causes. 3. `X_NATIVE_DESIGN_SYSTEM.md` from verified tokens + x-ui (+ gaps closed). 4. Incremental
   migrations/fixes (shared components, tooltip unification, inspector row clarity, toolbar hierarchy,
   modal/popover consistency) — smallest correct layer, no behavior regressions. 5. Headless tests for
   every integration fix; suite stays 1776+ green; tsc + build green. 6. Final docs + report.
