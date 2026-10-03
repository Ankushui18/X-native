#[allow(unused_imports)]
use crate::*;
pub use kurbo::Point;
pub use kurbo::{Affine, Rect};
use kurbo::{Circle, RoundedRect, RoundedRectRadii, Shape};
use peniko::{Brush, Color, Fill, Gradient, Mix};
use std::collections::HashMap;

// -------------------------------------------------------------------- stats

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SceneStats {
    pub nodes: usize,
    pub paths: usize,
    pub culled: usize,
    pub dirty_nodes: usize,
}
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

pub fn intersects(a: Rect, b: Rect) -> bool {
    a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0
}
pub fn bounds(world: Affine, w: f64, h: f64) -> Rect {
    let p = [
        world * kurbo::Point::new(0.0, 0.0),
        world * kurbo::Point::new(w, 0.0),
        world * kurbo::Point::new(w, h),
        world * kurbo::Point::new(0.0, h),
    ];
    let xs = p.iter().map(|p| p.x);
    let ys = p.iter().map(|p| p.y);
    Rect::new(
        xs.clone().fold(f64::INFINITY, f64::min),
        ys.clone().fold(f64::INFINITY, f64::min),
        xs.fold(f64::NEG_INFINITY, f64::max),
        ys.fold(f64::NEG_INFINITY, f64::max),
    )
}
