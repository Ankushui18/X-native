//! Connectors - lines/arrows that connect board objects
//! Stay attached when objects move

use crate::BoardNode;
use glam::Vec2;
use serde::{Deserialize, Serialize};

/// Simple node ID type for connectors
pub type NodeId = String;

/// Connector types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ConnectorType {
    /// Simple line
    Line,
    /// Arrow at end
    Arrow,
    /// Double-sided arrow
    DoubleArrow,
    /// Dashed line (relationship)
    Dashed,
    /// Curved bezier
    Curve,
}

/// How connector attaches to nodes
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AttachmentPoint {
    /// Attached to specific node side
    NodeSide(NodeId, Side),
    /// Attached to node center
    NodeCenter(NodeId),
    /// Free-floating point
    Free(Vec2),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Side {
    Top,
    Right,
    Bottom,
    Left,
}

/// A connector between two objects
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connector {
    pub id: String,
    pub from: AttachmentPoint,
    pub to: AttachmentPoint,
    pub connector_type: ConnectorType,
    pub stroke_color: [f32; 4],
    pub stroke_width: f32,
    /// Control points for curves
    pub control_points: Vec<Vec2>,
    /// Label on the connector (optional)
    pub label: Option<String>,
}

impl Connector {
    pub fn new(from: AttachmentPoint, to: AttachmentPoint, connector_type: ConnectorType) -> Self {
        Self {
            id: format!("connector-{}", uuid::Uuid::new_v4()),
            from,
            to,
            connector_type,
            stroke_color: [0.2, 0.2, 0.2, 1.0],
            stroke_width: 2.0,
            control_points: Vec::new(),
            label: None,
        }
    }

    /// Calculate current start point based on attachments
    pub fn start_point(&self, nodes: &std::collections::HashMap<String, BoardNode>) -> Vec2 {
        self.attachment_point_to_vec2(&self.from, nodes)
    }

    /// Calculate current end point based on attachments
    pub fn end_point(&self, nodes: &std::collections::HashMap<String, BoardNode>) -> Vec2 {
        self.attachment_point_to_vec2(&self.to, nodes)
    }

    fn attachment_point_to_vec2(
        &self,
        point: &AttachmentPoint,
        nodes: &std::collections::HashMap<String, BoardNode>,
    ) -> Vec2 {
        match point {
            AttachmentPoint::NodeCenter(node_id) => {
                if let Some(node) = nodes.get(node_id) {
                    // Get node center based on its transform
                    if let Some(t) = node.transform() {
                        Vec2::new(t.x as f32, t.y as f32)
                    } else {
                        Vec2::ZERO
                    }
                } else {
                    Vec2::ZERO
                }
            }
            AttachmentPoint::NodeSide(node_id, side) => {
                if let Some(node) = nodes.get(node_id) {
                    if let Some(t) = node.transform() {
                        let pos = Vec2::new(t.x as f32, t.y as f32);
                        // Simplified - would calculate actual bounds
                        match side {
                            Side::Top => pos + Vec2::new(0.0, -30.0),
                            Side::Right => pos + Vec2::new(30.0, 0.0),
                            Side::Bottom => pos + Vec2::new(0.0, 30.0),
                            Side::Left => pos + Vec2::new(-30.0, 0.0),
                        }
                    } else {
                        Vec2::ZERO
                    }
                } else {
                    Vec2::ZERO
                }
            }
            AttachmentPoint::Free(point) => *point,
        }
    }

    /// Update connector when a node moves
    pub fn update_on_node_move(&mut self, _moved_node_id: String, _new_pos: Vec2) {
        // Attachment points automatically recalculate on render
        // No need to store absolute positions
    }
}
