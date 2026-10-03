#[allow(unused_imports)]
use crate::*;
use kurbo::{Affine, Circle, Rect, RoundedRect, RoundedRectRadii, Shape};
use peniko::{Brush, Color, Fill, Gradient, Mix};
use std::collections::HashMap;

// --------------------------------------------------------------- components

pub type ComponentRegistry<'a> = HashMap<&'a str, &'a Node>;
pub fn collect_components<'a>(node: &'a Node, reg: &mut ComponentRegistry<'a>) {
    if let NodeKind::Component { name } = &node.kind {
        reg.insert(name.as_str(), node);
    }
    for child in &node.children {
        collect_components(child, reg);
    }
}
/// Guards against a component that (directly or transitively) instances itself.
pub const MAX_INSTANCE_DEPTH: u32 = 32;
