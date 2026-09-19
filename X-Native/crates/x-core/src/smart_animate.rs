//! SmartAnimate interpolation engine.
//!
//! SmartAnimate morphs between two frames by interpolating node properties
//! (position, size, opacity, fill color, corner radius, rotation) over a
//! transition duration. Nodes are matched by ID; nodes present in one frame
//! but not the other fade in/out.
//!
//! This is the core of Figma's "Smart animate" transition preset.

use crate::{Color, Node, Paint};
use std::collections::HashMap;

/// Interpolated state for a single node during a SmartAnimate transition.
#[derive(Debug, Clone)]
pub struct InterpolatedNode {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub opacity: f32,
    pub rotation: f64,
    pub corner_radius: Option<f64>,
    pub fill: Option<Color>,
}

/// Collect all nodes from a frame into a flat map (id -> node).
fn collect_nodes(node: &Node, map: &mut HashMap<String, InterpolatedNode>) {
    let fill_color = match &node.fill {
        Paint::Solid(c) => Some(*c),
        _ => None,
    };
    let corner_radius = if let crate::NodeKind::Rect { radius } = node.kind {
        Some(radius)
    } else {
        None
    };
    map.insert(
        node.id.clone(),
        InterpolatedNode {
            id: node.id.clone(),
            x: node.transform.x,
            y: node.transform.y,
            w: node.w,
            h: node.h,
            opacity: node.opacity,
            rotation: node.transform.rotation,
            corner_radius,
            fill: fill_color,
        },
    );
    for child in &node.children {
        collect_nodes(child, map);
    }
}

/// Interpolate between two frames. Returns a map of node ID -> interpolated
/// state at progress `t` (0.0 = from_frame, 1.0 = to_frame).
///
/// Nodes present in both frames morph smoothly. Nodes only in `from_frame`
/// fade out (opacity → 0). Nodes only in `to_frame` fade in (opacity 0 → target).
pub fn interpolate_frames(
    from_frame: &Node,
    to_frame: &Node,
    t: f64,
) -> HashMap<String, InterpolatedNode> {
    let mut from_nodes = HashMap::new();
    let mut to_nodes = HashMap::new();
    collect_nodes(from_frame, &mut from_nodes);
    collect_nodes(to_frame, &mut to_nodes);

    let mut result = HashMap::new();

    // Nodes in both frames: interpolate
    for (id, from) in &from_nodes {
        if let Some(to) = to_nodes.get(id) {
            result.insert(id.clone(), interpolate_node(from, to, t));
        }
    }

    // Nodes only in from_frame: fade out
    for (id, from) in &from_nodes {
        if !to_nodes.contains_key(id) {
            let mut faded = from.clone();
            faded.opacity = from.opacity * (1.0 - t) as f32;
            result.insert(id.clone(), faded);
        }
    }

    // Nodes only in to_frame: fade in
    for (id, to) in &to_nodes {
        if !from_nodes.contains_key(id) {
            let mut faded = to.clone();
            faded.opacity = to.opacity * t as f32;
            result.insert(id.clone(), faded);
        }
    }

    result
}

/// Smart-animate the destination screen against the screen it replaced at
/// progress `t`, using Figma's own matching rule — name and hierarchy, the
/// rule behind **Animate matching layers** (help 360039818874) and behind the
/// Smart animate preset. The result is keyed by the DESTINATION layer's id, so
/// a renderer painting the new screen can pull each layer's in-between out of
/// the map:
///
/// * a matched layer morphs — position, size, opacity, rotation, corner
///   radius, fill — from its counterpart, exactly as [`interpolate_frames`]
///   morphs nodes that share an id;
/// * a layer that matched nothing *dissolves in*: it starts transparent and
///   reaches its own opacity at `t = 1`;
/// * a fixed layer that matched is not in the map at all: Figma gives it no
///   transition, so the renderer paints it where it is for the whole tick.
///
/// [`matching_layers`]: crate::prototype::matching_layers
pub fn interpolate_matching_layers(
    from: &Node,
    to: &Node,
    t: f64,
) -> HashMap<String, InterpolatedNode> {
    let t = t.clamp(0.0, 1.0);
    let mut from_nodes = HashMap::new();
    let mut to_nodes = HashMap::new();
    collect_nodes(from, &mut from_nodes);
    collect_nodes(to, &mut to_nodes);
    let mut result = HashMap::new();
    for layer in crate::prototype::matching_layers(from, to) {
        let Some(now) = to_nodes.get(&layer.to) else {
            continue;
        };
        match &layer.transition {
            crate::prototype::LayerTransition::SmartAnimate { from: src } => {
                if let Some(before) = from_nodes.get(src) {
                    result.insert(layer.to.clone(), interpolate_node(before, now, t));
                }
            }
            // "A new dest layer dissolves in" — and so does a fixed layer
            // with nothing to match, which has no position to hold.
            crate::prototype::LayerTransition::Dissolve => {
                let mut arriving = now.clone();
                arriving.opacity = now.opacity * t as f32;
                result.insert(layer.to.clone(), arriving);
            }
            crate::prototype::LayerTransition::Hold => {}
        }
    }
    result
}

/// Linearly interpolate between two node states.
fn interpolate_node(from: &InterpolatedNode, to: &InterpolatedNode, t: f64) -> InterpolatedNode {
    InterpolatedNode {
        id: from.id.clone(),
        x: lerp(from.x, to.x, t),
        y: lerp(from.y, to.y, t),
        w: lerp(from.w, to.w, t),
        h: lerp(from.h, to.h, t),
        opacity: lerp_f32(from.opacity, to.opacity, t as f32),
        rotation: lerp_angle(from.rotation, to.rotation, t),
        corner_radius: match (from.corner_radius, to.corner_radius) {
            (Some(r1), Some(r2)) => Some(lerp(r1, r2, t)),
            (Some(r), None) => Some(lerp(r, 0.0, t)),
            (None, Some(r)) => Some(lerp(0.0, r, t)),
            (None, None) => None,
        },
        fill: match (from.fill, to.fill) {
            (Some(c1), Some(c2)) => Some(interpolate_color(c1, c2, t)),
            (Some(c), None) => Some(fade_color_out(c, t)),
            (None, Some(c)) => Some(fade_color_in(c, t)),
            (None, None) => None,
        },
    }
}

/// Linear interpolation: `a + (b - a) * t`.
fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

/// Linear interpolation for f32.
fn lerp_f32(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// Interpolate rotation taking the shortest path (avoid spinning 360°).
fn lerp_angle(a: f64, b: f64, t: f64) -> f64 {
    let mut diff = b - a;
    // Normalize to [-π, π]
    while diff > std::f64::consts::PI {
        diff -= 2.0 * std::f64::consts::PI;
    }
    while diff < -std::f64::consts::PI {
        diff += 2.0 * std::f64::consts::PI;
    }
    a + diff * t
}

/// Interpolate two colors by linearly blending RGBA components. Color
/// components are f32, so this uses `lerp_f32` — the f64 `lerp` above is for
/// geometry.
fn interpolate_color(c1: Color, c2: Color, t: f64) -> Color {
    let t = t as f32;
    let mix = |i: usize| lerp_f32(c1.components[i], c2.components[i], t).clamp(0.0, 1.0);
    Color::new([mix(0), mix(1), mix(2), mix(3)])
}

/// Fade a color out (alpha → 0).
fn fade_color_out(c: Color, t: f64) -> Color {
    let a = (c.components[3] * (1.0 - t as f32)).clamp(0.0, 1.0);
    Color::new([c.components[0], c.components[1], c.components[2], a])
}

/// Fade a color in (alpha 0 → target).
fn fade_color_in(c: Color, t: f64) -> Color {
    let a = (c.components[3] * t as f32).clamp(0.0, 1.0);
    Color::new([c.components[0], c.components[1], c.components[2], a])
}

/// Easing functions for animation curves.
pub mod easing {
    /// Linear (no easing).
    pub fn linear(t: f64) -> f64 {
        t
    }

    /// Ease-in: slow start, fast end (quadratic).
    pub fn ease_in(t: f64) -> f64 {
        t * t
    }

    /// Ease-out: fast start, slow end (quadratic).
    pub fn ease_out(t: f64) -> f64 {
        1.0 - (1.0 - t) * (1.0 - t)
    }

    /// Ease-in-out: slow start and end, fast middle (quadratic).
    pub fn ease_in_out(t: f64) -> f64 {
        if t < 0.5 {
            2.0 * t * t
        } else {
            1.0 - 2.0 * (1.0 - t) * (1.0 - t)
        }
    }

    /// Cubic ease-in.
    pub fn cubic_in(t: f64) -> f64 {
        t * t * t
    }

    /// Cubic ease-out.
    pub fn cubic_out(t: f64) -> f64 {
        1.0 - (1.0 - t).powi(3)
    }

    /// Cubic ease-in-out.
    pub fn cubic_in_out(t: f64) -> f64 {
        if t < 0.5 {
            4.0 * t * t * t
        } else {
            1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NodeKind, Transform};

    fn make_rect(id: &str, x: f64, y: f64, w: f64, h: f64, color: Color) -> Node {
        let mut n = Node::rect(id, x, y, w, h, color);
        n.kind = NodeKind::Rect { radius: 0.0 };
        n
    }

    #[test]
    fn interpolate_position() {
        let from = make_rect("a", 0.0, 0.0, 100.0, 100.0, Color::BLACK);
        let to = make_rect("a", 100.0, 100.0, 100.0, 100.0, Color::BLACK);
        let result = interpolate_frames(&from, &to, 0.5);
        let interp = result.get("a").unwrap();
        assert!((interp.x - 50.0).abs() < 0.01);
        assert!((interp.y - 50.0).abs() < 0.01);
    }

    #[test]
    fn interpolate_size() {
        let from = make_rect("a", 0.0, 0.0, 100.0, 100.0, Color::BLACK);
        let to = make_rect("a", 0.0, 0.0, 200.0, 200.0, Color::BLACK);
        let result = interpolate_frames(&from, &to, 0.5);
        let interp = result.get("a").unwrap();
        assert!((interp.w - 150.0).abs() < 0.01);
        assert!((interp.h - 150.0).abs() < 0.01);
    }

    #[test]
    fn fade_out_missing_node() {
        let from = make_rect("a", 0.0, 0.0, 100.0, 100.0, Color::BLACK);
        let to = Node::frame("empty", 500.0, 500.0);
        let result = interpolate_frames(&from, &to, 0.5);
        let interp = result.get("a").unwrap();
        assert!((interp.opacity - 0.5).abs() < 0.01);
    }

    #[test]
    fn fade_in_new_node() {
        let from = Node::frame("empty", 500.0, 500.0);
        let to = make_rect("a", 0.0, 0.0, 100.0, 100.0, Color::BLACK);
        let result = interpolate_frames(&from, &to, 0.5);
        let interp = result.get("a").unwrap();
        assert!((interp.opacity - 0.5).abs() < 0.01);
    }

    /// The tick's half of Smart animate: layers matched by name and
    /// hierarchy morph, new ones dissolve in, and a matched fixed layer is
    /// left alone — Figma's cases (help 360039818874).
    #[test]
    fn matching_layers_interpolate_by_name_not_id() {
        fn layer(id: &str, name: &str, x: f64, y: f64, w: f64, h: f64) -> Node {
            let mut n = make_rect(id, x, y, w, h, Color::BLACK);
            n.name = name.into();
            n
        }
        let mut pinned = layer("bar-b", "Bar", 0.0, 150.0, 40.0, 40.0);
        pinned.constraints.fixed = true;
        let from = Node::frame("Home", 300.0, 200.0)
            .child(
                layer("card-a", "Card", 0.0, 0.0, 40.0, 40.0)
                    .child(layer("title-a", "Title", 0.0, 0.0, 40.0, 10.0)),
            )
            .child(layer("bar-a", "Bar", 0.0, 150.0, 40.0, 40.0))
            .child(layer("gone-a", "Gone", 60.0, 0.0, 10.0, 10.0));
        let to = Node::frame("Detail", 300.0, 200.0)
            .child(
                layer("card-b", "Card", 40.0, 20.0, 80.0, 80.0)
                    .child(layer("title-b", "Title", 8.0, 8.0, 64.0, 10.0)),
            )
            .child(pinned)
            .child(layer("new-b", "New", 200.0, 0.0, 20.0, 20.0));

        let mid = interpolate_matching_layers(&from, &to, 0.5);
        // matched by name and place: halfway between the two layouts
        let card = mid.get("card-b").expect("the matched card morphs");
        assert!((card.x - 20.0).abs() < 0.01, "moved halfway");
        assert!((card.y - 10.0).abs() < 0.01);
        assert!((card.w - 60.0).abs() < 0.01, "grew halfway");
        assert!((card.h - 60.0).abs() < 0.01);
        // its child matches through the hierarchy, not through the screens
        let title = mid.get("title-b").expect("the child matches under Card");
        assert!((title.x - 4.0).abs() < 0.01);
        assert!((title.w - 52.0).abs() < 0.01);
        // a layer the outgoing screen never had arrives transparent, in place
        let fresh = mid.get("new-b").expect("a new layer dissolves in");
        assert!((fresh.opacity - 0.5).abs() < 0.01);
        assert!((fresh.x - 200.0).abs() < 0.01, "it arrives where it lives");
        // matched but fixed: no transition, so nothing to interpolate
        assert_eq!(mid.get("bar-b"), None, "a fixed match holds still");
        // the map is keyed by destination id, and outgoing-only layers are
        // simply not part of the new screen's picture
        assert_eq!(mid.get("card-a"), None);
        assert_eq!(mid.get("gone-a"), None);
    }

    #[test]
    fn interpolate_color() {
        let c1 = Color::new([0.0, 0.0, 0.0, 1.0]); // black
        let c2 = Color::new([1.0, 1.0, 1.0, 1.0]); // white
        let mid = super::interpolate_color(c1, c2, 0.5);
        assert!((mid.components[0] - 0.5).abs() < 0.01);
        assert!((mid.components[1] - 0.5).abs() < 0.01);
        assert!((mid.components[2] - 0.5).abs() < 0.01);
    }

    #[test]
    fn easing_functions() {
        assert_eq!(easing::linear(0.5), 0.5);
        assert!(easing::ease_in(0.5) < 0.5);
        assert!(easing::ease_out(0.5) > 0.5);
        assert!((easing::ease_in_out(0.5) - 0.5).abs() < 0.01);
    }
}
