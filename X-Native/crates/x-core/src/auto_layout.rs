#[allow(unused_imports)]
use crate::*;
use kurbo::{Affine, Circle, Rect, RoundedRect, RoundedRectRadii, Shape};
use peniko::{Brush, Color, Fill, Gradient, Mix};
use std::collections::HashMap;

// -------------------------------------------------------------- auto layout

/// Auto Layout v2: gap/padding VARIABLES, PER-SIDE padding, cross-axis
/// alignment, space-between, independent main/cross HUG, flex
/// grow/shrink/basis (Figma "fill container"), ABSOLUTE out-of-flow
/// children, baseline alignment, multi-line WRAP and min/max constraints.
///
/// Unified from two parallel tracks: the v2 solver (wrap/grow/basis/
/// baseline) originally written against scalar padding, and the per-side
/// padding + cross_sizing model. Padding is `[left, right, top, bottom]`;
/// main-axis start/end and cross-axis start/end are picked per direction.
///
/// CSS Flexbox parity (Figma Jul-2026): inside strokes included in layout,
/// border-box fill-container distribution, auto-gap never overlaps, padding
/// minimum enforced on fixed frames.
pub fn apply_auto_layout(node: &mut Node, vars: &Variables) {
    let layout = match &node.kind {
        NodeKind::Frame { layout: Some(l) } => l.clone(),
        _ => return,
    };
    let gap = layout
        .gap_var
        .as_deref()
        .map(|n| vars.number(n, layout.gap))
        .unwrap_or(layout.gap);
    let padding: Padding = layout
        .padding_var
        .as_deref()
        .map(|n| {
            let v = vars.number(n, layout.padding[0]);
            [v, v, v, v]
        })
        .unwrap_or(layout.padding);

    // CSS Flexbox parity: inside strokes add to the effective padding when
    // `stroke_include_in_layout` is true (the new default). Outside and
    // center strokes never affect layout.
    let inside_stroke = if layout.stroke_include_in_layout {
        node.inside_stroke_width()
    } else {
        0.0
    };
    let eff_padding: Padding = [
        padding[0] + inside_stroke, // left
        padding[1] + inside_stroke, // right
        padding[2] + inside_stroke, // top
        padding[3] + inside_stroke, // bottom
    ];

    // CSS Flexbox parity: padding (incl. inside stroke) always gets the room
    // it needs. A fixed-size frame can't be smaller than its padding total.
    let min_w = eff_padding[0] + eff_padding[1];
    let min_h = eff_padding[2] + eff_padding[3];
    if node.w < min_w {
        node.w = min_w;
    }
    if node.h < min_h {
        node.h = min_h;
    }

    if let Some(g) = &layout.grid {
        // CSS-grid mode (Figma Grid): the stack solver is bypassed; the
        // min/max clamp below still applies to the frame's own axes.
        crate::grid::apply_grid_layout(node, &layout, g);
    } else if layout.wrap == AutoLayoutWrap::Wrap {
        layout_wrapped(node, &layout, gap, eff_padding);
    } else {
        layout_flow(node, &layout, gap, eff_padding);
    }

    // Min/max dimensions clamp the frame's own axes. Figma: "Minimum and
    // maximum dimensions is an additional setting that can be used at the
    // same time as other resizing properties" (help 360040451373), so this is
    // not a hug-only rule — a Fixed frame is bounded the same way. A maximum
    // can never cut into the padding, and the minimum wins when the two
    // cross, since that is the setting Figma reads last.
    if let Some(mx) = layout.max_width {
        node.w = node.w.min(mx.max(min_w));
    }
    if let Some(mn) = layout.min_width {
        node.w = node.w.max(mn);
    }
    if let Some(mx) = layout.max_height {
        node.h = node.h.min(mx.max(min_h));
    }
    if let Some(mn) = layout.min_height {
        node.h = node.h.max(mn);
    }
    // neither axis may fall under its own padding total
    if node.w < min_w {
        node.w = min_w;
    }
    if node.h < min_h {
        node.h = min_h;
    }
    node.dirty = false;
}

/// Main-axis (start, end) padding for this direction.
fn main_pad(horizontal: bool, pad: Padding) -> (f64, f64) {
    if horizontal {
        (pad[0], pad[1])
    } else {
        (pad[2], pad[3])
    }
}
/// Cross-axis (start, end) padding for this direction.
fn cross_pad(horizontal: bool, pad: Padding) -> (f64, f64) {
    if horizontal {
        (pad[2], pad[3])
    } else {
        (pad[0], pad[1])
    }
}

/// Single row (horizontal) / column (vertical) flow — the classic solver,
/// now with flex grow/shrink/basis (Figma "fill container" + overflow shrink).
fn layout_flow(node: &mut Node, layout: &AutoLayout, gap: f64, pad: Padding) {
    let horizontal = layout.direction == LayoutDirection::Horizontal;
    let (m0, m1) = main_pad(horizontal, pad);
    let (c0, c1) = cross_pad(horizontal, pad);
    let hug_cross = layout.cross() == Sizing::Hug;
    // Absolute children are removed from the flow (Figma ABSOLUTE): they keep
    // their manual transform and are ignored for sizing/gap/hug.
    let flow: Vec<usize> = node
        .children
        .iter()
        .enumerate()
        .filter(|(_, c)| !c.constraints.is_out_of_flow())
        .map(|(i, _)| i)
        .collect();
    let n = flow.len();

    // Main-axis base sizes: flex-basis overrides the node's own size.
    let mut mains: Vec<f64> = flow
        .iter()
        .map(|&i| {
            let c = &node.children[i];
            c.constraints
                .basis
                .unwrap_or(if horizontal { c.w } else { c.h })
        })
        .collect();
    let content_main: f64 = mains.iter().sum();
    let container_main = if horizontal { node.w } else { node.h };

    // Distribution (Fixed frames): Between/Around/Evenly consume the
    // leftover like CSS justify-content; Packed keeps the authored gap.
    // `edge` is extra leading space before the first item (0 / u/2 / g).
    let leftover = (container_main - m0 - m1 - content_main).max(0.0);
    let (gap, edge) = match (layout.distribute, layout.sizing == Sizing::Fixed, n) {
        (Distribute::Between, true, k) if k > 1 => (leftover / (k as f64 - 1.0), 0.0),
        (Distribute::Around, true, k) if k > 0 => {
            let u = leftover / k as f64;
            (u, u / 2.0)
        }
        (Distribute::Evenly, true, k) if k > 0 => {
            let g = leftover / (k as f64 + 1.0);
            (g, g)
        }
        _ => (gap, 0.0),
    };

    // grow/shrink only for Fixed frames (Hug fits content by definition) and
    // only when a distribution mode isn't already consuming the leftover.
    if layout.sizing == Sizing::Fixed && n > 0 && layout.distribute == Distribute::Packed {
        let available = container_main - m0 - m1 - (n as f64 - 1.0) * gap;
        if available > content_main {
            // grow: distribute leftover among children with grow > 0.
            // CSS Flexbox parity (Figma Jul-2026): border-box model —
            // children with thicker inside strokes take more total space
            // so their content areas match their siblings'.
            let grow_total: f64 = flow
                .iter()
                .map(|&i| node.children[i].constraints.grow)
                .sum();
            if grow_total > 0.0 {
                // Sum of inside strokes for grow children (each stroke
                // counts on both sides: 2 * stroke_width).
                let grow_stroke_total: f64 = flow
                    .iter()
                    .filter(|&&i| node.children[i].constraints.grow > 0.0)
                    .map(|&i| 2.0 * node.children[i].inside_stroke_width())
                    .sum();
                // Total size of non-grow children (their sizes stay fixed).
                let non_grow_total: f64 = (0..n)
                    .filter(|&k| node.children[flow[k]].constraints.grow == 0.0)
                    .map(|k| mains[k])
                    .sum();
                // Content pool: available space minus non-grow children
                // minus grow children's stroke widths.
                let content_pool = (available - non_grow_total - grow_stroke_total).max(0.0);
                for k in 0..n {
                    let g = node.children[flow[k]].constraints.grow;
                    if g > 0.0 {
                        let child_stroke = 2.0 * node.children[flow[k]].inside_stroke_width();
                        // Content share + own stroke = total allocation.
                        mains[k] = content_pool * g / grow_total + child_stroke;
                    }
                }
            }
        } else if available < content_main {
            // shrink: reduce children proportional to shrink * size.
            let overflow = content_main - available;
            let shrink_weight: f64 = flow
                .iter()
                .enumerate()
                .map(|(k, &i)| node.children[i].constraints.shrink * mains[k])
                .sum();
            if shrink_weight > 0.0 {
                for k in 0..n {
                    let s = node.children[flow[k]].constraints.shrink;
                    mains[k] = (mains[k] - overflow * (s * mains[k]) / shrink_weight).max(0.0);
                }
            }
        }
    }

    // Per-child effective cross-axis alignment (align_self overrides the frame).
    let effective: Vec<CrossAlign> = flow
        .iter()
        .map(|&i| {
            node.children[i]
                .constraints
                .align_self
                .map(to_cross_align)
                .unwrap_or(layout.align)
        })
        .collect();
    // Baseline alignment (horizontal layout only — the cross axis is vertical).
    let baseline = horizontal && effective.contains(&CrossAlign::Baseline);
    let mut base_off = vec![0.0f64; n];
    let (mut max_base, mut max_after) = (0.0f64, 0.0f64);
    if baseline {
        for k in 0..n {
            let c = &node.children[flow[k]];
            let b = child_baseline(c);
            base_off[k] = b;
            max_base = max_base.max(b);
            max_after = max_after.max(c.h - b);
        }
    }

    let cross_extent = flow
        .iter()
        .map(|&i| {
            let c = &node.children[i];
            if horizontal {
                c.h
            } else {
                c.w
            }
        })
        .fold(0.0f64, f64::max);
    let container_cross = if baseline && hug_cross {
        max_base + max_after + c0 + c1
    } else if hug_cross {
        cross_extent + c0 + c1
    } else if horizontal {
        node.h
    } else {
        node.w
    };

    let mut cursor = m0 + edge;
    for k in 0..n {
        let i = flow[k];
        let child = &mut node.children[i];
        let child_cross = if horizontal { child.h } else { child.w };
        let align = effective[k];
        let cross_pos = if baseline && align == CrossAlign::Baseline {
            c0 + max_base - base_off[k]
        } else {
            cross_position(align, container_cross, c0, c1, child_cross)
        };
        if horizontal {
            // grow/shrink resizes the child along the main axis.
            child.w = mains[k];
            child.transform.x = cursor;
            child.transform.y = cross_pos;
            cursor += mains[k] + gap;
        } else {
            child.h = mains[k];
            child.transform.y = cursor;
            child.transform.x = cross_pos;
            cursor += mains[k] + gap;
        }
        child.dirty = true;
    }
    if layout.sizing == Sizing::Hug {
        // edge is only non-zero for Fixed frames, so Hug content is unaffected
        let main = if n > 0 {
            cursor - gap - edge + m1
        } else {
            m0 + m1
        };
        if horizontal {
            node.w = main;
        } else {
            node.h = main;
        }
    }
    if hug_cross {
        if horizontal {
            node.h = container_cross;
        } else {
            node.w = container_cross;
        }
    }
}

/// Multi-line wrap: children flow along the main axis until they would
/// exceed the available extent, then wrap to a new line. Lines are stacked
/// along the cross axis with `gap` between them; `align` aligns each item
/// within its own line (Figma's default `alignContent = start`). Hug frames
/// wrap at `max_width`/`max_height` (if set) and then hug to the widest line.
fn layout_wrapped(node: &mut Node, layout: &AutoLayout, gap: f64, pad: Padding) {
    let horizontal = layout.direction == LayoutDirection::Horizontal;
    let (m0, m1) = main_pad(horizontal, pad);
    let (c0, c1) = cross_pad(horizontal, pad);
    let hug_cross = layout.cross() == Sizing::Hug;
    // Absolute children are removed from the flow (Figma ABSOLUTE).
    let flow: Vec<usize> = node
        .children
        .iter()
        .enumerate()
        .filter(|(_, c)| !c.constraints.is_out_of_flow())
        .map(|(i, _)| i)
        .collect();
    let count = flow.len();
    if count == 0 {
        if layout.sizing == Sizing::Hug {
            if horizontal {
                node.w = m0 + m1;
            } else {
                node.h = m0 + m1;
            }
        }
        if hug_cross {
            if horizontal {
                node.h = c0 + c1;
            } else {
                node.w = c0 + c1;
            }
        }
        return;
    }

    // flex-basis overrides the node's own main-axis size (Figma "fill"/basis).
    let mains: Vec<f64> = flow
        .iter()
        .map(|&i| {
            let c = &node.children[i];
            c.constraints
                .basis
                .unwrap_or(if horizontal { c.w } else { c.h })
        })
        .collect();
    let crosses: Vec<f64> = flow
        .iter()
        .map(|&i| {
            let c = &node.children[i];
            if horizontal {
                c.h
            } else {
                c.w
            }
        })
        .collect();

    // Available main-axis content extent (the wrap point). Hug frames with no
    // max constraint never wrap (a single line hugs to content width).
    let avail = match layout.sizing {
        Sizing::Fixed => (if horizontal { node.w } else { node.h } - m0 - m1).max(0.0),
        Sizing::Hug => match if horizontal {
            layout.max_width
        } else {
            layout.max_height
        } {
            Some(mx) => (mx - m0 - m1).max(0.0),
            None => f64::INFINITY,
        },
    };

    // Greedy line fill (positions are indices into `flow`).
    let mut rows: Vec<Vec<usize>> = Vec::new();
    let mut cur: Vec<usize> = Vec::new();
    let mut cur_main = 0.0f64;
    for (i, &main_i) in mains.iter().enumerate() {
        let add = if cur.is_empty() { main_i } else { main_i + gap };
        if !cur.is_empty() && cur_main + add > avail + 1e-9 {
            rows.push(std::mem::take(&mut cur));
            cur_main = 0.0;
        }
        if cur.is_empty() {
            cur_main = main_i;
        } else {
            cur_main += main_i + gap;
        }
        cur.push(i);
    }
    if !cur.is_empty() {
        rows.push(cur);
    }

    let row_items: Vec<f64> = rows
        .iter()
        .map(|r| r.iter().map(|&i| mains[i]).sum())
        .collect();
    // Per-line flex-grow (Fixed frames): "fill container" fills the remaining
    // width of its own line, exactly like Figma's fill in wrap layouts.
    // CSS Flexbox parity (Figma Jul-2026): border-box model — distribute
    // by content area so children with thicker strokes get more total space.
    let mut final_main: Vec<f64> = mains.clone();
    if layout.sizing == Sizing::Fixed && layout.distribute == Distribute::Packed {
        for row in rows.iter() {
            let grow_total: f64 = row
                .iter()
                .map(|&i| node.children[flow[i]].constraints.grow)
                .sum();
            if grow_total > 0.0 {
                let line_gaps = (row.len().saturating_sub(1)) as f64 * gap;
                let line_avail = (avail - line_gaps).max(0.0);
                let grow_stroke_total: f64 = row
                    .iter()
                    .filter(|&&i| node.children[flow[i]].constraints.grow > 0.0)
                    .map(|&i| 2.0 * node.children[flow[i]].inside_stroke_width())
                    .sum();
                let non_grow_total: f64 = row
                    .iter()
                    .filter(|&&i| node.children[flow[i]].constraints.grow == 0.0)
                    .map(|&i| mains[i])
                    .sum();
                let content_pool = (line_avail - non_grow_total - grow_stroke_total).max(0.0);
                for &i in row.iter() {
                    let g = node.children[flow[i]].constraints.grow;
                    if g > 0.0 {
                        let child_stroke = 2.0 * node.children[flow[i]].inside_stroke_width();
                        final_main[i] = content_pool * g / grow_total + child_stroke;
                    }
                }
            }
        }
    }
    let row_main: Vec<f64> = rows
        .iter()
        .enumerate()
        .map(|(ri, r)| row_items[ri] + (r.len().saturating_sub(1)) as f64 * gap)
        .collect();
    // Per-row cross extent. Horizontal rows with baseline-aligned items use
    // (max baseline above + max descent below), like flexbox's baseline row.
    let row_cross: Vec<f64> = rows
        .iter()
        .map(|r| {
            let any_base = horizontal
                && r.iter().any(|&i| {
                    node.children[flow[i]]
                        .constraints
                        .align_self
                        .map(to_cross_align)
                        .unwrap_or(layout.align)
                        == CrossAlign::Baseline
                });
            if any_base {
                let max_base = r
                    .iter()
                    .map(|&i| child_baseline(&node.children[flow[i]]))
                    .fold(0.0f64, f64::max);
                let max_after = r
                    .iter()
                    .map(|&i| {
                        let c = &node.children[flow[i]];
                        c.h - child_baseline(c)
                    })
                    .fold(0.0f64, f64::max);
                max_base + max_after
            } else {
                r.iter().map(|&i| crosses[i]).fold(0.0f64, f64::max)
            }
        })
        .collect();
    let total_cross: f64 =
        row_cross.iter().sum::<f64>() + (rows.len().saturating_sub(1)) as f64 * gap;

    let container_cross = if hug_cross {
        total_cross + c0 + c1
    } else if horizontal {
        node.h
    } else {
        node.w
    };

    // Position each line's children.
    let mut cross_cursor = c0;
    for (ri, row) in rows.iter().enumerate() {
        // Distribution (Fixed only) spreads the row's leftover main-axis
        // space like flexbox justify-content.
        let row_leftover = (avail - row_items[ri]).max(0.0);
        let (per_gap, row_edge) =
            match (layout.distribute, layout.sizing == Sizing::Fixed, row.len()) {
                (Distribute::Between, true, k) if k > 1 => (row_leftover / (k as f64 - 1.0), 0.0),
                (Distribute::Around, true, k) if k > 0 => {
                    let u = row_leftover / k as f64;
                    (u, u / 2.0)
                }
                (Distribute::Evenly, true, k) if k > 0 => {
                    let g = row_leftover / (k as f64 + 1.0);
                    (g, g)
                }
                _ => (gap, 0.0),
            };
        // Per-row baseline offsets (baseline rows align their text baselines).
        let row_base: Vec<f64> = row
            .iter()
            .map(|&i| child_baseline(&node.children[flow[i]]))
            .collect();
        let row_max_base = row_base.iter().cloned().fold(0.0f64, f64::max);
        let mut main_cursor = m0 + row_edge;
        for (ci, &i) in row.iter().enumerate() {
            let child = &mut node.children[flow[i]];
            // Per-child align_self overrides the frame's cross-axis alignment.
            let align = child
                .constraints
                .align_self
                .map(to_cross_align)
                .unwrap_or(layout.align);
            let cross_pos = if horizontal && align == CrossAlign::Baseline {
                row_max_base - row_base[ci] + cross_cursor
            } else {
                cross_position(align, row_cross[ri], 0.0, 0.0, crosses[i]) + cross_cursor
            };
            if horizontal {
                child.w = final_main[i];
                child.transform.x = main_cursor;
                child.transform.y = cross_pos;
                main_cursor += final_main[i] + per_gap;
            } else {
                child.h = final_main[i];
                child.transform.y = main_cursor;
                child.transform.x = cross_pos;
                main_cursor += final_main[i] + per_gap;
            }
            child.dirty = true;
        }
        cross_cursor += row_cross[ri] + gap;
    }

    if layout.sizing == Sizing::Hug {
        let main = row_main.iter().fold(0.0f64, |a, &b| a.max(b)) + m0 + m1;
        if horizontal {
            node.w = main;
        } else {
            node.h = main;
        }
    }
    if hug_cross {
        if horizontal {
            node.h = container_cross;
        } else {
            node.w = container_cross;
        }
    }
}

/// Map a per-child `Alignment` to the frame's cross-axis `CrossAlign`.
fn to_cross_align(a: Alignment) -> CrossAlign {
    match a {
        Alignment::Min => CrossAlign::Start,
        Alignment::Center => CrossAlign::Center,
        Alignment::Max => CrossAlign::End,
        Alignment::Baseline => CrossAlign::Baseline,
    }
}

/// Baseline offset of a child: distance from its top edge to its first text
/// baseline. Uses the explicit `node.baseline` when the text pipeline supplied
/// one; otherwise falls back to a geometry heuristic (text ≈ 0.72·h·0.8 ascent
/// at the node-height convention; non-text = bottom edge, per Figma).
fn child_baseline(child: &Node) -> f64 {
    if let Some(b) = child.baseline {
        return b;
    }
    if matches!(child.kind, NodeKind::Text { .. }) {
        child.h * 0.72 * 0.8
    } else {
        child.h
    }
}

/// Cross-axis offset of an item within a container of extent `container`,
/// honoring `padding` (0.0 = padding already baked into the cursor).
fn cross_position(
    align: CrossAlign,
    container: f64,
    pad_start: f64,
    pad_end: f64,
    child_cross: f64,
) -> f64 {
    match align {
        CrossAlign::Start => pad_start,
        // Symmetric padding makes "center of the box" == "center of the
        // content area", so no padding term here (matches the classic solver).
        CrossAlign::Center => (container - child_cross) / 2.0,
        CrossAlign::End => container - pad_end - child_cross,
        // Baseline is resolved by the caller (needs the whole line's offsets);
        // this arm is unreachable but keeps the match exhaustive.
        CrossAlign::Baseline => pad_start,
    }
}

/// Phase 5.1: recursive layout solve — children first (post-order), so a Hug
/// child reports its final size before the parent positions it.
pub fn apply_layout_recursive(node: &mut Node, vars: &Variables) {
    for child in &mut node.children {
        apply_layout_recursive(child, vars);
    }
    apply_auto_layout(node, vars);
}

/// The order a container's children are PAINTED in — indices into
/// `node.children`, bottom-most first (the painter's algorithm).
///
/// Figma's **canvas stacking** (help 31289464393751): "When multiple layers
/// have negative spacing creating a stack, the last object … will be on top by
/// default. You can change the visual order of the stack as seen on the
/// canvas" — *First on top* paints the first child last, so it lands on top.
/// The setting is a canvas-only change: the layer list keeps its own order.
///
/// This is the ONE owner of child paint order. The viewer, the IR encoder and
/// the hit test all walk it, so the layer you see on top is the layer you
/// click — and a frame that has never touched the setting keeps document
/// order exactly as before.
pub fn paint_order(node: &Node) -> Vec<usize> {
    let mut order: Vec<usize> = (0..node.children.len()).collect();
    if paints_first_on_top(node) {
        order.reverse();
    }
    order
}

/// `paint_order` as ranks: `ranks[i]` is the position child `i` paints in
/// (0 = bottom-most). Renderers that already have their own sort — `scene.rs`
/// orders by `z_index` — use this as the tie-break, so the canvas-stacking
/// rule still has exactly one implementation.
pub fn paint_ranks(node: &Node) -> Vec<usize> {
    let mut ranks = vec![0usize; node.children.len()];
    for (k, i) in paint_order(node).iter().enumerate() {
        ranks[*i] = k;
    }
    ranks
}

/// Does this container paint its FIRST child on top? True only for an
/// auto-layout frame whose canvas stacking is *First on top*; every other
/// layer in the document keeps the usual painter's order.
pub fn paints_first_on_top(node: &Node) -> bool {
    matches!(
        &node.kind,
        NodeKind::Frame { layout: Some(l) } if l.canvas_stacking == CanvasStacking::FirstOnTop
    )
}
