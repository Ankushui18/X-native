//! Vector Networks & Planar Geometry (Phase 1 Subsystem Specification)
//!
//! Decoupled from specific math engines via traits.
//! Regions are derived from planar graph traversal rather than stored as arbitrary closed loops.

use std::collections::HashMap;
use serde::{Deserialize, Serialize};

pub type VertexId = usize;
pub type EdgeId = usize;
pub type RegionId = usize;
pub type PaintId = usize;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum WindingRule {
    NonZero,
    EvenOdd,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum StrokeCap {
    None,
    Round,
    Square,
    Arrow,
    Triangle,
    ReverseTriangle,
    Diamond,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum StrokeJoin {
    Miter,
    Round,
    Bevel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Vertex {
    pub x: f64,
    pub y: f64,
    pub stroke_cap: Option<StrokeCap>,
    pub stroke_join: Option<StrokeJoin>,
    pub corner_radius: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Edge {
    pub start: VertexId,
    pub end: VertexId,
    pub tangent_start: Option<(f64, f64)>, // relative handle from start vertex
    pub tangent_end: Option<(f64, f64)>,   // relative handle from end vertex
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Region {
    pub winding_rule: WindingRule,
    pub loops: Vec<Vec<VertexId>>, // directed half-edge cycles
    pub paint_id: Option<PaintId>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct VectorNetwork {
    pub vertices: HashMap<VertexId, Vertex>,
    pub edges: HashMap<EdgeId, Edge>,
    pub regions: HashMap<RegionId, Region>,
    pub winding_rule: Option<WindingRule>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum GeometryError {
    InvalidTopology(String),
    IntersectionFailed(String),
    DegenerateGeometry,
}

/// Decoupled boolean operations trait (Phase 0 / Phase 1).
/// Allows swapping math engines (e.g. Lyon, Vello, CavalierContours, or custom planar solvers).
pub trait GeometryBoolean {
    fn union(&self, other: &Self) -> Result<VectorNetwork, GeometryError>;
    fn subtract(&self, other: &Self) -> Result<VectorNetwork, GeometryError>;
    fn intersect(&self, other: &Self) -> Result<VectorNetwork, GeometryError>;
    fn exclude(&self, other: &Self) -> Result<VectorNetwork, GeometryError>;
}
