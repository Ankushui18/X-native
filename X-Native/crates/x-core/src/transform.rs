#[allow(unused_imports)]
use crate::*;
pub use kurbo::Point;
pub use kurbo::{Affine, Rect};
use kurbo::{Circle, RoundedRect, RoundedRectRadii, Shape};
use peniko::{Brush, Color, Fill, Gradient, Mix};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------- transform

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Transform {
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    /// Skew angles (radians) applied after scale (Figma's shear transform).
    pub skew_x: f64,
    pub skew_y: f64,
    /// Transform-origin pivot in NORMALIZED 0..1 local space (Figma's 9-point
    /// origin). (0.5, 0.5) = center (the default); (0,0) = top-left, etc.
    pub origin_x: f64,
    pub origin_y: f64,
}
impl Default for Transform {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            rotation: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            skew_x: 0.0,
            skew_y: 0.0,
            origin_x: 0.5,
            origin_y: 0.5,
        }
    }
}
impl Transform {
    /// The pivot point in node-local px (the transform-origin).
    pub fn pivot(self, w: f64, h: f64) -> (f64, f64) {
        (self.origin_x * w, self.origin_y * h)
    }
    pub fn matrix(self, w: f64, h: f64) -> Affine {
        let (px, py) = self.pivot(w, h);
        Affine::translate((self.x + px, self.y + py))
            * Affine::rotate(self.rotation)
            * Affine::scale_non_uniform(self.scale_x, self.scale_y)
            * Affine::skew(self.skew_x, self.skew_y)
            * Affine::translate((-px, -py))
    }
}

impl Transform {
    /// QR decomposition of an affine into our rotate/scale/skew representation.
    /// A zero-origin pivot makes the translation exact. Used when moving a
    /// copied subtree out of a transformed parent into page space.
    pub fn from_affine(matrix: Affine) -> Self {
        let [a, b, c, d, e, f] = matrix.as_coeffs();
        let sx = a.hypot(b);
        if sx > 1e-12 {
            Self {
                x: e,
                y: f,
                rotation: b.atan2(a),
                scale_x: sx,
                scale_y: (a * d - b * c) / sx,
                skew_x: ((a * c + b * d) / (sx * sx)).atan(),
                skew_y: 0.0,
                origin_x: 0.0,
                origin_y: 0.0,
            }
        } else {
            Self {
                x: e,
                y: f,
                rotation: (-c).atan2(d),
                scale_x: 0.0,
                scale_y: c.hypot(d),
                origin_x: 0.0,
                origin_y: 0.0,
                ..Self::default()
            }
        }
    }
}

/// Figma's angle convention, in degrees: a layer starts at 0°, a positive angle
/// runs counterclockwise towards 180°, a negative one clockwise towards -180°,
/// and *"once you pass 180 in either direction, Figma will count down towards 0°
/// in that direction"* — 195° is stored as -165°. The stored value therefore
/// always lands in `(-180, 180]`, which is the range the Design panel's rotation
/// field shows ([help 360039956914](https://help.figma.com/hc/en-us/articles/360039956914)).
pub fn normalize_degrees(deg: f64) -> f64 {
    if !deg.is_finite() {
        return 0.0;
    }
    let mut d = deg % 360.0;
    if d > 180.0 {
        d -= 360.0;
    }
    // 180 is the top of the range and -180 is not: the two are the same angle,
    // and Figma's own example counts down *from* 180, never to it.
    if d <= -180.0 {
        d += 360.0;
    }
    d
}

/// `c` rotated `delta` radians about `pivot`, both in the same space.
pub fn rotate_point_about(c: (f64, f64), pivot: (f64, f64), delta: f64) -> (f64, f64) {
    let (sin, cos) = delta.sin_cos();
    let (dx, dy) = (c.0 - pivot.0, c.1 - pivot.1);
    (pivot.0 + dx * cos - dy * sin, pivot.1 + dx * sin + dy * cos)
}

impl Transform {
    /// Rotate this box by `delta` radians about `pivot` (same space as `x`/`y`):
    /// the box's own angle advances by the same delta and the box itself orbits
    /// the pivot. When `pivot` is the box's own transform-origin the point stays
    /// put — the arithmetic drops out of the matrix, whatever the box's scale or
    /// skew — which is what Figma's rotation origin means.
    pub fn rotate_about(&mut self, w: f64, h: f64, pivot: (f64, f64), delta: f64) {
        let (px, py) = self.pivot(w, h);
        let c = (self.x + px, self.y + py);
        let q = rotate_point_about(c, pivot, delta);
        self.x = q.0 - px;
        self.y = q.1 - py;
        self.rotation += delta;
    }
}

#[cfg(test)]
mod rotation_tests {
    use super::*;

    /// The angle convention of `360039956914`: ±180, and past 180 the count runs
    /// back down in the direction you came from.
    #[test]
    fn the_angle_convention_counts_back_down_past_180() {
        assert_eq!(normalize_degrees(0.0), 0.0);
        assert_eq!(normalize_degrees(45.0), 45.0);
        assert_eq!(normalize_degrees(-90.0), -90.0);
        assert_eq!(normalize_degrees(180.0), 180.0);
        // "going 15° past 180° will give you an angle of -165°"
        assert_eq!(normalize_degrees(195.0), -165.0);
        assert_eq!(normalize_degrees(-195.0), 165.0);
        // a full turn is no turn
        assert_eq!(normalize_degrees(360.0), 0.0);
        assert_eq!(normalize_degrees(-360.0), 0.0);
        assert_eq!(normalize_degrees(360.0 + 195.0), -165.0);
    }

    /// A rotation about the box's own origin leaves the origin where it is; a
    /// rotation about any other point orbits it. Both fall out of the same call.
    #[test]
    fn rotating_about_the_origin_pins_it_and_about_anything_else_orbits_it() {
        let mut t = Transform::default();
        // a 100 × 50 box at (10, 20), origin at its centre
        t.x = 10.0;
        t.y = 20.0;
        let (w, h) = (100.0, 50.0);
        let own = (t.x + t.pivot(w, h).0, t.y + t.pivot(w, h).1);
        t.rotate_about(w, h, own, 90f64.to_radians());
        assert!((t.x - 10.0).abs() < 1e-9, "x: {}", t.x);
        assert!((t.y - 20.0).abs() < 1e-9, "y: {}", t.y);
        assert!((t.rotation - 90f64.to_radians()).abs() < 1e-12);

        // a quarter turn about the top-left corners swaps the box's offset
        let mut u = Transform::default();
        u.x = 10.0;
        u.y = 20.0;
        let tl = (10.0, 20.0);
        u.rotate_about(w, h, tl, 90f64.to_radians());
        // the centre went from (60, 45) to (60 - 25, 45 - 50) = (35, -5)
        assert!((u.x + 50.0 - 35.0).abs() < 1e-9, "centre x: {}", u.x + 50.0);
        assert!((u.y + 25.0 + 5.0).abs() < 1e-9, "centre y: {}", u.y + 25.0);

        // a moved origin is the pivot too — same call, and the pin still holds
        let mut v = Transform::default();
        v.x = 10.0;
        v.y = 20.0;
        v.origin_x = 0.0;
        v.origin_y = 0.0;
        let corner = (v.x, v.y);
        v.rotate_about(w, h, corner, 30f64.to_radians());
        assert!((v.x - 10.0).abs() < 1e-9, "odd origin x: {}", v.x);
        assert!((v.y - 20.0).abs() < 1e-9, "odd origin y: {}", v.y);
    }
}
