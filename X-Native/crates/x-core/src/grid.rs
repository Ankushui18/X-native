//! CSS-Grid layout solver ( Grid, Config 2025).
//!
//! Frames whose [`AutoLayout`] carries a [`GridLayout`] lay out as a grid:
//! children place into cells (explicitly via [`ChildConstraints::grid_col`]
//! / `grid_row`, or auto-flowed row-major/column-major/dense), stretch to
//! their spanned cell area, and tracks size Fixed / Fr / Auto. Row tracks
//! beyond the declared ones are implicit `Auto` rows. A HUG frame sizes to
//! its tracks.

use crate::{ChildConstraints, GridAutoFlow, GridLayout, GridTrack, Node, Sizing};
use std::collections::HashMap;

struct Placed {
    col: usize,
    row: usize,
    col_span: usize,
    row_span: usize,
}

/// Apply a grid layout to a frame's children (mutating their transforms
/// and sizes). Absolute children keep their positions.
pub fn apply_grid_layout(node: &mut Node, layout: &crate::AutoLayout, grid: &GridLayout) {
    let kids: Vec<usize> = (0..node.children.len())
        .filter(|&i| {
            let c = &node.children[i];
            c.visible && !c.constraints.is_absolute
        })
        .collect();
    if kids.is_empty() {
        // hug an empty grid to its padding
        if layout.sizing == Sizing::Hug {
            node.w = grid.padding[0] + grid.padding[1];
            node.h = grid.padding[2] + grid.padding[3];
        }
        return;
    }

    // ---- placement ------------------------------------------------------
    let ncols = kids
        .iter()
        .map(|&i| {
            let c = &node.children[i];
            c.constraints.grid_col.unwrap_or(0) + c.constraints.grid_col_span
        })
        .chain(std::iter::once(grid.columns.len()))
        .max()
        .unwrap_or(1)
        .max(1);

    let mut occupancy: Vec<Vec<bool>> = vec![];
    let cells_free =
        |occ: &mut Vec<Vec<bool>>, col: usize, row: usize, cs: usize, rs: usize| -> bool {
            while occ.len() < row + rs {
                occ.push(vec![false; ncols]);
            }
            for (r, row_cells) in occ.iter().enumerate().take(row + rs).skip(row) {
                let _ = r;
                for c in col..col + cs {
                    if row_cells.get(c).copied().unwrap_or(false) {
                        return false;
                    }
                }
            }
            true
        };
    #[allow(clippy::too_many_arguments)]
    let mark = |occ: &mut Vec<Vec<bool>>, col: usize, row: usize, cs: usize, rs: usize| {
        while occ.len() < row + rs {
            occ.push(vec![false; ncols]);
        }
        for row_cells in occ.iter_mut().take(row + rs).skip(row) {
            for c in col..col + cs {
                if let Some(cell) = row_cells.get_mut(c) {
                    *cell = true;
                }
            }
        }
    };

    let mut placed: HashMap<usize, Placed> = HashMap::new();

    // pass 1: fully explicit children claim their cells first
    let mut explicit: Vec<usize> = vec![];
    let mut semi: Vec<usize> = vec![];
    let mut flow: Vec<usize> = vec![];
    for &i in &kids {
        let c = &node.children[i];
        match (c.constraints.grid_col, c.constraints.grid_row) {
            (Some(col), Some(row)) => {
                let p = Placed {
                    col,
                    row,
                    col_span: c.constraints.grid_col_span,
                    row_span: c.constraints.grid_row_span,
                };
                mark(&mut occupancy, p.col, p.row, p.col_span, p.row_span);
                placed.insert(i, p);
                explicit.push(i);
            }
            _ => {
                let has_any = c.constraints.grid_col.is_some() || c.constraints.grid_row.is_some();
                if has_any {
                    semi.push(i);
                } else {
                    flow.push(i);
                }
            }
        }
    }

    // pass 2: partially explicit (fixed column OR fixed row)
    for &i in &semi {
        let (col_hint, row_hint, cs, rs) = {
            let c = &node.children[i];
            (
                c.constraints.grid_col,
                c.constraints.grid_row,
                c.constraints.grid_col_span,
                c.constraints.grid_row_span,
            )
        };
        let p = if let Some(col) = col_hint {
            // first row where the span fits
            let mut row = 0;
            while !cells_free(&mut occupancy, col, row, cs, rs) {
                row += 1;
            }
            Placed {
                col,
                row,
                col_span: cs,
                row_span: rs,
            }
        } else {
            let row = row_hint.unwrap_or(0);
            let mut col = 0;
            while col + cs <= ncols && !cells_free(&mut occupancy, col, row, cs, rs) {
                col += 1;
            }
            if col + cs > ncols {
                col = 0; // wrap into a fresh row
                while !cells_free(&mut occupancy, col, row, cs, rs) {
                    col += 1;
                }
            }
            Placed {
                col,
                row,
                col_span: cs,
                row_span: rs,
            }
        };
        mark(&mut occupancy, p.col, p.row, p.col_span, p.row_span);
        placed.insert(i, p);
    }

    // pass 3: auto-flow into the first fitting cell. Mode depends on
    // `grid.auto_flow`:
    //   - Row: row-major, scan left-to-right then top-to-bottom (default).
    //   - Column: column-major, scan top-to-bottom then left-to-right.
    //   - Dense: same as Row, but backfill gaps from the start — re-scan
    //     from (0,0) on every placement so earlier children can fill holes
    //     left by larger items.
    for &i in &flow {
        let (cs, rs) = {
            let c = &node.children[i];
            (c.constraints.grid_col_span, c.constraints.grid_row_span)
        };
        let cs = cs.min(ncols).max(1);

        match grid.auto_flow {
            GridAutoFlow::Row | GridAutoFlow::Dense => {
                // Row-major: scan rows first, then columns within each row.
                // No cursor is carried between children, so sparse and dense
                // placement both start at row 0 and dense backfilling falls
                // out of the scan itself.
                let start_row: usize = 0;
                'outer: for row in start_row.. {
                    for col in 0..ncols.saturating_sub(cs - 1) {
                        if cells_free(&mut occupancy, col, row, cs, rs) {
                            mark(&mut occupancy, col, row, cs, rs);
                            placed.insert(
                                i,
                                Placed {
                                    col,
                                    row,
                                    col_span: cs,
                                    row_span: rs,
                                },
                            );
                            break 'outer;
                        }
                    }
                }
            }
            GridAutoFlow::Column => {
                // Column-major: fill each column's DECLARED rows top-to-bottom,
                // then move to the next column. The row scan has to be bounded
                // by the declared rows — `cells_free` answers true for any row
                // past the end of `occupancy` (which `mark` grows on demand), so
                // an unbounded scan always "found" a fresh implicit row in
                // column 0 and the flow never reached column 1. Every child
                // stacked into column 0 as a result.
                let declared = grid.rows.len();
                let mut at = None;
                if declared > 0 {
                    'declared_col: for col in 0..ncols {
                        for row in 0..declared {
                            if row + rs <= declared && cells_free(&mut occupancy, col, row, cs, rs)
                            {
                                at = Some((col, row));
                                break 'declared_col;
                            }
                        }
                    }
                }
                if at.is_none() {
                    // Every declared cell is taken, or the grid declares no rows
                    // at all. Grow implicit rows, still trying the earlier
                    // columns first so the column-major order survives. Bounded
                    // so a full grid cannot spin.
                    'implicit_col: for col in 0..ncols {
                        for row in declared..declared + 100 {
                            if cells_free(&mut occupancy, col, row, cs, rs) {
                                at = Some((col, row));
                                break 'implicit_col;
                            }
                        }
                    }
                }
                if let Some((col, row)) = at {
                    mark(&mut occupancy, col, row, cs, rs);
                    placed.insert(
                        i,
                        Placed {
                            col,
                            row,
                            col_span: cs,
                            row_span: rs,
                        },
                    );
                }
            }
        }
    }

    let nrows = occupancy.len().max(1);

    // ---- track sizing ---------------------------------------------------
    let track_at = |tracks: &[GridTrack], i: usize| -> GridTrack {
        tracks.get(i).copied().unwrap_or(GridTrack::Auto)
    };

    let mut col_sizes = vec![0.0f64; ncols];
    for (i, sz) in col_sizes.iter_mut().enumerate() {
        if let GridTrack::Fixed(v) = track_at(&grid.columns, i) {
            *sz = v;
        }
    }
    // Auto columns size to the max natural width of single-span children
    for &i in &kids {
        let p = &placed[&i];
        if p.col_span == 1 && matches!(track_at(&grid.columns, p.col), GridTrack::Auto) {
            col_sizes[p.col] = col_sizes[p.col].max(node.children[i].w);
        }
    }

    let hug_w = layout.sizing == Sizing::Hug;
    let content_w = node.w - grid.padding[0] - grid.padding[1];
    let fixed_auto_w: f64 =
        col_sizes.iter().sum::<f64>() + grid.column_gap * (ncols.saturating_sub(1)) as f64;

    // Fr columns share the leftover space (HUG frames treat Fr as Auto)
    let fr_cols: Vec<usize> = (0..ncols)
        .filter(|&i| matches!(track_at(&grid.columns, i), GridTrack::Fr(_)))
        .collect();
    if fr_cols.is_empty() {
        if hug_w {
            node.w = fixed_auto_w + grid.padding[0] + grid.padding[1];
        }
    } else {
        let mut fr_total = 0.0;
        for &i in &fr_cols {
            if let GridTrack::Fr(v) = track_at(&grid.columns, i) {
                fr_total += v;
            }
        }
        if hug_w {
            // intrinsic sizing: Fr behaves as Auto
            for &i in &fr_cols {
                let mut nat = 0.0f64;
                for &k in &kids {
                    let p = &placed[&k];
                    if p.col == i && p.col_span == 1 {
                        nat = nat.max(node.children[k].w);
                    }
                }
                col_sizes[i] = nat;
            }
            node.w = col_sizes.iter().sum::<f64>()
                + grid.column_gap * (ncols.saturating_sub(1)) as f64
                + grid.padding[0]
                + grid.padding[1];
        } else {
            let leftover = (content_w - fixed_auto_w).max(0.0);
            for &i in &fr_cols {
                if let GridTrack::Fr(v) = track_at(&grid.columns, i) {
                    col_sizes[i] = if fr_total > 0.0 {
                        leftover * v / fr_total
                    } else {
                        0.0
                    };
                }
            }
        }
    }

    let mut row_sizes = vec![0.0f64; nrows];
    for (i, sz) in row_sizes.iter_mut().enumerate() {
        if let GridTrack::Fixed(v) = track_at(&grid.rows, i) {
            *sz = v;
        }
    }
    for &i in &kids {
        let p = &placed[&i];
        if p.row_span == 1 && matches!(track_at(&grid.rows, p.row), GridTrack::Auto) {
            row_sizes[p.row] = row_sizes[p.row].max(node.children[i].h);
        }
    }

    let hug_h = layout.cross_sizing.unwrap_or(layout.sizing) == Sizing::Hug;
    let content_h = node.h - grid.padding[2] - grid.padding[3];
    let fixed_auto_h: f64 =
        row_sizes.iter().sum::<f64>() + grid.row_gap * (nrows.saturating_sub(1)) as f64;
    let fr_rows: Vec<usize> = (0..nrows)
        .filter(|&i| matches!(track_at(&grid.rows, i), GridTrack::Fr(_)))
        .collect();
    if fr_rows.is_empty() {
        if hug_h {
            node.h = fixed_auto_h + grid.padding[2] + grid.padding[3];
        }
    } else {
        let mut fr_total = 0.0;
        for &i in &fr_rows {
            if let GridTrack::Fr(v) = track_at(&grid.rows, i) {
                fr_total += v;
            }
        }
        if hug_h {
            for &i in &fr_rows {
                let mut nat = 0.0f64;
                for &k in &kids {
                    let p = &placed[&k];
                    if p.row == i && p.row_span == 1 {
                        nat = nat.max(node.children[k].h);
                    }
                }
                row_sizes[i] = nat;
            }
            node.h = row_sizes.iter().sum::<f64>()
                + grid.row_gap * (nrows.saturating_sub(1)) as f64
                + grid.padding[2]
                + grid.padding[3];
        } else {
            let leftover = (content_h - fixed_auto_h).max(0.0);
            for &i in &fr_rows {
                if let GridTrack::Fr(v) = track_at(&grid.rows, i) {
                    row_sizes[i] = if fr_total > 0.0 {
                        leftover * v / fr_total
                    } else {
                        0.0
                    };
                }
            }
        }
    }

    // ---- position + stretch ---------------------------------------------
    let col_x = |col: usize| -> f64 {
        grid.padding[0] + (0..col).map(|i| col_sizes[i]).sum::<f64>() + col as f64 * grid.column_gap
    };
    let row_y = |row: usize| -> f64 {
        grid.padding[2] + (0..row).map(|i| row_sizes[i]).sum::<f64>() + row as f64 * grid.row_gap
    };
    let span_w = |p: &Placed| -> f64 {
        (p.col..p.col + p.col_span)
            .map(|i| col_sizes[i])
            .sum::<f64>()
            + (p.col_span - 1) as f64 * grid.column_gap
    };
    let span_h = |p: &Placed| -> f64 {
        (p.row..p.row + p.row_span)
            .map(|i| row_sizes[i])
            .sum::<f64>()
            + (p.row_span - 1) as f64 * grid.row_gap
    };

    for (i, c) in node.children.iter_mut().enumerate() {
        if let Some(p) = placed.get(&i) {
            c.transform.x = col_x(p.col);
            c.transform.y = row_y(p.row);
            c.w = span_w(p);
            c.h = span_h(p);
        }
        // absolute children keep their authored position
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{apply_auto_layout, CrossAlign, LayoutDirection, NodeKind, Variables};
    use peniko::Color;

    fn grid_frame(w: f64, h: f64, columns: Vec<GridTrack>, rows: Vec<GridTrack>) -> Node {
        let mut f = Node::frame("g", w, h);
        f.kind = NodeKind::Frame {
            layout: Some(crate::AutoLayout {
                direction: LayoutDirection::Vertical,
                gap: 0.0,
                padding: [0.0; 4],
                sizing: Sizing::Fixed,
                cross_sizing: Some(Sizing::Fixed),
                align: CrossAlign::Start,
                grid: Some(GridLayout {
                    columns,
                    rows,
                    column_gap: 0.0,
                    row_gap: 0.0,
                    padding: [0.0; 4],
                    auto_flow: GridAutoFlow::Row,
                }),
                ..Default::default()
            }),
        };
        f
    }

    fn cell(id: &str, w: f64, h: f64) -> Node {
        Node::rect(id, 0.0, 0.0, w, h, Color::WHITE)
    }

    #[test]
    fn auto_columns_size_to_content_and_children_stretch() {
        let mut f = grid_frame(600.0, 100.0, vec![GridTrack::Auto, GridTrack::Auto], vec![]);
        f.children.push(cell("a", 120.0, 30.0));
        f.children.push(cell("b", 80.0, 20.0));
        f.children.push(cell("c", 60.0, 50.0));
        apply_auto_layout(&mut f, &Variables::default());

        // auto columns: max natural per column (120, 80); flow row-major
        let a = &f.children[0];
        let b = &f.children[1];
        let c = &f.children[2];
        assert_eq!((a.transform.x, a.w), (0.0, 120.0));
        assert_eq!((b.transform.x, b.w), (120.0, 80.0));
        // c wraps to row 2, column 0
        assert_eq!((c.transform.x, c.transform.y), (0.0, 30.0));
        // row 1 height = max(a.h, b.h) = 30; children stretch to it
        assert_eq!(a.h, 30.0);
        assert_eq!(b.h, 30.0);
        assert_eq!(c.h, 50.0);
    }

    #[test]
    fn fr_columns_split_leftover_space() {
        let mut f = grid_frame(
            300.0,
            100.0,
            vec![
                GridTrack::Fixed(100.0),
                GridTrack::Fr(1.0),
                GridTrack::Fr(2.0),
            ],
            vec![],
        );
        f.children.push(cell("a", 10.0, 10.0));
        f.children.push(cell("b", 10.0, 10.0));
        f.children.push(cell("c", 10.0, 10.0));
        apply_auto_layout(&mut f, &Variables::default());

        // leftover = 300 - 100 = 200 -> 1fr=66.67, 2fr=133.33
        let b = &f.children[1];
        let c = &f.children[2];
        assert!((b.w - 200.0 / 3.0).abs() < 1e-9, "1fr = {:?}", b.w);
        assert!((c.w - 400.0 / 3.0).abs() < 1e-9, "2fr = {:?}", c.w);
        assert!((b.transform.x - 100.0).abs() < 1e-9);
        assert!((c.transform.x - (100.0 + 200.0 / 3.0)).abs() < 1e-9);
    }

    #[test]
    fn explicit_placement_and_spans() {
        let mut f = grid_frame(
            400.0,
            100.0,
            vec![GridTrack::Fixed(100.0), GridTrack::Fixed(100.0)],
            vec![],
        );
        let mut wide = cell("wide", 10.0, 10.0);
        wide.constraints.grid_col = Some(0);
        wide.constraints.grid_row = Some(0);
        wide.constraints.grid_col_span = 2;
        let mut corner = cell("corner", 10.0, 10.0);
        corner.constraints.grid_col = Some(1);
        corner.constraints.grid_row = Some(1);
        f.children.push(wide);
        f.children.push(corner);
        apply_auto_layout(&mut f, &Variables::default());

        let w = &f.children[0];
        assert_eq!((w.transform.x, w.transform.y), (0.0, 0.0));
        assert_eq!(w.w, 200.0, "spans both columns");
        let c = &f.children[1];
        assert_eq!((c.transform.x, c.transform.y), (100.0, 10.0));
        // implicit row 1 height = corner's natural height (10)
        assert_eq!(c.h, 10.0);
    }

    #[test]
    fn gaps_and_padding_are_honored() {
        let mut f = grid_frame(0.0, 0.0, vec![GridTrack::Auto, GridTrack::Auto], vec![]);
        if let NodeKind::Frame { layout: Some(l) } = &mut f.kind {
            l.sizing = Sizing::Hug; // hug width
            l.cross_sizing = Some(Sizing::Hug);
            if let Some(g) = &mut l.grid {
                g.column_gap = 10.0;
                g.row_gap = 6.0;
                g.padding = [5.0, 7.0, 3.0, 9.0]; // l r t b
            }
        }
        f.children.push(cell("a", 50.0, 20.0));
        f.children.push(cell("b", 40.0, 30.0));
        f.children.push(cell("c", 30.0, 10.0));
        apply_auto_layout(&mut f, &Variables::default());

        // columns: [50, 40]; hug width = 5 + 50 + 10 + 40 + 7 = 112
        assert_eq!(f.w, 112.0, "hug width incl gaps + padding");
        // row 0 height = max(20,30)=30; row 1 = 10; hug height = 3 + 30 + 6 + 10 + 9 = 58
        assert_eq!(f.h, 58.0, "hug height incl row gap + padding");
        let a = &f.children[0];
        assert_eq!((a.transform.x, a.transform.y), (5.0, 3.0));
        let b = &f.children[1];
        assert_eq!(b.transform.x, 5.0 + 50.0 + 10.0);
        let c = &f.children[2];
        assert_eq!(c.transform.y, 3.0 + 30.0 + 6.0);
        // stretched b spans the taller row
        assert_eq!(b.h, 30.0);
    }

    #[test]
    fn hug_frame_treats_fr_as_auto() {
        let mut f = grid_frame(
            0.0,
            100.0,
            vec![GridTrack::Fr(1.0), GridTrack::Fr(1.0)],
            vec![],
        );
        if let NodeKind::Frame { layout: Some(l) } = &mut f.kind {
            l.sizing = Sizing::Hug;
            l.cross_sizing = Some(Sizing::Fixed);
        }
        f.children.push(cell("a", 60.0, 10.0));
        f.children.push(cell("b", 40.0, 10.0));
        apply_auto_layout(&mut f, &Variables::default());

        assert_eq!(f.w, 100.0, "fr columns hug to natural sizes");
        assert_eq!(f.children[0].w, 60.0);
        assert_eq!(f.children[1].w, 40.0);
    }

    #[test]
    fn absolute_children_are_untouched() {
        let mut f = grid_frame(200.0, 100.0, vec![GridTrack::Fixed(200.0)], vec![]);
        let mut abs = cell("abs", 30.0, 30.0);
        abs.constraints.is_absolute = true;
        abs.transform.x = 123.0;
        abs.transform.y = 45.0;
        f.children.push(cell("a", 30.0, 30.0));
        f.children.push(abs);
        apply_auto_layout(&mut f, &Variables::default());

        let abs = &f.children[1];
        assert_eq!(
            (abs.transform.x, abs.transform.y, abs.w),
            (123.0, 45.0, 30.0)
        );
    }

    #[test]
    fn partial_explicit_col_finds_first_free_row() {
        let mut f = grid_frame(300.0, 100.0, vec![GridTrack::Fixed(100.0); 3], vec![]);
        // a explicitly occupies (0,0); b pinned to column 0 -> row 1
        let mut a = cell("a", 10.0, 10.0);
        a.constraints.grid_col = Some(0);
        a.constraints.grid_row = Some(0);
        let mut b = cell("b", 10.0, 10.0);
        b.constraints.grid_col = Some(0);
        f.children.push(a);
        f.children.push(b);
        apply_auto_layout(&mut f, &Variables::default());

        assert_eq!(f.children[0].transform.y, 0.0);
        assert_eq!(
            f.children[1].transform.y, 10.0,
            "pinned col wraps to next free row"
        );
    }

    #[test]
    fn grid_template_css_helpers() {
        let g = GridLayout {
            columns: vec![
                GridTrack::Fixed(120.0),
                GridTrack::Fr(1.0),
                GridTrack::Fr(2.0),
                GridTrack::Auto,
            ],
            rows: vec![],
            ..Default::default()
        };
        assert_eq!(g.template_columns_css(), "120px 1fr 2fr auto");
        assert_eq!(g.template_rows_css(), "");
        let g2 = GridLayout {
            rows: vec![GridTrack::Fixed(60.0)],
            ..Default::default()
        };
        assert_eq!(g2.template_rows_css(), "60px");
    }

    // ----- Grid auto-flow modes -----

    #[test]
    fn grid_column_major_auto_flow() {
        // 2x3 grid, column-major: children fill top-to-bottom, then next column
        let mut f = grid_frame(
            300.0,
            200.0,
            vec![GridTrack::Fixed(100.0), GridTrack::Fixed(100.0)],
            vec![
                GridTrack::Fixed(50.0),
                GridTrack::Fixed(50.0),
                GridTrack::Fixed(50.0),
            ],
        );
        if let NodeKind::Frame { layout: Some(l) } = &mut f.kind {
            if let Some(g) = &mut l.grid {
                g.auto_flow = GridAutoFlow::Column;
            }
        }
        // 5 children to place column-major
        for i in 0..5 {
            f.children.push(cell(&format!("c{}", i), 20.0, 20.0));
        }
        apply_auto_layout(&mut f, &Variables::default());
        // Column-major: c0(0,0), c1(0,1), c2(0,2), c3(1,0), c4(1,1)
        let c0 = &f.children[0];
        let c1 = &f.children[1];
        let c2 = &f.children[2];
        let c3 = &f.children[3];
        let c4 = &f.children[4];
        assert_eq!((c0.transform.x, c0.transform.y), (0.0, 0.0));
        assert_eq!((c1.transform.x, c1.transform.y), (0.0, 50.0));
        assert_eq!((c2.transform.x, c2.transform.y), (0.0, 100.0));
        assert_eq!((c3.transform.x, c3.transform.y), (100.0, 0.0));
        assert_eq!((c4.transform.x, c4.transform.y), (100.0, 50.0));
    }

    #[test]
    fn grid_dense_auto_flow_backfills_gaps() {
        // 3x3 grid with one explicit child at (2,0), then 3 auto-flow children.
        // Row-major without dense: auto children skip (2,0) and go to row 1.
        // With dense: auto children backfill the gap at (0,0), (1,0), then (0,1).
        let mut f = grid_frame(
            300.0,
            300.0,
            vec![GridTrack::Fixed(100.0); 3],
            vec![GridTrack::Fixed(50.0); 3],
        );
        if let NodeKind::Frame { layout: Some(l) } = &mut f.kind {
            if let Some(g) = &mut l.grid {
                g.auto_flow = GridAutoFlow::Dense;
            }
        }
        // Explicit child at column 2, row 0
        let mut explicit = cell("explicit", 20.0, 20.0);
        explicit.constraints.grid_col = Some(2);
        explicit.constraints.grid_row = Some(0);
        f.children.push(explicit);
        // 3 auto-flow children
        for i in 0..3 {
            f.children.push(cell(&format!("auto{}", i), 20.0, 20.0));
        }
        apply_auto_layout(&mut f, &Variables::default());
        // Dense: auto0 fills (0,0), auto1 fills (1,0), auto2 fills (0,1)
        let auto0 = &f.children[1];
        let auto1 = &f.children[2];
        let auto2 = &f.children[3];
        assert_eq!((auto0.transform.x, auto0.transform.y), (0.0, 0.0));
        assert_eq!((auto1.transform.x, auto1.transform.y), (100.0, 0.0));
        assert_eq!((auto2.transform.x, auto2.transform.y), (0.0, 50.0));
    }
}
