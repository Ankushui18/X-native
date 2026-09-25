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

// =====================================================================
// Modifier evaluation pipeline (Phase 1)
// =====================================================================
//
// `ModifierStack::evaluate` recomputes the result geometry from the base
// network on demand — the base is never mutated (non-destructive by
// construction). Every modifier is a pure function
// `VectorNetwork -> Result<VectorNetwork, ModifierError>`, composed in
// stack order.
//
// Division of labor (explicit, per the blueprint's "define behavior"
// mandate):
//
// * `Transform` and `Simplify` are implemented here on the raw
//   `VectorNetwork` — pure std math, no external engine.
// * `Boolean`, `Offset`, `RoundedCorners` and `Stroke` require the
//   arrangement/offsetting engine that operates on the node-level path
//   representation (see booleans.rs). On a raw network they fail with
//   `ModifierError::RequiresGeometryEngine` instead of approximating —
//   loud failure beats silent wrong geometry.

use std::collections::HashMap;

use crate::vector_network::{Edge, GeometryError, Region, VectorNetwork, Vertex};

/// Error produced while evaluating a modifier stack.
#[derive(Debug, Clone, PartialEq)]
pub enum ModifierError {
    /// The operation needs the planar arrangement / offsetting engine
    /// (node-level paths). Not supported on a raw VectorNetwork.
    RequiresGeometryEngine { op: &'static str },
    /// Out-of-domain parameter (NaN, negative radius, ...).
    InvalidParameter { op: &'static str, detail: String },
    /// The base network is not a valid planar embedding.
    InvalidTopology(String),
}

impl std::fmt::Display for ModifierError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ModifierError::RequiresGeometryEngine { op } => write!(
                f,
                "modifier {op} requires the geometry engine (arrangement/offsetting) and is not supported on a raw VectorNetwork"
            ),
            ModifierError::InvalidParameter { op, detail } => {
                write!(f, "modifier {op} has an invalid parameter: {detail}")
            }
            ModifierError::InvalidTopology(detail) => {
                write!(f, "invalid topology: {detail}")
            }
        }
    }
}

fn op_name(m: &Modifier) -> &'static str {
    match m {
        Modifier::RoundedCorners { .. } => "RoundedCorners",
        Modifier::Offset { .. } => "Offset",
        Modifier::Boolean { .. } => "Boolean",
        Modifier::Stroke { .. } => "Stroke",
        Modifier::Transform { .. } => "Transform",
        Modifier::Simplify { .. } => "Simplify",
    }
}

impl ModifierStack {
    /// Recompute the modifier stack from `base`, applying modifiers in
    /// order. `base` is left untouched; an empty stack is the identity.
    pub fn evaluate(&self, base: &VectorNetwork) -> Result<VectorNetwork, ModifierError> {
        base.validate()
            .map_err(|e| ModifierError::InvalidTopology(format!("{e:?}")))?;
        let mut current = base.clone();
        for m in &self.modifiers {
            current = apply(&current, m)?;
        }
        Ok(current)
    }
}

fn apply(net: &VectorNetwork, m: &Modifier) -> Result<VectorNetwork, ModifierError> {
    match m {
        Modifier::Transform { matrix } => {
            if !matrix.iter().all(|v| v.is_finite()) {
                return Err(ModifierError::InvalidParameter {
                    op: "Transform",
                    detail: "matrix entries must be finite".into(),
                });
            }
            Ok(transform_net(net, *matrix))
        }
        Modifier::Simplify { tolerance } => {
            if !tolerance.is_finite() || *tolerance < 0.0 {
                return Err(ModifierError::InvalidParameter {
                    op: "Simplify",
                    detail: format!("tolerance must be finite and >= 0, got {tolerance}"),
                });
            }
            simplify_net(net, *tolerance)
                .map_err(|e| ModifierError::InvalidTopology(format!("{e:?}")))
        }
        Modifier::RoundedCorners { .. }
        | Modifier::Offset { .. }
        | Modifier::Boolean { .. }
        | Modifier::Stroke { .. } => Err(ModifierError::RequiresGeometryEngine { op: op_name(m) }),
    }
}

/// Affine transform `[a, b, c, d, tx, ty]`: (x, y) -> (a x + c y + tx,
/// b x + d y + ty). Tangent handles scale by the linear part.
fn transform_net(net: &VectorNetwork, m: [f64; 6]) -> VectorNetwork {
    let [a, b, c, d, tx, ty] = m;
    let map_pt = |p: (f64, f64)| (a * p.0 + c * p.1 + tx, b * p.0 + d * p.1 + ty);
    let map_vec = |v: (f64, f64)| (a * v.0 + c * v.1, b * v.0 + d * v.1);

    // Mean of the two axis scales: a defensible isotropic approximation
    // for radii under anisotropic transforms (exact anisotropic corner
    // radii are an engine-level concern).
    let sx = (a * a + b * b).sqrt();
    let sy = (c * c + d * d).sqrt();
    let radius_scale = (sx + sy) / 2.0;
    let vertices = net
        .vertices
        .iter()
        .map(|(id, v)| {
            let p = map_pt((v.x, v.y));
            (
                *id,
                Vertex {
                    x: p.0,
                    y: p.1,
                    stroke_cap: v.stroke_cap,
                    stroke_join: v.stroke_join,
                    corner_radius: v.corner_radius.map(|r| r * radius_scale),
                },
            )
        })
        .collect();
    let edges = net
        .edges
        .iter()
        .map(|(id, e)| {
            (
                *id,
                Edge {
                    start: e.start,
                    end: e.end,
                    tangent_start: e.tangent_start.map(map_vec),
                    tangent_end: e.tangent_end.map(map_vec),
                },
            )
        })
        .collect();
    let regions = net.regions.iter().map(|(id, r)| (*id, r.clone())).collect();
    VectorNetwork {
        vertices,
        edges,
        regions,
        winding_rule: net.winding_rule,
    }
}

// ------------------------------------------------------------------
// Simplify: Ramer–Douglas–Peucker over the flattened authored loops
// ------------------------------------------------------------------

fn perp_distance(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let dx = b.0 - a.0;
    let dy = b.1 - a.1;
    let len2 = dx * dx + dy * dy;
    if len2 == 0.0 {
        return ((p.0 - a.0).powi(2) + (p.1 - a.1).powi(2)).sqrt();
    }
    let t = ((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len2;
    let tc = t.clamp(0.0, 1.0);
    let qx = a.0 + tc * dx;
    let qy = a.1 + tc * dy;
    ((p.0 - qx).powi(2) + (p.1 - qy).powi(2)).sqrt()
}

/// RDP on an open chain; returns the indices of kept points (endpoints
/// always kept).
fn rdp_open(points: &[(f64, f64)], tol: f64) -> Vec<usize> {
    let n = points.len();
    if n < 3 {
        return (0..n).collect();
    }
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    let mut stack: Vec<(usize, usize)> = vec![(0, n - 1)];
    while let Some((lo, hi)) = stack.pop() {
        if hi - lo < 2 {
            continue;
        }
        let a = points[lo];
        let b = points[hi];
        let mut max_d = f64::NEG_INFINITY;
        let mut idx = lo;
        for i in (lo + 1)..hi {
            let d = perp_distance(points[i], a, b);
            if d > max_d {
                max_d = d;
                idx = i;
            }
        }
        if max_d > tol {
            keep[idx] = true;
            stack.push((lo, idx));
            stack.push((idx, hi));
        }
    }
    (0..n).filter(|&i| keep[i]).collect()
}

/// RDP on a closed loop; returns kept indices into the original loop.
fn rdp_closed(points: &[(f64, f64)], tol: f64) -> Vec<usize> {
    let n = points.len();
    if n < 3 {
        return (0..n).collect();
    }
    // Anchor: the point with the smallest x (deterministic tie-break).
    let p0 = (0..n)
        .min_by(|&i, &j| {
            points[i]
                .0
                .partial_cmp(&points[j].0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| i.cmp(&j))
        })
        .unwrap();
    // Open chain from p0 back to p0 (n segments, n+1 points, endpoints equal).
    let chain: Vec<(f64, f64)> = (0..=n).map(|k| points[(p0 + k) % n]).collect();
    let kept = rdp_open(&chain, tol);
    // Map chain indices (0 and n are the same original point) back.
    let mut out: Vec<usize> = kept
        .iter()
        .map(|&k| if k == 0 || k == n { p0 } else { (p0 + k) % n })
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

/// Rebuild the network from simplified authored loops. Contract:
///
/// * Output is polygonal: all curves are flattened (cubics become
///   straight chords between kept points). `Simplify` destroys curvature —
///   that is its purpose (point-count reduction / cleanup).
/// * A loop that would collapse below 3 distinct vertices keeps its
///   original shape.
/// * Content that exists only as edges without a region is dropped.
/// * Large tolerances relative to inter-loop spacing can produce chords
///   that cross other edges; re-run `analyze`/the arrangement before
///   boolean use.
fn simplify_net(net: &VectorNetwork, tolerance: f64) -> Result<VectorNetwork, GeometryError> {
    net.validate()?;
    let loops = net.authored_loops()?; // per (region, loop), in order

    let mut new_vertices: Vec<Vertex> = Vec::new();
    // Exact (f64, f64) -> id dedup. A Vec + linear scan instead of a
    // HashMap: f64 is not Eq, and simplification output is small, so
    // O(n^2) with a handful of hundred entries is cheap and exact.
    let mut coord_to_id: Vec<(f64, f64)> = Vec::new();
    let mut edges: HashMap<usize, Edge> = HashMap::new();
    let mut regions: HashMap<usize, Region> = HashMap::new();

    let mut rids: Vec<&usize> = net.regions.keys().collect();
    rids.sort();

    fn alloc(
        p: (f64, f64),
        coord_to_id: &mut Vec<(f64, f64)>,
        new_vertices: &mut Vec<Vertex>,
    ) -> usize {
        if let Some(i) = coord_to_id.iter().position(|q| q.0 == p.0 && q.1 == p.1) {
            return i;
        }
        new_vertices.push(Vertex {
            x: p.0,
            y: p.1,
            stroke_cap: None,
            stroke_join: None,
            corner_radius: None,
        });
        coord_to_id.push(p);
        new_vertices.len() - 1
    }

    fn new_edge(from: usize, to: usize, edges: &mut HashMap<usize, Edge>) {
        if from != to {
            edges.insert(
                edges.len(),
                Edge {
                    start: from,
                    end: to,
                    tangent_start: None,
                    tangent_end: None,
                },
            );
        }
    }

    let mut loop_cursor = 0usize; // into `loops`, same (sorted region, loop) order
    for rid in rids {
        let region = &net.regions[rid];
        let mut new_loops: Vec<Vec<usize>> = Vec::new();
        for loop_vids in &region.loops {
            let poly = &loops[loop_cursor];
            loop_cursor += 1;
            // Guard against degenerate flattening (zero-length loop).
            let mut distinct: Vec<(f64, f64)> = Vec::new();
            for p in poly {
                if !distinct.iter().any(|q| q.0 == p.0 && q.1 == p.1) {
                    distinct.push(*p);
                }
            }
            if tolerance <= 0.0 || distinct.len() < 3 {
                // Keep original shape: remap its vertices.
                let mut ids: Vec<usize> = Vec::with_capacity(loop_vids.len());
                for v in loop_vids {
                    let p = match net.vertices.get(v) {
                        Some(p) => (p.x, p.y),
                        None => {
                            return Err(GeometryError::InvalidTopology(format!(
                                "loop references unknown vertex {v}"
                            )))
                        }
                    };
                    let id = alloc(p, &mut coord_to_id, &mut new_vertices);
                    ids.push(id);
                }
                for i in 0..ids.len() {
                    new_edge(ids[i], ids[(i + 1) % ids.len()], &mut edges);
                }
                new_loops.push(ids);
                continue;
            }
            let kept = rdp_closed(poly, tolerance);
            if kept.len() < 3 {
                // Collapse protection: keep original shape.
                let mut ids: Vec<usize> = Vec::with_capacity(loop_vids.len());
                for v in loop_vids {
                    let p = match net.vertices.get(v) {
                        Some(p) => (p.x, p.y),
                        None => {
                            return Err(GeometryError::InvalidTopology(format!(
                                "loop references unknown vertex {v}"
                            )))
                        }
                    };
                    let id = alloc(p, &mut coord_to_id, &mut new_vertices);
                    ids.push(id);
                }
                for i in 0..ids.len() {
                    new_edge(ids[i], ids[(i + 1) % ids.len()], &mut edges);
                }
                new_loops.push(ids);
                continue;
            }
            // Kept points are polyline points; map to new vertex ids.
            // Polyline point k of this loop corresponds to poly[k].
            // rdp_closed returned indices into `poly` (the flattened
            // loop), not vertex ids — rebuild from the coordinates.
            let mut ids: Vec<usize> = Vec::with_capacity(kept.len());
            for &k in &kept {
                let p = poly[k];
                let id = alloc(p, &mut coord_to_id, &mut new_vertices);
                ids.push(id);
            }
            // Dedup consecutive (a kept point may equal its neighbor when
            // the loop had duplicate vertices).
            let mut deduped: Vec<usize> = Vec::new();
            for id in ids {
                if deduped.last() != Some(&id) {
                    deduped.push(id);
                }
            }
            if deduped.len() >= 2 && deduped.first() == deduped.last() {
                deduped.pop();
            }
            if deduped.len() < 3 {
                // Degenerate after dedup: keep original shape instead.
                continue;
            }
            for i in 0..deduped.len() {
                new_edge(deduped[i], deduped[(i + 1) % deduped.len()], &mut edges);
            }
            new_loops.push(deduped);
        }
        if !new_loops.is_empty() {
            regions.insert(
                *rid,
                Region {
                    winding_rule: region.winding_rule,
                    loops: new_loops,
                    paint_id: region.paint_id,
                },
            );
        }
    }

    Ok(VectorNetwork {
        vertices: new_vertices.into_iter().enumerate().collect(),
        edges,
        regions,
        winding_rule: net.winding_rule,
    })
}

#[cfg(test)]
mod modifier_tests {
    //! Modifier evaluation tests (companion to vector_network::planar_tests).
    //!
    //! Coordinate convention: document space is y-down (as on screen).

    use super::{Modifier, ModifierStack};
    use crate::vector_network::planar_tests::{square, zigzag_square};
    use crate::{GeometryError, ModifierError, VectorNetwork};

    // ------------------------------------------------------------------
    // Modifier evaluation
    // ------------------------------------------------------------------

    #[test]
    fn transform_scales_points_and_tangents() {
        let (mut net, _) = square(0.0, 0.0, 10.0);
        // give one edge a tangent
        let e = net.edges.remove(&1).unwrap();
        net.edges.insert(
            1,
            Edge {
                start: e.start,
                end: e.end,
                tangent_start: Some((2.0, 0.0)),
                tangent_end: None,
            },
        );
        let stack = ModifierStack {
            modifiers: vec![Modifier::Transform {
                matrix: [2.0, 0.0, 0.0, 2.0, 0.0, 0.0],
            }],
        };
        let out = stack.evaluate(&net).unwrap();
        let p = &out.vertices[&1];
        assert_eq!((p.x, p.y), (20.0, -20.0));
        let e = &out.edges[&1];
        assert_eq!(e.tangent_start, Some((4.0, 0.0)));
        // base untouched
        let p = &net.vertices[&1];
        assert_eq!((p.x, p.y), (10.0, -10.0));
    }

    #[test]
    fn transform_rejects_non_finite() {
        let (net, _) = square(0.0, 0.0, 10.0);
        let stack = ModifierStack {
            modifiers: vec![Modifier::Transform {
                matrix: [f64::NAN, 0.0, 0.0, 1.0, 0.0, 0.0],
            }],
        };
        match stack.evaluate(&net) {
            Err(ModifierError::InvalidParameter { op, .. }) => assert_eq!(op, "Transform"),
            other => panic!("expected InvalidParameter, got {other:?}"),
        }
    }

    #[test]
    fn unsupported_ops_fail_explicitly() {
        let (net, _) = square(0.0, 0.0, 10.0);
        for m in [
            Modifier::RoundedCorners {
                radius: 2.0,
                smoothing: None,
                corner_indices: None,
            },
            Modifier::Offset {
                distance: 3.0,
                join: "miter".into(),
                miter_limit: None,
            },
            Modifier::Boolean {
                op: "union".into(),
                target_id: None,
            },
            Modifier::Stroke {
                width: 2.0,
                cap: "round".into(),
                join: "miter".into(),
                miter_limit: None,
                dashes: None,
                variable_width: None,
            },
        ] {
            let stack = ModifierStack { modifiers: vec![m] };
            match stack.evaluate(&net) {
                Err(ModifierError::RequiresGeometryEngine { .. }) => {}
                other => panic!("expected RequiresGeometryEngine, got {other:?}"),
            }
        }
    }

    #[test]
    fn simplify_removes_small_features_keeps_large() {
        let net = zigzag_square();
        // tolerance 0.2 > bump amplitude 0.1 -> back to 4 corners
        let big = ModifierStack {
            modifiers: vec![Modifier::Simplify { tolerance: 0.2 }],
        }
        .evaluate(&net)
        .unwrap();
        assert_eq!(big.vertices.len(), 4, "bump removed");
        assert!(big.point_is_filled((2.0, 2.0)).unwrap());

        // tolerance 0.05 < 0.1 -> the bump apex must survive
        let small = ModifierStack {
            modifiers: vec![Modifier::Simplify { tolerance: 0.05 }],
        }
        .evaluate(&net)
        .unwrap();
        let apex = small
            .vertices
            .values()
            .any(|v| (v.x - 2.5).abs() < 1e-9 && (v.y - 4.1).abs() < 1e-9);
        assert!(apex, "bump apex must be kept");
        assert!(small.point_is_filled((2.0, 2.0)).unwrap());

        // base untouched
        assert_eq!(net.vertices.len(), 8);
    }

    #[test]
    fn simplify_zero_tolerance_keeps_shape() {
        let net = zigzag_square();
        let out = ModifierStack {
            modifiers: vec![Modifier::Simplify { tolerance: 0.0 }],
        }
        .evaluate(&net)
        .unwrap();
        assert_eq!(out.vertices.len(), 8);
    }

    #[test]
    fn stack_is_composable_and_pure() {
        let net = zigzag_square();
        let stack = ModifierStack {
            modifiers: vec![
                Modifier::Simplify { tolerance: 0.2 },
                Modifier::Transform {
                    matrix: [1.0, 0.0, 0.0, 1.0, 100.0, 0.0],
                },
            ],
        };
        let r1 = stack.evaluate(&net).unwrap();
        let r2 = stack.evaluate(&net).unwrap();
        // deterministic
        let v1: Vec<(f64, f64)> = (0..r1.vertices.len())
            .map(|i| {
                let v = &r1.vertices[&i];
                (v.x, v.y)
            })
            .collect();
        let v2: Vec<(f64, f64)> = (0..r2.vertices.len())
            .map(|i| {
                let v = &r2.vertices[&i];
                (v.x, v.y)
            })
            .collect();
        assert_eq!(v1, v2);
        // translate applied
        let x: Vec<f64> = r1.vertices.values().map(|v| v.x).collect();
        assert!(x.iter().all(|v| *v >= 100.0));
        // base untouched
        assert_eq!(net.vertices.len(), 8);
        let v0 = &net.vertices[&0];
        assert_eq!((v0.x, v0.y), (0.0, 0.0));
    }

    #[test]
    fn empty_stack_is_identity() {
        let net = zigzag_square();
        let before: Vec<(f64, f64)> = (0..8)
            .map(|i| {
                let v = &net.vertices[&i];
                (v.x, v.y)
            })
            .collect();
        let out = ModifierStack::default().evaluate(&net).unwrap();
        assert_eq!(out.vertices.len(), 8);
        let after: Vec<(f64, f64)> = (0..8)
            .map(|i| {
                let v = &out.vertices[&i];
                (v.x, v.y)
            })
            .collect();
        assert_eq!(before, after);
    }
}
