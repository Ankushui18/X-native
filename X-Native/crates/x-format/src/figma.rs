//! Figma importer — REST-API JSON documents (`GET /v1/files/:key` shape).
//!
//! Honest scope: the binary `.fig` format is proprietary, undocumented,
//! and version-unstable — NOT parsed here. What IS parsed is the JSON
//! document the official Figma REST API returns (and which tools like
//! `figma-export` save to disk): `{"document": {"children": [pages]}}`.
//! That's the interoperable path Figma itself supports.
//!
//! **Covered**: pages (CANVAS), FRAME/GROUP/COMPONENT/INSTANCE,
//! RECTANGLE (incl. cornerRadius), ELLIPSE, LINE, TEXT (characters +
//! style.fontSize + rich runs: `characterStyleOverrides`/
//! `styleOverrideTable` per-character styling imports as char-index runs
//! and exports back), VECTOR (fillGeometry SVG path data), solid fills,
//! linear/radial gradient fills (gradientHandlePositions), per-node
//! opacity, visibility, rotation, absoluteBoundingBox geometry
//! (converted to parent-relative), instance componentId -> component
//! name resolution, the full stroke stack (multiple strokes, solid OR
//! gradient paints, not just the first), layer effects (drop/inner shadow, layer/background
//! blur) round-tripping through `effects`, and auto-layout (`layoutMode`)
//! mapped onto our native `AutoLayout` model — approximated where the two
//! Figma's per-side padding and independent primary/counter sizing
//! modes map exactly onto our `padding: [l,r,t,b]` + `cross_sizing`,
//! and `constraints` map onto our resize pins (HPin/VPin).
//!
//! **Not covered** (fallback/skip, never panic): boolean ops (imported
//! as their rendered fillGeometry when present), image fills
//! (placeholder asset name, not the actual pixel bytes).
//!
//! Everything lowers through the SHARED Import IR — this file only
//! parses; semantics live in import_ir::lower().

use crate::import_ir::{ImportDoc, ImportKind, ImportNode};
use crate::json::{self, V};
use crate::svg_import::parse_path_d;
use std::collections::HashMap;
use x_core::{Color, Document, GradSpace, Paint};

/// JSON string escaping that covers the FULL control range: JSON forbids
/// raw U+0000–U+001F inside strings, so a text node containing a tab (or
/// any other control char) must not be emitted verbatim. Matches the
/// escaper in serialize.rs (the .x format's emitter).
fn esc_json(s: &str) -> String {
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
fn path_d(path: &[x_core::PathCmd]) -> String {
    path.iter()
        .map(|c| match c {
            x_core::PathCmd::MoveTo(x, y) => format!("M {x} {y}"),
            x_core::PathCmd::LineTo(x, y) => format!("L {x} {y}"),
            x_core::PathCmd::CurveTo(x1, y1, x2, y2, x, y) => {
                format!("C {x1} {y1} {x2} {y2} {x} {y}")
            }
            x_core::PathCmd::Close => "Z".into(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}
/// Serialize a native color at the Figma boundary.
///
/// `peniko::Color::components` are renderer-space components, not the
/// normalized sRGB bytes that Figma's REST schema expects. In particular,
/// mid-tone sRGB values may be stored in a linear working space. Reading the
/// raw array made exported Figma colors visibly darker and also made alpha
/// handling depend on peniko internals. `to_rgba8` is the explicit, stable
/// sRGB conversion for this interchange boundary.
fn figma_color_json(c: Color) -> String {
    let rgba = c.to_rgba8();
    let channel = |v: u8| v as f64 / 255.0;
    format!(
        "{{\"r\":{},\"g\":{},\"b\":{},\"a\":{}}}",
        channel(rgba.r),
        channel(rgba.g),
        channel(rgba.b),
        channel(rgba.a)
    )
}
fn figma_paint_json(p: &Paint, w: f64, h: f64) -> String {
    match p {
        Paint::Solid(c) => format!("{{\"type\":\"SOLID\",\"visible\":true,\"color\":{}}}", figma_color_json(*c)),
        Paint::Variable(_) => "{\"type\":\"SOLID\",\"visible\":true,\"color\":{\"r\":0,\"g\":0,\"b\":0,\"a\":1}}".into(),
        // the Figma REST schema has no pattern paint — honest gray solid
        // fallback (documented lossy, same policy as Variable)
        Paint::Pattern { .. } => "{\"type\":\"SOLID\",\"visible\":true,\"color\":{\"r\":0.6,\"g\":0.6,\"b\":0.6,\"a\":1}}".into(),
        Paint::LinearGradient { start, end, stops, .. } => format!("{{\"type\":\"GRADIENT_LINEAR\",\"visible\":true,\"gradientHandlePositions\":[{{\"x\":{},\"y\":{}}},{{\"x\":{},\"y\":{}}}],\"gradientStops\":[{}]}}", start.0 / w.max(1.0), start.1 / h.max(1.0), end.0 / w.max(1.0), end.1 / h.max(1.0), stops.iter().map(|(t,c)| format!("{{\"position\":{t},\"color\":{}}}", figma_color_json(*c))).collect::<Vec<_>>().join(",")),
        Paint::RadialGradient { center, radius, stops, .. } => format!("{{\"type\":\"GRADIENT_RADIAL\",\"visible\":true,\"gradientHandlePositions\":[{{\"x\":{},\"y\":{}}},{{\"x\":{},\"y\":{}}}],\"gradientStops\":[{}]}}", center.0 / w.max(1.0), center.1 / h.max(1.0), (center.0 + radius) / w.max(1.0), center.1 / h.max(1.0), stops.iter().map(|(t,c)| format!("{{\"position\":{t},\"color\":{}}}", figma_color_json(*c))).collect::<Vec<_>>().join(",")),
        // Figma's REST schema does carry both Phase-6 gradients. Handles are
        // normalized (0..1 of the node box) like the arms above: angular uses
        // center + a unit point at each of the two sweep angles, diamond uses
        // center + the horizontal/vertical radius points.
        Paint::AngularGradient { center, start_angle, end_angle, stops, .. } => {
            let pt = |deg: f64| {
                let r = deg.to_radians();
                (
                    (center.0 + r.cos() * 0.5 * w.max(1.0)) / w.max(1.0),
                    (center.1 + r.sin() * 0.5 * h.max(1.0)) / h.max(1.0),
                )
            };
            let (sx, sy) = pt(*start_angle);
            let (ex, ey) = pt(*end_angle);
            format!("{{\"type\":\"GRADIENT_ANGULAR\",\"visible\":true,\"gradientHandlePositions\":[{{\"x\":{},\"y\":{}}},{{\"x\":{},\"y\":{}}},{{\"x\":{},\"y\":{}}}],\"gradientStops\":[{}]}}", center.0 / w.max(1.0), center.1 / h.max(1.0), sx, sy, ex, ey, stops.iter().map(|(t,c)| format!("{{\"position\":{t},\"color\":{}}}", figma_color_json(*c))).collect::<Vec<_>>().join(","))
        }
        Paint::DiamondGradient { center, width, height, stops, .. } => format!("{{\"type\":\"GRADIENT_DIAMOND\",\"visible\":true,\"gradientHandlePositions\":[{{\"x\":{},\"y\":{}}},{{\"x\":{},\"y\":{}}},{{\"x\":{},\"y\":{}}}],\"gradientStops\":[{}]}}", center.0 / w.max(1.0), center.1 / h.max(1.0), (center.0 + width) / w.max(1.0), center.1 / h.max(1.0), center.0 / w.max(1.0), (center.1 + height) / h.max(1.0), stops.iter().map(|(t,c)| format!("{{\"position\":{t},\"color\":{}}}", figma_color_json(*c))).collect::<Vec<_>>().join(",")),
    }
}

fn figma_effect_json(e: x_core::EffectLayer) -> Option<String> {
    if !e.visible || e.opacity <= 0.0 {
        return None;
    }
    use x_core::Effect::*;
    Some(match e.effect {
        DropShadow { dx, dy, blur, color } => format!("{{\"type\":\"DROP_SHADOW\",\"visible\":true,\"radius\":{},\"color\":{},\"offset\":{{\"x\":{},\"y\":{}}}}}", blur, figma_color_json(color), dx, dy),
        InnerShadow { dx, dy, blur, color } => format!("{{\"type\":\"INNER_SHADOW\",\"visible\":true,\"radius\":{},\"color\":{},\"offset\":{{\"x\":{},\"y\":{}}}}}", blur, figma_color_json(color), dx, dy),
        LayerBlur { radius } => format!("{{\"type\":\"LAYER_BLUR\",\"visible\":true,\"radius\":{radius}}}"),
        BackgroundBlur { radius } => format!("{{\"type\":\"BACKGROUND_BLUR\",\"visible\":true,\"radius\":{radius}}}"),
        Noise { .. } => return None, // Figma doesn't support noise effects
    })
}

fn figma_layout_json(l: &x_core::AutoLayout) -> String {
    let mode = match l.direction {
        x_core::LayoutDirection::Horizontal => "HORIZONTAL",
        x_core::LayoutDirection::Vertical => "VERTICAL",
    };
    let axis_mode = |hug: bool| if hug { "AUTO" } else { "FIXED" };
    let (main_mode, cross_mode) = (
        axis_mode(l.sizing == x_core::Sizing::Hug),
        axis_mode(l.cross() == x_core::Sizing::Hug),
    );
    let counter_align = match l.align {
        x_core::CrossAlign::Start => "MIN",
        x_core::CrossAlign::Center => "CENTER",
        x_core::CrossAlign::End => "MAX",
        x_core::CrossAlign::Baseline => "CENTER",
    };
    let primary_align = match l.distribute {
        x_core::Distribute::Between => "SPACE_BETWEEN",
        x_core::Distribute::Around => "SPACE_AROUND",
        x_core::Distribute::Evenly => "SPACE_EVENLY",
        x_core::Distribute::Packed => "MIN",
    };
    let wrap = if l.wrap == x_core::AutoLayoutWrap::Wrap {
        "WRAP"
    } else {
        "NO_WRAP"
    };
    let [pl, pr, pt, pb] = l.padding;
    format!(",\"layoutMode\":\"{mode}\",\"itemSpacing\":{},\"paddingLeft\":{pl},\"paddingRight\":{pr},\"paddingTop\":{pt},\"paddingBottom\":{pb},\"primaryAxisSizingMode\":\"{main_mode}\",\"counterAxisSizingMode\":\"{cross_mode}\",\"primaryAxisAlignItems\":\"{primary_align}\",\"counterAxisAlignItems\":\"{counter_align}\",\"layoutWrap\":\"{wrap}\"", l.gap)
}

fn export_node(n: &x_core::Node, parent: (f64, f64)) -> String {
    use x_core::NodeKind;
    let ax = parent.0 + n.transform.x;
    let ay = parent.1 + n.transform.y;
    let (ty, mut extra) = match &n.kind {
        NodeKind::Frame { layout } => (
            "FRAME",
            format!(
                "{}{}",
                layout.as_ref().map(figma_layout_json).unwrap_or_default(),
                figma_constraints_json(n)
            ),
        ),
        NodeKind::Group => ("GROUP", figma_constraints_json(n)),
        NodeKind::Section => ("SECTION", figma_constraints_json(n)),
        NodeKind::Component { name } => (
            "COMPONENT",
            format!(",\"description\":\"{}\"", esc_json(name)),
        ),
        NodeKind::Instance { component } => (
            "INSTANCE",
            format!(",\"componentId\":\"{}\"", esc_json(component)),
        ),
        NodeKind::Rect { radius } => ("RECTANGLE", format!(",\"cornerRadius\":{radius}")),
        NodeKind::Ellipse => ("ELLIPSE", String::new()),
        NodeKind::Arc { start, end, ratio } => (
            "VECTOR",
            format!(
                ",\"fillGeometry\":[{{\"path\":\"{}\",\"windingRule\":\"NONZERO\"}}]",
                esc_json(&path_d(&x_core::booleans::arc_path_cmds(
                    n.w, n.h, *start, *end, *ratio
                )))
            ),
        ),
        NodeKind::Poly { sides } => ("POLYGON", format!(",\"pointCount\":{sides}")),
        NodeKind::Star { points, ratio } => (
            "STAR",
            format!(",\"pointCount\":{points},\"starInnerScale\":{ratio}"),
        ),
        NodeKind::Line => ("LINE", String::new()),
        NodeKind::Text { text } => {
            let font = n
                .bindings
                .get("font")
                .cloned()
                .unwrap_or_else(|| "Inter".into());
            let lh = n
                .bindings
                .get("lh")
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(1.2);
            let ls = n
                .bindings
                .get("ls")
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(0.0);
            // rich runs: Figma's mixed-style text encoding — one style id
            // per character + the style table. A char covered by multiple
            // runs takes the LAST run (same rule as the renderer).
            let rich = if n.text_runs.is_empty() {
                String::new()
            } else {
                let total = text.chars().count();
                let ids: Vec<usize> = (0..total)
                    .map(|ci| {
                        n.text_runs
                            .iter()
                            .rposition(|r| ci >= r.start && ci < r.start.saturating_add(r.len))
                            .map(|i| i + 1)
                            .unwrap_or(0)
                    })
                    .collect();
                let table: Vec<String> = n
                    .text_runs
                    .iter()
                    .enumerate()
                    .map(|(i, r)| {
                        let mut st = String::new();
                        if let Some(f) = &r.font {
                            st.push_str(&format!("\"fontFamily\":\"{}\"", esc_json(f)));
                        }
                        if let Some(sz) = r.size {
                            if !st.is_empty() {
                                st.push(',');
                            }
                            st.push_str(&format!("\"fontSize\":{sz}"));
                        }
                        if let Some(c) = r.color {
                            if !st.is_empty() {
                                st.push(',');
                            }
                            st.push_str(&format!(
                                "\"fills\":[{{\"type\":\"SOLID\",\"color\":{}}}]",
                                figma_color_json(c)
                            ));
                        }
                        if let Some(w) = r.weight {
                            if !st.is_empty() {
                                st.push(',');
                            }
                            st.push_str(&format!("\"fontWeight\":{w}"));
                        }
                        if r.italic == Some(true) {
                            if !st.is_empty() {
                                st.push(',');
                            }
                            st.push_str("\"fontStyle\":\"ITALIC\"");
                        }
                        if let Some(ls) = r.ls {
                            if !st.is_empty() {
                                st.push(',');
                            }
                            st.push_str(&format!("\"letterSpacing\":{ls}"));
                        }
                        if st.is_empty() {
                            st = "\"fontSize\":{}".replace("{}", &format!("{}", n.h));
                        }
                        format!("\"{}\":{{{st}}}", i + 1)
                    })
                    .collect();
                format!(
                    ",\"characterStyleOverrides\":[{}],\"styleOverrideTable\":{{{}}}",
                    ids.iter()
                        .map(|i| i.to_string())
                        .collect::<Vec<_>>()
                        .join(","),
                    table.join(",")
                )
            };
            ("TEXT", format!(",\"characters\":\"{}\",\"style\":{{\"fontFamily\":\"{}\",\"fontSize\":{},\"lineHeightPx\":{},\"letterSpacing\":{}}}{}", esc_json(text), esc_json(&font), n.h, n.h * lh, ls, rich))
        }
        NodeKind::Vector { path } => (
            "VECTOR",
            format!(
                ",\"fillGeometry\":[{{\"path\":\"{}\",\"windingRule\":\"NONZERO\"}}]",
                esc_json(&path_d(path))
            ),
        ),
        NodeKind::Image { .. } => ("RECTANGLE", String::new()),
        NodeKind::Slice => ("SLICE", String::new()),
    };
    // resize constraints export for every node kind (absent when default)
    extra.push_str(&figma_constraints_json(n));
    let fills = n
        .active_fills()
        .iter()
        .map(|l| figma_paint_json(&l.paint, n.w, n.h))
        .collect::<Vec<_>>()
        .join(",");
    let strokes = n.active_strokes();
    let stroke_json = if strokes.is_empty() {
        String::new()
    } else {
        let paints = strokes
            .iter()
            .map(|s| figma_paint_json(&s.stroke.paint, n.w, n.h))
            .collect::<Vec<_>>()
            .join(",");
        // Figma has one strokeWeight per node regardless of stack depth —
        // use the first (topmost) stroke's width, same lossy convention
        // real Figma exports use.
        format!(
            ",\"strokes\":[{paints}],\"strokeWeight\":{}",
            strokes[0].stroke.width
        )
    };
    let effects = n
        .active_effects()
        .into_iter()
        .filter_map(figma_effect_json)
        .collect::<Vec<_>>()
        .join(",");
    let children = if n.children.is_empty() {
        String::new()
    } else {
        format!(
            ",\"children\":[{}]",
            n.children
                .iter()
                .map(|c| export_node(c, (ax, ay)))
                .collect::<Vec<_>>()
                .join(",")
        )
    };
    format!("{{\"id\":\"{}\",\"name\":\"{}\",\"type\":\"{ty}\",\"visible\":{},\"opacity\":{},\"rotation\":{},\"absoluteBoundingBox\":{{\"x\":{ax},\"y\":{ay},\"width\":{},\"height\":{}}},\"fills\":[{fills}]{stroke_json},\"effects\":[{effects}]{extra}{children}}}", esc_json(&n.id), esc_json(&n.id), n.visible, n.opacity, -n.transform.rotation, n.w, n.h)
}

/// Export an editable Figma REST-compatible JSON document. This is the
/// documented interchange representation; it is deliberately not labelled
/// as the proprietary binary `.fig` format.
pub fn export_figma_json(doc: &Document) -> String {
    let pages = doc
        .pages
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let name = if p.id.is_empty() {
                format!("Page {}", i + 1)
            } else {
                p.id.clone()
            };
            format!(
                "{{\"id\":\"{}\",\"name\":\"{}\",\"type\":\"CANVAS\",\"children\":[{}]}}",
                esc_json(&p.id),
                esc_json(&name),
                p.children
                    .iter()
                    .map(|c| export_node(c, (0.0, 0.0)))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("{{\"name\":\"X Designer export\",\"components\":{{}},\"document\":{{\"id\":\"0:0\",\"type\":\"DOCUMENT\",\"children\":[{pages}]}}}}")
}

fn s<'a>(v: &'a V, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.str())
}

fn figma_color(v: &V) -> Color {
    // Figma stores unpremultiplied, normalized sRGB channels. Clamp before
    // converting so malformed JSON cannot wrap a negative/out-of-range value
    // through `as u8`; round so .5 maps to the same byte on both boundaries.
    let byte = |value: f64| ((value.clamp(0.0, 1.0) * 255.0).round()) as u8;
    Color::from_rgba8(
        byte(n_or(v, "r", 0.0)),
        byte(n_or(v, "g", 0.0)),
        byte(n_or(v, "b", 0.0)),
        byte(n_or(v, "a", 1.0)),
    )
}
fn n_or(v: &V, key: &str, d: f64) -> f64 {
    v.get(key).and_then(|x| x.num()).unwrap_or(d)
}
fn n_or_opt(v: &V, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.num())
}

fn first_fill(node: &V, w: f64, h: f64) -> Option<Paint> {
    let fills = node.get("fills")?.arr()?;
    let f = fills
        .iter()
        .find(|f| f.get("visible").and_then(V::boolean).unwrap_or(true))?;
    figma_fill_paint(f, w, h)
}

/// One Figma paint object (fill or stroke) -> Paint. SOLID and
/// GRADIENT_LINEAR/RADIAL (handles normalized 0..1, scaled to pixels).
fn figma_fill_paint(f: &V, w: f64, h: f64) -> Option<Paint> {
    let opacity = n_or(f, "opacity", 1.0) as f32;
    match s(f, "type") {
        Some("SOLID") => {
            let mut c = f.get("color").map(figma_color)?;
            // apply the fill-level opacity onto the alpha channel
            c = c.multiply_alpha(opacity.clamp(0.0, 1.0));
            Some(Paint::Solid(c))
        }
        Some(t @ ("GRADIENT_LINEAR" | "GRADIENT_RADIAL")) => {
            let stops: Vec<(f32, Color)> = f
                .get("gradientStops")?
                .arr()?
                .iter()
                .filter_map(|st| {
                    let color = st.get("color").map(figma_color)?;
                    Some((
                        n_or(st, "position", 0.0) as f32,
                        color.multiply_alpha(opacity.clamp(0.0, 1.0)),
                    ))
                })
                .collect();
            if stops.is_empty() {
                return None;
            }
            let handles = f.get("gradientHandlePositions").and_then(V::arr);
            let hp = |i: usize| -> (f64, f64) {
                handles
                    .and_then(|h| h.get(i))
                    .map(|p| (n_or(p, "x", 0.0) * w, n_or(p, "y", 0.0) * h))
                    .unwrap_or((0.0, 0.0))
            };
            if t == "GRADIENT_LINEAR" {
                Some(Paint::LinearGradient {
                    start: hp(0),
                    end: hp(1),
                    stops,
                    space: GradSpace::Srgb,
                })
            } else {
                let c = hp(0);
                let e = hp(1);
                let r = ((e.0 - c.0).powi(2) + (e.1 - c.1).powi(2)).sqrt().max(1.0);
                Some(Paint::RadialGradient {
                    center: c,
                    radius: r,
                    stops,
                    space: GradSpace::Srgb,
                })
            }
        }
        _ => None, // IMAGE fills etc. — handled as placeholder by caller
    }
}

/// absoluteBoundingBox: {x, y, width, height} in canvas coords.
fn bbox(v: &V) -> (f64, f64, f64, f64) {
    match v.get("absoluteBoundingBox") {
        Some(b) => (
            n_or(b, "x", 0.0),
            n_or(b, "y", 0.0),
            n_or(b, "width", 0.0),
            n_or(b, "height", 0.0),
        ),
        None => (0.0, 0.0, 0.0, 0.0),
    }
}

fn collect_component_names(v: &V, out: &mut HashMap<String, String>) {
    // file-level "components" map: id -> {name}
    if let Some(V::Obj(m)) = v.get("components") {
        for (id, c) in m {
            if let Some(name) = s(c, "name") {
                out.insert(id.clone(), name.to_string());
            }
        }
    }
}

/// Layer effects (shadows/blurs): DROP_SHADOW, INNER_SHADOW, LAYER_BLUR,
/// BACKGROUND_BLUR — Figma's full effect set maps 1:1 onto our `Effect`.
fn figma_effects(node: &V) -> Vec<x_core::Effect> {
    let Some(arr) = node.get("effects").and_then(V::arr) else {
        return vec![];
    };
    arr.iter()
        .filter(|e| e.get("visible").and_then(V::boolean).unwrap_or(true))
        .filter_map(|e| {
            let radius = n_or(e, "radius", 0.0);
            let off = e.get("offset");
            let dx = off.map(|o| n_or(o, "x", 0.0)).unwrap_or(0.0);
            let dy = off.map(|o| n_or(o, "y", 0.0)).unwrap_or(0.0);
            let color = e
                .get("color")
                .map(figma_color)
                .unwrap_or(Color::from_rgba8(0, 0, 0, 255));
            match s(e, "type") {
                Some("DROP_SHADOW") => Some(x_core::Effect::DropShadow {
                    dx,
                    dy,
                    blur: radius,
                    color,
                }),
                Some("INNER_SHADOW") => Some(x_core::Effect::InnerShadow {
                    dx,
                    dy,
                    blur: radius,
                    color,
                }),
                Some("LAYER_BLUR") => Some(x_core::Effect::LayerBlur { radius }),
                Some("BACKGROUND_BLUR") => Some(x_core::Effect::BackgroundBlur { radius }),
                _ => None,
            }
        })
        .collect()
}

/// Figma auto-layout ("layoutMode") -> our native `AutoLayout`. Per-side
/// padding and independent primary/counter sizing modes map exactly:
/// primary -> `sizing` (main axis), counter -> `cross_sizing`.
fn figma_auto_layout(node: &V) -> Option<x_core::AutoLayout> {
    let mode = s(node, "layoutMode")?;
    let direction = match mode {
        "HORIZONTAL" => x_core::LayoutDirection::Horizontal,
        "VERTICAL" => x_core::LayoutDirection::Vertical,
        _ => return None, // "NONE" or unrecognized: no auto-layout
    };
    let padding = [
        n_or(node, "paddingLeft", 0.0),
        n_or(node, "paddingRight", 0.0),
        n_or(node, "paddingTop", 0.0),
        n_or(node, "paddingBottom", 0.0),
    ];
    let hug_main = s(node, "primaryAxisSizingMode") == Some("AUTO");
    let hug_cross = s(node, "counterAxisSizingMode") == Some("AUTO");
    let sizing = if hug_main {
        x_core::Sizing::Hug
    } else {
        x_core::Sizing::Fixed
    };
    let cross_sizing = Some(if hug_cross {
        x_core::Sizing::Hug
    } else {
        x_core::Sizing::Fixed
    });
    let align = match s(node, "counterAxisAlignItems") {
        Some("CENTER") => x_core::CrossAlign::Center,
        Some("MAX") => x_core::CrossAlign::End,
        _ => x_core::CrossAlign::Start,
    };
    let distribute = match s(node, "primaryAxisAlignItems") {
        Some("SPACE_BETWEEN") => x_core::Distribute::Between,
        Some("SPACE_AROUND") => x_core::Distribute::Around,
        Some("SPACE_EVENLY") => x_core::Distribute::Evenly,
        _ => x_core::Distribute::Packed,
    };
    let wrap = if s(node, "layoutWrap") == Some("WRAP") {
        x_core::AutoLayoutWrap::Wrap
    } else {
        x_core::AutoLayoutWrap::NoWrap
    };
    Some(x_core::AutoLayout {
        direction,
        gap: n_or(node, "itemSpacing", 0.0),
        padding,
        sizing,
        cross_sizing,
        align,
        distribute,
        wrap,
        ..Default::default()
    })
}

/// Figma `constraints` -> our resize pins. Accepts the REST spellings
/// (MIN/CENTER/MAX/STRETCH/SCALE) plus the UI-style aliases
/// (LEFT/RIGHT/TOP/BOTTOM/LEFT_RIGHT/TOP_BOTTOM) for lenient input.
pub(crate) fn figma_pins(node: &V) -> (x_core::HPin, x_core::VPin) {
    let c = node.get("constraints");
    let h = c
        .and_then(|c| s(c, "horizontal"))
        .or_else(|| s(node, "horizontalConstraint"));
    let v = c
        .and_then(|c| s(c, "vertical"))
        .or_else(|| s(node, "verticalConstraint"));
    let hp = match h {
        Some("CENTER") => x_core::HPin::CenterH,
        Some("MAX") | Some("RIGHT") => x_core::HPin::Right,
        Some("STRETCH") | Some("LEFT_RIGHT") => x_core::HPin::StretchH,
        Some("SCALE") => x_core::HPin::ScaleH,
        _ => x_core::HPin::Left, // MIN/LEFT/default
    };
    let vp = match v {
        Some("CENTER") => x_core::VPin::CenterV,
        Some("MAX") | Some("BOTTOM") => x_core::VPin::Bottom,
        Some("STRETCH") | Some("TOP_BOTTOM") => x_core::VPin::StretchV,
        Some("SCALE") => x_core::VPin::ScaleV,
        _ => x_core::VPin::Top, // MIN/TOP/default
    };
    (hp, vp)
}

/// Our pins -> Figma `constraints` (canonical REST spellings).
pub(crate) fn figma_constraints_json(n: &x_core::Node) -> String {
    if n.pin == (x_core::HPin::Left, x_core::VPin::Top) {
        return String::new();
    }
    let h = match n.pin.0 {
        x_core::HPin::Left => "MIN",
        x_core::HPin::Right => "MAX",
        x_core::HPin::CenterH => "CENTER",
        x_core::HPin::StretchH => "STRETCH",
        x_core::HPin::ScaleH => "SCALE",
    };
    let v = match n.pin.1 {
        x_core::VPin::Top => "MIN",
        x_core::VPin::Bottom => "MAX",
        x_core::VPin::CenterV => "CENTER",
        x_core::VPin::StretchV => "STRETCH",
        x_core::VPin::ScaleV => "SCALE",
    };
    format!(",\"constraints\":{{\"horizontal\":\"{h}\",\"vertical\":\"{v}\"}}")
}

/// Threaded import context: component map (REST `components`), optional
/// image bytes keyed by `imageRef` (fetched out-of-band from the image
/// endpoint), the accumulated embedded-asset carry, and diagnostics.
struct FigmaCtx<'a> {
    components: &'a HashMap<String, String>,
    images: &'a HashMap<String, Vec<u8>>,
    assets: Vec<(String, Vec<u8>)>,
    diags: Vec<String>,
}

/// First enabled IMAGE fill's `imageRef`, if the node has one.
fn image_ref(node: &V) -> Option<&str> {
    node.get("fills")
        .and_then(V::arr)?
        .iter()
        .filter(|f| f.get("visible").and_then(V::boolean).unwrap_or(true))
        .filter(|f| s(f, "type") == Some("IMAGE"))
        .find_map(|f| s(f, "imageRef"))
}

fn convert(node: &V, parent_abs: (f64, f64), ctx: &mut FigmaCtx) -> Option<ImportNode> {
    let ty = s(node, "type")?;
    let (ax, ay, w, h) = bbox(node);
    // Figma gives absolute canvas coords; our tree is parent-relative
    let (x, y) = (ax - parent_abs.0, ay - parent_abs.1);
    let visible = node.get("visible").and_then(V::boolean).unwrap_or(true);
    let opacity = n_or(node, "opacity", 1.0) as f32;
    // Figma rotation: radians, counter-clockwise positive in its docs;
    // our native convention is clockwise-positive in y-down space, which
    // matches Figma's on-screen behavior directly (both y-down) — Figma's
    // "rotation" field is already the visual angle, negated.
    let rotation = -n_or(node, "rotation", 0.0);
    let fill = first_fill(node, w, h);

    let mut kind = match ty {
        "FRAME" => ImportKind::Frame,
        "GROUP" => ImportKind::Group,
        "COMPONENT" | "COMPONENT_SET" => ImportKind::Component {
            name: s(node, "name").unwrap_or("Component").to_string(),
        },
        "INSTANCE" => {
            let cid = s(node, "componentId").unwrap_or("");
            ImportKind::Instance {
                component: ctx
                    .components
                    .get(cid)
                    .cloned()
                    .unwrap_or_else(|| cid.to_string()),
                overrides: vec![], // REST JSON bakes overrides into children
            }
        }
        "RECTANGLE" => ImportKind::Rect {
            radius: n_or(node, "cornerRadius", 0.0),
        },
        "ELLIPSE" => ImportKind::Ellipse,
        "LINE" => ImportKind::Line,
        "TEXT" => {
            // style: fontSize / fontFamily / lineHeightPx|Percent / letterSpacing
            let st = node.get("style");
            let size = st.map(|st| n_or(st, "fontSize", 0.0)).filter(|v| *v > 0.0);
            let font = st.and_then(|st| s(st, "fontFamily")).map(str::to_string);
            let lh = st.and_then(|st| {
                if let Some(px) = Some(n_or(st, "lineHeightPx", 0.0)).filter(|v| *v > 0.0) {
                    Some(px / size.unwrap_or(px))
                } else {
                    Some(n_or(st, "lineHeightPercentFontSize", 0.0))
                        .filter(|v| *v > 0.0)
                        .map(|p| p / 100.0)
                }
            });
            let ls = st
                .map(|st| n_or(st, "letterSpacing", 0.0))
                .filter(|v| *v != 0.0);
            let content = s(node, "characters").unwrap_or("").to_string();
            // characterStyleOverrides: one styleId PER CHARACTER (0 = base
            // style); styleOverrideTable maps id -> {fontFamily, fontSize,
            // fills}. Consecutive same-id chars group into rich runs
            // (char indices — no UTF-16 conversion needed).
            let mut runs: Vec<x_core::TextRun> = vec![];
            if let Some(ids) = node.get("characterStyleOverrides").and_then(V::arr) {
                let table = node.get("styleOverrideTable");
                let total = content.chars().count();
                let per_char: Vec<usize> = (0..total)
                    .map(|ci| {
                        ids.get(ci)
                            .and_then(V::num)
                            .map(|v| v as usize)
                            .unwrap_or(0)
                    })
                    .collect();
                let mut i = 0;
                while i < total {
                    let id = per_char[i];
                    let mut j = i + 1;
                    while j < total && per_char[j] == id {
                        j += 1;
                    }
                    if id != 0 {
                        let entry = table.and_then(|t| t.get(&id.to_string()));
                        let color = entry
                            .and_then(|e| e.get("fills"))
                            .and_then(V::arr)
                            .and_then(|f| f.first())
                            .and_then(|f| figma_fill_paint(f, 0.0, 0.0))
                            .and_then(|p| {
                                if let Paint::Solid(c) = p {
                                    Some(c)
                                } else {
                                    None
                                }
                            });
                        let size = entry.map(|e| n_or(e, "fontSize", 0.0)).filter(|v| *v > 0.0);
                        let font = entry.and_then(|e| s(e, "fontFamily")).map(str::to_string);
                        let weight = entry
                            .and_then(|e| n_or_opt(e, "fontWeight"))
                            .map(|w| w as u16);
                        let italic = entry
                            .and_then(|e| s(e, "fontStyle"))
                            .map(|fs| fs == "ITALIC");
                        let ls = entry
                            .and_then(|e| n_or_opt(e, "letterSpacing"))
                            .filter(|v| *v != 0.0);
                        if color.is_some()
                            || size.is_some()
                            || font.is_some()
                            || weight.is_some()
                            || italic == Some(true)
                            || ls.is_some()
                        {
                            runs.push(x_core::TextRun {
                                start: i,
                                len: j - i,
                                color,
                                size,
                                font,
                                weight,
                                italic,
                                ls,
                            });
                        }
                    }
                    i = j;
                }
            }
            ImportKind::Text {
                content,
                size,
                font,
                line_height: lh,
                letter_spacing: ls,
                runs,
            }
        }
        "VECTOR" | "STAR" | "REGULAR_POLYGON" | "BOOLEAN_OPERATION" => {
            // fillGeometry: [{path: "M...Z", windingRule}] — SVG path data
            // in node-local coords; reuse the SVG importer's d-parser (one
            // parser, shared semantics).
            let cmds = node
                .get("fillGeometry")
                .and_then(V::arr)
                .and_then(|g| g.first())
                .and_then(|g0| s(g0, "path"))
                .map(parse_path_d)
                .unwrap_or_default();
            if cmds.is_empty() {
                ImportKind::Rect { radius: 0.0 }
            } else {
                ImportKind::Path { cmds }
            }
        }
        "SLICE" => return None,
        _ => return None, // unknown type: skip, never guess
    };
    // an image fill replaces the node kind: Figma paints bytes onto the
    // shape, our model carries images as dedicated Image nodes (same as
    // the Sketch bitmap import)
    if let Some(r) = image_ref(node) {
        if let Some(bytes) = ctx.images.get(r) {
            let name = format!("figma-{r}");
            if !ctx.assets.iter().any(|(n, _)| *n == name) {
                ctx.assets.push((name.clone(), bytes.clone()));
            }
            kind = ImportKind::Image { asset: name };
        } else {
            ctx.diags.push(format!("figma: image fill '{r}' dropped — no bytes supplied (use import_figma_json_with_images)"));
        }
    }

    let mut ir = ImportNode::new(kind)
        .named(s(node, "name").unwrap_or("").to_string())
        .at(x, y)
        .size(w, h);
    if let Some(id) = s(node, "id") {
        ir = ir.id(id);
    }
    // explicit constraints only (None keeps the Left/Top default)
    if node.get("constraints").is_some()
        || s(node, "horizontalConstraint").is_some()
        || s(node, "verticalConstraint").is_some()
    {
        let (hp, vp) = figma_pins(node);
        ir = ir.pin(hp, vp);
    }
    ir.rotation = rotation;
    ir.opacity = opacity;
    ir.visible = visible;
    ir.fill = fill;
    ir.layout = figma_auto_layout(node);
    if let Some(strokes) = node.get("strokes").and_then(V::arr) {
        // strokes share the fill paint vocabulary (solid + gradients)
        let mut paints = strokes
            .iter()
            .filter(|f| f.get("visible").and_then(V::boolean).unwrap_or(true))
            .filter_map(|st| figma_fill_paint(st, w, h));
        let weight = n_or(node, "strokeWeight", 1.0);
        if let Some(p) = paints.next() {
            ir.stroke = Some((p, weight));
        }
        // any additional stroke paints stack on top (same weight — Figma
        // only exposes one strokeWeight per node regardless of stack depth)
        ir.extra_strokes = paints.map(|p| (p, weight)).collect();
    }
    ir.effects = figma_effects(node);
    if let Some(children) = node.get("children").and_then(V::arr) {
        for c in children {
            if let Some(cn) = convert(c, (ax, ay), ctx) {
                ir.children.push(cn);
            }
        }
    }
    Some(ir)
}

/// Parse a Figma REST-API JSON document into the shared Import IR, then
/// lower to a native Document. Image fills are dropped (no bytes) — use
/// `import_figma_json_with_images` to supply them.
pub fn import_figma_json(text: &str) -> Result<Document, String> {
    import_figma_json_with_report_impl(text, &HashMap::new()).map(|(d, _)| d)
}

/// Same, with image bytes keyed by Figma `imageRef` (fetched out-of-band
/// from `GET /v1/images/:key`, which needs a token). Nodes whose first
/// enabled fill is an IMAGE become embedded `Image` nodes; refs without
/// bytes are dropped with a diagnostic in the report.
pub fn import_figma_json_with_images(
    text: &str,
    images: &HashMap<String, Vec<u8>>,
) -> Result<(Document, crate::ImportReport), String> {
    import_figma_json_with_report_impl(text, images)
}

fn import_figma_json_with_report_impl(
    text: &str,
    images: &HashMap<String, Vec<u8>>,
) -> Result<(Document, crate::ImportReport), String> {
    let v = json::parse(text)?;
    let document = v
        .get("document")
        .ok_or("not a Figma REST JSON file (no \"document\")")?;
    let mut components = HashMap::new();
    collect_component_names(&v, &mut components);
    let mut ctx = FigmaCtx {
        components: &components,
        images,
        assets: vec![],
        diags: vec![],
    };

    let mut doc = ImportDoc {
        source: "figma",
        ..Default::default()
    };
    let pages = document
        .get("children")
        .and_then(V::arr)
        .ok_or("document has no pages")?;
    for page in pages {
        if s(page, "type") != Some("CANVAS") {
            continue;
        }
        let mut page_ir = ImportNode::new(ImportKind::Frame);
        if let Some(nm) = s(page, "name") {
            page_ir = page_ir.named(nm);
        }
        if let Some(id) = s(page, "id") {
            page_ir = page_ir.id(id);
        }
        if let Some(children) = page.get("children").and_then(V::arr) {
            // page-level children are positioned at absolute canvas coords;
            // shift the envelope so content starts near the origin
            let (mut minx, mut miny) = (f64::MAX, f64::MAX);
            let mut kids = vec![];
            for c in children {
                if let Some(cn) = convert(c, (0.0, 0.0), &mut ctx) {
                    minx = minx.min(cn.x);
                    miny = miny.min(cn.y);
                    kids.push(cn);
                }
            }
            if minx == f64::MAX {
                minx = 0.0;
                miny = 0.0;
            }
            for mut k in kids {
                k.x -= minx - 40.0;
                k.y -= miny - 40.0;
                page_ir.children.push(k);
            }
        }
        doc.pages.push(page_ir);
    }
    if doc.pages.is_empty() {
        return Err("figma file contains no canvases".into());
    }
    doc.assets = ctx.assets;
    doc.diagnostics = ctx.diags;
    Ok(crate::import_ir::lower_with_report(doc))
}

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::{HPin, NodeKind, Sizing, VPin};

    const FIXTURE: &str = r##"{
      "name": "Test file",
      "components": { "1:10": { "name": "Chip" } },
      "document": {
        "id": "0:0", "type": "DOCUMENT",
        "children": [{
          "id": "0:1", "type": "CANVAS", "name": "Page 1",
          "children": [
            { "id": "1:1", "type": "FRAME", "name": "Screen",
              "absoluteBoundingBox": {"x": 100, "y": 200, "width": 400, "height": 300},
              "fills": [{"type": "SOLID", "color": {"r": 1, "g": 1, "b": 1, "a": 1}}],
              "children": [
                { "id": "1:2", "type": "RECTANGLE", "cornerRadius": 8,
                  "absoluteBoundingBox": {"x": 120, "y": 220, "width": 100, "height": 60},
                  "fills": [{"type": "GRADIENT_LINEAR",
                    "gradientHandlePositions": [{"x":0,"y":0},{"x":1,"y":0}],
                    "gradientStops": [
                      {"position": 0, "color": {"r": 1, "g": 0, "b": 0, "a": 1}},
                      {"position": 1, "color": {"r": 0, "g": 0, "b": 1, "a": 1}}]}] },
                { "id": "1:3", "type": "TEXT", "characters": "Hello Figma",
                  "absoluteBoundingBox": {"x": 120, "y": 300, "width": 200, "height": 24},
                  "fills": [] },
                { "id": "1:4", "type": "VECTOR",
                  "absoluteBoundingBox": {"x": 300, "y": 220, "width": 50, "height": 50},
                  "fillGeometry": [{"path": "M 0 0 L 50 0 L 25 50 Z"}],
                  "fills": [{"type": "SOLID", "color": {"r": 0, "g": 1, "b": 0, "a": 1}}] },
                { "id": "1:5", "type": "INSTANCE", "componentId": "1:10",
                  "absoluteBoundingBox": {"x": 300, "y": 300, "width": 80, "height": 30},
                  "fills": [] }
              ] }
          ] }]
      }
    }"##;

    #[test]
    fn imports_rest_json_through_the_shared_ir() {
        let doc = import_figma_json(FIXTURE).expect("import");
        assert_eq!(doc.pages.len(), 1);
        let frame = &doc.pages[0].children[0];
        assert!(matches!(frame.kind, NodeKind::Frame { .. }));
        assert_eq!((frame.w, frame.h), (400.0, 300.0));
        // children converted to PARENT-RELATIVE coords (120-100=20 …)
        let rect = &frame.children[0];
        assert_eq!((rect.transform.x, rect.transform.y), (20.0, 20.0));
        assert!(matches!(rect.kind, NodeKind::Rect { radius } if radius == 8.0));
        // gradient handles scaled to node pixels
        match &rect.fill {
            Paint::LinearGradient { start, end, .. } => {
                assert_eq!(*start, (0.0, 0.0));
                assert_eq!(*end, (100.0, 0.0));
            }
            other => panic!("expected gradient, got {other:?}"),
        }
        // shared-IR text default: black (empty fills array)
        let text = &frame.children[1];
        assert_eq!(text.fill, Paint::Solid(Color::BLACK));
        assert!(matches!(&text.kind, NodeKind::Text { text } if text == "Hello Figma"));
        // vector fillGeometry parsed via the SHARED svg d-parser
        let vec_node = &frame.children[2];
        match &vec_node.kind {
            NodeKind::Vector { path } => assert_eq!(path.len(), 4),
            other => panic!("expected vector, got {other:?}"),
        }
        // instance resolves componentId -> component name via the file map
        let inst = &frame.children[3];
        assert!(matches!(&inst.kind, NodeKind::Instance { component } if component == "Chip"));
        // ids are figma's (sanitized: "1:2" keeps the colon)
        assert_eq!(rect.id, "1:2");
    }

    #[test]
    fn non_figma_json_is_an_error() {
        assert!(import_figma_json("{}").is_err());
        assert!(import_figma_json("not json").is_err());
    }

    #[test]
    fn figma_color_boundary_uses_normalized_srgb_channels() {
        // `components` is renderer-space data; Figma expects unpremultiplied
        // sRGB values. This catches the classic mid-tone regression where a
        // native 128 gray was exported as its linear-light value (~0.216).
        let value = crate::json::parse(&figma_color_json(Color::from_rgba8(128, 64, 200, 127)))
            .expect("color object is valid JSON");
        assert!((n_or(&value, "r", 0.0) - 128.0 / 255.0).abs() < 1e-9);
        assert!((n_or(&value, "g", 0.0) - 64.0 / 255.0).abs() < 1e-9);
        assert!((n_or(&value, "b", 0.0) - 200.0 / 255.0).abs() < 1e-9);
        assert!((n_or(&value, "a", 0.0) - 127.0 / 255.0).abs() < 1e-9);
    }

    #[test]
    fn figma_fractional_channels_round_trip_without_truncation() {
        let json = r##"{
          "document": { "children": [{ "type": "CANVAS", "id": "p", "children": [
            { "type": "RECTANGLE", "id": "r",
              "absoluteBoundingBox": {"x": 0, "y": 0, "width": 10, "height": 10},
              "fills": [{"type":"SOLID","color":{"r":0.5,"g":0.25,"b":0.75,"a":0.5}}] }
          ] }] }
        }"##;
        let doc = import_figma_json(json).expect("figma import");
        let color = match &doc.pages[0].children[0].fill {
            Paint::Solid(c) => c,
            other => panic!("expected solid color, got {other:?}"),
        };
        // Round-to-nearest is intentional: it keeps the two interchange
        // boundaries within one byte instead of always biasing downward.
        assert_eq!(color.to_rgba8().r, 128);
        assert_eq!(color.to_rgba8().g, 64);
        assert_eq!(color.to_rgba8().b, 191);
        assert_eq!(color.to_rgba8().a, 128);
    }

    #[test]
    fn exported_figma_json_reimports_editable_nodes() {
        let mut doc = Document::new();
        doc.pages.push(
            x_core::Node::frame("Page", 400.0, 300.0).child(
                x_core::Node::rect(
                    "Card",
                    10.0,
                    20.0,
                    120.0,
                    80.0,
                    Color::from_rgb8(20, 40, 200),
                )
                .radius(12.0),
            ),
        );
        let json = export_figma_json(&doc);
        let loaded = import_figma_json(&json).expect("own Figma JSON should import");
        assert_eq!(loaded.pages.len(), 1);
        assert_eq!(loaded.pages[0].children.len(), 1);
    }

    #[test]
    fn export_escapes_control_characters_to_valid_json() {
        // Regression: text containing a tab (or any raw control char) used
        // to be emitted verbatim — invalid JSON that no parser accepts
        // (JSON forbids raw U+0000–U+001F inside strings).
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
        let json = export_figma_json(&doc);
        assert!(
            crate::json::parse(&json).is_ok(),
            "exported JSON must be parseable: {json}"
        );
        // and the content survives the round trip
        let back = import_figma_json(&json).expect("own Figma JSON should import");
        assert!(matches!(&back.pages[0].children[0].kind,
            x_core::NodeKind::Text { text } if text == "a\tb\u{1}c\"d\\e"));
    }

    #[test]
    fn imports_constraints_per_side_padding_and_counter_sizing() {
        let json = r##"{
          "document": { "id": "0:0", "type": "DOCUMENT", "children": [{
            "id": "0:1", "type": "CANVAS", "name": "Page 1",
            "children": [
              { "id": "1:1", "type": "FRAME", "name": "Card",
                "absoluteBoundingBox": {"x": 0, "y": 0, "width": 120, "height": 80},
                "layoutMode": "VERTICAL", "itemSpacing": 8,
                "paddingLeft": 10, "paddingRight": 4, "paddingTop": 6, "paddingBottom": 2,
                "primaryAxisSizingMode": "FIXED", "counterAxisSizingMode": "AUTO",
                "children": [
                  { "id": "1:2", "type": "RECTANGLE", "name": "r",
                    "absoluteBoundingBox": {"x": 10, "y": 6, "width": 100, "height": 40},
                    "constraints": {"horizontal": "STRETCH", "vertical": "CENTER"},
                    "fills": [{"type": "SOLID", "color": {"r": 1, "g": 0, "b": 0, "a": 1}}] }
                ] }
            ] }] }
        }"##;
        let doc = import_figma_json(json).expect("figma import");
        let card = &doc.pages[0].children[0];
        let NodeKind::Frame { layout: Some(l) } = &card.kind else {
            panic!("layout frame")
        };
        assert_eq!(
            l.padding,
            [10.0, 4.0, 6.0, 2.0],
            "exact per-side padding, no averaging"
        );
        assert_eq!(l.sizing, Sizing::Fixed, "primary FIXED -> main Fixed");
        assert_eq!(
            l.cross_sizing,
            Some(Sizing::Hug),
            "counter AUTO -> independent cross hug"
        );
        let r = &card.children[0];
        assert_eq!(
            r.pin,
            (HPin::StretchH, VPin::CenterV),
            "constraints map to resize pins"
        );
        // and back out: export writes them
        let out = export_node(card, (0.0, 0.0));
        assert!(out.contains("\"paddingLeft\":10"));
        assert!(out.contains("\"paddingRight\":4"));
        assert!(out.contains("\"paddingTop\":6"));
        assert!(out.contains("\"paddingBottom\":2"));
        assert!(out.contains("\"counterAxisSizingMode\":\"AUTO\""));
        assert!(
            out.contains("\"constraints\":{\"horizontal\":\"STRETCH\",\"vertical\":\"CENTER\"}")
        );
    }

    #[test]
    fn default_constraints_stay_left_top() {
        // no constraints object -> pins stay at the model default (Left/Top)
        let json = r##"{
          "document": { "id": "0:0", "type": "DOCUMENT", "children": [{
            "id": "0:1", "type": "CANVAS", "children": [
              { "id": "1:1", "type": "RECTANGLE",
                "absoluteBoundingBox": {"x": 0, "y": 0, "width": 10, "height": 10},
                "fills": [] }
            ] }] }
        }"##;
        let doc = import_figma_json(json).expect("figma import");
        assert_eq!(doc.pages[0].children[0].pin, (HPin::Left, VPin::Top));
    }

    #[test]
    fn character_style_overrides_import_as_rich_runs() {
        let json = r##"{
          "name": "T", "document": { "children": [{ "type": "CANVAS", "id": "0:1", "children": [
            { "id": "2:1", "type": "TEXT", "name": "t",
              "absoluteBoundingBox": { "x": 0, "y": 0, "width": 200, "height": 20 },
              "characters": "Bold rest",
              "style": { "fontFamily": "Inter", "fontSize": 16 },
              "characterStyleOverrides": [1,1,1,1,0,0,0,0,0],
              "styleOverrideTable": { "1": { "fontFamily": "Inter-Bold", "fontSize": 24,
                "fills": [ { "type": "SOLID", "color": { "r": 1, "g": 0, "b": 0, "a": 1 } } ] } } }
          ]}]}
        }"##;
        let doc = import_figma_json(json).expect("should import");
        let n = &doc.pages[0].children[0];
        assert!(
            matches!(&n.kind, NodeKind::Text { text } if text == "Bold rest"),
            "content: {:?}",
            n.kind
        );
        assert_eq!(n.text_runs.len(), 1, "one styled group: {:?}", n.text_runs);
        let r = &n.text_runs[0];
        assert_eq!((r.start, r.len), (0, 4), "'Bold' chars 0..4");
        assert!(
            matches!(r.color, Some(c) if c.to_rgba8().r == 255),
            "override fill color"
        );
        assert_eq!(r.size, Some(24.0));
        assert_eq!(r.font.as_deref(), Some("Inter-Bold"));
    }

    #[test]
    fn rich_text_runs_export_to_character_style_overrides() {
        let mut doc = Document::new();
        doc.pages.push(x_core::Node::frame("p1", 400.0, 300.0));
        let mut t = x_core::Node::text("t1", 10.0, 10.0, 200.0, 16.0, "Bold rest");
        t.text_runs = vec![x_core::TextRun {
            start: 0,
            len: 4,
            color: Some(Color::from_rgb8(255, 0, 0)),
            size: None,
            font: None,
            weight: None,
            italic: None,
            ls: None,
        }];
        doc.pages[0].children.push(t);
        let json = export_figma_json(&doc);
        assert!(
            json.contains("\"characterStyleOverrides\":[1,1,1,1,0,0,0,0,0]"),
            "per-char ids: {json}"
        );
        assert!(
            json.contains("\"styleOverrideTable\":{\"1\":"),
            "style table"
        );
        // round-trip: the exported JSON imports back with the same run
        let back = import_figma_json(&json).expect("reimport");
        let n = &back.pages[0].children[0];
        assert_eq!(n.text_runs.len(), 1);
        assert_eq!((n.text_runs[0].start, n.text_runs[0].len), (0, 4));
        assert!(matches!(n.text_runs[0].color, Some(c) if c.to_rgba8().r == 255));
    }

    #[test]
    fn pattern_fills_export_as_solid_fallback() {
        // the Figma REST schema has no pattern paint — export degrades to
        // a visible gray solid instead of dropping the fill
        let mut doc = Document::new();
        doc.pages.push(x_core::Node::frame("p1", 400.0, 300.0));
        doc.pages[0].children.push(
            x_core::Node::rect("r", 10.0, 10.0, 100.0, 50.0, Color::WHITE).fill_paint(
                Paint::Pattern {
                    asset: "asset://cafe".into(),
                    fit: x_core::ImageFit::Tile,
                },
            ),
        );
        let json = export_figma_json(&doc);
        assert!(
            json.contains("\"type\":\"SOLID\""),
            "solid fallback: {json}"
        );
        assert!(json.contains("0.6"), "neutral gray marker");
        assert!(
            !json.contains("asset://"),
            "no asset leakage into Figma JSON"
        );
    }

    #[test]
    fn image_fills_become_image_nodes_when_bytes_are_supplied() {
        let json = r##"{
          "name": "T", "document": { "children": [{ "type": "CANVAS", "id": "0:1", "children": [
            { "id": "2:1", "type": "RECTANGLE", "name": "hero",
              "absoluteBoundingBox": { "x": 0, "y": 0, "width": 80, "height": 40 },
              "fills": [ { "type": "IMAGE", "visible": true, "imageRef": "S1:2", "scaleMode": "FILL" } ] }
          ]}]}
        }"##;
        // minimal sniffable PNG (magic + IHDR header)
        let png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x50\x00\x00\x00\x28\x08\x06\x00\x00\x00";
        let mut images = std::collections::HashMap::new();
        images.insert("S1:2".to_string(), png.to_vec());
        let (doc, report) = import_figma_json_with_images(json, &images).expect("should import");
        match &doc.pages[0].children[0].kind {
            NodeKind::Image { asset, .. } => {
                assert!(
                    asset.starts_with("asset://"),
                    "content-addressed id: {asset}"
                );
                assert_eq!(
                    doc.assets.get(asset).map(|r| r.bytes.clone()),
                    Some(png.to_vec()),
                    "bytes registered"
                );
            }
            other => panic!("expected Image, got {other:?}"),
        }
        assert!(
            !report.diagnostics.iter().any(|d| d.contains("image fill")),
            "no drop diagnostic: {:?}",
            report.diagnostics
        );
    }

    #[test]
    fn image_fills_drop_with_diagnostic_without_bytes() {
        let json = r##"{
          "name": "T", "document": { "children": [{ "type": "CANVAS", "id": "0:1", "children": [
            { "id": "2:1", "type": "RECTANGLE", "name": "hero",
              "absoluteBoundingBox": { "x": 0, "y": 0, "width": 80, "height": 40 },
              "fills": [ { "type": "IMAGE", "visible": true, "imageRef": "S1:2", "scaleMode": "FILL" } ] }
          ]}]}
        }"##;
        let empty = std::collections::HashMap::new();
        let (doc, report) = import_figma_json_with_images(json, &empty).expect("should import");
        assert!(
            !matches!(doc.pages[0].children[0].kind, NodeKind::Image { .. }),
            "no Image node without bytes"
        );
        assert!(
            report
                .diagnostics
                .iter()
                .any(|d| d.contains("image fill 'S1:2' dropped")),
            "diagnostic: {:?}",
            report.diagnostics
        );
    }

    #[test]
    fn text_typography_imports_from_style() {
        let json = r##"{
          "name": "T", "document": { "children": [{ "type": "CANVAS", "id": "0:1", "children": [
            { "id": "2:1", "type": "TEXT", "characters": "Headline",
              "absoluteBoundingBox": { "x": 0, "y": 0, "width": 200, "height": 24 },
              "style": { "fontFamily": "Roboto", "fontSize": 18, "lineHeightPx": 27, "letterSpacing": 0.5 } }
          ]}]}
        }"##;
        let doc = import_figma_json(json).expect("should import");
        let t = &doc.pages[0].children[0];
        assert!(matches!(&t.kind, NodeKind::Text { text } if text == "Headline"));
        assert_eq!(t.h, 18.0, "h becomes the font size");
        assert_eq!(t.bindings.get("font").map(String::as_str), Some("Roboto"));
        assert_eq!(
            t.bindings.get("lh").map(String::as_str),
            Some("1.5"),
            "27/18"
        );
        assert_eq!(t.bindings.get("ls").map(String::as_str), Some("0.5"));
    }

    #[test]
    fn text_typography_round_trips_through_export() {
        let mut doc = Document::new();
        doc.pages.push(x_core::Node::frame("p1", 400.0, 300.0));
        let mut t = x_core::Node::text("t1", 0.0, 0.0, 200.0, 16.0, "Body");
        t.bindings.insert("font".into(), "Inter".into());
        t.bindings.insert("lh".into(), "1.4".into());
        t.bindings.insert("ls".into(), "0.25".into());
        doc.pages[0].children.push(t);
        let json = export_figma_json(&doc);
        let back = import_figma_json(&json).expect("should reimport");
        let t = &back.pages[0].children[0];
        assert_eq!(t.h, 16.0, "fontSize survives");
        assert_eq!(t.bindings.get("font").map(String::as_str), Some("Inter"));
        assert_eq!(t.bindings.get("lh").map(String::as_str), Some("1.4"));
        assert_eq!(t.bindings.get("ls").map(String::as_str), Some("0.25"));
    }

    #[test]
    fn gradient_strokes_import_and_round_trip() {
        let json = r##"{
          "name": "T", "document": { "children": [{ "type": "CANVAS", "id": "0:1", "children": [
            { "id": "2:1", "type": "RECTANGLE", "name": "card",
              "absoluteBoundingBox": { "x": 0, "y": 0, "width": 100, "height": 50 },
              "fills": [], "strokeWeight": 3,
              "strokes": [ { "type": "GRADIENT_LINEAR", "visible": true,
                "gradientHandlePositions": [ { "x": 0, "y": 0 }, { "x": 1, "y": 0 } ],
                "gradientStops": [
                  { "position": 0, "color": { "r": 1, "g": 0, "b": 0, "a": 1 } },
                  { "position": 1, "color": { "r": 0, "g": 0, "b": 1, "a": 1 } } ] } ] }
          ]}]}
        }"##;
        let doc = import_figma_json(json).expect("should import");
        let n = &doc.pages[0].children[0];
        match &n.stroke.paint {
            Paint::LinearGradient {
                start, end, stops, ..
            } => {
                assert_eq!(
                    (*start, *end),
                    ((0.0, 0.0), (100.0, 0.0)),
                    "handles scaled to node pixels"
                );
                assert_eq!(stops.len(), 2);
            }
            other => panic!("gradient stroke lost: {other:?}"),
        }
        assert_eq!(n.stroke.width, 3.0);
        let back = import_figma_json(&export_figma_json(&doc)).expect("reimport");
        let n2 = &back.pages[0].children[0];
        assert!(
            matches!(&n2.stroke.paint, Paint::LinearGradient { .. }),
            "gradient stroke round-trips"
        );
        assert_eq!(n2.stroke.width, 3.0);
    }

    #[test]
    fn rich_text_style_fields_roundtrip_through_figma_json() {
        let red = Color::from_rgb8(0xff, 0x00, 0x00);
        let mut t = x_core::Node::text("t", 0.0, 0.0, 200.0, 24.0, "hello world");
        t.text_runs = vec![
            x_core::TextRun {
                start: 0,
                len: 5,
                color: Some(red),
                size: None,
                font: None,
                weight: Some(700),
                italic: None,
                ls: None,
            },
            x_core::TextRun {
                start: 6,
                len: 5,
                color: None,
                size: Some(30.0),
                font: None,
                weight: None,
                italic: Some(true),
                ls: None,
            },
        ];
        let mut doc = Document::new();
        doc.pages
            .push(x_core::Node::frame("Page", 400.0, 300.0).child(t));
        let json = export_figma_json(&doc);
        assert!(json.contains("styleOverrideTable"), "table exported");
        assert!(
            json.contains("characterStyleOverrides"),
            "overrides exported"
        );
        assert!(json.contains("\"fontWeight\":700"), "weight exported");
        assert!(json.contains("\"fontStyle\":\"ITALIC\""), "italic exported");
        let loaded = import_figma_json(&json).expect("import");
        let t_node = loaded.pages[0]
            .children
            .iter()
            .find(|c| c.id == "t")
            .expect("text node");
        let runs = &t_node.text_runs;
        assert_eq!(runs.len(), 2, "two styled groups: {runs:?}");
        assert_eq!((runs[0].start, runs[0].len), (0, 5));
        assert_eq!(runs[0].color, Some(red));
        assert_eq!(runs[0].weight, Some(700));
        assert_eq!(runs[1].size, Some(30.0));
        assert_eq!(runs[1].italic, Some(true));
    }
}
