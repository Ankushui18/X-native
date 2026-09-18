//! Chrome painting primitives (Vello Scene) + the text renderer.
//!
//! All chrome text goes through `TextUi` (real Inter/system font shaping
//! via x-text); W/H/X/Y and hex values use the mono face, matching the
//! HTML's JetBrains Mono usage.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;
use vello::kurbo::{Affine, BezPath, Rect, RoundedRect, Stroke};
use vello::peniko::{Color, Fill};
use vello::Scene;
use x_native::text::{glyph_outlines, Align, FontManager, Span, TextBlockStyle};
use x_native::TextWrap;

use crate::theme::*;

// ------------------------------------------------------------- primitives

#[inline]
fn fill_rect_raw(s: &mut Scene, r: Rect, c: Color) {
    s.fill(Fill::NonZero, Affine::IDENTITY, c, None, &r);
}

/// Theme-mapped rect fill. Every chrome panel goes through here, so a
/// palette switch repaints the whole UI without touching a call site.
pub fn fill_rect(s: &mut Scene, r: Rect, c: Color) {
    fill_rect_raw(s, r, crate::theme::resolve(c));
}

pub fn fill_rrect(s: &mut Scene, r: Rect, radius: f64, c: Color) {
    let c = crate::theme::resolve(c);
    if radius <= 0.0 {
        fill_rect_raw(s, r, c);
        return;
    }
    let rr = RoundedRect::from_rect(r, radius);
    s.fill(Fill::NonZero, Affine::IDENTITY, c, None, &rr);
}

pub fn stroke_rect(s: &mut Scene, r: Rect, c: Color, w: f64) {
    // CSS borders render inside the border-box — inset the path by w/2 so
    // a 1px stroke covers the first pixel row crisply (Chromium parity),
    // instead of straddling the edge and washing out to half intensity.
    let h = w / 2.0;
    let ri = Rect::new(r.x0 + h, r.y0 + h, r.x1 - h, r.y1 - h);
    s.stroke(
        &Stroke::new(w),
        Affine::IDENTITY,
        crate::theme::resolve(c),
        None,
        &ri,
    );
}

pub fn stroke_rrect(s: &mut Scene, r: Rect, radius: f64, c: Color, w: f64) {
    let inset = w / 2.0;
    let rr = RoundedRect::new(
        r.x0 + inset,
        r.y0 + inset,
        r.x1 - inset,
        r.y1 - inset,
        (radius - inset).max(0.0),
    );
    s.stroke(
        &Stroke::new(w),
        Affine::IDENTITY,
        crate::theme::resolve(c),
        None,
        &rr,
    );
}

pub fn hline(s: &mut Scene, x0: f64, x1: f64, y: f64, c: Color) {
    let mut p = BezPath::new();
    p.move_to((x0, y + 0.5));
    p.line_to((x1, y + 0.5));
    s.stroke(
        &Stroke::new(1.0),
        Affine::IDENTITY,
        crate::theme::resolve(c),
        None,
        &p,
    );
}

pub fn vline(s: &mut Scene, x: f64, y0: f64, y1: f64, c: Color) {
    let mut p = BezPath::new();
    p.move_to((x + 0.5, y0));
    p.line_to((x + 0.5, y1));
    s.stroke(
        &Stroke::new(1.0),
        Affine::IDENTITY,
        crate::theme::resolve(c),
        None,
        &p,
    );
}

pub fn line(s: &mut Scene, x0: f64, y0: f64, x1: f64, y1: f64, c: Color, w: f64) {
    let mut p = BezPath::new();
    p.move_to((x0, y0));
    p.line_to((x1, y1));
    s.stroke(
        &Stroke::new(w),
        Affine::IDENTITY,
        crate::theme::resolve(c),
        None,
        &p,
    );
}

pub fn circle(s: &mut Scene, cx: f64, cy: f64, r: f64, c: Color) {
    let mut p = BezPath::new();
    p.move_to((cx + r, cy));
    p.curve_to(
        (cx + r, cy + r * 0.5523),
        (cx + r * 0.5523, cy + r),
        (cx, cy + r),
    );
    p.curve_to(
        (cx - r * 0.5523, cy + r),
        (cx - r, cy + r * 0.5523),
        (cx - r, cy),
    );
    p.curve_to(
        (cx - r, cy - r * 0.5523),
        (cx - r * 0.5523, cy - r),
        (cx, cy - r),
    );
    p.curve_to(
        (cx + r * 0.5523, cy - r),
        (cx + r, cy - r * 0.5523),
        (cx + r, cy),
    );
    p.close_path();
    s.fill(
        Fill::NonZero,
        Affine::IDENTITY,
        crate::theme::resolve(c),
        None,
        &p,
    );
}

pub fn ring(s: &mut Scene, cx: f64, cy: f64, r: f64, c: Color, w: f64) {
    let mut p = BezPath::new();
    p.move_to((cx + r, cy));
    p.curve_to(
        (cx + r, cy + r * 0.5523),
        (cx + r * 0.5523, cy + r),
        (cx, cy + r),
    );
    p.curve_to(
        (cx - r * 0.5523, cy + r),
        (cx - r, cy + r * 0.5523),
        (cx - r, cy),
    );
    p.curve_to(
        (cx - r, cy - r * 0.5523),
        (cx - r * 0.5523, cy - r),
        (cx, cy - r),
    );
    p.curve_to(
        (cx + r * 0.5523, cy - r),
        (cx + r, cy - r * 0.5523),
        (cx + r, cy),
    );
    p.close_path();
    s.stroke(
        &Stroke::new(w),
        Affine::IDENTITY,
        crate::theme::resolve(c),
        None,
        &p,
    );
}

/// Intent-driven drop shadow: twelve translucent shells expanding under
/// `r`, with weights normalised so the stack delivers the intent token's
/// alpha exactly ([`x_native::ui::Elevation::layers`]).
///
/// Call sites name the intent — `Raised` chrome, `Floating` menus,
/// `Overlay` prototype layers, `Modal` palettes — never a blur radius.
/// `Flat` paints nothing. Shadow black bypasses [`crate::theme::resolve`]
/// deliberately: it is light physics, not a palette role, and stays black
/// in every theme.
pub fn elev_shadow(s: &mut Scene, r: Rect, radius: f64, elev: x_native::ui::Elevation) {
    for (grow, alpha) in elev.layers() {
        if alpha == 0 {
            continue;
        }
        let c = Color::from_rgba8(0, 0, 0, alpha);
        let rr = RoundedRect::from_rect(r.inflate(grow, grow), radius + grow * 0.6);
        s.fill(Fill::NonZero, Affine::IDENTITY, c, None, &rr);
    }
}

// ------------------------------------------------------------------- text

/// Tailwind v3 preflight line-height ("normal" ⇒ 1.5 for these UI faces).
/// Every vertical placement in the ui/ HTML derives from it.
pub const CSS_LH: f64 = 1.5;

/// Top of a `size`-tall box centred in a `height`-tall row. The chrome's own
/// version of `align-items: center`: a row 20 tall with a 12px glyph starts
/// it at 4, a row 26 tall with a 16.5px line box at 4.75 — written as a call
/// rather than as the number, because a hand-computed centring offset is
/// exactly the kind of literal that drifts when the row height changes.
pub fn centre_in(size: f64, height: f64) -> f64 {
    (height - size) / 2.0
}

/// Top of a one-line text box of `size` (CSS line-height) centred in `r`.
pub fn line_top(r: Rect, size: f64) -> f64 {
    r.y0 + centre_in(size * CSS_LH, r.height())
}

/// Top of a `size`-tall glyph centred in `r` (an icon has no line box).
pub fn glyph_top(r: Rect, size: f64) -> f64 {
    r.y0 + centre_in(size, r.height())
}

/// Left of a `size`-wide glyph centred in `r`.
pub fn glyph_left(r: Rect, size: f64) -> f64 {
    r.x0 + centre_in(size, r.width())
}

/// Weight of a chrome label (Inter 400/500/600 per the HTML); `Mono`
/// routes to JetBrains Mono (W/H/X/Y values, hex codes, percentages).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Wt {
    Reg,
    Med,
    Semi,
    Bold,
    Mono,
}

#[derive(Hash, PartialEq, Eq)]
struct UiSpanKey {
    text: String,
    size: u64,
    color: [u32; 4],
    letter_spacing: u64,
    word_spacing: u64,
    font: Option<usize>,
    variations: Vec<(String, u32)>,
}
#[derive(Hash, PartialEq, Eq)]
struct UiTextKey {
    epoch: u64,
    font: usize,
    spans: Vec<UiSpanKey>,
}
#[derive(Default)]
struct UiTextCache {
    scenes: HashMap<UiTextKey, Arc<Scene>>,
    bytes: usize,
}

pub struct TextUi {
    pub fonts: FontManager,
    pub regular: usize,
    pub medium: usize,
    pub semibold: usize,
    pub bold: usize,
    pub mono: usize,
    width_cache: RefCell<HashMap<(String, u8, u64, u64), f64>>,
    text_scenes: RefCell<UiTextCache>,
}

impl TextUi {
    /// Load the bundled Inter 400/500/600/700 + JetBrains Mono 400 — the
    /// exact faces the ui/ HTML loads from Google Fonts — so advances,
    /// kerning and vertical metrics match the browser pixel for pixel.
    pub fn load() -> Self {
        let mut fonts = FontManager::new();
        let reg = fonts
            .load_face_bytes("Inter-400", crate::fonts::INTER_400.to_vec(), 0)
            .expect("bundled Inter 400");
        let med = fonts
            .load_face_bytes("Inter-500", crate::fonts::INTER_500.to_vec(), 0)
            .expect("bundled Inter 500");
        let semi = fonts
            .load_face_bytes("Inter-600", crate::fonts::INTER_600.to_vec(), 0)
            .expect("bundled Inter 600");
        let bold = fonts
            .load_face_bytes("Inter-700", crate::fonts::INTER_700.to_vec(), 0)
            .expect("bundled Inter 700");
        let mono = fonts
            .load_face_bytes("JetBrains Mono", crate::fonts::JBM_400.to_vec(), 0)
            .expect("bundled JetBrains Mono");
        let _ = fonts.load_system_fonts(); // fallback faces for doc content
        Self {
            fonts,
            regular: reg,
            medium: med,
            semibold: semi,
            bold,
            mono,
            width_cache: RefCell::new(HashMap::new()),
            text_scenes: Default::default(),
        }
    }

    /// True when at least one real font face is loaded.
    pub fn has_fonts(&self) -> bool {
        !self.fonts.fonts.is_empty()
    }

    pub fn face(&self, wt: Wt) -> usize {
        match wt {
            Wt::Reg => self.regular,
            Wt::Med => self.medium,
            Wt::Semi => self.semibold,
            Wt::Bold => self.bold,
            Wt::Mono => self.mono,
        }
    }

    /// CSS baseline offset for a line box of `size` px whose TOP is at 0,
    /// using the face's real hhea metrics — identical to what Chromium
    /// computes: content area = ascent − descent (descent is NEGATIVE in
    /// ttf-parser), half-leading = (1.5em − content)/2, baseline from top
    /// = half-leading + ascent = 0.75em + (ascent + descent)/2.
    pub fn css_baseline(&self, font: usize, size: f64) -> f64 {
        let f = &self.fonts.fonts[font];
        let k = size / f.units_per_em;
        0.75 * size + 0.5 * (f.ascent + f.descent) * k
    }

    /// Width of `text` at `size` (shaped, cached) — used for centering and
    /// truncation so chrome text layout matches the HTML measurements.
    pub fn measure(&self, text: &str, size: f64, wt: Wt) -> f64 {
        if !self.has_fonts() {
            return text.len() as f64 * size * 0.58;
        }
        let key = (
            text.to_string(),
            wt as u8,
            size.to_bits(),
            self.fonts.epoch(),
        );
        if let Some(w) = self.width_cache.borrow().get(&key) {
            return *w;
        }
        let font = self.face(wt);
        let w = Self::width_uncached(&self.fonts, text, size, font);
        let mut cache = self.width_cache.borrow_mut();
        if cache.len() >= 4096 {
            cache.clear();
        }
        cache.insert(key, w);
        w
    }

    /// Width of a letter-spaced run: CSS letter-spacing adds `em*size`
    /// after EVERY character (including the last), but the trailing space
    /// doesn't affect left-aligned drawing, so subtract only what matters
    /// for width: n * spacing.
    pub fn measure_tracked(&self, text: &str, size: f64, spacing_em: f64, wt: Wt) -> f64 {
        self.measure(text, size, wt) + text.chars().count() as f64 * size * spacing_em
    }

    fn width_uncached(fonts: &FontManager, text: &str, size: f64, font: usize) -> f64 {
        // shaped ADVANCE sum (kerning included). The old bbox-max approach
        // returned 0 for whitespace (spaces have no outline), which made
        // per-char layout — the inline editor's caret grid — squash words
        // together.
        let (_, w) = fonts.shape(text, font, size);
        w
    }

    /// Truncate to fit `max_w`, appending an ellipsis like CSS `truncate`.
    pub fn truncate(&self, text: &str, size: f64, wt: Wt, max_w: f64) -> String {
        if self.measure(text, size, wt) <= max_w {
            return text.to_string();
        }
        let mut t: String = text.chars().take(64).collect();
        while t.len() > 1 && self.measure(&format!("{t}…"), size, wt) > max_w {
            t.pop();
        }
        format!("{t}…")
    }

    /// Draw a single-line run with its CSS line box TOP-LEFT at (x, y):
    /// identical to Chromium placing an inline box at that point with the
    /// Tailwind default line-height (1.5). Every chrome call site passes
    /// box tops measured from the ui/ HTML.
    #[allow(clippy::too_many_arguments)]
    pub fn text(&self, s: &mut Scene, x: f64, y: f64, text: &str, size: f64, color: Color, wt: Wt) {
        if !self.has_fonts() {
            return;
        }
        let font = self.face(wt);
        let spans = [Span::new(text, size).color(color).font(font)];
        self.draw_spans(s, &spans, font, x, y);
    }

    fn draw_spans(&self, s: &mut Scene, spans: &[Span], font: usize, x: f64, y: f64) {
        let max_size = spans.iter().map(|sp| sp.size).fold(0.0f64, f64::max);
        // glyphs come out of the shaper baseline-relative; put the baseline
        // where Chromium would for a line box starting at `y`
        let baseline = y + self.css_baseline(font, max_size);
        self.draw_spans_baseline(s, spans, font, x, baseline);
    }

    /// Draw spans with the BASELINE at `y_baseline` (the shaper's own
    /// internal offset — ascent × 1.2, see glyph_outlines — is subtracted
    /// so the net placement is exactly the CSS baseline).
    fn draw_spans_baseline(
        &self,
        s: &mut Scene,
        spans: &[Span],
        font: usize,
        x: f64,
        y_baseline: f64,
    ) {
        // Theme-mapped text. Tinting happens BEFORE the cache key is built
        // so themed and untitled scenes can never collide in `text_scenes`.
        let tinted = crate::theme::tint_spans(spans);
        let spans = tinted.as_deref().unwrap_or(spans);
        let f = &self.fonts.fonts[font];
        // glyph_outlines offsets the first baseline by
        // ascent × clamp(line_height, 1.0, 1.2) of max(span sizes, **12.0**)
        // — its fold seeds at 12px, so sub-12px runs are placed with 12px
        // metrics. Mirror that floor here or small labels land low by
        // 1.2 × ascent × (12 − size)/em.
        let max_size = spans.iter().map(|sp| sp.size).fold(12.0f64, f64::max);
        let internal = 1.2 * f.ascent * (max_size / f.units_per_em);
        let ty = y_baseline - internal;
        let style = TextBlockStyle {
            max_width: 100_000.0,
            line_height: 1.5,
            align: Align::Left,
            wrap: TextWrap::Auto,
            ..Default::default()
        };
        let key = UiTextKey {
            epoch: self.fonts.epoch(),
            font,
            spans: spans
                .iter()
                .map(|sp| UiSpanKey {
                    text: sp.text.clone(),
                    size: sp.size.to_bits(),
                    color: sp.color.components.map(f32::to_bits),
                    letter_spacing: sp.letter_spacing.to_bits(),
                    word_spacing: sp.word_spacing.to_bits(),
                    font: sp.font,
                    variations: sp
                        .variations
                        .iter()
                        .map(|(tag, value)| (tag.clone(), value.to_bits()))
                        .collect(),
                })
                .collect(),
        };
        if let Some(scene) = self.text_scenes.borrow().scenes.get(&key) {
            s.append(scene, Some(Affine::translate((x, ty))));
            return;
        }
        let (glyphs, _) = glyph_outlines(&self.fonts, spans, font, &style);
        let mut scene = Scene::new();
        for g in glyphs {
            scene.fill(Fill::NonZero, g.transform, g.color, None, &g.path);
        }
        let encoding = scene.encoding();
        let bytes = encoding.path_data.len()
            + encoding.draw_data.len()
            + encoding.path_tags.len()
            + encoding.transforms.len() * 24
            + encoding.styles.len() * 32
            + key.spans.iter().map(|s| s.text.len() + 128).sum::<usize>();
        s.append(&scene, Some(Affine::translate((x, ty))));
        if bytes <= 16 * 1024 * 1024 {
            let mut cache = self.text_scenes.borrow_mut();
            if cache.scenes.len() >= 2048 || cache.bytes.saturating_add(bytes) > 16 * 1024 * 1024 {
                cache.scenes.clear();
                cache.bytes = 0;
            }
            cache.bytes += bytes;
            cache.scenes.insert(key, Arc::new(scene));
        }
    }

    /// Draw a single run with its BASELINE at `y_baseline` — renderer-
    /// aligned document text (the doc scene uses the face ascent, not a
    /// CSS line box). Font is an explicit face index.
    #[allow(clippy::too_many_arguments)]
    pub fn text_at_baseline(
        &self,
        s: &mut Scene,
        x: f64,
        y_baseline: f64,
        text: &str,
        size: f64,
        color: Color,
        font: usize,
    ) {
        if !self.has_fonts() {
            return;
        }
        let spans = [Span::new(text, size).color(color).font(font)];
        self.draw_spans_baseline(s, &spans, font, x, y_baseline);
    }

    /// Draw with letter-spacing in px (e.g. 10px * 0.12em tracked labels).
    #[allow(clippy::too_many_arguments)]
    pub fn text_tracked(
        &self,
        s: &mut Scene,
        x: f64,
        y: f64,
        text: &str,
        size: f64,
        spacing_em: f64,
        color: Color,
        wt: Wt,
    ) {
        let font = self.face(wt);
        let spans = [Span::new(text, size)
            .color(color)
            .font(font)
            .letter_spacing(size * spacing_em)];
        let baseline = y + self.css_baseline(font, size);
        self.draw_spans_baseline(s, &spans, font, x, baseline);
    }

    /// Micro label: dim section eyebrows (`DRAFTS`, `PAGES`, `FONTS`) —
    /// T10 tracked 0.12em. One of the two tracked steps; the other is
    /// [`TextUi::caps_label`].
    pub fn micro_label(&self, s: &mut Scene, x: f64, y: f64, text: &str, color: Color, wt: Wt) {
        self.text_tracked(s, x, y, text, T10, 0.12, color, wt);
    }

    /// Caps label: panel section headings (`Appearance`, `PROTOTYPE`) —
    /// T10 tracked 0.08em. Pairs with [`TextUi::micro_label`]; together
    /// they are the only tracked steps in the UI.
    pub fn caps_label(&self, s: &mut Scene, x: f64, y: f64, text: &str, color: Color, wt: Wt) {
        self.text_tracked(s, x, y, text, T10, 0.08, color, wt);
    }

    /// Draw text centered in `r` horizontally (and optionally vertically).
    #[allow(clippy::too_many_arguments)]
    pub fn text_center(
        &self,
        s: &mut Scene,
        r: Rect,
        text: &str,
        size: f64,
        color: Color,
        wt: Wt,
        vcenter: bool,
    ) {
        let w = self.measure(text, size, wt);
        let tx = (r.x0 + r.x1 - w) / 2.0;
        // center the 1.5em line box, like flex align-items:center
        let th = size * CSS_LH;
        let ty = if vcenter {
            (r.y0 + r.y1 - th) / 2.0
        } else {
            r.y0
        };
        self.text(s, tx, ty, text, size, color, wt);
    }

    /// Draw text right-aligned inside `r` (with optional right padding).
    #[allow(clippy::too_many_arguments)]
    pub fn text_right(
        &self,
        s: &mut Scene,
        x1: f64,
        y: f64,
        text: &str,
        size: f64,
        color: Color,
        wt: Wt,
        pad: f64,
    ) {
        let w = self.measure(text, size, wt);
        self.text(s, x1 - pad - w, y, text, size, color, wt);
    }

    /// Avatar bubble: filled circle + centered initial (S per the HTML).
    /// `size` is the initial's font size — a Tailwind class per instance in
    /// the HTML (12px in the 32px dashboard avatar, 10px in the 20px member
    /// bubbles, 11px in the editor's 24px one) so it can't be derived.
    /// Centers the CAP height (uppercase initials have no descender) —
    /// the same optical centering flexbox produces visually.
    #[allow(clippy::too_many_arguments)]
    pub fn avatar(
        &self,
        s: &mut Scene,
        cx: f64,
        cy: f64,
        r: f64,
        bg: Color,
        size: f64,
        initial: &str,
    ) {
        circle(s, cx, cy, r, bg);
        let font = self.face(Wt::Bold);
        let w = self.measure(initial, size, Wt::Bold);
        let cap = self.cap_height(font, size);
        let baseline = cy + cap / 2.0;
        let spans = [Span::new(initial, size).color(C_BLACK).font(font)];
        self.draw_spans_baseline(s, &spans, font, cx - w / 2.0, baseline);
    }

    /// Cap height in px (OS/2 sCapHeight; falls back to 0.72em — Inter's
    /// real ratio is 0.727).
    pub fn cap_height(&self, font: usize, size: f64) -> f64 {
        let f = &self.fonts.fonts[font];
        let k = size / f.units_per_em;
        let cap = if f.cap_height > 0.0 {
            f.cap_height
        } else {
            0.72 * f.units_per_em
        };
        cap * k
    }

    /// Team badge: rounded square + centered letter.
    ///
    /// The letter is [`C_BLACK`], like [`TextUi::avatar`]'s initial: badges sit
    /// on the saturated team hues (#5B7CFF blue, #FF7A45 orange), where light
    /// text measures 3.0:1 and 2.1:1 — both under the WCAG-AA 4.5:1 floor for
    /// text this small. Black clears them (5.8:1 / 8.1:1).
    #[allow(clippy::too_many_arguments)]
    pub fn badge(
        &self,
        s: &mut Scene,
        x: f64,
        y: f64,
        size: f64,
        radius: f64,
        bg: Color,
        ch: &str,
    ) {
        fill_rrect(s, Rect::new(x, y, x + size, y + size), radius, bg);
        let fs = size * 0.55;
        let font = self.face(Wt::Bold);
        let w = self.measure(ch, fs, Wt::Bold);
        let cap = self.cap_height(font, fs);
        let baseline = y + (size + cap) / 2.0;
        let spans = [Span::new(ch, fs).color(C_BLACK).font(font)];
        self.draw_spans_baseline(s, &spans, font, x + (size - w) / 2.0, baseline);
    }
}

/// 28x28 logo + "X-Native" wordmark used on both screens.
pub fn logo_and_name(t: &mut TextUi, s: &mut Scene, x: f64, y: f64, with_name: bool) {
    crate::icons::draw_logo(s, x, y, LOGO);
    if with_name {
        // tracking-tight (-0.025em) per the HTML wordmark span; the wordmark
        // is flex-centered against the same 40px bar as the logo
        t.text_tracked(
            s,
            x + LOGO + 12.0,
            y + (LOGO - T14 * CSS_LH) / 2.0,
            "X-Native",
            T14,
            -0.025,
            C_TEXT,
            Wt::Semi,
        );
    }
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    #[test]
    fn text_scene_cache_reuses_geometry_but_distinguishes_style_and_size() {
        let ui = TextUi::load();
        let mut scene = Scene::new();
        ui.text(&mut scene, 0.0, 0.0, "cached", 12.0, Color::BLACK, Wt::Reg);
        let count = ui.text_scenes.borrow().scenes.len();
        ui.text(
            &mut scene,
            50.0,
            90.0,
            "cached",
            12.0,
            Color::BLACK,
            Wt::Reg,
        );
        assert_eq!(ui.text_scenes.borrow().scenes.len(), count);
        ui.text(&mut scene, 0.0, 0.0, "cached", 12.0, Color::WHITE, Wt::Reg);
        ui.text(&mut scene, 0.0, 0.0, "cached", 12.01, Color::BLACK, Wt::Reg);
        assert_eq!(ui.text_scenes.borrow().scenes.len(), count + 2);
        assert_ne!(
            ui.measure("cached", 12.0, Wt::Reg),
            ui.measure("cached", 12.01, Wt::Reg)
        );
    }
}

#[cfg(test)]
mod centring_tests {
    use super::*;

    /// The chrome's rows put text and glyphs on a common centre line by
    /// arithmetic, not by hand. These are the numbers the left rail paints at
    /// (the LAYERS tree row and a 26px page row), pinned here so a change to
    /// the helpers cannot silently shift the panel: the placement helpers and
    /// the rows they place into have to be checked together.
    #[test]
    fn a_glyph_and_a_label_share_the_row_middle() {
        let row = Rect::new(0.0, 10.0, 100.0, 10.0 + 22.0); // tree row
        // a 12px glyph in a 22px row starts 5px in, not on the top edge
        assert_eq!(glyph_top(row, ICON_XS), 15.0);
        // an 11px label carries a 16.5px line box (CSS preflight), so its top
        // is 2.75px into the row — the number the tree rows paint at
        assert_eq!(T11 * CSS_LH, 16.5);
        assert_eq!(line_top(row, T11), 12.75);
        // both boxes are centred on the same line
        assert_eq!(
            glyph_top(row, ICON_XS) + ICON_XS / 2.0,
            line_top(row, T11) + T11 * CSS_LH / 2.0
        );
    }

    #[test]
    fn a_glyph_centres_in_its_own_button_and_in_the_row_it_sits_in() {
        // the 14×18 hover button beside a layer row: a 12px glyph is 1 in
        // from the left and 3 down from the button top
        let chip = Rect::new(0.0, 10.0, 14.0, 10.0 + 18.0);
        assert_eq!(glyph_left(chip, ICON_XS), 1.0);
        assert_eq!(glyph_top(chip, ICON_XS), 13.0);
        // an 18px thumbnail box centred in a 26px page row, with a 12px page
        // glyph centred inside it — 7px from the row top
        let row = Rect::new(0.0, 10.0, 120.0, 10.0 + 26.0);
        let thumb_top = row.y0 + centre_in(18.0, row.height());
        assert_eq!(thumb_top, 14.0);
        assert_eq!(thumb_top + centre_in(ICON_XS, 18.0), 17.0);
        assert_eq!(thumb_top + centre_in(ICON_XS, 18.0) - row.y0, 7.0);
    }
}
