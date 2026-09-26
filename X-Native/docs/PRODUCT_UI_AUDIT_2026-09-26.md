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
| TB-U1 Resources + Actions | FIXED: Resources key retargeted to Assets pane via onNav (label "Assets", ⌥2); Actions key keeps the ⌘/ palette | FIXED (P1) | — |
| TB-U2 tool flyouts | no arrows/Esc/focus mgmt; global Esc skips toolbar `open` | PARTIAL (mouse-only menu) | P1 |
| TB-U3 Prototype entry | FIXED: toolbar Prototype toggle (flow glyph, mirrors DevMode toggle + ⇧E both-ways); palette rows show ⇧E | FIXED (P1) | — |
| TB-U4 caret + Done tooltips | native `title=` inside a Tooltip-using component | PARTIAL (§2.3) | P2 |
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
| IN-U2 | FIXED: seg entry shows only when the vector card is absent (exactly one entry always); both use id+toast+⇧⌘O title; card refuses the stroke-less no-op with a teaching toast; labels unified | FIXED (P1) | — |
| IN-U3 | Component/Instance, Boolean, Poly/Star headers use h-row, not Section (no collapse/persist, different chrome) | DRIFT (§29) | P2 |
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
| FS-U1 | NO property-first variable binding: ColorRow/type/layout rows have zero bind affordance; binding requires leaving the inspector for the left Variables tab (variable-first only). §13 expects variable in the picker flow | MISSING UI | P1 |
| FS-U6 | RETRACTED as filed: `patch` DOES generically detach (memory:2489–2499 — my earlier grep was head-truncated). Fill/stroke/type/radii/text edits correctly unbind. The chip text is TRUE. Remnants below (verified by full read + handler-by-handler check) | RETRACTED | — |
| FS-U6′ | REAL remnant, FIXED: `hideSel` toggled `visible` without detaching a `visible` binding (the only bindable prop outside patch/resize/autoLayout, all verified covered) → toggle silently reverted on next relayout. Fix: detach visible + ownBindings.visible in hideSel (mirrors precedents). Tests: +4 in variables.test.mjs (100/0) | FIXED | P2 |
| FS-U5 | BindingChip renders ONLY for fill + strokePaint: all other bindable props (opacity? fontSize? layoutGap? w/h?) show no indicator when bound, so FS-U6-class surprises are invisible there too | PARTIAL | P1 |
| FS-U2 | Native window.prompt/confirm in ≥10 UI sites (variable/collection/mode rename+create, mode+style delete/create, new-file confirm, offset distance, project name) — blocking browser dialogs instead of X-Native modals (§17) | DRIFT | P1 |
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
| TY-U3 | Multi-select type metrics (size/leading/tracking/¶ + family/weight selects) show FIRST-layer values, no Mixed — IN-U1 sibling (§29) | PARTIAL | P1 |
| FS-U6 scope+ | RETRACTED with FS-U6: patchType→patch detaches correctly (verified) | — | — |
| TY-U4 | Round-to-pixels button has BOTH Tooltip wrapper AND native title= → double tooltip | DRIFT | P2 |
| TY-U5 | Hidden x-ui "wiring" div (`display:none` PropertyField to force bundling) — dead UI + bundling hack; one of only 3 x-ui usages | DEAD UI | P2 |
| TY-U6 | Tooltip is pointer-only (no focus trigger) — keyboard users never see tooltips (§32) | PARTIAL | P2 |

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

CORRECTION to §2.1: XPopover IS adopted (EffectPopover renders inside it). Still unused: XDialog,
XTabs, XButton, XInput, XSelect, XSegmentedControl, PropertyField (except the hidden hack), ContextToolbar.
CONNECTED: FillPicker (anchor+flip+clamp, Esc, outside-click, role=dialog), EffectPopover (via XPopover,
nested-picker-aware outside-click), ContextMenu (clamped, Esc, outside, arrow nav incl. submenus),
Actions palette (combobox/listbox/activedescendant, arrows+enter+esc, filters, empty state), NudgeDialog
(Esc capture + veil + close btn), ExportAssetsDialog (veil + global Esc), FigInspectorModal (Esc + veil).

| # | Finding | Status | Pri |
|---|---|---|---|
| PM-U1 (=FS-U2) | ≥10 native window.prompt/confirm sites and NO X-Native confirm/prompt modal (XDialog unused, no wrapper). Fix: XConfirm/XPrompt on XDialog + migrate all sites | MISSING UI | P1 |
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
| LP-U1 | FIXED: RightPanel/PageDesign take onOpenVariables from App (setNav("variables")); legacy setLeftTab kept as fallback only | FIXED (P1) | — |
| LP-U2 | leftTab is write-only engine state (⌥1..3 writes it alongside the working onNav; zero readers) — remove or unify (same fix) | DEAD STATE | P2 |
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
- CONSISTENCY: four tab systems (PM-U5), two tooltip systems (§2.3), two Esc owners (PM-U3),
  `export-run` class reused for Present/vector-Done (PT-U2/IN-U4), two accent greens (FR-U2).
- DISCOVERABILITY: prototype tab (TB-U3), italic (TY-U1), property-first binding (FS-U1), ⇧E/⌘⌥↩ chords
  (TB-U6/PT-U7), rotate zone (FR-U3), and the entire product for first-run users (LP-U4) are
  unreachable without prior knowledge.
- AFFORDANCE: locked selections show editable handles that refuse (FR-U1); "Edit vector" flattens
  (IN-U5); Resources opens the command palette (TB-U1); duplicate Outline-stroke buttons diverge (IN-U2).
- FEEDBACK: bound-value edits vanish without notice (FS-U6); AgentPane swallows unmatched input (LP-U6);
  multi-select shows first-layer values as shared (IN-U1/TY-U3).
- ERROR PREVENTION: guard toasts on binding (good); native confirm() for destructive mode delete (PM-U1);
  corrupt→toast + fresh doc (honest, minimal).
- ACCESSIBILITY: align/valign/decoration buttons have no accessible name at all (TY-U2); tooltips are
  pointer-only (TY-U6); tool flyouts/menu-less popovers lack keyboard paths (TB-U2); dialogs lack initial
  focus (PM-U6); canvas chrome is color-only for lock state (would-be FR-U1 fix must not be color-only).
- KEYBOARD WORKFLOW: palette/tree/menus have arrows; flyouts, tabs, orientation segs, and the dock have
  none; shortcuts exist but are advertised inconsistently (⌘/ claimed twice, ⇧E/⇧F hidden).
- CANVAS/INSPECTOR/TOOLBAR/POPUP/MODAL: canvas chrome is the strongest surface (type-aware, culled,
  badged); inspector has the best primitives (Section/Field) with the worst multi-select honesty;
  toolbar has a duplicate + mouse-only flyouts; popovers are individually good but unshared; modals are
  bespoke + native-dialog-backed.
- TYPOGRAPHY/ICONOGRAPHY/SPACING/COLOR: type scale + icon scale disciplined (12/14/16); spacing and
  radius have NO token scales (ad-hoc gaps/radii everywhere); color tokens complete incl. dark theme +
  green/red/amber, but canvas + chips bypass them with hardcoded values.
- MOTION/PERFORMANCE PERCEPTION: motion restrained and non-blocking (pass); memo'd panel/tree + hover
  guards show perf intent; full-snapshot subscriptions remain the structural risk (§33 — not measured
  here for lack of a browser).

## §5. Plan (running)
1. Per-surface code↔UI traces + integration tables (§2.4 order). 2. Senior critique (§26) with concrete
   causes. 3. `X_NATIVE_DESIGN_SYSTEM.md` from verified tokens + x-ui (+ gaps closed). 4. Incremental
   migrations/fixes (shared components, tooltip unification, inspector row clarity, toolbar hierarchy,
   modal/popover consistency) — smallest correct layer, no behavior regressions. 5. Headless tests for
   every integration fix; suite stays 1776+ green; tsc + build green. 6. Final docs + report.
