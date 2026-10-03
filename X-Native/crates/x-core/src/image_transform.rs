//! Canonical image transform model (review item: "Don't independently
//! calculate crop/fit in each sink").
//!
//! `resolve_image_placement()` is THE single mapping from a node's
//! (fit, placement, box size, intrinsic image size) to concrete draw
//! transforms. Every sink consumes the same resolution: ImagePlacement
//! -> resolve_image_placement() -> ResolvedImage -> {Vello, SVG, PDF}.
//!
//! Each draw is an `Affine` mapping IMAGE PIXEL SPACE (0..iw, 0..ih)
//! into NODE-LOCAL SPACE. Sinks only compose their own outer transform
//! (world matrix / SVG group / PDF CTM) — they never re-derive fit,
//! focal, zoom, flip, or tiling math. Flips fold into the affine, so a
//! sink cannot get them wrong independently.

use crate::node::{ImageFit, ImagePlacement};
use kurbo::Affine;

/// The resolved placement: clip rect is always the node box; one draw
/// per image instance (1 for fill/fit/crop, N for tile).
#[derive(Debug, Clone)]
pub struct ResolvedImage {
    /// image-pixel-space -> node-local-space, one per drawn copy
    pub draws: Vec<Affine>,
}

/// THE canonical fit/placement resolution. Mirrors were removed from the
/// sinks; change behavior HERE and every target follows.
pub fn resolve_image_placement(
    fit: ImageFit,
    placement: &ImagePlacement,
    w: f64,
    h: f64,
    iw: f64,
    ih: f64,
) -> ResolvedImage {
    if [
        w,
        h,
        iw,
        ih,
        placement.scale,
        placement.focal.0,
        placement.focal.1,
    ]
    .iter()
    .any(|n| !n.is_finite())
    {
        return ResolvedImage { draws: vec![] };
    }
    let (w, h) = (w.max(0.001), h.max(0.001));
    let (iw, ih) = (iw.max(0.001), ih.max(0.001));
    let zoom = placement.scale.max(0.05);
    let (fx, fy) = placement.focal;
    // flip = mirror inside the node box, applied OUTSIDE the fit math so
    // focal semantics stay in unflipped space (matches the canvas sink)
    let flip = Affine::translate((
        if placement.flip_h { w } else { 0.0 },
        if placement.flip_v { h } else { 0.0 },
    )) * Affine::scale_non_uniform(
        if placement.flip_h { -1.0 } else { 1.0 },
        if placement.flip_v { -1.0 } else { 1.0 },
    );

    let draws = match fit {
        ImageFit::Fill => {
            let (sx, sy) = (w / iw * zoom, h / ih * zoom);
            // keep the focal point stationary while zooming
            let (ox, oy) = (w * fx * (1.0 - zoom), h * fy * (1.0 - zoom));
            vec![flip * Affine::translate((ox, oy)) * Affine::scale_non_uniform(sx, sy)]
        }
        ImageFit::Fit => {
            let s = (w / iw).min(h / ih) * zoom;
            let (ox, oy) = ((w - iw * s) * fx, (h - ih * s) * fy);
            vec![flip * Affine::translate((ox, oy)) * Affine::scale(s)]
        }
        ImageFit::Crop => {
            let s = (w / iw).max(h / ih) * zoom;
            // focal chooses which part of the overflow stays visible:
            // 0 -> left/top edge, 1 -> right/bottom edge
            let (ox, oy) = ((w - iw * s) * fx, (h - ih * s) * fy);
            vec![flip * Affine::translate((ox, oy)) * Affine::scale(s)]
        }
        ImageFit::Tile => {
            let (tw, th) = (iw * zoom, ih * zoom);
            let nx = ((w / tw).ceil() as i64).max(1);
            let ny = ((h / th).ceil() as i64).max(1);
            let Some(count) = nx.checked_mul(ny).filter(|n| *n <= 16_384) else {
                return ResolvedImage { draws: vec![] };
            };
            let mut v = Vec::with_capacity(count as usize);
            for ty in 0..ny {
                for tx in 0..nx {
                    v.push(
                        flip * Affine::translate((tx as f64 * tw, ty as f64 * th))
                            * Affine::scale(zoom),
                    );
                }
            }
            v
        }
    };
    ResolvedImage { draws }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kurbo::Point;

    fn map(a: &Affine, x: f64, y: f64) -> (f64, f64) {
        let p = *a * Point::new(x, y);
        (p.x, p.y)
    }

    #[test]
    fn fill_stretches_image_to_box() {
        let r = resolve_image_placement(
            ImageFit::Fill,
            &ImagePlacement::default(),
            200.0,
            100.0,
            50.0,
            50.0,
        );
        assert_eq!(r.draws.len(), 1);
        assert_eq!(map(&r.draws[0], 0.0, 0.0), (0.0, 0.0));
        assert_eq!(map(&r.draws[0], 50.0, 50.0), (200.0, 100.0));
    }

    #[test]
    fn fit_letterboxes_centered_by_default() {
        // 100x100 image into 200x100 box: s=1, centered horizontally
        let r = resolve_image_placement(
            ImageFit::Fit,
            &ImagePlacement::default(),
            200.0,
            100.0,
            100.0,
            100.0,
        );
        assert_eq!(map(&r.draws[0], 0.0, 0.0), (50.0, 0.0));
        assert_eq!(map(&r.draws[0], 100.0, 100.0), (150.0, 100.0));
    }

    #[test]
    fn crop_covers_and_focal_selects_visible_region() {
        // 100x100 image into 200x100 box: s=2 -> image spans 200x200
        let centered = resolve_image_placement(
            ImageFit::Crop,
            &ImagePlacement::default(),
            200.0,
            100.0,
            100.0,
            100.0,
        );
        assert_eq!(
            map(&centered.draws[0], 0.0, 0.0),
            (0.0, -50.0),
            "center crop hides 50px top+bottom"
        );
        let top = ImagePlacement {
            focal: (0.5, 0.0),
            ..Default::default()
        };
        let r = resolve_image_placement(ImageFit::Crop, &top, 200.0, 100.0, 100.0, 100.0);
        assert_eq!(
            map(&r.draws[0], 0.0, 0.0),
            (0.0, 0.0),
            "focal 0 pins the top edge"
        );
    }

    #[test]
    fn tile_emits_grid_and_zoom_scales_tiles() {
        let r = resolve_image_placement(
            ImageFit::Tile,
            &ImagePlacement::default(),
            100.0,
            100.0,
            25.0,
            50.0,
        );
        assert_eq!(r.draws.len(), 4 * 2, "4 cols x 2 rows");
        // second column starts one tile over
        assert_eq!(map(&r.draws[1], 0.0, 0.0), (25.0, 0.0));
        let zoomed = ImagePlacement {
            scale: 2.0,
            ..Default::default()
        };
        let r2 = resolve_image_placement(ImageFit::Tile, &zoomed, 100.0, 100.0, 25.0, 50.0);
        assert_eq!(r2.draws.len(), 2, "2x zoom halves the grid");
        assert_eq!(
            map(&r2.draws[0], 25.0, 50.0),
            (50.0, 100.0),
            "tile drawn at 2x"
        );
    }

    #[test]
    fn flips_mirror_inside_the_box() {
        let ph = ImagePlacement {
            flip_h: true,
            ..Default::default()
        };
        let r = resolve_image_placement(ImageFit::Fill, &ph, 200.0, 100.0, 50.0, 50.0);
        // image left edge lands on box RIGHT edge
        assert_eq!(map(&r.draws[0], 0.0, 0.0), (200.0, 0.0));
        assert_eq!(map(&r.draws[0], 50.0, 50.0), (0.0, 100.0));
    }
}
