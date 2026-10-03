//! Sticky Notes - colored text cards for brainstorming

use crate::nodes::NodeId;
use serde::{Deserialize, Serialize};
use x_core::Transform;

/// A sticky note with text content
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StickyNote {
    pub id: NodeId,
    pub text: String,
    pub background_color: [f32; 4],
    pub text_color: [f32; 4],
    pub font_size: f32,
    pub width: f32,
    pub height: f32,
    pub transform: Transform,
    /// Optional style reference
    pub style_id: Option<String>,
}

impl StickyNote {
    pub fn new(text: &str, x: f32, y: f32) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            text: text.to_string(),
            background_color: [1.0, 0.95, 0.6, 1.0], // Default yellow
            text_color: [0.2, 0.2, 0.2, 1.0],
            font_size: 14.0,
            width: 180.0,
            height: 120.0,
            transform: Transform {
                x: x as f64,
                y: y as f64,
                rotation: 0.0,
                scale_x: 1.0,
                scale_y: 1.0,
                skew_x: 0.0,
                skew_y: 0.0,
                origin_x: 0.5,
                origin_y: 0.5,
            },
            style_id: None,
        }
    }

    pub fn with_color(mut self, bg: [f32; 4], fg: [f32; 4]) -> Self {
        self.background_color = bg;
        self.text_color = fg;
        self
    }

    pub fn with_style(mut self, style_id: &str) -> Self {
        self.style_id = Some(style_id.to_string());
        self
    }

    /// Auto-resize height based on text content
    pub fn auto_resize_height(&mut self) {
        let lines = self.text.split('\n').count();
        self.height = (lines as f32 * self.font_size * 1.5).max(60.0);
    }

    /// Get dimensions
    pub fn dimensions(&self) -> (f32, f32) {
        (self.width, self.height)
    }
}

impl StickyNote {
    /// Create a sticky note with explicit dimensions and color
    pub fn sticky(
        id: &str,
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        color_idx: usize,
        text: String,
    ) -> crate::BoardNode {
        use crate::BoardNode;

        let colors = [
            [1.0, 0.95, 0.6, 1.0], // Yellow
            [0.6, 0.8, 1.0, 1.0],  // Blue
            [0.7, 0.95, 0.7, 1.0], // Green
            [1.0, 0.8, 0.9, 1.0],  // Pink
        ];
        let bg = colors[color_idx % colors.len()];
        let fg = [0.2, 0.2, 0.2, 1.0];

        let sticky = StickyNote {
            id: id.to_string(),
            text,
            background_color: bg,
            text_color: fg,
            font_size: 14.0,
            width,
            height,
            transform: Transform {
                x: x as f64,
                y: y as f64,
                rotation: 0.0,
                scale_x: 1.0,
                scale_y: 1.0,
                skew_x: 0.0,
                skew_y: 0.0,
                origin_x: 0.5,
                origin_y: 0.5,
            },
            style_id: None,
        };

        BoardNode::Sticky(sticky)
    }

    /// Create a connector between two board nodes.
    ///
    /// Returns the `ConnectorRef` node to add to the page plus the `Connector`
    /// itself, which must be stored in `BoardPage.connectors` (the ref only
    /// points at it by id).
    pub fn connector(
        id: &str,
        from_node: String,
        to_node: String,
    ) -> (crate::BoardNode, crate::Connector) {
        use crate::{AttachmentPoint, Connector, ConnectorType};

        let mut connector = Connector::new(
            AttachmentPoint::NodeCenter(from_node),
            AttachmentPoint::NodeCenter(to_node),
            ConnectorType::Arrow,
        );
        connector.id = id.to_string();
        connector.stroke_color = [0.2, 0.2, 0.2, 1.0];
        connector.stroke_width = 2.0;

        let conn_ref = crate::nodes::ConnectorRef {
            id: id.to_string(),
            connector_id: connector.id.clone(),
        };

        (crate::BoardNode::ConnectorRef(conn_ref), connector)
    }
}
