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
| 12 | Effects / shadows / blur | ✅ done | L-001–L-010 (51 tests) |
| 13 | Images (place/crop/mask/export) | ✅ done | M-001–M-010 + export peek (52 tests) |
| 14 | Typography (+ phantom controls) | ✅ done | Y-001–Y-015 (39 tests) |
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

## §12 — Effects / shadows / blur

Figma refs: "Apply effects to layers" (all 3 chunks: 7 kinds, caps,
per-kind settings, show-behind + its 4 conditions, spread kind-gate,
hover previews, copy/paste/duplicate, reorder, layer + group render
order, bg-blur fill rule + nested ignore, effect styles), "Apply blend
modes" (chunk 0: blend targets incl. effects, pass-through vs normal,
per-mode math). After: full suite green
(934 + 64 + 46 + 63 + 49 + 92 + 19 + 19 + 55 + 51 new effect checks).

### Fixed (shipped in the §12 effects commit on this branch)

- L-001 — Noise and texture painted below inner shadows and strokes;
  Figma stacks them on top (over strokes, glyphs and children). Fix: both
  paint after children at the end of the layer, in row order, clipped to
  the outline (stroke band for open paths).
- L-002 — Only the first noise rendered, and paint ignored its colour;
  the popover labelled density "Blur". Fix: every visible noise renders in
  order with its own blend; colour row + Density/Size fields added (spread
  = grain size); noise default colour is white, preserving prior output.
- L-003 — Text and booleans rendered only the first drop shadow. Fix: one
  native-shadow pass per visible drop; strokes stay shadowless (as text
  already was). Text drops still composite Normal and ignore spread and
  blend - the former matches Figma's kind gate, the latter two are native-
  shadow platform limits.
- L-004 — "Show behind transparent areas: off" only affected stroke-only
  layers; a translucent fill let its own shadow show through. Fix: drops
  on translucent fills paint through an even-odd inverse clip of the
  footprint (`dropMaskNeeds` + `fillCompositeAlpha`), rotation-safe.
- L-005 — Spread rendered on every kind; Figma only applies it on
  rectangles, ellipses, frames and components (frames/components also need
  clip + a visible fill; instances included as master renders). Fix:
  `spreadApplies` gates both painters, and the Spread field hints where it
  will not render. The value is kept, only the render ignored.
- L-006 — Hovering an effect kind gave no canvas preview. Fix: engine
  `previewEffect` (render-only, cleared on select/add/menu-leave) merged
  into the paint list via `withPreviewEffect`, cap-aware; blur cache
  bypassed for the previewed layer.
- L-007 — ⌘D with an effect open duplicated the whole layer. Fix: capture-
  phase ⌘D in the popover duplicates the effect next to the original
  (cap-checked with toast).
- L-008 — Background blur / glass with an opaque or missing fill silently
  did nothing. Fix: row tooltip when the composite fill alpha is outside
  0.10%-99.99% (`bgBlurSeesThrough`).
- L-009 — A layer whose only fill was an additional paint cast no shadow
  (`canShadow` read the scalar base only). Fix: shared `paintsAnyFill`
  covers base, image and additional fills in the gate and ring choice.
- L-010 — Noise/texture on lines and arrows clipped to the zero-area trace
  and vanished. Fix: open paths clip to the stroke band.

### Verified parity (traced, no fix needed)

Effect caps 8/8/1/1/2/1/1 with counts + toasts; drag reorder (drop/inner
render in row order); eye toggles; remove closes the popover; `+` opens the
type menu; X/Y/fill+opacity/blur/spread settings; per-shadow blend;
show-behind checkbox gated on the 4 documented conditions; shadow offsets
rotation-invariant; ring shadows for stroke-only layers; spread-then-blur
order; layer blur over the subtree (+raster cache); bg blur reads beneath
before own paint, first only; inner below strokes, drops below fills;
text-shadow via the text path; plus-darker documented canvas fallback.

### Deferred / out of scope

- Progressive blur, noise duo/multi palettes, texture radius + unclipped
  mode, glass light/refraction/depth/dispersion/frost/splay (X glass is a
  documented tint+blur simplification): model + render absent.
- Copy/paste effect settings (⌘C/⌘V target ambiguity with layer paste).
- Effect styles: §19 (with stroke color styles).
- Group silhouette shadows (X paints the bounds rect for groups).
- Normal-parent blend isolation (X composites inline; pass-through ==
  normal) and blur-vs-noise row order (filter always wraps the composite).
- Non-cacheable layer blur is per-op, not composite (groups, rotated,
  blended, text); nested background blurs multiply instead of ignoring.
- Text inner shadows render at box level, not glyph level.
- Image-pixel transparency is not analysed for the drop mask (fillOpacity
  only); translucent glyphs deepen slightly per extra text-shadow pass.

## §13 — Images / crop / place / masks

Figma refs: "Crop an image" (entry points, 8 handles, slider, aspect
picker, Resize-to-fit, Enter/click-outside applies, Option symmetric,
aspect locked by default w/ Control unlock, ⌘+drag quick-crop,
post-crop reposition/rotate/resize), "Adjust image properties" (Fill /
Fit / Crop / Tile incl. %-of-original tile + fill-only Rotate-90, 7
adjustments ± reversible), "Apply mask effects" (any layer incl. text /
alpha-images / groups; mask-below-masked; siblings-above until next
mask/object/parent/clip-frame; Alpha / Vector / Luminance; ⌃⌘M +
Use-as-mask, default Alpha, hover-preview type switch; independent
move/resize; remove re-reveals; View > Mask outlines), place-image
best-practices (File > Place image, shape-tools menu, ⇧⌘K; multi-file
picker, place one-by-one by click/drag; click shape/frame/text fills
it; drag-drop batches in rows of ten; PNG/JPEG/GIF/TIFF/WEBP;
browser copy-paste). After: full suite green
(934 + 64 + 46 + 63 + 49 + 92 + 19 + 19 + 55 + 51 + 52 new image
checks) + build clean.

### Fixed (shipped in the §13 images commit on this branch)

- M-001 — Masked siblings rendered with a geometric clip, so text,
  alpha-image and blur/shadow-bearing masks could not work. Fix: an
  offscreen compositor (`paintMaskedRun`) paints the mask for real,
  reduces per type (`reduceMaskAlpha`), tiles each kid with
  destination-in and blits under the live CTM; runs partitioned by
  pure `partitionMaskRuns` (hidden masks paint plain).
- M-002 — No View > Mask outlines. Fix: engine `showMaskOutlines` +
  View-menu checkbox; canvas strokes visible masks green.
- M-003 — No crop tool: `crop` fit cover-rendered with no rect to
  edit. Fix: `imageCrop` model + `cropModel.ts` rect/handle math
  (corners aspect-locked, Ctrl/⌘ frees, ⌥ symmetric, 1% min, grab-
  style reposition, rotation-aware dims) + canvas crop mode (blue
  window, dimmed surround, faded full image incl. rotated, Enter /
  click-away applies, Esc restores the entry snapshot without
  touching undo) entered via double-click, Crop image menu/button,
  right-click; render falls back to cover until a rect exists.
- M-004 — No place flow: the picker took one file and dropped it at
  a capped size. Fix: picker-first queue (`queueImages`): ⇧⌘K, the
  canvas menu and the assets panel open a multi-file picker, each
  click places one (a click on a shape/frame fills it, clearing stale
  crop/tile), Esc stops, a cursor badge counts down; the image tool
  (⇧I) keeps location-first for its first file. ⇧⌘K was double-bound
  to vector cleanup's display-only shortcut; the cleanup entry keeps
  no chord and the key opens the picker.
- M-005 — Multi-file drops cascaded diagonally. Fix: drops lay out
  in aligned rows of ten from the drop point under one undo; pastes
  keep the cascade.
- M-006 — Image settings lived only on the base fill and tile was a
  fixed scale. Fix: `imageTile` % model (FillPicker field, %-of-
  original render), rotate-90 + 7 adjustments render on canvas via
  the processed-image cache, `imageCrop` render branch.
- M-007/M-008 — Adjustments + fill rotate: verified pre-existing and
  correct (pixel-loop pipeline, 24-entry cache, `hasAdj` covers
  `imageRot`); no fix needed.
- M-009 — Stacked fills could not be images. Fix: `Paint` carries
  the full image family, `paintOnePaint`/`paintStack` render them
  through `imgOf` (skipped while loading, never broken), inspector
  rows map every field, canvas preloads stack sources. Stack paints
  never inherit the base crop (per-fill crop rects are out of model).
- M-010 — Dev-mode readout labelled vector masks "Alpha". Fix: the
  readout reports the actual mask type.
- Export peek — SVG exported Fill as stretch, any stale `imageSrc`
  as an image even under a solid fill, and shaped layers as
  unclipped rects. Fix: fill/crop export as cover (`slice`), the
  branch gates on `fillType === "image"`, shaped kinds clip the
  bitmap to their outline. Crop-rect-exact, tile-pattern and
  stacked-fill export need bitmap dims at export time: still out.
- Labels — "Place image/video…" (toolbar, shortcut sheet) claimed
  video support X has none of; now "Place image…".

### Verified parity (traced, no fix needed)

Cover/contain math; tile repeat; adjustments ± reversible; mask
create via ⌘⌥M / Use-as-mask incl. 2+ selection grouping; mask
default Alpha; sibling-independent move/resize; mask remove
re-reveals; FillPicker preview/choose/replace + 4 modes; image tool
natural size capped 480px; clipboard image/png ladder; inspector
"Image" row labels + header kind label; assets panel listing.

### Deferred / out of scope

- GIF animation, TIFF decode, image strokes (K-007).
- In-crop rotate / aspect picker / slider; drag-to-size place ghost;
  per-fill crop rects for stacked images; mask-type hover preview
  (native select kept); inspector image-dimensions section.
- Place into text (glyph-clipped image fills need a text-image path).
- Mask shortcut change (§26 owns shortcuts).
- Export: crop-rect-exact, tile-pattern, stacked-fill, rotation and
  adjustment baking (§24 owns import/export).

## §14 — Typography (+ phantom controls)

Figma refs: "Adjust text dimensions and resizing" (click → auto width,
drag → fixed, manual resize → fixed on the axis, scale tool scales
font + bounds, wrap style has no effect on auto width), "Explore text
properties" (all 4 chunks: alignment incl. vertical-align-is-fixed-
only, decoration + underline details, family/weight/size, hanging
quotes/lists, case, tracking, leading px/%/Auto, lists + list spacing,
numbers, OpenType, indent left-only, paragraph spacing, truncate + max
lines gating, vertical trim, wrap styles + Dev Mode `text-wrap`),
"Guide to text" (both chunks: creation, text on a path, Enter/double-
click edit, click-another-to-edit, multi-edit, fill-is-glyphs,
stroke-is-per-character), shortcut cheatsheets (⌘⌥L/T/R/J align,
⌘U/⌥U underline, ⇧⌘X strikethrough, ⇧⌘A remove-layout, > increases).
After: full suite green
(934 + 64 + 46 + 63 + 49 + 92 + 19 + 19 + 55 + 51 + 52 + 39 new type
checks) + build clean.

### Fixed (shipped in the §14 typography commit on this branch)

- Y-001 — Drag-created text came out auto-height; a dragged box is
  exact dimensions. Fix: drag creates Fixed/Fixed (click stays
  hug/hug).
- Y-002 — Vertical alignment applied on hug axes (visible with
  truncate). Fix: `valignApplies` gates the renderer and SVG export
  to fixed-size layers; fill counts as fixed.
- Y-003 — Small caps rendered as full-height capitals. Fix: the copy
  is lowered and painted/exported under a real small-caps variant
  (`applyTextCase` + `font-variant`), keeping small-cap proportions.
- Y-004 — Leading rendered floored at the font size while the field
  and the hug box allowed tighter values: triple inconsistency. Fix:
  the painter floors at 1px, so tight leading renders everywhere it
  measures.
- Y-005 — First-line indent applied under every alignment. Fix:
  `indentOf` gates measure, paint and the edit overlay's text-indent
  to left-aligned text.
- Y-006 — Justified rows ignored letter-spacing in the gap math and
  wore a short underline. Fix: tracking is accounted between words
  with the distributed gap on top; decoration spans the row.
- Y-007 — Strikethrough sat at half the em (cap-top area). Fix: it
  crosses at 0.7em, mid x-height.
- Y-008 — Hug height ignored paragraph spacing and truncation: tall
  copy overflowed short boxes. Fix: `textMetrics` counts surviving
  gaps and caps rows at max lines (budgeting the ellipsis on auto
  width); `hugHeight` adds the gaps.
- Y-009 — Fixed-size truncate cut at max lines though fixed layers
  have no such setting, and the Max lines field showed regardless.
  Fix: fixed layers truncate at the rows the box fits
  (`fitLineCount`); the field disables off auto/hug with the reason
  as its tooltip.
- Y-010 — Clicking another text layer mid-edit only selected it.
  Fix: the press commits the old copy (re-hug included) and opens
  the new editor; no drag starts. (Multi-edit-all stays out: new
  feature.)
- Y-011 — The sheet advertised ⌥⌘L/T/R text alignment with no
  handlers, and ⌥⌘L secretly removed auto layout. Fix: L/T/R/J
  align text (Mac dead-key-safe via e.code); remove-layout keeps
  its advertised ⇧⌥A alone.
- Y-012 — Missing type chords + stale hug boxes after the existing
  ones. Fix: weight ⌥⌘>/< (±100), tracking ⌥>/< (±1), leading
  ⇧⌥>/< (±1 from the effective value), strikethrough ⇧⌘X (cut now
  excludes Shift), underline ⌥U alongside ⌘U; every metric chord
  re-hugs (one undo step via the burst coalescer); ⌘. hide-UI yields
  ⌥⌘. to weight-up; sheet rows added.
- Y-013 — Wrap-style "Off" misnamed Figma's Auto (default greedy
  wrap). Fix: labelled Auto.
- Y-014 — Dev Mode omitted decoration/case and emitted invalid
  keywords (`text-align: justified`, `text-justify` as
  `text-justified`). Fix: decoration + case/transform across CSS,
  Tailwind, SwiftUI, React-style and spec rows; justify keywords
  corrected.
- Y-015 — Phantom values: the fields accepted sub-unit fonts and
  negative leading/gaps/indents the renderer could not honour. Fix:
  floors in `num()` (leading keeps 0 = Auto) and whole ≥1 max lines.

### Verified parity (traced, no fix needed)

Manual resize fixes the dragged axis; scale tool scales font +
spacing + limits; auto-width breaks only on Return; fixed wraps and
overflows vertically unclipped; justify skips the last line; Enter +
double-click edit; Esc/⌘Enter commit; ⌘B bold; ⇧⌘>/< size direction
(help-article prose claims `<` increases, but the cheatsheet gives
`>` explicitly and convention + X's implementation agree, so X is
kept); case options; lists with gutter markers; wrap auto/balance/
pretty incl. overlay; truncate ellipsis trimming; font picker +
system fonts; glyph fills + per-character strokes.

### Deferred / out of scope

- Text on a path; multi-edit; rich-text runs (`textRuns` is dead
  model: nothing reads it); line-height % mode + px/% conversion;
  underline details (style/thickness/offset/skip-ink/color); list
  spacing as its own prop; numbers/OpenType/variable fonts; vertical
  trim; hanging quotes/lists; italic (no model); links; spellcheck
  beyond the native overlay; missing-font alert.
- Type chords while the editor has focus (the typing guard stands).
- SVG export wrapping + paragraph gaps (§24 owns export).
