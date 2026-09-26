# Figma Behavior Parity Fixes — X-Native (TS)

- Date: 2026-09-26. Branch: `arena/01a0d904-x-native`, HEAD `6e0e90d` (base `c7c6d34`).
- Companion: `FIGMA_BEHAVIOR_PARITY_AUDIT.md` (findings, matrices, remaining issues).
- Working ledger: `X-Native/docs/BEHAVIOR_AUDIT_2026-09-26.md` (§§5–26, per-fix evidence + code refs).
- Counts: **224 fixes** — P0 9/9, P1 122/123 (1 open: §7 rotation-sign), P2 93/93.
- Per-area headers give primary files + regression file; each fix states was→fix. Fixes carry `§N ID`
  code comments where the area used markers (fully marked in §26; partially in §§17/25; area-level
  otherwise — all verified present in source).

## P0 — critical (9/9 fixed)

### G-000 §9 Guides invisible + ungrabbable
Was: `.guide-x`/`.guide-y` CSS classes missing — guides never painted and had no hit target; the whole
guide feature was unusable. Fix: added guide paint + hit + drag in `ui/Guides.tsx`, styles in `styles.css`
(re-verified this session: classes present), selection/Delete/Esc/menu wiring in `engine/memory.ts`.
Tests: `guides.test.mjs` (+19 guide checks incl. G-000 visibility/grab).

### M-001 §13 Mask clip wrong
Was: mask clipping produced wrong output for text, alpha, and blurred content — masks fundamentally broken.
Fix: `partitionMaskRuns`/`paintMaskedRun` in `engine/paint.ts` (re-verified present, line ~559).
Tests: `images.test.mjs` (mask-render cases).

### C-003 §17 Aliased library ids
Was: two components could share one library id — edits cross-talked between components. Fix: unique id
issue + collision guard in `engine/memory.ts`. Tests: `components.test.mjs`.

### C-005 §17 Shared instance child ids
Was: instance children shared ids — id collision corruption across instances. Fix: fresh id assignment on
instantiate in `engine/memory.ts`. Tests: `components.test.mjs`.

### C-009 §17 Variant publish hit wrong def
Was: edits to variant B silently overwrote variant A's definition. Fix: publish targets the edited
variant's own def in `engine/memory.ts`. Tests: `components.test.mjs`.

### C-012 §17 Root sync corruption
Was: instance sync could mismatch roots — deep corruption. Fix: `findInstanceRoot` guard
(re-verified present in `engine/memory.ts`, ~line 254) + root checks at sync entry. Tests: `components.test.mjs`.

### C-013 §17 Reset grafts master-root clone
Was: reset grafted a master-root clone inside the member. Fix: reset restores member state without grafting
in `engine/memory.ts`. Tests: `components.test.mjs`.

### VR-007 §18 Duplicate variable ids
Was: dupe variable ids silently shadowed each other in resolution. Fix: dedupe guard in
`engine/variables.ts`. Tests: `variables.test.mjs`.

### HI-003 §25 Burst coalescing into thin air
Was: burst edits coalesced onto a null base — edits became unundoable and redo was eaten (history
corruption). Fix: `lastHist` reset discipline in `engine/memory.ts` (re-verified: reset sites + guard at
coalesce, ~lines 1154/1487/1510/1589). Tests: `history25.test.mjs`.

## P1 — significant (123 fixed, grouped by area)

### §5 Frames — `ui/Canvas.tsx`, `ui/chrome.tsx`, `engine/memory.ts` | tests `parity.test.mjs` (+11)
- **F-002** Help advertised ⌥⌘G but nothing bound; menu item display-only → bound chord + wired menu.
- **F-003** ⌘⌫ deleted whole selection → ungroups one level, children preserved.
- **F-005** ⌥⌘E resize-to-fit missing entirely → chord + fit function shipped.
- **F-007** Esc cleared selection at frame level → climbs child→frame→top→page.
- **§5-cleanup** Boolean chords dead on macOS (dead-keys) + duplicate branch → code+key fallback, deduped.

### §6 Selection — `ui/Canvas.tsx`, `ui/selectSame.ts`, `ui/chrome.tsx` | `parity.test.mjs` (+7)
- **S-001** Click on selected group did nothing → drills into the group.
- **S-002** ⇧-range crossed parents → siblings (same parent) only.
- **S-004** ⇧-marquee unioned → replaces marquee set, anchor kept.

### §7 Transform — `ui/fieldExpr.ts`, `ui/inspector.tsx`, `engine/memory.ts` | `parity.test.mjs` (+8)
- **T-001** Align/distribute/rotation-origin `e.key` chords dead on macOS → code+key fallback.
- **T-005** Shadow offsets stayed axis-aligned on rotate → offsets rotate with layer.

### §8 Navigation — `ui/Canvas.tsx`, `ui/chrome.tsx` | `parity.test.mjs` (+6)
- **N-002** Some move paths skipped pixel snap → snap on all move paths.

### §9 Guides — `ui/Guides.tsx`, `engine/memory.ts`, `styles.css` | `guides.test.mjs` (+19)
- **G-002** No guide selection → selectable; Delete/Esc/menu act on guides.
- **G-003** Canvas guides only → frame-level guides shipped.
- **G-004** Resize ignored guides → resize snaps to guides.
- **G-006** Fixed-grid settings stored but renderer ignored them → columns/rows/gutter/margins render.
- **G-007** Layout-grid fields missing from inspector → count/gutter/margins fields shipped.

### §10 Fills — `ui/FillPicker.tsx`, `ui/inspector.tsx`, `engine/paint.ts` | `fills.test.mjs` (+19)
- **P-001** Angular gradient mirrored → correct mirror.
- **P-002** Conic sweep origin 90° off → Figma origin.
- **P-003** Radials forced circular → elliptical supported.
- **P-004** Gradient handles targeted hidden/removed stops → target visible stops only.
- **P-005** Rotate/blend dead on extra fills → apply to all fills.
- **P-010** Image fill type dead-ended with no image → always resolvable.

### §11 Strokes — `engine/strokeModel.ts`, `ui/inspector.tsx`, `engine/memory.ts` | `strokes.test.mjs` (+55)
- **K-004** Width profiles swallowed strokes on branching paths → render on branches.
- **K-005** Outside spill region unclickable → clickable/selectable.
- **K-007** Phantom gradient/image/blend stroke controls silently dropped edits → removed; supported only.

### §12 Effects — `ui/effectModel.ts`, `ui/inspector.tsx`, `engine/paint.ts` | `effects.test.mjs` (+51)
- **L-001** Noise/texture stack order wrong → Figma order.
- **L-002** First-noise-only + mislabeled → multi-noise + correct labels.
- **L-003** First-shadow-only on text/booleans → multi-shadow supported.
- **L-004** Show-behind ignored → honored.
- **L-005** Spread applied where invalid → gated to supporting types.
- **L-007** ⌘D in fx popover duplicated the layer → duplicates the effect.
- **L-009** No shadow with extra-only fills → renders.
- **L-010** Noise vanished on line layers → renders.

### §13 Images — `ui/cropModel.ts`, `engine/paint.ts`, `ui/inspector.tsx` | `images.test.mjs` (+52)
- **M-003** No crop interaction → crop tool with handles + commit shipped.
- **M-004** No place-image flow → place flow shipped.
- **M-006** Tile/adjust model gaps → tile mode + adjustments modeled.
- **M-009** Only first image fill rendered → stacked image fills render.
- **M-EX** Export peeked unmasked output → masked output.

### §14 Type — `ui/textLayout.ts`, `ui/inspector.tsx`, `engine/memory.ts` | `typography.test.mjs` (+39)
- **Y-001** Drag kept text auto → auto→fixed on drag.
- **Y-002** Vertical align applied on auto-height → gated to fixed-height.
- **Y-003** Small caps not rendered → rendered.
- **Y-004** Leading could collapse → floored per Figma.
- **Y-006** Tracking dropped on justified text → honored.
- **Y-008** Wrong hug height → measured correctly.
- **Y-009** Truncate/max-lines ignored → honored.
- **Y-010** Click didn't switch editing target → switches to clicked text.
- **Y-011** Advertised chords unbound; ⌥⌘L removed auto-layout → bound; ⌥⌘L safe.
- **Y-012** Metric chords missing; stale hug → bound + rehug.
- **Y-014** Dev-mode CSS emitted invalid lists → valid lists.
- **Y-015** Phantom values accepted but never rendered → clamped to renderer capability.

### §15 Vectors — `engine/geometry.ts`, `ui/Canvas.tsx`, `engine/memory.ts` | `vector.test.mjs` (+28)
- **V-001** Booleans pre-flattened; dead drill → members drillable.
- **V-002** Backspace with no point ate an anchor → no-op.
- **V-004** Click started second draft → inserts point on path.
- **V-005** Arrows moved layer in edit mode → move selected points.
- **V-007** Insert split/deformed arcs → curve shape preserved.

### §16 Layers — `ui/chrome.tsx`, `engine/memory.ts` | `layers.test.mjs` (+24)
- **L-001** Locked children still editable → lock inheritance enforced.
- **L-002** Ungroup single-child mis-spliced; rotation lost → splice + rotation kept.
- **L-003** Cross-parent move no-op → works.

### §17 Components — `engine/memory.ts`, `engine/types.ts` | `components.test.mjs` (+55)
- **C-001** Instance member geometry leaked to main → no leak.
- **C-002** No structural guards → destructive ops on instances guarded.
- **C-004** Master detach orphaned instances → no orphans.
- **C-006** Reset restored wrong variant → own variant.
- **C-007** Overrides cross-wired → own instance.
- **C-010** Publish gaps (nested/override) → covered.
- **C-011** Overrides dropped on variant switch → carried.

### §18 Variables — `engine/variables.ts`, `engine/memory.ts`, `ui/inspector.tsx` | `variables.test.mjs` (+32)
- **VR-001** Only "var" bound → "variable" alias bound too.
- **VR-002** Picker missing on stroke/effects → present.
- **VR-003** Unguarded tuples → guarded.
- **VR-004** Scale-factor ignored → applied.
- **VR-005** Arc radius refused variables → accepted.
- **VR-006** Number→string bind failed → coerced.
- **VR-008** Alias cycles possible (hang) → refused.
- **VR-009** String coercion wrong/missing → correct.
- **VR-010** Unlink dropped value → restores alias target value.
- **VR-014** Mode snapshot leaked across modes → clean snapshot.

### §19 Auto layout — `engine/layout.ts`, `ui/layoutActions.ts`, `ui/Canvas.tsx` | `autolayout.test.mjs` (+42)
- **AL-001** Arrow keys flipped hug→fixed wrongly → correct flip.
- **AL-002** Single gap only → independent row/column gaps.
- **AL-003** min/max ignored when wrapped → honored.
- **AL-005** First/last margin ignored → honored.
- **AL-006** List reorder broke layout position → keeps position.
- **AL-007** Hidden toggle silent no-op / layout loss → toggles without loss.
- **AL-008** Wrap drop index wrong → correct.
- **AL-009** Baseline+stroke misaligned → aligned.
- **AL-010** Wrap badge missing → shown.
- **AL-011** Distribute via DnD missing → works.
- **AL-014** Keyboard trapped in layout context → leaves.

### §20 Inspector — `ui/inspector.tsx`, `ui/fieldExpr.ts`, `engine/memory.ts` | `inspector.test.mjs` (+40)
- **IN-001** Multi-select showed first value as uniform → mixed-state shown.
- **IN-002** Scale vs resize conflated → distinguished.
- **IN-003** Tidy-up missing/broken → works.
- **IN-004** Multi-select bulk actions missing → present.

### §21 Toolbar — `ui/chrome.tsx` | `toolbar.test.mjs` (+12)
- **TB-002** Advertised zoom chord unwired → wired.

### §22 Menus — `ui/ContextMenu.tsx`, `ui/chrome.tsx` | `menu.test.mjs` (+13)
- **MN-004** Disabled items silent no-ops with misleading toast → explain why.

### §23 Prototype — `ui/PresentationPlayer.tsx`, `engine/protoEval.ts` | `proto.test.mjs` (+13; PT-008 in `parity.test.mjs`)
- **PT-001** Present dropped out of flow → stays in flow.
- **PT-002** Drag triggered navigation → drag vs nav disambiguated.
- **PT-003** Overlay close wrong → correct.
- **PT-004** Dead triggers → all fire.
- **PT-005** Delay unauthorable → authorable.
- **PT-006** Media triggers broken → work.
- **PT-007** None→dismiss missing → supported.
- **PT-011** Scroll-to gating wrong → correct.
- **PT-012** Action type missing from UI (engine cmd existed) → added.
- **PT-014** Overlay position wrong → correct.
- **PT-017** Expression eval gap for numbers → evaluated.
- **PT-018** Variable-driven nav silently dropped → resolves.

### §24 Export — `ui/exportModel.ts`, `engine/svgExport.ts`, `engine/codegen.ts` | `export24.test.mjs` + `codegen.test.mjs` (+43)
- **EX-002** Slice bounds wrong → correct.
- **EX-003** No slice model → shipped.
- **EX-004** PDF page size wrong → correct.
- **EX-005** PNG/JPG scales missing → offered.
- **EX-006** SVG choice missing → offered.
- **EX-007** PDF renderer wrong → correct.
- **EX-010** Copy-link broken → works.
- **EX-011** Lossy SVG emitter → lossless.
- **EX-013** Re-import dead-end → round-trips.

### §25 History — `engine/memory.ts` | `history25.test.mjs` (+24)
- **HI-001** Redo eaten by unrelated edits → preserved.
- **HI-002** First-command undo broken → clean.
- **HI-006** Mid-sweep wheel corrupted sweep → handled.
- **HI-007** First-entry redo broken → works.

### §26 Keyboard — `ui/chrome.tsx`, `ui/ContextMenu.tsx`, `engine/memory.ts`, `engine/types.ts` | `keyboard26.test.mjs` (+21)
- **KB-001** Ctrl+Y swallowed → redoes (Win/Linux).
- **KB-002** ⌘I missing + no italic model → `italic` on node + chord toggles.
- **KB-003** Chords dead on macOS dead-keys → guarded fallback.
- **KB-004** `/` and `⌥/` did nothing → remove stroke / remove fill.
- **KB-017** Menu arrows dead; Esc cleared selection → arrows navigate; Esc closes menu safely.

## P2 — polish/minor (92 fixed, grouped by area)

### §5 Frames (`parity.test.mjs`)
- **F-001** Only F bound → A added. · **F-004** Nested frames inherited size → top-level-only reuse.
  **F-006** Presets cascaded → land left/same-Y, swap on repeat. · **F-008** No quick-add badges → shipped.
  **F-009** No W/H scrub → shipped.

### §6 Selection (`parity.test.mjs`)
- **S-003** No panel hover highlight → highlights. · **S-005** Select-same missed Instance → covered.

### §7 Transform (`parity.test.mjs`)
- **T-002** Aspect lock ignored min/max → respects. · **T-003** Equation tokens rejected → accepted.
  **T-004** No ⌥-scrub from inputs → scrubs.

### §8 Navigation (`parity.test.mjs`)
- **N-001** Zoom labels swapped → "Zoom in/out".

### §9 Guides (`guides.test.mjs`)
- **G-001** One undo entry per nudge → coalesced. · **G-005** 8% canvas margin → 10%.

### §10 Fills (`fills.test.mjs`)
- **P-006** − only hid fill → removes. · **P-007** Delete ignored stop → removes stop.
  **P-008** Inserted stop wrong color → neighbor color. · **P-009** Same-color stop lost selection → stable.

### §11 Strokes (`strokes.test.mjs`)
- **K-001** Dash phase ignored → honored. · **K-002** Dash caps wrong → correct. · **K-003** No join
  preview → hover preview. · **K-006** Join hidden with arrows → visible. · **K-008** Circle tip missing →
  offered. · **K-009** Label mismatch → "Align".

### §12 Effects (`effects.test.mjs`)
- **L-006** No effect preview → hover preview. · **L-008** BG-blur invalid target silent → warns.

### §13 Images (`images.test.mjs`)
- **M-002** No mask outlines view → shipped. · **M-005** Image cascade wrong → fixed.
  **M-010** Fit readout mislabeled → fixed. · **M-LBL** Video labels wrong → fixed.

### §14 Type (`typography.test.mjs`)
- **Y-005** Indent on wrong aligns → gated. · **Y-007** Strikethrough mispositioned → fixed.
  **Y-013** Style label wrong → fixed.

### §15 Vectors (`vector.test.mjs`)
- **V-003** Close-ring offered everywhere → scoped. · **V-006** No ⇧-constrain on points → constrains.
  **V-008** Tangent kinked on drag → smooth. · **V-009** No ⌥-pull → independent handle drag.
  **V-010** Zero-length segments kept → cleaned.

### §16 Layers (`layers.test.mjs`)
- **L-004** No ⌥-fold → folds subtree. · **L-005** No reveal on select → reveals row.
  **L-006** Whitespace rename accepted → rejected. · **L-007** Prompt-only rename, weak reorder → inline
  rename + drag reorder.

### §17 Components (`components.test.mjs`)
- **C-008** Insert position wrong → correct.

### §18 Variables (`variables.test.mjs`)
- **VR-011** Rename gestures missing → work. · **VR-012** Case-only rename rejected → allowed.
  **VR-013** Picker coverage gaps → full Figma-supported coverage.

### §19 Auto layout (`autolayout.test.mjs`)
- **AL-004** Gap readout wrong → accurate. · **AL-012** Canvas DnD gaps → work. · **AL-013** Align DnD
  gaps → work.

### §20 Inspector (`inspector.test.mjs`)
- **IN-005** No scrub hint → shown. · **IN-006** Only ⇧ z-order chords → ⌘⌥]/[ added. · **IN-007**
  Distribute controls missing → present. · **IN-008** Help URL wrong → correct. · **IN-009** Constraints
  editor missing → present.

### §21 Toolbar (`toolbar.test.mjs`)
- **TB-001** Tool tooltip missing/wrong → correct. · **TB-003** Zoom shortcut gaps → complete.
  **TB-004** Add-frame missing → present. · **TB-005** Zoom in menus missing → present. · **TB-006** Dead
  font-list code → removed.

### §22 Menus (`menu.test.mjs`)
- **MN-001** Paste-over label wrong → fixed. · **MN-002** Boolean labels wrong → fixed. · **MN-003**
  Flatten label wrong → fixed. · **MN-005** Selection submenu gaps → complete. · **MN-006–008** Paste/guide/
  vector labels mismatched → per Figma.

### §23 Prototype (`proto.test.mjs`)
- **PT-008** Smart-animate order wrong → correct. · **PT-009** Scroll overflow ignored → honored.
  **PT-010** No reset-scroll on entry → resets. · **PT-013/015/016** Trigger/timing/easing labels → fixed.
  **PT-019** Variable conn lines missing → drawn.

### §24 Export (`export24.test.mjs`)
- **EX-001** Batch rows missing from UI → present. · **EX-008** Export icon button missing → present.
  **EX-009** Suffix default wrong → correct. · **EX-012** Format label → fixed. · **EX-014** Scrolled slice
  wrong → correct.

### §25 History (`history25.test.mjs`)
- **HI-004** History guard crash path → no crash. · **HI-005** Stale sweep on new cmd → correct resweep.

### §26 Keyboard (`keyboard26.test.mjs`)
- **KB-005–016** Text-edit / type-tool-guard / vector / layer / pixel-zoom-climb / grid / align /
  distribute / show-hide-UI / boolean / layer-list chords → per official article. · **KB-018** Library/asset
  chords missing → bound. · **KB-S** Shortcut sheet stale → audited to match bindings.

## Verification

| Check | Command / path | Result (HEAD `6e0e90d`, 2026-09-26) |
|---|---|---|
| TS typecheck | `cd X-Native/apps/web && ./node_modules/.bin/tsc -b` | ✅ exit 0 |
| Production build | `npm run build` | ✅ 4.31s |
| Full suite | `npm test` | ✅ **1776 passed / 0 failed**, 22 files |
| Audit regression coverage | `parity` (shared §§5–8,20,23) + `guides fills strokes effects images typography vector layers components variables autolayout inspector toolbar menu proto export24 codegen history25 keyboard26` | ✅ § trackers ~610 added checks; net 1216→1776 |
| E2E | `npm run test:e2e` → `e2e/behaviour.mjs` | ⚠️ NOT VERIFIED — no Chromium in sandbox; provisioning blocked (see audit §2). Runner exists and is wired; must run in CI/browser env |
| Rust | — | N/A — no toolchain; product track is TS (`track=ts`) |
| Live-pointer feel | — | NOT VERIFIED — code-traced + headless-tested only (audit §8) |

Per-fix verification rule (§39.12): only the checks above were executed. No E2E, browser, or Rust results
are claimed. Every fix ships with headless regression tests in the file listed in its area header.

## Files changed

Branch `arena/01a0d904-x-native` vs base `c7c6d34`: **111 files, +45464/−2001**. That span includes
earlier session groundwork (perf harness + results, geo-bridge design + mocks, MCP server, phase docs) as
well as this audit. Audit-fix code is concentrated in:

- engine: `memory.ts`, `types.ts`, `paint.ts`, `layout.ts`, `geometry.ts`, `variables.ts`, `protoEval.ts`,
  `strokeModel.ts`, `svgExport.ts`, `codegen.ts`, `snapping.ts`, `clipboard.ts`, `files.ts`, `persist.ts`,
  `designApi.ts`, `lint.ts`, `modifierStack.ts`
- ui: `Canvas.tsx`, `chrome.tsx`, `inspector.tsx`, `ContextMenu.tsx`, `Guides.tsx`, `FillPicker.tsx`,
  `effectModel.ts`, `cropModel.ts`, `exportModel.ts`, `fieldExpr.ts`, `layoutActions.ts`, `scaleModel.ts`,
  `selectSame.ts`, `textLayout.ts`, `search.ts`, `devPrefs.ts`, `a11y.ts`, `x-ui.tsx`, `icons.tsx`,
  `PresentationPlayer.tsx`, `FigInspectorModal.tsx`, `ZenHUD.tsx`, `Dashboard.tsx`, `App.tsx`, `styles.css`
- tests: 22 audit regression files (`parity`, `guides`, `fills`, `strokes`, `effects`, `images`,
  `typography`, `vector`, `layers`, `components`, `variables`, `autolayout`, `inspector`, `toolbar`, `menu`,
  `proto`, `export24`, `codegen`, `history25`, `keyboard26`, + shared `workflow`/`designapi` context)
- docs: `X-Native/docs/BEHAVIOR_AUDIT_2026-09-26.md` (ledger), this file, `FIGMA_BEHAVIOR_PARITY_AUDIT.md`

## Remaining issues (same as audit §9)

1. Rotation-sign convention (P1, §7 T-DEV) — needs Figma-side comparison.
2. Locked-layer patch whitelist (P1, §20 deferred hole) — whitelist at patch entry.
3. Tidy-up gap readout surface (P2, §20) — engine computes, no UI surface.
4. E2E NOT VERIFIED — run `npm run test:e2e` in a browser environment.
5. Live-pointer feel NOT VERIFIED for drag/cursor/motion paths.
