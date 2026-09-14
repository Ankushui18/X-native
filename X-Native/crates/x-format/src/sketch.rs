//! Sketch (`.sketch`) file importer.
//!
//! A `.sketch` file is a plain ZIP archive of JSON files — no binary
//! schema to decode (unlike `.fig`), which makes this the more tractable
//! importer. Scope is deliberately bounded to what's common and
//! well-defined across Sketch's format history rather than attempting
//! every layer class and every style option:
//!
//! **Covered**: pages, artboards, groups, rectangles (incl. uniform
//! corner radius), ovals, text (plain string content + rich runs:
//! `attributedString.attributes` beyond the base run import as
//! per-character styling — UTF-16 location/length converted to char
//! indices — and export back as extra attribute entries), generic vector
//! shapes (shapePath/shapeGroup/star/polygon/triangle — via their `points`
//! array, converted to cubic-bezier `PathCmd`s), symbol masters and
//! instances (mapped to our Component/Instance, with text/fill/opacity
//! overrides in our render-effective encodings: `"text:…"`, `"#rrggbb[aa]"`,
//! `"opacity:N"`), bitmap layers (`image._ref` → embedded `Image` nodes;
//! the decode itself lives in `x-render`'s AssetStore), Sketch resizing
//! constraints (the `resizingConstraint` bitmask ↔ our HPin/VPin pins),
//! solid and linear/radial
//! gradient fills, image-pattern paints (`fillType` 2: fills render as
//! tiled images through every sink; pattern borders round-trip and render
//! as a neutral gray stroke), rotation, opacity, visibility, the full
//! border stack
//! (`style.borders`, multiple strokes, solid OR gradient paints), and
//! shadow/blur effects
//! (`style.shadows`, `style.innerShadows`, `style.blur`) round-tripping
//! through the shared `Effect` enum on both import and export.
//!
//! **Not covered** (produces a plain rect/vector fallback or is silently
//! dropped — never a panic): stroke-REGION patterns (a pattern border
//! keeps its paint and renders as a neutral gray stroke — image fills
//! clip; stroke regions can't), bitmap swap overrides (`_imageName` —
//! needs image bytes), and
//! `visible:` overrides (Sketch stores visibility as a plain property,
//! not an override value). Boolean shapeGroups flatten to a single
//! vector path (non-destructive re-editing is not preserved); nested
//! symbol swaps (`_symbolID`) round-trip through the component-name
//! registry.

use crate::import_ir::{ImportDoc, ImportKind, ImportNode};
use crate::json::{self, V};
use crate::zipfile::ZipArchive;
use std::collections::HashMap;
use x_core::{color_to_hex, Color, Document, Effect, GradSpace, ImageFit, Paint, PathCmd};

/// JSON string escaping that covers the FULL control range (Sketch's JSON
/// is standard JSON: raw U+0000–U+001F are invalid inside strings).
/// Matches the escaper in serialize.rs (the .x format's emitter).
fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}
/// Sketch `resizingConstraint` bitmask -> our pins (import direction).
pub(crate) fn sketch_pins(rc: u32) -> (x_core::HPin, x_core::VPin) {
    use x_core::{HPin, VPin};
    let (pin_l, pin_r) = (rc & 4 == 0, rc & 1 == 0);
    let (pin_t, pin_b) = (rc & 32 == 0, rc & 8 == 0);
    let h = if pin_l && pin_r {
        HPin::StretchH
    } else if pin_l {
        HPin::Left
    } else if pin_r {
        HPin::Right
    } else {
        HPin::ScaleH
    };
    let v = if pin_t && pin_b {
        VPin::StretchV
    } else if pin_t {
        VPin::Top
    } else if pin_b {
        VPin::Bottom
    } else {
        VPin::ScaleV
    };
    (h, v)
}

/// Our pins -> Sketch `resizingConstraint` bitmask (export direction).
/// Pin-to-mask: left=59, right=62, top=31, bottom=55, fixed width=61,
/// fixed height=47; AND them together, 63 = nothing pinned.
pub(crate) fn sketch_resizing_constraint(pin: (x_core::HPin, x_core::VPin)) -> u32 {
    use x_core::{HPin, VPin};
    const L: u32 = 59;
    const R: u32 = 62;
    const T: u32 = 31;
    const B: u32 = 55;
    const W: u32 = 61;
    const H: u32 = 47;
    const NONE: u32 = 63;
    let h = match pin.0 {
        HPin::Left => L & W,
        HPin::Right => R & W,
        HPin::StretchH => L & R,
        HPin::CenterH | HPin::ScaleH => NONE,
    };
    let v = match pin.1 {
        VPin::Top => T & H,
        VPin::Bottom => B & H,
        VPin::StretchV => T & B,
        VPin::CenterV | VPin::ScaleV => NONE,
    };
    h & v
}

fn sk_color(c: Color) -> String {
    format!(
        "{{\"red\":{},\"green\":{},\"blue\":{},\"alpha\":{}}}",
        c.components[0] as f64,
        c.components[1] as f64,
        c.components[2] as f64,
        c.components[3] as f64
    )
}
fn sk_fill(p: &Paint, w: f64, h: f64) -> String {
    match p {
    Paint::Solid(c) => format!("{{\"isEnabled\":true,\"fillType\":0,\"color\":{}}}", sk_color(*c)),
    Paint::Variable(_) => format!("{{\"isEnabled\":true,\"fillType\":0,\"color\":{}}}", sk_color(Color::BLACK)),
    Paint::LinearGradient { start,end,stops,.. } => format!("{{\"isEnabled\":true,\"fillType\":1,\"gradient\":{{\"gradientType\":0,\"from\":\"{{{}, {}}}\",\"to\":\"{{{}, {}}}\",\"stops\":[{}]}}}}", start.0/w.max(1.0),start.1/h.max(1.0),end.0/w.max(1.0),end.1/h.max(1.0),stops.iter().map(|(t,c)|format!("{{\"position\":{t},\"color\":{}}}",sk_color(*c))).collect::<Vec<_>>().join(",")),
    Paint::RadialGradient { center,radius,stops,.. } => format!("{{\"isEnabled\":true,\"fillType\":1,\"gradient\":{{\"gradientType\":1,\"from\":\"{{{}, {}}}\",\"to\":\"{{{}, {}}}\",\"stops\":[{}]}}}}", center.0/w.max(1.0),center.1/h.max(1.0),(center.0+radius)/w.max(1.0),center.1/h.max(1.0),stops.iter().map(|(t,c)|format!("{{\"position\":{t},\"color\":{}}}",sk_color(*c))).collect::<Vec<_>>().join(",")),
    // pattern fill (fillType 2): image ref + patternFillType (0 tile, 1
    // fill-bounds); the exported zip embeds images/<stem>.png for every
    // registered asset (same pass as bitmap layers)
    Paint::Pattern { asset, fit } => format!(
        "{{\"isEnabled\":true,\"fillType\":2,\"image\":{{\"_ref\":\"images/{}.png\"}},\"patternFillType\":{},\"patternTileScale\":1}}",
        esc(asset.trim_start_matches("asset://")),
        if *fit == ImageFit::Tile { 0 } else { 1 }),
    // Sketch gradientType: 0 linear, 1 radial, 2 angular. A diamond has no
    // Sketch equivalent — exported as the radial that shares its radii
    // (documented lossy, same policy as Pattern in the Figma exporter).
    Paint::AngularGradient { center,stops,.. } => format!("{{\"isEnabled\":true,\"fillType\":1,\"gradient\":{{\"gradientType\":2,\"from\":\"{{{}, {}}}\",\"to\":\"{{{}, {}}}\",\"stops\":[{}]}}}}", center.0/w.max(1.0),center.1/h.max(1.0),(center.0+0.5*w)/w.max(1.0),center.1/h.max(1.0),stops.iter().map(|(t,c)|format!("{{\"position\":{t},\"color\":{}}}",sk_color(*c))).collect::<Vec<_>>().join(",")),
    Paint::DiamondGradient { center,width,height,stops,.. } => format!("{{\"isEnabled\":true,\"fillType\":1,\"gradient\":{{\"gradientType\":1,\"from\":\"{{{}, {}}}\",\"to\":\"{{{}, {}}}\",\"stops\":[{}]}}}}", center.0/w.max(1.0),center.1/h.max(1.0),(center.0+width.max(*height))/w.max(1.0),center.1/h.max(1.0),stops.iter().map(|(t,c)|format!("{{\"position\":{t},\"color\":{}}}",sk_color(*c))).collect::<Vec<_>>().join(",")),
}
}

/// (point, curveFrom, curveTo) in normalized page units
type SkPt = ((f64, f64), (f64, f64), (f64, f64));

fn sk_path_points(path: &[PathCmd], w: f64, h: f64) -> (String, bool) {
    let mut pts: Vec<SkPt> = Vec::new();
    let mut closed = false;
    for cmd in path {
        match *cmd {
            PathCmd::MoveTo(x, y) => pts.push(((x, y), (x, y), (x, y))),
            PathCmd::LineTo(x, y) => pts.push(((x, y), (x, y), (x, y))),
            PathCmd::CurveTo(x1, y1, x2, y2, x, y) => {
                if let Some(last) = pts.last_mut() {
                    last.1 = (x1, y1);
                }
                pts.push(((x, y), (x, y), (x2, y2)));
            }
            PathCmd::Close => closed = true,
        }
    }
    let norm = |p: (f64, f64)| (p.0 / w.max(1.0), p.1 / h.max(1.0));
    let json = pts.into_iter().map(|(p, from, to)| {
        let (px, py) = norm(p); let (fx, fy) = norm(from); let (tx, ty) = norm(to);
        format!("{{\"_class\":\"curvePoint\",\"point\":\"{{{px}, {py}}}\",\"curveFrom\":\"{{{fx}, {fy}}}\",\"curveTo\":\"{{{tx}, {ty}}}\"}}")
    }).collect::<Vec<_>>().join(",");
    (json, closed)
}

fn sk_layer(n: &x_core::Node) -> String {
    use x_core::NodeKind;
    let (class, extra) = match &n.kind {
        NodeKind::Frame { .. } => ("artboard", String::new()), NodeKind::Group => ("group", String::new()),
        NodeKind::Section => ("group", String::new()), // sketch has no section kind; the NAME still travels with the layer
        NodeKind::Component { name } => ("symbolMaster", format!(",\"symbolID\":\"{}\"",esc(name))),
        NodeKind::Instance { component } => {
            // text + fill + opacity overrides round-trip; targets are the
            // master's layer ids (the keys of our override map)
            let ovs = n.overrides.iter().filter_map(|(target, enc)| {
                if let Some(t) = enc.strip_prefix("text:") {
                    Some(format!("{{\"overrideName\":\"{}_stringValue\",\"value\":\"{}\"}}", esc(target), esc(t)))
                } else if enc.starts_with('#') {
                    x_core::parse_hex_color(enc).map(|c| format!("{{\"overrideName\":\"{}_fillColor\",\"value\":{}}}", esc(target), sk_color(c)))
                } else if let Some(name) = enc.strip_prefix("swap:") {
                    Some(format!("{{\"overrideName\":\"{}_symbolID\",\"value\":\"{}\"}}", esc(target), esc(name)))
                } else {
                    enc.strip_prefix("opacity:").map(|o| format!("{{\"overrideName\":\"{}_opacity\",\"value\":{}}}", esc(target), o))
                }
            }).collect::<Vec<_>>().join(",");
            ("symbolInstance", format!(",\"symbolID\":\"{}\",\"overrideValues\":[{}]", esc(component), ovs))
        }
        NodeKind::Rect { radius } => ("rectangle",format!(",\"fixedRadius\":{radius}")), NodeKind::Ellipse => ("oval",String::new()),
        NodeKind::Arc { start, end } => { let (points, closed) = sk_path_points(&x_core::booleans::arc_path_cmds(n.w, n.h, *start, *end), n.w, n.h); ("shapePath", format!(",\"isClosed\":{closed},\"points\":[{points}]")) },
        NodeKind::Line => ("shapePath", ",\"isClosed\":false,\"points\":[{\"_class\":\"curvePoint\",\"point\":\"{0, 0}\"},{\"_class\":\"curvePoint\",\"point\":\"{1, 1}\"}]".to_string()),
        NodeKind::Text { text } => {
            // base attribute run (location 0): font name/size (h IS the
            // font size), fill color, kerning, line height — plus one extra
            // attribute entry per rich TextRun (UTF-16 location/length)
            let font = n.bindings.get("font").cloned().unwrap_or_else(|| "Helvetica".into());
            let ls = n.bindings.get("ls").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
            let lh = n.bindings.get("lh").and_then(|v| v.parse::<f64>().ok()).unwrap_or(1.2);
            let mut attrs = format!("\"NSFontAttribute\":{{\"_class\":\"font\",\"name\":\"{}\",\"size\":{}}}", esc(&font), n.h);
            if let Paint::Solid(c) = &n.fill { attrs.push_str(&format!(",\"MSAttributedStringColorAttribute\":{{\"_class\":\"color\",\"color\":{}}}", sk_color(*c))); }
            if ls != 0.0 { attrs.push_str(&format!(",\"kerning\":{ls}")); }
            attrs.push_str(&format!(",\"paragraphStyle\":{{\"_class\":\"paragraphStyle\",\"alignment\":0,\"minimumLineHeight\":{}}}", n.h * lh));
            let extra: Vec<String> = n.text_runs.iter().filter_map(|r| {
                let mut a = String::new();
                if let Some(f) = &r.font {
                    a.push_str(&format!("\"NSFontAttribute\":{{\"_class\":\"font\",\"name\":\"{}\",\"size\":{}}}", esc(f), r.size.unwrap_or(n.h)));
                } else if let Some(sz) = r.size {
                    a.push_str(&format!("\"NSFontAttribute\":{{\"_class\":\"font\",\"name\":\"{}\",\"size\":{sz}}}", esc(&font)));
                }
                if let Some(c) = r.color { a.push_str(&format!(",\"MSAttributedStringColorAttribute\":{{\"_class\":\"color\",\"color\":{}}}", sk_color(c))); }
                if a.is_empty() { return None; }
                let (su, lu) = utf16_range(text, r.start, r.len);
                if lu == 0 { return None; }
                Some(format!("{{\"location\":{su},\"length\":{lu},\"attributes\":{{{a}}}}}"))
            }).collect();
            let list = if extra.is_empty() { String::new() } else { format!(",{}", extra.join(",")) };
            ("text", format!(",\"attributedString\":{{\"string\":\"{}\",\"attributes\":[{{\"location\":0,\"length\":{},\"attributes\":{{{}}}}}{}]}}", esc(text), text.chars().count(), attrs, list))
        }
        NodeKind::Vector { path } => { let (points, closed) = sk_path_points(path, n.w, n.h); ("shapePath", format!(",\"isClosed\":{closed},\"points\":[{points}]")) },
        NodeKind::Image { asset,.. } => ("bitmap",format!(",\"image\":{{\"_ref\":\"images/{}.png\"}}",esc(asset.trim_start_matches("asset://")))),
        NodeKind::Slice => ("slice", String::new()),    };
    // resize constraints for every layer (Sketch's AND-encoded bitmask)
    let rc = sketch_resizing_constraint(n.pin);
    let fills = n
        .active_fills()
        .iter()
        .map(|l| sk_fill(&l.paint, n.w, n.h))
        .collect::<Vec<_>>()
        .join(",");
    // borders carry the full paint (solid color OR gradient) — sk_fill
    // already emits both shapes; append the border's thickness
    let borders = n
        .active_strokes()
        .iter()
        .map(|s| {
            format!(
                "{{\"thickness\":{},{}",
                s.stroke.width,
                sk_fill(&s.stroke.paint, n.w, n.h).trim_start_matches('{')
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let (mut shadows, mut inner_shadows, mut blur) = (String::new(), String::new(), String::new());
    for e in n.active_effects().into_iter() {
        match e.effect {
            x_core::Effect::DropShadow {
                dx,
                dy,
                blur: b,
                color,
            } => {
                if !shadows.is_empty() {
                    shadows.push(',');
                }
                shadows.push_str(&format!("{{\"isEnabled\":true,\"offsetX\":{},\"offsetY\":{},\"blurRadius\":{},\"color\":{}}}", dx, dy, b, sk_color(color)));
            }
            x_core::Effect::InnerShadow {
                dx,
                dy,
                blur: b,
                color,
            } => {
                if !inner_shadows.is_empty() {
                    inner_shadows.push(',');
                }
                inner_shadows.push_str(&format!("{{\"isEnabled\":true,\"offsetX\":{},\"offsetY\":{},\"blurRadius\":{},\"color\":{}}}", dx, dy, b, sk_color(color)));
            }
            x_core::Effect::LayerBlur { radius } | x_core::Effect::BackgroundBlur { radius } => {
                // Sketch has one `blur` slot per layer; last one wins if the
                // node somehow carries more than one — rare in practice.
                blur = format!("\"blur\":{{\"isEnabled\":true,\"radius\":{radius}}},");
            }
            x_core::Effect::Noise { .. } => {} // Sketch doesn't support noise effects
        }
    }
    let children = if n.children.is_empty() {
        String::new()
    } else {
        format!(
            ",\"layers\":[{}]",
            n.children
                .iter()
                .map(sk_layer)
                .collect::<Vec<_>>()
                .join(",")
        )
    };
    // masters carry their human component name (the importers resolve
    // symbolID -> master through the layer name); every other layer keeps
    // name == id, matching the editor's default naming
    let layer_name = match &n.kind {
        NodeKind::Component { name } => name.clone(),
        _ => n.id.clone(),
    };
    format!("{{\"_class\":\"{class}\",\"do_objectID\":\"{}\",\"name\":\"{}\",\"isVisible\":{},\"rotation\":{},\"resizingConstraint\":{rc},\"frame\":{{\"x\":{},\"y\":{},\"width\":{},\"height\":{}}},\"style\":{{\"contextSettings\":{{\"opacity\":{}}},{blur}\"fills\":[{fills}],\"borders\":[{borders}],\"shadows\":[{shadows}],\"innerShadows\":[{inner_shadows}]}}{extra}{children}}}",esc(&n.id),esc(&layer_name),n.visible,-n.transform.rotation.to_degrees(),n.transform.x,n.transform.y,n.w,n.h,n.opacity)
}

/// Export a real Sketch ZIP package using the documented JSON package shape.
pub fn export_sketch(doc: &Document) -> Vec<u8> {
    let refs=doc.pages.iter().enumerate().map(|(i,_)|format!("{{\"_class\":\"MSJSONFileReference\",\"_ref_class\":\"MSImmutablePage\",\"_ref\":\"pages/page-{}\"}}",i+1)).collect::<Vec<_>>().join(",");
    let mut files = vec![
        (
            "document.json".into(),
            format!(
                "{{\"_class\":\"document\",\"do_objectID\":\"x-designer\",\"pages\":[{refs}]}}"
            )
            .into_bytes(),
        ),
        (
            "meta.json".into(),
            b"{\"app\":\"X Designer\",\"version\":1}".to_vec(),
        ),
    ];
    for (i, p) in doc.pages.iter().enumerate() {
        files.push((
            format!("pages/page-{}.json", i + 1),
            format!(
                "{{\"_class\":\"page\",\"do_objectID\":\"{}\",\"name\":\"{}\",\"layers\":[{}]}}",
                esc(&p.id),
                esc(&p.id),
                p.children
                    .iter()
                    .map(sk_layer)
                    .collect::<Vec<_>>()
                    .join(",")
            )
            .into_bytes(),
        ));
    }
    for asset in doc.assets.embedded_sorted() {
        if asset.mime == "image/png" {
            files.push((format!("images/{}.png", asset.hash), asset.bytes.clone()));
        }
    }
    crate::zipfile::write_stored(&files)
}

fn s<'a>(v: &'a V, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.str())
}
fn n(v: &V, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.num())
}
fn n_or(v: &V, key: &str, default: f64) -> f64 {
    n(v, key).unwrap_or(default)
}
fn b_or(v: &V, key: &str, default: bool) -> bool {
    v.get(key).and_then(|x| x.boolean()).unwrap_or(default)
}

fn frame_xywh(v: &V) -> (f64, f64, f64, f64) {
    match v.get("frame") {
        Some(f) => (
            n_or(f, "x", 0.0),
            n_or(f, "y", 0.0),
            n_or(f, "width", 0.0),
            n_or(f, "height", 0.0),
        ),
        None => (0.0, 0.0, 0.0, 0.0),
    }
}

/// Sketch color objects are `{red, green, blue, alpha}` floats in 0..=1 —
/// directly compatible with peniko's `Color::rgba(f64...)`, no scaling.
fn sketch_color(v: &V) -> Option<Color> {
    Some(Color::new([
        n_or(v, "red", 0.0) as f32,
        n_or(v, "green", 0.0) as f32,
        n_or(v, "blue", 0.0) as f32,
        n_or(v, "alpha", 1.0) as f32,
    ]))
}

/// UTF-16 unit -> char-index map. Sketch attribute `location`/`length`
/// are UTF-16 units; our `TextRun` ranges are CHAR indices. Entry k is the
/// char index containing utf16 unit k; the final entry is the char count
/// (the end-of-string boundary).
fn utf16_char_map(text: &str) -> Vec<usize> {
    let total: usize = text.chars().map(|c| c.len_utf16()).sum();
    let mut map = Vec::with_capacity(total + 1);
    for (ci, c) in text.chars().enumerate() {
        for _ in 0..c.len_utf16() {
            map.push(ci);
        }
    }
    map.push(text.chars().count());
    map
}

/// char range -> (utf16 offset, utf16 length) for Sketch export.
fn utf16_range(text: &str, start: usize, len: usize) -> (usize, usize) {
    let (mut su, mut lu, mut ci) = (0usize, 0usize, 0usize);
    for c in text.chars() {
        if ci >= start + len {
            break;
        }
        if ci >= start {
            lu += c.len_utf16();
        } else {
            su += c.len_utf16();
        }
        ci += 1;
    }
    (su, lu)
}

/// The first enabled fill in a layer's `style.fills` array, as our
/// `Paint`. Solid fills (`fillType` 0) map directly. Gradients
/// (`fillType` 1) dispatch on `gradient.gradientType`: 0 linear,
/// 1 radial, 2 angular. Angular sweeps have no equivalent in our `Paint`
/// enum and fall back to a linear gradient between the same anchors
/// rather than being dropped silently.
fn first_fill(layer: &V) -> Option<Paint> {
    // gradient anchors are NORMALIZED 0..1 within the layer frame; our
    // Paint gradients are node-local PIXELS (sketch_paint does the scaling)
    let (_, _, fw, fh) = frame_xywh(layer);
    let fills = layer.get("style")?.get("fills")?.arr()?;
    let fill = fills.iter().find(|f| b_or(f, "isEnabled", true))?;
    sketch_paint(fill, fw, fh)
}

/// Sketch encodes gradient/point positions as the string `"{x, y}"`
/// (curly braces, not JSON) — a real, deliberate format quirk.
fn point_pair(v: &V) -> Option<(f64, f64)> {
    let raw = v.str()?;
    let inner = raw.trim_start_matches('{').trim_end_matches('}');
    let mut parts = inner.split(',').map(|p| p.trim().parse::<f64>());
    Some((parts.next()?.ok()?, parts.next()?.ok()?))
}

/// AUDIT FIX (was a real bug in the draft): layer opacity lives at
/// `style.contextSettings.opacity` — the draft called `.num()` on the
/// contextSettings OBJECT itself, which is always None, so every layer
/// imported fully opaque.
fn opacity(layer: &V) -> f32 {
    layer
        .get("style")
        .and_then(|s| s.get("contextSettings"))
        .and_then(|c| c.get("opacity"))
        .and_then(|o| o.num())
        .unwrap_or(1.0) as f32
}

/// Converts a Sketch `points` array (each point has a normalized 0..1
/// `point`/`curveFrom`/`curveTo` position within the shape's own frame)
/// into absolute-within-frame cubic-bezier `PathCmd`s. Every point is
/// treated as a bezier vertex whether or not it actually has curve
/// handles — a straight segment's handles just equal its own point,
/// which produces a degenerate (but correct) cubic equal to the line.
fn shape_points_to_path(points: &[V], w: f64, h: f64, closed: bool) -> Vec<PathCmd> {
    let abs = |p: (f64, f64)| (p.0 * w, p.1 * h);
    let pts: Vec<SkPt> = points
        .iter()
        .filter_map(|p| {
            let pos = point_pair(p.get("point")?)?;
            let curve_from = p.get("curveFrom").and_then(point_pair).unwrap_or(pos);
            let curve_to = p.get("curveTo").and_then(point_pair).unwrap_or(pos);
            Some((abs(pos), abs(curve_from), abs(curve_to)))
        })
        .collect();
    if pts.is_empty() {
        return vec![];
    }
    let mut out = vec![PathCmd::MoveTo(pts[0].0 .0, pts[0].0 .1)];
    let n_pts = pts.len();
    let last_idx = if closed { n_pts } else { n_pts - 1 };
    for i in 0..last_idx {
        let (_, cur_curve_from, _) = pts[i];
        let (next_pos, _, next_curve_to) = pts[(i + 1) % n_pts];
        out.push(PathCmd::CurveTo(
            cur_curve_from.0,
            cur_curve_from.1,
            next_curve_to.0,
            next_curve_to.1,
            next_pos.0,
            next_pos.1,
        ));
    }
    if closed {
        out.push(PathCmd::Close);
    }
    out
}

/// Registry of symbolID -> human name, built by pre-scanning every page
/// (Sketch documents commonly keep a dedicated "Symbols" page, but
/// there's no rule requiring it) for `symbolMaster` layers before
/// converting anything — an instance can appear before its master.
fn collect_symbol_masters(layer: &V, out: &mut HashMap<String, String>) {
    if s(layer, "_class") == Some("symbolMaster") {
        if let (Some(sid), Some(name)) = (s(layer, "symbolID"), s(layer, "name")) {
            out.insert(sid.to_string(), name.to_string());
        }
    }
    if let Some(children) = layer.get("layers").and_then(|v| v.arr()) {
        for c in children {
            collect_symbol_masters(c, out);
        }
    }
}

/// Sketch `style.borders` (strokes). Each enabled solid border becomes a
/// (primary stroke, extra stacked strokes) — the first is the primary
/// `ir.stroke`, any rest stack as `extra_strokes` (same convention as
/// the Figma importer).
type StrokeSet = (Option<(Paint, f64)>, Vec<(Paint, f64)>);

/// One Sketch fill/border object -> Paint. fillType 0 = solid color,
/// 1 = gradient (anchors normalized 0..1 in the layer frame, same as
/// fills — scaled to pixels here).
fn sketch_paint(fill: &V, fw: f64, fh: f64) -> Option<Paint> {
    let fill_type = n_or(fill, "fillType", 0.0) as i64;
    if fill_type == 0 {
        return fill.get("color").and_then(sketch_color).map(Paint::Solid);
    }
    if fill_type == 2 {
        // pattern fill: image ref + patternFillType (0 tile, 1 fill, 2
        // stretch). Stretch approximates as Fill (proportional cover —
        // our image model never distorts).
        let stem = fill
            .get("image")?
            .get("_ref")?
            .str()?
            .trim_start_matches("images/")
            .trim_end_matches(".png")
            .to_string();
        let pft = n_or(fill, "patternFillType", 0.0) as i64;
        return Some(Paint::Pattern {
            asset: stem,
            fit: if pft == 0 {
                ImageFit::Tile
            } else {
                ImageFit::Fill
            },
        });
    }
    let g = fill.get("gradient")?;
    let stops: Vec<(f32, Color)> = g
        .get("stops")?
        .arr()?
        .iter()
        .filter_map(|st| {
            Some((
                n_or(st, "position", 0.0) as f32,
                sketch_color(st.get("color")?)?,
            ))
        })
        .collect();
    if stops.is_empty() {
        return None;
    }
    let raw_from = g.get("from").and_then(point_pair).unwrap_or((0.0, 0.0));
    let raw_to = g.get("to").and_then(point_pair).unwrap_or((1.0, 1.0));
    let from = (raw_from.0 * fw, raw_from.1 * fh);
    let to = (raw_to.0 * fw, raw_to.1 * fh);
    if n_or(g, "gradientType", 0.0) as i64 == 1 {
        let radius = ((to.0 - from.0).powi(2) + (to.1 - from.1).powi(2)).sqrt();
        Some(Paint::RadialGradient {
            center: from,
            radius,
            stops,
            space: GradSpace::Srgb,
        })
    } else {
        Some(Paint::LinearGradient {
            start: from,
            end: to,
            stops,
            space: GradSpace::Srgb,
        })
    }
}

fn sketch_strokes(layer: &V) -> StrokeSet {
    let Some(borders) = layer
        .get("style")
        .and_then(|s| s.get("borders"))
        .and_then(V::arr)
    else {
        return (None, vec![]);
    };
    let (fw, fh) = {
        let (_, _, w, h) = frame_xywh(layer);
        (w, h)
    };
    let mut strokes = borders
        .iter()
        .filter(|b| b_or(b, "isEnabled", true))
        .filter_map(|b| Some((sketch_paint(b, fw, fh)?, n_or(b, "thickness", 1.0))));
    (strokes.next(), strokes.collect())
}

/// Sketch `style.shadows` / `style.innerShadows` / `style.blur` — the
/// same shadow/blur vocabulary Figma exposes, so it lowers onto the same
/// shared `Effect` enum.
fn sketch_effects(layer: &V) -> Vec<Effect> {
    let mut out = vec![];
    let style = layer.get("style");
    if let Some(shadows) = style.and_then(|s| s.get("shadows")).and_then(V::arr) {
        for sh in shadows.iter().filter(|s| b_or(s, "isEnabled", true)) {
            let color = sh
                .get("color")
                .and_then(sketch_color)
                .unwrap_or(Color::from_rgba8(0, 0, 0, 255));
            out.push(Effect::DropShadow {
                dx: n_or(sh, "offsetX", 0.0),
                dy: n_or(sh, "offsetY", 0.0),
                blur: n_or(sh, "blurRadius", 0.0),
                color,
            });
        }
    }
    if let Some(shadows) = style.and_then(|s| s.get("innerShadows")).and_then(V::arr) {
        for sh in shadows.iter().filter(|s| b_or(s, "isEnabled", true)) {
            let color = sh
                .get("color")
                .and_then(sketch_color)
                .unwrap_or(Color::from_rgba8(0, 0, 0, 255));
            out.push(Effect::InnerShadow {
                dx: n_or(sh, "offsetX", 0.0),
                dy: n_or(sh, "offsetY", 0.0),
                blur: n_or(sh, "blurRadius", 0.0),
                color,
            });
        }
    }
    if let Some(blur) = style.and_then(|s| s.get("blur")) {
        if b_or(blur, "isEnabled", false) {
            out.push(Effect::LayerBlur {
                radius: n_or(blur, "radius", 0.0),
            });
        }
    }
    out
}

/// A flattened Sketch boolean group: one vector path + its placement.
struct FlatShape {
    cmds: Vec<PathCmd>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// Sketch boolean shapeGroups (`shapeGroup` with `hasBooleanOperation`,
/// children carrying `booleanOperation`: -1 none / 0 union / 1 subtract /
/// 2 intersect / 3 difference) flatten into ONE vector path through the
/// editor's exact boolean geometry — the same model as the editor's own
/// `boolean_selected` (the result replaces the operands). Children fold
/// left-to-right: the first (bottom) shape is the base, each subsequent
/// shape's op applies to the accumulated result. Shapes marked `none`
/// after the first merge as union — visually closest to Sketch's
/// "sits on top, doesn't interact".
///
/// None (caller falls back to a plain group import, with a diagnostic):
/// unsupported child geometry (text/bitmap/nested groups), rotated
/// children (rotation would need baking into the path), or degenerate
/// op lists. Non-destructive re-editing is NOT preserved — the flattened
/// path is the honest equivalent of Sketch's own "flatten" action.
fn flatten_boolean_group(
    layer: &V,
    gx: f64,
    gy: f64,
    symbol_names: &HashMap<String, String>,
    diags: &mut Vec<String>,
) -> Option<FlatShape> {
    use x_core::booleans::{boolean, node_to_path, BoolOp, PositionedPath};
    let children = layer.get("layers").and_then(|v| v.arr())?;
    if children.len() < 2 {
        return None;
    }
    let op_of = |c: &V| -> Option<BoolOp> {
        match n_or(c, "booleanOperation", -1.0) as i64 {
            0 => Some(BoolOp::Union),
            1 => Some(BoolOp::Subtract),
            2 => Some(BoolOp::Intersect),
            3 => Some(BoolOp::Exclude),
            _ => None, // -1 / absent: base shape, or "none" (treated as union)
        }
    };
    // boolean group iff the flag is set OR any child carries a real op
    let flagged = b_or(layer, "hasBooleanOperation", false);
    if !flagged && !children.iter().skip(1).any(|c| op_of(c).is_some()) {
        return None;
    }

    // child layer JSON -> positioned path (rect/oval/shapePath geometry,
    // offset in the GROUP's parent space)
    let mut positioned = vec![];
    for c in children {
        if n_or(c, "rotation", 0.0) != 0.0 {
            diags.push("sketch: boolean group with rotated child imported as plain group (rotation not baked into paths)".into());
            return None;
        }
        let cn = convert_layer(c, symbol_names, diags)?;
        let sid = cn.id.clone().unwrap_or_else(|| "shape".into());
        let node = match &cn.kind {
            ImportKind::Rect { radius } => {
                x_core::Node::rect(&sid, 0.0, 0.0, cn.w, cn.h, Color::BLACK).radius(*radius)
            }
            ImportKind::Ellipse => x_core::Node::ellipse(&sid, 0.0, 0.0, cn.w, cn.h, Color::BLACK),
            ImportKind::Path { cmds } => {
                x_core::Node::vector(&sid, 0.0, 0.0, cn.w, cn.h, cmds.clone())
            }
            _ => {
                diags.push(format!("sketch: boolean group child '{}' has unsupported geometry, imported as plain group", sid));
                return None;
            }
        };
        positioned.push(PositionedPath {
            cmds: node_to_path(&node)?,
            offset: (gx + cn.x, gy + cn.y),
        });
    }

    // fold: base = first shape, each next op applies to the accumulator
    let mut acc = positioned[0].clone();
    let mut bounds: Option<(f64, f64, f64, f64)> = None; // x, y, w, h of the last op's result
    for (i, next) in positioned.iter().enumerate().skip(1) {
        let op = op_of(&children[i]).unwrap_or(BoolOp::Union); // "none" after first = union
        let res = boolean(op, &acc, next);
        if res.cmds.is_empty() {
            diags.push(
                "sketch: boolean operation produced empty geometry, imported as plain group".into(),
            );
            return None;
        }
        bounds = Some((res.origin.0, res.origin.1, res.size.0, res.size.1));
        acc = PositionedPath {
            cmds: res.cmds,
            offset: res.origin,
        };
    }
    let (bx, by, bw, bh) = bounds?; // >=2 children but no op ran: not a boolean group after all
    Some(FlatShape {
        cmds: acc.cmds,
        x: bx,
        y: by,
        w: bw,
        h: bh,
    })
}

fn convert_layer(
    layer: &V,
    symbol_names: &HashMap<String, String>,
    diags: &mut Vec<String>,
) -> Option<ImportNode> {
    let class = s(layer, "_class")?;
    let (x, y, w, h) = frame_xywh(layer);
    let rotation_deg = n_or(layer, "rotation", 0.0);
    let mut fill = first_fill(layer);

    // boolean shapeGroups flatten to one vector path (see flatten_boolean_group);
    // computed BEFORE the kind match because it decides the kind
    let flat = if class == "shapeGroup" {
        flatten_boolean_group(layer, x, y, symbol_names, diags)
    } else {
        None
    };

    let kind = match class {
        "artboard" => ImportKind::Frame,
        "symbolMaster" => ImportKind::Component {
            name: s(layer, "name").unwrap_or("Symbol").to_string(),
        },
        "group" | "shapeGroup" => flat
            .as_ref()
            .map(|f| ImportKind::Path {
                cmds: f.cmds.clone(),
            })
            .unwrap_or(ImportKind::Group),
        "rectangle" => {
            let radius = layer
                .get("points")
                .and_then(|v| v.arr())
                .and_then(|pts| pts.first())
                .and_then(|p| p.get("cornerRadius"))
                .and_then(|v| v.num())
                .or_else(|| n(layer, "fixedRadius"))
                .unwrap_or(0.0);
            ImportKind::Rect { radius }
        }
        "oval" => ImportKind::Ellipse,
        "text" => {
            // attributedString: string + attribute runs. The FIRST run's
            // style is the base (uniform text); later runs that DIFFER from
            // the base become rich TextRuns (char-index ranges, converted
            // from Sketch's UTF-16 location/length).
            let asv = layer.get("attributedString");
            let content = asv.and_then(|a| s(a, "string")).unwrap_or("").to_string();
            let attrs = asv
                .and_then(|a| a.get("attributes"))
                .and_then(V::arr)
                .and_then(|runs| runs.first())
                .and_then(|r| r.get("attributes"));
            let font = attrs
                .and_then(|a| a.get("NSFontAttribute"))
                .map(|f| (s(f, "name").unwrap_or("Helvetica"), n_or(f, "size", 0.0)));
            let (font_name, size) = match font {
                Some((n, sz)) if sz > 0.0 => (Some(n.to_string()), Some(sz)),
                Some((n, _)) => (Some(n.to_string()), None),
                None => (None, None),
            };
            // text color lives in the attribute run (Sketch text layers
            // rarely carry style.fills); only when nothing else filled it
            if fill.is_none() {
                if let Some(c) = attrs
                    .and_then(|a| a.get("MSAttributedStringColorAttribute"))
                    .and_then(|c| c.get("color"))
                    .and_then(sketch_color)
                {
                    fill = Some(Paint::Solid(c));
                }
            }
            let ls = attrs.map(|a| n_or(a, "kerning", 0.0)).filter(|v| *v != 0.0);
            let lh = attrs
                .and_then(|a| a.get("paragraphStyle"))
                .map(|p| n_or(p, "minimumLineHeight", 0.0))
                .filter(|v| *v > 0.0)
                .map(|m| m / size.unwrap_or(m));
            // rich runs: runs 1.. whose style differs from run 0's base
            let mut runs: Vec<x_core::TextRun> = vec![];
            if let Some(arr) = asv.and_then(|a| a.get("attributes")).and_then(V::arr) {
                if arr.len() > 1 {
                    let map = utf16_char_map(&content);
                    let total_chars = content.chars().count();
                    let base = arr.first().and_then(|r| r.get("attributes"));
                    let base_color = base
                        .and_then(|a| a.get("MSAttributedStringColorAttribute"))
                        .and_then(|c| c.get("color"))
                        .and_then(sketch_color);
                    let base_size = base
                        .and_then(|a| a.get("NSFontAttribute"))
                        .map(|f| n_or(f, "size", 0.0))
                        .filter(|v| *v > 0.0);
                    let base_font = base
                        .and_then(|a| a.get("NSFontAttribute"))
                        .and_then(|f| s(f, "name"))
                        .map(str::to_string);
                    for r in arr.iter().skip(1) {
                        let loc = n_or(r, "location", 0.0) as usize;
                        let len16 = n_or(r, "length", 0.0) as usize;
                        if len16 == 0 {
                            continue;
                        }
                        let cs = map.get(loc.min(map.len() - 1)).copied().unwrap_or(0);
                        let ce = map
                            .get((loc + len16).min(map.len() - 1))
                            .copied()
                            .unwrap_or(cs)
                            .max(cs)
                            .min(total_chars);
                        if ce <= cs || cs >= total_chars {
                            continue;
                        }
                        let a = r.get("attributes");
                        let color = a
                            .and_then(|a| a.get("MSAttributedStringColorAttribute"))
                            .and_then(|c| c.get("color"))
                            .and_then(sketch_color)
                            .filter(|c| Some(*c) != base_color);
                        let size = a
                            .and_then(|a| a.get("NSFontAttribute"))
                            .map(|f| n_or(f, "size", 0.0))
                            .filter(|v| *v > 0.0)
                            .filter(|v| Some(*v) != base_size);
                        let font = a
                            .and_then(|a| a.get("NSFontAttribute"))
                            .and_then(|f| s(f, "name"))
                            .map(str::to_string)
                            .filter(|f| base_font.as_deref() != Some(f.as_str()));
                        if color.is_none() && size.is_none() && font.is_none() {
                            continue;
                        }
                        runs.push(x_core::TextRun {
                            start: cs,
                            len: ce - cs,
                            color,
                            size,
                            font,
                            weight: None,
                            italic: None,
                            ls: None,
                        });
                    }
                }
            }
            ImportKind::Text {
                content,
                size,
                font: font_name,
                line_height: lh,
                letter_spacing: ls,
                runs,
            }
        }
        "shapePath" | "star" | "polygon" | "triangle" => {
            let points = layer
                .get("points")
                .and_then(|v| v.arr())
                .cloned()
                .unwrap_or_default();
            let closed = b_or(layer, "isClosed", true);
            ImportKind::Path {
                cmds: shape_points_to_path(&points, w, h, closed),
            }
        }
        "symbolInstance" => {
            let symbol_id = s(layer, "symbolID").unwrap_or("");
            let name = symbol_names
                .get(symbol_id)
                .cloned()
                .unwrap_or_else(|| symbol_id.to_string());
            let mut ovr = vec![];
            if let Some(overrides) = layer.get("overrideValues").and_then(|v| v.arr()) {
                for ov in overrides {
                    let Some(prop) = s(ov, "overrideName") else {
                        continue;
                    };
                    // render-effective encodings, matching the renderer's
                    // override map ("text:…", "#rrggbb[aa]", "opacity:N")
                    if let Some(target) = prop.strip_suffix("_stringValue") {
                        if let Some(value) = s(ov, "value") {
                            ovr.push((target.to_string(), format!("text:{value}")));
                        }
                    } else if let Some(target) = prop.strip_suffix("_fillColor") {
                        let c = ov.get("value");
                        let (r, g, b, a) = (
                            c.and_then(|c| n(c, "red")),
                            c.and_then(|c| n(c, "green")),
                            c.and_then(|c| n(c, "blue")),
                            c.and_then(|c| n(c, "alpha")),
                        );
                        match (r, g, b) {
                            (Some(r), Some(g), Some(b)) => {
                                let a = a.unwrap_or(1.0).clamp(0.0, 1.0);
                                // round, don't truncate: Sketch stores e.g.
                                // 0.533333 for 136/255 and truncation would
                                // drift the channel by one
                                ovr.push((
                                    target.to_string(),
                                    color_to_hex(Color::from_rgba8(
                                        (r * 255.0).round() as u8,
                                        (g * 255.0).round() as u8,
                                        (b * 255.0).round() as u8,
                                        (a * 255.0).round() as u8,
                                    )),
                                ));
                            }
                            _ => diags.push(format!(
                                "sketch: skipped malformed fillColor override on '{target}'"
                            )),
                        }
                    } else if let Some(target) = prop.strip_suffix("_opacity") {
                        if let Some(o) = n(ov, "value") {
                            ovr.push((target.to_string(), format!("opacity:{o}")));
                        }
                    } else if let Some(target) = prop.strip_suffix("_symbolID") {
                        // nested symbol swap: value is the target master's
                        // symbolID; our renderer resolves swaps by component
                        // NAME, so map through the symbol table (self-round-
                        // trips: our exporter writes name-as-symbolID)
                        if let Some(value) = s(ov, "value") {
                            let name = symbol_names
                                .get(value)
                                .cloned()
                                .unwrap_or_else(|| value.to_string());
                            ovr.push((target.to_string(), format!("swap:{name}")));
                        }
                    } else if prop.ends_with("_imageName") {
                        // bitmap swap needs image bytes we don't have at
                        // import time — honest skip with a diagnostic
                        diags.push(format!(
                            "sketch: skipped unsupported bitmap swap override '{prop}'"
                        ));
                    }
                }
            }
            ImportKind::Instance {
                component: name,
                overrides: ovr,
            }
        }
        "bitmap" => {
            // real reference: layer.image._ref = "images/<sha>.png" —
            // matches the ImportDoc.assets key (the zip path stem), so
            // lower() rewrites it to the content-addressed asset:// id.
            // Layer name is only the fallback for malformed files.
            let asset = layer
                .get("image")
                .and_then(|i| s(i, "_ref"))
                .map(|r| {
                    r.trim_start_matches("images/")
                        .trim_end_matches(".png")
                        .to_string()
                })
                .unwrap_or_else(|| s(layer, "name").unwrap_or("image").to_string());
            ImportKind::Image { asset }
        }
        other => {
            diags.push(format!("sketch: skipped unsupported layer class '{other}'"));
            return None;
        }
    };

    let (px, py, pw, ph) = flat
        .as_ref()
        .map(|f| (f.x, f.y, f.w, f.h))
        .unwrap_or((x, y, w, h));
    let mut ir = ImportNode::new(kind).at(px, py).size(pw, ph);
    if let Some(id) = s(layer, "do_objectID") {
        ir = ir.id(id);
    }
    // Sketch resizing constraints (bitmask) -> resize pins. Each pin CLEARS
    // a bit from 63: 1=right, 2=width, 4=left, 8=bottom, 16=height, 32=top;
    // compound values are the AND of the individual masks (Sketch's own
    // encoding — 63 = nothing pinned = scale).
    if let Some(rc) = n(layer, "resizingConstraint") {
        let (hp, vp) = sketch_pins(rc as u32);
        ir = ir.pin(hp, vp);
    }
    ir.fill = fill.clone();
    let (stroke, extra_strokes) = sketch_strokes(layer);
    ir.stroke = stroke;
    ir.extra_strokes = extra_strokes;
    ir.effects = sketch_effects(layer);
    // Sketch rotates clockwise-positive; native convention is CCW-positive.
    ir.rotation = -rotation_deg.to_radians();
    ir.opacity = opacity(layer);
    ir.visible = b_or(layer, "isVisible", true);

    if flat.is_none() {
        if let Some(children) = layer.get("layers").and_then(|v| v.arr()) {
            for child in children {
                if let Some(cn) = convert_layer(child, symbol_names, diags) {
                    ir.children.push(cn);
                }
            }
        }
    }
    // Sketch shapeGroups carry the style; child shapePaths have none —
    // propagate the group fill to fill-less child paths (source-format
    // quirk, so it belongs HERE, not in the shared lowering).
    if class == "shapeGroup" {
        if let Some(p) = fill {
            for c in &mut ir.children {
                if matches!(c.kind, ImportKind::Path { .. }) && c.fill.is_none() {
                    c.fill = Some(p.clone());
                }
            }
        }
    }
    Some(ir)
}

pub fn import_sketch(bytes: &[u8]) -> Result<Document, String> {
    import_sketch_with_report(bytes).map(|(d, _)| d)
}

/// Import + fidelity report (import diagnostics UI).
pub fn import_sketch_with_report(bytes: &[u8]) -> Result<(Document, crate::ImportReport), String> {
    let archive = ZipArchive::open(bytes)?;
    let document_bytes = archive.read("document.json")?;
    let document_text = String::from_utf8_lossy(&document_bytes);
    let document_v = json::parse(&document_text)?;

    let page_paths: Vec<String> = document_v
        .get("pages")
        .and_then(|v| v.arr())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| s(p, "_ref").map(|r| format!("{r}.json")))
                .collect()
        })
        .unwrap_or_default();

    let mut page_values: Vec<V> = Vec::new();
    for path in &page_paths {
        let raw = archive.read(path)?;
        let text = String::from_utf8_lossy(&raw);
        page_values.push(json::parse(&text)?);
    }
    // Fallback for older/nonstandard files that don't use document.json's
    // page-reference list: pick up every pages/*.json entry directly.
    if page_values.is_empty() {
        let matched =
            archive.read_matching(|name| name.starts_with("pages/") && name.ends_with(".json"))?;
        for raw in matched.values() {
            let text = String::from_utf8_lossy(raw);
            page_values.push(json::parse(&text)?);
        }
    }
    if page_values.is_empty() {
        return Err("sketch file contains no pages".into());
    }

    let mut symbol_names = HashMap::new();
    for pv in &page_values {
        collect_symbol_masters(pv, &mut symbol_names);
    }

    // Sketch embeds bitmap assets under images/ — carry them in the IR
    // so the app shell can register them with the Assets loader.
    let mut doc = ImportDoc {
        source: "sketch",
        ..Default::default()
    };
    if let Ok(images) = archive.read_matching(|n| n.starts_with("images/") && n.ends_with(".png")) {
        for (name, data) in images {
            let stem = name
                .trim_start_matches("images/")
                .trim_end_matches(".png")
                .to_string();
            doc.assets.push((stem, data));
        }
    }
    for pv in &page_values {
        let mut page_ir = ImportNode::new(ImportKind::Frame);
        if let Some(id) = s(pv, "do_objectID") {
            page_ir = page_ir.id(id);
        }
        if let Some(layers) = pv.get("layers").and_then(|v| v.arr()) {
            for layer in layers {
                if let Some(n) = convert_layer(layer, &symbol_names, &mut doc.diagnostics) {
                    page_ir.children.push(n);
                }
            }
        }
        doc.pages.push(page_ir);
    }
    Ok(crate::lower_with_report(doc))
}

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::{HPin, NodeKind, VPin};

    fn zip_of(files: &[(&str, &[u8])]) -> Vec<u8> {
        crate::zipfile::write_stored(
            &files
                .iter()
                .map(|(n, b)| (n.to_string(), b.to_vec()))
                .collect::<Vec<_>>(),
        )
    }

    const DOCUMENT_JSON: &str = r#"{"_class":"document","do_objectID":"doc-1","pages":[{"_class":"MSJSONFileReference","_ref_class":"MSImmutablePage","_ref":"pages/page-1"}]}"#;

    #[test]
    fn imports_a_rectangle_with_solid_fill_and_rotation() {
        let page = r#"{"_class":"page","do_objectID":"page-1","layers":[
            {"_class":"rectangle","do_objectID":"r1","name":"Rect","isVisible":true,"rotation":90,
             "frame":{"x":10,"y":20,"width":100,"height":50},
             "style":{"fills":[{"isEnabled":true,"fillType":0,"color":{"red":1,"green":0,"blue":0,"alpha":1}}]}}
        ]}"#;
        let zip = zip_of(&[
            ("document.json", DOCUMENT_JSON.as_bytes()),
            ("pages/page-1.json", page.as_bytes()),
        ]);
        let doc = import_sketch(&zip).expect("should import");
        assert_eq!(doc.pages.len(), 1);
        let rect = &doc.pages[0].children[0];
        assert!(matches!(rect.kind, NodeKind::Rect { .. }));
        assert_eq!(rect.transform.x, 10.0);
        assert_eq!(rect.transform.y, 20.0);
        assert_eq!(rect.w, 100.0);
        assert_eq!(rect.h, 50.0);
        assert_eq!(rect.fill, Paint::Solid(Color::new([1.0, 0.0, 0.0, 1.0])));
        // Sketch rotates clockwise-positive; we store counter-clockwise-positive.
        assert!((rect.transform.rotation - (-std::f64::consts::FRAC_PI_2)).abs() < 1e-9);
    }

    #[test]
    fn exported_sketch_package_reimports() {
        let mut source = Document::new();
        source.pages.push(
            x_core::Node::frame("Page", 400.0, 300.0).child(x_core::Node::ellipse(
                "Dot",
                12.0,
                18.0,
                40.0,
                40.0,
                Color::from_rgb8(200, 20, 80),
            )),
        );
        let bytes = export_sketch(&source);
        let loaded = import_sketch(&bytes).expect("own Sketch package should import");
        assert_eq!(loaded.pages.len(), 1);
        assert_eq!(loaded.pages[0].children.len(), 1);
    }

    #[test]
    fn imports_a_linear_gradient_fill() {
        let page = r#"{"_class":"page","do_objectID":"page-1","layers":[
            {"_class":"oval","do_objectID":"o1","isVisible":true,"frame":{"x":0,"y":0,"width":10,"height":10},
             "style":{"fills":[{"isEnabled":true,"fillType":1,"gradient":{"gradientType":0,
                "from":"{0, 0}","to":"{1, 1}",
                "stops":[{"position":0,"color":{"red":0,"green":0,"blue":0,"alpha":1}},
                         {"position":1,"color":{"red":1,"green":1,"blue":1,"alpha":1}}]}}]}}
        ]}"#;
        let zip = zip_of(&[
            ("document.json", DOCUMENT_JSON.as_bytes()),
            ("pages/page-1.json", page.as_bytes()),
        ]);
        let doc = import_sketch(&zip).expect("should import");
        match &doc.pages[0].children[0].fill {
            Paint::LinearGradient {
                start, end, stops, ..
            } => {
                assert_eq!(*start, (0.0, 0.0));
                // anchors scale from normalized 0..1 to the 10x10 frame
                assert_eq!(*end, (10.0, 10.0));
                assert_eq!(stops.len(), 2);
            }
            other => panic!("expected LinearGradient, got {other:?}"),
        }
    }

    #[test]
    fn imports_symbol_master_and_instance_with_render_effective_text_override() {
        let page = r#"{"_class":"page","do_objectID":"page-1","layers":[
            {"_class":"symbolMaster","do_objectID":"m1","symbolID":"sym-abc","name":"Button","isVisible":true,
             "frame":{"x":0,"y":0,"width":100,"height":40},"layers":[
                {"_class":"text","do_objectID":"label","isVisible":true,"frame":{"x":10,"y":10,"width":80,"height":20},
                 "attributedString":{"string":"OK"},"style":{"fills":[]}}
             ]},
            {"_class":"symbolInstance","do_objectID":"i1","symbolID":"sym-abc","isVisible":true,
             "frame":{"x":200,"y":0,"width":100,"height":40},
             "overrideValues":[{"overrideName":"label_stringValue","value":"Save"}]}
        ]}"#;
        let zip = zip_of(&[
            ("document.json", DOCUMENT_JSON.as_bytes()),
            ("pages/page-1.json", page.as_bytes()),
        ]);
        let doc = import_sketch(&zip).expect("should import");
        let master = &doc.pages[0].children[0];
        assert!(matches!(&master.kind, NodeKind::Component { name } if name == "Button"));
        let instance = &doc.pages[0].children[1];
        match &instance.kind {
            NodeKind::Instance { component } => assert_eq!(component, "Button"),
            other => panic!("expected Instance, got {other:?}"),
        }
        // AUDIT: must be render-effective — "text:" prefix, keyed by the
        // target layer id, exactly what build_render_tree consumes.
        assert_eq!(
            instance.overrides.get("label"),
            Some(&"text:Save".to_string())
        );
        assert_eq!(instance.transform.x, 200.0, "instance position preserved");
        // and the override actually takes effect through the render IR:
        let tree = x_render::build_render_tree(&doc.pages[0], &x_core::Variables::default());
        let texts: Vec<String> = tree
            .commands
            .iter()
            .filter_map(|c| match c {
                x_render::RenderCommand::Glyphs { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect();
        assert!(
            texts.contains(&"Save".to_string()),
            "override renders: {texts:?}"
        );
    }

    #[test]
    fn artboard_and_group_positions_survive() {
        // AUDIT regression test: draft dropped x/y for artboards + groups
        let page = r#"{"_class":"page","do_objectID":"page-1","layers":[
            {"_class":"artboard","do_objectID":"a1","isVisible":true,
             "frame":{"x":100,"y":50,"width":400,"height":300},"layers":[
                {"_class":"group","do_objectID":"g1","isVisible":true,
                 "frame":{"x":25,"y":35,"width":100,"height":80},"layers":[]}
             ]}
        ]}"#;
        let zip = zip_of(&[
            ("document.json", DOCUMENT_JSON.as_bytes()),
            ("pages/page-1.json", page.as_bytes()),
        ]);
        let doc = import_sketch(&zip).expect("should import");
        let ab = &doc.pages[0].children[0];
        assert_eq!((ab.transform.x, ab.transform.y), (100.0, 50.0));
        let g = &ab.children[0];
        assert_eq!((g.transform.x, g.transform.y), (25.0, 35.0));
        // page auto-sized to content envelope, not left 0x0
        assert!(doc.pages[0].w >= 500.0 && doc.pages[0].h >= 350.0);
    }

    #[test]
    fn layer_opacity_is_read_from_context_settings() {
        // AUDIT regression test: draft read contextSettings as a number
        let page = r#"{"_class":"page","do_objectID":"page-1","layers":[
            {"_class":"rectangle","do_objectID":"r1","isVisible":true,
             "frame":{"x":0,"y":0,"width":10,"height":10},
             "style":{"contextSettings":{"_class":"graphicsContextSettings","blendMode":0,"opacity":0.35},
                      "fills":[{"isEnabled":true,"fillType":0,"color":{"red":0,"green":0,"blue":1,"alpha":1}}]}}
        ]}"#;
        let zip = zip_of(&[
            ("document.json", DOCUMENT_JSON.as_bytes()),
            ("pages/page-1.json", page.as_bytes()),
        ]);
        let doc = import_sketch(&zip).expect("should import");
        assert!((doc.pages[0].children[0].opacity - 0.35).abs() < 1e-6);
    }

    #[test]
    fn shape_group_fill_propagates_to_child_paths() {
        // AUDIT regression test: draft left combined-shape children
        // transparent (Sketch styles live on the shapeGroup, not children)
        let page = r#"{"_class":"page","do_objectID":"page-1","layers":[
            {"_class":"shapeGroup","do_objectID":"sg1","isVisible":true,
             "frame":{"x":0,"y":0,"width":100,"height":100},
             "style":{"fills":[{"isEnabled":true,"fillType":0,"color":{"red":0,"green":1,"blue":0,"alpha":1}}]},
             "layers":[
                {"_class":"shapePath","do_objectID":"p1","isVisible":true,"isClosed":true,
                 "frame":{"x":0,"y":0,"width":100,"height":100},
                 "points":[{"point":"{0, 0}"},{"point":"{1, 0}"},{"point":"{1, 1}"}]}
             ]}
        ]}"#;
        let zip = zip_of(&[
            ("document.json", DOCUMENT_JSON.as_bytes()),
            ("pages/page-1.json", page.as_bytes()),
        ]);
        let doc = import_sketch(&zip).expect("should import");
        let child = &doc.pages[0].children[0].children[0];
        assert!(matches!(child.kind, NodeKind::Vector { .. }));
        assert_eq!(child.fill, Paint::Solid(Color::new([0.0, 1.0, 0.0, 1.0])));
    }

    #[test]
    fn hidden_layer_is_kept_with_visible_false() {
        let page = r#"{"_class":"page","do_objectID":"page-1","layers":[
            {"_class":"rectangle","do_objectID":"r1","isVisible":false,"frame":{"x":0,"y":0,"width":1,"height":1},"style":{"fills":[]}},
            {"_class":"rectangle","do_objectID":"r2","isVisible":true,"frame":{"x":5,"y":5,"width":1,"height":1},"style":{"fills":[]}}
        ]}"#;
        let zip = zip_of(&[
            ("document.json", DOCUMENT_JSON.as_bytes()),
            ("pages/page-1.json", page.as_bytes()),
        ]);
        let doc = import_sketch(&zip).expect("should import");
        assert_eq!(doc.pages[0].children.len(), 2);
        assert!(!doc.pages[0].children[0].visible);
        assert!(doc.pages[0].children[1].visible);
    }

    #[test]
    fn vector_star_converts_points_to_beziers() {
        let page = r#"{"_class":"page","do_objectID":"page-1","layers":[
            {"_class":"star","do_objectID":"s1","isVisible":true,"isClosed":true,
             "frame":{"x":0,"y":0,"width":100,"height":100},
             "style":{"fills":[{"isEnabled":true,"fillType":0,"color":{"red":1,"green":1,"blue":0,"alpha":1}}]},
             "points":[
               {"point":"{0.5, 0}","curveFrom":"{0.5, 0}","curveTo":"{0.5, 0}"},
               {"point":"{1, 1}","curveFrom":"{1, 1}","curveTo":"{1, 1}"},
               {"point":"{0, 1}","curveFrom":"{0, 1}","curveTo":"{0, 1}"}]}
        ]}"#;
        let zip = zip_of(&[
            ("document.json", DOCUMENT_JSON.as_bytes()),
            ("pages/page-1.json", page.as_bytes()),
        ]);
        let doc = import_sketch(&zip).expect("should import");
        match &doc.pages[0].children[0].kind {
            NodeKind::Vector { path } => {
                assert!(matches!(path[0], PathCmd::MoveTo(x, y) if x == 50.0 && y == 0.0));
                assert_eq!(
                    path.iter()
                        .filter(|c| matches!(c, PathCmd::CurveTo(..)))
                        .count(),
                    3
                );
                assert!(matches!(path.last(), Some(PathCmd::Close)));
            }
            other => panic!("expected Vector, got {other:?}"),
        }
    }

    #[test]
    fn malformed_document_json_is_an_error_not_a_panic() {
        let zip = zip_of(&[("document.json", b"not json")]);
        assert!(import_sketch(&zip).is_err());
        assert!(import_sketch(b"not a zip at all").is_err());
    }

    #[test]
    fn pages_fallback_scan_without_document_refs() {
        // document.json with no "pages" array -> fallback to pages/*.json
        let docjson = br#"{"_class":"document","do_objectID":"doc-1"}"#;
        let page = r#"{"_class":"page","do_objectID":"page-9","layers":[
            {"_class":"oval","do_objectID":"o1","isVisible":true,"frame":{"x":0,"y":0,"width":10,"height":10},"style":{"fills":[]}}
        ]}"#;
        let zip = zip_of(&[
            ("document.json", docjson),
            ("pages/page-9.json", page.as_bytes()),
        ]);
        let doc = import_sketch(&zip).expect("fallback scan works");
        assert_eq!(doc.pages.len(), 1);
        assert_eq!(doc.pages[0].children.len(), 1);
    }

    #[test]
    fn text_with_control_characters_survives_export_and_reimport() {
        // Regression: a tab (or any raw control char) in a text node used
        // to be written verbatim into the package's JSON — invalid JSON,
        // so the exported .sketch could not be re-imported by anyone.
        let mut doc = Document::new();
        doc.pages.push(
            x_core::Node::frame("Page", 400.0, 300.0).child(x_core::Node::text(
                "Tab",
                0.0,
                0.0,
                100.0,
                20.0,
                "a\tb\u{1}c\"d\\e",
            )),
        );
        let bytes = export_sketch(&doc);
        let back = import_sketch(&bytes).expect("own sketch package must re-import");
        assert!(
            matches!(&back.pages[0].children[0].kind,
            x_core::NodeKind::Text { text } if text == "a\tb\u{1}c\"d\\e"),
            "control characters must survive the round trip"
        );
    }

    #[test]
    fn imports_fill_override_with_alpha_as_8_digit_hex() {
        let page = r#"{"_class":"page","do_objectID":"page-1","layers":[
            {"_class":"symbolMaster","do_objectID":"m1","symbolID":"sym-abc","name":"Button","isVisible":true,
             "frame":{"x":0,"y":0,"width":100,"height":40},"layers":[
                {"_class":"rectangle","do_objectID":"label","isVisible":true,"frame":{"x":10,"y":10,"width":80,"height":20},
                 "style":{"fills":[]}}
             ]},
            {"_class":"symbolInstance","do_objectID":"i1","symbolID":"sym-abc","isVisible":true,
             "frame":{"x":200,"y":0,"width":100,"height":40},
             "overrideValues":[
                {"overrideName":"label_fillColor","value":{"red":1.0,"green":0.0,"blue":0.0,"alpha":0.50196078431}}
             ]}
        ]}"#;
        let zip = zip_of(&[
            ("document.json", DOCUMENT_JSON.as_bytes()),
            ("pages/page-1.json", page.as_bytes()),
        ]);
        let doc = import_sketch(&zip).expect("should import");
        let instance = &doc.pages[0].children[1];
        // alpha < 1 keeps the 8-digit #rrggbbaa form the renderer parses
        assert_eq!(
            instance.overrides.get("label"),
            Some(&"#ff000080".to_string())
        );
    }

    #[test]
    fn imports_fill_and_opacity_overrides_on_distinct_layers() {
        let page = r#"{"_class":"page","do_objectID":"page-1","layers":[
            {"_class":"symbolMaster","do_objectID":"m1","symbolID":"sym-abc","name":"Card","isVisible":true,
             "frame":{"x":0,"y":0,"width":200,"height":100},"layers":[
                {"_class":"rectangle","do_objectID":"bg","isVisible":true,"frame":{"x":0,"y":0,"width":200,"height":100},"style":{"fills":[]}},
                {"_class":"rectangle","do_objectID":"accent","isVisible":true,"frame":{"x":0,"y":80,"width":200,"height":20},"style":{"fills":[]}}
             ]},
            {"_class":"symbolInstance","do_objectID":"i1","symbolID":"sym-abc","isVisible":true,
             "frame":{"x":10,"y":0,"width":200,"height":100},
             "overrideValues":[
                {"overrideName":"bg_fillColor","value":{"red":0.118,"green":0.533,"blue":0.898,"alpha":1.0}},
                {"overrideName":"accent_opacity","value":0.25}
             ]}
        ]}"#;
        let zip = zip_of(&[
            ("document.json", DOCUMENT_JSON.as_bytes()),
            ("pages/page-1.json", page.as_bytes()),
        ]);
        let doc = import_sketch(&zip).expect("should import");
        let instance = &doc.pages[0].children[1];
        // fill floats round (0.533*255 -> 136) into the #hex encoding;
        // opacity keeps the "opacity:N" encoding — both render-effective
        assert_eq!(instance.overrides.get("bg"), Some(&"#1e88e5".to_string()));
        assert_eq!(
            instance.overrides.get("accent"),
            Some(&"opacity:0.25".to_string())
        );
    }

    #[test]
    fn symbol_swaps_import_and_bitmap_swaps_skip_with_diagnostic() {
        let page = r#"{"_class":"page","do_objectID":"page-1","layers":[
            {"_class":"symbolMaster","do_objectID":"m1","symbolID":"sym-abc","name":"Card","isVisible":true,
             "frame":{"x":0,"y":0,"width":100,"height":40},"layers":[]},
            {"_class":"symbolMaster","do_objectID":"m2","symbolID":"sym-xyz","name":"Photo","isVisible":true,
             "frame":{"x":0,"y":100,"width":100,"height":40},"layers":[]},
            {"_class":"symbolInstance","do_objectID":"i1","symbolID":"sym-abc","isVisible":true,
             "frame":{"x":10,"y":0,"width":100,"height":40},
             "overrideValues":[
                {"overrideName":"nested_symbolID","value":"sym-xyz"},
                {"overrideName":"pic_imageName","value":"photo.png"}
             ]}
        ]}"#;
        let zip = zip_of(&[
            ("document.json", DOCUMENT_JSON.as_bytes()),
            ("pages/page-1.json", page.as_bytes()),
        ]);
        let (doc, report) = import_sketch_with_report(&zip).expect("should import");
        let instance = &doc.pages[0].children[2];
        // symbol swap resolves through the symbol table to the master NAME
        assert_eq!(
            instance.overrides.get("nested"),
            Some(&"swap:Photo".to_string())
        );
        // bitmap swap still skipped — no image bytes at import time
        assert!(
            !instance.overrides.contains_key("pic"),
            "bitmap swap not imported: {:?}",
            instance.overrides
        );
        assert!(
            report
                .diagnostics
                .iter()
                .any(|d| d.contains("bitmap swap override")),
            "diagnostic emitted: {:?}",
            report.diagnostics
        );
    }

    #[test]
    fn resizing_constraints_import_to_pins() {
        // Sketch bitmask: each pin CLEARS a bit from 63 (1=right, 2=width,
        // 4=left, 8=bottom, 16=height, 32=top). Authoritative values from
        // sketch-constructor's resizingConstraints map.
        let page = r#"{"_class":"page","do_objectID":"page-1","layers":[
            {"_class":"rectangle","do_objectID":"r63","isVisible":true,"resizingConstraint":63,
             "frame":{"x":0,"y":0,"width":10,"height":10},"style":{"fills":[]}},
            {"_class":"rectangle","do_objectID":"r27","isVisible":true,"resizingConstraint":27,
             "frame":{"x":0,"y":0,"width":10,"height":10},"style":{"fills":[]}},
            {"_class":"rectangle","do_objectID":"r58","isVisible":true,"resizingConstraint":58,
             "frame":{"x":0,"y":0,"width":10,"height":10},"style":{"fills":[]}},
            {"_class":"rectangle","do_objectID":"r23","isVisible":true,"resizingConstraint":23,
             "frame":{"x":0,"y":0,"width":10,"height":10},"style":{"fills":[]}},
            {"_class":"rectangle","do_objectID":"rnone","isVisible":true,
             "frame":{"x":0,"y":0,"width":10,"height":10},"style":{"fills":[]}}
        ]}"#;
        let zip = zip_of(&[
            ("document.json", DOCUMENT_JSON.as_bytes()),
            ("pages/page-1.json", page.as_bytes()),
        ]);
        let doc = import_sketch(&zip).expect("should import");
        let kids = &doc.pages[0].children;
        // 63 = nothing pinned -> scale (Sketch's resize default)
        assert_eq!(
            (kids[0].pin.0, kids[0].pin.1),
            (HPin::ScaleH, VPin::ScaleV),
            "63"
        );
        // 27 = top+left pinned, size fixed
        assert_eq!(
            (kids[1].pin.0, kids[1].pin.1),
            (HPin::Left, VPin::Top),
            "27"
        );
        // 58 = left+right pinned (stretch width), vertical scale
        assert_eq!(
            (kids[2].pin.0, kids[2].pin.1),
            (HPin::StretchH, VPin::ScaleV),
            "58"
        );
        // 23 = top+bottom pinned (stretch height), horizontal scale
        assert_eq!(
            (kids[3].pin.0, kids[3].pin.1),
            (HPin::ScaleH, VPin::StretchV),
            "23"
        );
        // absent -> our Left/Top default
        assert_eq!(
            (kids[4].pin.0, kids[4].pin.1),
            (HPin::Left, VPin::Top),
            "absent"
        );
    }

    #[test]
    fn resizing_constraints_round_trip_through_export() {
        // pins -> rc on export, rc -> pins on import
        let mut doc = Document::new();
        doc.pages.push(x_core::Node::frame("p1", 400.0, 300.0));
        let mut n = x_core::Node::rect(
            "n1",
            0.0,
            0.0,
            10.0,
            10.0,
            Color::from_rgb8(0xcc, 0xcc, 0xcc),
        );
        n.pin = (HPin::Left, VPin::Top); // Left&61=57, Top&47=15 -> 57&15=9
        doc.pages[0].children.push(n);
        let mut n = x_core::Node::rect(
            "n2",
            0.0,
            0.0,
            10.0,
            10.0,
            Color::from_rgb8(0xcc, 0xcc, 0xcc),
        );
        n.pin = (HPin::StretchH, VPin::ScaleV); // (59&62)&63 = 58
        doc.pages[0].children.push(n);
        let zip = export_sketch(&doc);
        let back = import_sketch(&zip).expect("should import");
        let kids = &back.pages[0].children;
        assert_eq!((kids[0].pin.0, kids[0].pin.1), (HPin::Left, VPin::Top));
        assert_eq!(
            (kids[1].pin.0, kids[1].pin.1),
            (HPin::StretchH, VPin::ScaleV)
        );
    }

    #[test]
    fn instance_overrides_round_trip_through_export() {
        let mut doc = Document::new();
        doc.pages.push(x_core::Node::frame("p1", 400.0, 300.0));
        let mut master = x_core::Node::component("m1", "Button", 100.0, 40.0);
        master
            .children
            .push(x_core::Node::text("label", 10.0, 10.0, 80.0, 20.0, "OK"));
        doc.pages[0].children.push(master);
        let mut inst = x_core::Node::instance("i1", "Button", 200.0, 0.0, 100.0, 40.0);
        inst.overrides.insert("label".into(), "text:Save".into());
        inst.overrides.insert("bg".into(), "#1e88e5".into());
        inst.overrides
            .insert("accent".into(), "opacity:0.25".into());
        doc.pages[0].children.push(inst);
        let zip = export_sketch(&doc);
        let back = import_sketch(&zip).expect("should import");
        let instance = &back.pages[0].children[1];
        // masters export their human component name — the symbol table
        // resolves it back (regression guard for name == id loss)
        match &instance.kind {
            NodeKind::Instance { component } => assert_eq!(component, "Button"),
            other => panic!("expected Instance, got {other:?}"),
        }
        assert_eq!(
            instance.overrides.get("label"),
            Some(&"text:Save".to_string()),
            "text override survives"
        );
        assert_eq!(
            instance.overrides.get("bg"),
            Some(&"#1e88e5".to_string()),
            "fill override survives"
        );
        assert_eq!(
            instance.overrides.get("accent"),
            Some(&"opacity:0.25".to_string()),
            "opacity override survives"
        );
    }

    #[test]
    fn bitmap_layers_round_trip_through_export() {
        // AUDIT regression: the bitmap pipeline is complete end-to-end —
        // export embeds images/<hash>.png, import re-registers the bytes
        // into the content-addressed AssetStore (decode lives in x-render).
        let png = make_png_bytes(4, 2);
        let mut doc = Document::new();
        doc.pages.push(x_core::Node::frame("p1", 400.0, 300.0));
        let asset_id = doc
            .assets
            .register("hero.png", png.clone(), x_core::AssetSource::Embedded);
        doc.pages[0]
            .children
            .push(x_core::Node::image("img1", 0.0, 0.0, 40.0, 20.0, &asset_id));
        let zip = export_sketch(&doc);
        let back = import_sketch(&zip).expect("should import");
        match &back.pages[0].children[0].kind {
            NodeKind::Image { asset, .. } => {
                assert_eq!(
                    asset, &asset_id,
                    "same content-addressed asset id round-trips"
                );
                assert!(
                    back.assets.get(asset).is_some(),
                    "asset record present in imported store"
                );
            }
            other => panic!("expected Image, got {other:?}"),
        }
        assert_eq!(
            back.assets.get(&asset_id).map(|r| r.bytes.clone()),
            Some(png),
            "byte-identical asset"
        );
    }

    /// Minimal valid PNG with an IHDR big enough for probe_dimensions.
    fn make_png_bytes(w: u32, h: u32) -> Vec<u8> {
        let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        // IHDR
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&w.to_be_bytes());
        ihdr.extend_from_slice(&h.to_be_bytes());
        ihdr.extend_from_slice(&[8, 0, 0, 0, 0]); // 8-bit grayscale
        push_chunk(&mut out, b"IHDR", &ihdr);
        // IDAT: each row = filter byte 0 + w zero bytes; zlib stored block
        let mut raw = Vec::new();
        for _ in 0..h {
            raw.push(0u8);
            raw.extend(std::iter::repeat_n(0u8, w as usize));
        }
        let mut idat = vec![0x78, 0x01]; // zlib header, stored
        idat.extend_from_slice(&(raw.len() as u16).to_le_bytes());
        idat.push(0);
        idat.push(0); // NLEN complement
        idat.extend_from_slice(&raw);
        let mut adler = 1u32; // adler32 of raw (values not validated by sniff)
        for b in &raw {
            adler = (adler + *b as u32) % 65521 * 2 % 65521;
        }
        idat.extend_from_slice(&adler.to_be_bytes());
        push_chunk(&mut out, b"IDAT", &idat);
        push_chunk(&mut out, b"IEND", &[]);
        out
    }

    fn push_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        let mut crc = 0xFFFF_FFFFu32;
        for b in kind.iter().chain(data) {
            crc ^= *b as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        out.extend_from_slice(&(!crc).to_be_bytes());
    }

    #[test]
    fn boolean_group_subtract_flattens_to_vector() {
        // AUDIT: boolean shapeGroups used to import as overlapping shapes
        // (visually wrong). Now they flatten through the exact boolean
        // geometry — same model as the editor's own boolean command.
        let page = r#"{"_class":"page","do_objectID":"page-1","layers":[
            {"_class":"shapeGroup","do_objectID":"bg1","hasBooleanOperation":true,"isVisible":true,
             "frame":{"x":10,"y":20,"width":100,"height":100},"style":{"fills":[{"_class":"color","color":{"red":1,"green":0,"blue":0,"alpha":1}}]},
             "layers":[
                {"_class":"rectangle","do_objectID":"base","booleanOperation":-1,"isVisible":true,
                 "frame":{"x":0,"y":0,"width":100,"height":100},"style":{"fills":[]}},
                {"_class":"rectangle","do_objectID":"hole","booleanOperation":1,"isVisible":true,
                 "frame":{"x":60,"y":60,"width":30,"height":30},"style":{"fills":[]}}
             ]}
        ]}"#;
        let zip = zip_of(&[
            ("document.json", DOCUMENT_JSON.as_bytes()),
            ("pages/page-1.json", page.as_bytes()),
        ]);
        let doc = import_sketch(&zip).expect("should import");
        let n = &doc.pages[0].children[0];
        let x_core::NodeKind::Vector { path } = &n.kind else {
            panic!("boolean group must flatten to a vector, got {:?}", n.kind)
        };
        assert!(!path.is_empty(), "flattened path is non-empty");
        // base rect minus the strictly-inside bite: bbox is the base rect
        assert!((n.transform.x - 10.0).abs() < 1.0, "x {}", n.transform.x);
        assert!((n.transform.y - 20.0).abs() < 1.0, "y {}", n.transform.y);
        assert!((n.w - 100.0).abs() < 2.0, "w {}", n.w);
        assert!((n.h - 100.0).abs() < 2.0, "h {}", n.h);
        // the group's fill carries over to the flattened shape
        assert!(matches!(&n.fill, Paint::Solid(c) if c.to_rgba8().r == 255));
    }

    #[test]
    fn boolean_union_of_disjoint_shapes_keeps_both_contours() {
        let page = r#"{"_class":"page","do_objectID":"page-1","layers":[
            {"_class":"shapeGroup","do_objectID":"bg1","hasBooleanOperation":true,"isVisible":true,
             "frame":{"x":10,"y":20,"width":110,"height":50},"style":{"fills":[]},
             "layers":[
                {"_class":"rectangle","do_objectID":"a","booleanOperation":-1,"isVisible":true,
                 "frame":{"x":0,"y":0,"width":50,"height":50},"style":{"fills":[]}},
                {"_class":"rectangle","do_objectID":"b","booleanOperation":0,"isVisible":true,
                 "frame":{"x":60,"y":0,"width":50,"height":50},"style":{"fills":[]}}
             ]}
        ]}"#;
        let zip = zip_of(&[
            ("document.json", DOCUMENT_JSON.as_bytes()),
            ("pages/page-1.json", page.as_bytes()),
        ]);
        let doc = import_sketch(&zip).expect("should import");
        let n = &doc.pages[0].children[0];
        let x_core::NodeKind::Vector { path } = &n.kind else {
            panic!("expected vector, got {:?}", n.kind)
        };
        let contours = path
            .iter()
            .filter(|c| matches!(c, PathCmd::MoveTo(..)))
            .count();
        assert!(
            contours >= 2,
            "disjoint union keeps both contours, got {contours}"
        );
        assert!((n.w - 110.0).abs() < 2.0, "union width {}", n.w);
    }

    #[test]
    fn boolean_group_with_rotated_child_falls_back_to_plain_group() {
        let page = r#"{"_class":"page","do_objectID":"page-1","layers":[
            {"_class":"shapeGroup","do_objectID":"bg1","hasBooleanOperation":true,"isVisible":true,
             "frame":{"x":0,"y":0,"width":100,"height":100},"style":{"fills":[]},
             "layers":[
                {"_class":"rectangle","do_objectID":"a","booleanOperation":-1,"isVisible":true,
                 "frame":{"x":0,"y":0,"width":100,"height":100},"style":{"fills":[]}},
                {"_class":"rectangle","do_objectID":"b","booleanOperation":1,"rotation":45,"isVisible":true,
                 "frame":{"x":30,"y":30,"width":40,"height":40},"style":{"fills":[]}}
             ]}
        ]}"#;
        let zip = zip_of(&[
            ("document.json", DOCUMENT_JSON.as_bytes()),
            ("pages/page-1.json", page.as_bytes()),
        ]);
        let (doc, report) = import_sketch_with_report(&zip).expect("should import");
        let n = &doc.pages[0].children[0];
        // honest fallback: plain group with both shapes, plus a diagnostic
        assert!(
            matches!(n.kind, NodeKind::Group),
            "rotated child -> plain group, got {:?}",
            n.kind
        );
        assert_eq!(n.children.len(), 2);
        assert!(
            report
                .diagnostics
                .iter()
                .any(|d| d.contains("rotated child")),
            "diagnostic: {:?}",
            report.diagnostics
        );
    }

    #[test]
    fn symbol_swap_override_renders_the_swapped_master() {
        let page = r#"{"_class":"page","do_objectID":"page-1","layers":[
            {"_class":"symbolMaster","do_objectID":"m1","symbolID":"sym-btn","name":"Button","isVisible":true,
             "frame":{"x":0,"y":0,"width":100,"height":40},"layers":[
                {"_class":"text","do_objectID":"label","isVisible":true,"frame":{"x":10,"y":10,"width":80,"height":20},
                 "attributedString":{"string":"OK"},"style":{"fills":[]}},
                {"_class":"symbolInstance","do_objectID":"slot","symbolID":"sym-btn","isVisible":true,
                 "frame":{"x":0,"y":0,"width":100,"height":40},"overrideValues":[]}
             ]},
            {"_class":"symbolMaster","do_objectID":"m2","symbolID":"sym-badge","name":"Badge","isVisible":true,
             "frame":{"x":0,"y":100,"width":100,"height":40},"layers":[
                {"_class":"text","do_objectID":"btxt","isVisible":true,"frame":{"x":5,"y":5,"width":90,"height":30},
                 "attributedString":{"string":"B"},"style":{"fills":[]}}
             ]},
            {"_class":"symbolInstance","do_objectID":"i1","symbolID":"sym-btn","isVisible":true,
             "frame":{"x":200,"y":0,"width":100,"height":40},
             "overrideValues":[{"overrideName":"slot_symbolID","value":"sym-badge"}]}
        ]}"#;
        let zip = zip_of(&[
            ("document.json", DOCUMENT_JSON.as_bytes()),
            ("pages/page-1.json", page.as_bytes()),
        ]);
        let doc = import_sketch(&zip).expect("should import");
        let instance = &doc.pages[0].children[2];
        assert_eq!(
            instance.overrides.get("slot"),
            Some(&"swap:Badge".to_string())
        );
        // render-effective: the swap actually substitutes Badge's content
        let tree = x_render::build_render_tree(&doc.pages[0], &x_core::Variables::default());
        let texts: Vec<String> = tree
            .commands
            .iter()
            .filter_map(|c| match c {
                x_render::RenderCommand::Glyphs { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect();
        assert!(
            texts.contains(&"B".to_string()),
            "swapped master renders: {texts:?}"
        );
    }

    #[test]
    fn symbol_swap_override_round_trips_through_export() {
        let mut doc = Document::new();
        doc.pages.push(x_core::Node::frame("p1", 400.0, 300.0));
        doc.pages[0]
            .children
            .push(x_core::Node::component("m1", "Button", 100.0, 40.0));
        doc.pages[0]
            .children
            .push(x_core::Node::component("m2", "Photo", 100.0, 40.0));
        let mut inst = x_core::Node::instance("i1", "Button", 200.0, 0.0, 100.0, 40.0);
        inst.overrides.insert("slot".into(), "swap:Photo".into());
        doc.pages[0].children.push(inst);
        let zip = export_sketch(&doc);
        let back = import_sketch(&zip).expect("should import");
        let instance = &back.pages[0].children[2];
        assert_eq!(
            instance.overrides.get("slot"),
            Some(&"swap:Photo".to_string()),
            "swap override survives export"
        );
    }

    #[test]
    fn text_typography_imports_from_attribute_run() {
        // font name/size, color, kerning, minimumLineHeight — the first
        // attribute run approximates the whole text
        let page = r#"{"_class":"page","do_objectID":"page-1","layers":[
            {"_class":"text","do_objectID":"t1","isVisible":true,
             "frame":{"x":10,"y":10,"width":200,"height":16},
             "attributedString":{"string":"Headline","attributes":[{"location":0,"length":8,"attributes":{
                "NSFontAttribute":{"_class":"font","name":"Roboto-Medium","size":24},
                "MSAttributedStringColorAttribute":{"_class":"color","color":{"red":1,"green":0,"blue":0,"alpha":1}},
                "kerning":0.5,
                "paragraphStyle":{"_class":"paragraphStyle","alignment":0,"minimumLineHeight":30}
             }}]},
             "style":{"fills":[]}}
        ]}"#;
        let zip = zip_of(&[
            ("document.json", DOCUMENT_JSON.as_bytes()),
            ("pages/page-1.json", page.as_bytes()),
        ]);
        let doc = import_sketch(&zip).expect("should import");
        let t = &doc.pages[0].children[0];
        assert!(matches!(&t.kind, NodeKind::Text { text } if text == "Headline"));
        assert_eq!(t.h, 24.0, "h becomes the font size");
        assert_eq!(
            t.bindings.get("font").map(String::as_str),
            Some("Roboto-Medium")
        );
        assert_eq!(
            t.bindings.get("lh").map(String::as_str),
            Some("1.25"),
            "30/24 line-height ratio"
        );
        assert_eq!(t.bindings.get("ls").map(String::as_str), Some("0.5"));
        assert!(
            matches!(&t.fill, Paint::Solid(c) if c.to_rgba8().r == 255),
            "color from attribute run"
        );
        // and the render IR actually carries it: PX CONTRACT — the IR size
        // is the real glyph px (legacy em 24 pre-scaled by 0.72), named font
        let tree = x_render::build_render_tree(&doc.pages[0], &x_core::Variables::default());
        let glyphs = tree
            .commands
            .iter()
            .filter_map(|c| match c {
                x_render::RenderCommand::Glyphs { size, font, .. } => Some((*size, font.clone())),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            glyphs,
            vec![(24.0 * 0.72, Some("Roboto-Medium".to_string()))],
            "render-effective typography (legacy em pre-scaled to px)"
        );
    }

    #[test]
    fn multi_run_attributed_string_imports_rich_runs() {
        // "Hi\u{1F600}!" — the emoji is ONE char but TWO UTF-16 units, so a
        // Sketch run at utf16 [2,4) must map to char range [2,3)
        let page = r#"{"_class":"page","doObjectID":"page-1","layers":[
            {"_class":"text","doObjectID":"t1","isVisible":true,
             "frame":{"x":10,"y":10,"width":200,"height":20},
             "attributedString":{"string":"Hi\ud83d\ude00!","attributes":[
                {"location":0,"length":5,"attributes":{
                    "NSFontAttribute":{"_class":"font","name":"Helvetica","size":20},
                    "MSAttributedStringColorAttribute":{"_class":"color","color":{"red":0,"green":0,"blue":0,"alpha":1}}}},
                {"location":2,"length":2,"attributes":{
                    "NSFontAttribute":{"_class":"font","name":"Helvetica-Bold","size":40},
                    "MSAttributedStringColorAttribute":{"_class":"color","color":{"red":1,"green":0,"blue":0,"alpha":1}}}}]},
             "style":{"fills":[]}}
        ]}"#;
        let zip = zip_of(&[
            ("document.json", DOCUMENT_JSON.as_bytes()),
            ("pages/page-1.json", page.as_bytes()),
        ]);
        let doc = import_sketch(&zip).expect("should import");
        let n = &doc.pages[0].children[0];
        assert!(
            matches!(&n.kind, NodeKind::Text { text } if text == "Hi\u{1F600}!"),
            "content: {:?}",
            n.kind
        );
        assert_eq!(
            n.text_runs.len(),
            1,
            "only the differing run is recorded: {:?}",
            n.text_runs
        );
        let r = &n.text_runs[0];
        assert_eq!((r.start, r.len), (2, 1), "utf16 [2,4) -> char [2,3)");
        assert!(
            matches!(r.color, Some(c) if c.to_rgba8().r == 255),
            "run color red"
        );
        assert_eq!(r.size, Some(40.0));
        assert_eq!(r.font.as_deref(), Some("Helvetica-Bold"));
    }

    #[test]
    fn rich_text_runs_round_trip_through_sketch_export() {
        let mut doc = Document::new();
        doc.pages.push(x_core::Node::frame("p1", 400.0, 300.0));
        let mut t = x_core::Node::text("t1", 10.0, 10.0, 200.0, 18.0, "Hi\u{1F600}!");
        t.text_runs = vec![x_core::TextRun {
            start: 2,
            len: 1,
            color: Some(Color::from_rgb8(255, 0, 0)),
            size: Some(36.0),
            font: None,
            weight: None,
            italic: None,
            ls: None,
        }];
        doc.pages[0].children.push(t);
        let zip = export_sketch(&doc);
        // the exported page JSON carries the run in UTF-16 units
        let archive = ZipArchive::open(&zip).expect("zip");
        let pages = archive
            .read_matching(|n| n.starts_with("pages/"))
            .expect("page files");
        let page_json = String::from_utf8_lossy(pages.values().next().unwrap());
        assert!(
            page_json.contains("\"location\":2,\"length\":2"),
            "utf16 location/length: {page_json}"
        );
        // and it imports back to the same char-index run
        let back = import_sketch(&zip).expect("should import");
        let t2 = &back.pages[0].children[0];
        assert_eq!(t2.text_runs.len(), 1);
        assert_eq!((t2.text_runs[0].start, t2.text_runs[0].len), (2, 1));
        assert_eq!(t2.text_runs[0].size, Some(36.0));
        assert!(matches!(t2.text_runs[0].color, Some(c) if c.to_rgba8().r == 255));
    }

    #[test]
    fn pattern_fills_import_with_embedded_image() {
        // minimal PNG header (valid signature + IHDR with 80x40 dims)
        let png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x50\x00\x00\x00\x28\x08\x06\x00\x00\x00";
        let page = r#"{"_class":"page","doObjectID":"page-1","layers":[
            {"_class":"rectangle","doObjectID":"r1","isVisible":true,
             "frame":{"x":0,"y":0,"width":100,"height":50},
             "style":{"fills":[{"isEnabled":true,"fillType":2,
               "image":{"_ref":"images/pat1.png"},
               "patternFillType":0,"patternTileScale":1}]}}
        ]}"#;
        let zip = zip_of(&[
            ("document.json", DOCUMENT_JSON.as_bytes()),
            ("pages/page-1.json", page.as_bytes()),
            ("images/pat1.png", png),
        ]);
        let doc = import_sketch(&zip).expect("should import");
        let n = &doc.pages[0].children[0];
        match &n.fill {
            Paint::Pattern { asset, fit } => {
                assert!(
                    asset.starts_with("asset://"),
                    "content-addressed id: {asset}"
                );
                assert!(*fit == ImageFit::Tile, "patternFillType 0 -> Tile");
                assert!(
                    doc.assets.get(asset).is_some(),
                    "pattern bytes registered in the AssetStore"
                );
            }
            other => panic!("pattern fill lost: {other:?}"),
        }
    }

    #[test]
    fn pattern_fills_round_trip_through_export() {
        let mut doc = Document::new();
        doc.pages.push(x_core::Node::frame("p1", 400.0, 300.0));
        let id = doc.assets.register("cafe", b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x50\x00\x00\x00\x28\x08\x06\x00\x00\x00".to_vec(), x_core::AssetSource::Embedded);
        let r = x_core::Node::rect("r1", 10.0, 10.0, 100.0, 50.0, Color::WHITE).fill_paint(
            Paint::Pattern {
                asset: id,
                fit: ImageFit::Fill,
            },
        );
        doc.pages[0].children.push(r);
        let zip = export_sketch(&doc);
        let archive = ZipArchive::open(&zip).expect("zip");
        let pages = archive
            .read_matching(|n| n.starts_with("pages/"))
            .expect("pages");
        let page_json = String::from_utf8_lossy(pages.values().next().unwrap());
        assert!(
            page_json.contains("\"fillType\":2"),
            "fillType 2 emitted: {page_json}"
        );
        assert!(page_json.contains("images/"), "image ref: {page_json}");
        // re-import: pattern survives with its bytes
        let back = import_sketch(&zip).expect("reimport");
        let n = &back.pages[0].children[0];
        assert!(
            matches!(&n.fill, Paint::Pattern { fit, .. } if *fit == ImageFit::Fill),
            "fit survives: {:?}",
            n.fill
        );
        assert!(
            matches!(&n.fill, Paint::Pattern { asset, .. } if asset.starts_with("asset://")),
            "content-addressed: {:?}",
            n.fill
        );
        assert!(
            matches!(&n.fill, Paint::Pattern { asset, .. } if back.assets.get(asset).is_some()),
            "bytes re-registered"
        );
    }

    #[test]
    fn text_typography_round_trips_through_export() {
        let mut doc = Document::new();
        doc.pages.push(x_core::Node::frame("p1", 400.0, 300.0));
        let mut t = x_core::Node::text("t1", 10.0, 10.0, 200.0, 18.0, "Headline");
        t.bindings.insert("font".into(), "Roboto-Medium".into());
        t.bindings.insert("lh".into(), "1.5".into());
        t.bindings.insert("ls".into(), "0.5".into());
        t.fill = Paint::Solid(Color::from_rgb8(0x1e, 0x88, 0xe5));
        doc.pages[0].children.push(t);
        let zip = export_sketch(&doc);
        let back = import_sketch(&zip).expect("should import");
        let t = &back.pages[0].children[0];
        assert_eq!(t.h, 18.0, "font size survives");
        assert_eq!(
            t.bindings.get("font").map(String::as_str),
            Some("Roboto-Medium")
        );
        assert_eq!(
            t.bindings.get("lh").map(String::as_str),
            Some("1.5"),
            "minimumLineHeight 27 / 18"
        );
        assert_eq!(t.bindings.get("ls").map(String::as_str), Some("0.5"));
        assert!(
            matches!(&t.fill, Paint::Solid(c) if c.to_rgba8().b == 0xe5),
            "text color survives"
        );
    }

    #[test]
    fn gradient_border_imports_and_round_trips() {
        let page = r#"{"_class":"page","do_objectID":"page-1","layers":[
            {"_class":"rectangle","do_objectID":"r1","isVisible":true,
             "frame":{"x":0,"y":0,"width":100,"height":50},"style":{"fills":[],
             "borders":[{"isEnabled":true,"fillType":1,"thickness":3,
               "gradient":{"from":"{0, 0}","to":"{1, 0}","stops":[
                 {"position":0,"color":{"red":1,"green":0,"blue":0,"alpha":1}},
                 {"position":1,"color":{"red":0,"green":0,"blue":1,"alpha":1}}]}}]}}
        ]}"#;
        let zip = zip_of(&[
            ("document.json", DOCUMENT_JSON.as_bytes()),
            ("pages/page-1.json", page.as_bytes()),
        ]);
        let doc = import_sketch(&zip).expect("should import");
        let n = &doc.pages[0].children[0];
        match &n.stroke.paint {
            Paint::LinearGradient {
                start, end, stops, ..
            } => {
                // anchors scaled from normalized to layer pixels
                assert_eq!((*start, *end), ((0.0, 0.0), (100.0, 0.0)));
                assert_eq!(stops.len(), 2);
            }
            other => panic!("gradient border lost: {other:?}"),
        }
        assert_eq!(n.stroke.width, 3.0);
        // render IR carries a gradient BRUSH (no flattening to solid)
        let tree = x_render::build_render_tree(&doc.pages[0], &x_core::Variables::default());
        assert!(tree.commands.iter().any(|c| matches!(c,
            x_render::RenderCommand::StrokePath { brush: b, .. } if matches!(b, x_core::peniko::Brush::Gradient(_)))), "stroke stays a gradient");
        // and it survives our own export
        let back = import_sketch(&export_sketch(&doc)).expect("reimport");
        let n2 = &back.pages[0].children[0];
        assert!(
            matches!(&n2.stroke.paint, Paint::LinearGradient { .. }),
            "gradient border round-trips"
        );
        assert_eq!(n2.stroke.width, 3.0);
    }
}
