//! Real typography: TTF/OTF loading, glyph outlines, kerning, wrapping.
//!
//! Pipeline (the P0 architecture):
//!   FontManager -> font loading -> fallback chain -> glyph mapping ->
//!   positioning (advances + kern) -> line breaking -> layout -> Vello.
//!
//! `ttf-parser` gives us cmap/glyf/kern/hmtx parsing with zero C deps.
//! This is deliberately a *shaping-lite* stack: full complex-script
//! shaping (Arabic joining, Indic reordering) needs harfbuzz/rustybuzz —
//! the API here (shape() returning positioned glyphs) is designed so that
//! swap is internal and callers never change.

use std::collections::HashMap;
use vello::kurbo::{Affine, BezPath};
use vello::peniko::{Color, Fill};
use vello::Scene;

pub struct LoadedFont {
    pub name: String,
    data: std::sync::Arc<[u8]>,
    /// face index inside a .ttc collection (0 for single-font files)
    pub face_index: u32,
    pub units_per_em: f64,
    pub ascent: f64,
    pub descent: f64,
    pub line_gap: f64,
    /// OS/2 sCapHeight in font units (0 when the table is missing).
    pub cap_height: f64,
    /// glyph outline cache: glyph id -> path in font units (y-up)
    outline_cache: std::cell::RefCell<HashMap<u16, Option<BezPath>>>,
}
impl LoadedFont {
    pub fn bytes(&self) -> &[u8] {
        &self.data
    }
}

impl Clone for LoadedFont {
    fn clone(&self) -> Self {
        Self {
            name: self.name.clone(),
            data: self.data.clone(),
            face_index: self.face_index,
            units_per_em: self.units_per_em,
            ascent: self.ascent,
            descent: self.descent,
            line_gap: self.line_gap,
            cap_height: self.cap_height,
            // Cache state is local to the receiving thread; the font bytes are shared.
            outline_cache: Default::default(),
        }
    }
}

impl LoadedFont {
    pub fn from_bytes(name: &str, data: Vec<u8>) -> Result<Self, String> {
        Self::from_bytes_indexed(name, data, 0)
    }

    /// Parse face `index` of a collection (.ttc) or 0 for plain files.
    pub fn from_bytes_indexed(name: &str, data: Vec<u8>, index: u32) -> Result<Self, String> {
        let face = ttf_parser::Face::parse(&data, index).map_err(|e| format!("{e:?}"))?;
        let upm = face.units_per_em() as f64;
        let (asc, desc, gap) = (
            face.ascender() as f64,
            face.descender() as f64,
            face.line_gap() as f64,
        );
        let cap = face.capital_height().unwrap_or(0) as f64;
        Ok(Self {
            name: name.into(),
            data: data.into(),
            face_index: index,
            units_per_em: upm,
            ascent: asc,
            descent: desc,
            line_gap: gap,
            cap_height: cap,
            outline_cache: Default::default(),
        })
    }

    /// Raw font bytes (rustybuzz needs them for its own Face).
    pub fn data(&self) -> &[u8] {
        &self.data
    }

    fn face(&self) -> ttf_parser::Face<'_> {
        // parse is cheap (zero-copy views); Face borrows self.data
        ttf_parser::Face::parse(&self.data, self.face_index).expect("validated at load")
    }

    pub fn glyph_id(&self, c: char) -> Option<u16> {
        self.face().glyph_index(c).map(|g| g.0)
    }

    pub fn advance(&self, glyph: u16) -> f64 {
        self.face()
            .glyph_hor_advance(ttf_parser::GlyphId(glyph))
            .unwrap_or(0) as f64
    }

    pub fn kern(&self, left: u16, right: u16) -> f64 {
        let face = self.face();
        if let Some(kern) = face.tables().kern {
            for sub in kern.subtables {
                if sub.horizontal {
                    if let Some(v) =
                        sub.glyphs_kerning(ttf_parser::GlyphId(left), ttf_parser::GlyphId(right))
                    {
                        return v as f64;
                    }
                }
            }
        }
        0.0
    }

    /// Outline in font units (y-up); cached per glyph.
    pub fn outline(&self, glyph: u16) -> Option<BezPath> {
        if let Some(hit) = self.outline_cache.borrow().get(&glyph) {
            return hit.clone();
        }
        struct B(BezPath);
        impl ttf_parser::OutlineBuilder for B {
            fn move_to(&mut self, x: f32, y: f32) {
                self.0.move_to((x as f64, y as f64));
            }
            fn line_to(&mut self, x: f32, y: f32) {
                self.0.line_to((x as f64, y as f64));
            }
            fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
                self.0.quad_to((x1 as f64, y1 as f64), (x as f64, y as f64));
            }
            fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
                self.0.curve_to(
                    (x1 as f64, y1 as f64),
                    (x2 as f64, y2 as f64),
                    (x as f64, y as f64),
                );
            }
            fn close(&mut self) {
                self.0.close_path();
            }
        }
        let mut b = B(BezPath::new());
        let out = self
            .face()
            .outline_glyph(ttf_parser::GlyphId(glyph), &mut b)
            .map(|_| b.0);
        self.outline_cache.borrow_mut().insert(glyph, out.clone());
        out
    }
}

/// A glyph positioned in pixel space (relative to the text origin).
#[derive(Debug, Clone, Copy)]
pub struct PositionedGlyph {
    pub glyph: u16,
    /// index into FontManager.fonts (fallback may mix fonts in one run)
    pub font: usize,
    pub x: f64,
    pub y: f64,
    pub scale: f64, // font units -> px
}

#[derive(Default, Clone)]
pub struct FontManager {
    /// cache-invalidation epoch: bumped whenever the font set changes
    pub(crate) epoch: u64,
    pub fonts: Vec<LoadedFont>,
    by_name: HashMap<String, usize>,
}

impl FontManager {
    pub fn new() -> Self {
        Self::default()
    }
    /// generation for shaped-text cache keys
    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn load_file(&mut self, name: &str, path: &str) -> Result<usize, String> {
        let data = std::fs::read(path).map_err(|e| e.to_string())?;
        self.load_face_bytes(name, data, 0)
    }

    /// Register raw font bytes (face `index` for .ttc collections).
    pub fn load_face_bytes(
        &mut self,
        name: &str,
        data: Vec<u8>,
        index: u32,
    ) -> Result<usize, String> {
        let font = LoadedFont::from_bytes_indexed(name, data, index)?;
        let idx = self.fonts.len();
        self.by_name.insert(name.to_string(), idx);
        self.fonts.push(font);
        // A global cache must distinguish DIFFERENT font collections, not
        // just equal local load counts. Cloned immutable snapshots keep this id.
        static NEXT_EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        self.epoch = NEXT_EPOCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(idx)
    }

    /// Scan standard system font dirs; returns how many loaded.
    pub fn load_system_fonts(&mut self) -> usize {
        let mut n = 0;
        for dir in [
            "/usr/share/fonts/truetype/dejavu",
            "/usr/share/fonts/truetype/noto",
            "/usr/share/fonts/opentype/noto",
            "/usr/share/fonts/truetype",
            "/usr/share/fonts/TTF",
            "C:\\Windows\\Fonts",
            "/System/Library/Fonts",
            "./fonts",
        ] {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for e in entries.flatten() {
                    let p = e.path();
                    if p.extension()
                        .is_some_and(|x| x == "ttf" || x == "otf" || x == "ttc")
                    {
                        if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                            if self.load_file(stem, p.to_str().unwrap_or_default()).is_ok() {
                                n += 1;
                            }
                        }
                    }
                }
            }
            if n >= 24 {
                break;
            } // enough coverage; keep startup fast
        }
        // guarantee CJK coverage even when the scan stopped early
        // (the Noto CJK collection lives in the opentype dir)
        if self.font_index("NotoSansCJK-Regular").is_none()
            && self
                .load_file(
                    "NotoSansCJK-Regular",
                    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
                )
                .is_ok()
        {
            n += 1;
        }
        n
    }

    pub fn font_index(&self, name: &str) -> Option<usize> {
        self.by_name.get(name).copied()
    }

    /// raw face bytes (for subsetting/embedding at export)
    pub fn face_bytes(&self, idx: usize) -> Option<&[u8]> {
        self.fonts.get(idx).map(|f| f.bytes())
    }
    /// registered face whose name matches a document font-family,
    /// case-insensitively (exact, then prefix/contains — mirrors how the
    /// shaping fallback resolves "Inter" -> registered stem "Inter-400").
    pub fn find_family(&self, family: &str) -> Option<usize> {
        if let Some(i) = self.by_name.get(family) {
            return Some(*i);
        }
        let f = family.to_lowercase();
        let mut best: Option<(u8, usize)> = None;
        for (k, i) in &self.by_name {
            let kl = k.to_lowercase();
            let score = if kl == f {
                3
            } else if kl.starts_with(&f) || f.starts_with(&kl) {
                2
            } else if kl.contains(&f) || f.contains(&kl) {
                1
            } else {
                0
            };
            if score > 0 && best.map(|(s, _)| score > s).unwrap_or(true) {
                best = Some((score, *i));
            }
        }
        best.map(|(_, i)| i)
    }
    pub fn family_names(&self) -> Vec<&str> {
        self.by_name.keys().map(|s| s.as_str()).collect()
    }

    /// Resolve a font BINDING name to a face: exact stem first, then the
    /// first stem starting with `name-` / `name` (so family "Inter" finds
    /// "Inter-400" from the bundled static instances).
    pub fn resolve_font_name(&self, name: &str) -> Option<usize> {
        if let Some(i) = self.font_index(name) {
            return Some(i);
        }
        let mut stems: Vec<&String> = self.by_name.keys().collect();
        stems.sort();
        if let Some((_, &i)) = stems
            .iter()
            .filter_map(|k| {
                k.strip_prefix(name).and_then(|rest| {
                    if rest.starts_with('-') || rest.starts_with(' ') {
                        Some((k, self.by_name.get(*k).unwrap()))
                    } else {
                        None
                    }
                })
            })
            .next()
        {
            return Some(i);
        }
        None
    }

    /// Resolve family + weight to a face: "{family}-{weight}" first
    /// ("Inter" + 600 -> "Inter-600"), then any weight-bearing stem of the
    /// family, then the plain family. None => caller falls back to default.
    pub fn resolve_face(&self, family: &str, weight: u16) -> Option<usize> {
        if let Some(i) = self.font_index(&format!("{family}-{weight}")) {
            return Some(i);
        }
        let mut stems: Vec<&String> = self
            .by_name
            .keys()
            .filter(|k| k.starts_with(family) && k.len() > family.len())
            .collect();
        stems.sort();
        if let Some((_, &i)) = stems
            .iter()
            .filter_map(|k| {
                k[family.len()..]
                    .strip_prefix('-')
                    .and_then(|rest| rest.parse::<u16>().ok())
                    .map(|_| (k, self.by_name.get(*k).unwrap()))
            })
            .next()
        {
            return Some(i);
        }
        self.resolve_font_name(family)
    }
    pub fn default_font(&self) -> Option<usize> {
        self.font_index("DejaVuSans")
            .or(if self.fonts.is_empty() { None } else { Some(0) })
    }

    /// The default face resolved at `weight`: takes font 0's family prefix
    /// ("Inter-400" -> "Inter") and finds "Family-<weight>". Static faces
    /// ignore `wght` variations, so weight only renders through an actual
    /// face switch — this is how plain `fw` bindings get real bold ink.
    pub fn default_font_weighted(&self, weight: u16) -> Option<usize> {
        let d = self.default_font()?;
        if weight == 400 {
            return Some(d);
        }
        let fam = self.fonts[d].name.split('-').next()?.to_string();
        self.resolve_face(&fam, weight).or(Some(d))
    }

    /// Map char -> (font, glyph) via the fallback chain starting at `first`.
    fn map_char(&self, c: char, first: usize) -> Option<(usize, u16)> {
        if let Some(g) = self.fonts.get(first).and_then(|f| f.glyph_id(c)) {
            if g != 0 {
                return Some((first, g));
            }
        }
        for (i, f) in self.fonts.iter().enumerate() {
            if i == first {
                continue;
            }
            if let Some(g) = f.glyph_id(c) {
                if g != 0 {
                    return Some((i, g));
                }
            }
        }
        None
    }

    /// Shape one line: chars -> positioned glyphs (advances + kerning).
    /// Returns (glyphs, width_px).
    pub fn shape(&self, text: &str, font: usize, size_px: f64) -> (Vec<PositionedGlyph>, f64) {
        let mut out = vec![];
        let mut pen = 0.0f64;
        let mut prev: Option<(usize, u16)> = None;
        for c in text.chars() {
            let Some((fi, gid)) = self.map_char(c, font) else {
                // missing glyph: advance by ~half em (tofu-width) and reset kerning
                pen += size_px * 0.5;
                prev = None;
                continue;
            };
            let f = &self.fonts[fi];
            let scale = size_px / f.units_per_em;
            if let Some((pfi, pgid)) = prev {
                if pfi == fi {
                    pen += f.kern(pgid, gid) * scale;
                }
            }
            out.push(PositionedGlyph {
                glyph: gid,
                font: fi,
                x: pen,
                y: 0.0,
                scale,
            });
            pen += f.advance(gid) * scale;
            prev = Some((fi, gid));
        }
        (out, pen)
    }

    pub fn measure(&self, text: &str, font: usize, size_px: f64) -> f64 {
        self.shape(text, font, size_px).1
    }

    /// Greedy word-wrap into lines fitting `max_width` px.
    pub fn break_lines(
        &self,
        text: &str,
        font: usize,
        size_px: f64,
        max_width: f64,
    ) -> Vec<String> {
        let mut lines = vec![];
        for para in text.split('\n') {
            let mut line = String::new();
            for word in para.split(' ') {
                let cand = if line.is_empty() {
                    word.to_string()
                } else {
                    format!("{line} {word}")
                };
                if self.measure(&cand, font, size_px) <= max_width || line.is_empty() {
                    line = cand;
                } else {
                    lines.push(std::mem::take(&mut line));
                    line = word.to_string();
                }
            }
            lines.push(line);
        }
        lines
    }

    /// Line height in px for a font at size (ascent - descent + gap).
    pub fn line_height(&self, font: usize, size_px: f64) -> f64 {
        let f = &self.fonts[font];
        (f.ascent - f.descent + f.line_gap) * (size_px / f.units_per_em)
    }

    /// Encode a (possibly multi-line) text block into the scene.
    /// `world` maps the text-box origin; wraps at `max_width` if Some.
    /// Returns paths encoded.
    #[allow(clippy::too_many_arguments)] // positional params are the natural shape here; grouping would obscure the algorithm
    pub fn encode_text_block(
        &self,
        scene: &mut Scene,
        text: &str,
        world: Affine,
        font: usize,
        size_px: f64,
        max_width: Option<f64>,
        color: Color,
    ) -> usize {
        let f0 = &self.fonts[font];
        let baseline0 = f0.ascent * (size_px / f0.units_per_em);
        let lh = self.line_height(font, size_px);
        let lines: Vec<String> = match max_width {
            Some(w) => self.break_lines(text, font, size_px, w),
            None => text.split('\n').map(String::from).collect(),
        };
        let mut paths = 0usize;
        for (li, line) in lines.iter().enumerate() {
            let (glyphs, _) = self.shape(line, font, size_px);
            let base_y = baseline0 + li as f64 * lh;
            for g in glyphs {
                if let Some(outline) = self.fonts[g.font].outline(g.glyph) {
                    // font units are y-up; flip and scale into pixel space
                    let t = world
                        * Affine::translate((g.x, base_y))
                        * Affine::scale_non_uniform(g.scale, -g.scale);
                    scene.fill(Fill::NonZero, t, color, None, &outline);
                    paths += 1;
                }
            }
        }
        paths
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mgr() -> FontManager {
        let mut m = FontManager::new();
        let n = m.load_system_fonts();
        assert!(
            n > 0,
            "no system fonts found — DejaVu expected in CI/sandbox"
        );
        m
    }

    #[test]
    fn loads_real_ttf_and_maps_glyphs() {
        let m = mgr();
        let f = m.default_font().unwrap();
        let font = &m.fonts[f];
        assert!(font.units_per_em > 0.0);
        let a = font.glyph_id('A').unwrap();
        assert!(a != 0);
        assert!(font.advance(a) > 0.0);
        // real outline with real curves
        let outline = font.outline(a).unwrap();
        assert!(outline.elements().len() > 4);
    }

    #[test]
    fn resolve_natural_matches_face_metrics() {
        use crate::shaping::resolve_natural_line_height;
        let mut m = FontManager::new();
        m.load_system_fonts();
        let nat = resolve_natural_line_height(&m, None, 14.0);
        let d = m.default_font().unwrap();
        let f = &m.fonts[d];
        assert!((nat - (f.ascent - f.descent + f.line_gap) * (14.0 / f.units_per_em)).abs() < 1e-9);
    }

    #[test]
    fn default_font_weighted_switches_faces() {
        // fetch real font bytes, then build a manager whose FONT 0 is the
        // family under test (default_font_weighted resolves font 0's prefix)
        let bytes = {
            let mut m = FontManager::new();
            m.load_system_fonts();
            m.fonts[m.default_font().unwrap()].data.to_vec()
        };
        let mut m = FontManager::new();
        let i400 = m.load_face_bytes("Fam-400", bytes.clone(), 0).unwrap();
        let i700 = m.load_face_bytes("Fam-700", bytes, 0).unwrap();
        // font 0's family prefix resolves at each weight
        assert_eq!(m.default_font_weighted(400), Some(i400));
        assert_eq!(m.default_font_weighted(700), Some(i700));
        // unknown weight falls back to the plain default
        assert!(m.default_font_weighted(999).is_some());
    }

    #[test]
    fn shaping_positions_advance_monotonically_and_kerns() {
        let m = mgr();
        let f = m.default_font().unwrap();
        let (glyphs, width) = m.shape("AVATAR", f, 32.0);
        assert_eq!(glyphs.len(), 6);
        assert!(width > 0.0);
        for pair in glyphs.windows(2) {
            assert!(pair[1].x > pair[0].x);
        }
        // kerning: "AV" should be narrower than advance('A') + advance('V')
        let (_, av) = m.shape("AV", f, 32.0);
        let fa = &m.fonts[f];
        let scale = 32.0 / fa.units_per_em;
        let sum =
            (fa.advance(fa.glyph_id('A').unwrap()) + fa.advance(fa.glyph_id('V').unwrap())) * scale;
        assert!(av <= sum + 1e-6, "kerned width {av} should be <= raw {sum}");
    }

    #[test]
    fn line_breaking_wraps_greedily() {
        let m = mgr();
        let f = m.default_font().unwrap();
        let text = "the quick brown fox jumps over the lazy dog";
        let lines = m.break_lines(text, f, 16.0, 120.0);
        assert!(lines.len() >= 3, "expected multiple lines, got {lines:?}");
        for l in &lines {
            if l.contains(' ') {
                assert!(m.measure(l, f, 16.0) <= 120.0 + 1e-6);
            }
        }
        // explicit newlines respected
        assert_eq!(m.break_lines("a\nb", f, 16.0, 999.0).len(), 2);
    }

    #[test]
    fn encode_block_renders_multi_line_real_glyphs() {
        let m = mgr();
        let f = m.default_font().unwrap();
        let mut scene = Scene::new();
        let n = m.encode_text_block(
            &mut scene,
            "Hello type!\nSecond line",
            Affine::IDENTITY,
            f,
            24.0,
            None,
            Color::BLACK,
        );
        assert!(n >= 20, "expected ~22 glyph paths, got {n}");
        assert!(scene.encoding().n_paths as usize >= n);
    }

    #[test]
    fn fallback_reports_missing_glyphs_gracefully() {
        let m = mgr();
        let f = m.default_font().unwrap();
        // control chars have no glyph; must not panic and still advance text
        let (glyphs, w) = m.shape("a\u{7f}b", f, 16.0);
        assert!(glyphs.len() >= 2);
        assert!(w > 0.0);
    }
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;
    #[test]
    fn snapshots_share_font_data_but_not_mutable_outline_caches() {
        let bytes = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../apps/x-designer/assets/fonts/Inter-400.ttf"
        ))
        .to_vec();
        let mut a = FontManager::new();
        a.load_face_bytes("A", bytes.clone(), 0).unwrap();
        let mut b = FontManager::new();
        b.load_face_bytes("B", bytes, 0).unwrap();
        assert_ne!(
            a.epoch(),
            b.epoch(),
            "equal load counts must not alias different font collections"
        );
        let snapshot = a.clone();
        assert_eq!(snapshot.epoch(), a.epoch());
        assert_eq!(
            snapshot.fonts[0].data().as_ptr(),
            a.fonts[0].data().as_ptr()
        );
        let glyph = a.fonts[0].glyph_id('A').unwrap();
        a.fonts[0].outline(glyph);
        assert!(snapshot.fonts[0].outline_cache.borrow().is_empty());
        std::thread::spawn(move || snapshot.fonts[0].outline(glyph))
            .join()
            .unwrap();
    }
}

// ----------------------------------------------------------- font browsing

/// The family name of a registered face stem: strips a trailing numeric
/// weight suffix (`"Inter-400"` → `"Inter"`). Anything else — `"Inter"`,
/// `"Inter-Italic"`, `"A-1-400"` (→ `"A-1"`) — keeps its last hyphen segment.
/// Mirrors the `"Family-<weight>"` stem convention [`FontManager::resolve_font_name`]
/// documents for bundled static instances.
pub fn family_of_face(face: &str) -> &str {
    match face.rsplit_once('-') {
        Some((fam, suffix))
            if !fam.is_empty()
                && !suffix.is_empty()
                && suffix.chars().all(|c| c.is_ascii_digit()) =>
        {
            fam
        }
        _ => face,
    }
}

/// Group face stems into `(family, faces)` pairs for a font browser:
/// sorted by family, faces sorted within each family, no duplicates.
pub fn group_families<'a, I: IntoIterator<Item = &'a str>>(names: I) -> Vec<(String, Vec<String>)> {
    use std::collections::BTreeMap;
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for n in names {
        groups
            .entry(family_of_face(n).to_string())
            .or_default()
            .push(n.to_string());
    }
    for faces in groups.values_mut() {
        faces.sort();
        faces.dedup();
    }
    groups.into_iter().collect()
}

impl FontManager {
    /// Browser listing: every registered family with its face stems.
    /// (Families → faces; pair with [`FontManager::font_index`] to load.)
    pub fn families(&self) -> Vec<(String, Vec<String>)> {
        group_families(self.family_names())
    }
}

#[cfg(test)]
mod families_tests {
    use super::*;

    #[test]
    fn family_of_face_strips_numeric_weights_only() {
        assert_eq!(family_of_face("Inter-400"), "Inter");
        assert_eq!(family_of_face("Inter-700"), "Inter");
        assert_eq!(family_of_face("Inter"), "Inter");
        assert_eq!(family_of_face("Inter-Italic"), "Inter-Italic");
        assert_eq!(family_of_face("A-1-400"), "A-1");
        assert_eq!(family_of_face("Inter-"), "Inter-");
        assert_eq!(family_of_face("-400"), "-400");
    }

    #[test]
    fn group_families_sorts_and_dedups() {
        let got = group_families([
            "Roboto-400",
            "Inter-700",
            "Inter-400",
            "Inter",
            "Roboto-400",
        ]);
        assert_eq!(
            got,
            vec![
                (
                    "Inter".to_string(),
                    vec![
                        "Inter".to_string(),
                        "Inter-400".to_string(),
                        "Inter-700".to_string()
                    ]
                ),
                ("Roboto".to_string(), vec!["Roboto-400".to_string()]),
            ]
        );
    }

    #[test]
    fn font_manager_families_groups_registered_stems() {
        let bytes = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../apps/x-designer/assets/fonts/Inter-400.ttf"
        ))
        .to_vec();
        let mut fm = FontManager::new();
        fm.load_face_bytes("Inter-400", bytes, 0).unwrap();
        assert_eq!(
            fm.families(),
            vec![("Inter".to_string(), vec!["Inter-400".to_string()])]
        );
    }
}
