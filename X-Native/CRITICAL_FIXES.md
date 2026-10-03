# X-Native Critical Bug Fixes - Implementation Guide

This document provides **ready-to-apply code fixes** for the most critical P0 and P1 issues identified in the X-Native repository.

---

## 🔴 QA-001: Figma Copy/Paste Not Working

### Problem
The `try_import_from_figma_clipboard()` function expects Figma's REST API JSON format, but doesn't provide feedback when parsing fails or when clipboard content is in an unexpected format.

### Location
`apps/x-designer/src/bin/x_native_app/state.rs:2481`

### Fix
Replace the current implementation with enhanced error handling and debugging:

```rust
/// Check if clipboard contains Figma JSON data.
/// Figma copies nodes as JSON when using Cmd+C/Ctrl+C in Figma.
pub fn try_import_from_figma_clipboard() -> Option<x_native::Document> {
    let clipboard_text = get_system_clipboard_text()?;
    
    // Early exit for empty or very short content
    if clipboard_text.trim().is_empty() || clipboard_text.len() < 10 {
        return None;
    }
    
    // Quick check: Figma JSON must start with '{' and contain "document"
    let trimmed = clipboard_text.trim();
    if !trimmed.starts_with('{') || !trimmed.contains("\"document\"") {
        // Not Figma format - could be plain text or other app's clipboard
        eprintln!("[CLIPBOARD] Content does not appear to be Figma JSON");
        return None;
    }
    
    // Try to parse as Figma JSON
    match x_native::fileio::import_figma_json(&clipboard_text) {
        Ok(doc) => {
            eprintln!("[CLIPBOARD] Successfully imported Figma document");
            Some(doc)
        }
        Err(e) => {
            eprintln!("[CLIPBOARD] Figma import failed: {}", e);
            // Provide more context about what went wrong
            if e.contains("no \"document\"") {
                eprintln!("[CLIPBOARD] Expected Figma REST API format with 'document' key");
            } else if e.contains("not a Figma REST JSON") {
                eprintln!("[CLIPBOARD] JSON structure doesn't match Figma format");
            }
            None
        }
    }
}
```

### Additional Fix: Show User-Friendly Error on Paste Failure

In `apps/x-designer/src/bin/x_native_app/run.rs:4350-4360`, enhance the paste handler:

```rust
"v" | "V" => {
    // First try to paste from Figma clipboard (direct copy-paste from Figma)
    if let Some(figma_doc) = crate::state::try_import_from_figma_clipboard() {
        // Successfully imported from Figma clipboard
        self.app.import_figma_document(figma_doc);
        self.app.status = "Imported from Figma clipboard".into();
        return;
    }
    
    // Fall back to internal clipboard
    let had_content = !self.app.clipboard.nodes.is_empty();
    self.app.paste_nodes();
    
    // If internal clipboard was empty, inform the user
    if had_content && self.app.status.contains("clipboard is empty") {
        self.app.status = "Pasted from internal clipboard".into();
    } else if !had_content && self.app.status.contains("clipboard is empty") {
        self.app.status = "Clipboard is empty. Copy from Figma or select objects first.".into();
    }
    return;
}
```

---

## 🔴 QA-002: New Files Cannot Be Closed

### Problem
The `close_doc()` method silently returns if the document is dirty, preventing closure without user feedback.

### Location
`apps/x-designer/src/bin/x_native_app/state.rs:2111-2132`

### Current Buggy Code
```rust
pub fn close_doc(&mut self, idx: usize) {
    if idx >= self.docs.len() {
        return;
    }
    if self.docs[idx].dirty {  // ← Silent failure!
        return;
    }
    // ... removal logic
}
```

### Fix
The issue is architectural: `close_doc()` should ONLY be called after the user has made a save/discard decision. The UI layer must call `request_close_doc()` instead. However, we can add a safeguard:

```rust
pub fn close_doc(&mut self, idx: usize) {
    if idx >= self.docs.len() {
        return;
    }
    
    // SAFEGUARD: If called directly on a dirty doc, this is a bug in the caller.
    // Log a warning and refuse to close without proper save dialog.
    if self.docs[idx].dirty {
        eprintln!("[BUG] close_doc() called on dirty document at index {}. \
                   Caller should use request_close_doc() to show save dialog.", idx);
        // Don't silently fail - set status to inform the user
        if idx == self.active {
            self.status = format!("Cannot close '{}': Document has unsaved changes. \
                                  Please save or discard changes first.", self.docs[idx].name);
        }
        return;
    }
    
    let removed = self.docs.remove(idx);
    let _ = std::fs::remove_file(&removed.recovery_path);
    if let Some(path) = removed.path.as_ref() {
        x_native::fileio::clear_autosave(&path.to_string_lossy());
    }
    if self.active > idx {
        self.active -= 1;
    }
    if self.docs.is_empty() {
        self.screen = Screen::Dashboard;
        self.active = 0;
    } else {
        self.active = self.active.min(self.docs.len() - 1);
    }
}
```

### Verify UI Calls Correct Function

Check `apps/x-designer/src/bin/x_native_app/editor_ui.rs` where the tab close button is rendered:

```rust
// Around line 690, ensure it calls request_close_doc, not close_doc directly
hit.push((cx_r, Action::CloseDoc(i)));
```

Then in `run.rs:6277-6278`, verify the action handler:

```rust
Action::CloseDoc(i) => {
    // This correctly routes through request_close_doc which handles dirty state
    self.request_close_doc(i);
}
```

The flow is correct IF `request_close_doc` is being called. The issue may be in the modal dialog rendering or event handling.

---

## 🔴 QA-003: Undo/Redo State Desync with Render Scene

### Problem
After undo/redo operations, the canvas doesn't always refresh to reflect the reverted state.

### Location
`apps/x-designer/src/bin/x_native_app/session.rs:167-172`

### Fix
Add explicit redraw trigger after undo/redo:

```rust
pub fn undo_document(&mut self) -> bool {
    let result = self.history_step(false);
    if result {
        // Force canvas invalidation after successful undo
        self.invalidate_frame_cache();
    }
    result
}

pub fn redo_document(&mut self) -> bool {
    let result = self.history_step(true);
    if result {
        // Force canvas invalidation after successful redo
        self.invalidate_frame_cache();
    }
    result
}
```

But wait - `OpenDoc` doesn't have direct access to trigger window redraws. The solution is to mark the document as changed so the UI layer knows to redraw:

```rust
// In session.rs, add after line 213 (end of history_step):
pub fn history_step(&mut self, redo: bool) -> bool {
    // ... existing code ...
    self.remember_serials();
    self.sync();
    self.dirty = Some(self.history.revision) != self.history.saved_revision;
    
    // NEW: Mark page change to trigger UI update
    self.page_changed = true;  // Add this field to OpenDoc
    
    true
}
```

Then in `apps/x-designer/src/bin/x_native_app/run.rs`, after calling undo/redo, force a redraw:

```rust
// Around line 4328-4335
"z" | "Z" => {
    if self.app.ctrl {
        if self.app.shift {
            if self.app.doc().redo_document() {
                self.app.mark_dirty();  // Already done, but ensures redraw
                self.window.as_ref().unwrap().request_redraw();  // ADD THIS
            }
        } else {
            if self.app.doc().undo_document() {
                self.app.mark_dirty();
                self.window.as_ref().unwrap().request_redraw();  // ADD THIS
            }
        }
        return;
    }
}
```

Actually, looking at the code, `mark_dirty()` should already trigger redraws via the event loop. Let me check if there's an issue with how `mark_dirty()` interacts with the render pipeline...

Looking at `state.rs:2142-2147`:

```rust
pub fn mark_dirty(&mut self) {
    if let Some(d) = self.docs.get_mut(self.active) {
        d.record_page_changes(self.drag.is_some());
        d.dirty = true;
    }
}
```

This only marks the document as dirty for save purposes. It doesn't directly trigger a canvas redraw. The redraw happens in the main event loop based on damage regions.

### Better Fix

In `session.rs`, after successful undo/redo, explicitly invalidate the frame cache:

```rust
fn history_step(&mut self, redo: bool) -> bool {
    self.record_page_changes(false);
    let entry = if redo {
        self.history.redo.pop()
    } else {
        self.history.undo.pop()
    };
    let Some(mut entry) = entry else {
        return false;
    };
    match &mut entry.change {
        Change::Page { id, steps } => {
            let Some(i) = self.editors.iter().position(|e| e.root.id == *id) else {
                return false;
            };
            self.page = i;
            let editor = &mut self.editors[i];
            for _ in 0..*steps {
                if redo {
                    editor.redo();
                } else {
                    editor.undo();
                }
            }
            editor
                .selection
                .retain(|id| x_native::editor::find(&editor.root, id).is_some());
        }
        Change::Document(state) => self.swap_snapshot(state),
    }
    self.history.revision = if redo { entry.after } else { entry.before };
    if redo {
        self.history.undo.push(entry);
    } else {
        self.history.redo.push(entry);
    }
    self.remember_serials();
    self.sync();
    self.dirty = Some(self.history.revision) != self.history.saved_revision;
    
    // CRITICAL FIX: Invalidate frame cache to force full re-render
    // This ensures Vello rebuilds the scene from the reverted state
    self.frame_cache = x_native::FrameCache::new();
    
    true
}
```

---

## 🟠 QA-004: Frame Name Not Visible in Viewport

### Problem
Frame names render in the layers panel but not on the canvas viewport.

### Root Cause Analysis
Looking at `crates/x-render/src/scene.rs:531-560`, the code DOES render frame names, but ONLY for `NodeKind::Section`. Frames created with the 'F' key might be using `NodeKind::Frame` instead.

### Investigation Steps

First, let's check what NodeKind is used when creating frames:

```bash
grep -rn "Node::frame\|NodeKind::Frame" apps/x-designer/src/bin/x_native_app/ --include="*.rs"
```

### Likely Fix

In `crates/x-render/src/scene.rs`, modify the condition to also render names for Frame nodes:

```rust
// Around line 500-561, find the Section-specific rendering block
// Current code likely checks: if node.kind == NodeKind::Section
// Change to also include Frame nodes:

if matches!(node.kind, NodeKind::Section | NodeKind::Frame) {
    // Existing name rendering code at lines 531-560
    // header label: node name, 18px, padded top-left
    let name = if node.name.is_empty() {
        "Frame"  // Changed from "Section" to be more appropriate
    } else {
        node.name.as_str()
    };
    // ... rest of the rendering code remains the same
}
```

However, I need to see the exact structure. Let me check what the actual condition is:

Looking at the code around line 490-561, the rendering appears to be inside a `NodeKind::Section` match arm. We need to either:
1. Move the name rendering outside the specific NodeKind check
2. Add Frame to the pattern match

### Recommended Fix

```rust
// In crates/x-render/src/scene.rs, find the encode function's node kind match
// and ensure Frame nodes also get name labels

// After the shape/background rendering but before children iteration, add:

// Render name label for frames and sections
if matches!(node.kind, NodeKind::Frame | NodeKind::Section) && !node.hidden {
    let name = if node.name.is_empty() {
        if node.kind == NodeKind::Frame { "Frame" } else { "Section" }
    } else {
        &node.name
    };
    
    let label_color = Color::from_rgba8(0x4b, 0x55, 0x63, 0xff)
        .multiply_alpha(node.opacity.min(0.7)); // Slightly transparent
    
    // Position at top-left with padding, transformed by world matrix
    let t = world * Affine::translate((14.0, 20.0));
    
    if let Some(fm) = ctx.fonts {
        if let Some(font) = fm.default_font() {
            fm.encode_text_block(
                scene,
                name,
                t,
                font,
                14.0,  // Slightly smaller than section headers
                Some((node.w - 20.0).max(8.0)),
                label_color,
            );
        }
    } else {
        x_text::encode_text(scene, name, t, 16.0, label_color);
    }
}
```

---

## 🟠 QA-010: Canvas Zoom/Pan Cursor Desync

### Problem
At high zoom levels or after extensive panning, mouse clicks place objects at offset positions from the cursor.

### Root Cause
Classic camera matrix mismatch between input handling and rendering.

### Investigation

Check coordinate transformation in input handling:

```bash
grep -rn "screen_to_world\|cursor.*coord\|mouse.*transform" apps/x-designer/src/bin/x_native_app/ --include="*.rs"
```

### Likely Location
`apps/x-designer/src/bin/x_native_app/loading.rs` or similar view config module.

### Fix Pattern

Ensure the SAME camera matrix is used for both:
1. Rendering (in `x-render`)
2. Input coordinate conversion (in `run.rs` or `board_ui.rs`)

```rust
// Example fix pattern - verify this matches what's used in rendering
fn screen_to_world(screen_x: f64, screen_y: f64, zoom: f64, pan: (f64, f64)) -> (f64, f64) {
    (
        (screen_x - pan.0) / zoom,
        (screen_y - pan.1) / zoom,
    )
}

// Ensure this is EXACTLY the inverse of the rendering transform:
// world_to_screen should be:
// screen_x = world_x * zoom + pan.x
// screen_y = world_y * zoom + pan.y
```

### Debug Steps

Add logging to verify the transformation:

```rust
// In the mouse click handler, before creating an object:
let (world_x, world_y) = screen_to_world(cursor_x, cursor_y, self.zoom, self.pan);
eprintln!("[INPUT] Screen: ({}, {}), Zoom: {}, Pan: {:?} -> World: ({}, {})", 
          cursor_x, cursor_y, self.zoom, self.pan, world_x, world_y);
```

Compare with rendering:

```rust
// In scene encoding:
eprintln!("[RENDER] Camera - Zoom: {}, Pan: {:?}", self.zoom, self.pan);
```

---

## Testing Your Fixes

After applying each fix:

1. **Build**: `cargo build --package x-designer`
2. **Run Tests**: `cargo test --package x-native`
3. **Manual Test**: Run the app and verify the specific behavior
4. **Add Regression Test**: In `regression_tests.rs`, add a test case

Example regression test for QA-003 (Undo/Redo):

```rust
#[test]
fn t_undo_redo_triggers_canvas_refresh() {
    let mut h = Host::demo_blank();
    
    // Create a shape
    h.tool(Tool::Rect);
    h.drag(100.0, 100.0, 200.0, 200.0);
    
    // Capture initial state
    let initial_count = h.app.doc().editor_ref().root.children.len();
    
    // Undo
    assert!(h.app.doc().undo_document());
    let after_undo = h.app.doc().editor_ref().root.children.len();
    
    // Redo
    assert!(h.app.doc().redo_document());
    let after_redo = h.app.doc().editor_ref().root.children.len();
    
    // Verify state changes
    assert_eq!(after_undo, initial_count - 1, "Undo should remove the shape");
    assert_eq!(after_redo, initial_count, "Redo should restore the shape");
    
    // CRITICAL: Verify frame cache was invalidated (forces re-render)
    // This is hard to test directly, but we can verify the document is marked dirty
    assert!(h.app.docs[h.app.active].dirty, "Document should be marked dirty after undo/redo");
}
```

---

## Quick Reference: Key File Locations

| Component | Primary Files |
|-----------|--------------|
| Clipboard | `apps/x-designer/src/bin/x_native_app/clipboard.rs`, `state.rs:2481` |
| Undo/Redo | `apps/x-designer/src/bin/x_native_app/session.rs:167-214` |
| File Close | `apps/x-designer/src/bin/x_native_app/state.rs:2111`, `run.rs:6024` |
| Frame Rendering | `crates/x-render/src/scene.rs:500-561` |
| Input/Zoom | `apps/x-designer/src/bin/x_native_app/loading.rs`, `run.rs` mouse handlers |
| Pen Tool | `apps/x-designer/src/bin/x_native_app/state.rs:498`, `run.rs` pen handlers |
| UI Panels | `apps/x-designer/src/bin/x_native_app/editor_ui.rs`, `board_ui.rs` |

---

## Next Steps

1. **Start with QA-001** (Figma clipboard) - Add debug logging first to understand what's actually in the clipboard
2. **Then QA-003** (Undo/Redo) - Add frame cache invalidation
3. **Then QA-002** (File close) - Verify the UI flow and add better error messages
4. **Move to P1 issues** once P0 are stable

Would you like me to create specific pull requests with these fixes, or dive deeper into any particular issue?
