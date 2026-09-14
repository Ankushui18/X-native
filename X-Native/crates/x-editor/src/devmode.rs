#[allow(unused_imports)]
use crate::*;
use x_core::kurbo::{Affine, Rect};
use x_core::peniko::Color;
use x_core::*;

// ------------------------------------------------------------------ dev mode

/// CSS gradient angle from a start/end direction vector (y-down), in degrees.
/// CSS `0deg` points up, `90deg` points right, clockwise.
fn css_gradient_angle(start: (f64, f64), end: (f64, f64)) -> f64 {
    let dx = end.0 - start.0;
    let dy = end.1 - start.1;
    dx.atan2(-dy).to_degrees().rem_euclid(360.0)
}

/// The text node's (font_size, letter_spacing, font_weight, italic) drawn from
/// a full-span override when one exists, else the node defaults. `font_size`
/// always falls back to the node's em height (`node.h`).
///
/// Letter-spacing resolves to the node's `ls` binding (the inspector's
/// per-node default) whenever a full-span override doesn't pin it — so a
/// multi-span run still exports its base tracking instead of dropping it.
fn text_style_of(node: &Node) -> (f64, Option<f64>, Option<u16>, Option<bool>) {
    let len = match &node.kind {
        NodeKind::Text { text } => text.chars().count(),
        _ => 0,
    };
    let node_ls = node.bindings.get("ls").and_then(|v| v.parse::<f64>().ok());
    match node.text_runs.iter().find(|r| r.start == 0 && r.len == len) {
        Some(r) => (
            r.size.unwrap_or(node.h),
            r.ls.or(node_ls),
            r.weight,
            r.italic,
        ),
        None => (node.h, node_ls, None, None),
    }
}

/// Phase 10.4: dev-mode export — CSS for a node (the inspect panel's copy).
pub fn node_to_css(node: &Node, vars: &Variables) -> String {
    let mut css = String::new();
    css.push_str(&format!(
        ".{} {{\n",
        node.id
            .replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "-")
    ));
    // dev-mode CSS assumes the absolute-layout context the editor renders in
    css.push_str("  position: absolute;\n");
    css.push_str(&format!(
        "  left: {}px;\n  top: {}px;\n",
        node.transform.x, node.transform.y
    ));
    css.push_str(&format!(
        "  width: {}px;\n  height: {}px;\n",
        node.w, node.h
    ));
    // Dev-Mode annotation (Figma: developer notes)
    if let Some(code) = node.bindings.get("code") {
        css.push_str(&format!("  /* code connect: {code} */\n"));
    }
    if let Some(note) = node.note() {
        css.push_str(&format!("  /* note: {} */\n", note));
    }
    // auto layout -> flex (Figma auto layout IS flexbox);
    // grid mode (Figma Grid) -> CSS grid
    if let NodeKind::Frame { layout: Some(al) } = &node.kind {
        if let Some(g) = &al.grid {
            css.push_str(&format!(
                "  display: grid;\n  grid-template-columns: {};\n",
                g.template_columns_css()
            ));
            let rows = g.template_rows_css();
            if rows.is_empty() {
                css.push_str("  grid-auto-rows: auto;\n");
            } else {
                css.push_str(&format!("  grid-template-rows: {rows};\n"));
            }
            if g.column_gap > 0.0 || g.row_gap > 0.0 {
                css.push_str(&format!("  gap: {}px {}px;\n", g.row_gap, g.column_gap));
            }
            if g.padding == [0.0; 4] {
                // no padding
            } else if g.padding[0] == g.padding[1]
                && g.padding[1] == g.padding[2]
                && g.padding[2] == g.padding[3]
            {
                css.push_str(&format!("  padding: {}px;\n", g.padding[0]));
            } else {
                css.push_str(&format!(
                    "  padding: {}px {}px {}px {}px;\n",
                    g.padding[2], g.padding[1], g.padding[3], g.padding[0]
                ));
            }
            // CSS grid-auto-flow: only emit when non-default (Row)
            if g.auto_flow != GridAutoFlow::Row {
                css.push_str(&format!("  grid-auto-flow: {};\n", g.auto_flow.css()));
            }
            // explicit grid placements, when any child carries one
            let placed: Vec<String> = node
                .children
                .iter()
                .filter(|c| c.constraints.grid_col.is_some() || c.constraints.grid_row.is_some())
                .map(|c| {
                    let mut parts = vec![];
                    if let Some(col) = c.constraints.grid_col {
                        parts.push(format!("grid-column: {}", col + 1));
                        if c.constraints.grid_col_span > 1 {
                            parts[0] = format!(
                                "grid-column: {} / span {}",
                                col + 1,
                                c.constraints.grid_col_span
                            );
                        }
                    }
                    if let Some(row) = c.constraints.grid_row {
                        if c.constraints.grid_row_span > 1 {
                            parts.push(format!(
                                "grid-row: {} / span {}",
                                row + 1,
                                c.constraints.grid_row_span
                            ));
                        } else {
                            parts.push(format!("grid-row: {}", row + 1));
                        }
                    }
                    format!("  /* {} */ {{ {} }}", c.id, parts.join("; "))
                })
                .collect();
            for p in placed {
                css.push_str(&p);
                css.push('\n');
            }
            return css; // grid replaces the flex block entirely
        }
    }
    if let NodeKind::Frame { layout: Some(al) } = &node.kind {
        css.push_str(&format!(
            "  display: flex;\n  flex-direction: {};\n",
            if al.direction == LayoutDirection::Horizontal {
                "row"
            } else {
                "column"
            }
        ));
        if al.gap > 0.0 {
            css.push_str(&format!("  gap: {}px;\n", al.gap));
        }
        if al.uniform_pad() {
            if al.padding[0] > 0.0 {
                css.push_str(&format!("  padding: {}px;\n", al.padding[0]));
            }
        } else {
            // padding array is [left, right, top, bottom]; CSS t r b l
            css.push_str(&format!(
                "  padding: {}px {}px {}px {}px;\n",
                al.padding[2], al.padding[1], al.padding[3], al.padding[0]
            ));
        }
        css.push_str(&format!(
            "  align-items: {};\n",
            match al.align {
                CrossAlign::Start => "flex-start",
                CrossAlign::Center => "center",
                CrossAlign::End => "flex-end",
                CrossAlign::Baseline => "baseline",
            }
        ));
        css.push_str(&format!("  justify-content: {};\n", al.distribute.css()));
        if al.wrap == AutoLayoutWrap::Wrap {
            css.push_str("  flex-wrap: wrap;\n");
        }
        if let Some(mw) = al.min_width {
            css.push_str(&format!("  min-width: {}px;\n", mw));
        }
        if let Some(mw) = al.max_width {
            css.push_str(&format!("  max-width: {}px;\n", mw));
        }
        if let Some(mh) = al.min_height {
            css.push_str(&format!("  min-height: {}px;\n", mh));
        }
        if let Some(mh) = al.max_height {
            css.push_str(&format!("  max-height: {}px;\n", mh));
        }
    }
    // resize pins (Sketch resizing constraints / Figma constraints), when
    // they differ from the left/top default — the inspect panel's hint
    if (node.pin.0, node.pin.1) != (HPin::Left, VPin::Top) {
        css.push_str(&format!(
            "  /* resize: pinned {} / {} */\n",
            pin_h_name(node.pin.0),
            pin_v_name(node.pin.1)
        ));
    }
    // a text node's fill is its text color, emitted in the text block below
    if !matches!(node.kind, NodeKind::Text { .. }) {
        match &node.fill {
            Paint::Solid(c) if c.components[3] > 0.0 => {
                css.push_str(&format!("  background: {};\n", x_core::color_to_hex(*c)))
            }
            Paint::Variable(n) => css.push_str(&format!(
                "  background: {}; /* var: {} */\n",
                x_core::color_to_hex(vars.color(n, Color::BLACK)),
                n
            )),
            Paint::LinearGradient {
                start, end, stops, ..
            } => {
                let s: Vec<String> = stops
                    .iter()
                    .map(|(t, c)| format!("{} {}%", x_core::color_to_hex(*c), t * 100.0))
                    .collect();
                css.push_str(&format!(
                    "  background: linear-gradient({:.1}deg, {});\n",
                    css_gradient_angle(*start, *end),
                    s.join(", ")
                ));
            }
            Paint::RadialGradient {
                center,
                radius,
                stops,
                ..
            } => {
                let s: Vec<String> = stops
                    .iter()
                    .map(|(t, c)| format!("{} {}%", x_core::color_to_hex(*c), t * 100.0))
                    .collect();
                css.push_str(&format!(
                    "  background: radial-gradient(circle {:.0}px at {:.0}px {:.0}px, {});\n",
                    radius,
                    center.0,
                    center.1,
                    s.join(", ")
                ));
            }
            Paint::Pattern { asset, .. } => {
                css.push_str(&format!(
                    "  background-image: url({asset}); /* image pattern */\n"
                ));
            }
            _ => {}
        }
    }
    if let NodeKind::Rect { radius } = node.kind {
        if let Some([tl, tr, br, bl]) = node.corner_radii {
            css.push_str(&format!("  border-radius: {tl}px {tr}px {br}px {bl}px;\n"));
        } else if radius > 0.0 {
            css.push_str(&format!("  border-radius: {radius}px;\n"));
        }
    }
    // CSS Flexbox parity (Figma Jul-2026): inside strokes → CSS `border`
    // (included in layout by default), outside/center strokes → CSS
    // `outline` (excluded from layout, like outline vs border in CSS).
    if node.stroke.width > 0.0 {
        let align = node
            .active_strokes()
            .first()
            .map(|l| l.options.align)
            .unwrap_or(StrokeAlign::Center);
        let css_prop = match align {
            StrokeAlign::Inside => "border",
            _ => "outline",
        };
        // Inside strokes participate in the border-box model
        if align == StrokeAlign::Inside {
            css.push_str("  box-sizing: border-box;\n");
        }
        match node.stroke.solid_color() {
            Some(c) if c.components[3] > 0.0 => css.push_str(&format!(
                "  {}: {}px solid {};\n",
                css_prop,
                node.stroke.width,
                x_core::color_to_hex(c)
            )),
            _ if node.stroke.solid_color().is_none() => css.push_str(&format!(
                "  {}: {}px solid; /* gradient stroke */\n",
                css_prop,
                node.stroke.width
            )),
            _ => {}
        }
    }
    if let NodeKind::Text { .. } = node.kind {
        // a text node's fill is its text color
        match &node.fill {
            Paint::Solid(c) if c.components[3] > 0.0 => {
                css.push_str(&format!("  color: {};\n", x_core::color_to_hex(*c)))
            }
            Paint::Variable(n) => css.push_str(&format!(
                "  color: {}; /* var: {} */\n",
                x_core::color_to_hex(vars.color(n, Color::BLACK)),
                n
            )),
            _ => {}
        }
        // h IS the font size; font/ls/lh ride the bindings (typography
        // bindings — the same source the render sinks honor). A full-text
        // run overrides size/ls and may carry weight/italic.
        let (size, ls, weight, italic) = text_style_of(node);
        css.push_str(&format!("  font-size: {}px;\n", size));
        let font = node
            .bindings
            .get("font")
            .cloned()
            .unwrap_or_else(|| "sans-serif".into());
        css.push_str(&format!("  font-family: \"{font}\";\n"));
        let lh = node
            .bindings
            .get("lh")
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(1.2);
        css.push_str(&format!("  line-height: {lh};\n"));
        if let Some(ls) = ls {
            css.push_str(&format!("  letter-spacing: {ls}px;\n"));
        }
        // paragraph wrap strategy (Figma Aug-2026 text wrap)
        if node.text_wrap() != x_core::TextWrap::Auto {
            css.push_str(&format!("  text-wrap: {};\n", node.text_wrap().to_str()));
        }
        if weight.unwrap_or(400) >= 600 {
            css.push_str("  font-weight: bold;\n");
        }
        if italic == Some(true) {
            css.push_str("  font-style: italic;\n");
        }
        // rich runs are per-character styling — CSS can't express them in
        // one rule, so surface the count as a hint instead of lying
        if !node.text_runs.is_empty() {
            css.push_str(&format!(
                "  /* {} rich text run(s): per-character styling */\n",
                node.text_runs.len()
            ));
        }
    }
    if node.opacity < 1.0 {
        css.push_str(&format!("  opacity: {};\n", node.opacity));
    }
    if node.blend != BlendKind::Normal {
        css.push_str(&format!(
            "  mix-blend-mode: {};\n",
            blend_css_name(node.blend)
        ));
    }
    // z_index: paint order within auto-layout frames (CSS z-index)
    if let Some(z) = node.z_index {
        css.push_str(&format!("  z-index: {};\n", z));
    }
    if node.transform.rotation != 0.0 {
        css.push_str(&format!(
            "  transform: rotate({:.1}deg);\n",
            node.transform.rotation.to_degrees()
        ));
    }
    // CSS Flexbox parity: inside strokes → border, outside/center → outline
    if node.stroke.width > 0.0 {
        let align = node
            .active_strokes()
            .first()
            .map(|l| l.options.align)
            .unwrap_or(StrokeAlign::Center);
        let css_prop = match align {
            StrokeAlign::Inside => "border",
            _ => "outline",
        };
        css.push_str(&format!(
            "  {}: {:.0}px solid {};\n",
            css_prop,
            node.stroke.width,
            x_core::color_to_hex(node.stroke.solid_color().unwrap_or(peniko::Color::BLACK))
        ));
    }
    let mut shadows: Vec<String> = vec![];
    for e in &node.effects {
        match e {
            x_core::Effect::DropShadow {
                dx,
                dy,
                blur,
                color,
            } => shadows.push(format!(
                "{dx}px {dy}px {blur}px {}",
                x_core::color_to_hex(*color)
            )),
            x_core::Effect::InnerShadow {
                dx,
                dy,
                blur,
                color,
            } => shadows.push(format!(
                "inset {dx}px {dy}px {blur}px {}",
                x_core::color_to_hex(*color)
            )),
            x_core::Effect::LayerBlur { radius } => {
                css.push_str(&format!("  filter: blur({radius}px);\n"))
            }
            x_core::Effect::BackgroundBlur { radius } => {
                css.push_str(&format!("  backdrop-filter: blur({radius}px);\n"))
            }
            x_core::Effect::Noise { .. } => {
                // Noise effect not supported in CSS export
            }
        }
    }
    if !shadows.is_empty() {
        css.push_str(&format!("  box-shadow: {};\n", shadows.join(", ")));
    }
    if let NodeKind::Image { asset, fit, .. } = &node.kind {
        css.push_str(&format!(
            "  background-image: url(\"{asset}\"); /* fit: {fit:?} */\n"
        ));
    }
    css.push_str("}\n");
    css
}

fn pin_h_name(p: HPin) -> &'static str {
    match p {
        HPin::Left => "left",
        HPin::Right => "right",
        HPin::CenterH => "center-h",
        HPin::StretchH => "stretch-h",
        HPin::ScaleH => "scale-h",
    }
}

fn pin_v_name(p: VPin) -> &'static str {
    match p {
        VPin::Top => "top",
        VPin::Bottom => "bottom",
        VPin::CenterV => "center-v",
        VPin::StretchV => "stretch-v",
        VPin::ScaleV => "scale-v",
    }
}

fn blend_css_name(b: BlendKind) -> &'static str {
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

/// Export the document's variables as W3C Design Tokens (DTCG format)
/// JSON. Variables are grouped into token groups by collection; aliases
/// use DTCG `{name}` references; per-mode values ride the
/// `com.x-native.modes` extension on each token.
/// XML-escape text content / attribute values.
fn xml_esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Android id from a node id: non-alphanumerics collapse to underscores.
fn xml_id(id: &str) -> String {
    let mut out = String::new();
    for c in id.chars() {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    out.trim_matches('_').to_string()
}

/// Android layout XML for a node (Dev Mode's fourth platform): View for
/// shapes, LinearLayout for auto-layout frames, TextView for text. Colors
/// are `#AARRGGBB`; gradients and blur surface as comments (they need
/// drawables/effects in Android, not one attribute).
pub fn node_to_xml(node: &Node, vars: &Variables) -> String {
    let mut s = String::new();
    if let Some(code) = node.bindings.get("code") {
        s.push_str(&format!("<!-- code connect: {} -->\n", xml_esc(code)));
    }
    if let Some(note) = node.note() {
        s.push_str(&format!("<!-- note: {} -->\n", xml_esc(note)));
    }
    let tag = match &node.kind {
        NodeKind::Text { .. } => "TextView",
        NodeKind::Frame {
            layout: Some(_), ..
        } => "LinearLayout",
        _ => "View",
    };
    s.push_str(&format!(
        "<{tag}\n    android:id=\"@+id/{}\"",
        xml_id(&node.id)
    ));
    s.push_str(&format!("\n    android:layout_width=\"{:.0}dp\"", node.w));
    s.push_str(&format!("\n    android:layout_height=\"{:.0}dp\"", node.h));
    if let NodeKind::Frame { layout: Some(al) } = &node.kind {
        let dir = match al.direction {
            LayoutDirection::Horizontal => "horizontal",
            _ => "vertical",
        };
        s.push_str(&format!("\n    android:orientation=\"{dir}\""));
        let gravity = match al.align {
            CrossAlign::Center => "center",
            CrossAlign::End => "end",
            _ => "start",
        };
        s.push_str(&format!("\n    android:gravity=\"{gravity}\""));
        let [pl, pr, pt, pb] = al.padding;
        if pl + pr + pt + pb > 0.0 {
            s.push_str(&format!(
                "\n    android:paddingStart=\"{pl:.0}dp\"\n    android:paddingEnd=\"{pr:.0}dp\"\n    android:paddingTop=\"{pt:.0}dp\"\n    android:paddingBottom=\"{pb:.0}dp\""
            ));
        }
        if al.gap > 0.0 {
            s.push_str(&format!(
                "\n    <!-- item gap {gap:.0}dp: set layout_margin on children -->",
                gap = al.gap
            ));
        }
    }
    match &node.fill {
        Paint::Solid(c) if c.components[3] > 0.0 => s.push_str(&format!(
            "\n    android:background=\"#{:02X}{:02X}{:02X}{:02X}\"",
            c.to_rgba8().a,
            c.to_rgba8().r,
            c.to_rgba8().g,
            c.to_rgba8().b
        )),
        Paint::Variable(n) => {
            let c = vars.color(n, Color::BLACK);
            s.push_str(&format!(
                "\n    android:background=\"#{:02X}{:02X}{:02X}{:02X}\" <!-- token: {n} -->",
                c.to_rgba8().a,
                c.to_rgba8().r,
                c.to_rgba8().g,
                c.to_rgba8().b
            ));
        }
        Paint::LinearGradient { .. } | Paint::RadialGradient { .. } => {
            s.push_str("\n    <!-- gradient fill: use a shape drawable -->");
        }
        _ => {}
    }
    if let NodeKind::Rect { radius } = node.kind {
        let r = node.corner_radii.map(|c| c[0]).unwrap_or(radius);
        if r > 0.0 {
            s.push_str(&format!(
                "\n    <!-- corner radius {r:.0}dp: shape drawable or MaterialCardView -->"
            ));
        }
    }
    if let NodeKind::Text { text } = &node.kind {
        let (size, ls, weight, italic) = text_style_of(node);
        s.push_str(&format!("\n    android:text=\"{}\"", xml_esc(text)));
        s.push_str(&format!("\n    android:textSize=\"{size:.0}sp\""));
        if let Some(ls) = ls {
            s.push_str(&format!(
                "\n    android:letterSpacing=\"{:.2}\"",
                ls / size.max(1.0)
            ));
        }
        let style = match (weight.unwrap_or(400) >= 600, italic.unwrap_or(false)) {
            (true, true) => "bold|italic",
            (true, false) => "bold",
            (false, true) => "italic",
            _ => "",
        };
        if !style.is_empty() {
            s.push_str(&format!("\n    android:textStyle=\"{style}\""));
        }
    }
    if (1.0 - node.opacity as f64).abs() > 0.001 {
        s.push_str(&format!("\n    android:alpha=\"{:.2}\"", node.opacity));
    }
    for e in &node.effects {
        match e {
            Effect::DropShadow { dy, blur, .. } => s.push_str(&format!(
                "\n    android:elevation=\"{:.0}dp\" <!-- shadow y {dy:.0} blur {blur:.0} -->",
                (dy + blur / 2.0).max(1.0)
            )),
            Effect::LayerBlur { radius } => s.push_str(&format!(
                "\n    <!-- layer blur {radius:.0}dp: RenderEffect -->
"
            )),
            _ => {}
        }
    }
    s.push_str(" />");
    s
}

pub fn export_tokens(doc: &Document) -> String {
    fn num_str(n: f64) -> String {
        if (n - n.trunc()).abs() < f64::EPSILON && n.abs() < 1e15 {
            format!("{}", n as i64)
        } else {
            format!("{n}")
        }
    }
    fn esc_json(s: &str) -> String {
        let mut out = String::new();
        for c in s.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out
    }
    // collection -> (name, type, value-json, modes)
    type TokenEntry = (String, String, String, Vec<(String, String)>);
    let mut groups: std::collections::BTreeMap<String, Vec<TokenEntry>> = Default::default();
    let vars = &doc.variables;
    for (name, c) in &vars.colors {
        let coll = vars.collection_of(name).to_string();
        let mut modes = vec![];
        for (mode, table) in &vars.modes {
            if let Some(v) = table.get(name) {
                modes.push((mode.clone(), x_core::color_to_hex(*v)));
            }
        }
        groups.entry(coll).or_default().push((
            name.clone(),
            "color".into(),
            format!("\"{}\"", x_core::color_to_hex(*c)),
            modes,
        ));
    }
    for (name, n) in &vars.numbers {
        let coll = vars.collection_of(name).to_string();
        let mut modes = vec![];
        for (mode, table) in &vars.num_modes {
            if let Some(v) = table.get(name) {
                modes.push((mode.clone(), num_str(*v)));
            }
        }
        groups
            .entry(coll)
            .or_default()
            .push((name.clone(), "number".into(), num_str(*n), modes));
    }
    for (name, sv) in &vars.strings {
        let coll = vars.collection_of(name).to_string();
        let mut modes = vec![];
        for (mode, table) in &vars.str_modes {
            if let Some(v) = table.get(name) {
                modes.push((mode.clone(), v.clone()));
            }
        }
        groups.entry(coll).or_default().push((
            name.clone(),
            "string".into(),
            format!("\"{}\"", esc_json(sv)),
            modes,
        ));
    }
    for (name, b) in &vars.bools {
        let coll = vars.collection_of(name).to_string();
        let mut modes = vec![];
        for (mode, table) in &vars.bool_modes {
            if let Some(v) = table.get(name) {
                modes.push((mode.clone(), v.to_string()));
            }
        }
        groups.entry(coll).or_default().push((
            name.clone(),
            "boolean".into(),
            b.to_string(),
            modes,
        ));
    }

    // The header carries no comma: a document with no variables must still
    // emit valid JSON, so each group prepends its own separator instead.
    let mut out = String::from("{\n  \"$schema\": \"https://tr.designtokens.org/format/\"");
    let coll_count = groups.len();
    for (ci, (coll, mut tokens)) in groups.into_iter().enumerate() {
        out.push_str(",\n");
        out.push_str(&format!("  \"{}\": {{\n", esc_json(&coll)));
        tokens.sort_by(|a, b| a.0.cmp(&b.0));
        for (ti, (name, ty, value, modes)) in tokens.iter().enumerate() {
            // DTCG alias syntax when this variable is an alias of another
            let value = vars
                .aliases
                .get(name)
                .map(|target| format!("\"{{{}}}\"", esc_json(target)))
                .unwrap_or_else(|| value.clone());
            out.push_str(&format!(
                "    \"{}\": {{\"$type\": \"{}\", \"$value\": {}",
                esc_json(name),
                ty,
                value
            ));
            if !modes.is_empty() {
                let m: Vec<String> = modes
                    .iter()
                    .map(|(mode, v)| format!("\"{}\": \"{}\"", esc_json(mode), esc_json(v)))
                    .collect();
                out.push_str(&format!(
                    ", \"$extensions\": {{\"com.x-native.modes\": {{{}}}}}",
                    m.join(", ")
                ));
            }
            let last = ti + 1 == tokens.len();
            out.push_str(if last { "}\n" } else { "},\n" });
        }
        let last_group = ci + 1 == coll_count;
        out.push_str(if last_group { "  }\n" } else { "  },\n" });
    }
    out.push_str("}\n");
    out
}

/// SwiftUI snippet for a node (the inspect panel's copy).
pub fn node_to_swift(node: &Node, vars: &Variables) -> String {
    let mut s = String::new();
    if let Some(code) = node.bindings.get("code") {
        s.push_str(&format!("// code connect: {code}\n"));
    }
    let radius = match node.kind {
        NodeKind::Rect { radius } => node.corner_radii.map(|c| c[0]).unwrap_or(radius),
        _ => 0.0,
    };
    let shape = if radius > 0.0 {
        format!("RoundedRectangle(cornerRadius: {radius:.0})")
    } else {
        "Rectangle()".to_string()
    };
    s.push_str(&format!("{shape}\n"));
    match &node.fill {
        Paint::Solid(c) if c.components[3] > 0.0 => s.push_str(&format!(
            "    .fill(Color(hex: 0x{:02X}{:02X}{:02X}))\n",
            (c.components[0] * 255.0) as u8,
            (c.components[1] * 255.0) as u8,
            (c.components[2] * 255.0) as u8
        )),
        Paint::Variable(n) => s.push_str(&format!(
            "    .fill(Color(hex: 0x{:02X}{:02X}{:02X})) // token: {n}\n",
            vars.color(n, Color::BLACK).to_rgba8().r,
            vars.color(n, Color::BLACK).to_rgba8().g,
            vars.color(n, Color::BLACK).to_rgba8().b
        )),
        Paint::LinearGradient {
            start, end, stops, ..
        } => {
            let stops: Vec<String> = stops
                .iter()
                .map(|(_, c)| {
                    format!(
                        "Color(hex: 0x{:02X}{:02X}{:02X})",
                        c.to_rgba8().r,
                        c.to_rgba8().g,
                        c.to_rgba8().b
                    )
                })
                .collect();
            let (sx, sy) = (start.0 / node.w.max(1.0), start.1 / node.h.max(1.0));
            let (ex, ey) = (end.0 / node.w.max(1.0), end.1 / node.h.max(1.0));
            s.push_str(&format!("    .fill(LinearGradient(colors: [{}], startPoint: UnitPoint(x: {sx:.2}, y: {sy:.2}), endPoint: UnitPoint(x: {ex:.2}, y: {ey:.2})))\n",
                stops.join(", ")));
        }
        Paint::RadialGradient {
            center,
            radius,
            stops,
            ..
        } => {
            let stops: Vec<String> = stops
                .iter()
                .map(|(_, c)| {
                    format!(
                        "Color(hex: 0x{:02X}{:02X}{:02X})",
                        c.to_rgba8().r,
                        c.to_rgba8().g,
                        c.to_rgba8().b
                    )
                })
                .collect();
            let (cx, cy) = (center.0 / node.w.max(1.0), center.1 / node.h.max(1.0));
            s.push_str(&format!("    .fill(RadialGradient(colors: [{}], center: UnitPoint(x: {cx:.2}, y: {cy:.2}), startRadius: 0, endRadius: {:.0}))\n",
                stops.join(", "), radius));
        }
        _ => {}
    }
    s.push_str(&format!(
        "    .frame(width: {:.0}, height: {:.0})\n",
        node.w, node.h
    ));
    if matches!(node.kind, NodeKind::Text { .. }) {
        let (size, ls, weight, italic) = text_style_of(node);
        s.push_str(&format!("    .font(.system(size: {:.0}))\n", size * 0.8));
        if let Some(ls) = ls {
            s.push_str(&format!("    .tracking({ls:.1})\n"));
        }
        if weight.unwrap_or(400) >= 600 {
            s.push_str("    .bold()\n");
        }
        if italic == Some(true) {
            s.push_str("    .italic()\n");
        }
    }
    if node.opacity < 1.0 {
        s.push_str(&format!("    .opacity({:.2})\n", node.opacity));
    }
    if node.stroke.width > 0.0 {
        s.push_str(&format!(
            "    .overlay({shape}.stroke(Color(hex: 0x{:02X}{:02X}{:02X}), lineWidth: {:.0}))\n",
            node.stroke
                .solid_color()
                .unwrap_or(Color::BLACK)
                .to_rgba8()
                .r,
            node.stroke
                .solid_color()
                .unwrap_or(Color::BLACK)
                .to_rgba8()
                .g,
            node.stroke
                .solid_color()
                .unwrap_or(Color::BLACK)
                .to_rgba8()
                .b,
            node.stroke.width
        ));
    }
    for e in &node.effects {
        if let x_core::Effect::DropShadow {
            dx,
            dy,
            blur,
            color,
        } = e
        {
            s.push_str(&format!("    .shadow(color: Color(hex: 0x{:02X}{:02X}{:02X}), radius: {:.0}, x: {dx:.0}, y: {dy:.0})\n",
                color.to_rgba8().r, color.to_rgba8().g, color.to_rgba8().b, blur / 2.0));
        }
    }
    s
}

/// Jetpack Compose (Kotlin) snippet for a node (the inspect panel's copy).
pub fn node_to_compose(node: &Node, vars: &Variables) -> String {
    let mut s = String::new();
    if let Some(code) = node.bindings.get("code") {
        s.push_str(&format!("// code connect: {code}\n"));
    }
    let radius = match node.kind {
        NodeKind::Rect { radius } => node.corner_radii.map(|c| c[0]).unwrap_or(radius),
        _ => 0.0,
    };
    let mut mods = String::new();
    mods.push_str(&format!(".size({:.0}.dp, {:.0}.dp)", node.w, node.h));
    if radius > 0.0 {
        mods.push_str(&format!(
            "\n        .clip(RoundedCornerShape({radius:.0}.dp))"
        ));
    }
    match &node.fill {
        Paint::Solid(c) if c.components[3] > 0.0 => mods.push_str(&format!(
            "\n        .background(Color(0x{:02X}{:02X}{:02X}{:02X}))",
            c.to_rgba8().r,
            c.to_rgba8().g,
            c.to_rgba8().b,
            c.to_rgba8().a
        )),
        Paint::Variable(n) => {
            let c = vars.color(n, Color::BLACK);
            mods.push_str(&format!(
                "\n        .background(Color(0x{:02X}{:02X}{:02X})) // token: {n}",
                c.to_rgba8().r,
                c.to_rgba8().g,
                c.to_rgba8().b
            ));
        }
        Paint::LinearGradient {
            start, end, stops, ..
        } => {
            let colors: Vec<String> = stops
                .iter()
                .map(|(_, c)| {
                    format!(
                        "Color(0x{:02X}{:02X}{:02X}{:02X})",
                        c.to_rgba8().r,
                        c.to_rgba8().g,
                        c.to_rgba8().b,
                        c.to_rgba8().a
                    )
                })
                .collect();
            mods.push_str(&format!("\n        .background(Brush.linearGradient(listOf({}), start = Offset({:.0}f, {:.0}f), end = Offset({:.0}f, {:.0}f)))",
                colors.join(", "), start.0, start.1, end.0, end.1));
        }
        Paint::RadialGradient {
            center,
            radius,
            stops,
            ..
        } => {
            let colors: Vec<String> = stops
                .iter()
                .map(|(_, c)| {
                    format!(
                        "Color(0x{:02X}{:02X}{:02X}{:02X})",
                        c.to_rgba8().r,
                        c.to_rgba8().g,
                        c.to_rgba8().b,
                        c.to_rgba8().a
                    )
                })
                .collect();
            mods.push_str(&format!("\n        .background(Brush.radialGradient(listOf({}), center = Offset({:.0}f, {:.0}f), radius = {:.0}f))",
                colors.join(", "), center.0, center.1, radius));
        }
        _ => {}
    }
    if matches!(node.kind, NodeKind::Text { .. }) {
        let (size, ls, weight, italic) = text_style_of(node);
        mods.push_str(&format!("\n        .fontSize({:.0}.sp)", size * 0.8));
        if let Some(ls) = ls {
            mods.push_str(&format!("\n        .letterSpacing({ls:.1}.sp)"));
        }
        if weight.unwrap_or(400) >= 600 {
            mods.push_str("\n        .fontWeight(FontWeight.Bold)");
        }
        if italic == Some(true) {
            mods.push_str("\n        .fontStyle(FontStyle.Italic)");
        }
    }
    if node.opacity < 1.0 {
        mods.push_str(&format!("\n        .alpha({:.2}f)", node.opacity));
    }
    s.push_str(&format!("Box(\n    Modifier\n        {mods}\n)"));
    for e in &node.effects {
        if let x_core::Effect::DropShadow {
            dx,
            dy,
            blur,
            color,
        } = e
        {
            s.push_str(&format!("\n    .shadow({blur:.0}.dp, spotColor = Color(0x{:02X}{:02X}{:02X}), ambientColor = Color(0x{:02X}{:02X}{:02X}))",
                color.to_rgba8().r, color.to_rgba8().g, color.to_rgba8().b, color.to_rgba8().r, color.to_rgba8().g, color.to_rgba8().b));
            let _ = (dx, dy);
        }
    }
    s
}

/// Token mapping for a node: which variables / styles drive its look. Returns
/// (kind, token) pairs in a stable order — the inspect panel's "Tokens" list.
pub fn node_tokens(node: &Node, vars: &Variables) -> Vec<(String, String)> {
    let mut out = vec![];
    // paint bound directly to a variable
    if let Paint::Variable(name) = &node.fill {
        out.push(("Fill".into(), name.clone()));
    }
    // per-property bindings (radius / opacity / fontsize / w / h)
    let mut keys: Vec<&String> = node.bindings.keys().collect();
    keys.sort();
    for k in keys {
        if let Some(v) = node.bindings.get(k) {
            let label = match k.as_str() {
                "radius" => "Corner radius",
                "opacity" => "Opacity",
                "fontsize" => "Font size",
                "w" => "Width",
                "h" => "Height",
                other => other,
            };
            out.push((label.into(), v.clone()));
        }
    }
    // named style bindings (Figma styles)
    for (key, label) in x_core::STYLE_BINDING_KEYS {
        if let Some(name) = node.bindings.get(key) {
            out.push((format!("{label} style"), name.clone()));
        }
    }
    // a solid fill that exactly matches a variable color -> "color token"
    if let Paint::Solid(c) = node.fill {
        if let Some((name, _)) = vars.colors.iter().find(|(_, vc)| **vc == c) {
            out.push(("Color".into(), name.clone()));
        }
    }
    out
}

/// Inspect-mode measurements: a node's size/position plus its distance to the
/// four edges of its parent (Figma's red "padding" lines).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Measurements {
    pub w: f64,
    pub h: f64,
    pub x: f64,
    pub y: f64,
    pub parent_w: f64,
    pub parent_h: f64,
    /// gaps to parent edges (left, right, top, bottom)
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
}

pub fn node_measurements(root: &Node, id: &str) -> Option<Measurements> {
    let node = find(root, id)?;
    let parent_id = crate::selection::parent_id(root, id)?;
    let parent = find(root, &parent_id)?;
    Some(Measurements {
        w: node.w,
        h: node.h,
        x: node.transform.x,
        y: node.transform.y,
        parent_w: parent.w,
        parent_h: parent.h,
        left: node.transform.x,
        right: parent.w - (node.transform.x + node.w),
        top: node.transform.y,
        bottom: parent.h - (node.transform.y + node.h),
    })
}

/// Gap between two nodes' world AABBs (Figma's hovered-node measurement).
/// Positive = separated by that many px on that axis; negative = overlap depth.
/// `nested` is populated when one AABB fully contains the other (a node inside
/// its frame) — Figma then shows edge-to-edge insets instead of a disjoint gap.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Gap {
    pub horizontal: f64,
    pub vertical: f64,
    pub nested: Option<NestedOffsets>,
}

/// Edge insets of the inner node relative to its container, when one node is
/// nested inside the other. `a_contains_b` = true when node `a` is the
/// container (b is the inner node); false when `b` contains `a`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NestedOffsets {
    pub a_contains_b: bool,
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
}

/// World-space AABB of a node (its local box carried through all ancestor
/// transforms, including rotation/skew).
fn world_bounds(root: &Node, id: &str) -> Option<Rect> {
    fn walk(n: &Node, parent: Affine, id: &str) -> Option<Rect> {
        let world = parent * n.transform.matrix(n.w, n.h);
        if n.id == id {
            return Some(x_core::bounds(world, n.w, n.h));
        }
        n.children.iter().find_map(|c| walk(c, world, id))
    }
    walk(root, Affine::IDENTITY, id)
}

pub fn node_gap(root: &Node, a: &str, b: &str) -> Option<Gap> {
    let ra = world_bounds(root, a)?;
    let rb = world_bounds(root, b)?;
    let horizontal = if ra.x1 <= rb.x0 {
        rb.x0 - ra.x1
    } else if rb.x1 <= ra.x0 {
        ra.x0 - rb.x1
    } else {
        -(ra.x1.min(rb.x1) - ra.x0.max(rb.x0))
    };
    let vertical = if ra.y1 <= rb.y0 {
        rb.y0 - ra.y1
    } else if rb.y1 <= ra.y0 {
        ra.y0 - rb.y1
    } else {
        -(ra.y1.min(rb.y1) - ra.y0.max(rb.y0))
    };
    // nested containment: one AABB fully inside the other -> edge insets
    let a_contains_b = rb.x0 >= ra.x0 && rb.x1 <= ra.x1 && rb.y0 >= ra.y0 && rb.y1 <= ra.y1;
    let b_contains_a = ra.x0 >= rb.x0 && ra.x1 <= rb.x1 && ra.y0 >= rb.y0 && ra.y1 <= rb.y1;
    let nested = if a_contains_b {
        Some(NestedOffsets {
            a_contains_b: true,
            left: rb.x0 - ra.x0,
            right: ra.x1 - rb.x1,
            top: rb.y0 - ra.y0,
            bottom: ra.y1 - rb.y1,
        })
    } else if b_contains_a {
        Some(NestedOffsets {
            a_contains_b: false,
            left: ra.x0 - rb.x0,
            right: rb.x1 - ra.x1,
            top: ra.y0 - rb.y0,
            bottom: rb.y1 - ra.y1,
        })
    } else {
        None
    };
    Some(Gap {
        horizontal,
        vertical,
        nested,
    })
}

/// One asset referenced by the selection (an image `asset://` id or a
/// component definition/reference), for the Inspect "Assets" browser.
#[derive(Debug, Clone, PartialEq)]
pub struct SelectionAsset {
    pub kind: &'static str, // "IMAGE" | "COMPONENT"
    pub name: String,
    pub usage: usize,
}

/// Collect images and components referenced by the selected subtrees.
pub fn selection_assets(root: &Node, ids: &[String]) -> Vec<SelectionAsset> {
    fn walk(n: &Node, comps: &mut Vec<String>) {
        match &n.kind {
            NodeKind::Component { name } | NodeKind::Instance { component: name } => {
                comps.push(name.clone())
            }
            _ => {}
        }
        for c in &n.children {
            walk(c, comps);
        }
    }

    let mut out: Vec<SelectionAsset> = vec![];
    let mut seen: std::collections::HashSet<String> = Default::default();
    for id in ids {
        let Some(n) = find(root, id) else { continue };
        // images (asset:// uris) referenced in this subtree
        let mut assets = std::collections::HashSet::new();
        x_core::collect_asset_ids(n, &mut assets);
        for asset in assets {
            let usage = x_core::asset_usage(n, &asset);
            if seen.insert(format!("img:{asset}")) {
                out.push(SelectionAsset {
                    kind: "IMAGE",
                    name: asset,
                    usage,
                });
            }
        }
        // component references / definitions
        let mut comps = vec![];
        walk(n, &mut comps);
        comps.sort();
        let mut i = 0;
        while i < comps.len() {
            let name = comps[i].clone();
            let usage = comps.iter().filter(|c| **c == name).count();
            if seen.insert(format!("cmp:{name}")) {
                out.push(SelectionAsset {
                    kind: "COMPONENT",
                    name,
                    usage,
                });
            }
            i += usage;
        }
    }
    out.sort_by(|a, b| (a.kind, &a.name).cmp(&(b.kind, &b.name)));
    out
}
