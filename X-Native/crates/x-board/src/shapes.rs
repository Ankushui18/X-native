//! Simple shapes for Board - rectangle, circle, etc.
//! Simpler than Design shapes - no complex fills/effects

use crate::nodes::NodeId;
use serde::{Deserialize, Serialize};
use x_core::Transform;

/// Basic shape types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ShapeType {
    Rectangle { corner_radius: f32 },
    Circle,
    Triangle,
    Diamond,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoardShape {
    pub id: NodeId,
    pub shape_type: ShapeType,
    pub width: f32,
    pub height: f32,
    pub fill_color: Option<[f32; 4]>,
    pub stroke_color: Option<[f32; 4]>,
    pub stroke_width: f32,
    pub transform: Transform,
}

impl BoardShape {
    pub fn rectangle(x: f32, y: f32, width: f32, height: f32) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            shape_type: ShapeType::Rectangle { corner_radius: 0.0 },
            width,
            height,
            fill_color: Some([0.9, 0.9, 0.9, 1.0]),
            stroke_color: Some([0.3, 0.3, 0.3, 1.0]),
            stroke_width: 1.0,
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
        }
    }

    pub fn circle(x: f32, y: f32, diameter: f32) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            shape_type: ShapeType::Circle,
            width: diameter,
            height: diameter,
            fill_color: Some([0.9, 0.9, 0.9, 1.0]),
            stroke_color: Some([0.3, 0.3, 0.3, 1.0]),
            stroke_width: 1.0,
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
        }
    }

    pub fn with_fill(mut self, color: [f32; 4]) -> Self {
        self.fill_color = Some(color);
        self
    }

    pub fn with_stroke(mut self, color: [f32; 4], width: f32) -> Self {
        self.stroke_color = Some(color);
        self.stroke_width = width;
        self
    }
}
