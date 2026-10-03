//! Vector Networks & Planar Geometry (Phase 1 Subsystem Specification)
//!
//! Decoupled from specific math engines via traits.
//! Regions are derived from planar graph traversal rather than stored as arbitrary closed loops.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
pub enum VertexStrokeCap {
    None,
    Round,
    Square,
    Arrow,
    Triangle,
    ReverseTriangle,
    Diamond,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum VertexStrokeJoin {
    Miter,
    Round,
    Bevel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Vertex {
    pub x: f64,
    pub y: f64,
    pub stroke_cap: Option<VertexStrokeCap>,
    pub stroke_join: Option<VertexStrokeJoin>,
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

// =====================================================================
// Planar graph analysis — derived geometry (Phase 1)
// =====================================================================
//
// The VectorNetwork stores what the author drew: vertices, edges, regions
// (named loops) and a winding rule. Everything in this section is
// *derived on demand* from the planar embedding and is never persisted:
//
//   * faces   — bounded + unbounded regions of the subdivision, found by
//               half-edge face walking
//   * winding — per-face algebraic winding number (all authored loops)
//   * filled  — per-face inside/outside decision under the winding rule
//   * holes   — unfilled faces enclosed by filled faces
//
// Because fill is a property of the embedding rather than of any single
// stored path, hit-testing, boolean topology and Shape Builder work are
// mathematically sound: hole loops, touching edges and nested same-wind
// loops all resolve with SVG/Figma winding semantics (NonZero vs EvenOdd).
//
// Preconditions: the edges must form a valid *planar embedding*, i.e.
// edges only meet at shared endpoints. Interior crossings must be split
// into new vertices first (the arrangement step — the node-level engine
// in booleans.rs performs it for the PathCmd representation). `validate`
// checks endpoint integrity and self-loops; crossing splitting is the
// arrangement's job, and feeding its output into this analyzer is what
// keeps results sound.

use std::f64::consts::PI;

/// Directed half-edge. `2*i` follows edge `i` from its start to its end;
/// `2*i+1` follows it backwards.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct HalfEdge(pub u32);

impl HalfEdge {
    #[inline]
    pub fn edge_index(self) -> usize {
        (self.0 / 2) as usize
    }
    /// The half-edge on the same edge in the opposite direction.
    #[inline]
    pub fn twin(self) -> Self {
        HalfEdge(self.0 ^ 1)
    }
    #[inline]
    pub fn is_forward(self) -> bool {
        self.0.is_multiple_of(2)
    }
}

/// One face (plane region) of the planar subdivision.
#[derive(Debug, Clone)]
pub struct Face {
    /// Boundary half-edges in traversal order.
    pub loop_halfedges: Vec<HalfEdge>,
    /// Signed area in document (y-down) coordinates. The unbounded face
    /// has the largest absolute area, opposite in sign to the bounded
    /// faces.
    pub area: f64,
    /// A point strictly inside the face (midpoint of the first boundary
    /// edge, pushed a hair into the face interior). Used for winding and
    /// containment queries; never meaningful on the boundary.
    pub sample: (f64, f64),
    /// The vertices of the boundary, in traversal order (the last vertex
    /// is repeated at the start so the loop is explicitly closed).
    pub vertices: Vec<(f64, f64)>,
}

/// Derived planar analysis of a `VectorNetwork`. Recompute after every
/// topology change; never store it in the document.
///
/// `faces` are *face cells*: one record per boundary cycle produced by the
/// half-edge walk. For connected edge sets a cell is a true face. For
/// disconnected components (e.g. a hole = a nested closed loop sharing no
/// vertices) one topological face may appear as several cells; the
/// authoritative point queries below (`point_is_filled`, `winding_at`,
/// `region_at`) are computed directly from the authored loops and are
/// exact for any topology.
#[derive(Debug, Clone)]
pub struct PlanarAnalysis {
    pub faces: Vec<Face>,
    /// Index of a face cell of the unbounded region: the first cell with
    /// negative signed area (bounded cells are positive in raw y-down
    /// coordinates). Falls back to 0 for degenerate (all-zero-area) input.
    pub outer: usize,
    /// Algebraic winding number of each cell's sample point with respect
    /// to all authored loops (positive = counterclockwise in raw
    /// coordinates).
    pub winding: Vec<i32>,
    /// Winding-rule fill decision at each cell's sample point. For
    /// disconnected components this is the local fill of the cell's region.
    pub filled: Vec<bool>,
    pub rule: WindingRule,
}

// ------------------------------------------------------------------
// Small geometry primitives (std only; no external math library)
// ------------------------------------------------------------------

/// Angle of `a -> b` in the y-up frame (flip document y for atan2 so that
/// turn conventions match the mathematical plane).
#[inline]
fn yup_angle(a: (f64, f64), b: (f64, f64)) -> f64 {
    f64::atan2(-(b.1 - a.1), b.0 - a.0)
}

/// Winding number of point `p` with respect to the closed polyline `loop`
/// (first and last point need not match; the closing segment is implicit).
/// Ray casting toward +x with signed crossings. Returns 0 for empty loops.
pub fn winding_number(loop_points: &[(f64, f64)], p: (f64, f64)) -> i32 {
    let n = loop_points.len();
    if n < 3 {
        return 0;
    }
    let mut w: i32 = 0;
    for i in 0..n {
        let a = loop_points[i];
        let b = loop_points[(i + 1) % n];
        if (a.1 > p.1) != (b.1 > p.1) {
            let t = (p.1 - a.1) / (b.1 - a.1);
            let x = a.0 + t * (b.0 - a.0);
            if x > p.0 {
                w += if b.1 > a.1 { 1 } else { -1 };
            }
        }
    }
    w
}

/// Even-odd containment of `p` in the closed polyline (boundary excluded).
pub fn point_in_loop(loop_points: &[(f64, f64)], p: (f64, f64)) -> bool {
    let n = loop_points.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    for i in 0..n {
        let a = loop_points[i];
        let b = loop_points[(i + 1) % n];
        if (a.1 > p.1) != (b.1 > p.1) {
            let t = (p.1 - a.1) / (b.1 - a.1);
            let x = a.0 + t * (b.0 - a.0);
            if x > p.0 {
                inside = !inside;
            }
        }
    }
    inside
}

/// Signed area of a closed polyline (raw coordinates).
pub fn loop_signed_area(loop_points: &[(f64, f64)]) -> f64 {
    let n = loop_points.len();
    if n < 3 {
        return 0.0;
    }
    let mut s = 0.0;
    for i in 0..n {
        let a = loop_points[i];
        let b = loop_points[(i + 1) % n];
        s += a.0 * b.1 - b.0 * a.1;
    }
    s / 2.0
}

/// Flatten one authored edge (optionally a cubic) into a polyline.
fn flatten_edge(
    a: (f64, f64),
    b: (f64, f64),
    tangent_start: Option<(f64, f64)>,
    tangent_end: Option<(f64, f64)>,
) -> Vec<(f64, f64)> {
    let (Some(t1), Some(t2)) = (tangent_start, tangent_end) else {
        return vec![a, b];
    };
    let c1 = (a.0 + t1.0, a.1 + t1.1);
    let c2 = (b.0 + t2.0, b.1 + t2.1);
    // Adaptive subdivision: 4 is visually negligible for editing purposes;
    // winding/hit-testing only need the polyline to stay within a small
    // fraction of the control polygon.
    let mut out = Vec::with_capacity(17);
    for i in 0..=4 {
        let t = i as f64 / 4.0;
        let u = 1.0 - t;
        let x = u * u * u * a.0 + 3.0 * u * u * t * c1.0 + 3.0 * u * t * t * c2.0 + t * t * t * b.0;
        let y = u * u * u * a.1 + 3.0 * u * u * t * c1.1 + 3.0 * u * t * t * c2.1 + t * t * t * b.1;
        out.push((x, y));
    }
    out
}

impl VectorNetwork {
    /// Structural validation of the planar embedding: every edge endpoint
    /// exists and no edge is a self-loop.
    pub fn validate(&self) -> Result<(), GeometryError> {
        for (id, e) in &self.edges {
            if !self.vertices.contains_key(&e.start) {
                return Err(GeometryError::InvalidTopology(format!(
                    "edge {id} references unknown vertex {}",
                    e.start
                )));
            }
            if !self.vertices.contains_key(&e.end) {
                return Err(GeometryError::InvalidTopology(format!(
                    "edge {id} references unknown vertex {}",
                    e.end
                )));
            }
            if e.start == e.end {
                return Err(GeometryError::DegenerateGeometry);
            }
        }
        Ok(())
    }

    /// All authored loops (from stored regions) flattened to polylines, in
    /// sorted region id / loop order (deterministic). Loops that reference
    /// missing edges are a topology error.
    pub fn authored_loops(&self) -> Result<Vec<Vec<(f64, f64)>>, GeometryError> {
        // (start, end) -> edge index, first match in id order (deterministic).
        let mut by_pair: HashMap<(VertexId, VertexId), &Edge> = HashMap::new();
        let mut ids: Vec<&EdgeId> = self.edges.keys().collect();
        ids.sort();
        for id in ids {
            let e = &self.edges[id];
            by_pair.entry((e.start, e.end)).or_insert(e);
        }
        let pos = |v: VertexId| -> Result<(f64, f64), GeometryError> {
            self.vertices.get(&v).map(|p| (p.x, p.y)).ok_or_else(|| {
                GeometryError::InvalidTopology(format!("loop references unknown vertex {v}"))
            })
        };
        let mut region_ids: Vec<&RegionId> = self.regions.keys().collect();
        region_ids.sort();
        let mut loops = Vec::new();
        for rid in region_ids {
            let region = &self.regions[rid];
            for loop_vids in &region.loops {
                if loop_vids.len() < 3 {
                    return Err(GeometryError::InvalidTopology(
                        "authored loop with fewer than 3 vertices".into(),
                    ));
                }
                let mut poly: Vec<(f64, f64)> = Vec::new();
                for i in 0..loop_vids.len() {
                    let a = loop_vids[i];
                    let b = loop_vids[(i + 1) % loop_vids.len()];
                    let e = by_pair.get(&(a, b)).ok_or_else(|| {
                        GeometryError::InvalidTopology(format!("loop edge {a} -> {b} has no edge"))
                    })?;
                    let pts = flatten_edge(pos(a)?, pos(b)?, e.tangent_start, e.tangent_end);
                    if i == 0 {
                        poly.extend(pts);
                    } else {
                        poly.extend(pts.iter().skip(1));
                    }
                }
                loops.push(poly);
            }
        }
        Ok(loops)
    }

    /// Half-edge face walking over the edge set. Deterministic; returns
    /// faces with the unbounded face last.
    fn walk_faces(&self) -> Result<Vec<Face>, GeometryError> {
        let mut edge_ids: Vec<EdgeId> = self.edges.keys().cloned().collect();
        edge_ids.sort();
        let n = edge_ids.len();

        let mut pos = Vec::with_capacity(n);
        let mut vids = Vec::with_capacity(n);
        for id in &edge_ids {
            let e = &self.edges[id];
            let a = self.vertices.get(&e.start).ok_or_else(|| {
                GeometryError::InvalidTopology(format!(
                    "edge {id} references unknown vertex {}",
                    e.start
                ))
            })?;
            let b = self.vertices.get(&e.end).ok_or_else(|| {
                GeometryError::InvalidTopology(format!(
                    "edge {id} references unknown vertex {}",
                    e.end
                ))
            })?;
            pos.push(((a.x, a.y), (b.x, b.y), e.tangent_start, e.tangent_end));
            vids.push((e.start, e.end));
        }

        // Outgoing half-edges per vertex, sorted by y-up angle, ties broken
        // by half-edge index for determinism (coincident edges).
        let mut out: HashMap<VertexId, Vec<(f64, u32)>> = HashMap::new();
        for i in 0..n {
            let (a, b, _, _) = pos[i];
            out.entry(self.edges[&edge_ids[i]].start)
                .or_default()
                .push((yup_angle(a, b), (2 * i) as u32));
            out.entry(self.edges[&edge_ids[i]].end)
                .or_default()
                .push((yup_angle(b, a), (2 * i + 1) as u32));
        }
        for list in out.values_mut() {
            list.sort_by(|x, y| {
                x.0.partial_cmp(&y.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| x.1.cmp(&y.1))
            });
        }

        // next(h): h = u -> v. Reverse direction at v points v -> u. The
        // face is kept on the RIGHT in the y-up frame, so the next
        // half-edge is the one leaving v with the largest clockwise turn
        // from the reverse direction.
        let next_of = |h: HalfEdge| -> Option<HalfEdge> {
            let i = h.edge_index();
            let (vs, ve) = vids[i];
            let v = if h.is_forward() { ve } else { vs }; // tail vertex id
            let tail_pt = if h.is_forward() { pos[i].1 } else { pos[i].0 };
            let head_pt = if h.is_forward() { pos[i].0 } else { pos[i].1 };
            let rev = yup_angle(tail_pt, head_pt);
            let list = out.get(&v)?;
            let best: Option<(f64, u32)> = list
                .iter()
                .copied()
                .filter(|(_, idx)| *idx != h.0 && *idx != h.twin().0)
                .max_by(|x, y| {
                    let cx = (rev - x.0).rem_euclid(2.0 * PI);
                    let cy = (rev - y.0).rem_euclid(2.0 * PI);
                    cx.partial_cmp(&cy).unwrap_or(std::cmp::Ordering::Equal)
                });
            best.map(|(_, idx)| HalfEdge(idx))
        };

        let mut visited = vec![false; 2 * n];
        let mut faces: Vec<Vec<HalfEdge>> = Vec::new();
        for start in 0..2 * n {
            if visited[start] {
                continue;
            }
            let mut h = HalfEdge(start as u32);
            let mut loop_h: Vec<HalfEdge> = Vec::new();
            loop {
                if visited[h.0 as usize] {
                    return Err(GeometryError::InvalidTopology(
                        "face walk reached a visited half-edge; the edge set is not a planar embedding".into(),
                    ));
                }
                visited[h.0 as usize] = true;
                loop_h.push(h);
                match next_of(h) {
                    Some(nh) => {
                        if nh.0 as usize == start {
                            break;
                        }
                        h = nh;
                    }
                    None => {
                        // Single-edge vertex pair with no fan-out: the walk
                        // closes immediately (degenerate sliver face).
                        break;
                    }
                }
            }
            faces.push(loop_h);
        }

        // Build Face records.
        let face_records: Vec<Face> = faces
            .iter()
            .map(|loop_h| {
                let mut vertices: Vec<(f64, f64)> = loop_h
                    .iter()
                    .map(|h| {
                        let i = h.edge_index();
                        if h.is_forward() {
                            pos[i].0
                        } else {
                            pos[i].1
                        }
                    })
                    .collect();
                vertices.push(vertices[0]); // close explicitly
                let area = loop_signed_area(&vertices);
                // Sample: midpoint of first edge, pushed into the face.
                // Face is on the right in y-up frame == on the LEFT in raw
                // (y-down) coordinates: left normal of travel (dx,dy) is
                // (-dy, dx).
                let a = vertices[0];
                let b = vertices[1];
                let len = ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();
                let eps = 1e-6 * len.max(1e-9);
                let sample = if len > 0.0 {
                    let nx = -(b.1 - a.1) / len * eps;
                    let ny = (b.0 - a.0) / len * eps;
                    ((a.0 + b.0) / 2.0 + nx, (a.1 + b.1) / 2.0 + ny)
                } else {
                    a
                };
                Face {
                    loop_halfedges: loop_h.clone(),
                    area,
                    sample,
                    vertices,
                }
            })
            .collect();

        Ok(face_records)
    }

    /// A bounded face cell is traversed so that the face is on the LEFT in
    /// raw (y-down) coordinates -> positive signed area. Cells of the
    /// unbounded region are traversed the other way -> negative signed
    /// area. (Empirically pinned by the square test: interior +400,
    /// exterior -400.) Degenerate zero-area cells are treated as bounded.
    fn outer_face_index(faces: &[Face]) -> usize {
        faces.iter().position(|f| f.area < 0.0).unwrap_or(0)
    }
}

impl VectorNetwork {
    /// Full derived analysis: faces, winding, fill, holes — recomputed from
    /// the current embedding. Callers should cache the result per document
    /// version and invalidate on topology changes; per-point hit-testing
    /// through `point_is_filled` re-derives (fine for occasional queries).
    pub fn analyze(&self) -> Result<PlanarAnalysis, GeometryError> {
        self.validate()?;
        let faces = self.walk_faces()?;
        let loops = self.authored_loops()?;
        let rule = self.winding_rule.unwrap_or(WindingRule::NonZero);
        let outer = Self::outer_face_index(&faces);

        // Empty edge set: a single synthetic unbounded cell.
        let mut faces = faces;
        if faces.is_empty() {
            faces.push(Face {
                loop_halfedges: Vec::new(),
                area: 0.0,
                sample: (0.0, 0.0),
                vertices: Vec::new(),
            });
        }

        let winding: Vec<i32> = faces
            .iter()
            .map(|f| {
                let mut w: i32 = 0;
                for loop_pts in &loops {
                    w += winding_number(loop_pts, f.sample);
                }
                w
            })
            .collect();

        let filled: Vec<bool> = winding
            .iter()
            .map(|&w| match rule {
                WindingRule::NonZero => w != 0,
                WindingRule::EvenOdd => w.rem_euclid(2) != 0,
            })
            .collect();

        Ok(PlanarAnalysis {
            faces,
            outer,
            winding,
            filled,
            rule,
        })
    }

    /// Hit-testing: is `p` inside a filled area of the network under its
    /// winding rule? Exact for any topology (connected or not): the fill
    /// is the algebraic winding number of `p` over all authored loops.
    /// Points exactly on a boundary are treated as outside.
    pub fn point_is_filled(&self, p: (f64, f64)) -> Result<bool, GeometryError> {
        self.validate()?;
        let loops = self.authored_loops()?;
        let w = Self::winding_at_loops(&loops, p);
        let rule = self.winding_rule.unwrap_or(WindingRule::NonZero);
        Ok(match rule {
            WindingRule::NonZero => w != 0,
            WindingRule::EvenOdd => w.rem_euclid(2) != 0,
        })
    }

    /// Raw algebraic winding number of `p` over all authored loops
    /// (positive = counterclockwise in raw y-down coordinates).
    pub fn winding_at(&self, p: (f64, f64)) -> Result<i32, GeometryError> {
        self.validate()?;
        let loops = self.authored_loops()?;
        Ok(Self::winding_at_loops(&loops, p))
    }

    fn winding_at_loops(loops: &[Vec<(f64, f64)>], p: (f64, f64)) -> i32 {
        let mut w: i32 = 0;
        for loop_pts in loops {
            w += winding_number(loop_pts, p);
        }
        w
    }

    /// The stored region whose territory contains `p`: the first region
    /// (in id order) in which `p` lies inside an ODD number of the
    /// region's loops. A region with loops [outer, hole1, hole2] is the
    /// territory outer XOR hole1 XOR hole2 — the standard vector region
    /// definition. Points on boundaries or outside every region -> None.
    pub fn region_at(&self, p: (f64, f64)) -> Result<Option<RegionId>, GeometryError> {
        self.validate()?;
        let loops = self.authored_loops()?;
        let mut rids: Vec<RegionId> = self.regions.keys().cloned().collect();
        rids.sort();
        let mut offset = 0;
        for rid in rids {
            let region = &self.regions[&rid];
            let mut count = 0;
            for j in 0..region.loops.len() {
                if point_in_loop(&loops[offset + j], p) {
                    count += 1;
                }
            }
            offset += region.loops.len();
            if count % 2 == 1 {
                return Ok(Some(rid));
            }
        }
        Ok(None)
    }

    /// The face cell (from `analyze`) strictly containing `p`: `p` must be
    /// on the left side (raw y-down coordinates) of every boundary
    /// half-edge of the cell. Points on boundaries return None.
    pub fn face_at(&self, p: (f64, f64)) -> Result<Option<usize>, GeometryError> {
        let a = self.analyze()?;
        let edge_ids = Self::sorted_edge_ids(self);
        for (i, f) in a.faces.iter().enumerate() {
            if f.loop_halfedges.is_empty() {
                continue;
            }
            let mut ok = true;
            'edges: for &h in &f.loop_halfedges {
                let e = match self.edges.get(&edge_ids[h.edge_index()]) {
                    Some(e) => e,
                    None => continue 'edges,
                };
                let (a_pt, b_pt, ts, te) = if h.is_forward() {
                    (
                        self.vp(e.start)?,
                        self.vp(e.end)?,
                        e.tangent_start,
                        e.tangent_end,
                    )
                } else {
                    (
                        self.vp(e.end)?,
                        self.vp(e.start)?,
                        e.tangent_end,
                        e.tangent_start,
                    )
                };
                let poly = flatten_edge(a_pt, b_pt, ts, te);
                for k in 0..poly.len().saturating_sub(1) {
                    let seg_a = poly[k];
                    let seg_b = poly[k + 1];
                    let cross = (seg_b.0 - seg_a.0) * (p.1 - seg_a.1)
                        - (seg_b.1 - seg_a.1) * (p.0 - seg_a.0);
                    if cross <= 0.0 {
                        ok = false;
                        break 'edges;
                    }
                }
            }
            if ok {
                return Ok(Some(i));
            }
        }
        Ok(None)
    }

    fn sorted_edge_ids(net: &VectorNetwork) -> Vec<EdgeId> {
        let mut ids: Vec<EdgeId> = net.edges.keys().cloned().collect();
        ids.sort();
        ids
    }

    fn vp(&self, v: VertexId) -> Result<(f64, f64), GeometryError> {
        self.vertices
            .get(&v)
            .map(|p| (p.x, p.y))
            .ok_or_else(|| GeometryError::InvalidTopology(format!("unknown vertex {v}")))
    }
}

#[cfg(test)]
pub(crate) mod planar_tests {
    //! Tests for the Phase-1 planar analysis + modifier evaluation.
    //!
    //! Coordinate convention: document space is y-down (as on screen).
    //! A "screen-clockwise" loop runs top-left -> top-right -> bottom-right
    //! -> bottom-left.

    use super::{Edge, GeometryError, PlanarAnalysis, Region, VectorNetwork, WindingRule};
    use std::collections::HashMap;

    /// Square centered at (cx, cy), half-size s. The loop runs screen-clockwise.
    /// Returns (network, loop vertex ids in order).
    pub(crate) fn square(cx: f64, cy: f64, s: f64) -> (VectorNetwork, Vec<usize>) {
        let pts = [
            (cx - s, cy - s),
            (cx + s, cy - s),
            (cx + s, cy + s),
            (cx - s, cy + s),
        ];
        let mut net = VectorNetwork::default();
        for (i, p) in pts.iter().enumerate() {
            net.vertices.insert(
                i,
                crate::Vertex {
                    x: p.0,
                    y: p.1,
                    stroke_cap: None,
                    stroke_join: None,
                    corner_radius: None,
                },
            );
        }
        for i in 0..4 {
            net.edges.insert(
                i,
                Edge {
                    start: i,
                    end: (i + 1) % 4,
                    tangent_start: None,
                    tangent_end: None,
                },
            );
        }
        net.regions.insert(
            0,
            Region {
                winding_rule: WindingRule::NonZero,
                loops: vec![vec![0, 1, 2, 3]],
                paint_id: Some(0),
            },
        );
        net.winding_rule = Some(WindingRule::NonZero);
        (net, vec![0, 1, 2, 3])
    }

    /// Square with a smaller concentric hole. `reversed` controls the hole
    /// loop orientation (true = opposite winding, the usual hole).
    pub(crate) fn square_with_hole(reversed: bool) -> VectorNetwork {
        let (mut net, _) = square(0.0, 0.0, 10.0);
        let o = 4usize;
        let inner = [(-5.0, -5.0), (5.0, -5.0), (5.0, 5.0), (-5.0, 5.0)];
        for (i, p) in inner.iter().enumerate() {
            net.vertices.insert(
                o + i,
                crate::Vertex {
                    x: p.0,
                    y: p.1,
                    stroke_cap: None,
                    stroke_join: None,
                    corner_radius: None,
                },
            );
        }
        let loop_dir: Vec<usize> = if reversed {
            vec![o, o + 3, o + 2, o + 1]
        } else {
            vec![o, o + 1, o + 2, o + 3]
        };
        for (i, v) in loop_dir.iter().enumerate() {
            let w = loop_dir[(i + 1) % 4];
            net.edges.insert(
                4 + i,
                Edge {
                    start: *v,
                    end: w,
                    tangent_start: None,
                    tangent_end: None,
                },
            );
        }
        net.regions.insert(
            1,
            Region {
                winding_rule: WindingRule::NonZero,
                loops: vec![loop_dir],
                paint_id: Some(1),
            },
        );
        net
    }

    pub(crate) fn filled_count(a: &PlanarAnalysis) -> usize {
        a.filled.iter().filter(|&&f| f).count()
    }

    // ------------------------------------------------------------------
    // Planar analysis
    // ------------------------------------------------------------------

    #[test]
    fn single_square_fills_interior() {
        let (net, _) = square(0.0, 0.0, 10.0);
        let a = net.analyze().unwrap();
        assert_eq!(a.faces.len(), 2, "square: inner + outer face");
        assert_eq!(filled_count(&a), 1);
        // outer face cell has negative signed area (raw y-down convention)
        assert!(a.faces[a.outer].area < 0.0);
        // center is filled, outside is not (exact winding queries)
        assert!(net.point_is_filled((0.0, 0.0)).unwrap());
        assert!(!net.point_is_filled((50.0, 50.0)).unwrap());
        assert_eq!(net.winding_at((0.0, 0.0)).unwrap().abs(), 1);
        assert_eq!(net.winding_at((50.0, 50.0)).unwrap(), 0);
        // the face cell containing the center is the inner one
        let face = net.face_at((0.0, 0.0)).unwrap().unwrap();
        assert_ne!(face, a.outer);
        assert!(a.filled[face]);
        // region lookup
        assert_eq!(net.region_at((0.0, 0.0)).unwrap(), Some(0));
    }

    #[test]
    fn loop_orientation_does_not_change_fill() {
        // Same square, loop authored counter-screen-clockwise: identical
        // embedding, must give identical fill.
        let (net, _) = square(0.0, 0.0, 10.0);
        let a = net.analyze().unwrap();
        // rebuild with reversed loop direction (edges reversed too)
        let mut rev = VectorNetwork::default();
        for (id, v) in net.vertices.iter() {
            rev.vertices.insert(*id, v.clone());
        }
        for (id, e) in net.edges.iter() {
            let _ = id;
            rev.edges.insert(
                e.start * 4 + e.end,
                Edge {
                    start: e.end,
                    end: e.start,
                    tangent_start: e.tangent_end,
                    tangent_end: e.tangent_start,
                },
            );
        }
        rev.regions.insert(
            0,
            Region {
                winding_rule: WindingRule::NonZero,
                loops: vec![vec![0, 3, 2, 1]],
                paint_id: Some(0),
            },
        );
        rev.winding_rule = Some(WindingRule::NonZero);
        let b = rev.analyze().unwrap();
        assert_eq!(a.faces.len(), b.faces.len());
        assert_eq!(a.filled.iter().filter(|&&f| f).count(), 1);
        assert_eq!(b.filled.iter().filter(|&&f| f).count(), 1);
        assert!(rev.point_is_filled((0.0, 0.0)).unwrap());
    }

    #[test]
    fn reversed_hole_is_unfilled_under_both_rules() {
        for rule in [WindingRule::NonZero, WindingRule::EvenOdd] {
            let mut net = square_with_hole(true);
            net.winding_rule = Some(rule);
            // face cells: each disconnected component contributes 2 (interior
            // + exterior cycle), so 4 cells total.
            let a = net.analyze().unwrap();
            assert_eq!(a.faces.len(), 4, "2 components x 2 cells");
            // exact point queries (winding-based, topology-agnostic)
            assert!(
                net.point_is_filled((7.5, 7.5)).unwrap(),
                "{rule:?}: ring filled"
            );
            assert!(
                !net.point_is_filled((0.0, 0.0)).unwrap(),
                "{rule:?}: hole unfilled"
            );
            assert_eq!(
                net.winding_at((0.0, 0.0)).unwrap(),
                0,
                "hole winding must be 0"
            );
            assert_eq!(net.winding_at((7.5, 7.5)).unwrap().abs(), 1);
            // territory lookup: ring and hole both sit in region 0's territory
            assert_eq!(net.region_at((7.5, 7.5)).unwrap(), Some(0));
            assert_eq!(net.region_at((0.0, 0.0)).unwrap(), Some(0));
            let _ = a;
        }
    }

    #[test]
    fn same_wind_nested_differs_by_rule() {
        // Inner loop with the SAME orientation: winding 2 inside it.
        let mut net = square_with_hole(false);
        net.winding_rule = Some(WindingRule::NonZero);
        let _ = net.analyze().unwrap();
        assert_eq!(net.winding_at((0.0, 0.0)).unwrap().abs(), 2);
        assert!(
            net.point_is_filled((0.0, 0.0)).unwrap(),
            "NonZero: winding 2 is filled"
        );

        let mut even = square_with_hole(false);
        even.winding_rule = Some(WindingRule::EvenOdd);
        assert!(
            !even.point_is_filled((0.0, 0.0)).unwrap(),
            "EvenOdd: winding 2 is unfilled"
        );
    }

    #[test]
    fn disjoint_squares_give_two_filled_faces() {
        let (mut net, _) = square(-20.0, 0.0, 5.0);
        let (other, _) = square(20.0, 0.0, 5.0);
        // merge (offset ids of the second)
        let offset = net.vertices.len();
        for (id, v) in other.vertices.iter() {
            net.vertices.insert(id + offset, v.clone());
        }
        for (id, e) in other.edges.iter() {
            let _ = id;
            net.edges.insert(
                100 + e.start,
                Edge {
                    start: e.start + offset,
                    end: e.end + offset,
                    tangent_start: e.tangent_start,
                    tangent_end: e.tangent_end,
                },
            );
        }
        let mut regions = HashMap::new();
        for (id, r) in net.regions.iter() {
            regions.insert(*id, r.clone());
        }
        regions.insert(
            1,
            Region {
                winding_rule: WindingRule::NonZero,
                loops: vec![vec![offset, offset + 1, offset + 2, offset + 3]],
                paint_id: Some(1),
            },
        );
        net.regions = regions;
        let a = net.analyze().unwrap();
        // 2 components x 2 cells
        assert_eq!(a.faces.len(), 4);
        assert_eq!(filled_count(&a), 2);
        assert!(net.point_is_filled((-20.0, 0.0)).unwrap());
        assert!(net.point_is_filled((20.0, 0.0)).unwrap());
        assert!(!net.point_is_filled((0.0, 0.0)).unwrap());
        assert_eq!(
            net.region_at((0.0, 0.0)).unwrap(),
            None,
            "between components: no territory"
        );
    }

    #[test]
    fn internal_edge_splits_face() {
        // 2x1 rectangle (corners (0,0),(2,0),(2,1),(0,1)) with an internal
        // edge at x=1. One authored loop (the outer rectangle). The face
        // walk must split the interior into two faces, both filled.
        let mut net = VectorNetwork::default();
        let pts = [
            (0.0, 0.0), // 0
            (1.0, 0.0), // 1
            (2.0, 0.0), // 2
            (2.0, 1.0), // 3
            (1.0, 1.0), // 4
            (0.0, 1.0), // 5
        ];
        for (i, p) in pts.iter().enumerate() {
            net.vertices.insert(
                i,
                crate::Vertex {
                    x: p.0,
                    y: p.1,
                    stroke_cap: None,
                    stroke_join: None,
                    corner_radius: None,
                },
            );
        }
        let loop_order = [0usize, 1, 2, 3, 4, 5];
        for i in 0..6 {
            net.edges.insert(
                i,
                Edge {
                    start: loop_order[i],
                    end: loop_order[(i + 1) % 6],
                    tangent_start: None,
                    tangent_end: None,
                },
            );
        }
        // internal edge 1 -> 4
        net.edges.insert(
            6,
            Edge {
                start: 1,
                end: 4,
                tangent_start: None,
                tangent_end: None,
            },
        );
        net.regions.insert(
            0,
            Region {
                winding_rule: WindingRule::NonZero,
                loops: vec![loop_order.to_vec()],
                paint_id: Some(0),
            },
        );
        net.winding_rule = Some(WindingRule::NonZero);
        let a = net.analyze().unwrap();
        // two bounded faces + the unbounded face
        assert_eq!(a.faces.len(), 3);
        assert_eq!(filled_count(&a), 2);
        assert!(net.point_is_filled((0.5, 0.5)).unwrap());
        assert!(net.point_is_filled((1.5, 0.5)).unwrap());
        assert!(!net.point_is_filled((3.0, 3.0)).unwrap());
    }

    #[test]
    fn validation_catches_bad_topology() {
        let (mut net, _) = square(0.0, 0.0, 5.0);
        net.edges.insert(
            99,
            Edge {
                start: 0,
                end: 999,
                tangent_start: None,
                tangent_end: None,
            },
        );
        match net.analyze() {
            Err(GeometryError::InvalidTopology(msg)) => assert!(msg.contains("unknown vertex")),
            other => panic!("expected InvalidTopology, got {other:?}"),
        }
        // self-loop
        let (mut net2, _) = square(0.0, 0.0, 5.0);
        net2.edges.insert(
            98,
            Edge {
                start: 0,
                end: 0,
                tangent_start: None,
                tangent_end: None,
            },
        );
        assert!(matches!(
            net2.validate(),
            Err(GeometryError::DegenerateGeometry)
        ));
    }

    #[test]
    fn empty_network_has_only_outer_face() {
        let net = VectorNetwork::default();
        let a = net.analyze().unwrap();
        assert_eq!(a.faces.len(), 1);
        assert_eq!(a.outer, 0);
        assert!(!net.point_is_filled((0.0, 0.0)).unwrap());
    }

    #[test]
    fn cubic_edges_flatten_for_winding() {
        // A "square" whose right side is actually a cubic bulging outward.
        // Winding/hit-testing must treat the flattened curve as the boundary.
        let mut net = VectorNetwork::default();
        let pts = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        for (i, p) in pts.iter().enumerate() {
            net.vertices.insert(
                i,
                crate::Vertex {
                    x: p.0,
                    y: p.1,
                    stroke_cap: None,
                    stroke_join: None,
                    corner_radius: None,
                },
            );
        }
        for i in 0..4 {
            let (ts, te) = if i == 1 {
                // right side, bulging to x=15
                (Some((4.0, 0.0)), Some((4.0, 0.0)))
            } else {
                (None, None)
            };
            net.edges.insert(
                i,
                Edge {
                    start: i,
                    end: (i + 1) % 4,
                    tangent_start: ts,
                    tangent_end: te,
                },
            );
        }
        net.regions.insert(
            0,
            Region {
                winding_rule: WindingRule::NonZero,
                loops: vec![vec![0, 1, 2, 3]],
                paint_id: Some(0),
            },
        );
        net.winding_rule = Some(WindingRule::NonZero);
        let a = net.analyze().unwrap();
        assert_eq!(filled_count(&a), 1);
        // point right of the flat x=10 line, inside the flattened bulge
        // (4-subdivision flattening reaches x=13 at mid-height)
        assert!(net.point_is_filled((12.0, 5.0)).unwrap());
        // well outside the bulge
        assert!(!net.point_is_filled((16.0, 5.0)).unwrap());
    }

    /// Zigzag square: bottom edge straight, top edge has a 0.1 bump.
    pub(crate) fn zigzag_square() -> VectorNetwork {
        let pts = [
            (0.0, 0.0), // 0 bottom-left
            (4.0, 0.0), // 1 bottom-right
            (4.0, 4.0), // 2 top-right
            (3.0, 4.0), // 3
            (2.5, 4.1), // 4 bump apex
            (2.0, 4.0), // 5
            (1.0, 4.0), // 6
            (0.0, 4.0), // 7 top-left
        ];
        let mut net = VectorNetwork::default();
        for (i, p) in pts.iter().enumerate() {
            net.vertices.insert(
                i,
                crate::Vertex {
                    x: p.0,
                    y: p.1,
                    stroke_cap: None,
                    stroke_join: None,
                    corner_radius: None,
                },
            );
        }
        for i in 0..pts.len() {
            net.edges.insert(
                i,
                Edge {
                    start: i,
                    end: (i + 1) % pts.len(),
                    tangent_start: None,
                    tangent_end: None,
                },
            );
        }
        net.regions.insert(
            0,
            Region {
                winding_rule: WindingRule::NonZero,
                loops: vec![vec![0, 1, 2, 3, 4, 5, 6, 7]],
                paint_id: Some(0),
            },
        );
        net.winding_rule = Some(WindingRule::NonZero);
        net
    }
}
