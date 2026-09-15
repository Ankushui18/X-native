#[allow(unused_imports)]
use crate::*;
use kurbo::{Affine, Circle, Rect, RoundedRect, RoundedRectRadii, Shape};
use peniko::{Brush, Color, Fill, Gradient, Mix};
use std::collections::HashMap;

// -------------------------------------------------------------------- paint

/// Phase 4: gradients join solid and variable-bound paints.
/// Package 7: image patterns join them too (Sketch `fillType` 2). The
/// asset id is the content-addressed `asset://…` name shared with Image
/// nodes; `fit` reuses the image-placement vocabulary (Sketch's
/// patternFillType 0 Tile → Tile, 1 Fill → Fill, 2 Stretch → Fill
/// (approximated — proportional cover, no distortion)).
/// Interpolation space for multi-stop gradients (Sketch 2026.2
/// "perceptual gradients"). `Srgb` keeps legacy rendering byte-stable;
/// `Oklab` interpolates perceptually — renderers densify the stop list
/// in OKLab so the output is correct even on sRGB-lerping GPUs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum GradSpace {
    #[default]
    Srgb,
    Oklab,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Paint {
    Solid(Color),
    Variable(String),
    LinearGradient {
        start: (f64, f64),
        end: (f64, f64),
        stops: Vec<(f32, Color)>,
        space: GradSpace,
    },
    RadialGradient {
        center: (f64, f64),
        radius: f64,
        stops: Vec<(f32, Color)>,
        space: GradSpace,
    },
    /// Phase 6: Angular/Conic gradient - rotates around center point
    AngularGradient {
        center: (f64, f64),
        start_angle: f64,  // degrees, 0 = right, 90 = down
        end_angle: f64,    // degrees, typically start_angle + 360
        stops: Vec<(f32, Color)>,
        space: GradSpace,
    },
    /// Phase 6: Diamond gradient - expands in diamond shape from center
    DiamondGradient {
        center: (f64, f64),
        width: f64,        // horizontal radius
        height: f64,       // vertical radius
        stops: Vec<(f32, Color)>,
        space: GradSpace,
    },
    Pattern {
        asset: String,
        fit: ImageFit,
    },
}

impl Paint {
    /// Phase 6: Flip gradient - reverse the color stops
    pub fn flip(&mut self) {
        match self {
            Paint::LinearGradient { stops, .. } |
            Paint::RadialGradient { stops, .. } |
            Paint::AngularGradient { stops, .. } |
            Paint::DiamondGradient { stops, .. } => {
                // Reverse stops and adjust positions
                for (pos, _) in stops.iter_mut() {
                    *pos = 1.0 - *pos;
                }
                stops.reverse();
            }
            _ => {}
        }
    }

    /// Phase 6: Rotate gradient by angle (degrees)
    pub fn rotate(&mut self, angle: f64) {
        match self {
            Paint::LinearGradient { start, end, .. } => {
                // Rotate the gradient line around its center
                let cx = (start.0 + end.0) / 2.0;
                let cy = (start.1 + end.1) / 2.0;
                
                let rad = angle.to_radians();
                let cos = rad.cos();
                let sin = rad.sin();
                
                // Rotate start point
                let dx = start.0 - cx;
                let dy = start.1 - cy;
                start.0 = cx + dx * cos - dy * sin;
                start.1 = cy + dx * sin + dy * cos;
                
                // Rotate end point
                let dx = end.0 - cx;
                let dy = end.1 - cy;
                end.0 = cx + dx * cos - dy * sin;
                end.1 = cy + dx * sin + dy * cos;
            }
            Paint::AngularGradient { start_angle, end_angle, .. } => {
                // Rotate angular gradient
                *start_angle += angle;
                *end_angle += angle;
                // Normalize angles
                *start_angle = start_angle.rem_euclid(360.0);
                *end_angle = end_angle.rem_euclid(360.0);
            }
            _ => {}
        }
    }

    /// Phase 6: Add a color stop at position
    pub fn add_stop(&mut self, position: f32, color: Color) {
        match self {
            Paint::LinearGradient { stops, .. } |
            Paint::RadialGradient { stops, .. } |
            Paint::AngularGradient { stops, .. } |
            Paint::DiamondGradient { stops, .. } => {
                stops.push((position, color));
                // Sort by position
                stops.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            }
            _ => {}
        }
    }

    /// Phase 6: Remove a color stop at index
    pub fn remove_stop(&mut self, index: usize) {
        match self {
            Paint::LinearGradient { stops, .. }
            | Paint::RadialGradient { stops, .. }
            | Paint::AngularGradient { stops, .. }
            | Paint::DiamondGradient { stops, .. }
                if index < stops.len() && stops.len() > 2 =>
            {
                stops.remove(index);
            }
            _ => {}
        }
    }

    /// Phase 6: Move a color stop to new position
    pub fn move_stop(&mut self, index: usize, new_position: f32) {
        match self {
            Paint::LinearGradient { stops, .. }
            | Paint::RadialGradient { stops, .. }
            | Paint::AngularGradient { stops, .. }
            | Paint::DiamondGradient { stops, .. }
                if index < stops.len() =>
            {
                stops[index].0 = new_position.clamp(0.0, 1.0);
                // Re-sort
                stops.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            }
            _ => {}
        }
    }

    /// Phase 6: Check if this paint is a gradient
    pub fn is_gradient(&self) -> bool {
        matches!(self, 
            Paint::LinearGradient { .. } | 
            Paint::RadialGradient { .. } |
            Paint::AngularGradient { .. } |
            Paint::DiamondGradient { .. }
        )
    }

    /// Phase 6: Get gradient type name for UI
    pub fn gradient_type_name(&self) -> &'static str {
        match self {
            Paint::LinearGradient { .. } => "Linear",
            Paint::RadialGradient { .. } => "Radial",
            Paint::AngularGradient { .. } => "Angular",
            Paint::DiamondGradient { .. } => "Diamond",
            _ => "Solid",
        }
    }

    /// Phase 6: Create a linear gradient
    pub fn linear_gradient(
        start: (f64, f64),
        end: (f64, f64),
        stops: Vec<(f32, Color)>,
        space: GradSpace,
    ) -> Self {
        Paint::LinearGradient {
            start,
            end,
            stops,
            space,
        }
    }

    /// Phase 6: Create a radial gradient
    pub fn radial_gradient(
        center: (f64, f64),
        radius: f64,
        stops: Vec<(f32, Color)>,
        space: GradSpace,
    ) -> Self {
        Paint::RadialGradient {
            center,
            radius,
            stops,
            space,
        }
    }

    /// Phase 6: Create an angular (conic) gradient
    pub fn angular_gradient(
        center: (f64, f64),
        start_angle: f64,
        end_angle: f64,
        stops: Vec<(f32, Color)>,
        space: GradSpace,
    ) -> Self {
        Paint::AngularGradient {
            center,
            start_angle,
            end_angle,
            stops,
            space,
        }
    }

    /// Phase 6: Create a diamond gradient
    pub fn diamond_gradient(
        center: (f64, f64),
        width: f64,
        height: f64,
        stops: Vec<(f32, Color)>,
        space: GradSpace,
    ) -> Self {
        Paint::DiamondGradient {
            center,
            width,
            height,
            stops,
            space,
        }
    }
}

impl GradSpace {
    /// Stop list for a renderer: `Srgb` returns the authored stops
    /// unchanged; `Oklab` densifies each segment (16 steps) with
    /// perceptual interpolation, so an sRGB-lerping renderer still
    /// shows the intended ramp.
    pub fn stops_for_render<'a>(
        &self,
        stops: &'a [(f32, Color)],
    ) -> std::borrow::Cow<'a, [(f32, Color)]> {
        match self {
            GradSpace::Srgb => std::borrow::Cow::Borrowed(stops),
            GradSpace::Oklab => std::borrow::Cow::Owned(densify_oklab(stops, 16)),
        }
    }
}

/// sRGB u8 color -> OKLab (Björn Ottosson's reference matrices).
fn oklab_of(c: Color) -> [f64; 3] {
    let rgba = c.to_rgba8();
    let lin = |v: f64| {
        let v = v / 255.0;
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    };
    let (r, g, b) = (lin(rgba.r as f64), lin(rgba.g as f64), lin(rgba.b as f64));
    let l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    let m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    let s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    let (l_, m_, s_) = (l.cbrt(), m.cbrt(), s.cbrt());
    [
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    ]
}

/// OKLab -> sRGB u8 color (clamped to gamut).
fn color_of_oklab(lab: [f64; 3]) -> Color {
    let (l, a, b) = (lab[0], lab[1], lab[2]);
    let l_ = l + 0.3963377774 * a + 0.2158037573 * b;
    let m_ = l - 0.1055613458 * a - 0.0638541728 * b;
    let s_ = l - 0.0894841775 * a - 1.2914855480 * b;
    let (l, m, s) = (l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
    let r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    let b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    let delin = |v: f64| {
        let v = if v <= 0.0031308 {
            12.92 * v
        } else {
            1.055 * v.powf(1.0 / 2.4) - 0.055
        };
        (v.clamp(0.0, 1.0) * 255.0).round() as u8
    };
    Color::from_rgba8(delin(r), delin(g), delin(b), 255)
}

/// Densify a stop list with OKLab interpolation: `steps` samples per
/// segment, alpha lerped linearly, original stop positions preserved.
pub fn densify_oklab(stops: &[(f32, Color)], steps: usize) -> Vec<(f32, Color)> {
    if stops.len() < 2 || steps == 0 {
        return stops.to_vec();
    }
    let mut out = vec![stops[0]];
    for w in stops.windows(2) {
        let (t0, c0) = w[0];
        let (t1, c1) = w[1];
        let lab0 = oklab_of(c0);
        let lab1 = oklab_of(c1);
        let a0 = c0.to_rgba8().a as f64;
        let a1 = c1.to_rgba8().a as f64;
        for i in 1..=steps {
            let t = i as f64 / steps as f64;
            let pos = t0 as f64 + (t1 - t0) as f64 * t;
            let lab = [
                lab0[0] + (lab1[0] - lab0[0]) * t,
                lab0[1] + (lab1[1] - lab0[1]) * t,
                lab0[2] + (lab1[2] - lab0[2]) * t,
            ];
            let mut c = color_of_oklab(lab);
            let a = (a0 + (a1 - a0) * t).round() as u8;
            c = premultiply_keep_alpha(c, a);
            out.push((pos as f32, c));
        }
    }
    out
}

/// Replace a color's alpha channel.
fn premultiply_keep_alpha(c: Color, a: u8) -> Color {
    let rgba = c.to_rgba8();
    Color::from_rgba8(rgba.r, rgba.g, rgba.b, a)
}

/// One ordered fill entry. Layers are painted back-to-front in vector order.
#[derive(Debug, Clone, PartialEq)]
pub struct PaintLayer {
    pub paint: Paint,
    pub opacity: f32,
    pub visible: bool,
    pub blend: BlendKind,
}
impl PaintLayer {
    pub fn new(paint: Paint) -> Self {
        Self {
            paint,
            opacity: 1.0,
            visible: true,
            blend: BlendKind::Normal,
        }
    }
}

/// One ordered stroke entry. Geometry options can expand here without
/// changing the node or file schema again.
#[derive(Debug, Clone, PartialEq)]
pub struct StrokeLayer {
    pub stroke: Stroke,
    pub opacity: f32,
    pub visible: bool,
    pub blend: BlendKind,
    pub options: StrokeOptions,
}
impl StrokeLayer {
    pub fn new(stroke: Stroke) -> Self {
        Self {
            stroke,
            opacity: 1.0,
            visible: true,
            blend: BlendKind::Normal,
            options: StrokeOptions::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StrokeAlign {
    Inside,
    #[default]
    Center,
    Outside,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StrokeCap {
    #[default]
    None,
    Round,
    Square,
    Arrow,
    Triangle,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StrokeJoin {
    #[default]
    Miter,
    Bevel,
    Round,
}
#[derive(Debug, Clone, PartialEq)]
pub struct StrokeOptions {
    pub align: StrokeAlign,
    pub cap_start: StrokeCap,
    pub cap_end: StrokeCap,
    pub join: StrokeJoin,
    pub dash: Vec<f64>,
    pub dash_offset: f64,
    pub miter_limit: f64,
}
impl Default for StrokeOptions {
    fn default() -> Self {
        Self {
            align: StrokeAlign::Center,
            cap_start: StrokeCap::None,
            cap_end: StrokeCap::None,
            join: StrokeJoin::Miter,
            dash: vec![],
            dash_offset: 0.0,
            miter_limit: 4.0,
        }
    }
}

/// A stroke paint. Solid colors are the common case; gradients ride the
/// same `Paint` enum as fills so every importer/exporter/sink shares one
/// vocabulary (`Stroke::solid` keeps call sites terse).
#[derive(Debug, Clone, PartialEq)]
pub struct Stroke {
    pub paint: Paint,
    pub width: f64,
}
impl Default for Stroke {
    fn default() -> Self {
        Self {
            paint: Paint::Solid(Color::BLACK),
            width: 0.0,
        }
    }
}
impl Stroke {
    pub fn solid(color: Color, width: f64) -> Self {
        Self {
            paint: Paint::Solid(color),
            width,
        }
    }
    /// Solid color if this stroke is solid (UI color pickers); None for
    /// gradient strokes.
    pub fn solid_color(&self) -> Option<Color> {
        match &self.paint {
            Paint::Solid(c) => Some(*c),
            _ => None,
        }
    }
    /// UI edit: set a solid color, replacing any gradient.
    pub fn set_solid_color(&mut self, c: Color) {
        self.paint = Paint::Solid(c);
    }
}

/// Phase 4: blend modes. Applied as a Vello mix layer around the node.
/// Phase 6: Added PlusDarker, PlusLighter, and PassThrough for Figma parity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BlendKind {
    #[default]
    Normal,
    Darken,
    Multiply,
    ColorBurn,
    Lighten,
    Screen,
    ColorDodge,
    Overlay,
    SoftLight,
    HardLight,
    Difference,
    Exclusion,
    Hue,
    Saturation,
    Color,
    Luminosity,
    /// Phase 6: Stronger darken effect on mid-tones
    PlusDarker,
    /// Phase 6: Stronger lighten effect on mid-tones
    PlusLighter,
    /// Phase 6: Special mode for groups/frames - allows child blend modes
    /// to interact with content below parent layer
    PassThrough,
}
impl BlendKind {
    pub fn mix(self) -> Option<Mix> {
        match self {
            BlendKind::Normal => None,
            BlendKind::Multiply => Some(Mix::Multiply),
            BlendKind::Screen => Some(Mix::Screen),
            BlendKind::Overlay => Some(Mix::Overlay),
            BlendKind::Darken => Some(Mix::Darken),
            BlendKind::Lighten => Some(Mix::Lighten),
            BlendKind::ColorBurn => Some(Mix::ColorBurn),
            BlendKind::ColorDodge => Some(Mix::ColorDodge),
            BlendKind::SoftLight => Some(Mix::SoftLight),
            BlendKind::HardLight => Some(Mix::HardLight),
            BlendKind::Difference => Some(Mix::Difference),
            BlendKind::Exclusion => Some(Mix::Exclusion),
            BlendKind::Hue => Some(Mix::Hue),
            BlendKind::Saturation => Some(Mix::Saturation),
            BlendKind::Color => Some(Mix::Color),
            BlendKind::Luminosity => Some(Mix::Luminosity),
            // Phase 6: PlusDarker and PlusLighter use custom formulas
            // Vello/Peniko doesn't have direct support, so we return None
            // and handle them with custom shaders in the renderer
            BlendKind::PlusDarker => None,  // Custom: max(0, base + blend - 1)
            BlendKind::PlusLighter => None, // Custom: min(1, base + blend)
            BlendKind::PassThrough => None, // Special: handled by group rendering
        }
    }
}

/// Ordered layer effects. The renderer lowers these to normalized GPU-vector
/// Gaussian taps on the pinned Vello backend, including clipped background
/// replay for background blur and clipped edge compositing for inner shadow.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    DropShadow {
        dx: f64,
        dy: f64,
        blur: f64,
        color: Color,
    },
    InnerShadow {
        dx: f64,
        dy: f64,
        blur: f64,
        color: Color,
    },
    LayerBlur {
        radius: f64,
    },
    BackgroundBlur {
        radius: f64,
    },
    /// Noise/Grain effect - trendy differentiator
    Noise {
        amount: f32, // 0.0 to 1.0
        seed: u32,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct EffectLayer {
    pub effect: Effect,
    pub visible: bool,
    pub opacity: f32,
    pub blend: BlendKind,
}
impl EffectLayer {
    pub fn new(effect: Effect) -> Self {
        Self {
            effect,
            visible: true,
            opacity: 1.0,
            blend: BlendKind::Normal,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn densify_oklab_keeps_endpoints_and_count() {
        let stops = vec![
            (0.0f32, Color::from_rgb8(255, 0, 0)),
            (1.0f32, Color::from_rgb8(0, 0, 255)),
        ];
        let out = densify_oklab(&stops, 16);
        assert_eq!(out.len(), 17, "first stop + 16 densified steps");
        assert_eq!(out.first().unwrap().1.to_rgba8().r, 255);
        assert_eq!(out.last().unwrap().1.to_rgba8().b, 255);
        // positions monotonic, spanning 0..1
        let pos: Vec<f32> = out.iter().map(|(t, _)| *t).collect();
        assert!((pos[0] - 0.0).abs() < 1e-6 && (pos[pos.len() - 1] - 1.0).abs() < 1e-6);
        assert!(pos.windows(2).all(|w| w[0] <= w[1]));
    }

    #[test]
    fn oklab_midpoint_beats_srgb_lerp_for_red_blue() {
        // red -> blue through OKLab keeps chroma: the midpoint is a
        // vivid purple, not the sRGB dead-zone (127, 0, 127)
        let stops = vec![
            (0.0f32, Color::from_rgb8(255, 0, 0)),
            (1.0f32, Color::from_rgb8(0, 0, 255)),
        ];
        let out = densify_oklab(&stops, 2);
        let mid = out[1].1.to_rgba8();
        assert!((mid.r as i32 - 140).abs() <= 2, "r ~140, got {}", mid.r);
        assert!((mid.g as i32 - 83).abs() <= 2, "g ~83, got {}", mid.g);
        assert!((mid.b as i32 - 162).abs() <= 2, "b ~162, got {}", mid.b);
    }

    #[test]
    fn stops_for_render_matches_space() {
        let stops = vec![
            (0.0f32, Color::from_rgb8(255, 90, 0)),
            (1.0f32, Color::from_rgb8(142, 45, 226)),
        ];
        assert_eq!(GradSpace::Srgb.stops_for_render(&stops).len(), 2);
        let ok = GradSpace::Oklab.stops_for_render(&stops);
        assert_eq!(ok.len(), 17, "2 endpoints + 16 densified");
        // alpha lerps linearly
        let half = vec![
            (0.0f32, Color::from_rgba8(255, 0, 0, 40)),
            (1.0f32, Color::from_rgba8(0, 0, 255, 200)),
        ];
        let out = densify_oklab(&half, 2);
        assert_eq!(out[1].1.to_rgba8().a, 120, "mid alpha = (40+200)/2");
    }
}
