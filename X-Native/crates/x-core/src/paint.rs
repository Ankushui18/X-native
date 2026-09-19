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
        start_angle: f64, // degrees, 0 = right, 90 = down
        end_angle: f64,   // degrees, typically start_angle + 360
        stops: Vec<(f32, Color)>,
        space: GradSpace,
    },
    /// Phase 6: Diamond gradient - expands in diamond shape from center
    DiamondGradient {
        center: (f64, f64),
        width: f64,  // horizontal radius
        height: f64, // vertical radius
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
            Paint::LinearGradient { stops, .. }
            | Paint::RadialGradient { stops, .. }
            | Paint::AngularGradient { stops, .. }
            | Paint::DiamondGradient { stops, .. } => {
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
            Paint::AngularGradient {
                start_angle,
                end_angle,
                ..
            } => {
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
            Paint::LinearGradient { stops, .. }
            | Paint::RadialGradient { stops, .. }
            | Paint::AngularGradient { stops, .. }
            | Paint::DiamondGradient { stops, .. } => {
                stops.push((position, color));
                // Sort by position (total_cmp: a NaN stop position must not
                // panic the gradient sort)
                stops.sort_by(|a, b| a.0.total_cmp(&b.0));
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
                // Re-sort (total_cmp: NaN-proof, same as add_stop)
                stops.sort_by(|a, b| a.0.total_cmp(&b.0));
            }
            _ => {}
        }
    }

    /// Convert a gradient while preserving its authored stops. Coordinates
    /// are kept in the node's existing local space; when a source geometry
    /// does not provide a meaningful span, a 100px default keeps the result
    /// visible instead of collapsing it to a zero-length gradient.
    pub fn set_gradient_type(&mut self, gradient_type: &str) -> bool {
        let stops = match self {
            Paint::LinearGradient { stops, .. }
            | Paint::RadialGradient { stops, .. }
            | Paint::AngularGradient { stops, .. }
            | Paint::DiamondGradient { stops, .. } => stops.clone(),
            _ => return false,
        };
        let (center, span, space) = match self {
            Paint::LinearGradient {
                start, end, space, ..
            } => (
                ((start.0 + end.0) / 2.0, (start.1 + end.1) / 2.0),
                ((end.0 - start.0) / 2.0, (end.1 - start.1) / 2.0),
                *space,
            ),
            Paint::RadialGradient {
                center,
                radius,
                space,
                ..
            } => (*center, (*radius, 0.0), *space),
            Paint::AngularGradient { center, space, .. } => (*center, (100.0, 0.0), *space),
            Paint::DiamondGradient {
                center,
                width,
                height,
                space,
                ..
            } => (*center, (*width, *height), *space),
            _ => return false,
        };
        let span = if span.0.abs() + span.1.abs() < 1e-9 {
            (100.0, 0.0)
        } else {
            span
        };
        let kind = gradient_type.trim().to_ascii_lowercase();
        *self = match kind.as_str() {
            "linear" => Paint::LinearGradient {
                start: (center.0 - span.0, center.1 - span.1),
                end: (center.0 + span.0, center.1 + span.1),
                stops,
                space,
            },
            "radial" => Paint::RadialGradient {
                center,
                radius: span.0.hypot(span.1).max(1.0),
                stops,
                space,
            },
            "angular" | "conic" => Paint::AngularGradient {
                center,
                start_angle: 0.0,
                end_angle: 360.0,
                stops,
                space,
            },
            "diamond" => Paint::DiamondGradient {
                center,
                width: span.0.abs().max(1.0),
                height: span.1.abs().max(1.0),
                stops,
                space,
            },
            _ => return false,
        };
        true
    }

    /// Phase 6: Check if this paint is a gradient
    pub fn is_gradient(&self) -> bool {
        matches!(
            self,
            Paint::LinearGradient { .. }
                | Paint::RadialGradient { .. }
                | Paint::AngularGradient { .. }
                | Paint::DiamondGradient { .. }
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
    /// Figma's own words for the mode (`Apply blend modes…`). ONE owner: the
    /// panel pill, the menu and any export read this, so a name can never
    /// drift between the control and the list it opens.
    pub fn label(self) -> &'static str {
        match self {
            BlendKind::PassThrough => "Pass through",
            BlendKind::Normal => "Normal",
            BlendKind::Darken => "Darken",
            BlendKind::Multiply => "Multiply",
            BlendKind::PlusDarker => "Plus darker",
            BlendKind::ColorBurn => "Color burn",
            BlendKind::Lighten => "Lighten",
            BlendKind::Screen => "Screen",
            BlendKind::PlusLighter => "Plus lighter",
            BlendKind::ColorDodge => "Color dodge",
            BlendKind::Overlay => "Overlay",
            BlendKind::SoftLight => "Soft light",
            BlendKind::HardLight => "Hard light",
            BlendKind::Difference => "Difference",
            BlendKind::Exclusion => "Exclusion",
            BlendKind::Hue => "Hue",
            BlendKind::Saturation => "Saturation",
            BlendKind::Color => "Color",
            BlendKind::Luminosity => "Luminosity",
        }
    }

    /// The dropdown for a **layer**, in Figma's order: *"Pass through is the
    /// default mode for layers"*, and it leads the list.
    pub fn layer_modes() -> Vec<BlendKind> {
        let mut v = vec![BlendKind::PassThrough];
        v.extend(BlendKind::paint_modes());
        v
    }

    /// The dropdown for a fill, a stroke or an effect. **No Pass through** —
    /// *"Pass through cannot be applied to fills or effects."* Same 18 modes
    /// and the same order otherwise, so the two menus differ by exactly the
    /// one row Figma's documentation says they differ by.
    pub fn paint_modes() -> Vec<BlendKind> {
        vec![
            BlendKind::Normal,
            BlendKind::Darken,
            BlendKind::Multiply,
            BlendKind::PlusDarker,
            BlendKind::ColorBurn,
            BlendKind::Lighten,
            BlendKind::Screen,
            BlendKind::PlusLighter,
            BlendKind::ColorDodge,
            BlendKind::Overlay,
            BlendKind::SoftLight,
            BlendKind::HardLight,
            BlendKind::Difference,
            BlendKind::Exclusion,
            BlendKind::Hue,
            BlendKind::Saturation,
            BlendKind::Color,
            BlendKind::Luminosity,
        ]
    }

    /// Figma's menu order for a list, or `None` when the mode is not in it
    /// (a `Pass through` on a paint cannot be ticked because it cannot be set).
    pub fn row_in(modes: &[BlendKind], kind: BlendKind) -> Option<usize> {
        modes.iter().position(|m| *m == kind)
    }

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
            BlendKind::PlusDarker => None, // Custom: max(0, base + blend - 1)
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

/// The effect types this engine carries, in Figma's dropdown order (`Apply
/// effects to layers`: *"Drop shadow"*, *"Inner shadow"*, *"Layer blur"*,
/// *"Background blur"*, *"Noise"*). `Glass` and `Texture` are Figma's two
/// newer types and are not in the model — see the master list rows 8.23/8.24.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectKind {
    DropShadow,
    InnerShadow,
    LayerBlur,
    BackgroundBlur,
    Noise,
}

impl EffectKind {
    /// The add menu and the row's type dropdown, in Figma's order.
    pub fn all() -> [EffectKind; 5] {
        [
            EffectKind::DropShadow,
            EffectKind::InnerShadow,
            EffectKind::LayerBlur,
            EffectKind::BackgroundBlur,
            EffectKind::Noise,
        ]
    }
    /// Figma's words for the type, the ONE owner of them.
    pub fn label(self) -> &'static str {
        match self {
            EffectKind::DropShadow => "Drop shadow",
            EffectKind::InnerShadow => "Inner shadow",
            EffectKind::LayerBlur => "Layer blur",
            EffectKind::BackgroundBlur => "Background blur",
            EffectKind::Noise => "Noise",
        }
    }
    /// The icon name this type wears (the app's vocabulary).
    pub fn icon(self) -> &'static str {
        match self {
            EffectKind::DropShadow | EffectKind::InnerShadow => "box",
            EffectKind::LayerBlur => "sparkles",
            EffectKind::BackgroundBlur => "layout-template",
            EffectKind::Noise => "grid-2x2",
        }
    }
}

/// One numeric row of an effect's settings block, in Figma's words and order:
/// shadows show **X**, **Y**, **Blur**; blurs show **Radius**; noise shows
/// **Density**.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectField {
    X,
    Y,
    Blur,
    Radius,
    Density,
}

impl EffectField {
    pub fn label(self) -> &'static str {
        match self {
            EffectField::X => "X",
            EffectField::Y => "Y",
            EffectField::Blur => "Blur",
            EffectField::Radius => "Radius",
            EffectField::Density => "Density",
        }
    }
}

impl Effect {
    pub fn kind(&self) -> EffectKind {
        match self {
            Effect::DropShadow { .. } => EffectKind::DropShadow,
            Effect::InnerShadow { .. } => EffectKind::InnerShadow,
            Effect::LayerBlur { .. } => EffectKind::LayerBlur,
            Effect::BackgroundBlur { .. } => EffectKind::BackgroundBlur,
            Effect::Noise { .. } => EffectKind::Noise,
        }
    }

    /// A new effect of `kind` with Figma's own starting values: a shadow
    /// starts at `X 0 / Y 4 / Blur 4` in 25% black (Figma's drop shadow
    /// default), a blur at a small radius, noise at a light density.
    pub fn default_of(kind: EffectKind) -> Effect {
        match kind {
            EffectKind::DropShadow => Effect::DropShadow {
                dx: 0.0,
                dy: 4.0,
                blur: 4.0,
                color: Color::from_rgba8(0, 0, 0, 64),
            },
            EffectKind::InnerShadow => Effect::InnerShadow {
                dx: 0.0,
                dy: 4.0,
                blur: 4.0,
                color: Color::from_rgba8(0, 0, 0, 64),
            },
            EffectKind::LayerBlur => Effect::LayerBlur { radius: 4.0 },
            EffectKind::BackgroundBlur => Effect::BackgroundBlur { radius: 8.0 },
            EffectKind::Noise => Effect::Noise {
                amount: 0.25,
                seed: 1,
            },
        }
    }

    /// The numeric settings this effect shows, in the order Figma shows them.
    /// The panel builds its block from this, so a type can never grow a field
    /// the model has no place for (or lose one it has).
    pub fn fields(&self) -> Vec<EffectField> {
        match self {
            Effect::DropShadow { .. } | Effect::InnerShadow { .. } => {
                vec![EffectField::X, EffectField::Y, EffectField::Blur]
            }
            Effect::LayerBlur { .. } | Effect::BackgroundBlur { .. } => vec![EffectField::Radius],
            Effect::Noise { .. } => vec![EffectField::Density],
        }
    }

    pub fn field(&self, f: EffectField) -> f64 {
        match (self, f) {
            (Effect::DropShadow { dx, .. }, EffectField::X)
            | (Effect::InnerShadow { dx, .. }, EffectField::X) => *dx,
            (Effect::DropShadow { dy, .. }, EffectField::Y)
            | (Effect::InnerShadow { dy, .. }, EffectField::Y) => *dy,
            (Effect::DropShadow { blur, .. }, EffectField::Blur)
            | (Effect::InnerShadow { blur, .. }, EffectField::Blur) => *blur,
            (Effect::LayerBlur { radius }, EffectField::Radius)
            | (Effect::BackgroundBlur { radius }, EffectField::Radius) => *radius,
            (Effect::Noise { amount, .. }, EffectField::Density) => *amount as f64,
            _ => 0.0,
        }
    }

    /// Write a field. A field the effect does not carry is ignored rather than
    /// silently landing somewhere else.
    pub fn set_field(&mut self, f: EffectField, v: f64) {
        match (self, f) {
            (Effect::DropShadow { dx, .. }, EffectField::X)
            | (Effect::InnerShadow { dx, .. }, EffectField::X) => *dx = v,
            (Effect::DropShadow { dy, .. }, EffectField::Y)
            | (Effect::InnerShadow { dy, .. }, EffectField::Y) => *dy = v,
            (Effect::DropShadow { blur, .. }, EffectField::Blur)
            | (Effect::InnerShadow { blur, .. }, EffectField::Blur) => *blur = v.max(0.0),
            (Effect::LayerBlur { radius }, EffectField::Radius)
            | (Effect::BackgroundBlur { radius }, EffectField::Radius) => *radius = v.max(0.0),
            (Effect::Noise { amount, .. }, EffectField::Density) => {
                *amount = (v as f32).clamp(0.0, 1.0)
            }
            _ => {}
        }
    }

    /// The shadow's **Fill** (Figma calls a shadow's colour a paint). `None`
    /// for the effect types that have no colour.
    pub fn color(&self) -> Option<Color> {
        match self {
            Effect::DropShadow { color, .. } | Effect::InnerShadow { color, .. } => Some(*color),
            _ => None,
        }
    }

    pub fn set_color(&mut self, c: Color) {
        match self {
            Effect::DropShadow { color, .. } | Effect::InnerShadow { color, .. } => *color = c,
            _ => {}
        }
    }
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

    /// Figma (help 360040667874) writes the mode list out in order, and says
    /// the one thing that separates the two dropdowns: *"Pass through cannot be
    /// applied to fills or effects"* while it IS the default for layers.
    #[test]
    fn the_blend_lists_are_figmas_and_pass_through_is_layer_only() {
        let words = [
            "Darken",
            "Multiply",
            "Plus darker",
            "Color burn",
            "Lighten",
            "Screen",
            "Plus lighter",
            "Color dodge",
            "Overlay",
            "Soft light",
            "Hard light",
            "Difference",
            "Exclusion",
            "Hue",
            "Saturation",
            "Color",
            "Luminosity",
        ];
        let paints = BlendKind::paint_modes();
        assert_eq!(paints.len(), 18);
        assert_eq!(paints[0], BlendKind::Normal, "Normal is the paint default");
        assert!(
            !paints.contains(&BlendKind::PassThrough),
            "Pass through cannot be applied to fills or effects"
        );
        let names: Vec<&str> = paints[1..].iter().map(|m| m.label()).collect();
        assert_eq!(names, words, "Figma's order, after Normal");

        let layers = BlendKind::layer_modes();
        assert_eq!(layers.len(), 19);
        assert_eq!(layers[0], BlendKind::PassThrough);
        assert_eq!(
            &layers[1..],
            &paints[..],
            "one extra row, not a second list"
        );

        assert_eq!(BlendKind::row_in(&layers, BlendKind::PassThrough), Some(0));
        assert_eq!(BlendKind::row_in(&paints, BlendKind::PassThrough), None);
    }

    /// The five types this engine carries, in Figma's dropdown order, each with
    /// its own starting values and its own settings rows.
    #[test]
    fn the_effect_kinds_are_figmas_five_with_their_own_fields() {
        let kinds = EffectKind::all();
        let labels: Vec<&str> = kinds.iter().map(|k| k.label()).collect();
        assert_eq!(
            labels,
            vec![
                "Drop shadow",
                "Inner shadow",
                "Layer blur",
                "Background blur",
                "Noise"
            ]
        );
        for k in kinds {
            let e = Effect::default_of(k);
            assert_eq!(e.kind(), k, "a default carries its own kind");
            let expect = match k {
                EffectKind::DropShadow | EffectKind::InnerShadow => {
                    vec![EffectField::X, EffectField::Y, EffectField::Blur]
                }
                EffectKind::LayerBlur | EffectKind::BackgroundBlur => vec![EffectField::Radius],
                EffectKind::Noise => vec![EffectField::Density],
            };
            assert_eq!(e.fields(), expect, "{} rows", k.label());
            assert_eq!(
                e.color().is_some(),
                matches!(k, EffectKind::DropShadow | EffectKind::InnerShadow),
                "only a shadow carries a Fill"
            );
        }
        // a shadow's documented defaults: X 0, Y 4, Blur 4
        let d = Effect::default_of(EffectKind::DropShadow);
        assert_eq!(d.field(EffectField::X), 0.0);
        assert_eq!(d.field(EffectField::Y), 4.0);
        assert_eq!(d.field(EffectField::Blur), 4.0);
    }

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
    fn nan_stop_positions_do_not_panic_the_sort() {
        // AUDIT: gradient stop sorting once force-unwrapped float ordering — a NaN
        // position (0.0/0.0, import garbage) panicked the app mid-paint.
        // total_cmp orders NaN past every finite stop instead.
        let mut p = Paint::linear_gradient(
            (0.0, 0.0),
            (100.0, 0.0),
            vec![
                (0.0f32, Color::from_rgb8(255, 0, 0)),
                (1.0f32, Color::from_rgb8(0, 0, 255)),
            ],
            GradSpace::Srgb,
        );
        p.add_stop(f32::NAN, Color::from_rgb8(0, 255, 0));
        p.add_stop(0.5, Color::from_rgb8(255, 255, 0));
        // clamp keeps NaN (NaN.clamp(0,1) == NaN), so move_stop is a real
        // NaN path too
        p.move_stop(0, f32::NAN);
        if let Paint::LinearGradient { stops, .. } = &p {
            let pos: Vec<f32> = stops.iter().map(|(t, _)| *t).collect();
            assert_eq!(pos.len(), 4);
            assert_eq!(pos[0], 0.5, "finite stops keep natural order");
            assert_eq!(pos[1], 1.0);
            assert!(pos[2].is_nan() && pos[3].is_nan(), "NaN parked at the end");
        } else {
            panic!("expected LinearGradient");
        }
    }

    #[test]
    fn gradient_type_conversion_preserves_stops() {
        let mut paint = Paint::linear_gradient(
            (10.0, 20.0),
            (110.0, 20.0),
            vec![
                (0.0, Color::from_rgb8(255, 0, 0)),
                (1.0, Color::from_rgb8(0, 0, 255)),
            ],
            GradSpace::Srgb,
        );
        assert!(paint.set_gradient_type("radial"));
        assert_eq!(paint.gradient_type_name(), "Radial");
        match paint {
            Paint::RadialGradient { stops, center, .. } => {
                assert_eq!(center, (60.0, 20.0));
                assert_eq!(stops.len(), 2);
            }
            other => panic!("expected radial gradient, got {other:?}"),
        }
        assert!(!Paint::Solid(Color::WHITE).set_gradient_type("linear"));
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
