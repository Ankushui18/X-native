//! Thin serialization edge for the shared x-editor::DocumentSession.
//! Commands and undo live in Rust; only one changed node is encoded here.

use serde_json::{json, Value};
use x_core::booleans::BoolOp;
use x_core::{parse_hex_color, PathCmd, StrokeAlign, StrokeCap, StrokeJoin};
use x_editor::{
    DocumentSession, GeometryNodeDelta, NodeDelta, OffsetDelta, OffsetShapeDelta, OutlineDelta,
    OutlineShapeDelta, OutlineStrokeStyle, SessionCommand, SessionDelta,
};
use x_format::{deserialize::load_x, serialize::save_x};

fn node_value(node: NodeDelta) -> Value {
    json!({ "id": node.id, "name": node.name, "x": node.x, "y": node.y, "w": node.w, "h": node.h })
}

fn geometry_value(change: GeometryNodeDelta) -> Value {
    let mut value = node_value(change.node);
    value["index"] = json!(change.index);
    value["kind"] = json!(if change.rings.is_some() {
        "vector"
    } else {
        "rect"
    });
    value["fill"] = json!(change.fill);
    value["visible"] = json!(change.visible);
    value["locked"] = json!(change.locked);
    if let Some(rings) = change.rings {
        value["rings"] = json!(rings);
    }
    value
}

fn offset_value(change: OffsetDelta) -> Value {
    let mut value = node_value(change.node);
    match change.shape {
        OffsetShapeDelta::Rect { radius } => {
            value["kind"] = json!("rect");
            value["radius"] = json!(radius);
        }
        OffsetShapeDelta::Ellipse => value["kind"] = json!("ellipse"),
        OffsetShapeDelta::Poly { sides } => {
            value["kind"] = json!("poly");
            value["count"] = json!(sides);
        }
        OffsetShapeDelta::Star { points, ratio } => {
            value["kind"] = json!("star");
            value["count"] = json!(points);
            value["ratio"] = json!(ratio);
        }
        OffsetShapeDelta::Vector { path } => {
            value["kind"] = json!("vector");
            value["path"] = json!(path
                .into_iter()
                .map(|cmd| match cmd {
                    PathCmd::MoveTo(x, y) => json!(["M", x, y]),
                    PathCmd::LineTo(x, y) => json!(["L", x, y]),
                    PathCmd::CurveTo(a, b, c, d, x, y) => json!(["C", a, b, c, d, x, y]),
                    PathCmd::Close => json!(["Z"]),
                })
                .collect::<Vec<_>>());
        }
    }
    value
}

fn outline_path_value(path: Vec<PathCmd>) -> Value {
    json!(path
        .into_iter()
        .map(|cmd| match cmd {
            PathCmd::MoveTo(x, y) => json!(["M", x, y]),
            PathCmd::LineTo(x, y) => json!(["L", x, y]),
            PathCmd::CurveTo(a, b, c, d, x, y) => json!(["C", a, b, c, d, x, y]),
            PathCmd::Close => json!(["Z"]),
        })
        .collect::<Vec<_>>())
}

fn outline_cap_name(cap: StrokeCap) -> &'static str {
    match cap {
        StrokeCap::None => "none",
        StrokeCap::Round => "round",
        StrokeCap::Square => "square",
        StrokeCap::Arrow => "arrow",
        StrokeCap::Triangle => "triangle",
    }
}

fn outline_stroke_value(style: OutlineStrokeStyle) -> Value {
    json!({
        "width": style.width,
        "color": style.color,
        "align": match style.align {
            StrokeAlign::Inside => "inside",
            StrokeAlign::Center => "center",
            StrokeAlign::Outside => "outside",
        },
        "capStart": outline_cap_name(style.cap_start),
        "capEnd": outline_cap_name(style.cap_end),
        "join": match style.join {
            StrokeJoin::Miter => "miter",
            StrokeJoin::Bevel => "bevel",
            StrokeJoin::Round => "round",
        },
        "dash": style.dash,
        "dashOffset": style.dash_offset,
        "miterLimit": style.miter_limit,
        "widthProfile": style.width_profile.into_iter().map(|point| json!({
            "position": point.position,
            "widthMultiplier": point.width_multiplier,
        })).collect::<Vec<_>>(),
    })
}

fn outline_value(change: OutlineDelta) -> Value {
    let mut value = node_value(change.node);
    match change.shape {
        OutlineShapeDelta::Rect { radius } => {
            value["kind"] = json!("rect");
            value["radius"] = json!(radius);
        }
        OutlineShapeDelta::Ellipse => value["kind"] = json!("ellipse"),
        OutlineShapeDelta::Line => value["kind"] = json!("line"),
        OutlineShapeDelta::Arc { start, end, ratio } => {
            value["kind"] = json!("arc");
            value["start"] = json!(start);
            value["end"] = json!(end);
            value["ratio"] = json!(ratio);
        }
        OutlineShapeDelta::Poly { sides } => {
            value["kind"] = json!("poly");
            value["count"] = json!(sides);
        }
        OutlineShapeDelta::Star { points, ratio } => {
            value["kind"] = json!("star");
            value["count"] = json!(points);
            value["ratio"] = json!(ratio);
        }
        OutlineShapeDelta::Vector { path } => {
            value["kind"] = json!("vector");
            value["path"] = outline_path_value(path);
        }
    }
    value["fill"] = json!(change.fill);
    value["stroke"] = change
        .stroke
        .map(outline_stroke_value)
        .unwrap_or(Value::Null);
    value
}

fn offset_join(join: &str) -> Result<StrokeJoin, String> {
    match join {
        "miter" => Ok(StrokeJoin::Miter),
        "bevel" => Ok(StrokeJoin::Bevel),
        "round" => Ok(StrokeJoin::Round),
        _ => Err("unknown offset join".into()),
    }
}

fn delta_json(delta: SessionDelta) -> String {
    let node = delta.node.map(node_value);
    let mut value = json!({
        "revision": delta.revision,
        "node": node,
        "canUndo": delta.can_undo,
        "canRedo": delta.can_redo,
    });
    if let Some(boolean) = delta.boolean {
        value["boolean"] = json!({
            "upsert": boolean.upsert.into_iter().map(geometry_value).collect::<Vec<_>>(),
            "removed": boolean.removed,
        });
    }
    if let Some(stroke) = delta.stroke {
        value["stroke"] = json!({
            "id": stroke.id,
            "width": stroke.width,
            "color": stroke.color,
            "align": match stroke.align {
                StrokeAlign::Inside => "inside", StrokeAlign::Center => "center", StrokeAlign::Outside => "outside"
            },
            "join": match stroke.join {
                StrokeJoin::Miter => "miter", StrokeJoin::Bevel => "bevel", StrokeJoin::Round => "round"
            },
            "outer": stroke.outer,
            "inner": stroke.inner,
        });
    }
    if let Some(offset) = delta.offset {
        value["offset"] = offset_value(offset);
    }
    if let Some(outline) = delta.outline {
        value["outline"] = outline_value(outline);
    }
    value.to_string()
}

/// Host-testable half of the WASM class. Native callers instead use the
/// typed DocumentSession directly (re-exported by x-native::editor).
pub struct CommandBridge {
    session: DocumentSession,
}

impl CommandBridge {
    pub fn open(x: &str) -> Result<Self, String> {
        let doc = load_x(x)?;
        Ok(Self {
            session: DocumentSession::new(doc)?,
        })
    }

    pub fn state(&self) -> String {
        delta_json(self.session.state())
    }

    pub fn get_node(&self, id: &str) -> String {
        self.session
            .node(id)
            .map(node_value)
            .unwrap_or(Value::Null)
            .to_string()
    }

    pub fn get_shape(&self, id: &str) -> Result<String, String> {
        self.session
            .offset_shape(id)
            .map(|node| offset_value(node).to_string())
    }

    pub fn rename_node(&mut self, id: &str, name: &str) -> Result<String, String> {
        self.dispatch(SessionCommand::Rename { id, name })
    }

    pub fn move_node(&mut self, id: &str, dx: f64, dy: f64) -> Result<String, String> {
        self.dispatch(SessionCommand::Move { id, dx, dy })
    }

    pub fn resize_node(&mut self, id: &str, w: f64, h: f64) -> Result<String, String> {
        self.dispatch(SessionCommand::Resize { id, w, h })
    }

    pub fn boolean_node(
        &mut self,
        first: &str,
        second: &str,
        name: &str,
    ) -> Result<String, String> {
        let op = match name {
            "union" => BoolOp::Union,
            "subtract" => BoolOp::Subtract,
            "intersect" => BoolOp::Intersect,
            "exclude" => BoolOp::Exclude,
            _ => return Err("unknown Boolean operation".into()),
        };
        self.dispatch(SessionCommand::Boolean { first, second, op })
    }

    pub fn stroke_node(
        &mut self,
        id: &str,
        width: f64,
        hex: &str,
        alignment: &str,
        join: &str,
    ) -> Result<String, String> {
        if hex.len() != 7
            || !hex.starts_with('#')
            || !hex[1..].bytes().all(|v| v.is_ascii_hexdigit())
        {
            return Err("stroke color must be opaque #rrggbb".into());
        }
        let color = parse_hex_color(hex).ok_or("invalid stroke color")?;
        let align = match alignment {
            "inside" => StrokeAlign::Inside,
            "center" => StrokeAlign::Center,
            "outside" => StrokeAlign::Outside,
            _ => return Err("unknown stroke alignment".into()),
        };
        let join = match join {
            "miter" => StrokeJoin::Miter,
            "bevel" => StrokeJoin::Bevel,
            _ => return Err("stroke join not proven".into()),
        };
        self.dispatch(SessionCommand::Stroke {
            id,
            width,
            color,
            align,
            join,
        })
    }

    /// Geometry only; this bounded preview changes no native history.
    pub fn preview_offset(&self, id: &str, distance: f64, join: &str) -> Result<String, String> {
        let shape = self
            .session
            .preview_offset(id, distance, offset_join(join)?)?;
        Ok(shape.map(offset_value).unwrap_or(Value::Null).to_string())
    }

    /// One signed offset edit. A join is an existing native StrokeJoin;
    /// it is not approximated in the web host. A missing/unknown join fails.
    pub fn offset_node(&mut self, id: &str, distance: f64, join: &str) -> Result<String, String> {
        self.dispatch(SessionCommand::Offset {
            id,
            distance,
            join: offset_join(join)?,
        })
    }

    /// Convert one admitted live stroke to an editable filled vector. Stroke
    /// profile/dash/cap/join data is already persisted in Rust; the caller only
    /// names the layer and receives a bounded reversible projection.
    pub fn outline_stroke(&mut self, id: &str) -> Result<String, String> {
        self.dispatch(SessionCommand::OutlineStroke { id })
    }

    pub fn undo(&mut self) -> Result<String, String> {
        self.dispatch(SessionCommand::Undo)
    }

    pub fn redo(&mut self) -> Result<String, String> {
        self.dispatch(SessionCommand::Redo)
    }

    fn dispatch(&mut self, command: SessionCommand<'_>) -> Result<String, String> {
        self.session.dispatch(command).map(delta_json)
    }

    /// Explicit export only. It is not used to acknowledge commands or paint.
    pub fn export_x(&self) -> String {
        save_x(&self.session.snapshot())
    }

    /// Phase 9: Raster/PDF export of a single node through the Rust render
    /// pipeline. Returns a JSON envelope `{ "ok": true, "bytes": "<base64>",
    /// "width": N, "height": N, "format": "png"|"jpg"|"pdf" }`. PNG and JPG
    /// use `x_render::export_raster` (tiny-skia, deterministic, no GPU);
    /// PDF uses `x_render::export_pdf`. The TS caller decodes the base64
    /// into a downloadable Blob — never the lossy canvas.toDataURL path.
    pub fn export_node(&self, id: &str, format: &str, scale: f64) -> Result<String, String> {
        use base64::Engine;
        use x_render::{
            build_render_tree, export_pdf, export_raster, encode_png, encode_jpg,
            RasterFormat,
        };
        if !scale.is_finite() || scale <= 0.0 || scale > 64.0 {
            return Err("export scale must be a finite number between 0 and 64".into());
        }
        let snapshot = self.session.snapshot();
        // Find the node anywhere in the document
        let node = snapshot
            .pages
            .iter()
            .find_map(|page| find_node(page, id))
            .ok_or_else(|| format!("node '{id}' not found"))?;
        let (w, h) = (node.w.max(1.0), node.h.max(1.0));
        let tree = build_render_tree(node, &x_core::Variables::default());
        match format {
            "png" => {
                let (bytes, pw, ph) = export_raster(
                    &tree, w, h, RasterFormat::Png, scale, None, None, None,
                )?;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                Ok(format!(
                    r#"{{"ok":true,"bytes":"{b64}","width":{pw},"height":{ph},"format":"png"}}"#
                ))
            }
            "jpg" | "jpeg" => {
                let quality = 92u8; // high quality default
                let (bytes, pw, ph) = export_raster(
                    &tree, w, h, RasterFormat::Jpg(quality), scale,
                    Some(x_core::Color::WHITE), None, None,
                )?;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                Ok(format!(
                    r#"{{"ok":true,"bytes":"{b64}","width":{pw},"height":{ph},"format":"jpg"}}"#
                ))
            }
            "pdf" => {
                let bytes = export_pdf(&tree, w, h);
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                Ok(format!(
                    r#"{{"ok":true,"bytes":"{b64}","width":{},"height":{},"format":"pdf"}}"#,
                    w as u32, h as u32
                ))
            }
            _ => Err(format!("unsupported export format: {format}")),
        }
    }

    /// Phase 9: Add a point to an existing vector path segment. The point is
    /// inserted at the midpoint of the segment ending at `anchor_idx` (the
    /// segment_hit result from the UI). ONE undoable command.
    pub fn vector_add_point(
        &mut self,
        id: &str,
        segment_idx: usize,
        x: f64,
        y: f64,
    ) -> Result<String, String> {
        self.session
            .editor_mut()
            .add_vector_point_on(id, segment_idx, (x, y))
            .map(|_| delta_json(self.session.state()))
            .ok_or_else(|| "could not add point: invalid node or segment".into())
    }

    /// Phase 9: Convert a corner point to smooth (or vice versa). Toggles a
    /// LineTo ↔ CurveTo at the given anchor index. ONE undoable command.
    pub fn vector_convert_point(
        &mut self,
        id: &str,
        anchor_idx: usize,
    ) -> Result<String, String> {
        self.session
            .editor_mut()
            .convert_anchor(id, anchor_idx)
            .then(|| delta_json(self.session.state()))
            .ok_or_else(|| "could not convert point: invalid node or anchor".into())
    }
}

/// Walk the node tree to find a node by id.
fn find_node<'a>(node: &'a x_core::Node, id: &str) -> Option<&'a x_core::Node> {
    if node.id == id {
        return Some(node);
    }
    for child in &node.children {
        if let Some(found) = find_node(child, id) {
            return Some(found);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::{
        Color, Document, Node, PaintLayer, Stroke, StrokeCap, StrokeJoin, StrokeLayer,
        StrokeOptions, VariableWidthPoint,
    };

    fn fixture() -> String {
        save_x(&Document {
            pages: vec![Node::frame("page", 400.0, 300.0).child(Node::rect(
                "box",
                10.0,
                20.0,
                30.0,
                40.0,
                Color::BLACK,
            ))],
            default_font: Some("Inter".into()),
            ..Default::default()
        })
    }

    #[test]
    fn a_session_returns_small_deltas_and_explicit_persistence() {
        let mut bridge = CommandBridge::open(&fixture()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&bridge.state()).unwrap()["revision"],
            0
        );
        assert_eq!(
            serde_json::from_str::<Value>(&bridge.get_node("box")).unwrap()["x"],
            10.0
        );
        assert_eq!(bridge.get_node("missing"), "null");
        let renamed = bridge.rename_node("box", "Renamed").unwrap();
        let update: Value = serde_json::from_str(&renamed).unwrap();
        assert_eq!(update["node"]["name"], "Renamed");
        assert_eq!(update["canUndo"], true);
        assert!(
            renamed.len() < 256,
            "command returned a document, not a delta"
        );
        let moved = bridge.move_node("box", 3.0, -4.0).unwrap();
        let moved: Value = serde_json::from_str(&moved).unwrap();
        assert_eq!(moved["node"]["x"], 13.0);
        assert_eq!(moved["node"]["y"], 16.0);
        let undo: Value = serde_json::from_str(&bridge.undo().unwrap()).unwrap();
        assert_eq!(undo["node"]["x"], 10.0);
        let redo: Value = serde_json::from_str(&bridge.redo().unwrap()).unwrap();
        assert_eq!(redo["node"]["x"], 13.0);
        let saved = load_x(&bridge.export_x()).unwrap();
        assert_eq!(saved.pages[0].children[0].transform.x, 13.0);
        assert_eq!(saved.default_font.as_deref(), Some("Inter"));
    }

    #[test]
    fn resize_uses_the_shared_rust_editor_and_small_v2_node_delta() {
        let mut bridge = CommandBridge::open(&fixture()).unwrap();
        let changed = bridge.resize_node("box", 80.0, 24.5).unwrap();
        assert!(changed.len() < 256, "resize serialized an entire document");
        let delta: Value = serde_json::from_str(&changed).unwrap();
        assert_eq!(delta["revision"], 1);
        assert_eq!(delta["node"]["w"], 80.0);
        assert_eq!(delta["node"]["h"], 24.5);
        let queried: Value = serde_json::from_str(&bridge.get_node("box")).unwrap();
        assert_eq!(queried["w"], 80.0);
        let undone: Value = serde_json::from_str(&bridge.undo().unwrap()).unwrap();
        assert_eq!(undone["node"]["w"], 30.0);
        let redone: Value = serde_json::from_str(&bridge.redo().unwrap()).unwrap();
        assert_eq!(redone["node"]["h"], 24.5);
        let exported = load_x(&bridge.export_x()).unwrap();
        assert_eq!(exported.pages[0].children[0].w, 80.0);
        for (w, h) in [(f64::NAN, 10.0), (10.0, 0.0)] {
            assert!(bridge.resize_node("box", w, h).is_err());
        }
        assert_eq!(
            bridge.resize_node("box", 80.0, 24.5).unwrap(),
            bridge.state()
        );
    }

    #[test]
    fn four_booleans_have_atomic_small_deltas_and_native_history() {
        for name in ["union", "subtract", "intersect", "exclude"] {
            let document = Document {
                pages: vec![Node::frame("page", 400.0, 300.0)
                    .child(Node::rect("first", 0.0, 0.0, 10.0, 10.0, Color::BLACK))
                    .child(Node::rect("second", 5.0, 5.0, 10.0, 10.0, Color::BLACK))],
                ..Default::default()
            };
            let mut bridge = CommandBridge::open(&save_x(&document)).unwrap();
            let wire = bridge.boolean_node("first", "second", name).unwrap();
            let changed: Value = serde_json::from_str(&wire).unwrap();
            assert!(
                wire.len() < 2_048,
                "returned a full document, not a vector delta"
            );
            assert_eq!(changed["revision"], 1);
            assert_eq!(changed["node"], Value::Null);
            assert_eq!(changed["boolean"]["removed"], json!(["first", "second"]));
            assert_eq!(changed["boolean"]["upsert"][0]["kind"], "vector");
            let created = changed["boolean"]["upsert"][0]["id"].as_str().unwrap();
            assert!(bridge.get_node("first") == "null");
            let snapshot = load_x(&bridge.export_x()).unwrap();
            assert_eq!(snapshot.pages[0].children.len(), 1);
            assert_eq!(snapshot.pages[0].children[0].id, created);
            let undo: Value = serde_json::from_str(&bridge.undo().unwrap()).unwrap();
            assert_eq!(undo["revision"], 2);
            assert_eq!(undo["boolean"]["removed"], json!([created]));
            assert_eq!(undo["boolean"]["upsert"].as_array().unwrap().len(), 2);
            assert_eq!(undo["canRedo"], true);
            let redo: Value = serde_json::from_str(&bridge.redo().unwrap()).unwrap();
            assert_eq!(redo["boolean"]["upsert"][0]["id"], created);
            assert!(bridge.boolean_node("missing", "second", name).is_err());
            assert_eq!(
                bridge.state(),
                serde_json::json!({
                    "revision": 3, "node": null, "canUndo": true, "canRedo": false,
                })
                .to_string()
            );
        }
    }

    #[test]
    fn stroke_delta_is_small_validated_and_checkpoint_is_lossless() {
        let mut bridge = CommandBridge::open(&fixture()).unwrap();
        for (width, color, align, join) in [
            (-1.0, "#236b9e", "inside", "miter"),
            (f64::NAN, "#236b9e", "center", "bevel"),
            (3.0, "#fff", "inside", "miter"),
            (3.0, "#ffffff00", "inside", "miter"),
            (3.0, "#236b9e", "wrong", "miter"),
            (3.0, "#236b9e", "outside", "round"),
        ] {
            assert!(bridge
                .stroke_node("box", width, color, align, join)
                .is_err());
        }
        assert_eq!(
            serde_json::from_str::<Value>(&bridge.state()).unwrap()["revision"],
            0
        );
        let wire = bridge
            .stroke_node("box", 8.0, "#236b9e", "outside", "bevel")
            .unwrap();
        assert!(
            wire.len() < 550,
            "returned a page instead of at most 12 stroke anchors"
        );
        let delta: Value = serde_json::from_str(&wire).unwrap();
        assert_eq!(delta["node"], Value::Null);
        assert_eq!(delta["stroke"]["outer"][0], json!([-8.0, 0.0]));
        assert_eq!(delta["stroke"]["inner"][0], json!([0.0, 0.0]));
        assert_eq!(delta["stroke"]["color"], "#236b9e");
        assert_eq!(delta["stroke"]["join"], "bevel");
        let saved = load_x(&bridge.export_x()).unwrap();
        assert_eq!(
            saved.pages[0].children[0].stroke_layers[0].options.align,
            StrokeAlign::Outside
        );
        let undone: Value = serde_json::from_str(&bridge.undo().unwrap()).unwrap();
        assert_eq!(undone["stroke"]["width"], 0.0);
        let redo: Value = serde_json::from_str(&bridge.redo().unwrap()).unwrap();
        assert_eq!(redo["stroke"], delta["stroke"]);
    }

    #[test]
    fn signed_offset_serializes_only_the_affected_shape_and_supports_undo() {
        let mut bridge = CommandBridge::open(&fixture()).unwrap();
        assert!(bridge.offset_node("box", f64::NAN, "round").is_err());
        assert!(bridge.offset_node("box", 3.0, "unknown").is_err());
        assert_eq!(
            serde_json::from_str::<Value>(&bridge.state()).unwrap()["revision"],
            0
        );
        let preview: Value =
            serde_json::from_str(&bridge.preview_offset("box", 4.0, "round").unwrap()).unwrap();
        assert_eq!(preview["kind"], "vector");
        assert_eq!(
            serde_json::from_str::<Value>(&bridge.state()).unwrap()["revision"],
            0
        );
        let applied = bridge.offset_node("box", 4.0, "round").unwrap();
        let change: Value = serde_json::from_str(&applied).unwrap();
        assert_eq!(change["offset"], preview);
        assert_eq!(change["revision"], 1);
        assert_eq!(change["node"], Value::Null);
        assert_eq!(change["offset"]["kind"], "vector");
        assert_eq!(change["offset"]["id"], "box");
        assert!(change["offset"]["path"].as_array().unwrap().len() >= 5);
        assert!(change.get("pages").is_none());
        assert!(
            applied.len() < 10_000,
            "a one-layer command returned a page"
        );
        assert!(matches!(
            load_x(&bridge.export_x()).unwrap().pages[0].children[0].kind,
            x_core::NodeKind::Vector { .. }
        ));
        let undone: Value = serde_json::from_str(&bridge.undo().unwrap()).unwrap();
        assert_eq!(undone["node"], Value::Null);
        assert_eq!(undone["offset"]["kind"], "rect");
        assert_eq!(undone["offset"]["radius"], 0.0);
        let redone: Value = serde_json::from_str(&bridge.redo().unwrap()).unwrap();
        assert_eq!(redone["offset"], change["offset"]);
        let contracted: Value =
            serde_json::from_str(&bridge.offset_node("box", -100.0, "bevel").unwrap()).unwrap();
        assert_eq!(contracted["offset"]["path"], json!([]));
        assert!(bridge.undo().is_ok());
    }

    #[test]
    fn outline_stroke_serializes_a_reversible_profiled_dash_cap_delta() {
        let mut line = Node::line(
            "ink",
            10.0,
            20.0,
            72.0,
            36.0,
            Color::from_rgb8(0x91, 0x42, 0xd4),
        );
        line.visual_stacks_materialized = true;
        line.fill_layers = vec![PaintLayer::new(line.fill.clone())];
        line.stroke = Stroke::solid(Color::from_rgb8(0x91, 0x42, 0xd4), 7.0);
        line.stroke_layers = vec![StrokeLayer {
            stroke: line.stroke.clone(),
            opacity: 1.0,
            visible: true,
            blend: x_core::BlendKind::Normal,
            options: StrokeOptions {
                cap_start: StrokeCap::Round,
                cap_end: StrokeCap::Triangle,
                join: StrokeJoin::Round,
                dash: vec![11.0, 4.0],
                dash_offset: 8.0,
                width_profile: vec![
                    VariableWidthPoint {
                        position: 0.0,
                        width_multiplier: 0.5,
                    },
                    VariableWidthPoint {
                        position: 0.4,
                        width_multiplier: 1.75,
                    },
                    VariableWidthPoint {
                        position: 1.0,
                        width_multiplier: 0.75,
                    },
                ],
                ..Default::default()
            },
        }];
        let source = save_x(&Document {
            pages: vec![Node::frame("page", 160.0, 90.0).child(line)],
            ..Default::default()
        });
        let mut bridge = CommandBridge::open(&source).unwrap();

        let applied_wire = bridge.outline_stroke("ink").unwrap();
        assert!(
            applied_wire.len() < 100_000,
            "outline command returned a page"
        );
        let applied: Value = serde_json::from_str(&applied_wire).unwrap();
        assert_eq!(applied["revision"], 1);
        assert_eq!(applied["node"], Value::Null);
        assert!(applied.get("stroke").is_none() && applied.get("offset").is_none());
        assert_eq!(applied["outline"]["id"], "ink");
        assert_eq!(applied["outline"]["kind"], "vector");
        assert_eq!(applied["outline"]["fill"], "#9142d4");
        assert_eq!(applied["outline"]["stroke"], Value::Null);
        assert!(applied["outline"]["path"]
            .as_array()
            .unwrap()
            .iter()
            .any(|cmd| cmd == &json!(["Z"])));
        assert!(matches!(
            load_x(&bridge.export_x()).unwrap().pages[0].children[0].kind,
            x_core::NodeKind::Vector { .. }
        ));

        let undone: Value = serde_json::from_str(&bridge.undo().unwrap()).unwrap();
        assert_eq!(undone["revision"], 2);
        assert_eq!(undone["outline"]["kind"], "line");
        assert_eq!(undone["outline"]["fill"], Value::Null);
        assert_eq!(undone["outline"]["stroke"]["width"], 7.0);
        assert_eq!(undone["outline"]["stroke"]["capStart"], "round");
        assert_eq!(undone["outline"]["stroke"]["capEnd"], "triangle");
        assert_eq!(undone["outline"]["stroke"]["join"], "round");
        assert_eq!(undone["outline"]["stroke"]["dash"], json!([11.0, 4.0]));
        assert_eq!(undone["outline"]["stroke"]["dashOffset"], 8.0);
        assert_eq!(
            undone["outline"]["stroke"]["widthProfile"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            bridge.export_x(),
            source,
            "undo restores the exact native source"
        );

        let redone: Value = serde_json::from_str(&bridge.redo().unwrap()).unwrap();
        assert_eq!(redone["revision"], 3);
        assert_eq!(redone["outline"], applied["outline"]);
        assert!(bridge.outline_stroke("missing").is_err());
    }

    #[test]
    fn errors_are_explicit_and_do_not_destroy_a_session() {
        assert!(CommandBridge::open("not an x document").is_err());
        let mut bridge = CommandBridge::open(&fixture()).unwrap();
        assert!(bridge.move_node("box", f64::NAN, 0.0).is_err());
        assert!(bridge.rename_node("missing", "X").is_err());
        assert_eq!(
            serde_json::from_str::<Value>(&bridge.state()).unwrap()["revision"],
            0
        );
        let undone: Value = serde_json::from_str(&bridge.undo().unwrap()).unwrap();
        assert_eq!(undone["node"], Value::Null);
    }

    // Phase 9: export and vector editing tests

    #[test]
    fn export_node_png_produces_valid_base64_png() {
        let bridge = CommandBridge::open(&fixture()).unwrap();
        let result = bridge.export_node("box", "png", 1.0).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["format"], "png");
        let bytes_b64 = parsed["bytes"].as_str().unwrap();
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(bytes_b64).unwrap();
        assert_eq!(&bytes[1..4], b"PNG", "valid PNG signature");
        assert!(bytes.len() > 8);
    }

    #[test]
    fn export_node_jpg_produces_valid_jpeg() {
        let bridge = CommandBridge::open(&fixture()).unwrap();
        let result = bridge.export_node("box", "jpg", 2.0).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["format"], "jpg");
        let bytes_b64 = parsed["bytes"].as_str().unwrap();
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(bytes_b64).unwrap();
        assert_eq!(&bytes[0..2], &[0xFF, 0xD8], "JPEG SOI marker");
    }

    #[test]
    fn export_node_pdf_produces_valid_pdf() {
        let bridge = CommandBridge::open(&fixture()).unwrap();
        let result = bridge.export_node("box", "pdf", 1.0).unwrap();
        let parsed: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["format"], "pdf");
        let bytes_b64 = parsed["bytes"].as_str().unwrap();
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(bytes_b64).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.starts_with("%PDF-1.4"));
        assert!(text.contains("%%EOF"));
    }

    #[test]
    fn export_node_unknown_format_returns_error() {
        let bridge = CommandBridge::open(&fixture()).unwrap();
        assert!(bridge.export_node("box", "gif", 1.0).is_err());
    }

    #[test]
    fn export_node_missing_id_returns_error() {
        let bridge = CommandBridge::open(&fixture()).unwrap();
        assert!(bridge.export_node("nonexistent", "png", 1.0).is_err());
    }

    #[test]
    fn export_node_invalid_scale_returns_error() {
        let bridge = CommandBridge::open(&fixture()).unwrap();
        assert!(bridge.export_node("box", "png", 0.0).is_err());
        assert!(bridge.export_node("box", "png", -1.0).is_err());
        assert!(bridge.export_node("box", "png", f64::NAN).is_err());
    }

    #[test]
    fn vector_add_point_inserts_anchor_and_is_undoable() {
        let doc = save_x(&Document {
            pages: vec![Node::frame("page", 400.0, 300.0).child(Node::vector(
                "v",
                10.0,
                10.0,
                100.0,
                50.0,
                vec![
                    PathCmd::MoveTo(0.0, 0.0),
                    PathCmd::LineTo(100.0, 0.0),
                    PathCmd::LineTo(100.0, 50.0),
                    PathCmd::Close,
                ],
            ))],
            ..Default::default()
        });
        let mut bridge = CommandBridge::open(&doc).unwrap();
        let result = bridge.vector_add_point("v", 2, 100.0, 25.0).unwrap();
        let delta: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(delta["revision"], 1);
        assert_eq!(delta["canUndo"], true);
        let undone: Value = serde_json::from_str(&bridge.undo().unwrap()).unwrap();
        assert_eq!(undone["revision"], 2);
    }

    #[test]
    fn vector_convert_point_toggles_corner_and_smooth() {
        let doc = save_x(&Document {
            pages: vec![Node::frame("page", 400.0, 300.0).child(Node::vector(
                "v",
                0.0,
                0.0,
                100.0,
                50.0,
                vec![
                    PathCmd::MoveTo(0.0, 0.0),
                    PathCmd::LineTo(100.0, 0.0),
                    PathCmd::LineTo(100.0, 50.0),
                ],
            ))],
            ..Default::default()
        });
        let mut bridge = CommandBridge::open(&doc).unwrap();
        let result = bridge.vector_convert_point("v", 1).unwrap();
        let delta: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(delta["revision"], 1);
        let result2 = bridge.vector_convert_point("v", 1).unwrap();
        let delta2: Value = serde_json::from_str(&result2).unwrap();
        assert_eq!(delta2["revision"], 2);
        assert!(bridge.undo().is_ok());
    }
}
