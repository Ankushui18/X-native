//! Phase 6: Image adjustment filters
//!
//! Non-destructive image adjustments for exposure, contrast, saturation,
//! temperature, tint, highlights, and shadows. These adjustments are applied
//! at render time and can be modified or removed at any time.

use x_core::Color;

/// Phase 6: Image adjustment parameters
/// All values are in the range [-1.0, 1.0] where:
/// - -1.0 = maximum negative adjustment
/// - 0.0 = no adjustment
/// - 1.0 = maximum positive adjustment
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImageAdjustments {
    /// Brightness adjustment (-1.0 to 1.0)
    pub exposure: f32,
    /// Contrast adjustment (-1.0 to 1.0)
    pub contrast: f32,
    /// Color saturation adjustment (-1.0 to 1.0)
    pub saturation: f32,
    /// Color temperature adjustment (-1.0 to 1.0, negative = cool/blue, positive = warm/orange)
    pub temperature: f32,
    /// Color tint adjustment (-1.0 to 1.0, negative = green, positive = magenta)
    pub tint: f32,
    /// Highlight brightness adjustment (-1.0 to 1.0)
    pub highlights: f32,
    /// Shadow brightness adjustment (-1.0 to 1.0)
    pub shadows: f32,
}

impl Default for ImageAdjustments {
    fn default() -> Self {
        Self {
            exposure: 0.0,
            contrast: 0.0,
            saturation: 0.0,
            temperature: 0.0,
            tint: 0.0,
            highlights: 0.0,
            shadows: 0.0,
        }
    }
}

impl ImageAdjustments {
    /// Phase 6: Check if any adjustments are applied
    pub fn has_adjustments(&self) -> bool {
        self.exposure != 0.0
            || self.contrast != 0.0
            || self.saturation != 0.0
            || self.temperature != 0.0
            || self.tint != 0.0
            || self.highlights != 0.0
            || self.shadows != 0.0
    }

    /// Phase 6: Reset all adjustments to default (no adjustments)
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Phase 6: Apply all adjustments to a color
    pub fn apply_to_color(&self, color: Color) -> Color {
        let rgba = color.to_rgba8();
        let mut r = rgba.r as f32 / 255.0;
        let mut g = rgba.g as f32 / 255.0;
        let mut b = rgba.b as f32 / 255.0;
        let a = rgba.a as f32 / 255.0;

        // Apply exposure (brightness)
        if self.exposure != 0.0 {
            let factor = 2.0f32.powf(self.exposure * 2.0); // -2 stops to +2 stops
            r *= factor;
            g *= factor;
            b *= factor;
        }

        // Apply contrast
        if self.contrast != 0.0 {
            let factor = 1.0 + self.contrast;
            r = (r - 0.5) * factor + 0.5;
            g = (g - 0.5) * factor + 0.5;
            b = (b - 0.5) * factor + 0.5;
        }

        // Apply saturation
        if self.saturation != 0.0 {
            let gray = 0.2989 * r + 0.5870 * g + 0.1140 * b;
            let factor = 1.0 + self.saturation;
            r = gray + (r - gray) * factor;
            g = gray + (g - gray) * factor;
            b = gray + (b - gray) * factor;
        }

        // Apply temperature (shift between blue and orange)
        if self.temperature != 0.0 {
            // Negative = cool (blue), Positive = warm (orange)
            r += self.temperature * 0.1;
            b -= self.temperature * 0.1;
        }

        // Apply tint (shift between green and magenta)
        if self.tint != 0.0 {
            // Negative = green, Positive = magenta
            g -= self.tint * 0.1;
            r += self.tint * 0.05;
            b += self.tint * 0.05;
        }

        // Convert to HSL for highlight/shadow adjustments
        let (h, s, l) = rgb_to_hsl(r, g, b);

        // Apply highlights (affect bright areas, l > 0.5)
        if self.highlights != 0.0 {
            let highlight_mask = (l - 0.5).max(0.0) * 2.0; // 0 to 1 for highlights
            let new_l = l + self.highlights * 0.3 * highlight_mask;
            let (new_r, new_g, new_b) = hsl_to_rgb(h, s, new_l.clamp(0.0, 1.0));
            r = new_r;
            g = new_g;
            b = new_b;
        }

        // Apply shadows (affect dark areas, l < 0.5)
        if self.shadows != 0.0 {
            let shadow_mask = (0.5 - l).max(0.0) * 2.0; // 0 to 1 for shadows
            let new_l = l + self.shadows * 0.3 * shadow_mask;
            let (new_r, new_g, new_b) = hsl_to_rgb(h, s, new_l.clamp(0.0, 1.0));
            r = new_r;
            g = new_g;
            b = new_b;
        }

        // Clamp values
        r = r.clamp(0.0, 1.0);
        g = g.clamp(0.0, 1.0);
        b = b.clamp(0.0, 1.0);

        Color::from_rgba8(
            (r * 255.0) as u8,
            (g * 255.0) as u8,
            (b * 255.0) as u8,
            (a * 255.0) as u8,
        )
    }

    /// Phase 6: Apply adjustments to an entire image (array of pixels)
    pub fn apply_to_image(&self, pixels: &mut [Color]) {
        if !self.has_adjustments() {
            return;
        }

        for pixel in pixels.iter_mut() {
            *pixel = self.apply_to_color(*pixel);
        }
    }
}

/// Phase 6: Convert RGB to HSL color space
fn rgb_to_hsl(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;

    if max == min {
        // Achromatic
        (0.0, 0.0, l)
    } else {
        let d = max - min;
        let s = if l > 0.5 {
            d / (2.0 - max - min)
        } else {
            d / (max + min)
        };

        let h = if max == r {
            (g - b) / d + (if g < b { 6.0 } else { 0.0 })
        } else if max == g {
            (b - r) / d + 2.0
        } else {
            (r - g) / d + 4.0
        };

        (h / 6.0, s, l)
    }
}

/// Phase 6: Convert HSL to RGB color space
fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (f32, f32, f32) {
    if s == 0.0 {
        // Achromatic
        (l, l, l)
    } else {
        let q = if l < 0.5 {
            l * (1.0 + s)
        } else {
            l + s - l * s
        };
        let p = 2.0 * l - q;

        let r = hue_to_rgb(p, q, h + 1.0 / 3.0);
        let g = hue_to_rgb(p, q, h);
        let b = hue_to_rgb(p, q, h - 1.0 / 3.0);

        (r, g, b)
    }
}

/// Phase 6: Helper function for HSL to RGB conversion
fn hue_to_rgb(p: f32, q: f32, mut t: f32) -> f32 {
    if t < 0.0 {
        t += 1.0;
    }
    if t > 1.0 {
        t -= 1.0;
    }

    if t < 1.0 / 6.0 {
        p + (q - p) * 6.0 * t
    } else if t < 1.0 / 2.0 {
        q
    } else if t < 2.0 / 3.0 {
        p + (q - p) * (2.0 / 3.0 - t) * 6.0
    } else {
        p
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_adjustments() {
        let adj = ImageAdjustments::default();
        assert!(!adj.has_adjustments());
        assert_eq!(adj.exposure, 0.0);
        assert_eq!(adj.contrast, 0.0);
    }

    #[test]
    fn test_exposure_adjustment() {
        let adj = ImageAdjustments {
            exposure: 1.0, // +2 stops
            ..Default::default()
        };

        let white = Color::from_rgb8(255, 255, 255);
        let adjusted = adj.apply_to_color(white);

        // White should stay white (clamped)
        let rgba = adjusted.to_rgba8();
        assert_eq!(rgba.r, 255);
        assert_eq!(rgba.g, 255);
        assert_eq!(rgba.b, 255);
    }

    #[test]
    fn test_saturation_adjustment() {
        let adj = ImageAdjustments {
            saturation: -1.0, // Fully desaturate
            ..Default::default()
        };

        let red = Color::from_rgb8(255, 0, 0);
        let adjusted = adj.apply_to_color(red);

        // Should be grayscale
        let rgba = adjusted.to_rgba8();
        assert_eq!(rgba.r, rgba.g);
        assert_eq!(rgba.g, rgba.b);
    }

    #[test]
    fn test_rgb_hsl_roundtrip() {
        let r = 0.5;
        let g = 0.3;
        let b = 0.7;

        let (h, s, l) = rgb_to_hsl(r, g, b);
        let (r2, g2, b2) = hsl_to_rgb(h, s, l);

        assert!((r - r2).abs() < 0.01);
        assert!((g - g2).abs() < 0.01);
        assert!((b - b2).abs() < 0.01);
    }

    #[test]
    fn test_has_adjustments() {
        let mut adj = ImageAdjustments::default();
        assert!(!adj.has_adjustments());

        adj.exposure = 0.5;
        assert!(adj.has_adjustments());

        adj.exposure = 0.0;
        adj.contrast = -0.3;
        assert!(adj.has_adjustments());
    }

    #[test]
    fn test_reset() {
        // `mut` stays: the point of the test is that reset() clears these.
        let mut adj = ImageAdjustments {
            exposure: 1.0,
            contrast: -0.5,
            saturation: 0.3,
            ..Default::default()
        };

        assert!(adj.has_adjustments());

        adj.reset();
        assert!(!adj.has_adjustments());
    }
}
