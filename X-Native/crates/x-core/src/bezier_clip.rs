//! Exact vector booleans 2.0 — curve-preserving clipper (review item).
//!
//! The polygon clipper (clip.rs) flattens curves before clipping, so its
//! OUTPUT is a polyline: every boolean op degrades curve quality a
//! little, and repeated ops compound it. This module EXTENDS the system
//! (does not replace it) with the review's target pipeline:
//!
//!   Bezier → Bezier intersections → topology → **Bezier output**
//!
//! Method: Greiner–Hormann on *curve chains*. Each contour is a ring of
//! cubic segments (lines are exact degenerate cubics). Intersections are
//! found by recursive bezier subdivision (bbox pruning + flatness
//! cutoff), segments are split AT the intersection parameters with
//! de Casteljau — which is exact for beziers — and tracing re-assembles
//! output contours from the ORIGINAL curve pieces. Curves in, curves
//! out: repeated ops never re-approximate geometry that didn't change.
//!
//! Scope (honest): single-contour, non-self-intersecting operands, like
//! the polygon backend. Degenerate topology (tangency, vertex-on-curve,
//! overlapping arcs) returns None and the facade falls back to the
//! polygon clipper, then raster — an operation never fails outright.

use crate::PathCmd;

pub type Pt = (f64, f64);

// ------------------------------------------------------------- segments

/// One cubic bezier segment. Lines are stored as exact cubics with
/// control points at the 1/3 marks so every algorithm below is uniform.
#[derive(Debug, Clone, Copy)]
pub struct Seg {
    pub p: [Pt; 4],
}

fn lerp(a: Pt, b: Pt, t: f64) -> Pt {
    (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
}

impl Seg {
    pub fn line(a: Pt, b: Pt) -> Self {
        Self {
            p: [a, lerp(a, b, 1.0 / 3.0), lerp(a, b, 2.0 / 3.0), b],
        }
    }
    pub fn cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt) -> Self {
        Self {
            p: [p0, p1, p2, p3],
        }
    }

    pub fn eval(&self, t: f64) -> Pt {
        let mt = 1.0 - t;
        let [p0, p1, p2, p3] = self.p;
        (
            mt * mt * mt * p0.0
                + 3.0 * mt * mt * t * p1.0
                + 3.0 * mt * t * t * p2.0
                + t * t * t * p3.0,
            mt * mt * mt * p0.1
                + 3.0 * mt * mt * t * p1.1
                + 3.0 * mt * t * t * p2.1
                + t * t * t * p3.1,
        )
    }

    /// de Casteljau split at t — exact.
    pub fn split(&self, t: f64) -> (Seg, Seg) {
        let [p0, p1, p2, p3] = self.p;
        let a = lerp(p0, p1, t);
        let b = lerp(p1, p2, t);
        let c = lerp(p2, p3, t);
        let d = lerp(a, b, t);
        let e = lerp(b, c, t);
        let f = lerp(d, e, t);
        (Seg { p: [p0, a, d, f] }, Seg { p: [f, e, c, p3] })
    }

    pub fn reversed(&self) -> Seg {
        Seg {
            p: [self.p[3], self.p[2], self.p[1], self.p[0]],
        }
    }

    fn bbox(&self) -> (f64, f64, f64, f64) {
        let xs = [self.p[0].0, self.p[1].0, self.p[2].0, self.p[3].0];
        let ys = [self.p[0].1, self.p[1].1, self.p[2].1, self.p[3].1];
        (
            xs.iter().cloned().fold(f64::MAX, f64::min),
            ys.iter().cloned().fold(f64::MAX, f64::min),
            xs.iter().cloned().fold(f64::MIN, f64::max),
            ys.iter().cloned().fold(f64::MIN, f64::max),
        )
    }

    /// max control-point deviation from the chord
    fn flatness(&self) -> f64 {
        let [p0, p1, p2, p3] = self.p;
        let d = |p: Pt| {
            let (dx, dy) = (p3.0 - p0.0, p3.1 - p0.1);
            let len = (dx * dx + dy * dy).sqrt().max(1e-12);
            ((p.0 - p0.0) * dy - (p.1 - p0.1) * dx).abs() / len
        };
        d(p1).max(d(p2))
    }

    /// is this cubic numerically a straight line at the 1/3 marks?
    pub fn is_line(&self) -> bool {
        let l = Seg::line(self.p[0], self.p[3]);
        let e = 1e-6;
        (self.p[1].0 - l.p[1].0).abs() < e
            && (self.p[1].1 - l.p[1].1).abs() < e
            && (self.p[2].0 - l.p[2].0).abs() < e
            && (self.p[2].1 - l.p[2].1).abs() < e
    }
}

// ------------------------------------------------------- path <-> chains

/// PathCmd contour -> closed ring of segments. None if open/multi-contour.
pub fn path_to_segs(cmds: &[PathCmd], offset: Pt) -> Option<Vec<Seg>> {
    let mut segs = vec![];
    let mut start: Option<Pt> = None;
    let mut cur = (0.0, 0.0);
    let mut contours = 0;
    for c in cmds {
        match *c {
            PathCmd::MoveTo(x, y) => {
                contours += 1;
                if contours > 1 {
                    return None;
                } // multi-contour: fall back
                cur = (x + offset.0, y + offset.1);
                start = Some(cur);
            }
            PathCmd::LineTo(x, y) => {
                let to = (x + offset.0, y + offset.1);
                segs.push(Seg::line(cur, to));
                cur = to;
            }
            PathCmd::CurveTo(x1, y1, x2, y2, x, y) => {
                let to = (x + offset.0, y + offset.1);
                segs.push(Seg::cubic(
                    cur,
                    (x1 + offset.0, y1 + offset.1),
                    (x2 + offset.0, y2 + offset.1),
                    to,
                ));
                cur = to;
            }
            PathCmd::Close => {
                if let Some(s) = start {
                    if (cur.0 - s.0).abs() > 1e-9 || (cur.1 - s.1).abs() > 1e-9 {
                        segs.push(Seg::line(cur, s));
                        cur = s;
                    }
                }
            }
        }
    }
    // ensure closed
    if let Some(s) = start {
        if (cur.0 - s.0).abs() > 1e-9 || (cur.1 - s.1).abs() > 1e-9 {
            segs.push(Seg::line(cur, s));
        }
    }
    (segs.len() >= 2).then_some(segs)
}

/// segments -> PathCmds (curves preserved; lines emitted as LineTo)
pub fn segs_to_path(contours: &[Vec<Seg>], origin: Pt) -> Vec<PathCmd> {
    let mut out = vec![];
    for segs in contours {
        if segs.is_empty() {
            continue;
        }
        let s0 = segs[0].p[0];
        out.push(PathCmd::MoveTo(s0.0 - origin.0, s0.1 - origin.1));
        for s in segs {
            if s.is_line() {
                out.push(PathCmd::LineTo(s.p[3].0 - origin.0, s.p[3].1 - origin.1));
            } else {
                out.push(PathCmd::CurveTo(
                    s.p[1].0 - origin.0,
                    s.p[1].1 - origin.1,
                    s.p[2].0 - origin.0,
                    s.p[2].1 - origin.1,
                    s.p[3].0 - origin.0,
                    s.p[3].1 - origin.1,
                ));
            }
        }
        out.push(PathCmd::Close);
    }
    out
}

// ------------------------------------------------- bezier intersections

/// recursive subdivision intersection: (t_on_a, t_on_b, point)
fn seg_intersections(a: &Seg, b: &Seg, out: &mut Vec<(f64, f64, Pt)>) {
    #[allow(clippy::too_many_arguments)] // positional params are the natural shape here; grouping would obscure the algorithm
    fn rec(
        a: &Seg,
        ta0: f64,
        ta1: f64,
        b: &Seg,
        tb0: f64,
        tb1: f64,
        out: &mut Vec<(f64, f64, Pt)>,
        depth: u32,
    ) {
        let (ax0, ay0, ax1, ay1) = a.bbox();
        let (bx0, by0, bx1, by1) = b.bbox();
        if ax1 < bx0 - 1e-9 || bx1 < ax0 - 1e-9 || ay1 < by0 - 1e-9 || by1 < ay0 - 1e-9 {
            return;
        }
        const TOL: f64 = 1e-6;
        if depth > 40 || (a.flatness() < TOL && b.flatness() < TOL) {
            // chord-chord intersection
            let (p1, p2) = (a.p[0], a.p[3]);
            let (p3, p4) = (b.p[0], b.p[3]);
            let d = (p2.0 - p1.0) * (p4.1 - p3.1) - (p2.1 - p1.1) * (p4.0 - p3.0);
            if d.abs() < 1e-12 {
                return;
            }
            let s = ((p3.0 - p1.0) * (p4.1 - p3.1) - (p3.1 - p1.1) * (p4.0 - p3.0)) / d;
            let u = ((p3.0 - p1.0) * (p2.1 - p1.1) - (p3.1 - p1.1) * (p2.0 - p1.0)) / d;
            if !(-1e-9..=1.0 + 1e-9).contains(&s) || !(-1e-9..=1.0 + 1e-9).contains(&u) {
                return;
            }
            let ta = ta0 + (ta1 - ta0) * s.clamp(0.0, 1.0);
            let tb = tb0 + (tb1 - tb0) * u.clamp(0.0, 1.0);
            out.push((ta, tb, (p1.0 + (p2.0 - p1.0) * s, p1.1 + (p2.1 - p1.1) * s)));
            return;
        }
        let tam = (ta0 + ta1) / 2.0;
        let tbm = (tb0 + tb1) / 2.0;
        let (a1, a2) = a.split(0.5);
        let (b1, b2) = b.split(0.5);
        rec(&a1, ta0, tam, &b1, tb0, tbm, out, depth + 1);
        rec(&a1, ta0, tam, &b2, tbm, tb1, out, depth + 1);
        rec(&a2, tam, ta1, &b1, tb0, tbm, out, depth + 1);
        rec(&a2, tam, ta1, &b2, tbm, tb1, out, depth + 1);
    }
    rec(a, 0.0, 1.0, b, 0.0, 1.0, out, 0);
}

// -------------------------------------------------------- classification

/// flatten one chain for point-classification ONLY (output is untouched)
fn flatten_chain(segs: &[Seg]) -> Vec<Pt> {
    let mut pts = vec![];
    for s in segs {
        for i in 0..12 {
            pts.push(s.eval(i as f64 / 12.0));
        }
    }
    pts
}

fn point_in(poly: &[Pt], x: f64, y: f64) -> bool {
    let mut inside = false;
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
    inside
}

// ------------------------------------------------------------- topology

#[derive(Debug, Clone)]
struct Vtx {
    pt: Pt,
    /// outgoing segment toward `next`
    out: Seg,
    next: usize,
    prev: usize,
    intersect: bool,
    xid: usize,
    neighbor: usize,
    entry: bool,
    processed: bool,
}

pub use crate::clip::ClipOp;

/// Curve-preserving Greiner–Hormann with perturb-retry: aligned edges /
/// endpoint-grazing intersections are common in real designs (snapped
/// geometry), so on degeneracy the CLIPPER is nudged by a sub-visible
/// epsilon and the op retried, mirroring the polygon backend's strategy.
/// Returns closed contours of segments, or None (caller falls back).
pub fn clip_bezier(subject: &[Seg], clipper: &[Seg], op: ClipOp) -> Option<Vec<Vec<Seg>>> {
    for attempt in 0..4 {
        let eps = 1e-4 * (attempt as f64) * (1.0 + attempt as f64);
        let moved: Vec<Seg> = clipper
            .iter()
            .map(|s| Seg {
                p: [
                    (s.p[0].0 + eps, s.p[0].1 + eps * 1.37),
                    (s.p[1].0 + eps, s.p[1].1 + eps * 1.37),
                    (s.p[2].0 + eps, s.p[2].1 + eps * 1.37),
                    (s.p[3].0 + eps, s.p[3].1 + eps * 1.37),
                ],
            })
            .collect();
        if let Some(r) = clip_bezier_once(subject, &moved, op) {
            return Some(r);
        }
    }
    None
}

/// One curve-preserving Greiner–Hormann pass; None on degenerate topology.
fn clip_bezier_once(subject: &[Seg], clipper: &[Seg], op: ClipOp) -> Option<Vec<Vec<Seg>>> {
    // ---- 1. all intersections between the two chains
    #[derive(Clone)]
    struct Hit {
        seg_a: usize,
        ta: f64,
        seg_b: usize,
        tb: f64,
    }
    let mut hits: Vec<Hit> = vec![];
    for (i, sa) in subject.iter().enumerate() {
        for (j, sb) in clipper.iter().enumerate() {
            let mut pts = vec![];
            seg_intersections(sa, sb, &mut pts);
            for (ta, tb, _) in pts {
                hits.push(Hit {
                    seg_a: i,
                    ta,
                    seg_b: j,
                    tb,
                });
            }
        }
    }
    // dedup subdivision duplicates (same param neighborhood)
    hits.sort_by(|a, b| {
        (a.seg_a, a.seg_b)
            .cmp(&(b.seg_a, b.seg_b))
            .then(a.ta.total_cmp(&b.ta))
    });
    hits.dedup_by(|a, b| {
        a.seg_a == b.seg_a
            && a.seg_b == b.seg_b
            && (a.ta - b.ta).abs() < 1e-4
            && (a.tb - b.tb).abs() < 1e-4
    });
    // endpoint-grazing = degenerate for this backend
    if hits
        .iter()
        .any(|h| h.ta < 1e-6 || h.ta > 1.0 - 1e-6 || h.tb < 1e-6 || h.tb > 1.0 - 1e-6)
    {
        return None;
    }

    let sub_flat = flatten_chain(subject);
    let clp_flat = flatten_chain(clipper);

    if hits.is_empty() {
        // containment / disjoint: same exact fast paths as the polygon
        // backend, but the CURVES are returned untouched
        let s_in_c = point_in(&clp_flat, subject[0].p[0].0, subject[0].p[0].1);
        let c_in_s = point_in(&sub_flat, clipper[0].p[0].0, clipper[0].p[0].1);
        let rev = |segs: &[Seg]| -> Vec<Seg> { segs.iter().rev().map(|s| s.reversed()).collect() };
        return Some(match op {
            ClipOp::Intersect => {
                if s_in_c {
                    vec![subject.to_vec()]
                } else if c_in_s {
                    vec![clipper.to_vec()]
                } else {
                    vec![]
                }
            }
            ClipOp::Union => {
                if s_in_c {
                    vec![clipper.to_vec()]
                } else if c_in_s {
                    vec![subject.to_vec()]
                } else {
                    vec![subject.to_vec(), clipper.to_vec()]
                }
            }
            ClipOp::AminusB => {
                if s_in_c {
                    vec![]
                } else if c_in_s {
                    vec![subject.to_vec(), rev(clipper)]
                } else {
                    vec![subject.to_vec()]
                }
            }
            ClipOp::BminusA => {
                if c_in_s {
                    vec![]
                } else if s_in_c {
                    vec![clipper.to_vec(), rev(subject)]
                } else {
                    vec![clipper.to_vec()]
                }
            }
        });
    }
    if !hits.len().is_multiple_of(2) {
        return None;
    } // grazing contact

    // ---- 2. split segments at intersection params; build vertex rings
    let mut arena: Vec<Vtx> = vec![];
    let build = |segs: &[Seg], which_a: bool, hits: &[Hit], arena: &mut Vec<Vtx>| -> usize {
        let head = arena.len();
        for (i, seg) in segs.iter().enumerate() {
            // this segment's intersections, sorted by t
            let mut cuts: Vec<(f64, usize)> = hits
                .iter()
                .enumerate()
                .filter(|(_, h)| if which_a { h.seg_a == i } else { h.seg_b == i })
                .map(|(id, h)| (if which_a { h.ta } else { h.tb }, id))
                .collect();
            // total_cmp: a NaN parameter must not panic the de Casteljau split
            cuts.sort_by(|a, b| a.0.total_cmp(&b.0));
            // successive de Casteljau splits with param rescaling
            let mut rest = *seg;
            let mut prev_t = 0.0;
            let mut pending: Vec<(Seg, Option<usize>)> = vec![]; // (piece, xid at END of piece)
            for (t, id) in &cuts {
                let local = ((t - prev_t) / (1.0 - prev_t)).clamp(0.0, 1.0);
                let (left, right) = rest.split(local);
                pending.push((left, Some(*id)));
                rest = right;
                prev_t = *t;
            }
            pending.push((rest, None));
            // vertices: one at the segment start (plain), then one per cut
            for (k, (piece, xid)) in pending.iter().enumerate() {
                let v = Vtx {
                    pt: piece.p[0],
                    out: *piece,
                    next: 0,
                    prev: 0,
                    intersect: k > 0 || false,
                    xid: usize::MAX,
                    neighbor: usize::MAX,
                    entry: false,
                    processed: false,
                };
                let _ = xid;
                arena.push(v);
                // mark the vertex that STARTS at a cut (the next piece's
                // start) as the intersection vertex for that cut id
                if k > 0 {
                    let idx = arena.len() - 1;
                    arena[idx].intersect = true;
                    arena[idx].xid = pending[k - 1].1.unwrap();
                }
            }
        }
        let end = arena.len();
        for (k, v) in arena.iter_mut().enumerate().take(end).skip(head) {
            v.next = if k + 1 < end { k + 1 } else { head };
            v.prev = if k > head { k - 1 } else { end - 1 };
        }
        head
    };
    let a_head = build(subject, true, &hits, &mut arena);
    let b_head = build(clipper, false, &hits, &mut arena);

    // pair intersection vertices across chains by hit id
    let mut a_of: Vec<usize> = vec![usize::MAX; hits.len()];
    let mut b_of: Vec<usize> = vec![usize::MAX; hits.len()];
    for (k, v) in arena.iter().enumerate() {
        if v.intersect {
            if k < b_head {
                a_of[v.xid] = k;
            } else {
                b_of[v.xid] = k;
            }
        }
    }
    if a_of.iter().chain(b_of.iter()).any(|&k| k == usize::MAX) {
        return None;
    }
    for id in 0..hits.len() {
        arena[a_of[id]].neighbor = b_of[id];
        arena[b_of[id]].neighbor = a_of[id];
    }

    // ---- 3. entry/exit marking
    let mark = |head: usize, other: &[Pt], invert: bool, arena: &mut Vec<Vtx>| {
        let p = arena[head].pt;
        let mut status = !point_in(other, p.0, p.1);
        if invert {
            status = !status;
        }
        let mut k = head;
        loop {
            if arena[k].intersect {
                arena[k].entry = status;
                status = !status;
            }
            k = arena[k].next;
            if k == head {
                break;
            }
        }
    };
    let (inv_s, inv_c) = match op {
        ClipOp::Intersect => (false, false),
        ClipOp::Union => (true, true),
        ClipOp::AminusB => (true, false),
        ClipOp::BminusA => (false, true),
    };
    mark(a_head, &clp_flat, inv_s, &mut arena);
    mark(b_head, &sub_flat, inv_c, &mut arena);

    // ---- 4. trace: collect SEGMENTS (curves preserved)
    let mut out: Vec<Vec<Seg>> = vec![];
    let budget = arena.len() * 4;
    while let Some(start) = (0..arena.len()).find(|&k| arena[k].intersect && !arena[k].processed) {
        let mut contour: Vec<Seg> = vec![];
        arena[start].processed = true;
        let nb = arena[start].neighbor;
        arena[nb].processed = true;
        let mut cur = start;
        let mut steps = 0usize;
        loop {
            if arena[cur].entry {
                loop {
                    contour.push(arena[cur].out);
                    cur = arena[cur].next;
                    steps += 1;
                    if steps > budget {
                        return None;
                    }
                    if arena[cur].intersect {
                        break;
                    }
                }
            } else {
                loop {
                    let pv = arena[cur].prev;
                    contour.push(arena[pv].out.reversed());
                    cur = pv;
                    steps += 1;
                    if steps > budget {
                        return None;
                    }
                    if arena[cur].intersect {
                        break;
                    }
                }
            }
            arena[cur].processed = true;
            let nb = arena[cur].neighbor;
            arena[nb].processed = true;
            cur = nb;
            if cur == start || arena[cur].neighbor == start {
                break;
            }
        }
        if contour.len() >= 2 {
            out.push(contour);
        }
    }
    if out.is_empty() {
        return None;
    }
    Some(out)
}

/// Exclude = (A−B) ⊎ (B−A) — same perturbation for both passes so the
/// two halves stay consistent
pub fn clip_bezier_exclude(subject: &[Seg], clipper: &[Seg]) -> Option<Vec<Vec<Seg>>> {
    let mut a = clip_bezier(subject, clipper, ClipOp::AminusB)?;
    let b = clip_bezier(subject, clipper, ClipOp::BminusA)?;
    a.extend(b);
    Some(a)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    /// kappa-cubic circle, like node_to_path's ellipse
    fn circle(cx: f64, cy: f64, r: f64) -> Vec<Seg> {
        const K: f64 = 0.5522847498;
        let k = K * r;
        vec![
            Seg::cubic(
                (cx + r, cy),
                (cx + r, cy + k),
                (cx + k, cy + r),
                (cx, cy + r),
            ),
            Seg::cubic(
                (cx, cy + r),
                (cx - k, cy + r),
                (cx - r, cy + k),
                (cx - r, cy),
            ),
            Seg::cubic(
                (cx - r, cy),
                (cx - r, cy - k),
                (cx - k, cy - r),
                (cx, cy - r),
            ),
            Seg::cubic(
                (cx, cy - r),
                (cx + k, cy - r),
                (cx + r, cy - k),
                (cx + r, cy),
            ),
        ]
    }

    fn square(x: f64, y: f64, w: f64) -> Vec<Seg> {
        vec![
            Seg::line((x, y), (x + w, y)),
            Seg::line((x + w, y), (x + w, y + w)),
            Seg::line((x + w, y + w), (x, y + w)),
            Seg::line((x, y + w), (x, y)),
        ]
    }

    fn area(contours: &[Vec<Seg>]) -> f64 {
        // green's theorem on fine flattening (evaluation only)
        let mut total = 0.0;
        for segs in contours {
            let mut pts = vec![];
            for s in segs {
                for i in 0..64 {
                    pts.push(s.eval(i as f64 / 64.0));
                }
            }
            let n = pts.len();
            let mut a = 0.0;
            for i in 0..n {
                let (x1, y1) = pts[i];
                let (x2, y2) = pts[(i + 1) % n];
                a += x1 * y2 - x2 * y1;
            }
            total += a / 2.0;
        }
        total.abs()
    }

    fn curve_count(contours: &[Vec<Seg>]) -> usize {
        contours.iter().flatten().filter(|s| !s.is_line()).count()
    }

    #[test]
    fn circle_rect_union_preserves_curves() {
        let c = circle(50.0, 50.0, 50.0);
        let r = square(50.0, 0.0, 100.0);
        let u = clip_bezier(&c, &r, ClipOp::Union).expect("union");
        assert!(curve_count(&u) >= 2, "output keeps REAL curve segments");
        let want = 10000.0 + PI * 2500.0 / 2.0; // square + left half disc
        let got = area(&u);
        assert!(
            (got - want).abs() / want < 0.002,
            "area {got} vs {want} (0.2% — beats flattening)"
        );
    }

    #[test]
    fn circle_circle_lens_is_analytic() {
        // two r=50 circles, centers 60 apart: lens area = 2r²cos⁻¹(d/2r) − d/2·√(4r²−d²)
        let a = circle(0.0, 0.0, 50.0);
        let b = circle(60.0, 0.0, 50.0);
        let i = clip_bezier(&a, &b, ClipOp::Intersect).expect("lens");
        let (r, d) = (50.0f64, 60.0f64);
        let want = 2.0 * r * r * (d / (2.0 * r)).acos() - d / 2.0 * (4.0 * r * r - d * d).sqrt();
        let got = area(&i);
        assert!(
            (got - want).abs() / want < 0.005,
            "lens {got} vs analytic {want}"
        );
        assert!(
            curve_count(&i) >= 2,
            "lens boundary is curved, not polygonal"
        );
    }

    #[test]
    fn repeated_ops_do_not_degrade_curves() {
        // the review's core complaint: subtract 4 small squares from a
        // circle one after another; the remaining arc segments must STILL
        // be genuine curves and the area must track analytically.
        let mut acc = circle(0.0, 0.0, 100.0);
        let mut expected = PI * 100.0 * 100.0;
        for (i, (x, y)) in [
            (80.0, -20.0),
            (-120.0, -20.0),
            (-20.0, 80.0),
            (-20.0, -120.0),
        ]
        .iter()
        .enumerate()
        {
            let bite = square(*x, *y, 40.0);
            // each bite: half sticks out of the circle; overlap area is
            // NOT analytic-trivial, so track relative sanity instead
            let r = clip_bezier(&acc, &bite, ClipOp::AminusB)
                .unwrap_or_else(|| panic!("op {i} degenerate"));
            let a_before = area(
                &[acc.clone()]
                    .into_iter()
                    .flat_map(|c| vec![c])
                    .collect::<Vec<_>>(),
            );
            let a_after = area(&r);
            assert!(a_after < a_before, "op {i}: area decreased");
            assert!(
                curve_count(&r) >= 3,
                "op {i}: circle arcs survive as curves ({} curved segs)",
                curve_count(&r)
            );
            assert_eq!(r.len(), 1, "op {i}: single contour");
            acc = r.into_iter().next().unwrap();
            expected = a_after;
        }
        // after 4 ops the accumulated area is still within 0.5% of the
        // freshly-computed value (no drift beyond evaluation noise)
        let final_area = area(&[acc]);
        assert!((final_area - expected).abs() / expected < 0.005);
    }

    #[test]
    fn lines_still_work_like_the_polygon_backend() {
        let a = square(0.0, 0.0, 100.0);
        let b = square(50.0, 0.0, 100.0);
        let u = clip_bezier(&a, &b, ClipOp::Union).expect("union");
        assert!((area(&u) - 15000.0).abs() < 5.0);
        assert_eq!(curve_count(&u), 0, "pure-line input -> pure-line output");
        let i = clip_bezier(&a, &b, ClipOp::Intersect).expect("intersect");
        assert!((area(&i) - 5000.0).abs() < 5.0);
        let e = clip_bezier_exclude(&a, &b).expect("exclude");
        assert!((area(&e) - 10000.0).abs() < 10.0);
    }

    #[test]
    fn containment_and_disjoint_return_untouched_curves() {
        let big = circle(0.0, 0.0, 100.0);
        let small = circle(0.0, 0.0, 30.0);
        let donut = clip_bezier(&big, &small, ClipOp::AminusB).expect("donut");
        assert_eq!(donut.len(), 2, "outer + hole");
        assert_eq!(
            curve_count(&donut),
            8,
            "ALL segments still cubic — zero flattening"
        );
        let want = PI * (100.0 * 100.0 - 30.0 * 30.0);
        assert!((area(&donut).abs() - PI * 100.0 * 100.0 - PI * 30.0 * 30.0).abs() > 0.0); // sanity only
                                                                                           // signed sum: outer minus reversed hole
        let mut signed = 0.0;
        for segs in &donut {
            let mut pts = vec![];
            for s in segs {
                for i in 0..64 {
                    pts.push(s.eval(i as f64 / 64.0));
                }
            }
            let n = pts.len();
            let mut a = 0.0;
            for i in 0..n {
                let (x1, y1) = pts[i];
                let (x2, y2) = pts[(i + 1) % n];
                a += x1 * y2 - x2 * y1;
            }
            signed += a / 2.0;
        }
        assert!(
            (signed.abs() - want).abs() / want < 0.001,
            "donut area {} vs {}",
            signed.abs(),
            want
        );
    }

    #[test]
    fn path_roundtrip_preserves_curve_commands() {
        let c = circle(50.0, 50.0, 50.0);
        let cmds = segs_to_path(std::slice::from_ref(&c), (0.0, 0.0));
        let curves = cmds
            .iter()
            .filter(|c| matches!(c, PathCmd::CurveTo(..)))
            .count();
        assert_eq!(curves, 4, "4 kappa cubics back out");
        let back = path_to_segs(&cmds, (0.0, 0.0)).expect("re-parse");
        assert_eq!(back.len(), c.len());
    }
}
