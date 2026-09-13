//! Shape Builder: overlap validation for boolean shape operations.
//!
//! The engine could already boolean two shapes (`Editor::boolean_selected`),
//! but it did so silently: pick two rectangles on opposite sides of the
//! canvas, hit Union, and you get a compound path of two unrelated islands
//! with no hint that nothing was actually combined. Subtract was worse —
//! subtracting a shape that fully covers the other yields an empty result,
//! and the selection just loses a layer.
//!
//! A Shape Builder refuses those cases and says why. The measure is the same
//! one the design-audit toolkit already reports (`--min-overlap`: "fraction
//! of the smaller box"), so the canvas and the CLI agree on what "overlapping"
//! means:
//!
//! ```text
//! ratio = |A ∩ B| / min(|A|, |B|)
//! ```
//!
//! Areas come from the real boolean geometry (`x_core::booleans`), not from
//! bounding boxes — two boxes can overlap in bbox while the shapes themselves
//! never touch (a ring around a dot, say), and that must not pass validation.

#[allow(unused_imports)]
use crate::*;
use crate::{find, Editor};
use x_core::booleans::{boolean, node_to_path, path_to_polylines, BoolOp, PositionedPath};
use x_core::clip::area as poly_area;
use x_core::{Node, PathCmd};

/// Curve flattening resolution used when measuring areas. Matches the
/// resolution the boolean backends themselves work at, so the numbers the
/// validation quotes are the numbers the operation is computed from.
pub const AREA_STEPS: usize = 32;

/// Fraction-of-smaller-shape threshold a drag must clear to count as an
/// overlap. Same default as the audit toolkit's `--min-overlap`.
pub const DEFAULT_MIN_OVERLAP: f64 = 0.01;

/// What the Shape Builder was asked to do with the two selected shapes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShapeBuilderOp {
    /// Combine the overlapping regions into one shape (boolean union).
    Merge,
    /// Cut the second shape out of the first (boolean subtract).
    Subtract,
}

/// Why a Shape Builder operation was refused.
#[derive(Debug, Clone, PartialEq)]
pub enum ShapeBuilderIssue {
    /// The tool needs exactly two shapes.
    NotEnoughSelection { have: usize, need: usize },
    /// The node has no outline to boolean (text, frame, image, group, ...).
    UnsupportedNode { id: String },
    /// The node has an outline but no enclosed area (an open line, an empty
    /// path) — nothing to merge or cut.
    DegenerateGeometry { id: String },
    /// The shapes do not overlap enough to combine.
    Disjoint { ratio: f64 },
    /// For Subtract: the cutting shape covers the target completely, so the
    /// result would be empty.
    FullyNested { id: String, ratio: f64 },
}

impl ShapeBuilderIssue {
    /// A status-bar-ready explanation.
    pub fn message(&self) -> String {
        match self {
            Self::NotEnoughSelection { have, need } => format!(
                "Shape Builder needs {need} shapes selected (got {have})"
            ),
            Self::UnsupportedNode { id } => {
                format!("Shape Builder can't use \"{id}\": no vector outline")
            }
            Self::DegenerateGeometry { id } => {
                format!("Shape Builder can't use \"{id}\": the shape encloses no area")
            }
            Self::Disjoint { ratio } => format!(
                "Shape Builder: the shapes barely overlap ({}% of the smaller one) — nothing to combine",
                (ratio * 100.0).round() as i64
            ),
            Self::FullyNested { id, ratio } => format!(
                "Shape Builder: \"{id}\" covers the other shape completely ({}%) — the result would be empty",
                (ratio * 100.0).round() as i64
            ),
        }
    }
}

/// Enclosed area of a path in its own local coordinates, summed over its
/// subpaths. Curves are flattened at [`AREA_STEPS`].
pub fn path_area(cmds: &[PathCmd]) -> f64 {
    path_to_polylines(cmds, AREA_STEPS)
        .iter()
        .map(|p| poly_area(p).abs())
        .sum()
}

/// Overlap measurement between two nodes, in world placement.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OverlapReport {
    pub area_a: f64,
    pub area_b: f64,
    /// |A ∩ B|
    pub intersection: f64,
    /// |A ∪ B|
    pub union: f64,
    /// intersection / min(area_a, area_b); 0 when either shape has no area.
    pub ratio: f64,
}

fn positioned(n: &Node, cmds: Vec<PathCmd>) -> PositionedPath {
    PositionedPath {
        cmds,
        offset: (n.transform.x, n.transform.y),
    }
}

fn measure(pa: &PositionedPath, pb: &PositionedPath, op: BoolOp) -> f64 {
    path_area(&boolean(op, pa, pb).cmds)
}

fn measure_pair(a: &Node, pa: &[PathCmd], b: &Node, pb: &[PathCmd]) -> OverlapReport {
    let area_a = path_area(pa);
    let area_b = path_area(pb);
    let pa = positioned(a, pa.to_vec());
    let pb = positioned(b, pb.to_vec());
    let intersection = measure(&pa, &pb, BoolOp::Intersect);
    let union = measure(&pa, &pb, BoolOp::Union);
    let smaller = area_a.min(area_b);
    let ratio = if smaller > 0.0 {
        (intersection / smaller).clamp(0.0, 1.0)
    } else {
        0.0
    };
    OverlapReport {
        area_a,
        area_b,
        intersection,
        union,
        ratio,
    }
}

/// Measure how much two nodes overlap. `None` when either has no outline.
pub fn overlap(a: &Node, b: &Node) -> Option<OverlapReport> {
    let pa = node_to_path(a)?;
    let pb = node_to_path(b)?;
    Some(measure_pair(a, &pa, b, &pb))
}

/// [`overlap`], but naming the node that has no outline instead of collapsing
/// both cases into one — the refusal is only actionable if it says WHICH
/// layer the Shape Builder could not use.
fn overlap_named(a: &Node, b: &Node) -> Result<OverlapReport, ShapeBuilderIssue> {
    let pa = node_to_path(a).ok_or(ShapeBuilderIssue::UnsupportedNode { id: a.id.clone() })?;
    let pb = node_to_path(b).ok_or(ShapeBuilderIssue::UnsupportedNode { id: b.id.clone() })?;
    Ok(measure_pair(a, &pa, b, &pb))
}

/// `a > b` for floats, NaN counting as "not greater".
///
/// The degenerate-geometry checks below used to read `!(area > 0.0)`, which is
/// the correct NaN-rejecting test but is rejected by
/// `clippy::neg_cmp_op_on_partial_ord`; `area <= 0.0` would silently accept NaN
/// and let a NaN-sized shape through the boolean backends.
fn gt(a: f64, b: f64) -> bool {
    matches!(a.partial_cmp(&b), Some(std::cmp::Ordering::Greater))
}

/// Validate a Shape Builder operation before performing it.
///
/// * `Merge` needs a real overlap — otherwise the "combined" shape is just
///   two islands wearing one node.
/// * `Subtract` needs an overlap too, and additionally refuses the case where
///   the cutter swallows the target (empty result).
pub fn validate(
    op: ShapeBuilderOp,
    a: &Node,
    b: &Node,
    min_ratio: f64,
) -> Result<OverlapReport, ShapeBuilderIssue> {
    let report = overlap_named(a, b)?;
    if !gt(report.area_a, 0.0) {
        return Err(ShapeBuilderIssue::DegenerateGeometry { id: a.id.clone() });
    }
    if !gt(report.area_b, 0.0) {
        return Err(ShapeBuilderIssue::DegenerateGeometry { id: b.id.clone() });
    }
    if report.ratio < min_ratio {
        return Err(ShapeBuilderIssue::Disjoint {
            ratio: report.ratio,
        });
    }
    if op == ShapeBuilderOp::Subtract {
        // the cutter (b) covers (essentially) all of the target (a)
        let covered = if report.area_a > 0.0 {
            report.intersection / report.area_a
        } else {
            0.0
        };
        // the boolean backends are approximate near coincident edges, so
        // "fully covered" gets a small tolerance instead of == 1.0
        if covered > 0.995 {
            return Err(ShapeBuilderIssue::FullyNested {
                id: a.id.clone(),
                ratio: covered,
            });
        }
    }
    Ok(report)
}

impl Editor {
    /// Shape Builder on the current two-shape selection: validate, then run
    /// the boolean. Returns the new node id, or a [`ShapeBuilderIssue`]
    /// explaining exactly why the operation was refused. Nothing is mutated
    /// when an issue is returned.
    pub fn shape_builder_selected(
        &mut self,
        op: ShapeBuilderOp,
        min_ratio: f64,
    ) -> Result<String, ShapeBuilderIssue> {
        if self.selection.len() != 2 {
            return Err(ShapeBuilderIssue::NotEnoughSelection {
                have: self.selection.len(),
                need: 2,
            });
        }
        let ida = self.selection[0].clone();
        let idb = self.selection[1].clone();
        let na = find(&self.root, &ida)
            .ok_or(ShapeBuilderIssue::UnsupportedNode { id: ida.clone() })?
            .clone();
        let nb = find(&self.root, &idb)
            .ok_or(ShapeBuilderIssue::UnsupportedNode { id: idb.clone() })?
            .clone();
        validate(op, &na, &nb, min_ratio)?;
        let bool_op = match op {
            ShapeBuilderOp::Merge => BoolOp::Union,
            ShapeBuilderOp::Subtract => BoolOp::Subtract,
        };
        // validation passed, so a refusal here means the geometry itself
        // degenerated under the clipper
        self.boolean_selected(bool_op)
            .ok_or(ShapeBuilderIssue::DegenerateGeometry { id: ida })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::{Color, Node};

    fn page(children: Vec<Node>) -> Editor {
        let mut p = Node::frame("page", 800.0, 600.0);
        p.children = children;
        Editor::new(p)
    }

    fn rect(id: &str, x: f64, y: f64, w: f64, h: f64) -> Node {
        Node::rect(id, x, y, w, h, Color::from_rgb8(200, 30, 30))
    }

    #[test]
    fn overlapping_boxes_report_the_fraction_of_the_smaller_one() {
        // 100x100 and 50x100 overlapping in a 25x100 strip
        let a = rect("a", 0.0, 0.0, 100.0, 100.0);
        let b = rect("b", 75.0, 0.0, 50.0, 100.0);
        let r = overlap(&a, &b).expect("both are rects");
        assert!((r.area_a - 10_000.0).abs() < 1.0, "area_a {}", r.area_a);
        assert!((r.area_b - 5_000.0).abs() < 1.0, "area_b {}", r.area_b);
        assert!(
            (r.intersection - 2_500.0).abs() < 100.0,
            "intersection {}",
            r.intersection
        );
        // 2500 / 5000 = 0.5 of the smaller shape
        assert!((r.ratio - 0.5).abs() < 0.02, "ratio {}", r.ratio);
        assert!((r.union - 12_500.0).abs() < 200.0, "union {}", r.union);
    }

    #[test]
    fn disjoint_boxes_are_refused_with_the_ratio_in_the_message() {
        let a = rect("a", 0.0, 0.0, 40.0, 40.0);
        let b = rect("b", 300.0, 300.0, 40.0, 40.0);
        let err = validate(ShapeBuilderOp::Merge, &a, &b, DEFAULT_MIN_OVERLAP).unwrap_err();
        assert!(matches!(err, ShapeBuilderIssue::Disjoint { .. }), "{err:?}");
        let msg = err.message();
        assert!(msg.contains("nothing to combine"), "{msg}");
    }

    #[test]
    fn merge_of_overlapping_shapes_succeeds_and_selects_the_result() {
        let mut ed = page(vec![
            rect("a", 0.0, 0.0, 100.0, 100.0),
            rect("b", 60.0, 0.0, 100.0, 100.0),
        ]);
        ed.selection = vec!["a".into(), "b".into()];
        let id = ed
            .shape_builder_selected(ShapeBuilderOp::Merge, DEFAULT_MIN_OVERLAP)
            .expect("overlapping merge");
        assert_eq!(ed.selection, vec![id.clone()]);
        assert!(find(&ed.root, &id).is_some());
        // inputs are gone, result is one node
        assert!(find(&ed.root, "a").is_none());
        assert!(find(&ed.root, "b").is_none());
        // and the whole thing is one undo step
        ed.undo();
        assert!(find(&ed.root, "a").is_some());
        assert!(find(&ed.root, "b").is_some());
    }

    #[test]
    fn disjoint_selection_mutates_nothing() {
        let mut ed = page(vec![
            rect("a", 0.0, 0.0, 50.0, 50.0),
            rect("b", 400.0, 400.0, 50.0, 50.0),
        ]);
        ed.selection = vec!["a".into(), "b".into()];
        let depth = ed.undo_depth();
        let err = ed
            .shape_builder_selected(ShapeBuilderOp::Merge, DEFAULT_MIN_OVERLAP)
            .unwrap_err();
        assert!(matches!(err, ShapeBuilderIssue::Disjoint { .. }));
        assert_eq!(ed.undo_depth(), depth, "a refusal must not push a command");
        assert!(find(&ed.root, "a").is_some() && find(&ed.root, "b").is_some());
    }

    #[test]
    fn subtract_that_would_leave_nothing_is_refused() {
        let small = rect("small", 40.0, 40.0, 20.0, 20.0);
        let big = rect("big", 0.0, 0.0, 200.0, 200.0);
        let err =
            validate(ShapeBuilderOp::Subtract, &small, &big, DEFAULT_MIN_OVERLAP).unwrap_err();
        match err {
            ShapeBuilderIssue::FullyNested { id, ratio } => {
                assert_eq!(id, "small");
                assert!(ratio > 0.99, "ratio {ratio}");
            }
            other => panic!("expected FullyNested, got {other:?}"),
        }
        // the same pair merges fine — the refusal is specific to Subtract
        assert!(validate(ShapeBuilderOp::Merge, &small, &big, DEFAULT_MIN_OVERLAP).is_ok());
    }

    #[test]
    fn partial_subtract_is_allowed() {
        let a = rect("a", 0.0, 0.0, 100.0, 100.0);
        let b = rect("b", 50.0, 0.0, 100.0, 100.0);
        let r = validate(ShapeBuilderOp::Subtract, &a, &b, DEFAULT_MIN_OVERLAP).expect("partial");
        assert!(r.ratio > 0.4 && r.ratio < 0.6, "ratio {}", r.ratio);
    }

    #[test]
    fn nodes_without_an_outline_are_named_in_the_refusal() {
        let a = rect("a", 0.0, 0.0, 50.0, 50.0);
        let t = Node::text("label", 0.0, 0.0, 50.0, 20.0, "hello");
        let err = validate(ShapeBuilderOp::Merge, &a, &t, DEFAULT_MIN_OVERLAP).unwrap_err();
        // the refusal must name the TEXT node, not the perfectly good rect
        assert_eq!(
            err,
            ShapeBuilderIssue::UnsupportedNode {
                id: "label".to_string()
            }
        );
        assert!(err.message().contains("no vector outline"));
    }

    #[test]
    fn zero_area_geometry_is_degenerate_not_disjoint() {
        // an open line encloses nothing: the honest complaint is "no area",
        // not "doesn't overlap"
        let a = rect("a", 0.0, 0.0, 50.0, 50.0);
        let l = Node::line("l", 0.0, 0.0, 50.0, 0.0, Color::BLACK);
        let err = validate(ShapeBuilderOp::Merge, &a, &l, DEFAULT_MIN_OVERLAP).unwrap_err();
        assert!(
            matches!(err, ShapeBuilderIssue::DegenerateGeometry { .. }),
            "{err:?}"
        );
    }

    #[test]
    fn selection_size_is_checked_before_any_geometry() {
        let mut ed = page(vec![rect("a", 0.0, 0.0, 50.0, 50.0)]);
        ed.selection = vec!["a".into()];
        let err = ed
            .shape_builder_selected(ShapeBuilderOp::Merge, DEFAULT_MIN_OVERLAP)
            .unwrap_err();
        assert_eq!(
            err,
            ShapeBuilderIssue::NotEnoughSelection { have: 1, need: 2 }
        );
        ed.selection.clear();
        assert!(matches!(
            ed.shape_builder_selected(ShapeBuilderOp::Subtract, DEFAULT_MIN_OVERLAP)
                .unwrap_err(),
            ShapeBuilderIssue::NotEnoughSelection { have: 0, need: 2 }
        ));
    }

    #[test]
    fn touching_edges_do_not_pass_a_meaningful_threshold() {
        // sharing an edge only: intersection area is ~0, ratio ~0
        let a = rect("a", 0.0, 0.0, 60.0, 60.0);
        let b = rect("b", 60.0, 0.0, 60.0, 60.0);
        let r = overlap(&a, &b).unwrap();
        assert!(r.ratio < 0.01, "ratio {} should be ~0", r.ratio);
        assert!(validate(ShapeBuilderOp::Merge, &a, &b, 0.1).is_err());
    }
}
