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
use crate::node::{TextCase, TextDecoration};
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

/// Text style — named text properties
#[derive(Debug, Clone, PartialEq)]
pub struct TextStyleData {
    pub font_family: String,
    pub font_weight: u16,    // 100-900
    pub font_size: f64,      // points
    pub line_height: f64,    // 0 = auto
    pub letter_spacing: f64, // em units
    pub paragraph_spacing: f64,
    pub text_case: TextCase,
    pub text_decoration: TextDecoration,
}

// `TextCase` / `TextDecoration` live in `node.rs` — they are the node's
// text model, and named Text styles carry the very same enums. A second
// copy here (with a divergent variant list) was a silent fork: styles
// could state a decoration the node model could not represent.

impl Default for TextStyleData {
    fn default() -> Self {
        Self {
            font_family: "Inter".to_string(),
            font_weight: 400,
            font_size: 16.0,
            line_height: 0.0,
            letter_spacing: 0.0,
            paragraph_spacing: 0.0,
            text_case: crate::node::TextCase::Original,
            text_decoration: TextDecoration::None,
        }
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
