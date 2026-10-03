//! Portable SVG from the same resolved IR used by the canvas. Fonts are paths;
//! images are embedded once and reused. No user-provided XML or external URLs.
use std::collections::HashMap;
use vello::{
    kurbo::{Affine, Rect, Shape},
    peniko::{Brush, Color, GradientKind, Mix},
};
use x_core::AssetStore;
use x_render::{Assets, RenderCommand, RenderTree};

pub fn export_svg_ir(
    tree: &RenderTree,
    width: f64,
    height: f64,
    store: &AssetStore,
    assets: &Assets,
) -> Result<String, String> {
    let mut defs = String::new();
    let mut body = String::new();
    let mut next = 0usize;
    let mut depth = 0usize;
    let mut images: HashMap<String, String> = HashMap::new();
    for command in &tree.commands {
        x_format::cancellation::checkpoint()?;
        match command {
            RenderCommand::FillPath {
                transform,
                path,
                brush,
                ..
            } => {
                let paint = brush_attributes(brush, &mut defs, &mut next)?;
                body.push_str(&format!(
                    "<path transform=\"{}\" d=\"{}\" {paint}/>\n",
                    matrix(*transform),
                    path.to_svg()
                ));
            }
            RenderCommand::PushClip {
                transform, path, ..
            } => {
                next += 1;
                defs.push_str(&format!("<clipPath id=\"c{next}\" clipPathUnits=\"userSpaceOnUse\"><path transform=\"{}\" d=\"{}\"/></clipPath>\n", matrix(*transform), path.to_svg()));
                body.push_str(&format!("<g clip-path=\"url(#c{next})\">\n"));
                depth += 1;
            }
            RenderCommand::PushLayer {
                alpha, mix, bounds, ..
            } => {
                next += 1;
                defs.push_str(&format!("<clipPath id=\"c{next}\" clipPathUnits=\"userSpaceOnUse\"><path d=\"{}\"/></clipPath>\n", bounds.into_path(0.1).to_svg()));
                body.push_str(&format!("<g opacity=\"{alpha}\" style=\"mix-blend-mode:{}\" clip-path=\"url(#c{next})\">\n", blend_name(*mix)));
                depth += 1;
            }
            RenderCommand::PopLayer => {
                if depth == 0 {
                    return Err("unbalanced SVG layer stack".into());
                }
                depth -= 1;
                body.push_str("</g>\n");
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
                    .and_then(|adj| assets.get_adjusted(asset, *adj));
                let img = adjusted
                    .as_ref()
                    .or_else(|| assets.get(asset))
                    .ok_or_else(|| format!("missing decoded image {asset}"))?;
                let (iw, ih) = (img.image.width, img.image.height);
                let image_key = if let Some(adj) = adjustments {
                    format!("{asset}#adjusted:{adj:?}")
                } else {
                    asset.clone()
                };
                let image_id = if let Some(id) = images.get(&image_key) {
                    id.clone()
                } else {
                    let (mime, bytes) = if let Some(adjusted) = adjusted.as_ref() {
                        (
                            "image/png",
                            x_render::encode_rgba_png(
                                adjusted.image.width,
                                adjusted.image.height,
                                adjusted.image.data.data(),
                            )?,
                        )
                    } else {
                        let record = store
                            .get(asset)
                            .ok_or_else(|| format!("missing embedded image {asset}"))?;
                        if !matches!(record.mime.as_str(), "image/png" | "image/jpeg") {
                            return Err("SVG embedding supports PNG/JPEG only".into());
                        }
                        (record.mime.as_str(), record.bytes.clone())
                    };
                    next += 1;
                    let id = format!("im{next}");
                    defs.push_str(&format!("<image id=\"{id}\" width=\"{iw}\" height=\"{ih}\" href=\"data:{mime};base64,{}\"/>\n", x_format::base64(&bytes)));
                    images.insert(image_key, id.clone());
                    id
                };
                next += 1;
                defs.push_str(&format!("<clipPath id=\"c{next}\" clipPathUnits=\"userSpaceOnUse\"><path transform=\"{}\" d=\"{}\"/></clipPath>\n", matrix(*transform), Rect::new(0.0,0.0,*w,*h).into_path(0.1).to_svg()));
                body.push_str(&format!("<g clip-path=\"url(#c{next})\">\n"));
                let resolved =
                    x_core::resolve_image_placement(*fit, placement, *w, *h, iw.into(), ih.into());
                if resolved.draws.is_empty() {
                    return Err("image tiling exceeds render budget".into());
                }
                let image_transform = *transform
                    * Affine::translate((*w / 2.0, *h / 2.0))
                    * Affine::rotate(rotation.to_radians())
                    * Affine::translate((-*w / 2.0, -*h / 2.0));
                for draw in resolved.draws {
                    body.push_str(&format!(
                        "<use href=\"#{image_id}\" transform=\"{}\"/>\n",
                        matrix(image_transform * draw)
                    ));
                }
                body.push_str("</g>\n");
            }
            RenderCommand::Glyphs { .. } | RenderCommand::StrokePath { .. } => {
                return Err("SVG requires the prepared, outlined export plan".into())
            }
        }
        if defs.len() + body.len() > 128 * 1024 * 1024 {
            return Err("SVG exceeds the 128 MiB output budget".into());
        }
    }
    if depth != 0 {
        return Err("unbalanced SVG layer stack".into());
    }
    Ok(format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width}\" height=\"{height}\" viewBox=\"0 0 {width} {height}\"><defs>{defs}</defs>{body}</svg>\n"))
}

fn matrix(t: Affine) -> String {
    let [a, b, c, d, e, f] = t.as_coeffs();
    format!("matrix({a} {b} {c} {d} {e} {f})")
}
fn color(c: Color) -> (String, f32) {
    let c = c.to_rgba8();
    (
        format!("#{:02x}{:02x}{:02x}", c.r, c.g, c.b),
        f32::from(c.a) / 255.0,
    )
}
fn brush_attributes(brush: &Brush, defs: &mut String, next: &mut usize) -> Result<String, String> {
    match brush {
        Brush::Solid(c) => {
            let (c, a) = color(*c);
            Ok(format!("fill=\"{c}\" fill-opacity=\"{a}\""))
        }
        Brush::Gradient(g) => {
            *next += 1;
            let id = *next;
            let spread = match g.extend {
                vello::peniko::Extend::Pad => "pad",
                vello::peniko::Extend::Repeat => "repeat",
                vello::peniko::Extend::Reflect => "reflect",
            };
            let tag = match &g.kind {
                GradientKind::Linear(p) => {
                    defs.push_str(&format!("<linearGradient id=\"g{id}\" gradientUnits=\"userSpaceOnUse\" spreadMethod=\"{spread}\" x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\">",p.start.x,p.start.y,p.end.x,p.end.y));
                    "linearGradient"
                }
                GradientKind::Radial(p) => {
                    defs.push_str(&format!("<radialGradient id=\"g{id}\" gradientUnits=\"userSpaceOnUse\" spreadMethod=\"{spread}\" fx=\"{}\" fy=\"{}\" fr=\"{}\" cx=\"{}\" cy=\"{}\" r=\"{}\">",p.start_center.x,p.start_center.y,p.start_radius,p.end_center.x,p.end_center.y,p.end_radius));
                    "radialGradient"
                }
                GradientKind::Sweep(_) => return Err("sweep gradients need raster export".into()),
            };
            for stop in g.stops.iter() {
                let (c, a) = color(stop.color.to_alpha_color());
                defs.push_str(&format!(
                    "<stop offset=\"{}\" stop-color=\"{c}\" stop-opacity=\"{a}\"/>",
                    stop.offset
                ));
            }
            defs.push_str(&format!("</{tag}>\n"));
            Ok(format!("fill=\"url(#g{id})\""))
        }
        Brush::Image(_) => Err("unresolved image brush; use raster export".into()),
    }
}
fn blend_name(mix: Mix) -> &'static str {
    match mix {
        Mix::Normal => "normal",
        Mix::Multiply => "multiply",
        Mix::Screen => "screen",
        Mix::Overlay => "overlay",
        Mix::Darken => "darken",
        Mix::Lighten => "lighten",
        Mix::ColorDodge => "color-dodge",
        Mix::ColorBurn => "color-burn",
        Mix::HardLight => "hard-light",
        Mix::SoftLight => "soft-light",
        Mix::Difference => "difference",
        Mix::Exclusion => "exclusion",
        Mix::Hue => "hue",
        Mix::Saturation => "saturation",
        Mix::Color => "color",
        Mix::Luminosity => "luminosity",
    }
}
