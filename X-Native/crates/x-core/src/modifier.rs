//! Procedural Modifier Stack (Phase 1 Subsystem Specification)
//!
//! Non-destructive geometry operation graph evaluated on demand.
//! Base Geometry -> Modifier 1 -> Modifier 2 -> ... -> Evaluated Geometry.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VariableWidthPoint {
    pub position: f64, // 0.0 to 1.0 along the path
    pub width_multiplier: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VariableWidthProfile {
    pub points: Vec<VariableWidthPoint>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Modifier {
    RoundedCorners {
        radius: f64,
        smoothing: Option<f64>,
        corner_indices: Option<Vec<usize>>,
    },
    Offset {
        distance: f64,
        join: String, // "miter", "round", "bevel"
        miter_limit: Option<f64>,
    },
    Boolean {
        op: String, // "union", "subtract", "intersect", "exclude"
        target_id: Option<String>,
    },
    Stroke {
        width: f64,
        cap: String,
        join: String,
        miter_limit: Option<f64>,
        dashes: Option<Vec<f64>>,
        variable_width: Option<VariableWidthProfile>,
    },
    Transform {
        matrix: [f64; 6], // affine transform [a, b, c, d, tx, ty]
    },
    Simplify {
        tolerance: f64,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ModifierStack {
    pub modifiers: Vec<Modifier>,
}

impl ModifierStack {
    pub fn new() -> Self {
        Self {
            modifiers: Vec::new(),
        }
    }

    pub fn push(&mut self, modifier: Modifier) {
        self.modifiers.push(modifier);
    }

    pub fn remove(&mut self, index: usize) -> Option<Modifier> {
        if index < self.modifiers.len() {
            Some(self.modifiers.remove(index))
        } else {
            None
        }
    }
}
