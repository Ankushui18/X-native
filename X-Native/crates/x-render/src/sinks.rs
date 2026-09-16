//! IR consumers beyond the live canvas (the payoff list):
//! - ThumbnailSink: fixed-size raster previews of any page (CPU-side
//!   scene, caller rasterizes via wgpu or uses bounds-only mode)
//! - PdfSink: RenderCommands -> minimal but valid PDF (print/export)
//! - SceneCache: keyed re-encode avoidance + damage rectangles from
//!   changed_keys (cached rendering / partial redraw)

use crate::ir::{RenderCommand, RenderTree, VelloSink};
use vello::kurbo::{Affine, Rect, Shape};
use vello::peniko::Brush;
use vello::Scene;
use x_core::*;

// ---------------------------------------------------------------- thumbnail

/// Scene scaled to fit a WxH thumbnail box (for pages panel, file browser,
/// minimap). Pure IR -> no document access needed.
pub fn thumbnail_scene(
    tree: &RenderTree,
    page_w: f64,
    page_h: f64,
    thumb_w: f64,
    thumb_h: f64,
) -> (Scene, f64) {
    let scale = (thumb_w / page_w.max(1.0)).min(thumb_h / page_h.max(1.0));
    let sink = VelloSink {
        assets: None,
        fonts: None,
    };
    let full = sink.render(tree);
    let mut out = Scene::new();
    out.append(&full, Some(Affine::scale(scale)));
    (out, scale)
}

// --------------------------------------------------------------------- pdf

/// Minimal valid single-page PDF from RenderCommands. Fills/strokes of
/// rects+paths and text (as text ops with core font). Good enough for
/// print/handoff; a full PDF lib can swap in behind the same call.
pub fn export_pdf(tree: &RenderTree, page_w: f64, page_h: f64) -> Vec<u8> {
    export_pdf_full(tree, page_w, page_h, None, None)
}

pub fn export_pdf_with_assets(
    tree: &RenderTree,
    page_w: f64,
    page_h: f64,
    assets: Option<&crate::Assets>,
) -> Vec<u8> {
    export_pdf_full(tree, page_w, page_h, assets, None)
}

/// PDF export with real image XObjects (uncompressed DeviceRGB 8-bit,
/// fit-mode CTMs matching the canvas sink) and — when `fonts` is given —
/// TEXT PARITY: glyphs are emitted as filled bezier outlines from the
/// same `node_text_outlines` pipeline the canvas uses (shaping, BiDi,
/// fallback, wrapping), so text placement is identical by construction.
/// Without fonts, falls back to Helvetica Tj text ops.
pub fn export_pdf_full(
    tree: &RenderTree,
    page_w: f64,
    page_h: f64,
    assets: Option<&crate::Assets>,
    fonts: Option<&x_text::FontManager>,
) -> Vec<u8> {
    let outlined = fonts.and_then(|f| crate::text_geometry::outline_text(tree, f).ok());
    let tree = outlined.as_ref().unwrap_or(tree);
    let mut content = String::new();
    let mut images: Vec<(String, vello::peniko::ImageBrush)> = vec![];
    let mut shadings: Vec<String> = vec![];
    // /PN pattern dicts (PatternType 2) wrapping shading /ShM for gradient
    // strokes; entries are indices into `shadings`
    let mut patterns: Vec<usize> = vec![];
    // PDF y-axis is bottom-up: flip
    content.push_str(&format!("1 0 0 -1 0 {page_h} cm\n"));
    for cmd in &tree.commands {
        match cmd {
            RenderCommand::FillPath {
                transform,
                path,
                brush,
                ..
            } => {
                if let Brush::Gradient(grad) = brush {
                    if let Some(sh) = shading_for(grad, transform) {
                        // clip to the path, paint the shading (sh op)
                        let idx = shadings.len();
                        shadings.push(sh);
                        content.push_str("q\n");
                        emit_path(&mut content, transform, path);
                        content.push_str(&format!("W n /Sh{idx} sh\nQ\n"));
                        continue;
                    }
                }
                let (r, g, b) = brush_rgb(brush);
                content.push_str(&format!("{r} {g} {b} rg\n"));
                emit_path(&mut content, transform, path);
                content.push_str("f\n");
            }
            RenderCommand::StrokePath {
                transform,
                path,
                brush,
                width,
                ..
            } => {
                if let Brush::Gradient(grad) = brush {
                    // gradient stroke: PDF can't stroke with a raw shading,
                    // so wrap it in a PatternType 2 (shading) pattern and
                    // stroke in the Pattern color space — same geometry as
                    // the fill path above
                    if let Some(sh) = shading_for(grad, transform) {
                        let idx = shadings.len();
                        shadings.push(sh);
                        patterns.push(idx);
                        content.push_str(&format!(
                            "/Pattern cs /P{} SCN {width} w\n",
                            patterns.len() - 1
                        ));
                        emit_path(&mut content, transform, path);
                        content.push_str("S\n");
                        continue;
                    }
                }
                let (r, g, b) = brush_rgb(brush);
                content.push_str(&format!("{r} {g} {b} RG {width} w\n"));
                emit_path(&mut content, transform, path);
                content.push_str("S\n");
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
                runs,
                ..
            } => {
                // TEXT PARITY: shaped glyph outlines via the exact canvas
                // pipeline when a FontManager is available.
                let mut drew = false;
                if let Some(fm) = fonts {
                    let nat =
                        x_text::resolve_natural_line_height(fm, font.as_deref(), *size).max(0.1);
                    let lh = match *lh_mode {
                        1 => (*lh_value).max(1.0) / nat,
                        2 => ((*lh_value) / 100.0 * *size / nat).max(0.1),
                        _ => *line_height,
                    };
                    // rich runs: per-glyph fill color — the shaped
                    // TRANSPARENT marker means "no explicit color" and
                    // falls back to the command brush (incl. gradients)
                    if !runs.is_empty() {
                        if let Some((glyphs, _)) = x_text::node_text_outlines_rich(
                            fm,
                            runs,
                            *size,
                            *max_width,
                            font.as_deref(),
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
                        ) {
                            for gl in glyphs {
                                let full = *transform * gl.transform;
                                let explicit = gl.color.components[3] > 0.0;
                                if !explicit {
                                    if let Brush::Gradient(grad) = brush {
                                        if let Some(sh) = shading_for(grad, transform) {
                                            let idx = shadings.len();
                                            shadings.push(sh);
                                            content.push_str("q\n");
                                            emit_path(&mut content, &full, &gl.path);
                                            content.push_str(&format!("W n /Sh{idx} sh\nQ\n"));
                                            continue;
                                        }
                                    }
                                }
                                let (r, g, b) = if explicit {
                                    pdf_rgb(gl.color)
                                } else {
                                    brush_rgb(brush)
                                };
                                content.push_str(&format!("{r} {g} {b} rg\n"));
                                emit_path(&mut content, &full, &gl.path);
                                content.push_str("f\n");
                            }
                            drew = true;
                        }
                    } else if let Some((glyphs, _)) = x_text::node_text_outlines_styled(
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
                    ) {
                        for gl in glyphs {
                            // full transform = node world * glyph local;
                            // the global top-down flip is already the CTM.
                            let full = *transform * gl.transform;
                            if let Brush::Gradient(grad) = brush {
                                if let Some(sh) = shading_for(grad, transform) {
                                    let idx = shadings.len();
                                    shadings.push(sh);
                                    content.push_str("q\n");
                                    emit_path(&mut content, &full, &gl.path);
                                    content.push_str(&format!("W n /Sh{idx} sh\nQ\n"));
                                }
                            } else {
                                let (r, g, b) = brush_rgb(brush);
                                content.push_str(&format!("{r} {g} {b} rg\n"));
                                emit_path(&mut content, &full, &gl.path);
                                content.push_str("f\n");
                            }
                        }
                        drew = true;
                    }
                }
                if !drew {
                    let (r, g, b) = brush_rgb(brush);
                    let t = transform.as_coeffs();
                    // undo the global flip locally for upright text
                    let x = t[4];
                    let y = page_h - t[5] - size * 0.8;
                    let esc = text
                        .replace('\\', r"\\")
                        .replace('(', r"\(")
                        .replace(')', r"\)");
                    content.push_str(&format!(
                        "q 1 0 0 -1 0 {page_h} cm BT /F1 {size} Tf {r} {g} {b} rg 1 0 0 1 {x} {y} Tm ({esc}) Tj ET Q\n"));
                }
            }
            RenderCommand::PushClip {
                transform, path, ..
            } => {
                // graphics state + clip path: q <path> W n
                content.push_str("q\n");
                emit_path(&mut content, transform, path);
                content.push_str("W n\n");
            }
            // blend layers: no PDF blend in the minimal sink, but the state
            // stack must stay balanced with the matching PopLayer's Q
            RenderCommand::PushLayer { .. } => content.push_str("q\n"),
            RenderCommand::PopLayer => content.push_str("Q\n"),
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
                    .and_then(|adj| assets.and_then(|a| a.get_adjusted(asset, *adj)));
                if let Some(img) = adjusted
                    .as_ref()
                    .or_else(|| assets.and_then(|a| a.get(asset)))
                {
                    let image_key = if let Some(adj) = adjustments {
                        format!("{asset}#adjusted:{adj:?}")
                    } else {
                        asset.clone()
                    };
                    let idx = match images.iter().position(|(n, _)| n == &image_key) {
                        Some(i) => i,
                        None => {
                            images.push((image_key, img.clone()));
                            images.len() - 1
                        }
                    };
                    // CANONICAL image transform model: identical draw
                    // affines to the canvas sink; this sink only converts
                    // each image-pixel-space affine to a PDF CTM. A PDF
                    // image is a UNIT square, so append pixel->unit
                    // scaling with a y-flip (image data is top-down).
                    let (iw, ih) = (img.image.width as f64, img.image.height as f64);
                    let resolved = x_core::resolve_image_placement(*fit, placement, *w, *h, iw, ih);
                    let image_transform = *transform
                        * Affine::translate((*w / 2.0, *h / 2.0))
                        * Affine::rotate(rotation.to_radians())
                        * Affine::translate((-*w / 2.0, -*h / 2.0));
                    let t = image_transform.as_coeffs(); // node world (page is already y-flipped)
                    content.push_str("q\n");
                    content.push_str(&format!(
                        "{} {} {} {} {} {} cm\n",
                        t[0], t[1], t[2], t[3], t[4], t[5]
                    ));
                    content.push_str(&format!("0 0 {w} {h} re W n\n"));
                    for draw in &resolved.draws {
                        // pixel-space -> unit-square: scale(iw, ih) then
                        // flip y because PDF unit images are bottom-up
                        let m = *draw
                            * Affine::translate((0.0, ih))
                            * Affine::scale_non_uniform(iw, -ih);
                        let c = m.as_coeffs();
                        content.push_str("q\n");
                        content.push_str(&format!(
                            "{} {} {} {} {} {} cm\n",
                            c[0], c[1], c[2], c[3], c[4], c[5]
                        ));
                        content.push_str(&format!("/Im{idx} Do\nQ\n"));
                    }
                    content.push_str("Q\n");
                }
            }
        }
    }
    build_pdf_with_images(&content, page_w, page_h, &images, &shadings, &patterns)
}

/// PDF DeviceRGB is an encoded sRGB boundary. Convert through the byte
/// representation explicitly rather than relying on the color component
/// storage type's interpretation.
fn pdf_rgb(c: vello::peniko::Color) -> (f64, f64, f64) {
    let rgba = c.to_rgba8();
    (
        f64::from(rgba.r) / 255.0,
        f64::from(rgba.g) / 255.0,
        f64::from(rgba.b) / 255.0,
    )
}

fn brush_rgb(b: &Brush) -> (f64, f64, f64) {
    match b {
        Brush::Solid(c) => pdf_rgb(*c),
        Brush::Gradient(g) => g
            .stops
            .first()
            .map(|s| pdf_rgb(s.color.to_alpha_color()))
            .unwrap_or((0.0, 0.0, 0.0)),
        _ => (0.0, 0.0, 0.0),
    }
}

fn emit_path(out: &mut String, transform: &Affine, path: &vello::kurbo::BezPath) {
    use vello::kurbo::PathEl::*;
    let mut cur = (0.0f64, 0.0f64); // current point (transformed), for quad->cubic
    for el in path.elements() {
        match el {
            MoveTo(p) => {
                let p = *transform * *p;
                cur = (p.x, p.y);
                out.push_str(&format!("{:.2} {:.2} m\n", p.x, p.y));
            }
            LineTo(p) => {
                let p = *transform * *p;
                cur = (p.x, p.y);
                out.push_str(&format!("{:.2} {:.2} l\n", p.x, p.y));
            }
            CurveTo(a, b, c) => {
                let (a, b, c) = (*transform * *a, *transform * *b, *transform * *c);
                cur = (c.x, c.y);
                out.push_str(&format!(
                    "{:.2} {:.2} {:.2} {:.2} {:.2} {:.2} c\n",
                    a.x, a.y, b.x, b.y, c.x, c.y
                ));
            }
            QuadTo(q, p) => {
                // exact quad -> cubic: c1 = p0 + 2/3(q-p0), c2 = p + 2/3(q-p).
                // (The old "use q for both controls" shortcut visibly fattens
                // curves — caught by the text-parity RMSE once glyph outlines,
                // which are quad-heavy TrueType curves, started flowing here.)
                let (q, p) = (*transform * *q, *transform * *p);
                let c1 = (
                    cur.0 + 2.0 / 3.0 * (q.x - cur.0),
                    cur.1 + 2.0 / 3.0 * (q.y - cur.1),
                );
                let c2 = (p.x + 2.0 / 3.0 * (q.x - p.x), p.y + 2.0 / 3.0 * (q.y - p.y));
                cur = (p.x, p.y);
                out.push_str(&format!(
                    "{:.2} {:.2} {:.2} {:.2} {:.2} {:.2} c\n",
                    c1.0, c1.1, c2.0, c2.1, p.x, p.y
                ));
            }
            ClosePath => out.push_str("h\n"),
        }
    }
}

/// PDF shading dictionary body for a peniko gradient, transformed to page
/// space. Type 2 (axial) / Type 3 (radial); multi-stop via a stitching
/// Type 3 function over Type 2 exponential segments. None for sweep.
fn shading_for(g: &vello::peniko::Gradient, transform: &Affine) -> Option<String> {
    use vello::peniko::GradientKind;
    if g.stops.is_empty() {
        return None;
    }
    let stop_color = |i: usize| -> (f64, f64, f64) { pdf_rgb(g.stops[i].color.to_alpha_color()) };
    // color function over the whole 0..1 domain
    let func = if g.stops.len() == 1 {
        let (r, gr, b) = stop_color(0);
        format!("<< /FunctionType 2 /Domain [0 1] /C0 [{r} {gr} {b}] /C1 [{r} {gr} {b}] /N 1 >>")
    } else if g.stops.len() == 2 {
        let (r0, g0, b0) = stop_color(0);
        let (r1, g1, b1) = stop_color(1);
        format!(
            "<< /FunctionType 2 /Domain [0 1] /C0 [{r0} {g0} {b0}] /C1 [{r1} {g1} {b1}] /N 1 >>"
        )
    } else {
        // stitching function over the interior stop offsets
        let n = g.stops.len();
        let mut funcs = String::new();
        for i in 0..n - 1 {
            let (r0, g0, b0) = stop_color(i);
            let (r1, g1, b1) = stop_color(i + 1);
            funcs.push_str(&format!("<< /FunctionType 2 /Domain [0 1] /C0 [{r0} {g0} {b0}] /C1 [{r1} {g1} {b1}] /N 1 >> "));
        }
        let bounds: Vec<String> = g.stops[1..n - 1]
            .iter()
            .map(|s| format!("{}", s.offset))
            .collect();
        let encode = "0 1 ".repeat(n - 1);
        format!(
            "<< /FunctionType 3 /Domain [0 1] /Functions [{funcs}] /Bounds [{}] /Encode [{}] >>",
            bounds.join(" "),
            encode.trim_end()
        )
    };
    match g.kind {
        GradientKind::Linear(vello::peniko::LinearGradientPosition { start, end }) => {
            let s = *transform * vello::kurbo::Point::new(start.x, start.y);
            let e = *transform * vello::kurbo::Point::new(end.x, end.y);
            Some(format!(
                "<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [{} {} {} {}] /Function {func} /Extend [true true] >>",
                s.x, s.y, e.x, e.y))
        }
        GradientKind::Radial(vello::peniko::RadialGradientPosition {
            start_center,
            start_radius,
            end_center,
            end_radius,
        }) => {
            let c0 = *transform * vello::kurbo::Point::new(start_center.x, start_center.y);
            let c1 = *transform * vello::kurbo::Point::new(end_center.x, end_center.y);
            // scale radii by the transform's average scale factor
            let co = transform.as_coeffs();
            let sc = ((co[0] * co[0] + co[1] * co[1]).sqrt()
                + (co[2] * co[2] + co[3] * co[3]).sqrt())
                / 2.0;
            Some(format!(
                "<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [{} {} {} {} {} {}] /Function {func} /Extend [true true] >>",
                c0.x, c0.y, start_radius as f64 * sc, c1.x, c1.y, end_radius as f64 * sc))
        }
        GradientKind::Sweep(_) => None,
    }
}

fn build_pdf_with_images(
    content: &str,
    w: f64,
    h: f64,
    images: &[(String, vello::peniko::ImageBrush)],
    shadings: &[String],
    patterns: &[usize],
) -> Vec<u8> {
    let stream = content.as_bytes();
    let mut pdf: Vec<u8> = Vec::new();
    let mut offsets: Vec<usize> = vec![];
    let push = |pdf: &mut Vec<u8>, s: &str| pdf.extend_from_slice(s.as_bytes());
    push(&mut pdf, "%PDF-1.4\n");
    // object numbering: 1 catalog, 2 pages, 3 page, 4 content, 5 font,
    // 6..6+N image XObjects, then M shading dicts
    let n_img = images.len();
    let ximgs: String = (0..n_img)
        .map(|i| format!("/Im{i} {} 0 R ", 6 + i))
        .collect();
    let xshs: String = (0..shadings.len())
        .map(|i| format!("/Sh{i} {} 0 R ", 6 + n_img + i))
        .collect();
    // pattern dicts come after the shading objects in the numbering
    let xpats: String = (0..patterns.len())
        .map(|i| format!("/P{i} {} 0 R ", 6 + n_img + shadings.len() + i))
        .collect();
    let xobj = if images.is_empty() {
        String::new()
    } else {
        format!("/XObject << {ximgs}>> ")
    };
    let shd = if shadings.is_empty() {
        String::new()
    } else {
        format!("/Shading << {xshs}>> ")
    };
    let pat = if patterns.is_empty() {
        String::new()
    } else {
        format!("/Pattern << {xpats}>> ")
    };
    let head = [
        "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n".to_string(),
        "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n".to_string(),
        format!("3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 {w} {h}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> {xobj}{shd}{pat}>> >> endobj\n"),
        format!("4 0 obj << /Length {} >> stream\n{}\nendstream endobj\n", stream.len(), content),
        "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n".to_string(),
    ];
    for o in &head {
        offsets.push(pdf.len());
        push(&mut pdf, o);
    }
    // image XObjects: strip alpha -> DeviceRGB, FlateDecode-compressed
    // (was uncompressed — the third review item)
    for (i, (_, img)) in images.iter().enumerate() {
        offsets.push(pdf.len());
        let rgba = img.image.data.data();
        let mut rgb = Vec::with_capacity(rgba.len() / 4 * 3);
        for px in rgba.chunks(4) {
            rgb.extend_from_slice(&px[..3]);
        }
        let compressed = miniz_oxide::deflate::compress_to_vec_zlib(&rgb, 6);
        push(&mut pdf, &format!(
            "{} 0 obj << /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length {} >> stream\n",
            6 + i, img.image.width, img.image.height, compressed.len()));
        pdf.extend_from_slice(&compressed);
        push(&mut pdf, "\nendstream endobj\n");
    }
    // gradient shading dictionaries
    for (i, sh) in shadings.iter().enumerate() {
        offsets.push(pdf.len());
        push(&mut pdf, &format!("{} 0 obj {sh} endobj\n", 6 + n_img + i));
    }
    // shading patterns for gradient STROKES: /PN wraps /ShM (PatternType 2,
    // identity matrix — the shading coords are already device-space)
    for (i, sh_idx) in patterns.iter().enumerate() {
        offsets.push(pdf.len());
        push(
            &mut pdf,
            &format!(
                "{} 0 obj << /PatternType 2 /Shading /Sh{sh_idx} 0 R >> endobj\n",
                6 + n_img + shadings.len() + i
            ),
        );
    }
    let total = 6 + n_img + shadings.len() + patterns.len();
    let xref_at = pdf.len();
    push(&mut pdf, &format!("xref\n0 {total}\n0000000000 65535 f \n"));
    for off in &offsets {
        push(&mut pdf, &format!("{off:010} 00000 n \n"));
    }
    push(
        &mut pdf,
        &format!("trailer << /Size {total} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n"),
    );
    pdf
}

// ------------------------------------------------------------------- cache

/// Cached rendering: keeps the last tree + scene; re-encodes only when
/// commands changed, and reports damage rects for partial redraw.
#[derive(Default)]
pub struct SceneCache {
    last: Option<RenderTree>,
    scene: Option<Scene>,
    pub encode_count: usize,
}

impl SceneCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns (scene, damage). Damage None = full redraw (first frame),
    /// Some(vec![]) = nothing changed (cache hit, no re-encode),
    /// Some(rects) = partial damage.
    pub fn render(&mut self, tree: RenderTree, sink: &VelloSink) -> (&Scene, Option<Vec<Rect>>) {
        let damage = match &self.last {
            None => None,
            Some(old) => {
                let changed = tree.changed_keys(old);
                if changed.is_empty() && old.commands.len() == tree.commands.len() {
                    self.last = Some(tree);
                    return (self.scene.as_ref().unwrap(), Some(vec![]));
                }
                // damage = union of old+new bounds of every changed key
                let mut rects = vec![];
                for key in &changed {
                    for t in [old, &tree] {
                        for cmd in &t.commands {
                            if cmd.key() == key {
                                if let Some(b) = command_bounds(cmd) {
                                    rects.push(b);
                                }
                            }
                        }
                    }
                }
                Some(rects)
            }
        };
        self.encode_count += 1;
        self.scene = Some(sink.render(&tree));
        self.last = Some(tree);
        (self.scene.as_ref().unwrap(), damage)
    }
}

fn command_bounds(cmd: &RenderCommand) -> Option<Rect> {
    match cmd {
        RenderCommand::FillPath {
            transform, path, ..
        }
        | RenderCommand::StrokePath {
            transform, path, ..
        } => Some(transform.transform_rect_bbox(path.bounding_box())),
        RenderCommand::Glyphs {
            transform,
            size,
            max_width,
            ..
        } => Some(transform.transform_rect_bbox(Rect::new(0.0, 0.0, *max_width, size * 1.4))),
        RenderCommand::Image {
            transform,
            w,
            h,
            rotation,
            ..
        } => {
            let image_transform = *transform
                * Affine::translate((*w / 2.0, *h / 2.0))
                * Affine::rotate(rotation.to_radians())
                * Affine::translate((-*w / 2.0, -*h / 2.0));
            Some(image_transform.transform_rect_bbox(Rect::new(0.0, 0.0, *w, *h)))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::build_render_tree;

    fn doc() -> (Node, Variables) {
        let d = Node::frame("page", 400.0, 300.0)
            .child(Node::rect(
                "a",
                10.0,
                10.0,
                100.0,
                60.0,
                Color::from_rgb8(255, 0, 0),
            ))
            .child(Node::rect(
                "b",
                200.0,
                100.0,
                80.0,
                40.0,
                Color::from_rgb8(0, 0, 255),
            ))
            .child(Node::text("t", 10.0, 200.0, 200.0, 20.0, "hello"));
        (d, Variables::default())
    }

    #[test]
    fn thumbnails_scale_to_fit() {
        let (d, v) = doc();
        let tree = build_render_tree(&d, &v);
        let (scene, scale) = thumbnail_scene(&tree, 400.0, 300.0, 100.0, 100.0);
        assert!((scale - 0.25).abs() < 1e-9); // limited by width: 100/400
        assert!(scene.encoding().n_paths > 0);
    }

    #[test]
    fn pdf_export_produces_valid_structure() {
        let (d, v) = doc();
        let tree = build_render_tree(&d, &v);
        let pdf = export_pdf(&tree, 400.0, 300.0);
        let s = String::from_utf8_lossy(&pdf);
        assert!(s.starts_with("%PDF-1.4"));
        assert!(s.contains("%%EOF"));
        assert!(s.contains("/MediaBox [0 0 400 300]"));
        assert!(s.contains(" rg\n"), "has fill colors");
        assert!(s.contains("(hello) Tj"), "has the text");
        assert!(s.contains("xref"));
    }

    #[test]
    fn scene_cache_skips_reencode_and_reports_damage() {
        let (d, v) = doc();
        let sink = VelloSink {
            assets: None,
            fonts: None,
        };
        let mut cache = SceneCache::new();
        // frame 1: full
        let (_, damage) = cache.render(build_render_tree(&d, &v), &sink);
        assert!(damage.is_none());
        assert_eq!(cache.encode_count, 1);
        // frame 2: identical -> cache hit, NO re-encode
        let (_, damage) = cache.render(build_render_tree(&d, &v), &sink);
        assert_eq!(damage, Some(vec![]));
        assert_eq!(cache.encode_count, 1, "must not re-encode unchanged frame");
        // frame 3: move node "a" -> damage covers old+new position only
        let mut d2 = d.clone();
        fn fm<'a>(n: &'a mut Node, id: &str) -> Option<&'a mut Node> {
            if n.id == id {
                return Some(n);
            }
            n.children.iter_mut().find_map(|c| fm(c, id))
        }
        fm(&mut d2, "a").unwrap().transform.x += 50.0;
        let (_, damage) = cache.render(build_render_tree(&d2, &v), &sink);
        assert_eq!(cache.encode_count, 2);
        let rects = damage.unwrap();
        assert!(!rects.is_empty());
        // all damage within the union of a's old (10..110) and new (60..160) x-range
        for r in &rects {
            assert!(
                r.x0 >= 9.0 && r.x1 <= 161.0,
                "damage rect {r:?} escaped the moved node"
            );
        }
    }
}

#[cfg(test)]
mod pdf_quality_tests {
    use super::*;
    use crate::ir::build_render_tree;

    #[test]
    fn rich_text_runs_paint_per_glyph_colors_in_pdf() {
        let mut fm = x_text::FontManager::new();
        assert!(fm.load_system_fonts() > 0);
        let mut t = Node::text("t", 10.0, 10.0, 200.0, 20.0, "Red ink");
        // explicit black fill: unstyled glyphs fall back to the command
        // brush = THE NODE'S fill (the Node::text default is #0d1220)
        t.fill = Paint::Solid(Color::from_rgb8(0, 0, 0));
        t.text_runs = vec![TextRun {
            start: 0,
            len: 3,
            color: Some(Color::from_rgb8(255, 0, 0)),
            size: None,
            font: None,
            weight: None,
            italic: None,
            ls: None,
        }];
        let d = Node::frame("page", 300.0, 100.0).child(t);
        let tree = build_render_tree(&d, &Variables::default());
        let pdf = export_pdf_full(&tree, 300.0, 100.0, None, Some(&fm));
        let txt = String::from_utf8_lossy(&pdf);
        assert!(
            txt.contains("1 0 0 rg"),
            "explicit run color painted per glyph"
        );
        assert!(
            txt.contains("0 0 0 rg"),
            "unstyled glyphs fall back to the command brush (black)"
        );
        // and no Helvetica Tj fallback for the shaped rich path
        assert!(!txt.contains("Tj"), "shaped outlines, not text ops");
    }

    #[test]
    fn vello_sink_renders_rich_text_runs() {
        let mut fm = x_text::FontManager::new();
        assert!(fm.load_system_fonts() > 0);
        let mut t = Node::text("t", 10.0, 10.0, 200.0, 20.0, "Big little");
        t.text_runs = vec![TextRun {
            start: 0,
            len: 3,
            color: Some(Color::from_rgb8(255, 0, 0)),
            size: Some(40.0),
            font: None,
            weight: None,
            italic: None,
            ls: None,
        }];
        let d = Node::frame("page", 300.0, 100.0).child(t);
        let tree = build_render_tree(&d, &Variables::default());
        let sink = VelloSink {
            assets: None,
            fonts: Some(&fm),
        };
        let scene = sink.render(&tree);
        assert!(
            scene.encoding().n_paths > 3,
            "rich glyphs drew as paths: {}",
            scene.encoding().n_paths
        );
    }

    #[test]
    fn pattern_fills_paint_clip_plus_image_in_pdf() {
        let mut assets = crate::Assets::new();
        let rgba: Vec<u8> = (0..4 * 4 * 4).map(|i| (i % 255) as u8).collect();
        let img = vello::peniko::ImageBrush {
            image: vello::peniko::ImageData {
                data: vello::peniko::Blob::from(rgba),
                format: vello::peniko::ImageFormat::Rgba8,
                alpha_type: vello::peniko::ImageAlphaType::Alpha,
                width: 4,
                height: 4,
            },
            sampler: Default::default(),
        };
        assets.insert_raw("pat", img);
        let d = Node::frame("page", 200.0, 100.0).child(
            Node::rect("r", 10.0, 10.0, 100.0, 50.0, Color::WHITE).fill_paint(Paint::Pattern {
                asset: "pat".into(),
                fit: ImageFit::Tile,
            }),
        );
        let tree = build_render_tree(&d, &Variables::default());
        let pdf = export_pdf_with_assets(&tree, 200.0, 100.0, Some(&assets));
        let txt = String::from_utf8_lossy(&pdf);
        assert!(txt.contains("W n"), "clip to the shape");
        assert!(txt.contains(" Do"), "image XObject drawn");
    }

    #[test]
    fn gradient_emits_shading_dict_not_flatten() {
        let doc = Node::frame("page", 200.0, 100.0).child(
            Node::rect("g", 10.0, 10.0, 100.0, 50.0, Color::WHITE).fill_paint(
                Paint::LinearGradient {
                    start: (0.0, 0.0),
                    end: (100.0, 0.0),
                    stops: vec![
                        (0.0, Color::from_rgb8(255, 0, 0)),
                        (0.5, Color::from_rgb8(0, 255, 0)),
                        (1.0, Color::from_rgb8(0, 0, 255)),
                    ],
                    space: x_core::GradSpace::Srgb,
                },
            ),
        );
        let tree = build_render_tree(&doc, &Variables::default());
        let pdf = export_pdf(&tree, 200.0, 100.0);
        let txt = String::from_utf8_lossy(&pdf);
        assert!(txt.contains("/ShadingType 2"), "axial shading present");
        assert!(
            txt.contains("/FunctionType 3"),
            "3 stops -> stitching function"
        );
        assert!(txt.contains(" sh\n"), "shading paint op used");
        assert!(txt.contains("/Shading <<"), "page resources expose it");
    }

    #[test]
    fn gradient_strokes_use_pattern_colorspace() {
        // PDF can't stroke with a raw shading — the sink wraps it in a
        // PatternType 2 pattern and strokes in the Pattern color space
        let doc = Node::frame("page", 200.0, 100.0).child(
            Node::rect("r", 10.0, 10.0, 100.0, 50.0, Color::WHITE).stroke(Stroke {
                paint: Paint::LinearGradient {
                    start: (0.0, 0.0),
                    end: (100.0, 0.0),
                    stops: vec![
                        (0.0, Color::from_rgb8(255, 0, 0)),
                        (1.0, Color::from_rgb8(0, 0, 255)),
                    ],
                    space: x_core::GradSpace::Srgb,
                },
                width: 4.0,
            }),
        );
        let tree = build_render_tree(&doc, &Variables::default());
        // the IR keeps the gradient (no flattening to a solid)
        assert!(
            tree.commands.iter().any(|c| matches!(
                c,
                RenderCommand::StrokePath {
                    brush: Brush::Gradient(_),
                    ..
                }
            )),
            "IR stroke is a gradient brush"
        );
        let pdf = export_pdf(&tree, 200.0, 100.0);
        let txt = String::from_utf8_lossy(&pdf);
        assert!(
            txt.contains("/Pattern cs /P0 SCN"),
            "strokes in the pattern color space"
        );
        assert!(
            txt.contains("/PatternType 2"),
            "shading pattern object present"
        );
        assert!(
            txt.contains("/Pattern <<"),
            "page resources expose the pattern"
        );
        assert!(
            txt.contains("/Shading /Sh0 0 R"),
            "pattern wraps the shading dict"
        );
    }

    #[test]
    fn radial_gradient_maps_to_type3() {
        let doc = Node::frame("page", 200.0, 200.0).child(
            Node::ellipse("r", 20.0, 20.0, 100.0, 100.0, Color::WHITE).fill_paint(
                Paint::RadialGradient {
                    center: (50.0, 50.0),
                    radius: 50.0,
                    stops: vec![(0.0, Color::WHITE), (1.0, Color::BLACK)],
                    space: x_core::GradSpace::Srgb,
                },
            ),
        );
        let tree = build_render_tree(&doc, &Variables::default());
        let pdf = export_pdf(&tree, 200.0, 200.0);
        let txt = String::from_utf8_lossy(&pdf);
        assert!(txt.contains("/ShadingType 3"), "radial shading present");
    }

    #[test]
    fn images_are_flate_compressed_and_tile_repeats() {
        let mut assets = crate::Assets::new();
        // 4x4 solid png via the png crate is overkill; feed raw RGBA through
        // the store-less path: build a tiny Image directly
        let rgba: Vec<u8> = (0..4 * 4 * 4).map(|i| (i % 255) as u8).collect();
        let img = vello::peniko::ImageBrush {
            image: vello::peniko::ImageData {
                data: vello::peniko::Blob::from(rgba),
                format: vello::peniko::ImageFormat::Rgba8,
                alpha_type: vello::peniko::ImageAlphaType::Alpha,
                width: 4,
                height: 4,
            },
            sampler: Default::default(),
        };
        assets.insert_raw("tiny", img);
        let mut n = Node::image("i", 0.0, 0.0, 16.0, 16.0, "tiny");
        if let NodeKind::Image { fit, .. } = &mut n.kind {
            *fit = ImageFit::Tile;
        }
        let doc = Node::frame("page", 100.0, 100.0).child(n);
        let tree = build_render_tree(&doc, &Variables::default());
        let pdf = export_pdf_with_assets(&tree, 100.0, 100.0, Some(&assets));
        let txt = String::from_utf8_lossy(&pdf);
        assert!(
            txt.contains("/Filter /FlateDecode"),
            "image stream compressed"
        );
        // 16/4 = 4 tiles per axis -> 16 Do invocations
        assert_eq!(txt.matches("/Im0 Do").count(), 16, "real tiling, not crop");
    }
}

#[cfg(test)]
mod incremental_tests {
    use super::*;
    use crate::ir::build_render_tree;

    fn doc(n_rects: usize, moved: Option<(usize, f64)>) -> Node {
        let mut page = Node::frame("page", 2000.0, 2000.0);
        for i in 0..n_rects {
            let x = if moved == Some((i, 0.0)) {
                999.0
            } else {
                (i * 20) as f64
            } + moved
                .filter(|(mi, _)| *mi == i)
                .map(|(_, dx)| dx)
                .unwrap_or(0.0);
            page.children.push(Node::rect(
                &format!("r{i}"),
                x,
                10.0,
                15.0,
                15.0,
                Color::from_rgb8(50, 100, 200),
            ));
        }
        page
    }

    #[test]
    fn unchanged_frame_skips_encode_entirely() {
        let vars = Variables::default();
        let sink = VelloSink {
            assets: None,
            fonts: None,
        };
        let mut cache = SceneCache::new();
        let (_, d1) = cache.render(build_render_tree(&doc(500, None), &vars), &sink);
        assert!(d1.is_none(), "first frame = full encode");
        let n_enc = cache.encode_count;
        let (_, d2) = cache.render(build_render_tree(&doc(500, None), &vars), &sink);
        assert_eq!(d2, Some(vec![]), "identical frame = cache hit");
        assert_eq!(cache.encode_count, n_enc, "no re-encode happened");
    }

    #[test]
    fn moving_one_node_damages_one_region_not_the_world() {
        let vars = Variables::default();
        let sink = VelloSink {
            assets: None,
            fonts: None,
        };
        let mut cache = SceneCache::new();
        cache.render(build_render_tree(&doc(500, None), &vars), &sink);
        // move node 42 by 5px
        let (_, damage) = cache.render(build_render_tree(&doc(500, Some((42, 5.0))), &vars), &sink);
        let rects = damage.expect("incremental damage, not full redraw");
        assert!(
            !rects.is_empty() && rects.len() <= 4,
            "one moved node -> tiny damage set, got {}",
            rects.len()
        );
    }
}
