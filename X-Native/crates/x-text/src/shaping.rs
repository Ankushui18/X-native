//! Professional shaping stack (P0 typography):
//!
//!   FontManager -> font loading -> Unicode shaping (rustybuzz/HarfBuzz)
//!   -> glyph runs -> BiDi + line breaking -> text layout -> Vello
//!
//! Delivers: ligatures (GSUB), kerning (GPOS), Arabic joining/RTL,
//! CJK line breaking, font fallback per run, letter spacing, line
//! height, rich-text spans, variable-font axes.

use crate::font::FontManager;
use std::collections::HashMap;
use vello::kurbo::{Affine, BezPath, PathEl, Point, Shape};
use vello::peniko::{Color, Fill};
use vello::Scene;

// ------------------------------------------------------------------- spans

/// Rich text: a styled range. `font` indexes FontManager (None = default).
#[derive(Debug, Clone, PartialEq)]
pub struct Span {
    pub text: String,
    pub size: f64,
    pub color: Color,
    pub letter_spacing: f64,
    /// extra advance after every space character (CSS word-spacing, px)
    pub word_spacing: f64,
    pub font: Option<usize>,
    /// variable-font axes, e.g. [("wght", 700.0)]
    pub variations: Vec<(String, f32)>,
}

impl Span {
    pub fn new(text: &str, size: f64) -> Self {
        Self {
            text: text.into(),
            size,
            color: Color::BLACK,
            letter_spacing: 0.0,
            word_spacing: 0.0,
            font: None,
            variations: vec![],
        }
    }
    pub fn color(mut self, c: Color) -> Self {
        self.color = c;
        self
    }
    pub fn letter_spacing(mut self, s: f64) -> Self {
        self.letter_spacing = s;
        self
    }
    pub fn word_spacing(mut self, s: f64) -> Self {
        self.word_spacing = s;
        self
    }
    pub fn font(mut self, f: usize) -> Self {
        self.font = Some(f);
        self
    }
    pub fn variation(mut self, axis: &str, value: f32) -> Self {
        self.variations.push((axis.into(), value));
        self
    }
}

// -------------------------------------------------------------- glyph runs

/// One shaped glyph, positioned in px relative to the run origin.
#[derive(Debug, Clone, Copy)]
pub struct ShapedGlyph {
    pub glyph_id: u16,
    pub cluster: u32,
    pub x_advance: f64,
    pub x_offset: f64,
    pub y_offset: f64,
}

/// A shaped run: one font, one direction, one style.
#[derive(Debug, Clone)]
pub struct GlyphRun {
    pub font: usize,
    pub size: f64,
    pub color: Color,
    pub rtl: bool,
    pub glyphs: Vec<ShapedGlyph>,
    pub width: f64,
    pub text: String,
}

// ---------------------------------------------------------------- shaping

pub struct Shaper<'a> {
    pub fonts: &'a FontManager,
    face_cache: HashMap<usize, rustybuzz::Face<'a>>,
}

impl<'a> Shaper<'a> {
    pub fn new(fonts: &'a FontManager) -> Self {
        Self {
            fonts,
            face_cache: HashMap::new(),
        }
    }

    fn face(&mut self, font: usize) -> Option<&rustybuzz::Face<'a>> {
        if !self.face_cache.contains_key(&font) {
            let data = self.fonts.fonts.get(font)?.data();
            let face = rustybuzz::Face::from_slice(data, 0)?;
            self.face_cache.insert(font, face);
        }
        self.face_cache.get(&font)
    }

    /// Best font for `text` starting from `prefer`: first font in the
    /// fallback chain whose cmap covers the majority of chars.
    pub fn pick_font(&self, text: &str, prefer: usize) -> usize {
        let score = |fi: usize| -> usize {
            let Some(f) = self.fonts.fonts.get(fi) else {
                return 0;
            };
            text.chars()
                .filter(|&c| !c.is_whitespace() && f.glyph_id(c).is_some_and(|g| g != 0))
                .count()
        };
        let total = text.chars().filter(|c| !c.is_whitespace()).count();
        if total == 0 || score(prefer) == total {
            return prefer;
        }
        (0..self.fonts.fonts.len())
            .max_by_key(|&i| score(i))
            .unwrap_or(prefer)
    }

    /// Shape one span into runs (BiDi-split first, then rustybuzz per run).
    pub fn shape_span(&mut self, span: &Span, default_font: usize) -> Vec<GlyphRun> {
        let bidi = unicode_bidi::BidiInfo::new(&span.text, None);
        let mut runs = vec![];
        let para = match bidi.paragraphs.first() {
            Some(p) => p,
            None => return runs,
        };
        let (levels, ranges) = bidi.visual_runs(para, para.range.clone());
        for range in ranges {
            let sub = &span.text[range.clone()];
            if sub.is_empty() {
                continue;
            }
            let rtl = levels[range.start].is_rtl();
            let base = span.font.unwrap_or(default_font);
            // FONT-COVERAGE SEGMENTATION: a single BiDi run can mix
            // scripts (latin + Devanagari + CJK). Split it wherever the
            // covering font changes so no segment falls to tofu.
            for (seg, font) in self.segment_by_font(sub, base) {
                self.shape_one(&seg, font, rtl, span, &mut runs);
            }
            continue;
        }
        runs
    }

    /// Split text into (segment, font) pieces where each piece's font
    /// actually covers its characters (whitespace glues to the current
    /// segment). This is per-character fallback, the missing piece that
    /// coverage-voting per run cannot provide.
    fn segment_by_font(&self, text: &str, prefer: usize) -> Vec<(String, usize)> {
        let covers = |fi: usize, c: char| -> bool {
            self.fonts
                .fonts
                .get(fi)
                .and_then(|f| f.glyph_id(c))
                .is_some_and(|g| g != 0)
        };
        let font_for = |c: char| -> usize {
            if covers(prefer, c) {
                return prefer;
            }
            (0..self.fonts.fonts.len())
                .find(|&i| covers(i, c))
                .unwrap_or(prefer)
        };
        let mut out: Vec<(String, usize)> = vec![];
        for ch in text.chars() {
            let f = if ch.is_whitespace() {
                out.last().map(|(_, f)| *f).unwrap_or(prefer)
            } else {
                font_for(ch)
            };
            match out.last_mut() {
                Some((seg, sf)) if *sf == f => seg.push(ch),
                _ => out.push((ch.to_string(), f)),
            }
        }
        out
    }

    fn shape_one(
        &mut self,
        sub: &str,
        font: usize,
        rtl: bool,
        span: &Span,
        runs: &mut Vec<GlyphRun>,
    ) {
        let Some(face) = self.face(font) else { return };
        let mut face = face.clone();
        for (axis, value) in &span.variations {
            let tag_bytes = axis.as_bytes();
            if tag_bytes.len() == 4 {
                let tag = rustybuzz::ttf_parser::Tag::from_bytes(&[
                    tag_bytes[0],
                    tag_bytes[1],
                    tag_bytes[2],
                    tag_bytes[3],
                ]);
                let _ = face.set_variation(tag, *value);
            }
        }
        let mut buf = rustybuzz::UnicodeBuffer::new();
        buf.push_str(sub);
        buf.set_direction(if rtl {
            rustybuzz::Direction::RightToLeft
        } else {
            rustybuzz::Direction::LeftToRight
        });
        let out = rustybuzz::shape(&face, &[], buf);
        let upm = self.fonts.fonts[font].units_per_em;
        let scale = span.size / upm;
        let mut glyphs = vec![];
        let mut width = 0.0;
        for (info, pos) in out.glyph_infos().iter().zip(out.glyph_positions()) {
            let is_space = sub
                .get(info.cluster as usize..)
                .and_then(|s| s.chars().next())
                .map(|c| c == ' ')
                .unwrap_or(false);
            let adv = pos.x_advance as f64 * scale
                + span.letter_spacing
                + if is_space { span.word_spacing } else { 0.0 };
            glyphs.push(ShapedGlyph {
                glyph_id: info.glyph_id as u16,
                cluster: info.cluster,
                x_advance: adv,
                x_offset: pos.x_offset as f64 * scale,
                y_offset: pos.y_offset as f64 * scale,
            });
            width += adv;
        }
        runs.push(GlyphRun {
            font,
            size: span.size,
            color: span.color,
            rtl,
            glyphs,
            width,
            text: sub.to_string(),
        });
    }
}

// ------------------------------------------------------------ line breaking

/// Break opportunities: after spaces/hyphens, and BETWEEN CJK ideographs
/// (each CJK char is a break opportunity — standard CJK behavior).
pub fn break_opportunities(text: &str) -> Vec<usize> {
    let mut out = vec![];
    let mut prev_cjk = false;
    for (i, c) in text.char_indices() {
        let is_cjk = matches!(c as u32,
            0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0x3040..=0x30FF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF);
        if c == ' ' || c == '-' {
            out.push(i + c.len_utf8());
        } else if (is_cjk || (prev_cjk && !is_cjk)) && i > 0 {
            out.push(i);
        }
        prev_cjk = is_cjk;
    }
    out
}

/// A laid-out line: spans clipped to the line, with total width.
#[derive(Debug, Clone)]
pub struct Line {
    pub spans: Vec<Span>,
    pub width: f64,
    /// true on the LAST line of a paragraph (explicit \n or end of text):
    /// block layout adds `TextBlockStyle::paragraph_spacing` after it.
    pub para_end: bool,
}

/// Greedy layout of rich spans into lines <= max_width. Measures with
/// REAL shaping (ligatures/kerning affect fit). Handles \n, spaces, CJK.
pub fn layout_lines(
    shaper: &mut Shaper,
    spans: &[Span],
    default_font: usize,
    max_width: f64,
) -> Vec<Line> {
    layout_lines_wrapped(
        shaper,
        spans,
        default_font,
        max_width,
        x_core::TextWrap::Auto,
    )
}

/// Wrap-mode-aware layout: `Auto` is the classic greedy pass; `Balance`
/// re-wraps each paragraph at the narrowest width that keeps its greedy
/// LINE COUNT (CSS `text-wrap: balance` — lines come out even); `Pretty`
/// balances and then evens the last two lines so a lone word never
/// strands on the paragraph's final line (widow control).
pub fn layout_lines_wrapped(
    shaper: &mut Shaper,
    spans: &[Span],
    default_font: usize,
    max_width: f64,
    wrap: x_core::TextWrap,
) -> Vec<Line> {
    if wrap == x_core::TextWrap::Auto {
        return greedy_lines(shaper, spans, default_font, max_width);
    }
    // re-wrap per paragraph: split spans on explicit newlines, then
    // break each paragraph into pieces (same rules as the greedy pass)
    let mut out: Vec<Line> = vec![];
    let mut para: Vec<Span> = vec![];
    let flush = |shaper: &mut Shaper, para: &mut Vec<Span>, out: &mut Vec<Line>, max_width: f64| {
        if para.is_empty() {
            return;
        }
        let pieces = paragraph_pieces(para);
        let greedy = greedy_pieces(shaper, &pieces, default_font, max_width);
        let lines = match wrap {
            x_core::TextWrap::Balance => balance_paragraph(shaper, &pieces, &greedy, default_font),
            x_core::TextWrap::Pretty => {
                let balanced = balance_paragraph(shaper, &pieces, &greedy, default_font);
                pretty_tail(shaper, &balanced, default_font, max_width)
            }
            x_core::TextWrap::Auto => greedy,
        };
        out.extend(lines);
        para.clear();
    };
    for span in spans {
        for part in split_keep(&span.text, '\n') {
            if part == "\n" {
                flush(shaper, &mut para, &mut out, max_width);
                out.push(Line {
                    spans: vec![],
                    width: 0.0,
                    para_end: true,
                });
                continue;
            }
            let mut piece = span.clone();
            piece.text = part.to_string();
            para.push(piece);
        }
    }
    flush(shaper, &mut para, &mut out, max_width);
    if out.is_empty() {
        out.push(Line {
            spans: vec![],
            width: 0.0,
            para_end: true,
        });
    }
    out
}

/// Split paragraph spans into break-opportunity pieces (same segmentation
/// as the greedy pass, but kept as an owned list so re-wrapping at other
/// widths is cheap).
fn paragraph_pieces(para: &[Span]) -> Vec<Span> {
    let mut pieces = vec![];
    for span in para {
        let mut last = 0;
        for b in break_opportunities(&span.text) {
            if b > last && b <= span.text.len() {
                let mut p = span.clone();
                p.text = span.text[last..b].to_string();
                pieces.push(p);
                last = b;
            }
        }
        if last < span.text.len() {
            let mut p = span.clone();
            p.text = span.text[last..].to_string();
            pieces.push(p);
        }
    }
    pieces
}

/// Shaped width of one piece (`default_font` is the fallback when the
/// span carries no explicit font — the same rule as the greedy pass).
fn piece_width(shaper: &mut Shaper, sp: &Span, default_font: usize) -> f64 {
    shaper
        .shape_span(sp, sp.font.unwrap_or(default_font))
        .iter()
        .map(|r| r.width)
        .sum::<f64>()
}

/// Greedy first-fit of a piece list at width `w` (the same merge rule as
/// the streaming pass: adjacent same-style spans fuse).
fn greedy_pieces(shaper: &mut Shaper, pieces: &[Span], default_font: usize, w: f64) -> Vec<Line> {
    let mut lines = vec![];
    let mut cur: Vec<Span> = vec![];
    let mut cur_w = 0.0;
    for piece in pieces {
        let pw = piece_width(shaper, piece, default_font);
        if cur_w + pw > w && cur_w > 0.0 {
            lines.push(Line {
                spans: std::mem::take(&mut cur),
                width: cur_w,
                para_end: false,
            });
            cur_w = 0.0;
        }
        if let Some(lastspan) = cur.last_mut() {
            if lastspan.size == piece.size
                && lastspan.color == piece.color
                && lastspan.font == piece.font
                && lastspan.letter_spacing == piece.letter_spacing
            {
                lastspan.text.push_str(&piece.text);
                cur_w += pw;
                continue;
            }
        }
        cur.push(piece.clone());
        cur_w += pw;
    }
    if !cur.is_empty() || lines.is_empty() {
        lines.push(Line {
            spans: cur,
            width: cur_w,
            para_end: true,
        });
    }
    lines
}

/// Binary-search the narrowest width that keeps the paragraph's greedy
/// line count, then wrap there — the CSS balance strategy.
fn balance_paragraph(
    shaper: &mut Shaper,
    pieces: &[Span],
    greedy: &[Line],
    default_font: usize,
) -> Vec<Line> {
    let k = greedy.len();
    if k < 2 {
        return greedy.to_vec();
    }
    let w_hi = greedy.iter().map(|l| l.width).fold(0.0, f64::max);
    let w_lo = pieces
        .iter()
        .map(|p| piece_width(shaper, p, default_font))
        .fold(0.0, f64::max);
    if w_lo >= w_hi {
        return greedy.to_vec();
    }
    let count_at = |shaper: &mut Shaper, w: f64| -> usize {
        greedy_pieces(shaper, pieces, default_font, w).len()
    };
    let (mut lo, mut hi) = (w_lo, w_hi);
    for _ in 0..14 {
        let mid = (lo + hi) / 2.0;
        if count_at(shaper, mid) <= k {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    let balanced = greedy_pieces(shaper, pieces, default_font, hi);
    if balanced.len() == k {
        balanced
    } else {
        greedy.to_vec()
    }
}

/// Number of break-opportunity pieces in a line that carry visible
/// text (spans MERGE same-style pieces, so word count must be re-split).
fn visible_pieces(line: &Line) -> usize {
    let mut n = 0;
    for span in &line.spans {
        let mut last = 0;
        for b in break_opportunities(&span.text) {
            if b > last && b <= span.text.len() {
                if !span.text[last..b].trim().is_empty() {
                    n += 1;
                }
                last = b;
            }
        }
        if last < span.text.len() && !span.text[last..].trim().is_empty() {
            n += 1;
        }
    }
    n
}

/// Pretty: after balancing, if the paragraph's last line is a single
/// segment, re-split the last two lines so the widow gains a neighbor.
fn pretty_tail(
    shaper: &mut Shaper,
    balanced: &[Line],
    default_font: usize,
    max_width: f64,
) -> Vec<Line> {
    let k = balanced.len();
    if k < 2 || visible_pieces(&balanced[k - 1]) > 1 {
        return balanced.to_vec();
    }
    // pieces of the last two lines (re-split merged spans — same style)
    let mut tail: Vec<Span> = vec![];
    for line in &balanced[k - 2..] {
        for span in &line.spans {
            let mut last = 0;
            for b in break_opportunities(&span.text) {
                if b > last && b <= span.text.len() {
                    let mut p = span.clone();
                    p.text = span.text[last..b].to_string();
                    tail.push(p);
                    last = b;
                }
            }
            if last < span.text.len() {
                let mut p = span.clone();
                p.text = span.text[last..].to_string();
                tail.push(p);
            }
        }
    }
    if tail.len() < 3 {
        return balanced.to_vec(); // nothing to move
    }
    let total: f64 = tail
        .iter()
        .map(|p| piece_width(shaper, p, default_font))
        .sum();
    // try even-ish splits of the tail: first line shrinks, the widow
    // line gains a piece — keep both within the original box
    for f in [0.42, 0.46, 0.5, 0.54, 0.58, 0.62] {
        let cand = greedy_pieces(shaper, &tail, default_font, total * f);
        if cand.len() == 2
            && visible_pieces(&cand[1]) >= 2
            && cand[0].width <= max_width + 0.01
            && cand[1].width <= max_width + 0.01
        {
            let mut out = balanced[..k - 2].to_vec();
            out.extend(cand);
            return out;
        }
    }
    balanced.to_vec()
}

fn greedy_lines(
    shaper: &mut Shaper,
    spans: &[Span],
    default_font: usize,
    max_width: f64,
) -> Vec<Line> {
    let measure = |sh: &mut Shaper, sp: &Span| -> f64 {
        sh.shape_span(sp, default_font)
            .iter()
            .map(|r| r.width)
            .sum()
    };
    let mut lines: Vec<Line> = vec![];
    let mut cur: Vec<Span> = vec![];
    let mut cur_w = 0.0;

    for span in spans {
        for para in split_keep(&span.text, '\n') {
            if para == "\n" {
                lines.push(Line {
                    spans: std::mem::take(&mut cur),
                    width: cur_w,
                    para_end: true,
                });
                cur_w = 0.0;
                continue;
            }
            // word/CJK segments
            let mut segs: Vec<&str> = vec![];
            let mut last = 0;
            for b in break_opportunities(para) {
                if b > last && b <= para.len() {
                    segs.push(&para[last..b]);
                    last = b;
                }
            }
            if last < para.len() {
                segs.push(&para[last..]);
            }
            for seg in segs {
                let piece = Span {
                    text: seg.to_string(),
                    ..span.clone()
                };
                let w = measure(shaper, &piece);
                if cur_w + w > max_width && cur_w > 0.0 {
                    lines.push(Line {
                        spans: std::mem::take(&mut cur),
                        width: cur_w,
                        para_end: false,
                    });
                    cur_w = 0.0;
                }
                // merge with previous span on the line if same style
                if let Some(lastspan) = cur.last_mut() {
                    if lastspan.size == piece.size
                        && lastspan.color == piece.color
                        && lastspan.font == piece.font
                        && lastspan.letter_spacing == piece.letter_spacing
                    {
                        lastspan.text.push_str(&piece.text);
                        cur_w += w;
                        continue;
                    }
                }
                cur.push(piece);
                cur_w += w;
            }
        }
    }
    if !cur.is_empty() || lines.is_empty() {
        lines.push(Line {
            spans: cur,
            width: cur_w,
            para_end: true,
        });
    }
    lines
}

fn split_keep(s: &str, sep: char) -> Vec<&str> {
    let mut out = vec![];
    let mut last = 0;
    for (i, c) in s.char_indices() {
        if c == sep {
            if i > last {
                out.push(&s[last..i]);
            }
            out.push(&s[i..i + c.len_utf8()]);
            last = i + c.len_utf8();
        }
    }
    if last < s.len() {
        out.push(&s[last..]);
    }
    out
}

// ------------------------------------------------------------------ layout

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Left,
    Center,
    Right,
}

/// Map the document model's alignment onto the shaper's. The model carries a
/// fourth state (`Justified`) the layout engine does not stretch for yet; it
/// degrades to Left rather than claim to justify (a justified label over
/// left-set lines is a phantom control).
impl From<x_core::TextAlign> for Align {
    fn from(t: x_core::TextAlign) -> Self {
        match t {
            x_core::TextAlign::Left => Align::Left,
            x_core::TextAlign::Center => Align::Center,
            x_core::TextAlign::Right => Align::Right,
            // NOTE: Justified intentionally maps to Left — see above.
            x_core::TextAlign::Justified => Align::Left,
        }
    }
}

/// Split spans for synthesized small caps: runs of lowercase chars become
/// UPPERCASED segments at `size * SMALL_CAPS_RATIO`, everything else keeps
/// the span size. Returns (segment_text, segment_size) pairs so the app's
/// measurement uses the EXACT segmentation the shaper renders.
pub const SMALL_CAPS_RATIO: f64 = 0.7;

pub fn small_caps_segments(span_text: &str, size: f64) -> Vec<(String, f64)> {
    let mut out: Vec<(String, f64)> = vec![];
    for c in span_text.chars() {
        let lower = c.is_lowercase();
        let seg_size = if lower { size * SMALL_CAPS_RATIO } else { size };
        let up: String = if lower {
            c.to_uppercase().collect()
        } else {
            c.to_string()
        };
        match out.last_mut() {
            Some((text, sz)) if *sz == seg_size => text.push_str(&up),
            _ => out.push((up, seg_size)),
        }
    }
    out
}

pub struct TextBlockStyle {
    pub max_width: f64,
    pub line_height: f64, // multiplier over font natural height (1.0 = natural)
    /// Line-height MODE the multiplier came from (Figma): 0 = legacy auto,
    /// 1 = px, 2 = %. Auto keeps the r1-r3 softened-ascent first baseline;
    /// explicit modes position it with the CSS half-leading model so a
    /// 44px box on 18px type centers its content area in the line box.
    pub lh_mode: u8,
    pub align: Align,
    pub wrap: x_core::TextWrap,
    /// extra px after the LAST line of each paragraph (\n-terminated)
    pub paragraph_spacing: f64,
    /// px to raise (>0) / lower (<0) every glyph from its baseline
    pub baseline_shift: f64,
    /// synthesized small caps: lowercase renders as uppercase at 70% size
    /// (CSS font-variant-caps synthesis — the market-standard fallback
    /// when the face has no `smcp` feature)
    pub small_caps: bool,
    /// variable-font optical size axis (`opsz`); <= 0 = auto/unused
    pub optical_size: f32,
    /// variable-font width axis (`wdth`, 100 = normal); <= 0 = unused
    pub width_axis: f32,
    /// cap on the number of wrapped lines (CSS `max-lines`); None =
    /// unlimited. Lines beyond the cap are dropped and the returned
    /// block height covers exactly what was emitted.
    pub max_lines: Option<usize>,
    /// left indent (px) of the FIRST line of each paragraph
    /// (CSS `text-indent`). 0 = no indent. Note: wrapping is computed at
    /// the full max_width and the first line is then shifted — the shifted
    /// line may overflow the box by the indent amount (CSS reserves the
    /// indent from the first line's available width; the shift-only
    /// simplification is what every fast path here can do cheaply).
    pub paragraph_indent: f64,
    /// underline / strikethrough, drawn once per line across its width
    pub decoration: x_core::TextDecoration,
}

impl Default for TextBlockStyle {
    fn default() -> Self {
        Self {
            max_width: 100_000.0,
            line_height: 1.2,
            lh_mode: 0,
            align: Align::Left,
            wrap: x_core::TextWrap::Auto,
            paragraph_spacing: 0.0,
            baseline_shift: 0.0,
            small_caps: false,
            optical_size: 0.0,
            width_axis: 0.0,
            max_lines: None,
            paragraph_indent: 0.0,
            decoration: x_core::TextDecoration::None,
        }
    }
}

/// One positioned glyph outline: the bezier path in font units and the
/// LOCAL transform (block-relative — caller composes its own world/CTM)
/// that places and scales it, plus its fill color.
pub struct OutlineGlyph {
    pub path: BezPath,
    /// local placement: translate(pen + offset, baseline) * scale(s, -s)
    pub transform: Affine,
    pub color: Color,
}

/// Shape + wrap + align rich spans and return every glyph as a positioned
/// outline. This is the SINGLE source of truth for text geometry: the
/// canvas encoder (encode_rich_text) and the SVG/PDF exporters all
/// consume it, so text placement is pixel-identical across all three
/// sinks by construction. Returns (glyphs, total_height).
pub fn glyph_outlines(
    fonts: &FontManager,
    spans: &[Span],
    default_font: usize,
    style: &TextBlockStyle,
) -> (Vec<OutlineGlyph>, f64) {
    let mut shaper = Shaper::new(fonts);
    // synthesized small caps: re-segment BEFORE wrapping so measurement and
    // rendering see the same pieces
    let spans: Vec<Span> = if style.small_caps {
        let mut out = vec![];
        for sp in spans {
            for (seg, sz) in small_caps_segments(&sp.text, sp.size) {
                let mut s2 = Span::new(&seg, sz)
                    .color(sp.color)
                    .letter_spacing(sp.letter_spacing)
                    .word_spacing(sp.word_spacing);
                s2.font = sp.font;
                s2.variations = sp.variations.clone();
                out.push(s2);
            }
        }
        out
    } else {
        spans.to_vec()
    };
    // variable-font axes ride every span (no-op on static faces)
    let spans: Vec<Span> = if style.optical_size > 0.0 || style.width_axis > 0.0 {
        spans
            .into_iter()
            .map(|mut sp| {
                if style.optical_size > 0.0 {
                    sp.variations.push(("opsz".into(), style.optical_size));
                }
                if style.width_axis > 0.0 {
                    sp.variations.push(("wdth".into(), style.width_axis));
                }
                sp
            })
            .collect()
    } else {
        spans
    };
    let mut lines = layout_lines_wrapped(
        &mut shaper,
        &spans,
        default_font,
        style.max_width,
        style.wrap,
    );
    // max-lines: drop everything beyond the cap BEFORE placement, so the
    // returned height covers exactly what is emitted (CSS max-lines).
    if let Some(cap) = style.max_lines {
        lines.truncate(cap);
    }
    let mut out = vec![];
    let mut y = 0.0f64;
    for (li, line) in lines.iter().enumerate() {
        let max_size = line.spans.iter().map(|s| s.size).fold(12.0, f64::max);
        let f0 = &fonts.fonts[default_font];
        let natural = (f0.ascent - f0.descent + f0.line_gap) * (max_size / f0.units_per_em);
        let lh = natural * style.line_height;
        let fs_sc = max_size / f0.units_per_em;
        let lh_px = lh;
        let baseline = y + if style.lh_mode == 0 {
            // legacy AUTO: softened ascent (r1-r3 pixel contract)
            f0.ascent * fs_sc * style.line_height.clamp(1.0, 1.2)
        } else {
            // explicit PX/%: CSS half-leading — center the content area
            // (ascent+descent) in the line box, baseline on top of it
            (lh_px - (f0.ascent - f0.descent) * fs_sc) / 2.0 + f0.ascent * fs_sc
        } - style.baseline_shift;
        // paragraph indent (CSS text-indent): the FIRST line of a paragraph.
        // A line starts a paragraph when it is the block's first line or the
        // previous line ended one (para_end — explicit \n or end of text).
        let para_first = li == 0 || lines[li - 1].para_end;
        let x0 = match style.align {
            Align::Left => 0.0,
            Align::Center => (style.max_width - line.width) / 2.0,
            Align::Right => style.max_width - line.width,
        } + if para_first {
            style.paragraph_indent
        } else {
            0.0
        };
        let mut pen = x0;
        for span in &line.spans {
            for run in shaper.shape_span(span, default_font) {
                let f = &fonts.fonts[run.font];
                let scale = run.size / f.units_per_em;
                let mut x = pen;
                for g in &run.glyphs {
                    if let Some(outline) = f.outline(g.glyph_id) {
                        let t = Affine::translate((x + g.x_offset, baseline - g.y_offset))
                            * Affine::scale_non_uniform(scale, -scale);
                        out.push(OutlineGlyph {
                            path: outline,
                            transform: t,
                            color: run.color,
                        });
                    }
                    x += g.x_advance;
                }
                pen += run.width;
            }
        }
        // decoration: one rect across the laid-out line, in the line's ink
        // colour. Underline sits ~0.1em below the baseline, strikethrough
        // through the x-height (~0.5em above) — the CSS-like defaults that
        // read well on any face. Thickness ~5% of the line size, min 1px.
        if style.decoration != x_core::TextDecoration::None && !line.spans.is_empty() {
            let th = (max_size * 0.05).max(1.0);
            let line_y = match style.decoration {
                x_core::TextDecoration::Underline => baseline + max_size * 0.10,
                x_core::TextDecoration::Strikethrough => baseline - max_size * 0.50,
                x_core::TextDecoration::None => unreachable!("guarded above"),
            };
            let mut path = BezPath::new();
            path.push(PathEl::MoveTo(Point::new(x0, line_y)));
            path.push(PathEl::LineTo(Point::new(x0 + line.width, line_y)));
            path.push(PathEl::LineTo(Point::new(x0 + line.width, line_y + th)));
            path.push(PathEl::LineTo(Point::new(x0, line_y + th)));
            path.push(PathEl::ClosePath);
            out.push(OutlineGlyph {
                path,
                transform: Affine::IDENTITY,
                color: line.spans[0].color,
            });
        }
        y += lh;
        // paragraph spacing separates paragraphs — it never pads the block
        // after the final line (Figma/CSS-collapsed semantics)
        if line.para_end && li + 1 < lines.len() {
            y += style.paragraph_spacing;
        }
    }
    (out, y)
}

/// Full pipeline: rich spans -> shaped, wrapped, aligned -> Vello paths.
/// Returns (paths_encoded, total_height).
pub fn encode_rich_text(
    scene: &mut Scene,
    fonts: &FontManager,
    spans: &[Span],
    default_font: usize,
    world: Affine,
    style: &TextBlockStyle,
) -> (usize, f64) {
    let (glyphs, height) = glyph_outlines(fonts, spans, default_font, style);
    let n = glyphs.len();
    for g in glyphs {
        scene.fill(Fill::NonZero, world * g.transform, g.color, None, &g.path);
    }
    (n, height)
}

/// The ONE canonical mapping from a Text node's properties to shaped glyph
/// outlines. PX CONTRACT: `size` is the real glyph size in px (emitters
/// pre-scale legacy node ems by 0.72). Canvas sink, PDF exporter, and SVG
/// exporter must all call THIS so text geometry cannot drift between them.
pub fn node_text_outlines(
    fonts: &FontManager,
    text: &str,
    size: f64,
    max_width: f64,
    font_name: Option<&str>,
    color: Color,
) -> Option<(Vec<OutlineGlyph>, f64)> {
    node_text_outlines_styled(
        fonts,
        text,
        size,
        max_width,
        font_name,
        color,
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
        Align::Left,
        None,
        0.0,
        x_core::TextDecoration::None,
    )
}

/// Typography-aware variant: letter spacing (px) + line height multiplier.
/// Same ONE-pipeline contract; the defaults reproduce node_text_outlines.
#[allow(clippy::too_many_arguments)] // positional params are the natural shape here; grouping would obscure the algorithm
pub fn node_text_outlines_styled(
    fonts: &FontManager,
    text: &str,
    size: f64,
    max_width: f64,
    font_name: Option<&str>,
    color: Color,
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
    align: Align,
    max_lines: Option<usize>,
    paragraph_indent: f64,
    decoration: x_core::TextDecoration,
) -> Option<(Vec<OutlineGlyph>, f64)> {
    // route through the ShapedTextCache: repeated frames/text reuse the
    // shaped block (Arc clone), positions compose OUTSIDE via the world
    // transform so moves are cache hits. Falls back to direct shaping
    // if the cache is poisoned.
    let key = crate::cache::TextLayoutKey::new_styled(
        text,
        size,
        max_width,
        font_name,
        color,
        fonts.epoch(),
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
        align,
        max_lines,
        paragraph_indent,
        decoration,
    );
    if let Some(block) = crate::cache::ShapedTextCache::global().get_or_shape(fonts, key) {
        return Some((
            block
                .glyphs
                .iter()
                .map(|g| OutlineGlyph {
                    path: g.path.clone(),
                    transform: g.transform,
                    color: g.color,
                })
                .collect(),
            block.height,
        ));
    }
    node_text_outlines_styled_uncached(
        fonts,
        text,
        size,
        max_width,
        font_name,
        color,
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
        align,
        max_lines,
        paragraph_indent,
        decoration,
    )
}

/// The raw shaping path (cache-miss fill + tests).
pub fn node_text_outlines_uncached(
    fonts: &FontManager,
    text: &str,
    size: f64,
    max_width: f64,
    font_name: Option<&str>,
    color: Color,
) -> Option<(Vec<OutlineGlyph>, f64)> {
    node_text_outlines_styled_uncached(
        fonts,
        text,
        size,
        max_width,
        font_name,
        color,
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
        Align::Left,
        None,
        0.0,
        x_core::TextDecoration::None,
    )
}

/// Rich-run shaping: styled sub-ranges over a base style (per-run
/// color/size/font overrides). Parts come from `x_core::resolve_text_parts`;
/// a part with `color: None` shapes with a fully-transparent MARKER color
/// so sinks can paint it with the command brush (gradient text fills keep
/// their gradient on unstyled runs). Per-run colors are final (opacity
/// folded by the renderer).
#[allow(clippy::too_many_arguments)] // positional params are the natural shape here; grouping would obscure the algorithm
pub fn node_text_outlines_rich(
    fonts: &FontManager,
    parts: &[x_core::TextPart],
    base_size: f64,
    max_width: f64,
    base_font: Option<&str>,
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
    align: Align,
    max_lines: Option<usize>,
    paragraph_indent: f64,
    decoration: x_core::TextDecoration,
) -> Option<(Vec<OutlineGlyph>, f64)> {
    let key = crate::cache::TextLayoutKey::new_rich(
        parts,
        base_size,
        max_width,
        base_font,
        fonts.epoch(),
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
        align,
        max_lines,
        paragraph_indent,
        decoration,
    );
    if let Some(block) = crate::cache::ShapedTextCache::global().get_or_shape(fonts, key) {
        return Some((
            block
                .glyphs
                .iter()
                .map(|g| OutlineGlyph {
                    path: g.path.clone(),
                    transform: g.transform,
                    color: g.color,
                })
                .collect(),
            block.height,
        ));
    }
    node_text_outlines_rich_uncached(
        fonts,
        parts,
        base_size,
        max_width,
        base_font,
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
        align,
        max_lines,
        paragraph_indent,
        decoration,
    )
}

/// Raw rich-run shaping path (cache-miss fill + tests).
/// A text node's baseline offset (top edge -> first baseline) from real
/// font metrics: ascent scaled by the 0.72 em contract, softened by the
/// line-height factor. Feeds `Node::baseline` for auto-layout baseline
/// alignment.
pub fn node_text_baseline(
    fonts: &FontManager,
    size: f64,
    font_name: Option<&str>,
    lh: f64,
) -> Option<f64> {
    let chosen = font_name
        .and_then(|n| fonts.resolve_font_name(n))
        .or_else(|| fonts.default_font())?;
    let f0 = &fonts.fonts[chosen];
    // PX CONTRACT: size is the real glyph size in px
    let factor = lh.clamp(1.0, 1.2);
    Some(f0.ascent * (size / f0.units_per_em) * factor)
}

#[allow(clippy::too_many_arguments)] // positional params are the natural shape here; grouping would obscure the algorithm
pub fn node_text_outlines_rich_uncached(
    fonts: &FontManager,
    parts: &[x_core::TextPart],
    base_size: f64,
    max_width: f64,
    base_font: Option<&str>,
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
    align: Align,
    max_lines: Option<usize>,
    paragraph_indent: f64,
    decoration: x_core::TextDecoration,
) -> Option<(Vec<OutlineGlyph>, f64)> {
    let default_font = base_font
        .and_then(|n| fonts.resolve_font_name(n))
        .or_else(|| fonts.default_font())?;
    let spans: Vec<Span> = parts
        .iter()
        .map(|p| {
            // same 0.72 em + letter-spacing contract as the plain path; the
            // per-run size overrides the base when present. Weight resolves
            // through the family: "Inter" + 600 -> the "Inter-600" face
            // when one is registered (bundled static instances).
            let fam = p.font.as_deref().or(base_font);
            // PX CONTRACT: part px sizes pass through; the base is px too
            let mut sp = Span::new(&p.text, p.size.unwrap_or(base_size))
                .color(p.color.unwrap_or(Color::TRANSPARENT)) // marker: no explicit color
                .letter_spacing(p.ls.unwrap_or(ls))
                .word_spacing(word_spacing);
            let idx = match p.weight {
                Some(w) => fam
                    .and_then(|f| fonts.resolve_face(f, w))
                    .or_else(|| fam.and_then(|f| fonts.resolve_font_name(f))),
                None => fam.and_then(|f| fonts.resolve_font_name(f)),
            };
            if let Some(i) = idx {
                sp = sp.font(i);
            }
            sp
        })
        .collect();
    let style = TextBlockStyle {
        lh_mode,
        max_width: max_width.max(8.0),
        line_height: lh.max(0.5),
        align,
        wrap,
        paragraph_spacing,
        baseline_shift,
        small_caps,
        optical_size,
        width_axis,
        max_lines,
        paragraph_indent,
        decoration,
    };
    Some(glyph_outlines(fonts, &spans, default_font, &style))
}

/// Natural line box (px) of the face a Text node resolves to — the SAME
/// resolution the styled pipeline uses (name -> face, else default).
/// Emitters convert line-height MODES (px / %) into the pipeline's
/// natural multiplier with this.
pub fn resolve_natural_line_height(fm: &FontManager, font_name: Option<&str>, size_px: f64) -> f64 {
    match font_name
        .and_then(|n| fm.resolve_font_name(n))
        .or_else(|| fm.default_font())
    {
        Some(i) => {
            let f = &fm.fonts[i];
            (f.ascent - f.descent + f.line_gap) * (size_px / f.units_per_em)
        }
        None => size_px * 1.2,
    }
}

/// Raw styled shaping path (cache-miss fill + tests).
#[allow(clippy::too_many_arguments)] // positional params are the natural shape here; grouping would obscure the algorithm
pub fn node_text_outlines_styled_uncached(
    fonts: &FontManager,
    text: &str,
    size: f64,
    max_width: f64,
    font_name: Option<&str>,
    color: Color,
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
    align: Align,
    max_lines: Option<usize>,
    paragraph_indent: f64,
    decoration: x_core::TextDecoration,
) -> Option<(Vec<OutlineGlyph>, f64)> {
    let chosen = font_name
        .and_then(|n| fonts.resolve_font_name(n))
        .or_else(|| fonts.default_font())?;
    // PX CONTRACT: `size` is the real glyph size in px (legacy node ems
    // are pre-scaled by the emitters: h * 0.72)
    let spans = [Span::new(text, size)
        .color(color)
        .letter_spacing(ls)
        .word_spacing(word_spacing)];
    let style = TextBlockStyle {
        lh_mode,
        max_width: max_width.max(8.0),
        line_height: lh.max(0.5),
        align,
        wrap,
        paragraph_spacing,
        baseline_shift,
        small_caps,
        optical_size,
        width_axis,
        max_lines,
        paragraph_indent,
        decoration,
    };
    Some(glyph_outlines(fonts, &spans, chosen, &style))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Explicit PX mode positions the FIRST baseline with the CSS
    /// half-leading model (content area centered in the line box); the
    /// legacy AUTO path keeps the softened ascent. Same multiplier,
    /// different modes -> different baselines.
    #[test]
    fn explicit_lh_mode_half_leading_first_baseline() {
        let m = fonts();
        let f = m.default_font().unwrap();
        let f0 = &m.fonts[f];
        let fs = 20.0;
        let s = fs / f0.units_per_em;
        let nat = (f0.ascent - f0.descent + f0.line_gap) * s;
        let lh_px = 44.0;
        let mult = lh_px / nat;
        let mk = |mode: u8| TextBlockStyle {
            lh_mode: mode,
            line_height: mult,
            ..Default::default()
        };
        let spans = [Span::new("H", fs)];
        let (g1, _) = glyph_outlines(&m, &spans, f, &mk(1));
        let (g0, _) = glyph_outlines(&m, &spans, f, &mk(0));
        let ty = |g: &[OutlineGlyph]| g[0].transform.translation().y;
        let expected = (lh_px - (f0.ascent - f0.descent) * s) / 2.0 + f0.ascent * s;
        assert!(
            (ty(&g1) - expected).abs() < 0.01,
            "px-mode baseline {} vs half-leading {}",
            ty(&g1),
            expected
        );
        let legacy = f0.ascent * s * mult.clamp(1.0, 1.2);
        assert!((ty(&g0) - legacy).abs() < 0.01, "auto baseline unchanged");
        assert!(
            (ty(&g0) - ty(&g1)).abs() > 1.0,
            "modes must differ at the same multiplier"
        );
    }

    /// The shaped-text cache must NOT collide across LH modes: the same
    /// multiplier with mode 0 vs mode 1 yields different first baselines
    /// through the memoized (pub styled) path.
    #[test]
    fn lh_mode_is_part_of_the_cache_key() {
        let m = fonts();
        let f = m.default_font().unwrap();
        let f0 = &m.fonts[f];
        let fs = 20.0;
        let s = fs / f0.units_per_em;
        let nat = (f0.ascent - f0.descent + f0.line_gap) * s;
        let mult = 44.0 / nat;
        let (g1, _) = node_text_outlines_styled(
            &m,
            "H",
            fs,
            10_000.0,
            None,
            Color::WHITE,
            0.0,
            mult,
            x_core::TextWrap::Auto,
            0.0,
            0.0,
            0.0,
            false,
            0.0,
            0.0,
            1,
            Align::Left,
            None,
            0.0,
            x_core::TextDecoration::None,
        )
        .unwrap();
        let (g0, _) = node_text_outlines_styled(
            &m,
            "H",
            fs,
            10_000.0,
            None,
            Color::WHITE,
            0.0,
            mult,
            x_core::TextWrap::Auto,
            0.0,
            0.0,
            0.0,
            false,
            0.0,
            0.0,
            0,
            Align::Left,
            None,
            0.0,
            x_core::TextDecoration::None,
        )
        .unwrap();
        let d = (g0[0].transform.translation().y - g1[0].transform.translation().y).abs();
        assert!(d > 1.0, "cached blocks must differ across modes (d={d})");
    }

    /// Word spacing adds its advance after every space (CSS contract) and
    /// the block height is untouched.
    #[test]
    fn word_spacing_advances_after_spaces() {
        let m = fonts();
        let f = m.default_font().unwrap();
        let mut sh0 = Shaper::new(&m);
        let base = {
            let runs = sh0.shape_span(&Span::new("a b", 20.0), f);
            runs.iter().map(|r| r.width).sum::<f64>()
        };
        let mut sh1 = Shaper::new(&m);
        let spaced = {
            let runs = sh1.shape_span(&Span::new("a b", 20.0).word_spacing(7.0), f);
            runs.iter().map(|r| r.width).sum::<f64>()
        };
        assert!((spaced - base - 7.0).abs() < 0.01, "{base} vs {spaced}");
    }

    /// Small caps segmentation: lowercase -> uppercased at 70%, others
    /// unchanged; adjacent same-size chars fuse into one segment.
    #[test]
    fn small_caps_segments_split() {
        let segs = small_caps_segments("Ab c", 20.0);
        assert_eq!(
            segs,
            vec![
                ("A".to_string(), 20.0),
                ("B".to_string(), 14.0),
                (" ".to_string(), 20.0),
                ("C".to_string(), 14.0),
            ]
        );
        // multi-char uppercase expansion (ß -> SS) still segments cleanly
        let segs = small_caps_segments("aß", 10.0);
        assert_eq!(
            segs.iter().map(|(t, _)| t.as_str()).collect::<String>(),
            "ASS"
        );
    }

    /// Synthesized small caps: mixed-case text keeps its block height (the
    /// capitals anchor the line) while the lowercase glyphs shrink — the
    /// line renders narrower. All-lowercase text legitimately loses height
    /// (every glyph is small) — that is the CSS-synthesis contract.
    #[test]
    fn small_caps_narrower_same_height() {
        let m = fonts();
        let f = m.default_font().unwrap();
        let style = |sc| TextBlockStyle {
            lh_mode: 0,
            max_width: 10_000.0,
            line_height: 1.0,
            align: Align::Left,
            wrap: x_core::TextWrap::Auto,
            paragraph_spacing: 0.0,
            baseline_shift: 0.0,
            small_caps: sc,
            optical_size: 0.0,
            width_axis: 0.0,
            max_lines: None,
            paragraph_indent: 0.0,
            decoration: x_core::TextDecoration::None,
        };
        let (g0, h0) = glyph_outlines(&m, &[Span::new("Abc", 20.0).font(f)], f, &style(false));
        let (g1, h1) = glyph_outlines(&m, &[Span::new("Abc", 20.0).font(f)], f, &style(true));
        assert_eq!(g0.len(), g1.len(), "same glyph count");
        assert!((h0 - h1).abs() < 0.01, "block height unchanged");
        let w_of = |gs: &[OutlineGlyph]| {
            gs.iter()
                .map(|g| g.transform.as_coeffs()[4])
                .fold(0.0f64, f64::max)
        };
        assert!(w_of(&g1) < w_of(&g0), "small caps narrower: {}", w_of(&g1));
    }

    /// Variable axes ride spans into the shaper (no-op on static faces —
    /// same advance width, and no panic).
    #[test]
    fn variable_axes_shape_without_panic() {
        let m = fonts();
        let f = m.default_font().unwrap();
        let style = TextBlockStyle {
            lh_mode: 0,
            max_width: 10_000.0,
            line_height: 1.0,
            align: Align::Left,
            wrap: x_core::TextWrap::Auto,
            paragraph_spacing: 0.0,
            baseline_shift: 0.0,
            small_caps: false,
            optical_size: 32.0,
            width_axis: 75.0,
            max_lines: None,
            paragraph_indent: 0.0,
            decoration: x_core::TextDecoration::None,
        };
        let base = TextBlockStyle {
            lh_mode: 0,
            optical_size: 0.0,
            width_axis: 0.0,
            ..style
        };
        let (g0, _) = glyph_outlines(&m, &[Span::new("Wam", 20.0).font(f)], f, &base);
        let style = TextBlockStyle {
            lh_mode: 0,
            optical_size: 32.0,
            width_axis: 75.0,
            ..base
        };
        let (g1, _) = glyph_outlines(&m, &[Span::new("Wam", 20.0).font(f)], f, &style);
        assert_eq!(g0.len(), g1.len(), "axes are safe no-ops on static faces");
    }

    /// Paragraph spacing separates paragraphs (after every \n line but the
    /// last); a single line never gains padding.
    #[test]
    fn paragraph_spacing_between_paragraphs_only() {
        let m = fonts();
        let f = m.default_font().unwrap();
        let style = |ps| TextBlockStyle {
            lh_mode: 0,
            max_width: 10_000.0,
            line_height: 1.0,
            align: Align::Left,
            wrap: x_core::TextWrap::Auto,
            paragraph_spacing: ps,
            baseline_shift: 0.0,
            small_caps: false,
            optical_size: 0.0,
            width_axis: 0.0,
            max_lines: None,
            paragraph_indent: 0.0,
            decoration: x_core::TextDecoration::None,
        };
        let (_, h_single0) = glyph_outlines(&m, &[Span::new("one", 20.0).font(f)], f, &style(0.0));
        let (_, h_single1) = glyph_outlines(&m, &[Span::new("one", 20.0).font(f)], f, &style(40.0));
        assert!(
            (h_single1 - h_single0).abs() < 0.01,
            "no pad after last line"
        );
        let (_, h_two0) =
            glyph_outlines(&m, &[Span::new("one\ntwo", 20.0).font(f)], f, &style(0.0));
        let (_, h_two1) =
            glyph_outlines(&m, &[Span::new("one\ntwo", 20.0).font(f)], f, &style(40.0));
        assert!(
            (h_two1 - h_two0 - 40.0).abs() < 0.01,
            "{h_two0} vs {h_two1}"
        );
    }

    /// Baseline shift raises glyph outlines without changing block height.
    #[test]
    fn baseline_shift_moves_glyphs_up() {
        let m = fonts();
        let f = m.default_font().unwrap();
        let style = |bs| TextBlockStyle {
            lh_mode: 0,
            max_width: 10_000.0,
            line_height: 1.0,
            align: Align::Left,
            wrap: x_core::TextWrap::Auto,
            paragraph_spacing: 0.0,
            baseline_shift: bs,
            small_caps: false,
            optical_size: 0.0,
            width_axis: 0.0,
            max_lines: None,
            paragraph_indent: 0.0,
            decoration: x_core::TextDecoration::None,
        };
        let (g0, h0) = glyph_outlines(&m, &[Span::new("Hy", 20.0).font(f)], f, &style(0.0));
        let (g1, h1) = glyph_outlines(&m, &[Span::new("Hy", 20.0).font(f)], f, &style(6.0));
        assert!((h0 - h1).abs() < 0.01, "height unchanged");
        let ty_of = |g: &OutlineGlyph| g.transform.as_coeffs()[5];
        let ty0 = g0.iter().map(ty_of).fold(f64::MAX, f64::min);
        let ty1 = g1.iter().map(ty_of).fold(f64::MAX, f64::min);
        assert!(
            (ty1 - ty0 + 6.0).abs() < 0.05,
            "glyphs raised by 6 ({ty0} -> {ty1})"
        );
    }

    /// Family/weight face resolution: bundled stems ("Inter-400") resolve
    /// from the bare family, and weight picks the matching instance.
    #[test]
    fn resolve_family_and_weight() {
        let mut m = FontManager::new();
        let dir = "../../apps/x-designer/assets/fonts";
        let loaded = m
            .load_file("Inter-400", &format!("{dir}/Inter-400.ttf"))
            .is_ok()
            && m.load_file("Inter-500", &format!("{dir}/Inter-500.ttf"))
                .is_ok()
            && m.load_file("Inter-600", &format!("{dir}/Inter-600.ttf"))
                .is_ok()
            && m.load_file("Inter-700", &format!("{dir}/Inter-700.ttf"))
                .is_ok();
        if !loaded {
            // the bundle is present in-repo; only skip if genuinely missing
            assert!(
                !std::path::Path::new(dir).exists(),
                "Inter bundle missing from {dir}"
            );
            return;
        }
        // bare family -> some Inter instance
        assert!(m.resolve_font_name("Inter").is_some());
        // weight -> the exact instance when registered
        let semi = m.resolve_face("Inter", 600).expect("600 resolves");
        assert_eq!(semi, m.font_index("Inter-600").unwrap());
        // missing weight falls back to a family face, never a panic
        let _ = m.resolve_face("Inter", 450);
        // unknown family -> None (caller falls back to default)
        assert_eq!(m.resolve_face("Nope", 400), None);
        assert_eq!(m.resolve_font_name("Nope"), None);
    }

    /// Center/Right placement shifts every line by the expected offset;
    /// Left stays at the origin (the shipped pixel contract, unchanged).
    #[test]
    fn align_centers_and_right_sets_lines() {
        let m = fonts();
        let f = m.default_font().unwrap();
        let spans = [Span::new("Alignment", 24.0)];
        let style = |a: Align| TextBlockStyle {
            align: a,
            max_width: 400.0,
            ..Default::default()
        };
        let (gl, _) = glyph_outlines(&m, &spans, f, &style(Align::Left));
        let (gc, _) = glyph_outlines(&m, &spans, f, &style(Align::Center));
        let (gr, _) = glyph_outlines(&m, &spans, f, &style(Align::Right));
        let mut sh = Shaper::new(&m);
        let w = layout_lines(&mut sh, &spans, f, 400.0)[0].width;
        let xl = gl[0].transform.translation().x;
        let xc = gc[0].transform.translation().x;
        let xr = gr[0].transform.translation().x;
        assert!(xl < 1.0, "left starts at the origin: {xl}");
        assert!(
            (xc - xl - (400.0 - w) / 2.0).abs() < 0.5,
            "center offset {xc}"
        );
        assert!((xr - xl - (400.0 - w)).abs() < 0.5, "right offset {xr}");
    }

    /// max-lines drops lines beyond the cap; the returned height covers
    /// exactly the lines that were emitted.
    #[test]
    fn max_lines_caps_the_block() {
        let m = fonts();
        let f = m.default_font().unwrap();
        let f0 = &m.fonts[f];
        let spans = [Span::new("one\ntwo\nthree\nfour\nfive", 24.0)];
        let full = TextBlockStyle {
            max_width: 400.0,
            ..Default::default()
        };
        let capped = TextBlockStyle {
            max_lines: Some(2),
            max_width: 400.0,
            ..Default::default()
        };
        let (g5, h5) = glyph_outlines(&m, &spans, f, &full);
        let (g2, h2) = glyph_outlines(&m, &spans, f, &capped);
        assert!(h2 < h5, "capped block is shorter ({h2} < {h5})");
        assert!(g2.len() < g5.len(), "capped block has fewer glyphs");
        // the default style's line box is natural * 1.2
        let nat = (f0.ascent - f0.descent + f0.line_gap) * (24.0 / f0.units_per_em);
        assert!(
            (h2 - 2.0 * nat * 1.2).abs() < 0.5,
            "height = 2 line boxes: {h2}"
        );
    }

    /// Paragraph indent shifts the FIRST line of each paragraph only —
    /// wrapped continuation lines stay at the margin. Paragraph 1 is long
    /// enough to always wrap at 150px; paragraph 2 is a short single line,
    /// so the first and last baselines are paragraph-first lines and every
    /// baseline between them is a continuation (font-robust).
    #[test]
    fn paragraph_indent_shifts_paragraph_first_lines() {
        let m = fonts();
        let f = m.default_font().unwrap();
        let text = "one two three four five six seven eight nine ten eleven twelve\nzz";
        let spans = [Span::new(text, 24.0)];
        let mk = |indent: f64| TextBlockStyle {
            max_width: 150.0,
            paragraph_indent: indent,
            ..Default::default()
        };
        let (plain, _) = glyph_outlines(&m, &spans, f, &mk(0.0));
        let (ind, _) = glyph_outlines(&m, &spans, f, &mk(30.0));
        // per-baseline minimum x
        let minx = |glyphs: &[OutlineGlyph]| -> Vec<(f64, f64)> {
            let mut acc: Vec<(f64, f64)> = vec![];
            for g in glyphs {
                let (x, y) = (g.transform.translation().x, g.transform.translation().y);
                match acc.iter_mut().find(|(by, _)| (by - y).abs() < 0.1) {
                    Some(e) if x < e.1 => e.1 = x,
                    Some(_) => {}
                    None => acc.push((y, x)),
                }
            }
            acc.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            acc
        };
        let a = minx(&plain);
        let b = minx(&ind);
        assert_eq!(a.len(), b.len(), "indent must not change wrapping");
        assert!(a.len() >= 3, "paragraph 1 must wrap: {} lines", a.len());
        assert!(
            (b[0].1 - a[0].1 - 30.0).abs() < 0.5,
            "para 1 first line +30"
        );
        assert!(
            (b[a.len() - 1].1 - a[a.len() - 1].1 - 30.0).abs() < 0.5,
            "para 2 first line +30"
        );
        for i in 1..a.len() - 1 {
            assert!((b[i].1 - a[i].1).abs() < 0.5, "wrapped line {i} unchanged");
        }
    }

    /// Decoration adds exactly one rect per line, in the line's ink colour:
    /// the underline below the baseline, the strike through it.
    #[test]
    fn decoration_draws_one_rect_per_line() {
        let m = fonts();
        let f = m.default_font().unwrap();
        let f0 = &m.fonts[f];
        let spans = [Span::new("Underline me", 24.0)];
        let base = TextBlockStyle {
            max_width: 400.0,
            ..Default::default()
        };
        let under = TextBlockStyle {
            max_width: 400.0,
            decoration: x_core::TextDecoration::Underline,
            ..Default::default()
        };
        let strike = TextBlockStyle {
            max_width: 400.0,
            decoration: x_core::TextDecoration::Strikethrough,
            ..Default::default()
        };
        let (g0, _) = glyph_outlines(&m, &spans, f, &base);
        let (gu, _) = glyph_outlines(&m, &spans, f, &under);
        let (gs, _) = glyph_outlines(&m, &spans, f, &strike);
        assert_eq!(gu.len(), g0.len() + 1, "one extra rect for one line");
        assert_eq!(gs.len(), g0.len() + 1);
        // default-style first baseline: softened ascent at the 1.2 box
        let baseline = f0.ascent * (24.0 / f0.units_per_em) * 1.2;
        let bb_u = gu[g0.len()].path.bounding_box();
        let bb_s = gs[g0.len()].path.bounding_box();
        assert!(bb_u.min_y() > baseline, "underline sits below the baseline");
        assert!(bb_s.max_y() < baseline, "strike sits above the baseline");
        assert!(
            bb_u.max_y() - bb_u.min_y() >= 1.0,
            "underline has thickness"
        );
    }

    fn fonts() -> FontManager {
        let mut m = FontManager::new();
        m.load_system_fonts();
        // add scripts beyond the default dir
        let _ = m.load_file(
            "NotoSansArabic",
            "/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf",
        );
        let _ = m.load_file(
            "NotoKufiArabic",
            "/usr/share/fonts/truetype/noto/NotoKufiArabic-Regular.ttf",
        );
        assert!(!m.fonts.is_empty(), "system fonts required");
        m
    }

    #[test]
    fn ligatures_reduce_glyph_count() {
        let m = fonts();
        let f = m.default_font().unwrap();
        let mut sh = Shaper::new(&m);
        // DejaVu has an fi ligature via GSUB
        let runs = sh.shape_span(&Span::new("fi", 16.0), f);
        let n_fi: usize = runs.iter().map(|r| r.glyphs.len()).sum();
        let runs = sh.shape_span(&Span::new("f i", 16.0), f);
        let n_f_i: usize = runs.iter().map(|r| r.glyphs.len()).sum();
        assert!(n_fi < n_f_i, "'fi' should ligate: {n_fi} vs {n_f_i} glyphs");
        assert_eq!(n_fi, 1, "DejaVu ligates fi into one glyph");
    }

    #[test]
    fn kerning_applies_via_gpos_or_kern() {
        let m = fonts();
        let f = m.default_font().unwrap();
        let mut sh = Shaper::new(&m);
        let w_av: f64 = sh
            .shape_span(&Span::new("AV", 32.0), f)
            .iter()
            .map(|r| r.width)
            .sum();
        let w_a: f64 = sh
            .shape_span(&Span::new("A", 32.0), f)
            .iter()
            .map(|r| r.width)
            .sum();
        let w_v: f64 = sh
            .shape_span(&Span::new("V", 32.0), f)
            .iter()
            .map(|r| r.width)
            .sum();
        assert!(
            w_av < w_a + w_v - 0.1,
            "AV must kern tighter: {w_av} vs {}",
            w_a + w_v
        );
    }

    #[test]
    fn arabic_shapes_rtl_with_joining_forms() {
        let m = fonts();
        let arabic = m
            .font_index("NotoSansArabic")
            .or(m.font_index("NotoKufiArabic"));
        let Some(af) = arabic else { return }; // env without arabic fonts: skip
        let mut sh = Shaper::new(&m);
        // "سلام" (salaam) — 4 letters that join contextually
        let runs = sh.shape_span(&Span::new("سلام", 24.0).font(af), af);
        assert_eq!(runs.len(), 1);
        assert!(runs[0].rtl, "Arabic run must be RTL");
        // joining: shaped glyph count <= char count, and NOT the isolated forms
        let isolated: Vec<u16> = "سلام"
            .chars()
            .map(|c| m.fonts[af].glyph_id(c).unwrap_or(0))
            .collect();
        let shaped: Vec<u16> = runs[0].glyphs.iter().map(|g| g.glyph_id).collect();
        assert_ne!(
            shaped, isolated,
            "contextual forms must differ from isolated cmap forms"
        );
    }

    #[test]
    fn mixed_ltr_rtl_splits_into_directional_runs() {
        let m = fonts();
        let Some(_af) = m.font_index("NotoSansArabic") else {
            return;
        };
        let f = m.default_font().unwrap();
        let mut sh = Shaper::new(&m);
        let runs = sh.shape_span(&Span::new("abc سلام xyz", 16.0), f);
        assert!(
            runs.len() >= 3,
            "LTR/RTL/LTR should split: got {} runs",
            runs.len()
        );
        assert!(runs.iter().any(|r| r.rtl) && runs.iter().any(|r| !r.rtl));
    }

    #[test]
    fn fallback_picks_covering_font_per_run() {
        let m = fonts();
        let Some(af) = m.font_index("NotoSansArabic") else {
            return;
        };
        let latin = m.default_font().unwrap();
        let sh = Shaper::new(&m);
        // The picked font must COVER the text. (DejaVu itself covers
        // Arabic, so staying put is legal; what matters is coverage.)
        let picked = sh.pick_font("سلام", latin);
        let covers = "سلام"
            .chars()
            .all(|c| m.fonts[picked].glyph_id(c).is_some_and(|g| g != 0));
        assert!(covers, "picked font must cover Arabic");
        assert_eq!(sh.pick_font("hello", latin), latin);
        // A font with NO coverage of the text must be abandoned:
        // shape emoji-ish/unknown chars against a tiny fake preference.
        let mono = m.font_index("DejaVuSansMono").unwrap_or(latin);
        let picked2 = sh.pick_font("سلام", mono);
        let covers2 = "سلام"
            .chars()
            .all(|c| m.fonts[picked2].glyph_id(c).is_some_and(|g| g != 0));
        assert!(
            covers2,
            "fallback from non-covering font must find coverage"
        );
        let _ = af;
    }

    #[test]
    fn cjk_breaks_between_ideographs() {
        let ops = break_opportunities("設計工具");
        // 4 ideographs -> break opportunity before each following char
        assert!(ops.len() >= 3, "CJK chars must each be breakable: {ops:?}");
        let ops = break_opportunities("hello world");
        assert_eq!(ops, vec![6], "latin breaks after the space");
    }

    #[test]
    fn letter_spacing_and_line_height_apply() {
        let m = fonts();
        let f = m.default_font().unwrap();
        let mut sh = Shaper::new(&m);
        let w0: f64 = sh
            .shape_span(&Span::new("spacing", 16.0), f)
            .iter()
            .map(|r| r.width)
            .sum();
        let w5: f64 = sh
            .shape_span(&Span::new("spacing", 16.0).letter_spacing(5.0), f)
            .iter()
            .map(|r| r.width)
            .sum();
        assert!((w5 - w0 - 7.0 * 5.0).abs() < 0.5, "7 chars x 5px spacing");
        // line height scales block height
        let mut sc = Scene::new();
        let style1 = TextBlockStyle {
            lh_mode: 0,
            max_width: 10_000.0,
            line_height: 1.0,
            align: Align::Left,
            wrap: x_core::TextWrap::Auto,
            ..Default::default()
        };
        let style2 = TextBlockStyle {
            lh_mode: 0,
            max_width: 10_000.0,
            line_height: 2.0,
            align: Align::Left,
            wrap: x_core::TextWrap::Auto,
            ..Default::default()
        };
        let (_, h1) = encode_rich_text(
            &mut sc,
            &m,
            &[Span::new("a\nb", 16.0)],
            f,
            Affine::IDENTITY,
            &style1,
        );
        let (_, h2) = encode_rich_text(
            &mut sc,
            &m,
            &[Span::new("a\nb", 16.0)],
            f,
            Affine::IDENTITY,
            &style2,
        );
        assert!(
            (h2 / h1 - 2.0).abs() < 0.01,
            "double line-height doubles block height"
        );
    }

    #[test]
    fn rich_text_spans_layout_and_wrap_with_real_shaping() {
        let m = fonts();
        let f = m.default_font().unwrap();
        let spans = vec![
            Span::new("Bold-ish heading ", 20.0).color(Color::from_rgb8(255, 0, 0)),
            Span::new("then body text that definitely wraps across lines", 12.0),
        ];
        let mut sh = Shaper::new(&m);
        let lines = layout_lines(&mut sh, &spans, f, 150.0);
        assert!(lines.len() >= 3, "must wrap: got {} lines", lines.len());
        for line in &lines {
            assert!(line.width <= 150.0 + 1.0, "line overflows: {}", line.width);
        }
        // encode: paths appear, mixed colors preserved
        let mut sc = Scene::new();
        let style = TextBlockStyle {
            lh_mode: 0,
            max_width: 150.0,
            line_height: 1.2,
            align: Align::Left,
            wrap: x_core::TextWrap::Auto,
            ..Default::default()
        };
        let (paths, h) = encode_rich_text(&mut sc, &m, &spans, f, Affine::IDENTITY, &style);
        assert!(paths > 30, "many glyphs: {paths}");
        assert!(h > 40.0, "multi-line block height: {h}");
    }

    #[test]
    fn balance_evens_lines_and_keeps_count() {
        let m = fonts();
        let Some(f) = m.default_font() else { return };
        let mut sh = Shaper::new(&m);
        let words = [
            "one", "two", "three", "four", "five", "six", "seven", "eight",
        ];
        // width of the first five words on one line (measured, not guessed)
        let mut wline = |n: usize| {
            layout_lines(
                &mut sh,
                &[Span::new(&format!("{} ", words[..n].join(" ")), 16.0)],
                f,
                10_000.0,
            )[0]
            .width
        };
        // greedy at exactly "five words incl. their trailing space"
        // puts 5 on line 1 and leaves a 3-word tail: 5/3 split
        let w = wline(5);
        let auto = layout_lines(&mut sh, &[Span::new(&words.join(" "), 16.0)], f, w);
        assert_eq!(auto.len(), 2, "greedy 5/3 split at this width");

        let bal = layout_lines_wrapped(
            &mut sh,
            &[Span::new(&words.join(" "), 16.0)],
            f,
            w,
            x_core::TextWrap::Balance,
        );
        assert_eq!(bal.len(), 2, "balance keeps the line count");
        assert!(
            bal[0].width < auto[0].width - 5.0,
            "first line sheds words: {} vs {}",
            bal[0].width,
            auto[0].width
        );
        assert!(
            bal[1].width > auto[1].width + 5.0,
            "tail line gains words: {} vs {}",
            bal[1].width,
            auto[1].width
        );
        // and stays inside the box
        assert!(bal.iter().all(|l| l.width <= w + 0.01));
    }

    #[test]
    fn pretty_rescues_a_widowed_word() {
        let m = fonts();
        let Some(f) = m.default_font() else { return };
        let mut sh = Shaper::new(&m);
        let words = [
            "aa", "bb", "cc", "dd", "ee", "ff", "gg", "hh", "ii", "jj", "kk", "ll", "mm",
        ];
        let mut wline = |n: usize| {
            layout_lines(
                &mut sh,
                &[Span::new(&format!("{} ", words[..n].join(" ")), 16.0)],
                f,
                10_000.0,
            )[0]
            .width
        };
        // width that fits 12 of 13 words on the first line -> the last
        // word strands alone (a widow)
        let w = wline(12);
        let auto = layout_lines(&mut sh, &[Span::new(&words.join(" "), 16.0)], f, w);
        assert_eq!(auto.len(), 2, "two lines at this width");
        let pretty = layout_lines_wrapped(
            &mut sh,
            &[Span::new(&words.join(" "), 16.0)],
            f,
            w,
            x_core::TextWrap::Pretty,
        );
        assert_eq!(pretty.len(), 2, "pretty keeps the line count");
        assert!(
            visible_pieces(&pretty[1]) >= 2,
            "widow gains a neighbor: {:?}",
            pretty[1].spans
        );
        assert!(pretty.iter().all(|l| l.width <= w + 0.01));
    }

    #[test]
    fn balance_and_pretty_key_the_cache_differently() {
        let m = fonts();
        let Some(f) = m.default_font() else { return };
        let mut sh = Shaper::new(&m);
        let spans = [Span::new("one two three four five six", 16.0)];
        let a = layout_lines_wrapped(&mut sh, &spans, f, 120.0, x_core::TextWrap::Balance);
        let b = layout_lines_wrapped(&mut sh, &spans, f, 120.0, x_core::TextWrap::Auto);
        assert!(!a.is_empty() && !b.is_empty());
    }

    #[test]
    fn alignment_positions_lines() {
        let m = fonts();
        let f = m.default_font().unwrap();
        let mut sh = Shaper::new(&m);
        let lines = layout_lines(&mut sh, &[Span::new("hi", 16.0)], f, 300.0);
        assert_eq!(lines.len(), 1);
        // encode with center/right must not panic and produce same path count
        for align in [Align::Left, Align::Center, Align::Right] {
            let mut sc = Scene::new();
            let style = TextBlockStyle {
                lh_mode: 0,
                max_width: 300.0,
                line_height: 1.0,
                align,
                wrap: x_core::TextWrap::Auto,
                ..Default::default()
            };
            let (p, _) = encode_rich_text(
                &mut sc,
                &m,
                &[Span::new("hi", 16.0)],
                f,
                Affine::IDENTITY,
                &style,
            );
            assert_eq!(p, 2);
        }
    }
}
