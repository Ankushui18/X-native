# Color, Gradients, and Images - Gap Analysis

## Executive Summary

This document analyzes the gap between Figma's color, gradient, and image capabilities and X-Native's current implementation, based on the [Figma "Color, gradients, and images" documentation](https://help.figma.com/hc/en-us/sections/360006798733-Color-gradients-and-images).

## Current X-Native Implementation

### ✅ What's Already Implemented

1. **Solid Colors**
   - Basic color fills with RGBA support
   - OKLab color space support for perceptual gradients
   - Variable-bound colors

2. **Gradients (Partial)**
   - ✅ Linear gradients with color stops
   - ✅ Radial gradients with color stops
   - ✅ OKLab interpolation for perceptual gradients
   - ❌ Angular gradients
   - ❌ Diamond gradients

3. **Pattern/Image Fills**
   - ✅ Pattern fills referencing canvas objects
   - ✅ Image fills with asset references
   - ✅ Image fit modes (Fill, Fit, Crop, Tile)
   - ❌ Video fills (paid plan feature)

4. **Blend Modes (16/20)**
   - ✅ Normal
   - ✅ Darken
   - ✅ Multiply
   - ✅ ColorBurn
   - ✅ Lighten
   - ✅ Screen
   - ✅ ColorDodge
   - ✅ Overlay
   - ✅ SoftLight
   - ✅ HardLight
   - ✅ Difference
   - ✅ Exclusion
   - ✅ Hue
   - ✅ Saturation
   - ✅ Color
   - ✅ Luminosity
   - ❌ PlusDarker
   - ❌ PlusLighter
   - ❌ PassThrough (for groups/frames)

5. **Multiple Fill Layers**
   - ✅ Ordered fill layers with opacity
   - ✅ Visibility toggles
   - ✅ Blend modes per layer

## ❌ Missing Features (Gap Analysis)

### Phase 1: Advanced Gradients (Critical)

#### 1. Angular Gradients
**Figma Feature**: Conic/angular gradients that rotate around a center point
**Status**: ❌ NOT IMPLEMENTED
**Requirements**:
- Gradient rotates clockwise from starting position
- Adjustable color stop positions
- Center point can be moved
- Rotation angle adjustable

**Implementation Plan**:
```rust
// Add to Paint enum in paint.rs
AngularGradient {
    center: (f64, f64),
    start_angle: f64,  // in degrees or radians
    end_angle: f64,
    stops: Vec<(f32, Color)>,
    space: GradSpace,
}

// Rendering implementation needed in renderer
fn render_angular_gradient(node: &Node, gradient: &AngularGradient) {
    // Convert to conic gradient for rendering
    // Handle rotation and center offset
}
```

**Files to Modify**:
- `crates/x-core/src/paint.rs` - Add AngularGradient variant
- `crates/x-render/src/lib.rs` - Add rendering logic
- `apps/x-designer/src/bin/x_native_app/editor_ui.rs` - Add UI controls

---

#### 2. Diamond Gradients
**Figma Feature**: Diamond-shaped gradient with four points from center
**Status**: ❌ NOT IMPLEMENTED
**Requirements**:
- Gradient starts at center and expands in diamond shape
- Adjustable width and height independently
- Color stops along the diamond expansion

**Implementation Plan**:
```rust
// Add to Paint enum
DiamondGradient {
    center: (f64, f64),
    width: f64,
    height: f64,
    stops: Vec<(f32, Color)>,
    space: GradSpace,
}

// Rendering needs custom shader or approximation
fn render_diamond_gradient(node: &Node, gradient: &DiamondGradient) {
    // Calculate diamond shape based on width/height
    // Render gradient along diamond edges
}
```

---

#### 3. Gradient Controls
**Figma Feature**: Interactive gradient manipulation
**Status**: ⚠️ PARTIALLY IMPLEMENTED
**Missing**:
- ❌ Flip gradient (reverse color stops)
- ❌ Rotate gradient (change angle)
- ❌ Interactive stop dragging
- ❌ Stop position adjustment UI

**Implementation Plan**:
```rust
// Add gradient manipulation methods
pub fn flip_gradient(&mut self, node_id: &str, layer_idx: usize) {
    // Reverse the stops vector
}

pub fn rotate_gradient(&mut self, node_id: &str, layer_idx: usize, angle: f64) {
    // Update gradient angle/transform
}

pub fn move_gradient_stop(&mut self, node_id: &str, layer_idx: usize, stop_idx: usize, position: f32) {
    // Update stop position
}
```

---

### Phase 2: Missing Blend Modes (High Priority)

#### 4. PlusDarker Blend Mode
**Figma Feature**: Stronger darken effect on mid-tones
**Status**: ❌ NOT IMPLEMENTED
**Formula**: `result = max(0, base + blend - 1)`

**Implementation Plan**:
```rust
// Add to BlendKind enum
PlusDarker,

// In BlendKind::mix()
BlendKind::PlusDarker => Some(Mix::PlusDarker),
```

**Note**: Vello/Peniko may not support this directly. May need custom shader.

---

#### 5. PlusLighter Blend Mode
**Figma Feature**: Stronger lighten effect on mid-tones
**Status**: ❌ NOT IMPLEMENTED
**Formula**: `result = min(1, base + blend)`

**Implementation Plan**:
```rust
// Add to BlendKind enum
PlusLighter,

// In BlendKind::mix()
BlendKind::PlusLighter => Some(Mix::PlusLighter),
```

---

#### 6. PassThrough Blend Mode
**Figma Feature**: Allows child blend modes to interact with content below parent
**Status**: ❌ NOT IMPLEMENTED
**Requirements**:
- Special blend mode for groups/frames
- Enables child layers to blend with content below parent
- Default for parent layers

**Implementation Plan**:
```rust
// Add to BlendKind enum
PassThrough,

// Special handling in renderer
fn render_group(node: &Node, blend: BlendKind) {
    if blend == BlendKind::PassThrough {
        // Don't isolate the group
        // Allow children to blend with content below
    } else {
        // Isolate the group
    }
}
```

---

### Phase 3: Image Adjustments (Medium Priority)

#### 7. Image Adjustment Filters
**Figma Feature**: Non-destructive image adjustments
**Status**: ❌ NOT IMPLEMENTED
**Requirements**:
- Exposure (-100 to +100)
- Contrast (-100 to +100)
- Saturation (-100 to +100)
- Temperature (-100 to +100)
- Tint (-100 to +100)
- Highlights (-100 to +100)
- Shadows (-100 to +100)

**Implementation Plan**:
```rust
// Add to Node struct or PaintLayer
pub struct ImageAdjustments {
    pub exposure: f32,      // -1.0 to 1.0
    pub contrast: f32,      // -1.0 to 1.0
    pub saturation: f32,    // -1.0 to 1.0
    pub temperature: f32,   // -1.0 to 1.0
    pub tint: f32,          // -1.0 to 1.0
    pub highlights: f32,    // -1.0 to 1.0
    pub shadows: f32,       // -1.0 to 1.0
}

// Apply adjustments in renderer
fn apply_image_adjustments(image: &Image, adjustments: &ImageAdjustments) -> ProcessedImage {
    // Apply each adjustment in order
    // Use GPU shaders for performance
}
```

**Files to Modify**:
- `crates/x-core/src/node.rs` - Add ImageAdjustments struct
- `crates/x-render/src/lib.rs` - Add adjustment rendering
- `apps/x-designer/src/bin/x_native_app/editor_ui.rs` - Add adjustment UI

---

#### 8. Image Rotation
**Figma Feature**: Rotate image fill in 90° increments
**Status**: ❌ NOT IMPLEMENTED
**Requirements**:
- Rotate image 90°, 180°, 270°
- Independent of layer rotation
- Non-destructive

**Implementation Plan**:
```rust
// Add to PaintLayer or ImagePlacement
pub rotation: f64,  // 0, 90, 180, 270

// Apply rotation in renderer
fn render_image_with_rotation(image: &Image, rotation: f64) {
    // Apply rotation transform before rendering
}
```

---

### Phase 4: Advanced Color Tools (Medium Priority)

#### 9. Eyedropper Tool
**Figma Feature**: Sample colors from canvas
**Status**: ❌ NOT IMPLEMENTED
**Requirements**:
- Click to sample color from any pixel on canvas
- Works with fills, strokes, and effects
- Samples from rendered output (includes blend modes, effects)

**Implementation Plan**:
```rust
// Add Tool variant
pub enum Tool {
    // ... existing tools
    Eyedropper,
}

// Implement sampling
fn sample_color_at_point(scene: &Scene, point: Point) -> Color {
    // Read pixel from rendered scene
    // Convert from device coordinates to color
}
```

**Keyboard Shortcut**: I (standard eyedropper shortcut)

---

#### 10. Mixed Selection Color Viewing
**Figma Feature**: View and adjust colors in mixed selections
**Status**: ❌ NOT IMPLEMENTED
**Requirements**:
- Show common colors when multiple objects selected
- Allow editing colors that apply to all selected objects
- Show "Mixed" when colors differ

**Implementation Plan**:
```rust
// In inspector UI
fn render_color_panel(selection: &[Node]) {
    let fills = collect_fills(selection);
    
    if all_same(&fills) {
        // Show single color editor
    } else {
        // Show "Mixed" indicator
        // Allow editing common properties
    }
}
```

---

### Phase 5: Video Support (Low Priority - Paid Feature)

#### 11. Video Fills
**Figma Feature**: Animated video/GIF fills
**Status**: ❌ NOT IMPLEMENTED
**Requirements**:
- Support video file formats (MP4, WebM, GIF)
- Playback controls (play, pause, loop)
- Video as fill or stroke
- Paid plan feature

**Implementation Plan**:
```rust
// Add to Paint enum
Video {
    asset: String,
    fit: ImageFit,
    autoplay: bool,
    loop_video: bool,
}

// Video playback system needed
struct VideoPlayer {
    // Video decoding and playback logic
}
```

**Note**: Complex feature requiring video decoding library (e.g., ffmpeg, gstreamer)

---

## Implementation Priority & Timeline

### Phase 1: Advanced Gradients (1 week)
1. Angular gradients
2. Diamond gradients
3. Gradient controls (flip, rotate)

### Phase 2: Missing Blend Modes (3 days)
4. PlusDarker blend mode
5. PlusLighter blend mode
6. PassThrough blend mode

### Phase 3: Image Adjustments (1 week)
7. Image adjustment filters (7 adjustments)
8. Image rotation

### Phase 4: Advanced Color Tools (1 week)
9. Eyedropper tool
10. Mixed selection color viewing

### Phase 5: Video Support (2-3 weeks)
11. Video fills (complex, requires video library)

**Total Estimated Time**: 5-6 weeks

---

## Keyboard Shortcuts Reference

| Shortcut | Action | Figma | X-Native Status |
|----------|--------|-------|-----------------|
| I | Eyedropper tool | ✅ | ❌ Missing |
| (None) | Flip gradient | ✅ | ❌ Missing |
| (None) | Rotate gradient | ✅ | ❌ Missing |

---

## Technical Considerations

### Performance
- Angular/diamond gradients need efficient GPU rendering
- Image adjustments should use GPU shaders (not CPU)
- Video playback requires hardware acceleration
- Blend modes already GPU-accelerated via Vello

### Rendering
- Angular gradients: Use conic gradient shader
- Diamond gradients: Custom shader or mesh approximation
- Image adjustments: GPU fragment shaders
- Video: Hardware video decoder + texture upload

### Data Model
- Gradients already support color stops
- Need to add angle/transform fields
- Image adjustments need storage per layer
- Video needs playback state

### User Experience
- Gradient editor needs interactive controls
- Image adjustment sliders with preview
- Eyedropper needs visual feedback
- Mixed selection needs clear UI

---

## Testing Strategy

1. **Unit Tests**
   - Gradient calculations
   - Blend mode math
   - Image adjustment algorithms

2. **Visual Tests**
   - Gradient rendering accuracy
   - Blend mode correctness
   - Image adjustment effects

3. **Performance Tests**
   - Gradient rendering speed
   - Image adjustment performance
   - Video playback smoothness

4. **Integration Tests**
   - Gradient editing workflow
   - Image adjustment workflow
   - Eyedropper sampling

---

## References

- [Figma Guide to Fills](https://help.figma.com/hc/en-us/articles/360041003694-Guide-to-fills)
- [Figma Gradients](https://help.figma.com/hc/en-us/articles/34208860210199-Use-gradients-as-a-fill-or-stroke)
- [Figma Blend Modes](https://help.figma.com/hc/en-us/articles/360040667874-Apply-blend-modes-to-layers-fills-and-effects)
- [Figma Image Properties](https://help.figma.com/hc/en-us/articles/360041098433-Adjust-the-properties-of-an-image)
- [Figma Eyedropper](https://help.figma.com/hc/en-us/articles/27643269375767-Sample-colors-with-the-eyedropper-tool)

---

## Summary

X-Native has a solid foundation for color, gradients, and images with:
- ✅ Solid colors with OKLab support
- ✅ Linear and radial gradients
- ✅ Pattern/image fills
- ✅ 16 blend modes (80% of Figma's set)
- ✅ Multiple fill layers

Missing critical features:
- ❌ Angular and diamond gradients
- ❌ 3 blend modes (PlusDarker, PlusLighter, PassThrough)
- ❌ Image adjustments (7 filters)
- ❌ Eyedropper tool
- ❌ Video fills

**Recommended Next Steps**:
1. Implement angular and diamond gradients (Phase 1)
2. Add missing blend modes (Phase 2)
3. Implement image adjustments (Phase 3)
4. Add eyedropper tool (Phase 4)
5. Consider video support (Phase 5 - complex)

This will bring X-Native to full feature parity with Figma's color, gradient, and image capabilities.
