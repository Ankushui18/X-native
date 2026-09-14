use crate::b64::base64;
#[allow(unused_imports)]
use crate::*;
use x_core::*;

/// Escape untrusted metadata for a quoted XML attribute (not a text node).
fn xml_attribute(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control())
        .map(|c| match c {
            '&' => "&amp;".into(),
            '"' => "&quot;".into(),
            '\'' => "&apos;".into(),
            '<' => "&lt;".into(),
            '>' => "&gt;".into(),
            _ => c.to_string(),
        })
        .collect()
}

// --------------------------------------------------------------- SVG export

/// Phase 7.6: export a node tree as standalone SVG. Rect/ellipse/line/text
/// (as vector strokes), gradients, opacity, rotation all map 1:1.
/// Asset resolver for image nodes: name -> raw PNG file bytes.
pub type SvgAssetResolver<'a> = &'a dyn Fn(&str) -> Option<Vec<u8>>;

/// Text outliner for text nodes (TEXT PARITY): given the resolved text
/// PARTS (plain text = one unstyled part), size, max_width and
/// font_binding, returns shaped glyph outlines as (SVG path data,
/// optional per-run color) — each path pre-positioned in node-local
/// coordinates. `None` color = "no explicit run color": the exporter
/// paints with the layer fill. Injected by the caller (the x_native
/// facade wires x-text's shaping pipeline in) because x-format must not
/// depend on x-text — the crate dependency graph is test-enforced.
pub type SvgTextOutliner<'a> = &'a dyn Fn(
    &[x_core::TextPart],
    f64,
    f64,
    Option<&str>,
    x_core::TextWrap,
) -> Option<Vec<(String, Option<Color>)>>;

pub fn export_svg(root: &Node, vars: &Variables) -> String {
    export_svg_full(root, vars, None, None)
}

pub fn export_svg_with_assets(
    root: &Node,
    vars: &Variables,
    assets: Option<SvgAssetResolver>,
) -> String {
    export_svg_full(root, vars, assets, None)
}

/// SVG export with embedded images (base64 data URIs; fit modes map to
/// preserveAspectRatio) and — when `text_outliner` is given — TEXT
/// PARITY: text nodes emit shaped glyph outline paths identical to the
/// canvas render instead of a `<text font-family="monospace">` guess.
pub fn export_svg_full(
    root: &Node,
    vars: &Variables,
    assets: Option<SvgAssetResolver>,
    text_outliner: Option<SvgTextOutliner>,
) -> String {
    let mut defs = String::new();
    let mut body = String::new();
    let mut grad_id = 0usize;
    // component registry: instances resolve to their master's children
    let mut registry: std::collections::HashMap<String, &Node> = Default::default();
    fn collect<'a>(n: &'a Node, reg: &mut std::collections::HashMap<String, &'a Node>) {
        if let NodeKind::Component { name } = &n.kind {
            reg.insert(name.clone(), n);
        }
        for c in &n.children {
            collect(c, reg);
        }
    }
    collect(root, &mut registry);
    svg_node(
        root,
        vars,
        &mut body,
        &mut defs,
        &mut grad_id,
        &registry,
        assets,
        text_outliner,
    );
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{}\" height=\"{}\" viewBox=\"0 0 {} {}\">\n<defs>\n{}</defs>\n{}</svg>\n",
        root.w, root.h, root.w, root.h, defs, body
    )
}

fn svg_fill(
    p: &Paint,
    vars: &Variables,
    defs: &mut String,
    grad_id: &mut usize,
    assets: Option<SvgAssetResolver>,
) -> String {
    if let Paint::Pattern { asset, fit } = p {
        // <pattern> def embedding the image as a data URI; tile size from
        // the PNG header. Without an asset resolver (no bytes) the fill
        // degrades to none — honest, and visible in the output.
        let stem = asset.trim_start_matches("asset://");
        let Some(bytes) = assets.and_then(|a| a(stem)) else {
            return "none".into();
        };
        let Some((iw, ih)) = crate::png_import::png_dimensions(&bytes) else {
            return "none".into();
        };
        *grad_id += 1;
        let id = format!("p{grad_id}");
        let b64 = base64(&bytes);
        // Tile repeats at natural size over the shape; Fill stretches one
        // copy across the bounding box.
        let units = if *fit == ImageFit::Tile {
            "userSpaceOnUse"
        } else {
            "objectBoundingBox"
        };
        let (pw, ph, iw_s, ih_s) = if *fit == ImageFit::Tile {
            (
                format!("{iw}"),
                format!("{ih}"),
                format!("{iw}"),
                format!("{ih}"),
            )
        } else {
            ("1".into(), "1".into(), "100%".into(), "100%".into())
        };
        defs.push_str(&format!("<pattern id=\"{id}\" patternUnits=\"{units}\" width=\"{pw}\" height=\"{ph}\"><image width=\"{iw_s}\" height=\"{ih_s}\" href=\"data:image/png;base64,{b64}\"/></pattern>\n"));
        return format!("url(#{id})");
    }
    match p {
        Paint::Solid(c) => {
            if c.components[3] == 0.0 {
                "none".into()
            } else {
                color_to_hex(*c)
            }
        }
        Paint::Variable(n) => color_to_hex(vars.color(n, Color::BLACK)),
        // unreachable: the early return above handles patterns
        Paint::Pattern { .. } => "none".into(),
        Paint::LinearGradient {
            start,
            end,
            stops,
            space,
        } => {
            *grad_id += 1;
            let id = format!("g{grad_id}");
            let stops = space.stops_for_render(stops);
            defs.push_str(&format!("<linearGradient id=\"{id}\" x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" gradientUnits=\"userSpaceOnUse\">", start.0, start.1, end.0, end.1));
            for (t, c) in stops.iter() {
                defs.push_str(&format!(
                    "<stop offset=\"{}\" stop-color=\"{}\"/>",
                    t,
                    color_to_hex(*c)
                ));
            }
            defs.push_str("</linearGradient>\n");
            format!("url(#{id})")
        }
        Paint::RadialGradient {
            center,
            radius,
            stops,
            space,
        } => {
            *grad_id += 1;
            let id = format!("g{grad_id}");
            let stops = space.stops_for_render(stops);
            defs.push_str(&format!("<radialGradient id=\"{id}\" cx=\"{}\" cy=\"{}\" r=\"{}\" gradientUnits=\"userSpaceOnUse\">", center.0, center.1, radius));
            for (t, c) in stops.iter() {
                defs.push_str(&format!(
                    "<stop offset=\"{}\" stop-color=\"{}\"/>",
                    t,
                    color_to_hex(*c)
                ));
            }
            defs.push_str("</radialGradient>\n");
            format!("url(#{id})")
        }
        // SVG has no conic/angular paint server. The honest degradation is a
        // solid fill of the first stop, and the loss is recorded in the
        // exported defs so a reader can see WHY the gradient disappeared.
        Paint::AngularGradient { stops, space, .. } => {
            let stops = space.stops_for_render(stops);
            defs.push_str(
                "<!-- angular gradient flattened to its first stop: \
SVG has no conic gradient -->\n",
            );
            stops
                .first()
                .map(|(_, c)| color_to_hex(*c))
                .unwrap_or_else(|| "none".into())
        }
        // A diamond is approximated by the radial gradient carrying its
        // larger radius (elliptical diamonds lose their aspect in SVG 1.1).
        Paint::DiamondGradient {
            center,
            width,
            height,
            stops,
            space,
        } => {
            *grad_id += 1;
            let id = format!("g{grad_id}");
            let stops = space.stops_for_render(stops);
            defs.push_str(&format!("<radialGradient id=\"{id}\" cx=\"{}\" cy=\"{}\" r=\"{}\" gradientUnits=\"userSpaceOnUse\">", center.0, center.1, width.max(*height)));
            for (t, c) in stops.iter() {
                defs.push_str(&format!(
                    "<stop offset=\"{}\" stop-color=\"{}\"/>",
                    t,
                    color_to_hex(*c)
                ));
            }
            defs.push_str("</radialGradient>\n");
            format!("url(#{id})")
        }
    }
}

/// SVG path-data for a command list, shifted by (dx, dy).
fn path_cmds_d(cmds: &[PathCmd], dx: f64, dy: f64) -> String {
    let mut d = String::new();
    for c in cmds {
        match c {
            PathCmd::MoveTo(x, y) => d.push_str(&format!("M {} {} ", x + dx, y + dy)),
            PathCmd::LineTo(x, y) => d.push_str(&format!("L {} {} ", x + dx, y + dy)),
            PathCmd::CurveTo(x1, y1, x2, y2, x, y) => d.push_str(&format!(
                "C {} {} {} {} {} {} ",
                x1 + dx,
                y1 + dy,
                x2 + dx,
                y2 + dy,
                x + dx,
                y + dy
            )),
            PathCmd::Close => d.push_str("Z "),
        }
    }
    d.trim_end().to_string()
}

fn mask_shape_svg(n: &Node) -> String {
    match &n.kind {
        NodeKind::Rect { radius } => format!(
            "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"{}\" fill=\"white\"/>",
            n.transform.x, n.transform.y, n.w, n.h, radius
        ),
        NodeKind::Ellipse => format!(
            "<ellipse cx=\"{}\" cy=\"{}\" rx=\"{}\" ry=\"{}\" fill=\"white\"/>",
            n.transform.x + n.w / 2.0,
            n.transform.y + n.h / 2.0,
            n.w / 2.0,
            n.h / 2.0
        ),
        NodeKind::Vector { path } => format!(
            "<path d=\"{}\" fill=\"white\"/>",
            path_cmds_d(path, n.transform.x, n.transform.y)
        ),
        NodeKind::Arc { start, end } => format!(
            "<path d=\"{}\" fill=\"white\"/>",
            path_cmds_d(
                &x_core::booleans::arc_path_cmds(n.w, n.h, *start, *end),
                n.transform.x,
                n.transform.y
            )
        ),
        _ => String::new(),
    }
}

fn svg_stroke_options(layer: &StrokeLayer) -> String {
    let cap = match layer.options.cap_start {
        StrokeCap::Round => "round",
        StrokeCap::Square => "square",
        _ => "butt",
    };
    let join = match layer.options.join {
        StrokeJoin::Round => "round",
        StrokeJoin::Bevel => "bevel",
        StrokeJoin::Miter => "miter",
    };
    let dash = if layer.options.dash.is_empty() {
        String::new()
    } else {
        format!(
            " stroke-dasharray=\"{}\" stroke-dashoffset=\"{}\"",
            layer
                .options
                .dash
                .iter()
                .map(|v| v.to_string())
                .collect::<Vec<_>>()
                .join(" "),
            layer.options.dash_offset
        )
    };
    format!(
        " stroke-linecap=\"{cap}\" stroke-linejoin=\"{join}\" stroke-miterlimit=\"{}\"{dash}",
        layer.options.miter_limit
    )
}
fn svg_blend(blend: BlendKind) -> &'static str {
    match blend {
        BlendKind::Normal => "",
        BlendKind::Darken => " style=\"mix-blend-mode:darken\"",
        BlendKind::Multiply => " style=\"mix-blend-mode:multiply\"",
        BlendKind::ColorBurn => " style=\"mix-blend-mode:color-burn\"",
        BlendKind::Lighten => " style=\"mix-blend-mode:lighten\"",
        BlendKind::Screen => " style=\"mix-blend-mode:screen\"",
        BlendKind::ColorDodge => " style=\"mix-blend-mode:color-dodge\"",
        BlendKind::Overlay => " style=\"mix-blend-mode:overlay\"",
        BlendKind::SoftLight => " style=\"mix-blend-mode:soft-light\"",
        BlendKind::HardLight => " style=\"mix-blend-mode:hard-light\"",
        BlendKind::Difference => " style=\"mix-blend-mode:difference\"",
        BlendKind::Exclusion => " style=\"mix-blend-mode:exclusion\"",
        BlendKind::Hue => " style=\"mix-blend-mode:hue\"",
        BlendKind::Saturation => " style=\"mix-blend-mode:saturation\"",
        BlendKind::Color => " style=\"mix-blend-mode:color\"",
        BlendKind::Luminosity => " style=\"mix-blend-mode:luminosity\"",
        BlendKind::PlusDarker => " style=\"mix-blend-mode:plus-darker\"",
        BlendKind::PlusLighter => " style=\"mix-blend-mode:plus-lighter\"",
        // CSS has no pass-through: a group that lets its children blend with
        // the backdrop exports as if it were normal (the children carry their
        // own mix-blend-mode).
        BlendKind::PassThrough => "",
    }
}

#[allow(clippy::too_many_arguments)]
fn svg_node(
    n: &Node,
    vars: &Variables,
    body: &mut String,
    defs: &mut String,
    grad_id: &mut usize,
    registry: &std::collections::HashMap<String, &Node>,
    assets: Option<SvgAssetResolver>,
    text_outliner: Option<SvgTextOutliner>,
) {
    if !n.visible {
        return;
    }
    let ox = n.transform.origin_x * n.w;
    let oy = n.transform.origin_y * n.h;
    let tf = if n.transform.skew_x == 0.0 && n.transform.skew_y == 0.0 {
        // no shear: use SVG's rotate-about-point shorthand (matches the
        // pivot-local chain translate(x+pivot)·rotate·translate(-pivot)).
        let mut t = format!("translate({} {})", n.transform.x, n.transform.y);
        if n.transform.rotation != 0.0 {
            t.push_str(&format!(
                " rotate({} {} {})",
                n.transform.rotation.to_degrees(),
                ox,
                oy
            ));
        }
        t
    } else {
        // shear present: express the full pivot-local chain explicitly so the
        // skew is applied about the origin (skew and translate don't commute).
        let mut t = format!("translate({} {})", n.transform.x + ox, n.transform.y + oy);
        if n.transform.rotation != 0.0 {
            t.push_str(&format!(" rotate({})", n.transform.rotation.to_degrees()));
        }
        if n.transform.skew_x != 0.0 {
            t.push_str(&format!(" skewX({})", n.transform.skew_x.to_degrees()));
        }
        if n.transform.skew_y != 0.0 {
            t.push_str(&format!(" skewY({})", n.transform.skew_y.to_degrees()));
        }
        t.push_str(&format!(" translate({} {})", -ox, -oy));
        t
    };
    let op = if n.opacity < 1.0 {
        format!(" opacity=\"{}\"", n.opacity)
    } else {
        String::new()
    };
    body.push_str(&format!("<g transform=\"{tf}\"{op}>"));
    match &n.kind {
        NodeKind::Rect { radius } => {
            let r = n.corner_radii.map(|c| c[0]).unwrap_or(*radius);
            for layer in n.active_fills() {
                let fill = svg_fill(&layer.paint, vars, defs, grad_id, assets);
                body.push_str(&format!(
                    "<rect width=\"{}\" height=\"{}\" rx=\"{}\" fill=\"{}\" opacity=\"{}\"{}/>",
                    n.w,
                    n.h,
                    r,
                    fill,
                    layer.opacity,
                    svg_blend(layer.blend)
                ));
            }
            for layer in n.active_strokes() {
                body.push_str(&format!("<rect width=\"{}\" height=\"{}\" rx=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" opacity=\"{}\"{}{}/>", n.w, n.h, r, svg_fill(&layer.stroke.paint, vars, defs, grad_id, assets), layer.stroke.width, layer.opacity, svg_blend(layer.blend), svg_stroke_options(&layer)));
            }
        }
        NodeKind::Ellipse => {
            for layer in n.active_fills() {
                let fill = svg_fill(&layer.paint, vars, defs, grad_id, assets);
                body.push_str(&format!("<ellipse cx=\"{}\" cy=\"{}\" rx=\"{}\" ry=\"{}\" fill=\"{}\" opacity=\"{}\"{}/>", n.w / 2.0, n.h / 2.0, n.w / 2.0, n.h / 2.0, fill, layer.opacity, svg_blend(layer.blend)));
            }
            for layer in n.active_strokes() {
                body.push_str(&format!("<ellipse cx=\"{}\" cy=\"{}\" rx=\"{}\" ry=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" opacity=\"{}\"{}{}/>", n.w / 2.0, n.h / 2.0, n.w / 2.0, n.h / 2.0, svg_fill(&layer.stroke.paint, vars, defs, grad_id, assets), layer.stroke.width, layer.opacity, svg_blend(layer.blend), svg_stroke_options(&layer)));
            }
        }
        NodeKind::Line => {
            for layer in n.active_strokes() {
                body.push_str(&format!("<line x1=\"0\" y1=\"0\" x2=\"{}\" y2=\"0\" stroke=\"{}\" stroke-width=\"{}\" opacity=\"{}\"{}{}/>", n.w, svg_fill(&layer.stroke.paint, vars, defs, grad_id, assets), layer.stroke.width.max(1.0), layer.opacity, svg_blend(layer.blend), svg_stroke_options(&layer)));
            }
        }
        NodeKind::Text { text } => {
            // TEXT PARITY: shaped glyph outlines when an outliner is
            // injected (identical geometry to the canvas render). Rich
            // runs resolve here — mixed per-run colors override the layer
            // fill per glyph path.
            let parts = x_core::resolve_text_parts(text, &n.text_runs);
            // PX CONTRACT: fs binding is real px; legacy nodes pre-scale the
            // em (h * 0.72) so exported geometry matches the canvas
            let text_px = n
                .bindings
                .get("fs")
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| *v > 0.0)
                .unwrap_or(n.h * 0.72);
            let outlines = text_outliner.and_then(|outline| {
                outline(
                    &parts,
                    text_px,
                    n.w,
                    n.bindings.get("font").map(String::as_str),
                    n.text_wrap(),
                )
            });
            for layer in n.active_fills() {
                let fill = svg_fill(&layer.paint, vars, defs, grad_id, assets);
                if let Some(entries) = &outlines {
                    for (d, run_color) in entries {
                        let path_fill = match run_color {
                            Some(c) => color_to_hex(*c),
                            None => fill.clone(),
                        };
                        body.push_str(&format!(
                            "<path d=\"{d}\" fill=\"{path_fill}\" opacity=\"{}\"{}/>",
                            layer.opacity,
                            svg_blend(layer.blend)
                        ));
                    }
                } else {
                    // rich text fallback: one <tspan> per styled run so
                    // bold/italic/size/color survive an SVG round-trip
                    // (resolve_text_parts — char-index runs, unified model).
                    let parts = x_core::resolve_text_parts(text, &n.text_runs);
                    let styled = parts.len() > 1
                        || parts.iter().any(|p| {
                            p.color.is_some()
                                || p.size.is_some()
                                || p.font.is_some()
                                || p.weight.unwrap_or(400) >= 600
                                || p.italic == Some(true)
                                || p.ls.is_some()
                        });
                    let esc_text = |t: &str| t.replace('&', "&amp;").replace('<', "&lt;");
                    if styled {
                        let base_size = n.h * 0.8;
                        let mut ts = format!("<text y=\"{}\" font-size=\"{}\" font-family=\"monospace\" fill=\"{}\" opacity=\"{}\"{}>", base_size, base_size, fill, layer.opacity, svg_blend(layer.blend));
                        for p in &parts {
                            let mut attrs = String::new();
                            if let Some(sz) = p.size {
                                attrs.push_str(&format!(" font-size=\"{}\"", sz * 0.8));
                            }
                            if let Some(f) = &p.font {
                                attrs.push_str(&format!(" font-family=\"{}\"", xml_attribute(f)));
                            }
                            if p.weight.unwrap_or(400) >= 600 {
                                attrs.push_str(" font-weight=\"bold\"");
                            }
                            if p.italic == Some(true) {
                                attrs.push_str(" font-style=\"italic\"");
                            }
                            if let Some(lsv) = p.ls {
                                attrs.push_str(&format!(" letter-spacing=\"{}\"", lsv));
                            }
                            if let Some(c) = p.color {
                                attrs.push_str(&format!(" fill=\"{}\"", color_to_hex(c)));
                            }
                            ts.push_str(&format!("<tspan{}>{}</tspan>", attrs, esc_text(&p.text)));
                        }
                        ts.push_str("</text>");
                        body.push_str(&ts);
                    } else {
                        body.push_str(&format!("<text y=\"{}\" font-size=\"{}\" font-family=\"monospace\" fill=\"{}\" opacity=\"{}\"{}>{}</text>", n.h * 0.8, n.h * 0.8, fill, layer.opacity, svg_blend(layer.blend), esc_text(text)));
                    }
                }
            }
        }
        NodeKind::Vector { path } => {
            let d = path_cmds_d(path, 0.0, 0.0);
            for layer in n.active_fills() {
                let fill = svg_fill(&layer.paint, vars, defs, grad_id, assets);
                body.push_str(&format!(
                    "<path d=\"{}\" fill=\"{}\" opacity=\"{}\"{}/>",
                    d.trim_end(),
                    fill,
                    layer.opacity,
                    svg_blend(layer.blend)
                ));
            }
            for layer in n.active_strokes() {
                body.push_str(&format!("<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" opacity=\"{}\"{}{}/>", d.trim_end(), svg_fill(&layer.stroke.paint, vars, defs, grad_id, assets), layer.stroke.width, layer.opacity, svg_blend(layer.blend), svg_stroke_options(&layer)));
            }
        }
        NodeKind::Section => {
            // labelled container: rounded rect fill + border + header text
            let r = n.corner_radii.map(|c| c[0]).unwrap_or(8.0);
            for layer in n.active_fills() {
                let fill = svg_fill(&layer.paint, vars, defs, grad_id, assets);
                body.push_str(&format!(
                    "<rect width=\"{}\" height=\"{}\" rx=\"{}\" fill=\"{}\" opacity=\"{}\"{}/>",
                    n.w,
                    n.h,
                    r,
                    fill,
                    layer.opacity,
                    svg_blend(layer.blend)
                ));
            }
            for layer in n.active_strokes() {
                body.push_str(&format!(
                    "<rect width=\"{}\" height=\"{}\" rx=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" opacity=\"{}\"{}{}/>",
                    n.w, n.h, r,
                    svg_fill(&layer.stroke.paint, vars, defs, grad_id, assets),
                    layer.stroke.width, layer.opacity, svg_blend(layer.blend),
                    svg_stroke_options(&layer)
                ));
            }
            let name = if n.name.is_empty() {
                "Section"
            } else {
                &n.name
            };
            body.push_str(&format!(
                "<text x=\"14\" y=\"28\" font-size=\"18\" font-family=\"sans-serif\" fill=\"#4b5563\">{}</text>",
                name.replace('&', "&amp;").replace('<', "&lt;")
            ));
        }
        // arc: same fill/stroke emission as a plain vector path
        NodeKind::Arc { start, end } => {
            let d = path_cmds_d(
                &x_core::booleans::arc_path_cmds(n.w, n.h, *start, *end),
                0.0,
                0.0,
            );
            for layer in n.active_fills() {
                let fill = svg_fill(&layer.paint, vars, defs, grad_id, assets);
                body.push_str(&format!(
                    "<path d=\"{}\" fill=\"{}\" opacity=\"{}\"{}/>",
                    d.trim_end(),
                    fill,
                    layer.opacity,
                    svg_blend(layer.blend)
                ));
            }
            for layer in n.active_strokes() {
                body.push_str(&format!("<path d=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" opacity=\"{}\"{}{}/>", d.trim_end(), svg_fill(&layer.stroke.paint, vars, defs, grad_id, assets), layer.stroke.width, layer.opacity, svg_blend(layer.blend), svg_stroke_options(&layer)));
            }
        }
        NodeKind::Image {
            asset,
            fit,
            placement,
        } => {
            // CANONICAL image transform model: identical resolution to the
            // canvas sink (x_core::resolve_image_placement) — the SVG gets
            // the exact same matrices, not a preserveAspectRatio guess.
            if let Some((bytes, iw, ih)) = assets
                .and_then(|r| r(asset))
                .and_then(|b| probe_dimensions(&b).map(|(w0, h0)| (b, w0 as f64, h0 as f64)))
            {
                let resolved = resolve_image_placement(*fit, placement, n.w, n.h, iw, ih);
                let b64 = base64(&bytes);
                *grad_id += 1;
                let clip = format!("imgclip{grad_id}");
                defs.push_str(&format!(
                    "<clipPath id=\"{clip}\"><rect width=\"{}\" height=\"{}\"/></clipPath>\n",
                    n.w, n.h
                ));
                body.push_str(&format!("<g clip-path=\"url(#{clip})\">"));
                for draw in &resolved.draws {
                    let c = draw.as_coeffs();
                    body.push_str(&format!(
                        "<image width=\"{iw}\" height=\"{ih}\" preserveAspectRatio=\"none\" transform=\"matrix({} {} {} {} {} {})\" href=\"data:image/png;base64,{b64}\"/>",
                        c[0], c[1], c[2], c[3], c[4], c[5]));
                }
                body.push_str("</g>");
            } else {
                // no resolver / unknown asset / undecodable header:
                // placeholder matches the canvas fallback
                body.push_str(&format!(
                    "<rect width=\"{}\" height=\"{}\" fill=\"#dddddd\"/>",
                    n.w, n.h
                ));
            }
        }
        NodeKind::Instance { component } => {
            // resolve to master content (matches the render IR semantics)
            if let Some(master) = registry.get(component) {
                for c in &master.children {
                    svg_node(
                        c,
                        vars,
                        body,
                        defs,
                        grad_id,
                        registry,
                        assets,
                        text_outliner,
                    );
                }
            }
        }
        _ => {}
    }
    // children with Figma mask semantics: a mask child clips FOLLOWING siblings
    let mut open_masks = 0usize;
    for c in &n.children {
        if c.is_mask && c.visible {
            let shape = mask_shape_svg(c);
            if !shape.is_empty() {
                *grad_id += 1;
                let mid = format!("mask{grad_id}");
                defs.push_str(&format!("<mask id=\"{mid}\">{shape}</mask>\n"));
                body.push_str(&format!("<g mask=\"url(#{mid})\">"));
                open_masks += 1;
            }
            continue; // masks paint nothing themselves
        }
        svg_node(
            c,
            vars,
            body,
            defs,
            grad_id,
            registry,
            assets,
            text_outliner,
        );
    }
    for _ in 0..open_masks {
        body.push_str("</g>");
    }
    body.push_str("</g>\n");
}

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::{Color, Paint, Stroke};

    #[test]
    fn rich_text_runs_override_the_fill_per_glyph() {
        // stub outliner: two glyph paths, the first carrying an explicit
        // run color, the second the None marker (layer fill fallback)
        let outliner = |parts: &[x_core::TextPart],
                        _s: f64,
                        _w: f64,
                        _f: Option<&str>,
                        _tw: x_core::TextWrap| {
            Some(
                parts
                    .iter()
                    .map(|p| {
                        (
                            format!("M 0 0 L 10 0 L 10 10 L 0 10 Z {}", p.text.len()),
                            p.color,
                        )
                    })
                    .collect::<Vec<_>>(),
            )
        };
        let mut t = x_core::Node::text("t", 10.0, 10.0, 200.0, 20.0, "Ab");
        // explicit layer fill: the marker glyph must fall back to THE
        // NODE'S fill, whatever it is (not a hardcoded default)
        t.fill = x_core::Paint::Solid(x_core::Color::from_rgb8(0x12, 0x34, 0x56));
        t.text_runs = vec![x_core::TextRun {
            start: 0,
            len: 1,
            color: Some(Color::from_rgb8(255, 0, 0)),
            size: None,
            font: None,
            weight: None,
            italic: None,
            ls: None,
        }];
        let doc = x_core::Node::frame("page", 300.0, 100.0).child(t);
        let svg = export_svg_full(&doc, &x_core::Variables::default(), None, Some(&outliner));
        assert!(
            svg.matches("fill=\"#ff0000\"").count() >= 1,
            "explicit run color overrides the layer fill: {svg}"
        );
        assert!(
            svg.matches("fill=\"#123456\"").count() >= 1,
            "marker glyphs keep the layer fill: {svg}"
        );
        assert!(
            !svg.contains("font-family"),
            "still outline paths, not font tags"
        );
    }

    #[test]
    fn pattern_fills_render_as_pattern_defs() {
        let png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x08\x00\x00\x00\x04\x08\x06\x00\x00\x00";
        let resolver = |name: &str| -> Option<Vec<u8>> {
            if name == "pat" {
                Some(png.to_vec())
            } else {
                None
            }
        };
        let doc = x_core::Node::frame("page", 200.0, 100.0).child(
            x_core::Node::rect("r", 10.0, 10.0, 100.0, 50.0, Color::WHITE).fill_paint(
                x_core::Paint::Pattern {
                    asset: "asset://pat".into(),
                    fit: x_core::ImageFit::Tile,
                },
            ),
        );
        let svg = export_svg_full(&doc, &x_core::Variables::default(), Some(&resolver), None);
        assert!(
            svg.contains(
                "<pattern id=\"p1\" patternUnits=\"userSpaceOnUse\" width=\"8\" height=\"4\""
            ),
            "tile pattern at natural size: {svg}"
        );
        assert!(
            svg.contains("fill=\"url(#p1)\""),
            "fill references the pattern"
        );
        assert!(
            svg.contains("data:image/png;base64,"),
            "image embedded as data URI"
        );
        // without bytes the fill degrades honestly
        let no_bytes = export_svg_full(&doc, &x_core::Variables::default(), None, None);
        assert!(
            no_bytes.contains("fill=\"none\""),
            "no resolver -> none: {no_bytes}"
        );
    }

    #[test]
    fn gradient_strokes_render_as_url_refs_with_defs() {
        let doc = x_core::Node::frame("page", 200.0, 100.0).child(
            x_core::Node::rect("r", 10.0, 10.0, 100.0, 50.0, Color::WHITE).stroke(Stroke {
                paint: Paint::LinearGradient {
                    start: (0.0, 0.0),
                    end: (100.0, 0.0),
                    stops: vec![
                        (0.0, Color::from_rgb8(255, 0, 0)),
                        (1.0, Color::from_rgb8(0, 0, 255)),
                    ],
                    space: x_core::GradSpace::Srgb,
                },
                width: 3.0,
            }),
        );
        let svg = export_svg(&doc, &x_core::Variables::default());
        assert!(
            svg.contains("stroke=\"url(#g"),
            "gradient stroke references a def: {svg}"
        );
        assert!(svg.contains("<linearGradient"), "defs contain the gradient");
        assert!(svg.contains("stroke-width=\"3\""));
    }
}
