use crate::import_ir::{lower, ImportDoc, ImportKind, ImportNode};
#[allow(unused_imports)]
use crate::*;
use std::collections::HashMap;
use x_core::*;

// --------------------------------------------------------------- SVG import

/// Phase 7.4: import SVG into the native node tree. Handles the subset a
/// design tool actually round-trips: svg/g/rect/ellipse/circle/line/path/
/// text elements, fill/opacity/rx/transform=translate/rotate attributes,
/// nested groups, `<path d=...>` with M/L/C/Z (absolute and relative
/// m/l/c/z, H/V/h/v). Unknown elements/attributes are skipped, never fatal.
/// Maximum element nesting the parser will follow — the SVG analogue of
/// the JSON importer's MAX_JSON_DEPTH. A crafted file with ~200k nested
/// groups recursed parse_children to a stack overflow (SIGABRT); beyond
/// this cap we return a clean error instead.
const MAX_SVG_DEPTH: usize = 512;

pub fn import_svg(svg: &str) -> Result<Node, String> {
    // parse -> shared Import IR -> lower() (ONE set of import semantics
    // across svg/sketch/figma/png), then unwrap the single page.
    let mut lexer = XmlLexer {
        s: svg.as_bytes(),
        i: 0,
    };
    loop {
        match lexer.next_tag()? {
            XmlTag::Open(name, attrs) | XmlTag::SelfClose(name, attrs) if name == "svg" => {
                let w = attr_num(&attrs, "width").unwrap_or(800.0);
                let h = attr_num(&attrs, "height").unwrap_or(600.0);
                let mut root = ImportNode::new(ImportKind::Frame).id("svg-root").size(w, h);
                apply_transform_attr(&mut root, &attrs);
                let css_rules = parse_css_rules(svg);
                let root_style = SvgStyle::from_parent(
                    &SvgStyle::default(),
                    &attrs,
                    &HashMap::new(),
                    &css_rules,
                    "svg",
                );
                parse_children(&mut lexer, &mut root, root_style, css_rules)?;
                let doc = lower(ImportDoc {
                    source: "svg",
                    pages: vec![root],
                    ..Default::default()
                });
                return doc
                    .pages
                    .into_iter()
                    .next()
                    .ok_or_else(|| "empty svg".into());
            }
            XmlTag::Eof => return Err("no <svg> element found".into()),
            _ => {}
        }
    }
}

// `Text`'s payload is kept for the upcoming <text> import path; the
// current lexer emits it but the importer does not consume it yet.
#[allow(dead_code)]
enum XmlTag {
    Open(String, Vec<(String, String)>),
    SelfClose(String, Vec<(String, String)>),
    Close(String),
    Text(String),
    Eof,
}

struct XmlLexer<'a> {
    s: &'a [u8],
    i: usize,
}
impl<'a> XmlLexer<'a> {
    fn next_tag(&mut self) -> Result<XmlTag, String> {
        crate::cancellation::checkpoint()?;
        // capture text content until next '<'
        let text_start = self.i;
        while self.i < self.s.len() && self.s[self.i] != b'<' {
            self.i += 1;
        }
        if self.i > text_start {
            let t = std::str::from_utf8(&self.s[text_start..self.i])
                .map_err(|_| "bad utf8")?
                .trim()
                .to_string();
            if !t.is_empty() {
                return Ok(XmlTag::Text(t));
            }
        }
        if self.i >= self.s.len() {
            return Ok(XmlTag::Eof);
        }
        self.i += 1; // consume '<'
                     // comments / doctype / processing instructions
        if self.s.get(self.i) == Some(&b'!') || self.s.get(self.i) == Some(&b'?') {
            while self.i < self.s.len() && self.s[self.i] != b'>' {
                self.i += 1;
            }
            self.i += 1;
            return self.next_tag();
        }
        let closing = self.s.get(self.i) == Some(&b'/');
        if closing {
            self.i += 1;
        }
        let name_start = self.i;
        while self.i < self.s.len()
            && (self.s[self.i].is_ascii_alphanumeric()
                || self.s[self.i] == b'-'
                || self.s[self.i] == b':')
        {
            self.i += 1;
        }
        let name = std::str::from_utf8(&self.s[name_start..self.i])
            .map_err(|_| "bad utf8")?
            .to_string();
        let mut attrs = vec![];
        loop {
            while self.i < self.s.len() && (self.s[self.i] as char).is_ascii_whitespace() {
                self.i += 1;
            }
            match self.s.get(self.i) {
                Some(b'>') => {
                    self.i += 1;
                    return Ok(if closing {
                        XmlTag::Close(name)
                    } else {
                        XmlTag::Open(name, attrs)
                    });
                }
                Some(b'/') => {
                    self.i += 2;
                    return Ok(XmlTag::SelfClose(name, attrs));
                }
                None => return Ok(XmlTag::Eof),
                _ => {
                    let ks = self.i;
                    while self.i < self.s.len()
                        && self.s[self.i] != b'='
                        && !(self.s[self.i] as char).is_ascii_whitespace()
                        && self.s[self.i] != b'>'
                    {
                        self.i += 1;
                    }
                    let key = std::str::from_utf8(&self.s[ks..self.i])
                        .map_err(|_| "bad utf8")?
                        .to_string();
                    if self.s.get(self.i) == Some(&b'=') {
                        self.i += 1;
                        let quote = *self.s.get(self.i).ok_or("eof in attr")?;
                        if quote == b'"' || quote == b'\'' {
                            self.i += 1;
                            let vs = self.i;
                            while self.i < self.s.len() && self.s[self.i] != quote {
                                self.i += 1;
                            }
                            let val = std::str::from_utf8(&self.s[vs..self.i])
                                .map_err(|_| "bad utf8")?
                                .to_string();
                            self.i += 1;
                            attrs.push((key, val));
                        }
                    }
                }
            }
        }
    }
}

fn attr<'v>(attrs: &'v [(String, String)], key: &str) -> Option<&'v str> {
    attrs
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

/// Presentation attributes and the CSS declaration block have equal
/// semantics here, with an inline `style` declaration taking priority as it
/// does in SVG's cascade. This is intentionally small and deterministic
/// rather than trying to be a browser CSS engine; it covers the declarations
/// emitted by design tools and preserves the inherited value when a
/// declaration is unsupported.
type CssRules = Vec<(String, HashMap<String, String>)>;

/// Extract the small CSS subset commonly emitted by Illustrator/Figma/Sketch
/// SVG exports. CSS is parsed before the XML walk so a class rule can style a
/// shape even when the `<style>` element appears after that shape.
fn parse_css_rules(svg: &str) -> CssRules {
    let mut rules = Vec::new();
    let mut offset = 0usize;
    while let Some(relative_start) = svg[offset..].find("<style") {
        let start = offset + relative_start;
        let after_open = &svg[start..];
        let Some(open_end) = after_open.find('>') else {
            break;
        };
        let body_start = start + open_end + 1;
        let Some(close_rel) = svg[body_start..].find("</style>") else {
            break;
        };
        let body_end = body_start + close_rel;
        let body = &svg[body_start..body_end];
        for block in body.split('}') {
            let Some((selectors, declarations)) = block.split_once('{') else {
                continue;
            };
            let mut properties = HashMap::new();
            for declaration in declarations.split(';') {
                let Some((name, value)) = declaration.split_once(':') else {
                    continue;
                };
                let name = name.trim().to_ascii_lowercase();
                let value = value
                    .trim()
                    .strip_suffix("!important")
                    .unwrap_or(value.trim())
                    .trim();
                if !name.is_empty() && !value.is_empty() && !name.starts_with('@') {
                    properties.insert(name, value.to_string());
                }
            }
            if properties.is_empty() {
                continue;
            }
            for selector in selectors
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                rules.push((selector.to_string(), properties.clone()));
            }
        }
        offset = body_end + "</style>".len();
    }
    rules
}

fn selector_specificity(
    selector: &str,
    attrs: &[(String, String)],
    tag_name: &str,
) -> Option<(u8, u8, u8)> {
    // Use the final simple selector for the common `g .accent` form; the
    // ancestry is still represented by the element's class/id in exported
    // design-tool SVGs, while unsupported combinators safely do not match.
    let selector = selector
        .split(['>', '+', '~', ' '])
        .filter(|part| !part.is_empty())
        .next_back()?;
    let id = attr(attrs, "id");
    let classes: Vec<&str> = attr(attrs, "class")
        .unwrap_or_default()
        .split_whitespace()
        .collect();
    let mut ids = 0;
    let mut class_count = 0;
    let mut element_specificity = 0;
    let mut rest = selector;
    if let Some(name) = rest.strip_prefix('#') {
        if id != Some(name) {
            return None;
        }
        ids = 1;
    } else if let Some(name) = rest.strip_prefix('.') {
        if !classes.contains(&name) {
            return None;
        }
        class_count = 1;
    } else {
        if let Some((name, suffix)) = rest.split_once('#') {
            if id != Some(suffix) {
                return None;
            }
            ids = 1;
            rest = name;
        }
        if let Some((name, suffix)) = rest.split_once('.') {
            if !classes.contains(&suffix) {
                return None;
            }
            class_count = 1;
            rest = name;
        }
        if !rest.is_empty() && rest != "*" {
            if !tag_name.eq_ignore_ascii_case(rest) {
                return None;
            }
            element_specificity = 1;
        }
    }
    Some((ids, class_count, element_specificity))
}

fn stylesheet_value(
    attrs: &[(String, String)],
    key: &str,
    rules: &CssRules,
    tag_name: &str,
) -> Option<String> {
    let mut winner: Option<((u8, u8, u8), usize, String)> = None;
    for (index, (selector, properties)) in rules.iter().enumerate() {
        let Some(specificity) = selector_specificity(selector, attrs, tag_name) else {
            continue;
        };
        let Some(value) = properties.get(&key.to_ascii_lowercase()) else {
            continue;
        };
        let replace = winner
            .as_ref()
            .is_some_and(|(old_specificity, old_index, _)| {
                specificity > *old_specificity
                    || (specificity == *old_specificity && index >= *old_index)
            });
        if replace {
            winner = Some((specificity, index, value.clone()));
        }
    }
    winner.map(|(_, _, value)| value)
}

fn style_value<'v>(attrs: &'v [(String, String)], key: &str) -> Option<&'v str> {
    attr(attrs, "style").and_then(|style| {
        style.split(';').rev().find_map(|declaration| {
            let (name, value) = declaration.split_once(':')?;
            (name.trim().eq_ignore_ascii_case(key)).then_some(value.trim())
        })
    })
}

fn attr_or_style<'v>(attrs: &'v [(String, String)], key: &str) -> Option<&'v str> {
    style_value(attrs, key).or_else(|| attr(attrs, key))
}

fn computed_value(
    attrs: &[(String, String)],
    key: &str,
    rules: &CssRules,
    tag_name: &str,
) -> Option<String> {
    style_value(attrs, key)
        .map(str::to_string)
        .or_else(|| stylesheet_value(attrs, key, rules, tag_name))
        .or_else(|| attr(attrs, key).map(str::to_string))
}

fn attr_num(attrs: &[(String, String)], key: &str) -> Option<f64> {
    attr_or_style(attrs, key)
        .and_then(|v| v.trim().strip_suffix("px").unwrap_or(v.trim()).parse().ok())
}

fn css_number(value: &str) -> Option<f32> {
    let value = value.trim();
    if let Some(percent) = value.strip_suffix('%') {
        Some(percent.parse::<f32>().ok()?.clamp(0.0, 100.0) / 100.0)
    } else {
        Some(value.parse::<f32>().ok()?.clamp(0.0, 1.0))
    }
}

#[derive(Clone)]
struct SvgPaint {
    paint: Paint,
    /// SVG's default gradientUnits is objectBoundingBox. Keep that bit of
    /// source semantics until the consuming shape gives us its pixel size.
    object_bounding_box: bool,
    /// Gradient-local transform, separate from the node transform.
    gradient_transform: Affine,
}

impl SvgPaint {
    fn solid(color: Color) -> Self {
        Self {
            paint: Paint::Solid(color),
            object_bounding_box: false,
            gradient_transform: Affine::IDENTITY,
        }
    }

    fn with_alpha(&self, alpha: f32) -> Paint {
        let mut paint = self.paint.clone();
        if alpha >= 1.0 {
            return paint;
        }
        match &mut paint {
            Paint::Solid(color) => *color = color.multiply_alpha(alpha),
            Paint::LinearGradient { stops, .. }
            | Paint::RadialGradient { stops, .. }
            | Paint::AngularGradient { stops, .. }
            | Paint::DiamondGradient { stops, .. } => {
                for (_, color) in stops {
                    *color = color.multiply_alpha(alpha);
                }
            }
            Paint::Variable(_) | Paint::Pattern { .. } => {}
        }
        paint
    }

    fn resolved(&self, w: f64, h: f64) -> Paint {
        let point = |x: f64, y: f64| {
            let p = if self.object_bounding_box {
                Point::new(x * w, y * h)
            } else {
                Point::new(x, y)
            };
            self.gradient_transform * p
        };
        match &self.paint {
            Paint::LinearGradient {
                start,
                end,
                stops,
                space,
            } => {
                let start = point(start.0, start.1);
                let end = point(end.0, end.1);
                Paint::LinearGradient {
                    start: (start.x, start.y),
                    end: (end.x, end.y),
                    stops: stops.clone(),
                    space: *space,
                }
            }
            Paint::RadialGradient {
                center,
                radius,
                stops,
                space,
            } => {
                let center_point = point(center.0, center.1);
                let edge = point(center.0 + radius, center.1);
                Paint::RadialGradient {
                    center: (center_point.x, center_point.y),
                    radius: {
                        let delta = edge - center_point;
                        (delta.x * delta.x + delta.y * delta.y).sqrt()
                    },
                    stops: stops.clone(),
                    space: *space,
                }
            }
            other => other.clone(),
        }
    }
}

#[derive(Clone)]
struct SvgStyle {
    fill: SvgPaint,
    fill_opacity: f32,
    stroke: Option<SvgPaint>,
    stroke_opacity: f32,
    stroke_width: f64,
    stroke_options: StrokeOptions,
    opacity: f32,
}

impl Default for SvgStyle {
    fn default() -> Self {
        Self {
            // SVG's default fill is black and its default stroke is none.
            fill: SvgPaint::solid(Color::BLACK),
            fill_opacity: 1.0,
            stroke: None,
            stroke_opacity: 1.0,
            stroke_width: 1.0,
            stroke_options: StrokeOptions::default(),
            opacity: 1.0,
        }
    }
}

impl SvgStyle {
    fn from_parent(
        parent: &Self,
        attrs: &[(String, String)],
        gradients: &HashMap<String, SvgPaint>,
        rules: &CssRules,
        tag: &str,
    ) -> Self {
        let mut style = parent.clone();
        let computed = |key: &str| computed_value(attrs, key, rules, tag);
        if let Some(value) = computed("fill") {
            if let Some(color) = parse_css_color(&value) {
                style.fill = SvgPaint::solid(color);
            } else if let Some(id) = paint_server_id(&value) {
                if let Some(paint) = gradients.get(id) {
                    style.fill = paint.clone();
                }
            }
        }
        if let Some(value) = computed("fill-opacity").as_deref().and_then(css_number) {
            style.fill_opacity = parent.fill_opacity * value;
        }
        if let Some(value) = computed("stroke") {
            style.stroke = parse_css_color(&value)
                .map(SvgPaint::solid)
                .or_else(|| paint_server_id(&value).and_then(|id| gradients.get(id).cloned()));
        }
        if let Some(value) = computed("stroke-opacity").as_deref().and_then(css_number) {
            style.stroke_opacity = parent.stroke_opacity * value;
        }
        if let Some(value) =
            computed("stroke-width").and_then(|v| v.trim_end_matches("px").parse::<f64>().ok())
        {
            style.stroke_width = value.max(0.0);
        }
        if let Some(value) = computed("stroke-linecap") {
            style.stroke_options.cap_start = match value.as_str() {
                "round" => StrokeCap::Round,
                "square" => StrokeCap::Square,
                _ => StrokeCap::None,
            };
            style.stroke_options.cap_end = style.stroke_options.cap_start;
        }
        if let Some(value) = computed("stroke-linejoin") {
            style.stroke_options.join = match value.as_str() {
                "round" => StrokeJoin::Round,
                "bevel" => StrokeJoin::Bevel,
                _ => StrokeJoin::Miter,
            };
        }
        if let Some(value) = computed("stroke-dasharray") {
            style.stroke_options.dash = if value.eq_ignore_ascii_case("none") {
                vec![]
            } else {
                value
                    .split([',', ' ', '\t', '\n'])
                    .filter_map(|part| part.trim().parse::<f64>().ok())
                    .collect()
            };
        }
        if let Some(value) = computed("stroke-dashoffset").and_then(|v| v.parse::<f64>().ok()) {
            style.stroke_options.dash_offset = value;
        }
        if let Some(value) = computed("stroke-miterlimit").and_then(|v| v.parse::<f64>().ok()) {
            style.stroke_options.miter_limit = value.max(0.0);
        }
        if let Some(value) = computed("opacity").as_deref().and_then(css_number) {
            // Group opacity is a compositing multiplier for descendants. It
            // is safe to carry it through the inherited style because the
            // shared lowering applies node opacity exactly once.
            style.opacity = parent.opacity * value;
        }
        style
    }

    fn fill_paint(&self, w: f64, h: f64) -> Paint {
        let resolved = SvgPaint {
            paint: self.fill.resolved(w, h),
            object_bounding_box: false,
            gradient_transform: Affine::IDENTITY,
        };
        resolved.with_alpha(self.fill_opacity)
    }

    fn stroke_paint(&self, w: f64, h: f64) -> Option<(Paint, f64)> {
        self.stroke.as_ref().map(|paint| {
            let resolved = SvgPaint {
                paint: paint.resolved(w, h),
                object_bounding_box: false,
                gradient_transform: Affine::IDENTITY,
            };
            (resolved.with_alpha(self.stroke_opacity), self.stroke_width)
        })
    }
}

fn paint_server_id(value: &str) -> Option<&str> {
    let value = value.trim();
    value.strip_prefix("url(#")?.strip_suffix(')')
}

fn gradient_number(value: Option<&str>, default: f64, percent_default: f64) -> f64 {
    let Some(value) = value.map(str::trim) else {
        return default;
    };
    if let Some(percent) = value.strip_suffix('%') {
        percent
            .parse::<f64>()
            .ok()
            .map(|n| n / 100.0 * percent_default)
            .unwrap_or(default)
    } else {
        value.parse().unwrap_or(default)
    }
}

fn gradient_offset(value: Option<&str>) -> f32 {
    gradient_number(value, 0.0, 1.0).clamp(0.0, 1.0) as f32
}

fn parse_gradient_stop(attrs: &[(String, String)]) -> Option<(f32, Color)> {
    let color = attr_or_style(attrs, "stop-color")
        .and_then(parse_css_color)
        .unwrap_or(Color::BLACK);
    let opacity = attr_or_style(attrs, "stop-opacity")
        .and_then(css_number)
        .unwrap_or(1.0);
    Some((
        gradient_offset(attr_or_style(attrs, "offset")),
        color.multiply_alpha(opacity),
    ))
}

fn svg_stroke_options(attrs: &[(String, String)]) -> StrokeOptions {
    let cap = match attr_or_style(attrs, "stroke-linecap") {
        Some("round") => StrokeCap::Round,
        Some("square") => StrokeCap::Square,
        _ => StrokeCap::None,
    };
    let join = match attr_or_style(attrs, "stroke-linejoin") {
        Some("round") => StrokeJoin::Round,
        Some("bevel") => StrokeJoin::Bevel,
        _ => StrokeJoin::Miter,
    };
    let dash = attr_or_style(attrs, "stroke-dasharray")
        .filter(|value| !value.eq_ignore_ascii_case("none"))
        .map(|value| {
            value
                .split([',', ' ', '\t', '\n'])
                .filter_map(|part| part.trim().parse::<f64>().ok())
                .collect()
        })
        .unwrap_or_default();
    StrokeOptions {
        cap_start: cap,
        cap_end: cap,
        join,
        dash,
        dash_offset: attr_num(attrs, "stroke-dashoffset").unwrap_or(0.0),
        miter_limit: attr_num(attrs, "stroke-miterlimit").unwrap_or(4.0),
        ..StrokeOptions::default()
    }
}

fn parse_gradient(
    lexer: &mut XmlLexer,
    kind: &str,
    attrs: Vec<(String, String)>,
    gradients: &mut HashMap<String, SvgPaint>,
    self_closed: bool,
) -> Result<(), String> {
    let Some(id) = attr(&attrs, "id").map(str::to_string) else {
        if !self_closed {
            skip_element(lexer)?;
        }
        return Ok(());
    };
    let object_bounding_box = attr(&attrs, "gradientUnits") != Some("userSpaceOnUse");
    let mut stops = Vec::new();
    if !self_closed {
        loop {
            match lexer.next_tag()? {
                XmlTag::SelfClose(name, stop_attrs) if name == "stop" => {
                    if let Some(stop) = parse_gradient_stop(&stop_attrs) {
                        stops.push(stop);
                    }
                }
                XmlTag::Open(name, stop_attrs) if name == "stop" => {
                    if let Some(stop) = parse_gradient_stop(&stop_attrs) {
                        stops.push(stop);
                    }
                    skip_element(lexer)?;
                }
                XmlTag::Close(_) | XmlTag::Eof => break,
                XmlTag::Open(..) => skip_element(lexer)?,
                XmlTag::SelfClose(..) | XmlTag::Text(_) => {}
            }
        }
    }
    stops.sort_by(|a, b| a.0.total_cmp(&b.0));
    if stops.is_empty() {
        return Ok(());
    }
    let paint = if kind == "linearGradient" {
        // Both gradientUnits modes share the same default unit x-gradient.
        let defaults = (0.0, 0.0, 1.0, 0.0);
        Paint::LinearGradient {
            start: (
                gradient_number(attr(&attrs, "x1"), defaults.0, 1.0),
                gradient_number(attr(&attrs, "y1"), defaults.1, 1.0),
            ),
            end: (
                gradient_number(attr(&attrs, "x2"), defaults.2, 1.0),
                gradient_number(attr(&attrs, "y2"), defaults.3, 1.0),
            ),
            stops,
            space: GradSpace::Srgb,
        }
    } else {
        Paint::RadialGradient {
            center: (
                gradient_number(attr(&attrs, "cx"), 0.5, 1.0),
                gradient_number(attr(&attrs, "cy"), 0.5, 1.0),
            ),
            radius: gradient_number(attr(&attrs, "r"), 0.5, 1.0),
            stops,
            space: GradSpace::Srgb,
        }
    };
    gradients.insert(
        id,
        SvgPaint {
            paint,
            object_bounding_box,
            gradient_transform: attr(&attrs, "gradientTransform")
                .and_then(parse_svg_transform)
                .unwrap_or(Affine::IDENTITY),
        },
    );
    Ok(())
}

fn parse_defs(
    lexer: &mut XmlLexer,
    gradients: &mut HashMap<String, SvgPaint>,
) -> Result<(), String> {
    loop {
        match lexer.next_tag()? {
            XmlTag::Close(name) if name == "defs" => return Ok(()),
            XmlTag::Eof => return Ok(()),
            XmlTag::Open(name, attrs) if name == "linearGradient" || name == "radialGradient" => {
                parse_gradient(lexer, &name, attrs, gradients, false)?;
            }
            XmlTag::SelfClose(name, attrs)
                if name == "linearGradient" || name == "radialGradient" =>
            {
                parse_gradient(lexer, &name, attrs, gradients, true)?;
            }
            XmlTag::Open(..) => skip_element(lexer)?,
            XmlTag::SelfClose(..) | XmlTag::Text(_) | XmlTag::Close(_) => {}
        }
    }
}

fn transform_numbers(value: &str) -> Vec<f64> {
    // Reuse the SVG number lexer so compact forms such as `10-20` and
    // scientific notation are accepted, not just comma-separated values.
    tokenize_path(value)
        .into_iter()
        .filter_map(|token| match token {
            PathToken::Number(value) => Some(value),
            PathToken::Command(_) => None,
        })
        .collect()
}

/// Parse the complete SVG transform list that can be represented by the
/// native affine model. Matrix transforms are kept as matrices until the
/// shared import lowering step, so scale/skew and rotate-about-a-point are
/// not silently discarded like the old translate/rotate-only path.
fn parse_svg_transform(value: &str) -> Option<Affine> {
    let mut result = Affine::IDENTITY;
    let mut rest = value.trim();
    let mut parsed = false;
    while !rest.is_empty() {
        let open = rest.find('(')?;
        let name = rest[..open].trim().to_ascii_lowercase();
        let close = rest[open + 1..].find(')')? + open + 1;
        let args = transform_numbers(&rest[open + 1..close]);
        let op = match name.as_str() {
            "matrix" if args.len() >= 6 => {
                Affine::new([args[0], args[1], args[2], args[3], args[4], args[5]])
            }
            "translate" if !args.is_empty() => {
                Affine::translate((args[0], args.get(1).copied().unwrap_or(0.0)))
            }
            "scale" if !args.is_empty() => {
                Affine::scale_non_uniform(args[0], args.get(1).copied().unwrap_or(args[0]))
            }
            "rotate" if !args.is_empty() => {
                let rotate = Affine::rotate(args[0].to_radians());
                if args.len() >= 3 {
                    Affine::translate((args[1], args[2]))
                        * rotate
                        * Affine::translate((-args[1], -args[2]))
                } else {
                    rotate
                }
            }
            "skewx" if !args.is_empty() => Affine::skew(args[0].to_radians(), 0.0),
            "skewy" if !args.is_empty() => Affine::skew(0.0, args[0].to_radians()),
            _ => {
                rest = rest[close + 1..]
                    .trim_start_matches(|c: char| c.is_ascii_whitespace() || c == ',');
                continue;
            }
        };
        // SVG transform lists are applied in declaration order to the
        // geometry; with column-vector affines that is a right multiply.
        result *= op;
        parsed = true;
        rest = rest[close + 1..].trim_start_matches(|c: char| c.is_ascii_whitespace() || c == ',');
    }
    parsed.then_some(result)
}

fn apply_transform_attr(node: &mut ImportNode, attrs: &[(String, String)]) {
    if let Some(value) = attr_or_style(attrs, "transform") {
        node.source_transform = parse_svg_transform(value);
    }
}

fn translate_path_cmd(command: PathCmd, dx: f64, dy: f64) -> PathCmd {
    match command {
        PathCmd::MoveTo(x, y) => PathCmd::MoveTo(x + dx, y + dy),
        PathCmd::LineTo(x, y) => PathCmd::LineTo(x + dx, y + dy),
        PathCmd::CurveTo(x1, y1, x2, y2, x, y) => {
            PathCmd::CurveTo(x1 + dx, y1 + dy, x2 + dx, y2 + dy, x + dx, y + dy)
        }
        PathCmd::Close => PathCmd::Close,
    }
}

fn cubic_value(a: f64, b: f64, c: f64, d: f64, t: f64) -> f64 {
    let mt = 1.0 - t;
    mt * mt * mt * a + 3.0 * mt * mt * t * b + 3.0 * mt * t * t * c + t * t * t * d
}

fn include_cubic_extrema(min: &mut f64, max: &mut f64, a: f64, b: f64, c: f64, d: f64) {
    let qa = -a + 3.0 * b - 3.0 * c + d;
    let qb = 2.0 * (a - 2.0 * b + c);
    let qc = b - a;
    let mut roots = [0.0; 2];
    let count = if qa.abs() < 1e-12 {
        if qb.abs() < 1e-12 {
            0
        } else {
            roots[0] = -qc / qb;
            1
        }
    } else {
        let discriminant = qb * qb - 4.0 * qa * qc;
        if discriminant < 0.0 {
            0
        } else if discriminant.abs() < 1e-12 {
            roots[0] = -qb / (2.0 * qa);
            1
        } else {
            let sqrt = discriminant.sqrt();
            roots[0] = (-qb - sqrt) / (2.0 * qa);
            roots[1] = (-qb + sqrt) / (2.0 * qa);
            2
        }
    };
    for t in roots.into_iter().take(count) {
        if (0.0..1.0).contains(&t) {
            let value = cubic_value(a, b, c, d, t);
            *min = min.min(value);
            *max = max.max(value);
        }
    }
}

/// Bounds the actual cubic curve, not just its control polygon. This avoids
/// importing a curve with an unnecessarily large node box (which changes
/// transforms, hit testing, and gradient coordinates).
fn include_point(
    min_x: &mut f64,
    min_y: &mut f64,
    max_x: &mut f64,
    max_y: &mut f64,
    x: f64,
    y: f64,
) {
    *min_x = (*min_x).min(x);
    *min_y = (*min_y).min(y);
    *max_x = (*max_x).max(x);
    *max_y = (*max_y).max(y);
}

fn path_bounds(cmds: &[PathCmd]) -> (f64, f64, f64, f64) {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    let mut current = (0.0, 0.0);
    let mut subpath_start = current;
    for command in cmds {
        match *command {
            PathCmd::MoveTo(x, y) => {
                current = (x, y);
                subpath_start = current;
                include_point(&mut min_x, &mut min_y, &mut max_x, &mut max_y, x, y);
            }
            PathCmd::LineTo(x, y) => {
                include_point(&mut min_x, &mut min_y, &mut max_x, &mut max_y, x, y);
                current = (x, y);
            }
            PathCmd::CurveTo(x1, y1, x2, y2, x, y) => {
                include_point(
                    &mut min_x, &mut min_y, &mut max_x, &mut max_y, current.0, current.1,
                );
                include_point(&mut min_x, &mut min_y, &mut max_x, &mut max_y, x, y);
                include_cubic_extrema(&mut min_x, &mut max_x, current.0, x1, x2, x);
                include_cubic_extrema(&mut min_y, &mut max_y, current.1, y1, y2, y);
                current = (x, y);
            }
            PathCmd::Close => {
                include_point(
                    &mut min_x,
                    &mut min_y,
                    &mut max_x,
                    &mut max_y,
                    subpath_start.0,
                    subpath_start.1,
                );
                current = subpath_start;
            }
        }
    }
    if min_x.is_finite() {
        (min_x, min_y, max_x, max_y)
    } else {
        (0.0, 0.0, 0.0, 0.0)
    }
}

#[derive(Clone, Copy)]
enum PathToken {
    Command(char),
    Number(f64),
}

fn tokenize_path(d: &str) -> Vec<PathToken> {
    let bytes = d.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        if byte.is_ascii_alphabetic() {
            tokens.push(PathToken::Command(byte as char));
            i += 1;
            continue;
        }
        if byte.is_ascii_whitespace() || byte == b',' {
            i += 1;
            continue;
        }
        let start = i;
        if bytes[i] == b'+' || bytes[i] == b'-' {
            i += 1;
        }
        while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
            i += 1;
        }
        if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
            i += 1;
            if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
                i += 1;
            }
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
        }
        if i == start || (i == start + 1 && (bytes[start] == b'+' || bytes[start] == b'-')) {
            // Unknown punctuation: skip it so a malformed path cannot make
            // the importer loop forever.
            i = i.max(start + 1);
            continue;
        }
        if let Ok(value) = d[start..i].parse::<f64>() {
            tokens.push(PathToken::Number(value));
        }
    }
    tokens
}

fn vector_angle(ux: f64, uy: f64, vx: f64, vy: f64) -> f64 {
    (ux * vy - uy * vx).atan2(ux * vx + uy * vy)
}

/// Convert one SVG endpoint-parameterized elliptical arc to cubic Beziers.
/// SVG has no native arc in the editable path model, so this is the lossless
/// representation available to the renderer (within normal cubic arc error).
fn append_svg_arc(
    out: &mut Vec<PathCmd>,
    start: (f64, f64),
    mut rx: f64,
    mut ry: f64,
    rotation: f64,
    large_arc: bool,
    sweep: bool,
    end: (f64, f64),
) {
    if (start.0 - end.0).abs() < 1e-12 && (start.1 - end.1).abs() < 1e-12 {
        return;
    }
    rx = rx.abs();
    ry = ry.abs();
    if rx < 1e-12 || ry < 1e-12 {
        out.push(PathCmd::LineTo(end.0, end.1));
        return;
    }
    let phi = rotation.to_radians().rem_euclid(std::f64::consts::TAU);
    let (cos_phi, sin_phi) = (phi.cos(), phi.sin());
    let dx = (start.0 - end.0) / 2.0;
    let dy = (start.1 - end.1) / 2.0;
    let x_prime = cos_phi * dx + sin_phi * dy;
    let y_prime = -sin_phi * dx + cos_phi * dy;
    let lambda = x_prime * x_prime / (rx * rx) + y_prime * y_prime / (ry * ry);
    if lambda > 1.0 {
        let scale = lambda.sqrt();
        rx *= scale;
        ry *= scale;
    }
    let rx2 = rx * rx;
    let ry2 = ry * ry;
    let x2 = x_prime * x_prime;
    let y2 = y_prime * y_prime;
    let numerator = (rx2 * ry2 - rx2 * y2 - ry2 * x2).max(0.0);
    let denominator = (rx2 * y2 + ry2 * x2).max(1e-24);
    let factor = if large_arc == sweep { -1.0 } else { 1.0 } * (numerator / denominator).sqrt();
    let cx_prime = factor * rx * y_prime / ry;
    let cy_prime = factor * -ry * x_prime / rx;
    let cx = cos_phi * cx_prime - sin_phi * cy_prime + (start.0 + end.0) / 2.0;
    let cy = sin_phi * cx_prime + cos_phi * cy_prime + (start.1 + end.1) / 2.0;
    let ux = (x_prime - cx_prime) / rx;
    let uy = (y_prime - cy_prime) / ry;
    let vx = (-x_prime - cx_prime) / rx;
    let vy = (-y_prime - cy_prime) / ry;
    let start_angle = vector_angle(1.0, 0.0, ux, uy);
    let mut delta = vector_angle(ux, uy, vx, vy);
    if !sweep && delta > 0.0 {
        delta -= std::f64::consts::TAU;
    } else if sweep && delta < 0.0 {
        delta += std::f64::consts::TAU;
    }
    let segments = (delta.abs() / std::f64::consts::FRAC_PI_2).ceil() as usize;
    let segments = segments.max(1);
    let step = delta / segments as f64;
    for segment in 0..segments {
        let a0 = start_angle + segment as f64 * step;
        let a1 = a0 + step;
        let alpha = 4.0 / 3.0 * (step / 4.0).tan();
        let (sin0, cos0) = a0.sin_cos();
        let (sin1, cos1) = a1.sin_cos();
        let point = |cos_a: f64, sin_a: f64| {
            (
                cx + cos_phi * rx * cos_a - sin_phi * ry * sin_a,
                cy + sin_phi * rx * cos_a + cos_phi * ry * sin_a,
            )
        };
        let tangent = |cos_a: f64, sin_a: f64| {
            (
                -cos_phi * rx * sin_a - sin_phi * ry * cos_a,
                -sin_phi * rx * sin_a + cos_phi * ry * cos_a,
            )
        };
        let p0 = point(cos0, sin0);
        let p3 = point(cos1, sin1);
        let t0 = tangent(cos0, sin0);
        let t1 = tangent(cos1, sin1);
        out.push(PathCmd::CurveTo(
            p0.0 + alpha * t0.0,
            p0.1 + alpha * t0.1,
            p3.0 - alpha * t1.0,
            p3.1 - alpha * t1.1,
            p3.0,
            p3.1,
        ));
    }
}

pub(crate) fn parse_path_d(d: &str) -> Vec<PathCmd> {
    let tokens = tokenize_path(d);
    let mut out = Vec::new();
    let mut index = 0usize;
    let mut command: Option<char> = None;
    let mut current = (0.0, 0.0);
    let mut subpath_start = current;
    let mut last_cubic_control: Option<(f64, f64)> = None;
    let mut last_quadratic_control: Option<(f64, f64)> = None;

    let number = |tokens: &[PathToken], index: usize| -> Option<f64> {
        match tokens.get(index) {
            Some(PathToken::Number(value)) => Some(*value),
            _ => None,
        }
    };
    let is_number = |tokens: &[PathToken], index: usize| {
        matches!(tokens.get(index), Some(PathToken::Number(_)))
    };

    while index < tokens.len() {
        if let Some(PathToken::Command(next)) = tokens.get(index).copied() {
            command = Some(next);
            index += 1;
            if next == 'Z' || next == 'z' {
                out.push(PathCmd::Close);
                current = subpath_start;
                last_cubic_control = None;
                last_quadratic_control = None;
                command = None;
            }
            continue;
        }
        let Some(mut active) = command else {
            index += 1;
            continue;
        };
        let relative = active.is_ascii_lowercase();
        let upper = active.to_ascii_uppercase();
        let required = match upper {
            'M' | 'L' | 'T' => 2,
            'H' | 'V' => 1,
            'C' => 6,
            'S' | 'Q' => 4,
            'A' => 7,
            _ => {
                command = None;
                continue;
            }
        };
        if !(0..required).all(|offset| is_number(&tokens, index + offset)) {
            command = None;
            continue;
        }
        let values: Vec<f64> = (0..required)
            .map(|offset| number(&tokens, index + offset).unwrap())
            .collect();
        index += required;
        match upper {
            'M' => {
                let p = if relative {
                    (current.0 + values[0], current.1 + values[1])
                } else {
                    (values[0], values[1])
                };
                out.push(PathCmd::MoveTo(p.0, p.1));
                current = p;
                subpath_start = p;
                last_cubic_control = None;
                last_quadratic_control = None;
                // Subsequent coordinate pairs after M are implicit L commands.
                active = if relative { 'l' } else { 'L' };
                command = Some(active);
            }
            'L' => {
                let p = if relative {
                    (current.0 + values[0], current.1 + values[1])
                } else {
                    (values[0], values[1])
                };
                out.push(PathCmd::LineTo(p.0, p.1));
                current = p;
                last_cubic_control = None;
                last_quadratic_control = None;
            }
            'H' => {
                let x = if relative {
                    current.0 + values[0]
                } else {
                    values[0]
                };
                current.0 = x;
                out.push(PathCmd::LineTo(current.0, current.1));
                last_cubic_control = None;
                last_quadratic_control = None;
            }
            'V' => {
                let y = if relative {
                    current.1 + values[0]
                } else {
                    values[0]
                };
                current.1 = y;
                out.push(PathCmd::LineTo(current.0, current.1));
                last_cubic_control = None;
                last_quadratic_control = None;
            }
            'C' => {
                let p1 = if relative {
                    (current.0 + values[0], current.1 + values[1])
                } else {
                    (values[0], values[1])
                };
                let p2 = if relative {
                    (current.0 + values[2], current.1 + values[3])
                } else {
                    (values[2], values[3])
                };
                let p = if relative {
                    (current.0 + values[4], current.1 + values[5])
                } else {
                    (values[4], values[5])
                };
                out.push(PathCmd::CurveTo(p1.0, p1.1, p2.0, p2.1, p.0, p.1));
                current = p;
                last_cubic_control = Some(p2);
                last_quadratic_control = None;
            }
            'S' => {
                let p1 = last_cubic_control
                    .map(|p| (2.0 * current.0 - p.0, 2.0 * current.1 - p.1))
                    .unwrap_or(current);
                let p2 = if relative {
                    (current.0 + values[0], current.1 + values[1])
                } else {
                    (values[0], values[1])
                };
                let p = if relative {
                    (current.0 + values[2], current.1 + values[3])
                } else {
                    (values[2], values[3])
                };
                out.push(PathCmd::CurveTo(p1.0, p1.1, p2.0, p2.1, p.0, p.1));
                current = p;
                last_cubic_control = Some(p2);
                last_quadratic_control = None;
            }
            'Q' | 'T' => {
                let (control, p) = if upper == 'Q' {
                    let q = if relative {
                        (current.0 + values[0], current.1 + values[1])
                    } else {
                        (values[0], values[1])
                    };
                    let p = if relative {
                        (current.0 + values[2], current.1 + values[3])
                    } else {
                        (values[2], values[3])
                    };
                    (q, p)
                } else {
                    let q = last_quadratic_control
                        .map(|q| (2.0 * current.0 - q.0, 2.0 * current.1 - q.1))
                        .unwrap_or(current);
                    let p = if relative {
                        (current.0 + values[0], current.1 + values[1])
                    } else {
                        (values[0], values[1])
                    };
                    (q, p)
                };
                let c1 = (
                    current.0 + (control.0 - current.0) * 2.0 / 3.0,
                    current.1 + (control.1 - current.1) * 2.0 / 3.0,
                );
                let c2 = (
                    p.0 + (control.0 - p.0) * 2.0 / 3.0,
                    p.1 + (control.1 - p.1) * 2.0 / 3.0,
                );
                out.push(PathCmd::CurveTo(c1.0, c1.1, c2.0, c2.1, p.0, p.1));
                current = p;
                last_quadratic_control = Some(control);
                last_cubic_control = None;
            }
            'A' => {
                let p = if relative {
                    (current.0 + values[5], current.1 + values[6])
                } else {
                    (values[5], values[6])
                };
                append_svg_arc(
                    &mut out,
                    current,
                    values[0],
                    values[1],
                    values[2],
                    values[3] != 0.0,
                    values[4] != 0.0,
                    p,
                );
                current = p;
                last_cubic_control = None;
                last_quadratic_control = None;
            }
            _ => {}
        }
    }
    out
}

fn parse_children(
    lexer: &mut XmlLexer,
    root: &mut ImportNode,
    root_style: SvgStyle,
    css_rules: CssRules,
) -> Result<(), String> {
    // Explicit element stack — this function used to recurse on nested <g>
    // and every recursion level cost a multi-KB frame: ~200k nested groups
    // (crafted file) overflowed the stack with SIGABRT, and even moderate
    // depth was unsafe on small stacks. The heap-bounded stack below cannot
    // overflow; MAX_SVG_DEPTH stays as a document-sanity bound (the same
    // cap the JSON importer applies).
    struct Frame {
        node: ImportNode,
        pending_text: Option<ImportNode>,
        style: SvgStyle,
    }
    let base = std::mem::replace(root, ImportNode::new(ImportKind::Frame));
    let mut stack: Vec<Frame> = vec![Frame {
        node: base,
        pending_text: None,
        style: root_style,
    }];
    let mut gradients: HashMap<String, SvgPaint> = HashMap::new();
    loop {
        match lexer.next_tag()? {
            XmlTag::Eof => {
                // unterminated file: unwind whatever is open into the root
                while let Some(mut f) = stack.pop() {
                    if let Some(t) = f.pending_text.take() {
                        f.node.children.push(t);
                    }
                    match stack.last_mut() {
                        Some(top) => top.node.children.push(f.node),
                        None => {
                            *root = f.node;
                        }
                    }
                }
                return Ok(());
            }
            XmlTag::Close(_) => {
                let mut f = stack.pop().ok_or("unbalanced close tag")?;
                if let Some(t) = f.pending_text.take() {
                    f.node.children.push(t);
                }
                match stack.last_mut() {
                    Some(top) => top.node.children.push(f.node),
                    None => {
                        *root = f.node;
                        return Ok(());
                    }
                }
            }
            XmlTag::Text(content) => {
                if let Some(top) = stack.last_mut() {
                    if let Some(mut t) = top.pending_text.take() {
                        if let ImportKind::Text { content: c, .. } = &mut t.kind {
                            *c = content;
                        }
                        top.node.children.push(t);
                    }
                }
            }
            tag @ (XmlTag::Open(..) | XmlTag::SelfClose(..)) => {
                let (name, attrs, self_closed) = match tag {
                    XmlTag::Open(n, a) => (n, a, false),
                    XmlTag::SelfClose(n, a) => (n, a, true),
                    _ => unreachable!(),
                };
                // source id if present; the shared lowering generates
                // fallbacks and dedupes — no local counter needed anymore
                let src_id = attr(&attrs, "id").map(String::from);
                let with_id = |mut n: ImportNode| {
                    if let Some(i) = &src_id {
                        n = n.id(i.clone());
                    }
                    n
                };
                let inherited = stack
                    .last()
                    .map(|frame| frame.style.clone())
                    .unwrap_or_default();
                let current_style =
                    SvgStyle::from_parent(&inherited, &attrs, &gradients, &css_rules, &name);
                match name.as_str() {
                    "g" => {
                        let mut g = with_id(ImportNode::new(ImportKind::Group));
                        g.opacity = current_style.opacity;
                        apply_transform_attr(&mut g, &attrs);
                        if self_closed {
                            stack.last_mut().unwrap().node.children.push(g);
                        } else {
                            if stack.len() >= MAX_SVG_DEPTH {
                                return Err(format!(
                                    "SVG nesting deeper than {MAX_SVG_DEPTH} levels"
                                ));
                            }
                            stack.push(Frame {
                                node: g,
                                pending_text: None,
                                style: current_style.clone(),
                            });
                        }
                    }
                    "rect" => {
                        let mut n = with_id(ImportNode::new(ImportKind::Rect {
                            radius: attr_num(&attrs, "rx").unwrap_or(0.0),
                        }))
                        .at(
                            attr_num(&attrs, "x").unwrap_or(0.0),
                            attr_num(&attrs, "y").unwrap_or(0.0),
                        )
                        .size(
                            attr_num(&attrs, "width").unwrap_or(0.0),
                            attr_num(&attrs, "height").unwrap_or(0.0),
                        )
                        .fill(current_style.fill_paint(
                            attr_num(&attrs, "width").unwrap_or(0.0),
                            attr_num(&attrs, "height").unwrap_or(0.0),
                        ));
                        n.opacity = current_style.opacity;
                        n.stroke = current_style.stroke_paint(
                            attr_num(&attrs, "width").unwrap_or(0.0),
                            attr_num(&attrs, "height").unwrap_or(0.0),
                        );
                        n.stroke_options = current_style
                            .stroke
                            .as_ref()
                            .map(|_| current_style.stroke_options.clone());
                        apply_transform_attr(&mut n, &attrs);
                        if !self_closed {
                            skip_element(lexer)?;
                        }
                        stack.last_mut().unwrap().node.children.push(n);
                    }
                    "ellipse" | "circle" => {
                        let r = attr_num(&attrs, "r");
                        let rx = attr_num(&attrs, "rx").or(r).unwrap_or(0.0);
                        let ry = attr_num(&attrs, "ry").or(r).unwrap_or(0.0);
                        let cx = attr_num(&attrs, "cx").unwrap_or(0.0);
                        let cy = attr_num(&attrs, "cy").unwrap_or(0.0);
                        let mut n = with_id(ImportNode::new(ImportKind::Ellipse))
                            .at(cx - rx, cy - ry)
                            .size(rx * 2.0, ry * 2.0)
                            .fill(current_style.fill_paint(rx * 2.0, ry * 2.0));
                        n.opacity = current_style.opacity;
                        n.stroke = current_style.stroke_paint(rx * 2.0, ry * 2.0);
                        n.stroke_options = current_style
                            .stroke
                            .as_ref()
                            .map(|_| current_style.stroke_options.clone());
                        apply_transform_attr(&mut n, &attrs);
                        if !self_closed {
                            skip_element(lexer)?;
                        }
                        stack.last_mut().unwrap().node.children.push(n);
                    }
                    "line" => {
                        let x1 = attr_num(&attrs, "x1").unwrap_or(0.0);
                        let y1 = attr_num(&attrs, "y1").unwrap_or(0.0);
                        let x2 = attr_num(&attrs, "x2").unwrap_or(0.0);
                        let y2 = attr_num(&attrs, "y2").unwrap_or(0.0);
                        // The native Line primitive is horizontal. Preserve
                        // diagonal SVG lines as editable vectors instead of
                        // silently flattening their y component.
                        let (dx, dy) = (x2 - x1, y2 - y1);
                        let min_x = dx.min(0.0);
                        let min_y = dy.min(0.0);
                        let cmds = vec![
                            PathCmd::MoveTo(-min_x, -min_y),
                            PathCmd::LineTo(dx - min_x, dy - min_y),
                        ];
                        let mut n = with_id(ImportNode::new(ImportKind::Path { cmds }))
                            .at(x1 + min_x, y1 + min_y)
                            .size(dx.abs().max(1.0), dy.abs().max(1.0))
                            .fill(Paint::Solid(Color::TRANSPARENT));
                        n.opacity = current_style.opacity;
                        n.stroke = current_style.stroke_paint(dx.abs().max(1.0), dy.abs().max(1.0));
                        n.stroke_options = current_style
                            .stroke
                            .as_ref()
                            .map(|_| current_style.stroke_options.clone());
                        apply_transform_attr(&mut n, &attrs);
                        if !self_closed {
                            skip_element(lexer)?;
                        }
                        stack.last_mut().unwrap().node.children.push(n);
                    }
                    "path" => {
                        let raw_cmds = attr(&attrs, "d").map(parse_path_d).unwrap_or_default();
                        // A vector node stores geometry at its local origin.
                        // SVG path data is commonly in document coordinates,
                        // so normalize the envelope and translate the command
                        // list rather than leaving the node at (0, 0).
                        let (x0, y0, x1, y1) = path_bounds(&raw_cmds);
                        let cmds = raw_cmds
                            .into_iter()
                            .map(|command| translate_path_cmd(command, -x0, -y0))
                            .collect();
                        let (w, h) = ((x1 - x0).max(0.0), (y1 - y0).max(0.0));
                        let mut n = with_id(ImportNode::new(ImportKind::Path { cmds }))
                            .at(x0, y0)
                            .size(w, h)
                            .fill(current_style.fill_paint(w, h));
                        n.opacity = current_style.opacity;
                        n.stroke = current_style.stroke_paint(w, h);
                        n.stroke_options = current_style
                            .stroke
                            .as_ref()
                            .map(|_| current_style.stroke_options.clone());
                        apply_transform_attr(&mut n, &attrs);
                        if !self_closed {
                            skip_element(lexer)?;
                        }
                        stack.last_mut().unwrap().node.children.push(n);
                    }
                    "text" => {
                        let size = attr_num(&attrs, "font-size").unwrap_or(16.0);
                        let mut n = with_id(ImportNode::new(ImportKind::Text {
                            content: String::new(),
                            size: None,
                            font: None,
                            line_height: None,
                            letter_spacing: None,
                            runs: vec![],
                        }))
                        .at(
                            attr_num(&attrs, "x").unwrap_or(0.0),
                            attr_num(&attrs, "y").unwrap_or(0.0) - size * 0.8,
                        )
                        .size(10.0 * size, size * 1.25)
                        .fill(current_style.fill_paint(10.0 * size, size * 1.25));
                        n.opacity = current_style.opacity;
                        apply_transform_attr(&mut n, &attrs);
                        if self_closed {
                            stack.last_mut().unwrap().node.children.push(n);
                        } else {
                            stack.last_mut().unwrap().pending_text = Some(n);
                        }
                    }
                    "defs" => {
                        if !self_closed {
                            parse_defs(lexer, &mut gradients)?;
                        }
                    }
                    "linearGradient" | "radialGradient" => {
                        parse_gradient(lexer, &name, attrs, &mut gradients, self_closed)?;
                    }
                    "style" | "clipPath" | "mask" | "symbol" => {
                        if !self_closed {
                            skip_element(lexer)?;
                        }
                    }
                    _ => {
                        if !self_closed {
                            skip_element(lexer)?;
                        }
                    }
                }
            }
        }
    }
}

fn skip_element(lexer: &mut XmlLexer) -> Result<(), String> {
    let mut depth = 1i32;
    loop {
        match lexer.next_tag()? {
            XmlTag::Open(..) => depth += 1,
            XmlTag::Close(_) => {
                depth -= 1;
                if depth == 0 {
                    return Ok(());
                }
            }
            XmlTag::Eof => return Ok(()),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A crafted SVG with hundreds of thousands of nested <g> groups used
    /// to recurse parse_children into a stack overflow (SIGABRT, taking
    /// the app down with it). Must now come back as a clean error.
    #[test]
    fn svg_import_rejects_deep_nesting() {
        let mut s = String::from("<svg xmlns=\"http://www.w3.org/2000/svg\">");
        s.push_str(&"<g>".repeat(200_000));
        s.push_str(&"</g>".repeat(200_000));
        s.push_str("</svg>");
        let err = import_svg(&s).expect_err("deep nesting must be rejected");
        assert!(err.contains("deep"), "{err}");
    }

    #[test]
    fn svg_import_accepts_reasonable_nesting() {
        let depth = 64;
        let mut s = String::from("<svg xmlns=\"http://www.w3.org/2000/svg\">");
        s.push_str(&"<g>".repeat(depth));
        s.push_str("<rect width=\"10\" height=\"10\"/>");
        s.push_str(&"</g>".repeat(depth));
        s.push_str("</svg>");
        assert!(import_svg(&s).is_ok(), "64 levels must import fine");
    }

    #[test]
    fn svg_import_preserves_css_style_inheritance_and_gradients() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120">
          <defs>
            <linearGradient id="brand" x1="0" y1="0" x2="100" y2="0" gradientUnits="userSpaceOnUse">
              <stop offset="0" stop-color="rgb(255, 0, 0)"/>
              <stop offset="1" style="stop-color: #0000ff; stop-opacity: .5"/>
            </linearGradient>
          </defs>
          <g style="fill: rgb(255 0 0 / 50%); fill-opacity: .8; stroke: rebeccapurple; stroke-width: 3; stroke-linecap: round">
            <rect x="10" y="10" width="80" height="40"/>
            <path d="M 110 10 Q 150 80 190 10 A 20 20 0 0 1 210 30 Z" fill="url(#brand)"/>
          </g>
        </svg>"##;
        let page = import_svg(svg).expect("SVG should import");
        let group = &page.children[0];
        let rect = &group.children[0];
        assert!(
            matches!(&rect.fill, Paint::Solid(color) if color.to_rgba8() == Color::from_rgba8(255, 0, 0, 102).to_rgba8())
        );
        assert_eq!(rect.stroke.width, 3.0);
        assert_eq!(
            rect.stroke_layers.first().unwrap().options.cap_start,
            StrokeCap::Round
        );
        let path = &group.children[1];
        match &path.fill {
            Paint::LinearGradient {
                start, end, stops, ..
            } => {
                assert_eq!(*start, (0.0, 0.0));
                assert_eq!(*end, (100.0, 0.0));
                assert_eq!(stops.len(), 2);
                assert_eq!(stops[1].1.to_rgba8().a, 128);
            }
            other => panic!("expected imported gradient, got {other:?}"),
        }
        assert!(matches!(path.kind, NodeKind::Vector { .. }));
        assert!(path.transform.x >= 110.0 && path.transform.y >= 10.0);
    }

    #[test]
    fn svg_import_applies_stylesheet_class_colors() {
        let page = import_svg(
            r##"<svg xmlns="http://www.w3.org/2000/svg"><style>.accent { fill: #123456; stroke: #fedcba; stroke-width: 4; }</style><rect class="accent" width="20" height="10"/></svg>"##,
        )
        .expect("stylesheet should import");
        let node = &page.children[0];
        assert_eq!(node.fill, Paint::Solid(Color::from_rgb8(0x12, 0x34, 0x56)));
        assert_eq!(node.stroke.width, 4.0);
        assert_eq!(
            x_core::paint_color(&node.stroke.paint, &Variables::default()).to_rgba8(),
            Color::from_rgb8(0xfe, 0xdc, 0xba).to_rgba8()
        );
    }

    #[test]
    fn svg_import_preserves_full_affine_transform_lists() {
        let page = import_svg(
            r##"<svg xmlns="http://www.w3.org/2000/svg"><rect id="scaled" width="20" height="10" transform="translate(10 20) scale(2 3) skewX(5)"/></svg>"##,
        )
        .expect("transform list should import");
        let node = &page.children[0];
        assert!((node.transform.x - 10.0).abs() < 1e-6);
        assert!((node.transform.y - 20.0).abs() < 1e-6);
        assert!((node.transform.scale_x - 2.0).abs() < 1e-6);
        assert!((node.transform.scale_y - 3.0).abs() < 1e-6);
        assert!(node.transform.skew_x.abs() > 1e-6);
    }

    #[test]
    fn svg_import_supports_smooth_quadratic_arc_and_scientific_paths() {
        let page = import_svg(
            r##"<svg xmlns="http://www.w3.org/2000/svg"><path fill="orange" d="M1e1 1e1 C 20 0 30 0 40 10 S 60 20 70 10 T 90 10 A 10 10 0 0 1 100 20 Z"/></svg>"##,
        )
        .expect("path should import");
        let path = &page.children[0];
        let NodeKind::Vector { path: commands } = &path.kind else {
            panic!("expected vector")
        };
        assert!(
            commands
                .iter()
                .filter(|c| matches!(c, PathCmd::CurveTo(..)))
                .count()
                >= 4
        );
        assert_eq!(path.fill, Paint::Solid(Color::from_rgb8(255, 165, 0)));
        assert!(path.w > 0.0 && path.h > 0.0);
    }
}
