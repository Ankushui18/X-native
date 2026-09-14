//! Shared Styles system — Color, Text, Effect, and Grid styles.
//!
//! This module provides Figma-like "Styles" that can be created, named,
//! applied to layers, and updated globally. Styles are separate from
//! Variables (which are design tokens with modes/aliases) — Styles are
//! designer-facing presets for fills, text properties, effects, and grids.
//!
//! Each style has:
//! - A unique ID (content-derived or UUID)
//! - A name (user-editable)
//! - A type (Color, Text, Effect, Grid)
//! - Type-specific data
//! - Optional description
//!
//! Styles can be:
//! - Applied to layers (fill, stroke, text style, effects)
//! - Detached (layer keeps values but loses style link)
//! - Updated globally (changing style updates all linked layers)
//! - Saved to .xlib libraries for sharing across documents

use crate::layout_types::GridLayout;
use crate::node::{
    HangingPunctuation, ListStyle, Node, TextCase, TextDecoration, TextWrap, WrapStyle,
};
use crate::paint::{BlendKind, Effect, Paint, Stroke};
use std::collections::HashMap;

// ------------------------------------------------------------------ StyleId

/// Unique identifier for a style. Uses content-derived hash or UUID.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct StyleId(pub String);

impl StyleId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn generate() -> Self {
        use crate::assets::hash_bytes;
        // Generate UUID-like id using timestamp + random
        let bytes = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .to_le_bytes();
        Self(hash_bytes(&bytes))
    }
}

// --------------------------------------------------------------- Style types

/// Type discriminator for styles
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StyleType {
    Color,
    Text,
    Effect,
    Grid,
}

impl std::fmt::Display for StyleType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StyleType::Color => write!(f, "Color"),
            StyleType::Text => write!(f, "Text"),
            StyleType::Effect => write!(f, "Effect"),
            StyleType::Grid => write!(f, "Grid"),
        }
    }
}

// ------------------------------------------------------------ ColorStyle data

/// Color style — a named paint (solid or gradient)
#[derive(Debug, Clone, PartialEq)]
pub struct ColorStyleData {
    pub paint: Paint,
}

impl ColorStyleData {
    pub fn solid(color: crate::Color) -> Self {
        Self {
            paint: Paint::Solid(color),
        }
    }

    pub fn linear_gradient(
        start: (f64, f64),
        end: (f64, f64),
        stops: Vec<(f32, crate::Color)>,
    ) -> Self {
        Self {
            paint: Paint::LinearGradient {
                start,
                end,
                stops,
                space: crate::paint::GradSpace::Srgb,
            },
        }
    }

    pub fn radial_gradient(
        center: (f64, f64),
        radius: f64,
        stops: Vec<(f32, crate::Color)>,
    ) -> Self {
        Self {
            paint: Paint::RadialGradient {
                center,
                radius,
                stops,
                space: crate::paint::GradSpace::Srgb,
            },
        }
    }
}

// ------------------------------------------------------------- TextStyle data

/// Line height as a text style carries it: Figma offers Auto, a fixed px
/// value, or a percentage of the font size. The engine's node bindings hold
/// the same three states as `lhm` (`"px"`/`"pct"`) + `lhpx`/`lhp`, so a style
/// applies without loss and reads back exactly.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum LineHeight {
    /// Natural line box of the resolved face.
    #[default]
    Auto,
    /// Absolute px per line (Figma's "px" mode; engine binding `lhm=px`).
    Px(f64),
    /// Percentage of the font size (Figma's "%" mode; engine `lhm=pct`).
    Percent(f64),
    /// Multiple of the face's natural line box (the engine's original `lh`
    /// binding, and what every pre-mode document carries).
    Multiple(f64),
}

impl LineHeight {
    /// The `lhm` spelling used by the file format: `auto`/`px`/`pct`/`mult`.
    pub fn mode_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Px(_) => "px",
            Self::Percent(_) => "pct",
            Self::Multiple(_) => "mult",
        }
    }

    /// The value that travels with the mode (`0.0` for `Auto`).
    pub fn value(self) -> f64 {
        match self {
            Self::Auto => 0.0,
            Self::Px(v) | Self::Percent(v) | Self::Multiple(v) => v,
        }
    }

    /// Parse the (`lhm`, value) pair the file format stores.
    pub fn from_mode(mode: Option<&str>, value: f64) -> Self {
        match mode {
            Some("px") => Self::Px(value),
            Some("pct") => Self::Percent(value),
            Some("mult") => Self::Multiple(value),
            _ => Self::Auto,
        }
    }

    /// Read the mode back out of a node's bindings.
    pub fn from_node(n: &Node) -> Self {
        match n.lh_mode_value() {
            (1, v) => Self::Px(v),
            (2, v) => Self::Percent(v),
            _ => match n.bindings.get("lh").and_then(|v| v.parse::<f64>().ok()) {
                Some(v) => Self::Multiple(v),
                None => Self::Auto,
            },
        }
    }

    /// Write the mode into a node's bindings, clearing the keys of every
    /// other mode so a node never carries two contradictory line heights.
    fn write(self, b: &mut HashMap<String, String>) {
        for k in ["lhm", "lhpx", "lhp", "lh"] {
            b.remove(k);
        }
        match self {
            Self::Auto => {}
            Self::Px(v) => {
                b.insert("lhm".into(), "px".into());
                b.insert("lhpx".into(), fmt_num(v));
            }
            Self::Percent(v) => {
                b.insert("lhm".into(), "pct".into());
                b.insert("lhp".into(), fmt_num(v));
            }
            Self::Multiple(v) => {
                b.insert("lh".into(), fmt_num(v));
            }
        }
    }
}

/// Text style — the named bundle of typography properties.
///
/// The property list is Figma's (see "Create and apply text styles"): family,
/// weight and size; line height; letter spacing; paragraph spacing and indent;
/// decoration; case; lists; and wrap style. Equally deliberate is what is NOT
/// here — alignment, fill, and resizing behaviour stay per-layer, because in
/// Figma a text style does not carry them either.
///
/// A style applies through the SAME channel the rest of the engine uses: the
/// node's `bindings` map (Model B) for everything a renderer reads, plus the
/// typed node fields (Model A) that the `.x` format and the inspector show.
/// Writing both is what keeps a style from being inert.
#[derive(Debug, Clone, PartialEq)]
pub struct TextStyleData {
    pub font_family: String,
    /// 100-900
    pub font_weight: u16,
    /// Point size; the engine's px contract makes this the glyph size in px.
    pub font_size: f64,
    pub line_height: LineHeight,
    /// Letter spacing in px (the shaper's `ls`; Figma's tracking is 1/1000em).
    pub letter_spacing: f64,
    /// Space inserted after a paragraph, px.
    pub paragraph_spacing: f64,
    /// First-line indent, px (Figma honours it on left-aligned paragraphs).
    pub paragraph_indent: f64,
    pub text_case: TextCase,
    /// Synthesized small caps — the engine spells this `tc = "sc"`, which
    /// takes the case slot, so it rides beside `text_case` rather than in it.
    pub small_caps: bool,
    pub text_decoration: TextDecoration,
    pub list_style: ListStyle,
    /// Paragraph wrap strategy (`tw` binding: auto/balance/pretty).
    pub wrap: TextWrap,
    /// Word-break behaviour (`wrap_style` field: normal/break-word).
    pub wrap_style: WrapStyle,
    pub hanging_punctuation: HangingPunctuation,
}

impl Default for TextStyleData {
    fn default() -> Self {
        Self {
            font_family: "Inter".to_string(),
            font_weight: 400,
            font_size: 16.0,
            line_height: LineHeight::Auto,
            letter_spacing: 0.0,
            paragraph_spacing: 0.0,
            paragraph_indent: 0.0,
            text_case: TextCase::Original,
            small_caps: false,
            text_decoration: TextDecoration::None,
            list_style: ListStyle::None,
            wrap: TextWrap::Auto,
            wrap_style: WrapStyle::Normal,
            hanging_punctuation: HangingPunctuation::default(),
        }
    }
}

/// Every binding key a text style owns. `detach` clears exactly these, so
/// detaching a style never touches a layer's variable bindings (`fontsize`,
/// `radius`, …) or its prototype/annotation entries.
pub const TEXT_STYLE_BINDINGS: [&str; 12] = [
    "font",
    "fw",
    "fs",
    "ls",
    "lh",
    "lhm",
    "lhpx",
    "lhp",
    "ps",
    "pi",
    "tc",
    "tw",
];

impl TextStyleData {
    /// Read the typography a node carries today — "create style from
    /// selection" in Figma's flow.
    pub fn from_node(n: &Node) -> Self {
        let num = |k: &str| n.bindings.get(k).and_then(|v| v.parse::<f64>().ok());
        let small_caps = n.bindings.get("tc").map(String::as_str) == Some("sc");
        Self {
            font_family: n
                .bindings
                .get("font")
                .cloned()
                .unwrap_or_else(|| "Inter".to_string()),
            font_weight: n
                .bindings
                .get("fw")
                .and_then(|v| v.parse::<u16>().ok())
                .unwrap_or(400),
            font_size: num("fs").filter(|v| *v > 0.0).unwrap_or(16.0),
            line_height: LineHeight::from_node(n),
            letter_spacing: num("ls").unwrap_or(0.0),
            paragraph_spacing: num("ps").unwrap_or(0.0),
            paragraph_indent: num("pi").unwrap_or(n.paragraph_indent),
            text_case: if small_caps {
                TextCase::Original
            } else {
                n.text_case
            },
            small_caps,
            text_decoration: n.text_decoration,
            list_style: n.list_style,
            wrap: n.text_wrap(),
            wrap_style: n.wrap_style,
            hanging_punctuation: n.hanging_punctuation,
        }
    }

    /// Write the style onto a node: the bindings every renderer reads, and the
    /// typed fields the file format and the inspector read. Returns true when
    /// anything changed, so callers can decide about dirty/undo.
    pub fn apply_to_node(&self, n: &mut Node) -> bool {
        let before = owned_typography(n);
        let b = &mut n.bindings;
        b.insert("font".into(), self.font_family.clone());
        b.insert("fw".into(), self.font_weight.to_string());
        b.insert("fs".into(), fmt_num(self.font_size));
        b.insert("ls".into(), fmt_num(self.letter_spacing));
        b.insert("ps".into(), fmt_num(self.paragraph_spacing));
        b.insert("pi".into(), fmt_num(self.paragraph_indent));
        // One line-height mode at a time; Auto clears all of them so the
        // face's natural line box applies.
        self.line_height.write(b);
        // Case and small caps share the `tc` slot; small caps wins, exactly as
        // the renderers read it.
        if self.small_caps {
            b.insert("tc".into(), "sc".into());
        } else if self.text_case != TextCase::Original {
            b.insert("tc".into(), self.text_case.to_str().into());
        } else {
            b.remove("tc");
        }
        if self.wrap != TextWrap::Auto {
            b.insert("tw".into(), self.wrap.to_str().into());
        } else {
            b.remove("tw");
        }
        n.text_case = self.text_case;
        n.text_decoration = self.text_decoration;
        n.list_style = self.list_style;
        n.wrap_style = self.wrap_style;
        n.paragraph_spacing = self.paragraph_spacing;
        n.paragraph_indent = self.paragraph_indent;
        n.hanging_punctuation = self.hanging_punctuation;
        before != owned_typography(n)
    }

    /// Detach: drop every key this style owns and reset the typed fields, so
    /// the layer keeps rendering exactly as it did but is no longer linked.
    /// Values are NOT re-derived from the style — the caller keeps them by
    /// simply not touching the bindings it wants to preserve (see
    /// `Document::detach_text_style`, which snapshots first).
    pub fn clear_from_node(n: &mut Node) {
        for k in TEXT_STYLE_BINDINGS {
            n.bindings.remove(k);
        }
        n.text_case = TextCase::default();
        n.text_decoration = TextDecoration::default();
        n.list_style = ListStyle::default();
        n.wrap_style = WrapStyle::default();
        n.paragraph_spacing = 0.0;
        n.paragraph_indent = 0.0;
        n.hanging_punctuation = HangingPunctuation::default();
    }
}

/// The typography a style owns, as comparable data: the binding entries in
/// `TEXT_STYLE_BINDINGS` plus the typed node fields. `Node` is not
/// `PartialEq` (it carries paths and caches), so "did applying this style
/// change anything?" compares exactly the slice of the node a style writes.
#[derive(PartialEq)]
struct TypographySnapshot {
    bindings: Vec<(String, String)>,
    text_case: TextCase,
    text_decoration: TextDecoration,
    list_style: ListStyle,
    wrap_style: WrapStyle,
    paragraph_spacing: f64,
    paragraph_indent: f64,
    hanging_punctuation: HangingPunctuation,
}

fn owned_typography(n: &Node) -> TypographySnapshot {
    let mut bindings: Vec<(String, String)> = TEXT_STYLE_BINDINGS
        .iter()
        .filter_map(|k| n.bindings.get(*k).map(|v| (k.to_string(), v.clone())))
        .collect();
    bindings.sort();
    TypographySnapshot {
        bindings,
        text_case: n.text_case,
        text_decoration: n.text_decoration,
        list_style: n.list_style,
        wrap_style: n.wrap_style,
        paragraph_spacing: n.paragraph_spacing,
        paragraph_indent: n.paragraph_indent,
        hanging_punctuation: n.hanging_punctuation,
    }
}

/// Compact number formatting for bindings: no trailing-zero noise, no
/// scientific notation for the sizes/spacing a style can hold.
fn fmt_num(v: f64) -> String {
    if v == v.round() && v.abs() < 1e15 {
        format!("{:.0}", v)
    } else {
        format!("{:.4}", v)
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    }
}

// ----------------------------------------------------------- EffectStyle data

/// Effect style — named stack of effects
#[derive(Debug, Clone, PartialEq)]
pub struct EffectStyleData {
    pub effects: Vec<Effect>,
}

impl EffectStyleData {
    pub fn drop_shadow(dx: f64, dy: f64, blur: f64, color: crate::Color) -> Self {
        Self {
            effects: vec![Effect::DropShadow {
                dx,
                dy,
                blur,
                color,
            }],
        }
    }

    pub fn inner_shadow(dx: f64, dy: f64, blur: f64, color: crate::Color) -> Self {
        Self {
            effects: vec![Effect::InnerShadow {
                dx,
                dy,
                blur,
                color,
            }],
        }
    }

    pub fn layer_blur(radius: f64) -> Self {
        Self {
            effects: vec![Effect::LayerBlur { radius }],
        }
    }

    pub fn background_blur(radius: f64) -> Self {
        Self {
            effects: vec![Effect::BackgroundBlur { radius }],
        }
    }
}

// -------------------------------------------------------------- GridStyle data

/// Grid style — named grid configuration
#[derive(Debug, Clone, PartialEq)]
pub struct GridStyleData {
    pub grid: GridLayout,
}

// -------------------------------------------------------------------- Style

/// A complete style record
#[derive(Debug, Clone, PartialEq)]
pub struct Style {
    pub id: StyleId,
    pub name: String,
    pub style_type: StyleType,
    pub description: Option<String>,
    /// The actual style data, tagged by type
    pub data: StyleData,
    /// Library id this style belongs to (if any)
    pub library_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum StyleData {
    Color(ColorStyleData),
    Text(TextStyleData),
    Effect(EffectStyleData),
    Grid(GridStyleData),
}

impl Style {
    pub fn new_color(id: StyleId, name: String, data: ColorStyleData) -> Self {
        Self {
            id,
            name,
            style_type: StyleType::Color,
            description: None,
            data: StyleData::Color(data),
            library_id: None,
        }
    }

    pub fn new_text(id: StyleId, name: String, data: TextStyleData) -> Self {
        Self {
            id,
            name,
            style_type: StyleType::Text,
            description: None,
            data: StyleData::Text(data),
            library_id: None,
        }
    }

    pub fn new_effect(id: StyleId, name: String, data: EffectStyleData) -> Self {
        Self {
            id,
            name,
            style_type: StyleType::Effect,
            description: None,
            data: StyleData::Effect(data),
            library_id: None,
        }
    }

    pub fn new_grid(id: StyleId, name: String, data: GridStyleData) -> Self {
        Self {
            id,
            name,
            style_type: StyleType::Grid,
            description: None,
            data: StyleData::Grid(data),
            library_id: None,
        }
    }

    pub fn rename(&mut self, new_name: &str) {
        if !new_name.trim().is_empty() {
            self.name = new_name.trim().to_string();
        }
    }

    pub fn set_description(&mut self, desc: Option<String>) {
        self.description = desc;
    }
}

// --------------------------------------------------------------- StyleLibrary

/// Collection of styles within a document or library
#[derive(Debug, Clone, Default)]
pub struct StyleLibrary {
    styles: HashMap<StyleId, Style>,
    /// Name lookup for UI (sorted, deterministic)
    name_index: HashMap<String, StyleId>,
}

impl StyleLibrary {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a style. Returns error if name already exists.
    pub fn add(&mut self, style: Style) -> Result<(), String> {
        if self.name_index.contains_key(&style.name) {
            return Err(format!("Style '{}' already exists", style.name));
        }
        self.name_index.insert(style.name.clone(), style.id.clone());
        self.styles.insert(style.id.clone(), style);
        Ok(())
    }

    /// Get style by ID
    pub fn get(&self, id: &StyleId) -> Option<&Style> {
        self.styles.get(id)
    }

    /// Get mutable style by ID
    pub fn get_mut(&mut self, id: &StyleId) -> Option<&mut Style> {
        self.styles.get_mut(id)
    }

    /// Get style by name
    pub fn get_by_name(&self, name: &str) -> Option<&Style> {
        self.name_index.get(name).and_then(|id| self.styles.get(id))
    }

    /// Remove style by ID
    pub fn remove(&mut self, id: &StyleId) -> Option<Style> {
        if let Some(style) = self.styles.remove(id) {
            self.name_index.remove(&style.name);
            Some(style)
        } else {
            None
        }
    }

    /// Update style data (triggers global update in document)
    pub fn update(&mut self, id: &StyleId, data: StyleData) -> Result<(), String> {
        if let Some(style) = self.styles.get_mut(id) {
            style.data = data;
            Ok(())
        } else {
            Err("Style not found".to_string())
        }
    }

    /// List all styles sorted by name
    pub fn list_all(&self) -> Vec<&Style> {
        let mut v: Vec<&Style> = self.styles.values().collect();
        v.sort_by(|a, b| a.name.cmp(&b.name));
        v
    }

    /// List styles by type
    pub fn list_by_type(&self, style_type: StyleType) -> Vec<&Style> {
        let mut v: Vec<&Style> = self
            .styles
            .values()
            .filter(|s| s.style_type == style_type)
            .collect();
        v.sort_by(|a, b| a.name.cmp(&b.name));
        v
    }

    /// Count styles
    pub fn len(&self) -> usize {
        self.styles.len()
    }

    pub fn is_empty(&self) -> bool {
        self.styles.is_empty()
    }

    /// Check if style name is available
    pub fn name_available(&self, name: &str) -> bool {
        !self.name_index.contains_key(name)
    }

    /// Import styles from another library (e.g., .xlib file)
    pub fn import(&mut self, other: &StyleLibrary, prefix: Option<&str>) -> usize {
        let mut imported = 0;
        for style in other.styles.values() {
            let mut new_style = style.clone();
            if let Some(p) = prefix {
                new_style.name = format!("{}/{}", p, style.name);
            }
            new_style.library_id = style.library_id.clone();
            if self.add(new_style).is_ok() {
                imported += 1;
            }
        }
        imported
    }
}

// ---------------------------------------------------------- Layer style links

/// Tracks which styles are applied to which layers
#[derive(Debug, Clone, Default)]
pub struct StyleUsage {
    /// Map: style_id -> set of node_ids using it
    usage: HashMap<StyleId, std::collections::HashSet<String>>,
}

impl StyleUsage {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that a node uses a style
    pub fn add_usage(&mut self, style_id: StyleId, node_id: String) {
        self.usage.entry(style_id).or_default().insert(node_id);
    }

    /// Remove usage record
    pub fn remove_usage(&mut self, style_id: &StyleId, node_id: &str) {
        if let Some(users) = self.usage.get_mut(style_id) {
            users.remove(node_id);
            if users.is_empty() {
                self.usage.remove(style_id);
            }
        }
    }

    /// Get all nodes using a style
    pub fn get_users(&self, style_id: &StyleId) -> Vec<String> {
        self.usage
            .get(style_id)
            .map(|hs| hs.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Clear all usage for a style (when style is deleted)
    pub fn clear_style(&mut self, style_id: &StyleId) {
        self.usage.remove(style_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Color;

    #[test]
    fn create_and_list_color_styles() {
        let mut lib = StyleLibrary::new();
        let style1 = Style::new_color(
            StyleId::new("color1"),
            "Primary".to_string(),
            ColorStyleData::solid(Color::from_rgb8(0, 153, 255)),
        );
        let style2 = Style::new_color(
            StyleId::new("color2"),
            "Secondary".to_string(),
            ColorStyleData::solid(Color::from_rgb8(27, 203, 85)),
        );

        lib.add(style1).unwrap();
        lib.add(style2).unwrap();

        assert_eq!(lib.len(), 2);
        let all = lib.list_all();
        assert_eq!(all[0].name, "Primary");
        assert_eq!(all[1].name, "Secondary");
    }

    #[test]
    fn duplicate_names_rejected() {
        let mut lib = StyleLibrary::new();
        let style1 = Style::new_color(
            StyleId::new("c1"),
            "Test".to_string(),
            ColorStyleData::solid(Color::WHITE),
        );
        let style2 = Style::new_color(
            StyleId::new("c2"),
            "Test".to_string(),
            ColorStyleData::solid(Color::BLACK),
        );

        lib.add(style1).unwrap();
        assert!(lib.add(style2).is_err());
        assert_eq!(lib.len(), 1);
    }

    #[test]
    fn update_style_data() {
        let mut lib = StyleLibrary::new();
        let style = Style::new_color(
            StyleId::new("c1"),
            "Accent".to_string(),
            ColorStyleData::solid(Color::from_rgb8(0, 0, 255)),
        );
        lib.add(style).unwrap();

        let new_data = StyleData::Color(ColorStyleData::solid(Color::from_rgb8(255, 0, 0)));
        lib.update(&StyleId::new("c1"), new_data).unwrap();

        let updated = lib.get(&StyleId::new("c1")).unwrap();
        if let StyleData::Color(data) = &updated.data {
            assert_eq!(data.paint, Paint::Solid(Color::from_rgb8(255, 0, 0)));
        } else {
            panic!("Expected Color style");
        }
    }

    #[test]
    fn style_usage_tracking() {
        let mut usage = StyleUsage::new();
        let style_id = StyleId::new("s1");

        usage.add_usage(style_id.clone(), "node1".to_string());
        usage.add_usage(style_id.clone(), "node2".to_string());
        usage.add_usage(StyleId::new("s2"), "node3".to_string());

        // The index is real, so removal is observable: `node1` goes, `node2`
        // stays, and an unrelated style's users are untouched.
        usage.remove_usage(&style_id, "node1");
        let mut users = usage.get_users(&style_id);
        users.sort();
        assert_eq!(users, vec!["node2".to_string()]);
        assert_eq!(
            usage.get_users(&StyleId::new("s2")),
            vec!["node3".to_string()]
        );

        // dropping the last user removes the entry, so an unused style stops
        // showing up as "referenced" in the linter
        usage.remove_usage(&style_id, "node2");
        assert!(usage.get_users(&style_id).is_empty());
    }

    #[test]
    fn import_with_prefix() {
        let mut source = StyleLibrary::new();
        source
            .add(Style::new_color(
                StyleId::new("c1"),
                "Blue".to_string(),
                ColorStyleData::solid(Color::from_rgb8(0, 0, 255)),
            ))
            .unwrap();

        let mut dest = StyleLibrary::new();
        let count = dest.import(&source, Some("Library"));

        assert_eq!(count, 1);
        let imported = dest.get_by_name("Library/Blue").unwrap();
        assert_eq!(imported.library_id, None); // library_id comes from source style
    }
}
