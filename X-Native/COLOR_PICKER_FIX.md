# Color Picker & UI Improvements for X-Native

## Issue Summary
The fill and stroke color pickers in X-Native don't have popup dialogs like open-pencil. Users can only edit hex/alpha values directly without a visual color picker interface.

## Reference: open-pencil Implementation

### Key Features from open-pencil:
1. **FillPicker.vue** - Complete fill type selector (Solid/Gradient/Image)
2. **ColorPickerPanel.vue** - Visual color picker with:
   - Saturation/brightness area
   - Hue slider
   - Alpha slider
   - RGB/HSB/OKHCL input fields
3. **PaintField.vue** - Unified paint control with opacity
4. **StrokeSection.vue** - Advanced stroke controls (dash, caps, joins)

## Implementation Plan for X-Native

### Phase 1: Color Picker Popup (P0 - Critical)

#### 1.1 Add Color Picker State to App Struct
**File**: `apps/x-designer/src/bin/x_native_app/state.rs`

```rust
// Already added in previous step:
pub color_picker_popup: Option<(bool, Rect, bool)>,  // (is_fill, field_rect, is_open)
```

#### 1.2 Add Color Picker Actions
**File**: `apps/x-designer/src/bin/x_native_app/state.rs`

```rust
// Already added:
pub enum Action {
    // ...
    ToggleColorPicker(bool),  // true=fill, false=stroke
    CloseColorPicker,
    // ...
}
```

#### 1.3 Create Color Picker Module
**File**: `apps/x-designer/src/bin/x_native_app/color_picker.rs` (NEW)

```rust
//! Color picker popup - inspired by open-pencil's FillPicker & ColorPickerPanel

use vello::kurbo::{Rect, Point};
use vello::peniko::Color;
use crate::state::App;
use crate::paint::Scene;
use crate::theme::*;

/// Color picker state
#[derive(Clone, Debug)]
pub struct ColorPickerState {
    pub is_fill: bool,
    pub anchor_rect: Rect,
    pub hue: f64,           // 0-360
    pub saturation: f64,    // 0-100
    pub brightness: f64,    // 0-100
    pub alpha: f64,         // 0-100
    pub rgb: (u8, u8, u8),
    pub hex: String,
}

impl ColorPickerState {
    pub fn from_color(color: Color, is_fill: bool, anchor: Rect) -> Self {
        let (h, s, b) = rgb_to_hsb(color.r, color.g, color.b);
        let hex = format!("{:02x}{:02x}{:02x}", color.r, color.g, color.b);
        
        Self {
            is_fill,
            anchor_rect: anchor,
            hue: h,
            saturation: s,
            brightness: b,
            alpha: (color.a * 100.0).round(),
            rgb: (color.r, color.g, color.b),
            hex,
        }
    }
    
    pub fn to_color(&self) -> Color {
        let (r, g, b) = hsb_to_rgb(self.hue, self.saturation, self.brightness);
        Color::from_rgba8(r, g, b, (self.alpha / 100.0) as f32)
    }
    
    pub fn update_hex(&mut self) {
        self.hex = format!("{:02x}{:02x}{:02x}", self.rgb.0, self.rgb.1, self.rgb.2);
    }
}

/// Convert RGB to HSB
fn rgb_to_hsb(r: u8, g: u8, b: u8) -> (f64, f64, f64) {
    let r = r as f64 / 255.0;
    let g = g as f64 / 255.0;
    let b = b as f64 / 255.0;
    
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;
    
    let h = if delta == 0.0 {
        0.0
    } else if max == r {
        60.0 * (((g - b) / delta) % 6.0)
    } else if max == g {
        60.0 * (((b - r) / delta) + 2.0)
    } else {
        60.0 * (((r - g) / delta) + 4.0)
    };
    
    let s = if max == 0.0 { 0.0 } else { delta / max };
    let b = max;
    
    (h.max(0.0), s * 100.0, b * 100.0)
}

/// Convert HSB to RGB
fn hsb_to_rgb(h: f64, s: f64, b: f64) -> (u8, u8, u8) {
    let h = h / 60.0;
    let s = s / 100.0;
    let b = b / 100.0;
    
    let i = h.floor() as i32 % 6;
    let f = h - h.floor();
    let p = b * (1.0 - s);
    let q = b * (1.0 - s * f);
    let t = b * (1.0 - s * (1.0 - f));
    
    let (r, g, b) = match i {
        0 => (b, t, p),
        1 => (q, b, p),
        2 => (p, b, t),
        3 => (p, q, b),
        4 => (t, p, b),
        _ => (b, p, q),
    };
    
    ((r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8)
}

/// Render the color picker popup
pub fn render_color_picker(app: &mut App, s: &mut Scene, picker: &ColorPickerState) {
    let anchor = picker.anchor_rect;
    
    // Position picker to the left of the field
    let popup_w = 280.0;
    let popup_h = 320.0;
    let popup_x = (anchor.x0 - popup_w - 8.0).max(8.0);
    let popup_y = anchor.y0.max(8.0);
    let popup_rect = Rect::new(popup_x, popup_y, popup_x + popup_w, popup_y + popup_h);
    
    // Background with shadow
    drop_shadow(s, popup_rect, 16.0);
    fill_rrect(s, popup_rect, 8.0, C_FIELD);
    stroke_rrect(s, popup_rect, 8.0, C_LINE_2, 1.0);
    
    let px = popup_x + 12.0;
    let mut py = popup_y + 12.0;
    
    // Color preview (large swatch at top)
    let preview_h = 80.0;
    let preview_rect = Rect::new(px, py, px + popup_w - 24.0, py + preview_h);
    fill_rrect(s, preview_rect, 6.0, picker.to_color());
    stroke_rrect(s, preview_rect, 6.0, C_LINE, 1.0);
    py += preview_h + 16.0;
    
    // Hue slider
    py = render_hue_slider(s, picker, px, py, popup_w - 24.0);
    py += 8.0;
    
    // Saturation/Brightness area
    py = render_sb_area(s, picker, px, py, popup_w - 24.0);
    py += 8.0;
    
    // Alpha slider
    py = render_alpha_slider(s, picker, px, py, popup_w - 24.0);
    py += 16.0;
    
    // RGB inputs
    py = render_rgb_inputs(app, s, picker, px, py, popup_w - 24.0);
    py += 8.0;
    
    // Hex input
    py = render_hex_input(app, s, picker, px, py, popup_w - 24.0);
}

fn render_hue_slider(s: &mut Scene, picker: &ColorPickerState, x: f64, y: f64, w: f64) -> f64 {
    let h = 16.0;
    let rect = Rect::new(x, y, x + w, y + h);
    
    // Draw hue gradient
    let segments = 6;
    for i in 0..segments {
        let seg_x = x + (i as f64) * (w / segments as f64);
        let seg_w = w / segments as f64;
        let hue_start = (i as f64) * 60.0;
        let hue_end = hue_start + 60.0;
        let (r1, g1, b1) = hsb_to_rgb(hue_start, picker.saturation, picker.brightness);
        let (r2, g2, b2) = hsb_to_rgb(hue_end, picker.saturation, picker.brightness);
        // Simplified: use solid colors per segment
        let color = Color::from_rgb8(r1, g1, b1);
        fill_rect(s, Rect::new(seg_x, y, seg_x + seg_w + 1.0, y + h), color);
    }
    
    // Current hue indicator
    let marker_x = x + (picker.hue / 360.0) * w;
    fill_circle(s, marker_x, y + h / 2.0, 10.0, VelloColor::WHITE);
    stroke_circle(s, marker_x, y + h / 2.0, 10.0, C_LINE, 2.0);
    
    y + h
}

fn render_sb_area(s: &mut Scene, picker: &ColorPickerState, x: f64, y: f64, w: f64) -> f64 {
    let h = 120.0;
    let rect = Rect::new(x, y, x + w, y + h);
    
    // Draw saturation/brightness gradient
    // White to color (horizontal), color to black (vertical)
    fill_rrect(s, rect, 4.0, Color::from_rgb8(
        picker.rgb.0,
        picker.rgb.1,
        picker.rgb.2
    ));
    stroke_rrect(s, rect, 4.0, C_LINE, 1.0);
    
    // Marker position
    let marker_x = x + (picker.saturation / 100.0) * w;
    let marker_y = y + h - (picker.brightness / 100.0) * h;
    
    fill_circle(s, marker_x, marker_y, 8.0, VelloColor::WHITE);
    stroke_circle(s, marker_x, marker_y, 8.0, C_LINE, 2.0);
    
    y + h
}

fn render_alpha_slider(s: &mut Scene, picker: &ColorPickerState, x: f64, y: f64, w: f64) -> f64 {
    let h = 16.0;
    let rect = Rect::new(x, y, x + w, y + h);
    
    // Checkerboard background
    draw_checkerboard(s, rect, 8.0);
    
    // Alpha gradient overlay
    let color = picker.to_color();
    fill_rrect(s, rect, 4.0, color);
    
    // Marker
    let marker_x = x + (picker.alpha / 100.0) * w;
    stroke_circle(s, marker_x, y + h / 2.0, 10.0, C_LINE_2, 2.0);
    
    y + h
}

fn render_rgb_inputs(app: &mut App, s: &mut Scene, picker: &ColorPickerState, x: f64, y: f64, w: f64) -> f64 {
    let h = 24.0;
    let label_w = 20.0;
    let input_w = (w - label_w * 3.0 - 8.0 * 2.0) / 3.0;
    
    // R
    app.fonts.text(s, x, y + 17.0, "R", T10, C_TEXT, Wt::Reg);
    let r_rect = Rect::new(x + label_w, y, x + label_w + input_w, y + h);
    fill_rrect(s, r_rect, 4.0, C_FIELD_2);
    let r_str = format!("{}", picker.rgb.0);
    app.fonts.text(s, r_rect.x0 + 6.0, y + 17.0, &r_str, T10, C_TEXT, Wt::Mono);
    
    // G
    let gx = x + label_w + input_w + 8.0;
    app.fonts.text(s, gx, y + 17.0, "G", T10, C_TEXT, Wt::Reg);
    let g_rect = Rect::new(gx + label_w, y, gx + label_w + input_w, y + h);
    fill_rrect(s, g_rect, 4.0, C_FIELD_2);
    let g_str = format!("{}", picker.rgb.1);
    app.fonts.text(s, g_rect.x0 + 6.0, y + 17.0, &g_str, T10, C_TEXT, Wt::Mono);
    
    // B
    let bx = gx + label_w + input_w + 8.0;
    app.fonts.text(s, bx, y + 17.0, "B", T10, C_TEXT, Wt::Reg);
    let b_rect = Rect::new(bx + label_w, y, bx + label_w + input_w, y + h);
    fill_rrect(s, b_rect, 4.0, C_FIELD_2);
    let b_str = format!("{}", picker.rgb.2);
    app.fonts.text(s, b_rect.x0 + 6.0, y + 17.0, &b_str, T10, C_TEXT, Wt::Mono);
    
    y + h
}

fn render_hex_input(app: &mut App, s: &mut Scene, picker: &ColorPickerState, x: f64, y: f64, w: f64) -> f64 {
    let h = 28.0;
    let rect = Rect::new(x, y, x + w, y + h);
    
    fill_rrect(s, rect, 6.0, C_FIELD_2);
    stroke_rrect(s, rect, 6.0, C_LINE, 1.0);
    
    // Swatch
    let swatch = Rect::new(x + 6.0, y + 7.0, x + 20.0, y + 21.0);
    fill_rrect(s, swatch, 3.0, picker.to_color());
    
    // Hex value
    app.fonts.text(s, swatch.x1 + 8.0, y + 19.0, &format!("#{}", picker.hex.to_uppercase()), T11, C_TEXT, Wt::Mono);
    
    y + h
}

fn draw_checkerboard(s: &mut Scene, rect: Rect, size: f64) {
    let cols = (rect.width() / size).ceil() as usize;
    let rows = (rect.height() / size).ceil() as usize;
    
    for row in 0..rows {
        for col in 0..cols {
            let x = rect.x0 + col as f64 * size;
            let y = rect.y0 + row as f64 * size;
            let is_light = (row + col) % 2 == 0;
            let color = if is_light { 
                Color::from_rgb8(240, 240, 240) 
            } else { 
                Color::from_rgb8(200, 200, 200) 
            };
            fill_rect(s, Rect::new(x, y, x + size, y + size), color);
        }
    }
}

fn fill_circle(s: &mut Scene, x: f64, y: f64, r: f64, color: Color) {
    use vello::kurbo::Circle;
    use vello::peniko::Fill;
    let circle = Circle::new((x, y), r);
    s.fill(Fill::NonZero, vello::Affine::IDENTITY, color, None, &circle);
}

fn stroke_circle(s: &mut Scene, x: f64, y: f64, r: f64, color: Color, width: f64) {
    use vello::kurbo::{Circle, Stroke};
    let circle = Circle::new((x, y), r);
    s.stroke(&Stroke::new(width), vello::Affine::IDENTITY, color, None, &circle);
}

fn drop_shadow(s: &mut Scene, rect: Rect, blur: f64) {
    // Simplified drop shadow - in production use proper blur
    let shadow_rect = Rect::new(rect.x0 + 2.0, rect.y0 + 4.0, rect.x1 + 2.0, rect.y1 + 4.0);
    let shadow_color = Color::from_rgba8(0, 0, 0, 0.15);
    fill_rrect(s, shadow_rect, rect.radii().top_left + 2.0, shadow_color);
}
```

### Phase 2: Integrate Color Picker into Editor UI

#### 2.1 Update Paint Row to Trigger Picker
**File**: `apps/x-designer/src/bin/x_native_app/editor_ui.rs`

In `paint_paint_row()` function, make the swatch clickable:

```rust
// Around line 2877-2882, change from:
fill_rrect(s, sw, 3.0, color);
if !is_fill {
    stroke_rrect(s, sw, 3.0, C_LINE_2, 1.0);
}

// To:
let swatch hov = hover(app, sw);
fill_rrect(s, sw, 3.0, color);
if !is_fill {
    stroke_rrect(s, sw, 3.0, C_LINE_2, 1.0);
}
if hov {
    stroke_rrect(s, sw, 3.0, C_ACCENT, 2.0);
}
hit.push((sw, Action::ToggleColorPicker(is_fill)));
```

#### 2.2 Handle Color Picker Actions
**File**: `apps/x-designer/src/bin/x_native_app/run.rs` or wherever actions are handled

Add handler for `Action::ToggleColorPicker`:

```rust
Action::ToggleColorPicker(is_fill) => {
    // Get the current fill/stroke color from selected node
    if let Some(doc) = app.docs.get_mut(app.active) {
        if let Some(editor) = doc.doc.active_editor() {
            let selection = editor.selected_nodes();
            if let Some(node_id) = selection.first() {
                if let Some(node) = editor.doc().get_node(node_id) {
                    let color = if is_fill {
                        node.fills.first().map(|f| f.color).unwrap_or(Color::WHITE)
                    } else {
                        node.strokes.first().map(|s| s.color).unwrap_or(Color::BLACK)
                    };
                    
                    // Get the field rect from the UI
                    let field_rect = get_field_rect_for_color(app, is_fill);
                    
                    app.color_picker_popup = Some((
                        is_fill,
                        field_rect.unwrap_or(Rect::new(300.0, 100.0, 400.0, 200.0)),
                        true
                    ));
                }
            }
        }
    }
}

Action::CloseColorPicker => {
    app.color_picker_popup = None;
}
```

#### 2.3 Render Color Picker Popup
**File**: `apps/x-designer/src/bin/x_native_app/editor_ui.rs`

At the end of the `paint()` function, after all other UI rendering:

```rust
// Render color picker popup if open
if let Some((is_fill, anchor, is_open)) = &app.color_picker_popup {
    if *is_open {
        // Get current color
        let color = get_current_color(app, *is_fill);
        let picker_state = ColorPickerState::from_color(color, *is_fill, *anchor);
        crate::color_picker::render_color_picker(app, s, &picker_state);
    }
}
```

### Phase 3: Additional UI Improvements from open-pencil

#### 3.1 Fill Type Selector (Solid/Gradient/Image)
Add tabs at top of color picker like open-pencil's FillPicker.vue:
- Solid color (current implementation)
- Linear gradient (future)
- Radial gradient (future)
- Image fill (future)

#### 3.2 Advanced Stroke Controls
Like open-pencil's StrokeSection.vue:
- Stroke alignment (Inside/Center/Outside)
- Dash pattern editor
- Cap style (Round/Square/Projecting)
- Join style (Round/Miter/Bevel)
- Individual side weights

#### 3.3 Variable Bindings
Like open-pencil's VariableBindingPicker:
- Bind colors to design tokens
- Detach variables
- Create new color variables

### Testing Checklist

- [ ] Click fill swatch opens color picker
- [ ] Click stroke swatch opens color picker
- [ ] Color picker positioned correctly relative to field
- [ ] Changing hue updates color preview
- [ ] Changing saturation/brightness updates color
- [ ] Changing alpha updates transparency
- [ ] RGB inputs update color
- [ ] Hex input updates color
- [ ] Click outside closes picker
- [ ] Escape key closes picker
- [ ] Color changes apply to selected node
- [ ] Works for both fill and stroke
- [ ] Multiple selection shows mixed state

## File Structure

```
apps/x-designer/src/bin/x_native_app/
├── state.rs              # App struct with color_picker_popup field
├── editor_ui.rs          # Paint row click handlers + popup rendering
├── run.rs                # Action handlers for ToggleColorPicker
└── color_picker.rs       # NEW: Color picker module
```

## Next Steps

1. **Immediate (Week 1)**: Implement basic color picker popup (Phase 1-2)
2. **Short-term (Week 2)**: Add gradient support and advanced stroke controls
3. **Medium-term (Week 3-4)**: Add variable bindings and design tokens
4. **Long-term**: Match open-pencil's full feature set including image fills

## References

- open-pencil FillPicker: `/src/components/fill-picker/FillPicker.vue`
- open-pencil ColorPickerPanel: `/src/components/color-picker-panel/ColorPickerPanel.vue`
- open-pencil StrokeSection: `/src/components/properties/stroke/StrokeSection.vue`
- open-pencil PaintField: `/src/components/properties/paint/PaintField.vue`
