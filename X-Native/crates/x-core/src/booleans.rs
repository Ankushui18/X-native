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

use crate::{Node, NodeKind, PathCmd, StrokeJoin};

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
        NodeKind::Arc { start, end, ratio } => Some(arc_path_cmds(n.w, n.h, *start, *end, *ratio)),
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
        NodeKind::Poly { sides } => Some(poly_path_cmds(n.w, n.h, *sides)),
        NodeKind::Star { points, ratio } => Some(star_path_cmds(n.w, n.h, *points, *ratio)),
        NodeKind::Line => Some(vec![PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(n.w, n.h)]),
        _ => None,
    }
}

/// The point `frac` of the way out from the centre to the ellipse's edge, at
/// `deg` degrees — LOCAL node space, the box the arc's properties never move.
/// The geometry below and the canvas handles both read it, so what is drawn
/// and what can be grabbed cannot disagree.
pub fn arc_point(w: f64, h: f64, deg: f64, frac: f64) -> (f64, f64) {
    let (rx, ry) = ((w / 2.0).max(1e-6), (h / 2.0).max(1e-6));
    let t = deg.to_radians();
    (rx + rx * frac * t.cos(), ry + ry * frac * t.sin())
}

/// An arc's signed sweep: `end - start`, with equal angles read as the whole
/// circle. The sign is part of the shape — Figma: "dragging the handle up
/// will produce a positive percentage, while dragging the handle down will
/// indicate a negative percentage" — so it is never folded with `rem_euclid`.
pub fn arc_sweep(start: f64, end: f64) -> f64 {
    let sweep = end - start;
    if sweep.abs() < 1e-9 {
        360.0
    } else {
        sweep.clamp(-360.0, 360.0)
    }
}

/// Elliptical-arc geometry (y-down space, degrees from east, clockwise
/// positive): cubic-bezier approximation, <= 90 degrees per segment, CLOSED —
/// the region Figma's arc properties describe. `ratio` is the fraction of the
/// radius the middle is cut back to, so 0 is a solid wedge through the centre
/// and 0.85 a thin ring; the ring is a hole because its inner edge is walked
/// the other way round (NonZero winding). Equal `start` and `end` is the full
/// ellipse, closed ring included.
///
/// ONE outline for everything that draws or measures an arc — the fill, the
/// stroke, a mask, flatten, outline stroke and the exporters — so the shape on
/// screen and the shape in the file cannot drift apart.
pub fn arc_path_cmds(w: f64, h: f64, start: f64, end: f64, ratio: f64) -> Vec<PathCmd> {
    let (cx, cy) = (w / 2.0, h / 2.0);
    let ratio = ratio.clamp(0.0, 1.0);
    let sweep = arc_sweep(start, end);
    let (x0, y0) = arc_point(w, h, start, 1.0);
    let mut cmds = vec![PathCmd::MoveTo(x0, y0)];
    arc_segments(&mut cmds, w, h, start, sweep, 1.0);
    if ratio > 1e-6 {
        let (ix, iy) = arc_point(w, h, start + sweep, ratio);
        cmds.push(PathCmd::LineTo(ix, iy));
        arc_segments(&mut cmds, w, h, start + sweep, -sweep, ratio);
    } else if sweep.abs() < 360.0 - 1e-9 {
        // a wedge closes through the centre
        cmds.push(PathCmd::LineTo(cx, cy));
    }
    cmds.push(PathCmd::Close);
    cmds
}

/// Emit one elliptical arc as cubic segments at `frac` of the radius — signed
/// `sweep`, so a negative value walks back the other way round.
fn arc_segments(cmds: &mut Vec<PathCmd>, w: f64, h: f64, from: f64, sweep: f64, frac: f64) {
    let (rx, ry) = ((w / 2.0).max(1e-6), (h / 2.0).max(1e-6));
    let n = ((sweep.abs() / 90.0).ceil() as usize).max(1);
    let seg = sweep / n as f64;
    // kappa: the standard circular-arc control offset (4/3) tan(theta/4); 0.5523
    // for a quarter. Signed with the segment, so the arms stay on the inside of
    // a counter-clockwise arc too.
    let kappa = 4.0 / 3.0 * (seg.to_radians() / 4.0).tan();
    let tangent = |deg: f64| {
        let t = deg.to_radians();
        (-rx * frac * t.sin(), ry * frac * t.cos())
    };
    for i in 0..n {
        let a0 = from + seg * i as f64;
        let a1 = a0 + seg;
        let (x0, y0) = arc_point(w, h, a0, frac);
        let (x1, y1) = arc_point(w, h, a1, frac);
        let (t0x, t0y) = tangent(a0);
        let (t1x, t1y) = tangent(a1);
        cmds.push(PathCmd::CurveTo(
            x0 + t0x * kappa,
            y0 + t0y * kappa,
            x1 - t1x * kappa,
            y1 - t1y * kappa,
            x1,
            y1,
        ));
    }
}

/// The Count bounds Figma documents for both a polygon's sides and a star's
/// points: "The minimum is three and the maximum is 60."
pub const COUNT_MIN: usize = 3;
pub const COUNT_MAX: usize = 60;

/// Figma's default star is "a five pointed star with ten sides"; the inner
/// points sit at 38.2% of the radius, the classic five-point star.
pub const STAR_RATIO: f64 = 0.382;

fn clamp_count(n: usize) -> usize {
    n.clamp(COUNT_MIN, COUNT_MAX)
}

fn ring_cmds(pts: &[(f64, f64)]) -> Vec<PathCmd> {
    let mut out = Vec::with_capacity(pts.len() + 2);
    for (i, p) in pts.iter().enumerate() {
        if i == 0 {
            out.push(PathCmd::MoveTo(p.0, p.1));
        } else {
            out.push(PathCmd::LineTo(p.0, p.1));
        }
    }
    out.push(PathCmd::Close);
    out
}

/// Figma's Polygon: `sides` vertices on the ellipse inscribed in the box, the
/// first one at the top — "the default shape for the polygon tool is a
/// triangle" — walking clockwise. LOCAL node space, like the arc's geometry,
/// so the shape is an appearance of the box and never resizes it.
pub fn poly_path_cmds(w: f64, h: f64, sides: usize) -> Vec<PathCmd> {
    let n = clamp_count(sides);
    let pts: Vec<(f64, f64)> = (0..n)
        .map(|k| arc_point(w, h, -90.0 + 360.0 * k as f64 / n as f64, 1.0))
        .collect();
    ring_cmds(&pts)
}

/// Figma's Star: `points` outer vertices with the inner ones at `ratio` of the
/// radius between them, so a five-point star has ten vertices. The first
/// vertex is at the top, like the polygon's.
pub fn star_path_cmds(w: f64, h: f64, points: usize, ratio: f64) -> Vec<PathCmd> {
    let n = clamp_count(points);
    let inner = ratio.clamp(0.05, 0.95);
    let pts: Vec<(f64, f64)> = (0..n * 2)
        .map(|k| {
            let frac = if k % 2 == 0 { 1.0 } else { inner };
            arc_point(w, h, -90.0 + 180.0 * k as f64 / n as f64, frac)
        })
        .collect();
    ring_cmds(&pts)
}

/// Is the LOCAL point (x, y) on the shape: inside the filled outline, or
/// within `tol` of it so the stroke is grabbable? The polygon and the star are
/// both simple polygons, so one crossing test on the flattened path answers
/// for either.
pub fn path_hit(cmds: &[PathCmd], x: f64, y: f64, tol: f64) -> bool {
    let polys = path_to_polylines(cmds, 2);
    if path_is_closed(cmds) && point_in(&polys, x, y) {
        return true;
    }
    polys.iter().any(|poly| {
        let n = poly.len();
        (0..n).any(|i| {
            let (a, b) = (poly[i], poly[(i + 1) % n]);
            dist_to_seg(a, b, (x, y)) <= tol
        })
    })
}

fn dist_to_seg(a: (f64, f64), b: (f64, f64), p: (f64, f64)) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len2 = dx * dx + dy * dy;
    let t = if len2 <= 1e-12 {
        0.0
    } else {
        (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len2).clamp(0.0, 1.0)
    };
    ((p.0 - (a.0 + dx * t)).powi(2) + (p.1 - (a.1 + dy * t)).powi(2)).sqrt()
}

// ---------------------------------------------- outline-stroke geometry

/// Flatten PathCmds into polylines (cubics subdivided `steps` times).
/// One polyline per subpath; `Close` ends its subpath.
pub fn path_to_polylines(cmds: &[PathCmd], steps: usize) -> Vec<Vec<(f64, f64)>> {
    subpaths(cmds, steps)
        .into_iter()
        .map(|(pts, _closed)| pts)
        .collect()
}

/// Like [`path_to_polylines`], but each subpath keeps the bit the caller
/// usually needs next: whether it ended with an explicit `Close`. Shared by
/// the outline-stroke and path-offset geometry so there is exactly one cubic
/// flattener in the crate.
fn subpaths(cmds: &[PathCmd], steps: usize) -> Vec<(Vec<(f64, f64)>, bool)> {
    let mut out: Vec<(Vec<(f64, f64)>, bool)> = vec![];
    let mut cur: Vec<(f64, f64)> = vec![];
    let mut last = (0.0, 0.0);
    let steps = steps.max(1);
    for c in cmds {
        match *c {
            PathCmd::MoveTo(x, y) => {
                if cur.len() >= 2 {
                    out.push((std::mem::take(&mut cur), false));
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
                    out.push((std::mem::take(&mut cur), true));
                }
                cur = vec![];
            }
        }
    }
    if cur.len() >= 2 {
        out.push((cur, false));
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

fn offset_polyline(pts: &[(f64, f64)], d: f64, closed: bool) -> Vec<(f64, f64)> {
    vertex_miters(pts, closed)
        .iter()
        .zip(pts)
        .map(|((m, scale), p)| (p.0 + m.0 * d * scale, p.1 + m.1 * d * scale))
        .collect()
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

// ---------------------------------------------------------------- path offset

/// Cubic flattening resolution for [`offset_path`]: subdivisions per cubic.
/// 12 matches the outline-stroke path, so "offset" and "outline stroke" agree
/// on how a curve becomes a polyline.
pub const OFFSET_FLATTEN_STEPS: usize = 12;

/// Shoelace area in y-down page space: positive = clockwise on screen.
fn signed_area(pts: &[(f64, f64)]) -> f64 {
    if pts.len() < 3 {
        return 0.0;
    }
    let mut a = 0.0;
    let mut j = pts.len() - 1;
    for i in 0..pts.len() {
        a += pts[j].0 * pts[i].1 - pts[i].0 * pts[j].1;
        j = i;
    }
    a * 0.5
}

/// Per-vertex (incoming edge normal, outgoing edge normal); `None` for a
/// degenerate edge, and both `None` at the ends of an open polyline.
/// Per-vertex `(incoming normal, outgoing normal)`; the alias exists because the
/// nested option pairs are unreadable at a call site and clippy's
/// `type_complexity` is denied workspace-wide.
type VertexNormals = Vec<(Option<(f64, f64)>, Option<(f64, f64)>)>;

fn vertex_normals(pts: &[(f64, f64)], closed: bool) -> VertexNormals {
    let n = pts.len();
    let usable = |v: (f64, f64)| (v.0.abs() + v.1.abs() > 1e-9).then_some(v);
    (0..n)
        .map(|i| {
            let prev = if i > 0 {
                pts[i - 1]
            } else if closed && n > 1 {
                pts[n - 1]
            } else {
                pts[i]
            };
            let next = if i + 1 < n {
                pts[i + 1]
            } else if closed && n > 1 {
                pts[0]
            } else {
                pts[i]
            };
            (
                usable(seg_normal(prev, pts[i])),
                usable(seg_normal(pts[i], next)),
            )
        })
        .collect()
}

/// Bevel join: two offset points per corner (one per adjacent edge normal).
fn offset_bevel(pts: &[(f64, f64)], d: f64, closed: bool) -> Vec<(f64, f64)> {
    let mut out: Vec<(f64, f64)> = vec![];
    for ((n1, n2), p) in vertex_normals(pts, closed).into_iter().zip(pts) {
        let push = |out: &mut Vec<(f64, f64)>, n: (f64, f64)| {
            let q = (p.0 + n.0 * d, p.1 + n.1 * d);
            let far_enough = out
                .last()
                .is_none_or(|r: &(f64, f64)| (r.0 - q.0).hypot(r.1 - q.1) > 1e-9);
            if far_enough {
                out.push(q);
            }
        };
        if let Some(n) = n1.or(n2) {
            push(&mut out, n);
        }
        if let Some(n) = n2 {
            push(&mut out, n);
        }
    }
    out
}

/// Round join: interpolate the normal direction across the corner in <= 15
/// degree steps, so a round corner is a short polyline arc.
fn offset_round(pts: &[(f64, f64)], d: f64, closed: bool) -> Vec<(f64, f64)> {
    use std::f64::consts::{PI, TAU};
    const STEP: f64 = PI / 12.0;
    let mut out: Vec<(f64, f64)> = vec![];
    for ((n1, n2), p) in vertex_normals(pts, closed).into_iter().zip(pts) {
        match (n1, n2) {
            (Some(a), Some(b)) => {
                let (a0, a1) = (a.1.atan2(a.0), b.1.atan2(b.0));
                let mut delta = (a1 - a0) % TAU;
                if delta > PI {
                    delta -= TAU;
                } else if delta < -PI {
                    delta += TAU;
                }
                let steps = ((delta.abs() / STEP).ceil() as usize).max(1);
                for i in 0..=steps {
                    let ang = a0 + delta * (i as f64 / steps as f64);
                    out.push((p.0 + ang.cos() * d, p.1 + ang.sin() * d));
                }
            }
            (Some(a), None) | (None, Some(a)) => out.push((p.0 + a.0 * d, p.1 + a.1 * d)),
            (None, None) => out.push(*p),
        }
    }
    out
}

/// Offset a path along its vertex normals — the honest version of Figma's
/// "Offset path" (`Object > Offset path`).
///
/// Positive `distance` moves a CLOSED subpath OUTWARD and an open subpath to
/// the left of travel; negative moves inward / right. Outward is decided by
/// measuring the subpath's winding, not by assuming one, so a counter-clockwise
/// hole in a compound path still offsets the way the designer expects.
///
/// Curves are flattened to polylines first ([`OFFSET_FLATTEN_STEPS`]
/// subdivisions per cubic), so an offset path comes back polygonal — the same
/// trade Figma makes when it re-authors the path. Corner treatment follows
/// `join`: `Miter` reuses the stroke-outline miter (bounded by a 4x miter
/// limit, past which it bevels), `Bevel` emits two points per corner, `Round`
/// interpolates the normal across the corner.
///
/// Returns an empty vec when there is nothing to offset: a zero distance, or a
/// path with no subpath of at least two points.
pub fn offset_path(cmds: &[PathCmd], distance: f64, join: StrokeJoin) -> Vec<PathCmd> {
    if !distance.is_finite() || distance.abs() < 1e-9 {
        return vec![];
    }
    let mut out: Vec<PathCmd> = vec![];
    for (pts, closed) in subpaths(cmds, OFFSET_FLATTEN_STEPS) {
        if pts.len() < 2 {
            continue;
        }
        // `seg_normal` is the LEFT normal, which points INWARD for a
        // clockwise-on-screen polygon — flip by winding so +d is outward.
        let d = if closed && signed_area(&pts) > 0.0 {
            -distance
        } else {
            distance
        };
        let ring = match join {
            StrokeJoin::Miter => offset_polyline(&pts, d, closed),
            StrokeJoin::Bevel => offset_bevel(&pts, d, closed),
            StrokeJoin::Round => offset_round(&pts, d, closed),
        };
        if ring.len() < 2 {
            continue;
        }
        out.push(PathCmd::MoveTo(ring[0].0, ring[0].1));
        for q in ring.iter().skip(1) {
            out.push(PathCmd::LineTo(q.0, q.1));
        }
        if closed {
            out.push(PathCmd::Close);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Color;

    #[test]
    fn a_quarter_arc_is_a_wedge_through_the_centre() {
        // ratio 0: the outer quarter, then straight in to the centre and
        // closed — a pie slice, which is what Figma draws for sweep 90
        let cmds = arc_path_cmds(100.0, 100.0, 0.0, 90.0, 0.0);
        assert_eq!(cmds.len(), 4, "MoveTo + curve + LineTo + Close");
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
        let through_centre = matches!(
            cmds[2],
            PathCmd::LineTo(x, y) if (x - 50.0).abs() < 1e-9 && (y - 50.0).abs() < 1e-9
        );
        assert!(through_centre, "the wedge closes through the centre");
        assert!(matches!(cmds[3], PathCmd::Close));
    }

    #[test]
    fn a_ratio_cuts_a_ring_out_of_the_wedge() {
        // ratio 0.5: the centre is replaced by an inner arc, walked the other
        // way round so NonZero winding leaves a hole
        let ring = arc_path_cmds(100.0, 100.0, 0.0, 180.0, 0.5);
        assert_eq!(
            ring.iter()
                .filter(|c| matches!(c, PathCmd::CurveTo(..)))
                .count(),
            4,
            "two 90-deg segments out, two back"
        );
        let seam = matches!(
            ring[3],
            PathCmd::LineTo(x, y) if (x - 25.0).abs() < 1e-9 && (y - 50.0).abs() < 1e-9
        );
        assert!(seam, "the inner edge starts at half the radius");
        assert!(matches!(ring.last(), Some(PathCmd::Close)));
        // the wedge form has no inner edge at all
        let wedge = arc_path_cmds(100.0, 100.0, 0.0, 180.0, 0.0);
        assert_eq!(
            wedge
                .iter()
                .filter(|c| matches!(c, PathCmd::CurveTo(..)))
                .count(),
            2
        );
        // arc_point is the one place the geometry and the handles agree
        let (px, py) = arc_point(100.0, 100.0, 180.0, 0.5);
        assert!((px - 25.0).abs() < 1e-9 && (py - 50.0).abs() < 1e-9);
    }

    #[test]
    fn arc_full_circle_and_arbitrary_sweep() {
        // start == end -> full ellipse: 4 quarter segments, closed
        let full = arc_path_cmds(80.0, 40.0, 0.0, 0.0, 0.0);
        assert_eq!(full.len(), 6, "MoveTo + 4 curves + Close");
        assert!(matches!(full.last(), Some(PathCmd::Close)));
        assert_eq!(arc_sweep(30.0, 30.0), 360.0, "equal angles are the circle");
        // a full circle WITH a ratio is a closed ring: outer loop, seam,
        // inner loop the other way round
        let ring = arc_path_cmds(80.0, 40.0, 0.0, 0.0, 0.75);
        assert_eq!(ring.len(), 11, "MoveTo + 4 + LineTo + 4 + Close");
        assert_eq!(
            ring.iter()
                .filter(|c| matches!(c, PathCmd::CurveTo(..)))
                .count(),
            8
        );
        // 200-deg sweep -> 3 segments (ceil(200/90))
        let sweep = arc_path_cmds(80.0, 40.0, 10.0, 210.0, 0.0);
        assert_eq!(
            sweep
                .iter()
                .filter(|c| matches!(c, PathCmd::CurveTo(..)))
                .count(),
            3
        );
        // the sweep is SIGNED: 210 -> 10 walks back the other way
        assert_eq!(arc_sweep(210.0, 10.0), -200.0);
        let back = arc_path_cmds(80.0, 40.0, 210.0, 10.0, 0.0);
        assert_eq!(
            back.iter()
                .filter(|c| matches!(c, PathCmd::CurveTo(..)))
                .count(),
            3,
            "-200 deg -> 3 segments, same count the other way"
        );
    }

    #[test]
    fn a_polygon_is_a_ring_of_sides_whose_first_is_the_top() {
        // Figma: "an enclosed shape that is made up of any number of straight
        // lines", a triangle by default — every vertex on the box's rim, in
        // the box's own space, so the box never becomes the shape.
        let cmds = poly_path_cmds(100.0, 100.0, 3);
        assert_eq!(cmds.len(), 4, "three vertices and the Close");
        assert!(
            matches!(cmds[0], PathCmd::MoveTo(x, y) if (x - 50.0).abs() < 1e-9 && y.abs() < 1e-9),
            "the first vertex is the top of the box"
        );
        let verts: Vec<(f64, f64)> = cmds
            .iter()
            .filter_map(|c| match c {
                PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => Some((*x, *y)),
                _ => None,
            })
            .collect();
        assert_eq!(verts.len(), 3, "a triangle has three");
        for (x, y) in &verts {
            let (dx, dy) = ((*x - 50.0) / 50.0, (*y - 50.0) / 50.0);
            let r = (dx * dx + dy * dy).sqrt();
            assert!((r - 1.0).abs() < 1e-9, "vertex {x},{y} sits on the rim");
        }
        assert!(matches!(cmds.last(), Some(PathCmd::Close)));
        // Figma's Count is clamped to 3..60 whatever the caller says
        assert_eq!(poly_path_cmds(100.0, 100.0, 1).len(), 4, "the floor is 3");
        assert_eq!(
            poly_path_cmds(100.0, 100.0, 200).len(),
            COUNT_MAX + 1,
            "the ceiling is 60"
        );
    }

    #[test]
    fn a_star_alternates_outside_points_with_ratio_inside_ones() {
        // "The default will be a five pointed star with ten sides": five
        // outside vertices on the rim, five at the Ratio between them.
        let cmds = star_path_cmds(100.0, 100.0, 5, STAR_RATIO);
        assert_eq!(cmds.len(), 11, "ten sides and the Close");
        assert!(matches!(cmds.last(), Some(PathCmd::Close)));
        let verts: Vec<(f64, f64)> = cmds
            .iter()
            .filter_map(|c| match c {
                PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => Some((*x, *y)),
                _ => None,
            })
            .collect();
        assert_eq!(verts.len(), 10, "five points and five notches");
        for (k, (x, y)) in verts.iter().enumerate() {
            let (dx, dy) = ((*x - 50.0) / 50.0, (*y - 50.0) / 50.0);
            let r = (dx * dx + dy * dy).sqrt();
            let want = if k % 2 == 0 { 1.0 } else { STAR_RATIO };
            assert!((r - want).abs() < 1e-9, "vertex {k} at {r}, not {want}");
        }
        assert_eq!(
            star_path_cmds(100.0, 100.0, 7, 0.2).len(),
            15,
            "seven points is fifteen sides"
        );
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

    // ------------------------------------------------------- offset_path

    /// The same square traced the other way: counter-clockwise on screen.
    fn sq_ccw(size: f64) -> Vec<PathCmd> {
        vec![
            PathCmd::MoveTo(0.0, 0.0),
            PathCmd::LineTo(0.0, size),
            PathCmd::LineTo(size, size),
            PathCmd::LineTo(size, 0.0),
            PathCmd::Close,
        ]
    }

    #[test]
    fn offset_path_grows_a_closed_square_outward() {
        // 90-degree corners: the miter point is exact, so +10 on a 100x100
        // square must produce exactly a 120x120 square.
        let out = offset_path(&sq(100.0), 10.0, StrokeJoin::Miter);
        assert!(!out.is_empty(), "offset produced nothing");
        assert!(
            matches!(out.last(), Some(PathCmd::Close)),
            "a closed subpath stays closed"
        );
        let area = area_of(&out);
        assert!(
            (area - 14400.0).abs() / 14400.0 < 0.01,
            "100+10+10 squared = 14400, got {area}"
        );
    }

    #[test]
    fn offset_path_negative_distance_offsets_inward() {
        let out = offset_path(&sq(100.0), -10.0, StrokeJoin::Miter);
        let area = area_of(&out);
        assert!(
            (area - 6400.0).abs() / 6400.0 < 0.01,
            "100-10-10 squared = 6400, got {area}"
        );
    }

    #[test]
    fn offset_path_measures_winding_instead_of_assuming_it() {
        // Same outline, opposite winding: +10 must still grow it outward.
        let cw = area_of(&offset_path(&sq(100.0), 10.0, StrokeJoin::Miter));
        let ccw = area_of(&offset_path(&sq_ccw(100.0), 10.0, StrokeJoin::Miter));
        assert!(
            (cw - ccw).abs() / cw < 0.01,
            "winding must not change the result: cw {cw} vs ccw {ccw}"
        );
        assert!(cw > 10000.0, "both grew outward, got {cw}");
    }

    #[test]
    fn offset_path_round_join_subdivides_the_corner() {
        let miter = offset_path(&sq(100.0), 10.0, StrokeJoin::Miter);
        let bevel = offset_path(&sq(100.0), 10.0, StrokeJoin::Bevel);
        let round = offset_path(&sq(100.0), 10.0, StrokeJoin::Round);
        let pts = |p: &[PathCmd]| {
            p.iter()
                .filter(|c| matches!(c, PathCmd::LineTo(..)))
                .count()
        };
        assert_eq!(pts(&miter), 3, "miter keeps one point per corner");
        assert!(
            pts(&bevel) > pts(&miter),
            "bevel emits two points per corner: {} vs {}",
            pts(&bevel),
            pts(&miter)
        );
        assert!(
            pts(&round) > pts(&bevel),
            "round interpolates across the corner: {} vs {}",
            pts(&round),
            pts(&bevel)
        );
        // all three enclose the same area to within the chord error of the
        // round approximation
        let (am, ab, ar) = (area_of(&miter), area_of(&bevel), area_of(&round));
        assert!((am - ab).abs() / am < 0.02, "bevel area {ab} vs {am}");
        assert!((am - ar).abs() / am < 0.02, "round area {ar} vs {am}");
    }

    #[test]
    fn offset_path_leaves_an_open_subpath_open() {
        let open = vec![PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(100.0, 0.0)];
        let out = offset_path(&open, 10.0, StrokeJoin::Miter);
        assert!(
            !out.iter().any(|c| matches!(c, PathCmd::Close)),
            "an open path must not gain a Close"
        );
        // left of travel (+x) is +y in page space
        assert!(
            matches!(out.first(), Some(PathCmd::MoveTo(_, y)) if (*y - 10.0).abs() < 1e-9),
            "open paths offset to the left of travel: {out:?}"
        );
    }

    #[test]
    fn offset_path_refuses_a_zero_or_degenerate_request() {
        assert!(
            offset_path(&sq(100.0), 0.0, StrokeJoin::Miter).is_empty(),
            "zero distance is a no-op, not a copy"
        );
        assert!(
            offset_path(&sq(100.0), f64::NAN, StrokeJoin::Miter).is_empty(),
            "NaN distance is refused"
        );
        assert!(
            offset_path(&[PathCmd::MoveTo(0.0, 0.0)], 10.0, StrokeJoin::Miter).is_empty(),
            "a single point cannot be offset"
        );
    }

    #[test]
    fn offset_path_flattens_curves_before_offsetting() {
        // a full circle of two cubics: the offset ring must have many more
        // points than the input, and its area must grow by ~2*pi*r*d
        let r = 50.0;
        let k = 0.5523 * r;
        let circle = vec![
            PathCmd::MoveTo(r + r, r),
            PathCmd::CurveTo(r + r, r + k, r + k, r + r, r, r + r),
            PathCmd::CurveTo(r - k, r + r, 0.0, r + k, 0.0, r),
            PathCmd::CurveTo(0.0, r - k, r - k, 0.0, r, 0.0),
            PathCmd::CurveTo(r + k, 0.0, r + r, r - k, r + r, r),
            PathCmd::Close,
        ];
        let before = area_of(&circle);
        let out = offset_path(&circle, 5.0, StrokeJoin::Round);
        let after = area_of(&out);
        let expected = std::f64::consts::PI * (r + 5.0).powi(2);
        assert!(
            out.iter()
                .filter(|c| matches!(c, PathCmd::LineTo(..)))
                .count()
                > 20,
            "the flattened ring is a polygon, got {:?}",
            out.len()
        );
        assert!(after > before, "grew: {before} -> {after}");
        assert!(
            (after - expected).abs() / expected < 0.03,
            "offset circle area {after} vs expected {expected}"
        );
    }
}
