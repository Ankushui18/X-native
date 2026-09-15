//! Vector booleans: union / subtract / intersect / exclude.
//!
//! Implementation: scanline polygonization + even-odd region test.
//! Paths are flattened (cubics -> polylines), regions combined with the
//! chosen predicate, and the result traced back into PathCmd contours
//! via marching squares over a supersampled coverage grid. This is a
//! raster-guided approach: robust against self-intersection and open
//! degenerate input, resolution-tunable, zero external deps.
//! (An exact Bentley-Ottmann clipper can replace the core behind the
//! same API later; results are already visually correct and re-editable
//! as vector contours.)

use crate::{Node, NodeKind, PathCmd};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoolOp {
    Union,
    Subtract,
    Intersect,
    Exclude,
}

// ------------------------------------------------------------ facade API
//
// `boolean(op, a, b)` is the STABLE public geometry API. Callers (editor,
// future plugin surface) never see which backend computes the result.
// Backends:
//   Backend::RasterGuided  — current: coverage grid + edge-chaining (beta)
//   Backend::Exact         — future: Bentley-Ottmann / Bezier clipper
// Swapping the default backend before v1.0 changes ONE constant here.

/// A positioned path: commands + world offset of their local origin.
#[derive(Debug, Clone)]
pub struct PositionedPath {
    pub cmds: Vec<PathCmd>,
    pub offset: (f64, f64),
}

/// Result of a boolean: contours + the world origin/size of their bbox.
#[derive(Debug, Clone)]
pub struct BooleanResult {
    pub cmds: Vec<PathCmd>,
    pub origin: (f64, f64),
    pub size: (f64, f64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Backend {
    /// coverage grid + edge-chaining contour extraction (robust fallback)
    RasterGuided,
    /// exact Greiner–Hormann POLYGON clipper (flattens curves first;
    /// output is polyline). Fallback tier between BezierExact and raster.
    Exact,
    /// booleans 2.0 (DEFAULT since v0.32): curve-preserving clipper —
    /// bezier intersections via recursive subdivision, de Casteljau
    /// splits at cut params, topology traced over ORIGINAL curve pieces.
    /// Curves in, curves out: repeated ops don't degrade quality.
    /// Falls back Exact -> RasterGuided on degenerate topology.
    #[default]
    BezierExact,
}

/// The stable boolean API: `boolean(op, a, b) -> path`.
/// Application code must call this (or `boolean_with`), never a backend.
pub fn boolean(op: BoolOp, a: &PositionedPath, b: &PositionedPath) -> BooleanResult {
    boolean_with(Backend::default(), op, a, b)
}

/// Same, with an explicit backend (tests / future migration).
pub fn boolean_with(
    backend: Backend,
    op: BoolOp,
    a: &PositionedPath,
    b: &PositionedPath,
) -> BooleanResult {
    if backend == Backend::BezierExact {
        if let Some(res) = boolean_bezier(op, a, b) {
            return res;
        }
        // degenerate for the curve clipper: try the polygon tier next
    }
    if backend == Backend::BezierExact || backend == Backend::Exact {
        if let Some(res) = boolean_exact(op, a, b) {
            return res;
        }
        // degenerate topology: fall through to the raster backend
    }
    let (cmds, origin, size) = boolean_paths(&a.cmds, a.offset, &b.cmds, b.offset, op);
    BooleanResult { cmds, origin, size }
}

/// Booleans 2.0 backend: curve-preserving. None => caller falls back.
fn boolean_bezier(op: BoolOp, a: &PositionedPath, b: &PositionedPath) -> Option<BooleanResult> {
    use crate::bezier_clip::{clip_bezier, clip_bezier_exclude, path_to_segs, segs_to_path};
    let sa = path_to_segs(&a.cmds, a.offset)?;
    let sb = path_to_segs(&b.cmds, b.offset)?;
    let contours = match op {
        BoolOp::Union => clip_bezier(&sa, &sb, crate::clip::ClipOp::Union)?,
        BoolOp::Intersect => clip_bezier(&sa, &sb, crate::clip::ClipOp::Intersect)?,
        BoolOp::Subtract => clip_bezier(&sa, &sb, crate::clip::ClipOp::AminusB)?,
        BoolOp::Exclude => clip_bezier_exclude(&sa, &sb)?,
    };
    if contours.is_empty() {
        return None;
    }
    // bounds from fine evaluation (control points can overshoot the shape)
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for seg in contours.iter().flatten() {
        for i in 0..=16 {
            let p = seg.eval(i as f64 / 16.0);
            x0 = x0.min(p.0);
            y0 = y0.min(p.1);
            x1 = x1.max(p.0);
            y1 = y1.max(p.1);
        }
    }
    let cmds = segs_to_path(&contours, (x0, y0));
    if cmds.is_empty() {
        return None;
    }
    Some(BooleanResult {
        cmds,
        origin: (x0, y0),
        size: (x1 - x0, y1 - y0),
    })
}

/// Exact backend: flatten (curves -> polylines at 16 segments/curve),
/// then Greiner–Hormann clip with analytic edge intersections.
/// Single-contour simple polygons; None => caller falls back.
fn boolean_exact(op: BoolOp, a: &PositionedPath, b: &PositionedPath) -> Option<BooleanResult> {
    let pa = flatten(&a.cmds, a.offset);
    let pb = flatten(&b.cmds, b.offset);
    // exact backend scope: one simple contour per operand
    if pa.len() != 1 || pb.len() != 1 {
        return None;
    }
    let (sa, sb) = (&pa[0], &pb[0]);
    let polys = match op {
        BoolOp::Union => crate::clip::clip(sa, sb, crate::clip::ClipOp::Union)?,
        BoolOp::Intersect => crate::clip::clip(sa, sb, crate::clip::ClipOp::Intersect)?,
        BoolOp::Subtract => crate::clip::clip(sa, sb, crate::clip::ClipOp::AminusB)?,
        BoolOp::Exclude => crate::clip::clip_exclude(sa, sb)?,
    };
    if polys.is_empty() {
        return None;
    }
    // bounds -> local space
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in polys.iter().flatten() {
        x0 = x0.min(p.0);
        y0 = y0.min(p.1);
        x1 = x1.max(p.0);
        y1 = y1.max(p.1);
    }
    let mut cmds = vec![];
    for poly in &polys {
        if poly.len() < 3 {
            continue;
        }
        cmds.push(PathCmd::MoveTo(poly[0].0 - x0, poly[0].1 - y0));
        for p in &poly[1..] {
            cmds.push(PathCmd::LineTo(p.0 - x0, p.1 - y0));
        }
        cmds.push(PathCmd::Close);
    }
    if cmds.is_empty() {
        return None;
    }
    Some(BooleanResult {
        cmds,
        origin: (x0, y0),
        size: (x1 - x0, y1 - y0),
    })
}

/// Flatten one path into closed polygons (local coords).
fn flatten(path: &[PathCmd], offset: (f64, f64)) -> Vec<Vec<(f64, f64)>> {
    let mut polys = vec![];
    let mut cur: Vec<(f64, f64)> = vec![];
    let mut start = (0.0, 0.0);
    let mut pos = (0.0, 0.0);
    let (ox, oy) = offset;
    for c in path {
        match *c {
            PathCmd::MoveTo(x, y) => {
                if cur.len() > 2 {
                    polys.push(std::mem::take(&mut cur));
                } else {
                    cur.clear();
                }
                start = (x + ox, y + oy);
                pos = start;
                cur.push(pos);
            }
            PathCmd::LineTo(x, y) => {
                pos = (x + ox, y + oy);
                cur.push(pos);
            }
            PathCmd::CurveTo(x1, y1, x2, y2, x, y) => {
                let (p0, p1, p2, p3) = (
                    pos,
                    (x1 + ox, y1 + oy),
                    (x2 + ox, y2 + oy),
                    (x + ox, y + oy),
                );
                for i in 1..=16 {
                    let t = i as f64 / 16.0;
                    let mt = 1.0 - t;
                    let px = mt * mt * mt * p0.0
                        + 3.0 * mt * mt * t * p1.0
                        + 3.0 * mt * t * t * p2.0
                        + t * t * t * p3.0;
                    let py = mt * mt * mt * p0.1
                        + 3.0 * mt * mt * t * p1.1
                        + 3.0 * mt * t * t * p2.1
                        + t * t * t * p3.1;
                    cur.push((px, py));
                }
                pos = p3;
            }
            PathCmd::Close => {
                if cur.len() > 2 {
                    cur.push(start);
                    polys.push(std::mem::take(&mut cur));
                } else {
                    cur.clear();
                }
            }
        }
    }
    if cur.len() > 2 {
        polys.push(cur);
    }
    polys
}

fn point_in(polys: &[Vec<(f64, f64)>], x: f64, y: f64) -> bool {
    // even-odd across all contours
    let mut inside = false;
    for poly in polys {
        let n = poly.len();
        for i in 0..n {
            let (x1, y1) = poly[i];
            let (x2, y2) = poly[(i + 1) % n];
            if (y1 > y) != (y2 > y) {
                let xi = x1 + (y - y1) / (y2 - y1) * (x2 - x1);
                if x < xi {
                    inside = !inside;
                }
            }
        }
    }
    inside
}

/// Boolean of two shapes -> new PathCmd contours in A∪B bounding space.
pub fn boolean_paths(
    a: &[PathCmd],
    a_off: (f64, f64),
    b: &[PathCmd],
    b_off: (f64, f64),
    op: BoolOp,
) -> (Vec<PathCmd>, (f64, f64), (f64, f64)) {
    let pa = flatten(a, a_off);
    let pb = flatten(b, b_off);
    // bounds
    let all: Vec<(f64, f64)> = pa.iter().chain(pb.iter()).flatten().copied().collect();
    if all.is_empty() {
        return (vec![], (0.0, 0.0), (0.0, 0.0));
    }
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for (x, y) in &all {
        x0 = x0.min(*x);
        y0 = y0.min(*y);
        x1 = x1.max(*x);
        y1 = y1.max(*y);
    }
    let pad = 2.0;
    x0 -= pad;
    y0 -= pad;
    x1 += pad;
    y1 += pad;

    // coverage grid (resolution capped for perf, >=1px cells)
    const MAX_CELLS: usize = 360;
    let w = x1 - x0;
    let h = y1 - y0;
    let cell = (w.max(h) / MAX_CELLS as f64).max(0.75);
    let gw = (w / cell).ceil() as usize + 1;
    let gh = (h / cell).ceil() as usize + 1;
    let mut grid = vec![false; gw * gh];
    for gy in 0..gh {
        for gx in 0..gw {
            let px = x0 + (gx as f64 + 0.5) * cell;
            let py = y0 + (gy as f64 + 0.5) * cell;
            let ia = point_in(&pa, px, py);
            let ib = point_in(&pb, px, py);
            grid[gy * gw + gx] = match op {
                BoolOp::Union => ia || ib,
                BoolOp::Subtract => ia && !ib,
                BoolOp::Intersect => ia && ib,
                BoolOp::Exclude => ia != ib,
            };
        }
    }

    // contour extraction by EDGE CHAINING: every filled cell contributes
    // its boundary edges (sides facing empty cells); these segments form
    // closed loops by construction — robust for any region shape,
    // including holes (hole loops emerge automatically).
    let at = |gx: i64, gy: i64| -> bool {
        gx >= 0
            && gy >= 0
            && (gx as usize) < gw
            && (gy as usize) < gh
            && grid[gy as usize * gw + gx as usize]
    };
    use std::collections::HashMap as Map;
    // edges keyed by start corner -> end corner (integer grid corners)
    let mut edges: Map<(i64, i64), Vec<(i64, i64)>> = Map::new();
    let add = |a: (i64, i64), b: (i64, i64), edges: &mut Map<(i64, i64), Vec<(i64, i64)>>| {
        edges.entry(a).or_default().push(b);
    };
    for gy in 0..gh as i64 {
        for gx in 0..gw as i64 {
            if !at(gx, gy) {
                continue;
            }
            // orient edges so interior is on the LEFT (CCW outer loops)
            if !at(gx, gy - 1) {
                add((gx, gy), (gx + 1, gy), &mut edges);
            } // top edge, ->
            if !at(gx + 1, gy) {
                add((gx + 1, gy), (gx + 1, gy + 1), &mut edges);
            } // right, v
            if !at(gx, gy + 1) {
                add((gx + 1, gy + 1), (gx, gy + 1), &mut edges);
            } // bottom, <-
            if !at(gx - 1, gy) {
                add((gx, gy + 1), (gx, gy), &mut edges);
            } // left, ^
        }
    }
    let mut contours: Vec<Vec<(f64, f64)>> = vec![];
    while let Some((&start_pt, _)) = edges.iter().find(|(_, v)| !v.is_empty()) {
        let mut loop_pts = vec![start_pt];
        let mut cur = start_pt;
        while let Some(nexts) = edges.get_mut(&cur) {
            let Some(nxt) = nexts.pop() else { break };
            if nxt == start_pt {
                break;
            }
            loop_pts.push(nxt);
            cur = nxt;
            if loop_pts.len() > gw * gh * 4 {
                break;
            } // safety
        }
        // clean empties
        edges.retain(|_, v| !v.is_empty());
        if loop_pts.len() >= 3 {
            contours.push(
                loop_pts
                    .into_iter()
                    .map(|(cx, cy)| (x0 + cx as f64 * cell, y0 + cy as f64 * cell))
                    .collect(),
            );
        }
    }

    // simplify (drop collinear runs) and emit PathCmds relative to (x0,y0)
    let mut out = vec![];
    for c in &contours {
        let simp = simplify(c, cell * 1.2);
        if simp.len() < 3 {
            continue;
        }
        out.push(PathCmd::MoveTo(simp[0].0 - x0, simp[0].1 - y0));
        for p in &simp[1..] {
            out.push(PathCmd::LineTo(p.0 - x0, p.1 - y0));
        }
        out.push(PathCmd::Close);
    }
    (out, (x0, y0), (x1 - x0, y1 - y0))
}

fn simplify(pts: &[(f64, f64)], tol: f64) -> Vec<(f64, f64)> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let mut out = vec![pts[0]];
    for i in 1..pts.len() - 1 {
        let a = *out.last().unwrap();
        let b = pts[i];
        let c = pts[i + 1];
        // keep b when it deviates from line a->c
        let area2 = ((b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)).abs();
        let base = ((c.0 - a.0).powi(2) + (c.1 - a.1).powi(2)).sqrt().max(1e-9);
        if area2 / base > tol * 0.5 {
            out.push(b);
        }
    }
    out.push(*pts.last().unwrap());
    out
}

/// Anything renderable becomes boolean input: rects/ellipses convert
/// to paths; vectors pass through.
pub fn node_to_path(n: &Node) -> Option<Vec<PathCmd>> {
    match &n.kind {
        NodeKind::Vector { path } => Some(path.clone()),
        NodeKind::Rect { radius } => {
            let (w, h, r) = (n.w, n.h, radius.min(n.w / 2.0).min(n.h / 2.0));
            if *radius <= 0.0 {
                Some(vec![
                    PathCmd::MoveTo(0.0, 0.0),
                    PathCmd::LineTo(w, 0.0),
                    PathCmd::LineTo(w, h),
                    PathCmd::LineTo(0.0, h),
                    PathCmd::Close,
                ])
            } else {
                let k = 0.5523 * r;
                Some(vec![
                    PathCmd::MoveTo(r, 0.0),
                    PathCmd::LineTo(w - r, 0.0),
                    PathCmd::CurveTo(w - r + k, 0.0, w, r - k, w, r),
                    PathCmd::LineTo(w, h - r),
                    PathCmd::CurveTo(w, h - r + k, w - r + k, h, w - r, h),
                    PathCmd::LineTo(r, h),
                    PathCmd::CurveTo(r - k, h, 0.0, h - r + k, 0.0, h - r),
                    PathCmd::LineTo(0.0, r),
                    PathCmd::CurveTo(0.0, r - k, r - k, 0.0, r, 0.0),
                    PathCmd::Close,
                ])
            }
        }
        NodeKind::Arc { start, end } => Some(arc_path_cmds(n.w, n.h, *start, *end)),
        NodeKind::Ellipse => {
            let (rx, ry) = (n.w / 2.0, n.h / 2.0);
            let (kx, ky) = (0.5523 * rx, 0.5523 * ry);
            let (cx, cy) = (rx, ry);
            Some(vec![
                PathCmd::MoveTo(cx + rx, cy),
                PathCmd::CurveTo(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry),
                PathCmd::CurveTo(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy),
                PathCmd::CurveTo(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry),
                PathCmd::CurveTo(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy),
                PathCmd::Close,
            ])
        }
        NodeKind::Line => Some(vec![PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(n.w, n.h)]),
        _ => None,
    }
}

/// Elliptical-arc path (y-down space, degrees clockwise from east):
/// cubic-bezier approximation, <= 90 deg per segment. `start == end`
/// (mod 360) yields the full ellipse. Open path (no Close) — Figma-style
/// arc primitive geometry shared by node_to_path, the renderer and SVG
/// export.
pub fn arc_path_cmds(w: f64, h: f64, start: f64, end: f64) -> Vec<PathCmd> {
    let (rx, ry) = (w / 2.0, (h / 2.0).max(1e-6));
    let rx = rx.max(1e-6);
    let (cx, cy) = (rx, ry);
    let sweep = (end - start).rem_euclid(360.0);
    let sweep = if sweep == 0.0 { 360.0 } else { sweep };
    // split into n segments of <= 90 deg
    let n = ((sweep / 90.0).ceil() as usize).max(1);
    let seg = sweep / n as f64;
    // kappa: standard circular-arc-to-bezier control offset for this
    // segment angle: (4/3) tan(theta/4); 0.5523 for a quarter
    let kappa = 4.0 / 3.0 * (seg.to_radians() / 4.0).tan();
    let pt = |deg: f64| {
        let t = deg.to_radians();
        (cx + rx * t.cos(), cy + ry * t.sin())
    };
    // tangent vector at angle t (derivative of (rx cos t, ry sin t))
    let tang = |deg: f64| {
        let t = deg.to_radians();
        (-rx * t.sin(), ry * t.cos())
    };
    let mut cmds = vec![];
    let p0 = pt(start);
    cmds.push(PathCmd::MoveTo(p0.0, p0.1));
    for i in 0..n {
        let a0 = start + seg * i as f64;
        let a1 = a0 + seg;
        let (x0, y0) = pt(a0);
        let (x1, y1) = pt(a1);
        let (t0x, t0y) = tang(a0);
        let (t1x, t1y) = tang(a1);
        cmds.push(PathCmd::CurveTo(
            x0 + t0x * kappa,
            y0 + t0y * kappa,
            x1 - t1x * kappa,
            y1 - t1y * kappa,
            x1,
            y1,
        ));
    }
    cmds
}

// ---------------------------------------------- outline-stroke geometry

/// Flatten PathCmds into polylines (cubics subdivided `steps` times).
/// One polyline per subpath; `Close` ends its subpath.
pub fn path_to_polylines(cmds: &[PathCmd], steps: usize) -> Vec<Vec<(f64, f64)>> {
    let mut out: Vec<Vec<(f64, f64)>> = vec![];
    let mut cur: Vec<(f64, f64)> = vec![];
    let mut last = (0.0, 0.0);
    let steps = steps.max(1);
    for c in cmds {
        match *c {
            PathCmd::MoveTo(x, y) => {
                if cur.len() >= 2 {
                    out.push(cur);
                }
                cur = vec![(x, y)];
                last = (x, y);
            }
            PathCmd::LineTo(x, y) => {
                cur.push((x, y));
                last = (x, y);
            }
            PathCmd::CurveTo(c1x, c1y, c2x, c2y, x, y) => {
                let (a, b, e) = (last, (c1x, c1y), (c2x, c2y));
                for i in 1..=steps {
                    let t = i as f64 / steps as f64;
                    let mt = 1.0 - t;
                    let px = mt * mt * mt * a.0
                        + 3.0 * mt * mt * t * b.0
                        + 3.0 * mt * t * t * e.0
                        + t * t * t * x;
                    let py = mt * mt * mt * a.1
                        + 3.0 * mt * mt * t * b.1
                        + 3.0 * mt * t * t * e.1
                        + t * t * t * y;
                    cur.push((px, py));
                }
                last = (x, y);
            }
            PathCmd::Close => {
                if cur.len() >= 2 {
                    out.push(cur);
                }
                cur = vec![];
            }
        }
    }
    if cur.len() >= 2 {
        out.push(cur);
    }
    out
}

/// Does the path end with an explicit Close (ring outline vs open stroke)?
pub fn path_is_closed(cmds: &[PathCmd]) -> bool {
    matches!(cmds.last(), Some(PathCmd::Close))
}

/// Left normal of the a->b segment (unit; zero for degenerate).
fn seg_normal(a: (f64, f64), b: (f64, f64)) -> (f64, f64) {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let l = dx.hypot(dy);
    if l < 1e-12 {
        (0.0, 0.0)
    } else {
        (-dy / l, dx / l)
    }
}

/// Offset a polyline by `d` along vertex miter normals (capped so sharp
/// corners never explode).
/// Per-vertex (unit miter normal, miter scale) of a polyline. The miter
/// scale is 1 / cos(half-angle between the edge normal and the bisector),
/// clamped to keep spikes bounded; endpoints (open polylines) use the
/// single adjacent edge normal with scale 1.
fn vertex_miters(pts: &[(f64, f64)], closed: bool) -> Vec<((f64, f64), f64)> {
    let n = pts.len();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let p = pts[i];
        let prev = if i > 0 {
            pts[i - 1]
        } else if closed && n > 1 {
            pts[n - 1]
        } else {
            p
        };
        let next = if i + 1 < n {
            pts[i + 1]
        } else if closed && n > 1 {
            pts[0]
        } else {
            p
        };
        let n1 = {
            let v = seg_normal(prev, p);
            (v.0.abs() + v.1.abs() > 1e-9).then_some(v)
        };
        let n2 = {
            let v = seg_normal(p, next);
            (v.0.abs() + v.1.abs() > 1e-9).then_some(v)
        };
        let m = match (n1, n2) {
            (Some(a), Some(b)) => {
                let (mx, my) = (a.0 + b.0, a.1 + b.1);
                let l = mx.hypot(my);
                if l < 1e-12 {
                    a
                } else {
                    (mx / l, my / l)
                }
            }
            (Some(a), None) | (None, Some(a)) => a,
            (None, None) => (0.0, 0.0),
        };
        let scale = match n1 {
            Some(a) => (a.0 * m.0 + a.1 * m.1).max(0.3).recip().min(4.0),
            None => 1.0,
        };
        out.push((m, scale));
    }
    out
}

/// Offset a polyline by `d` along miter normals. Shared by path
/// offsetting (`offset_path`), stroke alignment in the renderer and
/// outline strokes — one geometry authority, no drift.
pub fn offset_polyline(pts: &[(f64, f64)], d: f64, closed: bool) -> Vec<(f64, f64)> {
    vertex_miters(pts, closed)
        .iter()
        .zip(pts)
        .map(|((m, scale), p)| (p.0 + m.0 * d * scale, p.1 + m.1 * d * scale))
        .collect()
}

/// Offset every subpath of a path by `d` along vertex miter normals
/// (Figma's "Offset vector path" and the renderer's stroke-alignment
/// inset/outset). Curves are flattened to `steps` segments per cubic
/// before offsetting; closed subpaths re-close, open ones keep their
/// open ends (miter-capped endpoints). The sign of `d` follows the
/// left-normal of each segment, so which visual direction is "out"
/// depends on winding — callers decide via `grow_path` or a bbox test.
pub fn offset_path(cmds: &[PathCmd], d: f64, steps: usize) -> Vec<PathCmd> {
    // collect (polyline, closed) per subpath
    let mut subs: Vec<(Vec<(f64, f64)>, bool)> = vec![];
    let mut cur: Vec<(f64, f64)> = vec![];
    let mut last = (0.0, 0.0);
    let steps = steps.max(2);
    for c in cmds {
        match *c {
            PathCmd::MoveTo(x, y) => {
                if cur.len() >= 2 {
                    subs.push((std::mem::take(&mut cur), false));
                }
                cur = vec![(x, y)];
                last = (x, y);
            }
            PathCmd::LineTo(x, y) => {
                cur.push((x, y));
                last = (x, y);
            }
            PathCmd::CurveTo(c1x, c1y, c2x, c2y, x, y) => {
                let (a, b, e) = (last, (c1x, c1y), (c2x, c2y));
                for i in 1..=steps {
                    let t = i as f64 / steps as f64;
                    let mt = 1.0 - t;
                    cur.push((
                        mt * mt * mt * a.0
                            + 3.0 * mt * mt * t * b.0
                            + 3.0 * mt * t * t * e.0
                            + t * t * t * x,
                        mt * mt * mt * a.1
                            + 3.0 * mt * mt * t * b.1
                            + 3.0 * mt * t * t * e.1
                            + t * t * t * y,
                    ));
                }
                last = (x, y);
            }
            PathCmd::Close => {
                if cur.len() >= 2 {
                    subs.push((std::mem::take(&mut cur), true));
                }
                cur = vec![];
            }
        }
    }
    if cur.len() >= 2 {
        subs.push((cur, false));
    }
    let mut out: Vec<PathCmd> = vec![];
    for (pts, closed) in subs {
        let off = if closed && pts.len() >= 3 {
            offset_polyline(&pts, d, true)
        } else if !closed && pts.len() >= 2 {
            offset_polyline(&pts, d, false)
        } else {
            continue;
        };
        out.push(PathCmd::MoveTo(off[0].0, off[0].1));
        for q in off.iter().skip(1) {
            out.push(PathCmd::LineTo(q.0, q.1));
        }
        if closed {
            out.push(PathCmd::Close);
        }
    }
    out
}

/// Offset a path so that positive `amount` GROWS it regardless of winding
/// (the direction Figma's offset tool uses): the bbox decides the normal
/// sign for closed paths; open paths offset along the literal normals.
pub fn grow_path(cmds: &[PathCmd], amount: f64, steps: usize) -> Vec<PathCmd> {
    if !path_is_closed(cmds) || amount == 0.0 {
        return offset_path(cmds, amount, steps);
    }
    let extent = |cs: &[PathCmd]| -> Option<f64> {
        let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        let mut seen = false;
        for c in cs {
            let mut acc = |x: f64, y: f64| {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            };
            match *c {
                PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => {
                    acc(x, y);
                    seen = true;
                }
                PathCmd::CurveTo(x1c, y1c, x2c, y2c, x, y) => {
                    acc(x1c, y1c);
                    acc(x2c, y2c);
                    acc(x, y);
                    seen = true;
                }
                PathCmd::Close => {}
            }
        }
        seen.then(|| (x1 - x0) + (y1 - y0))
    };
    let want_grow = amount > 0.0;
    let d = amount.abs();
    let plus = offset_path(cmds, d, steps);
    let growing = match (extent(cmds), extent(&plus)) {
        (Some(a), Some(b)) => (b >= a) == want_grow,
        _ => return plus,
    };
    if growing {
        plus
    } else {
        offset_path(cmds, -d, steps)
    }
}

/// Variable-width brush stroke outline: each vertex carries its own full
/// stroke width (`widths[i]`, parallel to `pts`); the result is one closed
/// polygon (left side forward, right side reversed) suitable for a solid
/// fill — the brush tool's baked geometry. Widths are clamped to >= 0.75
/// so tapering never degenerates to zero-thickness spikes.
pub fn stroke_outline_variable(pts: &[(f64, f64)], widths: &[f64]) -> Vec<PathCmd> {
    if pts.len() < 2 || widths.len() != pts.len() {
        return vec![];
    }
    let miters = vertex_miters(pts, false);
    let side = |sign: f64| {
        miters
            .iter()
            .zip(pts)
            .zip(widths)
            .map(|(((m, scale), p), w)| {
                let d = (w.max(0.75) / 2.0) * scale * sign;
                (p.0 + m.0 * d, p.1 + m.1 * d)
            })
            .collect::<Vec<_>>()
    };
    let mut poly = side(1.0);
    let mut right = side(-1.0);
    right.reverse();
    poly.extend(right);
    let mut cmds = vec![PathCmd::MoveTo(poly[0].0, poly[0].1)];
    for q in poly.iter().skip(1) {
        cmds.push(PathCmd::LineTo(q.0, q.1));
    }
    cmds.push(PathCmd::Close);
    cmds
}

/// Outline-stroke geometry: turn a polyline into the filled outline of a
/// `width` stroke. Open polylines become one polygon (left side forward,
/// right side back); closed ones become a ring (two subpaths, opposite
/// winding — NonZero fill renders the band). Approximate (miter joins,
/// butt caps) — the honest version of Figma's Outline Stroke.
pub fn stroke_outline(pts: &[(f64, f64)], width: f64, closed: bool) -> Vec<PathCmd> {
    if pts.len() < 2 || width <= 0.0 {
        return vec![];
    }
    let d = width / 2.0;
    let mut cmds = vec![];
    let emit = |poly: &[(f64, f64)], cmds: &mut Vec<PathCmd>| {
        if poly.is_empty() {
            return;
        }
        cmds.push(PathCmd::MoveTo(poly[0].0, poly[0].1));
        for q in poly.iter().skip(1) {
            cmds.push(PathCmd::LineTo(q.0, q.1));
        }
        cmds.push(PathCmd::Close);
    };
    if closed {
        let a = offset_polyline(pts, d, true);
        let b = offset_polyline(pts, -d, true);
        emit(&a, &mut cmds);
        let b_rev: Vec<(f64, f64)> = b.into_iter().rev().collect();
        emit(&b_rev, &mut cmds);
    } else {
        let l = offset_polyline(pts, d, false);
        let r = offset_polyline(pts, -d, false);
        let mut poly = l;
        poly.extend(r.into_iter().rev());
        emit(&poly, &mut cmds);
    }
    cmds
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Color;

    #[test]
    fn arc_quarter_is_one_open_curve() {
        let cmds = arc_path_cmds(100.0, 100.0, 0.0, 90.0);
        assert_eq!(cmds.len(), 2, "MoveTo + one 90-deg segment");
        assert!(
            matches!(cmds[0], PathCmd::MoveTo(x, y) if (x - 100.0).abs() < 1e-9 && (y - 50.0).abs() < 1e-9),
            "starts at the east point"
        );
        if let PathCmd::CurveTo(c1x, c1y, c2x, c2y, x, y) = cmds[1] {
            // ends at the south point (50, 100)
            assert!((x - 50.0).abs() < 1e-9 && (y - 100.0).abs() < 1e-9);
            // control arms tangent at the endpoints: vertical at the
            // east point, horizontal at the south point
            assert!((c1x - 100.0).abs() < 1e-9, "first arm vertical");
            assert!((c2y - 100.0).abs() < 1e-9, "second arm horizontal");
            // 90-deg quarter control offset: kappa 0.5523 * radius 50
            assert!((c1y - (50.0 + 0.5523 * 50.0)).abs() < 1e-3);
            assert!((c2x - (50.0 + 0.5523 * 50.0)).abs() < 1e-3);
        } else {
            panic!("expected curve");
        }
        assert!(!matches!(cmds.last(), Some(PathCmd::Close)));
    }

    #[test]
    fn arc_full_circle_and_arbitrary_sweep() {
        // start == end -> full ellipse: 4 quarter segments
        let full = arc_path_cmds(80.0, 40.0, 0.0, 0.0);
        assert_eq!(full.len(), 5);
        assert_eq!(
            full.iter().filter(|c| matches!(c, PathCmd::Close)).count(),
            0
        );
        // 200-deg sweep -> 3 segments (ceil(200/90))
        let sweep = arc_path_cmds(80.0, 40.0, 10.0, 210.0);
        assert_eq!(sweep.len(), 4);
        // sweep normalizes via rem_euclid regardless of start/end order
        let back = arc_path_cmds(80.0, 40.0, 210.0, 10.0);
        assert_eq!(back.len(), 3, "210->10 clockwise = 160 deg -> 2 segments");
    }

    #[test]
    fn variable_outline_tapers_symmetrically() {
        // left->right taper 4 -> 2: corners at +-2 then +-1
        let cmds = stroke_outline_variable(&[(0.0, 0.0), (10.0, 0.0)], &[4.0, 2.0]);
        assert_eq!(
            cmds,
            vec![
                PathCmd::MoveTo(0.0, 2.0),
                PathCmd::LineTo(10.0, 1.0),
                PathCmd::LineTo(10.0, -1.0),
                PathCmd::LineTo(0.0, -2.0),
                PathCmd::Close,
            ]
        );
    }

    #[test]
    fn variable_outline_constant_width_matches_stroke_outline() {
        let pts = [(0.0, 0.0), (10.0, 0.0), (10.0, 8.0)];
        let a = stroke_outline_variable(&pts, &[3.0, 3.0, 3.0]);
        let b = stroke_outline(&pts, 3.0, false);
        assert_eq!(a, b, "constant brush width == uniform outline stroke");
        // mismatched width slices are rejected
        assert!(stroke_outline_variable(&pts, &[3.0, 3.0]).is_empty());
    }

    #[test]
    fn outline_open_line_is_a_thick_quad() {
        let cmds = stroke_outline(&[(0.0, 0.0), (10.0, 0.0)], 2.0, false);
        // left side forward at y=-1, right side back at y=+1
        assert_eq!(
            cmds,
            vec![
                PathCmd::MoveTo(0.0, 1.0),
                PathCmd::LineTo(10.0, 1.0),
                PathCmd::LineTo(10.0, -1.0),
                PathCmd::LineTo(0.0, -1.0),
                PathCmd::Close,
            ]
        );
    }

    #[test]
    fn outline_closed_rect_is_a_ring() {
        let rect = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        let cmds = stroke_outline(&rect, 2.0, true);
        // two subpaths (outer + reversed inner), both closed
        let moves = cmds
            .iter()
            .filter(|c| matches!(c, PathCmd::MoveTo(..)))
            .count();
        let closes = cmds.iter().filter(|c| matches!(c, PathCmd::Close)).count();
        assert_eq!((moves, closes), (2, 2));
        // +d is inward for this winding: subpath 1 is the inner ring, every
        // corner offset by the 90-degree miter distance sqrt(2)*d
        if let (PathCmd::MoveTo(x0, y0), PathCmd::LineTo(x1, y1)) = (cmds[0], cmds[1]) {
            assert!((x0.hypot(y0) - 2.0f64.sqrt()).abs() < 1e-9, "corner miter");
            assert!(
                (x1 - 9.0).abs() < 1e-9 && (y1 - 1.0).abs() < 1e-9,
                "inner top edge inset by 1: got ({x1}, {y1})"
            );
        } else {
            panic!("expected MoveTo/LineTo first");
        }
        // the outer ring's corners are the mirrored (-1,-1)/(11,...) miters
        assert!(
            cmds.iter().any(
                |c| matches!(c, PathCmd::LineTo(x, y) if (x.hypot(*y) - 2.0f64.sqrt()).abs() < 1e-9)
            ),
            "outer corner miter present"
        );
    }

    fn unit_square() -> Vec<PathCmd> {
        vec![
            PathCmd::MoveTo(0.0, 0.0),
            PathCmd::LineTo(100.0, 0.0),
            PathCmd::LineTo(100.0, 100.0),
            PathCmd::LineTo(0.0, 100.0),
            PathCmd::Close,
        ]
    }

    fn bbox(cmds: &[PathCmd]) -> (f64, f64, f64, f64) {
        let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for c in cmds {
            let pts: Vec<(f64, f64)> = match *c {
                PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => vec![(x, y)],
                PathCmd::CurveTo(a, b, cc, d, e, f) => {
                    vec![(a, b), (cc, d), (e, f)]
                }
                PathCmd::Close => vec![],
            };
            for (x, y) in pts {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
        (x0, y0, x1, y1)
    }

    #[test]
    fn grow_path_is_winding_independent() {
        // +10 must GROW, -10 must shrink, whatever the normal convention
        let big = grow_path(&unit_square(), 10.0, 8);
        let small = grow_path(&unit_square(), -10.0, 8);
        assert!(path_is_closed(&big) && path_is_closed(&small), "rings re-close");
        let (ax0, ay0, ax1, ay1) = bbox(&big);
        assert!(
            (ax0 + 10.0).abs() < 1e-6
                && (ay0 + 10.0).abs() < 1e-6
                && (ax1 - 110.0).abs() < 1e-6
                && (ay1 - 110.0).abs() < 1e-6,
            "grow by 10: {ax0},{ay0},{ax1},{ay1}"
        );
        let (bx0, by0, bx1, by1) = bbox(&small);
        assert!(
            (bx0 - 10.0).abs() < 1e-6
                && (by0 - 10.0).abs() < 1e-6
                && (bx1 - 90.0).abs() < 1e-6
                && (by1 - 90.0).abs() < 1e-6,
            "shrink by 10: {bx0},{by0},{bx1},{by1}"
        );
    }

    #[test]
    fn offset_path_keeps_open_subpaths_open() {
        let line = vec![PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(100.0, 0.0)];
        let off = offset_path(&line, 5.0, 8);
        assert!(!path_is_closed(&off), "open stays open");
        assert_eq!(off.len(), 2, "two endpoints, no cap geometry");
        // offset is along the segment normal: both endpoints moved equally
        let (a, b) = match (off[0], off[1]) {
            (PathCmd::MoveTo(ax, ay), PathCmd::LineTo(bx, by)) => ((ax, ay), (bx, by)),
            _ => panic!("shape preserved"),
        };
        assert!((a.0 - b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9, "rigid");
        let d = (a.0 * a.0 + a.1 * a.1).sqrt();
        assert!((d - 5.0).abs() < 1e-6, "5px normal offset, got {d}");
    }

    #[test]
    fn polylines_flatten_curves_and_split_subpaths() {
        let cmds = vec![
            PathCmd::MoveTo(0.0, 0.0),
            PathCmd::CurveTo(0.0, 10.0, 10.0, 10.0, 10.0, 0.0),
            PathCmd::Close,
            PathCmd::MoveTo(20.0, 0.0),
            PathCmd::LineTo(30.0, 0.0),
        ];
        let polys = path_to_polylines(&cmds, 4);
        assert_eq!(polys.len(), 2, "Close splits subpaths");
        assert_eq!(polys[0].len(), 5, "4 curve steps -> 5 points");
        assert_eq!(polys[1], vec![(20.0, 0.0), (30.0, 0.0)]);
        assert!(path_is_closed(&cmds[..3]));
        assert!(!path_is_closed(&cmds));
    }

    #[test]
    fn facade_api_is_backend_agnostic() {
        // two overlapping 100x100 squares, 50px apart -> union area 15000
        let sq: Vec<PathCmd> = vec![
            PathCmd::MoveTo(0.0, 0.0),
            PathCmd::LineTo(100.0, 0.0),
            PathCmd::LineTo(100.0, 100.0),
            PathCmd::LineTo(0.0, 100.0),
            PathCmd::Close,
        ];
        let a = PositionedPath {
            cmds: sq.clone(),
            offset: (0.0, 0.0),
        };
        let b = PositionedPath {
            cmds: sq,
            offset: (50.0, 0.0),
        };
        let default_res = boolean(BoolOp::Union, &a, &b);
        assert!(!default_res.cmds.is_empty());
        let expect = 15000.0;
        let got = area_of(&default_res.cmds);
        assert!(
            (got - expect).abs() / expect < 0.08,
            "union area {got} vs {expect}"
        );
        // both named backends produce results through the same signature —
        // but with DIFFERENT precision contracts: raster ~8%, exact <0.1%
        let r = boolean_with(Backend::RasterGuided, BoolOp::Intersect, &a, &b);
        let ia = area_of(&r.cmds);
        assert!((ia - 5000.0).abs() / 5000.0 < 0.08, "raster intersect {ia}");
        let r = boolean_with(Backend::Exact, BoolOp::Intersect, &a, &b);
        let ia = area_of(&r.cmds);
        assert!((ia - 5000.0).abs() / 5000.0 < 0.001, "exact intersect {ia}");
        // curves flatten to 16 segs: ellipse ∪ rect via exact stays within 1%
        let circle = node_to_path(&crate::Node::ellipse(
            "c",
            0.0,
            0.0,
            100.0,
            100.0,
            Color::BLACK,
        ))
        .unwrap();
        let rectp = node_to_path(&crate::Node::rect(
            "r",
            0.0,
            0.0,
            100.0,
            100.0,
            Color::BLACK,
        ))
        .unwrap();
        let pc = PositionedPath {
            cmds: circle,
            offset: (0.0, 0.0),
        };
        let pr = PositionedPath {
            cmds: rectp,
            offset: (50.0, 0.0),
        };
        let r = boolean_with(Backend::Exact, BoolOp::Union, &pc, &pr);
        let want = 10000.0 + (std::f64::consts::PI * 2500.0) / 2.0; // rect + left half-circle
        let got = area_of(&r.cmds);
        assert!(
            (got - want).abs() / want < 0.01,
            "exact curve union {got} vs {want}"
        );
    }

    fn area_of(path: &[PathCmd]) -> f64 {
        // shoelace over flattened contours
        let polys = flatten(path, (0.0, 0.0));
        let mut area = 0.0;
        for poly in &polys {
            let n = poly.len();
            let mut a = 0.0;
            for i in 0..n {
                let (x1, y1) = poly[i];
                let (x2, y2) = poly[(i + 1) % n];
                a += x1 * y2 - x2 * y1;
            }
            area += a.abs() / 2.0;
        }
        area
    }

    fn sq(size: f64) -> Vec<PathCmd> {
        vec![
            PathCmd::MoveTo(0.0, 0.0),
            PathCmd::LineTo(size, 0.0),
            PathCmd::LineTo(size, size),
            PathCmd::LineTo(0.0, size),
            PathCmd::Close,
        ]
    }

    #[test]
    fn boolean_areas_match_set_theory() {
        // two 100x100 squares overlapping by 50x100 -> known areas
        let a = sq(100.0);
        let b = sq(100.0);
        let cases = [
            (BoolOp::Union, 15000.0),    // 100*100*2 - 50*100
            (BoolOp::Intersect, 5000.0), // 50*100
            (BoolOp::Subtract, 5000.0),  // 100*100 - 5000
            (BoolOp::Exclude, 10000.0),  // union - intersect
        ];
        for (op, expected) in cases {
            let (path, _, _) = boolean_paths(&a, (0.0, 0.0), &b, (50.0, 0.0), op);
            assert!(!path.is_empty(), "{op:?}: empty result");
            let area = area_of(&path);
            let err = (area - expected).abs() / expected;
            assert!(
                err < 0.08,
                "{op:?}: area {area:.0} vs expected {expected:.0} ({:.1}% off)",
                err * 100.0
            );
        }
    }

    #[test]
    fn union_of_disjoint_shapes_keeps_both() {
        let a = sq(100.0);
        let b = sq(80.0);
        let (path, _, _) = boolean_paths(&a, (0.0, 0.0), &b, (300.0, 20.0), BoolOp::Union);
        assert!(!path.is_empty(), "disjoint union must keep both shapes");
        let area = area_of(&path);
        let expected = 100.0 * 100.0 + 80.0 * 80.0;
        assert!(
            (area - expected).abs() / expected < 0.1,
            "area {area} vs {expected}"
        );
        let contours = path
            .iter()
            .filter(|c| matches!(c, PathCmd::MoveTo(..)))
            .count();
        assert!(
            contours >= 2,
            "two separate contours expected, got {contours}"
        );
    }

    #[test]
    fn subtract_disjoint_keeps_a_intersect_empty() {
        let a = sq(50.0);
        let b = sq(50.0);
        // b far away
        let (path, _, _) = boolean_paths(&a, (0.0, 0.0), &b, (500.0, 0.0), BoolOp::Subtract);
        let area = area_of(&path);
        assert!(
            (area - 2500.0).abs() / 2500.0 < 0.08,
            "subtract-disjoint keeps A: {area}"
        );
        let (path, _, _) = boolean_paths(&a, (0.0, 0.0), &b, (500.0, 0.0), BoolOp::Intersect);
        assert!(
            path.is_empty() || area_of(&path) < 100.0,
            "disjoint intersect ~empty"
        );
    }

    #[test]
    fn subtract_hole_yields_ring_with_two_contours() {
        // big square minus centered small square -> ring (2 contours, even-odd)
        let a = sq(100.0);
        let b = sq(40.0);
        let (path, _, _) = boolean_paths(&a, (0.0, 0.0), &b, (30.0, 30.0), BoolOp::Subtract);
        let contours = path
            .iter()
            .filter(|c| matches!(c, PathCmd::MoveTo(..)))
            .count();
        assert!(
            contours >= 2,
            "ring needs an outer and an inner contour, got {contours}"
        );
        let area = area_of(&path);
        // outer 10000 + hole traced as its own contour: |area| sums both
        // even-odd rendering makes the hole transparent; area check loose
        assert!(area > 9000.0, "ring area sum: {area}");
    }
}
