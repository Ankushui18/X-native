//! WebAssembly boundary for Rust imports and an opt-in document command session.
//!
//! Imports use `x-format` and the existing TypeScript whole-result oracle;
//! no production web document/undo/layout authority is claimed by imports.
//! The separate `session` module holds an x-editor session over native `.x`:
//! one initial document, small command/state deltas, explicit export. It does
//! NOT mirror a TS document or run beside the live web editor's history.
//! See `docs/ARCHITECTURE_BOUNDARY.md`.
//!
//! The import entry points below are pure: bytes in, string out, no filesystem.
//! That is why they use the `*_bytes` importers rather than path-based wrappers,
//! which call `std::fs` and cannot run under wasm.

pub mod session;

use serde::{Deserialize, Serialize};
use x_core::booleans::{boolean, node_to_path, BoolOp, PositionedPath};
use x_core::peniko::Brush;
use x_core::{
    AutoLayout, Color, LayoutDirection, Node, NodeKind, Paint, PathCmd, Sizing, Stroke, StrokeJoin,
    Variables,
};
use x_editor::Editor;
use x_format::{figbinary, serialize::save_x, sketch, svg_import};
use x_render::{build_render_tree, RenderTree};

fn default_create_width() -> f64 {
    100.0
}

fn default_create_height() -> f64 {
    80.0
}

fn default_opacity() -> f64 {
    1.0
}

/// One command in the incremental WASM editor bridge. The tagged Serde shape
/// is a JS object (e.g. `{ type: "CreateNode", kind: "rect", x, y, w, h }`,
/// `{ type: "MoveNode", id, dx, dy }`, `{ type: "ResizeNode", id, x, y, width, height }`,
/// `{ type: "DeleteNode", id }`, `{ type: "Undo" }`, `{ type: "Redo" }`), not a JSON string.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum Command {
    #[serde(rename = "createNode", alias = "CreateNode")]
    CreateNode {
        #[serde(rename = "nodeType", alias = "node_type", alias = "kind")]
        node_type: String,
        x: f64,
        y: f64,
        #[serde(default = "default_create_width", alias = "w")]
        width: f64,
        #[serde(default = "default_create_height", alias = "h")]
        height: f64,
        #[serde(default, rename = "parentId", alias = "parent_id", alias = "parent")]
        parent_id: Option<String>,
        #[serde(default)]
        text: Option<String>,
    },
    #[serde(rename = "moveNode", alias = "MoveNode")]
    MoveNode {
        id: String,
        dx: f64,
        dy: f64,
        #[serde(default, rename = "parentId", alias = "parent_id", alias = "parent")]
        parent_id: Option<String>,
    },
    #[serde(rename = "resizeNode", alias = "ResizeNode")]
    ResizeNode {
        id: String,
        #[serde(default)]
        x: Option<f64>,
        #[serde(default)]
        y: Option<f64>,
        #[serde(alias = "w")]
        width: f64,
        #[serde(alias = "h")]
        height: f64,
    },
    #[serde(rename = "deleteNode", alias = "DeleteNode")]
    DeleteNode { id: String },
    #[serde(rename = "booleanOperation", alias = "BooleanOperation")]
    BooleanOperation {
        #[serde(rename = "targetIds", alias = "target_ids", alias = "ids")]
        target_ids: Vec<String>,
        operation: String,
    },
    #[serde(rename = "applyAutoLayout", alias = "ApplyAutoLayout")]
    ApplyAutoLayout {
        #[serde(rename = "frameId", alias = "frame_id", alias = "id")]
        frame_id: String,
        axis: String,
        padding: f64,
        gap: f64,
    },
    #[serde(rename = "updateNode", alias = "UpdateNode")]
    UpdateNode {
        #[serde(alias = "nodeId", alias = "node_id")]
        id: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        fill: Option<String>,
        #[serde(default)]
        stroke: Option<String>,
        #[serde(default, rename = "strokeWidth", alias = "stroke_width")]
        stroke_width: Option<f64>,
        #[serde(default)]
        opacity: Option<f64>,
        #[serde(default)]
        rotation: Option<f64>,
        #[serde(default)]
        radius: Option<f64>,
        #[serde(default)]
        text: Option<String>,
        #[serde(default, alias = "fillVariable")]
        fill_variable: Option<String>,
    },
    #[serde(rename = "outlineStroke", alias = "OutlineStroke")]
    OutlineStroke {
        #[serde(alias = "nodeId", alias = "node_id")]
        id: String,
    },
    #[serde(rename = "offsetPath", alias = "OffsetPath")]
    OffsetPath {
        #[serde(alias = "nodeId", alias = "node_id")]
        id: String,
        distance: f64,
        #[serde(default)]
        join: Option<String>,
    },
    #[serde(rename = "duplicateNode", alias = "DuplicateNode")]
    DuplicateNode {
        #[serde(alias = "nodeId", alias = "node_id")]
        id: String,
        #[serde(default)]
        dx: Option<f64>,
        #[serde(default)]
        dy: Option<f64>,
    },
    #[serde(rename = "updateVariable", alias = "UpdateVariable")]
    UpdateVariable { id: String, value: String },
    #[serde(rename = "setVariableMode", alias = "SetVariableMode")]
    SetVariableMode {
        #[serde(alias = "collectionId")]
        collection_id: String,
        #[serde(alias = "modeId")]
        mode_id: String,
    },
    #[serde(rename = "updateComponentProperty", alias = "UpdateComponentProperty")]
    UpdateComponentProperty {
        #[serde(alias = "instanceId")]
        instance_id: String,
        #[serde(alias = "propertyName")]
        property_name: String,
        value: String,
    },
    #[serde(rename = "undo", alias = "Undo")]
    Undo,
    #[serde(rename = "redo", alias = "Redo")]
    Redo,
}

/// Cubic-bezier-preserving path command serialized across the WASM boundary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op")]
pub enum WasmPathCmd {
    #[serde(rename = "M", alias = "MoveTo")]
    MoveTo { x: f64, y: f64 },
    #[serde(rename = "L", alias = "LineTo")]
    LineTo { x: f64, y: f64 },
    #[serde(rename = "C", alias = "CurveTo")]
    CurveTo {
        c1x: f64,
        c1y: f64,
        c2x: f64,
        c2y: f64,
        x: f64,
        y: f64,
    },
    #[serde(rename = "Z", alias = "Close")]
    Close,
}

fn wasm_path_cmd_from_core(cmd: &PathCmd) -> WasmPathCmd {
    match *cmd {
        PathCmd::MoveTo(x, y) => WasmPathCmd::MoveTo { x, y },
        PathCmd::LineTo(x, y) => WasmPathCmd::LineTo { x, y },
        PathCmd::CurveTo(c1x, c1y, c2x, c2y, x, y) => WasmPathCmd::CurveTo {
            c1x,
            c1y,
            c2x,
            c2y,
            x,
            y,
        },
        PathCmd::Close => WasmPathCmd::Close,
    }
}

fn core_path_cmd_from_wasm(cmd: &WasmPathCmd) -> PathCmd {
    match *cmd {
        WasmPathCmd::MoveTo { x, y } => PathCmd::MoveTo(x, y),
        WasmPathCmd::LineTo { x, y } => PathCmd::LineTo(x, y),
        WasmPathCmd::CurveTo {
            c1x,
            c1y,
            c2x,
            c2y,
            x,
            y,
        } => PathCmd::CurveTo(c1x, c1y, c2x, c2y, x, y),
        WasmPathCmd::Close => PathCmd::Close,
    }
}

/// Auto-layout configuration snapshot on a Frame node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmAutoLayout {
    pub axis: String,
    pub padding: f64,
    pub gap: f64,
}

/// Small renderable document projection returned by the WASM POC and consumed
/// by `render_frame`. Optional High-DPI and viewport fields are omitted when
/// `None` so existing Phase 1/2 snapshot consumers see the exact same shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentState {
    pub revision: u32,
    pub can_undo: bool,
    pub nodes: Vec<NodeSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_pixel_ratio: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport_height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pan_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pan_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zoom: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variables: Option<std::collections::HashMap<String, String>>,
    #[serde(
        default,
        alias = "active_modes",
        skip_serializing_if = "Option::is_none"
    )]
    pub active_modes: Option<std::collections::HashMap<String, String>>,
    #[serde(
        default,
        alias = "component_overrides",
        skip_serializing_if = "Option::is_none"
    )]
    pub component_overrides:
        Option<std::collections::HashMap<String, std::collections::HashMap<String, String>>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSnapshot {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default, alias = "parent_id")]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub rotation: f64,
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    #[serde(default)]
    pub fill: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius: Option<f64>,
    #[serde(
        default,
        alias = "path_commands",
        skip_serializing_if = "Option::is_none"
    )]
    pub path_commands: Option<Vec<WasmPathCmd>>,
    #[serde(default, alias = "boolean_op", skip_serializing_if = "Option::is_none")]
    pub boolean_op: Option<String>,
    #[serde(
        default,
        alias = "auto_layout",
        skip_serializing_if = "Option::is_none"
    )]
    pub auto_layout: Option<WasmAutoLayout>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    #[serde(
        default,
        alias = "component_properties",
        skip_serializing_if = "Option::is_none"
    )]
    pub component_properties: Option<std::collections::HashMap<String, String>>,
}

/// Diagnostics returned by `render_frame` so callers and tests can verify
/// High-DPI scaling, draw-call counts, and revision-based frame skipping.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderFrameStats {
    pub revision: u32,
    pub node_count: usize,
    pub command_count: usize,
    pub draw_calls: usize,
    pub device_pixel_ratio: f64,
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub skipped_unchanged: bool,
}

/// Convert an `x-render` `Brush` into a CSS color string suitable for Canvas2D.
pub fn brush_css_color(brush: &Brush) -> String {
    match brush {
        Brush::Solid(color) => {
            let rgba = color.to_rgba8();
            if rgba.a == 255 {
                format!("#{:02x}{:02x}{:02x}", rgba.r, rgba.g, rgba.b)
            } else {
                let alpha = f64::from(rgba.a) / 255.0;
                format!("rgba({},{},{},{alpha:.4})", rgba.r, rgba.g, rgba.b)
            }
        }
        Brush::Gradient(gradient) => gradient
            .stops
            .first()
            .map(|stop| {
                let color: Color = stop.color.to_alpha_color();
                let rgba = color.to_rgba8();
                format!("#{:02x}{:02x}{:02x}", rgba.r, rgba.g, rgba.b)
            })
            .unwrap_or_else(|| "#000000".into()),
        Brush::Image(_) => "#000000".into(),
    }
}

fn insert_into_parent(root: &mut Node, parent_id: &str, child: &mut Option<Node>) -> bool {
    if root.id == parent_id {
        if let Some(node) = child.take() {
            root.children.push(node);
        }
        return true;
    }
    for node in &mut root.children {
        if insert_into_parent(node, parent_id, child) {
            return true;
        }
    }
    false
}

/// Build an `x_render::RenderTree` from a `DocumentState` snapshot by
/// constructing `x_core::Node` items and lowering them through `x-render`.
pub fn build_render_tree_from_state(state: &DocumentState) -> Result<RenderTree, String> {
    let mut page = Node::frame("wasm-render-page", 4096.0, 4096.0);
    page.show_name = false;
    for snap in &state.nodes {
        if !snap.x.is_finite() || !snap.y.is_finite() {
            return Err(format!("non-finite coordinates on node {}", snap.id));
        }
        if !snap.w.is_finite() || !snap.h.is_finite() || snap.w <= 0.0 || snap.h <= 0.0 {
            return Err(format!("invalid dimensions on node {}", snap.id));
        }
        let parsed_fill = snap.fill.as_deref().and_then(x_core::parse_hex_color);
        let mut node = match snap.kind.as_str() {
            "frame" | "Frame" => {
                let mut f = Node::frame(&snap.id, snap.w, snap.h);
                f.transform.x = snap.x;
                f.transform.y = snap.y;
                f.name = snap.name.clone();
                f.fill = Paint::Solid(parsed_fill.unwrap_or(Color::WHITE));
                if let Some(al) = &snap.auto_layout {
                    let direction = match al.axis.as_str() {
                        "vertical" | "Vertical" | "column" => LayoutDirection::Vertical,
                        _ => LayoutDirection::Horizontal,
                    };
                    f.kind = NodeKind::Frame {
                        layout: Some(AutoLayout {
                            direction,
                            gap: al.gap,
                            padding: [al.padding, al.padding, al.padding, al.padding],
                            sizing: Sizing::Hug,
                            cross_sizing: Some(Sizing::Hug),
                            ..Default::default()
                        }),
                    };
                }
                f
            }
            "text" | "Text" => {
                let label = snap.text.as_deref().unwrap_or(&snap.name);
                let mut t = Node::text(&snap.id, snap.x, snap.y, snap.w, snap.h, label);
                t.name = snap.name.clone();
                if let Some(fill) = parsed_fill {
                    t.fill = Paint::Solid(fill);
                }
                t
            }
            "ellipse" | "Ellipse" => {
                let mut e = Node::ellipse(
                    &snap.id,
                    snap.x,
                    snap.y,
                    snap.w,
                    snap.h,
                    parsed_fill.unwrap_or(Color::BLACK),
                );
                e.name = snap.name.clone();
                e
            }
            "boolean" | "Boolean" | "path" | "Path" | "vector" | "Vector" => {
                let cmds: Vec<PathCmd> = snap
                    .path_commands
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .map(core_path_cmd_from_wasm)
                    .collect();
                let mut v = Node::vector(&snap.id, snap.x, snap.y, snap.w, snap.h, cmds);
                v.name = snap.name.clone();
                v.fill = Paint::Solid(parsed_fill.unwrap_or(Color::BLACK));
                v
            }
            _ => {
                let mut r = Node::rect(
                    &snap.id,
                    snap.x,
                    snap.y,
                    snap.w,
                    snap.h,
                    parsed_fill.unwrap_or(Color::BLACK),
                );
                if let Some(radius) = snap.radius {
                    if radius.is_finite() && radius >= 0.0 {
                        r.kind = NodeKind::Rect { radius };
                    }
                }
                r.name = snap.name.clone();
                r
            }
        };
        if snap.rotation.is_finite() && snap.rotation != 0.0 {
            node.transform.rotation = snap.rotation.to_radians();
        }
        if snap.opacity.is_finite() {
            node.opacity = snap.opacity.clamp(0.0, 1.0) as f32;
        }
        if let Some(stroke_color) = snap.stroke.as_deref().and_then(x_core::parse_hex_color) {
            let sw = snap.stroke_width.unwrap_or(1.0);
            if sw.is_finite() && sw > 0.0 {
                node.stroke = Stroke::solid(stroke_color, sw);
            }
        }
        if let Some(vis) = snap.visible {
            node.visible = vis;
        }
        if let Some(parent_id) = snap.parent_id.as_deref().filter(|s| !s.is_empty()) {
            let mut slot = Some(node);
            if !insert_into_parent(&mut page, parent_id, &mut slot) {
                if let Some(orphan) = slot {
                    page.children.push(orphan);
                }
            }
        } else {
            page.children.push(node);
        }
    }
    Ok(build_render_tree(&page, &Variables::default()))
}

/// Revision-keyed cache that avoids rebuilding the `x_render::RenderTree` or
/// repainting the canvas when neither the document state nor the viewport/DPR
/// has changed.
#[derive(Default)]
pub struct RenderFrameCache {
    last_canvas_id: String,
    last_state: Option<DocumentState>,
    last_pixel_width: u32,
    last_pixel_height: u32,
    last_dpr_bits: u64,
    cached_tree: Option<RenderTree>,
}

impl RenderFrameCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn prepare(
        &mut self,
        canvas_id: &str,
        state: &DocumentState,
        pixel_width: u32,
        pixel_height: u32,
        dpr: f64,
    ) -> Result<(&RenderTree, bool), String> {
        let dpr_bits = dpr.to_bits();
        let same_nodes = self
            .last_state
            .as_ref()
            .is_some_and(|prev| prev.revision == state.revision && prev.nodes == state.nodes);
        let same_viewport = self.last_canvas_id == canvas_id
            && self.last_pixel_width == pixel_width
            && self.last_pixel_height == pixel_height
            && self.last_dpr_bits == dpr_bits
            && self.last_state.as_ref().is_some_and(|prev| {
                prev.pan_x == state.pan_x && prev.pan_y == state.pan_y && prev.zoom == state.zoom
            });

        let skipped = same_nodes && same_viewport && self.cached_tree.is_some();
        if !skipped {
            if !same_nodes || self.cached_tree.is_none() {
                let tree = build_render_tree_from_state(state)?;
                self.cached_tree = Some(tree);
            }
            self.last_canvas_id = canvas_id.to_string();
            self.last_state = Some(state.clone());
            self.last_pixel_width = pixel_width;
            self.last_pixel_height = pixel_height;
            self.last_dpr_bits = dpr_bits;
        }
        let tree = self.cached_tree.as_ref().expect("populated above");
        Ok((tree, skipped))
    }
}

fn paint_hex(paint: &Paint, vars: &Variables) -> Option<String> {
    match paint {
        Paint::Solid(color) => {
            let rgba = color.to_rgba8();
            if rgba.a == 0 {
                None
            } else {
                Some(x_core::color_to_hex(*color))
            }
        }
        Paint::Variable(name) => {
            let color = vars.color(name, Color::BLACK);
            let rgba = color.to_rgba8();
            if rgba.a == 0 {
                None
            } else {
                Some(x_core::color_to_hex(color))
            }
        }
        Paint::LinearGradient { stops, .. }
        | Paint::RadialGradient { stops, .. }
        | Paint::AngularGradient { stops, .. }
        | Paint::DiamondGradient { stops, .. } => {
            stops.first().map(|(_, color)| x_core::color_to_hex(*color))
        }
        Paint::Pattern { .. } => None,
    }
}

#[derive(Debug, Clone)]
enum PocHistoryEntry {
    Editor,
    Variable {
        command: x_editor::variable_commands::VariableCommand,
        editor_step: bool,
    },
    VariableMode {
        collection_id: String,
        from_mode: Option<String>,
        to_mode: String,
        command: x_editor::variable_commands::VariableCommand,
    },
    ComponentOverride {
        instance_id: String,
        property_name: String,
        from: Option<String>,
        to: Option<String>,
        editor_step: bool,
    },
}

/// Host-testable proof-of-concept owner of an x-editor Editor. Production web
/// documents continue to use the established, separately admitted session.
pub struct PocEngine {
    editor: Editor,
    variables: Variables,
    active_modes: std::collections::HashMap<String, String>,
    component_overrides:
        std::collections::HashMap<String, std::collections::HashMap<String, String>>,
    history: Vec<PocHistoryEntry>,
    redo_history: Vec<PocHistoryEntry>,
    variables_touched: bool,
    components_touched: bool,
    revision: u32,
    next_id: u32,
}

impl PocEngine {
    pub fn new() -> Self {
        let mut variables = Variables::default();
        if let Some(c1) = x_core::parse_hex_color("#0d99ff") {
            variables.colors.insert("var-1".into(), c1);
            variables.collections.insert("var-1".into(), "Brand".into());
        }
        if let Some(c2) = x_core::parse_hex_color("#6366f1") {
            variables.colors.insert("var-2".into(), c2);
            variables.collections.insert("var-2".into(), "Brand".into());
        }
        variables.numbers.insert("var-3".into(), 8.0);
        variables
            .collections
            .insert("var-3".into(), "Spacing".into());
        variables.numbers.insert("var-4".into(), 16.0);
        variables
            .collections
            .insert("var-4".into(), "Spacing".into());
        variables.numbers.insert("var-5".into(), 8.0);
        variables
            .collections
            .insert("var-5".into(), "Radius".into());
        Self {
            editor: Editor::new(Node::frame("wasm-poc-page", 1200.0, 800.0)),
            variables,
            active_modes: std::collections::HashMap::new(),
            component_overrides: std::collections::HashMap::new(),
            history: Vec::new(),
            redo_history: Vec::new(),
            variables_touched: false,
            components_touched: false,
            revision: 0,
            next_id: 1,
        }
    }

    fn record_editor_step(&mut self) {
        self.history.push(PocHistoryEntry::Editor);
        self.redo_history.clear();
    }

    fn parse_var_value(raw: &str) -> x_editor::variable_commands::VarValue {
        use x_editor::variable_commands::VarValue;
        let trimmed = raw.trim();
        if let Some(color) =
            x_core::parse_hex_color(trimmed).or_else(|| x_core::parse_css_color(trimmed))
        {
            VarValue::Color(color)
        } else if trimmed.eq_ignore_ascii_case("true") {
            VarValue::Bool(true)
        } else if trimmed.eq_ignore_ascii_case("false") {
            VarValue::Bool(false)
        } else if let Some(num) = trimmed.parse::<f64>().ok().filter(|n| n.is_finite()) {
            VarValue::Number(num)
        } else {
            VarValue::Str(raw.to_string())
        }
    }

    fn collect_bound_node_ids(node: &Node, var_id: &str, out: &mut Vec<String>) {
        let bound_paint = matches!(&node.fill, Paint::Variable(v) if v == var_id)
            || node
                .fill_layers
                .iter()
                .any(|l| matches!(&l.paint, Paint::Variable(v) if v == var_id));
        let bound_prop = node.bindings.values().any(|v| v == var_id);
        if bound_paint || bound_prop {
            out.push(node.id.clone());
        }
        for child in &node.children {
            Self::collect_bound_node_ids(child, var_id, out);
        }
    }

    fn collect_snapshots(
        nodes: &[Node],
        parent_id: Option<&str>,
        vars: &Variables,
        component_overrides: &std::collections::HashMap<
            String,
            std::collections::HashMap<String, String>,
        >,
        out: &mut Vec<NodeSnapshot>,
    ) {
        for node in nodes {
            let deg = node.transform.rotation.to_degrees();
            let rotation = if deg == 0.0 || !deg.is_finite() {
                0.0
            } else {
                deg
            };
            let opacity = f64::from(node.opacity);
            let (kind, path_commands, boolean_op, auto_layout) = match &node.kind {
                NodeKind::Frame { layout } => (
                    "frame".into(),
                    None,
                    None,
                    layout.as_ref().map(|l| WasmAutoLayout {
                        axis: match l.direction {
                            LayoutDirection::Horizontal => "horizontal".into(),
                            LayoutDirection::Vertical => "vertical".into(),
                        },
                        padding: l.padding[0],
                        gap: l.gap,
                    }),
                ),
                NodeKind::Text { .. } => ("text".into(), None, None, None),
                NodeKind::Ellipse => ("ellipse".into(), None, None, None),
                NodeKind::Vector { path } => {
                    let is_bool = node.id.starts_with("wasm-poc-bool-");
                    let op = match node.name.as_str() {
                        "Union" => Some("union".into()),
                        "Subtract" => Some("subtract".into()),
                        "Intersect" => Some("intersect".into()),
                        "Exclude" => Some("exclude".into()),
                        _ => None,
                    };
                    (
                        if is_bool || op.is_some() {
                            "boolean".into()
                        } else {
                            "path".into()
                        },
                        Some(path.iter().map(wasm_path_cmd_from_core).collect()),
                        op,
                        None,
                    )
                }
                _ => ("rect".into(), None, None, None),
            };
            let (stroke, stroke_width) = {
                let active = node.active_strokes();
                if let Some(layer) = active.first() {
                    if layer.stroke.width > 0.0 {
                        (
                            paint_hex(&layer.stroke.paint, vars),
                            Some(layer.stroke.width),
                        )
                    } else {
                        (None, None)
                    }
                } else if node.stroke.width > 0.0 {
                    (paint_hex(&node.stroke.paint, vars), Some(node.stroke.width))
                } else {
                    (None, None)
                }
            };
            let fill = if let Some(var_name) = node.bindings.get("fill") {
                match vars.get(var_name) {
                    Some(x_core::Value::Str(hex)) => Some(hex),
                    _ => paint_hex(&node.fill, vars),
                }
            } else if node.visual_stacks_materialized {
                node.fill_layers
                    .iter()
                    .rev()
                    .find(|l| l.visible)
                    .and_then(|l| paint_hex(&l.paint, vars))
                    .or_else(|| paint_hex(&node.fill, vars))
            } else {
                paint_hex(&node.fill, vars)
            };
            let mut comp_props = std::collections::HashMap::new();
            for (k, v) in &node.bindings {
                if let Some(prop_name) = k.strip_prefix("prop:") {
                    comp_props.insert(prop_name.to_owned(), v.clone());
                }
            }
            if let Some(ovr) = component_overrides.get(&node.id) {
                for (k, v) in ovr {
                    comp_props.insert(k.clone(), v.clone());
                }
            }
            out.push(NodeSnapshot {
                id: node.id.clone(),
                name: node.name.clone(),
                kind,
                x: node.transform.x,
                y: node.transform.y,
                w: node.w,
                h: node.h,
                parent_id: parent_id.map(str::to_owned),
                rotation,
                opacity: if opacity.is_finite() { opacity } else { 1.0 },
                fill,
                stroke,
                stroke_width,
                text: match &node.kind {
                    NodeKind::Text { text } => Some(text.clone()),
                    _ => None,
                },
                radius: match &node.kind {
                    NodeKind::Rect { radius } if *radius > 0.0 => Some(*radius),
                    NodeKind::Frame { .. } => {
                        node.corner_radii.and_then(|r| (r[0] > 0.0).then_some(r[0]))
                    }
                    _ => None,
                },
                path_commands,
                boolean_op,
                auto_layout,
                visible: (!node.visible).then_some(false),
                component_properties: (!comp_props.is_empty()).then_some(comp_props),
            });
            Self::collect_snapshots(
                &node.children,
                Some(&node.id),
                vars,
                component_overrides,
                out,
            );
        }
    }

    fn relabel_clone_ids(node: &mut Node, next_id: &mut u32) -> Result<(), String> {
        let prefix = match &node.kind {
            NodeKind::Frame { .. } => "wasm-poc-frame",
            NodeKind::Text { .. } => "wasm-poc-text",
            NodeKind::Ellipse => "wasm-poc-ellipse",
            NodeKind::Vector { .. } => {
                if node.id.starts_with("wasm-poc-bool-") {
                    "wasm-poc-bool"
                } else {
                    "wasm-poc-path"
                }
            }
            _ => "wasm-poc-rect",
        };
        let current = *next_id;
        *next_id = next_id
            .checked_add(1)
            .ok_or_else(|| "WASM node id limit reached".to_string())?;
        node.id = format!("{prefix}-{current}");
        for child in &mut node.children {
            Self::relabel_clone_ids(child, next_id)?;
        }
        Ok(())
    }

    fn reflow_auto_layout_ancestors(&mut self, start_parent_id: &str) {
        let mut current = start_parent_id.to_owned();
        while !current.is_empty() && current != self.editor.root.id {
            if let Some(layout) = self.editor.auto_layout_of(&current) {
                self.editor
                    .set_auto_layout(&current, Some(layout), &self.variables);
            }
            if let Some(parent) = self.editor.get_parent_id(&current) {
                current = parent;
            } else {
                break;
            }
        }
    }

    pub fn snapshot(&self) -> DocumentState {
        let mut nodes = Vec::new();
        Self::collect_snapshots(
            &self.editor.root.children,
            None,
            &self.variables,
            &self.component_overrides,
            &mut nodes,
        );
        let variables = if self.variables_touched {
            let mut var_names = std::collections::BTreeSet::new();
            for k in self.variables.colors.keys() {
                var_names.insert(k.clone());
            }
            for k in self.variables.numbers.keys() {
                var_names.insert(k.clone());
            }
            for k in self.variables.strings.keys() {
                var_names.insert(k.clone());
            }
            for k in self.variables.bools.keys() {
                var_names.insert(k.clone());
            }
            for table in self.variables.modes.values() {
                for k in table.keys() {
                    var_names.insert(k.clone());
                }
            }
            for table in self.variables.num_modes.values() {
                for k in table.keys() {
                    var_names.insert(k.clone());
                }
            }
            for table in self.variables.str_modes.values() {
                for k in table.keys() {
                    var_names.insert(k.clone());
                }
            }
            for table in self.variables.bool_modes.values() {
                for k in table.keys() {
                    var_names.insert(k.clone());
                }
            }
            let mut map = std::collections::HashMap::new();
            for name in var_names {
                if let Some(val) = self.variables.get(&name) {
                    let s = match val {
                        x_core::Value::Str(v) => v,
                        x_core::Value::Num(n) => n.to_string(),
                        x_core::Value::Bool(b) => b.to_string(),
                    };
                    map.insert(name, s);
                }
            }
            Some(map)
        } else {
            None
        };
        let active_modes =
            if self.variables_touched && !self.active_modes.is_empty() {
                Some(self.active_modes.clone())
            } else {
                None
            };
        let component_overrides = if self.components_touched {
            Some(self.component_overrides.clone())
        } else {
            None
        };
        DocumentState {
            revision: self.revision,
            can_undo: !self.history.is_empty() || self.editor.undo_depth() > 0,
            nodes,
            device_pixel_ratio: None,
            viewport_width: None,
            viewport_height: None,
            pan_x: None,
            pan_y: None,
            zoom: None,
            variables,
            active_modes,
            component_overrides,
        }
    }

    pub fn dispatch_command(&mut self, command: Command) -> Result<DocumentState, String> {
        match command {
            Command::CreateNode {
                node_type,
                x,
                y,
                width,
                height,
                parent_id,
                text,
            } => {
                let kind = match node_type.as_str() {
                    "rect" | "rectangle" | "Rect" => "rect",
                    "frame" | "Frame" => "frame",
                    "text" | "Text" => "text",
                    "ellipse" | "Ellipse" => "ellipse",
                    _ => {
                        return Err("unsupported WASM node_type".into());
                    }
                };
                if !x.is_finite() || !y.is_finite() {
                    return Err("node coordinates must be finite numbers".into());
                }
                if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
                    return Err("node dimensions must be positive finite numbers".into());
                }
                let next_id = self
                    .next_id
                    .checked_add(1)
                    .ok_or("WASM node id limit reached")?;
                let revision = self
                    .revision
                    .checked_add(1)
                    .ok_or("WASM revision limit reached")?;
                let node = match kind {
                    "frame" => {
                        let id = format!("wasm-poc-frame-{}", self.next_id);
                        let mut frame = Node::frame(&id, width, height);
                        frame.transform.x = x;
                        frame.transform.y = y;
                        frame.name = format!("Frame {}", self.next_id);
                        frame
                    }
                    "text" => {
                        let id = format!("wasm-poc-text-{}", self.next_id);
                        let raw = text.as_deref().unwrap_or("");
                        let content = if raw.is_empty() { "Text" } else { raw };
                        let mut text_node = Node::text(&id, x, y, width, height, content);
                        text_node.name = format!("Text {}", self.next_id);
                        text_node
                    }
                    "ellipse" => {
                        let id = format!("wasm-poc-ellipse-{}", self.next_id);
                        let mut ellipse = Node::ellipse(&id, x, y, width, height, Color::BLACK);
                        ellipse.name = format!("Ellipse {}", self.next_id);
                        ellipse
                    }
                    _ => {
                        let id = format!("wasm-poc-rect-{}", self.next_id);
                        let mut rectangle = Node::rect(&id, x, y, width, height, Color::BLACK);
                        rectangle.name = format!("Rectangle {}", self.next_id);
                        rectangle
                    }
                };
                let target_parent = parent_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|pid| !pid.is_empty() && self.editor.get_node(pid).is_some())
                    .map(str::to_owned)
                    .unwrap_or_else(|| self.editor.root.id.clone());
                let depth_before = self.editor.undo_depth();
                if !self.editor.insert_node(&target_parent, node) {
                    return Err("Rust editor rejected the createNode command".into());
                }
                self.reflow_auto_layout_ancestors(&target_parent);
                let steps = self.editor.undo_depth().saturating_sub(depth_before);
                if steps > 1 {
                    self.editor.merge_last(steps);
                }
                self.record_editor_step();
                self.next_id = next_id;
                self.revision = revision;
                Ok(self.snapshot())
            }
            Command::MoveNode {
                id,
                dx,
                dy,
                parent_id,
            } => {
                if id.trim().is_empty() || id == self.editor.root.id {
                    return Err("node id must identify a non-root layer".into());
                }
                if !dx.is_finite() || !dy.is_finite() {
                    return Err("move deltas must be finite numbers".into());
                }
                if self.editor.get_node(&id).is_none() {
                    return Err(format!("node not found: {id}"));
                }
                let depth_before = self.editor.undo_depth();
                let before_serial = self.editor.edit_serial;
                let mut previous_parent: Option<String> = None;
                if let Some(requested_parent) = parent_id.as_deref().map(str::trim) {
                    let to_parent = if requested_parent.is_empty()
                        || requested_parent == self.editor.root.id
                        || self.editor.get_node(requested_parent).is_none()
                    {
                        self.editor.root.id.clone()
                    } else {
                        requested_parent.to_owned()
                    };
                    if let Some(from_parent) = self.editor.get_parent_id(&id) {
                        if from_parent != to_parent {
                            previous_parent = Some(from_parent.clone());
                            let from_index = self
                                .editor
                                .get_node(&from_parent)
                                .and_then(|p| p.children.iter().position(|c| c.id == id))
                                .unwrap_or(0);
                            let to_index = self
                                .editor
                                .get_node(&to_parent)
                                .map_or(0, |p| p.children.len());
                            let _ = self.editor.reorder_node(
                                &id,
                                &from_parent,
                                from_index,
                                &to_parent,
                                to_index,
                            );
                        }
                    }
                }
                if dx == 0.0 && dy == 0.0 && self.editor.edit_serial == before_serial {
                    return Ok(self.snapshot());
                }
                let revision = self
                    .revision
                    .checked_add(1)
                    .ok_or("WASM revision limit reached")?;
                if dx != 0.0 || dy != 0.0 {
                    self.editor.move_node(&id, dx, dy);
                }
                if self.editor.edit_serial == before_serial {
                    return Err("Rust editor rejected the moveNode command".into());
                }
                if let Some(from_p) = previous_parent {
                    self.reflow_auto_layout_ancestors(&from_p);
                }
                if let Some(cur_p) = self.editor.get_parent_id(&id) {
                    self.reflow_auto_layout_ancestors(&cur_p);
                }
                let steps = self.editor.undo_depth().saturating_sub(depth_before);
                if steps > 1 {
                    self.editor.merge_last(steps);
                }
                self.record_editor_step();
                self.revision = revision;
                Ok(self.snapshot())
            }
            Command::ResizeNode {
                id,
                x,
                y,
                width,
                height,
            } => {
                if id.trim().is_empty() || id == self.editor.root.id {
                    return Err("node id must identify a non-root layer".into());
                }
                if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
                    return Err("resize dimensions must be positive finite numbers".into());
                }
                if x.is_some_and(|v| !v.is_finite()) || y.is_some_and(|v| !v.is_finite()) {
                    return Err("resize coordinates must be finite numbers".into());
                }
                let (cur_x, cur_y, cur_w, cur_h) = self
                    .editor
                    .get_node(&id)
                    .map(|n| (n.transform.x, n.transform.y, n.w, n.h))
                    .ok_or_else(|| format!("node not found: {id}"))?;
                let dx = x.map_or(0.0, |nx| nx - cur_x);
                let dy = y.map_or(0.0, |ny| ny - cur_y);
                let dw = (width - cur_w).abs();
                let dh = (height - cur_h).abs();
                if dx == 0.0 && dy == 0.0 && dw == 0.0 && dh == 0.0 {
                    return Ok(self.snapshot());
                }
                let revision = self
                    .revision
                    .checked_add(1)
                    .ok_or("WASM revision limit reached")?;
                let depth_before = self.editor.undo_depth();
                let before_serial = self.editor.edit_serial;
                if dx != 0.0 || dy != 0.0 {
                    self.editor.move_node(&id, dx, dy);
                }
                if dw != 0.0 || dh != 0.0 {
                    self.editor.resize(&id, width, height);
                }
                if self.editor.edit_serial == before_serial {
                    return Err("Rust editor rejected the resizeNode command".into());
                }
                if let Some(cur_p) = self.editor.get_parent_id(&id) {
                    self.reflow_auto_layout_ancestors(&cur_p);
                }
                let steps = self.editor.undo_depth().saturating_sub(depth_before);
                if steps > 1 {
                    self.editor.merge_last(steps);
                }
                self.record_editor_step();
                self.revision = revision;
                Ok(self.snapshot())
            }
            Command::DeleteNode { id } => {
                if id.trim().is_empty() || id == self.editor.root.id {
                    return Err("cannot delete the root node".into());
                }
                if self.editor.get_node(&id).is_none() {
                    return Err(format!("node not found: {id}"));
                }
                let parent_id = self.editor.get_parent_id(&id);
                let revision = self
                    .revision
                    .checked_add(1)
                    .ok_or("WASM revision limit reached")?;
                let depth_before = self.editor.undo_depth();
                let before_serial = self.editor.edit_serial;
                self.editor.selection = vec![id];
                self.editor.delete_selection();
                if self.editor.edit_serial == before_serial {
                    return Err("Rust editor rejected the deleteNode command".into());
                }
                if let Some(pid) = parent_id {
                    self.reflow_auto_layout_ancestors(&pid);
                }
                let steps = self.editor.undo_depth().saturating_sub(depth_before);
                if steps > 1 {
                    self.editor.merge_last(steps);
                }
                self.record_editor_step();
                self.revision = revision;
                Ok(self.snapshot())
            }
            Command::BooleanOperation {
                target_ids,
                operation,
            } => {
                let (op, op_label) = match operation.trim() {
                    "union" | "Union" => (BoolOp::Union, "Union"),
                    "subtract" | "Subtract" => (BoolOp::Subtract, "Subtract"),
                    "intersect" | "Intersect" => (BoolOp::Intersect, "Intersect"),
                    "exclude" | "Exclude" => (BoolOp::Exclude, "Exclude"),
                    other => {
                        return Err(format!("unsupported boolean operation: {other}"));
                    }
                };
                if target_ids.len() < 2 {
                    return Err("booleanOperation requires at least 2 target node ids".into());
                }
                let mut cleaned_ids = Vec::with_capacity(target_ids.len());
                let mut common_parent: Option<String> = None;
                let mut paths = Vec::with_capacity(target_ids.len());
                let mut source_fill: Option<Paint> = None;
                let mut source_opacity: f32 = 1.0;
                for raw_id in &target_ids {
                    let id = raw_id.trim();
                    if id.is_empty() || id == self.editor.root.id {
                        return Err("booleanOperation targets must be non-root nodes".into());
                    }
                    if cleaned_ids.iter().any(|seen: &String| seen == id) {
                        return Err(format!("duplicate target id in booleanOperation: {id}"));
                    }
                    let node = self
                        .editor
                        .get_node(id)
                        .ok_or_else(|| format!("node not found: {id}"))?;
                    let parent = self
                        .editor
                        .get_parent_id(id)
                        .ok_or_else(|| format!("parent not found for node: {id}"))?;
                    if let Some(expected_parent) = &common_parent {
                        if expected_parent != &parent {
                            return Err("booleanOperation targets must share a parent".into());
                        }
                    } else {
                        common_parent = Some(parent);
                    }
                    let cmds = node_to_path(node).ok_or_else(|| {
                        format!("node cannot be converted to a boolean path: {id}")
                    })?;
                    if source_fill.is_none() {
                        source_fill = Some(node.fill.clone());
                        source_opacity = node.opacity;
                    }
                    paths.push(PositionedPath {
                        cmds,
                        offset: (node.transform.x, node.transform.y),
                    });
                    cleaned_ids.push(id.to_owned());
                }
                let parent_id = common_parent.unwrap_or_else(|| self.editor.root.id.clone());
                let mut acc = paths[0].clone();
                let mut acc_size = (0.0_f64, 0.0_f64);
                for next in &paths[1..] {
                    let res = boolean(op, &acc, next);
                    if res.cmds.is_empty() {
                        return Err("boolean operation produced an empty path".into());
                    }
                    acc = PositionedPath {
                        cmds: res.cmds,
                        offset: res.origin,
                    };
                    acc_size = res.size;
                }
                let next_id = self
                    .next_id
                    .checked_add(1)
                    .ok_or("WASM node id limit reached")?;
                let revision = self
                    .revision
                    .checked_add(1)
                    .ok_or("WASM revision limit reached")?;
                let bool_id = format!("wasm-poc-bool-{}", self.next_id);
                let mut bool_node = Node::vector(
                    &bool_id,
                    acc.offset.0,
                    acc.offset.1,
                    acc_size.0.max(1.0),
                    acc_size.1.max(1.0),
                    acc.cmds,
                );
                bool_node.name = op_label.to_owned();
                if let Some(fill) = source_fill {
                    bool_node.fill = fill;
                }
                bool_node.opacity = source_opacity;

                let depth_before = self.editor.undo_depth();
                let before_serial = self.editor.edit_serial;
                self.editor.selection = cleaned_ids;
                self.editor.delete_selection();
                if self.editor.edit_serial == before_serial {
                    return Err("Rust editor rejected deleting boolean source nodes".into());
                }
                if !self.editor.insert_node(&parent_id, bool_node) {
                    let _ = self.editor.undo();
                    return Err("Rust editor rejected inserting boolean result node".into());
                }
                self.reflow_auto_layout_ancestors(&parent_id);
                let steps = self.editor.undo_depth().saturating_sub(depth_before);
                if steps > 1 {
                    self.editor.merge_last(steps);
                }
                self.record_editor_step();
                self.editor.selection = vec![bool_id];
                self.next_id = next_id;
                self.revision = revision;
                Ok(self.snapshot())
            }
            Command::ApplyAutoLayout {
                frame_id,
                axis,
                padding,
                gap,
            } => {
                let id = frame_id.trim();
                if id.is_empty() || id == self.editor.root.id {
                    return Err("frameId must identify a non-root frame".into());
                }
                if !padding.is_finite() || padding < 0.0 {
                    return Err("auto-layout padding must be a non-negative finite number".into());
                }
                if !gap.is_finite() {
                    return Err("auto-layout gap must be a finite number".into());
                }
                let direction = match axis.trim() {
                    "horizontal" | "Horizontal" | "row" => LayoutDirection::Horizontal,
                    "vertical" | "Vertical" | "column" => LayoutDirection::Vertical,
                    other => {
                        return Err(format!("unsupported auto-layout axis: {other}"));
                    }
                };
                match self.editor.get_node(id).map(|n| &n.kind) {
                    Some(NodeKind::Frame { .. }) => {}
                    Some(_) => {
                        return Err(format!("node is not a frame: {id}"));
                    }
                    None => {
                        return Err(format!("frame not found: {id}"));
                    }
                }
                let revision = self
                    .revision
                    .checked_add(1)
                    .ok_or("WASM revision limit reached")?;
                let layout = AutoLayout {
                    direction,
                    gap,
                    padding: [padding, padding, padding, padding],
                    sizing: Sizing::Hug,
                    cross_sizing: Some(Sizing::Hug),
                    ..Default::default()
                };
                let depth_before = self.editor.undo_depth();
                let before_serial = self.editor.edit_serial;
                self.editor
                    .set_auto_layout(id, Some(layout), &self.variables);
                if self.editor.edit_serial == before_serial {
                    return Err("Rust editor rejected the applyAutoLayout command".into());
                }
                if let Some(parent_id) = self.editor.get_parent_id(id) {
                    self.reflow_auto_layout_ancestors(&parent_id);
                }
                let steps = self.editor.undo_depth().saturating_sub(depth_before);
                if steps > 1 {
                    self.editor.merge_last(steps);
                }
                self.record_editor_step();
                self.revision = revision;
                Ok(self.snapshot())
            }
            Command::UpdateNode {
                id,
                name,
                fill,
                stroke,
                stroke_width,
                opacity,
                rotation,
                radius,
                text,
                fill_variable,
            } => {
                let target_id = id.trim();
                if target_id.is_empty() || target_id == self.editor.root.id {
                    return Err("node id must identify a non-root layer".into());
                }
                if opacity.is_some_and(|v| !v.is_finite()) {
                    return Err("opacity must be a finite number".into());
                }
                if rotation.is_some_and(|v| !v.is_finite()) {
                    return Err("rotation must be a finite number".into());
                }
                if stroke_width.is_some_and(|v| !v.is_finite() || v < 0.0) {
                    return Err("strokeWidth must be a non-negative finite number".into());
                }
                if radius.is_some_and(|v| !v.is_finite() || v < 0.0) {
                    return Err("radius must be a non-negative finite number".into());
                }
                let before = self
                    .editor
                    .get_node(target_id)
                    .cloned()
                    .ok_or_else(|| format!("node not found: {target_id}"))?;
                let mut after = before;
                if let Some(new_name) = name {
                    let trimmed = new_name.trim();
                    if !trimmed.is_empty() {
                        after.name = trimmed.to_owned();
                    }
                }
                if let Some(fill_str) = fill {
                    let trimmed = fill_str.trim();
                    if let Some(var_id) = trimmed.strip_prefix("var:") {
                        let var_id = var_id.trim();
                        if !var_id.is_empty() {
                            after.fill = Paint::Variable(var_id.to_owned());
                            after.bindings.insert("fill".into(), var_id.to_owned());
                            if after.visual_stacks_materialized {
                                after.fill_layers =
                                    vec![x_core::PaintLayer::new(after.fill.clone())];
                            }
                        }
                    } else if trimmed.is_empty()
                        || trimmed.eq_ignore_ascii_case("none")
                        || trimmed.eq_ignore_ascii_case("#00000000")
                    {
                        after.fill = Paint::Solid(Color::TRANSPARENT);
                        after.bindings.remove("fill");
                        if after.visual_stacks_materialized {
                            after.fill_layers.clear();
                        }
                    } else {
                        let color = x_core::parse_hex_color(trimmed)
                            .ok_or_else(|| format!("invalid fill hex color: {trimmed}"))?;
                        after.fill = Paint::Solid(color);
                        if fill_variable.is_none() {
                            after.bindings.remove("fill");
                        }
                        if after.visual_stacks_materialized {
                            after.fill_layers = vec![x_core::PaintLayer::new(after.fill.clone())];
                        }
                    }
                }
                if let Some(var_raw) = fill_variable {
                    let var_id = var_raw.trim();
                    if var_id.is_empty() {
                        after.bindings.remove("fill");
                    } else {
                        if let Paint::Solid(color) = after.fill {
                            if color.to_rgba8().a > 0 {
                                self.variables
                                    .colors
                                    .entry(var_id.to_owned())
                                    .or_insert(color);
                            }
                        }
                        after.fill = Paint::Variable(var_id.to_owned());
                        after.bindings.insert("fill".into(), var_id.to_owned());
                        if after.visual_stacks_materialized {
                            after.fill_layers = vec![x_core::PaintLayer::new(after.fill.clone())];
                        }
                    }
                }
                if stroke.is_some() || stroke_width.is_some() {
                    let existing_color = after
                        .active_strokes()
                        .first()
                        .and_then(|layer| match &layer.stroke.paint {
                            Paint::Solid(c) if c.to_rgba8().a > 0 => Some(*c),
                            _ => None,
                        })
                        .or_else(|| match &after.stroke.paint {
                            Paint::Solid(c) if c.to_rgba8().a > 0 => Some(*c),
                            _ => None,
                        })
                        .unwrap_or(Color::BLACK);
                    let existing_width = after
                        .active_strokes()
                        .first()
                        .map(|l| l.stroke.width)
                        .unwrap_or(after.stroke.width);
                    let next_color = match stroke.as_deref().map(str::trim) {
                        Some(s)
                            if s.is_empty()
                                || s.eq_ignore_ascii_case("none")
                                || s.eq_ignore_ascii_case("#00000000") =>
                        {
                            None
                        }
                        Some(s) => Some(
                            x_core::parse_hex_color(s)
                                .ok_or_else(|| format!("invalid stroke hex color: {s}"))?,
                        ),
                        None => Some(existing_color),
                    };
                    let next_width = stroke_width.unwrap_or(if existing_width > 0.0 {
                        existing_width
                    } else {
                        1.0
                    });
                    if let Some(color) = next_color.filter(|_| next_width > 0.0) {
                        after.stroke = Stroke::solid(color, next_width);
                        if after.visual_stacks_materialized {
                            after.stroke_layers =
                                vec![x_core::StrokeLayer::new(after.stroke.clone())];
                        }
                    } else {
                        after.stroke = Stroke::default();
                        after.stroke_layers.clear();
                    }
                }
                if let Some(op) = opacity {
                    after.opacity = op.clamp(0.0, 1.0) as f32;
                }
                if let Some(rot_deg) = rotation {
                    after.transform.rotation = rot_deg.to_radians();
                }
                if let Some(r) = radius {
                    let clamped = r.max(0.0);
                    match &mut after.kind {
                        NodeKind::Rect { radius: rect_r } => {
                            *rect_r = clamped;
                            after.corner_radii = None;
                        }
                        NodeKind::Frame { .. } => {
                            after.corner_radii = if clamped > 0.0 {
                                Some([clamped; 4])
                            } else {
                                None
                            };
                        }
                        _ => {}
                    }
                }
                if let Some(new_text) = text {
                    if let NodeKind::Text { text: node_text } = &mut after.kind {
                        *node_text = new_text;
                    }
                }
                after.dirty = true;
                let revision = self
                    .revision
                    .checked_add(1)
                    .ok_or("WASM revision limit reached")?;
                if !self.editor.replace_node(target_id, after) {
                    return Err("Rust editor rejected the updateNode command".into());
                }
                self.record_editor_step();
                self.revision = revision;
                Ok(self.snapshot())
            }
            Command::OutlineStroke { id } => {
                let target_id = id.trim();
                if target_id.is_empty() || target_id == self.editor.root.id {
                    return Err("node id must identify a non-root layer".into());
                }
                if self.editor.get_node(target_id).is_none() {
                    return Err(format!("node not found: {target_id}"));
                }
                let parent_id = self.editor.get_parent_id(target_id);
                let revision = self
                    .revision
                    .checked_add(1)
                    .ok_or("WASM revision limit reached")?;
                let depth_before = self.editor.undo_depth();
                if self.editor.outline_stroke_node(target_id).is_none() {
                    return Err(format!(
                        "node cannot be outlined (requires an active stroke): {target_id}"
                    ));
                }
                if let Some(pid) = parent_id {
                    self.reflow_auto_layout_ancestors(&pid);
                }
                let steps = self.editor.undo_depth().saturating_sub(depth_before);
                if steps > 1 {
                    self.editor.merge_last(steps);
                }
                self.record_editor_step();
                self.revision = revision;
                Ok(self.snapshot())
            }
            Command::OffsetPath { id, distance, join } => {
                let target_id = id.trim();
                if target_id.is_empty() || target_id == self.editor.root.id {
                    return Err("node id must identify a non-root layer".into());
                }
                if !distance.is_finite() || distance == 0.0 {
                    return Err("offsetPath distance must be a non-zero finite number".into());
                }
                let stroke_join = match join.as_deref().map(str::trim) {
                    None | Some("") | Some("miter") | Some("Miter") => StrokeJoin::Miter,
                    Some("round") | Some("Round") => StrokeJoin::Round,
                    Some("bevel") | Some("Bevel") => StrokeJoin::Bevel,
                    Some(other) => {
                        return Err(format!("unsupported offsetPath join: {other}"));
                    }
                };
                let before = self
                    .editor
                    .get_node(target_id)
                    .cloned()
                    .ok_or_else(|| format!("node not found: {target_id}"))?;
                let source = node_to_path(&before).ok_or_else(|| {
                    format!("node cannot be converted to an offset path: {target_id}")
                })?;
                let rings = x_core::offset_path::offset_filled_path(&source, distance, stroke_join)
                    .map_err(str::to_owned)?;
                let mut next = before;
                let (mut min_x, mut min_y, mut max_x, mut max_y) = (
                    f64::INFINITY,
                    f64::INFINITY,
                    f64::NEG_INFINITY,
                    f64::NEG_INFINITY,
                );
                for &(x, y) in rings.iter().flatten() {
                    min_x = min_x.min(x);
                    min_y = min_y.min(y);
                    max_x = max_x.max(x);
                    max_y = max_y.max(y);
                }
                let mut cmds = Vec::new();
                if min_x.is_finite() {
                    for ring in &rings {
                        for (index, &(x, y)) in ring.iter().enumerate() {
                            let (lx, ly) = (x - min_x, y - min_y);
                            cmds.push(if index == 0 {
                                PathCmd::MoveTo(lx, ly)
                            } else {
                                PathCmd::LineTo(lx, ly)
                            });
                        }
                        cmds.push(PathCmd::Close);
                    }
                    next.transform.x += min_x;
                    next.transform.y += min_y;
                    next.w = (max_x - min_x).max(1.0);
                    next.h = (max_y - min_y).max(1.0);
                } else {
                    next.w = 1.0;
                    next.h = 1.0;
                }
                next.kind = NodeKind::Vector { path: cmds };
                next.corner_radii = None;
                next.corner_smoothing = 0.0;
                next.dirty = true;
                let parent_id = self.editor.get_parent_id(target_id);
                let revision = self
                    .revision
                    .checked_add(1)
                    .ok_or("WASM revision limit reached")?;
                let depth_before = self.editor.undo_depth();
                if !self.editor.replace_node(target_id, next) {
                    return Err("Rust editor rejected the offsetPath command".into());
                }
                if let Some(pid) = parent_id {
                    self.reflow_auto_layout_ancestors(&pid);
                }
                let steps = self.editor.undo_depth().saturating_sub(depth_before);
                if steps > 1 {
                    self.editor.merge_last(steps);
                }
                self.record_editor_step();
                self.revision = revision;
                Ok(self.snapshot())
            }
            Command::DuplicateNode { id, dx, dy } => {
                let target_id = id.trim();
                if target_id.is_empty() || target_id == self.editor.root.id {
                    return Err("node id must identify a non-root layer".into());
                }
                let offset_x = dx.unwrap_or(16.0);
                let offset_y = dy.unwrap_or(16.0);
                if !offset_x.is_finite() || !offset_y.is_finite() {
                    return Err("duplicate offsets must be finite numbers".into());
                }
                let mut cloned = self
                    .editor
                    .get_node(target_id)
                    .cloned()
                    .ok_or_else(|| format!("node not found: {target_id}"))?;
                let parent_id = self
                    .editor
                    .get_parent_id(target_id)
                    .unwrap_or_else(|| self.editor.root.id.clone());
                let mut candidate_next_id = self.next_id;
                Self::relabel_clone_ids(&mut cloned, &mut candidate_next_id)?;
                let revision = self
                    .revision
                    .checked_add(1)
                    .ok_or("WASM revision limit reached")?;
                cloned.transform.x += offset_x;
                cloned.transform.y += offset_y;
                if !cloned.name.is_empty() {
                    cloned.name = format!("{} copy", cloned.name);
                }
                let new_id = cloned.id.clone();
                let depth_before = self.editor.undo_depth();
                if !self.editor.insert_node(&parent_id, cloned) {
                    return Err("Rust editor rejected the duplicateNode command".into());
                }
                self.reflow_auto_layout_ancestors(&parent_id);
                let steps = self.editor.undo_depth().saturating_sub(depth_before);
                if steps > 1 {
                    self.editor.merge_last(steps);
                }
                self.record_editor_step();
                self.editor.selection = vec![new_id];
                self.next_id = candidate_next_id;
                self.revision = revision;
                Ok(self.snapshot())
            }
            Command::UpdateVariable { id, value } => {
                use x_editor::variable_commands::{
                    apply_variable, set_bool, set_color, set_mode_value, set_number, set_string,
                    VarValue, VariableCommand,
                };
                let var_id = id.trim();
                if var_id.is_empty() {
                    return Err("variable id must be a non-empty string".into());
                }
                let revision = self
                    .revision
                    .checked_add(1)
                    .ok_or("WASM revision limit reached")?;
                let parsed = Self::parse_var_value(&value);
                let base_cmd = match &parsed {
                    VarValue::Color(c) => set_color(&self.variables, var_id, *c),
                    VarValue::Number(n) => set_number(&self.variables, var_id, *n),
                    VarValue::Bool(b) => set_bool(&self.variables, var_id, *b),
                    VarValue::Str(s) => set_string(&self.variables, var_id, s.clone()),
                };
                let var_cmd = if let Some(mode) = self.variables.active_mode.clone() {
                    let mode_cmd = set_mode_value(&self.variables, var_id, &mode, parsed);
                    if self.variables.get(var_id).is_none() {
                        VariableCommand::Batch(vec![base_cmd, mode_cmd])
                    } else {
                        mode_cmd
                    }
                } else {
                    base_cmd
                };
                let _ = apply_variable(&mut self.variables, &var_cmd);
                let depth_before = self.editor.undo_depth();
                let mut bound_ids = Vec::new();
                Self::collect_bound_node_ids(&self.editor.root, var_id, &mut bound_ids);
                for bid in &bound_ids {
                    if let Some(mut node) = self.editor.get_node(bid).cloned() {
                        node.dirty = true;
                        let _ = self.editor.replace_node(bid, node);
                    }
                }
                let steps = self.editor.undo_depth().saturating_sub(depth_before);
                if steps > 1 {
                    self.editor.merge_last(steps);
                }
                self.variables_touched = true;
                self.history.push(PocHistoryEntry::Variable {
                    command: var_cmd,
                    editor_step: steps > 0,
                });
                self.redo_history.clear();
                self.revision = revision;
                Ok(self.snapshot())
            }
            Command::SetVariableMode {
                collection_id,
                mode_id,
            } => {
                use x_editor::variable_commands::{
                    apply_variable, set_active_mode, VariableCommand,
                };
                let col_id = collection_id.trim();
                let m_id = mode_id.trim();
                if col_id.is_empty() {
                    return Err("collectionId must be a non-empty string".into());
                }
                if m_id.is_empty() {
                    return Err("modeId must be a non-empty string".into());
                }
                let revision = self
                    .revision
                    .checked_add(1)
                    .ok_or("WASM revision limit reached")?;
                self.variables.modes.entry(m_id.to_owned()).or_default();
                let var_cmd = set_active_mode(&self.variables, m_id).unwrap_or(
                    VariableCommand::SetActiveMode {
                        from: self.variables.active_mode.clone(),
                        to: Some(m_id.to_owned()),
                    },
                );
                let _ = apply_variable(&mut self.variables, &var_cmd);
                let from_mode = self.active_modes.insert(col_id.to_owned(), m_id.to_owned());
                self.variables_touched = true;
                self.history.push(PocHistoryEntry::VariableMode {
                    collection_id: col_id.to_owned(),
                    from_mode,
                    to_mode: m_id.to_owned(),
                    command: var_cmd,
                });
                self.redo_history.clear();
                self.revision = revision;
                Ok(self.snapshot())
            }
            Command::UpdateComponentProperty {
                instance_id,
                property_name,
                value,
            } => {
                let inst_id = instance_id.trim();
                let prop_name = property_name.trim();
                if inst_id.is_empty() || inst_id == self.editor.root.id {
                    return Err("instanceId must identify a non-root layer".into());
                }
                if prop_name.is_empty() {
                    return Err("propertyName must be a non-empty string".into());
                }
                let revision = self
                    .revision
                    .checked_add(1)
                    .ok_or("WASM revision limit reached")?;
                let depth_before = self.editor.undo_depth();
                let mut editor_mutated = false;
                if self.editor.set_prop_value(inst_id, prop_name, &value) {
                    if let Some(mut after) = self.editor.get_node(inst_id).cloned() {
                        after
                            .bindings
                            .insert(format!("prop:{prop_name}"), value.clone());
                        let _ = self.editor.replace_node(inst_id, after);
                    }
                    editor_mutated = true;
                } else if let Some(before) = self.editor.get_node(inst_id).cloned() {
                    let mut after = before;
                    if let Ok(b) = value.trim().parse::<bool>() {
                        x_core::set_exclusive_override(
                            &mut after,
                            prop_name,
                            x_core::OverrideValue::Visible(b),
                        );
                        let prop_lower = prop_name.to_ascii_lowercase();
                        let mut matched_child = false;
                        for child in &mut after.children {
                            let child_lower = child.name.to_ascii_lowercase();
                            if child_lower == prop_lower
                                || (!child_lower.is_empty() && prop_lower.contains(&child_lower))
                            {
                                child.visible = b;
                                matched_child = true;
                            }
                        }
                        if !matched_child && after.children.len() == 1 {
                            after.children[0].visible = b;
                        }
                    } else {
                        x_core::set_exclusive_override(
                            &mut after,
                            prop_name,
                            x_core::OverrideValue::Text(value.clone()),
                        );
                        let prop_lower = prop_name.to_ascii_lowercase();
                        let mut matched_named = false;
                        for child in &mut after.children {
                            if child.name.to_ascii_lowercase() == prop_lower {
                                if let NodeKind::Text { text } = &mut child.kind {
                                    *text = value.clone();
                                    matched_named = true;
                                }
                            }
                        }
                        if !matched_named {
                            for child in &mut after.children {
                                if let NodeKind::Text { text } = &mut child.kind {
                                    *text = value.clone();
                                    break;
                                }
                            }
                        }
                    }
                    after
                        .bindings
                        .insert(format!("prop:{prop_name}"), value.clone());
                    after.dirty = true;
                    if self.editor.replace_node(inst_id, after) {
                        editor_mutated = true;
                    }
                }
                if editor_mutated {
                    if let Some(pid) = self.editor.get_parent_id(inst_id) {
                        self.reflow_auto_layout_ancestors(&pid);
                    }
                }
                let steps = self.editor.undo_depth().saturating_sub(depth_before);
                if steps > 1 {
                    self.editor.merge_last(steps);
                }
                let prev_override = self
                    .component_overrides
                    .entry(inst_id.to_owned())
                    .or_default()
                    .insert(prop_name.to_owned(), value.clone());
                self.components_touched = true;
                self.history.push(PocHistoryEntry::ComponentOverride {
                    instance_id: inst_id.to_owned(),
                    property_name: prop_name.to_owned(),
                    from: prev_override,
                    to: Some(value),
                    editor_step: steps > 0,
                });
                self.redo_history.clear();
                self.revision = revision;
                Ok(self.snapshot())
            }
            Command::Undo => {
                let Some(entry) = self.history.pop() else {
                    if !self.editor.undo() {
                        return Ok(self.snapshot());
                    }
                    let revision = self
                        .revision
                        .checked_add(1)
                        .ok_or("WASM revision limit reached")?;
                    self.revision = revision;
                    return Ok(self.snapshot());
                };
                match &entry {
                    PocHistoryEntry::Editor => {
                        if !self.editor.undo() {
                            return Ok(self.snapshot());
                        }
                    }
                    PocHistoryEntry::Variable {
                        command,
                        editor_step,
                    } => {
                        if *editor_step {
                            let _ = self.editor.undo();
                        }
                        let inv = x_editor::variable_commands::invert_variable(command);
                        let _ = x_editor::variable_commands::apply_variable(
                            &mut self.variables,
                            &inv,
                        );
                    }
                    PocHistoryEntry::VariableMode {
                        collection_id,
                        from_mode,
                        command,
                        ..
                    } => {
                        let inv = x_editor::variable_commands::invert_variable(command);
                        let _ = x_editor::variable_commands::apply_variable(
                            &mut self.variables,
                            &inv,
                        );
                        if let Some(prev) = from_mode {
                            self.active_modes.insert(collection_id.clone(), prev.clone());
                        } else {
                            self.active_modes.remove(collection_id);
                        }
                    }
                    PocHistoryEntry::ComponentOverride {
                        instance_id,
                        property_name,
                        from,
                        editor_step,
                        ..
                    } => {
                        if *editor_step {
                            let _ = self.editor.undo();
                        }
                        if let Some(prev) = from {
                            self.component_overrides
                                .entry(instance_id.clone())
                                .or_default()
                                .insert(property_name.clone(), prev.clone());
                        } else if let Some(map) = self.component_overrides.get_mut(instance_id) {
                            map.remove(property_name);
                        }
                    }
                }
                self.redo_history.push(entry);
                let revision = self
                    .revision
                    .checked_add(1)
                    .ok_or("WASM revision limit reached")?;
                self.revision = revision;
                Ok(self.snapshot())
            }
            Command::Redo => {
                let Some(entry) = self.redo_history.pop() else {
                    if !self.editor.redo() {
                        return Ok(self.snapshot());
                    }
                    let revision = self
                        .revision
                        .checked_add(1)
                        .ok_or("WASM revision limit reached")?;
                    self.revision = revision;
                    return Ok(self.snapshot());
                };
                match &entry {
                    PocHistoryEntry::Editor => {
                        if !self.editor.redo() {
                            return Ok(self.snapshot());
                        }
                    }
                    PocHistoryEntry::Variable {
                        command,
                        editor_step,
                    } => {
                        if *editor_step {
                            let _ = self.editor.redo();
                        }
                        let _ = x_editor::variable_commands::apply_variable(
                            &mut self.variables,
                            command,
                        );
                    }
                    PocHistoryEntry::VariableMode {
                        collection_id,
                        to_mode,
                        command,
                        ..
                    } => {
                        let _ = x_editor::variable_commands::apply_variable(
                            &mut self.variables,
                            command,
                        );
                        self.active_modes
                            .insert(collection_id.clone(), to_mode.clone());
                    }
                    PocHistoryEntry::ComponentOverride {
                        instance_id,
                        property_name,
                        to,
                        editor_step,
                        ..
                    } => {
                        if *editor_step {
                            let _ = self.editor.redo();
                        }
                        if let Some(val) = to {
                            self.component_overrides
                                .entry(instance_id.clone())
                                .or_default()
                                .insert(property_name.clone(), val.clone());
                        }
                    }
                }
                self.history.push(entry);
                let revision = self
                    .revision
                    .checked_add(1)
                    .ok_or("WASM revision limit reached")?;
                self.revision = revision;
                Ok(self.snapshot())
            }
        }
    }
}

impl Default for PocEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// Result of an import, as a small JSON envelope.
///
/// A `Result` cannot cross the wasm boundary usefully, so success and failure
/// are both encoded in the payload. The caller parses one shape either way,
/// and a malformed file produces a readable message instead of a trap.
fn envelope(result: Result<String, String>) -> String {
    match result {
        Ok(doc) => format!("{{\"ok\":true,\"doc\":{doc}}}"),
        Err(e) => format!("{{\"ok\":false,\"error\":{}}}", serde_json::json!(e)),
    }
}

/// Additive, independently versioned import metadata. The persisted .x schema
/// and native document remain unchanged. Older clients still decline text;
/// newer clients require these original dimensions rather than guessing.
fn import_envelope(
    result: Result<(x_core::Document, x_format::ImportReport), String>,
    source: &str,
) -> String {
    match result {
        Err(e) => envelope(Err(e)),
        Ok((doc, report)) => {
            let metrics: serde_json::Map<String, serde_json::Value> = report
                .text_metrics
                .iter()
                .map(|(id, m)| {
                    let mut fields = serde_json::json!({
                        "width": m.width, "height": m.height, "fontSize": m.font_size
                    });
                    if source == "svg" {
                        // SVG-only v2: explicit numeric weight or null (no
                        // supported element weight). Do not invent weight for
                        // FIG/Sketch or change their v1 metadata contract.
                        fields["fontWeight"] = serde_json::json!(m.font_weight);
                    }
                    (id.clone(), fields)
                })
                .collect();
            let version = if source == "svg" { 2 } else { 1 };
            let metadata = serde_json::json!({ "version": version, "nodes": metrics });
            let coordinates = if source == "fig" {
                let nodes: serde_json::Map<String, serde_json::Value> = report
                    .source_positions
                    .iter()
                    .map(|(id, (x, y))| (id.clone(), serde_json::json!({ "x": x, "y": y })))
                    .collect();
                let appearance: serde_json::Map<String, serde_json::Value> = report.figma_appearance.iter().map(|(id, a)| {
                    (id.clone(), serde_json::json!({ "fill": a.fill, "blend": a.blend, "effectCount": a.effect_count, "uniformCorners": a.uniform_corners }))
                }).collect();
                let effects: serde_json::Map<String, serde_json::Value> = report
                    .figma_appearance
                    .iter()
                    .map(|(id, a)| {
                        let values: Vec<_> = a.effects.iter().map(|e| serde_json::json!({
                        "kind": e.kind, "color": x_core::color_to_hex(e.color), "x": e.x, "y": e.y,
                        "blur": e.blur, "spread": e.spread, "visible": e.visible,
                        "blend": e.blend, "showBehind": e.show_behind
                    })).collect();
                        (id.clone(), serde_json::json!(values))
                    })
                    .collect();
                format!(
                    ",\"figmaCoordinates\":{},\"figmaAppearance\":{},\"figmaEffects\":{}",
                    serde_json::json!({ "version": 1, "nodes": nodes }),
                    serde_json::json!({ "version": 1, "images": report.assets_imported, "nodes": appearance }),
                    serde_json::json!({ "version": 1, "nodes": effects })
                )
            } else {
                String::new()
            };
            format!(
                "{{\"ok\":true,\"doc\":{},\"textMetrics\":{metadata}{coordinates}}}",
                save_x(&doc)
            )
        }
    }
}

/// Import a  `.fig` archive and return it as `.x` JSON.
pub fn import_fig_to_x(bytes: &[u8]) -> String {
    import_envelope(figbinary::import_fig_bytes_with_report(bytes), "fig")
}

/// Import a  archive and return it as `.x` JSON.
pub fn import_sketch_to_x(bytes: &[u8]) -> String {
    import_envelope(sketch::import_sketch_with_report(bytes), "sketch")
}

/// Import an SVG document and return it as `.x` JSON.
///
/// `import_svg` yields a single page `Node` rather than a `Document`, so it is
/// wrapped here. `Document::default()` supplies the empty variable/style/asset
/// stores, which is what an SVG carries anyway.
pub fn import_svg_to_x(text: &str) -> String {
    import_envelope(
        svg_import::import_svg_with_report(text).map(|(page, report)| {
            let doc = x_core::Document {
                pages: vec![page],
                ..Default::default()
            };
            (doc, report)
        }),
        "svg",
    )
}

/// Build identifier, so the web app can report which engine answered and a
/// bridged build is distinguishable from the TypeScript path at a glance.
pub fn engine_version() -> String {
    format!("x-wasm {} (rust)", env!("CARGO_PKG_VERSION"))
}

// The wasm_bindgen surface delegates to host-testable Rust imports and the
// shared command session. Native `cargo test` does not need wasm-bindgen.
#[cfg(target_arch = "wasm32")]
mod bindings {
    use std::cell::RefCell;

    use wasm_bindgen::prelude::*;
    use wasm_bindgen::JsCast;
    use x_core::kurbo::{BezPath, PathEl};
    use x_render::RenderCommand;

    use super::{brush_css_color, DocumentState, RenderFrameCache, RenderFrameStats};

    thread_local! {
        /// Isolated test engine; it never shares the production import or
        /// RustDocumentSession state.
        static POC_ENGINE: RefCell<Option<super::PocEngine>> = const { RefCell::new(None) };
        /// Per-thread frame cache for `render_frame` so unchanged revisions skip
        /// redundant `x-render` lowering and Canvas2D draw passes.
        static RENDER_CACHE: RefCell<RenderFrameCache> = RefCell::new(RenderFrameCache::new());
    }

    fn js_error(error: String) -> JsValue {
        JsValue::from_str(&error)
    }

    fn trace_bez_path(ctx: &web_sys::CanvasRenderingContext2d, path: &BezPath) {
        ctx.begin_path();
        for el in path.elements() {
            match el {
                PathEl::MoveTo(p) => ctx.move_to(p.x, p.y),
                PathEl::LineTo(p) => ctx.line_to(p.x, p.y),
                PathEl::QuadTo(p1, p2) => ctx.quadratic_curve_to(p1.x, p1.y, p2.x, p2.y),
                PathEl::CurveTo(p1, p2, p3) => {
                    ctx.bezier_curve_to(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
                }
                PathEl::ClosePath => ctx.close_path(),
            }
        }
    }

    fn execute_render_commands(
        ctx: &web_sys::CanvasRenderingContext2d,
        commands: &[RenderCommand],
    ) -> usize {
        let mut draw_calls = 0usize;
        for cmd in commands {
            match cmd {
                RenderCommand::FillPath {
                    transform,
                    path,
                    brush,
                    ..
                } => {
                    ctx.save();
                    let c = transform.as_coeffs();
                    let _ = ctx.transform(c[0], c[1], c[2], c[3], c[4], c[5]);
                    trace_bez_path(ctx, path);
                    ctx.set_fill_style_str(&brush_css_color(brush));
                    ctx.fill();
                    ctx.restore();
                    draw_calls += 1;
                }
                RenderCommand::StrokePath {
                    transform,
                    path,
                    brush,
                    width,
                    ..
                } => {
                    ctx.save();
                    let c = transform.as_coeffs();
                    let _ = ctx.transform(c[0], c[1], c[2], c[3], c[4], c[5]);
                    trace_bez_path(ctx, path);
                    ctx.set_stroke_style_str(&brush_css_color(brush));
                    ctx.set_line_width(*width);
                    ctx.stroke();
                    ctx.restore();
                    draw_calls += 1;
                }
                RenderCommand::Glyphs {
                    transform,
                    text,
                    size,
                    brush,
                    font,
                    ..
                } => {
                    ctx.save();
                    let c = transform.as_coeffs();
                    let _ = ctx.transform(c[0], c[1], c[2], c[3], c[4], c[5]);
                    let family = font.as_deref().unwrap_or("Inter, sans-serif");
                    ctx.set_font(&format!("{size}px {family}"));
                    ctx.set_fill_style_str(&brush_css_color(brush));
                    let _ = ctx.fill_text(text, 0.0, *size);
                    ctx.restore();
                    draw_calls += 1;
                }
                RenderCommand::PushClip {
                    transform, path, ..
                } => {
                    ctx.save();
                    let c = transform.as_coeffs();
                    let _ = ctx.transform(c[0], c[1], c[2], c[3], c[4], c[5]);
                    trace_bez_path(ctx, path);
                    ctx.clip();
                }
                RenderCommand::PushLayer { alpha, .. } => {
                    ctx.save();
                    ctx.set_global_alpha(f64::from(*alpha));
                }
                RenderCommand::PopLayer => {
                    ctx.restore();
                }
                RenderCommand::Image {
                    transform, w, h, ..
                } => {
                    ctx.save();
                    let c = transform.as_coeffs();
                    let _ = ctx.transform(c[0], c[1], c[2], c[3], c[4], c[5]);
                    ctx.stroke_rect(0.0, 0.0, *w, *h);
                    ctx.restore();
                    draw_calls += 1;
                }
            }
        }
        draw_calls
    }

    /// Start the isolated Phase 1 POC and return its initial typed snapshot.
    #[wasm_bindgen(js_name = init_wasm_engine)]
    pub fn init_wasm_engine() -> Result<JsValue, JsValue> {
        RENDER_CACHE.with(|cache| {
            *cache.borrow_mut() = RenderFrameCache::new();
        });
        let state = POC_ENGINE.with(|slot| {
            let mut slot = slot.borrow_mut();
            *slot = Some(super::PocEngine::new());
            slot.as_ref()
                .expect("POC engine was just initialized")
                .snapshot()
        });
        state
            .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
            .map_err(|error| js_error(error.to_string()))
    }

    /// Dispatch one Serde-tagged JS object and return the new Rust snapshot.
    #[wasm_bindgen(js_name = dispatch_command)]
    pub fn dispatch_command(command: JsValue) -> Result<JsValue, JsValue> {
        let command = serde_wasm_bindgen::from_value(command)
            .map_err(|error| js_error(format!("Invalid WASM POC command: {error}")))?;
        let state = POC_ENGINE.with(|slot| -> Result<super::DocumentState, JsValue> {
            let mut slot = slot.borrow_mut();
            let engine = slot.as_mut().ok_or_else(|| {
                js_error("Call init_wasm_engine() before dispatch_command()".into())
            })?;
            engine.dispatch_command(command).map_err(js_error)
        })?;
        state
            .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
            .map_err(|error| js_error(error.to_string()))
    }

    /// Render a `DocumentState` snapshot onto the HTML `<canvas>` identified by
    /// `canvas_id` using `x-render` command lowering and `web_sys::CanvasRenderingContext2d`.
    #[wasm_bindgen(js_name = render_frame)]
    pub fn render_frame(canvas_id: &str, state: JsValue) -> Result<JsValue, JsValue> {
        if canvas_id.trim().is_empty() {
            return Err(js_error("canvas_id must be a non-empty string".into()));
        }
        let state: DocumentState = serde_wasm_bindgen::from_value(state).map_err(|error| {
            js_error(format!("Invalid DocumentState for render_frame: {error}"))
        })?;

        let window = web_sys::window().ok_or_else(|| js_error("window is unavailable".into()))?;
        let document = window
            .document()
            .ok_or_else(|| js_error("window.document is unavailable".into()))?;
        let element = document
            .get_element_by_id(canvas_id)
            .ok_or_else(|| js_error(format!("Canvas element not found: #{canvas_id}")))?;
        if !element.tag_name().eq_ignore_ascii_case("CANVAS") {
            return Err(js_error(format!(
                "Element #{canvas_id} is not an HTMLCanvasElement"
            )));
        }
        let canvas: web_sys::HtmlCanvasElement = element.unchecked_into();
        let ctx_obj = canvas
            .get_context("2d")
            .map_err(|_| js_error("Failed to acquire 2D canvas context".into()))?
            .ok_or_else(|| js_error("2D canvas context returned null".into()))?;
        let ctx: web_sys::CanvasRenderingContext2d = ctx_obj.unchecked_into();

        let raw_window_dpr = window.device_pixel_ratio();
        let window_dpr = if raw_window_dpr.is_finite() && raw_window_dpr > 0.0 {
            raw_window_dpr
        } else {
            1.0
        };
        let dpr = state
            .device_pixel_ratio
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(window_dpr)
            .clamp(0.5, 8.0);

        let css_width = state
            .viewport_width
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or_else(|| {
                let cw = f64::from(canvas.client_width());
                if cw > 0.0 {
                    cw
                } else {
                    (f64::from(canvas.width()) / dpr).max(1.0)
                }
            });
        let css_height = state
            .viewport_height
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or_else(|| {
                let ch = f64::from(canvas.client_height());
                if ch > 0.0 {
                    ch
                } else {
                    (f64::from(canvas.height()) / dpr).max(1.0)
                }
            });

        let pixel_width = ((css_width * dpr).round() as u32).max(1);
        let pixel_height = ((css_height * dpr).round() as u32).max(1);
        if canvas.width() != pixel_width {
            canvas.set_width(pixel_width);
        }
        if canvas.height() != pixel_height {
            canvas.set_height(pixel_height);
        }

        let stats = RENDER_CACHE
            .with(|cache| -> Result<RenderFrameStats, String> {
                let mut cache = cache.borrow_mut();
                let (tree, skipped) =
                    cache.prepare(canvas_id, &state, pixel_width, pixel_height, dpr)?;
                let command_count = tree.commands.len();
                if skipped {
                    return Ok(RenderFrameStats {
                        revision: state.revision,
                        node_count: state.nodes.len(),
                        command_count,
                        draw_calls: 0,
                        device_pixel_ratio: dpr,
                        pixel_width,
                        pixel_height,
                        skipped_unchanged: true,
                    });
                }

                let _ = ctx.set_transform(1.0, 0.0, 0.0, 1.0, 0.0, 0.0);
                ctx.clear_rect(0.0, 0.0, f64::from(pixel_width), f64::from(pixel_height));

                let zoom = state
                    .zoom
                    .filter(|z| z.is_finite() && *z > 0.0)
                    .unwrap_or(1.0);
                let pan_x = state.pan_x.filter(|p| p.is_finite()).unwrap_or(0.0);
                let pan_y = state.pan_y.filter(|p| p.is_finite()).unwrap_or(0.0);
                let _ =
                    ctx.set_transform(dpr * zoom, 0.0, 0.0, dpr * zoom, dpr * pan_x, dpr * pan_y);

                let draw_calls = execute_render_commands(&ctx, &tree.commands);
                Ok(RenderFrameStats {
                    revision: state.revision,
                    node_count: state.nodes.len(),
                    command_count,
                    draw_calls,
                    device_pixel_ratio: dpr,
                    pixel_width,
                    pixel_height,
                    skipped_unchanged: false,
                })
            })
            .map_err(js_error)?;

        serde_wasm_bindgen::to_value(&stats).map_err(|error| js_error(error.to_string()))
    }

    /// Independently versioned command session. V3 added Booleans, V4 added
    /// aligned strokes, V5 added bounded single-layer signed offsets, and V6
    /// adds reversible Outline Stroke projections. Older bindgen artifacts
    /// cannot safely acknowledge/undo the new filled-vector rewrite.
    #[wasm_bindgen(js_name = sessionBridgeVersion)]
    pub fn session_bridge_version() -> u32 {
        6
    }

    #[wasm_bindgen]
    pub struct RustDocumentSession {
        bridge: super::session::CommandBridge,
    }

    #[wasm_bindgen]
    impl RustDocumentSession {
        #[wasm_bindgen(constructor)]
        pub fn new(x: &str) -> Result<RustDocumentSession, JsValue> {
            Ok(Self {
                bridge: super::session::CommandBridge::open(x).map_err(js_error)?,
            })
        }

        #[wasm_bindgen(js_name = state)]
        pub fn state(&self) -> String {
            self.bridge.state()
        }

        #[wasm_bindgen(js_name = getNode)]
        pub fn get_node(&self, id: &str) -> String {
            self.bridge.get_node(id)
        }

        #[wasm_bindgen(js_name = getShape)]
        pub fn get_shape(&self, id: &str) -> Result<String, JsValue> {
            self.bridge.get_shape(id).map_err(js_error)
        }

        #[wasm_bindgen(js_name = renameNode)]
        pub fn rename_node(&mut self, id: &str, name: &str) -> Result<String, JsValue> {
            self.bridge.rename_node(id, name).map_err(js_error)
        }

        #[wasm_bindgen(js_name = moveNode)]
        pub fn move_node(&mut self, id: &str, dx: f64, dy: f64) -> Result<String, JsValue> {
            self.bridge.move_node(id, dx, dy).map_err(js_error)
        }

        #[wasm_bindgen(js_name = resizeNode)]
        pub fn resize_node(&mut self, id: &str, w: f64, h: f64) -> Result<String, JsValue> {
            self.bridge.resize_node(id, w, h).map_err(js_error)
        }

        #[wasm_bindgen(js_name = booleanNode)]
        pub fn boolean_node(
            &mut self,
            first: &str,
            second: &str,
            op: &str,
        ) -> Result<String, JsValue> {
            self.bridge
                .boolean_node(first, second, op)
                .map_err(js_error)
        }

        #[wasm_bindgen(js_name = strokeNode)]
        pub fn stroke_node(
            &mut self,
            id: &str,
            width: f64,
            color: &str,
            align: &str,
            join: &str,
        ) -> Result<String, JsValue> {
            self.bridge
                .stroke_node(id, width, color, align, join)
                .map_err(js_error)
        }

        #[wasm_bindgen(js_name = previewOffset)]
        pub fn preview_offset(
            &self,
            id: &str,
            distance: f64,
            join: &str,
        ) -> Result<String, JsValue> {
            self.bridge
                .preview_offset(id, distance, join)
                .map_err(js_error)
        }

        #[wasm_bindgen(js_name = offsetNode)]
        pub fn offset_node(
            &mut self,
            id: &str,
            distance: f64,
            join: &str,
        ) -> Result<String, JsValue> {
            self.bridge
                .offset_node(id, distance, join)
                .map_err(js_error)
        }

        #[wasm_bindgen(js_name = outlineStroke)]
        pub fn outline_stroke(&mut self, id: &str) -> Result<String, JsValue> {
            self.bridge.outline_stroke(id).map_err(js_error)
        }

        pub fn undo(&mut self) -> Result<String, JsValue> {
            self.bridge.undo().map_err(js_error)
        }

        pub fn redo(&mut self) -> Result<String, JsValue> {
            self.bridge.redo().map_err(js_error)
        }

        #[wasm_bindgen(js_name = exportX)]
        pub fn export_x(&self) -> String {
            self.bridge.export_x()
        }
    }

    #[wasm_bindgen(js_name = importFigToX)]
    pub fn import_fig_to_x(bytes: &[u8]) -> String {
        super::import_fig_to_x(bytes)
    }

    #[wasm_bindgen(js_name = importSketchToX)]
    pub fn import_sketch_to_x(bytes: &[u8]) -> String {
        super::import_sketch_to_x(bytes)
    }

    #[wasm_bindgen(js_name = importSvgToX)]
    pub fn import_svg_to_x(text: &str) -> String {
        super::import_svg_to_x(text)
    }

    #[wasm_bindgen(js_name = bridgeVersion)]
    pub fn bridge_version() -> u32 {
        1
    }

    #[wasm_bindgen(js_name = engineVersion)]
    pub fn engine_version() -> String {
        super::engine_version()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_malformed_fig_reports_rather_than_panicking() {
        let out = import_fig_to_x(b"definitely not a zip");
        assert!(out.starts_with("{\"ok\":false"), "got: {out}");
        assert!(out.contains("error"), "got: {out}");
    }

    #[test]
    fn a_malformed_sketch_reports_rather_than_panicking() {
        let out = import_sketch_to_x(b"not a zip either");
        assert!(out.starts_with("{\"ok\":false"), "got: {out}");
    }

    #[test]
    fn an_svg_round_trips_to_x_json() {
        // r##..##: the fill colour contains `"#`, which closes a plain r#".."#.
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120">
            <rect x="10" y="10" width="80" height="50" fill="#ff0000"/></svg>"##;
        let out = import_svg_to_x(svg);
        assert!(out.starts_with("{\"ok\":true"), "got: {out}");
        // The payload has to be the document, not an empty stub.
        assert!(out.len() > 64, "suspiciously small payload: {out}");
    }

    #[test]
    fn svg_view_box_dimensions_survive_the_wasm_envelope() {
        let out = import_svg_to_x(
            r#"<svg viewBox="0 0 96 48"><rect id="box" width="20" height="15" fill="red"/></svg>"#,
        );
        let value: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(value["doc"]["pages"][0]["w"], 96.0);
        assert_eq!(value["doc"]["pages"][0]["h"], 48.0);
        assert_eq!(value["doc"]["pages"][0]["children"][0]["id"], "box");
    }

    #[test]
    fn translated_svg_group_exports_text_and_following_shape_without_a_wrapper() {
        let out = import_svg_to_x(
            r#"<svg width="120" height="80"><g id="wrapper" transform="translate(10 20)">
              <text id="label" x="0" y="30" font-size="10">Hi</text>
              <rect id="after" x="1" y="2" width="4" height="4" fill="red"/>
            </g></svg>"#,
        );
        let value: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(value["ok"], true);
        let children = value["doc"]["pages"][0]["children"].as_array().unwrap();
        assert_eq!(children.len(), 2);
        let position = |node: &serde_json::Value| (node["x"].as_f64(), node["y"].as_f64());
        assert_eq!(children[0]["id"], "label");
        assert_eq!(position(&children[0]), (Some(10.0), Some(40.0)));
        assert_eq!(children[1]["id"], "after");
        assert_eq!(position(&children[1]), (Some(11.0), Some(22.0)));
        assert_eq!(value["textMetrics"]["nodes"]["label"]["height"], 14.0);
    }

    #[test]
    fn svg_text_exports_the_same_source_box_metrics_as_the_web_importer() {
        let out = import_svg_to_x(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><text id="label" x="10" y="30" font-size="20" text-anchor="middle">Keep this text</text></svg>"##,
        );
        let value: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(value["textMetrics"]["version"], 2);
        let page = &value["doc"]["pages"][0];
        let text = &page["children"][0];
        let id = text["id"].as_str().unwrap();
        assert_eq!(id, "label");
        // The .x serializer omits `name` when it equals `id`; the web adapter
        // restores the effective name from the id, not from the TS importer.
        assert_eq!(text["name"].as_str().unwrap_or(id), "label");
        assert_eq!(text["h"], 20.0, "persisted native text h remains font size");
        assert_eq!(value["textMetrics"]["nodes"][id]["width"], 168.0);
        assert_eq!(value["textMetrics"]["nodes"][id]["height"], 28.0);
        assert_eq!(value["textMetrics"]["nodes"][id]["fontSize"], 20.0);
        assert!(value["textMetrics"]["nodes"][id]["fontWeight"].is_null());
        assert!(value.get("figmaCoordinates").is_none());
        assert!(value.get("figmaAppearance").is_none());
    }

    #[test]
    fn svg_numeric_weight_is_versioned_source_metadata_not_persisted_typography() {
        let out = import_svg_to_x(
            r#"<svg width="200" height="120"><text id="label" x="10" y="30" font-size="20" font-weight="700">Keep this text</text></svg>"#,
        );
        let value: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(value["textMetrics"]["version"], 2);
        assert_eq!(value["textMetrics"]["nodes"]["label"]["fontWeight"], 700);
        assert!(value["doc"]["pages"][0]["children"][0]
            .get("bindings")
            .is_none());
    }

    #[test]
    fn error_text_is_json_safe() {
        // A message containing a quote must not break the envelope.
        let out = envelope(Err("bad \"thing\" here".into()));
        assert!(out.contains("\\\"thing\\\""), "got: {out}");
    }

    #[test]
    fn all_control_characters_round_trip() {
        let message = "quote \" slash \\ tab \t cr \r nul \0 unicode λ";
        let value: serde_json::Value =
            serde_json::from_str(&envelope(Err(message.into()))).unwrap();
        assert_eq!(value["error"], message);
        assert_eq!(value["ok"], false);
    }

    #[test]
    fn file_imports_include_versioned_original_text_metrics() {
        for out in [
            import_fig_to_x(include_bytes!("../../../apps/web/e2e/fixtures/sample.fig")),
            import_sketch_to_x(include_bytes!(
                "../../../apps/web/e2e/fixtures/sample.sketch"
            )),
        ] {
            let value: serde_json::Value = serde_json::from_str(&out).unwrap();
            assert_eq!(value["ok"], true);
            assert_eq!(value["doc"]["version"], 1, "persisted .x schema unchanged");
            assert_eq!(value["textMetrics"]["version"], 1);
            let nodes = value["textMetrics"]["nodes"].as_object().unwrap();
            assert_eq!(nodes.len(), 1);
            let metrics = nodes.values().next().unwrap();
            assert_eq!(metrics["width"], 200.0);
            assert_eq!(metrics["height"], 24.0);
            assert_eq!(metrics["fontSize"], 18.0);
        }
    }

    #[test]
    fn fig_coordinates_are_versioned_import_only_metadata() {
        let out = import_fig_to_x(include_bytes!(
            "../../../apps/web/e2e/fixtures/coordinates.fig"
        ));
        let value: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(value["figmaCoordinates"]["version"], 1);
        assert_eq!(value["figmaAppearance"]["version"], 1);
        assert_eq!(value["figmaAppearance"]["images"], 0);
        assert!(value["doc"].get("figmaAppearance").is_none());
        let outer = &value["doc"]["pages"][1]["children"][0];
        let id = outer["id"].as_str().unwrap();
        assert_eq!(outer["x"], 40.0);
        assert_eq!(
            value["figmaCoordinates"]["nodes"][id],
            serde_json::json!({ "x": -120.0, "y": -80.0 })
        );
        assert!(
            value["doc"].get("figmaCoordinates").is_none(),
            "persisted .x unchanged"
        );
        let sketch: serde_json::Value = serde_json::from_str(&import_sketch_to_x(include_bytes!(
            "../../../apps/web/e2e/fixtures/sample.sketch"
        )))
        .unwrap();
        assert!(sketch.get("figmaAppearance").is_none());
        assert!(
            sketch.get("figmaCoordinates").is_none(),
            "do not apply FIG coordinate semantics to Sketch"
        );
    }

    #[test]
    fn fig_effect_metadata_is_versioned_and_not_persisted_or_shared_with_sketch() {
        let value: serde_json::Value = serde_json::from_str(&import_fig_to_x(include_bytes!(
            "../../../apps/web/e2e/fixtures/effect-source.fig"
        )))
        .unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(value["figmaEffects"]["version"], 1);
        assert!(value["doc"].get("figmaEffects").is_none());
        let id = value["doc"]["pages"][0]["children"][0]["id"]
            .as_str()
            .unwrap();
        let facts = &value["figmaEffects"]["nodes"][id];
        assert_eq!(facts.as_array().unwrap().len(), 4);
        assert_eq!(facts[0]["spread"], 7.0);
        assert_eq!(facts[0]["blend"], "MULTIPLY");
        assert_eq!(facts[0]["showBehind"], true);
        assert_eq!(facts[1]["visible"], false);
        assert_eq!(facts[2]["color"], "#000000");
        let sketch: serde_json::Value = serde_json::from_str(&import_sketch_to_x(include_bytes!(
            "../../../apps/web/e2e/fixtures/sample.sketch"
        )))
        .unwrap();
        assert!(sketch.get("figmaEffects").is_none());
    }

    #[test]
    fn poc_engine_accepts_a_typed_create_rectangle_command() {
        let command: Command = serde_json::from_value(serde_json::json!({
            "type": "createNode",
            "nodeType": "rect",
            "x": 100.0,
            "y": 100.0
        }))
        .unwrap();
        let mut engine = PocEngine::new();
        let initial = engine.snapshot();
        assert_eq!(initial.revision, 0);
        assert!(initial.nodes.is_empty());
        assert!(!initial.can_undo);

        let state = engine.dispatch_command(command).unwrap();
        assert_eq!(state.revision, 1);
        assert!(state.can_undo);
        assert_eq!(state.nodes.len(), 1);
        assert_eq!(state.nodes[0].id, "wasm-poc-rect-1");
        assert_eq!(state.nodes[0].name, "Rectangle 1");
        assert_eq!(state.nodes[0].kind, "rect");
        assert_eq!((state.nodes[0].x, state.nodes[0].y), (100.0, 100.0));
        assert_eq!((state.nodes[0].w, state.nodes[0].h), (100.0, 80.0));

        let value = serde_json::to_value(&state).unwrap();
        assert_eq!(value["canUndo"].as_bool(), Some(true));
        assert_eq!(value["nodes"][0]["kind"], "rect");
        assert_eq!(value["nodes"][0]["w"], 100.0);
    }

    #[test]
    fn poc_engine_creates_frame_and_moves_nodes() {
        let mut engine = PocEngine::new();
        let rect_cmd: Command = serde_json::from_value(serde_json::json!({
            "type": "createNode",
            "nodeType": "rect",
            "x": 40.0,
            "y": 50.0,
            "width": 160.0,
            "height": 90.0
        }))
        .unwrap();
        let state = engine.dispatch_command(rect_cmd).unwrap();
        assert_eq!(state.revision, 1);
        assert_eq!(state.nodes.len(), 1);
        assert_eq!(state.nodes[0].id, "wasm-poc-rect-1");
        assert_eq!(state.nodes[0].kind, "rect");
        assert_eq!((state.nodes[0].x, state.nodes[0].y), (40.0, 50.0));
        assert_eq!((state.nodes[0].w, state.nodes[0].h), (160.0, 90.0));

        let frame_cmd: Command = serde_json::from_value(serde_json::json!({
            "type": "createNode",
            "nodeType": "frame",
            "x": 200.0,
            "y": 120.0,
            "width": 320.0,
            "height": 240.0
        }))
        .unwrap();
        let state = engine.dispatch_command(frame_cmd).unwrap();
        assert_eq!(state.revision, 2);
        assert_eq!(state.nodes.len(), 2);
        assert_eq!(state.nodes[1].id, "wasm-poc-frame-2");
        assert_eq!(state.nodes[1].name, "Frame 2");
        assert_eq!(state.nodes[1].kind, "frame");
        assert_eq!((state.nodes[1].x, state.nodes[1].y), (200.0, 120.0));
        assert_eq!((state.nodes[1].w, state.nodes[1].h), (320.0, 240.0));

        let move_cmd: Command = serde_json::from_value(serde_json::json!({
            "type": "moveNode",
            "id": "wasm-poc-rect-1",
            "dx": 25.0,
            "dy": -15.0
        }))
        .unwrap();
        let state = engine.dispatch_command(move_cmd).unwrap();
        assert_eq!(state.revision, 3);
        assert!(state.can_undo);
        assert_eq!((state.nodes[0].x, state.nodes[0].y), (65.0, 35.0));
        assert_eq!((state.nodes[0].w, state.nodes[0].h), (160.0, 90.0));
    }

    #[test]
    fn poc_engine_rejects_unknown_types_and_non_finite_coordinates_without_mutating() {
        let mut engine = PocEngine::new();
        assert!(engine
            .dispatch_command(Command::CreateNode {
                node_type: "polygon".into(),
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 80.0,
                parent_id: None,
                text: None,
            })
            .is_err());
        assert!(engine
            .dispatch_command(Command::CreateNode {
                node_type: "rect".into(),
                x: f64::NAN,
                y: 0.0,
                width: 100.0,
                height: 80.0,
                parent_id: None,
                text: None,
            })
            .is_err());
        assert!(engine
            .dispatch_command(Command::CreateNode {
                node_type: "frame".into(),
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 80.0,
                parent_id: None,
                text: None,
            })
            .is_err());
        assert!(engine
            .dispatch_command(Command::MoveNode {
                id: "missing".into(),
                dx: 10.0,
                dy: 10.0,
                parent_id: None,
            })
            .is_err());
        assert!(engine
            .dispatch_command(Command::ResizeNode {
                id: "wasm-poc-rect-1".into(),
                x: Some(10.0),
                y: Some(10.0),
                width: f64::NAN,
                height: 50.0,
            })
            .is_err());
        assert!(engine
            .dispatch_command(Command::ResizeNode {
                id: "wasm-poc-rect-1".into(),
                x: Some(10.0),
                y: Some(10.0),
                width: 0.0,
                height: 50.0,
            })
            .is_err());
        assert!(engine
            .dispatch_command(Command::DeleteNode {
                id: "wasm-poc-page".into(),
            })
            .is_err());
        assert_eq!(engine.snapshot().revision, 0);
        assert!(engine.snapshot().nodes.is_empty());
    }

    #[test]
    fn poc_engine_supports_hierarchical_parent_resize_delete_undo_and_redo() {
        let mut engine = PocEngine::new();

        // Empty history undo/redo is a safe no-op.
        let empty_undo = engine.dispatch_command(Command::Undo).unwrap();
        assert_eq!(empty_undo.revision, 0);
        assert!(empty_undo.nodes.is_empty());
        let empty_redo = engine.dispatch_command(Command::Redo).unwrap();
        assert_eq!(empty_redo.revision, 0);
        assert!(empty_redo.nodes.is_empty());

        // Create a Frame, then create a Rectangle inside the Frame.
        let state = engine
            .dispatch_command(Command::CreateNode {
                node_type: "frame".into(),
                x: 100.0,
                y: 120.0,
                width: 400.0,
                height: 300.0,
                parent_id: None,
                text: None,
            })
            .unwrap();
        assert_eq!(state.nodes.len(), 1);
        assert_eq!(state.nodes[0].id, "wasm-poc-frame-1");
        assert_eq!(state.nodes[0].parent_id, None);
        assert_eq!(state.nodes[0].rotation, 0.0);
        assert_eq!(state.nodes[0].opacity, 1.0);
        assert_eq!(state.nodes[0].fill, None);

        let state = engine
            .dispatch_command(Command::CreateNode {
                node_type: "rect".into(),
                x: 24.0,
                y: 36.0,
                width: 120.0,
                height: 80.0,
                parent_id: Some("wasm-poc-frame-1".into()),
                text: None,
            })
            .unwrap();
        assert_eq!(state.revision, 2);
        assert_eq!(state.nodes.len(), 2);
        assert_eq!(state.nodes[1].id, "wasm-poc-rect-2");
        assert_eq!(
            state.nodes[1].parent_id,
            Some("wasm-poc-frame-1".to_string())
        );
        assert_eq!(state.nodes[1].rotation, 0.0);
        assert_eq!(state.nodes[1].opacity, 1.0);
        assert_eq!(state.nodes[1].fill, Some("#000000".to_string()));

        // Resize the child rectangle (updating both origin and dimensions in one undo step).
        let state = engine
            .dispatch_command(Command::ResizeNode {
                id: "wasm-poc-rect-2".into(),
                x: Some(30.0),
                y: Some(40.0),
                width: 180.0,
                height: 110.0,
            })
            .unwrap();
        assert_eq!(state.revision, 3);
        assert_eq!((state.nodes[1].x, state.nodes[1].y), (30.0, 40.0));
        assert_eq!((state.nodes[1].w, state.nodes[1].h), (180.0, 110.0));

        // Undo the resize in a single step.
        let state = engine.dispatch_command(Command::Undo).unwrap();
        assert_eq!(state.revision, 4);
        assert_eq!((state.nodes[1].x, state.nodes[1].y), (24.0, 36.0));
        assert_eq!((state.nodes[1].w, state.nodes[1].h), (120.0, 80.0));

        // Redo the resize.
        let state = engine.dispatch_command(Command::Redo).unwrap();
        assert_eq!(state.revision, 5);
        assert_eq!((state.nodes[1].x, state.nodes[1].y), (30.0, 40.0));
        assert_eq!((state.nodes[1].w, state.nodes[1].h), (180.0, 110.0));

        // Delete the child rectangle.
        let state = engine
            .dispatch_command(Command::DeleteNode {
                id: "wasm-poc-rect-2".into(),
            })
            .unwrap();
        assert_eq!(state.revision, 6);
        assert_eq!(state.nodes.len(), 1);
        assert_eq!(state.nodes[0].id, "wasm-poc-frame-1");

        // Undo the deletion: the rectangle is restored inside the frame.
        let state = engine.dispatch_command(Command::Undo).unwrap();
        assert_eq!(state.revision, 7);
        assert_eq!(state.nodes.len(), 2);
        assert_eq!(state.nodes[1].id, "wasm-poc-rect-2");
        assert_eq!(
            state.nodes[1].parent_id,
            Some("wasm-poc-frame-1".to_string())
        );

        // Redo the deletion: the rectangle is removed again.
        let state = engine.dispatch_command(Command::Redo).unwrap();
        assert_eq!(state.revision, 8);
        assert_eq!(state.nodes.len(), 1);
    }

    #[test]
    fn poc_engine_creates_text_and_ellipse_nodes_and_round_trips_text() {
        let mut engine = PocEngine::new();
        let text_state = engine
            .dispatch_command(Command::CreateNode {
                node_type: "text".into(),
                x: 40.0,
                y: 60.0,
                width: 140.0,
                height: 24.0,
                parent_id: None,
                text: Some("Hello WASM".into()),
            })
            .unwrap();
        assert_eq!(text_state.revision, 1);
        assert_eq!(text_state.nodes.len(), 1);
        assert_eq!(text_state.nodes[0].id, "wasm-poc-text-1");
        assert_eq!(text_state.nodes[0].kind, "text");
        assert_eq!(text_state.nodes[0].text, Some("Hello WASM".to_string()));

        let ellipse_state = engine
            .dispatch_command(Command::CreateNode {
                node_type: "ellipse".into(),
                x: 200.0,
                y: 80.0,
                width: 96.0,
                height: 96.0,
                parent_id: None,
                text: None,
            })
            .unwrap();
        assert_eq!(ellipse_state.revision, 2);
        assert_eq!(ellipse_state.nodes.len(), 2);
        assert_eq!(ellipse_state.nodes[1].id, "wasm-poc-ellipse-2");
        assert_eq!(ellipse_state.nodes[1].kind, "ellipse");
        assert_eq!(ellipse_state.nodes[1].fill, Some("#000000".to_string()));

        let tree = build_render_tree_from_state(&ellipse_state).unwrap();
        assert!(
            tree.commands.len() >= 2,
            "expected x-render commands for text and ellipse nodes"
        );
    }

    #[test]
    fn render_tree_and_frame_cache_lower_nodes_and_skip_unchanged_revisions() {
        let mut engine = PocEngine::new();
        let _state = engine
            .dispatch_command(Command::CreateNode {
                node_type: "rect".into(),
                x: 20.0,
                y: 30.0,
                width: 120.0,
                height: 80.0,
                parent_id: None,
                text: None,
            })
            .unwrap();
        let state = engine
            .dispatch_command(Command::CreateNode {
                node_type: "frame".into(),
                x: 200.0,
                y: 60.0,
                width: 300.0,
                height: 200.0,
                parent_id: None,
                text: None,
            })
            .unwrap();

        let mut cache = RenderFrameCache::new();
        let (tree, skipped) = cache
            .prepare("x-native-canvas", &state, 2400, 1600, 2.0)
            .unwrap();
        assert!(!skipped);
        assert!(
            tree.commands.len() >= 2,
            "expected x-render commands for rect and frame"
        );

        let (_tree, skipped_again) = cache
            .prepare("x-native-canvas", &state, 2400, 1600, 2.0)
            .unwrap();
        assert!(skipped_again, "unchanged revision and viewport must skip");

        let (_tree, skipped_after_dpr_change) = cache
            .prepare("x-native-canvas", &state, 3600, 2400, 3.0)
            .unwrap();
        assert!(
            !skipped_after_dpr_change,
            "DPR or viewport resize must trigger a redraw"
        );
    }

    #[test]
    fn poc_engine_boolean_operations_preserve_exact_bezier_curves_and_support_atomic_undo_redo() {
        for op in ["union", "subtract", "intersect", "exclude"] {
            let mut engine = PocEngine::new();
            engine
                .dispatch_command(Command::CreateNode {
                    node_type: "ellipse".into(),
                    x: 40.0,
                    y: 40.0,
                    width: 120.0,
                    height: 120.0,
                    parent_id: None,
                    text: None,
                })
                .unwrap();
            engine
                .dispatch_command(Command::CreateNode {
                    node_type: "ellipse".into(),
                    x: 100.0,
                    y: 40.0,
                    width: 120.0,
                    height: 120.0,
                    parent_id: None,
                    text: None,
                })
                .unwrap();

            let bool_cmd: Command = serde_json::from_value(serde_json::json!({
                "type": "booleanOperation",
                "targetIds": ["wasm-poc-ellipse-1", "wasm-poc-ellipse-2"],
                "operation": op,
            }))
            .unwrap();
            let state = engine.dispatch_command(bool_cmd).unwrap();
            assert_eq!(state.revision, 3);
            assert_eq!(state.nodes.len(), 1);
            let node = &state.nodes[0];
            assert_eq!(node.id, "wasm-poc-bool-3");
            assert_eq!(node.kind, "boolean");
            assert_eq!(node.boolean_op.as_deref(), Some(op));
            let cmds = node
                .path_commands
                .as_ref()
                .expect("boolean result must include pathCommands");
            let curve_count = cmds
                .iter()
                .filter(|c| matches!(c, WasmPathCmd::CurveTo { .. }))
                .count();
            assert!(
                curve_count >= 4,
                "expected exact cubic bezier CurveTo segments for {op}, got {curve_count}"
            );

            let tree = build_render_tree_from_state(&state).unwrap();
            assert!(
                !tree.commands.is_empty(),
                "boolean result must lower into x-render commands"
            );

            // Single atomic undo restores both original ellipses.
            let undone = engine.dispatch_command(Command::Undo).unwrap();
            assert_eq!(undone.revision, 4);
            assert_eq!(undone.nodes.len(), 2);
            assert_eq!(undone.nodes[0].id, "wasm-poc-ellipse-1");
            assert_eq!(undone.nodes[1].id, "wasm-poc-ellipse-2");

            // Single atomic redo re-applies the boolean node.
            let redone = engine.dispatch_command(Command::Redo).unwrap();
            assert_eq!(redone.revision, 5);
            assert_eq!(redone.nodes.len(), 1);
            assert_eq!(redone.nodes[0].id, "wasm-poc-bool-3");
        }
    }

    #[test]
    fn poc_engine_apply_auto_layout_positions_children_hugs_frame_and_reflows_on_child_resize() {
        let mut engine = PocEngine::new();
        engine
            .dispatch_command(Command::CreateNode {
                node_type: "frame".into(),
                x: 50.0,
                y: 60.0,
                width: 400.0,
                height: 300.0,
                parent_id: None,
                text: None,
            })
            .unwrap();
        engine
            .dispatch_command(Command::CreateNode {
                node_type: "rect".into(),
                x: 10.0,
                y: 10.0,
                width: 100.0,
                height: 50.0,
                parent_id: Some("wasm-poc-frame-1".into()),
                text: None,
            })
            .unwrap();
        engine
            .dispatch_command(Command::CreateNode {
                node_type: "rect".into(),
                x: 150.0,
                y: 20.0,
                width: 80.0,
                height: 60.0,
                parent_id: Some("wasm-poc-frame-1".into()),
                text: None,
            })
            .unwrap();

        let layout_cmd: Command = serde_json::from_value(serde_json::json!({
            "type": "applyAutoLayout",
            "frameId": "wasm-poc-frame-1",
            "axis": "horizontal",
            "padding": 16.0,
            "gap": 12.0,
        }))
        .unwrap();
        let state = engine.dispatch_command(layout_cmd).unwrap();
        assert_eq!(state.revision, 4);
        assert_eq!(state.nodes.len(), 3);
        assert_eq!(
            state.nodes[0].auto_layout,
            Some(WasmAutoLayout {
                axis: "horizontal".into(),
                padding: 16.0,
                gap: 12.0,
            })
        );
        // Frame hugs children: width = 16 + 100 + 12 + 80 + 16 = 224, height = 16 + 60 + 16 = 92
        assert_eq!((state.nodes[0].w, state.nodes[0].h), (224.0, 92.0));
        assert_eq!((state.nodes[1].x, state.nodes[1].y), (16.0, 16.0));
        assert_eq!((state.nodes[2].x, state.nodes[2].y), (128.0, 16.0));

        // Resizing the first child automatically reflows the auto-layout frame in one atomic step.
        let resized = engine
            .dispatch_command(Command::ResizeNode {
                id: "wasm-poc-rect-2".into(),
                x: None,
                y: None,
                width: 140.0,
                height: 50.0,
            })
            .unwrap();
        assert_eq!(resized.revision, 5);
        assert_eq!((resized.nodes[0].w, resized.nodes[0].h), (264.0, 92.0));
        assert_eq!((resized.nodes[2].x, resized.nodes[2].y), (168.0, 16.0));

        // Undo reverts both the child resize and the parent frame reflow at once.
        let after_resize_undo = engine.dispatch_command(Command::Undo).unwrap();
        assert_eq!(after_resize_undo.revision, 6);
        assert_eq!(
            (after_resize_undo.nodes[0].w, after_resize_undo.nodes[0].h),
            (224.0, 92.0)
        );
        assert_eq!(
            (after_resize_undo.nodes[2].x, after_resize_undo.nodes[2].y),
            (128.0, 16.0)
        );

        // Undo again reverts ApplyAutoLayout itself.
        let after_layout_undo = engine.dispatch_command(Command::Undo).unwrap();
        assert_eq!(after_layout_undo.revision, 7);
        assert_eq!(after_layout_undo.nodes[0].auto_layout, None);
        assert_eq!(
            (after_layout_undo.nodes[0].w, after_layout_undo.nodes[0].h),
            (400.0, 300.0)
        );
    }

    #[test]
    fn poc_engine_update_outline_offset_and_duplicate_support_atomic_undo_redo() {
        let mut engine = PocEngine::new();
        engine
            .dispatch_command(Command::CreateNode {
                node_type: "rect".into(),
                x: 40.0,
                y: 50.0,
                width: 100.0,
                height: 80.0,
                parent_id: None,
                text: None,
            })
            .unwrap();

        // 1. UpdateNode: name, fill, stroke, strokeWidth, opacity, rotation, radius
        let updated = engine
            .dispatch_command(Command::UpdateNode {
                id: "wasm-poc-rect-1".into(),
                name: Some("Card".into()),
                fill: Some("#2563eb".into()),
                stroke: Some("#111827".into()),
                stroke_width: Some(8.0),
                opacity: Some(0.85),
                rotation: Some(15.0),
                radius: Some(12.0),
                text: None,
                fill_variable: None,
            })
            .unwrap();
        assert_eq!(updated.revision, 2);
        let snap = &updated.nodes[0];
        assert_eq!(snap.name, "Card");
        assert_eq!(snap.fill.as_deref(), Some("#2563eb"));
        assert_eq!(snap.stroke.as_deref(), Some("#111827"));
        assert_eq!(snap.stroke_width, Some(8.0));
        assert!((snap.opacity - 0.85).abs() < 1e-5);
        assert!((snap.rotation - 15.0).abs() < 1e-5);
        assert_eq!(snap.radius, Some(12.0));

        // 2. DuplicateNode: clones with offset and fresh ID
        let duplicated = engine
            .dispatch_command(Command::DuplicateNode {
                id: "wasm-poc-rect-1".into(),
                dx: Some(24.0),
                dy: Some(18.0),
            })
            .unwrap();
        assert_eq!(duplicated.revision, 3);
        assert_eq!(duplicated.nodes.len(), 2);
        assert_eq!(duplicated.nodes[1].id, "wasm-poc-rect-2");
        assert_eq!(duplicated.nodes[1].name, "Card copy");
        assert_eq!((duplicated.nodes[1].x, duplicated.nodes[1].y), (64.0, 68.0));

        // 3. OutlineStroke on the stroked duplicate
        let outlined = engine
            .dispatch_command(Command::OutlineStroke {
                id: "wasm-poc-rect-2".into(),
            })
            .unwrap();
        assert_eq!(outlined.revision, 4);
        assert_eq!(outlined.nodes[1].kind, "path");
        assert_eq!(outlined.nodes[1].fill.as_deref(), Some("#111827"));
        assert_eq!(outlined.nodes[1].stroke, None);
        assert!(outlined.nodes[1]
            .path_commands
            .as_ref()
            .is_some_and(|cmds| cmds.len() >= 4));

        // 4. OffsetPath on the original rectangle
        let offset = engine
            .dispatch_command(Command::OffsetPath {
                id: "wasm-poc-rect-1".into(),
                distance: 10.0,
                join: Some("miter".into()),
            })
            .unwrap();
        assert_eq!(offset.revision, 5);
        assert_eq!(offset.nodes[0].kind, "path");
        assert!(offset.nodes[0].w > 100.0);
        assert!(offset.nodes[0].h > 80.0);

        // Undo OffsetPath restores the rectangle
        let undo_offset = engine.dispatch_command(Command::Undo).unwrap();
        assert_eq!(undo_offset.nodes[0].kind, "rect");
        assert_eq!(
            (undo_offset.nodes[0].w, undo_offset.nodes[0].h),
            (100.0, 80.0)
        );

        // Undo OutlineStroke restores the stroked duplicate rectangle
        let undo_outline = engine.dispatch_command(Command::Undo).unwrap();
        assert_eq!(undo_outline.nodes[1].kind, "rect");
        assert_eq!(undo_outline.nodes[1].stroke.as_deref(), Some("#111827"));
        assert_eq!(undo_outline.nodes[1].stroke_width, Some(8.0));

        // Undo DuplicateNode removes the duplicate
        let undo_dup = engine.dispatch_command(Command::Undo).unwrap();
        assert_eq!(undo_dup.nodes.len(), 1);
    }

    #[test]
    fn poc_engine_variables_and_component_properties_support_atomic_undo_redo() {
        let mut engine = PocEngine::new();
        // Create a frame representing a component instance and a child icon rect
        engine
            .dispatch_command(Command::CreateNode {
                node_type: "frame".into(),
                x: 40.0,
                y: 40.0,
                width: 200.0,
                height: 80.0,
                parent_id: None,
                text: None,
            })
            .unwrap();
        engine
            .dispatch_command(Command::CreateNode {
                node_type: "rect".into(),
                x: 12.0,
                y: 12.0,
                width: 24.0,
                height: 24.0,
                parent_id: Some("wasm-poc-frame-1".into()),
                text: None,
            })
            .unwrap();

        // Bind wasm-poc-rect-2 to variable "var-1" (default #0d99ff)
        let bound = engine
            .dispatch_command(Command::UpdateNode {
                id: "wasm-poc-rect-2".into(),
                name: Some("Icon".into()),
                fill: Some("#0d99ff".into()),
                stroke: None,
                stroke_width: None,
                opacity: None,
                rotation: None,
                radius: None,
                text: None,
                fill_variable: Some("var-1".into()),
            })
            .unwrap();
        assert_eq!(bound.nodes[1].fill.as_deref(), Some("#0d99ff"));

        // Update variable "var-1" to "#ef4444"
        let var_updated = engine
            .dispatch_command(Command::UpdateVariable {
                id: "var-1".into(),
                value: "#ef4444".into(),
            })
            .unwrap();
        assert_eq!(var_updated.revision, 4);
        assert_eq!(var_updated.nodes[1].fill.as_deref(), Some("#ef4444"));
        assert_eq!(
            var_updated
                .variables
                .as_ref()
                .and_then(|m| m.get("var-1"))
                .map(String::as_str),
            Some("#ef4444")
        );

        // Switch collection mode to "mode-dark" and set mode-scoped value "#10b981"
        let mode_switched = engine
            .dispatch_command(Command::SetVariableMode {
                collection_id: "col-brand".into(),
                mode_id: "mode-dark".into(),
            })
            .unwrap();
        assert_eq!(mode_switched.revision, 5);
        assert_eq!(
            mode_switched
                .active_modes
                .as_ref()
                .and_then(|m| m.get("col-brand"))
                .map(String::as_str),
            Some("mode-dark")
        );

        let dark_val = engine
            .dispatch_command(Command::UpdateVariable {
                id: "var-1".into(),
                value: "#10b981".into(),
            })
            .unwrap();
        assert_eq!(dark_val.nodes[1].fill.as_deref(), Some("#10b981"));

        // Toggle boolean component property "Has Icon" on wasm-poc-frame-1 to "false"
        let prop_toggled = engine
            .dispatch_command(Command::UpdateComponentProperty {
                instance_id: "wasm-poc-frame-1".into(),
                property_name: "Has Icon".into(),
                value: "false".into(),
            })
            .unwrap();
        assert_eq!(prop_toggled.revision, 7);
        assert_eq!(prop_toggled.nodes[1].visible, Some(false));
        assert_eq!(
            prop_toggled.nodes[0]
                .component_properties
                .as_ref()
                .and_then(|m| m.get("Has Icon"))
                .map(String::as_str),
            Some("false")
        );

        // Undo component property toggle restores child visibility
        let undo_prop = engine.dispatch_command(Command::Undo).unwrap();
        assert_eq!(undo_prop.nodes[1].visible, None);

        // Undo dark mode variable update restores "#ef4444"
        let undo_dark_val = engine.dispatch_command(Command::Undo).unwrap();
        assert_eq!(undo_dark_val.nodes[1].fill.as_deref(), Some("#ef4444"));

        // Undo mode switch restores default mode
        let undo_mode = engine.dispatch_command(Command::Undo).unwrap();
        assert!(undo_mode
            .active_modes
            .as_ref()
            .is_none_or(|m| !m.contains_key("col-brand")));

        // Undo base variable update restores "#0d99ff"
        let undo_var = engine.dispatch_command(Command::Undo).unwrap();
        assert_eq!(undo_var.nodes[1].fill.as_deref(), Some("#0d99ff"));
    }

    #[test]
    fn the_version_names_the_rust_engine() {
        assert!(engine_version().contains("rust"));
    }
}
