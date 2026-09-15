#[allow(unused_imports)]
use crate::*;
use kurbo::{Affine, Circle, Rect, RoundedRect, RoundedRectRadii, Shape};
use peniko::{Brush, Color, Fill, Gradient, Mix};
use std::collections::HashMap;

// ---------------------------------------------------------------- documents

/// Phase 6.5 / 7: a document is a set of pages plus its variable collection.
/// A reusable style: named paint / text / effect presets (standard styles).
/// DEPRECATED: Use x_core::styles::Style instead for the full styles system.
#[derive(Debug, Clone, PartialEq)]
pub enum LegacyStyle {
    Paint {
        fill: Paint,
    },
    /// A text style. Carries `TextStyleData` — the same property set Figma's
    /// text styles carry — so a style can hold line height, letter spacing,
    /// paragraph spacing/indent, case, decoration, lists and wrap instead of
    /// the four numbers this variant used to squeeze into.
    Text(TextStyleData),
    Effect {
        effects: Vec<Effect>,
    },
}

impl LegacyStyle {
    pub fn kind_label(&self) -> &'static str {
        match self {
            LegacyStyle::Paint { .. } => "PAINT",
            LegacyStyle::Text(..) => "TEXT",
            LegacyStyle::Effect { .. } => "FX",
        }
    }
}

/// Binding keys a node can carry in `bindings` to stay LINKED to a named
/// style (standard semantics: edit the style -> every consumer updates).
pub const STYLE_BINDING_KEYS: [(&str, &str); 3] = [
    ("style:paint", "PAINT"),
    ("style:text", "TEXT"),
    ("style:fx", "FX"),
];

pub fn binding_key_for(s: &LegacyStyle) -> &'static str {
    match s {
        LegacyStyle::Paint { .. } => "style:paint",
        LegacyStyle::Text(..) => "style:text",
        LegacyStyle::Effect { .. } => "style:fx",
    }
}

/// Apply a named style AND link the node to it (bindings["style:kind"] = name).
/// Subsequent `resolve_styles` calls keep the node in sync when the style
/// definition changes.
pub fn bind_style(n: &mut Node, name: &str, s: &LegacyStyle) {
    n.bindings.insert(binding_key_for(s).into(), name.into());
    apply_style(n, s);
}

/// Remove the style link of `kind_key` ("style:paint"/"style:text"/
/// "style:fx") from a node — values stay as-is (detach style).
pub fn detach_style(n: &mut Node, kind_key: &str) -> bool {
    n.bindings.remove(kind_key).is_some()
}

/// Detach a TEXT style from a node: the layer keeps the typography it renders
/// today but loses its `style:text` link, so later edits to the style stop
/// reaching it (Figma's "Detach style"). Returns false when it was not linked.
///
/// Snapshot-first: the values a text style writes live in the very bindings
/// [`TextStyleData::clear_from_node`] drops, so clearing without re-applying
/// the snapshot would silently reset the layer's type.
pub fn detach_text_style(n: &mut Node) -> bool {
    if !n.bindings.contains_key("style:text") {
        return false;
    }
    let keep = TextStyleData::from_node(n);
    TextStyleData::clear_from_node(n);
    keep.apply_to_node(n);
    n.bindings.remove("style:text");
    n.dirty = true;
    true
}

/// How many nodes in the subtree are bound to style `name` (usage count).
pub fn style_usage(n: &Node, name: &str) -> usize {
    let mut count = STYLE_BINDING_KEYS
        .iter()
        .filter(|(k, _)| n.bindings.get(*k).map(String::as_str) == Some(name))
        .count();
    for c in &n.children {
        count += style_usage(c, name);
    }
    count
}

/// Rename a style across the registry AND every consumer binding in the
/// given page trees. Returns rebound consumer count; None if `from` is
/// missing or `to` already exists (no silent overwrite).
pub fn rename_style(
    styles: &mut HashMap<String, LegacyStyle>,
    pages: &mut [Node],
    from: &str,
    to: &str,
) -> Option<usize> {
    if from == to || to.is_empty() || !styles.contains_key(from) || styles.contains_key(to) {
        return None;
    }
    let s = styles.remove(from)?;
    styles.insert(to.to_string(), s);
    fn rebind(n: &mut Node, from: &str, to: &str) -> usize {
        let mut c = 0;
        for (k, _) in STYLE_BINDING_KEYS {
            if n.bindings.get(k).map(String::as_str) == Some(from) {
                n.bindings.insert(k.into(), to.into());
                c += 1;
            }
        }
        for ch in &mut n.children {
            c += rebind(ch, from, to);
        }
        c
    }
    Some(pages.iter_mut().map(|p| rebind(p, from, to)).sum())
}

/// Re-apply every bound style in the subtree. Call after mutating a style
/// definition: this is the "style mutation -> all consumers update" pass.
/// Returns the number of nodes updated.
pub fn resolve_styles(n: &mut Node, styles: &HashMap<String, LegacyStyle>) -> usize {
    let mut count = 0;
    for (key, _) in STYLE_BINDING_KEYS {
        if let Some(name) = n.bindings.get(key).cloned() {
            if let Some(s) = styles.get(&name) {
                apply_style(n, s);
                count += 1;
            }
        }
    }
    for c in &mut n.children {
        count += resolve_styles(c, styles);
    }
    count
}

/// Apply a named style to a node (apply style). Paint styles set
/// the fill, text styles set the font binding + size (text size == node.h
/// in this engine), effect styles replace the effect list.
pub fn apply_style(n: &mut Node, s: &LegacyStyle) {
    match s {
        LegacyStyle::Paint { fill } => {
            n.fill = fill.clone();
            if n.visual_stacks_materialized {
                if let Some(top) = n.fill_layers.last_mut() {
                    top.paint = fill.clone();
                }
            }
        }
        LegacyStyle::Text(data) => {
            // The whole property set, through the bindings every renderer
            // reads (fs/fw/font/ls/lhm/lhpx/lhp/ps/pi/tc/tw) plus the typed
            // fields the .x format and the inspector read. The old applier
            // wrote only `font` and stuffed the size into `n.h`, which the
            // px-contract renderers ignore as soon as an `fs` binding exists.
            data.apply_to_node(n);
        }
        LegacyStyle::Effect { effects } => {
            n.effects = effects.clone();
            if n.visual_stacks_materialized {
                n.effect_layers = effects.iter().cloned().map(EffectLayer::new).collect();
            }
        }
    }
    n.dirty = true;
}

/// Canvas comment pin (review C18): an anchored discussion bubble.
/// Comments live per PAGE (world coordinates of the pin anchor) and are
/// shallow — one message + resolved flag; threading/replies stay out
/// until the collaboration layer (C17) defines identity.
#[derive(Debug, Clone, PartialEq)]
pub struct Comment {
    pub id: String,
    /// page index into `pages`
    pub page: usize,
    /// pin anchor in page/world coordinates
    pub x: f64,
    pub y: f64,
    pub author: String,
    pub text: String,
    pub resolved: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Document {
    /// The kind of document: Design (frames, components, code export) or
    /// Board (freeform sticky notes, connectors, infinite canvas).
    pub kind: DocumentKind,
    pub pages: Vec<Node>,
    pub variables: Variables,
    /// named reusable styles (Phase: Styles)
    pub styles: HashMap<String, LegacyStyle>,
    /// content-addressed assets (asset:// ids); Embedded records
    /// serialize into .x so documents stay portable
    pub assets: crate::AssetStore,
    /// pinned library dependencies (review: versioning-first libraries)
    pub library_deps: Vec<crate::LibraryDependency>,
    /// the pinned-version snapshot of each dependency — documents stay
    /// self-contained and render identically without the .xlib present
    pub library_snapshots: HashMap<String, crate::Library>,
    /// designer-facing component properties per master (component name ->
    /// prop definitions binding master-node ids to editable values)
    pub component_props: HashMap<String, Vec<crate::ComponentPropEntry>>,
    /// canvas comment pins, in page order (review C18)
    pub comments: Vec<Comment>,
}

/// The kind of document being edited.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, Default)]
pub enum DocumentKind {
    /// A standard design file with frames, components, auto-layout, etc.
    /// Supports code export, dev mode, components, variables.
    #[default]
    Design,
    /// A freeform board for brainstorming, sticky notes, and user flows.
    /// Infinite canvas, no strict hierarchy, no Auto Layout, no code export.
    Board,
}

impl Document {
    pub fn new() -> Self {
        Self::default()
    }

    /// Approximate resident bytes of the document model (nodes, styles,
    /// variables, asset store, library snapshots) — the memory-profiling
    /// breakdown the perf review asked for.
    pub fn memory_breakdown(&self) -> DocumentMemory {
        fn node_bytes(n: &Node) -> usize {
            let mut b = std::mem::size_of::<Node>() + n.id.len();
            if let NodeKind::Text { text } = &n.kind {
                b += text.len();
            }
            if let NodeKind::Vector { path } = &n.kind {
                b += path.len() * std::mem::size_of::<PathCmd>();
            }
            if let NodeKind::Image { asset, .. } = &n.kind {
                b += asset.len();
            }
            b += n
                .bindings
                .iter()
                .map(|(k, v)| k.len() + v.len() + 48)
                .sum::<usize>();
            b += n
                .overrides
                .iter()
                .map(|(k, v)| k.len() + v.len() + 48)
                .sum::<usize>();
            b += n.effects.len() * 48;
            b + n.children.iter().map(node_bytes).sum::<usize>()
        }
        let pages: usize = self.pages.iter().map(node_bytes).sum();
        let styles: usize = self.styles.keys().map(|k| k.len() + 128).sum();
        let variables = self.variables.colors.len() * 40
            + self.variables.numbers.len() * 32
            + self
                .variables
                .strings
                .iter()
                .map(|(k, v)| k.len() + v.len())
                .sum::<usize>();
        let assets: usize = self
            .assets
            .iter_sorted()
            .iter()
            .map(|r| r.bytes.len() + r.id.len() + r.name.len() + 128)
            .sum();
        let libraries: usize = self
            .library_snapshots
            .values()
            .map(|l| {
                l.styles.len() * 128
                    + l.components.iter().map(node_bytes).sum::<usize>()
                    + l.assets
                        .iter_sorted()
                        .iter()
                        .map(|r| r.bytes.len())
                        .sum::<usize>()
            })
            .sum();
        DocumentMemory {
            pages,
            styles,
            variables,
            assets,
            libraries,
        }
    }
    pub fn page(&self, id: &str) -> Option<&Node> {
        self.pages.iter().find(|p| p.id == id)
    }
    // -------------------------------------------------- text style registry
    //
    // The registry is `styles`; these are the create / update / detach /
    // propagate operations Figma's "Create and apply text styles" describes.
    // A node stays LINKED through its `style:text` binding (see `bind_style`),
    // so updating a definition and re-running `resolve_styles` over the page
    // trees moves every consumer — "edits to a style update all the layers
    // using it".

    /// Names of every text style, sorted: the picker's list order.
    pub fn text_style_names(&self) -> Vec<&str> {
        let mut v: Vec<&str> = self
            .styles
            .iter()
            .filter(|(_, s)| matches!(s, LegacyStyle::Text(_)))
            .map(|(k, _)| k.as_str())
            .collect();
        v.sort_unstable();
        v
    }

    /// The definition behind a text style name.
    pub fn text_style(&self, name: &str) -> Option<&TextStyleData> {
        match self.styles.get(name)? {
            LegacyStyle::Text(data) => Some(data),
            _ => None,
        }
    }

    /// Create a text style. Names are unique across ALL style kinds (as in
    /// Figma), so an existing paint or effect style blocks the name too.
    pub fn add_text_style(&mut self, name: &str, data: TextStyleData) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("a text style needs a name".into());
        }
        if self.styles.contains_key(name) {
            return Err(format!("style '{name}' already exists"));
        }
        self.styles
            .insert(name.to_string(), LegacyStyle::Text(data));
        Ok(())
    }

    /// Replace a text style's definition. Callers follow with `resolve_styles`
    /// on each page tree so the consumers pick the change up. False when the
    /// name is missing or holds a different kind of style.
    pub fn update_text_style(&mut self, name: &str, data: TextStyleData) -> bool {
        match self.styles.get_mut(name) {
            Some(slot @ LegacyStyle::Text(_)) => {
                *slot = LegacyStyle::Text(data);
                true
            }
            _ => false,
        }
    }

    /// Delete a text style definition. Linked layers keep their values (the
    /// link simply stops resolving); `detach_style` clears it explicitly.
    /// Another kind of style under that name is left alone.
    pub fn remove_text_style(&mut self, name: &str) -> Option<TextStyleData> {
        match self.styles.remove(name)? {
            LegacyStyle::Text(data) => Some(data),
            other => {
                self.styles.insert(name.to_string(), other);
                None
            }
        }
    }

    /// How many nodes under `root` are linked to this text style — the usage
    /// count a style row shows before you delete or rename it.
    pub fn text_style_usage(&self, root: &Node, name: &str) -> usize {
        fn walk(n: &Node, name: &str) -> usize {
            let linked = n.bindings.get("style:text").map(String::as_str) == Some(name);
            usize::from(linked) + n.children.iter().map(|c| walk(c, name)).sum::<usize>()
        }
        walk(root, name)
    }

    pub fn page_mut(&mut self, id: &str) -> Option<&mut Node> {
        self.pages.iter_mut().find(|p| p.id == id)
    }
}

#[cfg(test)]
mod style_tests {
    use super::*;

    #[test]
    fn apply_paint_style_sets_fill() {
        let mut n = Node::rect("r", 0.0, 0.0, 10.0, 10.0, Color::BLACK);
        let s = LegacyStyle::Paint {
            fill: Paint::Solid(Color::from_rgb8(0x0d, 0x99, 0xff)),
        };
        apply_style(&mut n, &s);
        assert_eq!(n.fill, Paint::Solid(Color::from_rgb8(0x0d, 0x99, 0xff)));
        assert!(n.dirty);
    }

    #[test]
    fn apply_text_style_writes_the_bindings_renderers_read() {
        let mut n = Node::text("t", 0.0, 0.0, 100.0, 20.0, "hi");
        let data = TextStyleData {
            font_family: "Lobster".into(),
            font_weight: 700,
            font_size: 32.0,
            letter_spacing: 0.5,
            line_height: LineHeight::Percent(140.0),
            ..Default::default()
        };
        apply_style(&mut n, &LegacyStyle::Text(data));
        let b = |k: &str| n.bindings.get(k).map(String::as_str);
        assert_eq!(b("font"), Some("Lobster"));
        assert_eq!(b("fw"), Some("700"));
        // the px contract: an `fs` binding IS the glyph size, no 0.72 factor
        assert_eq!(b("fs"), Some("32"));
        assert_eq!(b("ls"), Some("0.5"));
        assert_eq!(b("lhm"), Some("pct"));
        assert_eq!(b("lhp"), Some("140"));
        // the legacy "size lives in n.h" carrier is no longer what a style
        // writes; the box stays where it was until the app re-fits it
        assert_eq!(n.h, 20.0);
        assert!(n.dirty);
    }

    #[test]
    fn detach_text_style_keeps_the_typography_and_drops_the_link() {
        let mut n = Node::text("t", 0.0, 0.0, 100.0, 20.0, "hi");
        let data = TextStyleData {
            font_family: "Lobster".into(),
            font_weight: 700,
            font_size: 32.0,
            letter_spacing: 0.5,
            line_height: LineHeight::Percent(140.0),
            ..Default::default()
        };
        bind_style(&mut n, "H1", &LegacyStyle::Text(data.clone()));
        assert_eq!(n.bindings.get("style:text").map(String::as_str), Some("H1"));

        assert!(detach_text_style(&mut n));
        // the link is gone…
        assert_eq!(n.bindings.get("style:text"), None);
        // …and the typography the layer was rendering is untouched
        let b = |k: &str| n.bindings.get(k).map(String::as_str);
        assert_eq!(b("font"), Some("Lobster"));
        assert_eq!(b("fw"), Some("700"));
        assert_eq!(b("fs"), Some("32"));
        assert_eq!(b("ls"), Some("0.5"));
        assert_eq!(b("lhm"), Some("pct"));
        assert_eq!(b("lhp"), Some("140"));

        // an edit to the style definition no longer reaches this layer
        let mut styles: HashMap<String, LegacyStyle> = HashMap::new();
        styles.insert(
            "H1".into(),
            LegacyStyle::Text(TextStyleData {
                font_size: 64.0,
                ..data
            }),
        );
        assert_eq!(resolve_styles(&mut n, &styles), 0);
        assert_eq!(n.bindings.get("fs").map(String::as_str), Some("32"));
        // detaching an unlinked layer is a no-op
        assert!(!detach_text_style(&mut n));
    }

    #[test]
    fn style_mutation_updates_all_consumers() {
        // two rects + a text bound to styles; mutate definitions; resolve
        let mut styles: HashMap<String, LegacyStyle> = HashMap::new();
        styles.insert(
            "Brand".into(),
            LegacyStyle::Paint {
                fill: Paint::Solid(Color::from_rgb8(255, 0, 0)),
            },
        );
        styles.insert(
            "H1".into(),
            LegacyStyle::Text(TextStyleData {
                font_family: "Inter".into(),
                font_weight: 400,
                font_size: 20.0,
                ..Default::default()
            }),
        );
        let mut root = Node::frame("page", 800.0, 600.0)
            .child(Node::rect("a", 0.0, 0.0, 50.0, 50.0, Color::BLACK))
            .child(Node::frame("inner", 100.0, 100.0).child(Node::rect(
                "b",
                0.0,
                0.0,
                50.0,
                50.0,
                Color::BLACK,
            )))
            .child(Node::text("t", 0.0, 0.0, 100.0, 20.0, "hi"));
        // bind: a + b -> Brand, t -> H1
        let brand = styles["Brand"].clone();
        let h1 = styles["H1"].clone();
        fn find_mut<'a>(n: &'a mut Node, id: &str) -> Option<&'a mut Node> {
            if n.id == id {
                return Some(n);
            }
            for c in &mut n.children {
                if let Some(f) = find_mut(c, id) {
                    return Some(f);
                }
            }
            None
        }
        bind_style(find_mut(&mut root, "a").unwrap(), "Brand", &brand);
        bind_style(find_mut(&mut root, "b").unwrap(), "Brand", &brand);
        bind_style(find_mut(&mut root, "t").unwrap(), "H1", &h1);
        assert_eq!(
            find_mut(&mut root, "a").unwrap().fill,
            Paint::Solid(Color::from_rgb8(255, 0, 0))
        );
        // mutate the style definitions
        styles.insert(
            "Brand".into(),
            LegacyStyle::Paint {
                fill: Paint::Solid(Color::from_rgb8(0, 0, 255)),
            },
        );
        styles.insert(
            "H1".into(),
            LegacyStyle::Text(TextStyleData {
                font_family: "Lobster".into(),
                font_weight: 700,
                font_size: 44.0,
                letter_spacing: 1.5,
                ..Default::default()
            }),
        );
        let updated = resolve_styles(&mut root, &styles);
        assert_eq!(updated, 3, "all three consumers re-resolved");
        // deep consumer (b, nested in a sub-frame) updated too
        assert_eq!(
            find_mut(&mut root, "a").unwrap().fill,
            Paint::Solid(Color::from_rgb8(0, 0, 255))
        );
        assert_eq!(
            find_mut(&mut root, "b").unwrap().fill,
            Paint::Solid(Color::from_rgb8(0, 0, 255))
        );
        let t = find_mut(&mut root, "t").unwrap();
        assert_eq!(t.bindings.get("font").map(String::as_str), Some("Lobster"));
        assert_eq!(t.bindings.get("fw").map(String::as_str), Some("700"));
        assert_eq!(t.bindings.get("fs").map(String::as_str), Some("44"));
        // letter spacing propagated too — the property the old four-field
        // variant carried but the applier dropped on the floor
        assert_eq!(t.bindings.get("ls").map(String::as_str), Some("1.5"));
        // unbinding stops updates
        find_mut(&mut root, "a")
            .unwrap()
            .bindings
            .remove("style:paint");
        styles.insert(
            "Brand".into(),
            LegacyStyle::Paint {
                fill: Paint::Solid(Color::from_rgb8(0, 255, 0)),
            },
        );
        resolve_styles(&mut root, &styles);
        assert_eq!(
            find_mut(&mut root, "a").unwrap().fill,
            Paint::Solid(Color::from_rgb8(0, 0, 255)),
            "detached node untouched"
        );
        assert_eq!(
            find_mut(&mut root, "b").unwrap().fill,
            Paint::Solid(Color::from_rgb8(0, 255, 0))
        );
    }

    #[test]
    fn style_management_rename_detach_usage() {
        let mut styles: HashMap<String, LegacyStyle> = HashMap::new();
        styles.insert(
            "Primary".into(),
            LegacyStyle::Paint {
                fill: Paint::Solid(Color::from_rgb8(0x63, 0x66, 0xFF)),
            },
        );
        let primary = styles["Primary"].clone();
        let mut pages = vec![
            Node::frame("p1", 100.0, 100.0)
                .child(Node::rect("a", 0.0, 0.0, 10.0, 10.0, Color::BLACK))
                .child(Node::frame("inner", 50.0, 50.0).child(Node::rect(
                    "b",
                    0.0,
                    0.0,
                    10.0,
                    10.0,
                    Color::BLACK,
                ))),
            Node::frame("p2", 100.0, 100.0).child(Node::rect(
                "c",
                0.0,
                0.0,
                10.0,
                10.0,
                Color::BLACK,
            )),
        ];
        fn find_mut<'a>(n: &'a mut Node, id: &str) -> Option<&'a mut Node> {
            if n.id == id {
                return Some(n);
            }
            for c in &mut n.children {
                if let Some(f) = find_mut(c, id) {
                    return Some(f);
                }
            }
            None
        }
        bind_style(find_mut(&mut pages[0], "a").unwrap(), "Primary", &primary);
        bind_style(find_mut(&mut pages[0], "b").unwrap(), "Primary", &primary);
        bind_style(find_mut(&mut pages[1], "c").unwrap(), "Primary", &primary);
        // usage count across pages
        let usage: usize = pages.iter().map(|p| style_usage(p, "Primary")).sum();
        assert_eq!(usage, 3);
        // rename rebinds every consumer
        let rebound = rename_style(&mut styles, &mut pages, "Primary", "Brand/Primary").unwrap();
        assert_eq!(rebound, 3);
        assert!(styles.contains_key("Brand/Primary") && !styles.contains_key("Primary"));
        assert_eq!(
            find_mut(&mut pages[0], "b")
                .unwrap()
                .bindings
                .get("style:paint")
                .map(String::as_str),
            Some("Brand/Primary")
        );
        // rename collisions and missing sources are refused
        styles.insert(
            "Other".into(),
            LegacyStyle::Paint {
                fill: Paint::Solid(Color::BLACK),
            },
        );
        assert!(rename_style(&mut styles, &mut pages, "Brand/Primary", "Other").is_none());
        assert!(rename_style(&mut styles, &mut pages, "Ghost", "X").is_none());
        // detach: values stay, link gone, resolve no longer touches it
        let a = find_mut(&mut pages[0], "a").unwrap();
        let before = a.fill.clone();
        assert!(detach_style(a, "style:paint"));
        assert!(!detach_style(a, "style:paint"), "second detach is a no-op");
        styles.insert(
            "Brand/Primary".into(),
            LegacyStyle::Paint {
                fill: Paint::Solid(Color::from_rgb8(0x7C, 0x3A, 0xED)),
            },
        );
        resolve_styles(&mut pages[0], &styles);
        assert_eq!(
            find_mut(&mut pages[0], "a").unwrap().fill,
            before,
            "detached node untouched"
        );
        assert_eq!(
            find_mut(&mut pages[0], "b").unwrap().fill,
            Paint::Solid(Color::from_rgb8(0x7C, 0x3A, 0xED)),
            "bound node updated"
        );
        assert_eq!(
            style_usage(&pages[0], "Brand/Primary"),
            1,
            "usage reflects detach"
        );
    }

    #[test]
    fn apply_effect_style_replaces_effects() {
        let mut n = Node::rect("r", 0.0, 0.0, 10.0, 10.0, Color::BLACK);
        n.effects.push(Effect::LayerBlur { radius: 3.0 });
        let s = LegacyStyle::Effect {
            effects: vec![Effect::DropShadow {
                dx: 2.0,
                dy: 3.0,
                blur: 8.0,
                color: Color::BLACK,
            }],
        };
        apply_style(&mut n, &s);
        assert_eq!(n.effects.len(), 1);
        assert!(matches!(n.effects[0], Effect::DropShadow { .. }));
    }
}

/// Byte breakdown of a document's resident memory.
#[derive(Debug, Clone, Copy, Default)]
pub struct DocumentMemory {
    pub pages: usize,
    pub styles: usize,
    pub variables: usize,
    pub assets: usize,
    pub libraries: usize,
}
impl DocumentMemory {
    pub fn total(&self) -> usize {
        self.pages + self.styles + self.variables + self.assets + self.libraries
    }
}
