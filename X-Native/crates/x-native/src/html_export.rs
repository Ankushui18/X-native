//! Static HTML/CSS export: a shippable artifact, not a snippet.
//!
//! Every node becomes a div styled through the SAME dev-mode CSS engine the
//! Code panel uses (`x_editor::devmode::node_to_css`), with two
//! export-specific refinements:
//! - children of auto-layout frames drop `left/top/position:absolute` and
//!   flow as real flex items (the container block already carries
//!   `display: flex` + gap/padding/alignment), so pages reflow like
//!   Figma's auto-layout instead of being piles of coordinates;
//! - `asset://` paint references become relative files under `assets/`,
//!   optionally re-compressed/downscaled through the render crate's
//!   export optimizer (`x_render::optimize_png`).
//!
//! With `embed_subset_fonts`, every font family the document draws gets a
//! @font-face subset to EXACTLY the used characters (`x_text::subset`) —
//! the difference between a 300 KB webfont and a handful of KB per page.
//!
//! Output: `index.html` (page directory), `page-<n>.html`, shared
//! `styles.css`, `assets/…`, `assets/fonts/…`.

use std::collections::BTreeSet;
use std::path::Path;
use x_core::{Document, Node, NodeKind};

#[derive(Debug, Clone)]
pub struct HtmlExportOptions {
    /// re-encode document image assets (Best compression + adaptive filters,
    /// optional downscale); non-PNG formats ship byte-identical
    pub optimize_images: bool,
    /// downscale the longer edge to this before encoding (when optimizing)
    pub max_image_dim: Option<u32>,
    /// @font-face with subsetted faces for every family the doc uses
    pub embed_subset_fonts: bool,
}
impl Default for HtmlExportOptions {
    fn default() -> Self {
        Self {
            optimize_images: false,
            max_image_dim: Some(2048),
            embed_subset_fonts: false,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct HtmlExportReport {
    pub pages: usize,
    pub nodes: usize,
    pub assets_written: usize,
    pub bytes_saved: usize,
    pub fonts_embedded: Vec<String>,
    pub notes: Vec<String>,
}

/// must match `node_to_css`'s selector sanitizer, plus an `x-` prefix so
/// numeric layer ids stay valid CSS class names
pub(crate) fn class_of(id: &str) -> String {
    format!(
        "x-{}",
        id.replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "-")
    )
}

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '&' => o.push_str("&amp;"),
            '"' => o.push_str("&quot;"),
            c => o.push(c),
        }
    }
    o
}

fn asset_ext(mime: &str) -> &'static str {
    match mime {
        m if m.contains("svg") => "svg",
        m if m.contains("jpeg") || m.contains("jpg") => "jpg",
        m if m.contains("webp") => "webp",
        m if m.contains("gif") => "gif",
        _ => "png",
    }
}

fn has_flow_layout(n: &Node) -> bool {
    matches!(&n.kind, NodeKind::Frame { layout: Some(_) })
}

fn text_families(n: &Node, out: &mut BTreeSet<String>) {
    if let NodeKind::Text { .. } = n.kind {
        let fam = n.bindings.get("font").cloned().unwrap_or_default();
        if !fam.is_empty() && fam != "sans-serif" {
            out.insert(fam);
        }
    }
    for c in &n.children {
        text_families(c, out);
    }
}

/// `asset://<hash>` -> `assets/<hash>.<ext>` per the store's sniffed mime
fn rewrite_assets(line: &str, doc: &Document) -> String {
    if !line.contains("asset://") {
        return line.to_string();
    }
    let mut s = String::new();
    let mut rest = line;
    while let Some(i) = rest.find("asset://") {
        s.push_str(&rest[..i]);
        let after = &rest[i + 8..];
        let hash: String = after
            .chars()
            .take_while(|c| c.is_ascii_hexdigit())
            .collect();
        let ext = doc
            .assets
            .get(&format!("asset://{hash}"))
            .map(|r| asset_ext(&r.mime))
            .unwrap_or("png");
        s.push_str(&format!("assets/{hash}.{ext}"));
        rest = &after[hash.len()..];
    }
    s.push_str(rest);
    s
}

fn node_css(n: &Node, doc: &Document, parent_flow: bool) -> String {
    let base = x_core_dev_css(n, doc);
    let cls = class_of(&n.id);
    let mut out = format!(".{cls} {{\n");
    for line in base.lines().skip(1) {
        let t = line.trim();
        if t == "}" || t.is_empty() {
            continue;
        }
        if parent_flow && (t.starts_with("left:") || t.starts_with("top:")) {
            continue; // flex positions these
        }
        if parent_flow && t.starts_with("position:") {
            out.push_str("  position: relative;\n");
            continue;
        }
        out.push_str(&rewrite_assets(line, doc));
        out.push('\n');
    }
    if matches!(n.kind, NodeKind::Frame { .. }) {
        out.push_str("  overflow: hidden;\n");
    }
    if matches!(n.kind, NodeKind::Text { .. }) {
        // devmode CSS mirrors the design tool's text model (typed Node
        // fields); HTML export overrides the whitespace policy because the
        // DOM wraps by default while the engine's auto-width layers never do
        let (truncation, max_lines) = n.resolved_truncation();
        if matches!(truncation, x_core::TextTruncation::Disabled) && max_lines.is_none() {
            if n.resolved_word_break() {
                out.push_str("  overflow-wrap: break-word;\n");
            }
            out.push_str(if n.resolved_word_break() {
                "  white-space: pre-wrap;\n"
            } else {
                "  white-space: pre;\n"
            });
        } else {
            out.push_str("  overflow: hidden;\n");
            match max_lines {
                Some(k) if k > 0 => out.push_str(&format!(
                    "  display: -webkit-box; -webkit-line-clamp: {k}; -webkit-box-orient: vertical;\n"
                )),
                _ => out.push_str("  white-space: nowrap;\n"),
            }
            if matches!(truncation, x_core::TextTruncation::End) {
                out.push_str("  text-overflow: ellipsis;\n");
            }
        }
        if n.text_needs_styled() {
            out.push_str("  /* styled per the text model (see Code panel CSS) */\n");
        }
    }
    if !n.visible {
        out.push_str("  visibility: hidden;\n");
    }
    out.push_str("}\n");
    out
}

fn x_core_dev_css(n: &Node, doc: &Document) -> String {
    crate::editor::node_to_css(n, &doc.variables)
}

fn walk_count(n: &Node, rep: &mut HtmlExportReport) {
    rep.nodes += 1;
    for c in &n.children {
        walk_count(c, rep);
    }
}

fn emit_divs(n: &Node, _doc: &Document, out: &mut String, depth: usize) -> Result<(), String> {
    // `_doc`: the document context is threaded through for child kinds that
    // need it (components, images); plain divs only walk the tree.
    if depth > 256 {
        return Err(format!("{}: nesting exceeds HTML export limit", n.id));
    }
    out.push_str(&format!("<div class=\"{}\">\n", class_of(&n.id)));
    if let NodeKind::Text { text } = &n.kind {
        out.push_str(&esc(text));
        out.push('\n');
    }
    for c in &n.children {
        emit_divs(c, _doc, out, depth + 1)?;
    }
    out.push_str("</div>\n");
    Ok(())
}

fn emit_css_tree(
    n: &Node,
    doc: &Document,
    parent_flow: bool,
    seen: &mut BTreeSet<String>,
    css: &mut String,
) {
    let cls = class_of(&n.id);
    if !seen.insert(cls) {
        return; // duplicate ids collapse to one block (ids are deduped upstream)
    }
    css.push_str(&node_css(n, doc, parent_flow));
    let flow = has_flow_layout(n);
    for c in &n.children {
        emit_css_tree(c, doc, flow, seen, css);
    }
}

/// Export the document as a static site under `out_dir`.
pub fn export_html(
    doc: &Document,
    out_dir: &Path,
    fonts: &x_text::FontManager,
    opts: &HtmlExportOptions,
) -> Result<HtmlExportReport, String> {
    let mut rep = HtmlExportReport::default();
    std::fs::create_dir_all(out_dir).map_err(|e| format!("create {}: {e}", out_dir.display()))?;

    // ---- image assets (content-addressed => dedup is structural)
    let images: Vec<_> = doc
        .assets
        .embedded_sorted()
        .into_iter()
        .filter(|r| r.mime.starts_with("image/"))
        .collect();
    if !images.is_empty() {
        std::fs::create_dir_all(out_dir.join("assets")).map_err(|e| e.to_string())?;
    }
    for rec in images {
        let ext = asset_ext(&rec.mime);
        let name = format!("{}.{}", rec.hash, ext);
        let bytes = if opts.optimize_images && ext == "png" {
            match x_render::optimize_png(&rec.bytes, opts.max_image_dim) {
                Ok(o) => {
                    if o.len() < rec.bytes.len() {
                        rep.bytes_saved += rec.bytes.len() - o.len();
                    }
                    o
                }
                Err(e) => {
                    rep.notes.push(format!("optimize {name}: {e}"));
                    rec.bytes.clone()
                }
            }
        } else {
            rec.bytes.clone()
        };
        std::fs::write(out_dir.join("assets").join(&name), &bytes)
            .map_err(|e| format!("write asset {name}: {e}"))?;
        rep.assets_written += 1;
    }

    // ---- fonts
    let mut css = String::new();
    css.push_str("html,body{margin:0;padding:0;background:#fff;}\n");
    css.push_str("body>div:first-child{position:relative;}\n");
    css.push_str("*,*::before,*::after{box-sizing:border-box;}\n");
    if opts.embed_subset_fonts {
        let mut fams = BTreeSet::new();
        for p in &doc.pages {
            text_families(p, &mut fams);
        }
        if !fams.is_empty() {
            std::fs::create_dir_all(out_dir.join("assets/fonts")).map_err(|e| e.to_string())?;
        }
        let chars = x_text::document_chars(doc);
        for fam in fams {
            let Some(face_idx) = fonts.find_family(&fam) else {
                rep.notes.push(format!(
                    "font '{fam}': no matching face loaded; export references it by name only"
                ));
                continue;
            };
            let Some(src) = fonts.face_bytes(face_idx).map(|b| b.to_vec()) else {
                continue;
            };
            let file = format!("{}.ttf", class_of(&fam).replace("x-", ""));
            let out_bytes = match x_text::subset_font(&src, &chars) {
                Ok(sub) => sub.bytes,
                Err(e) => {
                    rep.notes
                        .push(format!("font '{fam}': {e}; embedding full face"));
                    src.clone()
                }
            };
            std::fs::write(out_dir.join("assets/fonts").join(&file), &out_bytes)
                .map_err(|e| format!("write font: {e}"))?;
            css.push_str(&format!(
                "@font-face{{font-family:\"{fam}\";src:url(\"assets/fonts/{file}\");font-display:block;}}\n"
            ));
            rep.fonts_embedded.push(fam);
        }
    }

    // ---- per-page HTML + shared stylesheet
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut pages: Vec<(String, String)> = Vec::new();
    for (i, p) in doc.pages.iter().enumerate() {
        let mut body = String::new();
        emit_divs(p, doc, &mut body, 0)?;
        emit_css_tree(p, doc, false, &mut seen, &mut css);
        walk_count(p, &mut rep);
        let file = format!("page-{}.html", i + 1);
        let html = format!(
            "<!doctype html>\n<html>\n<head><meta charset=\"utf-8\"><title>{}</title>\n<link rel=\"stylesheet\" href=\"styles.css\"></head>\n<body>\n{body}</body>\n</html>\n",
            esc(&p.name)
        );
        std::fs::write(out_dir.join(&file), html).map_err(|e| e.to_string())?;
        pages.push((file, p.name.clone()));
    }
    std::fs::write(out_dir.join("styles.css"), &css).map_err(|e| e.to_string())?;
    let mut nav = String::from(
        "<!doctype html>\n<html>\n<head><meta charset=\"utf-8\"><title>Pages</title></head>\n<body><ul>\n",
    );
    for (file, name) in &pages {
        nav.push_str(&format!("<li><a href=\"{file}\">{}</a></li>\n", esc(name)));
    }
    nav.push_str("</ul></body></html>\n");
    std::fs::write(out_dir.join("index.html"), nav).map_err(|e| e.to_string())?;
    rep.pages = pages.len();
    Ok(rep)
}
