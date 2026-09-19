//! Document introspection: `tree` / `find` / `node` / `info` — the
//! OpenPencil-style "inspect a design file without opening the editor"
//! surface, implemented as pure functions so the CLI, the MCP server and
//! the in-app UX tab all share one vocabulary.

use crate::{Document, Node, NodeKind};

/// One-line kind label (matches the CLI filter vocabulary, uppercased).
pub fn kind_label(n: &Node) -> &'static str {
    match &n.kind {
        NodeKind::Frame { .. } => "FRAME",
        NodeKind::Rect { .. } => "RECT",
        NodeKind::Ellipse => "ELLIPSE",
        NodeKind::Line => "LINE",
        NodeKind::Text { .. } => "TEXT",
        NodeKind::Image { .. } => "IMAGE",
        NodeKind::Vector { .. } => "VECTOR",
        NodeKind::Group => "GROUP",
        NodeKind::Section => "SECTION",
        NodeKind::Component { .. } => "COMPONENT",
        NodeKind::Instance { .. } => "INSTANCE",
        NodeKind::Slice => "SLICE",
        NodeKind::Arc { .. } => "ARC",
        NodeKind::Poly { .. } => "POLYGON",
        NodeKind::Star { .. } => "STAR",
    }
}

/// Indented tree listing, Figma-CLI style: `[i] [KIND] "name" (id)`.
pub fn tree_lines(doc: &Document, max_depth: Option<usize>) -> Vec<String> {
    let mut out = Vec::new();
    for (pi, p) in doc.pages.iter().enumerate() {
        out.push(format!("[{pi}] [PAGE] \"{}\" ({})", p.name, p.id));
        tree_walk(p, 1, max_depth, &mut out);
    }
    out
}

fn tree_walk(n: &Node, depth: usize, max_depth: Option<usize>, out: &mut Vec<String>) {
    if let Some(m) = max_depth {
        if depth > m {
            return;
        }
    }
    for (i, c) in n.children.iter().enumerate() {
        out.push(format!(
            "{}[{i}] [{}] \"{}\" ({}){}",
            "  ".repeat(depth),
            kind_label(c),
            c.name,
            c.id,
            if c.visible { "" } else { " [hidden]" }
        ));
        tree_walk(c, depth + 1, max_depth, out);
    }
}

/// A found node: id / kind / owning page / absolute top-left + size.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    pub page: usize,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Filter for [`find_with`] — every field is optional, all set fields must
/// match (AND). CLI: `x_native find file.x --type TEXT --name hero …`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FindFilter {
    /// Kind label, case-insensitive (`TEXT`, `frame`, …).
    pub kind: Option<String>,
    /// Case-insensitive substring of the layer name.
    pub name: Option<String>,
    /// Case-insensitive exact layer name (wins over `name` when both set).
    pub name_is: Option<String>,
    /// Exact node id.
    pub id: Option<String>,
    /// Only nodes at least this wide/tall (0 = unset).
    pub min_w: f64,
    pub min_h: f64,
    /// Only nodes no larger than this (0 = unset) — finds icon-sized junk.
    pub max_w: f64,
    pub max_h: f64,
    /// Skip hidden layers (default: include them, marked as such).
    pub visible_only: bool,
    /// Skip layers carrying a prototype interaction (finds "static" art).
    pub not_interactive: bool,
    /// Stop after N hits (0 = unlimited).
    pub limit: usize,
}

impl FindFilter {
    /// `true` when no criterion was set — callers can warn that the query
    /// matches everything.
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    fn matches(&self, n: &Node) -> bool {
        if let Some(k) = &self.kind {
            if !k.eq_ignore_ascii_case(kind_label(n)) {
                return false;
            }
        }
        if let Some(exact) = &self.name_is {
            if !exact.eq_ignore_ascii_case(n.name.trim()) {
                return false;
            }
        } else if let Some(q) = &self.name {
            if !n.name.to_lowercase().contains(&q.to_lowercase()) {
                return false;
            }
        }
        if let Some(id) = &self.id {
            if id != &n.id {
                return false;
            }
        }
        if self.min_w > 0.0 && n.w < self.min_w {
            return false;
        }
        if self.min_h > 0.0 && n.h < self.min_h {
            return false;
        }
        if self.max_w > 0.0 && n.w > self.max_w {
            return false;
        }
        if self.max_h > 0.0 && n.h > self.max_h {
            return false;
        }
        if self.visible_only && !n.visible {
            return false;
        }
        if self.not_interactive && !n.interactions.is_empty() {
            return false;
        }
        true
    }
}

/// Find every node whose kind (case-insensitive) and/or name (substring)
/// matches. Document order; the root of each page is not a hit.
pub fn find(doc: &Document, kind: Option<&str>, name: Option<&str>) -> Vec<Found> {
    find_with(
        doc,
        &FindFilter {
            kind: kind.map(str::to_string),
            name: name.map(str::to_string),
            ..Default::default()
        },
    )
}

/// [`find`] with the full filter vocabulary.
pub fn find_with(doc: &Document, f: &FindFilter) -> Vec<Found> {
    let mut out = Vec::new();
    for (pi, p) in doc.pages.iter().enumerate() {
        for c in &p.children {
            find_walk(c, 0.0, 0.0, pi, f, &mut out);
            if f.limit > 0 && out.len() >= f.limit {
                out.truncate(f.limit);
                return out;
            }
        }
    }
    out
}

/// [`find_with`] scoped to the subtree under one node id (the node itself
/// excluded). Returns an empty list when `root_id` is unknown.
pub fn find_under(doc: &Document, root_id: &str, f: &FindFilter) -> Vec<Found> {
    let mut out = Vec::new();
    if let Some((pi, root)) = locate(doc, root_id) {
        let (ox, oy) = (root.transform.x, root.transform.y);
        for c in &root.children {
            find_walk(c, ox, oy, pi, f, &mut out);
        }
        if f.limit > 0 {
            out.truncate(f.limit);
        }
    }
    out
}

fn find_walk(n: &Node, ox: f64, oy: f64, page: usize, f: &FindFilter, out: &mut Vec<Found>) {
    if f.limit > 0 && out.len() >= f.limit {
        return;
    }
    let (x, y) = (ox + n.transform.x, oy + n.transform.y);
    if f.matches(n) {
        out.push(Found {
            id: n.id.clone(),
            kind: kind_label(n),
            name: n.name.clone(),
            page,
            x,
            y,
            w: n.w,
            h: n.h,
        });
    }
    for c in &n.children {
        find_walk(c, x, y, page, f, out);
    }
}

/// JSON array of hits (`x_native find --json`); stable key order.
pub fn found_json(hits: &[Found]) -> String {
    let items: Vec<String> = hits
        .iter()
        .map(|h| {
            format!(
                "{{ \"id\": \"{}\", \"kind\": \"{}\", \"name\": \"{}\", \"page\": {}, \"x\": {}, \"y\": {}, \"w\": {}, \"h\": {} }}",
                esc_str(&h.id),
                h.kind,
                esc_str(&h.name),
                h.page,
                h.x,
                h.y,
                h.w,
                h.h
            )
        })
        .collect();
    format!("[{}]", items.join(",\n"))
}

pub fn find_node<'a>(root: &'a Node, id: &str) -> Option<&'a Node> {
    if root.id == id {
        return Some(root);
    }
    root.children.iter().find_map(|c| find_node(c, id))
}

/// Locate a node by id across all pages: (page index, node).
pub fn locate<'a>(doc: &'a Document, id: &str) -> Option<(usize, &'a Node)> {
    doc.pages
        .iter()
        .enumerate()
        .find_map(|(i, p)| find_node(p, id).map(|n| (i, n)))
}

/// JSON string escape (shared by both JSON shapes).
pub fn esc_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\t' => o.push_str("\\t"),
            '\r' => o.push_str("\\r"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o
}

/// Shared prologue for both JSON shapes (everything but children/sub).
fn node_head(n: &Node) -> String {
    let fill = match &n.fill {
        crate::Paint::Solid(c) => format!("\"{}\"", crate::color_to_hex(*c)),
        crate::Paint::Variable(id) => format!("\"var:{id}\""),
        _ => "null".to_string(),
    };
    let text = match &n.kind {
        NodeKind::Text { text } => format!(", \"text\": \"{}\"", esc_str(text)),
        _ => String::new(),
    };
    format!(
        "{{ \"id\": \"{}\", \"name\": \"{}\", \"kind\": \"{}\", \"x\": {}, \"y\": {}, \"w\": {}, \"h\": {}, \"visible\": {}, \"opacity\": {}, \"fill\": {}{}",
        esc_str(&n.id),
        esc_str(&n.name),
        kind_label(n),
        n.transform.x,
        n.transform.y,
        n.w,
        n.h,
        n.visible,
        n.opacity,
        fill,
        text,
    )
}

/// One-line JSON dump of a node (children as ids; deterministic key
/// order — no serde in the kernel by policy).
pub fn node_json(n: &Node) -> String {
    let kids: Vec<String> = n
        .children
        .iter()
        .map(|c| format!("\"{}\"", esc_str(&c.id)))
        .collect();
    let tail = if kids.is_empty() {
        String::new()
    } else {
        format!(", \"children\": [{}]", kids.join(", "))
    };
    format!("{}{tail} }}", node_head(n))
}

/// Full subtree JSON (bounded depth): children nest under `"sub"`; below
/// the depth cutoff, children degrade to id strings like `node_json`.
pub fn subtree_json(n: &Node, max_depth: usize) -> String {
    if n.children.is_empty() {
        return format!("{} }}", node_head(n));
    }
    if max_depth == 0 {
        return node_json(n);
    }
    let kids: Vec<String> = n
        .children
        .iter()
        .map(|c| subtree_json(c, max_depth - 1))
        .collect();
    format!("{}, \"sub\": [{}] }}", node_head(n), kids.join(", "))
}

/// Document-level summary numbers.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InfoStats {
    pub pages: usize,
    pub nodes: usize,
    pub frames: usize,
    pub texts: usize,
    pub images: usize,
    pub components: usize,
    pub instances: usize,
    pub auto_layouts: usize,
    pub interactions: usize,
    pub assets: usize,
    pub variables: usize,
}

pub fn info(doc: &Document) -> InfoStats {
    let mut st = InfoStats::default();
    fn walk(n: &Node, st: &mut InfoStats) {
        st.nodes += 1;
        match &n.kind {
            NodeKind::Frame { layout } => {
                st.frames += 1;
                if layout.is_some() {
                    st.auto_layouts += 1;
                }
            }
            NodeKind::Text { .. } => st.texts += 1,
            NodeKind::Image { .. } => st.images += 1,
            NodeKind::Component { .. } => st.components += 1,
            NodeKind::Instance { .. } => st.instances += 1,
            _ => {}
        }
        st.interactions += n.interactions.len();
        for c in &n.children {
            walk(c, st);
        }
    }
    for p in &doc.pages {
        walk(p, &mut st);
        st.pages += 1;
    }
    st.assets = doc.assets.len();
    st.variables = doc.variables.catalog().len();
    st
}

impl InfoStats {
    pub fn to_json(&self) -> String {
        format!(
            "{{ \"pages\": {}, \"nodes\": {}, \"frames\": {}, \"texts\": {}, \"images\": {}, \"components\": {}, \"instances\": {}, \"auto_layouts\": {}, \"interactions\": {}, \"assets\": {}, \"variables\": {} }}",
            self.pages,
            self.nodes,
            self.frames,
            self.texts,
            self.images,
            self.components,
            self.instances,
            self.auto_layouts,
            self.interactions,
            self.assets,
            self.variables
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Color, Document, Node};

    fn doc() -> Document {
        let mut d = Document::new();
        let mut page = Node::frame("p", 800.0, 600.0);
        page.name = "Page 1".into();
        let mut card = Node::frame("c", 200.0, 100.0);
        card.name = "Card".into();
        card.transform.x = 40.0;
        card.transform.y = 40.0;
        let mut t = Node::text("t", 8.0, 8.0, 80.0, 20.0, "Hi");
        t.name = "Title".into();
        let mut r = Node::rect("r", 0.0, 0.0, 10.0, 10.0, Color::BLACK);
        r.name = "Dot".into();
        card.children.push(t);
        card.children.push(r);
        page.children.push(card);
        d.pages.push(page);
        d
    }

    #[test]
    fn tree_lists_nested_indices() {
        let lines = tree_lines(&doc(), None);
        assert_eq!(lines[0], "[0] [PAGE] \"Page 1\" (p)");
        assert_eq!(lines[1], "  [0] [FRAME] \"Card\" (c)");
        assert_eq!(lines[2], "    [0] [TEXT] \"Title\" (t)");
        // depth cutoff keeps the page row only under it
        let shallow = tree_lines(&doc(), Some(1));
        assert_eq!(shallow.len(), 2, "{shallow:?}");
    }

    #[test]
    fn find_filters_kind_and_name() {
        let texts = find(&doc(), Some("text"), None);
        assert_eq!(texts.len(), 1);
        assert_eq!(texts[0].id, "t");
        // absolute position accumulates ancestors: card(40,40)+t(8,8)
        assert_eq!((texts[0].x, texts[0].y), (48.0, 48.0));
        let by_name = find(&doc(), None, Some("dot"));
        assert_eq!(by_name.len(), 1);
        assert_eq!(by_name[0].kind, "RECT");
        assert!(find(&doc(), Some("SLICE"), None).is_empty());
    }

    #[test]
    fn info_counts_the_tree() {
        let st = info(&doc());
        assert_eq!((st.pages, st.nodes, st.frames, st.texts), (1, 4, 2, 1));
        assert_eq!(st.components, 0);
        let j = st.to_json();
        assert!(j.contains("\"nodes\": 4"), "{j}");
    }

    #[test]
    fn node_json_escapes_and_nests() {
        let d = doc();
        let n = locate(&d, "c").unwrap().1;
        let one = node_json(n);
        assert!(one.contains("\"kind\": \"FRAME\""), "{one}");
        assert!(one.contains("\"children\": [\"t\", \"r\"]"), "{one}");
        let deep = subtree_json(n, 2);
        assert!(deep.contains("\"sub\": ["), "{deep}");
        assert!(
            deep.contains("\\\"Hi\\\"") || deep.contains("\"Hi\""),
            "{deep}"
        );
        let q = Node::text("q", 0.0, 0.0, 1.0, 1.0, "a\"b\\c");
        let jq = node_json(&q);
        assert!(jq.contains("a\\\"b\\\\c"), "{jq}");
    }

    #[test]
    fn find_filters_size_name_exact_and_visibility() {
        let d = doc();
        let big = find_with(
            &d,
            &FindFilter {
                min_w: 100.0,
                ..Default::default()
            },
        );
        assert_eq!(
            big.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(),
            vec!["c"]
        );
        let exact = find_with(
            &d,
            &FindFilter {
                name_is: Some("TITLE".into()),
                ..Default::default()
            },
        );
        assert_eq!(exact.len(), 1, "{exact:?}");
        assert_eq!(exact[0].id, "t");
        let small = find_with(
            &d,
            &FindFilter {
                max_w: 20.0,
                max_h: 20.0,
                ..Default::default()
            },
        );
        assert_eq!(small[0].id, "r");
        // an empty filter matches every non-root node
        assert_eq!(find_with(&d, &FindFilter::default()).len(), 3);
        assert!(FindFilter::default().is_empty());
        // visibility switch drops the hidden dot
        let mut with_hidden = doc();
        with_hidden.pages[0].children[0].children[1].visible = false;
        let all = find_with(&with_hidden, &FindFilter::default());
        let shown = find_with(
            &with_hidden,
            &FindFilter {
                visible_only: true,
                ..Default::default()
            },
        );
        assert_eq!(all.len(), 3);
        assert_eq!(shown.len(), 2, "{shown:?}");
    }

    #[test]
    fn find_under_scopes_to_a_subtree() {
        let d = doc();
        let inner = find_under(&d, "c", &FindFilter::default());
        assert_eq!(inner.len(), 2, "{inner:?}");
        // coordinates stay absolute even when scoped
        assert_eq!((inner[0].x, inner[0].y), (48.0, 48.0));
        assert!(find_under(&d, "nope", &FindFilter::default()).is_empty());
        let limited = find_under(
            &d,
            "p",
            &FindFilter {
                limit: 1,
                ..Default::default()
            },
        );
        assert_eq!(limited.len(), 1);
    }

    #[test]
    fn found_json_is_stable_and_escaped() {
        let d = doc();
        let js = found_json(&find(&d, Some("TEXT"), None));
        assert!(js.starts_with("[{ "), "{js}");
        assert!(js.contains("\"id\": \"t\""), "{js}");
        assert!(js.contains("\"kind\": \"TEXT\""), "{js}");
        assert_eq!(js, found_json(&find(&d, Some("TEXT"), None)));
        let mut odd = doc();
        odd.pages[0].children[0].name = "a\"b".into();
        assert!(found_json(&find(&odd, Some("FRAME"), None)).contains("a\\\"b"));
    }
}
