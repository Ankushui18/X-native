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

### §2.2 FINDING: token foundation exists — document & enforce (§6/§28) — ENFORCED (P2, §4q)
- styles.css already defines surface/text/accent/input/elevation/type tokens for light and dark.
- **Enforced now, not "next".** `src/ui/__tests__/drift.test.mjs` is the audit the bullet asked for,
  run on every `npm test`: per-file ceilings for inline `style={{`, quoted `#rrggbb`, native `title=`,
  raw `<button` and raw `<select` (workspace 414 / 195 / 340 / 363 / 49, measured 2026-09-26), pinned
  in a table that a new surface has to join and a fix has to lower. Same instrument as
  `DEAD_CODE_CEILING`; see `docs/KNOWN_DEBT.md` §12 for what it costs and what it does not gate.
- Dark theme: token-driven and checked in the browser suite for the dock (§4n), the player (§4o) and
  the vector card + Done button (§42 — written, not run in the sandbox that produced it). The canvas
  was the exception (FR-U2: chrome constants no token reached); since §4r it reads a `--cv-*` role
  family that both themes declare, and §43b checks a dark-booted app against the dark tokens. What
  the dark column does not yet do is *differ* for most canvas roles — that is FR-U2b, a design call.

### §2.3 FINDING: two tooltip systems (§21) — FIXED (P1)
- `Tooltip.tsx` imported by Dashboard/chrome/inspector, but native `title=` still dominated: chrome 40,
  inspector 205, Canvas 10. Native titles lack shortcut display + consistent design.
- **FIXED — one surface, no call-site churn.** The mapping is now single: the shared pill (dark `#1e1e1e`
  / `#383838` dark theme, 26px, 11px type, chip for the shortcut) renders for a control whether it was
  written `<Tooltip>` or `title=`. `ui/tooltipBridge.ts` adopts native labels at the moment of use: it
  moves `title` → `data-tip` while the pill shows (so the browser's unstyled box never appears), names any
  control that had no accessible name (that was all the native tooltip was standing in for), and puts the
  attribute back on leave — the bridge is presentation, not the owner of the label.
- **Keyboard users get labels too (TY-U6, also closed).** The shared component shows its pill on
  `:focus-visible` at zero delay; the bridge does the same for title-only controls. Pointer paths keep the
  380ms delay, and the chain rule (next tooltip along a row is instant) is shared by both via `showDelay`.
- **Split rule:** `splitShortcutLabel` pulls a trailing bracketed *key token* into the chip —
  `Lock layer (⇧⌘L)` → `Lock layer` + `⇧⌘L` — while prose stays in the label
  (`Clean up vector (sketch to perfect Bézier)`), so no existing text is mangled.
- **One trap worth recording:** the pill must be created as it appears rather than mounted-and-hidden.
  Toggling `display` on a node whose pop-in animation had already run left Chromium's composited opacity
  parked partway, and the pill rendered washed out (~20-50% over the panel) while `getComputedStyle`
  reported `opacity: 1` — a pixel-level check, not a style check, is what caught it. The bridge's pill is
  created per showing and carries `data-static` (no fade), because a tooltip that already waited 380ms has
  nothing to gain from one.
- Migration direction stands for the P2 drift items below: new code uses `<Tooltip>`; existing `title=`
  sites now *behave* like it.

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
| TB-U1 Resources + Actions | FIXED: Resources key retargeted to Assets pane via onNav (label "Assets", ⌥2); Actions key keeps the ⌘/ palette | FIXED (P1) | — |
| TB-U2 tool flyouts | FIXED: full menu pattern on tool + boolean flyouts (arrows/Home/End/Esc/Tab, focus-in on keyboard open, focus return, blur-close); open flyouts arm the shared popover guard so global Esc yields | FIXED (P1) | — |
| TB-U3 Prototype entry | FIXED: toolbar Prototype toggle (flow glyph, mirrors DevMode toggle + ⇧E both-ways); palette rows show ⇧E | FIXED (P1) | — |
| TB-U4 | FIXED: the toolbar caret dropped its native `title` (it sits inside the tool's Tooltip) and gained an `aria-label` instead. The bridge now also refuses to adopt a label inside a `.tip-host`, so a re-added title cannot double up. | FIXED (P2) | — |
| TB-U5 boolean flyout styles | FIXED: the boolean tool is the dock's own split-tool recipe (`tool split` + `.caret` gutter + the plain `.fly`, so it takes the 220px min-width every other menu has instead of an inline 180px), the separator is `.fly-div`, and the two remaining inline objects in the Toolbar — the multi-select `.toolset` and its count label — became `.toolset.multi` / `.sel-count`. The vector-edit **Done** button next door carried an inline accent with a hardcoded `#fff`; it is `.hit.vec-done` on `--accent`/`--on-accent`, so it survives the dark theme (where the accent's ink is `#0a0e13`, not white). The dock now has zero inline styles outside `Icon`'s own svg box. §4q | FIXED (P2) | — |
| TB-U6 palette Prototype/Design rows | FIXED: both rows show ⇧E | FIXED (P2) | — |

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
| TB-U3 (upheld) | FIXED with TB-U3 above (distinct flow glyph, not the Present play triangle) | FIXED (P1) | — |
| PT-U1 | FIXED with IN-U3: the header is a `Section`, so a click now folds the block instead of doing nothing | FIXED (P2) | — |
| PT-U2 | FIXED: `.export-run`'s recipe has a semantic name (`.x-primary`) — the class was named for the export sheet's Run button and every full-width action had copied it, Present included. The old name stays as an alias for its remaining callers. | FIXED (P2) | — |
| PT-U3 | FIXED: the prototype panel is one set of controls — `.proto-row`/`.proto-interaction` selects and inputs share one recipe (28px, 1px `--line`, `--input`, `--t-control`, accent focus), the interaction is a `.proto-interaction` card with layout classes (`.proto-top`/`.proto-pair`/`.proto-anim`/`.proto-cond`/`.proto-check`/`.proto-ease`) instead of six inline grids, and the preview's `marginTop` moved to CSS. Panel rows used to be borderless 24px selects and the card's 12px browser defaults one row apart. | FIXED (P2) | — |
| PT-U4 | FIXED: the selected-connection chip and the vector tool strip are the same `.canvas-dock` surface the canvas HUD and contextual toolbar use (`--dock`, `--line-2`, `--tool-fg`, elevation tokens). ~10 inline style objects per surface are gone, `#18181b`/`#fff` with them, and both follow the light/dark theme. Fixing it surfaced a second defect: **the chip could not be dismissed with Escape at all** — the canvas's own Escape branch is unreachable for real keypresses because the hotkey layer registers earlier and answers first (the reason `ui/penDraft.ts` exists), so the dismissal is now published (`ui/connSelection.ts`) and answered in the cascade. | FIXED (P2) | — |
| PT-U5 | FIXED: the player is styled by `.player-dock` (it defines the presentation stage's own palette — a prototype is shown on a dark stage in both themes, so it deliberately does not use the app's `--dock`). 11 inline style objects and their `#18181b`/`#fff`/`rgba(255,255,255,…)` copies are gone, the three toggles carry `aria-pressed` instead of saying "on" through their own inline colour, and labels ride the shared tooltip bridge like every other control. Fixing it surfaced a second defect: **the pager listed frames the player can never present** (see §4o). | FIXED (P2) | — |
| PT-U6 | "Prototype flows ⇧F" toggle lives in ZoomMenu (view menu inside inspector tab bar) — works, surprising home | IA note | P2 |
| PT-U7 | FIXED: the Present chip is the chord that starts a presentation (⌘⌥↩, as the palette lists and `bindHotkeys` implements) instead of the sentence "Esc to exit" in a shortcut slot. | FIXED (P2) | — |

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
| IN-U1 | FIXED: shared patchMany/mixedProp/manyVals/patchNumMany helpers; Mixed display + apply-to-all for opacity/blend/corners(+toggles)/stroke weight/base fill+stroke rows (incl gradient/image/meta/remove/visibility) and Fill/Stroke/Effect Add; ColorRow gains a mixed swatch+hex. REMAINING (follow-up): fill/stroke/effect stack ROW edits, effect row ops, visibility-toggle display states (all: first-layer display kept, Export-precedent documented) | FIXED (P1) | — |
| IN-U2 | FIXED: seg entry shows only when the vector card is absent (exactly one entry always); both use id+toast+⇧⌘O title; card refuses the stroke-less no-op with a teaching toast; labels unified | FIXED (P1) | — |
| IN-U3 | FIXED: every ad-hoc header is now a `Section` — Component/Instance (its action buttons moved into the section's action slot), Boolean, Star/Polygon, and on the page/prototype surfaces Frame Presets, Background, Local styles, Pixel grid, Flow starting point, Prototype settings, Interactions, Annotations. `h-row h3` and `.sec-toggle h2` were already the same 11px/500/muted style, so the chrome reads identically while every block gained fold + persistence + the scroll-to hook. Left bespoke on purpose: `Design health` (score + issues button) and the Dev Mode `Inspect` header (dot + view tabs) — both carry live, bespoke chrome a plain title would lose. Note: the audit's "10 sections" observation was itself approximate — the count varies by selection (screen 4 / layer 11 / text 12) and now includes these blocks. | FIXED (P2) | — |
| IN-U4 | FIXED: the card is the shared primitives — `Section id="vector"` for the header (fold + persistence + the scroll-to hook, chip and edit button in its action slot), `Field` for the vertex numbers, `XSegmentedControl` for mirroring and the offset join, `XButton` for the header and quick actions, `.x-btn-primary` for Apply. Its six point-alignment actions are the panel's own `.align > .g` idiom behind `Tooltip` (not tabs: a one-shot action has no selected panel to claim, and a `value=""` tablist would have left the row out of the tab order). All inline style objects and both `#fff`/`#ffffff` literals are gone; the geometry lives in `.vec-card`/`.vec-row`/`.vec-align`/`.vec-vertex`/`.vec-pair`/`.vec-slider`/`.vec-actions`/`.vec-sub`. Vertex fields are named `Vertex X` / `Vertex Y` / `Vertex corner radius` so they cannot collide with the layer's own `X` / `Y` / `Corner radius`, which the e2e `field()` helper and assistive tech address by aria-label. §4q | FIXED (P2) | — |
| IN-U5 | FIXED: "Edit vector" → **"Edit points"**, and it now enters vector edit mode (the inspector twin of double-clicking a layer; booleans still bake first, because their points only exist once the group is applied). The button reads "Editing points" while the editor is open. It previously dispatched `flatten` — the exact action of the button beside it — so the label promised editing and delivered a bake. "Flatten" stays a distinct bake. Seg buttons are still unclassed (x-ui adoption family). | FIXED (label+action) / DRIFT (styling) | P2 |
| IN-U6 | Flip buttons + assorted icon-only buttons use native title= amid Tooltip siblings | PARTIAL (§2.3) | P2 |
| IN-U7 | FIXED with PM-U5: `XTabs` now carries `role=tablist`/`tab`/`aria-selected` + roving `tabindex` + arrows/Home/End, keeps `aria-current` so the underline styling and the e2e checks that read it still work, and the zoom menu shares a `.tabs-row` so the divider still spans the strip. | FIXED (P2) | — |

## §8. Fill/Stroke/Effects + variables/styles trace (prompts §§13, 15, 18)

CONNECTED: Fill + (base re-add/stacking), reorderable extras (drag + bring/send), base+extras via
ColorRow → patch; swatch → anchored FillPicker (viewport-clamped + flip, role=dialog, Esc + outside-
click close w/o dropping selection) → onValueChange → patch; hex draft-commit, opacity, eye,
export-eye, remove. Stroke: ColorRow(stroke, honestly solid-only) + width Field (+custom 4-side) +
align seg w/ hover AND focus preview + sides seg; empty-add/remove. Effects: addKind menu w/ limits +
hover preview; rows + EffectPopover; remove. Variables: variable-first bind from VarsPane w/ guard
toasts (text/layout/instance checks); BindingChip + unbind; styles: tokens→styles subtab, create from
selection, apply (click=fill/shift-click=stroke) w/ bound ring + toasts, delete; direct patch DETACHES
styles (memory ~2482, Figma-correct). Engine has ONLY fill+stroke style slots.

| # | Finding | Status | Pri |
|---|---|---|---|
| FS-U1 | FIXED: shared BindControl on all 16 inspector rows with a binding (fill/stroke/width/opacity/7 type props/corners/w/h/gap/padding) — ghost button opens a type-filtered variable picker with live resolved values (XPopover), one pick binds the row's full target set; refuses via the engine's shared bindBlockReason table so they say why. Engine + VarRow + BindControl consume one table (headless ×13). e2e §30 (bind/pick/unbind/mixed-multi). NOT done: variables listed inside the FillPicker itself — deferred as a second surface | FIXED (P1) | — |
| FS-U6 | RETRACTED as filed: `patch` DOES generically detach (memory:2489–2499 — my earlier grep was head-truncated). Fill/stroke/type/radii/text edits correctly unbind. The chip text is TRUE. Remnants below (verified by full read + handler-by-handler check) | RETRACTED | — |
| FS-U6′ | REAL remnant, FIXED: `hideSel` toggled `visible` without detaching a `visible` binding (the only bindable prop outside patch/resize/autoLayout, all verified covered) → toggle silently reverted on next relayout. Fix: detach visible + ownBindings.visible in hideSel (mirrors precedents). Tests: +4 in variables.test.mjs (100/0) | FIXED | P2 |
| FS-U5 | FIXED: BindingChip replaced by the pill state of the same BindControl — every bound row shows its variable name (+ re-pick/unbind), multi divergent shows a lit Mixed ghost, structurally unbindable rows show a disabled ghost with the reason. visible/text have no inspector row (unchanged). Known tradeoff: 4 independent-corner fields each show the one cornerRadii pill | FIXED (P1) | — |
| FS-U2 | FIXED: 0 native prompt/confirm left in src (18 call sites). New `ui/dialog.ts` (promise bus: askConfirm/askPrompt/askChoice, queued so nested questions stay ordered, resolve is idempotent) + `ui/DialogHost` on the shared XDialog (Escape/backdrop = cancel, capture-phase Escape so the editor's global Escape does not also fire, primary action focused, prompt auto-selects its current value, Enter submits, inline validation refuses with a reason instead of silently doing nothing). Host mounted once in main.tsx over both routes. The style fill/stroke `confirm` (Cancel used to mean "fill") is a real 3-way choice. XButton gained forwardRef for dialog focus; XDialog gained aria-modal. NOTE: dashboard had 10 toast() call sites and rendered none — added, or a dialog's success message landed nowhere. e2e §31 | FIXED (P1) | — |
| FS-U3 | Text/effect styles don't exist in engine (only fill+stroke slots) — OUT OF SCOPE per §3/§35, not missing UI | OOS | — |
| FS-U4 | Plus/eye/minus/export buttons use native title= throughout ColorRow/fill/stroke/effects | PARTIAL (§2.3) | P2 |

Fix directions: FS-U6 → clear the patched prop's binding key in `patch` (mirror the resize/layout/
style precedents; smallest correct layer = engine); FS-U1 → bind affordance on rows + in-picker entry;
FS-U5 → chip/indicator wherever a binding can land.

## §9. Typography trace (prompt §14) — renderTypographySection:3442–3727 + textarea overlay

CONNECTED: font family (11 built-ins + Local Font Access enumeration + "Load system fonts" fallback w/
toasts; unknown family preserved); weight select; size/leading/tracking Fields (leading label toggles
Auto, click resets to Auto); resize-mode seg w/ Tooltips; align + valign segs; type-pop (underline/
strike toggles, case incl. small caps, truncate + maxLines gated w/ reason, ¶ spacing, ⇥ indent, wrap,
lists) — all dispatch patchType→patch + hug refit. Canvas: real textarea overlay, commit-on-blur w/
hug refit, edit-switch chaining (Y-010), Esc/⌘↵ commit. Frame-name inline edit: Enter commits,
Esc cancels, empty→"Frame". Tooltip.tsx itself verified solid (380ms delay + 500ms chaining, portal,
viewport clamp, role=tooltip; empty shortcut renders nothing).

| # | Finding | Status | Pri |
|---|---|---|---|
| TY-U1 | FIXED: Italic toggle in Type settings popover (patchType fontStyle + rehug, = ⌘I path), new `italic` glyph, Tooltip ⌘I | FIXED (P1) | — |
| TY-U2 | FIXED: all 9 type buttons wrapped in Tooltip + aria-label/aria-pressed (Underline shows ⌘U) | FIXED (P1) | — |
| TY-U3 | FIXED: Mixed + per-layer values + apply-to-all (with hug refit) for size/leading/tracking/paragraph-spacing/indent, Mixed options + patchTypeMany for family/weight, Auto-reset applies to all. REMAINING (follow-up): align/decoration segs, type-pop selects, min/max fields | FIXED (P1) | — |
| FS-U6 scope+ | RETRACTED with FS-U6: patchType→patch detaches correctly (verified) | — | — |
| TY-U4 | FIXED: same fix — also applied to the three dashboard buttons (Help, New project, Play prototype) that carried both. New suite check: no element under `.tip-host` carries a native `title`. | FIXED (P2) | — |
| TY-U5 | FIXED: hidden wiring div deleted (XPopover is used for real in the effect and bind popovers, so x-ui is in the bundle on merit). | FIXED (P2) | — |
| TY-U6 | FIXED in §4f: the shared component shows its pill on `:focus-visible`, and the `title` bridge does the same for title-only controls. | FIXED (P2) | — |

## §10. Frame/Selection canvas trace (prompts §§6, 8, 27–28) — Canvas render ~2085–2960

CONNECTED & TYPE-AWARE: purple ring for component/instance, accent otherwise; frames 7px squares,
shapes 6px squares, vectors/star/poly diamonds; text-hug side-only handles; line end-only handles;
rotation/flip-aware chrome transform; hover ring + panel-hover highlight; multi = thin member outlines
+ combined box (ring + 8 handles + size badge, hit-tested first). Labels: top-level frames/sections/
groups only (nested skipped), constant 11px, accent when active, off-screen culling, hidden while
presenting; double-click label → inline rename (Enter commits, Esc cancels, empty→"Frame"). Rotate:
zone-based 6–22px (parity-verified) + live angle readout while rotating, size badge otherwise. Extras:
on-canvas gradient handles, star/poly param handles, frame-tool + badges, smart guides + gap badges.

| # | Finding | Status | Pri |
|---|---|---|---|
| FR-U1 | FIXED: locked selection renders a grey dashed ring, no resize handles, and a "Locked" pill (single + all-locked multi; mixed groups keep working handles); dead grab zones toast "Locked · ⇧⌘L to unlock". Patch-based affordances (rotate/gradient/corners) intentionally kept — they work on locked layers | FIXED (P1) | — |
| FR-U2 | FIXED: canvas chrome is a token family now. `styles.css` declares 15 `--cv-*` roles in **both** themes (selection ink / wash / glow, chrome ink, lock, guide, target, mask, on-canvas card + hairline + text, scrim, well, line, dim) and `ui/canvasChrome.ts` reads all 22 of them — the 15 plus the seven the canvases already read ad hoc (`--panel --canvas --grid --canvas-label --comp --accent --accent-wash`) — once per paint: `readCanvasChrome(get)` is pure and testable, `canvasChrome()` does the style read for the minimap and rulers, and `withAlpha()` thins a role so the five incidental `rgba(16,185,129,…)` alphas do not have to be literals either. `COMP_PURPLE`'s "kept in step by hand — change both" comment is gone because the canvas now reads `--comp` itself. The two greens are answered by naming them: `--accent` is the control accent (#0e9f6e light / #10b981 dark, contrast-tuned for panel surfaces) and `--cv-sel` is selection ink on the document canvas (#10b981 in both themes today, i.e. the same pixels as before — retuning it per theme is FR-U2b and needs eyes). What stays literal is **document ink**, named `DOC_*` where it is a constant: a new slice's stroke, paint-bucket defaults, a glass effect's tint, `#00000000` creation fills, the noise renderer's black, a boolean mask's white — values written into saved files and their SVG exports, which must not move with the viewer's appearance. Canvas.tsx 68 → 13 colour literals, Minimap.tsx 4 → 0, Rulers.tsx 5 → 0 (workspace colour drift 195 → 131, ceiling lowered in the same commit). `canvasChrome.test.mjs` (50 checks) is the ratchet: fallbacks ≡ the sheet's light column key-for-key, the dark block declares every role, no chrome literal may come back, and every emerald left in Canvas.tsx is a `DOC_*`. §4r | FIXED (P2) | — |
| FR-U2b | The dark theme now *can* retune canvas chrome — it does not yet. `--cv-sel`, `--cv-ink`, `--cv-guide`, `--cv-target`, `--cv-mask`, `--cv-chip*` and `--cv-scrim` carry the same value in both columns, because changing them is a visible design decision on the one surface this sandbox cannot look at. Only `--cv-well` / `--cv-line` / `--cv-dim` differ (they were already theme-split as literals). One sheet edit each, with eyes, closes this | OPEN (needs eyes) | P3 |
| FR-U3 | Rotate affordance invisible (zone-only = Figma parity, but zero first-time discoverability) — roadmap: subtle corner affordance on hover | ROADMAP | P2 |
| FR-U4 | FIXED: `clampBadge(rect, view, { pad, flipY })` in `ui/zoom.ts` is the only place a painted badge may sit, and both badge sites (single selection and multi-selection) go through it. Below the box when it fits; flipped above it when below is off-canvas; clamped inside the view when neither side fits (a selection taller than the canvas has nowhere to hang), never negative, with the flip rejected if the flip target is itself off-screen — trading one invisible badge for another is not a fix. Nine arithmetic checks on the pure function plus two band-comparison checks in §46. | FIXED (P2) | — |

## §11. Popovers/Modals/Tabs trace (prompts §§17–19, 21–22)

CORRECTION to §2.1: XPopover IS adopted (EffectPopover renders inside it) — and the migration left a
stale guard behind: EffectPopover kept its own outside-click handler matching `.fx-pop`, the class the
shared popover replaced, so the guard matched nothing and **every click inside the shadow popover closed
it** (fields could be opened, not used; Enter/Tab-committed edits from a focused-by-script field worked,
which is why no unit test caught it). FIXED: dismissal is XPopover's alone; only the ⌘D echo remains here.
Still unused: XDialog (now used by DialogHost — see PM-U1), XTabs, XSelect, XSegmentedControl,
PropertyField (except the hidden hack), ContextToolbar. XButton gained forwardRef for the dialogs.
CONNECTED: FillPicker (anchor+flip+clamp, Esc, outside-click, role=dialog), EffectPopover (via XPopover,
nested-picker-aware outside-click), ContextMenu (clamped, Esc, outside, arrow nav incl. submenus),
Actions palette (combobox/listbox/activedescendant, arrows+enter+esc, filters, empty state), NudgeDialog
(Esc capture + veil + close btn), ExportAssetsDialog (veil + global Esc), FigInspectorModal (Esc + veil).

| # | Finding | Status | Pri |
|---|---|---|---|
| PM-U1 (=FS-U2) | FIXED — same work: one XDialog-backed prompt/confirm/choice (no separate XConfirm component was needed; the bus is the wrapper). 32 headless checks on the bus (cancel values, queue order, double-settle, no-host fallback) + e2e §31 (no native dialog call recorded during rename, create, delete, style choice, dashboard project). PM-U6 (focus) covered for the new dialogs: primary action focused, prompt selects its value | FIXED (P1) | — |
| PM-U2 | FIXED: the palette now has a dismissible scrim — click anywhere outside closes it, clicks inside keep working (the sheet is not dismiss-on-any-click), and the scrim swallows clicks so the canvas underneath does not take them. Verified that a click meant for the backdrop did not also touch the document (layer rows unchanged). | FIXED (P2) | — |
| PM-U3 | Two Esc patterns: component-local (Nudge capture, FillPicker, EffectPopover, ContextMenu) vs App-global closeOverlay (export/actions/find/figInspector) — both work, inconsistent ownership | DRIFT | P2 |
| PM-U4 | FIXED: the nudge form is now the shared `XDialog` — same chrome, `aria-modal`, backdrop/close-button dismissal, and one Escape owner (its own capture-phase handler is gone; that handler was also fighting the editor's global Escape). Values, commit-on-blur/Enter and persistence unchanged (verified 7 → stored). | FIXED (P2) | — |
| PM-U5 | FIXED: the hand-rolled variants are gone — inspector head tabs → `XTabs`, the Variables/Styles switch and both Dev Mode switches (Inspect view, Code scope) → `XSegmentedControl`, which until now had **zero** call sites while the app hand-wrote `.seg` everywhere. All three share one roving-focus + arrow/Home/End model (`tablistKeys`). Chrome was held to be identical: the pane switch keeps the selection token, the compact dev segs keep their elevated active state (a first cut made them green — caught in review and scoped to `.pane`). Remaining out-of-family: the left NavRail (vertical, its own layout — not a tab strip) and the dashboard's filter tabs, which are a different surface. | FIXED (P2) | — |
| PM-U6 | FIXED: the sheet focuses its filter field on open, which is both the first control in the sheet and the first thing worth doing in it — every other modal input in the app (shortcuts, find-in-page, the palette) already did. The dialog also says `aria-modal="true"`, which it did not, so a screen reader was not told the document behind the veil is inert. §46 types into it with no click first and watches the list filter. Focus *restore* on close is still the App's (the sheet is closed by the global overlay owner, PM-U3), so the caret returns to `<body>` rather than to the command that opened it. | FIXED (P2) | — |

## §12. Left panel + states trace (prompts §§20, 23–25) — NavRail + LeftPanel + App screens

CONNECTED: 5 panes on local nav state (memo'd panel); layers = search, pages (twist + Esc-cancel
rename), tree w/ arrow nav, ⌥-fold, DnD, inline + ⌘R rename, reveal-on-select + scrollIntoView,
masked/locked inheritance, context menus, collapse-all; assets = components/images w/ teaching empties;
vars/styles subtab w/ guarded bind; tools = 7 quick actions; agent = keyword stub. States: missing-file
screen, opening screen, corrupt→toast ("started a new one", 4s — no silent loss ✓), export-nothing +
palette empties, Dashboard busy + failure toasts, font/PDF/export failure toasts.

| # | Finding | Status | Pri |
|---|---|---|---|
| LP-U1 | FIXED: RightPanel/PageDesign take onOpenVariables from App (setNav("variables")); legacy setLeftTab kept as fallback only. FS-U1 pass: DesignHealth's variable-issue jump + Design's empty-picker CTA threaded the same way (same fallback) | FIXED (P1) | — |
| LP-U2 | FIXED: `leftTab` deleted outright (type, snapshot field, command, engine state, undo list) and all 8 writers re-pointed at the App nav the panel actually reads. ⌥1..3 now switch panes, ⌘R opens the layers pane before dispatching rename, and the palette's variable row opens the Variables pane (it dispatched into dead state before, so the row did nothing). Inspector entry points without the callback toast where to look instead of dispatching into the void. ⚠️ Worth noting: this dual truth is exactly what produced the LP-U1 P1 bug, so removing it is the fix, not cleanup. | FIXED (P2) | — |
| LP-U3 | FIXED: the layers tree now has the two sentences it was missing. An empty page renders the inspector's own `.empty-state` recipe inside `.tree` — icon, "No layers on this page", what a row will let you do (name, group, hide, lock, reorder) and the real chords (`F` frame · `R` rectangle · `T` text, `⌘K` for every command) — and a search with no hits renders `.empty` with the term quoted ("No layer matches “q”. Clear the search to see the whole page."), which is the palette's `.actions-empty` sentence in the panel that filters. The two are told apart by the panel asking `matchesLayer`, the same predicate each row uses to hide itself, so the tree and its rows cannot disagree. No new CSS recipe and no new control: 25 checks in `leftpanel.dom.test.mjs` (jsdom, mounted `LeftPanel` on an emptied document) plus §44 in the browser. §4s | FIXED (P2) | — |
| LP-U4 | FIXED, at the scope the finding asked for ("minimal dismissible empty-canvas hints"): one card over an empty canvas — "Draw your first layer", the three chords as `<kbd>`, and what the Layers list will do with the result — that retires the moment the page holds a layer and is dismissed for good by its own `XButton` ("Don't show this again"), persisted by `ui/firstRun.ts` under `x-native-hint-empty-canvas`. The card takes `pointer-events: none` with only its button opted back in, so it cannot eat the drag it is describing (the `.cm-layer`/`.cm-pin` recipe); it is seeded from the persisted dismissal before first paint, so it never flashes for someone who has already closed it; and every localStorage access is guarded and injectable, because it throws in private mode and does not exist in node. No entrance animation — that is MOTION-U1's round, with eyes. 24 checks in `firstRun.test.mjs` (hostile stores, the key's namespace, the source contract) plus §44's draw-through-it, dismiss, reload, empty-again sequence. §4s | FIXED (P2) | — |
| LP-U5 | FIXED: the pane stopped claiming plugins ("Actions on this file — every row is a palette command, with its chord") and became a command list: seven rows, each wearing the palette's own chord in the `.sc` chip every menu uses (`⇧I ⌘D ⌘G ⌘Z ⇧⌘Z ⇧0 ⌘K`), and each command that cannot run is `disabled` — Duplicate/Group without a selection, Undo/Redo without history — instead of swallowing the click. The reason is a line of text at the bottom of the pane naming what is missing, not a tooltip: a dead control cannot receive the pointer that would show one, and `title=` is at its ratchet ceiling in this file. `LeftPanel`'s memo comparator gained `canUndo`/`canRedo`, because a history-only change moves no document field it compared. §4t | FIXED (P2) | — |
| LP-U6 | FIXED, at the scope the finding named ("scope feedback"): every ask now gets an answer. A matched one reports what it created from the same values it dispatched ("Added a frame — iPhone 16 Pro, 393 × 852 — centred in your view and selected."); an unmatched one says nothing matched, repeats the three things the pane can do, and states that it changed nothing. Placement is derived, not guessed: `viewportCentreWorld(snap)` in `ui/zoom.ts` puts the layer at the world point under the middle of the visible canvas (cascaded 24px per ask so two frames do not stack), and sizes come from the inspector's own `PRESET_GROUPS`, now exported and shared — the invented 390×844 matched no preset the inspector would recognise. The transcript keeps both voices (`data-who`), wraps instead of ellipsising, and the greeting no longer promises colour, which the pane cannot do. §4t | FIXED (P2) | — |

## §13. Import/export + responsive + icons/motion sweep (prompts §§12, 24, 31)

CONNECTED: import = canvas file-drop at cursor, global paste (SVG/text), Dashboard SVG/Sketch/Fig w/
busy state; all failures toasted w/ reasons. Export = per-layer Export section, bulk dialog (3 entries:
palette ⇧⌘E, layers-pane button, section link), copy-as SVG/PNG/code, PDF print path. Icons (§12):
PASS — disciplined 12/14/16 + caretSize/rowIconSize helpers (20px only for logo marks). Motion (§31):
PASS — restrained (120ms control fades, 140ms palette entrance, 180–280ms prototype transitions; never
blocks interaction). Responsive foundations: bounded panel drags (180–420/200–420), minUi ≤860px panel
overlays, min-width discipline in grids/rows, viewport-clamped popovers/menus/tooltips, responsive
palette (max-width/max-height/scroll).

| # | Finding | Status | Pri |
|---|---|---|---|
| RW-U1 | FIXED: the dock is bounded by the column it hangs in (`max-width: calc(100% - 24px)`) and wraps into a second row instead of running off the screen — `.toolset` wraps too, with `min-width: 0`, so a tool row wider than the stage folds rather than overflows. Wrapping rather than the scroll the finding suggested, because a scroll container clips the tool flyouts as well: `overflow-x: auto` computes `overflow-y` to `auto`, and those menus escape 40px above a 44px strip. That is what the ≤860px override did, so on a phone the boolean menu was opening into a clipped box; the override is gone and the dock's computed `overflow` is `visible` at every width. §4u | FIXED (P2) | — |
| RW-U2 | All window-size behavior code-verified ONLY (1280/1440/1920/2560 + narrow/wide need a browser) | NOT VERIFIED visually | P2 |

## §14. Senior designer critique (prompt §26) — evidence-linked, no subjective language

- INFORMATION ARCHITECTURE: two nav truths coexist (local `nav` drives the panel; engine `leftTab` is
  write-only) which made the "Open variables & styles" button dead (LP-U1); the view menu lives inside
  the inspector tab bar (PT-U6), so canvas-display toggles are found by accident, not by structure.
- VISUAL HIERARCHY: inspector `Section` vs ad-hoc `h-row` headers (IN-U3) give identical-rank content
  two different weights; the vector card's `<strong>` header is a third.
- DENSITY: appropriate for a pro tool (11px type scale, compact rows); ToolsPane wasted its density on
  7 shortcut-less buttons until §4t (LP-U5) — each row now carries its chord and its disabled state.
- CONSISTENCY: four tab systems (PM-U5, open), one tooltip system (§2.3 FIXED), two Esc owners (PM-U3),
  `export-run` class reused for Present/vector-Done (PT-U2/IN-U4), two accent greens — since §4r two
  *named roles* (`--accent` for controls, `--cv-sel` for selection ink on the canvas) rather than one
  literal and one token that happened to disagree (FR-U2).
- DISCOVERABILITY: prototype tab (TB-U3), italic (TY-U1), property-first binding (FS-U1), ⇧E/⌘⌥↩ chords
  (TB-U6/PT-U7) and the rotate zone (FR-U3) are unreachable without prior knowledge; the empty canvas
  and the empty layers tree taught nothing at all until §4s (LP-U3/LP-U4).
- AFFORDANCE: locked selections show editable handles that refuse (FR-U1); "Edit vector" flattens
  (IN-U5); Resources opens the command palette (TB-U1); duplicate Outline-stroke buttons diverge (IN-U2).
- FEEDBACK: bound-value edits vanish without notice (FS-U6); the AgentPane swallowed unmatched input
  until §4t (LP-U6); multi-select shows first-layer values as shared (IN-U1/TY-U3).
- ERROR PREVENTION: guard toasts on binding (good); destructive mode/collection delete now names what is lost
  and uses a red confirm instead of a native OK/Cancel (PM-U1 FIXED);
  corrupt→toast + fresh doc (honest, minimal).
- ACCESSIBILITY: align/valign/decoration buttons have no accessible name at all (TY-U2 FIXED); tooltips
  are pointer-only (TY-U6 FIXED — both the shared component and the `title` bridge now show labels on
  `:focus-visible`, and the bridge names controls that had no accessible name); tool flyouts/menu-less
  popovers lack keyboard paths (TB-U2 FIXED); dialogs lack initial focus (PM-U1's dialogs FIXED, the export
  sheet in §4u); canvas chrome is
  color-only for lock state (FR-U1 FIXED with a dashed ring + "Locked" pill).
- KEYBOARD WORKFLOW: palette/tree/menus have arrows; flyouts, tabs, orientation segs, and the dock have
  none; shortcuts exist but are advertised inconsistently (⌘/ claimed twice, ⇧E/⇧F hidden).
- CANVAS/INSPECTOR/TOOLBAR/POPUP/MODAL: canvas chrome is the strongest surface (type-aware, culled,
  badged); inspector has the best primitives (Section/Field) with the worst multi-select honesty;
  toolbar has a duplicate + mouse-only flyouts; popovers are individually good but unshared; modals are
  bespoke + native-dialog-backed.
- TOKEN NAMING: `--blue` holds the accent green (#0e9f6e / #10b981) in both themes — so the global focus
  ring is green everywhere, and a destructive confirm needed an explicit `outline-color` override to stop
  reading as the safe action. Renaming the token is a wide, risky sweep; recorded, not done.
- TYPOGRAPHY/ICONOGRAPHY/SPACING/COLOR: type scale + icon scale disciplined (12/14/16); spacing and
  radius have NO token scales (ad-hoc gaps/radii everywhere); color tokens complete incl. dark theme +
  green/red/amber, but canvas + chips bypass them with hardcoded values.
- MOTION/PERFORMANCE PERCEPTION: motion restrained and non-blocking (pass); memo'd panel/tree + hover
  guards show perf intent; full-snapshot subscriptions remain the structural risk (§33 — not measured
  here for lack of a browser).

## §4b. Behaviour suite status (PM-U1 pass, 2026-09-26)

The suite is runnable in this sandbox again: `npm i -D @sparticuz/chromium`, brotli-extract `al2023.tar.br`
and launch with `CHROMIUM_PATH=/tmp/chromium CHROMIUM_LIBS=/tmp/al2023x/lib npm run test:e2e`. The sandbox
resets between sessions and takes `/tmp` and `node_modules` with it; `/home/user/restore.sh` redoes the
branch tip, the install and the browser in one shot (it uses `reset --mixed`, so uncommitted edits survive).
**166 pass / 16 fail** as of the edge-drop fix in §4c (161/20 before it; the row-addressing round was
161/20 as well). **Attribution measured, not assumed**: the identical suite was run against `0a910ce` on
a second port — 30 failures there, 16 now, with no check that passed at baseline failing at any later
step. The checks fixed along the way: the 5 dialog checks, the effect-popover check that could not run
before (its guard bug is above), the TY-U3 row-addressing repairs, the three stroke/import checks the
§4c drop-point bug was hiding, and the new edge-drop regression check.

Was previously unreachable: the suite died at §10 on a stale selector (the colour-copy "+" moved into the
Vars pane's Styles subtab), so §§11–30 had **never executed in this environment**. Fixed, plus three more
blockers: §18's effect popover selectors (`.fx-pop` → the shared `.x-popover`, fields addressed by name),
every `clickRow` helper (`.panel.left .row` now starts with the Pages list, so index 0 was a *page* —
clicking it switched page and shift-clicking it cleared the selection), and §TY-U3's text setup
(crash-proof + a deselect first, since T on a selected text layer edits it).

Open, pre-existing (each verified failing at baseline, all outside PM-U1/FS-U1) — the 16 remaining:
`Card keeps corner radius 8 and stroke 2` and `.fig keeps radius 8 and stroke 2` (radius reads 8, stroke
reads s0), `.fig fills render (3243px red, 0px green)`, the style family (`creating a style lists it`,
`one style edit repaints every bound layer` — red is now 10365 but blue 0, `styles survive a reload`, `the
style list survives a reload`), `a style can be created from the stroke`, `a bound selection offers
detach`, `every inspector section is collapsible` (stale: asserts 8, the panel has 10–11), `three effects
do not overflow the panel` (`.inspector{overflow:auto}` is by design — stale, see §4d), `clicking centres
the viewport (dx=10, dy=1)`, `locked selection drops the accent (554px)`, `two selected layers show the
boolean menu`, `New file resets to a blank document (24->24, base 23)`, and the corrupt-save toast. The
three stroke/import checks that used to head this list are fixed — see §4c.

**CORRECTION to this section's earlier claim.** The TY-U3 text-size failure was reported here as a product
finding — "dragging with the text tool creates the layer at a position unrelated to the drag". That was
wrong, and the error was mine, not the app's. Dragging with the text tool places the layer correctly:
clicking back at the drag point re-selects the layer it just made — for a top-level draw, for a draw over
the sample document's "Success" frame, and for a rect drawn the same way — and rect and text land on
identical coordinates (three browser runs). What actually failed was the *test*: it selected rows by
index, and the panel groups children under their parent and orders newest-first inside each group, so the
rows it clicked were the sample document's own layers. Rows carry `data-row-id`; the suite now addresses
them by id and extends a selection with ⌘/Ctrl-toggle rather than a shift range (a range spans every row
*between* two layers — the whole tree when one of them nested into a frame).

## §4c. CORRECTION — the "inside-aligned imported stroke paints nothing" P1 was a phantom; the real bug was where an edge drop lands (2026-09-26)

**Retracted.** A stroke that arrives through the SVG importer with `strokeAlign: "inside"` does not fail
to paint. The node was invisible because the **whole import had landed outside its parent frame's clip**,
and the stroke question never entered into it.

Repro (unchanged): dropping

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="220" height="160">
  <rect x="30" y="30" width="160" height="100" fill="#dddddd" stroke="#ff0000" stroke-width="10"/>
</svg>
```

at client (800,520) over the demo file gives 0 red px, and the node's model is `x 390, y 637, w 160, h 100`
inside the "iPhone 16 Pro" frame (`box [80,60,390,844]`, `overflow: "clip"`).

What those coordinates mean (read off a temporary instrumented `placeNodes`, since removed): `at` is a
**world** point, and the host-local drop point was `origin = {x: 389.76, y: 637.11}` with `host.w = 390`.
Client x 800 is *exactly* that frame's right edge at this viewport, so the drop point sits 0.24 host px
inside it. The artwork is anchored top-left at the cursor, so 159.76 of its 160 px width hang outside the
frame — the part inside the clip is a sub-pixel sliver, hence 0 red px.

Evidence that clears both the importer and the painter:
- Moving the imported node to local x = 150 (inspector X field) paints **2155 red px**. The stroke that
  "paints nothing" paints normally the moment it is inside the frame; nothing about the import is broken.
- The same file, one fresh page per drop, paints wherever the cursor is not on a frame edge: over
  "Success" 2170 px, on empty canvas 2170 px, inside "Filter Sheet" 2162 px.
- The alignment buttons (center 180 / outside 553 / inside 0) were measuring that same, already-invisible
  node; the counts track the model but say nothing about alignment. The painter recording
  `{lineWidth: 14.75, strokeStyle: "#ff0000"}` was likewise a stroke being asked to draw off-clip.
- The pale 1-px `240,203,206` column at x=508 was the antialiased edge of that sliver, not a faint stroke.

Measurement hygiene, because it cost the most time: earlier pixel counts were read cumulatively from one
long-lived page while importing file after file, so successive "0 → 639 → 2239" readings were not
comparable to each other. And the `.sketch` failure that looked related was a second instance of this same
clipping: the imported artboard's green dot sat just outside the frame that clipped it (green 1051 px once
dropped on empty canvas, 0 over the frame).

**Fix — `ui/Canvas.tsx` (`placeNodes`).** After the anchor is computed, an axis whose visible overlap with
a clipping host is under 1 px is pulled inside that host: flush to the far edge when the artwork fits,
else flush to the host's origin. Artwork that already shows a pixel or more is untouched, and any drop
that is not inside a frame is untouched.
- Regression check added: "an import dropped on a frame's edge stays visible" (the (800,520) drop) —
  0 px before the fix, 2156 px after.
- The `.sketch` check now drops on empty canvas, because it measures whether fills survive the round trip
  and was otherwise measuring the clip instead.

Suite effect: 161 pass / 20 fail → **166 pass / 16 fail, 0 regressions**. Besides the new check, three
pre-existing failures were cured by the same fix — "base stroke renders", "both strokes and the fill
render together" and "undo steps back through the stroke stack" all dropped their SVG onto that same
frame edge. The `.fig` fills and the style checks were *not* this bug and are unchanged.

## §4d. Suite-side corrections found while checking the remaining failures

- "every inspector section is collapsible" asserts **8** sections; the panel now has **10** (Typography, Position, Layout, Appearance, Fill, Stroke, Effects, Modifiers, Expressions, Selection colors, Export — 11 on a text layer). Every one of them collapses and re-expands when clicked (verified in the browser). The number is stale, not the behaviour.
- "three effects do not overflow the panel" asserts `scrollHeight <= clientHeight` for `.inspector`, which is `overflow: auto` by design (styles.css) — a scrolling panel is the intended shape, so the check asks for something the app deliberately does not do. The meaningful version of it is "the effect *rows* stay one line", which already passes.

## §4e. The e2e backlog, closed out (final round)

**One real bug, found by the suite and fixed in the product.** "New file…" promised to delete the stored
file and start a new one, but it only called `clearDoc()`, which clears the legacy autosave slot
(`x-native-document`). The editor also writes a per-file copy (`x-native-doc:<id>`, `engine/files.ts`) on
every autosave, and boot prefers it — so the reload restored the document the user had just confirmed
deleting, and the `pagehide` flush rewrote the legacy slot on the way out. Measured: 24 layers before the
command, 24 after. The editor now replaces the file's stored document with a blank one (name kept) and the
autosave flush respects the suppression; the same probe reads 24 → 1, stored document 0 layers. Locked with
`src/engine/__tests__/files.test.mjs` (blank replaces the drawn doc, name survives, suppression holds).

**Four checks were asserting things the UI no longer does**, and one was measuring the wrong pixels:

- *corrupt save warns the user*: `#/file/demo` now has its own stored document, so the legacy slot is never
  read and `restoreFailed` cannot fire. The hostile payloads are aimed at the fallback path, so the check
  boots an **unstored** id — where the toast appears, with zero page errors.
- *locked selection drops the accent*: the demo document paints `#10b981` itself, so "accent pixels < 60"
  could never be true without subtracting a baseline, and the baseline was captured *after* the selection
  existed. With an idle-canvas baseline: 1300 px of accent chrome while selected, 0 px once locked, grey
  chrome +1075 px.
- *clicking centres the viewport*: the predicate matched blue document ink rather than the accent-green
  viewport rectangle the minimap draws. Measured on the right rectangle, a click at 25 %/50 %/75 % moves
  the view to −10.5 / −5.5 / −0.5 px of centre — the thumbnail refits to the union of document and
  viewport, so a few pixels of slack are expected; tolerance is 12 px. (`Minimap.tsx` maps the click
  correctly.)
- *boolean menu / inspector sections / effect overflow*: selection now comes from `findNodes` + layer rows
  (a marquee must start on empty canvas, and that corner of the demo is covered by frames); the section and
  effect checks pin the capability rather than the counts.

**Suite: 187 pass / 0 fail** (was 166/16 at §4c, 178/7 before this round). Unit tests 1621 + 6 new, tsc and
build clean. Pushed as `d2140b7`.

## §4f. P2 round 1 — the tooltip/a11y split (was §2.3 + TY-U6, both P1)

The largest remaining P1 item was the tooltip split: 328 native `title=` sites against 29 `<Tooltip>`
usages, which is why the same control could show a plain 1.5s browser box in the inspector and a styled
pill with a shortcut chip in the toolbar. Sweeping 328 call sites is a wide, mechanical change that would
have churned every file; the bridge closes the split at the source of truth instead — one pill, one delay,
one shortcut rule, one accessible name, for both kinds of control (details in §2.3).

Verification: 13 new headless checks on the split rule + `showDelay` chain (`tooltip.test.mjs`), 8 new
browser checks in e2e §32 (name up front, hover shows the pill with a chip, native attribute parked while
it shows, placed above the control, attribute restored on leave, keyboard focus for both kinds of control).
Suite **195 pass / 0 fail**; unit 1621 + 19; tsc and build clean. The suite's own `title=` selectors now
read `title` *or* `data-tip` (5 sites, inline) so a resting pointer cannot hide a control from a check.

**P2 backlog after this round: 34 rows, three families.** Ordered by leverage:
1. **`x-ui` adoption drift (~14 rows: PT-U3/4/5, IN-U3/4/6/7, TB-U4/5, FS-U4, TY-U4, PM-U2/4, LP-U5)** —
   raw selects/inputs/inline styles where the design system already has the component (the shared layer
   exists and is documented; the surfaces just do not use it). Highest value-per-change: each is a
   mechanical swap to XButton/XSelect/XSection/XTabs with no behaviour change.
2. **Two dead affordances (PT-U1 no-op handler, TY-U5 dead UI, LP-U2 dead state)** — cheap, visible.
3. **IA / missing UI (PT-U6 view menu inside the inspector tab bar, ~~LP-U3/LP-U4 first-run and empty
   states~~ — done in §4s, FR-U3 rotate zone, ~~RW-U1~~ done in §4u, RW-U2 unverified visual states)** — needs a design
   decision, not a sweep.

## §4g. P2 round 2 — one inspector header chrome (IN-U3, PT-U1)

Same story as §4f: the inspector already had the right primitive (`Section`) and used it for most of the
panel, while eleven blocks — Component/Instance, Boolean, Star/Polygon, Frame Presets, Background, Local
styles, Pixel grid, Flow starting point, Prototype settings, Interactions, Annotations — wore a bare
`h-row` + `h3` instead. Two headers for the same rank of content is exactly the drift §29 warns about, and
the bare ones silently lost three capabilities the `Section` has: folding, the folded preference surviving
a reload, and the `x-native-open-section` scroll-to hook other features use.

The styles were already identical (`h3` and `.sec-toggle h2` are both 11px/500/`var(--muted)`), so the
migration is chrome-neutral: folded/unfolded verified per surface in the browser (screen 41→37→41 controls,
text layer 95→45→95, Boolean 64→58→64 buttons, all restored), and the Component/Instance action row moved
into the section's `actions` slot with its buttons intact. Two headers stay bespoke because they carry live
chrome a plain title would drop: `Design health` (score + issues) and the Dev Mode `Inspect` header
(status dot + view tabs).

Suite **202 pass / 0 fail** (7 new checks in §33: the boolean block folds and restores, all three prototype
blocks are sections, fold/reopen round-trips). Unit 1621, tsc and build clean.

## §4h. P2 round 3 — dead state and dead UI (LP-U2, TY-U5, TY-U6)

`leftTab` was engine state that eight call sites wrote and nobody read: the left panel had already moved to
App-owned `nav`, so the palette's variable row and ⌥1..3 switched "nothing" while the working `onNav` path
sat next to them. That is the same dual truth that produced the LP-U1 P1 bug, so it was deleted rather than
documented — type, snapshot field, command, engine state and undo list — and each writer re-pointed at the
nav the panel reads. Now ⌥1/2/3 switch panes, ⌘R opens the layers pane before dispatching rename, and a
palette variable result opens the Variables pane (verified in the browser: typing the file's first variable
and picking the row lands on `Vars` with the toast naming that tab). Inspector entry points that have no
callback now toast where to look rather than dispatching into dead state.

Also removed: a `display:none` div whose only job was to force `PropertyField` into the bundle (TY-U5) —
`XPopover` is used for real in the effect and bind popovers, so the shared layer ships on merit.

Suite **206 pass / 0 fail** (4 new checks in §34), unit 1621, tsc and build clean.

## §4i. The double-label trap the tooltip bridge would have sprung (§4f follow-up)

Wiring one tooltip surface made a latent inconsistency visible: five controls carried **both** labels — a
`Tooltip` wrapper *and* a native `title` (the toolbar carets "More tools (n)", the round-to-pixels button,
and the dashboard's Help / New project / Play prototype). With the bridge in place their hover would have
rendered two boxes at once. Fixed on both sides: the redundant `title` attributes are gone (the caret also
gained the `aria-label` the native tooltip had been standing in for), and the bridge now refuses to adopt a
label inside a `.tip-host` — the shared component owns those, so a re-added title can no longer double up.

New check in §32 scans for any `.tip-host [title]` and fails with the offending labels. Suite **207 pass /
0 fail**; the dashboard's "New project" check now selects by accessible name rather than by the tooltip.

## §4j. "Edit vector" that flattened, and the Escape it exposed (IN-U5)

The vector row offered two buttons for one action: "Edit vector" and "Flatten" both dispatched `flatten`, so
the first label promised point editing and delivered a bake. It is now the inspector's twin of
double-clicking a layer — it enters vector edit mode (reading "Editing points" while open), and booleans
still bake first because their points only exist once the group is applied. "Flatten" remains the bake.

**What the fix uncovered:** Esc out of the point editor cleared the selection. The canvas has always
guarded this (`setVecEdit(null)` + `stopImmediatePropagation`), but it can only guard keydowns it hears —
the App's Escape cascade in `bindHotkeys` deselects without knowing edit mode exists, and when focus is in
the inspector (which is where the new button lives) the cascade wins. Result: leaving the editor dropped
the layer and sent the inspector back to the page panel. The cascade now yields to path editing exactly as
it already did to pen drafts and to open popovers, so Esc leaves the editor and keeps the layer; a second
Esc walks up/deselects as before. This is a small piece of PM-U3 (two Escape owners) paid down at the
cascade rather than by adding another owner.

Suite **212 pass / 0 fail** (§35: distinct actions, edit mode entered, Esc keeps the layer, flatten still
converts), unit 1621, tsc and build clean.

## §4k. One tab primitive, three call sites (PM-U5, IN-U7)

The shared layer had a segmented control nobody used: `XSegmentedControl` had **zero** call sites while the app
hand-wrote `.seg` markup in 22 places, and the Variables/Styles switch was two buttons with identical inline
styles that drifted from every other switch. Three strips now share one primitive and one keyboard model
(`tablistKeys`: roving focus, arrows, Home/End, activating as they move):

- inspector head tabs → `XTabs` (`role=tablist`/`tab`/`aria-selected` added; `aria-current` kept so the
  underline styling and the checks that read it still pass; the zoom menu sits in a `.tabs-row` so the
  divider still spans the strip),
- the Variables/Styles switch → `XSegmentedControl` with the pane variant, which keeps the selection token
  the hand-rolled pair had,
- both Dev Mode switches (Inspect view, Code scope) → the same component with the compact `.dev-seg` size,
  and in-card segs deliberately keep the plain elevated active state so the migration stays chrome-neutral
  (the first cut tinted them green; caught in the screenshot pass and scoped to `.pane`).

Suite **222 pass / 0 fail** (10 new checks in §36: roles and selection state on all three strips, roving
focus, arrows switching the inspector tab and the pane — with the panel actually following — Home, no inline
styles left on the pane switch). Unit 1621, tsc and build clean.

## §4l. Palette dismissal (PM-U2)

The quick-open sheet closed on Escape, on running a row, or on its own close button — a click anywhere else
left it sitting over the canvas, and that click reached the editor underneath. It now has a scrim: clicking
outside dismisses it, clicking inside does not (the sheet is large and full of controls, so
dismiss-on-any-click would be hostile), and the backdrop swallows the press so the document is untouched —
verified by clicking well clear of the sheet and finding the layer count unchanged.

Suite **228 pass / 0 fail** (6 new checks in §37), unit 1621, tsc and build clean.

## §4m. The nudge form stops dressing as help (PM-U4)

Nudge amounts is a preferences form; it was built from the shortcuts sheet's chrome (`help-pop` /
`help-card` / `shortcuts-head`), which is why it read as documentation rather than settings, and it carried
its own capture-phase Escape handler — a second Escape owner fighting the editor's global one (the PM-U3
family). It is now the shared `XDialog`: same chrome as every other modal, `aria-modal`, backdrop and
close-button dismissal, Escape handled once, values and persistence unchanged.

Suite **232 pass / 0 fail** (4 new checks in §38), unit 1621, tsc and build clean.

## §4n. Canvas chrome is a dock — and a dead Escape branch (PT-U4)

The chip and the vector strip were the last two surfaces on canvas painting themselves near-black
(`#18181b` + white text), each with ~10 inline style objects per control, so nothing on the canvas could
follow the theme and the two had already drifted from the HUD and the contextual toolbar floating right
above them. Both are `.canvas-dock` now: `--dock` + blur, `--line-2`, `--tool-fg`, `--elev-floating`, with
`--hover`/`--active` states, an accent `--accent` ring on the selected connection, and `--accent` /
`--on-accent` for Done. The only inline styles left inside either surface are the Icon component's own
sizes. Light and dark were both screenshotted, and the theme is asserted in the suite.

Fixing the chip exposed why Escape "did nothing": in the canvas key handler the pen-draft branch cleared an
empty draft and returned for *every* Escape, so the rotation-origin, vector-edit and selected-connection
branches below it were dead code. Scoping that branch to a real stray point was necessary but not
sufficient — instrumenting the handler showed it only ever receives **keyup** for keys the global hotkey
layer also handles (its own listener re-registers on state change and lands after the hotkey layer's, which
is exactly what `ui/penDraft.ts` documents). So the chip now publishes its dismissal the same way the pen
draft does (`ui/connSelection.ts`), and the Escape cascade answers it: real Escape dismisses the chip,
keeps the layer selected, and leaves the interaction intact.

Suite **242 pass / 0 fail** (10 new checks in §39), unit 1621, tsc and build clean.

## §4o. The player is chrome — and its pager was lying (PT-U5)

The presentation player was the one surface no token reached: eleven inline style objects carrying
`#18181b`, `#fff` and `rgba(255,255,255,0.7)` per control, each toggle saying "I am on" only by its own
inline colour, and the browser's own tooltip box instead of the shared pill. It is `.player-dock` now —
the class owns the stage's palette (`--stage-fg/dim/faint/line/fill/well/hover/…`) with `.player-select`,
`.player-btn` (+ `.on`, `.on.green`, `.exit`), `.player-page` and `.player-sep` — so the player is *one*
place to change instead of eleven, the stage layer's geometry moved to CSS with it, and `.player-btn` got
its first hover state. Toggles expose `aria-pressed`, and the two "on" hues (hotspots blue, live inputs
green) survive as the modifier classes they were always meant to be.

Verifying it turned up a second defect, in the pager. It listed **every frame in the document**, while
`presentGo` lands on the outermost frame containing the destination (§23 PT-002) — so in the sample file
"2. Card", a frame nested inside the phone frame, was a step that went nowhere: clicking Next grew the
back stack and left the stage on screen 1, and the frame chooser offered the same dead entry. The step
list is now the frames the player can actually reach (a nested frame is kept only while it *is* the
frame being presented, so the pager still shows where the presentation is): 1/3 with all three steps
landing, prev disabled at the start, next disabled at the end. The same list drives the chooser and the
arrow keys, so all three agree.

Suite **253 pass / 0 fail** (11 new checks in §40 — dock chrome, all 13 controls, `aria-pressed`, the
three steps, idle slide-away, shared tooltip, Exit), unit 1621, tsc and build clean.

## §4p. The prototype panel is one set of controls (PT-U2, PT-U3, PT-U7)

The panel's rows carried a borderless 24px select while the interaction card's selects kept the browser's
12px default — the same control looked like two different things one row apart — and the whole card was
built from six inline grids. The controls now share one recipe (`.proto-row` / `.proto-interaction`
selects and inputs, accent focus ring) and the card has real classes for its sections (`.proto-top`,
`.proto-pair`, `.proto-anim`, `.proto-cond`, `.proto-check`, `.proto-ease`); the last inline style in the
whole component is the easing curve's `overflow: visible`. The icon-only buttons in the area (orientation,
add/remove interaction, add/remove condition) were already riding the shared tooltip bridge, so they were
left alone rather than given a second label.

"Present Prototype" was `.export-run` — the class is named for the export sheet's Run button, and every
full-width action had copied the name, Present included. The recipe now has a semantic name (`.x-primary`)
with `.export-run` kept as an alias for the remaining callers (PT-U2). And the Present chip advertised
"Esc to exit" — a sentence in a shortcut slot, describing the key that *leaves* a presentation, while the
chord that starts one (⌘⌥↩, which the palette lists and `bindHotkeys` implements) was never shown
(PT-U7).

Suite **260 pass / 0 fail** (7 new checks in §41), unit 1621, tsc and build clean.

## §4q. P2 round 4 — the last bespoke card, and the dock's last inline paint (IN-U4, TB-U5)

Two surfaces were left that styled themselves instead of reading the sheet: the inspector's vector
card and the dock's boolean flyout. Both are now composed from the primitives the rest of the product
uses, and — the part that matters for the next round — both are now *verifiable in this sandbox*.

**The vector card (IN-U4).** It was the one block in the panel that no shared component reached: a
`<strong style={{fontSize:11}}>` header, four `export-run` buttons resized by inline padding (a class
named for the export sheet's Run button, doing double duty as a small pill), a hand-written row of six
24px icon buttons, raw `<input type="number">`s with no accessible name, and `#fff`/`#ffffff` typed
onto two accent buttons so the accent's own ink never reached them. It is a `Section id="vector"` now
— so it folds, persists and answers the `openSection` bus like the eleven blocks around it — with
`Field` for the vertex numbers (which brings arithmetic, label-scrub and a name for free: `100/4` and
`+5` now work on an anchor point), `XSegmentedControl` for mirroring and the offset join, `XButton`
for the header and the four actions, `.x-btn-primary` for Apply, and the panel's own `.align > .g`
idiom behind `Tooltip` for the six alignment actions. Geometry moved to `.vec-*` classes.

One decision worth recording, because it is the kind of thing a component library quietly gets wrong:
the alignment row is **not** a segmented control. Those six are one-shot actions on the selected
points, and `role="tab"` claims a panel is being shown — a selection the points do not have. It also
would have broken the keyboard: `XSegmentedControl` derives its roving tabindex from `value`, and an
action row has no value, so `tabIndexFor` returns −1 for every tab and the row leaves the tab order
altogether. The layer-alignment row two sections above already had the right shape, so the card takes
it — and names its buttons for what they move (`Align points left`, not `Align left`), because ⌥A and
friends belong to the layer row and `vectorAlign` has no chord to advertise.

The vertex fields are named `Vertex X` / `Vertex Y` / `Vertex corner radius` for the same reason the
e2e suite addresses fields by aria-label rather than position: the panel already has an `X`, a `Y` and
a `Corner radius`, and a second field with the same name makes `field(p, "Corner radius")` — and a
screen reader — read the wrong one.

**The dock (TB-U5).** The boolean tool was the only menu in the dock that laid itself out inline:
`style={{width: 180, left: 0}}` on the `.fly` (narrower than the recipe's own 220px min-width, so it
was the one menu clipping its chord chips), `style={{width:"auto", padding:"0 6px", gap:3}}` on its
trigger, and an inline hairline separator. Every tool group already had the recipe it now uses:
`tool split`, a `.caret` gutter, a plain `.fly`. The other two inline objects in the Toolbar (the
multi-select `.toolset` and its count label) became `.toolset.multi` / `.sel-count`, and the
vector-edit **Done** button — an inline accent with a hardcoded `#fff` — became `.hit.vec-done` on
`--accent`/`--on-accent`, which is the fix that actually matters: the dark theme's accent ink is
`#0a0e13`, so white-on-accent was illegible there. The dock now carries no inline style outside
`Icon`'s own svg box. A `.h-act` class also replaces the Component section's inline action row, the
last leftover of IN-U3.

**Verification — a new tier, because this sandbox has no browser.** Chromium cannot be fetched here
(`googlechromelabs.github.io` and `storage.googleapis.com` are unreachable; the `@sparticuz/chromium`
binary unpacks but its `libnss3`/`libnspr4` are absent and no apt mirror is reachable either), so the
browser suite could not be run. Rather than ship the round as "code-traced, NOT VERIFIED" — the
caveat every previous round carried — `src/ui/__tests__/domEnv.mjs` adds a headless DOM tier: jsdom
globals installed *before* react-dom is imported (import it first and React falls back to its legacy
IE value-change polyfill and throws `activeElement.detachEvent is not a function` on every
keystroke), then `RightPanel` / `Toolbar` mounted on a real `MemoryEngine` document the way `App.tsx`
mounts them (snapshot from the store, so a dispatch re-renders). That is enough to read the markup the
components actually produce, click it, type into it and watch the engine answer.

- `vectorcard.dom.test.mjs` — **45 checks**: the card renders for a vector and not for a rectangle;
  the header is a `Section` among the others; zero stray inline styles; alignment clicks move the
  points (`vectorAlign`), mirroring writes `mirrorMode`, typing into `Vertex X` writes the point and
  reads `100/4` as 25 and `+5` as relative; the corner-radius Field and its slider share one name;
  Simplify…/Offset Path… open their forms, read as pressed while open, apply through
  `simplifyPath`/`offsetPath` and close; Outline stroke refuses a stroke-less path without touching
  it; Smooth rewrites the handles; Edit points/Done drive `vecEdit`; the section folds and unfolds;
  one undo returns a typed vertex.
- `dock.dom.test.mjs` — **21 checks**: the dock is inline-free; the count is `.sel-count`; the boolean
  tool is `tool split` with a `.caret` and `aria-haspopup`/`aria-expanded`; opening it shows the five
  operations with their chords and a `.fly-div` separator; Intersect makes a boolean and closes the
  menu; the Done button appears only in vector edit and leaves it.
- `vectorcard.test.mjs` — **53 checks** on the source contract, so a future edit cannot quietly
  reintroduce the drift: the card composes the four primitives, carries no inline `style={{`, no
  literal colour, no `export-run`, no `<strong>`; every class it names exists in `styles.css`; the
  engine commands are all still dispatched; the boolean tool keeps the split recipe. This one is a
  ratchet and was mutation-checked (adding `style={{color:"#fff"}}` back fails two checks).

Measuring the two surfaces turned up the reason they survived four rounds: the drift was never
counted. `src/ui/__tests__/drift.test.mjs` now counts it — **22 checks**, one per surface plus a
census of the table itself — and pins a ceiling per file for the five things the design system's rules
name: inline `style={{` objects, quoted `#rrggbb` literals, native `title=`, raw `<button`, raw
`<select`. The workspace stands at **414 / 195 / 340 / 363 / 49**, with `inspector.tsx`
(179/44/221/192/41) and `FigInspectorModal.tsx` (113 inline objects for a dev modal) the two piles
that matter. It is the same instrument as `DEAD_CODE_CEILING` in `scripts/check.sh`: it does not claim
the pile is good, it claims the pile is known and cannot grow without someone editing the table and
saying so. It was mutation-checked (an added `style={{color:"#fff"}}` in `Comments.tsx` fails with
`OVER: inline 3→4, colour 0→1`), and a row that *falls* prints `(lower the ceiling: …)` so a fix and
its ratchet cannot be committed apart. Recorded as `docs/KNOWN_DEBT.md` §12, with the caveat that
belongs there: nothing in CI runs the web suite, so this ratchet only bites where `npm test` runs.

**A defect the build warning turned up (CSS-U1, fixed).** `vite build` has been printing
`▲ [WARNING] Unexpected "@media" [css-syntax-error]` at `styles.css:2522`, and the cause is a dangling
selector list: `.fill-pop, .ctx, .menu, .type-menu, .palette,` with no declaration block, immediately
followed by the reduced-motion `@media`. The `@media` was being parsed as the next *selector* in that
list, so the block never reached the minified sheet — the copy at the end of the file is the one that
has been applying the preference (so reduced motion did work, by luck of duplication), and `.palette`
names a class nothing in `src/` renders. The list is deleted, the duplicate block with it, and the
build is warning-free. It was the shared entrance animation for those four popover surfaces —
`.dash-menu`, `.xmodal` and the command palette each carry `animation: x-pop-in 110ms cubic-bezier(0.2,
0, 0.13, 1)` while `.fill-pop` / `.ctx` / `.menu` / `.type-menu` carry none. **Completing it is
deliberately not done here:** it is a visible motion change on four surfaces, and this sandbox has no
browser to look at it with. The rule to add is written down in the stylesheet comment where the list
used to be; it is the whole of the remaining motion-parity gap (MOTION-U1, open).

Unit suite **1610 checks, 0 failed** (1469 → 1610, so 141 new), `tsc -b` clean, `vite build` clean and
— for the first time in this file's recorded runs — **warning-free**.

Browser suite: **§42 added (15 checks), NOT RUN here** — it covers exactly the half jsdom cannot:
computed geometry read *against the panel's own recipes* (the card's align buttons measured against
the layer align row, its fields against the Position fields, the boolean `.fly` against a tool group's
`.fly`, so a scale change moves both sides and the claim survives), the Apply button's background
against the `--accent` token, the dark-theme card well against `--hover` and the Done button's ink
against `--on-accent`, and the inline-style census of the dock. It is syntax-checked and written to
the file's conventions; it needs `npm run test:e2e` with a Chromium to be believed.

**Still open after this round:** MOTION-U1 (the four popover surfaces with no entrance animation, rule
written down above — needs eyes on it), FR-U2 (the canvas chrome constants — `BRAND_ACCENT #10b981` vs
the `--accent` token `#0e9f6e`, `#a855f7`, `#ff3b6b`, `#18181b` — the largest remaining token gap, and
it needs the same token-feeding the canvas already does for `--canvas`/`--grid`/`--canvas-label`;
**closed in §4r**), IN-U6/FS-U4 (native `title=` on the flip and ColorRow buttons: behaviourally equivalent since §2.3's
bridge, stylistically split, and frozen by the drift ratchet rather than fixed), PM-U3 (two Escape
ownership patterns), ~~PM-U6 (export sheet's initial focus)~~, LP-U3–U6, ~~RW-U1~~ (both §4u), FR-U3/U4 — and the
`inspector.tsx` / `FigInspectorModal.tsx` rows of the drift table, which are where the next rounds'
numbers come from.

## §4r. P2 round 5 — the canvas stops keeping its own palette (FR-U2)

**What the census found.** The finding named five constants; the file had more. `BRAND_ACCENT` was
used 40 times, `COMP_PURPLE` 5, `LOCK_GREY` 5, the wash and glow 2 each — and around them, inline
where nobody had bothered to name them: `#ff3b6b` ×6 (smart guides and the equal-spacing badges),
`#0d99ff` ×3 (drop target, crop handles), `#00c853` (mask outline), `#f8fafc`, three near-identical
dark card backings (`rgba(15,23,42,.95)` for the spec note, `rgba(15,23,42,.90)` for the hex pill,
`rgba(13,20,38,.92)` for the cursor tooltip), a crop scrim, five incidental `rgba(16,185,129,α)`
alphas (0.08/0.14/0.25/0.4/0.75) for the boolean preview, bézier tangents, branching vertices and
the padding ghosts, and 36 chrome whites. `Minimap.tsx` told the same story in four `dark ? … : …`
pairs and `Rulers.tsx` in four more: **77 colour literals across the three 2D surfaces**, none of
them reachable from the sheet, with a comment on `COMP_PURPLE` asking a human to keep it in step
with `--comp` "by hand — change both".

**The decision the finding was really asking for: two greens, or one?** Two *roles*, named. `--accent`
is the control accent (#0e9f6e light / #10b981 dark), contrast-tuned for panel surfaces; `--cv-sel` is
selection ink on the document canvas. Two reasons to keep them apart rather than collapse them: the
sibling Rust workspace made the same call (`REFINEMENT_V1_PLAN` P0-7 derives `C_SEL` from a
`selection` role, distinct from `accent`/`focus_ring`), and the ring sits on `--canvas`, not on
`--panel`, so its contrast budget is a different problem. There is also an honest constraint, recorded
so it is not mistaken for a preference: light-mode selection ink stays `#10b981`, which is what the
browser suite's §26 counts (pixels near rgb(16,185,129) ± 24). Repainting the ring with `--accent`
would have moved every light-mode selection pixel to #0e9f6e — a visible identity change that no one
in this sandbox can look at, verified by a suite that cannot be run here. So the round moves *where
the value lives*, not the value: the same pixels, one door, and a dark column that a designer can now
retune in the sheet. That retune is **FR-U2b**, and it is the only part of this finding left open.

**The boundary that makes the rest safe: chrome vs document ink.** `Canvas.tsx` keeps 13 colour
literals and every one is triaged. Three are named `DOC_*` constants — a new slice's dashed stroke,
and the paint bucket's two defaults — because they are written into the file on creation. The rest
are a glass effect's default tint, five `#00000000` creation fills, the loupe's sampled-colour
default, the noise renderer's black, a boolean mask's white, and an `Icon` default prop. None of them
may answer the theme, or a saved document — and its SVG export — would change colour with the
viewer's appearance setting. `canvasChrome.test.mjs` holds the line: the only emerald literals
allowed in `Canvas.tsx` are the ones on a `const DOC_*` line, and the chrome record may only contain
`--cv-*` roles plus an allowlist of the seven surface/identity tokens the canvases already read, so
nobody smuggles a panel or document value into the canvas palette later.

**What the family buys.** One read per paint — `readCanvasChrome((token) => css.getPropertyValue(token))`
extends the `--canvas`/`--grid`/`--canvas-label` resolution that was already happening, so a frame
still costs one style resolution for all 22 roles; `withAlpha(role, α)` thins a role instead of
hardcoding another emerald rgba; the minimap and rulers read the same record and keep `theme` in
their paint deps, which is what makes them re-read on a flip. Two deliberate unifications, with the
numbers so nobody has to guess what moved: the three dark on-canvas card backings are now one
`--cv-chip` at .95, and the minimap viewport fill (.20 dark / .16 light) plus the rulers' selection
range (.22 / .16) are now `--accent-wash` (.16 / .14) — a 2–4% alpha change on two small translucent
rectangles, four spellings of one idea reduced to one. **Everything else is byte-identical to the
literal it replaced**, so this round is NOT VERIFIED visually in the same sense the others are: there
is nothing new to see, by construction, and the two alpha unifications are the whole of the visible
delta.

**The contracts.** `canvasChrome.test.mjs`, 50 checks, needing neither a DOM nor a canvas: the
fallback record equals the sheet's light column key-for-key (parsed out of `styles.css` with comments
stripped first — the sheet's own prose mentions `--accent:` and a naive declaration scan reads it as
a value, which is precisely how the first run of this test failed); the dark block declares all 22;
`readCanvasChrome` trims, falls back per key, survives a lookup returning `undefined`, and never hands
back the fallback object itself; `withAlpha` handles 3/6/8-digit hex and `rgb()`/`rgba()`, clamps its
alpha, and returns anything unparseable untouched so a mis-shaped sheet degrades instead of throwing
mid-paint; `canvasChrome()` survives having no document; and no chrome literal may reappear in any of
the three sources. The drift ratchet was lowered in the same commit: **Canvas.tsx 68 → 13 colour,
Minimap.tsx 4 → 0, Rulers.tsx 5 → 0; workspace colour drift 195 → 131.** (The literals that remain
elsewhere are a different pile: `devices.tsx` 35 are device bezels, `ZenHUD.tsx` 14 and
`RadialMenu.tsx` 6 are DOM surfaces that want classes, not canvas tokens.)

**Browser suite §43 + §43b — written, NOT RUN here** (no Chromium in this sandbox), 11 checks. The one
that could not have passed before this round: set `--cv-sel` to `#ff8800` on the running app, nudge
the selection to force a paint, and the chrome has to turn orange while the demo document's own
emerald toggle stays within ±150px of the idle baseline — the difference between reading the sheet and
remembering a literal, measured. Then remove the override and it has to come back. §43b boots dark
through the app's own path (the `x-native-theme` key that `page()` deliberately spares, so
`ThemeProvider` resolves it before first paint and React's `theme` lands in the paint deps — setting
the attribute alone restyles the DOM and leaves the canvases painting stale tokens), re-measures the
chrome against the dark tokens, rethemes again in dark, and checks the minimap viewport wears the dark
`--accent` and not the light one (tolerance 16, since the two values sit 26 apart in the green
channel). §20's minimap predicate needed no change: it was already green-ish rather than a literal.

**Also fixed in passing:** the on-canvas frame-rename field, which carried `background: "#ffffff"` and
`color: "#0f172a"` inline — white-on-white in the dark theme — and now uses `var(--elevated)`,
`var(--text)`, `var(--accent)` and `var(--elev-floating)`.

**Numbers.** Unit suite **2016 checks, 0 failed** across 28 suites (+50 this round). The counting rule
is written down because earlier rounds in this file quoted lower figures that summed only the suites
printing the `N passed, M failed` form:
`npm test 2>&1 | grep -o "[0-9]* passed" | awk '{s+=$1} END {print s}'`. `tsc -b` clean; `vite build`
clean and warning-free, the sheet at 96.88 kB (17.86 kB gzip) with the new tokens.

**Still open after this round:** FR-U2b (the dark column exists for every canvas role and retunes
three of them — the rest is a design call that needs eyes), MOTION-U1, IN-U6/FS-U4, PM-U3, PM-U6,
LP-U3–U6, RW-U1, FR-U3/U4, and the `inspector.tsx` / `FigInspectorModal.tsx` drift rows. (LP-U3 and
LP-U4 closed in §4s; LP-U5/U6 in §4t; PM-U6, RW-U1 and FR-U4 in §4u.)

## §4s. P2 round 6 — the empty page says something (LP-U3, LP-U4)

**Two blanks, not one.** LP-U3 was filed as a single line — "empty page = blank tree, no teaching empty
state (assets HAS one; layers doesn't)" — but the layers tree has two different blanks and they are not
the same sentence. A page with nothing on it renders `<div class="tree">` with no children; a search
with no hits renders the *same* empty div, because each `LayerRow` returns `null` when it does not
match. So "you have nothing yet" and "you found nothing" were one indistinguishable screen, and the
second is the worse of the two: a filter that looks like data loss.

**Nothing new was invented for it.** The sheet already had three empty-state recipes and the panel now
uses two of them. The empty page gets the inspector's `.empty-state` verbatim — icon, `.empty-title`,
`.empty-body`, `.empty-hint` with `<kbd>` chips — so the left and right panels teach in one voice and
one recipe; a visitor with nothing selected sees "Nothing selected" on the right and "No layers on this
page" on the left, laid out identically. The search's blank gets `.empty` (the Assets pane's recipe)
carrying the command palette's sentence: *No layer matches “q”. Clear the search to see the whole
page.* No new CSS class, no new control, no new copy voice.

**Telling them apart honestly.** The panel derives `emptyPage` and `noMatch` from the document and the
query — and for the query it calls `matchesLayer`, the very predicate each row uses to hide itself,
rather than counting rendered rows. Counting rows is the easy version and it drifts the first time a
row hides for any other reason (a folded parent, a future filter); asking the predicate means the tree
and its rows cannot disagree about whether anything matched. The two states are mutually exclusive by
construction (`noMatch` requires `!emptyPage`).

**LP-U4, at the scope it was filed at.** The finding asked for "minimal dismissible empty-canvas
hints", and §25's steps 1–3 did fail cold: an empty canvas renders a dock, two panels and an inspector,
and not one of them says what to do. So: one card, three chords, one button. The decisions worth
recording are the ones a reviewer would otherwise have to guess at.

- It is **DOM, not canvas paint** — real text, a real button in the tab order, the theme for free, and
  a dismissal that does not need a repaint.
- The card is `pointer-events: none` and **only its button gets them back**, because the card is
  describing a drag and must not eat one. That is the `.cm-layer` / `.cm-pin` recipe the comment pins
  already use, and §44 proves it by dragging a rectangle out *through* the card.
- It **retires by itself** the moment the page holds a layer, and stays out of the way while presenting
  or mid-pen-stroke (`!snap.presentFrame && !draft.length`).
- The dismissal is **read before first paint** (`useState(() => !emptyCanvasHintDismissed())`), so it
  never flashes for someone who has already closed it.
- `ui/firstRun.ts` is its own module because `localStorage` throws in private mode, is absent in node
  and absent in SSR: the guard belongs in one place, not inside a 7,000-line canvas component. It takes
  an injected store, which is why 24 checks cover hostile stores, a simulated next session and the
  key's namespace without a browser.
- The key is `x-native-`namespaced on purpose — the e2e's `page()` wipes every `x-native` key except the
  theme, so §44 always starts as a first-time visitor.
- What it deliberately is **not**: a tour, a checklist, a modal, or a per-tool hint framework. If the
  product ever wants onboarding proper, that is a new finding with a new design, not an extension of
  this card.

**Verification.** jsdom, mounted for real: `leftpanel.dom.test.mjs` (25) renders `LeftPanel` on an
emptied document and asserts both states, their copy, their `<kbd>` chords, that drawing a rectangle
retires the teaching state and puts a row in its place, and that the search's sentence quotes the term
and clears with it. Two harness fixes were needed and are worth naming because they unblock every
future row-mounting test: `mountSurface` learned the `left` surface (and that its pane prop is
`nav: "file"`, not `"layers"` — `NavId` has no layers member), and `installDom` now stubs
`scrollIntoView`/`scrollTo`, since a selected layer row scrolls itself into view and jsdom has no layout
to scroll; without the stub the row's effect threw on mount. `domEnv` also gained an `empty` fixture
that empties a page the way a visitor does (select all → delete), because a fresh `MemoryEngine` seeds a
starter page rather than an empty one. `firstRun.test.mjs` (24) covers the persistence and the card's
source contract: rendered from classes, dismissed through `XButton`, click-through in the sheet, painted
with tokens and no literals, and its `kbd` chips sharing the empty-state rule rather than starting a
second one.

**Browser suite §44 — written, NOT RUN here** (16 checks, 295 total): both empty states and their
computed layout (flex, centred, 28px top padding, no stray inline styles), the inspector showing the
same recipe at the same moment, the card's `pointer-events` pair and its centring over the canvas, the
drag through the card producing exactly one row, the no-match sentence and its recovery, and the full
dismissal sequence — click, `localStorage` reads `"1"`, reload, empty the page again, card stays gone
while the layers panel still teaches, because that one is a state and not a nudge.

**Numbers.** Unit suite **2065 checks, 0 failed** (2016 → 2065: +25 jsdom, +24 contract). `tsc -b`
clean; `vite build` clean and warning-free, the sheet at 97.42 kB (17.93 kB gzip). The drift ratchet is
**unchanged at 414 / 131 / 340 / 363 / 49** — a round that added two new surfaces of UI and moved no
number added no inline style, no colour literal, no `title=` and no raw `<button>` (the dismiss control
is `XButton`), which is the ratchet earning its keep: the new UI had to arrive through the primitives.

**Still open after this round:** LP-U5 (ToolsPane: no disabled states or shortcuts, and a "Plugins"
label with no plugins) and LP-U6 (AgentPane silently ignores input it cannot match, and hardcodes a
390×844 frame at 120,80) — both closed in §4t — plus MOTION-U1, FR-U2b, IN-U6/FS-U4, PM-U3, PM-U6,
RW-U1, FR-U3/U4, and the `inspector.tsx` / `FigInspectorModal.tsx` drift rows.

## §4t. P2 round 7 — the two panes that were placeholders (LP-U5, LP-U6)

The last two rows of the LP family were the two panes nobody had finished. Both rendered, both were
reachable from the rail, and both said something the product could not back up.

**LP-U5: a command list has to say which command, and whether it can run.** The Tools pane called
itself "Plugins and actions for this file" — there are no plugins, and the nav rail already calls it
*Tools* — and then listed seven bare labels with no chords and no disabled states. Clicking
**Duplicate** with nothing selected, or **Undo** with no history, dispatched a command the engine
correctly ignored: the pane gave the click away and returned nothing. It is now what it looked like it
was: seven rows in the `.presets` recipe the inspector's preset grid already uses, each wearing its
chord in a `.sc` chip (the declaration every other menu container in the sheet makes for itself:
`.menu .sc`, `.fly .sc`, `.ctx .sc`, now `.presets .sc`), and each command that cannot run is
`disabled` — Duplicate and Group without a selection, Undo and Redo without history — with a `.muted`
line at the bottom naming what is missing ("Duplicate needs a selection · Group needs a selection ·
Nothing to undo yet · Nothing to redo"). The reasons are text rather than tooltips on purpose: a
disabled control cannot receive the pointer that would show a tooltip, and `title=` in `chrome.tsx` is
at its ratchet ceiling (40/40), so the honest option was also the only one the ratchet allowed. The
chords are not typed twice — `toolsagent.dom.test.mjs` reads every `label: … sc: …` pair in
`chrome.tsx` and fails if the pane and the palette disagree about one, and §45 opens the palette in a
browser and compares them again. One plumbing fix came with it: `LeftPanel`'s memo comparator did not
compare `canUndo`/`canRedo`, so a history-only change would have left the pane's Undo row stale.

**LP-U6: an agent that cannot help has to say so.** The pane appended whatever you typed to a
transcript and then, unless the text mentioned a frame, text or a box, dispatched nothing — the message
sat there with no answer and no change, which reads as a broken product rather than a limited one. Its
placements were also guessed document coordinates (a 390×844 frame at 120,80; text at 140,120), so what
it "added" was routinely off-screen, and 390×844 matched no preset the inspector would recognise.
Every ask now gets an answer, and the answer is written from the same values that were dispatched, so
it cannot overclaim: *"Added a frame — iPhone 16 Pro, 393 × 852 — centred in your view and selected."*
or *"Nothing in “…” matched what I can do. I can add a frame, text or a rectangle — and I changed
nothing."* Placement is derived: `ui/zoom.ts` gained `viewportCentreWorld(snap)`, the world point under
the middle of the visible canvas, using the same canvas-local pan reasoning as `zoomTo`, and successive
asks cascade 24px so two frames do not stack exactly. Sizes come from the inspector's own preset list,
now exported and shared (`PRESET_GROUPS`), which is why the reply can name a preset instead of a
number nobody chose. The transcript keeps both voices (`data-who="you|agent"`, the agent's muted),
wraps instead of ellipsising a sentence into a 32px layer-name row, and its greeting no longer promises
colour — the pane has no colour branch, and a promise it cannot keep is the same defect as a control
that does nothing.

**Verification.** `toolsagent.dom.test.mjs` (35 checks) mounts both panes for real in jsdom and drives
them: the row set and chords, the pane's copy, disabled/enabled transitions across a select → duplicate
→ undo sequence, a live row's click actually dispatching (zoom becomes 1), no inline layout; then five
agent asks — an unmatched one that must answer and change nothing, a frame whose name and size come
from the preset list and which is selected as claimed, a second frame that must land exactly
`200/zoom + 24` world pixels from the first after a `setPan` of 200 (the arithmetic that proves
placement follows the view rather than a constant), a text ask carrying the message, and "box" reaching
the rectangle branch. Two harness notes worth keeping: a **static** import of a `.tsx` surface at the
top of a DOM test loads react-dom before jsdom is installed, after which every input event throws
`activeElement.detachEvent is not a function` and React's updates land a render late — so the preset
list is imported dynamically, after the first mount; and `domEnv` learned `press(el, key)`, because a
surface that acts on Enter has no button to click.

**Browser suite §45 — written, NOT RUN here** (18 checks, 313 total): the chords compared against the
palette opened with ⌘K rather than against a number in the test; disabled rows computed against `--dim`
and live rows against `--text`; no row explaining itself with a native `title`; clicking a dimmed row
leaving the layer count alone; a selection re-enabling Duplicate and Group; the agent's frame painted
*on screen* after a hand-tool pan far from the document origin (measured as selection chrome near
`--cv-sel`, the §43 technique — a fixed document coordinate would not survive that pan); the inspector
agreeing the layer is the 393×852 preset; the reply wrapping and wearing `--muted` against the
visitor's own voice; and an unmatched ask answering while the layer count stays put.

**Numbers.** Unit suite **2100 checks, 0 failed** (2065 → 2100: +35). `tsc -b` clean; `vite build`
clean and warning-free, the sheet at 97.83 kB (18.01 kB gzip). Drift moved **down**: `chrome.tsx`
inline 51 → 50 (the agent pane's `style={{ marginLeft: 0 }}` became `.share.left`), workspace inline
414 → 413, with no new raw `<button>`, no new `title=` and no new colour literal across two rebuilt
panes — the rows stayed the recipe they were already in.

**Still open after this round:** MOTION-U1, FR-U2b, IN-U6/FS-U4, PM-U3, PM-U6, RW-U1, FR-U3/U4, and the
`inspector.tsx` / `FigInspectorModal.tsx` drift rows. The LP family (LP-U1 … LP-U6) is now closed end to
end. (PM-U6, RW-U1 and FR-U4 closed in §4u.)

## §4u. P2 round 8 — nothing off the edge, nothing out of reach (RW-U1, FR-U4, PM-U6)

Three findings from three different sections of this audit — §13 (responsive), §11 (canvas/frame) and
§17 (modals) — with one shape: chrome the product puts on screen without asking whether the screen has
room for it, or whether the keyboard can get to it.

**RW-U1: the dock was bounded by nothing.** `.dock` is absolutely centred in `.canvas-col`
(`left: 50%; transform: translateX(-50%); bottom: 18px`) at a fixed `height: 44px`, and the column is
narrower than the window whenever a panel is docked — at 900px the stage can be ~300px wide while the
tool row, a multi-selection cluster and the right-hand cluster (Assets, Prototype, Dev Mode, Actions)
add up to ~500px. The strip had no width limit at all, so its tail simply left the screen, and the only
escape was `minUi` — which "solves" *the tools do not fit* by *closing your panels*. The one override
that did exist, under `@media (max-width: 860px)`, made the dock a scroll container, which is worse
than it sounds: `overflow-x: auto` computes `overflow-y` to `auto` as well, and `.tool .fly` escapes
40px above a 44px strip — so on a phone the boolean menu opened into a clipped box. The dock is bounded
by its own column now (`max-width: calc(100% - 24px)`, which is the right reference at every width
rather than the `100vw` the override guessed), keeps `min-height: 44px` so it grows upward from its
`bottom: 18px` anchor, and **wraps** — `flex-wrap: wrap` with `justify-content: center` on the dock and
on `.toolset` (plus `min-width: 0`, without which a flex item refuses to shrink below its content). No
`overflow` anywhere on it, so the flyouts escape at every width and the phone override is deleted.
A wrapped dock is a two-row pill, and what that looks like is exactly the kind of call this sandbox
cannot make — **NOT VERIFIED visually**; §46 measures the rects instead of trusting the shape.

**FR-U4: the one readout of "how big is this" could leave the screen.** Both badge sites — the single
selection and the multi-selection box — computed `by = sy + sh + 8` and painted unconditionally, so a
selection whose bottom edge was at the canvas bottom lost its size/angle badge: most often mid-resize
of something tall, which is precisely when the number is wanted. `ui/zoom.ts` gained
`clampBadge(rect, view, { pad, flipY })`, and both sites go through it: below the box when below fits;
flipped above it when below does not; clamped inside the view when neither side does (a selection
taller than the canvas has nowhere to hang), never negative. One subtlety the first draft got wrong and
a test caught: the flip has to be *rejected* when the flip target is itself off-screen, which happens
whenever the whole box is below the fold — trading one invisible badge for another is not a fix. It is
pure arithmetic on canvas-local pixels, so the paint loop stays the only code that knows about a `ctx`
and the behaviour is testable without a browser.

**PM-U6: the export sheet left the keyboard outside.** `Export assets…` (⇧⌘E, the palette, or the
inspector's Export button, all through the `x-native-export-dialog` seam) opened a sheet with
`role="dialog"` but no `aria-modal` and no initial focus, so focus stayed on whatever launched it and a
keyboard user tabbed in from the top of the document *behind* the veil. The filter field is now the
first stop, which is both the first control in the sheet and the first thing worth doing in it — and
every other modal input in the app (shortcuts, find-in-page, the palette) already focused itself, so
this was the outlier rather than a new convention. The dialog also says `aria-modal="true"` now, since
a modal that does not announce itself leaves the document behind it sounding live. What is *not* fixed
here: focus **restore** on close. The sheet is closed by the App's global overlay owner, so the caret
returns to `<body>` rather than to the command that opened it — that is PM-U3's two-Escapes question,
and answering it in one place is worth more than patching this sheet.

**Verification.** `edgefit.test.mjs` (26 checks) covers all three at the level each can be checked at:
nine arithmetic cases on `clampBadge` (fits, exactly-fits-the-pad boundary, one pixel over flips, flip
target off-screen falls through to the clamp, no flip target, badge taller than the view, both x edges,
`pad` as a parameter, a view smaller than the badge); the sheet read as text for the dock, because jsdom
has no layout engine and the stylesheet is what the browser will actually apply (bounded, wraps,
`min-height` not `height`, centred, `.toolset` folds too, and **no rule anywhere makes the dock a
scroll container** — the assertion that keeps the flyout bug from coming back); both badge sites in
`Canvas.tsx` call the helper with a flip target and neither keeps the old formula; and the export sheet
mounted for real, where React's commit-time focus is observable — `document.activeElement` is the
filter, it is the first focusable in the sheet, the sheet lists rows, and unmounting removes it.

**Browser suite §46 — written, NOT RUN here** (9 checks, 322 total). The badge is measured as two band
comparisons rather than one absolute count, because the badge is painted in `--cv-sel`, the same ink as
the selection outline that crosses both bands: pan until below no longer fits and there must be more
accent above the box than below, pan further and the reverse, which is the clamp. The dock is measured
at 1600/1100/900/700 with a select-all multi cluster and again at 430 — every `button.hit` inside both
the column and the viewport, `scrollWidth <= clientWidth`, computed `overflow-x: visible` — and at 430
the boolean menu is proven *painted*, not merely present, with `elementFromPoint` at its centre,
because clipping is visual and not geometric: an element inside a scroll container still reports its
full rect. The export sheet is opened through the palette and typed into with no click first, then
closed with Escape.

**Numbers.** Unit suite **2126 checks, 0 failed** (2100 → 2126: +26). `tsc -b` clean; `vite build`
clean and warning-free, the sheet at 97.84 kB (18.01 kB gzip). The drift table did not move —
413 inline / 131 colour / 340 `title=` / 363 raw `<button>` / 49 `<select>`, `chrome.tsx` still
50/4/40/64/2 — because this round added almost no markup: four declarations, one function call at two
sites, and one attribute.

**Still open after this round:** MOTION-U1 and FR-U2b (both need eyes), IN-U6/FS-U4, PM-U3 (which now
also owns the export sheet's focus restore), RW-U2, FR-U3, and the `inspector.tsx` /
`FigInspectorModal.tsx` drift rows.

## §5. Plan (running)
1. Per-surface code↔UI traces + integration tables (§2.4 order). 2. Senior critique (§26) with concrete
   causes. 3. `X_NATIVE_DESIGN_SYSTEM.md` from verified tokens + x-ui (+ gaps closed). 4. Incremental
   migrations/fixes (shared components, tooltip unification, inspector row clarity, toolbar hierarchy,
   modal/popover consistency) — smallest correct layer, no behavior regressions. 5. Headless tests for
   every integration fix; suite stays 1776+ green; tsc + build green. 6. Final docs + report.
