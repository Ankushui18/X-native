//! Board-specific tools

use serde::{Deserialize, Serialize};

/// Board tool types
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub enum BoardTool {
    /// Select and move objects
    #[default]
    Select,
    /// Create sticky notes
    StickyNote,
    /// Draw connector/arrows
    Connector,
    /// Draw freeform pen
    Pen,
    /// Simple rectangle
    Rectangle,
    /// Circle/ellipse
    Circle,
    /// Text label
    Text,
    /// Hand tool for panning
    Hand,
    /// Zoom tool
    Zoom,
}

impl BoardTool {
    pub fn icon_name(&self) -> &'static str {
        match self {
            Self::Select => "cursor",
            Self::StickyNote => "sticky-note",
            Self::Connector => "arrow-right",
            Self::Pen => "pen-tool",
            Self::Rectangle => "square",
            Self::Circle => "circle",
            Self::Text => "type",
            Self::Hand => "hand",
            Self::Zoom => "zoom-in",
        }
    }

    pub fn tooltip(&self) -> &'static str {
        match self {
            Self::Select => "Select (V)",
            Self::StickyNote => "Sticky Note (S)",
            Self::Connector => "Connector (C)",
            Self::Pen => "Pen (P)",
            Self::Rectangle => "Rectangle (R)",
            Self::Circle => "Circle (O)",
            Self::Text => "Text (T)",
            Self::Hand => "Hand (H)",
            Self::Zoom => "Zoom (Z)",
        }
    }

    pub fn shortcut(&self) -> Option<char> {
        match self {
            Self::Select => Some('v'),
            Self::StickyNote => Some('s'),
            Self::Connector => Some('c'),
            Self::Pen => Some('p'),
            Self::Rectangle => Some('r'),
            Self::Circle => Some('o'),
            Self::Text => Some('t'),
            Self::Hand => Some('h'),
            Self::Zoom => Some('z'),
        }
    }
}
