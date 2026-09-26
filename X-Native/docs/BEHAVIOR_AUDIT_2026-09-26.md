# X-Native ↔ Figma Behavior-Maturity Audit

**Started:** 2026-09-26 · **Branch:** `arena/01a0d904-x-native` · **Rule:** only features X-Native
already has; Figma is the behavior benchmark, not the UI template. Prior micro-parity work:
`MICRO_PARITY_GAP_2026-09-25.md` (all 10 implemented, `b502f9f`).

**Method limits (sandbox):** no browser can run here — every finding is code-traced in `apps/web/src`
and, where the behavior lives below the DOM, exercised headlessly (engine dispatches, render fns with
mock contexts, `npm test`). Pointer/keyboard bindings are verified by tracing handlers, not by clicking.

## Section tracker

| § | Area | Status | Findings fixed |
|---|------|--------|----------------|
| 5 | Frames (create/select/transform/chrome/labels/props) | ✅ done | F-001–F-009 + bool-branch cleanup (11 tests) |
| 6 | Selection system (type-aware matrix) | ✅ done | S-001–S-005 (7 tests) |
| 7 | Transform / resize / rotate | ✅ done | T-001–T-005 (8 tests) + 1 known deviation |
| 8 | Canvas navigation (pan/zoom/guides/minimap) | ✅ done | N-001–N-002 (6 tests) |
| 9 | Grid / guides / rulers | ✅ done | G-000–G-007 (19 tests) |
| 10 | Fill / color / gradient | ✅ done | P-001–P-010 (19 tests) |
| 11 | Strokes (+ variable) | ✅ done | K-001–K-009 (55 tests) |
| 12 | Effects / shadows / blur | … | |
| 13 | Images (place/crop/mask/export) | … | |
| 14 | Typography (+ phantom controls) | … | |
| 15 | Vector / pen (object vs edit mode) | … | |
| 16 | Layers / structure | … | |
| 17 | Components | … | |
| 18 | Variables / tokens / styles | … | |
| 19 | Auto Layout UX | … | |
| 20 | Contextual inspector | … | |
| 21 | Context toolbar | … | |
| 22 | Popups / popovers / menus | … | |
| 23 | Prototyping | … | |
| 24 | Import / export | … | |
| 25 | Undo / redo (per category) | … | |
| 26 | Keyboard behavior | … | |

## Findings log

<!-- F-### | § | Figma behavior | X-Native behavior (file:line) | Fix (commit) | Tests -->

## §5 Frames — evidence & fixes (2026-09-26)

Figma refs: "Frames in Figma Design" + "Frames vs Groups" help articles (fetched 2026-09-26).
Baseline `1216 passed, 0 failed`; after: `1227 passed, 0 failed`. `tsc -b` clean.

### Fixed (all shipped in the §5 frame commit on this branch)

- F-001 — Frame tool is `F` **or `A`** in Figma; X-Native mapped `f` only (`chrome.tsx` tool map).
  Fix: added `a: "frame"` (⇧A still wins earlier for auto layout).
- F-002 — ⌥⌘G / Ctrl+Alt+G wraps the selection in a **plain frame** (no layout); X-Native had no
  binding (help text at `chrome.tsx:3109` advertised it; `frame-sel` menu entry was display-only).
  Fix: new `frameSelection` engine command (white + clip, no layout, via `wrapSel`), chord with
  shift-wins, Arrange-menu row.
- F-003 — ⌘⌫ / Ctrl+Backspace **ungroups** groups and frames; X-Native deleted them.
  Fix: chord ungroups each selected group/frame (mixed selections still delete).
- F-004 — Canvas click: first top-level frame 100×100, later top-level frames reuse the **last
  top-level size**, nested clicks 100×100; X-Native always 100×100. Fix: engine `lastFrameSize`
  (set on top-level add/wrap, exposed on snapshot), read by Canvas click-create.
- F-005 — Resize-to-fit (⌥⇧⌘R / Alt+Shift+Ctrl+R or Layout button) hug-wraps children; missing.
  Fix: new `resizeToFit` command (visible non-absolute child bbox, children keep absolute
  positions, frames + groups), chord, Arrange-menu row, Layout-section button.
- F-006 — Frame-tool presets + selected-frame preset swap. Presets existed but always landed at
  fixed (80,80); no swap dropdown. Fix: preset frames land at viewport top-left; new Frame
  dropdown in Layout (Custom size + grouped presets; swaps w/h and renames).
- F-007 — Esc walks **one nesting level up** before clearing; X-Native always deselected all.
  Fix: single nested selection → select parent first (text-edit Esc still commits first).
- F-008 — Frame-tool hover shows **+ quick-add** badges duplicating the frame (⌥ = blank
  same-size, left/right badge = side). Missing. Fix: painted badges + hit branch; duplicate
  takes a new explicit `dx/dy` override so adjacency placement never corrupts the ⌘D cascade.
- F-009 — W/H field **label-drag scrub** (1px = 1 unit, ⇧ = ×10); X-Native had field math but no
  scrub. Fix: `Field` label/icon mousedown scrub, 3px click-vs-drag threshold (label-click mode
  cycling preserved), live change, one undo step via the patch coalescer.
- Cleanup — Gap-1 boolean audit left **two** ⌥⇧U/S/I/E branches (pre-existing `e.key` one only
  failed on macOS dead-keys). Merged: old branch e.code-ified (incl. ⌥⇧F flatten), duplicate
  deleted. Corrects the earlier "dead on all platforms" claim: it worked on Win/Linux.

### Verified parity (traced, no fix needed)

F/drag/nested creation incl. host parenting; ⌘G/⇧⌘G; paste-into-container; drop reparent;
locked-layer skips; clip toggle + render; unified/independent radius; top-level-only labels;
hover outline; type-aware chrome (selection ring, 6–22px corner rotate zone, rotOrigin pivot,
rotation-aware cursors); ⌘D cascade; field math; blend Pass through.

### Deferred / out of scope

- Group bounds always hug children (Figma) vs X-Native free-size groups: design decision, big
  blast radius — recorded, not changed.
- Preset swap applying child constraints: same as manual W/H typing today (no constraint pass
  on resize); revisit under §7.
- `*50%`-style percent-quirk in field math: kept safe-revert behavior.
- Nested selected-frame labels: no Figma doc found; unchanged.

## §6 Selection — evidence & fixes (2026-09-26)

Figma refs: "Select layers and objects" help article (both chunks) + forum/Reddit ground truth
on click barriers and deep-select direction. After: `1234 passed, 0 failed`. `tsc -b` clean.

### Fixed (shipped in the §6 selection commit on this branch)

- S-001 — A single click must never drill: Figma drills via double-click/Enter only. X-Native's
  `hitTest` stopped climbing at an already-selected group, so clicking inside one selected the
  child. Fix: removed the selection-aware climb-break (group/boolean always win plain clicks).
- S-002 — Panel ⇧-click extends across **every visible row** between anchor and target; X-Native
  ranged siblings-only. Fix: shared range anchor + DOM order (expansion/search honored, no
  state lift); ⌘/plain clicks move the anchor.
- S-003 — Hovering a Layers-panel row highlights the layer on canvas; X-Native had no link.
  Fix: rows emit `x-panel-hover`, Canvas paints the standard hover outline + label emphasis.
- S-004 — ⇧-marquee adds to the selection; X-Native always replaced. Fix: union with the
  stashed pre-drag selection (shrinking the band lets go again).
- S-005 — "Select all with same" was missing Figma's **Instance** kind. Fix: new `instance`
  kind matching `componentId` (masters excluded); graceful empty-toast on plain layers.

### Verified parity (traced, no fix needed)

Parent-by-default for groups (frames transparent — confirmed against Figma forum behavior);
⌘/Ctrl-click deep-drills (direction verified); ⌘-marquee reaches nested, plain marquee stays
top-level; Enter/⇧Enter/Tab/⇧Tab tree walk; Select-layer submenu (hidden out, locked in with
padlock); ⇧-click toggle; ⌘A / ⌥⌘A matching / ⇧⌘A inverse; collapse-all keeps selection path;
click-empty/Esc deselect; locked unclickable on canvas.

### Deferred / out of scope

- ⇧-click reaching *matching* nested objects without drilling: real Figma carve-out, but
  matching-aware hit-testing is disproportionate — recorded, not implemented.
- Smart Selection (1D/2D arrange): no X-Native equivalent — OUT OF SCOPE.
- View-only selection chrome: no X-Native equivalent — OUT OF SCOPE.
- Enter into an all-hidden/all-locked container selects the first child anyway: judgment call,
  left as is.

## §7 Transform / resize / rotate — evidence & fixes (2026-09-26)

Figma refs: "Adjust alignment, rotation, position, and dimensions" (3 chunks), "Scale layers
while maintaining proportions", nudge/⌘-arrow Reddit threads. After: `1242 passed, 0 failed`.

### Fixed (shipped in the §7 transform commit on this branch)

- T-001 — ⌥W/A/S/D/H/V align, ⌃⌥H/V distribute, and Canvas ⌥R rotation-origin were `e.key`
  chords: dead on macOS (⌥A → å, ⌥R → ®), working on Win/Linux. Fix: e.code-ified all three;
  ⌥R additionally guarded against meta/shift, which also fixes a §5-introduced double-fire
  (⌥⇧⌘R resize-to-fit toggled the rotation target too).
- T-002 — Aspect lock did not link min/max limits; Figma sets the proportional opposite.
  Fix: `setMinMax` writes the ratio counterpart (clearing still clears one only).
- T-003 — Equations had no current-value token; Figma accepts `Mixed+100` and `(𝑥/2)+6`.
  Fix: `Mixed`/`𝑥`/standalone-`x` substitute the current value (only previously unparseable
  input reaches it; `0x10+1` still fails closed).
- T-004 — Scrub worked from labels/icons only; Figma also scrubs ⌥-drag from the input.
  Fix: Field inputs start a scrub on ⌥-mousedown (plain press still focuses/selects).
- T-005 — Drop-shadow offsets rotated with the layer (canvas `translate` under the node
  rotation; SVG `feOffset` in rotated user space); Figma never rotates effects. Fix:
  counter-rotated offsets on canvas (drop) and export (drop + inner; canvas inner already
  used device-space `shadowOffset`).

### Verified parity (traced, no fix needed)

Edge/corner handles; ⇧ temp-ratio, ⌃ releases lock, ⌥ from-center, ⌘/Ctrl ignores
constraints, snap skipped when locked; aspect-lock W/H link + instance exclusion; Scale tool
K (children/strokes/effects/text/corner/layout scale, constraints ignored, locked/instance
refused, multiplier + anchor box); nudge 1/10 prefs + ⇧big; rotate zone/⇧15°/±180 normalize/
origin drag/Esc; flip ⇧H/⇧V as persistent matrix; align single→parent + ⇧click-to-parent +
multi-mutual (+ grid/AL retargets); distribute outer-pinned (3+); dim labels; rotation field
with origin slide; X/Y field math.

### Known deviation (recorded, NOT fixed)

- Rotation sign is inverted vs Figma: clockwise drag stores **+** here, **−** in Figma
  (Figma positive = CCW; X-Native positive = CW throughout drag math, `nodeMatrix`,
  canvas `rotate`, and SVG `rotate`). Internally self-consistent, so nothing renders
  wrong — but a Figma-trained user typing −45° gets the mirror. Fixing = flipping the
  convention in `Canvas.tsx` rotate drag, `memory.ts` `nodeMatrix`, `svgExport.ts`, and
  every rotation consumer, with visual verification this sandbox cannot do. Needs a
  dedicated, visually-verified migration; tracked here, not attempted.

### Deferred / out of scope

- Multi-selection equations to all: inspector shows the first layer only — §20 topic.
- ⌘-arrow keyboard resize (Reddit-claimed): not in Figma docs; implemented nowhere; skipped.
- Scrub speed tiers (2x/1x/½x/¼x + toast): polish; 1px = 1u + ⇧×10 covers the need.
- Flip mirroring shadow offsets: left as is (no Figma doc either way).
- Tidy up / Smart selection: OUT OF SCOPE (no equivalent).
- Layer-order mechanics: §16; order shortcuts: §26.

## §8 Canvas navigation — evidence & fixes (2026-09-26)

Figma ref: "Adjust your zoom and view options" (both chunks). After: `1248 passed, 0 failed`.

### Fixed (shipped in the §8 navigation commit on this branch)

- N-001 — Zoom-menu pixel-preview shortcut labels were swapped: "Off" claimed ⌃P and "1x"
  claimed ⌃⌥P, while the binding toggles 1x on ⌃P and 2x on ⌃⌥P. Fix: labels corrected
  (1x → ⌃P, 2x → ⌃⌥P, Off → none).
- N-002 — Pixel-grid snapping only settled moves, and nothing always-snapped. Figma rounds
  placement/moves/resizes while Snap-to-pixel-grid is on, and frames/sections/components
  always snap with it off. Fix: pure `wantsPixelSnap` + `roundBox` in `snapping.ts`, wired
  to creation, move-end, and resize/multi-resize-end; settling runs before `end` so the
  pre-existing move-settle no longer costs its own undo step; preset frames land rounded.

### Verified parity (traced, no fix needed)

Default zoom-to-fit on open; % readout + typeable zoom + presets; ⇧+/⇧−/⇧1/⇧2/⇧0 (+ ⌘
variants); ⌘/Ctrl-wheel + pinch zoom at cursor; wheel pan; ⇧wheel horizontal pan; space,
middle-mouse, and hand pan; zoom tool click-in/⌥-click-out/drag-marquee with cursors;
pixel grid ≥400% only; pixel preview 1x/2x raster; ⌘'/⌘⇧' grid+snap pair; layout-guides,
property-labels, flows, outlines, comments, rulers menu toggles; ⇧2-with-empty-selection
no-op (no ⇧1 fallback); zoom never disturbs selection or tool.

### Deferred / out of scope

- Minimap drag/click-to-pan: the minimap is display-only and Figma has no minimap to
  benchmark against — new-feature territory, not a behavior fix. Recorded, not built.
- Layout-guides chord is ⇧G (Figma: ^G): X-Native shortcut vocabulary, kept deliberately.
- Rulers/guides mechanics: §9. Multiplayer cursors: no X-Native equivalent — OUT OF SCOPE.

## §9 Rulers, guides, grids — evidence & fixes (2026-09-26)

Figma refs: "Create layout guides" (uniform/column/row types, red-10% default,
count/type/width/offset/margin/gutter, multiples combine, per-guide + ⇧G
visibility) and "Add guides to canvas or frames" (rulers prerequisite,
ruler-drag create, ⌥-drag duplicate, canvas- vs frame-level by drop target,
drag-back/Delete/right-click removal). After: full suite green
(934 + 64 + 46 + 63 + 49 + 92 + 19 new guide checks).

### Fixed (shipped in the §9 guides commit on this branch)

- G-000 (P0) — Guide lines were painted as 0×0 divs: `.guide` had no axis
  rules, so guides were invisible and ungrabbable. Fix: `.guide-x/.guide-y`
  span the viewport on the free axis, hairline paint with padded grab area,
  ew/ns-resize cursors.
- G-001 — Every guide nudge was its own undo step. Fix: `moveGuide` is
  coalescible per guide, and the drag that places a newborn guide joins the
  `addGuide` step — creation is one undo, a later reposition its own.
- G-002 — Guides had no selection: no click-select, Delete/Esc did nothing,
  no context menu. Fix: engine `selectedGuide` + `selectGuide` command,
  mutually exclusive with the layer selection (not persisted, not history);
  chrome routes Delete/Escape to the guide when no layers are selected;
  right-click menu removes; selected guides paint green.
- G-003 — No frame-level guides. Fix: `RulerGuide.frameId`, creation re-homes
  by drop target (`deepestFrame`, stored in frame space), ⌥-drag duplicates
  inheriting the level, frame deletion cleans up its guides and a dangling
  selection, stale guides never paint.
- G-004 — Resize ignored guides (move already snapped to page guides only).
  Fix: `snapResize` takes ruler guides with guides-winning-ties over
  coincidental layer edges; Canvas resolves frame guides to world space for
  both move and resize.
- G-005 — New-grid default corrected to Columns at red 10% (was 8%); paint
  fallback matches.
- G-006 — Fixed types were model-only: paint ignored `alignment`/`offset`/
  `cell` and grids spilled past the frame. Fix: fixed-width columns/rows
  honour min/center/max with offset, stretch shrinks to fit, uniform grids
  shift by offset, all clipped to the frame.
- G-007 — Inspector exposed only count/gutter/margin/size. Fix: type select,
  fixed width/height (empty = stretch), offset, and hue swatch (alpha kept)
  for every pattern; "Fill pattern" mislabel corrected to "Grid pattern".

### Verified parity (traced, no fix needed)

Ruler rails create on drag; drag-back-to-rail and off-viewport discard;
double-click removes; hover hints; drag badge; per-guide eye; multiples
combine; ⇧G global toggle; guide redlines while ⌥-dragging (existing snap
guides); undo/redo of add/remove; keyboard nudging is layer-only in both
products (no guide-arrow-move either side — not a gap).

### Deferred / out of scope

- Guide styles / shared guide presets: no X-Native equivalent — OUT OF SCOPE.
- Dotted frame-intersection indicator on the ruler while dragging: Figma
  micro-feedback with no X-Native counterpart; the drop re-homes correctly.
- Blue ruler highlight tracking the selected guide: same, cosmetic only.
- Ruler pixel numbering origin at canvas 0,0 with pan/zoom: existing rulers
  verified visually unchanged; numbering audit is rendering, not behavior.

## §10 Fill / color / gradient — evidence & fixes (2026-09-26)

Figma refs: "Guide to fills" (5 types; + adds solid; per-fill opacity/eye/
drag-reorder/minus), "Update fills using the color picker" (palette, hue +
opacity sliders, eyedropper, blend, contrast, RGB/HEX/CSS/HSL/HSB, file
colors), "Use gradients" (4 types, 2 default stops, drag/click-+/select+Delete,
Flip, Rotate), widget `GradientPaint` docs (handle semantics), plus a tutorial
confirming the default linear runs top→bottom. After: full suite green
(934 + 64 + 46 + 63 + 49 + 92 + 19 + 19 new fill checks).

### Fixed (shipped in the §10 fills commit on this branch)

- P-001 — Angular gradients mirrored the ramp (red→blue→red reflected sweep).
  Figma sweeps the full circle with an authentic seam. Fix: ramp runs
  unmirrored in both render paths.
- P-002 — Angular sweep origin sat 90° off the handle (conic 0 = top, atan2
  0 = east). Fix: quarter-turn so the origin tracks the end handle.
- P-003 — Radials rendered elliptical via context scaling; Figma's are
  circles. Fix: plain circular radius from handle distance in pixels.
- P-004 — Canvas handles only targeted the base fill, and showed for hidden
  or removed gradients. Fix: `gradTarget` aims at the topmost visible
  gradient (extras over base); first drag pins inherited geometry explicitly
  so nothing jumps; hidden/none gradients yield no handles.
- P-005 — The stacked-fill picker dropped blend + gradient geometry, so
  Rotate and blend mode were silently dead on extra fills. Fix: kept.
- P-006 — Base-fill minus only hid (row lingered eye-off, + stacked over a
  hidden base). Fix: true removal via the none+hidden pair the stroke row
  already used; + re-adds the default fill.
- P-007 — Delete/Backspace ignored the selected gradient stop. Fix: removes
  it (never while typing, never below two stops).
- P-008 — Click-inserted stops copied the left stop's colour instead of the
  ramp's. Fix: OKLab-interpolated `mixHex`, exported from paint so the
  insert matches the rendered ramp exactly.
- P-009 — Dragging one of two same-colour stops lost selection (matched by
  colour). Fix: identity tracking.
- P-010 — Image type offered for stacked fills led nowhere (choice dropped,
  solid rendered). Fix: excluded from extras until §13 wires it.

### Verified parity (traced, no fix needed)

Solid + 4 gradients + image types; + adds solid white on the stack /
#D9D9D9 re-added base; per-fill opacity field, eye, minus, grip reorder (+
bonus step buttons); swatch opens anchored picker; hex/RGB/HSL/HSB/CSS
models; SV + hue + opacity drags, all coalesced to one undo step; eyedropper
in-picker (I), global (I / Ctrl+C) with pixel sampling + layer fallback;
per-fill blend in picker and render; contrast check with auto-fix; default
linear top→bottom; fresh second stop white; Reverse + 90° Rotate; stop drag,
bar-click insert, double-click remove, 2-stop floor; on-canvas handle line +
dots with begin/end single-undo drags; Selection Colors section; text fill
colours the glyphs; default-shape emerald kept deliberately (product
identity, not Figma grey).

### Deferred / out of scope

- Pattern and Video fills: no X-Native equivalent — OUT OF SCOPE.
- Variable bindings on gradient stops: §19 (variables) owns bindings.
- Stroke picker offers gradient/image types it cannot apply: §11 (strokes).
- Gradient CSS/SVG export: §25 (import/export); codegen has no gradient path.
- Angular default origin kept south: no Figma evidence for south vs east;
  the handle-tracking fix is what the audit could prove.

## §11 Strokes — evidence & fixes (2026-09-26)

Figma refs: "Apply and adjust stroke properties" (all 3 chunks: position/
weight/width-profile/individual/caps/tips/joins/miter/dash/dot/custom/brush/
dynamic/support matrix/scale/outline), outline-shortcut tutorials (⌥⌘O),
arrow tutorial (default = line arrow). After: full suite green
(934 + 64 + 46 + 63 + 49 + 92 + 19 + 19 + 55 new stroke checks).

### Fixed (shipped in the §11 strokes commit on this branch)

- K-001 — Dashed lines started with a full dash; Figma starts (and joins)
  with a half dash. Fix: `lineDashOffset` of half the first dash, base and
  extras, via a shared `dashOffset` helper.
- K-002 — Unset dash cap inherited the end-point cap, so a dashed line with
  round caps drew round dashes. Figma defaults to None. Fix: butt unless set.
- K-003 — Hovering a stroke position gave no canvas preview. Fix: engine
  `previewStroke` (render-only, non-history, cleared on select) with
  hover/focus preview on the position seg, Figma's micro-interaction.
- K-004 — Width profiles applied to branching networks, where the single
  centerline outline swallowed the branches' strokes. Fix: `usesVariableWidth`
  gates on `isBranchingNetwork` (max vertex degree > 2); editor hidden there.
- K-005 — Outside/centre stroke spill past the box was unclickable (hit gate
  clipped to bounds). Fix: `strokeSpill` pad (base + extras, profile-aware)
  in the hit gate and shape test.
- K-006 — Join control hidden for arrows; Figma's matrix supports joins on
  arrows (polylines). Fix: shown for arrows, still hidden for plain lines.
- K-007 — Stroke picker offered gradient/image types and a blend menu it
  could not apply (edits silently dropped to solid colour). Fix: strokes get
  a solid-only picker with no blend menu until those render.
- K-008 — Circle tip missing from the start/end selects (only on the caps
  seg). Fix: added to both; plus a start/end swap button, Figma-style.
- K-009 — Main menu labelled Outline stroke ⇧⌘O while the context menu (and
  Figma) say ⌥⌘O. Fix: label corrected (binding already accepted both).

### Verified parity (traced, no fix needed)

Add-stroke flow + empty state; weight field excluded from dims; inside/
outside/center incl. line/arrow center-forcing and defaults (shapes inside,
lines center, round line caps, line-arrow default head); individual strokes
on rect/frame/component/instance with custom 4-field + 0-removes-side; start/
end selects on open paths, whole-layer caps seg, all 7 tips + bonus circle;
fixed 3× arrowhead scale; dash/gap/dash-cap/dotted recipe/custom `dash, gap…`
syntax with refusal snap-back; miter/bevel/round + miter-angle threshold math
(bevel iff join sharper); variable-width editor (add/drag/delete, reset,
single-undo) with uniform fallback, centre-only, dash-ignoring; extras with
independent geometry + full align + scale-aware; scale tool scales every
stroke length; outline stroke via menu + context menu + shortcut; eyedropper
and recolor paths untouched; selection outline excludes stroke weight.

### Deferred / out of scope

- Brush and Dynamic stroke types: no X-Native equivalent — OUT OF SCOPE.
- Gradient, image, and blend stroke fills: model + render absent; dead picker
  UI hidden (K-007) — OUT OF SCOPE.
- Per-point stroke props in vector edit mode: §15 (vectors/pen).
- Stroke color styles: §19 (only color styles apply to strokes in Figma).
- Miter-angle default 0 (never bevel): left; no Figma evidence for its default.
- Remove-stroke `/` and remove-fill `⌥/`: §26 (keyboard) to adjudicate.
- Outlined dashes: engine outlines the path; whether Figma dices dashes into
  shapes on outline is unverified — left as is.
