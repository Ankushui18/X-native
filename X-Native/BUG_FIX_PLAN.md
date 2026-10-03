# X-Native Bug Fix Implementation Plan

This document maps the 18 identified issues (QA-001 through QA-018) to specific code locations and provides implementation guidance for the development team.

---

## 🔴 P0: Critical / Blocker Issues

### QA-001: Figma Copy/Paste Not Working
**Component:** Clipboard / `x-format`  
**Files to Investigate:**
- `apps/x-designer/src/bin/x_native_app/state.rs:2481` - `try_import_from_figma_clipboard()`
- `crates/x-format/src/figma.rs:838` - `import_figma_json()`
- `apps/x-designer/src/bin/x_native_app/run.rs:4351-4358` - Paste handler

**Root Cause Analysis:**
The current implementation at line 2486 calls `x_native::fileio::import_figma_json(&clipboard_text)` which expects Figma's REST API JSON format with a `"document"` key. However, Figma's actual clipboard behavior may vary.

**Fix Steps:**
1. Add logging to detect what MIME types/text formats are actually received from the system clipboard
2. Check if Figma copies as `application/json` or plain text
3. Verify the JSON structure matches what `import_figma_json` expects (must have `"document"` key with `"children"` array)
4. Add error handling to show users why paste failed

**Debug Code to Add:**
```rust
// In state.rs:2481
pub fn try_import_from_figma_clipboard() -> Option<x_native::Document> {
    let clipboard_text = get_system_clipboard_text()?;
    
    // DEBUG: Log clipboard content length and first chars
    eprintln!("[DEBUG] Clipboard text length: {}", clipboard_text.len());
    eprintln!("[DEBUG] Clipboard preview: {:?}", &clipboard_text[..clipboard_text.len().min(200)]);
    
    match x_native::fileio::import_figma_json(&clipboard_text) {
        Ok(doc) => Some(doc),
        Err(e) => {
            eprintln!("[DEBUG] Figma import failed: {}", e);
            None
        }
    }
}
```

---

### QA-002: New Files Cannot Be Closed
**Component:** State Management / Windowing  
**Files to Investigate:**
- `apps/x-designer/src/bin/x_native_app/state.rs:2111` - `close_doc()`
- `apps/x-designer/src/bin/x_native_app/run.rs:6024-6068` - `request_close_doc()` and `close_doc_with_choice()`

**Root Cause Analysis:**
At line 2115-2117, `close_doc()` returns early if the document is dirty without showing a save dialog. The proper flow should go through `request_close_doc()` which handles the dirty state properly.

**Fix Steps:**
1. Ensure UI close button calls `request_close_doc()` not `close_doc()` directly
2. Verify the save dialog modal is properly rendered when dirty=true
3. Check that GPU resources in `x-render` are released when doc is removed

**Key Code Review:**
```rust
// state.rs:2111-2117 - THIS IS THE PROBLEM
pub fn close_doc(&mut self, idx: usize) {
    if idx >= self.docs.len() {
        return;
    }
    if self.docs[idx].dirty {  // ← Returns silently if dirty!
        return;
    }
    // ... removal logic
}
```

**Fix:** The UI should only call `close_doc()` after user confirms discard/save via `request_close_doc()`.

---

### QA-003: Undo/Redo State Desync with Render Scene
**Component:** State Management / `x-core` & `x-render`  
**Files to Investigate:**
- `apps/x-designer/src/bin/x_native_app/session.rs:167-214` - `undo_document()`, `redo_document()`, `history_step()`
- `apps/x-designer/src/bin/x_native_app/state.rs:2142` - `mark_dirty()`
- `apps/x-designer/src/bin/x_native_app/run.rs:192` - `request_redraw()`

**Root Cause Analysis:**
After undo/redo at line 211 in session.rs, `self.sync()` is called but there's no explicit `request_redraw()` call to ensure Vello re-renders the scene.

**Fix Steps:**
1. After `history_step()` completes successfully, explicitly trigger a redraw
2. Verify that `sync()` properly invalidates the frame cache
3. Add tracing to confirm undo stack operations

**Fix Location:**
```rust
// session.rs:167-172
pub fn undo_document(&mut self) -> bool {
    let result = self.history_step(false);
    if result {
        // TODO: Trigger canvas redraw here
    }
    result
}
```

---

## 🟠 P1: High Priority Issues

### QA-004: Frame Name Not Visible in Viewport
**Component:** Viewport Rendering / `x-board`  
**Files to Investigate:**
- `crates/x-render/src/scene.rs:531-560` - Frame name rendering logic

**Current Behavior:**
Lines 531-560 DO render frame names, but only for nodes with `NodeKind::Section`. Check if frames are being created as `Section` vs `Frame` kind.

**Fix Steps:**
1. Verify that frames created with 'F' shortcut have the correct `NodeKind`
2. Check camera matrix transformation is applied to label position (line 539)
3. Ensure font loading succeeds (lines 540-557)

**Debug:**
```rust
// Add before line 531 in scene.rs
if node.kind == NodeKind::Frame {
    eprintln!("[DEBUG] Frame '{}' at ({}, {}), name='{}'", 
              node.name, node.x, node.y, node.name);
}
```

---

### QA-005: Frame Borders Render Incorrectly
**Component:** Viewport Rendering / `x-render`  
**Files to Investigate:**
- `crates/x-render/src/sinks.rs` - Viewport/scissor setup
- `apps/x-designer/src/bin/x_native_app/gpu_target.rs` - Render pass configuration

**Fix Steps:**
1. Verify scissor test is enabled for canvas viewport
2. Ensure panel rendering uses separate viewports
3. Check wgpu render pass bounds match canvas area

---

### QA-006: Pen Tool Does Not Behave Like Figma
**Component:** Tools / `x-board`  
**Files to Investigate:**
- `apps/x-designer/src/bin/x_native_app/state.rs:498-501` - `Drag::Pen` state
- `apps/x-designer/src/bin/x_native_app/run.rs` - Pen tool event handling

**Fix Steps:**
1. Implement bezier handle dragging state machine
2. Add visual feedback for control points
3. Properly finalize path on Enter/Escape

---

### QA-007: Pages vs. Layers Hierarchy Issue
**Component:** UI Panel / State Management  
**Files to Investigate:**
- `apps/x-designer/src/bin/x_native_app/editor_ui.rs` - Layer tree rendering
- `apps/x-designer/src/bin/x_native_app/state.rs:567` - `mock_layers` field

**Note:** The presence of `mock_layers` suggests the UI may be rendering mock data instead of actual document structure.

---

### QA-008: Typography / Font Inconsistency (Manrope)
**Component:** Typography / `x-text`  
**Files to Investigate:**
- `apps/x-designer/src/bin/x_native_app/fonts.rs` - Font loading
- `crates/x-text/src/lib.rs` - Text encoding

**Fix Steps:**
1. Verify Manrope font files are in assets folder
2. Check font family resolution in `x-text`
3. Validate TrueType metrics (ascender/descender) application

---

### QA-009: Pages Are Being Created Incorrectly
**Component:** State Management  
**Files to Investigate:**
- `apps/x-designer/src/bin/x_native_app/state.rs` - Page creation logic
- `apps/x-designer/src/bin/x_native_app/run.rs` - AddPage action handler

**Fix Steps:**
1. Ensure new pages get unique IDs
2. Verify UI list uses ID-based keys, not indices
3. Check page array append logic

---

### QA-010: Canvas Zoom/Pan Cursor Desync
**Component:** Viewport / `x-board`  
**Files to Investigate:**
- `apps/x-designer/src/bin/x_native_app/loading.rs` - Camera/view config
- `crates/x-render/src/frame_cache.rs` - Coordinate transformations

**Fix Steps:**
1. Audit `screen_to_world` transformation math
2. Ensure same view/projection matrix used for input and rendering
3. Check for floating-point precision issues at high zoom

---

## 🟡 P2: Medium Priority Issues

### QA-011: Excessive Drop Shadow on Viewport Toolbar
**Component:** UI / Design System  
**Files to Investigate:**
- `crates/x-ui/src/design_system.rs` - Shadow parameters

---

### QA-012: Major UI Layout, Text, and Icon Alignment Issues
**Component:** UI / Design System  
**Files to Investigate:**
- `crates/x-ui/src/` - Layout containers
- `apps/x-designer/src/bin/x_native_app/paint.rs` - UI rendering

---

### QA-013: Right Panel Tab Double-Click Interaction Fails
**Component:** UI / Interactions  
**Files to Investigate:**
- `apps/x-designer/src/bin/x_native_app/run.rs` - Event handling
- `apps/x-designer/src/bin/x_native_app/editor_ui.rs` - Tab UI

**Fix:** Verify double-click event listener is registered, not just single-click.

---

### QA-014: Theme Toggle Not Propagating to Canvas Background/Grid
**Component:** UI / `x-ui` & `x-board`  
**Files to Investigate:**
- `apps/x-designer/src/bin/x_native_app/theme.rs` - Theme state
- `crates/x-render/src/scene.rs` - Background color usage

**Fix:** Ensure canvas renderer subscribes to theme change events.

---

### QA-015: Selection Handles Not Rotating/Scaling with Object
**Component:** Viewport / `x-board`  
**Files to Investigate:**
- `crates/x-render/src/` - Bounding box calculation
- Selection handle rendering code

**Fix:** Compute Oriented Bounding Box (OBB) instead of AABB for rotated objects.

---

## 🟢 P3: Low Priority / Architectural Debt

### QA-016: Memory Leak on Repeated File Switching
**Component:** Performance / `x-render`  
**Files to Investigate:**
- `apps/x-designer/src/bin/x_native_app/state.rs:2111` - `close_doc()` cleanup
- `crates/x-render/src/` - Texture/buffer lifecycle

**Fix Steps:**
1. Profile memory usage during file switching
2. Ensure explicit drop of wgpu textures and buffers
3. Add resource tracking/debug counters

---

### QA-017: Auto Layout Recalculation Blocking Main Thread
**Component:** Performance / `x-core`  
**Files to Investigate:**
- `crates/x-core/src/` - Layout engine
- `apps/x-designer/src/bin/x_native_app/state.rs` - Layout triggers

**Fix:** Consider debouncing or background thread offloading.

---

### QA-018: Raster Image Export Misalignment
**Component:** Export / `x-render`  
**Files to Investigate:**
- `crates/x-render/src/raster.rs` - Export pipeline
- `crates/x-render/src/sinks.rs` - Scene generation for export

**Fix:** Ensure export uses identical transform matrix as viewport.

---

## Recommended Implementation Order

### Week 1: Critical Path (P0)
1. **QA-001** - Figma copy/paste (blocks validation)
2. **QA-003** - Undo/redo desync (data integrity)
3. **QA-002** - File closing (basic workflow)

### Week 2: Rendering Core (P1)
4. **QA-010** - Zoom/pan desync (affects all interactions)
5. **QA-004** - Frame names (visibility issue)
6. **QA-005** - Frame borders (visual correctness)
7. **QA-006** - Pen tool (core feature)

### Week 3: UI Polish (P1/P2)
8. **QA-007** - Pages/layers hierarchy
9. **QA-008** - Typography consistency
10. **QA-009** - Page creation
11. **QA-012** - UI alignment
12. **QA-014** - Theme propagation

### Week 4: Advanced Features & Optimization (P2/P3)
13. **QA-011** - Toolbar shadow
14. **QA-013** - Double-click handling
15. **QA-015** - Selection handles
16. **QA-016** - Memory leak profiling
17. **QA-017** - Auto-layout performance
18. **QA-018** - Export alignment

---

## Testing Strategy

For each fix:
1. Add regression test in `apps/x-designer/src/bin/x_native_app/regression_tests.rs`
2. Run existing test suite: `cargo test --package x-native`
3. Manual verification against Figma behavior
4. Screenshot comparison for rendering fixes

---

## Key Architecture Notes

- **Clipboard**: Uses `arboard` crate for system clipboard access
- **Rendering**: Vello + wgpu GPU pipeline
- **State**: Document-based with per-page editors
- **UI**: Custom immediate-mode UI in `x-ui` crate
- **File Format**: Custom `.x` format with Figma/SVG/PNG import support
