# Vector Tools Gap Analysis: Figma vs X-Native

## Executive Summary

This document analyzes the gap between Figma's vector editing capabilities and X-Native's current implementation, based on the [Figma "Design with vector tools" documentation](https://help.figma.com/hc/en-us/sections/31585889321751-Design-with-vector-tools).

## Current X-Native Implementation

### ✅ What's Already Implemented

1. **Vector Path Data Model**
   - `NodeKind::Vector { path: Vec<PathCmd> }` - Core vector node type
   - `PathCmd` enum with MoveTo, LineTo, CurveTo (cubic bezier), Close
   - `simplify_polyline()` - Ramer-Douglas-Peucker simplification
   - `path_to_bez()` - Convert PathCmd to kurbo::BezPath

2. **Boolean Operations** (Fully Implemented)
   - `crates/x-core/src/booleans.rs` - Complete boolean engine
   - Union, Subtract, Intersect, Exclude operations
   - Three backends: BezierExact (default), Exact (polygon), RasterGuided (fallback)
   - Curve-preserving boolean operations (curves in, curves out)
   - Exposed via `CtxCmd::Union/Subtract/Intersect/Exclude`

3. **Pen Tool**
   - `Tool::Pen` - Basic pen tool for creating vector paths
   - Can create paths with MoveTo, LineTo, CurveTo
   - Keyboard shortcut: P

4. **Eraser Tool**
   - `Tool::Eraser` - Can erase parts of vector paths
   - Shift+E shortcut

5. **Stroke & Fill**
   - Full stroke system with `StrokeLayer`
   - Stroke alignment: Inside/Outside/Center
   - Fill system with `PaintLayer`
   - Multiple fill/stroke layers supported

6. **Context Menu Actions** (Defined but not fully implemented)
   - `EditVector` - Action defined in context_menu.rs
   - `OutlineStroke` - Action defined
   - `Flatten` - Action defined

## ❌ Missing Features (Gap Analysis)

### Phase 1: Core Vector Editing Mode (Critical)

#### 1. Vector Edit Mode
**Figma Feature**: Press Enter to enter vector edit mode, allowing point manipulation
**Status**: ❌ NOT IMPLEMENTED
**Requirements**:
- Enter/exit vector edit mode (Enter key)
- Show vector points and handles when in edit mode
- Select individual points/segments
- Move points with mouse
- Delete points (Delete key)
- Add points to segments (click on segment)

**Implementation Plan**:
```rust
// Add to state.rs
pub struct VectorEditMode {
    pub active: bool,
    pub selected_node: Option<String>,
    pub selected_points: Vec<usize>,
    pub tool: VectorTool,
}

pub enum VectorTool {
    Move,
    Pen,
    Bend,
    Cut,
    Eraser,
    Lasso,
}

// Add to App struct
pub vector_edit_mode: Option<VectorEditMode>,
```

**Files to Modify**:
- `apps/x-designer/src/bin/x_native_app/state.rs` - Add state
- `apps/x-designer/src/bin/x_native_app/run.rs` - Add keyboard handler
- `apps/x-designer/src/bin/x_native_app/editor_ui.rs` - Render edit mode UI
- `apps/x-designer/src/bin/x_native_app/events.rs` - Add mouse handlers

---

#### 2. Point Selection & Manipulation
**Figma Feature**: Select points, move them, add/remove points
**Status**: ❌ NOT IMPLEMENTED
**Requirements**:
- Click to select individual points
- Shift+click for multi-select
- Drag to move selected points
- Delete selected points
- Add point on segment (click between points)

**Implementation Plan**:
```rust
// In editor_core.rs
pub fn select_vector_point(&mut self, node_id: &str, point_idx: usize) {
    // Add to selection
}

pub fn move_vector_points(&mut self, node_id: &str, points: &[usize], dx: f64, dy: f64) {
    // Modify PathCmd positions
}

pub fn add_vector_point(&mut self, node_id: &str, segment_idx: usize, position: (f64, f64)) {
    // Insert new point in path
}

pub fn delete_vector_points(&mut self, node_id: &str, points: &[usize]) {
    // Remove points from path
}
```

---

### Phase 2: Vector Editing Tools (High Priority)

#### 3. Bend Tool (Bézier Handle Manipulation)
**Figma Feature**: Add and adjust bézier curves
**Status**: ❌ NOT IMPLEMENTED
**Requirements**:
- Click on point to add bézier handles
- Drag handles to adjust curve
- Mirror handle modes: No mirroring, Mirror angle, Mirror angle+length

**Implementation Plan**:
```rust
pub fn add_bezier_handle(&mut self, node_id: &str, point_idx: usize) {
    // Convert LineTo to CurveTo with control points
}

pub fn adjust_bezier_handle(&mut self, node_id: &str, point_idx: usize, handle: (f64, f64)) {
    // Modify control points
}
```

---

#### 4. Cut Tool
**Figma Feature**: Split vector paths at points or along segments
**Status**: ❌ NOT IMPLEMENTED
**Requirements**:
- Click on point to split path
- Click and drag across segments to cut
- Create separate layers from cut pieces

**Implementation Plan**:
```rust
pub fn split_vector_path(&mut self, node_id: &str, at_point: usize) -> Vec<String> {
    // Split path at point, return new node IDs
}

pub fn cut_vector_path(&mut self, node_id: &str, start: (f64, f64), end: (f64, f64)) -> Vec<String> {
    // Cut along line, return new node IDs
}
```

---

#### 5. Lasso Tool
**Figma Feature**: Select multiple points with freeform selection
**Status**: ❌ NOT IMPLEMENTED
**Requirements**:
- Draw freeform selection area
- Select all points inside area
- Combine with Shift for additive selection

---

#### 6. Variable Width Strokes
**Figma Feature**: Create strokes with varying width along path
**Status**: ❌ NOT IMPLEMENTED
**Requirements**:
- Add width points along stroke
- Adjust width at each point
- Pre-configured width profiles (tapered, etc.)

**Implementation Plan**:
```rust
// Add to Node struct
pub stroke_width_profile: Option<Vec<WidthPoint>>,

pub struct WidthPoint {
    pub position: f64, // 0.0 to 1.0 along path
    pub width: f64,
}

// In renderer
pub fn render_variable_width_stroke(&self, node: &Node, vars: &Variables) {
    // Generate path with varying stroke width
}
```

---

### Phase 3: Path Operations (Medium Priority)

#### 7. Outline Stroke (Convert Stroke to Path)
**Figma Feature**: Convert strokes to editable vector paths
**Status**: ⚠️ PARTIALLY IMPLEMENTED (action defined, not wired)
**Requirements**:
- Convert stroke to filled path
- Each side of stroke becomes separate path
- Preserve stroke styling as fill

**Implementation Plan**:
```rust
pub fn outline_stroke(&mut self, node_id: &str) {
    // Convert stroke to vector path
    // For each stroke segment, create offset paths
}

// In booleans.rs or new module
pub fn stroke_to_path(path: &[PathCmd], width: f64) -> Vec<PathCmd> {
    // Generate offset paths for stroke
}
```

**Keyboard Shortcut**: ⌘⌥O / Ctrl+Alt+O

---

#### 8. Flatten Layers
**Figma Feature**: Merge multiple layers into single vector path
**Status**: ⚠️ PARTIALLY IMPLEMENTED (action defined, not wired)
**Requirements**:
- Combine multiple vector paths into one
- Convert text to vector paths
- Remove hierarchy (flatten groups/frames)

**Implementation Plan**:
```rust
pub fn flatten_selection(&mut self) {
    // Get all selected nodes
    // Convert each to vector path (text -> outline, shapes -> path)
    // Union all paths into single node
}
```

**Keyboard Shortcut**: ⌥⇧F / Alt+Shift+F

---

#### 9. Convert Text to Vector Path
**Figma Feature**: Outline text to make it editable as vector
**Status**: ❌ NOT IMPLEMENTED
**Requirements**:
- Convert text glyphs to vector paths
- Preserve visual appearance
- Allow point editing after conversion

**Implementation Plan**:
```rust
pub fn text_to_outline(&mut self, node_id: &str) {
    // Extract text content
    // Convert each glyph to vector path using font outlines
    // Create new vector node with combined path
}
```

---

#### 10. Offset Vector Path
**Figma Feature**: Expand or contract path by offset distance
**Status**: ❌ NOT IMPLEMENTED
**Requirements**:
- Expand path outward (positive offset)
- Contract path inward (negative offset)
- Choose join style: Square or Round

**Implementation Plan**:
```rust
pub fn offset_vector(&mut self, node_id: &str, distance: f64, join: JoinStyle) {
    // Compute offset path
    // Handle corners based on join style
}

pub enum JoinStyle {
    Square,
    Round,
}

// In booleans.rs or new module
pub fn offset_path(path: &[PathCmd], offset: f64) -> Vec<PathCmd> {
    // Generate offset path
}
```

---

#### 11. Simplify Vector Path
**Figma Feature**: Reduce path complexity by removing points
**Status**: ⚠️ PARTIALLY IMPLEMENTED (simplify_polyline exists, not exposed in UI)
**Requirements**:
- Slider to control simplification amount
- Automatic simplification of entire path
- Manual: select points and delete+heal

**Implementation Plan**:
```rust
pub fn simplify_vector(&mut self, node_id: &str, tolerance: f64) {
    // Apply simplify_polyline to path
    // Update node with simplified path
}
```

---

### Phase 4: Advanced Tools (Low Priority)

#### 12. Shape Builder Tool
**Figma Feature**: Interactive boolean operations with visual feedback
**Status**: ❌ NOT IMPLEMENTED
**Requirements**:
- Hover over regions to highlight
- Click to merge regions
- Alt+click to subtract regions
- Extract regions to separate layers

**Implementation Plan**:
```rust
pub struct ShapeBuilderTool {
    pub hovered_region: Option<RegionId>,
    pub selected_regions: Vec<RegionId>,
}

pub fn shape_builder_merge(&mut self, regions: &[RegionId]) {
    // Union selected regions
}

pub fn shape_builder_subtract(&mut self, region: RegionId) {
    // Subtract region
}
```

---

#### 13. Stroke Caps (End Point Styling)
**Figma Feature**: Add caps to stroke endpoints
**Status**: ❌ NOT IMPLEMENTED
**Requirements**:
- Cap types: None, Line arrow, Triangle arrow, Reversed triangle, Circle, Diamond, Round, Square
- Per-endpoint cap selection
- Visual rendering of caps

**Implementation Plan**:
```rust
// Add to Stroke struct
pub cap_start: StrokeCap,
pub cap_end: StrokeCap,

pub enum StrokeCap {
    None,
    LineArrow,
    TriangleArrow,
    ReversedTriangle,
    Circle,
    Diamond,
    Round,
    Square,
}

// In renderer
pub fn render_stroke_cap(&self, cap: StrokeCap, position: (f64, f64), angle: f64) {
    // Render cap shape
}
```

---

#### 14. Paint Tool
**Figma Feature**: Freehand drawing with pressure sensitivity
**Status**: ❌ NOT IMPLEMENTED
**Requirements**:
- Freehand drawing mode
- Pressure sensitivity (if tablet supported)
- Brush size and shape options

---

## Implementation Priority & Timeline

### Phase 1: Core Vector Editing (2-3 weeks)
1. Vector Edit Mode state management
2. Point selection & manipulation
3. Enter/exit edit mode (Enter key)
4. Visual rendering of points/handles
5. Mouse interaction for point editing

### Phase 2: Editing Tools (2 weeks)
6. Bend tool (bézier handles)
7. Cut tool
8. Lasso tool
9. Basic variable width strokes

### Phase 3: Path Operations (2 weeks)
10. Outline stroke (wire up existing action)
11. Flatten layers (wire up existing action)
12. Convert text to path
13. Offset vector path
14. Simplify vector path (expose existing simplify_polyline)

### Phase 4: Advanced Tools (2 weeks)
15. Shape builder tool
16. Stroke caps
17. Paint tool
18. Width profiles

**Total Estimated Time**: 8-9 weeks

---

## Keyboard Shortcuts Reference

| Shortcut | Action | Figma | X-Native Status |
|----------|--------|-------|-----------------|
| Enter | Enter/Exit vector edit mode | ✅ | ❌ Missing |
| P | Pen tool | ✅ | ✅ Done |
| V | Move tool (in edit mode) | ✅ | ❌ Missing |
| X | Cut tool | ✅ | ❌ Missing |
| Shift+E | Eraser tool | ✅ | ✅ Done |
| Q | Lasso tool | ✅ | ❌ Missing |
| ⌘⌥O / Ctrl+Alt+O | Outline stroke | ✅ | ⚠️ Action defined |
| ⌥⇧F / Alt+Shift+F | Flatten | ✅ | ⚠️ Action defined |
| ⌥⇧U / Alt+Shift+U | Union | ✅ | ✅ Done |
| ⌥⇧S / Alt+Shift+S | Subtract | ✅ | ✅ Done |
| ⌥⇧I / Alt+Shift+I | Intersect | ✅ | ✅ Done |
| ⌥⇧E / Alt+Shift+E | Exclude | ✅ | ✅ Done |

---

## Technical Considerations

### Performance
- Vector edit mode must render efficiently with many points
- Consider using spatial hashing for point hit-testing
- Limit handle rendering to selected points to reduce draw calls

### Data Model
- Current `PathCmd` is sufficient for basic editing
- May need to add point metadata (corner vs smooth, handle locks)
- Variable width requires per-point width data

### Rendering
- Points should render at fixed screen size (not affected by zoom)
- Handles should be semi-transparent to avoid obscuring paths
- Use distinct colors for selected vs unselected points

### User Experience
- Snap to grid/pixels when moving points
- Show distance tooltips when adjusting handles
- Provide visual feedback for all editing operations

---

## Testing Strategy

1. **Unit Tests**
   - Point manipulation (add, move, delete)
   - Path operations (offset, simplify, outline)
   - Boolean operations (already tested)

2. **Integration Tests**
   - Edit mode enter/exit
   - Tool switching
   - Undo/redo for vector edits

3. **Visual Tests**
   - Point rendering at various zoom levels
   - Handle visibility and interaction
   - Stroke cap rendering

4. **Performance Tests**
   - Edit mode with 1000+ points
   - Variable width with complex paths
   - Boolean operations on complex shapes

---

## References

- [Figma Vector Networks](https://help.figma.com/hc/en-us/articles/360040450213-Vector-networks)
- [Figma Edit Vector Layers](https://help.figma.com/hc/en-us/articles/360039957634-Edit-vector-layers)
- [Figma Boolean Operations](https://help.figma.com/hc/en-us/articles/360039957534-Boolean-operations)
- [Figma Shape Builder Tool](https://help.figma.com/hc/en-us/articles/31616004109847-Create-custom-shapes-with-the-shape-builder-tool)
- [Figma Offset Vector](https://help.figma.com/hc/en-us/articles/33792861450263-Offset-a-vector-path)
- [Figma Simplify Vector](https://help.figma.com/hc/en-us/articles/33792593975575-Simplify-a-vector-path)

---

## Summary

X-Native has a solid foundation for vector editing with:
- ✅ Vector path data model
- ✅ Boolean operations (fully implemented)
- ✅ Basic pen tool
- ✅ Eraser tool

Missing critical features:
- ❌ Vector edit mode (point manipulation)
- ❌ Advanced editing tools (bend, cut, lasso)
- ❌ Path operations (offset, outline, flatten)
- ❌ Variable width strokes
- ❌ Shape builder tool

**Recommended Next Steps**:
1. Implement vector edit mode (Phase 1)
2. Add point selection & manipulation
3. Wire up existing flatten/outline actions
4. Add bend and cut tools
5. Implement path operations

This will bring X-Native to feature parity with Figma's vector editing capabilities.
