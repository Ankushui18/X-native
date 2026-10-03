use x_core::kurbo::{Affine, Point, Rect};

#[allow(unused_imports)]
use crate::*;
use x_core::*;

// ------------------------------------------------------------ spatial index

/// Phase 9.1: uniform grid over world space. Rebuild is O(n); point queries
/// touch one cell. Good enough to keep hit testing flat at 100K nodes; an
/// R-tree can replace it behind the same two methods later.
pub struct SpatialGrid {
    cell: f64,
    cells: std::collections::HashMap<(i64, i64), Vec<usize>>,
    entries: Vec<(String, Rect)>,
}
impl SpatialGrid {
    pub fn build(root: &Node, cell: f64) -> Self {
        let mut grid = Self {
            cell,
            cells: Default::default(),
            entries: vec![],
        };
        fn walk(node: &Node, parent: Affine, grid: &mut SpatialGrid) {
            if !node.visible {
                return;
            }
            let world = parent * node.transform.matrix(node.w, node.h);
            if !matches!(node.kind, NodeKind::Frame { .. } | NodeKind::Group) {
                let b = bounds(world, node.w, node.h);
                let idx = grid.entries.len();
                grid.entries.push((node.id.clone(), b));
                let (cx0, cy0) = (
                    (b.x0 / grid.cell).floor() as i64,
                    (b.y0 / grid.cell).floor() as i64,
                );
                let (cx1, cy1) = (
                    (b.x1 / grid.cell).floor() as i64,
                    (b.y1 / grid.cell).floor() as i64,
                );
                for cx in cx0..=cx1 {
                    for cy in cy0..=cy1 {
                        grid.cells.entry((cx, cy)).or_default().push(idx);
                    }
                }
            }
            for c in &node.children {
                walk(c, world, grid);
            }
        }
        walk(root, Affine::IDENTITY, &mut grid);
        grid
    }
    pub fn query_point(&self, p: Point) -> Vec<&str> {
        let key = (
            (p.x / self.cell).floor() as i64,
            (p.y / self.cell).floor() as i64,
        );
        self.cells
            .get(&key)
            .map(|v| {
                v.iter()
                    .filter(|&&i| {
                        let r = self.entries[i].1;
                        p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1
                    })
                    .map(|&i| self.entries[i].0.as_str())
                    .collect()
            })
            .unwrap_or_default()
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}
