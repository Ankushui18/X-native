//! Exact edge-offset bands for closed convex, anchor-only strokes.
//!
//! A stroke has two boundaries, not a resized bounding box. The visible band
//! lies between `outer` and `inner` (EVENODD fill). Outward corners honor the
//! requested miter/bevel join and bounded miter limit. Inward corners use the
//! intersections of the inset edges: beveling these would incorrectly remove
//! coverage from a convex shape's inside edge. Curves, open paths, concave
//! topology and variable widths have separate operations and are declined here
//! rather than approximated or silently flattened.

use crate::{StrokeAlign, StrokeJoin};

/// One node-local contour anchor in document units.
pub type Point = (f64, f64);

#[derive(Debug, Clone, PartialEq)]
pub struct AlignedStrokeBand {
    pub outer: Vec<Point>,
    /// Empty when the inset has collapsed. Otherwise this is the hole; the
    /// outer boundary remains valid even for a very thick inside stroke.
    pub inner: Vec<Point>,
}

fn cross(a: Point, b: Point) -> f64 {
    a.0 * b.1 - a.1 * b.0
}

fn area(points: &[Point]) -> f64 {
    // Translate before summing so distant (large absolute) coordinates do not
    // destroy the orientation of a small polygon through cancellation.
    let origin = points[0];
    (1..points.len() - 1)
        .map(|i| {
            cross(
                (points[i].0 - origin.0, points[i].1 - origin.1),
                (points[i + 1].0 - origin.0, points[i + 1].1 - origin.1),
            )
        })
        .sum::<f64>()
        * 0.5
}

fn offset(
    points: &[Point],
    normals: &[Point],
    distance: f64,
    bevel: bool,
    limit: f64,
) -> Vec<Point> {
    if distance == 0.0 {
        return points.to_vec();
    }
    let count = points.len();
    let mut ring = Vec::with_capacity(count * 2);
    for i in 0..count {
        let previous = (i + count - 1) % count;
        let p = points[i];
        let n1 = normals[previous];
        let n2 = normals[i];
        let q1 = (p.0 + n1.0 * distance, p.1 + n1.1 * distance);
        let q2 = (p.0 + n2.0 * distance, p.1 + n2.1 * distance);
        let e1 = (p.0 - points[previous].0, p.1 - points[previous].1);
        let e2 = (
            points[(i + 1) % count].0 - p.0,
            points[(i + 1) % count].1 - p.1,
        );
        let denominator = cross(e1, e2);
        // Collinear consecutive edges share their normal and a single point.
        if (n1.0 - n2.0).hypot(n1.1 - n2.1) < 1e-12 {
            ring.push(q1);
            continue;
        }
        if !bevel && denominator.abs() > 1e-12 {
            let between = (q2.0 - q1.0, q2.1 - q1.1);
            let t = cross(between, e2) / denominator;
            let meet = (q1.0 + e1.0 * t, q1.1 + e1.1 * t);
            let ratio = (meet.0 - p.0).hypot(meet.1 - p.1) / distance.abs();
            if meet.0.is_finite() && meet.1.is_finite() && ratio <= limit + 1e-9 {
                ring.push(meet);
                continue;
            }
        }
        // A bevel is the segment joining the ends of the two offset edges.
        ring.push(q1);
        ring.push(q2);
    }
    ring
}

/// Return the visible stroke's outer/inner closed contours in the *same local
/// coordinate space* as `points`. Polygon must be convex and nondegenerate;
/// `width` is full stroke width, `miter_limit` is relative to the offset depth.
/// Neither shape geometry nor document history is mutated by this pure API.
pub fn aligned_stroke_band(
    points: &[Point],
    width: f64,
    align: StrokeAlign,
    join: StrokeJoin,
    miter_limit: f64,
) -> Result<AlignedStrokeBand, &'static str> {
    let points = if points.len() > 3 && points.first() == points.last() {
        &points[..points.len() - 1]
    } else {
        points
    };
    if !(3..=512).contains(&points.len())
        || !width.is_finite()
        || !(0.0 < width && width <= 1e6)
        || !miter_limit.is_finite()
        || !(1.0..=16.0).contains(&miter_limit)
        || points
            .iter()
            .any(|&(x, y)| !x.is_finite() || !y.is_finite() || x.abs() > 1e9 || y.abs() > 1e9)
    {
        return Err("invalid or excessive stroke geometry");
    }
    if join == StrokeJoin::Round {
        return Err("round stroke join has not passed this geometry gate");
    }
    let signed = area(points);
    if signed.abs() < 1e-9 {
        return Err("degenerate stroke polygon");
    }
    let sign: f64 = signed.signum();
    let n = points.len();
    let mut normals = Vec::with_capacity(n);
    for i in 0..n {
        let p = points[i];
        let q = points[(i + 1) % n];
        let dx = q.0 - p.0;
        let dy = q.1 - p.1;
        let length = dx.hypot(dy);
        if length < 1e-9 {
            return Err("zero-length stroke edge");
        }
        normals.push((sign * dy / length, -sign * dx / length));
    }
    for i in 0..n {
        let p = points[i];
        let q = points[(i + 1) % n];
        let r = points[(i + 2) % n];
        let e1 = (q.0 - p.0, q.1 - p.1);
        let e2 = (r.0 - q.0, r.1 - q.1);
        if sign * cross(e1, e2) < -1e-9 * e1.0.hypot(e1.1) * e2.0.hypot(e2.1) {
            return Err("concave stroke topology requires a clipping proof");
        }
    }
    let (outside, inside) = match align {
        StrokeAlign::Inside => (0.0, width),
        StrokeAlign::Center => (width / 2.0, width / 2.0),
        StrokeAlign::Outside => (width, 0.0),
    };
    let outer = offset(
        points,
        &normals,
        outside,
        join == StrokeJoin::Bevel,
        miter_limit,
    );
    // Inward joins are intersections. A miter limit applies to the OUTWARD
    // silhouette only; an inset edge does not grow an external spike.
    let candidate = offset(points, &normals, -inside, false, f64::MAX);
    let valid_hole = sign * area(&candidate) > 1e-9
        && candidate.iter().all(|&(x, y)| {
            points.iter().enumerate().all(|(i, &p)| {
                let q = points[(i + 1) % n];
                sign * cross((q.0 - p.0, q.1 - p.1), (x - p.0, y - p.1)) >= -1e-8
            })
        });
    let inner = if valid_hole { candidate } else { Vec::new() };
    if outer
        .iter()
        .chain(inner.iter())
        .any(|&(x, y)| !x.is_finite() || !y.is_finite())
    {
        return Err("stroke offset overflow");
    }
    Ok(AlignedStrokeBand { outer, inner })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(w: f64, h: f64) -> [Point; 4] {
        [(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)]
    }

    #[test]
    fn alignment_measures_from_the_original_rectangle_edges() {
        let r = rect(100.0, 80.0);
        let band = |align| aligned_stroke_band(&r, 10.0, align, StrokeJoin::Miter, 4.0).unwrap();
        assert_eq!(band(StrokeAlign::Inside).outer, r);
        assert_eq!(
            band(StrokeAlign::Inside).inner,
            rect(80.0, 60.0).map(|(x, y)| (x + 10.0, y + 10.0))
        );
        assert_eq!(
            band(StrokeAlign::Center).outer,
            rect(110.0, 90.0).map(|(x, y)| (x - 5.0, y - 5.0))
        );
        assert_eq!(
            band(StrokeAlign::Center).inner,
            rect(90.0, 70.0).map(|(x, y)| (x + 5.0, y + 5.0))
        );
        assert_eq!(
            band(StrokeAlign::Outside).outer,
            rect(120.0, 100.0).map(|(x, y)| (x - 10.0, y - 10.0))
        );
        assert_eq!(band(StrokeAlign::Outside).inner, r);
    }

    #[test]
    fn outward_bevels_chamfer_corners_but_inner_edges_still_intersect() {
        let r = rect(100.0, 80.0);
        let bevel =
            aligned_stroke_band(&r, 10.0, StrokeAlign::Center, StrokeJoin::Bevel, 4.0).unwrap();
        assert_eq!(
            bevel.outer,
            [
                (-5.0, 0.0),
                (0.0, -5.0),
                (100.0, -5.0),
                (105.0, 0.0),
                (105.0, 80.0),
                (100.0, 85.0),
                (0.0, 85.0),
                (-5.0, 80.0)
            ]
        );
        assert_eq!(
            bevel.inner,
            rect(90.0, 70.0).map(|(x, y)| (x + 5.0, y + 5.0))
        );
        let limit =
            aligned_stroke_band(&r, 10.0, StrokeAlign::Outside, StrokeJoin::Miter, 1.0).unwrap();
        assert_eq!(limit.outer.len(), 8, "miter limit must fall back to bevel");
    }

    #[test]
    fn acute_convex_corner_bevels_when_the_miter_exceeds_its_limit() {
        let triangle = [(0.0, 0.0), (100.0, 0.0), (50.0, 500.0)];
        let normal =
            aligned_stroke_band(&triangle, 4.0, StrokeAlign::Outside, StrokeJoin::Miter, 4.0)
                .unwrap();
        assert_eq!(
            normal.outer.len(),
            4,
            "one acute corner exceeds the four-times miter limit"
        );
        assert_eq!(
            normal.inner, triangle,
            "outside stroke leaves the original polygon as its inner boundary"
        );
        let extended = aligned_stroke_band(
            &triangle,
            4.0,
            StrokeAlign::Outside,
            StrokeJoin::Miter,
            16.0,
        )
        .unwrap();
        assert_eq!(
            extended.outer.len(),
            3,
            "a deliberately raised limit permits the long miter"
        );
    }

    #[test]
    fn narrow_holes_collapse_without_flipping_or_painting_outside() {
        let band = aligned_stroke_band(
            &rect(10.0, 8.0),
            5.0,
            StrokeAlign::Inside,
            StrokeJoin::Miter,
            4.0,
        )
        .unwrap();
        assert!(band.inner.is_empty());
        assert_eq!(band.outer, rect(10.0, 8.0));
    }

    #[test]
    fn orientation_is_measured_and_invalid_topology_is_declined() {
        let square = rect(40.0, 40.0);
        let reversed = square.into_iter().rev().collect::<Vec<_>>();
        let band =
            aligned_stroke_band(&reversed, 6.0, StrokeAlign::Outside, StrokeJoin::Miter, 4.0)
                .unwrap();
        assert!(band.outer.iter().any(|&(x, y)| x == -6.0 && y == -6.0));
        assert!(aligned_stroke_band(
            &[
                (0.0, 0.0),
                (10.0, 0.0),
                (3.0, 3.0),
                (10.0, 10.0),
                (0.0, 10.0)
            ],
            2.0,
            StrokeAlign::Center,
            StrokeJoin::Miter,
            4.0
        )
        .is_err());
        assert!(aligned_stroke_band(
            &square,
            f64::NAN,
            StrokeAlign::Outside,
            StrokeJoin::Miter,
            4.0
        )
        .is_err());
        assert!(
            aligned_stroke_band(&square, 2.0, StrokeAlign::Outside, StrokeJoin::Round, 4.0)
                .is_err()
        );
    }
}
