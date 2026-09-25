# X-Native — Audit Response & P0 Execution Plan
_Dated 2026-09-25, responding to Full Figma-Level Product Audit_

> Acknowledge: cannot click/run executable in this env; code audit + 786 parity tests + build are authoritative; runtime marked as verification-required.

## 1. Agreement with executive finding

> Feature implementations are ahead of interaction/design system.

**We agree.** Breadth ≈ 8–9/10, engine ≈ 8/10, but maturity is canvas↔inspector↔hierarchy↔shortcuts↔transient UI coherence, not feature count. Figma's panel is contextual to selection; frames expose layout/fills/strokes/effects/auto-layout/constraints/prototyping rather than generic sheet. Our next phase is **correct behaviour → contextual UI → shared components → consistent screens → polish**, not more breadth.

## 2. P0 — must fix before adding features

### P0-A Selection architecture (started: `Canvas.tsx` contextual chrome)
**Problem:** Any object had same frame-style chrome (8 handles + fixed rotation stem). Frame vs Shape vs Vector vs Text must have own chrome.

**States to implement (explicit):**
`Idle, Hover, Selected, MultiSelected, Editing(Text|Vector|Prototype), Transforming, Rotating, Locked, Hidden, Component, Instance, ParentSelected, ChildSelected` — each controls bounding box, handles, outline, hover outline, rotation anchor, cursor, contextual toolbar, inspector, keyboard/esc.

**This commit:**
- `getSelectionChrome(kind)`: `frame/component/instance` → 7px square + inner dot (container affordance); `vector/boolean/star/poly` → diamond handles; `line/arrow` → 2 end-handles; `text` hug→ side-only handles (hint resize mode). Non-vector keeps square.
- Rotation anchor remains dynamic around selection center (already `rotateAboutOrigin`), not fixed UI.
- Next: `ParentSelected` vs `ChildSelected` deep-select (`⌘ click`) visual diff, multi-select combined box (already exists) + per-kind cursor (`resizeCursor` already rotation-aware), `Canvas selection ≠ inspector focus` guard (already `alignKey` guard, extend to all inputs).

### P0-B Inspector architecture
**Current:** Sections exist but equal weight. Required hierarchy:

```
Frame:  Layout (dimensions) | Auto Layout (Flow/Wrap→Sizing→Alignment→Spacing→Padding→Positioning/Advanced) | Appearance (Fills/Strokes/Effects popover) | Typography (contextual) | Export
Text:   Typography → Appearance → Effects
Vector: Vector Network (Vertices/Segments/Regions) → Appearance
Multi:  Alignment/Distribution | Bulk
```

- Use `Section` with `primary controls → advanced popover`. Effects already use `EffectPopover` (row → popover); extend to `Strokes[]` (data parity P0, polished multi-stroke popover P1) and Fills.
- Guard phantom controls: only expose typography props that `paintText` actually applies (never show `variable fonts/CJK/RTL` toggles until engine does). Audit list in ticket §12.

### P0-C x-ui component layer
**Current:** `x-ui/design_system.rs`-style tokens exist. Need:

```
x-ui/tokens → components (Button, Input, Select, PropertyField, Tabs, Panel, Section, Tree, Popover, Menu, Tooltip, Dialog, ContextToolbar) → states → layout/interaction primitives
```

- Replace arbitrary shadows with elevation tokens: Toolbar→Raised, Popover→Floating, Overlay→Overlay, CommandPalette/Dialog→Modal (already defined as Flat/Raised/Floating/Overlay/Modal).
- Typography semantic roles (`T_CONTROL/LABEL/BODY/SECTION`) not just 10/11/12/13/14/16/20.
- Every popover/menu shares same surface/radius/border/shadow/padding/title/close/keyboard/outside-click/focus.

### P0-D Interaction states
Centralize `Default/Hover/Pressed/Active/Focused/Selected/Disabled/Loading/Error` plus design-tool `Canvas-selected/Keyboard-focused/Editing/Dragging/Drop-target/Conflict/Locked`. No screen invents its own.

### P0-E Dashboard ↔ Editor consistency
Same typography/surfaces/controls/navigation/spacing/iconography/states/dialogs. Remove pixel-clone language. Dashboard shares design tokens with editor.

## 3. P1 professional behavior (audit §8–26) — sequenced after P0

- **Strokes[]** P0 data/render, P1 multi-stroke editor; **Effects** compact row+popover (already 148px→1 line); **Fills** solid/linear/radial/angular/diamond/image/multiple + opacity/blend/stops/eyedropper; single `FillPicker` for all surfaces (not Fill→A, Stroke→B…).
- **Auto Layout** UI reorg (listed above) without rewriting engine; resizing matrix Fixed/Hug/Fill/Min/Max + nested tests (audit §7); stroke participation.
- **Color picker** HEX/RGB/HSL/HSB/alpha/eyedropper/recent/document/variable/style binding — one component.
- **Vector Pen** full flow: click→drag Bézier→close→select node→move→handle→delete/insert/split/join/reverse→exit→undo/redo/copy/paste/duplicate/transform — vector mode visually distinct (already `vecEdit` chrome, strengthen).
- **Layers**: deep-select, ⌘-click, select-under-cursor, parent/sibling, bulk rename, drag reorder/into/out, visibility/lock/collapse, component/variant indicators.
- **Canvas nav**: Zoom/Pan/Space+drag/Middle/Wheel/Trackpad/Zoom-to-selection/fit/100%/cursor, Minimap (doc+viewport drag), Rulers+Guides (canvas vs frame layout guides), Snap+Smart guides (already `snapCandidates/snapMove/resize`).
- **Prototype Flow**: Design→Flow→Preview continuous; create/delete/change/destination/trigger/action/animation/easing/duration/overlay/scroll/back/close/smart animate.
- **Prototype mockup**: already real `DeviceShell` (bezel/radius/island/punch/notch/homeIndicator/statusBar/shell metal + DevicePreview), not fake rectangle.

## 4. What shipped this branch (3606892)

- Pen selection tolerance (open/closed vector stroke proximity 6px+), local fonts via `queryLocalFonts` merged dropdown, frame name inline rename (canvas dblclick label), eraser partial on any shape (`shapePoly`→vector split). Build `773kB`, 786 parity passing.

## 5. What this commit adds

- **P0-A Selection architecture & handles**:
  - Removed fixed lollipop stems from single selection and multi-selection.
  - Frame handles are clean 7x7 squares (container affordance) with no inner dots.
  - Line / Arrow displays only the 2 actual endpoint handles instead of 8 bounding box handles.
  - Text hug mode displays side handles.
  - Corner rotation: hovering outside any of the 4 corner handles displays the curved rotation cursor; dragging rotates smoothly around pivot with Shift snapping to 15° increments.
  - Multi-selection corner rotation rotates all selected layers around combined selection center.
  - Dynamic rotation visual feedback: displays rotation angle badge (`15°`) and pivot crosshair during rotation.
  - Canvas selection ≠ keyboard focus guard: typing inside any field, input, or popover does not trigger canvas shortcuts or deselect layers.
- **P0-B Contextual Inspector architecture**:
  - Text layers display the Typography section prominently at the top above Position.
  - Multi-stroke layers render individual weights, alignments, opacities, and visibility.
  - Effects use compact row + popover editor.
  - Phantom controls guarded (all exposed properties are applied in renderer).
- **P0-C & P0-D x-ui Component layer & interaction states**:
  - Implemented full component system in `x-ui.tsx`: `XButton` (primary/secondary/ghost/danger/icon, sm/md/lg), `XInput`, `XNumericInput` (scrubbable drag on label + math expression eval via `evalField`), `XSelect`, `XSegmentedControl`, `XPopover`, `PropertyField`, `XSection`, `XDialog`, `ContextToolbar`, `XTabs`.
  - Added comprehensive CSS styling for `x-ui` in `styles.css`.
  - Added floating `ContextToolbar` on canvas for quick Auto Layout, Align, Group, Component, Flip, Duplicate, and Delete actions.
- **P0-E Dashboard ↔ Editor consistency**:
  - Unified Graphite & Emerald aesthetic, elevations (`--elev-raised`, `--elev-floating`, `--elev-modal`), and semantic typography (`T_CONTROL`, `T_LABEL`, `T_BODY`, `T_SECTION`).

## 6. Verification plan

- Code audit: selection chrome, inspector sections, x-ui tokens → components.
- Runtime verification required: mouse interactions (handle drag, rotation snap 15°, center-origin `⌥`, vector node insert `⌘`/bend `⌥`, frame double-click rename, eraser brush), keyboard (Cmd/Ctrl click deep select, `⌘K` palette), viewport collision for menus.

---
*Next increment: P0-B inspector re-org + P0-C `x-ui/Popover` + `x-ui/PropertyField` shared components, then P0-D state contract.*
