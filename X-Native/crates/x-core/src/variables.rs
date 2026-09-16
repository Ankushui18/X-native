#[allow(unused_imports)]
use crate::*;
use kurbo::{Affine, Circle, Rect, RoundedRect, RoundedRectRadii, Shape};
use peniko::{Brush, Color, Fill, Gradient, Mix};
use std::collections::HashMap;

// ---------------------------------------------------------------- variables

/// Variables v2 (Phase 5.4): color/number/string/bool storage, aliases
/// (var -> var, cycle-limited), and color modes (e.g. "light"/"dark").
/// Lookup order for colors: alias chain -> active mode table -> base table.
#[derive(Debug, Default, Clone)]
pub struct Variables {
    /// P1: collection name per variable ("Primitives", "Semantic", ...).
    /// Unlisted variables belong to the implicit "Local" collection.
    pub collections: HashMap<String, String>,
    /// Names of variables exposed to prototype viewers (Figma "exposed
    /// variables"): present mode shows an input chip so a viewer can set
    /// the value, which then drives conditional logic. Sorted set — the
    /// `.x` wire order is deterministic.
    pub exposed: std::collections::BTreeSet<String>,
    pub colors: HashMap<String, Color>,
    pub numbers: HashMap<String, f64>,
    pub strings: HashMap<String, String>,
    pub bools: HashMap<String, bool>,
    pub aliases: HashMap<String, String>,
    /// Color values per mode (Figma: variable modes, e.g. light/dark).
    pub modes: HashMap<String, HashMap<String, Color>>,
    /// Mode tables for non-color variables (numbers/strings/bools can be
    /// mode-driven too — Figma parity beyond the original color-only modes).
    pub num_modes: HashMap<String, HashMap<String, f64>>,
    pub str_modes: HashMap<String, HashMap<String, String>>,
    pub bool_modes: HashMap<String, HashMap<String, bool>>,
    pub active_mode: Option<String>,
}
const MAX_ALIAS_DEPTH: u32 = 8;
impl Variables {
    fn resolve_name<'a>(&'a self, name: &'a str) -> &'a str {
        let mut cur = name;
        for _ in 0..MAX_ALIAS_DEPTH {
            match self.aliases.get(cur) {
                Some(next) => cur = next,
                None => break,
            }
        }
        cur
    }
    pub fn color(&self, name: &str, fallback: Color) -> Color {
        let name = self.resolve_name(name);
        if let Some(mode) = &self.active_mode {
            if let Some(table) = self.modes.get(mode) {
                if let Some(c) = table.get(name) {
                    return *c;
                }
            }
        }
        self.colors.get(name).copied().unwrap_or(fallback)
    }
    pub fn number(&self, name: &str, fallback: f64) -> f64 {
        let name = self.resolve_name(name);
        if let Some(mode) = &self.active_mode {
            if let Some(v) = self.num_modes.get(mode).and_then(|t| t.get(name)) {
                return *v;
            }
        }
        self.numbers.get(name).copied().unwrap_or(fallback)
    }
    pub fn string(&self, name: &str, fallback: &str) -> String {
        let name = self.resolve_name(name);
        if let Some(mode) = &self.active_mode {
            if let Some(v) = self.str_modes.get(mode).and_then(|t| t.get(name)) {
                return v.clone();
            }
        }
        self.strings
            .get(name)
            .cloned()
            .unwrap_or_else(|| fallback.to_string())
    }
    pub fn boolean(&self, name: &str, fallback: bool) -> bool {
        let name = self.resolve_name(name);
        if let Some(mode) = &self.active_mode {
            if let Some(v) = self.bool_modes.get(mode).and_then(|t| t.get(name)) {
                return *v;
            }
        }
        self.bools.get(name).copied().unwrap_or(fallback)
    }

    /// Read a variable as a typed [`Value`] (prototype logic's operand).
    /// Aliases resolve first; the active mode wins over the base table.
    pub fn get(&self, name: &str) -> Option<crate::Value> {
        let name = self.resolve_name(name);
        if let Some(mode) = &self.active_mode {
            if let Some(c) = self.modes.get(mode).and_then(|t| t.get(name)) {
                return Some(crate::Value::Str(color_to_hex(*c)));
            }
            if let Some(v) = self.num_modes.get(mode).and_then(|t| t.get(name)) {
                return Some(crate::Value::Num(*v));
            }
            if let Some(v) = self.str_modes.get(mode).and_then(|t| t.get(name)) {
                return Some(crate::Value::Str(v.clone()));
            }
            if let Some(v) = self.bool_modes.get(mode).and_then(|t| t.get(name)) {
                return Some(crate::Value::Bool(*v));
            }
        }
        if let Some(c) = self.colors.get(name) {
            return Some(crate::Value::Str(color_to_hex(*c)));
        }
        if let Some(v) = self.numbers.get(name) {
            return Some(crate::Value::Num(*v));
        }
        if let Some(v) = self.strings.get(name) {
            return Some(crate::Value::Str(v.clone()));
        }
        if let Some(v) = self.bools.get(name) {
            return Some(crate::Value::Bool(*v));
        }
        None
    }

    /// Write a variable (prototype logic's `SetVar`). Colors are written as
    /// hex strings into the string table — the designer UI edits colors as
    /// hex bindings, so that keeps one source of truth.
    pub fn set(&mut self, name: &str, value: crate::Value) {
        let name = self.resolve_name(name).to_string();
        match value {
            crate::Value::Num(n) => {
                self.numbers.insert(name, n);
            }
            crate::Value::Str(s) => {
                self.strings.insert(name, s);
            }
            crate::Value::Bool(b) => {
                self.bools.insert(name, b);
            }
        }
    }

    /// Switch the active mode (prototype `SetMode`). Unknown modes are
    /// ignored — the lookup functions fall back to base tables.
    pub fn set_mode(&mut self, mode: &str) {
        if self.modes.contains_key(mode)
            || self.num_modes.contains_key(mode)
            || self.str_modes.contains_key(mode)
            || self.bool_modes.contains_key(mode)
        {
            self.active_mode = Some(mode.to_string());
        }
    }

    pub fn collection_of(&self, name: &str) -> &str {
        self.collections
            .get(name)
            .map(String::as_str)
            .unwrap_or("Local")
    }
    /// All (collection, name, kind) triples, sorted, for the variables UI.
    pub fn catalog(&self) -> Vec<(String, String, &'static str)> {
        let mut out = vec![];
        for k in self.colors.keys() {
            out.push((self.collection_of(k).to_string(), k.clone(), "color"));
        }
        for k in self.numbers.keys() {
            out.push((self.collection_of(k).to_string(), k.clone(), "number"));
        }
        for k in self.strings.keys() {
            out.push((self.collection_of(k).to_string(), k.clone(), "string"));
        }
        for k in self.bools.keys() {
            out.push((self.collection_of(k).to_string(), k.clone(), "bool"));
        }
        out.sort();
        out
    }
    pub fn mode_names(&self) -> Vec<String> {
        let mut v: Vec<String> = self.modes.keys().cloned().collect();
        v.sort();
        v
    }
}

pub fn paint_color(p: &Paint, vars: &Variables) -> Color {
    match p {
        Paint::Solid(c) => *c,
        Paint::Variable(n) => vars.color(n, Color::BLACK),
        Paint::LinearGradient { stops, .. }
        | Paint::RadialGradient { stops, .. }
        | Paint::AngularGradient { stops, .. }
        | Paint::DiamondGradient { stops, .. } => {
            stops.first().map(|s| s.1).unwrap_or(Color::BLACK)
        }
        // patterns have no single color; callers needing a flat fallback
        // (dev-mode swatches, stroke/text fallbacks) see a neutral gray
        Paint::Pattern { .. } => Color::from_rgb8(0x99, 0x99, 0x99),
    }
}

pub fn paint_brush(p: &Paint, vars: &Variables) -> Brush {
    match p {
        Paint::Solid(c) => Brush::Solid(*c),
        Paint::Variable(n) => Brush::Solid(vars.color(n, Color::BLACK)),
        Paint::LinearGradient {
            start,
            end,
            stops,
            space,
        } => Brush::Gradient(
            Gradient::new_linear((start.0, start.1), (end.0, end.1))
                .with_stops(space.stops_for_render(stops).as_ref()),
        ),
        Paint::RadialGradient {
            center,
            radius,
            stops,
            space,
        } => Brush::Gradient(
            Gradient::new_radial((center.0, center.1), *radius as f32)
                .with_stops(space.stops_for_render(stops).as_ref()),
        ),
        // Angular == peniko's sweep gradient (angles are radians there, our
        // model stores degrees). The accurate path is the mesh tessellation
        // in `x-render/src/gradients.rs`; this brush is what every non-mesh
        // consumer (swatches, thumbnails, PDF/SVG fallbacks) sees.
        Paint::AngularGradient {
            center,
            start_angle,
            end_angle,
            stops,
            space,
        } => Brush::Gradient(
            Gradient::new_sweep(
                (center.0, center.1),
                start_angle.to_radians() as f32,
                end_angle.to_radians() as f32,
            )
            .with_stops(space.stops_for_render(stops).as_ref()),
        ),
        // A diamond has no peniko primitive: approximate with the radial
        // gradient at the larger of the two radii (documented lossy — the
        // mesh path renders the true diamond).
        Paint::DiamondGradient {
            center,
            width,
            height,
            stops,
            space,
        } => Brush::Gradient(
            Gradient::new_radial((center.0, center.1), width.max(*height) as f32)
                .with_stops(space.stops_for_render(stops).as_ref()),
        ),
        // patterns are not a flat brush: fills render via clip + tiled
        // image in the IR. This arm is the fallback for contexts that
        // can't clip (swatches, thumbnails) — a neutral gray stands in.
        Paint::Pattern { .. } => Brush::Solid(paint_color(p, vars)),
    }
}

/// Parses CSS hexadecimal colors. Both the SVG short forms (`#rgb`,
/// `#rgba`) and the six/eight digit forms are accepted. The returned color
/// keeps CSS's unpremultiplied sRGB meaning by entering through
/// `Color::from_rgba8`.
pub fn parse_hex_color(s: &str) -> Option<Color> {
    let s = s.trim().strip_prefix('#').unwrap_or(s.trim());
    let expanded = match s.len() {
        3 | 4 => s.chars().flat_map(|c| [c, c]).collect::<String>(),
        _ => s.to_string(),
    };
    let s = expanded.as_str();
    let (r, g, b, a) = match s.len() {
        6 => (
            u8::from_str_radix(&s[0..2], 16).ok()?,
            u8::from_str_radix(&s[2..4], 16).ok()?,
            u8::from_str_radix(&s[4..6], 16).ok()?,
            255u8,
        ),
        8 => (
            u8::from_str_radix(&s[0..2], 16).ok()?,
            u8::from_str_radix(&s[2..4], 16).ok()?,
            u8::from_str_radix(&s[4..6], 16).ok()?,
            u8::from_str_radix(&s[6..8], 16).ok()?,
        ),
        _ => return None,
    };
    Some(Color::from_rgba8(r, g, b, a))
}

/// Parse the CSS Color 3/4 forms used by SVG and design-tool exports:
/// named colors, hex colors, `rgb()/rgba()` and `hsl()/hsla()`. CSS color
/// components are sRGB values, so this function deliberately converts via
/// the byte constructor rather than assigning renderer-space components.
/// Unsupported color functions return `None` instead of silently becoming
/// black; callers can then apply the correct inherited/default paint.
pub fn parse_css_color(value: &str) -> Option<Color> {
    let raw = value.trim();
    if raw.eq_ignore_ascii_case("none") || raw.eq_ignore_ascii_case("transparent") {
        return Some(Color::TRANSPARENT);
    }
    if raw.starts_with('#') {
        return parse_hex_color(raw);
    }
    let lower = raw.to_ascii_lowercase();
    if let Some(hex) = css_named_color(&lower) {
        return parse_hex_color(hex);
    }
    let (kind, body) = if let Some(body) = lower.strip_prefix("rgba(") {
        ("rgba", body.strip_suffix(')')?)
    } else if let Some(body) = lower.strip_prefix("rgb(") {
        ("rgb", body.strip_suffix(')')?)
    } else if let Some(body) = lower.strip_prefix("hsla(") {
        ("hsla", body.strip_suffix(')')?)
    } else if let Some(body) = lower.strip_prefix("hsl(") {
        ("hsl", body.strip_suffix(')')?)
    } else {
        return None;
    };
    let tokens = css_function_tokens(body);
    if kind == "rgb" || kind == "rgba" {
        let (channels, alpha) = css_channels_and_alpha(&tokens, kind == "rgba")?;
        let rgb = [
            css_rgb_channel(channels[0])?,
            css_rgb_channel(channels[1])?,
            css_rgb_channel(channels[2])?,
        ];
        return Some(Color::from_rgba8(
            rgb[0],
            rgb[1],
            rgb[2],
            css_alpha(alpha.unwrap_or("1"))?,
        ));
    }

    let (channels, alpha) = css_channels_and_alpha(&tokens, kind == "hsla")?;
    let hue = css_hue(channels[0])?;
    let saturation = css_percentage(channels[1])?;
    let lightness = css_percentage(channels[2])?;
    let (r, g, b) = hsl_to_srgb(hue, saturation, lightness);
    Some(Color::from_rgba8(r, g, b, css_alpha(alpha.unwrap_or("1"))?))
}

fn css_function_tokens(body: &str) -> Vec<&str> {
    // CSS Color 4 permits commas or whitespace, with `/` separating alpha.
    // Keeping the slash as its own token makes both syntaxes equivalent.
    body.replace(',', " ")
        .replace('/', " / ")
        .split_whitespace()
        .collect()
}

fn css_channels_and_alpha<'a>(
    tokens: &'a [&'a str],
    rgba: bool,
) -> Option<([&'a str; 3], Option<&'a str>)> {
    let slash = tokens.iter().position(|token| *token == "/");
    let (color_tokens, slash_alpha, positional_alpha) = match slash {
        Some(i) => (&tokens[..i], tokens.get(i + 1).copied(), None),
        None if rgba => (&tokens[..tokens.len().min(3)], None, tokens.get(3).copied()),
        None => (tokens, None, None),
    };
    if color_tokens.len() != 3 {
        return None;
    }
    Some((
        [color_tokens[0], color_tokens[1], color_tokens[2]],
        slash_alpha.or(positional_alpha),
    ))
}

fn css_rgb_channel(token: &str) -> Option<u8> {
    let value = token
        .strip_suffix('%')
        .map(|v| v.parse::<f64>().ok().map(|n| n * 2.55))
        .unwrap_or_else(|| token.parse::<f64>().ok());
    Some(value?.clamp(0.0, 255.0).round() as u8)
}

fn css_alpha(token: &str) -> Option<u8> {
    let value = if let Some(percent) = token.strip_suffix('%') {
        percent.parse::<f64>().ok()? / 100.0
    } else {
        token.parse::<f64>().ok()?.clamp(0.0, 1.0)
    };
    Some((value.clamp(0.0, 1.0) * 255.0).round() as u8)
}

fn css_percentage(token: &str) -> Option<f64> {
    let value = token.strip_suffix('%')?.parse::<f64>().ok()? / 100.0;
    Some(value.clamp(0.0, 1.0))
}

fn css_hue(token: &str) -> Option<f64> {
    let (number, scale) = if let Some(value) = token.strip_suffix("deg") {
        (value, 1.0)
    } else if let Some(value) = token.strip_suffix("turn") {
        (value, 360.0)
    } else if let Some(value) = token.strip_suffix("grad") {
        (value, 0.9)
    } else if let Some(value) = token.strip_suffix("rad") {
        (value, 180.0 / std::f64::consts::PI)
    } else {
        (token, 1.0)
    };
    Some(
        number
            .parse::<f64>()
            .ok()?
            .mul_add(scale, 0.0)
            .rem_euclid(360.0),
    )
}

fn hsl_to_srgb(hue: f64, saturation: f64, lightness: f64) -> (u8, u8, u8) {
    let chroma = (1.0 - (2.0 * lightness - 1.0).abs()) * saturation;
    let x = chroma * (1.0 - (((hue / 60.0) % 2.0) - 1.0).abs());
    let m = lightness - chroma / 2.0;
    let (r, g, b) = match hue {
        h if h < 60.0 => (chroma, x, 0.0),
        h if h < 120.0 => (x, chroma, 0.0),
        h if h < 180.0 => (0.0, chroma, x),
        h if h < 240.0 => (0.0, x, chroma),
        h if h < 300.0 => (x, 0.0, chroma),
        _ => (chroma, 0.0, x),
    };
    (
        ((r + m).clamp(0.0, 1.0) * 255.0).round() as u8,
        ((g + m).clamp(0.0, 1.0) * 255.0).round() as u8,
        ((b + m).clamp(0.0, 1.0) * 255.0).round() as u8,
    )
}

fn css_named_color(name: &str) -> Option<&'static str> {
    // CSS named colors are sRGB hex values. Keep this table local to the
    // parser so importers do not have to invent subtly different palettes.
    match name {
        "aliceblue" => Some("#f0f8ff"),
        "antiquewhite" => Some("#faebd7"),
        "aqua" | "cyan" => Some("#00ffff"),
        "aquamarine" => Some("#7fffd4"),
        "azure" => Some("#f0ffff"),
        "beige" => Some("#f5f5dc"),
        "bisque" => Some("#ffe4c4"),
        "black" => Some("#000000"),
        "blanchedalmond" => Some("#ffebcd"),
        "blue" => Some("#0000ff"),
        "blueviolet" => Some("#8a2be2"),
        "brown" => Some("#a52a2a"),
        "burlywood" => Some("#deb887"),
        "cadetblue" => Some("#5f9ea0"),
        "chartreuse" => Some("#7fff00"),
        "chocolate" => Some("#d2691e"),
        "coral" => Some("#ff7f50"),
        "cornflowerblue" => Some("#6495ed"),
        "cornsilk" => Some("#fff8dc"),
        "crimson" => Some("#dc143c"),
        "darkblue" => Some("#00008b"),
        "darkcyan" => Some("#008b8b"),
        "darkgoldenrod" => Some("#b8860b"),
        "darkgray" | "darkgrey" => Some("#a9a9a9"),
        "darkgreen" => Some("#006400"),
        "darkkhaki" => Some("#bdb76b"),
        "darkmagenta" => Some("#8b008b"),
        "darkolivegreen" => Some("#556b2f"),
        "darkorange" => Some("#ff8c00"),
        "darkorchid" => Some("#9932cc"),
        "darkred" => Some("#8b0000"),
        "darksalmon" => Some("#e9967a"),
        "darkseagreen" => Some("#8fbc8f"),
        "darkslateblue" => Some("#483d8b"),
        "darkslategray" | "darkslategrey" => Some("#2f4f4f"),
        "darkturquoise" => Some("#00ced1"),
        "darkviolet" => Some("#9400d3"),
        "deeppink" => Some("#ff1493"),
        "deepskyblue" => Some("#00bfff"),
        "dimgray" | "dimgrey" => Some("#696969"),
        "dodgerblue" => Some("#1e90ff"),
        "firebrick" => Some("#b22222"),
        "floralwhite" => Some("#fffaf0"),
        "forestgreen" => Some("#228b22"),
        "fuchsia" | "magenta" => Some("#ff00ff"),
        "gainsboro" => Some("#dcdcdc"),
        "ghostwhite" => Some("#f8f8ff"),
        "gold" => Some("#ffd700"),
        "goldenrod" => Some("#daa520"),
        "gray" | "grey" => Some("#808080"),
        "green" => Some("#008000"),
        "greenyellow" => Some("#adff2f"),
        "honeydew" => Some("#f0fff0"),
        "hotpink" => Some("#ff69b4"),
        "indianred" => Some("#cd5c5c"),
        "indigo" => Some("#4b0082"),
        "ivory" => Some("#fffff0"),
        "khaki" => Some("#f0e68c"),
        "lavender" => Some("#e6e6fa"),
        "lavenderblush" => Some("#fff0f5"),
        "lawngreen" => Some("#7cfc00"),
        "lemonchiffon" => Some("#fffacd"),
        "lightblue" => Some("#add8e6"),
        "lightcoral" => Some("#f08080"),
        "lightcyan" => Some("#e0ffff"),
        "lightgoldenrodyellow" => Some("#fafad2"),
        "lightgray" | "lightgrey" => Some("#d3d3d3"),
        "lightgreen" => Some("#90ee90"),
        "lightpink" => Some("#ffb6c1"),
        "lightsalmon" => Some("#ffa07a"),
        "lightseagreen" => Some("#20b2aa"),
        "lightskyblue" => Some("#87cefa"),
        "lightslategray" | "lightslategrey" => Some("#778899"),
        "lightsteelblue" => Some("#b0c4de"),
        "lightyellow" => Some("#ffffe0"),
        "lime" => Some("#00ff00"),
        "limegreen" => Some("#32cd32"),
        "linen" => Some("#faf0e6"),
        "maroon" => Some("#800000"),
        "mediumaquamarine" => Some("#66cdaa"),
        "mediumblue" => Some("#0000cd"),
        "mediumorchid" => Some("#ba55d3"),
        "mediumpurple" => Some("#9370db"),
        "mediumseagreen" => Some("#3cb371"),
        "mediumslateblue" => Some("#7b68ee"),
        "mediumspringgreen" => Some("#00fa9a"),
        "mediumturquoise" => Some("#48d1cc"),
        "mediumvioletred" => Some("#c71585"),
        "midnightblue" => Some("#191970"),
        "mintcream" => Some("#f5fffa"),
        "mistyrose" => Some("#ffe4e1"),
        "moccasin" => Some("#ffe4b5"),
        "navajowhite" => Some("#ffdead"),
        "navy" => Some("#000080"),
        "oldlace" => Some("#fdf5e6"),
        "olive" => Some("#808000"),
        "olivedrab" => Some("#6b8e23"),
        "orange" => Some("#ffa500"),
        "orangered" => Some("#ff4500"),
        "orchid" => Some("#da70d6"),
        "palegoldenrod" => Some("#eee8aa"),
        "palegreen" => Some("#98fb98"),
        "paleturquoise" => Some("#afeeee"),
        "palevioletred" => Some("#db7093"),
        "papayawhip" => Some("#ffefd5"),
        "peachpuff" => Some("#ffdab9"),
        "peru" => Some("#cd853f"),
        "pink" => Some("#ffc0cb"),
        "plum" => Some("#dda0dd"),
        "powderblue" => Some("#b0e0e6"),
        "purple" => Some("#800080"),
        "rebeccapurple" => Some("#663399"),
        "red" => Some("#ff0000"),
        "rosybrown" => Some("#bc8f8f"),
        "royalblue" => Some("#4169e1"),
        "saddlebrown" => Some("#8b4513"),
        "salmon" => Some("#fa8072"),
        "sandybrown" => Some("#f4a460"),
        "seagreen" => Some("#2e8b57"),
        "seashell" => Some("#fff5ee"),
        "sienna" => Some("#a0522d"),
        "silver" => Some("#c0c0c0"),
        "skyblue" => Some("#87ceeb"),
        "slateblue" => Some("#6a5acd"),
        "slategray" | "slategrey" => Some("#708090"),
        "snow" => Some("#fffafa"),
        "springgreen" => Some("#00ff7f"),
        "steelblue" => Some("#4682b4"),
        "tan" => Some("#d2b48c"),
        "teal" => Some("#008080"),
        "thistle" => Some("#d8bfd8"),
        "tomato" => Some("#ff6347"),
        "turquoise" => Some("#40e0d0"),
        "violet" => Some("#ee82ee"),
        "wheat" => Some("#f5deb3"),
        "white" => Some("#ffffff"),
        "whitesmoke" => Some("#f5f5f5"),
        "yellow" => Some("#ffff00"),
        "yellowgreen" => Some("#9acd32"),
        _ => None,
    }
}
pub fn color_to_hex(c: Color) -> String {
    let rgba = c.to_rgba8();
    let (r, g, b, a) = (rgba.r, rgba.g, rgba.b, rgba.a);
    if a == 255 {
        format!("#{r:02x}{g:02x}{b:02x}")
    } else {
        format!("#{r:02x}{g:02x}{b:02x}{a:02x}")
    }
}

/// Typed instance overrides (Phase 5.3): an override value keyed by a node id
/// is either a hex color ("#12ab34") applied to that node's fill, or — new —
/// prefixed "text:" to replace a Text node's content.
pub fn effective_fill(node: &Node, overrides: &HashMap<String, String>, vars: &Variables) -> Color {
    if let Some(v) = overrides.get(&node.id) {
        if let Some(c) = parse_hex_color(v) {
            return c;
        }
    }
    paint_color(&node.fill, vars)
}
pub fn effective_brush(
    node: &Node,
    overrides: &HashMap<String, String>,
    vars: &Variables,
) -> Brush {
    if let Some(v) = overrides.get(&node.id) {
        if let Some(c) = parse_hex_color(v) {
            return Brush::Solid(c);
        }
    }
    paint_brush(&node.fill, vars)
}
pub fn effective_text<'a>(
    node: &'a Node,
    overrides: &'a HashMap<String, String>,
) -> Option<&'a str> {
    overrides
        .get(&node.id)
        .and_then(|v| v.strip_prefix("text:"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_modes_override_base_tables() {
        let mut v = Variables::default();
        v.numbers.insert("spacing".into(), 8.0);
        v.strings.insert("label".into(), "Hi".into());
        v.bools.insert("compact".into(), false);
        v.num_modes.insert(
            "dense".into(),
            [("spacing".to_string(), 4.0)].into_iter().collect(),
        );
        v.str_modes.insert(
            "dense".into(),
            [("label".to_string(), "H".to_string())]
                .into_iter()
                .collect(),
        );
        v.bool_modes.insert(
            "dense".into(),
            [("compact".to_string(), true)].into_iter().collect(),
        );

        assert_eq!(v.number("spacing", 0.0), 8.0);
        assert_eq!(v.string("label", ""), "Hi");
        assert!(!v.boolean("compact", false));

        v.set_mode("dense");
        assert_eq!(v.number("spacing", 0.0), 4.0);
        assert_eq!(v.string("label", ""), "H");
        assert!(v.boolean("compact", false));

        // get() is mode-aware too
        assert_eq!(v.get("spacing"), Some(crate::Value::Num(4.0)));
        assert_eq!(v.get("label"), Some(crate::Value::Str("H".into())));
        assert_eq!(v.get("compact"), Some(crate::Value::Bool(true)));

        // unknown mode is ignored by set_mode (falls back to base)
        v.set_mode("nope");
        assert_eq!(v.number("spacing", 0.0), 4.0);
    }

    #[test]
    fn set_and_get_roundtrip_all_types() {
        let mut v = Variables::default();
        v.set("n", crate::Value::Num(3.5));
        v.set("s", crate::Value::Str("hello".into()));
        v.set("b", crate::Value::Bool(true));
        assert_eq!(v.get("n"), Some(crate::Value::Num(3.5)));
        assert_eq!(v.get("s"), Some(crate::Value::Str("hello".into())));
        assert_eq!(v.get("b"), Some(crate::Value::Bool(true)));
        assert_eq!(v.get("missing"), None);

        // setting an alias writes through to the target name
        v.aliases.insert("alias".into(), "n".into());
        v.set("alias", crate::Value::Num(9.0));
        assert_eq!(v.get("n"), Some(crate::Value::Num(9.0)));
    }

    #[test]
    fn color_get_returns_hex_string() {
        let mut v = Variables::default();
        v.colors
            .insert("bg".into(), parse_hex_color("#102030").unwrap());
        assert_eq!(v.get("bg"), Some(crate::Value::Str("#102030".into())));
    }

    #[test]
    fn parses_css_hex_short_forms_and_alpha() {
        assert_eq!(
            parse_css_color("#abc").unwrap().to_rgba8(),
            Color::from_rgba8(170, 187, 204, 255).to_rgba8()
        );
        assert_eq!(
            parse_css_color("#abcd").unwrap().to_rgba8(),
            Color::from_rgba8(170, 187, 204, 221).to_rgba8()
        );
        assert_eq!(
            parse_css_color("rgba(10, 20, 30, 50%)").unwrap().to_rgba8(),
            Color::from_rgba8(10, 20, 30, 128).to_rgba8()
        );
        assert_eq!(
            parse_css_color("rgb(100% 0% 50% / .25)")
                .unwrap()
                .to_rgba8(),
            Color::from_rgba8(255, 0, 128, 64).to_rgba8()
        );
    }

    #[test]
    fn parses_css_named_and_hsl_colors() {
        assert_eq!(parse_css_color("CornflowerBlue").unwrap().to_rgba8().r, 100);
        assert_eq!(
            parse_css_color("hsl(0, 100%, 50%)").unwrap().to_rgba8(),
            Color::from_rgba8(255, 0, 0, 255).to_rgba8()
        );
        assert_eq!(parse_css_color("transparent").unwrap().to_rgba8().a, 0);
        assert!(parse_css_color("color(display-p3 1 0 0)").is_none());
    }
}
