//! The web Boolean raster contract. This is deliberately distinct from the
//! general-purpose `booleans::Backend::RasterGuided`: the existing TS document
//! geometry uses a fixed-width, cell-centre boundary walk rather than chained
//! cell edges. x-geo uses this backend until Rust becomes the sole authority.
//!
//! Return unsimplified world-space rings. The web bridge applies the *same*
//! output shaper to these rings and the TS oracle; simplifying here would
//! change both topology and bounds a second time.

use crate::booleans::{BoolOp, PositionedPath};
use crate::PathCmd;

const GRID_WIDTH: usize = 160;
// Hostile or exceptionally thin inputs must decline, not allocate an unbounded
// grid or monopolize the WASM thread. The web choke falls back to TS on error.
const MAX_GRID_CELLS: usize = 2_000_000;
const MAX_SAMPLE_EDGES: usize = 50_000_000;

type Point = (f64, f64);

/// Rasterize all operands on ONE grid, matching `booleanPathTs` in geometry.ts.
/// The wire v1 caller supplies one closed, anchor-only polygon per operand.
/// Errors are intentional declines, not approximate results.
pub fn boolean_web_raster(
    op: BoolOp,
    shapes: &[PositionedPath],
) -> Result<Vec<Vec<(f64, f64)>>, &'static str> {
    if !(2..=16).contains(&shapes.len()) {
        return Err("web raster expects 2 to 16 operands");
    }

    let (mut min_x, mut min_y, mut max_x, mut max_y) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    let mut world = Vec::with_capacity(shapes.len());
    for shape in shapes {
        let mut poly = Vec::with_capacity(shape.cmds.len());
        for cmd in &shape.cmds {
            let (x, y) = match *cmd {
                PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => (x, y),
                PathCmd::Close => continue,
                PathCmd::CurveTo(..) => return Err("web raster requires anchor-only polygons"),
            };
            let (x, y) = (x + shape.offset.0, y + shape.offset.1);
            if !x.is_finite() || !y.is_finite() {
                return Err("non-finite web raster coordinate");
            }
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
            poly.push((x, y));
        }
        if poly.len() < 3 {
            return Err("web raster requires at least three anchors");
        }
        world.push(poly);
    }

    let pad = 2.0;
    min_x -= pad;
    min_y -= pad;
    max_x += pad;
    max_y += pad;
    let bw = (max_x - min_x).max(2.0);
    let bh = (max_y - min_y).max(2.0);
    let height = ((bh / bw) * GRID_WIDTH as f64).round().max(8.0);
    if !height.is_finite() || height > (MAX_GRID_CELLS / GRID_WIDTH) as f64 {
        return Err("web raster grid too large");
    }
    let gh = height as usize;
    let cells = GRID_WIDTH * gh;
    let edges: usize = world.iter().map(Vec::len).sum();
    if cells
        .checked_mul(edges)
        .is_none_or(|n| n > MAX_SAMPLE_EDGES)
    {
        return Err("web raster sampling budget exceeded");
    }
    let sx = bw / GRID_WIDTH as f64;
    let sy = bh / gh as f64;

    let mut cov = vec![false; cells];
    for y in 0..gh {
        let py = min_y + (y as f64 + 0.5) * sy;
        for x in 0..GRID_WIDTH {
            let px = min_x + (x as f64 + 0.5) * sx;
            let mut value = inside(&world[0], px, py);
            for poly in &world[1..] {
                let other = inside(poly, px, py);
                value = match op {
                    BoolOp::Union => value || other,
                    BoolOp::Subtract => value && !other,
                    BoolOp::Intersect => value && other,
                    BoolOp::Exclude => value != other,
                };
            }
            cov[y * GRID_WIDTH + x] = value;
        }
    }

    // The TS oracle scans boundary cells row-major. It marks cells visited
    // globally (even when a walk is shorter than three points), and greedily
    // follows the first unvisited boundary neighbour in precisely this order.
    // This is NOT an edge-chaining polygonizer: altering the walk changes the
    // number and extent of contours even if the coverage grid stays identical.
    let mut seen = vec![false; cells];
    let mut rings = Vec::new();
    for y in 0..gh {
        for x in 0..GRID_WIDTH {
            let id = y * GRID_WIDTH + x;
            if !cov[id] || !boundary(&cov, x as isize, y as isize, gh) || seen[id] {
                continue;
            }
            let (mut cx, mut cy) = (x as isize, y as isize);
            let mut ring = Vec::new();
            for _ in 0..cells {
                let current = cy as usize * GRID_WIDTH + cx as usize;
                if seen[current] {
                    break;
                }
                seen[current] = true;
                ring.push((
                    min_x + (cx as f64 + 0.5) * sx,
                    min_y + (cy as f64 + 0.5) * sy,
                ));
                let neighbours = [
                    (cx + 1, cy),
                    (cx, cy + 1),
                    (cx - 1, cy),
                    (cx, cy - 1),
                    (cx + 1, cy + 1),
                    (cx - 1, cy + 1),
                    (cx + 1, cy - 1),
                    (cx - 1, cy - 1),
                ];
                let next = neighbours.into_iter().find(|&(nx, ny)| {
                    filled(&cov, nx, ny, gh)
                        && !seen[ny as usize * GRID_WIDTH + nx as usize]
                        && boundary(&cov, nx, ny, gh)
                });
                match next {
                    Some((nx, ny)) => {
                        cx = nx;
                        cy = ny;
                    }
                    None => break,
                }
            }
            if ring.len() >= 3 {
                rings.push(ring);
            }
        }
    }
    Ok(rings)
}

#[inline]
fn filled(cov: &[bool], x: isize, y: isize, gh: usize) -> bool {
    x >= 0
        && y >= 0
        && (x as usize) < GRID_WIDTH
        && (y as usize) < gh
        && cov[y as usize * GRID_WIDTH + x as usize]
}

#[inline]
fn boundary(cov: &[bool], x: isize, y: isize, gh: usize) -> bool {
    !filled(cov, x - 1, y, gh)
        || !filled(cov, x + 1, y, gh)
        || !filled(cov, x, y - 1, gh)
        || !filled(cov, x, y + 1, gh)
}

// Keep the TS ray-crossing arithmetic, including its denominator adjustment.
// Using x-core's equivalent even-odd predicate moves samples exactly on edges.
#[inline]
fn inside(poly: &[Point], x: f64, y: f64) -> bool {
    let mut hit = false;
    let mut j = poly.len() - 1;
    for (i, &a) in poly.iter().enumerate() {
        let b = poly[j];
        if (a.1 > y) != (b.1 > y) && x < ((b.0 - a.0) * (y - a.1)) / (b.1 - a.1 + 1e-9) + a.0 {
            hit = !hit;
        }
        j = i;
    }
    hit
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> PositionedPath {
        PositionedPath {
            cmds: vec![
                PathCmd::MoveTo(x, y),
                PathCmd::LineTo(x + w, y),
                PathCmd::LineTo(x + w, y + h),
                PathCmd::LineTo(x, y + h),
                PathCmd::Close,
            ],
            offset: (0.0, 0.0),
        }
    }

    #[test]
    fn shared_grid_uses_web_cell_centres_not_native_cell_edges() {
        let shapes = [rect(0.0, 0.0, 10.0, 10.0), rect(5.0, 5.0, 10.0, 10.0)];
        let rings = boolean_web_raster(BoolOp::Union, &shapes).unwrap();
        assert!(!rings.is_empty());
        // The padded 19x19 world is sampled on a 160x160 grid. The first
        // boundary cell centre is 0.078125, not the old RasterGuided 0.25.
        assert_eq!(rings[0][0], (0.078125, 0.078125));
        assert_eq!(rings, boolean_web_raster(BoolOp::Union, &shapes).unwrap());
    }

    #[test]
    fn thin_intersection_is_not_lost_to_a_minimum_cell_size() {
        let shapes = [rect(0.0, 0.0, 0.3, 10.0), rect(0.0, 4.0, 10.0, 0.3)];
        assert!(!boolean_web_raster(BoolOp::Intersect, &shapes)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn all_operands_share_the_initial_sampling_grid() {
        let shapes = [
            rect(0.0, 0.0, 10.0, 10.0),
            rect(8.0, 0.0, 10.0, 10.0),
            rect(16.0, 0.0, 10.0, 10.0),
        ];
        let rings = boolean_web_raster(BoolOp::Union, &shapes).unwrap();
        assert!(!rings.is_empty());
        // Third operand widens the original grid to [-2,28] in x.
        assert_eq!(rings[0][0].0, 0.15625);
        assert!((rings[0][0].1 - (-2.0 + 11.5 * (14.0 / 75.0))).abs() < 1e-12);
    }

    #[test]
    fn unbounded_grid_declines_instead_of_coarsening_the_result() {
        let shapes = [rect(0.0, 0.0, 0.01, 1e9), rect(0.0, 0.0, 0.01, 1e9)];
        assert_eq!(
            boolean_web_raster(BoolOp::Union, &shapes),
            Err("web raster grid too large")
        );
    }

    #[test]
    fn curved_paths_are_not_silently_rasterized_as_anchors() {
        let mut shapes = [rect(0.0, 0.0, 10.0, 10.0), rect(5.0, 5.0, 10.0, 10.0)];
        shapes[0].cmds[1] = PathCmd::CurveTo(0.0, 0.0, 10.0, 0.0, 10.0, 0.0);
        assert_eq!(
            boolean_web_raster(BoolOp::Union, &shapes),
            Err("web raster requires anchor-only polygons")
        );
    }
}
