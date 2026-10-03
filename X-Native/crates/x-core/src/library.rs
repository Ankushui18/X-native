//! Design libraries (review item: "local vs library").
//!
//! Deliberate architecture — NOT "load styles from another .x file":
//!
//! * A library is a standalone versioned artifact (`.xlib`) carrying
//!   styles / variables / components / assets under ONE library_id.
//! * Consumers reference objects by STABLE URI, never by copying:
//!   `library://<library-id>/style/<name>` — a node's style binding can
//!   point at a library ref, and the document stores a
//!   `LibraryDependency { library_id, resolved_version, source_path }`.
//! * VERSIONING FIRST: a dependency is PINNED to the version it was
//!   designed against. A newer library file NEVER changes a document
//!   silently — `diff_library()` computes the changeset and the app asks
//!   the designer to review + accept (`accept_update()`), which is the
//!   review's "Update available → Review changes → Accept" flow.

use crate::{AssetStore, LegacyStyle, Node, NodeKind, Style, Variables, STYLE_BINDING_KEYS};
use std::collections::HashMap;

pub const LIBRARY_URI_PREFIX: &str = "library://";

/// `library://<lib>/style/<name>` — parsed form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryRef {
    pub library_id: String,
    /// object class: "style" | "variable" | "component" | "asset"
    pub class: String,
    pub name: String,
}

impl LibraryRef {
    pub fn parse(uri: &str) -> Option<Self> {
        let rest = uri.strip_prefix(LIBRARY_URI_PREFIX)?;
        let mut it = rest.splitn(3, '/');
        let library_id = it.next()?.to_string();
        let class = it.next()?.to_string();
        let name = it.next()?.to_string();
        (!library_id.is_empty() && !class.is_empty() && !name.is_empty()).then_some(Self {
            library_id,
            class,
            name,
        })
    }
    pub fn uri(&self) -> String {
        format!(
            "{LIBRARY_URI_PREFIX}{}/{}/{}",
            self.library_id, self.class, self.name
        )
    }
    pub fn style(lib: &str, name: &str) -> Self {
        Self {
            library_id: lib.into(),
            class: "style".into(),
            name: name.into(),
        }
    }
}

/// The versioned library artifact (serialized as .xlib by x-format).
#[derive(Debug, Clone, Default)]
pub struct Library {
    pub library_id: String,
    pub name: String,
    /// monotonically increasing integer version
    pub version: u32,
    pub styles: HashMap<String, LegacyStyle>,
    pub variables: Variables,
    /// component master trees (a page-less forest)
    pub components: Vec<Node>,
    pub assets: AssetStore,
}

/// A consumer document's pinned dependency on a library.
#[derive(Debug, Clone, PartialEq)]
pub struct LibraryDependency {
    pub library_id: String,
    /// the version this document was designed against (PINNED)
    pub resolved_version: u32,
    /// integrity: fnv1a128 of the snapshot's canonical .xlib serialization.
    /// Verified on load — a manually edited .x, damaged snapshot, or
    /// partial write fails the check and surfaces a corruption warning
    /// instead of silently rendering wrong values. Empty = legacy doc
    /// (pre-integrity), accepted with a warning.
    pub snapshot_hash: String,
    /// where the .xlib was loaded from (machine-local hint, not identity)
    pub source_path: String,
}

// -------------------------------------------------------------- resolution

/// Resolve a library style ref against the loaded libraries. Only the
/// PINNED version's snapshot may be consulted — the caller passes the
/// snapshot it stored at accept-time (see `Document.library_snapshots`).
pub fn resolve_library_style<'a>(
    snapshots: &'a HashMap<String, Library>,
    r: &LibraryRef,
) -> Option<&'a LegacyStyle> {
    if r.class != "style" {
        return None;
    }
    snapshots.get(&r.library_id)?.styles.get(&r.name)
}

/// Re-apply every binding in the subtree that points at a library://
/// style, using the pinned snapshots. Same contract as resolve_styles but
/// for library refs. Returns updated-consumer count.
pub fn resolve_library_styles(n: &mut Node, snapshots: &HashMap<String, Library>) -> usize {
    let mut count = 0;
    for (key, _) in STYLE_BINDING_KEYS {
        let Some(raw) = n.bindings.get(key).cloned() else {
            continue;
        };
        let Some(r) = LibraryRef::parse(&raw) else {
            continue;
        };
        if let Some(s) = resolve_library_style(snapshots, &r) {
            crate::apply_style(n, s);
            count += 1;
        }
        // missing library/style: values stay frozen (never blank a design)
    }
    for c in &mut n.children {
        count += resolve_library_styles(c, snapshots);
    }
    count
}

/// Usage count of one library style ref in a subtree.
pub fn library_style_usage(n: &Node, r: &LibraryRef) -> usize {
    let uri = r.uri();
    let mut count = STYLE_BINDING_KEYS
        .iter()
        .filter(|(k, _)| n.bindings.get(*k).map(String::as_str) == Some(uri.as_str()))
        .count();
    for c in &n.children {
        count += library_style_usage(c, r);
    }
    count
}

/// Count live instances of a component (by master name) in a subtree.
pub fn count_instances(n: &Node, component: &str) -> usize {
    let mut count = match &n.kind {
        crate::NodeKind::Instance { component: c } if c == component => 1,
        _ => 0,
    };
    for c in &n.children {
        count += count_instances(c, component);
    }
    count
}

/// Build a publishable library from document parts: every named style,
/// the variables, and every visible Component node in the page forest
/// (deduped by component name — first definition wins, hidden registry
/// masters are excluded). The "publish" half of the library lifecycle;
/// `mklib`/demo docs are the seed, this is the app-side flow.
pub fn library_from_parts(
    styles: &std::collections::HashMap<String, crate::LegacyStyle>,
    vars: &crate::Variables,
    pages: &[Node],
    library_id: &str,
    name: &str,
    version: u32,
) -> Library {
    let mut lib = Library {
        library_id: library_id.to_string(),
        name: name.to_string(),
        version,
        styles: styles.clone(),
        variables: vars.clone(),
        ..Default::default()
    };
    let mut seen: Vec<String> = vec![];
    fn collect(n: &Node, lib: &mut Library, seen: &mut Vec<String>) {
        if let crate::NodeKind::Component { name } = &n.kind {
            if n.visible && !seen.contains(name) {
                seen.push(name.clone());
                lib.components.push(n.clone());
            }
        }
        for c in &n.children {
            collect(c, lib, seen);
        }
    }
    for page in pages {
        collect(page, &mut lib, &mut seen);
    }
    lib
}

// -------------------------------------------------------------- versioning

#[cfg(test)]
mod publish_tests {
    use super::*;
    use crate::{Document, Node, NodeKind, Style, Variables};

    #[test]
    fn library_from_parts_collects_styles_vars_visible_components() {
        let mut styles = std::collections::HashMap::new();
        styles.insert(
            "Paint/Primary".into(),
            LegacyStyle::Paint {
                fill: crate::Paint::Solid(crate::Color::from_rgb8(0, 0, 255)),
            },
        );
        let mut vars = Variables::default();
        vars.numbers.insert("gap".into(), 8.0);

        let mut page = Node::frame("page", 400.0, 300.0);
        let mut btn = Node::rect("btn", 0.0, 0.0, 100.0, 40.0, crate::Color::WHITE);
        btn.kind = NodeKind::Component {
            name: "Button".into(),
        };
        let mut dup = btn.clone();
        dup.id = "btn-dup".into(); // same name -> deduped
        let mut hidden = Node::rect("hid", 0.0, 0.0, 10.0, 10.0, crate::Color::WHITE);
        hidden.kind = NodeKind::Component {
            name: "Registry".into(),
        };
        hidden.visible = false; // registry masters never publish
        page.children.push(btn);
        page.children.push(dup);
        page.children.push(hidden);

        let lib = library_from_parts(&styles, &vars, &[page.clone()], "kit", "Kit", 2);
        assert_eq!(lib.library_id, "kit");
        assert_eq!(lib.version, 2);
        assert_eq!(lib.styles.len(), 1);
        assert_eq!(lib.variables.numbers["gap"], 8.0);
        assert_eq!(lib.components.len(), 1, "dedupe by name, skip hidden");
        assert!(
            matches!(&lib.components[0].kind, NodeKind::Component { name } if name == "Button")
        );
    }

    #[test]
    fn count_instances_counts_by_master_name() {
        let mut page = Node::frame("page", 400.0, 300.0);
        for i in 0..3 {
            page.children.push(Node::instance(
                &format!("i{i}"),
                "Button",
                0.0,
                0.0,
                10.0,
                10.0,
            ));
        }
        page.children
            .push(Node::instance("other", "Card", 0.0, 0.0, 10.0, 10.0));
        assert_eq!(count_instances(&page, "Button"), 3);
        assert_eq!(count_instances(&page, "Card"), 1);
        assert_eq!(count_instances(&page, "None"), 0);
    }
}

/// One reviewed change between the pinned snapshot and a newer library.
#[derive(Debug, Clone, PartialEq)]
pub enum LibraryChange {
    StyleAdded(String),
    StyleRemoved(String),
    StyleModified(String),
    VariableChanged(String),
    ComponentAdded(String),
    ComponentRemoved(String),
}

/// The review's "Update available → Review changes" step: a precise
/// changeset between the version a document pinned and a newer file.
pub fn diff_library(pinned: &Library, newer: &Library) -> Vec<LibraryChange> {
    let mut out = vec![];
    for (name, def) in &newer.styles {
        match pinned.styles.get(name) {
            None => out.push(LibraryChange::StyleAdded(name.clone())),
            Some(old) if old != def => out.push(LibraryChange::StyleModified(name.clone())),
            _ => {}
        }
    }
    for name in pinned.styles.keys() {
        if !newer.styles.contains_key(name) {
            out.push(LibraryChange::StyleRemoved(name.clone()));
        }
    }
    for (k, v) in &newer.variables.colors {
        if pinned.variables.colors.get(k) != Some(v) {
            out.push(LibraryChange::VariableChanged(k.clone()));
        }
    }
    for (k, v) in &newer.variables.numbers {
        if pinned.variables.numbers.get(k) != Some(v) {
            out.push(LibraryChange::VariableChanged(k.clone()));
        }
    }
    let names = |l: &Library| -> Vec<String> {
        l.components
            .iter()
            .filter_map(|c| match &c.kind {
                crate::NodeKind::Component { name } => Some(name.clone()),
                _ => None,
            })
            .collect()
    };
    let (pn, nn) = (names(pinned), names(newer));
    for n in &nn {
        if !pn.contains(n) {
            out.push(LibraryChange::ComponentAdded(n.clone()));
        }
    }
    for n in &pn {
        if !nn.contains(n) {
            out.push(LibraryChange::ComponentRemoved(n.clone()));
        }
    }
    out.sort_by_key(|c| format!("{c:?}"));
    out
}

/// The review's "Accept" step: repin the dependency to the newer version,
/// swap the snapshot, and re-resolve every consumer in the given pages.
/// Returns (accepted changes, updated consumer count).
pub fn accept_update(
    dep: &mut LibraryDependency,
    snapshots: &mut HashMap<String, Library>,
    pages: &mut [Node],
    newer: Library,
) -> (Vec<LibraryChange>, usize) {
    let changes = snapshots
        .get(&dep.library_id)
        .map(|pinned| diff_library(pinned, &newer))
        .unwrap_or_default();
    dep.resolved_version = newer.version;
    snapshots.insert(dep.library_id.clone(), newer);
    let mut updated = 0;
    for p in pages.iter_mut() {
        updated += resolve_library_styles(p, snapshots);
        // COMPONENT PROPAGATION: registry masters placed from this
        // library (id "libmaster-<lib>-<name>") are refreshed to the
        // accepted version's definition — every instance re-renders.
        updated += refresh_library_masters(p, &dep.library_id, snapshots);
    }
    (changes, updated)
}

/// Swap the CHILDREN + size of registry masters (id convention
/// `libmaster-<library_id>-<component_name>`) to the pinned snapshot's
/// current definition. Instances reference masters by component name,
/// so they pick the refresh up automatically. Returns masters updated.
pub fn refresh_library_masters(
    page: &mut Node,
    library_id: &str,
    snapshots: &HashMap<String, Library>,
) -> usize {
    let Some(lib) = snapshots.get(library_id) else {
        return 0;
    };
    let prefix = format!("libmaster-{library_id}-");
    fn walk(n: &mut Node, prefix: &str, lib: &Library, count: &mut usize) {
        if let Some(comp_name) = n.id.strip_prefix(prefix).map(str::to_string) {
            if let NodeKind::Component { .. } = &n.kind {
                if let Some(def) = lib
                    .components
                    .iter()
                    .find(|c| matches!(&c.kind, NodeKind::Component { name } if *name == comp_name))
                {
                    n.children = def.children.clone();
                    n.w = def.w;
                    n.h = def.h;
                    n.dirty = true;
                    *count += 1;
                }
            }
        }
        for c in &mut n.children {
            walk(c, prefix, lib, count);
        }
    }
    let mut count = 0;
    walk(page, &prefix, lib, &mut count);
    count
}

/// FREEZE-ON-CORRUPT: strip corrupt/missing libraries out of a snapshot
/// map before resolution. Bindings that point into removed libraries
/// keep their last-applied values (resolve skips unknown refs by design)
/// instead of resolving against damaged data. Returns frozen library ids.
pub fn freeze_unverified(
    snapshots: &mut HashMap<String, Library>,
    verdicts: &[(String, bool)], // (library_id, verified?)
) -> Vec<String> {
    let mut frozen = vec![];
    for (id, ok) in verdicts {
        if !ok && snapshots.remove(id).is_some() {
            frozen.push(id.clone());
        }
    }
    frozen
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{bind_style, Color, Paint};

    fn brand_v1() -> Library {
        let mut l = Library {
            library_id: "brand-system".into(),
            name: "Brand System".into(),
            version: 1,
            ..Default::default()
        };
        l.styles.insert(
            "primary".into(),
            LegacyStyle::Paint {
                fill: Paint::Solid(Color::from_rgb8(0x33, 0x66, 0xFF)),
            },
        );
        l.styles.insert(
            "surface".into(),
            LegacyStyle::Paint {
                fill: Paint::Solid(Color::WHITE),
            },
        );
        l.variables.numbers.insert("radius".into(), 8.0);
        l
    }

    #[test]
    fn refs_parse_and_roundtrip() {
        let r = LibraryRef::parse("library://brand-system/style/primary").unwrap();
        assert_eq!(r.library_id, "brand-system");
        assert_eq!(r.class, "style");
        assert_eq!(r.name, "primary");
        assert_eq!(r.uri(), "library://brand-system/style/primary");
        assert!(
            LibraryRef::parse("library://x/style").is_none(),
            "missing name"
        );
        assert!(LibraryRef::parse("asset://abc").is_none());
        // names may contain slashes ("Primary / 500")
        let r2 = LibraryRef::parse("library://brand-system/style/Primary/500").unwrap();
        assert_eq!(r2.name, "Primary/500");
    }

    #[test]
    fn library_binding_resolves_from_pinned_snapshot_only() {
        let lib = brand_v1();
        let mut snapshots = HashMap::new();
        snapshots.insert(lib.library_id.clone(), lib.clone());
        let mut page = Node::frame("p", 100.0, 100.0).child(Node::rect(
            "a",
            0.0,
            0.0,
            10.0,
            10.0,
            Color::BLACK,
        ));
        // bind by URI (the app writes the uri into the binding)
        let r = LibraryRef::style("brand-system", "primary");
        let def = resolve_library_style(&snapshots, &r).unwrap().clone();
        bind_style(&mut page.children[0], &r.uri(), &def);
        assert_eq!(
            page.children[0].fill,
            Paint::Solid(Color::from_rgb8(0x33, 0x66, 0xFF))
        );
        // resolving against the SAME pinned snapshot is a no-op change-wise
        let n = resolve_library_styles(&mut page, &snapshots);
        assert_eq!(n, 1);
        assert_eq!(
            page.children[0].fill,
            Paint::Solid(Color::from_rgb8(0x33, 0x66, 0xFF))
        );
        // a missing library must freeze values, not blank them
        let empty = HashMap::new();
        let n2 = resolve_library_styles(&mut page, &empty);
        assert_eq!(n2, 0);
        assert_eq!(
            page.children[0].fill,
            Paint::Solid(Color::from_rgb8(0x33, 0x66, 0xFF)),
            "frozen"
        );
        assert_eq!(library_style_usage(&page, &r), 1);
    }

    #[test]
    fn newer_library_never_changes_consumers_silently() {
        // v1 pinned; v2 exists on disk. Nothing may change until accept.
        let v1 = brand_v1();
        let mut v2 = brand_v1();
        v2.version = 2;
        v2.styles.insert(
            "primary".into(),
            LegacyStyle::Paint {
                fill: Paint::Solid(Color::from_rgb8(0x66, 0x33, 0xFF)),
            },
        );
        v2.styles.insert(
            "danger".into(),
            LegacyStyle::Paint {
                fill: Paint::Solid(Color::from_rgb8(0xE7, 0x4C, 0x3C)),
            },
        );
        v2.styles.remove("surface");

        let mut snapshots = HashMap::new();
        snapshots.insert(v1.library_id.clone(), v1.clone());
        let mut dep = LibraryDependency {
            library_id: "brand-system".into(),
            resolved_version: 1,
            snapshot_hash: String::new(),
            source_path: "brand.xlib".into(),
        };
        let r = LibraryRef::style("brand-system", "primary");
        let def = resolve_library_style(&snapshots, &r).unwrap().clone();
        let mut pages = vec![Node::frame("p", 100.0, 100.0).child(Node::rect(
            "a",
            0.0,
            0.0,
            10.0,
            10.0,
            Color::BLACK,
        ))];
        bind_style(&mut pages[0].children[0], &r.uri(), &def);

        // v2 exists — but the document is pinned to v1: resolve does NOT move
        resolve_library_styles(&mut pages[0], &snapshots);
        assert_eq!(
            pages[0].children[0].fill,
            Paint::Solid(Color::from_rgb8(0x33, 0x66, 0xFF)),
            "pinned version protects the document"
        );

        // review: the changeset is precise
        let changes = diff_library(&v1, &v2);
        assert!(changes.contains(&LibraryChange::StyleModified("primary".into())));
        assert!(changes.contains(&LibraryChange::StyleAdded("danger".into())));
        assert!(changes.contains(&LibraryChange::StyleRemoved("surface".into())));

        // accept: repin + snapshot swap + consumers update NOW
        let (accepted, updated) = accept_update(&mut dep, &mut snapshots, &mut pages, v2);
        assert_eq!(accepted.len(), changes.len());
        assert_eq!(dep.resolved_version, 2);
        assert_eq!(updated, 1);
        assert_eq!(
            pages[0].children[0].fill,
            Paint::Solid(Color::from_rgb8(0x66, 0x33, 0xFF)),
            "consumer updated only after explicit accept"
        );
    }
}
