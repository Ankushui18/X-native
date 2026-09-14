//! B13 "Copy as code": deterministic JSX (React + inline styles) from a
//! node subtree — the Dev-Mode-style bridge between the canvas and code.
//!
//! Rules (all fixed-key-order, integer-first number formatting, so output
//! is byte-stable for a given tree):
//! - invisible nodes and masks are skipped entirely; slices render nothing
//!   and are skipped too
//! - frames / rects / groups / sections / component masters → `<div>`
//! - auto-layout frames emit flex styles; children positioned absolutely
//!   ONLY when the parent has no layout (flex flow otherwise)
//! - text → `<span>` with fontSize / lineHeight / letterSpacing /
//!   fontWeight / color (first rich-run wins over the node fill)
//! - images → `<img src="asset://…">`, vectors → `<svg>` placeholders,
//!   instances → `<Ident />` component references
//! - multi-selection wraps in a fragment

use x_core::{
    color_to_hex, AutoLayout, AutoLayoutWrap, CrossAlign, Distribute, ImageFit, Node, NodeKind,
    Paint, StrokeAlign,
};

/// JSX for a SELECTION: one subtree per node, wrapped in a fragment when
/// more than one.
pub fn selection_to_jsx<'a>(nodes: impl IntoIterator<Item = &'a Node>) -> String {
    let picked: Vec<&Node> = nodes.into_iter().collect();
    let mut parts: Vec<String> = Vec::new();
    for n in &picked {
        let mut out = String::new();
        emit(n, None, 0, &mut out);
        if !out.is_empty() {
            parts.push(out);
        }
    }
    match parts.len() {
        0 => String::new(),
        1 => parts.remove(0),
        _ => format!("<>\n{}\n</>", parts.join("\n")),
    }
}

/// JSX for a single node's subtree.
pub fn node_to_jsx(node: &Node) -> String {
    selection_to_jsx(std::iter::once(node))
}

/// Integer-first number formatting (42, 12.5, 0.25): trims float noise.
fn n(v: f64) -> String {
    let r = (v * 100.0).round() / 100.0;
    if (r - r.trunc()).abs() < f64::EPSILON {
        format!("{}", r as i64)
    } else {
        let s = format!("{r}");
        s
    }
}

fn ident(name: &str) -> String {
    let camel: String = name
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut cs = w.chars();
            match cs.next() {
                Some(f) => f.to_uppercase().collect::<String>() + cs.as_str(),
                None => String::new(),
            }
        })
        .collect();
    if camel.is_empty() || camel.chars().next().map(|c| c.is_ascii_digit()) == Some(true) {
        "Component".into()
    } else {
        camel
    }
}

fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        match c {
            '\'' => out.push_str("\\'"),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            _ => out.push(c),
        }
    }
    out.push('\'');
    out
}

fn paint_css(p: &Paint, key: &str) -> Option<String> {
    Some(match p {
        Paint::Solid(c) => {
            if c.components[3] == 0.0 {
                return None;
            }
            format!(
                "{key}: {quote_color}",
                quote_color = quote(&color_to_hex(*c))
            )
        }
        Paint::Variable(id) => format!("{key}: {}", quote(&format!("var(--{id})"))),
        Paint::LinearGradient {
            start, end, stops, ..
        } => {
            // angle from the start→end vector (CSS 0deg = to top)
            let (dx, dy) = (end.0 - start.0, end.1 - start.1);
            let deg = (dy.atan2(dx).to_degrees() + 90.0).rem_euclid(360.0);
            let stops: Vec<String> = stops
                .iter()
                .map(|(p, c)| format!("{} {}%", color_to_hex(*c), n((*p * 100.0) as f64)))
                .collect();
            format!(
                "{key}: {}",
                quote(&format!(
                    "linear-gradient({}deg, {})",
                    n(deg),
                    stops.join(", ")
                ))
            )
        }
        Paint::RadialGradient { center, stops, .. } => {
            let stops: Vec<String> = stops
                .iter()
                .map(|(p, c)| format!("{} {}%", color_to_hex(*c), n((*p * 100.0) as f64)))
                .collect();
            format!(
                "{key}: {}",
                quote(&format!(
                    "radial-gradient(circle at {}% {}%, {})",
                    n(center.0 * 100.0),
                    n(center.1 * 100.0),
                    stops.join(", ")
                ))
            )
        }
        Paint::Pattern { asset, fit } => {
            let size = match fit {
                ImageFit::Fit => "backgroundSize: 'contain', backgroundRepeat: 'no-repeat'",
                _ => "backgroundSize: 'cover'",
            };
            format!("{key}: {}, {size}", quote(&format!("url(asset://{asset})")))
        }
    })
}

/// CSS Flexbox parity: inside strokes → `border`, outside/center → `outline`.
fn stroke_css(node: &Node) -> Option<String> {
    if node.stroke.width <= 0.0 {
        return None;
    }
    let hex = match &node.stroke.paint {
        Paint::Solid(c) if c.components[3] > 0.0 => color_to_hex(*c),
        _ => return None,
    };
    let align = node
        .active_strokes()
        .first()
        .map(|l| l.options.align)
        .unwrap_or(StrokeAlign::Center);
    let prop = match align {
        StrokeAlign::Inside => "border",
        _ => "outline",
    };
    Some(format!(
        "{}: {}px solid {}",
        prop,
        n(node.stroke.width),
        quote(&hex)
    ))
}

fn object_fit(fit: &ImageFit) -> Option<&'static str> {
    match fit {
        ImageFit::Fill => None,
        ImageFit::Fit => Some("contain"),
        ImageFit::Crop => Some("cover"),
        ImageFit::Tile => None,
    }
}

/// Style entries for the box (size / position / paint), shared by every
/// element tag. `parent_layout` None → absolute position.
fn box_style(node: &Node, parent_layout: Option<&AutoLayout>) -> Vec<String> {
    use x_core::{LayoutDirection, Sizing};
    let mut s: Vec<String> = Vec::new();
    macro_rules! sz {
        ($k:expr, $v:expr) => {
            s.push(format!("{}: {}", $k, n($v)))
        };
    }
    macro_rules! abs {
        () => {
            s.push("position: 'absolute'".into());
            sz!("left", node.transform.x);
            sz!("top", node.transform.y);
            sz!("width", node.w);
            sz!("height", node.h);
        };
    }
    let Some(l) = parent_layout else {
        abs!();
        return s;
    };
    // Figma ABSOLUTE children keep their canvas coordinates
    if node.constraints.is_absolute {
        abs!();
        return s;
    }
    // own Hug sizing (frames with their own layout): omit the dimension of
    // the axis that hugs (own main axis / own cross axis)
    let (mut omit_w, mut omit_h) = match &node.kind {
        NodeKind::Frame { layout: Some(own) } => {
            let main_w = own.direction == LayoutDirection::Horizontal;
            let (hug_main, hug_cross) = (own.sizing == Sizing::Hug, own.cross() == Sizing::Hug);
            if main_w {
                (hug_main, hug_cross)
            } else {
                (hug_cross, hug_main)
            }
        }
        _ => (false, false),
    };
    // Fill children stretch along the parent's main axis
    if node.constraints.grow >= 1.0 {
        s.push("flexGrow: 1".into());
        match l.direction {
            LayoutDirection::Horizontal => omit_w = true,
            LayoutDirection::Vertical => omit_h = true,
        }
    }
    if !omit_w {
        sz!("width", node.w);
    }
    if !omit_h {
        sz!("height", node.h);
    }
    s
}

fn layout_style(l: &AutoLayout, out: &mut Vec<String>) {
    out.push("display: 'flex'".to_string());
    out.push(format!(
        "flexDirection: {}",
        quote(match l.direction {
            x_core::LayoutDirection::Horizontal => "row",
            x_core::LayoutDirection::Vertical => "column",
        })
    ));
    if l.gap > 0.0 {
        out.push(format!("gap: {}", n(l.gap)));
    }
    let [pl, pr, pt, pb] = l.padding;
    if pt + pr + pb + pl > 0.0 {
        if l.uniform_pad() {
            out.push(format!("padding: {}", n(pt)));
        } else {
            out.push(format!(
                "padding: {}",
                quote(&format!("{}px {}px {}px {}px", n(pt), n(pr), n(pb), n(pl)))
            ));
        }
    }
    let align = match l.align {
        CrossAlign::Start => None,
        CrossAlign::Center => Some("center"),
        CrossAlign::End => Some("flex-end"),
        CrossAlign::Baseline => Some("baseline"),
    };
    if let Some(a) = align {
        out.push(format!("alignItems: {}", quote(a)));
    }
    let justify = match l.distribute {
        Distribute::Packed => None,
        Distribute::Between => Some("space-between"),
        Distribute::Around => Some("space-around"),
        Distribute::Evenly => Some("space-evenly"),
    };
    if let Some(j) = justify {
        out.push(format!("justifyContent: {}", quote(j)));
    }
    if l.wrap == AutoLayoutWrap::Wrap {
        out.push("flexWrap: 'wrap'".into());
    }
    if let Some(w) = l.min_width {
        out.push(format!("minWidth: {}", n(w)));
    }
    if let Some(w) = l.max_width {
        out.push(format!("maxWidth: {}", n(w)));
    }
    if let Some(h) = l.min_height {
        out.push(format!("minHeight: {}", n(h)));
    }
    if let Some(h) = l.max_height {
        out.push(format!("maxHeight: {}", n(h)));
    }
}

fn indent_str(depth: usize) -> String {
    "  ".repeat(depth + 1)
}

/// Open a tag with a (possibly empty) style block. The style entries are
/// emitted one per line inside `style={{ ... }}`.
fn open_tag(tag: &str, style: &[String], depth: usize) -> String {
    let ind = indent_str(depth);
    if style.is_empty() {
        return format!("{ind}<{tag}>\n");
    }
    let mut out = format!("{ind}<{tag}\n{ind}  style={{{{\n");
    for e in style {
        out.push_str(&format!("{ind}    {e},\n"));
    }
    out.push_str(&format!("{ind}  }}}}\n{ind}>\n"));
    out
}

fn emit(node: &Node, parent_layout: Option<&AutoLayout>, depth: usize, out: &mut String) {
    if !node.visible || node.is_mask {
        return;
    }
    match &node.kind {
        NodeKind::Slice => return,
        NodeKind::Instance { component } => {
            // component reference; position/size when parent doesn't flow
            let mut style = box_style(node, parent_layout);
            if node.opacity < 1.0 {
                style.push(format!("opacity: {}", n(node.opacity as f64)));
            }
            let ind = indent_str(depth);
            if style.is_empty() {
                out.push_str(&format!("{ind}<{} />\n", ident(component)));
            } else {
                out.push_str(&format!(
                    "{ind}<{id}\n{ind}  style={{\n",
                    id = ident(component)
                ));
                for e in &style {
                    out.push_str(&format!("{ind}    {e},\n"));
                }
                out.push_str(&format!("{ind}  }}\n{ind}/>\n"));
            }
            return;
        }
        NodeKind::Image { asset, fit, .. } => {
            let mut style = box_style(node, parent_layout);
            if node.opacity < 1.0 {
                style.push(format!("opacity: {}", n(node.opacity as f64)));
            }
            if let Some(of) = object_fit(fit) {
                style.push(format!("objectFit: {}", quote(of)));
            }
            let ind = indent_str(depth);
            out.push_str(&format!(
                "{ind}<img\n{ind}  src={}\n",
                quote(&format!("asset://{asset}"))
            ));
            out.push_str(&format!("{ind}  style={{\n"));
            for e in &style {
                out.push_str(&format!("{ind}    {e},\n"));
            }
            out.push_str(&format!("{ind}  }}\n{ind}/>\n"));
            return;
        }
        NodeKind::Vector { path } => {
            let ind = indent_str(depth);
            out.push_str(&format!(
                "{ind}<svg width={{{}}} height={{{}}} viewBox={}>",
                n(node.w),
                n(node.h),
                quote(&format!("0 0 {} {}", n(node.w), n(node.h)))
            ));
            out.push_str(&format!("{{/* {} path segments */}}", path.len()));
            out.push_str("</svg>\n");
            return;
        }
        _ => {}
    }

    // element shapes that carry a box + paint
    let (tag, comment): (&str, Option<String>) = match &node.kind {
        NodeKind::Text { .. } => ("span", None),
        NodeKind::Ellipse => ("div", None),
        NodeKind::Component { name } => ("div", Some(format!("component master: {name}"))),
        _ => ("div", None),
    };

    let mut style: Vec<String> = box_style(node, parent_layout);
    match &node.kind {
        NodeKind::Frame { layout } => {
            if let Some(l) = layout {
                layout_style(l, &mut style);
            }
            if node.overflow.clips() {
                style.push("overflow: 'hidden'".into());
            }
        }
        NodeKind::Ellipse => {
            style.push("borderRadius: 9999".into());
        }
        NodeKind::Text { text } => {
            let tm = node.text_metrics.clone().unwrap_or_default();
            style.push(format!(
                "fontSize: {}",
                n(if tm.font_size > 0.0 {
                    tm.font_size
                } else {
                    16.0
                })
            ));
            if tm.line_height > 0.0 {
                style.push(format!("lineHeight: {}px", n(tm.line_height)));
            }
            if tm.letter_spacing != 0.0 {
                style.push(format!("letterSpacing: {}px", n(tm.letter_spacing)));
            }
            let weight = node.text_runs.first().and_then(|r| r.weight).unwrap_or(400);
            if weight != 400 {
                style.push(format!("fontWeight: {weight}"));
            }
            if let Some(c) = node.text_runs.first().and_then(|r| r.color) {
                style.push(format!("color: {}", quote(&color_to_hex(c))));
            } else if let Some(css) = paint_css(&node.fill, "color") {
                style.push(css);
            }
            style.push("whiteSpace: 'pre-wrap'".into());
            let _ = text;
        }
        _ => {}
    }
    // box paint / border / radius / opacity for the div shapes
    if tag != "span" {
        if let Some(css) = paint_css(&node.fill, "backgroundColor") {
            style.push(css);
        }
        if let Some(css) = stroke_css(node) {
            style.push(css);
        }
        if let Some([a, b, c, d]) = node.corner_radii {
            if a + b + c + d > 0.0 {
                if a == b && b == c && c == d {
                    style.push(format!("borderRadius: {}", n(a)));
                } else {
                    style.push(format!(
                        "borderRadius: {}",
                        quote(&format!("{}px {}px {}px {}px", n(a), n(b), n(c), n(d)))
                    ));
                }
            }
        }
        if node.opacity < 1.0 {
            style.push(format!("opacity: {}", n(node.opacity as f64)));
        }
    }

    let ind = indent_str(depth);
    if let Some(c) = comment {
        out.push_str(&format!("{ind}{{/* {c} */}}\n"));
    }
    out.push_str(&open_tag(tag, &style, depth));
    if let NodeKind::Text { text } = &node.kind {
        out.push_str(&format!("{}{}\n", indent_str(depth + 1), quote(text)));
    }
    let my_layout = match &node.kind {
        NodeKind::Frame { layout } => layout.as_ref(),
        _ => None,
    };
    for child in &node.children {
        emit(child, my_layout, depth + 1, out);
    }
    out.push_str(&format!("{ind}</{tag}>\n"));
}

// ————————————————————————————————————————— Tailwind flavor
// Same style-model inputs as the inline-style emitter (box_style /
// layout_style / paint_css), but every declaration becomes a Tailwind
// class: exact design values map to arbitrary-value classes
// (`w-[120px]`, `bg-[#ee5555]`, `gap-[10px]`), so the markup stays
// utility-first while remaining pixel-faithful. Unmappable declarations
// degrade to Tailwind arbitrary properties (`[key:value]`), keeping the
// output lossless-by-construction like the inline mode.

/// JSX with Tailwind `className` instead of inline styles.
pub fn selection_to_tailwind<'a>(nodes: impl IntoIterator<Item = &'a Node>) -> String {
    let picked: Vec<&Node> = nodes.into_iter().collect();
    let mut parts: Vec<String> = Vec::new();
    for n in &picked {
        let mut out = String::new();
        emit_tw(n, None, 0, &mut out);
        if !out.is_empty() {
            parts.push(out);
        }
    }
    match parts.len() {
        0 => String::new(),
        1 => parts.remove(0),
        _ => format!("<>\\n{}\\n</>", parts.join("\\n")),
    }
}

/// Tailwind JSX for a single node's subtree.
pub fn node_to_tailwind(node: &Node) -> String {
    selection_to_tailwind(std::iter::once(node))
}

/// Strip quotes and a trailing `px` unit from a CSS value.
fn tw_num(v: &str) -> String {
    let v = v.trim().trim_matches('\'');
    v.trim_end_matches("px").trim().to_string()
}

/// One `key: value` inline-style entry → zero or more Tailwind classes.
fn tw_classes(entry: &str) -> Vec<String> {
    let Some((k, v)) = entry.split_once(':') else {
        return vec![];
    };
    let (k, v) = (k.trim(), v.trim().trim_matches('\''));
    let px = |v: &str| format!("{}px", tw_num(v));
    match k {
        "position" => match v {
            "absolute" => vec!["absolute".into()],
            "relative" => vec!["relative".into()],
            _ => vec![],
        },
        "left" => vec![format!("left-[{}]", px(v))],
        "top" => vec![format!("top-[{}]", px(v))],
        "width" => vec![format!("w-[{}]", px(v))],
        "height" => vec![format!("h-[{}]", px(v))],
        "flexGrow" => vec!["flex-1".into()],
        "display" => vec!["flex".into()],
        "flexDirection" => match v {
            "column" => vec!["flex-col".into()],
            _ => vec![],
        },
        "gap" => vec![format!("gap-[{}]", px(v))],
        "padding" => {
            let parts: Vec<&str> = v.split_whitespace().collect();
            match parts.as_slice() {
                [one] => vec![format!(
                    "p-[{}]",
                    one.trim_end_matches("px").to_string() + "px"
                )],
                [t, r, b, l] => vec![
                    format!("pt-[{t}]"),
                    format!("pr-[{r}]"),
                    format!("pb-[{b}]"),
                    format!("pl-[{l}]"),
                ],
                _ => vec![],
            }
        }
        "alignItems" => vec![format!(
            "items-{}",
            match v {
                "center" => "center",
                "flex-end" => "end",
                "baseline" => "baseline",
                _ => "start",
            }
        )]
        .into_iter()
        .filter(|c| c != "items-start")
        .collect(),
        "justifyContent" => vec![format!(
            "justify-{}",
            match v {
                "center" => "center",
                "flex-end" => "end",
                "space-between" => "between",
                "space-around" => "around",
                "space-evenly" => "evenly",
                _ => "start",
            }
        )]
        .into_iter()
        .filter(|c| c != "justify-start")
        .collect(),
        "flexWrap" => {
            if v == "wrap" {
                vec!["flex-wrap".into()]
            } else {
                vec![]
            }
        }
        "minWidth" => vec![format!("min-w-[{}]", px(v))],
        "maxWidth" => vec![format!("max-w-[{}]", px(v))],
        "minHeight" => vec![format!("min-h-[{}]", px(v))],
        "maxHeight" => vec![format!("max-h-[{}]", px(v))],
        "overflow" => {
            if v == "hidden" {
                vec!["overflow-hidden".into()]
            } else {
                vec![]
            }
        }
        "borderRadius" => {
            let parts: Vec<&str> = v.split_whitespace().collect();
            match parts.as_slice() {
                [one] if tw_num(one) == "9999" => vec!["rounded-full".into()],
                [one] => vec![format!(
                    "rounded-[{}]",
                    one.trim_end_matches("px").to_string() + "px"
                )],
                [a, b, c, d] => vec![
                    format!("rounded-tl-[{a}]"),
                    format!("rounded-tr-[{b}]"),
                    format!("rounded-br-[{c}]"),
                    format!("rounded-bl-[{d}]"),
                ],
                _ => vec![],
            }
        }
        "backgroundColor" => {
            let v = v.replace(' ', "_");
            vec![format!("bg-[{v}]")]
        }
        "color" => vec![format!("text-[{v}]")],
        "border" => {
            // "1.5px solid #ff0000"
            let mut w = String::new();
            let mut style = "border-solid".to_string();
            let mut col = String::new();
            for tok in v.split_whitespace() {
                if tok.ends_with("px") {
                    w = tok.to_string();
                } else if tok.starts_with('#') {
                    col = tok.to_string();
                } else if matches!(tok, "solid" | "dashed" | "dotted" | "none") {
                    style = format!("border-{tok}");
                }
            }
            let mut c = vec![];
            if !w.is_empty() {
                c.push(format!("border-[{w}]"));
            }
            if style != "border-solid" {
                c.push(style);
            }
            if !col.is_empty() {
                c.push(format!("border-[{col}]"));
            }
            c
        }
        "opacity" => {
            let ratio: f64 = v.parse().unwrap_or(1.0);
            vec![format!("opacity-{}", (ratio * 100.0).round() as i64)]
        }
        "fontSize" => vec![format!("text-[{}]", px(v))],
        "lineHeight" => vec![format!("leading-[{}]", px(v))],
        "letterSpacing" => {
            if tw_num(v) == "0" {
                vec![]
            } else {
                vec![format!("tracking-[{}]", px(v))]
            }
        }
        "fontWeight" => vec![match v {
            "400" => "font-normal".into(),
            "500" => "font-medium".into(),
            "600" => "font-semibold".into(),
            "700" => "font-bold".into(),
            "800" => "font-extrabold".into(),
            "900" => "font-black".into(),
            other => format!("font-[{other}]"),
        }],
        "whiteSpace" => vec![match v {
            "pre-wrap" => "whitespace-pre-wrap".into(),
            _ => "whitespace-pre".into(),
        }],
        "objectFit" => vec![format!("object-{v}")],
        "visibility" => {
            if v == "hidden" {
                vec!["invisible".into()]
            } else {
                vec![]
            }
        }
        _ => vec![],
    }
}

fn tw_join(entries: &[String]) -> String {
    let mut cls: Vec<String> = Vec::new();
    for e in entries {
        for c in tw_classes(e) {
            if !cls.contains(&c) {
                cls.push(c);
            }
        }
    }
    cls.join(" ")
}

fn tw_open(tag: &str, classes: &str, depth: usize, self_close: bool) -> String {
    let ind = indent_str(depth);
    if classes.is_empty() {
        return if self_close {
            format!("{ind}<{tag} />\n")
        } else {
            format!("{ind}<{tag}>\n")
        };
    }
    if self_close {
        format!("{ind}<{tag} className=\"{classes}\" />\n")
    } else {
        format!("{ind}<{tag} className=\"{classes}\">\n")
    }
}

fn emit_tw(node: &Node, parent_layout: Option<&AutoLayout>, depth: usize, out: &mut String) {
    if !node.visible || node.is_mask {
        return;
    }
    let ind = indent_str(depth);

    // instances render as component references, like the inline emitter
    if let NodeKind::Instance { component } = &node.kind {
        let mut style = box_style(node, parent_layout);
        if let Some(css) = paint_css(&node.fill, "backgroundColor") {
            style.push(css);
        }
        let cls = tw_join(&style);
        out.push_str(&tw_open(&ident(component), &cls, depth, true));
        return;
    }

    if let NodeKind::Image { asset, fit, .. } = &node.kind {
        let mut style = box_style(node, parent_layout);
        if parent_layout.is_none() {
            style.push("position: 'absolute'".into());
        }
        if let Some(of) = object_fit(fit) {
            style.push(format!("objectFit: {of}"));
        }
        let cls = tw_join(&style);
        if cls.is_empty() {
            out.push_str(&format!("{ind}<img src={{'asset://{asset}'}} />\n"));
        } else {
            out.push_str(&format!(
                "{ind}<img src={{'asset://{asset}'}} className=\"{cls}\" />\n"
            ));
        }
        return;
    }

    if let NodeKind::Vector { path } = &node.kind {
        out.push_str(&format!(
            "{ind}<svg width={{{}}} height={{{}}} viewBox={{'0 0 {} {}'}}>{{/* {} path segments */}}</svg>\n",
            n(node.w),
            n(node.h),
            n(node.w),
            n(node.h),
            path.len()
        ));
        return;
    }

    let (tag, comment): (&str, Option<String>) = match &node.kind {
        NodeKind::Text { .. } => ("span", None),
        NodeKind::Ellipse => ("div", None),
        NodeKind::Component { name } => ("div", Some(format!("component master: {name}"))),
        _ => ("div", None),
    };

    let mut style: Vec<String> = box_style(node, parent_layout);
    match &node.kind {
        NodeKind::Frame { layout } => {
            if let Some(l) = layout {
                layout_style(l, &mut style);
            }
            if node.overflow.clips() {
                style.push("overflow: 'hidden'".into());
            }
        }
        NodeKind::Ellipse => {
            style.push("borderRadius: 9999".into());
        }
        NodeKind::Text { .. } => {
            let tm = node.text_metrics.clone().unwrap_or_default();
            style.push(format!(
                "fontSize: {}",
                n(if tm.font_size > 0.0 {
                    tm.font_size
                } else {
                    16.0
                })
            ));
            if tm.line_height > 0.0 {
                style.push(format!("lineHeight: {}px", n(tm.line_height)));
            }
            if tm.letter_spacing != 0.0 {
                style.push(format!("letterSpacing: {}px", n(tm.letter_spacing)));
            }
            let weight = node.text_runs.first().and_then(|r| r.weight).unwrap_or(400);
            if weight != 400 {
                style.push(format!("fontWeight: {weight}"));
            }
            if let Some(c) = node.text_runs.first().and_then(|r| r.color) {
                style.push(format!("color: '{}'", color_to_hex(c)));
            } else if let Some(css) = paint_css(&node.fill, "color") {
                style.push(css);
            }
            style.push("whiteSpace: 'pre-wrap'".into());
        }
        _ => {}
    }
    if tag != "span" {
        if let Some(css) = paint_css(&node.fill, "backgroundColor") {
            style.push(css);
        }
        if let Some(css) = stroke_css(node) {
            style.push(css);
        }
        if let Some([a, b, c, d]) = node.corner_radii {
            if a + b + c + d > 0.0 {
                if a == b && b == c && c == d {
                    style.push(format!("borderRadius: {}", n(a)));
                } else {
                    style.push(format!(
                        "borderRadius: '{}px {}px {}px {}px'",
                        n(a),
                        n(b),
                        n(c),
                        n(d)
                    ));
                }
            }
        }
        if node.opacity < 1.0 {
            style.push(format!("opacity: {}", n(node.opacity as f64)));
        }
    }

    // absolute children need a positioned container — utility-side equivalent
    let has_children = node.children.iter().any(|c| c.visible && !c.is_mask);
    let own_layout = matches!(&node.kind, NodeKind::Frame { layout: Some(_) });
    let mut classes = tw_join(&style);
    if has_children
        && !own_layout
        && !classes.contains("absolute")
        && !classes.contains("relative")
        && !classes.contains("fixed")
        && !classes.contains("sticky")
    {
        classes = format!("relative {classes}").trim().to_string();
    }

    let my_layout = match &node.kind {
        NodeKind::Frame { layout } => layout.as_ref(),
        _ => None,
    };

    if let Some(c) = comment {
        out.push_str(&format!("{ind}{{/* {c} */}}\n"));
    }
    out.push_str(&tw_open(tag, &classes, depth, false));
    if let NodeKind::Text { text } = &node.kind {
        out.push_str(&format!("{}{}\n", indent_str(depth + 1), quote(text)));
    }
    for child in &node.children {
        emit_tw(child, my_layout, depth + 1, out);
    }
    out.push_str(&format!("{ind}</{tag}>\n"));
}

#[cfg(test)]
mod tailwind_tests {
    use super::*;
    use x_core::{AutoLayout, Color, LayoutDirection, Node, Sizing, TextMetrics};

    #[test]
    fn rect_maps_to_arbitrary_value_classes() {
        let r = Node::rect(
            "r1",
            40.0,
            300.0,
            120.0,
            44.0,
            Color::from_rgb8(0xEE, 0x55, 0x55),
        );
        let code = node_to_tailwind(&r);
        assert!(
            code.contains(
                "className=\"absolute left-[40px] top-[300px] w-[120px] h-[44px] bg-[#ee5555]\""
            ),
            "\n{code}"
        );
    }

    #[test]
    fn flex_frame_flows_children() {
        let mut f = Node::frame("f", 200.0, 100.0);
        f.kind = NodeKind::Frame {
            layout: Some(AutoLayout {
                direction: LayoutDirection::Horizontal,
                gap: 10.0,
                padding: [12.0; 4],
                sizing: Sizing::Fixed,
                ..Default::default()
            }),
        };
        let mut t = Node::text("t", 0.0, 0.0, 80.0, 20.0, "Hi");
        t.text_metrics = Some(TextMetrics {
            font_size: 14.0,
            line_height: 20.0,
            ..Default::default()
        });
        f.children.push(t);
        let code = node_to_tailwind(&f);
        assert!(code.contains("flex"), "\n{code}");
        assert!(code.contains("gap-[10px]"), "\n{code}");
        assert!(code.contains("p-[12px]"), "\n{code}");
        let span = code.lines().find(|l| l.contains("<span")).unwrap_or("");
        assert!(span.contains("text-[14px]"), "span: {span}");
        assert!(span.contains("leading-[20px]"), "span: {span}");
        assert!(
            !span.contains("left-["),
            "flow child must not position: {span}"
        );
        // the parent frame is flex — it needs no extra relative
        let div = code.lines().find(|l| l.contains("<div")).unwrap_or("");
        assert!(!div.contains("relative"), "flex parent: {div}");
    }

    #[test]
    fn hidden_and_masks_skipped_too() {
        let mut a = Node::rect("a", 0.0, 0.0, 10.0, 10.0, Color::from_rgb8(0, 0, 0));
        a.visible = false;
        assert_eq!(node_to_tailwind(&a), "");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::{AutoLayout, Color, LayoutDirection, Node, Sizing};

    #[test]
    fn rect_is_absolute_div() {
        let r = Node::rect(
            "r1",
            40.0,
            300.0,
            120.0,
            44.0,
            Color::from_rgb8(0xEE, 0x55, 0x55),
        );
        let code = node_to_jsx(&r);
        let want = "  <div\n    style={{\n      position: 'absolute',\n      left: 40,\n      top: 300,\n      width: 120,\n      height: 44,\n      backgroundColor: '#ee5555',\n    }}\n  >\n  </div>\n";
        assert_eq!(code, want, "exact rect JSX");
    }

    #[test]
    fn auto_layout_frame_is_flex() {
        let mut f = Node::frame("f", 200.0, 100.0);
        f.transform.x = 10.0;
        f.transform.y = 20.0;
        f.corner_radii = Some([8.0; 4]);
        f.kind = NodeKind::Frame {
            layout: Some(AutoLayout {
                direction: LayoutDirection::Horizontal,
                gap: 10.0,
                padding: [12.0; 4],
                sizing: Sizing::Fixed,
                ..Default::default()
            }),
        };
        let mut t = Node::text("t", 0.0, 0.0, 80.0, 20.0, "Hi");
        t.text_metrics = Some(x_core::TextMetrics {
            font_size: 14.0,
            line_height: 20.0,
            ..Default::default()
        });
        f.children.push(t);
        let code = node_to_jsx(&f);
        assert!(code.contains("display: 'flex'"), "{code}");
        assert!(code.contains("flexDirection: 'row'"), "{code}");
        assert!(code.contains("gap: 10"), "{code}");
        assert!(code.contains("padding: 12"), "{code}");
        assert!(code.contains("borderRadius: 8"), "{code}");
        // the text child FLOWS: no position/left/top
        assert!(code.contains("<span"), "{code}");
        assert!(
            !code.contains("position: 'absolute',\n      left: 0"),
            "{code}"
        );
        assert!(code.contains("fontSize: 14"), "{code}");
        assert!(code.contains("lineHeight: 20px"), "{code}");
        assert!(code.contains("'Hi'"), "{code}");
    }

    #[test]
    fn fill_child_gets_flexgrow_and_loses_main_size() {
        let mut f = Node::frame("f", 200.0, 100.0);
        f.kind = NodeKind::Frame {
            layout: Some(AutoLayout {
                direction: LayoutDirection::Horizontal,
                ..Default::default()
            }),
        };
        let mut c = Node::rect("c", 0.0, 0.0, 60.0, 30.0, Color::from_rgb8(1, 2, 3));
        c.constraints.grow = 1.0;
        f.children.push(c);
        let code = node_to_jsx(&f);
        assert!(code.contains("flexGrow: 1"), "{code}");
        // main axis (row) size dropped, cross size kept
        assert!(code.contains("height: 30"), "{code}");
        assert!(!code.contains("width: 60"), "{code}");
    }

    #[test]
    fn instance_is_component_ref() {
        let i = Node::instance("b1", "my badge", 96.0, 12.0, 40.0, 24.0);
        let code = node_to_jsx(&i);
        assert!(code.starts_with("  <MyBadge\n"), "{code}");
        assert!(code.contains("left: 96"), "{code}");
        assert!(code.trim_end().ends_with("/>"), "{code}");
    }

    #[test]
    fn hidden_and_masks_are_skipped_fragment_wraps_selection() {
        let mut a = Node::rect("a", 0.0, 0.0, 10.0, 10.0, Color::from_rgb8(0, 0, 0));
        a.visible = false;
        let mut m = Node::rect("m", 0.0, 0.0, 10.0, 10.0, Color::from_rgb8(0, 0, 0));
        m.is_mask = true;
        let b = Node::rect("b", 5.0, 5.0, 20.0, 20.0, Color::from_rgb8(1, 1, 1));
        assert_eq!(node_to_jsx(&a), "");
        assert_eq!(node_to_jsx(&m), "");
        let frag = selection_to_jsx([&b, &b]);
        assert!(frag.starts_with("<>\n"), "{frag}");
        assert!(frag.trim_end().ends_with("</>"), "{frag}");
        // single node: NO fragment
        assert!(!node_to_jsx(&b).starts_with("<>"));
    }

    #[test]
    fn stroke_opacity_and_gradient() {
        let mut r = Node::rect("r", 0.0, 0.0, 50.0, 50.0, Color::from_rgb8(9, 9, 9));
        r.opacity = 0.5;
        r.stroke.width = 1.5;
        r.stroke.paint = Paint::Solid(Color::from_rgb8(0xFF, 0, 0));
        r.fill = Paint::LinearGradient {
            start: (0.0, 0.0),
            end: (1.0, 0.0),
            stops: vec![
                (0.0, Color::from_rgb8(0, 0, 0)),
                (1.0, Color::from_rgb8(255, 255, 255)),
            ],
            space: x_core::GradSpace::Srgb,
        };
        let code = node_to_jsx(&r);
        assert!(code.contains("opacity: 0.5"), "{code}");
        assert!(code.contains("border: 1.5px solid '#ff0000'"), "{code}");
        // 0deg -> 90deg vector + 90 (CSS to-top)
        assert!(
            code.contains("linear-gradient(90deg, #000000 0%, #ffffff 100%)"),
            "{code}"
        );
    }

    #[test]
    fn image_and_vector_shapes() {
        let mut im = Node::frame("im", 100.0, 80.0);
        im.kind = NodeKind::Image {
            asset: "a1".into(),
            fit: ImageFit::Crop,
            placement: Default::default(),
        };
        let code = node_to_jsx(&im);
        assert!(code.contains("<img"), "{code}");
        assert!(code.contains("src='asset://a1'"), "{code}");
        assert!(code.contains("objectFit: 'cover'"), "{code}");
        let mut v = Node::frame("v", 30.0, 30.0);
        v.kind = NodeKind::Vector { path: vec![] };
        let code = node_to_jsx(&v);
        assert!(code.contains("<svg width={30} height={30}"), "{code}");
    }
}
