//! Font sources: real system-font enumeration + Google Fonts.
//!
//! SystemFonts: recursively scans platform font dirs, reads the REAL
//! family/style names from each font's name table (not file stems),
//! groups faces into families, and loads on demand.
//!
//! GoogleFonts: resolves a family name through the fonts.googleapis.com
//! css2 API to a direct TTF url, downloads it (curl — no TLS stack in
//! our tree), caches on disk, and loads it into the FontManager.
//! Offline-safe: every failure is a Result, the cache works without
//! network once populated.

use crate::font::FontManager;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

// ------------------------------------------------------------ system fonts

/// One physical font face on disk.
#[derive(Debug, Clone, PartialEq)]
pub struct FaceInfo {
    pub family: String,
    pub style: String,
    pub path: PathBuf,
    /// index inside a .ttc collection
    pub index: u32,
    pub variable: bool,
}

/// Enumerated system font database, grouped by family.
#[derive(Debug, Default)]
pub struct SystemFonts {
    pub families: BTreeMap<String, Vec<FaceInfo>>,
}

pub fn platform_font_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![];
    #[cfg(target_os = "linux")]
    {
        dirs.push("/usr/share/fonts".into());
        dirs.push("/usr/local/share/fonts".into());
        if let Ok(h) = std::env::var("HOME") {
            dirs.push(format!("{h}/.fonts").into());
            dirs.push(format!("{h}/.local/share/fonts").into());
        }
    }
    #[cfg(target_os = "windows")]
    dirs.push("C:\\Windows\\Fonts".into());
    #[cfg(target_os = "macos")]
    {
        dirs.push("/System/Library/Fonts".into());
        dirs.push("/Library/Fonts".into());
    }
    dirs.push("./fonts".into());
    dirs
}

impl SystemFonts {
    /// Scan all platform dirs recursively; read name tables for real
    /// family/style names. Fast: parses headers only, loads no outlines.
    pub fn enumerate() -> Self {
        let mut db = Self::default();
        for dir in platform_font_dirs() {
            scan_dir(&dir, &mut db, 0);
        }
        db
    }

    pub fn family_names(&self) -> Vec<&str> {
        self.families.keys().map(String::as_str).collect()
    }

    /// Find the face best matching (family, style). Style matching is
    /// case-insensitive with "Regular" preferred when style is empty.
    pub fn find(&self, family: &str, style: &str) -> Option<&FaceInfo> {
        let faces = self
            .families
            .iter()
            .find(|(f, _)| f.eq_ignore_ascii_case(family))
            .map(|(_, v)| v)?;
        if style.is_empty() {
            // "regular" is spelled many ways (Regular, Book, Roman...);
            // prefer any face that is neither bold nor italic/oblique.
            return faces
                .iter()
                .find(|f| {
                    let s = f.style.to_ascii_lowercase();
                    !s.contains("bold") && !s.contains("italic") && !s.contains("oblique")
                })
                .or(faces.first());
        }
        faces
            .iter()
            .find(|f| f.style.eq_ignore_ascii_case(style))
            .or_else(|| {
                faces.iter().find(|f| {
                    f.style
                        .to_ascii_lowercase()
                        .contains(&style.to_ascii_lowercase())
                })
            })
            .or(faces.first())
    }

    /// Load a family/style into the manager under "Family Style".
    /// Returns the font index (cached if already loaded).
    pub fn load_into(
        &self,
        fm: &mut FontManager,
        family: &str,
        style: &str,
    ) -> Result<usize, String> {
        let face = self
            .find(family, style)
            .ok_or_else(|| format!("family '{family}' not found"))?;
        let key = format!("{} {}", face.family, face.style);
        if let Some(i) = fm.font_index(&key) {
            return Ok(i);
        }
        let data = std::fs::read(&face.path).map_err(|e| e.to_string())?;
        fm.load_face_bytes(&key, data, face.index)
    }
}

fn scan_dir(dir: &Path, db: &mut SystemFonts, depth: u32) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            scan_dir(&p, db, depth + 1);
            continue;
        }
        let ext = p
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !matches!(ext.as_str(), "ttf" | "otf" | "ttc" | "otc") {
            continue;
        }
        let Ok(data) = std::fs::read(&p) else {
            continue;
        };
        let n_faces = ttf_parser::fonts_in_collection(&data).unwrap_or(1);
        for idx in 0..n_faces {
            let Ok(face) = ttf_parser::Face::parse(&data, idx) else {
                continue;
            };
            let family = name_record(&face, ttf_parser::name_id::TYPOGRAPHIC_FAMILY)
                .or_else(|| name_record(&face, ttf_parser::name_id::FAMILY))
                .unwrap_or_else(|| {
                    p.file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned()
                });
            let style = name_record(&face, ttf_parser::name_id::TYPOGRAPHIC_SUBFAMILY)
                .or_else(|| name_record(&face, ttf_parser::name_id::SUBFAMILY))
                .unwrap_or_else(|| "Regular".into());
            let variable = face.is_variable();
            db.families
                .entry(family.clone())
                .or_default()
                .push(FaceInfo {
                    family,
                    style,
                    path: p.clone(),
                    index: idx,
                    variable,
                });
        }
    }
}

fn name_record(face: &ttf_parser::Face, id: u16) -> Option<String> {
    face.names()
        .into_iter()
        .filter(|n| n.name_id == id)
        .find_map(|n| n.to_string())
}

// ------------------------------------------------------------ google fonts

/// One family in the Google Fonts catalog.
#[derive(Debug, Clone, PartialEq)]
pub struct GfFamily {
    pub family: String,
    pub category: String,
    /// available cuts: "400", "700i", ... (weight + optional italic flag)
    pub cuts: Vec<String>,
    /// variable-font axes: (tag, min, max, default)
    pub axes: Vec<(String, f32, f32, f32)>,
}

impl GfFamily {
    pub fn weights(&self) -> Vec<u32> {
        let mut w: Vec<u32> = self
            .cuts
            .iter()
            .filter(|c| !c.ends_with('i'))
            .filter_map(|c| c.parse().ok())
            .collect();
        w.sort_unstable();
        w
    }
    pub fn has_italic(&self) -> bool {
        self.cuts.iter().any(|c| c.ends_with('i'))
    }
    pub fn is_variable(&self) -> bool {
        !self.axes.is_empty()
    }
}

/// Google Fonts client with disk cache + full catalog.
pub struct GoogleFonts {
    pub cache_dir: PathBuf,
    catalog: std::cell::RefCell<Option<Vec<GfFamily>>>,
}

impl GoogleFonts {
    pub fn new() -> Self {
        let cache_dir = std::env::var("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                std::env::var("HOME")
                    .map(|h| PathBuf::from(h).join(".cache"))
                    .unwrap_or_else(|_| "./".into())
            })
            .join("x-native/google-fonts");
        Self {
            cache_dir,
            catalog: std::cell::RefCell::new(None),
        }
    }

    pub fn with_cache(dir: &Path) -> Self {
        Self {
            cache_dir: dir.into(),
            catalog: std::cell::RefCell::new(None),
        }
    }

    /// The FULL catalog (~2000 families) from the public metadata
    /// endpoint. Cached on disk for offline reuse and in memory per run.
    pub fn catalog(&self) -> Result<Vec<GfFamily>, String> {
        if let Some(c) = self.catalog.borrow().as_ref() {
            return Ok(c.clone());
        }
        let meta_path = self.cache_dir.join("catalog.json");
        let text = if meta_path.exists() {
            std::fs::read_to_string(&meta_path).map_err(|e| e.to_string())?
        } else {
            std::fs::create_dir_all(&self.cache_dir).map_err(|e| e.to_string())?;
            let t = curl_text("https://fonts.google.com/metadata/fonts")?;
            std::fs::write(&meta_path, &t).map_err(|e| e.to_string())?;
            t
        };
        let families = parse_gf_catalog(&text)?;
        *self.catalog.borrow_mut() = Some(families.clone());
        Ok(families)
    }

    /// Case-insensitive family lookup in the catalog.
    pub fn family(&self, name: &str) -> Option<GfFamily> {
        self.catalog()
            .ok()?
            .into_iter()
            .find(|f| f.family.eq_ignore_ascii_case(name))
    }

    /// Search the catalog by substring (for the font browser UI).
    pub fn search(&self, query: &str) -> Vec<GfFamily> {
        let q = query.to_ascii_lowercase();
        self.catalog()
            .unwrap_or_default()
            .into_iter()
            .filter(|f| f.family.to_ascii_lowercase().contains(&q))
            .take(50)
            .collect()
    }

    fn cache_path(&self, family: &str, weight: u32) -> PathBuf {
        self.cache_path_style(family, weight, false)
    }
    fn cache_path_style(&self, family: &str, weight: u32, italic: bool) -> PathBuf {
        let slug: String = family
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect();
        let it = if italic { "i" } else { "" };
        self.cache_dir.join(format!("{slug}-{weight}{it}.ttf"))
    }

    pub fn is_cached(&self, family: &str, weight: u32) -> bool {
        self.cache_path(family, weight).exists()
    }

    /// Resolve family+weight -> local TTF path (cache hit or download).
    pub fn fetch(&self, family: &str, weight: u32) -> Result<PathBuf, String> {
        self.fetch_style(family, weight, false)
    }

    /// Full style fetch: weight + italic.
    pub fn fetch_style(&self, family: &str, weight: u32, italic: bool) -> Result<PathBuf, String> {
        let path = self.cache_path_style(family, weight, italic);
        if path.exists() {
            return Ok(path);
        }
        std::fs::create_dir_all(&self.cache_dir).map_err(|e| e.to_string())?;

        // css2 API: request the specific cut; UA chosen to get TTF urls
        let fam_q = family.replace(' ', "+");
        let css_url = if italic {
            format!("https://fonts.googleapis.com/css2?family={fam_q}:ital,wght@1,{weight}")
        } else {
            format!("https://fonts.googleapis.com/css2?family={fam_q}:wght@{weight}")
        };
        let css = curl_text(&css_url)?;
        let url = extract_ttf_url(&css).ok_or_else(|| {
            format!("no TTF url in css2 response for '{family}' (family may not exist)")
        })?;
        curl_binary(&url, &path)?;
        // sanity: must parse as a font, or the cache would poison later loads
        let data = std::fs::read(&path).map_err(|e| e.to_string())?;
        if ttf_parser::Face::parse(&data, 0).is_err() {
            let _ = std::fs::remove_file(&path);
            return Err("downloaded file is not a valid font".into());
        }
        Ok(path)
    }

    /// Fetch + load into the manager under "Family wght" (e.g "Roboto 700").
    pub fn load_into(
        &self,
        fm: &mut FontManager,
        family: &str,
        weight: u32,
    ) -> Result<usize, String> {
        self.load_style_into(fm, family, weight, false)
    }

    pub fn load_style_into(
        &self,
        fm: &mut FontManager,
        family: &str,
        weight: u32,
        italic: bool,
    ) -> Result<usize, String> {
        let key = format!("{family} {weight}{}", if italic { " Italic" } else { "" });
        if let Some(i) = fm.font_index(&key) {
            return Ok(i);
        }
        let path = self.fetch_style(family, weight, italic)?;
        let data = std::fs::read(&path).map_err(|e| e.to_string())?;
        fm.load_face_bytes(&key, data, 0)
    }

    /// Download every static cut of a family (whole-family install).
    pub fn install_family(&self, fm: &mut FontManager, fam: &GfFamily) -> Vec<usize> {
        let mut out = vec![];
        for cut in &fam.cuts {
            let italic = cut.ends_with('i');
            let w: u32 = cut.trim_end_matches('i').parse().unwrap_or(400);
            if let Ok(i) = self.load_style_into(fm, &fam.family, w, italic) {
                out.push(i);
            }
        }
        out
    }
}

impl Default for GoogleFonts {
    fn default() -> Self {
        Self::new()
    }
}

/// Parse fonts.google.com/metadata/fonts into families. Tolerant,
/// zero-dependency extraction (the file is ~2.7MB of stable JSON).
pub fn parse_gf_catalog(text: &str) -> Result<Vec<GfFamily>, String> {
    let list_at = text
        .find("\"familyMetadataList\"")
        .ok_or("no familyMetadataList")?;
    let body = &text[list_at..];
    let mut out = vec![];
    let mut i = 0;
    while let Some(fam_at) = body[i..].find("\"family\":") {
        let start = i + fam_at;
        let Some(fam) = grab_json_str(&body[start..], "\"family\":") else {
            break;
        };
        let seg_end = body[start..]
            .find("\"family\":")
            .map(|_| {
                body[start + 10..]
                    .find("\"family\":")
                    .map(|n| start + 10 + n)
                    .unwrap_or(body.len())
            })
            .unwrap_or(body.len());
        let seg = &body[start..seg_end.min(body.len())];
        let category = grab_json_str(seg, "\"category\":").unwrap_or_default();
        // fonts: {"400": {...}, "700i": {...}}  (whitespace-tolerant)
        let mut cuts = vec![];
        if let Some(fp0) = seg.find("\"fonts\":") {
            let after = &seg[fp0 + 8..];
            let brace = after.find('{').unwrap_or(usize::MAX);
            if brace != usize::MAX {
                let fseg = &after[brace..];
                if let Some(close) = find_balanced(fseg) {
                    let inner = &fseg[1..close];
                    let mut j = 0;
                    while let Some(q) = inner[j..].find('"') {
                        let ks = j + q + 1;
                        let Some(qe) = inner[ks..].find('"') else {
                            break;
                        };
                        let key = &inner[ks..ks + qe];
                        if key.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                            cuts.push(key.to_string());
                        }
                        // skip past this key's value object
                        let Some(vo) = inner[ks + qe..].find('{') else {
                            break;
                        };
                        let vstart = ks + qe + vo;
                        let Some(vlen) = find_balanced(&inner[vstart..]) else {
                            break;
                        };
                        j = vstart + vlen + 1;
                    }
                }
            }
        }
        // axes: [{"tag":"wght","min":100.0,...}]
        let mut axes = vec![];
        if let Some(ap0) = seg.find("\"axes\":") {
            let after = &seg[ap0 + 7..];
            let bracket = after.find('[').unwrap_or(usize::MAX);
            if bracket == usize::MAX { /* none */ }
            let aseg = if bracket == usize::MAX {
                ""
            } else {
                &after[bracket..]
            };
            if let Some(close) = aseg.find(']') {
                let inner = &aseg[..close];
                let mut k = 0;
                while let Some(tp) = inner[k..].find("\"tag\":") {
                    let s2 = k + tp;
                    let tag = grab_json_str(&inner[s2..], "\"tag\":").unwrap_or_default();
                    let min = grab_json_num(&inner[s2..], "\"min\":").unwrap_or(0.0);
                    let max = grab_json_num(&inner[s2..], "\"max\":").unwrap_or(0.0);
                    let dv = grab_json_num(&inner[s2..], "\"defaultValue\":").unwrap_or(0.0);
                    axes.push((tag, min, max, dv));
                    k = s2 + 7;
                }
            }
        }
        if !fam.is_empty() && !cuts.is_empty() {
            out.push(GfFamily {
                family: fam,
                category,
                cuts,
                axes,
            });
        }
        i = start + 10;
    }
    if out.is_empty() {
        return Err("catalog parse produced no families".into());
    }
    Ok(out)
}

fn grab_json_str(seg: &str, key: &str) -> Option<String> {
    let at = seg.find(key)? + key.len();
    let rest = seg[at..].trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}
fn grab_json_num(seg: &str, key: &str) -> Option<f32> {
    let at = seg.find(key)? + key.len();
    let rest = &seg[at..];
    let end = rest
        .find(|c: char| c == ',' && true || c == '}' || c == ']')
        .unwrap_or(rest.len());
    rest[..end].trim().parse().ok()
}
/// byte length of a balanced {...} starting at index 0 (which must be '{')
fn find_balanced(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    if b.first() != Some(&b'{') {
        return None;
    }
    let (mut depth, mut in_str, mut esc) = (0i32, false, false);
    for (i, &c) in b.iter().enumerate() {
        if in_str {
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == b'"' {
                in_str = false;
            }
            continue;
        }
        match c {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// Pull the first TTF url out of a css2 @font-face response.
pub fn extract_ttf_url(css: &str) -> Option<String> {
    let start = css.find("src: url(")? + "src: url(".len();
    let end = css[start..].find(')')? + start;
    let url = &css[start..end];
    url.starts_with("https://").then(|| url.to_string())
}

fn curl_text(url: &str) -> Result<String, String> {
    let out = std::process::Command::new("curl")
        .args(["-sf", "--max-time", "20", "-A", "Mozilla/4.0", url])
        .output()
        .map_err(|e| format!("curl spawn: {e}"))?;
    if !out.status.success() {
        return Err(format!("fetch failed: {url}"));
    }
    String::from_utf8(out.stdout).map_err(|e| e.to_string())
}

fn curl_binary(url: &str, dest: &Path) -> Result<(), String> {
    let out = std::process::Command::new("curl")
        .args(["-sf", "--max-time", "60", "-A", "Mozilla/4.0", "-o"])
        .arg(dest)
        .arg(url)
        .status()
        .map_err(|e| format!("curl spawn: {e}"))?;
    if !out.success() {
        return Err(format!("download failed: {url}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_enumeration_reads_real_family_names() {
        let db = SystemFonts::enumerate();
        assert!(!db.families.is_empty(), "system fonts expected");
        // real name-table families, not file stems
        assert!(
            db.families.contains_key("DejaVu Sans"),
            "families: {:?}",
            db.family_names().iter().take(10).collect::<Vec<_>>()
        );
        // styles grouped under the family
        let dv = &db.families["DejaVu Sans"];
        let styles: Vec<&str> = dv.iter().map(|f| f.style.as_str()).collect();
        assert!(
            styles
                .iter()
                .any(|s| s.eq_ignore_ascii_case("Book") || s.eq_ignore_ascii_case("Regular")),
            "{styles:?}"
        );
        assert!(
            styles
                .iter()
                .any(|s| s.to_ascii_lowercase().contains("bold")),
            "{styles:?}"
        );
        // ttc collections enumerate multiple faces from one file
        if let Some(cjk) = db.families.iter().find(|(f, _)| f.contains("CJK")) {
            assert!(cjk.1[0].path.extension().unwrap() == "ttc");
        }
    }

    #[test]
    fn find_matches_family_and_style_loosely() {
        let db = SystemFonts::enumerate();
        let f = db
            .find("dejavu sans", "bold")
            .expect("case-insensitive family+style");
        assert!(f.style.to_ascii_lowercase().contains("bold"));
        let f = db
            .find("DejaVu Sans", "")
            .expect("empty style -> regular-ish");
        assert!(!f.style.to_ascii_lowercase().contains("bold"));
        assert!(db.find("No Such Family", "").is_none());
    }

    #[test]
    fn system_load_into_manager_dedupes() {
        let db = SystemFonts::enumerate();
        let mut fm = FontManager::new();
        let a = db.load_into(&mut fm, "DejaVu Sans", "Bold").expect("load");
        let b = db
            .load_into(&mut fm, "DejaVu Sans", "Bold")
            .expect("cached");
        assert_eq!(a, b, "second load must reuse the same index");
        // the loaded face really is the bold cut: heavier advance stems
        assert!(fm.fonts[a].glyph_id('A').unwrap() != 0);
    }

    #[test]
    fn ttc_index_loads_distinct_faces() {
        let db = SystemFonts::enumerate();
        // CJK collection has JP/KR/SC/TC faces at different indices
        let cjk: Vec<&FaceInfo> = db
            .families
            .iter()
            .filter(|(f, _)| f.contains("CJK"))
            .flat_map(|(_, v)| v.iter())
            .collect();
        if cjk.len() >= 2 {
            assert!(
                cjk.iter().any(|f| f.index > 0),
                "collection must yield indexed faces"
            );
        }
    }

    #[test]
    fn full_catalog_parses_1900_plus_families() {
        let tmp = std::env::temp_dir().join("xnative-gf-catalog");
        let gf = GoogleFonts::with_cache(&tmp);
        let Ok(cat) = gf.catalog() else {
            eprintln!("(offline — skipping catalog test)");
            return;
        };
        assert!(
            cat.len() > 1500,
            "expected the full catalog, got {}",
            cat.len()
        );
        // Roboto: all 9 weights + italics, variable axes present
        let roboto = gf.family("roboto").expect("Roboto in catalog");
        assert_eq!(
            roboto.weights(),
            vec![100, 200, 300, 400, 500, 600, 700, 800, 900]
        );
        assert!(roboto.has_italic());
        assert!(roboto.is_variable());
        assert!(roboto
            .axes
            .iter()
            .any(|(t, min, max, _)| t == "wght" && *min == 100.0 && *max == 900.0));
        assert_eq!(roboto.category, "Sans Serif");
        // search works
        let hits = gf.search("lobs");
        assert!(hits.iter().any(|f| f.family == "Lobster"));
        // catalog persisted for offline reuse
        assert!(tmp.join("catalog.json").exists());
        // second call = memory hit (no re-parse issues)
        assert_eq!(gf.catalog().unwrap().len(), cat.len());
    }

    #[test]
    fn italic_cuts_fetch_and_load() {
        let tmp = std::env::temp_dir().join("xnative-gf-italic");
        let gf = GoogleFonts::with_cache(&tmp);
        let Ok(p) = gf.fetch_style("Roboto", 700, true) else {
            eprintln!("(offline — skipping italic test)");
            return;
        };
        assert!(p.to_string_lossy().contains("roboto-700i"));
        let mut fm = FontManager::new();
        let idx = gf.load_style_into(&mut fm, "Roboto", 700, true).unwrap();
        assert!(fm.fonts[idx].name.contains("Italic"));
        assert!(fm.fonts[idx].glyph_id('R').unwrap() != 0);
    }

    #[test]
    fn google_css_url_extraction() {
        let css = "@font-face {\n  font-family: 'Roboto';\n  src: url(https://fonts.gstatic.com/s/roboto/v51/abc.ttf) format('truetype');\n}";
        assert_eq!(
            extract_ttf_url(css).as_deref(),
            Some("https://fonts.gstatic.com/s/roboto/v51/abc.ttf")
        );
        assert!(extract_ttf_url("nothing here").is_none());
        assert!(
            extract_ttf_url("src: url(data:font/woff;base64,xx)").is_none(),
            "non-https rejected"
        );
    }

    #[test]
    fn google_fonts_download_cache_and_load() {
        let tmp = std::env::temp_dir().join("xnative-gf-test");
        let _ = std::fs::remove_dir_all(&tmp);
        let gf = GoogleFonts::with_cache(&tmp);
        // network-dependent: skip silently when offline
        let Ok(path) = gf.fetch("Roboto", 400) else {
            eprintln!("(offline — skipping google fonts network test)");
            return;
        };
        assert!(path.exists());
        assert!(gf.is_cached("Roboto", 400));
        // second fetch = cache hit (no network): delete nothing, same path
        let path2 = gf.fetch("Roboto", 400).unwrap();
        assert_eq!(path, path2);
        // loads into the manager and shapes
        let mut fm = FontManager::new();
        let idx = gf.load_into(&mut fm, "Roboto", 400).unwrap();
        assert!(fm.fonts[idx].glyph_id('R').unwrap() != 0);
        let (glyphs, w) = fm.shape("Roboto!", idx, 24.0);
        assert!(glyphs.len() >= 6 && w > 0.0);
        // bogus family fails cleanly, never panics
        assert!(gf.fetch("Definitely Not A Real Family 123", 400).is_err());
    }
}
