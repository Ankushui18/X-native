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
| TB-U5 boolean flyout styles | inline styles (width/divider/label) bypass tokens | DRIFT (§29) | P2 |
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
| IN-U1 | FIXED: shared patchMany/mixedProp/manyVals/patchNumMany helpers; Mixed display + apply-to-all for opacity/blend/corners(+toggles)/stroke weight/base fill+stroke rows (incl gradient/image/meta/remove/visibility) and Fill/Stroke/Effect Add; ColorRow gains a mixed swatch+hex. REMAINING (follow-up): fill/stroke/effect stack ROW edits, effect row ops, visibility-toggle display states (all: first-layer display kept, Export-precedent documented) | FIXED (P1) | — |
| IN-U2 | FIXED: seg entry shows only when the vector card is absent (exactly one entry always); both use id+toast+⇧⌘O title; card refuses the stroke-less no-op with a teaching toast; labels unified | FIXED (P1) | — |
| IN-U3 | FIXED: every ad-hoc header is now a `Section` — Component/Instance (its action buttons moved into the section's action slot), Boolean, Star/Polygon, and on the page/prototype surfaces Frame Presets, Background, Local styles, Pixel grid, Flow starting point, Prototype settings, Interactions, Annotations. `h-row h3` and `.sec-toggle h2` were already the same 11px/500/muted style, so the chrome reads identically while every block gained fold + persistence + the scroll-to hook. Left bespoke on purpose: `Design health` (score + issues button) and the Dev Mode `Inspect` header (dot + view tabs) — both carry live, bespoke chrome a plain title would lose. Note: the audit's "10 sections" observation was itself approximate — the count varies by selection (screen 4 / layer 11 / text 12) and now includes these blocks. | FIXED (P2) | — |
| IN-U4 | Vector card bespoke: `<strong>` header, `export-run` buttons, inline styles, hardcoded #fff, native titles | DRIFT | P2 |
| IN-U5 | "Edit vector" label dispatches `flatten` (misleading); seg buttons raw/unclassed | LABEL + DRIFT | P2 |
| IN-U6 | Flip buttons + assorted icon-only buttons use native title= amid Tooltip siblings | PARTIAL (§2.3) | P2 |
| IN-U7 | Design/Prototype/Inspect tabs are raw buttons, not XTabs; no arrow-key nav (§19 evidence) | DRIFT | P2 |

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
| FR-U2 | Chrome colors hardcoded in Canvas consts (#10b981 accent ≠ --accent #0e9f6e token; #a855f7, #fff, #ff3b6b) — bypass theme, can't adapt to dark mode; two different "accent" greens | DRIFT (§6) | P2 |
| FR-U3 | Rotate affordance invisible (zone-only = Figma parity, but zero first-time discoverability) — roadmap: subtle corner affordance on hover | ROADMAP | P2 |
| FR-U4 | Size/angle badge has no viewport clamp (by = sy+sh+8 can run off-screen at viewport bottom) | PARTIAL (§18 class) | P2 |

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
| PM-U2 | Actions palette has no outside-click close (no veil/backdrop; Esc/run/close only) | PARTIAL | P2 |
| PM-U3 | Two Esc patterns: component-local (Nudge capture, FillPicker, EffectPopover, ContextMenu) vs App-global closeOverlay (export/actions/find/figInspector) — both work, inconsistent ownership | DRIFT | P2 |
| PM-U4 | NudgeDialog wears help-pop/help-card styles (a prefs dialog in help clothing) | DRIFT (§29) | P2 |
| PM-U5 | FOUR tab/seg systems: left NavRail, inspector raw tabs (IN-U7), vars/styles bespoke seg w/ inline styles, qo-filters — XTabs unused. Fix: one tab/seg primitive; migrate inspector + vars/styles | DRIFT (§29) | P2 |
| PM-U6 | ExportAssetsDialog has no initial focus (no autoFocus) — keyboard users start from top | PARTIAL | P2 |

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
| LP-U3 | Empty page = blank tree, no teaching empty state (assets HAS one; layers doesn't) | MISSING UI | P2 |
| LP-U4 | Zero first-run onboarding anywhere (no welcome/empty-canvas guidance) — §25 steps 1–3 fail cold. Fix: minimal dismissible empty-canvas hints | MISSING UI | P2 |
| LP-U5 | ToolsPane: no disabled states/shortcuts; "Plugins" label with no plugins | PARTIAL | P2 |
| LP-U6 | AgentPane: unmatched input silently ignored (chat appended, nothing happens); hardcoded geometry (390×844 frame at 120,80…). Fix: scope feedback | PARTIAL | P2 |

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
| RW-U1 | Bottom toolbar dock has NO narrow-width protection (fixed content row, no max-width/scroll/wrap) → tools clip off-screen on narrow windows while minUi saves only the panels. Fix: max-width + scroll or overflow flyout | PARTIAL | P2 |
| RW-U2 | All window-size behavior code-verified ONLY (1280/1440/1920/2560 + narrow/wide need a browser) | NOT VERIFIED visually | P2 |

## §14. Senior designer critique (prompt §26) — evidence-linked, no subjective language

- INFORMATION ARCHITECTURE: two nav truths coexist (local `nav` drives the panel; engine `leftTab` is
  write-only) which made the "Open variables & styles" button dead (LP-U1); the view menu lives inside
  the inspector tab bar (PT-U6), so canvas-display toggles are found by accident, not by structure.
- VISUAL HIERARCHY: inspector `Section` vs ad-hoc `h-row` headers (IN-U3) give identical-rank content
  two different weights; the vector card's `<strong>` header is a third.
- DENSITY: appropriate for a pro tool (11px type scale, compact rows); ToolsPane wastes its density on
  7 shortcut-less buttons (LP-U5).
- CONSISTENCY: four tab systems (PM-U5, open), one tooltip system (§2.3 FIXED), two Esc owners (PM-U3),
  `export-run` class reused for Present/vector-Done (PT-U2/IN-U4), two accent greens (FR-U2).
- DISCOVERABILITY: prototype tab (TB-U3), italic (TY-U1), property-first binding (FS-U1), ⇧E/⌘⌥↩ chords
  (TB-U6/PT-U7), rotate zone (FR-U3), and the entire product for first-run users (LP-U4) are
  unreachable without prior knowledge.
- AFFORDANCE: locked selections show editable handles that refuse (FR-U1); "Edit vector" flattens
  (IN-U5); Resources opens the command palette (TB-U1); duplicate Outline-stroke buttons diverge (IN-U2).
- FEEDBACK: bound-value edits vanish without notice (FS-U6); AgentPane swallows unmatched input (LP-U6);
  multi-select shows first-layer values as shared (IN-U1/TY-U3).
- ERROR PREVENTION: guard toasts on binding (good); destructive mode/collection delete now names what is lost
  and uses a red confirm instead of a native OK/Cancel (PM-U1 FIXED);
  corrupt→toast + fresh doc (honest, minimal).
- ACCESSIBILITY: align/valign/decoration buttons have no accessible name at all (TY-U2 FIXED); tooltips
  are pointer-only (TY-U6 FIXED — both the shared component and the `title` bridge now show labels on
  `:focus-visible`, and the bridge names controls that had no accessible name); tool flyouts/menu-less
  popovers lack keyboard paths (TB-U2 FIXED); dialogs lack initial focus (PM-U6 FIXED); canvas chrome is
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
3. **IA / missing UI (PT-U6 view menu inside the inspector tab bar, LP-U3/LP-U4 first-run and empty
   states, FR-U3 rotate zone, RW-U1/RW-U2 unverified visual states)** — needs a design decision, not a
   sweep.

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

## §5. Plan (running)
1. Per-surface code↔UI traces + integration tables (§2.4 order). 2. Senior critique (§26) with concrete
   causes. 3. `X_NATIVE_DESIGN_SYSTEM.md` from verified tokens + x-ui (+ gaps closed). 4. Incremental
   migrations/fixes (shared components, tooltip unification, inspector row clarity, toolbar hierarchy,
   modal/popover consistency) — smallest correct layer, no behavior regressions. 5. Headless tests for
   every integration fix; suite stays 1776+ green; tsc + build green. 6. Final docs + report.
