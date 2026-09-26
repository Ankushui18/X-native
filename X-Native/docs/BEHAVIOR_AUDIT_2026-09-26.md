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
| 15 | Vector / pen (object vs edit mode) | ✅ done | V-001–V-010 (28 tests) |
| 16 | Layers / structure | ✅ done | L-001–L-007 (24 tests) |
| 17 | Components | ✅ done | C-001–C-013 (55 tests) |
| 18 | Variables / tokens / styles | ✅ done | VR-001–VR-014 (32 tests) |
| 19 | Auto Layout UX | ✅ done | AL-001–AL-014 (42 tests) |
| 20 | Contextual inspector | ✅ done | IN-001–IN-009 (40 tests) |
| 21 | Context toolbar | ✅ done | TB-001–TB-006 (12 tests) |
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

## §15 — Vector / pen (object vs edit mode)

Evidence: Figma “Vector networks” + “Edit vector layers” (pen click/drag,
close-on-start, Esc/Enter/dblclick-to-finish, mirror modes, per-point caps +
corner radius, paint toggle, eraser, multi-point bbox, corner smooth toggle).

### Fixed (shipped in the §15 vector commit on this branch)

- V-001 Enter/double-click on a basic shape no longer flattens it up front:
  shapes edit in place (overlay already used a `shapePoly` fallback), so
  enter-and-exit-with-no-changes leaves the node untouched and the first
  real edit converts `kind` via the existing `patchPath` path. Engine
  `insertPointOnPath` / `bendSegment` / `addVectorBranch` seed from
  `shapePoly` with an effective-closed flag (shapes closed, lines/arrows
  open); pen branch-anchoring accepts shape vertices. Double-click on a
  boolean *with children* now drills into the child (Figma) instead of
  baking the boolean — previously the drill branch was dead code for
  booleans.
- V-002 Delete/Backspace in vector edit with no point selected no longer
  eats the last anchor; it is a no-op (the keystroke is still swallowed so
  the layer survives). ⇧Delete heal kept.
- V-003 The pen close-ring now appears only on the start anchor (the only
  click that closes); previously every draft anchor within 14/zoom was
  ringed while clicking one just stacked a duplicate point.
- V-004 Pen click on the edited path inside vector edit inserts an anchor
  (Figma) instead of starting a second draft; vertex clicks still start
  branch-drawing, clicks elsewhere still draft.
- V-005 Arrow keys in vector edit with points selected nudge the anchors
  (via `shiftPoints` + `patchPath`, first nudge converts a shape) instead
  of the whole layer; ⇧ keeps the 10px step.
- V-006 ⇧-drag of vector points constrains to the dominant axis (single
  and multi-point moves).
- V-007 Point insertion on a curved segment now splits the cubic (closest-t
  sampling + De Casteljau) so the anchor lands on the curve and the arc
  keeps its shape; straight segments keep the old chord midpoint.
- V-008 Double-click corner→smooth derives the tangent from the
  neighbouring anchors (length = third of the shorter edge) instead of a
  fixed 20px horizontal kink.
- V-009 ⌥-drag on a handle-less anchor pulls a Bézier handle out of it
  (mirror mode decides whether the far side follows) instead of moving.
- V-010 Double-click-to-finish drops the press point when it coincides
  with the previous anchor (< 1.5 units), so finishing on the spot never
  leaves a zero-length end segment.

### Verified parity (traced, no fix needed)

- Pen: click = corner, drag = symmetric handles, ⇧ 45° snap, Esc/Enter
  commit, Backspace pops draft points, rubber-band + ghost preview,
  network branching on vertices; pencil thin + `smoothPath` on release.
- Edit loop: Enter/dblclick entry, Esc exit, blur/⌘Enter text interplay,
  marquee point select (+⇧), multi-point move/delete, mirror buttons +
  1/2/3/4 keys, per-point corner radius, per-end caps (8 styles) with
  arrowheads, dblclick corner/smooth toggle, per-region Paint with
  same-fill toggle, Shape Builder merge/subtract, Bend via modifier or
  subtool, Simplify/Clean up, partial erasure (`erasePath`) incl.
  shape-outline splitting.
- Whole path commits as one undo step; `normalizeVectorNode` on exit is a
  no-op for untouched shapes.

### Deferred / out of scope

- Multi-point transform bbox (resize/rotate/Space-reposition) — new UI,
  no existing affordance; moves already work.
- Lasso (Q), Cut (X), Variable-width subtool — absent tools, not broken
  ones (`vecSubTool` `"eraser"`/`"lasso"` union members are dead type-only
  values; the main eraser tool exists separately).
- Per-point caps inside edit mode beyond the node's start/end pair (same
  thing for every 2-endpoint path).

## §16 — Layers / structure

Evidence: Figma “Lock and unlock layers” (⇧⌘L, inheritance, panel
selection of locked, Select-layer submenu), lock/hide shortcut ground
truth, plus panel-behavior conventions (⌥-click subtree fold, reveal on
select, inline rename).

### Fixed (shipped in the §16 layers commit on this branch)

- L-001 Lock inheritance: new `isEffectivelyLocked` helper — a locked
  frame/group locks its whole subtree. Wired through hit-testing,
  drag-move origins, marquee selection, and the delete / duplicate /
  reorder / nudge / arrange / ungroup / resizeToFit ops; dropping into a
  locked container is refused. Panel rows render the inherited padlock and
  explain (“unlock the parent first”) instead of flipping a dead flag.
- L-002 Ungroup: unwraps every selected group (was selection[0] only),
  refuses locked groups, and preserves world geometry through rotation
  (child centers rotate about the group's rotation origin, rotation is
  inherited; unrotated output byte-identical to before).
- L-003 Cross-parent grouping: ⌘G across frames/pages-parents now forms
  one group in the first selection's parent with world-measured bounds
  (was a silent no-op); ancestor/descendant pairs stay a no-op so a child
  is never cloned twice.
- L-004 ⌥-click on a twistie folds/unfolds the whole subtree (Figma) via
  a descendant-id broadcast each row answers itself.
- L-005 A canvas selection reveals itself in the panel: ancestors
  auto-expand and the row scrolls into view (`nearest`).
- L-006 Empty/whitespace renames revert (layer rows and pages); committed
  names are trimmed.
- L-007 Pages: inline rename replaces both `window.prompt` calls (row
  double-click and page menu), and pages drag-reorder via a new `movePage`
  op that keeps the current page selected.

### Verified parity (traced, no fix needed)

- Panel order (front-on-top), select/⌘-toggle/⇧-range over visible DOM
  rows, hover outline on canvas, inspector-editable locked layers
  (Figma's “adjust any properties”), hidden-subtree render skip,
  Select-layer submenu with padlocks, collapse-all, name search,
  drag reorder zones + position preservation.
- ⌘R rename, ⇧⌘L / ⇧⌘H, ⌘G / ⇧⌘G / ⌥⌘G, ⌘⌫ group-dissolve, ⌘[/] arrange,
  ⌘A skipping hidden+locked, page add/duplicate/guarded-delete.

### Deferred / out of scope

- Drag-across eye/lock to batch-toggle rows (Figma tip, new gesture).
- Mixed-selection lock/hide semantics beyond per-layer toggle (no
  evidence either way).
- Sort-position / batch-rename plugins territory.

## §17 — Components / instances / variants

Evidence: Figma “Guide to components” (360038662654: main defines
properties, instances receive updates), Figma “Apply changes to
instances” (360039150733, fetched verbatim: allowed = text props,
fill/stroke, effects, guides, nested-instance swap, export settings,
layer name; refused = layer order, position incl. auto-layout items,
constraints, text bounds; preservation across variant/swap by matching
layer NAMES + hierarchy; per-property reset via More actions;
push-to-main same-file only, never for nested-in-component), plus forum
30206/13948 corroborating name+hierarchy preservation.

### Fixed (shipped in the §17 components commit on this branch)

- C-001 Member geometry/layout refusal: patches on instance members
  strip position/size/radii/vector/auto-layout/constraints keys before
  they reach the node or its override record (`stripMemberPatch`);
  instance roots still move but take no layout. Member vector edits
  (patchPath/bend/insert/mirror/corner) are refused outright.
- C-002 Structural guards: delete/duplicate/nudge/arrange/resize/
  auto-layout/wrap/ungroup refuse or skip instance members; add/
  reorder/paste never land children inside an instance (paste falls
  back to the sibling slot); an instance never ungroups.
- C-003 Component-from-instance mints a fresh library id (was aliased
  to the source component).
- C-004 Master-safe detach: masters refuse detach (was orphaning the
  library entry); detach clears dead override records but keeps nested
  instances linked; members refuse detach.
- C-005 Variant swaps re-id (`reid`) so two instances of one variant
  never share child ids (was shared ids across instances).
- C-006 Reset restores the CURRENT variant def (was always default),
  preserves the variant selection, and keeps the Variant property
  consistent with it.
- C-007 Name-based override preservation: sync matches master/instance
  children by name (positional fallback), so master reorders no longer
  cross-wire overrides; variant instances sync from their own def.
- C-008 Library insert places at the viewport center (was fixed 80,80).
- C-009 Variant-aware publish: editing a variant copy publishes to its
  own variant def, never to the default node plain instances read.
- C-010 Master-subtree publish: edits at or under a master (patch,
  move, nudge, resize, path family, reorder, arrange incl. front/back,
  add, delete, duplicate, wrap, ungroup, lock, hide, flip, variant
  props) republish it, so instances receive every update. Members take
  the master's position (only instance roots keep their own x/y), so
  master position edits flow.
- C-011 Override carry: setVariant / variant-property / swap carry
  same-named overrides (nested-aware) and drop stale size overrides
  when the new def size differs.
- C-012 Sync-corruption repair (the deep one): the sync walk re-synced
  members against the master root (members inherited its name, size,
  and cloned children on every master edit), because the recursion
  stamped members with the library link. Only instance roots carry
  the link now (`isRoot` flag, legacy stamps cleared);
  `findInstanceRoot` heals residual stamps on read; nested instances
  keep their own link/content through outer syncs and still follow
  their own master.
- C-013 Reset hardening: full reset on a member id redirects to its
  instance root (was grafting a master-root clone inside the member);
  per-property reset on a member restores that layer's own master
  value via name-path lookup with index fallback.
- Flip on instance roots flips the flag only (recorded as an
  override); members refuse (consistent with C-001). `XNode.variant`
  is optional (`types.ts`). UI: canvas drag skips member origins,
  vector-edit entry on members toasts instead of corrupting, arrow
  nudges skip members, add-layout refuses instances.

### Verified parity (traced, no fix needed)

- Duplicate-master→instance, instance-dupe→instance, reset whole and
  per-property ops, swap op + inspector dropdown, AssetsPane inventory,
  `⌘⌥K` / `⌥⌘B` / `⇧⌘Y` wired, scale/radii/layout-remove refusals,
  detach keeps nested instances.
- X's `⌥⌘B` detach binding is X's own (no conflict with `⌘B` bold);
  a 2023 Medium claim that `⌥⌘K` detaches is wrong — that chord is
  Create component in Figma and X.

### Deferred / out of scope

- Push-to-main (`pushChanges`): op absent; same-file-only push is new
  surface, not a parity gap in shipped behavior.
- `resetOverrides:text/fill` menu handlers are unoffered dead code
  (per-property reset exists via the op); no phantom.
- Undo-stack no-op pollution (dispatch pushes even when guards
  refuse): pre-existing, cross-cutting, left for the history section.

## §18 — Variables / tokens / styles

Evidence: Figma “Guide to variables” (15339657135383: article map),
“Apply variables to designs” (15343107263511, fetched verbatim:
number→font size/gap/guides/w-h/min-max/corner/effects/padding/
opacity/letter-spacing/line-height/paragraph/stroke; number-on-text
tip; string→text/font family+weight; boolean→visibility; detach
gestures; on-canvas padding/gap edits detach), “Create and manage”
(15145852043927: alias same-type + detach, duplicate ⇧Enter, scope
lists, edit modal), “Modes” (15343816063383: new mode duplicates the
first column, default = left-most), forum “Detach deleted variables”
(delete leaves dangling bindings by design) and the alias
infinite-loop refusal (“that selection would create an infinite loop
of variables”).

### Fixed (shipped in the §18 variables commit on this branch)

- VR-001 Numbers bind to text content (Figma tip): bind guard + string
  coercion on apply, picker entry.
- VR-002 Width/height bindings; an explicit resize detaches them
  (Figma: on-canvas edits detach), otherwise relayout snaps it back.
- VR-003 Text bindings: letter-spacing, line-height, paragraph
  spacing/indent, font weight, font family (text layers only).
- VR-004 Gap/padding bindings on auto-layout frames (bind requires a
  layout; a fresh preset or layout-strip drops the keys).
- VR-005 Instance binding refusals: members take no size/radii/layout
  bindings, roots take no layout bindings (C-001 geometry ownership).
- VR-006 A variable type change scrubs bindings that no longer match
  (was silently dead entries); number→text stays valid.
- VR-007 `addVariable` refuses duplicate ids (was silent shadowing in
  resolution).
- VR-008 Cyclic and self aliases refused at author via `wouldCycle`
  (engine backstop + UI toast with Figma's message); the resolver's
  broken-cycle branch stays for legacy documents.
- VR-009 Styles inside instances record overrides: apply/create on
  roots and members survive master sync; detach and hand-edit
  style-drops record the absence instead of being re-bound.
- VR-010 Binding/expression preservation: sync merges maps with the
  instance's own entries winning (`ownBindings` pins), so master
  binds AND unbinds propagate while own bindings survive; nested
  instances pin their whole map (owned by their own master);
  variant switch, swap, and variant-props preserve pins; pin hygiene
  on duplicate-of-master, place, fresh sync members, reset, and
  makeComponent; bind/unbind/expression edits on master content
  publish (C-010).
- VR-011 Variable rename (double-click, same gesture as collections
  and modes; engine op existed with no caller).
- VR-012 Style rename (double-click; `editStyle` name existed with no
  caller).
- VR-013 Bind picker tables cover the Figma-supported props per type,
  with layout/instance guards mirroring the engine.
- VR-014 `addMode` snapshots the first column into the new mode
  (Figma duplicates values); fallback used to leak later default
  edits into the new mode.

### Verified parity (traced, no fix needed)

- Live canvas update on value edits (every dispatch relayouts);
  default = modes[0] (left-most); mode/collection add/rename/delete
  guards (dupes, last-mode protection, slot scrub, active reset);
  collection rename moves members.
- Delete-in-use dangles by design (matches Figma's “Detach deleted
  variables” model): values freeze, aliases report broken, the
  inspector shows “Missing variable” + unbind, and undo heals.
- Alias authoring filters same-type + refuses self (pre-existing UI);
  strict value coercion; detach-on-direct-edit; unbind keeps values.
- Styles: create-from-selection (multi), apply, detach, live repaint
  on edit, delete keeps colours; detach keeps variable links.

### Deferred / out of scope

- Per-layer/per-page modes with Auto inheritance (Figma core, big new
  surface; X is correctly global-only throughout, no phantoms).
- Scopes, descriptions, slash groups, picker search, code syntax,
  publishing/hiding (new model + UI surface).
- Duplicate variable/collection/mode, set-default/reorder modes
  (convenience surface; no engine ops exist).
- Effect-color, gradient-stop, and opacity-of-color bindings (nested
  key schemes); boolean→variant-prop binding (§23-adjacent).
- Nested-binding carry across variant switches (deep edge);
  expression unbind-flow (X-only deviation, merge only);
  paste-properties copying raw values instead of bindings.
- Kept extras: cross-collection variable moves (Figma forbids),
  engine-level type change (Figma immutable, UI-unreachable).

## §19 — Auto Layout UX

Evidence: Figma “Guide to auto layout” (38346729433109, chunks 0–1:
create/⌥⇧A/suggest, resize→Fixed, min/max clamps + Remove,
padding panel + ⌘-shorthand, alignment box + WASD/B/X keys, canvas
stacking, add-object indicator + oversize rule + ⌘ bypass, spacing
modes, baseline, hide-vs-opacity) and “Use the horizontal and
vertical flows” (31289464393751, chunks 0–2: vertical wrap =
top-to-bottom then a new column, wrap dual gaps, min size =
padding + inside stroke, auto spacing = space-between/around/
evenly with gap floored at 0, single-child start, strokes in
layout = inside counted by default / center+outside never /
per-frame, reorder/delete-in-instance rules, duplicate placement).

### Fixed (shipped in the §19 auto-layout commit on this branch)

- AL-001 Vertical wrap: `wraps()` reads on vertical flows and the
  panel toggle enables there (the packing branch already wrapped
  columns; only the gate and the toggle were horizontal-only).
- AL-002 A wrapping flow's second gap: new `gapCross` (“Gap between
  lines”, falls back to `gap`) spaces rows — or columns in a
  vertical wrap — while `gap` keeps the within-line spacing; panel
  field for wrapping flows; the canvas overlay paints between-line
  bands instead of skipping cross-line pairs.
- AL-003 Inside strokes count in layout math (was explicitly
  unsized): the frame's own inside stroke behaves as extra padding
  (origins, inner/fill space, hug totals, grid tracks, drop spots),
  and the minimum size is padding plus that stroke. Center and
  outside strokes are never counted.
- AL-004 A hug-driven resize settles absolutely positioned
  children's constraints (was explicit-resize only); flow children
  keep their packed seats.
- AL-005 Instance-root spacing fragments: padding, gap, gapCross,
  and the grid gap pair override on the root (both actions),
  recorded as fragments and merged over the master's layout at
  sync — master structure edits still flow underneath.
- AL-006 Members refuse `layout` through the generic patch too
  (was only the autoLayout action), matching “members only
  override paint/text/effects”.
- AL-007 Delete in an instance toggles the member's visibility
  instead of removing it (was a silent no-op); the toggle is
  recorded as an override, and deleting the root still deletes.
- AL-008 Positional drops: `reparent` lands in the flow gap under
  the point (`flowInsertIndex`, wrap-aware, absolute/hidden slots
  kept), with an explicit `index` for multi-drops as a block.
- AL-009 Oversize drops onto a fixed auto-layout axis are refused
  unless bypassed with ⌘/Ctrl; hug axes always fit and grow.
- AL-010 Ctrl-drop (Mac) lands absolutely positioned, out of the
  flow, where let go; the size gate never applies to it.
- AL-011 Dragging within a frame reorders to the pointed gap (was
  silently kept); plain frames keep position-only moves.
- AL-012 A live drop indicator (frame outline + blue insertion
  line in the exact landing gap) during move drags; instance and
  locked frames are skipped as targets, matching the engine.
- AL-013 The layout panel says why on instances: structure locked
  everywhere in an instance, spacing open on roots (members fully
  locked) — direction, wrap, alignment box + keys, distribution,
  stacking, grid structure, gap and padding fields.
- AL-014 `reparent` refuses locked and instance destinations
  (parity with `reorder`, which the panel drag already used).

### Verified parity (traced, no fix needed)

- Resize/patch→Fixed incl. layout-frame dual write + flow
  children; edge-dblclick hug / ⌥-fill with guards; effective
  fill⇒Fixed both axes; min/max model + clamps + Remove-clears.
- Auto spacing semantics + single-child start + gap floor at 0;
  the 3-cell alignment reduction + box keys (arrows/WASD/B/X);
  canvas stacking toggle + render; baseline alignment.
- Padding handles + click entry + ⌘-click CSS shorthand typing;
  hidden/absolute filtered from the flow; opacity-kept gaps.
- Duplicate lands after the original; arrow keys reorder flow
  children (±1 by sign); reorder refuses instance members and
  destinations; ⌥-duplicate and ⌘-bypass snapping while dragging.
- Canvas autoPad/autoGap gestures (now spacing-override the
  instance roots they land on, via AL-005); grid spots, pinned
  cells, and manual grids; remove/wrap guards on instances.

### Deferred / out of scope

- Wrap + hug-main growth semantics (no Guide evidence either
  way; X wraps at its current width, grow-only).
- `gapMode`/`spacing` overrides on instance roots (refused with
  structure; the Figma table names padding/gap values only).
- `gapCross` variable binding (values only; no new binding key).
- Grid-cell drop indicator (frame outline only); Windows S-drag
  absolute (key untracked during canvas drags).
- Per-frame stroke include/exclude toggle (X implements the
  Figma default — included — with no toggle surfaced).
- `suggestLayout` stroke-awareness (suggestion heuristic only).

## §20 — Contextual inspector

Evidence: Figma “Design, prototype, and explore layer properties”
(360039832014, chunks 0–1: nothing-selected = local styles/
variables + canvas background + export page; layer-selected
controls; view-only tabs out of scope) and “Adjust alignment,
rotation, position, and dimensions” (360039956914, chunks 0–2:
single→parent / multi→each-other / ⇧-align group-to-parent with
cross-frame per-frame groups; ⌥WASD/VH table; distribute multi
retains outermost; tidy 1D most-common spacing / 2D top-left
grid; mode gap display; X/Y = bounds top-left; nudge 1/10 + ⇧;
aspect-lock canvas modifiers + proportional min/max; rotation
±180 with ⇧-15 snap; flip ⇧H/V + right-click menu; order
⌘]/[ + ⌘⌥]/[; equations incl `Mixed+100` apply to all selected
layers; scrub label + ⌥-on-input with 2x/1x/1/2/1/4 vertical
speeds).

### Fixed (shipped in the §20 inspector commit on this branch)

- IN-001 ⇧-align moves the selection as one rigid group
  (was per-layer to each own parent): members sharing a frame
  take the union box's delta, cross-frame members group per
  frame against each own parent; locked layers and instance
  members sit out before the union is measured. ⌥⇧+WASD is the
  keyboard twin of ⇧-click (was unbound; ⌥⇧H/V previously
  fell through to flip on Windows/Linux only).
- IN-002 `distribute` and `tidyUp` measure in world coordinates
  (were local, so cross-frame members shared no span), refuse
  deep-locked layers and instance members like `move` (were
  direct-locked-only), and round only with the pixel grid on
  (tidy-up rounded unconditionally, distribute never did).
- IN-003 Tidy-up repeats the most common gap (was forced even,
  clamped at 0): a strict mode steps the row from its anchored
  first layer, ties fall back to the even split; a grid
  (overlap on both axes) bands rows by Y overlap and steps
  columns from the selection's top-left, which never moves,
  keeping within-row stagger; single rows/columns pick their
  axis by overlap, scatter by major span.
- IN-004 Position X/Y, W/H and rotation edit a multi-selection
  together (were first-layer-only): the fields show Mixed while
  the layers disagree, a plain number lands on every mover,
  equations evaluate once per layer (`evalFieldMany`,
  all-or-nothing), scrubbing shifts every mover by the same
  delta, and each layer keeps its own aspect lock, ratio,
  rotation origin and text hug refit. Opacity and the type
  metrics stay first-layer.
- IN-005 Rotation wraps to ±180 on every write: new central
  `wrapRotationDeg`, applied inside `rotateAboutOrigin` (panel
  single + multi) and in the ungroup inherit (was `% 360`,
  spilling into [0, 360)); the canvas single-drag wrap is now
  idempotent through the same helper.
- IN-006 Front/back accept ⌥ as well as ⇧ (the shortcut sheet
  advertises ⌘⌥]/[ while only ⌘⇧]/[ was bound; the Arrange
  menu shows ⇧ — both chords now reach the command).
- IN-007 Nothing-selected exposes local styles: a “Local styles”
  row under Background bridges to the left panel's Variables
  tab (was background + pixel grid + export only).
- IN-008 Scrub speed follows pointer height: ×2 above the start
  row, ×1/2 then ×1/4 below, with a toast naming the speed on
  change (was uniform 1 unit/px, ⇧×10 kept orthogonal).
- IN-009 The panel's Scale-all skips deep-locked layers (was
  direct `locked` only, against its own comment).

### Verified parity (traced, no fix needed)

- Single→parent align incl. grid-cell and stack-axis retargets;
  multi-align to selection bounds; ⌥WASD/HV; ⌃⌥H/V distribute;
  ⌃⌥⇧T tidy; distribute keeps outermost, needs three.
- Nudge 1/10 + ⇧; aspect-lock ⇧-force / ⌃-release canvas
  modifiers; proportional min/max under lock; ⌥R origin target;
  single-rotate ±180 wrap + ⇧-15 snap; flip ⇧H/V + context menu
  with locked/member guards; SelectionColors multi-paint story.
- Field arithmetic incl. `Mixed`/`x` substitution, live absolute
  typing, commit-on-blur/Enter, ⌥-drag scrub from the input.
- PageDesign background + pixel grid + page export; Design/
  Prototype tab gates; boolean-member section locks.

### Deferred / out of scope

- Engine `patch` still applies to locked layers (move/resize/
  reorder guard; the panel neither disables nor refuses) —
  needs a locked-key whitelist (unlock/visibility/rename stay
  legal) plus per-section UI disabling; new §20 code paths
  exclude locked layers themselves so the hole does not widen.
- X/Y show the origin on rotated layers (Figma shows the
  bounds top-left); opacity + type metrics stay first-layer on
  multi-select; sizing label-click cycles the first layer only.
- Rotation sign convention vs Figma's “+=counter-clockwise”
  unverified headless; flow-child distribute/tidy (layout snaps
  raw moves back, same as multi-align); multi paint-stack
  editing beyond SelectionColors; tidy gap readout (“8 · 24”)
  has no X surface.

## §21 — Context toolbar

Evidence: Figma “Access design tools from the toolbar”
(360041064174, single chunk: Move default + Hand/Scale menu,
space momentary hand, Region/Shape/Creation menus incl.
rectangle-default + Place-image-as-fill, pen/pencil, text
click/drag, comment/annotation/measurement, Actions menu,
Dev Mode ⇧D, Figma Draw) and “Boolean operations”
(360039957534, single chunk: union/subtract/intersect/exclude
+ ⌥⇧U/S/I/E, ≥2 supported layers, shapes/vectors/text only —
never sections or frames, top paint wins except subtract's
bottom, non-destructive member geometry, ungroup to break up).

### Fixed (shipped in the §21 toolbar commit on this branch)

- TB-001 Each dock group remembers its last-used tool: the
  main button re-arms it after a switch (was the group's first
  tool — ellipse, draw, click shape group gave rectangle).
  The live tool still wins while it sits in the group, so no
  frame lags the switch.
- TB-002 ⌘↵/Ctrl↵ exits vector edit (the dock Done button
  advertises “Esc or ⌘↵”; only Esc was wired). A pending pen
  draft still commits first, so the chord never eats points.
- TB-003 The floating toolbar's Auto Layout action shows for
  any single selection (was frames and multi-selections only);
  `addAutoLayout` already wraps lone shapes, and instances
  refuse with the article's way out (detach / edit master).
- TB-004 The grab cursor flips the moment Space lands (the
  held flag was ref-only, so the cursor stayed stale until
  the next render).
- TB-005 Slice and eraser take crosshair cursors (were the
  default arrow, unlike every other creation tool).
- TB-006 Removed a duplicated ⇧T Annotate hotkey branch (dead
  code — the first identical branch always won).

### Verified parity (traced, no fix needed)

- Tool groups and contents match the article (Move + Hand/
  Scale, Region, Shape with rectangle default, Creation,
  Text, Comment); Move is the default tool; X extras (Zoom,
  brush, eraser, Figma-Draw-adjacent) conflict with nothing.
- Single-use revert for shapes/frame/text/image, sticky
  pen/pencil/brush until Esc/Enter/V; slice stays armed for
  repeat cuts (X choice, no Figma evidence either way).
- Space momentary hand (pan + grab, tool untouched, typing
  guarded); full Escape ladder (crop → image-placing →
  pen draft commit → boolean preview → rotation target →
  text-edit commit → vector-edit exit → popover → present →
  guide → nested-up → deselect + tool reset).
- Tool letters V/H/K/Z/F/A/S/⇧S/R/L/⇧L/O/T/C/P/⇧P/B/I/⇧I/
  ⇧⌘K with typing and presentation guards; palette rows for
  the shortcut-less poly/star/eraser.
- Boolean menu at ≥2 selected with ⌥⇧U/S/I/E; flatten on ⌘E
  (+ ⌥⇧F alias); engine filters frames (sections are frames),
  needs two survivors, inherits top paint / subtract bottom.
- Actions palette (⌘/) spans commands, layers, pages,
  components, variables and flows — the Resources and Actions
  dock buttons are two honest doors to one room; Dev Mode
  toggle + ⇧D; Done buttons consistent (dock exits vector
  edit, the vector pill commits the draft too, nothing
  abandons points); Group wraps a single layer.

### Deferred / out of scope

- Floating-toolbar centering assumes a fixed width (offsets
  -140 vs clamp 380); cannot measure headless, left as is.
- Annotation/measurement comment tools (Full-seat dev
  handoff) and Figma Draw mode: absent surfaces, not broken
  ones; X's brush/pencil cover the drawing behavior.
- Bare-I image shortcut is undocumented (⇧I/⇧⌘K advertised,
  both wired to their own place flow); kept, conflicts with
  nothing.
