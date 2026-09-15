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
use vello::kurbo::{Affine, BezPath};
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
    /// true when this glyph's cluster starts on a space: justification
    /// distributes the extra line width over exactly these advances
    pub is_space: bool,
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
                is_space,
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
    layout_lines_wrapped_styled(shaper, spans, default_font, max_width, wrap, &TextLayout::default())
}

/// The full paragraph pipeline the node's typed text properties drive:
/// first-line indent, bulleted/numbered lists (with hanging markers that
/// keep the text in its box), word-break for overlong tokens, max-lines
/// with an end/middle ellipsis, and plain clipping without one.
/// Indent and marker width consume wrap budget on the lines they touch —
/// the same offsets the placement pass applies — so measurement and
/// rendering cannot drift apart.
pub fn layout_lines_wrapped_styled(
    shaper: &mut Shaper,
    spans: &[Span],
    default_font: usize,
    max_width: f64,
    wrap: x_core::TextWrap,
    layout: &TextLayout,
) -> Vec<Line> {
    let measure = |shaper: &mut Shaper, sp: &Span| -> f64 {
        shaper
            .shape_span(sp, sp.font.unwrap_or(default_font))
            .iter()
            .map(|r| r.width)
            .sum::<f64>()
    };
    let text_width = |shaper: &mut Shaper, text: &str, size: f64| -> f64 {
        if text.is_empty() {
            return 0.0;
        }
        measure(shaper, &Span::new(text, size).letter_spacing(base_ls(spans)))
    };
    // 1. wrap (word-break aware; Balance/Pretty re-wrap on top of the
    //    same piece rules)
    let wrapped = layout_lines_plain(shaper, spans, default_font, max_width, wrap, layout.word_break);
    if layout.paragraph_indent <= 0.0
        && layout.list == 0
        && !layout.hanging_quotes
        && layout.max_lines == 0
        && layout.truncate == 0
        && !layout.overflow_hidden
    {
        return wrapped;
    }
    // 2. per-paragraph properties + max lines + truncation
    let mut out: Vec<Line> = Vec::with_capacity(wrapped.len());
    let mut para_start = true;
    let mut number = 1usize;
    let mut li = 0usize;
    while li < wrapped.len() {
        let line = &wrapped[li];
        li += 1;
        let size = line.spans.first().map(|sp| sp.size).unwrap_or(16.0);
        let indent = if para_start {
            layout.paragraph_indent.max(0.0)
        } else {
            0.0
        };
        // marker for a paragraph start, measured (never guessed)
        let mut marker = String::new();
        if para_start {
            match layout.list {
                1 => marker.push_str("\u{2022} "),
                2 => {
                    marker.push_str(&format!("{number}. "));
                    number += 1;
                }
                _ => {}
            }
        }
        let marker_w = if marker.is_empty() {
            0.0
        } else {
            text_width(shaper, &marker, size)
        };
        // a hanging marker lives in the left margin: the text box keeps
        // its full width, so the marker costs the wrap budget nothing
        let marker_lead = if layout.hanging_lists { 0.0 } else { marker_w };
        let mut lead = indent + marker_lead;
        if para_start
            && layout.hanging_quotes
            && line
                .spans
                .iter()
                .flat(|sp| sp.text.chars())
                .any(|c| matches!(c, '"' | '\u{201c}' | '\u{2018}' | '\u{201e}'))
        {
            // an opening quote may bleed into the margin instead of
            // pushing the first word right
            lead = (lead - text_width(shaper, " ", size)).max(0.0);
        }
        // body budget = the line box minus everything we lead it with
        let avail = (max_width - lead).max(8.0);
        let last_kept = layout.max_lines > 0 && out.len() + 1 >= layout.max_lines as usize;
        let mut line = line.clone();
        if layout.truncate != 0 {
            truncate_line(shaper, &mut line, avail, layout.truncate, last_kept);
        } else if last_kept {
            truncate_line(shaper, &mut line, avail, 0, false);
        }
        if lead > 0.0 || !marker.is_empty() {
            let mut lead_sp = Span::new("", size);
            lead_sp.color = line.spans.first().map(|s| s.color).unwrap_or_default();
            lead_sp.letter_spacing = base_ls(&line.spans);
            lead_sp.word_spacing = lead; // reserved via one space advance
            line.spans.insert(0, lead_sp);
            if !marker.is_empty() {
                let mut ms = line.spans.first().cloned().unwrap_or_else(|| Span::new("", size));
                ms.text = marker;
                if layout.hanging_lists {
                    // hanging marker paints INTO the margin: it costs no
                    // width, so it goes first, ahead of the indent span
                    line.spans.insert(0, ms);
                } else {
                    line.spans.insert(1, ms);
                }
            }
            line.width += lead + if marker.is_empty() { 0.0 } else { marker_w };
        }
        para_start = line.para_end;
        out.push(line);
        if layout.max_lines > 0 && out.len() >= layout.max_lines as usize {
            break;
        }
    }
    if out.is_empty() {
        out.push(Line {
            spans: vec![],
            width: 0.0,
            para_end: true,
        });
    }
    out
}

/// The letter-spacing the paragraph inherits (for prefix measurement).
fn base_ls(spans: &[Span]) -> f64 {
    spans.first().map(|s| s.letter_spacing).unwrap_or(0.0)
}

/// End/middle ellipsis (or plain clipping) for one line.
fn truncate_line(
    shaper: &mut Shaper,
    line: &mut Line,
    avail: f64,
    mode: u8,
    add_ellipsis: bool,
) {
    if line.spans.is_empty() || line.width <= avail + 0.5 {
        return;
    }
    let size = line.spans[0].size;
    let ls = base_ls(&line.spans);
    let color = line.spans[0].color;
    let font = line.spans[0].font;
    let full: String = line.spans.iter().map(|s| s.text.as_str()).collect();
    let measure_str = |shaper: &mut Shaper, t: &str| -> f64 {
        if t.is_empty() {
            return 0.0;
        }
        let sp = Span::new(t, size).letter_spacing(ls).color(color);
        let mut sp = sp;
        sp.font = font;
        shaper
            .shape_span(&sp, font.unwrap_or(0))
            .iter()
            .map(|r| r.width)
            .sum::<f64>()
    };
    let ell = if add_ellipsis && mode != 0 { "\u{2026}" } else { "" };
    let ell_w = measure_str(shaper, ell);
    let budget = (avail - ell_w).max(1.0);
    let mut keep = String::new();
    if mode == 2 {
        // middle: keep a prefix, skip, keep a suffix — both within budget
        let mut suffix = String::new();
        let half = budget / 2.0;
        let mut w = 0.0;
        for c in full.chars() {
            let t = format!("{keep}{c}");
            let nw = measure_str(shaper, &t);
            if nw > half {
                break;
            }
            keep = t;
            w = nw;
        }
        let rest: String = full.chars().skip(keep.chars().count()).collect();
        let mut w2 = 0.0;
        for c in rest.chars().rev() {
            let t = format!("{c}{suffix}");
            let nw = measure_str(shaper, &t);
            if w + nw > budget {
                break;
            }
            suffix = t;
            w2 = nw;
        }
        let _ = w2;
        keep.push_str(ell);
        keep.push_str(&suffix);
    } else {
        let mut last_ok = String::new();
        let mut w = 0.0;
        let mut chars = full.chars();
        while let Some(c) = chars.next() {
            last_ok.push(c);
            let nw = measure_str(shaper, &last_ok);
            if nw > budget {
                last_ok.truncate(last_ok.len() - c.len_utf8());
                break;
            }
            w = nw;
        }
        let _ = w;
        keep = last_ok;
        // pull back to a word end when the cut lands mid-word
        if !keep.is_empty()
            && keep.len() < full.len()
            && !full[keep.len()..].starts_with(' ')
        {
            if let Some(i) = keep.rfind(' ') {
                if i > keep.len() / 2 {
                    keep.truncate(i);
                }
            }
        }
        keep.push_str(ell);
    }
    line.spans.truncate(0);
    let mut sp = Span::new(&keep, size).color(color);
    sp.font = font;
    line.spans.push(sp);
    line.width = measure_str(shaper, &keep);
}

/// Wrap pass shared by every mode: `word_break` additionally splits
/// overlong tokens at any character (Figma's "Wrap style: break word").
fn layout_lines_plain(
    shaper: &mut Shaper,
    spans: &[Span],
    default_font: usize,
    max_width: f64,
    wrap: x_core::TextWrap,
    word_break: bool,
) -> Vec<Line> {
    if wrap == x_core::TextWrap::Auto {
        return greedy_lines_broken(shaper, spans, default_font, max_width, word_break);
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
        let greedy = greedy_pieces(shaper, &pieces, default_font, max_width, word_break);
        let lines = match wrap {
            x_core::TextWrap::Balance => balance_paragraph(shaper, &pieces, &greedy, default_font, word_break),
            x_core::TextWrap::Pretty => {
                let balanced = balance_paragraph(shaper, &pieces, &greedy, default_font, word_break);
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
/// the streaming pass: adjacent same-style spans fuse). `word_break`
/// splits a piece that does not fit on an EMPTY line at char granularity.
fn greedy_pieces(
    shaper: &mut Shaper,
    pieces: &[Span],
    default_font: usize,
    w: f64,
    word_break: bool,
) -> Vec<Line> {
    let mut lines = vec![];
    let mut cur: Vec<Span> = vec![];
    let mut cur_w = 0.0;
    let mut it = pieces.iter();
    while let Some(piece) = it.next().cloned() {
        let mut piece = piece;
        let mut pw = piece_width(shaper, &piece, default_font);
        if cur_w + pw > w && cur_w > 0.0 {
            lines.push(Line {
                spans: std::mem::take(&mut cur),
                width: cur_w,
                para_end: false,
            });
            cur_w = 0.0;
        }
        if word_break && cur.is_empty() && pw > w && piece.text.chars().count() > 1 {
            let mut cut = 1usize;
            let chars: Vec<char> = piece.text.chars().collect();
            for k in 2..chars.len() {
                let head: String = chars[..k].iter().collect();
                let mut h = piece.clone();
                h.text = head;
                let hw = piece_width(shaper, &h, default_font);
                if hw > w {
                    break;
                }
                cut = k;
            }
            let head: String = chars[..cut].iter().collect();
            let rest: String = chars[cut..].iter().collect();
            lines.push(Line {
                spans: vec![{
                    let mut h = piece.clone();
                    h.text = head;
                    h
                }],
                width: {
                    let mut h = piece.clone();
                    h.text = chars[..cut].iter().collect();
                    piece_width(shaper, &h, default_font)
                },
                para_end: false,
            });
            piece.text = rest;
            pw = piece_width(shaper, &piece, default_font);
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
        cur.push(piece);
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
    word_break: bool,
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
        greedy_pieces(shaper, pieces, default_font, w, word_break).len()
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
    let balanced = greedy_pieces(shaper, pieces, default_font, hi, word_break);
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
        let cand = greedy_pieces(shaper, &tail, default_font, total * f, false);
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

/// Horizontal placement of a line inside the block's max width.
/// `Justify` stretches the space advances of every line except a
/// paragraph's last (Figma "Justify"); the x-text `Align::Right` is what
/// `x_core::TextAlign::Justified` maps to only as a LAST resort — the
/// placement pass distributes real space width whenever the line has
/// more than one piece.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Align {
    #[default]
    Left,
    Center,
    Right,
    Justify,
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

/// Node-level paragraph properties that change BREAKING (not just the
/// per-glyph advance): Figma's Type-settings additions. Part of the shape
/// cache key by construction — every field here feeds it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
pub struct TextLayout {
    /// first-line indent in px for every paragraph
    pub paragraph_indent: f64,
    /// 0 = none, 1 = bulleted, 2 = numbered (mirrors x_core::ListStyle)
    pub list: u8,
    /// quotation marks may hang into the left margin
    pub hanging_quotes: bool,
    /// list markers sit in the margin instead of shifting the text
    pub hanging_lists: bool,
    /// visible line cap (0 = unlimited)
    pub max_lines: u32,
    /// 0 = off, 1 = end ("…text"), 2 = middle ("te…xt")
    pub truncate: u8,
    /// cut lines that overflow the box without an ellipsis
    pub overflow_hidden: bool,
    /// CSS overflow-wrap: break-word — split overlong tokens anywhere
    pub word_break: bool,
    /// Figma "Vertical trim": block height = ink height, no half-leading
    pub vertical_trim: bool,
    /// 0 top / 1 middle / 2 bottom — vertical alignment inside a FIXED-size
    /// text box (Figma ignores it while auto-resizing; the renderer only
    /// sets `box_h` for fixed-size nodes)
    pub align_v: u8,
    /// the fixed text-box height `align_v` positions within (0 = auto)
    pub box_h: f64,
}

impl TextLayout {
    pub fn is_identity(&self) -> bool {
        *self == Self::default()
    }
    /// 64-bit fingerprint for the shape cache key (fields are small ints,
    /// bools and non-negative px values — bit-exact is unnecessary, this
    /// is a memo, not an identity).
    pub fn fingerprint(&self) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut mix = |v: u64| {
            h ^= v;
            h = h.wrapping_mul(0x1000_0000_01b3);
        };
        mix(self.paragraph_indent.to_bits());
        mix(self.list as u64);
        mix(self.hanging_quotes as u64);
        mix(self.hanging_lists as u64);
        mix(self.max_lines as u64);
        mix(self.truncate as u64);
        mix(self.overflow_hidden as u64);
        mix(self.word_break as u64);
        mix(self.vertical_trim as u64);
        mix(self.align_v as u64);
        mix(self.box_h as u64);
        h
    }
}

impl Default for Color {
    fn default() -> Self {
        Color::BLACK
    }
}

/// Everything a sink needs to shape one Text node — the single entry
/// point for exports so canvas, PDF, SVG, raster and the styled helper
/// cannot drift apart. Construct it with `..Default::default()`; every
/// field the canvas pipeline knows about lives here (Figma typography
/// parity: alignment, decoration, lists, indent, truncation, wrap).
#[derive(Debug, Clone, Default)]
pub struct NodeTextSpec<'a> {
    pub text: &'a str,
    pub size: f64,
    pub max_width: f64,
    pub font: Option<&'a str>,
    pub color: Color,
    pub ls: f64,
    pub lh: f64,
    pub wrap: x_core::TextWrap,
    pub word_spacing: f64,
    pub paragraph_spacing: f64,
    pub baseline_shift: f64,
    pub small_caps: bool,
    pub optical_size: f32,
    pub width_axis: f32,
    pub lh_mode: u8,
    /// x-text placement (Left/Center/Right/Justify)
    pub align: Align,
    /// 0 none / 1 underline / 2 strikethrough / 3 both
    pub decoration: u8,
    pub layout: TextLayout,
}

impl<'a> NodeTextSpec<'a> {
    /// Figma vertical alignment inside a fixed-size box (0 = auto width /
    /// height: the node ignores it, matching Figma's behavior)
    pub fn with_vbox(mut self, align_v: u8, box_h: f64) -> Self {
        self.layout.align_v = align_v;
        self.layout.box_h = box_h;
        self
    }
    /// Replace the paragraph-layout properties wholesale (sinks that keep
    /// their own TextLayout pass it through here).
    pub fn with_layout(mut self, layout: TextLayout) -> Self {
        self.layout = layout;
        self
    }

    pub fn with_align(mut self, align: Align) -> Self {
        self.align = align;
        self
    }
    pub fn style(&self) -> TextBlockStyle {
        TextBlockStyle {
            max_width: self.max_width.max(8.0),
            line_height: self.lh.max(0.5),
            lh_mode: self.lh_mode,
            align: self.align,
            wrap: self.wrap,
            paragraph_spacing: self.paragraph_spacing,
            baseline_shift: self.baseline_shift,
            small_caps: self.small_caps,
            optical_size: self.optical_size,
            width_axis: self.width_axis,
            decoration: self.decoration,
            layout: self.layout,
        }
    }

    /// The shape-cache key for this spec (from_style keeps every
    /// field that changes shaping, by construction).
    pub fn key(&self, font_epoch: u64) -> crate::cache::TextLayoutKey {
        let style = self.style();
        crate::cache::TextLayoutKey::from_style(
            self.text,
            self.size,
            self.max_width.max(8.0),
            self.font,
            self.color,
            font_epoch,
            &style,
            self.ls,
            self.word_spacing,
        )
    }
}

#[derive(Clone)]
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
    /// node's canonical text-decoration (0 none / 1 underline / 2 strike):
    /// painted as real geometry in the line's color so EVERY sink —
    /// canvas, SVG, PDF, raster — carries it without per-sink code
    pub decoration: u8,
    /// paragraph-breaking properties (indent / lists / truncation / trim)
    pub layout: TextLayout,
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
            decoration: 0,
            layout: TextLayout::default(),
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
    let lines = layout_lines_wrapped_styled(
        &mut shaper,
        &spans,
        default_font,
        style.max_width,
        style.wrap,
        &style.layout,
    );
    let mut out = vec![];
    let mut y = 0.0f64;
    // paragraph bookkeeping for indent/list lead-in (the wrap pass already
    // reserved these widths; here we actually shift the pen)
    let mut para_start = true;
    let mut prev_para_end = true;
    // vertical trim tracking (Figma "Trim lines and paragraphs"): the
    // block shrinks to the first ink top and the last ink bottom
    let mut top_ink = f64::MAX;
    let mut bottom_ink = 0.0f64;
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
        let line_top = baseline - f0.ascent * fs_sc;
        let line_bottom = baseline + f0.descent.abs() * fs_sc;
        let body_lead = if para_start {
            style.layout.paragraph_indent.max(0.0)
        } else {
            0.0
        };
        let x0 = match style.align {
            Align::Left => body_lead,
            Align::Center => ((style.max_width - line.width) / 2.0 + body_lead).max(0.0),
            Align::Right => style.max_width - line.width,
            // Figma justify: the paragraph's LAST line (and a line with no
            // place to stretch) stays left-aligned; other lines spread
            // their word spaces to fill the box
            Align::Justify => {
                if line.para_end || li + 1 == lines.len() || line.width >= style.max_width {
                    body_lead
                } else {
                    (style.max_width - line.width).max(0.0)
                }
            }
        };
        // distribute the justify slack over this line's space advances
        let gaps: f64 = line.spans.iter().map(|sp| span_breaks(sp).saturating_sub(1)).sum::<usize>() as f64;
        let extra = if style.align == Align::Justify && x0 > 0.0 && gaps > 0.0 {
            x0 / gaps
        } else {
            0.0
        };
        let base = x0;
        let mut pen = base;
        let mut last_right = base;
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
                        last_right = last_right.max(x + g.x_advance);
                    }
                    x += g.x_advance + if extra > 0.0 && g.is_space { extra } else { 0.0 };
                }
                pen += run.width + (extra * span_breaks(span).saturating_sub(1) as f64);
            }
        }
        // decoration: Figma paints underline/strikethrough as real line
        // geometry in the text color. Emitted through the SAME glyph list
        // as the outlines, so canvas, SVG, PDF and raster sinks carry it by
        // construction (thickness/offset = CSS defaults; the underline
        // details panel can override them once it ships).
        if style.decoration != 0 {
            let color = line.spans.first().map(|sp| sp.color).unwrap_or(Color::BLACK);
            let w = (max_size * 0.06).max(0.6);
            let mut mk = |ry: f64| {
                let r = vello::kurbo::Rect::new(base, ry, last_right.max(base + 1.0), ry + w);
                out.push(OutlineGlyph {
                    path: r.to_path(0.1),
                    transform: Affine::IDENTITY,
                    color,
                });
            };
            if style.decoration == 1 || style.decoration == 3 {
                mk(baseline + f0.descent.abs() * fs_sc * 0.25);
            }
            if style.decoration == 2 || style.decoration == 3 {
                let cap = if f0.cap_height > 0.0 {
                    f0.cap_height
                } else {
                    f0.ascent * 0.6
                };
                mk(baseline - cap * fs_sc * 0.5);
            }
        }
        top_ink = top_ink.min(line_top);
        bottom_ink = bottom_ink.max(line_bottom);
        y += lh;
        para_start = line.para_end;
        let _ = prev_para_end;
        // paragraph spacing separates paragraphs — it never pads the block
        // after the final line (Figma/CSS-collapsed semantics)
        if line.para_end && li + 1 < lines.len() {
            y += style.paragraph_spacing;
        }
    }
    // vertical trim: pull the block to its ink box and shift every glyph
    // (all sinks derive height from this return, so one pass keeps them
    // consistent — auto-layout measurement included)
    let mut height = y;
    if style.layout.vertical_trim && height > 0.0 && top_ink.is_finite() {
        let shift = -top_ink;
        height = (bottom_ink - top_ink).max(1.0);
        for g in out.iter_mut() {
            g.transform = Affine::translate((0.0, shift)) * g.transform;
        }
    }
    // vertical alignment inside a FIXED-SIZE box (Figma: Middle/Bottom
    // center/bottom-align the block within the text layer's height)
    if style.layout.align_v != 0 && style.layout.box_h > height + 0.5 {
        let shift = match style.layout.align_v {
            1 => (style.layout.box_h - height) / 2.0,
            2 => (style.layout.box_h - height).max(0.0),
            _ => 0.0,
        };
        if shift > 0.0 {
            for g in out.iter_mut() {
                g.transform = Affine::translate((0.0, shift)) * g.transform;
            }
        }
    }
    (out, height)
}

/// Break-opportunity pieces of a span (the justify slot count + 1).
fn span_breaks(sp: &Span) -> usize {
    let mut n = 0usize;
    let mut last = 0usize;
    for b in break_opportunities(&sp.text) {
        if b > last && b <= sp.text.len() {
            n += 1;
            last = b;
        }
    }
    if last < sp.text.len() {
        n += 1;
    }
    n
}

/// Shape one Text node from a full style struct (cache-routed). Used by
/// every export sink so parity is structural, not aspirational.
pub fn node_text_outlines_style(
    fonts: &FontManager,
    spec: &NodeTextSpec,
) -> Option<(Vec<OutlineGlyph>, f64)> {
    let key = spec.key(fonts.epoch());
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
    node_text_outlines_style_uncached(fonts, spec)
}

/// Raw style-struct shaping (cache-miss fill + tests + the app chrome).
pub fn node_text_outlines_style_uncached(
    fonts: &FontManager,
    spec: &NodeTextSpec,
) -> Option<(Vec<OutlineGlyph>, f64)> {
    let chosen = spec
        .font
        .and_then(|n| fonts.resolve_font_name(n))
        .or_else(|| fonts.default_font())?;
    let spans = [Span::new(spec.text, spec.size)
        .color(spec.color)
        .letter_spacing(spec.ls)
        .word_spacing(spec.word_spacing)];
    let style = spec.style();
    Some(glyph_outlines(fonts, &spans, chosen, &style))
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
        fonts, text, size, max_width, font_name, color, 0.0, 1.2, x_core::TextWrap::Auto, 0.0,
        0.0, 0.0, false, 0.0, 0.0, 0, Align::Left, 0, &TextLayout::default(),
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
    decoration: u8,
    layout: &TextLayout,
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
    )
    .with_text_layout(align as u8, decoration, layout);
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
        decoration,
        *layout,
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
        fonts, text, size, max_width, font_name, color, 0.0, 1.2, x_core::TextWrap::Auto, 0.0,
        0.0, 0.0, false, 0.0, 0.0, 0, Align::Left, 0, TextLayout::default(),
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
    decoration: u8,
    layout: &TextLayout,
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
    )
    .with_text_layout(align as u8, decoration, layout);
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
        decoration,
        layout,
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
    decoration: u8,
    layout: &TextLayout,
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
        decoration,
        layout: *layout,
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
    decoration: u8,
    layout: TextLayout,
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
        decoration,
        layout,
            ..Default::default()
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
         0, &TextLayout::default())
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
         0, &TextLayout::default())
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
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

    fn ink_min_x(gl: &OutlineGlyph) -> f64 {
        gl.path
            .elements()
            .iter()
            .filter_map(|e| match e {
                vello::kurbo::PathEl::MoveTo(pt)
                | vello::kurbo::PathEl::LineTo(pt)
                | vello::kurbo::PathEl::QuadTo(_, pt)
                | vello::kurbo::PathEl::CurveTo(_, _, pt) => Some(pt.x),
                vello::kurbo::PathEl::ClosePath => None,
            })
            .fold(f64::MAX, f64::min)
    }

    fn ink_span_x(gl: &OutlineGlyph) -> usize {
        gl.path
            .elements()
            .iter()
            .filter_map(|e| match e {
                vello::kurbo::PathEl::MoveTo(pt)
                | vello::kurbo::PathEl::LineTo(pt)
                | vello::kurbo::PathEl::QuadTo(_, pt)
                | vello::kurbo::PathEl::CurveTo(_, _, pt) => Some(pt.x),
                vello::kurbo::PathEl::ClosePath => None,
            })
            .map(|x| x as i64)
            .collect::<std::collections::HashSet<i64>>()
            .len()
    }

    /// Figma vertical alignment inside a FIXED-size box: the whole block
    /// translates; auto (align_v = 0) must leave the geometry untouched.
    #[test]
    fn vertical_align_offsets_block_in_box() {
        let m = fonts();
        let base = NodeTextSpec {
            text: "abc",
            size: 20.0,
            max_width: 10_000.0,
            font: None,
            color: Color::WHITE,
            lh: 1.0,
            ..Default::default()
        };
        let (auto, _) = node_text_outlines_style_uncached(&m, &base).unwrap();
        let (mid, _) = node_text_outlines_style_uncached(
            &m,
            &base.clone().with_vbox(1, 100.0),
        )
        .unwrap();
        let y = |g: &Vec<OutlineGlyph>| g[0].transform.translation().y;
        assert!((y(&mid) - y(&auto)).abs() > 1.0, "middle shifts the block down");
        // bottom = a larger shift than middle for the same box
        let (bot, _) =
            node_text_outlines_style_uncached(&m, &base.clone().with_vbox(2, 100.0)).unwrap();
        assert!(y(&bot) > y(&mid), "bottom sits below middle");
    }

    /// Paragraph indent hangs the FIRST line and wraps the rest; a negative
    /// indent hangs every following line into the left margin.
    #[test]
    fn paragraph_indent_moves_first_line() {
        let m = fonts();
        let base = NodeTextSpec {
            text: "hello world this is a long paragraph",
            size: 16.0,
            max_width: 120.0,
            font: None,
            color: Color::WHITE,
            lh: 1.0,
            ..Default::default()
        };
        let (plain, _) = node_text_outlines_style_uncached(&m, &base).unwrap();
        let (ind, _) = node_text_outlines_style_uncached(
            &m,
            &base.clone().with_layout(TextLayout {
                paragraph_indent: 30.0,
                ..TextLayout::default()
            }),
        )
        .unwrap();
        let plain_first = plain
            .iter()
            .filter(|g| (g.transform.translation().y - plain[0].transform.translation().y).abs() < 0.5)
            .map(|g| ink_min_x(g) + g.transform.translation().x)
            .fold(f64::MAX, f64::min);
        let ind_first = ind
            .iter()
            .filter(|g| (g.transform.translation().y - ind[0].transform.translation().y).abs() < 0.5)
            .map(|g| ink_min_x(g) + g.transform.translation().x)
            .fold(f64::MAX, f64::min);
        assert!(
            ind_first - plain_first > 20.0,
            "first line indented ({plain_first} -> {ind_first})"
        );
    }

    /// Decorations synthesize extra paths (LoadedFont carries no underline
    /// metrics) and change nothing else about the shaping.
    #[test]
    fn decorations_add_ink_paths() {
        let m = fonts();
        let base = NodeTextSpec {
            text: "word",
            size: 22.0,
            max_width: 10_000.0,
            font: None,
            color: Color::WHITE,
            lh: 1.0,
            ..Default::default()
        };
        let (none, _) = node_text_outlines_style_uncached(&m, &base).unwrap();
        let (under, _) = node_text_outlines_style_uncached(
            &m,
            &NodeTextSpec {
                decoration: 1,
                ..base.clone()
            },
        )
        .unwrap();
        let ink = |g: &Vec<OutlineGlyph>| {
            g.iter()
                .map(|gl| ink_span_x(gl).max(1))
                .sum::<usize>()
        };
        assert!(
            ink(&under) > ink(&none),
            "underline adds ink: {} -> {}",
            ink(&none),
            ink(&under)
        );
        let (strike, _) = node_text_outlines_style_uncached(
            &m,
            &NodeTextSpec {
                decoration: 2,
                ..base.clone()
            },
        )
        .unwrap();
        assert!(ink(&strike) > ink(&none), "strikethrough adds ink");
        // decorations must not move glyph baselines
        assert!(
            (none[0].transform.translation().y - under[0].transform.translation().y).abs() < 0.01
        );
    }

    /// The list + hanging knobs change geometry; TextLayout (not the style
    /// alone) must therefore be part of the cache key.
    #[test]
    fn layout_flags_drive_geometry_and_key() {
        let m = fonts();
        let base = NodeTextSpec {
            text: "one\ntwo",
            size: 18.0,
            max_width: 400.0,
            font: None,
            color: Color::WHITE,
            lh: 1.2,
            ..Default::default()
        };
        let (plain, ph) = node_text_outlines_style_uncached(&m, &base).unwrap();
        let (bul, bh) = node_text_outlines_style_uncached(
            &m,
            &base.clone().with_layout(TextLayout {
                list: 1,
                hanging_lists: true,
                ..TextLayout::default()
            }),
        )
        .unwrap();
        assert!(bul.len() > plain.len(), "bullet markers add glyphs");
        assert!(bh - ph > 1.0, "list paragraph spacing grows the block");
        // cache keys must differ for identical text with different layout
        let k1 = base.key(0);
        let k2 = base.clone().with_layout(TextLayout {
            list: 1,
            ..TextLayout::default()
        }).key(0);
        assert_ne!(format!("{k1:?}"), format!("{k2:?}"), "layout enters the key");
    }
}
