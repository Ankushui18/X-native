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
2. Full prompt §§1–40 received 2026-09-26 (supersedes the truncated copy). Deliverables per §37:
   `UI_UX_MASTER_AUDIT.md`, `UI_CODE_INTEGRATION_AUDIT.md`, `X_NATIVE_DESIGN_SYSTEM.md`,
   `UI_UX_IMPROVEMENT_ROADMAP.md` (+ §38 table, §39 criteria), all in `X-Native/docs/`.
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

## §4. Toolbar trace (prompt §9) — chrome.tsx Toolbar:1005–1245 + GROUPS:943–983

All 20 engine Tool values have toolbar UI (move group: select/hand/scale/zoom; region: frame/section/
slice; shape: rect/line/arrow/ellipse/poly/star/image; pen: pen/pencil/brush/eraser; text; comment) —
each dispatches `setTool`. Group buttons carry Tooltip+shortcut, last-used memory, active state; a11y
roles (toolbar/menu/menuitemradio, aria-checked/expanded/pressed) present. Multi-select section (≥2):
count label, makeComponent ⌥⌘K, boolean flyout + flatten. Dev Mode toggle mirrors rightTab. `--border`
token EXISTS (alias of --line) — divider renders; cleared.

| # | UI | Handler→State→Engine→Undo | Status | Pri |
|---|---|---|---|---|
| 20 tool buttons | click/hold/caret → local open → `setTool` | CONNECTED | — |
| Multi-select: make/boolean/flatten | dispatch makeComponent/boolean/flatten | CONNECTED | — |
| Dev Mode toggle | `setRightTab` inspect/design + aria-pressed | CONNECTED | — |
| VecEdit Done | `setVecEdit` null | CONNECTED (+P2: native title=) | P2 |
| TB-U1 Resources + Actions | BOTH call onActions; BOTH claim ⌘/; adjacent | DUPLICATE + misleading label | P1 |
| TB-U2 tool flyouts | no arrows/Esc/focus mgmt; global Esc skips toolbar `open` | PARTIAL (mouse-only menu) | P1 |
| TB-U3 Prototype entry | rightTab via ⇧E/palette only; no toolbar button; palette shows no sc | MISSING UI (undiscoverable) | P1 |
| TB-U4 caret + Done tooltips | native `title=` inside a Tooltip-using component | PARTIAL (§2.3) | P2 |
| TB-U5 boolean flyout styles | inline styles (width/divider/label) bypass tokens | DRIFT (§29) | P2 |
| TB-U6 palette Prototype/Design rows | `sc: ""` though ⇧E exists | PARTIAL | P2 |

Fix directions: U1 → Resources opens left Assets pane (or palette w/ resources filter), not the same
palette; U2 → arrow/Esc/focus discipline on `.fly` menus; U3 → toolbar Prototype toggle w/ active state
(mirror Dev Mode button) + ⇧E in palette row.

## §6. Prototype mode trace (prompt §16) — Canvas + inspector Prototype:726–1322 + Player

CANVAS (all connected): 4 conn handles/layer, 13px hit, rotation/flip-aware → protoConnect drag;
flow-start badge click → presentStart; S-curve noodles (gated showFlows + prototype tab, hidden while
presenting); selected-conn chip → deleteInteraction + toast; ⌘C/V on noodle; Esc drops conn selection.
PANEL (all wired via setInteractions + page/patch dispatches): flow start; device/scale/orientation +
live DevicePreview; interactions CRUD; 9 triggers (incl. key-capture, delay, drag); 10 actions
(navigate/overlay×3/back/scrollTo/openUrl/setVariable/setVariableMode/setVariant); overlay pos +
close-outside; duration clamp 1–10000; 9 animations; 6 easings + curve preview SVG; smart-match;
conditions (8 ops); "Present Prototype" run button.
PREVIEW: start = inspector Present btn / palette "Present ⌘⌥↩" / ⌘⌥↩ chord → presentStart + hideUi +
toast; Esc cascade overlay→back→stop; Player has prev/next/restart/hotspots/scale/inputs/sound/
fullscreen/Exit — all functional.

| # | Finding | Status | Pri |
|---|---|---|---|
| TB-U3 (upheld) | No TOOLBAR entry for the prototype authoring tab (Present btn ≠ tab; ⇧E + palette only) | MISSING UI | P1 |
| PT-U1 | No-op `onClick={() => {}}` on "Prototype settings" h-row (inspector ~779) | DEAD handler | P2 |
| PT-U2 | "Present Prototype" reuses `export-run` class | DRIFT (§29) | P2 |
| PT-U3 | All proto selects/inputs raw + inline styles; icon-only btns native title= (orientation/plus/minus/condition) | DRIFT + tooltip split | P2 |
| PT-U4 | Selected-conn chip: hardcoded #18181b/#fff + inline styles + native title | DRIFT | P2 |
| PT-U5 | Player: 9 controls all inline-styled + native title= + hardcoded colors; zero x-ui/Tooltip | DRIFT | P2 |
| PT-U6 | "Prototype flows ⇧F" toggle lives in ZoomMenu (view menu inside inspector tab bar) — works, surprising home | IA note | P2 |
| PT-U7 | Present button Tooltip shows "Esc to exit" but never the start chord ⌘⌥↩ (exists + in palette) | PARTIAL | P2 |

## §7. Inspector architecture trace (prompts §§10–11, 20, 29) — Design:3061–6222 + Section:8455 + Field:7637

ARCHITECTURE (good bones): shared `Section` (collapse + localStorage persist + `openSection` event bus
so add-actions reveal their section) and shared `Field` (arithmetic commit, Mixed display, per-layer
multi-values, word tokens, disabled-with-reason). Map: Typography (text-only, rendered FIRST) ·
Position (X/Y/W/H/rotation/flip/constraints-picker/align/distribute/tidy; multi-aware w/ Mixed) ·
Layout (add/suggest auto-layout) · Layout grid (frame-only) · Appearance (blend/opacity/radius) ·
Fill · Stroke · Selection colors · Effects · Modifiers · Expressions · Export (default closed) ·
kind-gated Boolean/Component-Instance/Poly-Star headers · vector card (Edit Path/Done/outline/
simplify/offset) · PageDesign no-selection state. All traced controls dispatch to the engine.

| # | Finding | Status | Pri |
|---|---|---|---|
| IN-U1 | MULTI-SELECT: fill/stroke/appearance/effects show FIRST-layer values with NO Mixed (only corner radii has it); edits patch first layer only — exactly the §29 violation (controls masquerading as shared). Fix: Mixed display + apply-to-all via the numMany/onChangeMany pattern | PARTIAL | P1 |
| IN-U2 | DUPLICATE "Outline stroke": seg button ~4300 (no id, no toast, no title) + vector-card button ~4525 (id + toast + ⇧⌘O) — both render on vectors with stroke, divergent behavior | DUPLICATE | P1 |
| IN-U3 | Component/Instance, Boolean, Poly/Star headers use h-row, not Section (no collapse/persist, different chrome) | DRIFT (§29) | P2 |
| IN-U4 | Vector card bespoke: `<strong>` header, `export-run` buttons, inline styles, hardcoded #fff, native titles | DRIFT | P2 |
| IN-U5 | "Edit vector" label dispatches `flatten` (misleading); seg buttons raw/unclassed | LABEL + DRIFT | P2 |
| IN-U6 | Flip buttons + assorted icon-only buttons use native title= amid Tooltip siblings | PARTIAL (§2.3) | P2 |
| IN-U7 | Design/Prototype/Inspect tabs are raw buttons, not XTabs; no arrow-key nav (§19 evidence) | DRIFT | P2 |

## §5. Plan (running)
1. Per-surface code↔UI traces + integration tables (§2.4 order). 2. Senior critique (§26) with concrete
   causes. 3. `X_NATIVE_DESIGN_SYSTEM.md` from verified tokens + x-ui (+ gaps closed). 4. Incremental
   migrations/fixes (shared components, tooltip unification, inspector row clarity, toolbar hierarchy,
   modal/popover consistency) — smallest correct layer, no behavior regressions. 5. Headless tests for
   every integration fix; suite stays 1776+ green; tsc + build green. 6. Final docs + report.
