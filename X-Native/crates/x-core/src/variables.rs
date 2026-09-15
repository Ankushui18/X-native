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

/// Parses "#rrggbb" or "#rrggbbaa" into a Color.
pub fn parse_hex_color(s: &str) -> Option<Color> {
    let s = s.strip_prefix('#').unwrap_or(s);
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
}
