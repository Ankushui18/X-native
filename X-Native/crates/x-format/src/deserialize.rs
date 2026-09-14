use crate::json::{P, V};
#[allow(unused_imports)]
use crate::*;
use x_core::document::LegacyStyle;
use x_core::*;

/// Perceptual interpolation flag on gradient paints ("gs":"oklab").
fn parse_grad_space(v: &V) -> GradSpace {
    match v.get("gs").and_then(V::str) {
        Some("oklab") => GradSpace::Oklab,
        _ => GradSpace::Srgb,
    }
}

fn parse_paint(v: &V) -> Paint {
    let t = v.get("t").and_then(V::str).unwrap_or("solid");
    match t {
        "var" => Paint::Variable(v.get("name").and_then(V::str).unwrap_or("").into()),
        "linear" => Paint::LinearGradient {
            start: (
                v.get("x0").and_then(V::num).unwrap_or(0.0),
                v.get("y0").and_then(V::num).unwrap_or(0.0),
            ),
            end: (
                v.get("x1").and_then(V::num).unwrap_or(0.0),
                v.get("y1").and_then(V::num).unwrap_or(0.0),
            ),
            stops: parse_stops(v),
            space: parse_grad_space(v),
        },
        "pattern" => Paint::Pattern {
            asset: v.get("asset").and_then(V::str).unwrap_or("").into(),
            fit: match v.get("fit").and_then(V::str) {
                Some("fit") => ImageFit::Fit,
                Some("crop") => ImageFit::Crop,
                Some("tile") => ImageFit::Tile,
                _ => ImageFit::Fill,
            },
        },
        "radial" => Paint::RadialGradient {
            center: (
                v.get("cx").and_then(V::num).unwrap_or(0.0),
                v.get("cy").and_then(V::num).unwrap_or(0.0),
            ),
            radius: v.get("r").and_then(V::num).unwrap_or(0.0),
            stops: parse_stops(v),
            space: parse_grad_space(v),
        },
        _ => Paint::Solid(
            v.get("c")
                .and_then(V::str)
                .and_then(parse_hex_color)
                .unwrap_or(Color::TRANSPARENT),
        ),
    }
}
fn parse_stops(v: &V) -> Vec<(f32, Color)> {
    v.get("stops")
        .and_then(V::arr)
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    let pair = s.arr()?;
                    Some((
                        pair.first()?.num()? as f32,
                        parse_hex_color(pair.get(1)?.str()?)?,
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_blend(v: Option<&str>) -> BlendKind {
    match v {
        Some("darken") => BlendKind::Darken,
        Some("multiply") => BlendKind::Multiply,
        Some("color-burn") => BlendKind::ColorBurn,
        Some("lighten") => BlendKind::Lighten,
        Some("screen") => BlendKind::Screen,
        Some("color-dodge") => BlendKind::ColorDodge,
        Some("overlay") => BlendKind::Overlay,
        Some("soft-light") => BlendKind::SoftLight,
        Some("hard-light") => BlendKind::HardLight,
        Some("difference") => BlendKind::Difference,
        Some("exclusion") => BlendKind::Exclusion,
        Some("hue") => BlendKind::Hue,
        Some("saturation") => BlendKind::Saturation,
        Some("color") => BlendKind::Color,
        Some("luminosity") => BlendKind::Luminosity,
        _ => BlendKind::Normal,
    }
}
fn parse_cap(v: Option<&str>) -> StrokeCap {
    match v {
        Some("round") => StrokeCap::Round,
        Some("square") => StrokeCap::Square,
        Some("arrow") => StrokeCap::Arrow,
        Some("triangle") => StrokeCap::Triangle,
        _ => StrokeCap::None,
    }
}

fn parse_effect(v: &V) -> Option<Effect> {
    let c = v
        .get("c")
        .and_then(V::str)
        .and_then(parse_hex_color)
        .unwrap_or(Color::BLACK);
    let (dx, dy, blur) = (
        v.get("dx").and_then(V::num).unwrap_or(0.0),
        v.get("dy").and_then(V::num).unwrap_or(0.0),
        v.get("blur").and_then(V::num).unwrap_or(0.0),
    );
    match v.get("t").and_then(V::str) {
        Some("drop") => Some(Effect::DropShadow {
            dx,
            dy,
            blur,
            color: c,
        }),
        Some("inner") => Some(Effect::InnerShadow {
            dx,
            dy,
            blur,
            color: c,
        }),
        Some("blur") => Some(Effect::LayerBlur {
            radius: v.get("r").and_then(V::num).unwrap_or(0.0),
        }),
        Some("bgblur") => Some(Effect::BackgroundBlur {
            radius: v.get("r").and_then(V::num).unwrap_or(0.0),
        }),
        _ => None,
    }
}

/// Parse a prototype-logic expression (see serialize.rs `expr_json`).
/// Unknown shapes degrade to `0` — forward-compatible.
fn parse_expr(v: &V) -> Expr {
    if let Some(n) = v.get("n").and_then(V::num) {
        return Expr::Val(Value::Num(n));
    }
    if let Some(s) = v.get("s").and_then(V::str) {
        return Expr::Val(Value::Str(s.to_string()));
    }
    if let Some(b) = v.get("b").and_then(V::boolean) {
        return Expr::Val(Value::Bool(b));
    }
    if let Some(name) = v.get("v").and_then(V::str) {
        return Expr::Var(name.to_string());
    }
    if let Some(a) = v.get("neg") {
        return Expr::Neg(Box::new(parse_expr(a)));
    }
    if let Some(a) = v.get("round") {
        return Expr::Round(Box::new(parse_expr(a)));
    }
    fn pair(a: &V) -> Option<(Expr, Expr)> {
        let arr = a.arr()?;
        if arr.len() != 2 {
            return None;
        }
        Some((parse_expr(&arr[0]), parse_expr(&arr[1])))
    }
    macro_rules! bin {
        ($key:expr, $ctor:expr) => {
            if let Some((l, r)) = v.get($key).and_then(pair) {
                return $ctor(Box::new(l), Box::new(r));
            }
        };
    }
    bin!("add", Expr::Add);
    bin!("sub", Expr::Sub);
    bin!("mul", Expr::Mul);
    bin!("div", Expr::Div);
    bin!("min", Expr::Min);
    bin!("max", Expr::Max);
    bin!("cat", Expr::Concat);
    Expr::Val(Value::Num(0.0))
}

fn parse_condition(v: &V) -> Condition {
    Condition {
        lhs: v
            .get("lhs")
            .map(parse_expr)
            .unwrap_or_else(|| Expr::Val(Value::Num(0.0))),
        op: CondOp::from_str(v.get("op").and_then(V::str).unwrap_or("eq")),
        rhs: v
            .get("rhs")
            .map(parse_expr)
            .unwrap_or_else(|| Expr::Val(Value::Num(0.0))),
    }
}

/// Parse a nested action (the `then`/`else` of a `Cond`). Mirrors the
/// top-level interaction action parse, minus timing (inherited).
fn parse_nested_action(v: &V) -> Action {
    let dest = v.get("dest").and_then(V::str).unwrap_or("").to_string();
    let pos = OverlayPosition::from_str(
        v.get("pos").and_then(V::str).unwrap_or("center"),
        v.get("px").and_then(V::num).unwrap_or(0.0),
        v.get("py").and_then(V::num).unwrap_or(0.0),
    );
    match v.get("action").and_then(V::str) {
        Some("overlay") => Action::OpenOverlay {
            overlay: dest,
            position: pos,
        },
        Some("swap") => Action::SwapOverlay { overlay: dest },
        Some("close") => Action::CloseOverlay,
        Some("scroll") => Action::ScrollTo { destination: dest },
        Some("back") => Action::Back,
        Some("link") => Action::OpenLink {
            url: v
                .get("url")
                .and_then(V::str)
                .unwrap_or(dest.as_str())
                .to_string(),
        },
        Some("setvar") => Action::SetVar {
            name: v.get("var").and_then(V::str).unwrap_or("").to_string(),
            value: v
                .get("expr")
                .map(parse_expr)
                .unwrap_or_else(|| Expr::Val(Value::Num(0.0))),
        },
        Some("setmode") => Action::SetMode {
            mode: v.get("mode").and_then(V::str).unwrap_or("").to_string(),
        },
        Some("cond") => Action::Cond {
            cond: v
                .get("cond")
                .map(parse_condition)
                .unwrap_or_else(|| Condition {
                    lhs: Expr::Val(Value::Bool(true)),
                    op: CondOp::Eq,
                    rhs: Expr::Val(Value::Bool(true)),
                }),
            then: Box::new(
                v.get("then")
                    .map(parse_nested_action)
                    .unwrap_or(Action::Back),
            ),
            els: v.get("else").map(parse_nested_action).map(Box::new),
        },
        _ => Action::Navigate { destination: dest },
    }
}

/// Parse a grid layout object: {"cols":[..],"rows":[..],"cgap":N,"rgap":N,"pad":[l,r,t,b]}.
/// Tracks: {"t":"fixed","v":N} | {"t":"fr","v":N} | {"t":"auto"}.
fn parse_grid(v: Option<&V>) -> Option<x_core::GridLayout> {
    let g = v?;
    let tracks = |key: &str| -> Vec<x_core::GridTrack> {
        g.get(key)
            .and_then(V::arr)
            .map(|a| {
                a.iter()
                    .filter_map(|t| match t.get("t").and_then(V::str) {
                        Some("fixed") => t.get("v").and_then(V::num).map(x_core::GridTrack::Fixed),
                        Some("fr") => t.get("v").and_then(V::num).map(x_core::GridTrack::Fr),
                        Some("auto") => Some(x_core::GridTrack::Auto),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    Some(x_core::GridLayout {
        columns: tracks("cols"),
        rows: tracks("rows"),
        column_gap: g.get("cgap").and_then(V::num).unwrap_or(0.0),
        row_gap: g.get("rgap").and_then(V::num).unwrap_or(0.0),
        padding: parse_padding(g.get("pad")),
    })
}

fn parse_kind(v: &V) -> NodeKind {
    match v.get("t").and_then(V::str).unwrap_or("frame") {
        "group" => NodeKind::Group,
        "section" => NodeKind::Section,
        "rect" => NodeKind::Rect {
            radius: v.get("radius").and_then(V::num).unwrap_or(0.0),
        },
        "ellipse" => NodeKind::Ellipse,
        "arc" => NodeKind::Arc {
            start: v.get("start").and_then(V::num).unwrap_or(0.0),
            end: v.get("end").and_then(V::num).unwrap_or(270.0),
        },
        "line" => NodeKind::Line,
        "text" => NodeKind::Text {
            text: v.get("text").and_then(V::str).unwrap_or("").into(),
        },
        "image" => NodeKind::Image {
            asset: v.get("asset").and_then(V::str).unwrap_or("").into(),
            placement: ImagePlacement {
                focal: (
                    v.get("fx").and_then(V::num).unwrap_or(0.5),
                    v.get("fy").and_then(V::num).unwrap_or(0.5),
                ),
                scale: v.get("scale").and_then(V::num).unwrap_or(1.0),
                flip_h: v.get("fliph").and_then(V::boolean).unwrap_or(false),
                flip_v: v.get("flipv").and_then(V::boolean).unwrap_or(false),
            },
            fit: match v.get("fit").and_then(V::str) {
                Some("fit") => ImageFit::Fit,
                Some("crop") => ImageFit::Crop,
                Some("tile") => ImageFit::Tile,
                _ => ImageFit::Fill,
            },
        },
        "vector" => NodeKind::Vector {
            path: v
                .get("path")
                .and_then(V::arr)
                .map(|a| {
                    a.iter()
                        .filter_map(|cmd| {
                            let c = cmd.arr()?;
                            match c.first()?.str()? {
                                "M" => Some(PathCmd::MoveTo(c.get(1)?.num()?, c.get(2)?.num()?)),
                                "L" => Some(PathCmd::LineTo(c.get(1)?.num()?, c.get(2)?.num()?)),
                                "C" => Some(PathCmd::CurveTo(
                                    c.get(1)?.num()?,
                                    c.get(2)?.num()?,
                                    c.get(3)?.num()?,
                                    c.get(4)?.num()?,
                                    c.get(5)?.num()?,
                                    c.get(6)?.num()?,
                                )),
                                "Z" => Some(PathCmd::Close),
                                _ => None,
                            }
                        })
                        .collect()
                })
                .unwrap_or_default(),
        },
        "component" => NodeKind::Component {
            name: v.get("name").and_then(V::str).unwrap_or("").into(),
        },
        "instance" => NodeKind::Instance {
            component: v.get("component").and_then(V::str).unwrap_or("").into(),
        },
        "slice" => NodeKind::Slice,
        _ => {
            let layout = v.get("layout").map(|l| AutoLayout {
                direction: if l.get("dir").and_then(V::str) == Some("h") {
                    LayoutDirection::Horizontal
                } else {
                    LayoutDirection::Vertical
                },
                gap: l.get("gap").and_then(V::num).unwrap_or(0.0),
                padding: parse_padding(l.get("padding")),
                sizing: if l.get("sizing").and_then(V::str) == Some("hug") {
                    Sizing::Hug
                } else {
                    Sizing::Fixed
                },
                align: match l.get("align").and_then(V::str) {
                    Some("center") => CrossAlign::Center,
                    Some("end") => CrossAlign::End,
                    Some("baseline") => CrossAlign::Baseline,
                    _ => CrossAlign::Start,
                },
                distribute: l
                    .get("distribute")
                    .and_then(V::str)
                    .map(Distribute::from_str)
                    .unwrap_or_else(|| {
                        if l.get("space_between").and_then(V::boolean).unwrap_or(false) {
                            Distribute::Between
                        } else {
                            Distribute::Packed
                        }
                    }),
                cross_sizing: l.get("cross_sizing").and_then(V::str).map(|s| {
                    if s == "hug" {
                        Sizing::Hug
                    } else {
                        Sizing::Fixed
                    }
                }),
                gap_var: l.get("gap_var").and_then(V::str).map(String::from),
                padding_var: l.get("padding_var").and_then(V::str).map(String::from),
                max_height: l.get("max_height").and_then(V::num),
                max_width: l.get("max_width").and_then(V::num),
                min_height: l.get("min_height").and_then(V::num),
                min_width: l.get("min_width").and_then(V::num),
                wrap: if l.get("wrap").and_then(V::boolean).unwrap_or(false) {
                    AutoLayoutWrap::Wrap
                } else {
                    AutoLayoutWrap::NoWrap
                },
                grid: parse_grid(l.get("grid")),
                resize_on_wrap: l
                    .get("resize_on_wrap")
                    .and_then(V::boolean)
                    .unwrap_or(false),
            });
            NodeKind::Frame { layout }
        }
    }
}

/// `"padding"` accepts the legacy scalar (all four sides) or the
/// `[left, right, top, bottom]` array written for non-uniform padding.
pub(crate) fn parse_padding(v: Option<&V>) -> Padding {
    match v {
        Some(V::Num(n)) => [*n; 4],
        Some(V::Arr(a)) if a.len() == 4 => [
            a[0].num().unwrap_or(0.0),
            a[1].num().unwrap_or(0.0),
            a[2].num().unwrap_or(0.0),
            a[3].num().unwrap_or(0.0),
        ],
        _ => [0.0; 4],
    }
}

pub(crate) fn parse_node(v: &V) -> Node {
    let kind = v.get("kind").map(parse_kind).unwrap_or(NodeKind::Group);
    let mut n = Node::frame("", 0.0, 0.0);
    n.kind = kind;
    n.id = v.get("id").and_then(V::str).unwrap_or("").into();
    n.name = v
        .get("name")
        .and_then(V::str)
        .map(str::to_string)
        .unwrap_or_else(|| n.id.clone());
    n.transform.x = v.get("x").and_then(V::num).unwrap_or(0.0);
    n.transform.y = v.get("y").and_then(V::num).unwrap_or(0.0);
    n.transform.rotation = v.get("rotation").and_then(V::num).unwrap_or(0.0);
    if let Some(scale) = v.get("scale").and_then(V::arr).filter(|a| a.len() == 2) {
        n.transform.scale_x = scale[0].num().unwrap_or(1.0);
        n.transform.scale_y = scale[1].num().unwrap_or(1.0);
    }
    if let Some(sk) = v.get("skew").and_then(V::arr) {
        if sk.len() == 2 {
            n.transform.skew_x = sk[0].num().unwrap_or(0.0);
            n.transform.skew_y = sk[1].num().unwrap_or(0.0);
        }
    }
    if let Some(or) = v.get("origin").and_then(V::arr) {
        if or.len() == 2 {
            n.transform.origin_x = or[0].num().unwrap_or(0.5);
            n.transform.origin_y = or[1].num().unwrap_or(0.5);
        }
    }
    // Legacy "spans" (the pre-unification rich-text model, BYTE ranges)
    // convert to text_runs (CHAR ranges): a byte offset maps to the index of
    // the char that contains it, clamped to the string end.
    if let Some(spans) = v.get("spans").and_then(V::arr) {
        if let NodeKind::Text { text } = &n.kind {
            let byte_to_char = |off: usize| -> usize {
                let mut ci = 0;
                for (bi, _) in text.char_indices() {
                    if bi >= off {
                        return ci;
                    }
                    ci += 1;
                }
                ci
            };
            for sp in spans {
                let sb = sp.get("s").and_then(V::num).unwrap_or(0.0) as usize;
                let eb = sp.get("e").and_then(V::num).unwrap_or(0.0) as usize;
                let (start, end) = (byte_to_char(sb), byte_to_char(eb));
                let run = TextRun {
                    start,
                    len: end.saturating_sub(start),
                    color: sp.get("fill").and_then(V::str).and_then(parse_hex_color),
                    size: sp.get("size").and_then(V::num),
                    font: sp.get("family").and_then(V::str).map(Into::into),
                    weight: sp.get("w").and_then(V::num).map(|x| x as u16),
                    italic: sp.get("i").and_then(V::boolean),
                    ls: sp.get("ls").and_then(V::num),
                };
                if run.len > 0 {
                    n.text_runs.push(run);
                }
            }
        }
    }
    n.w = v.get("w").and_then(V::num).unwrap_or(0.0);
    n.h = v.get("h").and_then(V::num).unwrap_or(0.0);
    n.opacity = v.get("opacity").and_then(V::num).unwrap_or(1.0) as f32;
    n.visible = v.get("visible").and_then(V::boolean).unwrap_or(true);
    n.locked = v.get("locked").and_then(V::boolean).unwrap_or(false);
    n.is_mask = v.get("mask").and_then(V::boolean).unwrap_or(false);
    n.fill = v
        .get("fill")
        .map(parse_paint)
        .unwrap_or(Paint::Solid(Color::TRANSPARENT));
    if let Some(s) = v.get("stroke") {
        // "paint" (gradients) or legacy "color" (solid)
        let paint = s
            .get("paint")
            .map(parse_paint)
            .or_else(|| {
                s.get("color")
                    .and_then(V::str)
                    .and_then(parse_hex_color)
                    .map(Paint::Solid)
            })
            .unwrap_or(Paint::Solid(Color::BLACK));
        n.stroke = Stroke {
            paint,
            width: s.get("width").and_then(V::num).unwrap_or(0.0),
        };
    }
    if let Some(layers) = v.get("fill_layers").and_then(V::arr) {
        n.visual_stacks_materialized = true;
        n.fill_layers = layers
            .iter()
            .filter_map(|l| {
                Some(PaintLayer {
                    paint: parse_paint(l.get("paint")?),
                    opacity: l.get("opacity").and_then(V::num).unwrap_or(1.0) as f32,
                    visible: l.get("visible").and_then(V::boolean).unwrap_or(true),
                    blend: parse_blend(l.get("blend").and_then(V::str)),
                })
            })
            .collect();
    }
    if let Some(layers) = v.get("stroke_layers").and_then(V::arr) {
        n.visual_stacks_materialized = true;
        n.stroke_layers = layers
            .iter()
            .map(|l| StrokeLayer {
                stroke: Stroke {
                    paint: l
                        .get("paint")
                        .map(parse_paint)
                        .or_else(|| {
                            l.get("color")
                                .and_then(V::str)
                                .and_then(parse_hex_color)
                                .map(Paint::Solid)
                        })
                        .unwrap_or(Paint::Solid(Color::BLACK)),
                    width: l.get("width").and_then(V::num).unwrap_or(0.0),
                },
                opacity: l.get("opacity").and_then(V::num).unwrap_or(1.0) as f32,
                visible: l.get("visible").and_then(V::boolean).unwrap_or(true),
                blend: parse_blend(l.get("blend").and_then(V::str)),
                options: StrokeOptions {
                    align: match l.get("align").and_then(V::str) {
                        Some("inside") => StrokeAlign::Inside,
                        Some("outside") => StrokeAlign::Outside,
                        _ => StrokeAlign::Center,
                    },
                    cap_start: parse_cap(l.get("cap_start").and_then(V::str)),
                    cap_end: parse_cap(l.get("cap_end").and_then(V::str)),
                    join: match l.get("join").and_then(V::str) {
                        Some("bevel") => StrokeJoin::Bevel,
                        Some("round") => StrokeJoin::Round,
                        _ => StrokeJoin::Miter,
                    },
                    dash: l
                        .get("dash")
                        .and_then(V::arr)
                        .map(|a| a.iter().filter_map(V::num).collect())
                        .unwrap_or_default(),
                    dash_offset: l.get("dash_offset").and_then(V::num).unwrap_or(0.0),
                    miter_limit: l.get("miter").and_then(V::num).unwrap_or(4.0),
                },
            })
            .collect();
    }
    if let Some(layers) = v.get("effect_layers").and_then(V::arr) {
        n.visual_stacks_materialized = true;
        n.effect_layers = layers
            .iter()
            .filter_map(|l| {
                Some(EffectLayer {
                    effect: parse_effect(l.get("effect")?)?,
                    opacity: l.get("opacity").and_then(V::num).unwrap_or(1.0) as f32,
                    visible: l.get("visible").and_then(V::boolean).unwrap_or(true),
                    blend: parse_blend(l.get("blend").and_then(V::str)),
                })
            })
            .collect();
    }
    if let Some(p) = v.get("pin").and_then(V::str) {
        let mut it = p.split_whitespace();
        n.pin = (
            match it.next() {
                Some("right") => HPin::Right,
                Some("center") => HPin::CenterH,
                Some("stretch") => HPin::StretchH,
                Some("scale") => HPin::ScaleH,
                _ => HPin::Left,
            },
            match it.next() {
                Some("bottom") => VPin::Bottom,
                Some("center") => VPin::CenterV,
                Some("stretch") => VPin::StretchV,
                Some("scale") => VPin::ScaleV,
                _ => VPin::Top,
            },
        );
    }
    if let Some(c) = v.get("corners").and_then(V::arr) {
        if c.len() == 4 {
            n.corner_radii = Some([
                c[0].num().unwrap_or(0.0),
                c[1].num().unwrap_or(0.0),
                c[2].num().unwrap_or(0.0),
                c[3].num().unwrap_or(0.0),
            ]);
        }
    }
    if let Some(rs) = v.get("textRuns").and_then(V::arr) {
        for r in rs {
            n.text_runs.push(TextRun {
                start: r.get("start").and_then(V::num).unwrap_or(0.0) as usize,
                len: r.get("len").and_then(V::num).unwrap_or(0.0) as usize,
                color: r.get("color").and_then(V::str).and_then(parse_hex_color),
                size: r.get("size").and_then(V::num),
                font: r.get("font").and_then(V::str).map(Into::into),
                weight: r.get("weight").and_then(V::num).map(|x| x as u16),
                italic: r.get("italic").and_then(V::boolean),
                ls: r.get("ls").and_then(V::num),
            });
        }
    }
    n.blend = parse_blend(v.get("blend").and_then(V::str));
    if let Some(fx) = v.get("effects").and_then(V::arr) {
        for e in fx {
            if let Some(effect) = parse_effect(e) {
                n.effects.push(effect);
            }
        }
    }
    if let Some(p) = v.get("prototype") {
        n.prototype = Some(PrototypeAction {
            destination: p.get("to").and_then(V::str).unwrap_or("").into(),
            transition_ms: p.get("ms").and_then(V::num).unwrap_or(0.0) as u32,
        });
    }
    if let Some(V::Obj(m)) = v.get("bindings") {
        for (k, val) in m {
            if let V::Str(s) = val {
                n.bindings.insert(k.clone(), s.clone());
            }
        }
    }
    if let Some(V::Obj(m)) = v.get("overrides") {
        for (k, val) in m {
            if let V::Str(s) = val {
                n.overrides.insert(k.clone(), s.clone());
            }
        }
    }
    if let Some(ps) = v.get("props").and_then(V::arr) {
        for p in ps {
            let name = p.get("name").and_then(V::str).unwrap_or("").to_string();
            let target = p.get("target").and_then(V::str).unwrap_or("").to_string();
            let prop = match p.get("t").and_then(V::str) {
                Some("bool") => ComponentProp::Bool {
                    name,
                    target,
                    default: p.get("default").and_then(V::boolean).unwrap_or(false),
                },
                Some("swap") => ComponentProp::Swap {
                    name,
                    target,
                    default: p.get("default").and_then(V::str).unwrap_or("").to_string(),
                },
                Some("number") => ComponentProp::Number {
                    name,
                    target,
                    target_property: p
                        .get("target_property")
                        .and_then(V::str)
                        .unwrap_or("width")
                        .to_string(),
                    default: p.get("default").and_then(V::num).unwrap_or(0.0),
                    min: p.get("min").and_then(V::num),
                    max: p.get("max").and_then(V::num),
                },
                Some("color") => ComponentProp::Color {
                    name,
                    target,
                    target_property: p
                        .get("target_property")
                        .and_then(V::str)
                        .unwrap_or("fill")
                        .to_string(),
                    default: p
                        .get("default")
                        .and_then(V::str)
                        .and_then(parse_hex_color_v)
                        .unwrap_or(x_core::Color::from_rgba8(0, 0, 0, 255)),
                },
                Some("slot") => ComponentProp::Slot {
                    name,
                    target,
                    default: p.get("default").and_then(V::str).map(str::to_string),
                },
                _ => ComponentProp::Text {
                    name,
                    target,
                    default: p.get("default").and_then(V::str).unwrap_or("").to_string(),
                },
            };
            n.props.push(prop);
        }
    }
    if let Some(es) = v.get("export_settings").and_then(V::arr) {
        for e in es {
            n.export_settings.push(ExportSettings {
                format: e
                    .get("format")
                    .and_then(V::str)
                    .unwrap_or("png")
                    .to_string(),
                scale: e.get("scale").and_then(V::num).unwrap_or(1.0),
                quality: e.get("quality").and_then(V::num).unwrap_or(90.0) as u8,
                suffix: e.get("suffix").and_then(V::str).unwrap_or("").to_string(),
            });
        }
    }
    if let Some(ix) = v.get("interactions").and_then(V::arr) {
        for e in ix {
            let trigger = match e.get("trigger").and_then(V::str) {
                Some("key") => Trigger::KeyDown {
                    key: e.get("key").and_then(V::str).unwrap_or("").to_string(),
                },
                Some("hover") => Trigger::OnHover,
                Some("press") => Trigger::OnPress,
                Some("drag") => Trigger::OnDrag,
                Some("enter") => Trigger::MouseEnter,
                Some("leave") => Trigger::MouseLeave,
                Some("mouseup") => Trigger::MouseUp,
                Some("delay") => Trigger::AfterDelay {
                    ms: e.get("delay_ms").and_then(V::num).unwrap_or(0.0) as u32,
                },
                _ => Trigger::OnClick,
            };
            let dest = e.get("dest").and_then(V::str).unwrap_or("").to_string();
            let pos = OverlayPosition::from_str(
                e.get("pos").and_then(V::str).unwrap_or("center"),
                e.get("px").and_then(V::num).unwrap_or(0.0),
                e.get("py").and_then(V::num).unwrap_or(0.0),
            );
            let action = match e.get("action").and_then(V::str) {
                Some("setvar") => Action::SetVar {
                    name: e.get("var").and_then(V::str).unwrap_or("").to_string(),
                    value: e
                        .get("expr")
                        .map(parse_expr)
                        .unwrap_or_else(|| Expr::Val(Value::Num(0.0))),
                },
                Some("setmode") => Action::SetMode {
                    mode: e.get("mode").and_then(V::str).unwrap_or("").to_string(),
                },
                Some("cond") => Action::Cond {
                    cond: e
                        .get("cond")
                        .map(parse_condition)
                        .unwrap_or_else(|| Condition {
                            lhs: Expr::Val(Value::Bool(true)),
                            op: CondOp::Eq,
                            rhs: Expr::Val(Value::Bool(true)),
                        }),
                    then: Box::new(
                        e.get("then")
                            .map(parse_nested_action)
                            .unwrap_or(Action::Back),
                    ),
                    els: e.get("else").map(parse_nested_action).map(Box::new),
                },
                Some("overlay") => Action::OpenOverlay {
                    overlay: dest,
                    position: pos,
                },
                Some("swap") => Action::SwapOverlay { overlay: dest },
                Some("close") => Action::CloseOverlay,
                Some("scroll") => Action::ScrollTo { destination: dest },
                Some("link") => Action::OpenLink {
                    url: e
                        .get("url")
                        .and_then(V::str)
                        .unwrap_or(dest.as_str())
                        .to_string(),
                },
                Some("back") => Action::Back,
                _ => Action::Navigate { destination: dest },
            };
            n.interactions.push(Interaction {
                trigger,
                action,
                transition_ms: e.get("ms").and_then(V::num).unwrap_or(350.0) as u32,
                animation: Animation::from_str(e.get("anim").and_then(V::str).unwrap_or("smart")),
            });
        }
    }
    n.is_starting_point = v.get("start").and_then(V::boolean).unwrap_or(false);
    if let Some(c) = v.get("constraints") {
        n.constraints.align_self = match c.get("align_self").and_then(V::str) {
            Some("center") => Some(Alignment::Center),
            Some("max") => Some(Alignment::Max),
            Some("baseline") => Some(Alignment::Baseline),
            Some("min") => Some(Alignment::Min),
            _ => None,
        };
        n.constraints.grow = c.get("grow").and_then(V::num).unwrap_or(0.0);
        n.constraints.shrink = c.get("shrink").and_then(V::num).unwrap_or(1.0);
        n.constraints.basis = c.get("basis").and_then(V::num);
        n.constraints.is_absolute = c.get("absolute").and_then(V::boolean).unwrap_or(false);
        n.constraints.fixed = c.get("fixed").and_then(V::boolean).unwrap_or(false);
        n.constraints.sticky = c.get("sticky").and_then(V::boolean).unwrap_or(false);
        n.constraints.grid_col = c.get("col").and_then(V::num).map(|v| v.max(0.0) as usize);
        n.constraints.grid_row = c.get("row").and_then(V::num).map(|v| v.max(0.0) as usize);
        n.constraints.grid_col_span = c
            .get("col_span")
            .and_then(V::num)
            .map(|v| v.max(1.0) as usize)
            .unwrap_or(1);
        n.constraints.grid_row_span = c
            .get("row_span")
            .and_then(V::num)
            .map(|v| v.max(1.0) as usize)
            .unwrap_or(1);
    }
    if let Some(V::Arr(a)) = v.get("grids") {
        for g in a {
            n.layout_grids.push(LayoutGridDef {
                pattern: GridPattern::parse(g.get("pattern").and_then(V::str).unwrap_or("columns")),
                count: g.get("count").and_then(V::num).unwrap_or(12.0).max(1.0) as usize,
                gutter: g.get("gutter").and_then(V::num).unwrap_or(20.0),
                margin: g.get("margin").and_then(V::num).unwrap_or(20.0),
                cell: g.get("cell").and_then(V::num).unwrap_or(8.0),
            });
        }
    }
    n.overflow = Overflow::from_str(v.get("overflow").and_then(V::str).unwrap_or("visible"));
    if let Some(s) = v.get("scroll").and_then(V::arr) {
        if s.len() == 2 {
            n.scroll = (s[0].num().unwrap_or(0.0), s[1].num().unwrap_or(0.0));
        }
    }
    if let Some(kids) = v.get("children").and_then(V::arr) {
        n.children = kids.iter().map(parse_node).collect();
    }
    n.dirty = false;
    n
}

/// Load a `.x` v1 document. Unknown fields are ignored (forward-compatible).
pub fn load_x(text: &str) -> Result<Document, String> {
    let v = P::new(text).value()?;
    if v.get("version")
        .and_then(V::num)
        .is_some_and(|n| n > X_FORMAT_VERSION as f64)
    {
        return Err(format!(
            "file is newer than the v{X_FORMAT_VERSION} loader; use load_x_any"
        ));
    }
    decode_document(&v)
}

pub(crate) fn decode_document(v: &V) -> Result<Document, String> {
    if v.get("format").and_then(V::str) != Some("x-native") {
        return Err("not an x-native file".into());
    }
    let number = v
        .get("version")
        .and_then(V::num)
        .ok_or("missing schema version")?;
    if number < 1.0 || number > u32::MAX as f64 || number.fract() != 0.0 {
        return Err("invalid schema version".into());
    }
    let version = number as u32;
    if version > crate::SCHEMA_VERSION {
        return Err(format!(
            "file version {version} is newer than supported {X_FORMAT_VERSION}"
        ));
    }
    let pages = v
        .get("pages")
        .and_then(V::arr)
        .ok_or("pages must be an array")?;
    validate_native_nodes(pages)?;
    let mut doc = Document::new();
    if let Some(vars) = v.get("variables") {
        if let Some(V::Obj(m)) = vars.get("colors") {
            for (k, val) in m {
                if let Some(c) = val.str().and_then(parse_hex_color) {
                    doc.variables.colors.insert(k.clone(), c);
                }
            }
        }
        if let Some(V::Obj(m)) = vars.get("numbers") {
            for (k, val) in m {
                if let Some(n) = val.num() {
                    doc.variables.numbers.insert(k.clone(), n);
                }
            }
        }
        if let Some(V::Obj(m)) = vars.get("strings") {
            for (k, val) in m {
                if let V::Str(s) = val {
                    doc.variables.strings.insert(k.clone(), s.clone());
                }
            }
        }
        if let Some(V::Obj(m)) = vars.get("bools") {
            for (k, val) in m {
                if let Some(b) = val.boolean() {
                    doc.variables.bools.insert(k.clone(), b);
                }
            }
        }
        if let Some(V::Obj(m)) = vars.get("collections") {
            for (k, val) in m {
                if let V::Str(s) = val {
                    doc.variables.collections.insert(k.clone(), s.clone());
                }
            }
        }
        if let Some(V::Obj(m)) = vars.get("modes") {
            for (mode, table) in m {
                if let V::Obj(entries) = table {
                    let mut t = std::collections::HashMap::new();
                    for (k, val) in entries {
                        if let Some(c) = val.str().and_then(parse_hex_color) {
                            t.insert(k.clone(), c);
                        }
                    }
                    doc.variables.modes.insert(mode.clone(), t);
                }
            }
        }
        if let Some(V::Obj(m)) = vars.get("num_modes") {
            for (mode, table) in m {
                if let V::Obj(entries) = table {
                    let mut t = std::collections::HashMap::new();
                    for (k, val) in entries {
                        if let Some(n) = val.num() {
                            t.insert(k.clone(), n);
                        }
                    }
                    doc.variables.num_modes.insert(mode.clone(), t);
                }
            }
        }
        if let Some(V::Obj(m)) = vars.get("str_modes") {
            for (mode, table) in m {
                if let V::Obj(entries) = table {
                    let mut t = std::collections::HashMap::new();
                    for (k, val) in entries {
                        if let V::Str(sv) = val {
                            t.insert(k.clone(), sv.clone());
                        }
                    }
                    doc.variables.str_modes.insert(mode.clone(), t);
                }
            }
        }
        if let Some(V::Obj(m)) = vars.get("bool_modes") {
            for (mode, table) in m {
                if let V::Obj(entries) = table {
                    let mut t = std::collections::HashMap::new();
                    for (k, val) in entries {
                        if let Some(b) = val.boolean() {
                            t.insert(k.clone(), b);
                        }
                    }
                    doc.variables.bool_modes.insert(mode.clone(), t);
                }
            }
        }
        if let Some(m) = vars.get("active_mode").and_then(V::str) {
            doc.variables.active_mode = Some(m.to_string());
        }
        if let Some(V::Arr(a)) = vars.get("exposed") {
            for v in a {
                if let Some(s) = v.str() {
                    doc.variables.exposed.insert(s.to_string());
                }
            }
        }
    }
    if let Some(V::Obj(styles)) = v.get("styles") {
        for (name, sv) in styles {
            if let Some(s) = parse_style_v(sv) {
                doc.styles.insert(name.clone(), s);
            }
        }
    }
    if let Some(V::Obj(groups)) = v.get("component_props") {
        for (component, entries) in groups {
            if let V::Arr(list) = entries {
                for e in list {
                    let (Some(name), Some(target)) = (
                        e.get("name").and_then(V::str),
                        e.get("target").and_then(V::str),
                    ) else {
                        continue;
                    };
                    let kind = match e.get("kind").and_then(V::str) {
                        Some("bool") => x_core::ComponentPropKind::Bool,
                        Some("swap") => x_core::ComponentPropKind::Swap,
                        _ => x_core::ComponentPropKind::Text,
                    };
                    doc.component_props
                        .entry(component.clone())
                        .or_default()
                        .push(x_core::ComponentPropEntry {
                            name: name.to_string(),
                            target: target.to_string(),
                            kind,
                            default: e
                                .get("default")
                                .and_then(V::str)
                                .unwrap_or_default()
                                .to_string(),
                        });
                }
            }
        }
    }
    // canvas comment pins (review C18)
    if let Some(V::Arr(cs)) = v.get("comments") {
        for c in cs {
            let page = c.get("page").and_then(V::num).unwrap_or(0.0) as usize;
            doc.comments.push(x_core::Comment {
                id: c.get("id").and_then(V::str).unwrap_or("").to_string(),
                page,
                x: c.get("x").and_then(V::num).unwrap_or(0.0),
                y: c.get("y").and_then(V::num).unwrap_or(0.0),
                author: c.get("author").and_then(V::str).unwrap_or("").to_string(),
                text: c.get("text").and_then(V::str).unwrap_or("").to_string(),
                resolved: c.get("resolved").and_then(V::boolean).unwrap_or(false),
            });
        }
    }
    if let Some(assets) = v.get("assets").and_then(V::arr) {
        for a in assets {
            let (Some(data), Some(name)) = (
                a.get("data").and_then(V::str),
                a.get("name").and_then(V::str),
            ) else {
                continue;
            };
            if let Some(bytes) = crate::b64::debase64(data) {
                // re-register: id is re-derived from content, so a
                // tampered/corrupt record can't hijack another asset's id
                doc.assets.register(name, bytes, AssetSource::Embedded);
            }
        }
    }
    if let Some(libs) = v.get("libraries").and_then(V::arr) {
        for d in libs {
            let (Some(id), Some(ver)) = (
                d.get("library_id").and_then(V::str),
                d.get("resolved_version").and_then(V::num),
            ) else {
                continue;
            };
            doc.library_deps.push(LibraryDependency {
                library_id: id.to_string(),
                resolved_version: ver as u32,
                snapshot_hash: d
                    .get("snapshot_hash")
                    .and_then(V::str)
                    .unwrap_or("")
                    .to_string(),
                source_path: d
                    .get("source_path")
                    .and_then(V::str)
                    .unwrap_or("")
                    .to_string(),
            });
            // snapshot is a nested xlib object: re-serialize the V back to
            // text is wasteful; parse it directly through load_xlib by
            // reconstructing minimal JSON — instead, snapshot objects are
            // parsed inline here via the same field readers.
            if let Some(snap) = d.get("snapshot") {
                if snap.get("format").and_then(V::str) == Some("x-native-library") {
                    if let Some(l) = crate::xlib::parse_library_v(snap) {
                        doc.library_snapshots.insert(id.to_string(), l);
                    }
                }
            }
        }
    }
    if let Some(pages) = v.get("pages").and_then(V::arr) {
        doc.pages = pages.iter().map(parse_node).collect();
    }
    Ok(doc)
}

pub fn save_x_file(doc: &Document, path: &str) -> std::io::Result<()> {
    crate::admission::validate_admission(doc)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let bytes = save_x(doc);
    crate::admission::validate_encoded(&bytes).map_err(std::io::Error::other)?;
    crate::reliability::save_with_backups(path, bytes.as_bytes())?;
    crate::clear_autosave(path);
    Ok(())
}
pub fn load_x_file(path: &str) -> Result<Document, String> {
    let bytes = crate::read_bounded(std::path::Path::new(path))?;
    let text = std::str::from_utf8(&bytes).map_err(|e| e.to_string())?;
    let doc = crate::load_x_any(text)?.doc;
    crate::validate_admission(&doc)?;
    Ok(doc)
}

/// Shared style decoder (.x documents AND .xlib libraries).
pub(crate) fn parse_style_v(sv: &V) -> Option<LegacyStyle> {
    match sv.get("t").and_then(V::str) {
        Some("paint") => sv.get("fill").map(|f| LegacyStyle::Paint {
            fill: parse_paint(f),
        }),
        Some("text") => Some(LegacyStyle::Text {
            font: sv.get("font").and_then(V::str).unwrap_or("").into(),
            size: sv.get("size").and_then(V::num).unwrap_or(0.0),
            letter_spacing: sv.get("ls").and_then(V::num).unwrap_or(0.0),
            line_height: sv.get("lh").and_then(V::num).unwrap_or(0.0),
        }),
        Some("effect") => {
            let mut effects = Vec::new();
            if let Some(fx) = sv.get("effects").and_then(V::arr) {
                for e in fx {
                    let c = e
                        .get("c")
                        .and_then(V::str)
                        .and_then(parse_hex_color)
                        .unwrap_or(Color::BLACK);
                    let (dx, dy, blur) = (
                        e.get("dx").and_then(V::num).unwrap_or(0.0),
                        e.get("dy").and_then(V::num).unwrap_or(0.0),
                        e.get("blur").and_then(V::num).unwrap_or(0.0),
                    );
                    match e.get("t").and_then(V::str) {
                        Some("drop") => effects.push(Effect::DropShadow {
                            dx,
                            dy,
                            blur,
                            color: c,
                        }),
                        Some("inner") => effects.push(Effect::InnerShadow {
                            dx,
                            dy,
                            blur,
                            color: c,
                        }),
                        Some("blur") => effects.push(Effect::LayerBlur {
                            radius: e.get("r").and_then(V::num).unwrap_or(0.0),
                        }),
                        Some("bgblur") => effects.push(Effect::BackgroundBlur {
                            radius: e.get("r").and_then(V::num).unwrap_or(0.0),
                        }),
                        _ => {}
                    }
                }
            }
            Some(LegacyStyle::Effect { effects })
        }
        _ => None,
    }
}

/// str -> Color for library variable tables (shared helper).
pub(crate) fn parse_hex_color_v(s: &str) -> Option<Color> {
    parse_hex_color(s)
}

fn validate_native_nodes(pages: &[V]) -> Result<(), String> {
    let mut stack: Vec<_> = pages.iter().collect();
    while let Some(n) = stack.pop() {
        if !matches!(n, V::Obj(_)) {
            return Err("node must be an object".into());
        }
        for key in ["x", "y", "w", "h", "rotation", "opacity"] {
            if n.get(key).is_some_and(|v| !matches!(v, V::Num(_))) {
                return Err(format!("{key} must be a number"));
            }
        }
        for key in ["scale", "skew", "origin", "scroll"] {
            if let Some(value) = n.get(key) {
                if !value
                    .arr()
                    .is_some_and(|a| a.len() == 2 && a.iter().all(|v| v.num().is_some()))
                {
                    return Err(format!("{key} must contain two numbers"));
                }
            }
        }
        if let Some(kind) = n.get("kind") {
            let tag = kind
                .get("t")
                .and_then(V::str)
                .ok_or("kind must be an object with a type tag")?;
            if !matches!(
                tag,
                "frame"
                    | "group"
                    | "section"
                    | "rect"
                    | "ellipse"
                    | "arc"
                    | "line"
                    | "text"
                    | "image"
                    | "vector"
                    | "component"
                    | "instance"
                    | "slice"
            ) {
                return Err(format!("unsupported node kind '{tag}'"));
            }
        }
        if let Some(children) = n.get("children") {
            stack.extend(children.arr().ok_or("children must be an array")?);
        }
    }
    Ok(())
}
