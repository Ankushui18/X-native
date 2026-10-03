//! .x v2: frozen contract — schema version, migrations, validation,
//! corruption recovery, stable UUIDs, partial loading.
//! See docs/X_FORMAT_V2_SPEC.md. v1 files load via migrate_v1_to_v2.

use crate::{load_x, save_x};
use x_core::{Document, Node, NodeKind, Variables};

pub const SCHEMA_VERSION: u32 = 2;

// ---------------------------------------------------------------- metadata

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Metadata {
    pub name: String,
    pub uuid: String,
    pub app_version: String,
}

/// v2 document envelope = engine Document + contract extras.
#[derive(Debug, Default)]
pub struct DocumentV2 {
    pub doc: Document,
    pub metadata: Metadata,
    /// Optional app-level payload for document types owned by a higher-level
    /// crate (currently the infinite-canvas board). It is kept as JSON text so
    /// x-format stays independent of x-board while still preserving unknown
    /// board files through normal .x save/load.
    pub board_json: Option<String>,
    /// (family, style, source)
    pub fonts: Vec<(String, String, String)>,
    /// (id, kind, sha256, href)
    pub assets: Vec<(String, String, String, String)>,
    /// node uuid map: node id path -> uuid (stable across saves)
    pub uuids: std::collections::BTreeMap<String, String>,
}

// ------------------------------------------------------------------ uuids

/// FNV-1a 128-bit over the node's path from root — deterministic backfill
/// so migrating the same v1 file twice yields identical uuids.
pub fn fnv1a128(input: &str) -> String {
    const PRIME: u128 = 0x0000000001000000000000000000013B;
    let mut h: u128 = 0x6c62272e07bb014262b821756295c58d;
    for b in input.as_bytes() {
        h ^= *b as u128;
        h = h.wrapping_mul(PRIME);
    }
    format!("{h:032x}")
}

pub fn backfill_uuids(root: &Node, out: &mut std::collections::BTreeMap<String, String>) {
    fn walk(n: &Node, path: &str, out: &mut std::collections::BTreeMap<String, String>) {
        let p = format!("{path}/{}", n.id);
        out.entry(p.clone()).or_insert_with(|| fnv1a128(&p));
        for c in &n.children {
            walk(c, &p, out);
        }
    }
    walk(root, "", out);
}

// -------------------------------------------------------------- save/load

/// Deterministic v2 serialization: envelope with schema-ordered sections,
/// engine payload reuses the v1 node serializer (already key-sorted).
pub fn save_x_v2(d: &DocumentV2) -> String {
    let inner = save_x(&d.doc); // {"format":..,"version":1,...}
                                // strip v1 envelope, keep from "variables" on
    let payload = inner
        .strip_prefix("{\"format\":\"x-native\",\"version\":1,")
        .unwrap_or(&inner);
    let mut out = String::from("{\"format\":\"x-native\",\"version\":2,");
    out.push_str(&format!(
        "\"metadata\":{{\"name\":\"{}\",\"uuid\":\"{}\",\"app_version\":\"{}\"}},",
        esc(&d.metadata.name),
        esc(&d.metadata.uuid),
        esc(&d.metadata.app_version)
    ));
    if let Some(board_json) = &d.board_json {
        out.push_str(&format!("\"board_json\":\"{}\",", esc(board_json)));
    }
    out.push_str("\"fonts\":[");
    out.push_str(
        &d.fonts
            .iter()
            .map(|(f, s, src)| {
                format!(
                    "{{\"family\":\"{}\",\"style\":\"{}\",\"source\":\"{}\"}}",
                    esc(f),
                    esc(s),
                    esc(src)
                )
            })
            .collect::<Vec<_>>()
            .join(","),
    );
    out.push_str("],\"asset_manifest\":[");
    out.push_str(
        &d.assets
            .iter()
            .map(|(i, k, sha, href)| {
                format!(
                    "{{\"id\":\"{}\",\"kind\":\"{}\",\"sha256\":\"{}\",\"href\":\"{}\"}}",
                    esc(i),
                    esc(k),
                    esc(sha),
                    esc(href)
                )
            })
            .collect::<Vec<_>>()
            .join(","),
    );
    out.push_str("],\"uuids\":{");
    out.push_str(
        &d.uuids
            .iter()
            .map(|(k, v)| format!("\"{}\":\"{}\"", esc(k), esc(v)))
            .collect::<Vec<_>>()
            .join(","),
    );
    out.push_str("},");
    out.push_str(payload);
    out
}

fn esc(s: &str) -> String {
    crate::serialize::esc(s)
}

/// The migration chain: index N migrates schema vN+1 -> vN+2.
/// Adding v3 later = append one pure function here; nothing else changes.
pub type Migration = fn(&str) -> Result<String, String>;
pub const MIGRATIONS: &[(u32, Migration)] = &[(1, migrate_v1_to_v2)];

/// Version-dispatching loader: walks the migration chain stepwise
/// (v1 -> v2 -> ... -> CURRENT), then loads. Future versions error.
pub fn load_x_any(text: &str) -> Result<DocumentV2, String> {
    let mut version = sniff_version(text)?;
    if version > SCHEMA_VERSION {
        return Err(format!(
            "file schema v{version} is newer than supported v{SCHEMA_VERSION}"
        ));
    }
    let mut current = text.to_string();
    while version < SCHEMA_VERSION {
        let step = MIGRATIONS
            .iter()
            .find(|(from, _)| *from == version)
            .ok_or_else(|| format!("no migration from v{version}"))?;
        current = (step.1)(&current)?;
        version += 1;
    }
    load_v2(&current)
}

/// Validate-before-load: parse leniently, validate, and refuse only on
/// hard corruption. Malformed documents NEVER crash the caller — they
/// get a (possibly empty) document plus structured issues and notes.
pub fn load_checked(text: &str) -> (DocumentV2, Vec<Issue>, Vec<RecoveryNote>) {
    let (d2, notes) = load_x_lenient(text);
    let issues = validate(&d2.doc);
    (d2, issues, notes)
}

pub fn sniff_version(text: &str) -> Result<u32, String> {
    let root = crate::json::parse(text)?;
    let n = root
        .get("version")
        .and_then(crate::json::V::num)
        .ok_or("no version field")?;
    if n < 1.0 || n > u32::MAX as f64 || n.fract() != 0.0 {
        return Err("bad version number".into());
    }
    Ok(n as u32)
}

/// Pure migration step: v1 -> v2 (metadata + deterministic uuid backfill).
pub fn migrate_v1_to_v2(v1_text: &str) -> Result<String, String> {
    let doc = load_x(v1_text)?;
    let mut d2 = DocumentV2 {
        metadata: Metadata {
            name: "Untitled".into(),
            uuid: fnv1a128(v1_text),
            app_version: env!("CARGO_PKG_VERSION").into(),
        },
        ..Default::default()
    };
    for p in &doc.pages {
        backfill_uuids(p, &mut d2.uuids);
    }
    d2.doc = doc;
    Ok(save_x_v2(&d2))
}

fn load_v2(text: &str) -> Result<DocumentV2, String> {
    use crate::json::V;
    let v = crate::json::parse(text)?;
    let doc = crate::deserialize::decode_document(&v)?;
    let mut d = DocumentV2 {
        doc,
        ..Default::default()
    };
    let field = |v: &V, key: &str| v.get(key).and_then(V::str).unwrap_or_default().to_owned();
    if let Some(m) = v.get("metadata") {
        d.metadata = Metadata {
            name: field(m, "name"),
            uuid: field(m, "uuid"),
            app_version: field(m, "app_version"),
        };
    }
    if let Some(board_json) = v.get("board_json").and_then(V::str) {
        d.board_json = Some(board_json.to_owned());
    }
    if let Some(V::Obj(m)) = v.get("uuids") {
        for (key, value) in m {
            if let Some(s) = value.str() {
                d.uuids.insert(key.clone(), s.into());
            }
        }
    }
    if let Some(fonts) = v.get("fonts").and_then(V::arr) {
        d.fonts = fonts
            .iter()
            .map(|f| (field(f, "family"), field(f, "style"), field(f, "source")))
            .collect();
    }
    if let Some(assets) = v.get("asset_manifest").and_then(V::arr) {
        d.assets = assets
            .iter()
            .map(|a| {
                (
                    field(a, "id"),
                    field(a, "kind"),
                    field(a, "sha256"),
                    field(a, "href"),
                )
            })
            .collect();
    }
    if d.metadata.name.len() > 1024
        || d.metadata.uuid.len() > 1024
        || d.metadata.app_version.len() > 256
    {
        return Err("document metadata string budget exceeded".into());
    }
    Ok(d)
}

// ------------------------------------------------------------- validation

#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    pub code: &'static str,
    pub message: String,
}

pub fn validate(doc: &Document) -> Vec<Issue> {
    let mut issues = vec![];
    for page in &doc.pages {
        // E001 duplicate ids
        let mut seen = std::collections::HashSet::new();
        fn ids(n: &Node, seen: &mut std::collections::HashSet<String>, issues: &mut Vec<Issue>) {
            if !seen.insert(n.id.clone()) {
                issues.push(Issue {
                    code: "E001",
                    message: format!("duplicate node id '{}'", n.id),
                });
            }
            for c in &n.children {
                ids(c, seen, issues);
            }
        }
        ids(page, &mut seen, &mut issues);

        // component registry for E002/E003
        let mut masters: std::collections::HashMap<String, &Node> = Default::default();
        fn collect<'a>(n: &'a Node, m: &mut std::collections::HashMap<String, &'a Node>) {
            if let NodeKind::Component { name } = &n.kind {
                m.insert(name.clone(), n);
            }
            for c in &n.children {
                collect(c, m);
            }
        }
        collect(page, &mut masters);

        fn scan(
            n: &Node,
            masters: &std::collections::HashMap<String, &Node>,
            vars: &Variables,
            issues: &mut Vec<Issue>,
        ) {
            if let NodeKind::Instance { component } = &n.kind {
                match masters.get(component) {
                    None => issues.push(Issue {
                        code: "E002",
                        message: format!(
                            "instance '{}' references missing component '{component}'",
                            n.id
                        ),
                    }),
                    Some(master) => {
                        for target in n.overrides.keys() {
                            fn has(m: &Node, id: &str) -> bool {
                                m.id == id || m.children.iter().any(|c| has(c, id))
                            }
                            if !master.children.iter().any(|c| has(c, target)) {
                                issues.push(Issue { code: "E003", message: format!("override target '{target}' not found in component '{component}'") });
                            }
                        }
                    }
                }
            }
            for (prop, var) in &n.bindings {
                if !vars.numbers.contains_key(var) && !vars.colors.contains_key(var) {
                    issues.push(Issue {
                        code: "E004",
                        message: format!(
                            "binding {prop} -> undefined variable '{var}' on '{}'",
                            n.id
                        ),
                    });
                }
            }
            if !n.w.is_finite() || !n.h.is_finite() || n.w < 0.0 || n.h < 0.0 {
                issues.push(Issue {
                    code: "E006",
                    message: format!("bad geometry on '{}'", n.id),
                });
            }
            for c in &n.children {
                scan(c, masters, vars, issues);
            }
        }
        scan(page, &masters, &doc.variables, &mut issues);

        // E005 prototype destinations
        fn protos(n: &Node, pages: &[String], issues: &mut Vec<Issue>) {
            if let Some(p) = &n.prototype {
                if !pages.iter().any(|pg| pg == &p.destination) {
                    issues.push(Issue {
                        code: "E005",
                        message: format!(
                            "prototype on '{}' targets missing page '{}'",
                            n.id, p.destination
                        ),
                    });
                }
            }
            for c in &n.children {
                protos(c, pages, issues);
            }
        }
        let page_ids: Vec<String> = doc.pages.iter().map(|p| p.id.clone()).collect();
        protos(page, &page_ids, &mut issues);
    }
    issues
}

// ------------------------------------------------------------- recovery

#[derive(Debug, Clone)]
pub struct RecoveryNote(pub String);

/// Never-fail loader: longest-valid-prefix by brace balancing, then close.
pub fn load_x_lenient(text: &str) -> (DocumentV2, Vec<RecoveryNote>) {
    let mut notes = vec![];
    if text.len() > crate::admission::MAX_INPUT_BYTES {
        return (
            DocumentV2::default(),
            vec![RecoveryNote("input exceeds recovery budget".into())],
        );
    }
    if let Ok(d) = load_x_any(text) {
        return (d, notes);
    }
    // brace-balance repair: cut to last position where braces close cleanly
    let bytes = text.as_bytes();
    let (mut depth, mut in_str, mut escp) = (0i32, false, false);
    let mut best_end = 0usize;
    for (i, &b) in bytes.iter().enumerate() {
        if in_str {
            if escp {
                escp = false;
            } else if b == b'\\' {
                escp = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'{' | b'[' => {
                depth += 1;
                if depth > crate::json::MAX_JSON_DEPTH as i32 {
                    return (
                        DocumentV2::default(),
                        vec![RecoveryNote("recovery depth budget exceeded".into())],
                    );
                }
            }
            b'}' | b']' => {
                depth -= 1;
                if depth >= 0 {
                    best_end = i + 1;
                }
            }
            _ => {}
        }
    }
    // try progressively: prefix + needed closers
    if best_end == 0 {
        return (
            DocumentV2::default(),
            vec![RecoveryNote("no complete value to recover".into())],
        );
    }
    let prefix = &text[..best_end];
    let mut attempt = String::from(prefix);
    // count unclosed
    let (mut in_s, mut esc2) = (false, false);
    let mut closers = vec![];
    for &b in attempt.as_bytes() {
        if in_s {
            if esc2 {
                esc2 = false;
            } else if b == b'\\' {
                esc2 = true;
            } else if b == b'"' {
                in_s = false;
            }
            continue;
        }
        match b {
            b'"' => in_s = true,
            b'{' => closers.push('}'),
            b'[' => closers.push(']'),
            b'}' | b']' => {
                closers.pop();
            }
            _ => {}
        }
    }
    // drop trailing comma if present
    while attempt.ends_with(',') || attempt.ends_with(':') {
        attempt.pop();
        notes.push(RecoveryNote("dropped dangling separator".into()));
    }
    for c in closers.iter().rev() {
        attempt.push(*c);
    }
    match load_x_any(&attempt) {
        Ok(d) => {
            notes.push(RecoveryNote(format!(
                "recovered by truncating {} byte(s)",
                text.len() - best_end
            )));
            (d, notes)
        }
        Err(e) => {
            notes.push(RecoveryNote(format!(
                "unrecoverable ({e}); returning empty document"
            )));
            (DocumentV2::default(), notes)
        }
    }
}

// --------------------------------------------------------- partial loading

/// Locate pages without a full parse: returns (page id, byte range).
pub fn list_pages(text: &str) -> Vec<(String, std::ops::Range<usize>)> {
    let mut out = vec![];
    let Some(pages_at) = text.find("\"pages\":[") else {
        return out;
    };
    let body_start = pages_at + 9;
    let bytes = text.as_bytes();
    let (mut i, mut depth, mut in_str, mut escp) = (body_start, 0i32, false, false);
    let mut obj_start = None;
    while i < bytes.len() {
        let b = bytes[i];
        if in_str {
            if escp {
                escp = false;
            } else if b == b'\\' {
                escp = true;
            } else if b == b'"' {
                in_str = false;
            }
        } else {
            match b {
                b'"' => in_str = true,
                b'{' => {
                    if depth == 0 {
                        obj_start = Some(i);
                    }
                    depth += 1;
                }
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        if let Some(s) = obj_start.take() {
                            let slice = &text[s..=i];
                            let id = crate::json::parse(slice)
                                .ok()
                                .and_then(|v| {
                                    v.get("id").and_then(crate::json::V::str).map(str::to_owned)
                                })
                                .unwrap_or_default();
                            out.push((id, s..i + 1));
                        }
                    }
                }
                b']' if depth == 0 => break,
                _ => {}
            }
        }
        i += 1;
    }
    out
}

/// Decode exactly one page subtree by id.
pub fn load_page(text: &str, page_id: &str) -> Option<Node> {
    let pages = list_pages(text);
    let (_, range) = pages.into_iter().find(|(id, _)| id == page_id)?;
    let single = format!(
        "{{\"format\":\"x-native\",\"version\":1,\"pages\":[{}]}}",
        &text[range]
    );
    load_x(&single)
        .ok()
        .and_then(|d| d.pages.into_iter().next())
}

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::{Color, Node};

    fn sample_v1() -> String {
        let mut doc = Document::new();
        doc.variables.numbers.insert("gap".into(), 12.0);
        doc.pages
            .push(Node::frame("page-1", 400.0, 300.0).child(Node::rect(
                "r1",
                10.0,
                10.0,
                50.0,
                50.0,
                Color::from_rgb8(255, 0, 0),
            )));
        doc.pages.push(
            Node::frame("page-2", 400.0, 300.0)
                .child(Node::text("t1", 0.0, 0.0, 100.0, 20.0, "hi")),
        );
        save_x(&doc)
    }

    #[test]
    fn migration_chain_walks_stepwise_and_load_checked_never_panics() {
        // chain covers v1 -> v2
        assert_eq!(MIGRATIONS.len(), 1);
        assert_eq!(MIGRATIONS[0].0, 1);
        let v1 = sample_v1();
        let d = load_x_any(&v1).unwrap();
        assert_eq!(d.doc.pages.len(), 2);
        // load_checked: valid -> no issues, no notes
        let (d, issues, notes) = load_checked(&v1);
        assert!(issues.is_empty() && notes.is_empty());
        assert_eq!(d.doc.pages.len(), 2);
        // load_checked: corrupt -> notes, still a document, NO panic
        let (_, _, notes) = load_checked(&v1[..v1.len() / 2]);
        assert!(!notes.is_empty());
        // load_checked: garbage -> empty doc + notes, NO panic
        let (d, _, notes) = load_checked("{{{{ nonsense");
        assert!(d.doc.pages.is_empty() && !notes.is_empty());
    }

    #[test]
    fn v1_files_migrate_to_v2_with_stable_uuids() {
        let v1 = sample_v1();
        let a = migrate_v1_to_v2(&v1).unwrap();
        let b = migrate_v1_to_v2(&v1).unwrap();
        assert_eq!(a, b, "migration must be deterministic");
        let d2 = load_x_any(&v1).unwrap();
        assert_eq!(d2.doc.pages.len(), 2);
        assert!(d2.uuids.contains_key("/page-1"));
        assert!(d2.uuids.contains_key("/page-1/r1"));
        assert_eq!(d2.uuids["/page-1/r1"].len(), 32);
    }

    #[test]
    fn v2_roundtrip_is_deterministic_and_preserves_envelope() {
        let d2 = load_x_any(&sample_v1()).unwrap();
        let s1 = save_x_v2(&d2);
        let re = load_x_any(&s1).unwrap();
        let s2 = save_x_v2(&re);
        assert_eq!(s1, s2, "save(load(save)) must be byte-identical");
        assert_eq!(re.metadata.uuid, d2.metadata.uuid);
        assert_eq!(re.uuids, d2.uuids, "node uuids must survive");
    }

    #[test]
    fn newer_versions_are_rejected_with_both_numbers() {
        let err = load_x_any("{\"format\":\"x-native\",\"version\":9,\"pages\":[]}").unwrap_err();
        assert!(err.contains("v9") && err.contains("v2"), "{err}");
    }

    #[test]
    fn validation_catches_all_error_classes() {
        let mut doc = Document::new();
        let mut comp = Node::component("c", "Button", 100.0, 40.0);
        comp.children
            .push(Node::rect("bg", 0.0, 0.0, 100.0, 40.0, Color::BLACK));
        let mut bad_inst = Node::instance("i-ghost", "Ghost", 0.0, 0.0, 10.0, 10.0);
        bad_inst.overrides.insert("nope".into(), "#ff0000".into());
        let mut ok_inst = Node::instance("i-ok", "Button", 0.0, 0.0, 10.0, 10.0);
        ok_inst
            .overrides
            .insert("missing-target".into(), "#ff0000".into());
        let mut bound = Node::rect("b", 0.0, 0.0, 10.0, 10.0, Color::BLACK);
        bound
            .bindings
            .insert("radius".into(), "undefined-var".into());
        let mut nan = Node::rect("n", 0.0, 0.0, 10.0, 10.0, Color::BLACK);
        nan.w = f64::NAN;
        doc.pages.push(
            Node::frame("page", 400.0, 300.0)
                .child(comp)
                .child(bad_inst)
                .child(ok_inst)
                .child(bound)
                .child(nan)
                .child(Node::rect("dup", 0.0, 0.0, 1.0, 1.0, Color::BLACK))
                .child(Node::rect("dup", 0.0, 0.0, 1.0, 1.0, Color::BLACK))
                .child(
                    Node::rect("p", 0.0, 0.0, 1.0, 1.0, Color::BLACK)
                        .prototype("no-such-page", 100),
                ),
        );
        let issues = validate(&doc);
        let codes: Vec<&str> = issues.iter().map(|i| i.code).collect();
        for c in ["E001", "E002", "E003", "E004", "E005", "E006"] {
            assert!(codes.contains(&c), "missing {c} in {codes:?}");
        }
        // clean doc -> no issues
        let clean = load_x(&sample_v1()).unwrap();
        assert!(validate(&clean).is_empty());
    }

    #[test]
    fn corruption_recovery_salvages_truncated_files() {
        let v1 = sample_v1();
        // chop 30% off the end
        let cut = &v1[..v1.len() * 7 / 10];
        let (doc, notes) = load_x_lenient(cut);
        assert!(!notes.is_empty());
        assert!(
            !doc.doc.pages.is_empty(),
            "should salvage at least one page"
        );
        // garbage-append also survives
        let dirty = format!("{v1}garbage trailing bytes!!!");
        let (doc2, _) = load_x_lenient(&dirty);
        assert_eq!(doc2.doc.pages.len(), 2);
        // total garbage -> empty doc, note explains
        let (doc3, notes3) = load_x_lenient("not json at all");
        assert!(doc3.doc.pages.is_empty());
        assert!(!notes3.is_empty());
    }

    #[test]
    fn partial_loading_finds_and_decodes_single_pages() {
        let v1 = sample_v1();
        let pages = list_pages(&v1);
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].0, "page-1");
        assert_eq!(pages[1].0, "page-2");
        // decode ONLY page-2
        let p2 = load_page(&v1, "page-2").unwrap();
        assert_eq!(p2.id, "page-2");
        assert_eq!(p2.children[0].id, "t1");
        assert!(load_page(&v1, "nope").is_none());
    }
}

#[cfg(test)]
mod reliability_regressions {
    use super::*;
    #[test]
    fn legacy_duplicate_asset_envelope_is_migrated_without_losing_either_table() {
        let old = r#"{"format":"x-native","version":2,"assets":[{"id":"manifest","kind":"image","sha256":"hash","href":"local"}],"pages":[],"assets":[]}"#;
        let d = load_x_any(old).unwrap();
        assert_eq!(d.assets.len(), 1);
        let saved = save_x_v2(&d);
        assert_eq!(saved.matches("\"assets\":").count(), 1);
        assert!(saved.contains("\"asset_manifest\":"));
    }
    #[test]
    fn metadata_fonts_and_escaped_uuid_keys_survive() {
        let mut d = DocumentV2::default();
        d.metadata.name = "A\"B\nC\tन".into();
        d.fonts
            .push(("Inter".into(), "Regular".into(), "bundled".into()));
        d.uuids.insert("/page/quoted\"id".into(), "stable".into());
        let again = load_x_any(&save_x_v2(&d)).unwrap();
        assert_eq!(again.metadata.name, d.metadata.name);
        assert_eq!(again.fonts, d.fonts);
        assert_eq!(again.uuids, d.uuids);
    }
}
