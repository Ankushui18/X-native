//! Polyline simplification (Ramer–Douglas–Peucker) shared by every
//! user-facing Simplify in the engine: the pencil's `simplify_polyline`, the
//! `Simplify` modifier and the editor's `simplify_path`.
//!
//! Two properties the old per-call-site copies did not all have:
//!
//! * **Iterative.** An explicit stack of index ranges, never recursion and
//!   never a sliced copy, so memory is O(n) and a 100,000-point input cannot
//!   overflow the call stack (the recursive TypeScript copy overflowed at
//!   8,000 points).
//! * **Segment distance.** A point is measured against the kept *segment*
//!   (the perpendicular foot is clamped to the endpoints), not the infinite
//!   line through them. That makes the tolerance a guarantee: every dropped
//!   point lies within `eps` of the output segment that replaces it. The
//!   infinite-line metric could drop a point past a segment's end that was
//!   farther than `eps` from anything in the output (measured 2.04 at eps 1.5).
//!
//! Cost is O(n log n) when splits are balanced (hand-drawn input, zig-zags —
//! exact distance ties split nearest the middle of the range) and O(n²) for
//! the adversarial case where every split peels one point off the end (a
//! tight spiral that keeps every point); that bound is inherent to RDP with
//! segment distance and is recorded, not hidden.
//!
//! The boolean raster boundary walk (`web_raster::simplify_web_ring`) is *not*
//! routed here: it is pinned to the TypeScript boolean oracle's line metric so
//! the geometry equivalence guard stays byte-comparable.

/// Squared distance from `p` to the closed segment `a`–`b` (a point when
/// `a == b`).
#[must_use]
pub fn segment_distance_sq(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let (px, py) = (p.0 - a.0, p.1 - a.1);
    let len2 = dx * dx + dy * dy;
    if len2 <= 0.0 {
        return px * px + py * py;
    }
    let t = ((px * dx + py * dy) / len2).clamp(0.0, 1.0);
    let (qx, qy) = (px - t * dx, py - t * dy);
    qx * qx + qy * qy
}

/// Which points survive simplification at tolerance `eps` (first and last are
/// always kept). `eps <= 0` or NaN keeps every point that is not exactly on
/// its replacing segment; callers that want "unchanged" check that first.
#[must_use]
pub fn simplify_keep(pts: &[(f64, f64)], eps: f64) -> Vec<bool> {
    let n = pts.len();
    let mut keep = vec![false; n];
    if n == 0 {
        return keep;
    }
    keep[0] = true;
    keep[n - 1] = true;
    let eps_sq = if eps > 0.0 { eps * eps } else { 0.0 };
    let mut stack: Vec<(usize, usize)> = vec![(0, n - 1)];
    while let Some((lo, hi)) = stack.pop() {
        if hi <= lo + 1 {
            continue;
        }
        let (a, b) = (pts[lo], pts[hi]);
        // Twice the midpoint, so the tie-break stays in integers.
        let mid2 = lo + hi;
        let mut worst = lo;
        let mut worst_d = -1.0f64;
        for (i, &p) in pts.iter().enumerate().take(hi).skip(lo + 1) {
            let d = segment_distance_sq(p, a, b);
            let closer = (2 * i).abs_diff(mid2) < (2 * worst).abs_diff(mid2);
            if d > worst_d || (d == worst_d && closer) {
                worst_d = d;
                worst = i;
            }
        }
        if worst_d > eps_sq {
            keep[worst] = true;
            stack.push((lo, worst));
            stack.push((worst, hi));
        }
    }
    keep
}

/// The surviving points themselves, in order.
#[must_use]
pub fn simplify_points(pts: &[(f64, f64)], eps: f64) -> Vec<(f64, f64)> {
    let keep = simplify_keep(pts, eps);
    pts.iter()
        .zip(keep)
        .filter_map(|(&p, k)| k.then_some(p))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Largest distance from any input point to the output polyline segment
    /// that replaced it.
    fn max_deviation(pts: &[(f64, f64)], keep: &[bool]) -> f64 {
        let kept: Vec<usize> = (0..pts.len()).filter(|&i| keep[i]).collect();
        let mut worst = 0.0f64;
        for w in kept.windows(2) {
            for p in &pts[w[0]..=w[1]] {
                worst = worst.max(segment_distance_sq(*p, pts[w[0]], pts[w[1]]).sqrt());
            }
        }
        worst
    }

    fn zigzag(n: usize) -> Vec<(f64, f64)> {
        (0..n).map(|i| (i as f64, (i % 2) as f64 * 3.0)).collect()
    }

    /// Deterministic hand-drawn stroke: a sine with seeded jitter.
    fn hand(n: usize) -> Vec<(f64, f64)> {
        let mut seed: u64 = 7;
        (0..n)
            .map(|i| {
                seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
                let jitter = ((seed >> 33) as f64 / f64::from(u32::MAX) - 0.25) * 3.0;
                let t = i as f64 / (n - 1) as f64;
                (t * 800.0, 100.0 * (t * 12.0).sin() + jitter)
            })
            .collect()
    }

    #[test]
    fn collinear_collapses_and_spikes_survive() {
        let line = [(0.0, 0.0), (1.0, 0.5), (2.0, 1.0), (4.0, 2.0)];
        assert_eq!(simplify_points(&line, 0.1), vec![(0.0, 0.0), (4.0, 2.0)]);
        let spike = vec![(0.0, 0.0), (5.0, 5.0), (10.0, 0.0)];
        assert_eq!(simplify_points(&spike, 0.1), spike);
    }

    #[test]
    fn segment_metric_keeps_points_past_the_chord_end() {
        // (14, 0.5) is 0.5 from the infinite line y=0 but 4.03 from the
        // segment (0,0)-(10,0): the line metric dropped it at eps 1.
        let pts = vec![(0.0, 0.0), (14.0, 0.5), (10.0, 0.0)];
        assert_eq!(simplify_points(&pts, 1.0), pts);
    }

    #[test]
    fn tolerance_is_a_guarantee() {
        for eps in [0.25, 1.0, 1.5, 4.0] {
            let pts = hand(5000);
            let keep = simplify_keep(&pts, eps);
            assert!(max_deviation(&pts, &keep) <= eps + 1e-9, "eps {eps}");
        }
    }

    #[test]
    fn large_inputs_do_not_overflow() {
        for n in [8_000, 20_000, 100_000] {
            let z = zigzag(n);
            assert_eq!(simplify_points(&z, 1.0).len(), n, "zigzag {n} keeps every tooth");
            let h = hand(n);
            let keep = simplify_keep(&h, 1.5);
            assert!(max_deviation(&h, &keep) <= 1.5 + 1e-9);
            assert!(keep.iter().filter(|k| **k).count() < n / 4, "hand {n} reduces");
        }
    }

    #[test]
    fn degenerate_inputs() {
        assert!(simplify_points(&[], 1.0).is_empty());
        assert_eq!(simplify_points(&[(1.0, 1.0)], 1.0), vec![(1.0, 1.0)]);
        // A closed chain whose endpoints coincide measures point distance.
        let ring = vec![(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 0.0)];
        assert_eq!(simplify_points(&ring, 1.0), ring);
        assert_eq!(simplify_points(&[(0.0, 0.0), (1.0, 0.1), (2.0, 0.0)], 0.0).len(), 3);
    }
}
