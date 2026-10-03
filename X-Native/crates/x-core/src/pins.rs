#[allow(unused_imports)]
use crate::*;
use kurbo::{Affine, Circle, Rect, RoundedRect, RoundedRectRadii, Shape};
use peniko::{Brush, Color, Fill, Gradient, Mix};
use std::collections::HashMap;

// -------------------------------------------------------------- constraints

/// Phase 2.12: resize constraints (how a child reacts when its frame resizes).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HPin {
    #[default]
    Left,
    Right,
    CenterH,
    StretchH,
    ScaleH,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VPin {
    #[default]
    Top,
    Bottom,
    CenterV,
    StretchV,
    ScaleV,
}
