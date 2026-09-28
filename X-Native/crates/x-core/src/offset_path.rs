//! Topology-safe offsets of *filled, closed* paths. The source path, not a
//! resized bounding box, determines the new outline. Cubics are flattened at
//! the existing editor resolution; self-crossings and holes are normalized
//! under NONZERO winding before offsetting. The overlay solver then clips
//! crossing offset edges and removes vanished insets instead of returning
//! inverted/self-intersecting rings.
//!
//! This module is pure geometry. `x-editor` owns the single undo history and
//! `x-wasm` exposes only a bounded affected-layer projection. Open polylines
//! retain the separate native vector-edit operation (no filled winding).

use crate::booleans::path_to_polylines;
use crate::{PathCmd, StrokeJoin};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::float::simplify::SimplifyShape;
use i_overlay::mesh::outline::offset::OutlineOffset;
use i_overlay::mesh::style::{LineJoin, OutlineStyle};

/// The largest input or output contour set that can cross a command boundary.
/// Actual editor commands may impose narrower bounds for web admission.
pub const MAX_OFFSET_ANCHORS: usize = 4096;

/// Each ring is closed implicitly. Shape contours have NONZERO winding:
/// positive/outer contours and negative/hole contours must not be flattened
/// into a single path, especially after a self-intersection splits a region.
pub type OffsetRings = Vec<Vec<(f64, f64)>>;

/// Offset closed PathCmd contours in the same local coordinate space as the
/// source. `distance > 0` expands, `distance < 0` contracts. An inward offset
/// that consumes the shape is a *valid empty result*, not an inverted polygon.
/// `distance == 0`, invalid/open/nonfinite inputs and unbounded output are
/// rejected without modifying any document or history.
pub fn offset_filled_path(
    cmds: &[PathCmd],
    distance: f64,
    join: StrokeJoin,
) -> Result<OffsetRings, &'static str> {
    if !distance.is_finite() || distance == 0.0 || distance.abs() > 2048.0 {
        return Err("offset distance must be finite, nonzero and at most 2048");
    }
    if cmds.len() < 4 || cmds.len() > MAX_OFFSET_ANCHORS {
        return Err("offset source must contain bounded closed contours");
    }
    // Requiring every subpath to Close matters: `path_to_polylines` also accepts
    // open paths for stroke outlining, but an open chain cannot carry a fill
    // winding rule and must never be silently closed here.
    let (mut open, mut contours) = (false, 0usize);
    for cmd in cmds {
        let finite = |v: f64| v.is_finite() && v.abs() <= 1e6;
        let valid = match *cmd {
            PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => finite(x) && finite(y),
            PathCmd::CurveTo(a, b, c, d, x, y) =>
                [a, b, c, d, x, y].into_iter().all(finite),
            PathCmd::Close => true,
        };
        if !valid {
            return Err("offset path coordinate must be finite and bounded");
        }
        match cmd {
            PathCmd::MoveTo(..) if !open => {
                open = true;
                contours += 1;
            }
            PathCmd::LineTo(..) | PathCmd::CurveTo(..) if open => {}
            PathCmd::Close if open => open = false,
            _ => return Err("offset source contains an open or malformed contour"),
        }
    }
    if open || contours == 0 || contours > 128 {
        return Err("offset source contains an open or excessive contour set");
    }
    let paths = path_to_polylines(cmds, 12);
    if paths.len() != contours || paths.iter().map(Vec::len).sum::<usize>() > MAX_OFFSET_ANCHORS {
        return Err("offset source exceeds the flattening budget");
    }
    let mut source: Vec<Vec<[f64; 2]>> = Vec::with_capacity(paths.len());
    for mut path in paths {
        // Explicit repeated endpoints are common in imported vectors; they
        // are not a second edge and must not create a zero-length join.
        if path.len() > 3 && path.first() == path.last() {
            path.pop();
        }
        if path.len() < 3 {
            return Err("offset source contains a degenerate contour");
        }
        source.push(path.into_iter().map(|(x, y)| [x, y]).collect());
    }
    // i_overlay's offset builder requires simple, correctly oriented shapes.
    // Simplifying FIRST is essential for bowties, crossing stars and compound
    // paths: it uses the same NONZERO fill as native vector painting, and
    // yields oriented outer/hole contours. Its output is a set of shapes, not
    // a guessed vertex-normal shift of the author's possibly crossing walk.
    let valid = source.simplify_shape_as::<i64>(FillRule::NonZero);
    if valid.is_empty() {
        return Ok(vec![]);
    }
    let join = match join {
        // A 4x miter limit corresponds to a minimum included angle of
        // 2*asin(1/4); the library bevels sharper external corners.
        StrokeJoin::Miter => LineJoin::Miter(2.0 * (0.25_f64).asin()),
        StrokeJoin::Bevel => LineJoin::Bevel,
        StrokeJoin::Round => LineJoin::Round(std::f64::consts::PI / 12.0),
    };
    let style = OutlineStyle::new(distance).line_join(join);
    let shapes = valid.outline_as::<i64>(&style);
    if shapes.len() > 128 {
        return Err("offset result contains too many shapes");
    }
    let mut rings = Vec::new();
    let mut total = 0usize;
    for shape in shapes {
        if shape.len() > 128 {
            return Err("offset result contains too many holes");
        }
        for contour in shape {
            if contour.len() < 3 || (total += contour.len()) > MAX_OFFSET_ANCHORS {
                return Err("offset result exceeds the bounded contour budget");
            }
            let ring: Vec<_> = contour.into_iter().map(|[x, y]| (x, y)).collect();
            if ring.iter().any(|&(x, y)| !x.is_finite() || !y.is_finite() || x.abs() > 1e7 || y.abs() > 1e7) {
                return Err("offset result exceeds the coordinate budget");
            }
            rings.push(ring);
        }
    }
    Ok(rings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{booleans::node_to_path, Color, Node};

    fn path(points: &[(f64, f64)]) -> Vec<PathCmd> {
        let mut cmds = vec![PathCmd::MoveTo(points[0].0, points[0].1)];
        cmds.extend(points.iter().skip(1).map(|&(x, y)| PathCmd::LineTo(x, y)));
        cmds.push(PathCmd::Close);
        cmds
    }
    fn bounds(rings: &OffsetRings) -> (f64, f64, f64, f64) {
        let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for &(x, y) in rings.iter().flatten() {
            x0 = x0.min(x); y0 = y0.min(y); x1 = x1.max(x); y1 = y1.max(y);
        }
        (x0, y0, x1, y1)
    }
    fn near(actual: f64, expected: f64) {
        assert!((actual - expected).abs() < 0.02, "{actual} != {expected}");
    }
    fn area(ring: &[(f64, f64)]) -> f64 {
        (0..ring.len()).map(|i| {
            let (x, y) = ring[i]; let (u, v) = ring[(i + 1) % ring.len()];
            x * v - u * y
        }).sum::<f64>() / 2.0
    }

    #[test]
    fn positive_negative_joins_and_collapsed_inset() {
        let square = path(&[(0.0, 0.0), (80.0, 0.0), (80.0, 60.0), (0.0, 60.0)]);
        for reversed in [false, true] {
            let input = if reversed { path(&[(0.0, 60.0), (80.0, 60.0), (80.0, 0.0), (0.0, 0.0)]) } else { square.clone() };
            let miter = offset_filled_path(&input, 8.0, StrokeJoin::Miter).unwrap();
            assert_eq!(miter.len(), 1);
            assert_eq!(miter[0].len(), 4);
            let (x0,y0,x1,y1) = bounds(&miter);
            near(x0,-8.0); near(y0,-8.0); near(x1,88.0); near(y1,68.0);
            let bevel = offset_filled_path(&input, 8.0, StrokeJoin::Bevel).unwrap();
            assert_eq!(bevel.len(), 1);
            assert_eq!(bevel[0].len(), 8);
            let round = offset_filled_path(&input, 8.0, StrokeJoin::Round).unwrap();
            assert!(round[0].len() > 8);
            let inset = offset_filled_path(&input, -8.0, StrokeJoin::Miter).unwrap();
            let (x0,y0,x1,y1) = bounds(&inset);
            near(x0,8.0); near(y0,8.0); near(x1,72.0); near(y1,52.0);
            assert!(offset_filled_path(&input, -40.0, StrokeJoin::Round).unwrap().is_empty());
        }
    }

    #[test]
    fn ellipses_polygon_stars_and_crossings_have_bounded_nonzero_contours() {
        let shapes = [
            Node::ellipse("e", 0.0, 0.0, 100.0, 80.0, Color::BLACK),
            Node::poly("p", 0.0, 0.0, 100.0, 80.0, 5, Color::BLACK),
            Node::star("s", 0.0, 0.0, 100.0, 80.0, 5, 0.4, Color::BLACK),
        ];
        for shape in &shapes {
            let source = node_to_path(shape).unwrap();
            let grown = offset_filled_path(&source, 4.0, StrokeJoin::Round).unwrap();
            let shrunk = offset_filled_path(&source, -2.0, StrokeJoin::Miter).unwrap();
            assert!(!grown.is_empty() && !shrunk.is_empty());
            assert!(grown.iter().flatten().all(|&(x,y)| x.is_finite() && y.is_finite()));
        }
        // The original author walk crosses itself; the simplifying overlay
        // must resolve its filled lobes before either sign of offset.
        let bowtie = path(&[(0.0,0.0), (60.0,60.0), (0.0,60.0), (60.0,0.0)]);
        for sign in [-1.0, 1.0] {
            let result = offset_filled_path(&bowtie, sign * 3.0, StrokeJoin::Round).unwrap();
            assert!(!result.is_empty());
            assert!(result.iter().all(|r| r.len() >= 3));
        }
    }

    #[test]
    fn holes_keep_opposite_winding_and_close_when_the_shape_expands() {
        let mut source = path(&[(0.0,0.0), (100.0,0.0), (100.0,100.0), (0.0,100.0)]);
        source.extend(path(&[(35.0,35.0), (35.0,65.0), (65.0,65.0), (65.0,35.0)]));
        let grown = offset_filled_path(&source, 5.0, StrokeJoin::Miter).unwrap();
        assert_eq!(grown.len(), 2);
        assert!(area(&grown[0]) * area(&grown[1]) < 0.0);
        let shrunk = offset_filled_path(&source, -5.0, StrokeJoin::Bevel).unwrap();
        assert_eq!(shrunk.len(), 2);
        assert!(area(&shrunk[0]) * area(&shrunk[1]) < 0.0);
        assert!(offset_filled_path(&source, 18.0, StrokeJoin::Round).unwrap().len() <= 2);
    }

    #[test]
    fn bad_requests_do_not_produce_geometry() {
        let sq = path(&[(0.0,0.0), (10.0,0.0), (10.0,10.0), (0.0,10.0)]);
        for distance in [0.0, f64::NAN, f64::INFINITY, 2049.0] {
            assert!(offset_filled_path(&sq, distance, StrokeJoin::Miter).is_err());
        }
        assert!(offset_filled_path(&[PathCmd::MoveTo(0.0,0.0), PathCmd::LineTo(1.0,0.0)], 3.0, StrokeJoin::Round).is_err());
        assert!(offset_filled_path(&[PathCmd::MoveTo(f64::NAN,0.0), PathCmd::LineTo(1.0,0.0), PathCmd::LineTo(1.0,1.0), PathCmd::Close], 3.0, StrokeJoin::Round).is_err());
    }
}
