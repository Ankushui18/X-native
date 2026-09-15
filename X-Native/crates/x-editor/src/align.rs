#[allow(unused_imports)]
use crate::*;
use x_core::*;

// -------------------------------------------------------- align / distribute

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlignKind {
    Left,
    CenterH,
    Right,
    Top,
    CenterV,
    Bottom,
}

/// Phase 2.11: align sibling nodes (by their local x/y/w/h) to their
/// collective bounds. Operates on ids that share `parent`.
pub fn align(parent: &mut Node, ids: &[String], kind: AlignKind) {
    let sel: Vec<usize> = parent
        .children
        .iter()
        .enumerate()
        .filter(|(_, c)| ids.contains(&c.id))
        .map(|(i, _)| i)
        .collect();
    if sel.len() < 2 {
        return;
    }
    let x0 = sel
        .iter()
        .map(|&i| parent.children[i].transform.x)
        .fold(f64::INFINITY, f64::min);
    let y0 = sel
        .iter()
        .map(|&i| parent.children[i].transform.y)
        .fold(f64::INFINITY, f64::min);
    let x1 = sel
        .iter()
        .map(|&i| parent.children[i].transform.x + parent.children[i].w)
        .fold(f64::NEG_INFINITY, f64::max);
    let y1 = sel
        .iter()
        .map(|&i| parent.children[i].transform.y + parent.children[i].h)
        .fold(f64::NEG_INFINITY, f64::max);
    for &i in &sel {
        let c = &mut parent.children[i];
        match kind {
            AlignKind::Left => c.transform.x = x0,
            AlignKind::Right => c.transform.x = x1 - c.w,
            AlignKind::CenterH => c.transform.x = (x0 + x1) / 2.0 - c.w / 2.0,
            AlignKind::Top => c.transform.y = y0,
            AlignKind::Bottom => c.transform.y = y1 - c.h,
            AlignKind::CenterV => c.transform.y = (y0 + y1) / 2.0 - c.h / 2.0,
        }
        c.dirty = true;
    }
}

/// Phase 2.11: equal spacing along an axis (equal spacing distribution).
pub fn distribute_horizontal(parent: &mut Node, ids: &[String]) {
    let mut sel: Vec<usize> = parent
        .children
        .iter()
        .enumerate()
        .filter(|(_, c)| ids.contains(&c.id))
        .map(|(i, _)| i)
        .collect();
    if sel.len() < 3 {
        return;
    }
    // total_cmp: a NaN transform.x must not panic the distribution sort
    sel.sort_by(|&a, &b| {
        parent.children[a]
            .transform
            .x
            .total_cmp(&parent.children[b].transform.x)
    });
    let first = sel[0];
    let last = *sel.last().unwrap();
    let span = (parent.children[last].transform.x + parent.children[last].w)
        - parent.children[first].transform.x;
    let total_w: f64 = sel.iter().map(|&i| parent.children[i].w).sum();
    let gap = (span - total_w) / (sel.len() as f64 - 1.0);
    let mut cursor = parent.children[first].transform.x;
    for &i in &sel {
        parent.children[i].transform.x = cursor;
        cursor += parent.children[i].w + gap;
        parent.children[i].dirty = true;
    }
}
