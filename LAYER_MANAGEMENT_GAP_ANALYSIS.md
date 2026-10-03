# Layer Management Feature Gap Analysis

## Overview

This document analyzes the gap between X-Native's current layer management capabilities and Figma's full layer management feature set, based on the [Figma "Work with layers" documentation](https://help.figma.com/hc/en-us/sections/15330116720791-Work-with-layers).

## Current X-Native State (✅ Implemented)

| Feature | Status | Notes |
|---------|--------|-------|
| Layer panel (tree view) | ✅ | Nested frames/groups with expand/collapse |
| Visibility toggle (eye icon) | ✅ | Per-layer eye toggle on hover |
| Lock toggle (padlock icon) | ✅ | Per-layer lock toggle on hover |
| Basic click selection | ✅ | Single layer select |
| Shift-click multi-select | ✅ | Add/remove from selection |
| Marquee selection | ✅ | Rubber-band selection on canvas |
| Layer rename (double-click) | ✅ | Inline rename in layer panel |
| Keyboard: ⌘⇧L (lock) | ✅ | Lock/unlock selection |
| Keyboard: ⌘⇧H (hide) | ✅ | Toggle visibility |
| Keyboard: ⌘A (select all) | ✅ | Select all on page |
| Right-click context menu | ✅ | Copy, cut, paste, delete, group, etc. |
| Z-order (bring to front/back) | ✅ | ⌘⇧] / ⌘⇧[ |
| Layer hover outline | ✅ | Blue outline on hover |
| Parent/child relationships | ✅ | Tree structure maintained |

## Missing Features (❌ Not Implemented)

### 1. Deep Select (Cmd/Ctrl+click)
**Priority: High** | **Effort: Medium**

- **What:** Hold Cmd/Ctrl and click to select a deeply nested child without double-clicking through parents
- **Figma Reference:** "Deep select — Hold down ⌘ Command to select a nested child layer or the top-level frame"
- **Implementation:** In canvas press handler, check if Cmd/Ctrl is held; if so, find the deepest node at the click point instead of the top-level frame

### 2. Select Layer Menu (Right-click > Select layer)
**Priority: High** | **Effort: Medium**

- **What:** Right-click > Select layer > shows a list of all layers under the cursor, including hidden and locked ones (locked ones with padlock icon)
- **Figma Reference:** "Right-click to open the context menu. Hover over the Select layer option."
- **Implementation:** Extend context menu with "Select layer" submenu listing all nodes at cursor position (sorted by z-order)

### 3. Select Matching Objects (⌥⌘A / Ctrl+Alt+A)
**Priority: Medium** | **Effort: High**

- **What:** Select all objects across frames that match the currently selected object (identical structure/properties)
- **Figma Reference:** "Select matching layers — ⌥ Option ⌘ Command A"
- **Implementation:** 
  - Compare node structure (name, kind, children count, dimensions)
  - Walk all frames to find structural matches
  - Add all matches to selection
  - Add toolbar button "Select matching layers"

### 4. Bulk Rename Modal (⌘R / Ctrl+R)
**Priority: Medium** | **Effort: High**

- **What:** Modal dialog for renaming multiple layers at once with pattern matching
- **Figma Reference:** "Right-click on the layers in the panel and choose Rename"
- **Features:**
  - Match field (find text/regex in layer names)
  - Rename to field (replacement pattern)
  - Current name button (insert placeholder)
  - Number ↑/↓ buttons (ascending/descending counters)
  - Preview of resulting names
  - Regex support ($1, $2, etc.)
- **Implementation:** 
  - New `BulkRenameModal` state and UI
  - Pattern matching engine with regex support
  - Preview computation
  - Apply rename to all selected layers

### 5. Smart Selection
**Priority: High** | **Effort: Very High**

- **What:** When 2+ equally-spaced layers are selected, show smart handles for adjusting spacing, reordering, and duplicating
- **Figma Reference:** "Smart selection lets you quickly adjust the arrangement, or spacing between a selection of two or more layers"
- **Features:**
  - 1D Smart Selection (row or column)
  - 2D Smart Selection (grid)
  - Pink handles between layers for spacing adjustment
  - Drag handle to change gap uniformly
  - Reorder by dragging within selection
  - Duplicate layers in place (⌘D)
  - Resize layers with reflow
- **Implementation:**
  - Detect smart selection (equal spacing, axis overlap)
  - Render pink handles between layers
  - Implement spacing drag handler
  - Implement reorder within selection
  - Layout section in inspector for "Space between"

### 6. Measure Distances Between Layers
**Priority: Medium** | **Effort: Medium**

- **What:** When hovering with a layer selected, show measurement lines to nearby layers (red dashed lines with pixel distances)
- **Figma Reference:** "Measure distances between layers"
- **Implementation:**
  - On hover (with selection), compute distances to nearby layers
  - Draw dashed red lines (horizontal/vertical) from selection to hovered layer
  - Show pixel distance label on each measurement line
  - Show offset values (dx, dy)

### 7. Hidden Layer Outlines (⌘⇧O)
**Priority: Low** | **Effort: Low**

- **What:** Toggle to show outlines of all hidden layers on canvas (dashed outlines)
- **Figma Reference:** "⌘ Command ⇧ Shift O to view and select hidden layer outlines"
- **Implementation:** Add a `show_hidden_outlines` flag; when true, render dashed outlines for all hidden nodes

### 8. Collapse All Layers Button
**Priority: Low** | **Effort: Low**

- **What:** Button in top-right of layers panel to collapse all expanded layers (or all except selection)
- **Figma Reference:** "Collapse layers appears in the top right corner of the Layers panel"
- **Implementation:** Add collapse-all icon button; on click, clear `expanded` set (preserving ancestors of selection)

### 9. Keyboard Navigation in Layer Panel
**Priority: Medium** | **Effort: Medium**

- **What:** Navigate layer tree with keyboard
  - Enter: Select child (drill into selection)
  - Shift+Enter: Select parent
  - Tab: Select next sibling
  - Shift+Tab: Select previous sibling
- **Figma Reference:** "Move between nested objects using the keyboard shortcuts"
- **Implementation:** Handle these keys in the layer panel focus context

### 10. Layer Panel Search/Filter
**Priority: Medium** | **Effort: Medium**

- **What:** Search bar at top of layers panel to filter layers by name
- **Figma Reference:** Search icon in PAGE header
- **Implementation:** Add search input above the layer tree; filter visible rows by name match; expand parents of matching layers

### 11. Auto-Reparenting
**Priority: Low** | **Effort: Medium**

- **What:** When moving an object over a frame, automatically reparent it as a child of that frame
- **Figma Reference:** "If an object is smaller than a frame, we will make it a child of the frame"
- **Implementation:** On move end, check if object bounds are within a frame; if so, reparent
- **Bypass:** Hold Space to prevent reparenting

### 12. Identify Matching Objects
**Priority: Low** | **Effort: Medium**

- **What:** Highlight identical objects across frames when hovering one
- **Figma Reference:** "Identify matching objects"
- **Implementation:** When hovering a layer in the panel, highlight all matching layers across all frames

### 13. Copy/Paste Properties Between Layers
**Priority: Medium** | **Effort: Medium**

- **What:** Copy fill, stroke, effects, text properties from one layer and paste onto another
- **Figma Reference:** "Copy and paste properties between layers"
- **Keyboard:** ⌥⌘C / ⌥⌘V (copy/paste properties)
- **Implementation:** Store property clipboard separately; apply to target layers

### 14. Inverse Selection (⌘⇧A / Ctrl+Shift+A)
**Priority: Low** | **Effort: Low**

- **What:** Select everything on the canvas that is NOT currently selected
- **Figma Reference:** "⌘ A Shift — removes current selection, then selects everything you didn't select before"
- **Implementation:** Collect all selectable node IDs, subtract current selection, set as new selection

### 15. Edit Objects in Bulk
**Priority: Medium** | **Effort: Medium**

- **What:** Edit shared properties across a multi-selection (e.g., all search bars across frames)
- **Figma Reference:** "Edit objects on the canvas in bulk"
- **Implementation:** When multiple layers are selected, show their common properties in inspector; changes apply to all

## Implementation Priority (Recommended Order)

### Phase 1: Quick Wins (Low effort, high impact)
1. ✅ **Collapse All Layers** — Clear `expanded` set with one button
2. ✅ **Hidden Layer Outlines (⌘⇧O)** — Simple toggle + dashed outline rendering
3. ✅ **Inverse Selection (⌘⇧A)** — Simple set operation
4. ✅ **Keyboard Navigation in Layer Panel** — Enter/Shift+Enter/Tab/Shift+Tab

### Phase 2: Core Selection Improvements
5. **Deep Select (⌘/Ctrl+click)** — Modify press handler to find deepest node
6. **Select Layer Menu** — Add submenu to context menu
7. **Layer Panel Search/Filter** — Add search input + filter logic
8. **Measure Distances** — Hover measurement overlay

### Phase 3: Advanced Features
9. **Select Matching Objects (⌥⌘A)** — Structural comparison engine
10. **Bulk Rename Modal (⌘R)** — Full modal with regex support
11. **Copy/Paste Properties (⌥⌘C/V)** — Property clipboard
12. **Edit Objects in Bulk** — Multi-selection property editing

### Phase 4: Smart Selection (Largest effort)
13. **Smart Selection** — Full implementation with:
    - Detection algorithm (equal spacing, axis overlap)
    - Pink handle rendering
    - Spacing adjustment drag
    - Reorder within selection
    - Duplicate in place
    - "Space between" fields in inspector

### Phase 5: Canvas Intelligence
14. **Auto-Reparenting** — Frame detection on move end
15. **Identify Matching Objects** — Cross-frame hover highlighting

## Keyboard Shortcuts Summary

| Shortcut | Action | Status |
|----------|--------|--------|
| ⌘⇧L | Lock/unlock | ✅ Done |
| ⌘⇧H | Toggle visibility | ✅ Done |
| ⌘A | Select all | ✅ Done |
| Enter | Select child | ❌ Missing |
| ⇧Enter | Select parent | ❌ Missing |
| Tab | Next sibling | ❌ Missing |
| ⇧Tab | Previous sibling | ❌ Missing |
| ⌘⇧O | Show hidden outlines | ❌ Missing |
| ⌥⌘A | Select matching | ❌ Missing |
| ⌘R | Bulk rename | ❌ Missing |
| ⌥⌘C | Copy properties | ❌ Missing |
| ⌥⌘V | Paste properties | ❌ Missing |
| ⌘⇧A | Inverse selection | ❌ Missing |
| ⌘/Ctrl+click | Deep select | ❌ Missing |

## Files to Modify

### Core (crates/x-core)
- `node.rs` — Add bulk rename logic, matching object detection

### Editor (crates/x-editor)
- `mod.rs` — Add deep select, reparenting logic

### UI (apps/x-designer)
- `state.rs` — New actions, modal state
- `editor_ui.rs` — New paint functions (smart handles, measurements, bulk rename modal)
- `run.rs` — New action handlers, keyboard shortcuts

## Estimated Effort

| Phase | Features | Estimated Time |
|-------|----------|---------------|
| Phase 1 | 4 quick wins | 1-2 days |
| Phase 2 | 4 core improvements | 3-5 days |
| Phase 3 | 4 advanced features | 5-7 days |
| Phase 4 | Smart selection | 7-10 days |
| Phase 5 | Canvas intelligence | 3-5 days |
| **Total** | **15 features** | **19-29 days** |
