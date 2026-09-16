//! Import IR — the common intermediate representation every importer
//! targets (review: "don't let Sketch → Node, SVG → Node, Figma → Node
//! each develop completely different semantics").
//!
//! Pipeline:
//!
//!   External file → importer → **ImportDoc (this IR)** → lower() →
//!   X-Native Document → render IR → editor
//!
//! Importers only PARSE; every shared semantic decision lives in ONE
//! place — `lower()`:
//!   * id generation, sanitization, and cross-page uniqueness
//!   * kind-appropriate fill defaults (text = black, shapes = transparent)
//!   * opacity clamping, NaN/∞ scrubbing of all geometry
//!   * page auto-sizing to the content envelope (+margin, sane minimum)
//!   * instance text-override encoding (the render-effective `"text:"`)
//!   * rotation stored in the ONE native convention (radians, positive =
//!     clockwise in y-down screen space; importers convert at parse time
//!     and document their source convention)
//!
//! A conformance suite (`import_conformance.rs`) runs the SAME assertions
//! over every importer, so a new source format can't drift.

use std::collections::{HashMap, HashSet};
use x_core::*;

// ---------------------------------------------------------------------- IR

#[derive(Debug, Clone)]
pub enum ImportKind {
    Frame,
    Group,
    Rect {
        radius: f64,
    },
    Ellipse,
    Line,
    Text {
        content: String,
        size: Option<f64>,
        font: Option<String>,
        line_height: Option<f64>,
        letter_spacing: Option<f64>,
        runs: Vec<x_core::TextRun>,
    },
    Path {
        cmds: Vec<PathCmd>,
    },
    Image {
        asset: String,
    },
    Component {
        name: String,
    },
    Instance {
        component: String,
        overrides: Vec<(String, String)>,
    },
}

#[derive(Debug, Clone)]
pub struct ImportNode {
    /// source-file id, if the format has one; lower() falls back to a
    /// generated id and dedupes collisions either way
    pub id: Option<String>,
    /// human layer name from the source file ("" = fall back to id)
    pub name: String,
    pub kind: ImportKind,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// radians, positive = clockwise in y-down screen space (the native
    /// convention). Importers convert their source's convention here.
    pub rotation: f64,
    /// Optional source-space affine. Formats such as SVG can carry matrix,
    /// scale, skew, and rotation-about-a-point transforms that cannot be
    /// represented by the legacy rotation-only field. Lowering composes this
    /// with the node's placement and decomposes it into the native transform.
    pub source_transform: Option<Affine>,
    /// None = "source specified nothing" -> lower() picks the kind default
    pub fill: Option<Paint>,
    /// Primary (first) stroke — (paint, width); Paint so gradient strokes
    /// ride the same vocabulary as fills.
    pub stroke: Option<(Paint, f64)>,
    /// Stroke geometry options for the primary stroke. Keeping these in the
    /// shared IR prevents SVG/Figma importers from silently reverting caps,
    /// joins, and dashes to the renderer defaults.
    pub stroke_options: Option<StrokeOptions>,
    /// Any strokes beyond the first (Figma/Sketch both support stacking
    /// multiple stroke paints on one layer). Same width convention as
    /// `stroke`; importers that don't support multi-stroke just leave
    /// this empty and nothing changes for them.
    pub extra_strokes: Vec<(Paint, f64)>,
    /// Layer effects (shadows/blurs). Empty = none, never guessed.
    pub effects: Vec<Effect>,
    /// Auto-layout (Figma "layoutMode" / Sketch resizing stacks). None =
    /// source has no auto-layout on this node — only meaningful on
    /// `ImportKind::Frame`; lower() ignores it for any other kind.
    pub layout: Option<AutoLayout>,
    /// Resize constraints (Figma `constraints` / Sketch resizing rules).
    /// None = source specified nothing -> lower() keeps the Left/Top
    /// default; importers only set it when the source is explicit.
    pub pin: Option<(x_core::HPin, x_core::VPin)>,
    pub opacity: f32,
    pub visible: bool,
    pub children: Vec<ImportNode>,
}

impl ImportNode {
    pub fn new(kind: ImportKind) -> Self {
        Self {
            id: None,
            name: String::new(),
            kind,
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0,
            rotation: 0.0,
            source_transform: None,
            fill: None,
            stroke: None,
            stroke_options: None,
            extra_strokes: vec![],
            effects: vec![],
            layout: None,
            pin: None,
            opacity: 1.0,
            visible: true,
            children: vec![],
        }
    }
    pub fn named(mut self, name: impl Into<String>) -> Self {
        self.name = name.into();
        self
    }
    pub fn id(mut self, id: impl Into<String>) -> Self {
        self.id = Some(id.into());
        self
    }
    pub fn at(mut self, x: f64, y: f64) -> Self {
        self.x = x;
        self.y = y;
        self
    }
    pub fn size(mut self, w: f64, h: f64) -> Self {
        self.w = w;
        self.h = h;
        self
    }
    pub fn fill(mut self, p: Paint) -> Self {
        self.fill = Some(p);
        self
    }
    pub fn pin(mut self, h: x_core::HPin, v: x_core::VPin) -> Self {
        self.pin = Some((h, v));
        self
    }
    pub fn child(mut self, c: ImportNode) -> Self {
        self.children.push(c);
        self
    }
}

/// What an importer hands to `lower()`: pages plus any binary assets the
/// source embedded (registered by name so Image nodes resolve).
#[derive(Debug, Clone, Default)]
pub struct ImportDoc {
    pub pages: Vec<ImportNode>,
    /// asset name -> raw PNG bytes (decoded/registered by the app shell)
    pub assets: Vec<(String, Vec<u8>)>,
    /// which importer produced this (diagnostics / conformance)
    pub source: &'static str,
    /// importer-side diagnostics: source constructs that were skipped or
    /// approximated (importers push; lower() adds its own; the app shows
    /// them after import so fidelity is MEASURABLE per file)
    pub diagnostics: Vec<String>,
}

/// Import result with per-file fidelity diagnostics.
#[derive(Debug, Clone, Default)]
pub struct ImportReport {
    pub nodes_imported: usize,
    pub assets_imported: usize,
    pub diagnostics: Vec<String>,
}

// ------------------------------------------------------------------ lower

fn clean(v: f64) -> f64 {
    if v.is_finite() {
        v
    } else {
        0.0
    }
}

fn sanitize_id(raw: &str) -> String {
    let s: String = raw
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == ':' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if s.is_empty() {
        "node".into()
    } else {
        s
    }
}

/// THE single importer → Document lowering. All shared import semantics
/// live here; importers never construct `Node` themselves.
pub fn lower(doc: ImportDoc) -> Document {
    lower_with_report(doc).0
}

/// Same lowering, plus the fidelity report (import diagnostics item).
pub fn lower_with_report(doc: ImportDoc) -> (Document, ImportReport) {
    let mut out = Document::new();
    let mut used: HashSet<String> = HashSet::new();
    let mut counter = 0usize;
    // component names seen, for instance-ref diagnostics (kept permissive:
    // unknown refs stay as-is so partially-imported files still open)
    let mut component_names: HashMap<String, ()> = HashMap::new();
    for p in &doc.pages {
        collect_components(p, &mut component_names);
    }

    // register embedded assets into the content-addressed store and build
    // the source-name -> asset:// id map that Image nodes rewrite through
    let mut asset_ids: HashMap<String, String> = HashMap::new();
    for (name, bytes) in doc.assets {
        let id = out.assets.register(&name, bytes, AssetSource::Embedded);
        asset_ids.insert(name, id);
    }

    let mut report = ImportReport {
        diagnostics: doc.diagnostics.clone(),
        ..Default::default()
    };
    report.assets_imported = asset_ids.len();
    for (pi, page_ir) in doc.pages.into_iter().enumerate() {
        let mut page = lower_node(page_ir, &mut used, &mut counter, true, &asset_ids);
        // shared page semantics: a page is always a Frame, auto-sized to
        // its content envelope when the source gave no/zero size
        if page.w <= 0.0 || page.h <= 0.0 {
            let (mut mw, mut mh) = (0.0f64, 0.0f64);
            for c in &page.children {
                mw = mw.max(c.transform.x + c.w);
                mh = mh.max(c.transform.y + c.h);
            }
            page.w = (mw + 40.0).max(800.0);
            page.h = (mh + 40.0).max(600.0);
        }
        if page.id.is_empty() {
            page.id = format!("page-{}", pi + 1);
        }
        fn count(n: &Node) -> usize {
            1 + n.children.iter().map(count).sum::<usize>()
        }
        report.nodes_imported += count(&page);
        out.pages.push(page);
    }
    (out, report)
}

fn collect_components(n: &ImportNode, out: &mut HashMap<String, ()>) {
    if let ImportKind::Component { name } = &n.kind {
        out.insert(name.clone(), ());
    }
    for c in &n.children {
        collect_components(c, out);
    }
}

fn lower_node(
    ir: ImportNode,
    used: &mut HashSet<String>,
    counter: &mut usize,
    is_page: bool,
    asset_ids: &HashMap<String, String>,
) -> Node {
    // ---- id: sanitize source id or generate; dedupe globally
    let base = match &ir.id {
        Some(raw) => sanitize_id(raw),
        None => {
            *counter += 1;
            format!("import-{counter}")
        }
    };
    let mut id = base.clone();
    let mut n = 2;
    while !used.insert(id.clone()) {
        id = format!("{base}-{n}");
        n += 1;
    }

    let (x, y, w, h) = (
        clean(ir.x),
        clean(ir.y),
        clean(ir.w).max(0.0),
        clean(ir.h).max(0.0),
    );

    // ---- kind + kind-default fills (THE shared defaults table)
    let mut node = match ir.kind {
        ImportKind::Frame => {
            let mut f = Node::frame(&id, w, h);
            f.transform.x = x;
            f.transform.y = y;
            f.fill = ir.fill.clone().unwrap_or(Paint::Solid(if is_page {
                Color::TRANSPARENT
            } else {
                Color::WHITE
            }));
            if let Some(layout) = ir.layout.clone() {
                f = f.auto_layout(layout);
            }
            f
        }
        ImportKind::Group => {
            let mut g = Node::group(&id, w, h);
            g.transform.x = x;
            g.transform.y = y;
            if let Some(p) = ir.fill.clone() {
                g.fill = p;
            }
            g
        }
        ImportKind::Rect { radius } => Node::rect(&id, x, y, w, h, Color::TRANSPARENT)
            .radius(clean(radius).max(0.0))
            .fill_paint(ir.fill.clone().unwrap_or(Paint::Solid(Color::TRANSPARENT))),
        ImportKind::Ellipse => Node::ellipse(&id, x, y, w, h, Color::TRANSPARENT)
            .fill_paint(ir.fill.clone().unwrap_or(Paint::Solid(Color::TRANSPARENT))),
        ImportKind::Line => {
            let (paint, sw) = ir
                .stroke
                .clone()
                .unwrap_or((Paint::Solid(Color::BLACK), 2.0));
            let mut l = Node::line(&id, x, y, w.max(1.0), h, Color::BLACK);
            l.stroke.paint = paint;
            l.stroke.width = sw.max(0.5);
            l
        }
        ImportKind::Text {
            content,
            size,
            font,
            line_height,
            letter_spacing,
            runs,
        } => {
            let mut n = Node::text(&id, x, y, w, h, &content)
                // shared semantic: unstyled text is BLACK, never transparent
                .fill_paint(ir.fill.clone().unwrap_or(Paint::Solid(Color::BLACK)));
            // typography rides the node: h IS the font size in this app's
            // model (the inspector's Size row edits node.h), and font /
            // letter-spacing (px) / line-height (multiplier) ride the
            // bindings every render sink already honors
            if let Some(fs) = size {
                n.h = fs;
            }
            if let Some(f) = font {
                n.bindings.insert("font".into(), f);
            }
            if let Some(lh) = line_height {
                n.bindings.insert("lh".into(), format!("{lh}"));
            }
            if let Some(ls) = letter_spacing {
                n.bindings.insert("ls".into(), format!("{ls}"));
            }
            n.text_runs = runs;
            n
        }
        ImportKind::Path { cmds } => {
            let cmds: Vec<PathCmd> = cmds
                .into_iter()
                .map(|c| match c {
                    PathCmd::MoveTo(a, b) => PathCmd::MoveTo(clean(a), clean(b)),
                    PathCmd::LineTo(a, b) => PathCmd::LineTo(clean(a), clean(b)),
                    PathCmd::CurveTo(a, b, c2, d, e, f) => PathCmd::CurveTo(
                        clean(a),
                        clean(b),
                        clean(c2),
                        clean(d),
                        clean(e),
                        clean(f),
                    ),
                    PathCmd::Close => PathCmd::Close,
                })
                .collect();
            Node::vector(&id, x, y, w, h, cmds)
                .fill_paint(ir.fill.clone().unwrap_or(Paint::Solid(Color::TRANSPARENT)))
        }
        ImportKind::Image { asset } => {
            // shared semantic: embedded assets resolve to their stable
            // asset:// id; unknown names stay as legacy filename refs
            let asset_ref = asset_ids.get(&asset).cloned().unwrap_or(asset);
            let mut i = Node::image(&id, x, y, w, h, &asset_ref);
            i.transform.x = x;
            i.transform.y = y;
            i
        }
        ImportKind::Component { name } => {
            let mut c = Node::component(&id, &name, w, h);
            c.transform.x = x;
            c.transform.y = y;
            c
        }
        ImportKind::Instance {
            component,
            overrides,
        } => {
            let mut inst = Node::instance(&id, &component, x, y, w, h);
            for (target, encoding) in overrides {
                // shared semantic: render-effective override encodings
                // ("text:...", "#rrggbb[aa]", "opacity:N", "visible:bool", "swap:name")
                inst.overrides.insert(sanitize_id(&target), encoding);
            }
            inst
        }
    };

    // ---- shared scalar semantics
    // pattern paints carry the IMPORTER's image stem; resolve to the
    // stable asset:// id exactly like bitmap Image nodes
    fn rewrite_pattern(p: &mut Paint, asset_ids: &HashMap<String, String>) {
        if let Paint::Pattern { asset, .. } = p {
            if let Some(id) = asset_ids.get(asset) {
                *asset = id.clone();
            }
        }
    }
    rewrite_pattern(&mut node.fill, asset_ids);
    for l in node.fill_layers.iter_mut() {
        rewrite_pattern(&mut l.paint, asset_ids);
    }
    for l in node.stroke_layers.iter_mut() {
        rewrite_pattern(&mut l.stroke.paint, asset_ids);
    }
    rewrite_pattern(&mut node.stroke.paint, asset_ids);
    if let Some((paint, sw)) = ir.stroke.clone() {
        if !matches!(node.kind, NodeKind::Line) && sw > 0.0 {
            node.stroke = Stroke {
                paint,
                width: clean(sw),
            };
        }
    }
    if let Some(options) = ir.stroke_options {
        node.materialize_visual_stacks();
        if let Some(layer) = node.stroke_layers.first_mut() {
            layer.options = options;
        }
    }
    if !ir.extra_strokes.is_empty() && !matches!(node.kind, NodeKind::Line) {
        node.materialize_visual_stacks();
        for (paint, sw) in &ir.extra_strokes {
            if *sw > 0.0 {
                node.stroke_layers.push(StrokeLayer::new(Stroke {
                    paint: paint.clone(),
                    width: clean(*sw),
                }));
            }
        }
    }
    if !ir.effects.is_empty() {
        node.effects = ir.effects;
    }
    if let Some((h, v)) = ir.pin {
        node.pin = (h, v);
    }
    if !ir.name.is_empty() {
        node.name = ir.name.clone();
    }
    if let Some(source_transform) = ir.source_transform {
        // Shape constructors store x/y as the node placement. Compose that
        // placement into the source matrix before decomposition so SVG
        // matrix/scale/skew transforms do not lose translation or pivot.
        node.transform = Transform::from_affine(
            source_transform * Affine::translate((clean(ir.x), clean(ir.y))),
        );
    } else {
        node.transform.rotation = clean(ir.rotation);
    }
    node.opacity = if ir.opacity.is_finite() {
        ir.opacity.clamp(0.0, 1.0)
    } else {
        1.0
    };
    node.visible = ir.visible;

    for c in ir.children {
        let cn = lower_node(c, used, counter, false, asset_ids);
        node.children.push(cn);
    }
    node
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lower_dedupes_colliding_and_sanitizes_ids() {
        let doc = ImportDoc {
            pages: vec![ImportNode::new(ImportKind::Frame)
                .id("p")
                .child(
                    ImportNode::new(ImportKind::Rect { radius: 0.0 })
                        .id("a b/c")
                        .size(10.0, 10.0),
                )
                .child(
                    ImportNode::new(ImportKind::Rect { radius: 0.0 })
                        .id("a b/c")
                        .size(10.0, 10.0),
                )
                .child(ImportNode::new(ImportKind::Ellipse).size(5.0, 5.0))],
            ..Default::default()
        };
        let d = lower(doc);
        let p = &d.pages[0];
        assert_eq!(p.children[0].id, "a-b-c");
        assert_eq!(p.children[1].id, "a-b-c-2", "collision deduped");
        assert!(
            p.children[2].id.starts_with("import-"),
            "missing id generated"
        );
    }

    #[test]
    fn lower_scrubs_nan_and_clamps_opacity() {
        let mut r = ImportNode::new(ImportKind::Rect { radius: f64::NAN })
            .id("r")
            .size(f64::INFINITY, 10.0);
        r.opacity = 7.5;
        r.rotation = f64::NAN;
        let doc = ImportDoc {
            pages: vec![ImportNode::new(ImportKind::Frame).id("p").child(r)],
            ..Default::default()
        };
        let d = lower(doc);
        let n = &d.pages[0].children[0];
        assert_eq!(n.w, 0.0);
        assert_eq!(n.opacity, 1.0);
        assert_eq!(n.transform.rotation, 0.0);
    }

    #[test]
    fn lower_pages_autosize_and_text_defaults_black() {
        let doc = ImportDoc {
            pages: vec![ImportNode::new(ImportKind::Frame).id("p").child(
                ImportNode::new(ImportKind::Text {
                    content: "hi".into(),
                    size: None,
                    font: None,
                    line_height: None,
                    letter_spacing: None,
                    runs: vec![],
                })
                .id("t")
                .at(900.0, 700.0)
                .size(100.0, 20.0),
            )],
            ..Default::default()
        };
        let d = lower(doc);
        assert!(d.pages[0].w >= 1040.0, "page envelops content");
        assert_eq!(d.pages[0].children[0].fill, Paint::Solid(Color::BLACK));
    }

    #[test]
    fn lower_encodes_instance_text_overrides_render_effective() {
        let doc = ImportDoc {
            pages: vec![ImportNode::new(ImportKind::Frame).id("p").child(
                ImportNode::new(ImportKind::Instance {
                    component: "Button".into(),
                    overrides: vec![("label".into(), "text:Buy now".into())],
                })
                .id("i1")
                .size(80.0, 30.0),
            )],
            ..Default::default()
        };
        let d = lower(doc);
        assert_eq!(
            d.pages[0].children[0].overrides.get("label"),
            Some(&"text:Buy now".to_string())
        );
    }
}
