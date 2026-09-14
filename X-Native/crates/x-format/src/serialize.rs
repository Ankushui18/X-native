#[allow(unused_imports)]
use crate::*;
use x_core::document::LegacyStyle;
use x_core::*;

// ------------------------------------------------------------------ emitter

pub(crate) fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn paint_json(p: &Paint) -> String {
    match p {
        Paint::Solid(c) => format!("{{\"t\":\"solid\",\"c\":\"{}\"}}", color_to_hex(*c)),
        Paint::Variable(n) => format!("{{\"t\":\"var\",\"name\":\"{}\"}}", esc(n)),
        Paint::LinearGradient {
            start,
            end,
            stops,
            space,
        } => format!(
            "{{\"t\":\"linear\",\"x0\":{},\"y0\":{},\"x1\":{},\"y1\":{},\"stops\":[{}]{}}}",
            start.0,
            start.1,
            end.0,
            end.1,
            stops
                .iter()
                .map(|(t, c)| format!("[{},\"{}\"]", t, color_to_hex(*c)))
                .collect::<Vec<_>>()
                .join(","),
            // perceptual interpolation (Sketch 2026.2); omitted for Srgb
            if *space == GradSpace::Oklab {
                ",\"gs\":\"oklab\""
            } else {
                ""
            }
        ),
        Paint::Pattern { asset, fit } => format!(
            "{{\"t\":\"pattern\",\"asset\":\"{}\",\"fit\":\"{}\"}}",
            esc(asset),
            match fit {
                ImageFit::Fill => "fill",
                ImageFit::Fit => "fit",
                ImageFit::Crop => "crop",
                ImageFit::Tile => "tile",
            }
        ),
        Paint::RadialGradient {
            center,
            radius,
            stops,
            space,
        } => format!(
            "{{\"t\":\"radial\",\"cx\":{},\"cy\":{},\"r\":{},\"stops\":[{}]{}{}}}",
            center.0,
            center.1,
            radius,
            stops
                .iter()
                .map(|(t, c)| format!("[{},\"{}\"]", t, color_to_hex(*c)))
                .collect::<Vec<_>>()
                .join(","),
            if *space == GradSpace::Oklab {
                ",\"gs\":\"oklab\""
            } else {
                ""
            },
            ""
        ),
    }
}

fn blend_name(b: BlendKind) -> &'static str {
    match b {
        BlendKind::Normal => "normal",
        BlendKind::Darken => "darken",
        BlendKind::Multiply => "multiply",
        BlendKind::ColorBurn => "color-burn",
        BlendKind::Lighten => "lighten",
        BlendKind::Screen => "screen",
        BlendKind::ColorDodge => "color-dodge",
        BlendKind::Overlay => "overlay",
        BlendKind::SoftLight => "soft-light",
        BlendKind::HardLight => "hard-light",
        BlendKind::Difference => "difference",
        BlendKind::Exclusion => "exclusion",
        BlendKind::Hue => "hue",
        BlendKind::Saturation => "saturation",
        BlendKind::Color => "color",
        BlendKind::Luminosity => "luminosity",
    }
}
fn cap_name(c: StrokeCap) -> &'static str {
    match c {
        StrokeCap::None => "none",
        StrokeCap::Round => "round",
        StrokeCap::Square => "square",
        StrokeCap::Arrow => "arrow",
        StrokeCap::Triangle => "triangle",
    }
}

fn effect_json(e: &Effect) -> String {
    match e {
        Effect::DropShadow {
            dx,
            dy,
            blur,
            color,
        } => format!(
            "{{\"t\":\"drop\",\"dx\":{},\"dy\":{},\"blur\":{},\"c\":\"{}\"}}",
            dx,
            dy,
            blur,
            color_to_hex(*color)
        ),
        Effect::InnerShadow {
            dx,
            dy,
            blur,
            color,
        } => format!(
            "{{\"t\":\"inner\",\"dx\":{},\"dy\":{},\"blur\":{},\"c\":\"{}\"}}",
            dx,
            dy,
            blur,
            color_to_hex(*color)
        ),
        Effect::LayerBlur { radius } => format!("{{\"t\":\"blur\",\"r\":{radius}}}"),
        Effect::BackgroundBlur { radius } => format!("{{\"t\":\"bgblur\",\"r\":{radius}}}"),
        Effect::Noise { .. } => "{\"t\":\"noise\"}".to_string(),
    }
}

fn prop_json(p: &ComponentProp) -> String {
    match p {
        ComponentProp::Text {
            name,
            target,
            default,
        } => format!(
            "{{\"t\":\"text\",\"name\":\"{}\",\"target\":\"{}\",\"default\":\"{}\"}}",
            esc(name),
            esc(target),
            esc(default)
        ),
        ComponentProp::Bool {
            name,
            target,
            default,
        } => format!(
            "{{\"t\":\"bool\",\"name\":\"{}\",\"target\":\"{}\",\"default\":{}}}",
            esc(name),
            esc(target),
            default
        ),
        ComponentProp::Swap {
            name,
            target,
            default,
        } => format!(
            "{{\"t\":\"swap\",\"name\":\"{}\",\"target\":\"{}\",\"default\":\"{}\"}}",
            esc(name),
            esc(target),
            esc(default)
        ),
        ComponentProp::Number {
            name,
            target,
            target_property,
            default,
            min,
            max,
        } => {
            let mn = min.map(|v| format!(",\"min\":{v}")).unwrap_or_default();
            let mx = max.map(|v| format!(",\"max\":{v}")).unwrap_or_default();
            format!(
                "{{\"t\":\"number\",\"name\":\"{}\",\"target\":\"{}\",\"target_property\":\"{}\",\"default\":{}{}{}}}",
                esc(name),
                esc(target),
                esc(target_property),
                default,
                mn,
                mx
            )
        }
        ComponentProp::Color {
            name,
            target,
            target_property,
            default,
        } => {
            let hex = x_core::color_to_hex(*default);
            format!(
                "{{\"t\":\"color\",\"name\":\"{}\",\"target\":\"{}\",\"target_property\":\"{}\",\"default\":\"{}\"}}",
                esc(name),
                esc(target),
                esc(target_property),
                hex
            )
        }
        ComponentProp::Slot {
            name,
            target,
            default,
        } => {
            let d = default
                .as_deref()
                .map(|v| format!(",\"default\":\"{}\"", esc(v)))
                .unwrap_or_default();
            format!(
                "{{\"t\":\"slot\",\"name\":\"{}\",\"target\":\"{}\"{}}}",
                esc(name),
                esc(target),
                d
            )
        }
    }
}

/// Prototype-logic expression JSON (compact discriminators):
/// `{"n":1.5}` `{"s":"x"}` `{"b":true}` `{"v":"varname"}` `{"add":[e,e]}`
/// `{"neg":e}` `{"round":e}` `{"cat":[e,e]}`.
fn expr_json(e: &Expr) -> String {
    fn num(n: f64) -> String {
        if n.is_finite() {
            format!("{n}")
        } else {
            "0".into()
        }
    }
    match e {
        Expr::Val(v) => match v {
            Value::Num(n) => format!("{{\"n\":{}}}", num(*n)),
            Value::Str(s) => format!("{{\"s\":\"{}\"}}", esc(s)),
            Value::Bool(b) => format!("{{\"b\":{b}}}"),
        },
        Expr::Var(name) => format!("{{\"v\":\"{}\"}}", esc(name)),
        Expr::Neg(a) => format!("{{\"neg\":{}}}", expr_json(a)),
        Expr::Add(a, b) => format!("{{\"add\":[{},{}]}}", expr_json(a), expr_json(b)),
        Expr::Sub(a, b) => format!("{{\"sub\":[{},{}]}}", expr_json(a), expr_json(b)),
        Expr::Mul(a, b) => format!("{{\"mul\":[{},{}]}}", expr_json(a), expr_json(b)),
        Expr::Div(a, b) => format!("{{\"div\":[{},{}]}}", expr_json(a), expr_json(b)),
        Expr::Min(a, b) => format!("{{\"min\":[{},{}]}}", expr_json(a), expr_json(b)),
        Expr::Max(a, b) => format!("{{\"max\":[{},{}]}}", expr_json(a), expr_json(b)),
        Expr::Round(a) => format!("{{\"round\":{}}}", expr_json(a)),
        Expr::Concat(a, b) => format!("{{\"cat\":[{},{}]}}", expr_json(a), expr_json(b)),
    }
}

fn cond_json(c: &Condition) -> String {
    format!(
        "{{\"lhs\":{},\"op\":\"{}\",\"rhs\":{}}}",
        expr_json(&c.lhs),
        c.op.to_str(),
        expr_json(&c.rhs)
    )
}

/// A nested action object (the `then`/`else` branches of a `Cond`).
/// Carries the action kind plus its fields; timing/animation are inherited
/// from the enclosing interaction.
fn nested_action_json(a: &Action) -> String {
    let mut s = String::from("{\"action\":\"");
    s.push_str(a.kind());
    s.push('"');
    match a {
        Action::Navigate { destination }
        | Action::OpenOverlay {
            overlay: destination,
            ..
        }
        | Action::SwapOverlay {
            overlay: destination,
        }
        | Action::ScrollTo { destination } => {
            s.push_str(&format!(",\"dest\":\"{}\"", esc(destination)));
            if let Action::OpenOverlay { position, .. } = a {
                s.push_str(&format!(",\"pos\":\"{}\"", position.to_str()));
                if let OverlayPosition::Manual(x, y) = position {
                    s.push_str(&format!(",\"px\":{x},\"py\":{y}"));
                }
            }
        }
        Action::OpenLink { url } => {
            s.push_str(&format!(",\"url\":\"{}\"", esc(url)));
        }
        Action::SetVar { name, value } => {
            s.push_str(&format!(",\"var\":\"{}\"", esc(name)));
            s.push_str(&format!(",\"expr\":{}", expr_json(value)));
        }
        Action::SetMode { mode } => {
            s.push_str(&format!(",\"mode\":\"{}\"", esc(mode)));
        }
        Action::Cond { cond, then, els } => {
            s.push_str(&format!(",\"cond\":{}", cond_json(cond)));
            s.push_str(&format!(",\"then\":{}", nested_action_json(then)));
            if let Some(e) = els {
                s.push_str(&format!(",\"else\":{}", nested_action_json(e)));
            }
        }
        Action::CloseOverlay | Action::Back => {}
    }
    s.push('}');
    s
}

fn interaction_json(i: &Interaction) -> String {
    let delay = match &i.trigger {
        Trigger::AfterDelay { ms } => format!(",\"delay_ms\":{ms}"),
        Trigger::KeyDown { key } => format!(",\"key\":\"{}\"", esc(key)),
        _ => String::new(),
    };
    // direction suffix for Move in / Move out ("movein-left")
    let anim_str = match i.animation.dir_str() {
        Some(d) => format!("{}-{d}", i.animation.to_str()),
        None => i.animation.to_str().to_string(),
    };
    // prototype-logic extras (legacy actions serialize exactly as before)
    let extra = match &i.action {
        Action::SetVar { name, value } => {
            format!(",\"var\":\"{}\",\"expr\":{}", esc(name), expr_json(value))
        }
        Action::SetMode { mode } => format!(",\"mode\":\"{}\"", esc(mode)),
        Action::OpenLink { url } => format!(",\"url\":\"{}\"", esc(url)),
        Action::Cond { cond, then, els } => {
            let mut s = format!(
                ",\"cond\":{},\"then\":{}",
                cond_json(cond),
                nested_action_json(then)
            );
            if let Some(e) = els {
                s.push_str(&format!(",\"else\":{}", nested_action_json(e)));
            }
            s
        }
        _ => String::new(),
    };
    let (pos, px, py) = match &i.action {
        Action::OpenOverlay { position, .. } => {
            let (px, py) = match position {
                OverlayPosition::Manual(x, y) => (*x, *y),
                _ => (0.0, 0.0),
            };
            (
                format!(",\"pos\":\"{}\"", position.to_str()),
                format!(",\"px\":{px}"),
                format!(",\"py\":{py}"),
            )
        }
        _ => (String::new(), String::new(), String::new()),
    };
    let dest = match &i.action {
        Action::Navigate { destination }
        | Action::OpenOverlay {
            overlay: destination,
            ..
        }
        | Action::SwapOverlay {
            overlay: destination,
        }
        | Action::ScrollTo { destination } => format!(",\"dest\":\"{}\"", esc(destination)),
        _ => String::new(),
    };
    format!(
        "{{\"trigger\":\"{}\",\"action\":\"{}\",\"ms\":{},\"anim\":\"{}\"{}{}{}{}{}{}}}",
        i.trigger.to_str(),
        i.action.kind(),
        i.transition_ms,
        anim_str,
        dest,
        pos,
        px,
        py,
        delay,
        extra
    )
}
/// Grid layout JSON: {"cols":[..],"rows":[..],"cgap":N,"rgap":N,"pad":[l,r,t,b]}.
fn grid_json(g: &GridLayout) -> String {
    fn track_json(t: &GridTrack) -> String {
        match t {
            GridTrack::Fixed(v) => format!("{{\"t\":\"fixed\",\"v\":{v}}}"),
            GridTrack::Fr(v) => format!("{{\"t\":\"fr\",\"v\":{v}}}"),
            GridTrack::Auto => "{\"t\":\"auto\"}".into(),
        }
    }
    let cols: Vec<String> = g.columns.iter().map(track_json).collect();
    let rows: Vec<String> = g.rows.iter().map(track_json).collect();
    // auto_flow: only serialize when non-default (Row) to keep old files stable
    let flow_field = if g.auto_flow != GridAutoFlow::Row {
        format!(",\"flow\":\"{}\"", g.auto_flow.to_str())
    } else {
        String::new()
    };
    format!(
        ",\"grid\":{{\"cols\":[{}],\"rows\":[{}],\"cgap\":{},\"rgap\":{},\"pad\":[{},{},{},{}]{}{}}}",
        cols.join(","),
        rows.join(","),
        g.column_gap,
        g.row_gap,
        g.padding[0],
        g.padding[1],
        g.padding[2],
        g.padding[3],
        flow_field
    )
}

fn layout_extras(l: &AutoLayout) -> String {
    let mut s = String::new();
    for (key, v) in [
        ("min_width", l.min_width),
        ("max_width", l.max_width),
        ("min_height", l.min_height),
        ("max_height", l.max_height),
    ] {
        if let Some(v) = v {
            s.push_str(&format!(",\"{key}\":{v}"));
        }
    }
    if l.wrap == AutoLayoutWrap::Wrap {
        s.push_str(",\"wrap\":true");
    }
    if l.resize_on_wrap {
        s.push_str(",\"resize_on_wrap\":true");
    }
    // CSS Flexbox parity fields — only serialize when non-default to keep
    // old documents byte-stable (default: true / LastOnTop).
    if !l.stroke_include_in_layout {
        s.push_str(",\"stroke_include_in_layout\":false");
    }
    if l.canvas_stacking != CanvasStacking::default() {
        s.push_str(&format!(",\"canvas_stacking\":\"{}\"", l.canvas_stacking.to_str()));
    }
    s
}

fn kind_json(k: &NodeKind) -> String {
    match k {
        NodeKind::Frame { layout: None } => "{\"t\":\"frame\"}".into(),
        NodeKind::Frame { layout: Some(l) } => format!(
            "{{\"t\":\"frame\",\"layout\":{{\"dir\":\"{}\",\"gap\":{},\"padding\":{},\"sizing\":\"{}\",\"align\":\"{}\",\"space_between\":{}{}{}{}{}{}}}}}",
            if l.direction == LayoutDirection::Horizontal { "h" } else { "v" },
            l.gap,
            // uniform padding serializes as the legacy scalar (old files stay byte-stable)
            if l.uniform_pad() { format!("{}", l.padding[0]) } else { format!("[{},{},{},{}]", l.padding[0], l.padding[1], l.padding[2], l.padding[3]) },
            if l.sizing == Sizing::Hug { "hug" } else { "fixed" },
            match l.align { CrossAlign::Start => "start", CrossAlign::Center => "center", CrossAlign::End => "end", CrossAlign::Baseline => "baseline" },
            l.distribute == Distribute::Between,
            if l.distribute != Distribute::Packed {
                format!(",\"distribute\":\"{}\"", l.distribute.to_str())
            } else {
                String::new()
            },
            l.gap_var.as_deref().map(|v| format!(",\"gap_var\":\"{}\"", esc(v))).unwrap_or_default(),
            l.padding_var.as_deref().map(|v| format!(",\"padding_var\":\"{}\"", esc(v))).unwrap_or_default(),
            l.cross_sizing.map(|s| format!(",\"cross_sizing\":\"{}\"", if s == Sizing::Hug { "hug" } else { "fixed" })).unwrap_or_default(),
            // CSS-grid mode (Figma Grid): omitted entirely when not a grid
            format_args!("{}{}", l.grid.as_ref().map(grid_json).unwrap_or_default(), layout_extras(l)),
        ),
        NodeKind::Group => "{\"t\":\"group\"}".into(),
        NodeKind::Section => "{\"t\":\"section\"}".into(),
        NodeKind::Rect { radius } => format!("{{\"t\":\"rect\",\"radius\":{radius}}}"),
        NodeKind::Ellipse => "{\"t\":\"ellipse\"}".into(),
        NodeKind::Arc { start, end } => {
            format!("{{\"t\":\"arc\",\"start\":{start},\"end\":{end}}}")
        }
        NodeKind::Line => "{\"t\":\"line\"}".into(),
        NodeKind::Text { text } => format!("{{\"t\":\"text\",\"text\":\"{}\"}}", esc(text)),
        NodeKind::Image { asset, fit, placement } => {
            let mut s = format!("{{\"t\":\"image\",\"asset\":\"{}\",\"fit\":\"{}\"", esc(asset), match fit { ImageFit::Fill => "fill", ImageFit::Fit => "fit", ImageFit::Crop => "crop", ImageFit::Tile => "tile" });
            if !placement.is_default() {
                s.push_str(&format!(",\"fx\":{},\"fy\":{},\"scale\":{},\"fliph\":{},\"flipv\":{}",
                    placement.focal.0, placement.focal.1, placement.scale, placement.flip_h, placement.flip_v));
            }
            s.push('}');
            s
        }
        NodeKind::Vector { path } => {
            let cmds: Vec<String> = path.iter().map(|c| match c {
                PathCmd::MoveTo(x, y) => format!("[\"M\",{x},{y}]"),
                PathCmd::LineTo(x, y) => format!("[\"L\",{x},{y}]"),
                PathCmd::CurveTo(x1, y1, x2, y2, x, y) => format!("[\"C\",{x1},{y1},{x2},{y2},{x},{y}]"),
                PathCmd::Close => "[\"Z\"]".into(),
            }).collect();
            format!("{{\"t\":\"vector\",\"path\":[{}]}}", cmds.join(","))
        }
        NodeKind::Component { name } => format!("{{\"t\":\"component\",\"name\":\"{}\"}}", esc(name)),
        NodeKind::Instance { component } => format!("{{\"t\":\"instance\",\"component\":\"{}\"}}", esc(component)),
        NodeKind::Slice => "{\"t\":\"slice\"}".into(),    }
}

pub(crate) fn node_json(n: &Node, out: &mut String) {
    out.push_str(&format!(
        "{{\"id\":\"{}\",\"kind\":{},\"x\":{},\"y\":{},\"w\":{},\"h\":{},\"rotation\":{},\"opacity\":{},\"visible\":{},\"locked\":{},\"fill\":{}",
        esc(&n.id), kind_json(&n.kind),
        n.transform.x, n.transform.y, n.w, n.h, n.transform.rotation, n.opacity, n.visible, n.locked,
        paint_json(&n.fill),
    ));
    if n.name != n.id {
        out.push_str(&format!(",\"name\":\"{}\"", esc(&n.name)));
    }
    if n.transform.scale_x != 1.0 || n.transform.scale_y != 1.0 {
        out.push_str(&format!(
            ",\"scale\":[{},{}]",
            n.transform.scale_x, n.transform.scale_y
        ));
    }
    if n.transform.skew_x != 0.0 || n.transform.skew_y != 0.0 {
        out.push_str(&format!(
            ",\"skew\":[{},{}]",
            n.transform.skew_x, n.transform.skew_y
        ));
    }
    if n.transform.origin_x != 0.5 || n.transform.origin_y != 0.5 {
        out.push_str(&format!(
            ",\"origin\":[{},{}]",
            n.transform.origin_x, n.transform.origin_y
        ));
    }
    if n.stroke.width > 0.0 {
        // solid stays the byte-stable {"color","width"} shape; gradients
        // add the "paint" object (same encoding as fills)
        if let Paint::Solid(c) = &n.stroke.paint {
            out.push_str(&format!(
                ",\"stroke\":{{\"color\":\"{}\",\"width\":{}}}",
                color_to_hex(*c),
                n.stroke.width
            ));
        } else {
            out.push_str(&format!(
                ",\"stroke\":{{\"paint\":{},\"width\":{}}}",
                paint_json(&n.stroke.paint),
                n.stroke.width
            ));
        }
    }
    if n.visual_stacks_materialized {
        let layers = n
            .fill_layers
            .iter()
            .map(|l| {
                format!(
                    "{{\"paint\":{},\"opacity\":{},\"visible\":{},\"blend\":\"{}\"}}",
                    paint_json(&l.paint),
                    l.opacity,
                    l.visible,
                    blend_name(l.blend)
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        out.push_str(&format!(",\"fill_layers\":[{layers}]"));
    }
    if n.visual_stacks_materialized {
        let layers = n.stroke_layers.iter().map(|l| {
            // solid keeps the legacy "color" key (byte-stable old files);
            // gradient strokes serialize through "paint" like fills
            let paint_part = match &l.stroke.paint {
                Paint::Solid(c) => format!("\"color\":\"{}\"", color_to_hex(*c)),
                other => format!("\"paint\":{}", paint_json(other)),
            };
            format!(
            "{{{},\"width\":{},\"opacity\":{},\"visible\":{},\"blend\":\"{}\",\"align\":\"{}\",\"cap_start\":\"{}\",\"cap_end\":\"{}\",\"join\":\"{}\",\"dash\":[{}],\"dash_offset\":{},\"miter\":{}}}",
            paint_part,
            l.stroke.width, l.opacity, l.visible, blend_name(l.blend),
            match l.options.align { StrokeAlign::Inside => "inside", StrokeAlign::Center => "center", StrokeAlign::Outside => "outside" },
            cap_name(l.options.cap_start), cap_name(l.options.cap_end),
            match l.options.join { StrokeJoin::Miter => "miter", StrokeJoin::Bevel => "bevel", StrokeJoin::Round => "round" },
            l.options.dash.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(","), l.options.dash_offset, l.options.miter_limit
        )}).collect::<Vec<_>>().join(",");
        out.push_str(&format!(",\"stroke_layers\":[{layers}]"));
    }
    if n.visual_stacks_materialized {
        let layers = n
            .effect_layers
            .iter()
            .map(|l| {
                format!(
                    "{{\"effect\":{},\"opacity\":{},\"visible\":{},\"blend\":\"{}\"}}",
                    effect_json(&l.effect),
                    l.opacity,
                    l.visible,
                    blend_name(l.blend)
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        out.push_str(&format!(",\"effect_layers\":[{layers}]"));
    }
    if let Some([tl, tr, br, bl]) = n.corner_radii {
        out.push_str(&format!(",\"corners\":[{tl},{tr},{br},{bl}]"));
    }
    // rich text runs (non-empty only — plain text stays byte-identical).
    // start/len are CHAR indices into the text string.
    if !n.text_runs.is_empty() {
        let runs: Vec<String> = n
            .text_runs
            .iter()
            .map(|r| {
                let mut s = format!("{{\"start\":{},\"len\":{}", r.start, r.len);
                if let Some(c) = r.color {
                    s.push_str(&format!(",\"color\":\"{}\"", color_to_hex(c)));
                }
                if let Some(sz) = r.size {
                    s.push_str(&format!(",\"size\":{sz}"));
                }
                if let Some(f) = &r.font {
                    s.push_str(&format!(",\"font\":\"{}\"", esc(f)));
                }
                if let Some(w) = r.weight {
                    s.push_str(&format!(",\"weight\":{w}"));
                }
                if let Some(i) = r.italic {
                    s.push_str(&format!(",\"italic\":{i}"));
                }
                if let Some(ls) = r.ls {
                    s.push_str(&format!(",\"ls\":{ls}"));
                }
                s.push('}');
                s
            })
            .collect();
        out.push_str(&format!(",\"textRuns\":[{}]", runs.join(",")));
    }
    if n.pin != (HPin::Left, VPin::Top) {
        let h = match n.pin.0 {
            HPin::Left => "left",
            HPin::Right => "right",
            HPin::CenterH => "center",
            HPin::StretchH => "stretch",
            HPin::ScaleH => "scale",
        };
        let v = match n.pin.1 {
            VPin::Top => "top",
            VPin::Bottom => "bottom",
            VPin::CenterV => "center",
            VPin::StretchV => "stretch",
            VPin::ScaleV => "scale",
        };
        out.push_str(&format!(",\"pin\":\"{h} {v}\""));
    }
    if n.blend != BlendKind::Normal {
        let b = blend_name(n.blend);
        out.push_str(&format!(",\"blend\":\"{b}\""));
    }
    if !n.effects.is_empty() {
        let fx: Vec<String> = n.effects.iter().map(effect_json).collect();
        out.push_str(&format!(",\"effects\":[{}]", fx.join(",")));
    }
    if let Some(p) = &n.prototype {
        out.push_str(&format!(
            ",\"prototype\":{{\"to\":\"{}\",\"ms\":{}}}",
            esc(&p.destination),
            p.transition_ms
        ));
    }
    if n.is_mask {
        out.push_str(",\"mask\":true");
    }
    if let Some(b) = n.baseline {
        out.push_str(&format!(",\"baseline\":{b}"));
    }
    if n.constraints != ChildConstraints::default() {
        let mut parts: Vec<String> = Vec::new();
        if let Some(a) = n.constraints.align_self {
            parts.push(format!(
                "\"align_self\":\"{}\"",
                match a {
                    Alignment::Min => "min",
                    Alignment::Center => "center",
                    Alignment::Max => "max",
                    Alignment::Baseline => "baseline",
                }
            ));
        }
        if n.constraints.grow != 0.0 {
            parts.push(format!("\"grow\":{}", n.constraints.grow));
        }
        if n.constraints.shrink != 1.0 {
            parts.push(format!("\"shrink\":{}", n.constraints.shrink));
        }
        if let Some(b) = n.constraints.basis {
            parts.push(format!("\"basis\":{b}"));
        }
        if n.constraints.is_absolute {
            parts.push("\"absolute\":true".to_string());
        }
        if n.constraints.fixed {
            parts.push("\"fixed\":true".to_string());
        }
        if n.constraints.sticky {
            parts.push("\"sticky\":true".to_string());
        }
        if let Some(c) = n.constraints.grid_col {
            parts.push(format!("\"col\":{c}"));
        }
        if let Some(r) = n.constraints.grid_row {
            parts.push(format!("\"row\":{r}"));
        }
        if n.constraints.grid_col_span != 1 {
            parts.push(format!("\"col_span\":{}", n.constraints.grid_col_span));
        }
        if n.constraints.grid_row_span != 1 {
            parts.push(format!("\"row_span\":{}", n.constraints.grid_row_span));
        }
        out.push_str(&format!(",\"constraints\":{{{}}}", parts.join(",")));
    }
    // z_index: only serialize when set (default: None)
    if let Some(z) = n.z_index {
        out.push_str(&format!(",\"z_index\":{}", z));
    }
    if !n.bindings.is_empty() {
        let mut keys: Vec<_> = n.bindings.keys().collect();
        keys.sort();
        let kv: Vec<String> = keys
            .iter()
            .map(|k| format!("\"{}\":\"{}\"", esc(k), esc(&n.bindings[*k])))
            .collect();
        out.push_str(&format!(",\"bindings\":{{{}}}", kv.join(",")));
    }
    if !n.overrides.is_empty() {
        let mut keys: Vec<_> = n.overrides.keys().collect();
        keys.sort();
        let kv: Vec<String> = keys
            .iter()
            .map(|k| format!("\"{}\":\"{}\"", esc(k), esc(&n.overrides[*k])))
            .collect();
        out.push_str(&format!(",\"overrides\":{{{}}}", kv.join(",")));
    }
    if !n.props.is_empty() {
        let parts: Vec<String> = n.props.iter().map(prop_json).collect();
        out.push_str(&format!(",\"props\":[{}]", parts.join(",")));
    }
    if !n.export_settings.is_empty() {
        let parts: Vec<String> = n
            .export_settings
            .iter()
            .map(|s| {
                format!(
                    "{{\"format\":\"{}\",\"scale\":{},\"quality\":{},\"suffix\":\"{}\"}}",
                    esc(&s.format),
                    s.scale,
                    s.quality,
                    esc(&s.suffix)
                )
            })
            .collect();
        out.push_str(&format!(",\"export_settings\":[{}]", parts.join(",")));
    }
    if !n.interactions.is_empty() {
        let parts: Vec<String> = n.interactions.iter().map(interaction_json).collect();
        out.push_str(&format!(",\"interactions\":[{}]", parts.join(",")));
    }
    if n.is_starting_point {
        out.push_str(",\"start\":true");
    }
    if n.overflow != Overflow::Visible {
        out.push_str(&format!(",\"overflow\":\"{}\"", n.overflow.to_str()));
    }
    if n.scroll != (0.0, 0.0) {
        out.push_str(&format!(",\"scroll\":[{},{}]", n.scroll.0, n.scroll.1));
    }
    if !n.layout_grids.is_empty() {
        let parts: Vec<String> = n
            .layout_grids
            .iter()
            .map(|g| {
                format!(
                    "{{\"pattern\":\"{}\",\"count\":{},\"gutter\":{},\"margin\":{},\"cell\":{}}}",
                    g.pattern.to_str(),
                    g.count,
                    g.gutter,
                    g.margin,
                    g.cell
                )
            })
            .collect();
        out.push_str(&format!(",\"grids\":[{}]", parts.join(",")));
    }
    if !n.children.is_empty() {
        out.push_str(",\"children\":[");
        for (i, c) in n.children.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            node_json(c, out);
        }
        out.push(']');
    }
    out.push('}');
}

/// Serialize a Document to `.x` v1 JSON.
pub fn save_x(doc: &Document) -> String {
    let mut out = format!("{{\"format\":\"x-native\",\"version\":{X_FORMAT_VERSION},");
    // variables
    let mut colors: Vec<_> = doc.variables.colors.iter().collect();
    colors.sort_by_key(|(k, _)| (*k).clone());
    let mut numbers: Vec<_> = doc.variables.numbers.iter().collect();
    numbers.sort_by_key(|(k, _)| (*k).clone());
    out.push_str("\"variables\":{\"colors\":{");
    out.push_str(
        &colors
            .iter()
            .map(|(k, v)| format!("\"{}\":\"{}\"", esc(k), color_to_hex(**v)))
            .collect::<Vec<_>>()
            .join(","),
    );
    out.push_str("},\"numbers\":{");
    out.push_str(
        &numbers
            .iter()
            .map(|(k, v)| format!("\"{}\":{}", esc(k), v))
            .collect::<Vec<_>>()
            .join(","),
    );
    // strings, bools, collections, modes (P1 additions)
    let mut strs: Vec<_> = doc.variables.strings.iter().collect();
    strs.sort_by_key(|(k, _)| (*k).clone());
    out.push_str("},\"strings\":{");
    out.push_str(
        &strs
            .iter()
            .map(|(k, v)| format!("\"{}\":\"{}\"", esc(k), esc(v)))
            .collect::<Vec<_>>()
            .join(","),
    );
    let mut bls: Vec<_> = doc.variables.bools.iter().collect();
    bls.sort_by_key(|(k, _)| (*k).clone());
    out.push_str("},\"bools\":{");
    out.push_str(
        &bls.iter()
            .map(|(k, v)| format!("\"{}\":{}", esc(k), v))
            .collect::<Vec<_>>()
            .join(","),
    );
    let mut cols: Vec<_> = doc.variables.collections.iter().collect();
    cols.sort_by_key(|(k, _)| (*k).clone());
    out.push_str("},\"collections\":{");
    out.push_str(
        &cols
            .iter()
            .map(|(k, v)| format!("\"{}\":\"{}\"", esc(k), esc(v)))
            .collect::<Vec<_>>()
            .join(","),
    );
    let mut mds: Vec<_> = doc.variables.modes.iter().collect();
    mds.sort_by_key(|(k, _)| (*k).clone());
    out.push_str("},\"modes\":{");
    let mode_strs: Vec<String> = mds
        .iter()
        .map(|(mode, table)| {
            let mut entries: Vec<_> = table.iter().collect();
            entries.sort_by_key(|(k, _)| (*k).clone());
            let inner: Vec<String> = entries
                .iter()
                .map(|(k, c)| format!("\"{}\":\"{}\"", esc(k), color_to_hex(**c)))
                .collect();
            format!("\"{}\":{{{}}}", esc(mode), inner.join(","))
        })
        .collect();
    out.push_str(&mode_strs.join(","));
    out.push('}');
    // typed mode tables (numbers/strings/bools can be mode-driven too)
    fn mode_table<T>(
        tables: &std::collections::HashMap<String, std::collections::HashMap<String, T>>,
        fmt_val: impl Fn(&T) -> String,
    ) -> String {
        let mut mds: Vec<_> = tables.iter().collect();
        mds.sort_by_key(|(k, _)| (*k).clone());
        let parts: Vec<String> = mds
            .iter()
            .map(|(mode, table)| {
                let mut entries: Vec<_> = table.iter().collect();
                entries.sort_by_key(|(k, _)| (*k).clone());
                let inner: Vec<String> = entries
                    .iter()
                    .map(|(k, v)| format!("\"{}\":{}", esc(k), fmt_val(v)))
                    .collect();
                format!("\"{}\":{{{}}}", esc(mode), inner.join(","))
            })
            .collect();
        parts.join(",")
    }
    out.push_str(&format!(
        ",\"num_modes\":{{{}}}",
        mode_table(&doc.variables.num_modes, |v: &f64| format!("{v}"))
    ));
    out.push_str(&format!(
        ",\"str_modes\":{{{}}}",
        mode_table(&doc.variables.str_modes, |v: &String| format!(
            "\"{}\"",
            esc(v)
        ))
    ));
    out.push_str(&format!(
        ",\"bool_modes\":{{{}}}",
        mode_table(&doc.variables.bool_modes, |v: &bool| format!("{v}"))
    ));
    if let Some(m) = &doc.variables.active_mode {
        out.push_str(&format!(",\"active_mode\":\"{}\"", esc(m)));
    }
    if !doc.variables.exposed.is_empty() {
        let names: Vec<String> = doc
            .variables
            .exposed
            .iter()
            .map(|n| format!("\"{}\"", esc(n)))
            .collect();
        out.push_str(&format!(",\"exposed\":[{}]", names.join(",")));
    }
    out.push_str("},");
    // named styles (Figma paint/text/effect styles). Sorted for determinism.
    let mut style_keys: Vec<_> = doc.styles.keys().collect();
    style_keys.sort();
    out.push_str("\"styles\":{");
    let style_strs: Vec<String> = style_keys
        .iter()
        .map(|k| {
            format!(
                "\"{}\":{}",
                esc(k),
                legacy_style_json(&doc.styles[k.as_str()])
            )
        })
        .collect();
    out.push_str(&style_strs.join(","));
    // component properties per master (sorted for determinism)
    {
        let mut prop_keys: Vec<_> = doc.component_props.keys().collect();
        prop_keys.sort();
        let groups: Vec<String> = prop_keys
            .iter()
            .map(|k| {
                let entries: Vec<String> = doc.component_props[k.as_str()]
                    .iter()
                    .map(|e| {
                        let kind = match e.kind {
                            x_core::ComponentPropKind::Text => "text",
                            x_core::ComponentPropKind::Bool => "bool",
                            x_core::ComponentPropKind::Swap => "swap",
                        };
                        format!(
                            "{{\"name\":\"{}\",\"target\":\"{}\",\"kind\":\"{}\",\"default\":\"{}\"}}",
                            esc(&e.name),
                            esc(&e.target),
                            kind,
                            esc(&e.default)
                        )
                    })
                    .collect();
                format!("\"{}\":[{}]", esc(k), entries.join(","))
            })
            .collect();
        out.push_str("},\"component_props\":{");
        out.push_str(&groups.join(","));
    }
    // canvas comment pins (review C18)
    {
        out.push_str("},\"comments\":[");
        let cs: Vec<String> = doc
            .comments
            .iter()
            .map(|c| {
                format!(
                    "{{\"id\":\"{}\",\"page\":{},\"x\":{},\"y\":{},\"author\":\"{}\",\"text\":\"{}\",\"resolved\":{}}}",
                    esc(&c.id),
                    c.page,
                    c.x,
                    c.y,
                    esc(&c.author),
                    esc(&c.text),
                    c.resolved
                )
            })
            .collect();
        out.push_str(&cs.join(","));
        out.push(']');
    }
    // content-addressed EMBEDDED assets (asset:// store) — external
    // references stay machine-local and are not serialized
    out.push_str(",\"assets\":[");
    let asset_strs: Vec<String> = doc
        .assets
        .embedded_sorted()
        .iter()
        .map(|r| {
            format!(
                "{{\"id\":\"{}\",\"mime\":\"{}\",\"name\":\"{}\"{},\"data\":\"{}\"}}",
                esc(&r.id),
                esc(&r.mime),
                esc(&r.name),
                r.dimensions
                    .map(|(w, h)| format!(",\"w\":{w},\"h\":{h}"))
                    .unwrap_or_default(),
                crate::b64::base64(&r.bytes),
            )
        })
        .collect();
    out.push_str(&asset_strs.join(","));
    // pinned library dependencies + their version snapshots (documents
    // stay self-contained: render identically without the .xlib on disk)
    out.push_str("],\"libraries\":[");
    let mut deps = doc.library_deps.clone();
    deps.sort_by(|a, b| a.library_id.cmp(&b.library_id));
    let dep_strs: Vec<String> = deps.iter().map(|d| {
        let snap = doc.library_snapshots.get(&d.library_id)
            .map(crate::xlib::save_xlib)
            .unwrap_or_else(|| "null".into());
        format!("{{\"library_id\":\"{}\",\"resolved_version\":{},\"snapshot_hash\":\"{}\",\"source_path\":\"{}\",\"snapshot\":{}}}",
            esc(&d.library_id), d.resolved_version, esc(&d.snapshot_hash), esc(&d.source_path), snap)
    }).collect();
    out.push_str(&dep_strs.join(","));
    out.push_str("],\"pages\":[");
    for (i, p) in doc.pages.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        node_json(p, &mut out);
    }
    out.push_str("]}");
    out
}

/// Legacy style encoder for .x documents.
pub(crate) fn legacy_style_json(s: &LegacyStyle) -> String {
    match s {
        LegacyStyle::Paint { fill } => format!("{{\"t\":\"paint\",\"fill\":{}}}", paint_json(fill)),
        LegacyStyle::Text { font, size, letter_spacing, line_height } => format!(
            "{{\"t\":\"text\",\"font\":\"{}\",\"size\":{size},\"ls\":{letter_spacing},\"lh\":{line_height}}}", esc(font)),
        LegacyStyle::Effect { effects } => {
            let fx: Vec<String> = effects.iter().map(|e| match e {
                Effect::DropShadow { dx, dy, blur, color } => format!("{{\"t\":\"drop\",\"dx\":{dx},\"dy\":{dy},\"blur\":{blur},\"c\":\"{}\"}}", color_to_hex(*color)),
                Effect::InnerShadow { dx, dy, blur, color } => format!("{{\"t\":\"inner\",\"dx\":{dx},\"dy\":{dy},\"blur\":{blur},\"c\":\"{}\"}}", color_to_hex(*color)),
                Effect::LayerBlur { radius } => format!("{{\"t\":\"blur\",\"r\":{radius}}}"),
                Effect::BackgroundBlur { radius } => format!("{{\"t\":\"bgblur\",\"r\":{radius}}}"),
                Effect::Noise { amount, seed } => format!("{{\"t\":\"noise\",\"a\":{amount},\"s\":{seed}}}"),
            }).collect();
            format!("{{\"t\":\"effect\",\"effects\":[{}]}}", fx.join(","))
        }
    }
}

/// New style encoder for .xlib libraries.
pub(crate) fn style_json(s: &x_core::Style) -> String {
    match &s.data {
        x_core::StyleData::Color(data) => {
            format!("{{\"t\":\"color\",\"paint\":{}}}", paint_json(&data.paint))
        }
        x_core::StyleData::Text(data) => format!(
            "{{\"t\":\"text\",\"font\":\"{}\",\"weight\":{},\"size\":{},\"ls\":{},\"lh\":{}}}",
            esc(&data.font_family),
            data.font_weight,
            data.font_size,
            data.letter_spacing,
            data.line_height
        ),
        x_core::StyleData::Effect(data) => {
            let fx: Vec<String> = data
                .effects
                .iter()
                .map(|e| match e {
                    x_core::Effect::DropShadow {
                        dx,
                        dy,
                        blur,
                        color,
                    } => format!(
                        "{{\"t\":\"drop\",\"dx\":{dx},\"dy\":{dy},\"blur\":{blur},\"c\":\"{}\"}}",
                        color_to_hex(*color)
                    ),
                    x_core::Effect::InnerShadow {
                        dx,
                        dy,
                        blur,
                        color,
                    } => format!(
                        "{{\"t\":\"inner\",\"dx\":{dx},\"dy\":{dy},\"blur\":{blur},\"c\":\"{}\"}}",
                        color_to_hex(*color)
                    ),
                    x_core::Effect::LayerBlur { radius } => {
                        format!("{{\"t\":\"blur\",\"r\":{radius}}}")
                    }
                    x_core::Effect::BackgroundBlur { radius } => {
                        format!("{{\"t\":\"bgblur\",\"r\":{radius}}}")
                    }
                    x_core::Effect::Noise { amount, seed } => {
                        format!("{{\"t\":\"noise\",\"a\":{amount},\"s\":{seed}}}")
                    }
                })
                .collect();
            format!("{{\"t\":\"effect\",\"effects\":[{}]}}", fx.join(","))
        }
        x_core::StyleData::Grid(_) => "{\"t\":\"grid\"}".to_string(),
    }
}
