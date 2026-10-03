//! Board-specific node types
//! Simpler than Design nodes - no Auto Layout, no Components

use crate::{BoardShape, StickyNote};
use glam::Vec2;
use serde::{Deserialize, Serialize};
use x_core::Transform;

/// Simple node ID type for board nodes
pub type NodeId = String;

/// Board node types - simpler than Design nodes
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BoardNode {
    /// Sticky note with text
    Sticky(StickyNote),
    /// Simple shape (rectangle, circle, etc.)
    Shape(BoardShape),
    /// Freeform pen drawing
    PenPath(PenPath),
    /// Text label (simpler than Design text)
    TextLabel(TextLabel),
    /// Image/Asset
    Image(BoardImage),
    /// Connector line (arrow, relationship line)
    ConnectorRef(ConnectorRef),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PenPath {
    pub id: NodeId,
    pub points: Vec<Vec2>,
    pub stroke_color: [f32; 4],
    pub stroke_width: f32,
    pub fill_color: Option<[f32; 4]>,
    pub transform: Transform,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextLabel {
    pub id: NodeId,
    pub text: String,
    pub font_size: f32,
    pub color: [f32; 4],
    pub transform: Transform,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoardImage {
    pub id: NodeId,
    pub asset_id: String,
    pub transform: Transform,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorRef {
    pub id: NodeId,
    /// Reference to connector in BoardPage.connectors
    pub connector_id: String,
}

impl BoardNode {
    pub fn id(&self) -> &NodeId {
        match self {
            Self::Sticky(s) => &s.id,
            Self::Shape(s) => &s.id,
            Self::PenPath(p) => &p.id,
            Self::TextLabel(t) => &t.id,
            Self::Image(i) => &i.id,
            Self::ConnectorRef(c) => &c.id,
        }
    }

    pub fn transform(&self) -> Option<&Transform> {
        match self {
            Self::Sticky(s) => Some(&s.transform),
            Self::Shape(s) => Some(&s.transform),
            Self::PenPath(p) => Some(&p.transform),
            Self::TextLabel(t) => Some(&t.transform),
            Self::Image(i) => Some(&i.transform),
            Self::ConnectorRef(_) => None, // Connectors don't have transforms
        }
    }

    pub fn transform_mut(&mut self) -> Option<&mut Transform> {
        match self {
            Self::Sticky(s) => Some(&mut s.transform),
            Self::Shape(s) => Some(&mut s.transform),
            Self::PenPath(p) => Some(&mut p.transform),
            Self::TextLabel(t) => Some(&mut t.transform),
            Self::Image(i) => Some(&mut i.transform),
            Self::ConnectorRef(_) => None, // Connectors don't have transforms
        }
    }

    /// Get bounding box for hit testing
    pub fn bounding_box(&self) -> x_core::Rect {
        use x_core::Rect;

        match self {
            Self::Sticky(s) => {
                let (w, h) = s.dimensions();
                Rect::new(
                    s.transform.x,
                    s.transform.y,
                    s.transform.x + w as f64,
                    s.transform.y + h as f64,
                )
            }
            Self::Shape(shape) => {
                match &shape.shape_type {
                    crate::ShapeType::Rectangle { .. } | crate::ShapeType::Diamond => Rect::new(
                        shape.transform.x,
                        shape.transform.y,
                        shape.transform.x + shape.width as f64,
                        shape.transform.y + shape.height as f64,
                    ),
                    crate::ShapeType::Circle => {
                        // Board rendering treats transform.x/y as the
                        // top-left of the circle's box, not its centre. The
                        // old hit box subtracted a radius and therefore made
                        // the visible node difficult to select (and made the
                        // connector attachment disagree with the painter).
                        Rect::new(
                            shape.transform.x,
                            shape.transform.y,
                            shape.transform.x + shape.width as f64,
                            shape.transform.y + shape.height as f64,
                        )
                    }
                    crate::ShapeType::Triangle => Rect::new(
                        shape.transform.x,
                        shape.transform.y,
                        shape.transform.x + shape.width as f64,
                        shape.transform.y + shape.height as f64,
                    ),
                }
            }
            Self::PenPath(p) => {
                // Compute bounds from points
                if p.points.is_empty() {
                    return Rect::new(0.0, 0.0, 0.0, 0.0);
                }
                let mut min_x = f64::MAX;
                let mut min_y = f64::MAX;
                let mut max_x = f64::MIN;
                let mut max_y = f64::MIN;

                for pt in &p.points {
                    min_x = min_x.min(pt.x as f64);
                    min_y = min_y.min(pt.y as f64);
                    max_x = max_x.max(pt.x as f64);
                    max_y = max_y.max(pt.y as f64);
                }

                // The painter adds the node transform to every local point;
                // include the same origin in hit-testing and selection bounds.
                Rect::new(
                    min_x + p.transform.x,
                    min_y + p.transform.y,
                    max_x + p.transform.x,
                    max_y + p.transform.y,
                )
            }
            Self::TextLabel(t) => {
                // Approximate text bounds
                let approx_width = (t.text.len() as f32 * t.font_size * 0.6) as f64;
                let height = t.font_size as f64 * 1.2;
                Rect::new(
                    t.transform.x,
                    t.transform.y,
                    t.transform.x + approx_width,
                    t.transform.y + height,
                )
            }
            Self::Image(i) => {
                // Default image size if not specified
                Rect::new(
                    i.transform.x,
                    i.transform.y,
                    i.transform.x + 100.0,
                    i.transform.y + 100.0,
                )
            }
            Self::ConnectorRef(_) => {
                // Connectors handled separately
                Rect::new(0.0, 0.0, 0.0, 0.0)
            }
        }
    }
}
