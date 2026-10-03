//! Exact polygon boolean clipper (Greiner–Hormann, 1998).
//!
//! This is the `Backend::Exact` implementation the boolean facade promised:
//! edge/edge intersections are computed analytically (exact line-line
//! solutions, no coverage grid), so results are precise to curve-flattening
//! resolution instead of the raster backend's ~8% area tolerance.
//!
//! Scope (honest): simple (non-self-intersecting) single-contour inputs.
//! Curves arrive pre-flattened from the facade. Degenerate configurations
//! (vertex exactly on an edge) are handled by retrying with a tiny
//! perturbation of the clip polygon; if tracing still fails the caller
//! falls back to the raster backend, so the app NEVER loses the operation.

pub type Pt = (f64, f64);

#[derive(Debug, Clone)]
struct V {
    p: Pt,
    next: usize,
    prev: usize,
    /// paired vertex index in the other chain (intersections only)
    neighbor: usize,
    intersect: bool,
    entry: bool,
    processed: bool,
}

pub fn area(poly: &[Pt]) -> f64 {
    let n = poly.len();
    let mut a = 0.0;
    for i in 0..n {
        let (x1, y1) = poly[i];
        let (x2, y2) = poly[(i + 1) % n];
        a += x1 * y2 - x2 * y1;
    }
    a / 2.0
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

/// exact segment intersection; returns (s, t, point) with s on a-b, t on c-d
fn seg_x(a: Pt, b: Pt, c: Pt, d: Pt) -> Option<(f64, f64, Pt)> {
    let (r1, r2) = (b.0 - a.0, b.1 - a.1);
    let (s1, s2) = (d.0 - c.0, d.1 - c.1);
    let denom = r1 * s2 - r2 * s1;
    if denom.abs() < 1e-12 {
        return None;
    } // parallel/collinear
    let (q1, q2) = (c.0 - a.0, c.1 - a.1);
    let s = (q1 * s2 - q2 * s1) / denom;
    let t = (q1 * r2 - q2 * r1) / denom;
    if !(0.0..=1.0).contains(&s) || !(0.0..=1.0).contains(&t) {
        return None;
    }
    Some((s, t, (a.0 + s * r1, a.1 + s * r2)))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipOp {
    Union,
    Intersect,
    AminusB,
    BminusA,
}

/// One Greiner–Hormann pass. Returns None on degenerate topology
/// (vertex-on-edge after retries, or tracing runaway) — caller falls back.
pub fn clip(subject: &[Pt], clipper: &[Pt], op: ClipOp) -> Option<Vec<Vec<Pt>>> {
    if subject.len() < 3 || clipper.len() < 3 {
        return None;
    }
    // dedup closing point
    let mut s: Vec<Pt> = subject.to_vec();
    if s.len() > 1
        && (s[0].0 - s[s.len() - 1].0).abs() < 1e-9
        && (s[0].1 - s[s.len() - 1].1).abs() < 1e-9
    {
        s.pop();
    }
    let mut c: Vec<Pt> = clipper.to_vec();
    if c.len() > 1
        && (c[0].0 - c[c.len() - 1].0).abs() < 1e-9
        && (c[0].1 - c[c.len() - 1].1).abs() < 1e-9
    {
        c.pop();
    }
    if s.len() < 3 || c.len() < 3 {
        return None;
    }

    // retry loop: perturb the clip polygon if a vertex lands on an edge
    for attempt in 0..4 {
        let eps = 1e-7 * (attempt as f64) * (1.0 + attempt as f64);
        let cp: Vec<Pt> = c.iter().map(|(x, y)| (x + eps, y + eps * 1.37)).collect();
        match clip_once(&s, &cp, op) {
            Ok(r) => return Some(r),
            Err(true) => continue,     // degenerate: retry perturbed
            Err(false) => return None, // structural failure: give up
        }
    }
    None
}

/// Err(true) = degenerate, retry with perturbation. Err(false) = give up.
fn clip_once(s: &[Pt], c: &[Pt], op: ClipOp) -> Result<Vec<Vec<Pt>>, bool> {
    const DEG: f64 = 1e-9;
    // intersections per edge: (edge_start_index, alpha, shared id)
    let mut on_s: Vec<Vec<(f64, usize)>> = vec![vec![]; s.len()];
    let mut on_c: Vec<Vec<(f64, usize)>> = vec![vec![]; c.len()];
    let mut xpts: Vec<Pt> = vec![];
    for i in 0..s.len() {
        let (a, b) = (s[i], s[(i + 1) % s.len()]);
        for j in 0..c.len() {
            let (d, e) = (c[j], c[(j + 1) % c.len()]);
            if let Some((si, ti, p)) = seg_x(a, b, d, e) {
                let in_range = |t: f64| (DEG..=1.0 - DEG).contains(&t);
                if !in_range(si) || !in_range(ti) {
                    return Err(true); // vertex-on-edge: perturb + retry
                }
                let id = xpts.len();
                xpts.push(p);
                on_s[i].push((si, id));
                on_c[j].push((ti, id));
            }
        }
    }

    if xpts.is_empty() {
        // containment / disjoint special cases (exact, no tracing needed)
        let s_in_c = point_in(c, s[0].0, s[0].1);
        let c_in_s = point_in(s, c[0].0, c[0].1);
        let sv = s.to_vec();
        let cv = c.to_vec();
        let rev = |mut p: Vec<Pt>| {
            p.reverse();
            p
        };
        return Ok(match op {
            ClipOp::Intersect => {
                if s_in_c {
                    vec![sv]
                } else if c_in_s {
                    vec![cv]
                } else {
                    vec![]
                }
            }
            ClipOp::Union => {
                if s_in_c {
                    vec![cv]
                } else if c_in_s {
                    vec![sv]
                } else {
                    vec![sv, cv]
                }
            }
            ClipOp::AminusB => {
                if s_in_c {
                    vec![]
                } else if c_in_s {
                    vec![sv, rev(cv)]
                } else {
                    vec![sv]
                }
            }
            ClipOp::BminusA => {
                if c_in_s {
                    vec![]
                } else if s_in_c {
                    vec![cv, rev(sv)]
                } else {
                    vec![cv]
                }
            }
        });
    }
    if !xpts.len().is_multiple_of(2) {
        return Err(true);
    } // grazing contact

    // ---- build the two doubly-linked chains with intersections inserted
    let mut arena: Vec<V> = vec![];
    let mut id2s: Vec<usize> = vec![usize::MAX; xpts.len()];
    let mut id2c: Vec<usize> = vec![usize::MAX; xpts.len()];

    let build = |pts: &[Pt],
                 on: &mut Vec<Vec<(f64, usize)>>,
                 id2: &mut Vec<usize>,
                 arena: &mut Vec<V>|
     -> usize {
        let start = arena.len();
        for (i, p) in pts.iter().enumerate() {
            arena.push(V {
                p: *p,
                next: 0,
                prev: 0,
                neighbor: usize::MAX,
                intersect: false,
                entry: false,
                processed: false,
            });
            let _ = i;
            // total_cmp: a NaN event parameter must not panic the clipper
            on[i].sort_by(|a, b| a.0.total_cmp(&b.0));
            for (_, id) in &on[i] {
                id2[*id] = arena.len();
                arena.push(V {
                    p: xpts[*id],
                    next: 0,
                    prev: 0,
                    neighbor: usize::MAX,
                    intersect: true,
                    entry: false,
                    processed: false,
                });
            }
        }
        let end = arena.len();
        for (k, v) in arena.iter_mut().enumerate().take(end).skip(start) {
            v.next = if k + 1 < end { k + 1 } else { start };
            v.prev = if k > start { k - 1 } else { end - 1 };
        }
        start
    };
    let s_head = build(s, &mut on_s, &mut id2s, &mut arena);
    let c_head = build(c, &mut on_c, &mut id2c, &mut arena);
    for id in 0..xpts.len() {
        let (a, b) = (id2s[id], id2c[id]);
        arena[a].neighbor = b;
        arena[b].neighbor = a;
    }

    // ---- mark entry/exit (alternating from the head's containment status)
    let mark = |head: usize, other: &[Pt], invert: bool, arena: &mut Vec<V>| {
        let mut status = !point_in(other, arena[head].p.0, arena[head].p.1); // next crossing enters?
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
    mark(s_head, c, inv_s, &mut arena);
    mark(c_head, s, inv_c, &mut arena);

    // ---- trace result contours
    let mut out: Vec<Vec<Pt>> = vec![];
    let budget = arena.len() * 4;
    while let Some(start) = (0..arena.len()).find(|&k| arena[k].intersect && !arena[k].processed) {
        let mut poly: Vec<Pt> = vec![arena[start].p];
        arena[start].processed = true;
        let nb = arena[start].neighbor;
        arena[nb].processed = true;
        let mut cur = start;
        let mut steps = 0usize;
        loop {
            if arena[cur].entry {
                loop {
                    cur = arena[cur].next;
                    poly.push(arena[cur].p);
                    steps += 1;
                    if steps > budget {
                        return Err(false);
                    }
                    if arena[cur].intersect {
                        break;
                    }
                }
            } else {
                loop {
                    cur = arena[cur].prev;
                    poly.push(arena[cur].p);
                    steps += 1;
                    if steps > budget {
                        return Err(false);
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
        if poly.len() >= 3 {
            out.push(poly);
        }
    }
    Ok(out)
}

/// Exclude (symmetric difference) = (A−B) ⊎ (B−A): two exact passes.
pub fn clip_exclude(subject: &[Pt], clipper: &[Pt]) -> Option<Vec<Vec<Pt>>> {
    let mut a = clip(subject, clipper, ClipOp::AminusB)?;
    let b = clip(subject, clipper, ClipOp::BminusA)?;
    a.extend(b);
    Some(a)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x: f64, y: f64, w: f64) -> Vec<Pt> {
        vec![(x, y), (x + w, y), (x + w, y + w), (x, y + w)]
    }
    fn total_area(polys: &[Vec<Pt>]) -> f64 {
        // nonzero-style: signed areas sum (holes are reversed)
        polys.iter().map(|p| area(p)).sum::<f64>().abs()
    }

    #[test]
    fn exact_squares_all_ops() {
        // two 100x100 squares offset by 50: analytically known areas
        let a = square(0.0, 0.0, 100.0);
        let b = square(50.0, 0.0, 100.0);
        let u = clip(&a, &b, ClipOp::Union).unwrap();
        assert!(
            (total_area(&u) - 15000.0).abs() < 1.0,
            "union {}",
            total_area(&u)
        );
        let i = clip(&a, &b, ClipOp::Intersect).unwrap();
        assert!(
            (total_area(&i) - 5000.0).abs() < 1.0,
            "intersect {}",
            total_area(&i)
        );
        let d = clip(&a, &b, ClipOp::AminusB).unwrap();
        assert!(
            (total_area(&d) - 5000.0).abs() < 1.0,
            "a-b {}",
            total_area(&d)
        );
        let e = clip_exclude(&a, &b).unwrap();
        assert!(
            (total_area(&e) - 10000.0).abs() < 1.0,
            "exclude {}",
            total_area(&e)
        );
    }

    #[test]
    fn exact_thin_sliver_no_tolerance_blowup() {
        // 1px-thin overlap: raster grids die here, exact must be sub-1% —
        // this is the review's "very thin shapes" precision case
        let a = square(0.0, 0.0, 100.0);
        let b = square(99.0, 0.0, 100.0);
        let i = clip(&a, &b, ClipOp::Intersect).unwrap();
        let got = total_area(&i);
        assert!(
            (got - 100.0).abs() < 0.5,
            "sliver intersect {got} (want 100)"
        );
    }

    #[test]
    fn exact_containment_and_disjoint() {
        let big = square(0.0, 0.0, 100.0);
        let small = square(25.0, 25.0, 50.0);
        let hole = clip(&big, &small, ClipOp::AminusB).unwrap();
        assert!(
            (total_area(&hole) - 7500.0).abs() < 1.0,
            "donut {}",
            total_area(&hole)
        );
        let far = square(500.0, 500.0, 10.0);
        assert!(clip(&big, &far, ClipOp::Intersect).unwrap().is_empty());
        assert_eq!(clip(&big, &far, ClipOp::Union).unwrap().len(), 2);
    }

    #[test]
    fn exact_repeated_booleans_stay_stable() {
        // the review's "repeated boolean operations" drift case: union a
        // chain of 6 overlapping squares; area must stay analytically exact
        let mut acc = square(0.0, 0.0, 100.0);
        for k in 1..6 {
            let nxt = square(k as f64 * 50.0, 0.0, 100.0);
            let r = clip(&acc, &nxt, ClipOp::Union).unwrap();
            assert_eq!(r.len(), 1, "chain union stays one contour");
            acc = r.into_iter().next().unwrap();
        }
        let want = 100.0 + 5.0 * 50.0; // width 350 x height 100
        let got = total_area(&[acc.clone()]);
        assert!(
            (got - want * 100.0).abs() < 1.0,
            "chained union {got} vs {}",
            want * 100.0
        );
    }

    #[test]
    fn exact_huge_and_tiny_coordinates() {
        // review's "huge/small coordinate ranges" case
        let a = square(1e6, 1e6, 1000.0);
        let b = square(1e6 + 500.0, 1e6, 1000.0);
        let i = clip(&a, &b, ClipOp::Intersect).unwrap();
        assert!(
            (total_area(&i) - 500_000.0).abs() < 5.0,
            "huge coords {}",
            total_area(&i)
        );
        let a = square(0.0, 0.0, 0.001);
        let b = square(0.0005, 0.0, 0.001);
        let i = clip(&a, &b, ClipOp::Intersect).unwrap();
        let want = 0.0005 * 0.001;
        assert!((total_area(&i) - want).abs() / want < 0.01, "tiny coords");
    }
}
