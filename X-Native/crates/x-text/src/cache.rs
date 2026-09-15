//! ShapedTextCache — the review's #1 optimization target.
//!
//! Shaping (rustybuzz + BiDi + fallback + wrapping) ran per Glyphs
//! command per frame; in the mixed benchmark that made encode dominate
//! (10k = 138ms). This cache memoizes the ENTIRE shaped block:
//!
//!   TextNode → TextLayoutKey → ShapedTextCache → { glyph runs,
//!   positions, fallback decisions, metrics } → render
//!
//! Key contract (review): everything that changes shaping is in the key —
//! font binding (family+weight+style resolved through the fallback chain),
//! size, letter spacing, line height, text content, width constraint,
//! direction/script (implicit in content), features (via font binding).
//! NOT in the key: node position — output glyphs are BLOCK-LOCAL and the
//! world transform composes outside, so moving text is a cache HIT by
//! construction.
//!
//! Invalidation: content/font/size/width changes make a different key
//! (natural miss). `epoch` bumps flush everything (font hot-reload).
//! Entries are Arc'd: hits clone a pointer, not glyph vectors.

use crate::font::FontManager;
use crate::shaping::{
    node_text_outlines_rich_uncached, node_text_outlines_styled_uncached, OutlineGlyph,
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use vello::peniko::Color;

// ------------------------------------------------------------------- key

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TextLayoutKey {
    pub text: String,
    /// resolved font binding ("Inter 700" / None=default) — carries
    /// family+weight+style+features; fallback decisions depend on it
    pub font: Option<String>,
    /// f64 bits: exact size/width/spacing keys without float-Eq issues
    pub size_bits: u64,
    pub max_width_bits: u64,
    pub letter_spacing_bits: u64,
    pub line_height_bits: u64,
    /// Figma LH mode (0 auto / 1 px / 2 %): same multiplier, different
    /// first-baseline model — must not collide in the cache
    pub lh_mode: u8,
    pub word_spacing_bits: u64,
    pub paragraph_spacing_bits: u64,
    pub baseline_shift_bits: u64,
    pub small_caps: bool,
    pub optical_size_bits: u64,
    pub width_axis_bits: u64,
    /// color is NOT shaping-relevant but is baked into OutlineGlyph;
    /// keying it keeps entries correct at negligible cost
    pub color: [u8; 4],
    /// FontManager generation: font loads/unloads flush stale entries
    pub font_epoch: u64,
    /// rich-text runs (empty = plain single-style text; keeps the plain
    /// path byte-identical in both key construction and cache behavior)
    pub runs: Vec<RichRunKey>,
    /// paragraph wrap mode (x_core::TextWrap as u8): Balance/Pretty
    /// change line breaking, so layouts must not be served cross-mode
    pub wrap: u8,
    /// x_text::Align as u8 (Left/Center/Right/Justify): placement is part
    /// of the shaped block, so it must not be served cross-alignment
    pub align: u8,
    /// decoration bits (0 none / 1 underline / 2 strike / 3 both):
    /// decorations are REAL geometry in the block — sinks draw the glyph
    /// list alone, so anything painted has to be keyed
    pub decoration: u8,
    /// the node's paragraph-breaking properties (indent, lists,
    /// truncation, max lines, word break, vertical trim); None = all
    /// defaults, which keeps legacy keys byte-identical
    pub layout: Option<crate::shaping::TextLayout>,
}

/// One styled run inside a rich-text layout key (see TextLayoutKey::runs).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RichRunKey {
    pub text: String,
    /// None = unstyled run (transparent marker at shape time; sinks paint
    /// these with the command brush so gradient text fills keep gradients)
    pub color: Option<[u8; 4]>,
    pub size_bits: Option<u64>,
    pub font: Option<String>,
    /// Per-run letter-spacing (None = the base `ls`).
    pub ls_bits: Option<u64>,
    /// Per-run weight (None = the base family default) — resolves a
    /// different face, so it must not be served cross-key.
    pub weight: Option<u16>,
}

impl TextLayoutKey {
    pub fn new(
        text: &str,
        size: f64,
        max_width: f64,
        font: Option<&str>,
        color: Color,
        font_epoch: u64,
    ) -> Self {
        Self::new_styled(
            text,
            size,
            max_width,
            font,
            color,
            font_epoch,
            0.0,
            1.2,
            x_core::TextWrap::Auto,
            0.0,
            0.0,
            0.0,
            false,
            0.0,
            0.0,
            0,
        )
    }

    /// Typography-aware key (letter spacing px, line height multiplier).
    #[allow(clippy::too_many_arguments)] // positional params are the natural shape here; grouping would obscure the algorithm
    pub fn new_styled(
        text: &str,
        size: f64,
        max_width: f64,
        font: Option<&str>,
        color: Color,
        font_epoch: u64,
        ls: f64,
        lh: f64,
        wrap: x_core::TextWrap,
        word_spacing: f64,
        paragraph_spacing: f64,
        baseline_shift: f64,
        small_caps: bool,
        optical_size: f32,
        width_axis: f32,
        lh_mode: u8,
    ) -> Self {
        Self {
            text: text.to_string(),
            font: font.map(str::to_string),
            size_bits: size.to_bits(),
            max_width_bits: max_width.to_bits(),
            letter_spacing_bits: ls.to_bits(),
            line_height_bits: lh.to_bits(),
            lh_mode,
            word_spacing_bits: word_spacing.to_bits(),
            paragraph_spacing_bits: paragraph_spacing.to_bits(),
            baseline_shift_bits: baseline_shift.to_bits(),
            small_caps,
            optical_size_bits: optical_size.to_bits() as u64,
            width_axis_bits: width_axis.to_bits() as u64,
            wrap: wrap as u8,
            color: {
                let rgba = color.to_rgba8();
                [rgba.r, rgba.g, rgba.b, rgba.a]
            },
            font_epoch,
            runs: vec![],
            align: 0,
            decoration: 0,
            layout: None,
        }
    }

    /// Attach the node's canonical text-layout properties (alignment,
    /// decoration, paragraph-breaking). Default values leave the key
    /// byte-identical to the 16-arg constructor — old callers and old
    /// files keep their cache behavior.
    pub fn with_text_layout(
        mut self,
        align: u8,
        decoration: u8,
        layout: &crate::shaping::TextLayout,
    ) -> Self {
        self.align = align;
        self.decoration = decoration;
        self.layout = if layout.is_identity() {
            None
        } else {
            Some(*layout)
        };
        self
    }

    /// Key from a full style struct (the sink-side parity path): every
    /// field that changes shaping comes from ONE place, so exports cannot
    /// drift from the canvas.
    pub fn from_style(
        text: &str,
        size: f64,
        max_width: f64,
        font: Option<&str>,
        color: vello::peniko::Color,
        font_epoch: u64,
        style: &crate::shaping::TextBlockStyle,
        ls: f64,
        word_spacing: f64,
    ) -> Self {
        Self {
            text: text.to_string(),
            font: font.map(str::to_string),
            size_bits: size.to_bits(),
            max_width_bits: max_width.to_bits(),
            letter_spacing_bits: ls.to_bits(),
            line_height_bits: style.line_height.to_bits(),
            lh_mode: style.lh_mode,
            word_spacing_bits: word_spacing.to_bits(),
            paragraph_spacing_bits: style.paragraph_spacing.to_bits(),
            baseline_shift_bits: style.baseline_shift.to_bits(),
            small_caps: style.small_caps,
            optical_size_bits: style.optical_size.to_bits() as u64,
            width_axis_bits: style.width_axis.to_bits() as u64,
            wrap: style.wrap as u8,
            align: style.align as u8,
            decoration: style.decoration,
            layout: if style.layout.is_identity() {
                None
            } else {
                Some(style.layout)
            },
            color: {
                let rgba = color.to_rgba8();
                [rgba.r, rgba.g, rgba.b, rgba.a]
            },
            font_epoch,
            runs: vec![],
        }
    }

    /// Rich-run key: styled sub-ranges over a base style. Parts come from
    /// `x_core::resolve_text_parts`; per-run colors are FINAL (opacity
    /// already folded by the renderer).
    #[allow(clippy::too_many_arguments)]
    pub fn new_rich(
        parts: &[x_core::TextPart],
        base_size: f64,
        max_width: f64,
        base_font: Option<&str>,
        font_epoch: u64,
        ls: f64,
        lh: f64,
        wrap: x_core::TextWrap,
        word_spacing: f64,
        paragraph_spacing: f64,
        baseline_shift: f64,
        small_caps: bool,
        optical_size: f32,
        width_axis: f32,
        lh_mode: u8,
    ) -> Self {
        let mut k = Self::new_styled(
            &parts.iter().map(|p| p.text.as_str()).collect::<String>(),
            base_size,
            max_width,
            base_font,
            Color::TRANSPARENT,
            font_epoch,
            ls,
            lh,
            wrap,
            word_spacing,
            paragraph_spacing,
            baseline_shift,
            small_caps,
            optical_size,
            width_axis,
            lh_mode,
        );
        k.runs = parts
            .iter()
            .map(|p| RichRunKey {
                text: p.text.clone(),
                color: p.color.map(|c| {
                    let rgba = c.to_rgba8();
                    [rgba.r, rgba.g, rgba.b, rgba.a]
                }),
                size_bits: p.size.map(f64::to_bits),
                font: p.font.clone(),
                ls_bits: p.ls.map(f64::to_bits),
                weight: p.weight,
            })
            .collect();
        k
    }
}

// ----------------------------------------------------------------- entry

/// The memoized shaped block: glyph runs, positions (block-local
/// transforms), fallback decisions (baked into the outlines), metrics.
pub struct ShapedBlock {
    pub glyphs: Vec<OutlineGlyph>,
    pub height: f64,
}

// ----------------------------------------------------------------- cache

#[derive(Default)]
pub struct ShapedTextCache {
    map: Mutex<HashMap<TextLayoutKey, Arc<ShapedBlock>>>,
    pub hits: std::sync::atomic::AtomicU64,
    pub misses: std::sync::atomic::AtomicU64,
    /// approximate resident bytes + budget-eviction count
    pub bytes: std::sync::atomic::AtomicUsize,
    pub evictions: std::sync::atomic::AtomicU64,
}

/// rough per-block footprint: path elements dominate
fn block_bytes(b: &ShapedBlock) -> usize {
    b.glyphs
        .iter()
        .map(|g| g.path.elements().len() * 48 + 96)
        .sum::<usize>()
        + 64
}

const MAX_ENTRIES: usize = 4096;
/// byte budget for cached glyph outlines (~paths dominate);
/// exceeding either bound triggers eviction
const MAX_BYTES: usize = 64 * 1024 * 1024;

/// u8 -> Align for cache-miss rebuilds (variants are ordered, so a
/// numeric round-trip is exact; anything unknown is Left).
fn align_of(v: u8) -> crate::shaping::Align {
    match v {
        1 => crate::shaping::Align::Center,
        2 => crate::shaping::Align::Right,
        3 => crate::shaping::Align::Justify,
        _ => crate::shaping::Align::Left,
    }
}

impl ShapedTextCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Global process cache (sinks are stateless; the cache is shared).
    pub fn global() -> &'static ShapedTextCache {
        static G: OnceLock<ShapedTextCache> = OnceLock::new();
        G.get_or_init(ShapedTextCache::new)
    }

    pub fn get_or_shape(
        &self,
        fonts: &FontManager,
        key: TextLayoutKey,
    ) -> Option<Arc<ShapedBlock>> {
        use std::sync::atomic::Ordering::Relaxed;
        if let Some(hit) = self.map.lock().ok()?.get(&key).cloned() {
            self.hits.fetch_add(1, Relaxed);
            return Some(hit);
        }
        self.misses.fetch_add(1, Relaxed);
        let size = f64::from_bits(key.size_bits);
        let max_width = f64::from_bits(key.max_width_bits);
        let color = Color::from_rgba8(key.color[0], key.color[1], key.color[2], key.color[3]);
        let ls = f64::from_bits(key.letter_spacing_bits);
        let lh = f64::from_bits(key.line_height_bits);
        let ws = f64::from_bits(key.word_spacing_bits);
        let ps = f64::from_bits(key.paragraph_spacing_bits);
        let bs = f64::from_bits(key.baseline_shift_bits);
        let sc = key.small_caps;
        let opsz = f32::from_bits(key.optical_size_bits as u32);
        let wdth = f32::from_bits(key.width_axis_bits as u32);
        let (glyphs, height) = if key.runs.is_empty() {
            let wrap = match key.wrap {
                1 => x_core::TextWrap::Balance,
                2 => x_core::TextWrap::Pretty,
                _ => x_core::TextWrap::Auto,
            };
            node_text_outlines_styled_uncached(
                fonts,
                &key.text,
                size,
                max_width,
                key.font.as_deref(),
                color,
                ls,
                lh,
                wrap,
                ws,
                ps,
                bs,
                sc,
                opsz,
                wdth,
                key.lh_mode,
                align_of(key.align),
                key.decoration,
                key.layout.unwrap_or_default(),
            )?
        } else {
            // rich path: rebuild the parts from the key (the cache only
            // shapes what the key fully describes — same contract as text)
            let parts: Vec<x_core::TextPart> = key
                .runs
                .iter()
                .map(|r| x_core::TextPart {
                    text: r.text.clone(),
                    color: r.color.map(|c| Color::from_rgba8(c[0], c[1], c[2], c[3])),
                    size: r.size_bits.map(f64::from_bits),
                    font: r.font.clone(),
                    // weight resolves to a registered face (e.g. Inter-600);
                    // italic shapes through the font NAME
                    weight: r.weight,
                    italic: None,
                    ls: r.ls_bits.map(f64::from_bits),
                })
                .collect();
            let wrap = match key.wrap {
                1 => x_core::TextWrap::Balance,
                2 => x_core::TextWrap::Pretty,
                _ => x_core::TextWrap::Auto,
            };
            node_text_outlines_rich_uncached(
                fonts,
                &parts,
                size,
                max_width,
                key.font.as_deref(),
                ls,
                lh,
                wrap,
                ws,
                ps,
                bs,
                sc,
                opsz,
                wdth,
                key.lh_mode,
                align_of(key.align),
                key.decoration,
                &key.layout.unwrap_or_default(),
            )?
        };
        let block = Arc::new(ShapedBlock { glyphs, height });
        let mut map = self.map.lock().ok()?;
        // budget enforcement: entry count OR approximate byte size
        if map.len() >= MAX_ENTRIES
            || self.bytes.load(std::sync::atomic::Ordering::Relaxed) >= MAX_BYTES
        {
            map.clear();
            self.bytes.store(0, std::sync::atomic::Ordering::Relaxed);
            self.evictions
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        self.bytes
            .fetch_add(block_bytes(&block), std::sync::atomic::Ordering::Relaxed);
        map.insert(key, block.clone());
        Some(block)
    }

    pub fn len(&self) -> usize {
        self.map.lock().map(|m| m.len()).unwrap_or(0)
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn clear(&self) {
        if let Ok(mut m) = self.map.lock() {
            m.clear();
        }
        self.bytes.store(0, std::sync::atomic::Ordering::Relaxed);
    }
    pub fn stats(&self) -> (u64, u64) {
        use std::sync::atomic::Ordering::Relaxed;
        (self.hits.load(Relaxed), self.misses.load(Relaxed))
    }
    /// (approx resident bytes, budget evictions)
    pub fn memory(&self) -> (usize, u64) {
        use std::sync::atomic::Ordering::Relaxed;
        (self.bytes.load(Relaxed), self.evictions.load(Relaxed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fonts() -> FontManager {
        let mut fm = FontManager::new();
        assert!(fm.load_system_fonts() > 0);
        fm
    }

    fn key(text: &str, size: f64, width: f64, font: Option<&str>) -> TextLayoutKey {
        TextLayoutKey::new(text, size, width, font, Color::BLACK, 0)
    }

    #[test]
    fn rich_cache_keys_separate_styled_runs() {
        let styled = vec![x_core::TextPart {
            text: "ab".into(),
            color: Some(Color::from_rgb8(255, 0, 0)),
            size: None,
            font: None,
            weight: None,
            italic: None,
            ls: None,
        }];
        let plain = vec![x_core::TextPart {
            text: "ab".into(),
            color: None,
            size: None,
            font: None,
            weight: None,
            italic: None,
            ls: None,
        }];
        let k1 = TextLayoutKey::new_rich(
            &styled,
            16.0,
            200.0,
            None,
            0,
            0.0,
            1.2,
            x_core::TextWrap::Auto,
            0.0,
            0.0,
            0.0,
            false,
            0.0,
            0.0,
            0,
        );
        let k2 = TextLayoutKey::new_rich(
            &plain,
            16.0,
            200.0,
            None,
            0,
            0.0,
            1.2,
            x_core::TextWrap::Auto,
            0.0,
            0.0,
            0.0,
            false,
            0.0,
            0.0,
            0,
        );
        assert_ne!(k1, k2, "styled vs plain keys differ");
        assert_eq!(
            k1,
            TextLayoutKey::new_rich(
                &styled,
                16.0,
                200.0,
                None,
                0,
                0.0,
                1.2,
                x_core::TextWrap::Auto,
                0.0,
                0.0,
                0.0,
                false,
                0.0,
                0.0,
                0,
                0,
                &TextLayout::default()
            ),
            "same runs -> same key"
        );
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let h = |k: &TextLayoutKey| {
            let mut s = DefaultHasher::new();
            k.hash(&mut s);
            s.finish()
        };
        assert_ne!(h(&k1), h(&k2), "hash separates run styling");
        // empty runs == plain: rich key with no runs equals a plain-shape key? (distinct branch, but stable)
        assert_eq!(
            h(&k2),
            h(&TextLayoutKey::new_rich(
                &plain,
                16.0,
                200.0,
                None,
                0,
                0.0,
                1.2,
                x_core::TextWrap::Auto,
                0.0,
                0.0,
                0.0,
                false,
                0.0,
                0.0,
                0,
                0,
                &TextLayout::default()
            ))
        );
    }

    #[test]
    fn rich_runs_shape_and_cache_hits() {
        let fm = fonts();
        let c = ShapedTextCache::new();
        let parts = vec![
            x_core::TextPart {
                text: "BIG".into(),
                color: Some(Color::from_rgb8(255, 0, 0)),
                size: Some(40.0),
                font: None,
                weight: None,
                italic: None,
                ls: None,
            },
            x_core::TextPart {
                text: " small".into(),
                color: None,
                size: None,
                font: None,
                weight: None,
                italic: None,
                ls: None,
            },
        ];
        let k = TextLayoutKey::new_rich(
            &parts,
            16.0,
            400.0,
            None,
            fm.epoch(),
            0.0,
            1.2,
            x_core::TextWrap::Auto,
            0.0,
            0.0,
            0.0,
            false,
            0.0,
            0.0,
            0,
        );
        let a = c.get_or_shape(&fm, k.clone()).expect("rich shapes");
        let b = c.get_or_shape(&fm, k).expect("second hit");
        assert!(Arc::ptr_eq(&a, &b), "same rich key -> same Arc, no reshape");
    }

    #[test]
    fn rich_shaping_honors_per_part_color_size_and_marker() {
        let fm = fonts();
        let parts = vec![
            x_core::TextPart {
                text: "BIG".into(),
                color: Some(Color::from_rgb8(255, 0, 0)),
                size: Some(40.0),
                font: None,
                weight: None,
                italic: None,
                ls: None,
            },
            x_core::TextPart {
                text: " small".into(),
                color: None,
                size: None,
                font: None,
                weight: None,
                italic: None,
                ls: None,
            },
        ];
        let (glyphs, _) = crate::shaping::node_text_outlines_rich(
            &fm,
            &parts,
            16.0,
            400.0,
            None,
            0.0,
            1.2,
            x_core::TextWrap::Auto,
            0.0,
            0.0,
            0.0,
            false,
            0.0,
            0.0,
            0,
         Align::Left, 0, &TextLayout::default())
        .expect("rich outlines");
        assert!(glyphs.len() >= 8, "shaped {} glyphs", glyphs.len());
        // first three glyphs (the "BIG" run) carry the explicit color
        for g in glyphs.iter().take(3) {
            assert!(
                g.color.components[0] > 0.99 && g.color.components[1] < 0.01,
                "run color on glyph: {:?}",
                g.color
            );
        }
        // unstyled glyphs carry the fully-transparent MARKER (sinks paint
        // them with the command brush, preserving gradient text fills)
        assert!(
            glyphs.iter().skip(3).all(|g| g.color.components[3] == 0.0),
            "marker on unstyled glyphs"
        );
        // 40px run glyphs render larger than 16px base glyphs: the path is
        // in font units, the em scale rides the glyph transform
        let scale = |g: &OutlineGlyph| g.transform.as_coeffs()[0].abs();
        let big = glyphs.iter().take(3).map(scale).fold(0.0_f64, f64::max);
        let small = glyphs.iter().skip(3).map(scale).fold(0.0_f64, f64::max);
        assert!(
            small > 0.0 && big > small * 1.8,
            "size override scales outlines: {big} vs {small}"
        );
    }

    #[test]
    fn unchanged_text_is_a_hit() {
        let fm = fonts();
        let c = ShapedTextCache::new();
        let a = c
            .get_or_shape(&fm, key("Hello", 16.0, 400.0, None))
            .unwrap();
        let b = c
            .get_or_shape(&fm, key("Hello", 16.0, 400.0, None))
            .unwrap();
        assert!(Arc::ptr_eq(&a, &b), "same key -> same Arc, no reshape");
        assert_eq!(c.stats(), (1, 1));
    }

    #[test]
    fn text_change_is_a_miss() {
        let fm = fonts();
        let c = ShapedTextCache::new();
        c.get_or_shape(&fm, key("Hello", 16.0, 400.0, None))
            .unwrap();
        c.get_or_shape(&fm, key("Hello!", 16.0, 400.0, None))
            .unwrap();
        assert_eq!(c.stats().1, 2, "content change reshapes");
    }

    #[test]
    fn size_and_font_changes_are_misses() {
        // the review's exact example: Hello/16px vs Hello/24px = 2 entries
        let fm = fonts();
        let c = ShapedTextCache::new();
        c.get_or_shape(&fm, key("Hello", 16.0, 400.0, None))
            .unwrap();
        c.get_or_shape(&fm, key("Hello", 24.0, 400.0, None))
            .unwrap();
        assert_eq!(c.len(), 2, "16px and 24px are separate entries");
        c.get_or_shape(&fm, key("Hello", 16.0, 400.0, Some("DejaVu Sans")))
            .unwrap();
        assert_eq!(c.stats().1, 3, "font change reshapes");
    }

    #[test]
    fn width_change_rewraps() {
        let fm = fonts();
        let c = ShapedTextCache::new();
        let wide = c
            .get_or_shape(&fm, key("alpha beta gamma delta", 20.0, 500.0, None))
            .unwrap();
        let narrow = c
            .get_or_shape(&fm, key("alpha beta gamma delta", 20.0, 60.0, None))
            .unwrap();
        assert_eq!(c.stats().1, 2, "width constraint is in the key");
        assert!(
            narrow.height > wide.height * 1.5,
            "narrow entry actually rewrapped"
        );
    }

    #[test]
    fn position_change_is_a_hit_by_construction() {
        // THE critical property: moving a node never reshapes. Output is
        // block-local; position lives in the world transform composed by
        // the sink, so the key contains no position at all.
        let fm = fonts();
        let c = ShapedTextCache::new();
        let a = c
            .get_or_shape(&fm, key("move me", 16.0, 300.0, None))
            .unwrap();
        // "node moved": same node text drawn at a different world position
        let b = c
            .get_or_shape(&fm, key("move me", 16.0, 300.0, None))
            .unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        assert_eq!(c.stats(), (1, 1), "position change -> pure hit");
    }

    #[test]
    fn epoch_bump_invalidates() {
        let fm = fonts();
        let c = ShapedTextCache::new();
        c.get_or_shape(
            &fm,
            TextLayoutKey::new("x", 16.0, 100.0, None, Color::BLACK, 0),
        )
        .unwrap();
        c.get_or_shape(
            &fm,
            TextLayoutKey::new("x", 16.0, 100.0, None, Color::BLACK, 1),
        )
        .unwrap();
        assert_eq!(c.stats().1, 2, "font epoch is part of the key");
    }
}
