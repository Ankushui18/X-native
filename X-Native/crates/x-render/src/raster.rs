//! CPU raster export (PNG / JPG): RenderTree -> tiny-skia Pixmap -> bytes.
//!
//! Headless, deterministic, no GPU. This is the backend for Figma's "Export"
//! surface — it reuses the same `RenderCommand` IR the GPU path and the PDF
//! sink consume, so raster export cannot drift from the canvas.
//!
//! Supports arbitrary scale (@1x/@2x/@3x), PNG (straight alpha, transparent
//! background) and JPG (composited onto a background, quality knob).

use crate::ir::{RenderCommand, RenderTree};
use tiny_skia as ts;
use vello::kurbo::{Affine, BezPath, PathEl, Shape};
use vello::peniko::{Brush, Color, Mix};
use x_core::StrokeOptions;

// ------------------------------------------------------------- conversions

fn to_transform(a: Affine) -> ts::Transform {
    // kurbo Affine::as_coeffs() = [a, b, c, d, e, f] for matrix [[a, c, e], [b, d, f]]
    // tiny-skia Transform::from_row(sx, ky, kx, sy, tx, ty) for matrix [[sx,kx,tx],[ky,sy,ty]]
    let c = a.as_coeffs();
    ts::Transform::from_row(
        c[0] as f32,
        c[1] as f32,
        c[2] as f32,
        c[3] as f32,
        c[4] as f32,
        c[5] as f32,
    )
}

fn to_color(c: Color) -> ts::Color {
    let t = c.to_rgba8();
    ts::Color::from_rgba8(t.r, t.g, t.b, t.a)
}

fn to_path(path: &BezPath) -> Option<ts::Path> {
    let mut pb = ts::PathBuilder::new();
    for el in path.elements() {
        match el {
            PathEl::MoveTo(p) => pb.move_to(p.x as f32, p.y as f32),
            PathEl::LineTo(p) => pb.line_to(p.x as f32, p.y as f32),
            PathEl::QuadTo(p1, p2) => {
                pb.quad_to(p1.x as f32, p1.y as f32, p2.x as f32, p2.y as f32)
            }
            PathEl::CurveTo(p1, p2, p3) => pb.cubic_to(
                p1.x as f32,
                p1.y as f32,
                p2.x as f32,
                p2.y as f32,
                p3.x as f32,
                p3.y as f32,
            ),
            PathEl::ClosePath => pb.close(),
        }
    }
    pb.finish()
}

fn to_shader(g: &vello::peniko::Gradient) -> Option<ts::Shader<'static>> {
    use vello::peniko::GradientKind;
    if g.stops.is_empty() {
        return None;
    }
    let stops: Vec<ts::GradientStop> = g
        .stops
        .iter()
        .map(|s| ts::GradientStop::new(s.offset, to_color(s.color.to_alpha_color())))
        .collect();
    match g.kind {
        GradientKind::Linear(p) => ts::LinearGradient::new(
            ts::Point::from_xy(p.start.x as f32, p.start.y as f32),
            ts::Point::from_xy(p.end.x as f32, p.end.y as f32),
            stops,
            ts::SpreadMode::Pad,
            ts::Transform::identity(),
        ),
        GradientKind::Radial(p) => ts::RadialGradient::new(
            ts::Point::from_xy(p.start_center.x as f32, p.start_center.y as f32),
            p.start_radius,
            ts::Point::from_xy(p.end_center.x as f32, p.end_center.y as f32),
            p.end_radius,
            stops,
            ts::SpreadMode::Pad,
            ts::Transform::identity(),
        ),
        GradientKind::Sweep { .. } => None,
    }
}

fn to_paint(brush: &Brush) -> ts::Paint<'static> {
    let mut paint = ts::Paint::default();
    match brush {
        Brush::Solid(c) => paint.set_color(to_color(*c)),
        Brush::Gradient(g) => match to_shader(g) {
            Some(sh) => paint.shader = sh,
            None => paint.set_color(ts::Color::BLACK),
        },
        // image brush: not a raster fill source; fall back to black
        Brush::Image(_) => paint.set_color(ts::Color::BLACK),
    }
    paint
}

#[allow(clippy::field_reassign_with_default)]
fn to_stroke(options: &StrokeOptions, width: f64) -> ts::Stroke {
    use x_core::{StrokeCap, StrokeJoin};
    let cap = match options.cap_start {
        StrokeCap::Round => ts::LineCap::Round,
        StrokeCap::Square => ts::LineCap::Square,
        _ => ts::LineCap::Butt,
    };
    let join = match options.join {
        StrokeJoin::Round => ts::LineJoin::Round,
        StrokeJoin::Bevel => ts::LineJoin::Bevel,
        StrokeJoin::Miter => ts::LineJoin::Miter,
    };
    let mut stroke = ts::Stroke {
        width: width.max(0.0) as f32,
        line_cap: cap,
        line_join: join,
        miter_limit: options.miter_limit as f32,
        dash: None,
    };
    if !options.dash.is_empty() {
        let dashes: Vec<f32> = options.dash.iter().map(|d| *d as f32).collect();
        stroke.dash = ts::StrokeDash::new(dashes, options.dash_offset as f32);
    }
    stroke
}

fn mix_to_blend(mix: Mix) -> Option<ts::BlendMode> {
    match mix {
        Mix::Normal => None,
        Mix::Multiply => Some(ts::BlendMode::Multiply),
        Mix::Screen => Some(ts::BlendMode::Screen),
        Mix::Overlay => Some(ts::BlendMode::Overlay),
        Mix::Darken => Some(ts::BlendMode::Darken),
        Mix::Lighten => Some(ts::BlendMode::Lighten),
        Mix::ColorDodge => Some(ts::BlendMode::ColorDodge),
        Mix::ColorBurn => Some(ts::BlendMode::ColorBurn),
        Mix::HardLight => Some(ts::BlendMode::HardLight),
        Mix::SoftLight => Some(ts::BlendMode::SoftLight),
        Mix::Difference => Some(ts::BlendMode::Difference),
        Mix::Exclusion => Some(ts::BlendMode::Exclusion),
        Mix::Hue => Some(ts::BlendMode::Hue),
        Mix::Saturation => Some(ts::BlendMode::Saturation),
        Mix::Color => Some(ts::BlendMode::Color),
        Mix::Luminosity => Some(ts::BlendMode::Luminosity),
    }
}

/// An 8-bit alpha mask filled uniformly with `value` (0..255).
fn filled_mask(w: u32, h: u32, value: u8) -> Option<ts::Mask> {
    let mut m = ts::Mask::new(w, h)?;
    m.data_mut().fill(value);
    Some(m)
}

/// Multiply mask `a` (in place) by mask `b` (per-pixel alpha product).
fn mask_multiply(a: &mut ts::Mask, b: &ts::Mask) {
    let b = b.data().to_vec();
    for (x, y) in a.data_mut().iter_mut().zip(b.iter()) {
        *x = (((*x as u32) * (*y as u32)) / 255) as u8;
    }
}

// ------------------------------------------------------------- rasterizer

/// One pushed context (a PushLayer or PushClip). `mask` is the combined
/// clip+alpha restriction in effect inside this context; `blend` is the
/// innermost non-normal blend mode (applied per-draw — see note).
struct Ctx {
    mask: Option<ts::Mask>,
    blend: ts::BlendMode,
    layer: Option<(ts::Pixmap, ts::BlendMode, f32, vello::kurbo::Rect)>,
}

/// Renders a `RenderTree` into a `tiny_skia::Pixmap` at a scale factor.
pub struct RasterSink<'a> {
    pub assets: Option<&'a crate::Assets>,
    pub fonts: Option<&'a x_text::FontManager>,
    pix: ts::Pixmap,
    scale: f64,
    stack: Vec<Ctx>,
}

impl<'a> RasterSink<'a> {
    pub fn new(
        assets: Option<&'a crate::Assets>,
        fonts: Option<&'a x_text::FontManager>,
        page_w: f64,
        page_h: f64,
        scale: f64,
        background: Option<Color>,
    ) -> Option<Self> {
        if [page_w, page_h, scale]
            .iter()
            .any(|n| !n.is_finite() || *n <= 0.0)
        {
            return None;
        }
        if (page_w * scale).ceil() * (page_h * scale).ceil() > 16_777_216.0 {
            return None;
        }
        let w = (page_w * scale).round().max(1.0) as u32;
        let h = (page_h * scale).round().max(1.0) as u32;
        let mut pix = ts::Pixmap::new(w, h)?;
        pix.fill(match background {
            Some(c) => to_color(c),
            None => ts::Color::TRANSPARENT,
        });
        Some(Self {
            assets,
            fonts,
            pix,
            scale,
            stack: Vec::new(),
        })
    }

    pub fn render(self, tree: &RenderTree) -> ts::Pixmap {
        if check_work_budget(tree, self.pix.width(), self.pix.height()).is_err() {
            return self.pix;
        }
        self.render_cancellable(tree, &|| false)
            .expect("preflighted uncancellable render")
    }

    pub fn render_cancellable(
        mut self,
        tree: &RenderTree,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<ts::Pixmap, String> {
        if cancelled() {
            return Err("operation cancelled".into());
        }
        let outlined = self
            .fonts
            .and_then(|f| crate::text_geometry::outline_text(tree, f).ok());
        let tree = outlined.as_ref().unwrap_or(tree);
        check_work_budget(tree, self.pix.width(), self.pix.height())?;
        let scaled = (self.scale != 1.0).then(|| {
            let mut tree = RenderTree {
                commands: tree.commands.clone(),
            };
            let scale = Affine::scale(self.scale);
            for c in &mut tree.commands {
                match c {
                    RenderCommand::FillPath { transform, .. }
                    | RenderCommand::StrokePath { transform, .. }
                    | RenderCommand::Glyphs { transform, .. }
                    | RenderCommand::Image { transform, .. }
                    | RenderCommand::PushClip { transform, .. } => *transform = scale * *transform,
                    RenderCommand::PushLayer { bounds, .. } => {
                        *bounds = scale.transform_rect_bbox(*bounds)
                    }
                    RenderCommand::PopLayer => {}
                }
            }
            tree
        });
        let tree = scaled.as_ref().unwrap_or(tree);
        for cmd in &tree.commands {
            if cancelled() {
                return Err("operation cancelled".into());
            }
            match cmd {
                RenderCommand::FillPath {
                    transform,
                    path,
                    brush,
                    ..
                } => {
                    if let Some(p) = to_path(path) {
                        let mut paint = to_paint(brush);
                        let mask = self.stack.last().and_then(|c| c.mask.as_ref());
                        paint.blend_mode = self
                            .stack
                            .last()
                            .map(|c| c.blend)
                            .unwrap_or(ts::BlendMode::SourceOver);
                        self.pix.fill_path(
                            &p,
                            &paint,
                            ts::FillRule::Winding,
                            to_transform(*transform),
                            mask,
                        );
                    }
                }
                RenderCommand::StrokePath {
                    transform,
                    path,
                    brush,
                    width,
                    options,
                    ..
                } => {
                    if let Some(p) = to_path(path) {
                        let mut paint = to_paint(brush);
                        let mask = self.stack.last().and_then(|c| c.mask.as_ref());
                        paint.blend_mode = self
                            .stack
                            .last()
                            .map(|c| c.blend)
                            .unwrap_or(ts::BlendMode::SourceOver);
                        let stroke = to_stroke(options, *width);
                        self.pix
                            .stroke_path(&p, &paint, &stroke, to_transform(*transform), mask);
                    }
                }
                RenderCommand::Glyphs {
                    transform,
                    text,
                    size,
                    brush,
                    max_width,
                    font,
                    letter_spacing,
                    line_height,
                    lh_mode,
                    lh_value,
                    wrap,
                    word_spacing,
                    paragraph_spacing,
                    baseline_shift,
                    small_caps,
                    optical_size,
                    width_axis,
                    align,
                    v_align,
                    node_h,
                    max_lines,
                    paragraph_indent,
                    decoration,
                    ..
                } => {
                    let mut drew = false;
                    if let Some(fm) = self.fonts {
                        let nat = x_text::resolve_natural_line_height(fm, font.as_deref(), *size)
                            .max(0.1);
                        let lh = match *lh_mode {
                            1 => (*lh_value).max(1.0) / nat,
                            2 => ((*lh_value) / 100.0 * *size / nat).max(0.1),
                            _ => *line_height,
                        };
                        let align = x_text::Align::from(*align);
                        if let Some((glyphs, height)) = x_text::node_text_outlines_styled(
                            fm,
                            text,
                            *size,
                            *max_width,
                            font.as_deref(),
                            Color::WHITE,
                            *letter_spacing,
                            lh,
                            *wrap,
                            *word_spacing,
                            *paragraph_spacing,
                            *baseline_shift,
                            *small_caps,
                            *optical_size,
                            *width_axis,
                            *lh_mode,
                            align,
                            *max_lines,
                            *paragraph_indent,
                            *decoration,
                        ) {
                            // vertical placement inside the node box, the same
                            // rule the canvas sink applies
                            let dy = match v_align {
                                x_core::TextAlignVertical::Top => 0.0,
                                x_core::TextAlignVertical::Middle => (*node_h - height) / 2.0,
                                x_core::TextAlignVertical::Bottom => *node_h - height,
                            };
                            let vshift = Affine::translate((0.0, dy));
                            for gl in glyphs {
                                if let Some(p) = to_path(&gl.path) {
                                    let full = *transform * vshift * gl.transform;
                                    let mut paint = to_paint(brush);
                                    let mask = self.stack.last().and_then(|c| c.mask.as_ref());
                                    paint.blend_mode = self
                                        .stack
                                        .last()
                                        .map(|c| c.blend)
                                        .unwrap_or(ts::BlendMode::SourceOver);
                                    self.pix.fill_path(
                                        &p,
                                        &paint,
                                        ts::FillRule::Winding,
                                        to_transform(full),
                                        mask,
                                    );
                                }
                            }
                            drew = true;
                        }
                    }
                    if !drew {
                        // no font manager: placeholder box so text is not silently lost
                        if let Some(p) = to_path(
                            &vello::kurbo::Rect::new(0.0, 0.0, *max_width, *size).into_path(0.1),
                        ) {
                            let mut paint = ts::Paint::default();
                            paint.set_color(ts::Color::from_rgba8(0xcc, 0xcc, 0xcc, 0x80));
                            let mask = self.stack.last().and_then(|c| c.mask.as_ref());
                            self.pix.fill_path(
                                &p,
                                &paint,
                                ts::FillRule::Winding,
                                to_transform(*transform),
                                mask,
                            );
                        }
                    }
                }
                RenderCommand::Image {
                    transform,
                    asset,
                    w,
                    h,
                    fit,
                    placement,
                    adjustments,
                    rotation,
                    ..
                } => {
                    let adjusted = adjustments
                        .as_ref()
                        .and_then(|adj| self.assets.and_then(|a| a.get_adjusted(asset, *adj)));
                    let image = adjusted
                        .as_ref()
                        .or_else(|| self.assets.and_then(|a| a.get(asset)));
                    if let Some(img) = image {
                        let resolved = x_core::resolve_image_placement(
                            *fit,
                            placement,
                            *w,
                            *h,
                            img.image.width as f64,
                            img.image.height as f64,
                        );
                        // vello Image is straight-alpha RGBA8; tiny-skia wants premultiplied
                        let mut pixmap =
                            ts::Pixmap::new(img.image.width, img.image.height).unwrap();
                        let blob = img.image.data.data();
                        {
                            let dst = pixmap.data_mut();
                            for i in 0..(img.image.width * img.image.height) as usize {
                                let r = blob.get(i * 4).copied().unwrap_or(0) as u32;
                                let g = blob.get(i * 4 + 1).copied().unwrap_or(0) as u32;
                                let b = blob.get(i * 4 + 2).copied().unwrap_or(0) as u32;
                                let a = blob.get(i * 4 + 3).copied().unwrap_or(255) as u32;
                                dst[i * 4] = ((r * a + 127) / 255) as u8;
                                dst[i * 4 + 1] = ((g * a + 127) / 255) as u8;
                                dst[i * 4 + 2] = ((b * a + 127) / 255) as u8;
                                dst[i * 4 + 3] = a as u8;
                            }
                        }
                        // clip to the node box
                        if let Some(box_path) =
                            to_path(&vello::kurbo::Rect::new(0.0, 0.0, *w, *h).into_path(0.1))
                        {
                            let mut clip =
                                filled_mask(self.pix.width(), self.pix.height(), 255).unwrap();
                            clip.fill_path(
                                &box_path,
                                ts::FillRule::Winding,
                                true,
                                to_transform(*transform),
                            );
                            // intersect with any outer clip
                            let mask = match self.stack.last().and_then(|c| c.mask.as_ref()) {
                                Some(outer) => {
                                    let mut m = outer.clone();
                                    mask_multiply(&mut m, &clip);
                                    m
                                }
                                None => clip,
                            };
                            let blend = self
                                .stack
                                .last()
                                .map(|c| c.blend)
                                .unwrap_or(ts::BlendMode::SourceOver);
                            let image_transform = *transform
                                * Affine::translate((*w / 2.0, *h / 2.0))
                                * Affine::rotate(rotation.to_radians())
                                * Affine::translate((-*w / 2.0, -*h / 2.0));
                            for draw in &resolved.draws {
                                let t = image_transform * *draw;
                                let paint = ts::PixmapPaint {
                                    blend_mode: blend,
                                    quality: ts::FilterQuality::Bilinear,
                                    opacity: 1.0,
                                };
                                self.pix.draw_pixmap(
                                    0,
                                    0,
                                    pixmap.as_ref(),
                                    &paint,
                                    to_transform(t),
                                    Some(&mask),
                                );
                            }
                        }
                    } else {
                        // missing asset: gray box (matches the Vello sink)
                        if let Some(p) =
                            to_path(&vello::kurbo::Rect::new(0.0, 0.0, *w, *h).into_path(0.1))
                        {
                            let mut paint = ts::Paint::default();
                            paint.set_color(ts::Color::from_rgba8(0xdd, 0xdd, 0xdd, 0xff));
                            let mask = self.stack.last().and_then(|c| c.mask.as_ref());
                            paint.blend_mode = self
                                .stack
                                .last()
                                .map(|c| c.blend)
                                .unwrap_or(ts::BlendMode::SourceOver);
                            self.pix.fill_path(
                                &p,
                                &paint,
                                ts::FillRule::Winding,
                                to_transform(*transform),
                                mask,
                            );
                        }
                    }
                }
                RenderCommand::PushLayer {
                    mix, alpha, bounds, ..
                } => {
                    let blend = mix_to_blend(*mix).unwrap_or(ts::BlendMode::SourceOver);
                    let blank = ts::Pixmap::new(self.pix.width(), self.pix.height())
                        .expect("preflighted layer allocation");
                    let parent = std::mem::replace(&mut self.pix, blank);
                    self.stack.push(Ctx {
                        mask: None,
                        blend: ts::BlendMode::SourceOver,
                        layer: Some((parent, blend, *alpha, *bounds)),
                    });
                }
                RenderCommand::PushClip {
                    transform, path, ..
                } => {
                    let parent_blend = self
                        .stack
                        .last()
                        .map(|c| c.blend)
                        .unwrap_or(ts::BlendMode::SourceOver);
                    if let Some(p) = to_path(path) {
                        let new_mask = match self.stack.last().and_then(|c| c.mask.as_ref()) {
                            Some(outer) => {
                                let mut m = outer.clone();
                                m.intersect_path(
                                    &p,
                                    ts::FillRule::Winding,
                                    true,
                                    to_transform(*transform),
                                );
                                m
                            }
                            None => {
                                let mut m =
                                    filled_mask(self.pix.width(), self.pix.height(), 255).unwrap();
                                m.intersect_path(
                                    &p,
                                    ts::FillRule::Winding,
                                    true,
                                    to_transform(*transform),
                                );
                                m
                            }
                        };
                        self.stack.push(Ctx {
                            mask: Some(new_mask),
                            blend: parent_blend,
                            layer: None,
                        });
                    } else {
                        let m = self.stack.last().and_then(|c| c.mask.as_ref()).cloned();
                        self.stack.push(Ctx {
                            mask: m,
                            blend: parent_blend,
                            layer: None,
                        });
                    }
                }
                RenderCommand::PopLayer => {
                    if let Some(Ctx {
                        layer: Some((mut parent, blend, alpha, bounds)),
                        ..
                    }) = self.stack.pop()
                    {
                        let mut mask = self
                            .stack
                            .last()
                            .and_then(|c| c.mask.as_ref())
                            .cloned()
                            .or_else(|| filled_mask(self.pix.width(), self.pix.height(), 255))
                            .expect("preflighted mask");
                        let bounds = bounds.intersect(vello::kurbo::Rect::new(
                            0.0,
                            0.0,
                            f64::from(self.pix.width()),
                            f64::from(self.pix.height()),
                        ));
                        if let Some(path) = to_path(&bounds.into_path(0.1)) {
                            mask.intersect_path(
                                &path,
                                ts::FillRule::Winding,
                                true,
                                ts::Transform::identity(),
                            );
                        }
                        parent.draw_pixmap(
                            0,
                            0,
                            self.pix.as_ref(),
                            &ts::PixmapPaint {
                                opacity: alpha,
                                blend_mode: blend,
                                quality: ts::FilterQuality::Nearest,
                            },
                            ts::Transform::identity(),
                            Some(&mask),
                        );
                        self.pix = parent;
                    }
                }
            }
        }
        if cancelled() {
            return Err("operation cancelled".into());
        }
        Ok(self.pix)
    }
}

// ------------------------------------------------------------- encoding

/// Raster format for export.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RasterFormat {
    Png,
    Jpg(u8), // quality 0..=100
}

/// Encode a rendered pixmap to PNG bytes.
pub fn encode_png(pix: &ts::Pixmap) -> Result<Vec<u8>, String> {
    pix.encode_png().map_err(|e| e.to_string())
}

/// Encode straight RGBA8 image bytes for vector exports that need to carry a
/// derived image (for example, an image with non-default adjustments).
pub fn encode_rgba_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    if rgba.len()
        != (width as usize)
            .saturating_mul(height as usize)
            .saturating_mul(4)
    {
        return Err("RGBA byte length does not match image dimensions".into());
    }
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    drop(writer);
    Ok(out)
}

/// Encode a rendered pixmap to JPG bytes, composited onto white (JPG has no
/// alpha), at the given quality.
pub fn encode_jpg(pix: &ts::Pixmap, quality: u8) -> Result<Vec<u8>, String> {
    let w = pix.width();
    let h = pix.height();
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for px in pix.pixels() {
        let c = px.demultiply();
        // unpremultiplied color over white
        let a = c.alpha() as u32;
        let r = ((c.red() as u32 * a) + (255 * (255 - a))) / 255;
        let g = ((c.green() as u32 * a) + (255 * (255 - a))) / 255;
        let b = ((c.blue() as u32 * a) + (255 * (255 - a))) / 255;
        rgb.push(r as u8);
        rgb.push(g as u8);
        rgb.push(b as u8);
    }
    let mut out = Vec::new();
    let enc = jpeg_encoder::Encoder::new(&mut out, quality.min(100));
    enc.encode(&rgb, w as u16, h as u16, jpeg_encoder::ColorType::Rgb)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// Full raster export: RenderTree -> encoded bytes.
#[allow(clippy::too_many_arguments)]
pub fn export_raster(
    tree: &RenderTree,
    page_w: f64,
    page_h: f64,
    format: RasterFormat,
    scale: f64,
    background: Option<Color>,
    assets: Option<&crate::Assets>,
    fonts: Option<&x_text::FontManager>,
) -> Result<(Vec<u8>, u32, u32), String> {
    export_raster_cancellable(
        tree,
        page_w,
        page_h,
        format,
        scale,
        background,
        assets,
        fonts,
        &|| false,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn export_raster_cancellable(
    tree: &RenderTree,
    page_w: f64,
    page_h: f64,
    format: RasterFormat,
    scale: f64,
    background: Option<Color>,
    assets: Option<&crate::Assets>,
    fonts: Option<&x_text::FontManager>,
    cancelled: &dyn Fn() -> bool,
) -> Result<(Vec<u8>, u32, u32), String> {
    if cancelled() {
        return Err("operation cancelled".into());
    }
    let sink = RasterSink::new(assets, fonts, page_w, page_h, scale, background)
        .ok_or("raster pixmap allocation failed")?;
    check_work_budget(tree, sink.pix.width(), sink.pix.height())?;
    let pix = sink.render_cancellable(tree, cancelled)?;
    let (w, h) = (pix.width(), pix.height());
    let bytes = match format {
        RasterFormat::Png => encode_png(&pix)?,
        RasterFormat::Jpg(q) => encode_jpg(&pix, q)?,
    };
    if cancelled() {
        return Err("operation cancelled".into());
    }
    Ok((bytes, w, h))
}

fn check_work_budget(tree: &RenderTree, w: u32, h: u32) -> Result<(), String> {
    let pixels = u64::from(w) * u64::from(h);
    let mut stack = vec![];
    let mut channels = 4u64;
    for c in &tree.commands {
        match c {
            RenderCommand::PushLayer { .. } => {
                stack.push(5u64);
                channels += 5;
            }
            RenderCommand::PushClip { .. } => {
                stack.push(1u64);
                channels += 1;
            }
            RenderCommand::PopLayer => {
                channels =
                    channels.saturating_sub(stack.pop().ok_or("unbalanced raster layer stack")?);
            }
            _ => {}
        }
        if pixels.saturating_mul(channels + 2) > 256 * 1024 * 1024 {
            return Err(
                "raster layers exceed 256 MiB work budget; reduce scale or simplify clipping"
                    .into(),
            );
        }
    }
    if !stack.is_empty() {
        return Err("unbalanced raster layer stack".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{build_render_tree, build_render_tree_slice};
    use x_core::{Node, Variables};

    fn doc() -> Node {
        Node::frame("page", 200.0, 100.0)
            .child(Node::rect(
                "r",
                10.0,
                10.0,
                100.0,
                50.0,
                Color::from_rgb8(255, 0, 0),
            ))
            .child(Node::ellipse(
                "e",
                120.0,
                10.0,
                60.0,
                60.0,
                Color::from_rgb8(0, 0, 255),
            ))
    }

    fn sample_px(pix: &ts::Pixmap, x: u32, y: u32) -> (u8, u8, u8, u8) {
        let px = pix
            .pixel(x, y)
            .unwrap_or(ts::PremultipliedColorU8::TRANSPARENT);
        let c = px.demultiply();
        (c.red(), c.green(), c.blue(), c.alpha())
    }

    #[test]
    fn raster_fills_shapes_and_scales() {
        let d = doc();
        let tree = build_render_tree(&d, &Variables::default());
        let (bytes, w, h) = export_raster(
            &tree,
            200.0,
            100.0,
            RasterFormat::Png,
            1.0,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!((w, h), (200, 100));
        assert!(bytes.len() > 8);
        assert_eq!(&bytes[1..4], b"PNG", "valid PNG signature");
        // @2x doubles dimensions
        let (_, w2, h2) = export_raster(
            &tree,
            200.0,
            100.0,
            RasterFormat::Png,
            2.0,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!((w2, h2), (400, 200));
    }

    #[test]
    fn raster_hits_expected_colors() {
        let d = doc();
        let tree = build_render_tree(&d, &Variables::default());
        let sink = RasterSink::new(None, None, 200.0, 100.0, 1.0, None).unwrap();
        let pix = sink.render(&tree);
        // center of the red rect (10..110, 10..60)
        let (r, g, b, _) = sample_px(&pix, 60, 35);
        assert!(r > 200 && g < 60 && b < 60, "red rect center = {r},{g},{b}");
        // center of the blue ellipse (120..180, 10..70)
        let (r, g, b, _) = sample_px(&pix, 150, 40);
        assert!(
            b > 200 && r < 60 && g < 60,
            "blue ellipse center = {r},{g},{b}"
        );
        // transparent background corner (0..10)
        let (_, _, _, a) = sample_px(&pix, 2, 2);
        assert_eq!(a, 0, "transparent background");
    }

    #[test]
    fn jpg_encodes_with_white_background() {
        let d = doc();
        let tree = build_render_tree(&d, &Variables::default());
        let (bytes, w, h) = export_raster(
            &tree,
            200.0,
            100.0,
            RasterFormat::Jpg(90),
            1.0,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!((w, h), (200, 100));
        assert_eq!(&bytes[0..2], &[0xFF, 0xD8], "JPEG SOI marker");
    }

    #[test]
    fn slice_exports_region_at_origin() {
        // a red rect at (0,0) and a blue rect at (100,100); slice only the
        // blue rect's region. The export must be 40x40, blue at origin, and
        // NOT contain the red rect (which sits outside the slice).
        let d = Node::frame("page", 400.0, 300.0)
            .child(Node::rect(
                "a",
                0.0,
                0.0,
                50.0,
                50.0,
                Color::from_rgb8(255, 0, 0),
            ))
            .child(Node::rect(
                "b",
                100.0,
                100.0,
                40.0,
                40.0,
                Color::from_rgb8(0, 0, 255),
            ))
            .child(Node::slice("s", 100.0, 100.0, 40.0, 40.0));
        let (tree, w, h) = build_render_tree_slice(&d, "s", &Variables::default()).unwrap();
        let (bytes, pw, ph) =
            export_raster(&tree, w, h, RasterFormat::Png, 1.0, None, None, None).unwrap();
        assert_eq!((pw, ph), (40, 40));
        assert_eq!(&bytes[1..4], b"PNG");
        let sink = RasterSink::new(None, None, w, h, 1.0, None).unwrap();
        let pix = sink.render(&tree);
        // center of the slice -> blue (from rect b)
        let (r, g, b, _) = sample_px(&pix, 20, 20);
        assert!(
            b > 200 && r < 60 && g < 60,
            "slice center should be blue = {r},{g},{b}"
        );
        // no red anywhere: the red rect is entirely outside the slice region
        let mut any_red = false;
        for y in 0..40u32 {
            for x in 0..40u32 {
                let (r, g, b, a) = sample_px(&pix, x, y);
                if a > 0 && r > 200 && g < 60 && b < 60 {
                    any_red = true;
                }
            }
        }
        assert!(!any_red, "red rect must not bleed into the slice");
    }

    #[test]
    fn clip_masks_restrict_draws() {
        // frame with a circular mask over a red rect -> corners clipped out
        let d = Node::frame("page", 100.0, 100.0)
            .child(Node::ellipse("m", 0.0, 0.0, 80.0, 80.0, Color::WHITE).mask(true))
            .child(Node::rect(
                "r",
                0.0,
                0.0,
                100.0,
                100.0,
                Color::from_rgb8(255, 0, 0),
            ));
        let tree = build_render_tree(&d, &Variables::default());
        let sink = RasterSink::new(None, None, 100.0, 100.0, 1.0, Some(Color::WHITE)).unwrap();
        let pix = sink.render(&tree);
        // inside the mask circle (center) -> red
        let (r, _, _, _) = sample_px(&pix, 40, 40);
        assert!(r > 200, "center should be red = {r}");
        // corner outside the circle (95,95) -> white background
        let (r, g, b, _) = sample_px(&pix, 95, 95);
        assert!(
            r > 240 && g > 240 && b > 240,
            "corner should be white = {r},{g},{b}"
        );
    }

    /// PIXELS, not command lists: the canvas names a page's OUTERMOST frames and
    /// never the page itself, which is the "page name on the artboard" complaint.
    ///
    /// The page root is shifted down by `GUTTER`, so the band ABOVE it — where a
    /// root label would be painted — is inside the bitmap as well as the page
    /// itself, and both are read back:
    ///
    /// * the gutter above the page: nothing (the root used to be labelled like
    ///   any other frame),
    /// * the page's own top edge: nothing (where the page name used to sit,
    ///   inside the artwork, before names moved to the gutter),
    /// * the gutter above the outermost frame: that frame's name,
    /// * the gutter above a frame nested inside it: nothing,
    /// * the gutter above a Section: the section's name.
    ///
    /// No font manager is attached, so a label rasterizes as its placeholder box
    /// — exactly the question here ("was a name painted?") — and no GPU is
    /// needed: this sink is tiny-skia.
    #[test]
    fn canvas_pixels_name_the_outermost_frames_and_never_the_page() {
        const GUTTER: f64 = 40.0;
        let (w, h) = (400.0, 300.0 + GUTTER);

        fn check(darkest: u8, want_ink: bool, what: &str) {
            if want_ink {
                assert!(darkest < 245, "{what}: expected a name, darkest {darkest}");
            } else {
                assert!(darkest > 245, "{what}: expected no name, darkest {darkest}");
            }
        }

        // `middle` sits 50px down inside `hero`, so its own gutter (where a
        // nested frame's name would go) cannot overlap the hero's name.
        let mut middle = Node::frame("middle", 60.0, 40.0);
        middle.transform.y = 50.0;
        let mut hero = Node::frame("hero", 160.0, 100.0).child(middle);
        hero.transform.x = 40.0;
        hero.transform.y = 40.0;
        let mut band = Node::section("band", 120.0, 80.0);
        band.name = "Band".into();
        band.transform.x = 240.0;
        band.transform.y = 40.0;
        let mut page = Node::frame("page", w, h).child(hero).child(band);
        page.transform.y = GUTTER;

        let tree = crate::ir::build_render_tree_with_hidden(&page, &Variables::default(), None);
        let sink = RasterSink::new(None, None, w, h, 1.0, Some(Color::WHITE));
        let pix = sink.expect("sink").render(&tree);

        // "ink": the darkest pixel in a band, ignoring transparent pixels
        let ink = |x0: u32, y0: u32, x1: u32, y1: u32| {
            let mut darkest = 255u8;
            for y in y0..y1 {
                for x in x0..x1 {
                    let (r, g, b, a) = sample_px(&pix, x, y);
                    if a > 8 {
                        let avg = (u32::from(r) + u32::from(g) + u32::from(b)) / 3;
                        darkest = darkest.min(avg as u8);
                    }
                }
            }
            darkest
        };

        // A name sits 26px above its frame, so a gutter band is
        // `origin - 26 .. origin - 8`; the page's top edge is where the page
        // name used to be painted instead.
        check(ink(0, 14, 400, 32), false, "above the page");
        check(ink(0, 41, 240, 53), false, "page corner");
        check(ink(40, 54, 180, 72), true, "frame name");
        check(ink(40, 104, 80, 122), false, "nested frame");
        check(ink(240, 54, 340, 72), true, "section name");
    }
}

#[cfg(test)]
mod reliability_tests {
    use super::*;
    #[test]
    fn scale_affects_content_pixels_not_only_output_dimensions() {
        let node = x_core::Node::rect("red", 0.0, 0.0, 10.0, 10.0, Color::from_rgb8(255, 0, 0));
        let tree = crate::build_render_tree(&node, &x_core::Variables::default());
        let pix = RasterSink::new(None, None, 10.0, 10.0, 2.0, None)
            .unwrap()
            .render(&tree);
        assert_eq!(pix.pixel(19, 19).unwrap().red(), 255);
        assert_eq!(pix.pixel(19, 19).unwrap().alpha(), 255);
    }
    #[test]
    fn overlapping_children_share_one_group_opacity() {
        let mut group = x_core::Node::group("g", 20.0, 20.0)
            .child(x_core::Node::rect("a", 0.0, 0.0, 15.0, 20.0, Color::WHITE))
            .child(x_core::Node::rect("b", 5.0, 0.0, 15.0, 20.0, Color::WHITE));
        group.opacity = 0.5;
        let tree = crate::build_render_tree(&group, &x_core::Variables::default());
        let pix = RasterSink::new(None, None, 20.0, 20.0, 1.0, None)
            .unwrap()
            .render(&tree);
        assert_eq!(
            pix.pixel(2, 10).unwrap().alpha(),
            pix.pixel(10, 10).unwrap().alpha()
        );
        assert!((i32::from(pix.pixel(10, 10).unwrap().alpha()) - 128).abs() <= 1);
    }
}

#[cfg(test)]
mod cancellation_tests {
    use super::*;
    #[test]
    fn a_cancelled_raster_job_returns_no_encoded_output() {
        let node = x_core::Node::rect("r", 0.0, 0.0, 10.0, 10.0, Color::WHITE);
        let tree = crate::build_render_tree(&node, &x_core::Variables::default());
        let result = export_raster_cancellable(
            &tree,
            10.0,
            10.0,
            RasterFormat::Png,
            1.0,
            None,
            None,
            None,
            &|| true,
        );
        assert!(result.unwrap_err().contains("cancelled"));
    }
}

// ------------------------------------------------------- export optimizer

/// Re-encode a raster (PNG/JPEG/WebP input) as an optimized PNG: RGBA,
/// max compression + adaptive row filters; and when `max_dim` is given,
/// Lanczos-downscale first. Never grows the file when only recompressing
/// (falls back to the original bytes if that loses), and returns the
/// original bytes untouched on any decode failure — optimization must not
/// be able to break an export.
pub fn optimize_png(data: &[u8], max_dim: Option<u32>) -> Result<Vec<u8>, String> {
    let img = match image::load_from_memory(data) {
        Ok(i) => i.into_rgba8(),
        Err(_) => return Ok(data.to_vec()),
    };
    let (w, h) = (img.width(), img.height());
    let mut img = img;
    if let Some(m) = max_dim {
        if w.max(h) > m && m > 0 {
            let (nw, nh) = if w >= h {
                (
                    m,
                    ((m as f64 * h as f64 / w as f64).round().max(1.0)) as u32,
                )
            } else {
                (
                    ((m as f64 * w as f64 / h as f64).round().max(1.0)) as u32,
                    m,
                )
            };
            img = image::imageops::resize(&img, nw, nh, image::imageops::FilterType::Lanczos3);
        }
    }
    let (w2, h2) = (img.width(), img.height());
    let mut out: Vec<u8> = Vec::new();
    let enc = image::codecs::png::PngEncoder::new_with_quality(
        &mut out,
        image::codecs::png::CompressionType::Best,
        image::codecs::png::FilterType::Adaptive,
    );
    image::ImageEncoder::write_image(enc, img.as_raw(), w2, h2, image::ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    let _ = (w, h);
    if max_dim.is_none() && out.len() >= data.len() {
        return Ok(data.to_vec());
    }
    Ok(out)
}

/// Total bytes saved by `optimize_png` over a batch (for export reports).
pub fn optimize_images(
    files: Vec<(String, Vec<u8>)>,
    max_dim: Option<u32>,
) -> Vec<(String, Vec<u8>)> {
    files
        .into_iter()
        .map(|(name, bytes)| {
            let is_png = bytes.starts_with(&[0x89, b'P', b'N', b'G']);
            if is_png {
                match optimize_png(&bytes, max_dim) {
                    Ok(o) => (name, o),
                    Err(_) => (name, bytes),
                }
            } else {
                (name, bytes)
            }
        })
        .collect()
}

#[cfg(test)]
mod optimize_tests {
    use super::*;
    #[test]
    fn optimize_png_roundtrip() {
        let mut pm = tiny_skia::Pixmap::new(64, 48).unwrap();
        for y in 0..48u32 {
            for x in 0..64u32 {
                pm.pixels_mut()[y as usize * 64 + x as usize] =
                    tiny_skia::PremultipliedColorU8::from_rgba(
                        (x * 4) as u8,
                        (y * 5) as u8,
                        128,
                        255,
                    )
                    .unwrap();
            }
        }
        let png = pm.encode_png().unwrap();
        let opt = optimize_png(&png, None).unwrap();
        let back = image::load_from_memory(&opt).unwrap();
        assert_eq!((back.width(), back.height()), (64, 48));
        let small = optimize_png(&png, Some(16)).unwrap();
        let back2 = image::load_from_memory(&small).unwrap();
        assert_eq!((back2.width(), back2.height()), (16, 12));
        // garbage input passes through untouched
        assert_eq!(
            optimize_png(b"not a png", None).unwrap(),
            b"not a png".to_vec()
        );
    }
}
