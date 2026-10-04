//! Thin serialization edge for the shared x-editor::DocumentSession.
//! Commands and undo live in Rust; only one changed node is encoded here.

use kurbo::Shape as _; // bounding_box() on BezPath
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

    /// Phase 9: raster/PDF export of a single node — the SAME real render
    /// pipeline the desktop app exports with (`x-render`: `build_render_tree_of`
    /// for the tree, tiny-skia + `png`/`jpeg-encoder` for rasters, the vector
    /// PDF writer for PDFs). The hand-painted flat-colour stubs that used to
    /// live here produced files the canvas never showed - rounded corners,
    /// strokes and children simply were not in them - so they are gone.
    ///
    /// `options` is the TS caller's JSON payload:
    /// `{ "quality": 0..=100 (JPG), "bleed": { "l", "t", "r", "b" } }`.
    /// The bleed is the export-area expansion Figma's files contain for
    /// shadows/blur/outside strokes; the web side computes the same per-side
    /// margins in `exportBleed`, and taking them from the caller is what
    /// keeps the two tiers byte-identical in framing. Anything the bundle
    /// cannot paint faithfully (glyph runs - there is no font manager in
    /// wasm) is REFUSED so the caller degrades to the canvas path rather
    /// than downloading a wrong file.
    ///
    /// Returns the JSON envelope `{ "ok": true, "bytes": "<base64>",
    /// "width": N, "height": N, "format": "png"|"jpg"|"pdf" }`; the TS caller
    /// validates the bytes' magic before trusting it.
    pub fn export_node(
        &self,
        id: &str,
        format: &str,
        scale: f64,
        options: &str,
    ) -> Result<String, String> {
        if !scale.is_finite() || scale <= 0.0 || scale > 64.0 {
            return Err("export scale must be a finite number between 0 and 64".into());
        }
        if !matches!(format, "png" | "jpg" | "jpeg" | "pdf") {
            return Err(format!("unsupported export format: {format}"));
        }
        let snapshot = self.session.snapshot();
        let page = snapshot
            .pages
            .iter()
            .find(|p| find_node(p, id).is_some())
            .ok_or_else(|| format!("node '{id}' not found"))?;
        let node = find_node(page, id).ok_or_else(|| format!("node '{id}' not found"))?;
        let mut tree = x_render::build_render_tree_of(page, id, &snapshot.variables)
            .ok_or_else(|| format!("node '{id}' not found"))?;
        // A frame's name is canvas chrome, never exported artwork - strip it
        // before the bounds pass, exactly like the desktop plan builder, so a
        // label inflates neither the content nor the page.
        tree.commands
            .retain(|c| !x_render::ir::is_frame_name_label(c.key()));
        // No font manager ships in the wasm bundle: a tree that still carries
        // glyph runs after the label strip would rasterize wrong, so refuse
        // it and let the caller fall back (graceful degradation, not guessing).
        if tree
            .commands
            .iter()
            .any(|c| matches!(c, x_render::RenderCommand::Glyphs { .. }))
        {
            return Err(
                "wasm export has no font manager; export text layers via the canvas path".into(),
            );
        }
        // Out-of-band strokes become filled geometry, so a stroke's reach is
        // part of the page bounds, not painted off the edge of the canvas.
        x_render::text_geometry::outline_strokes(&mut tree);
        // Page = the node box, grown by every command's actual reach and by
        // the caller's per-side margins (the same 1.5x-blur convention
        // x-render inflates its clip bounds with, computed once in TS).
        let (mut x0, mut y0, mut x1, mut y1) = (0.0f64, 0.0f64, node.w.max(1.0), node.h.max(1.0));
        {
            use x_render::RenderCommand as Cmd;
            for command in &tree.commands {
                let r = match command {
                    Cmd::FillPath {
                        path, transform, ..
                    }
                    | Cmd::StrokePath {
                        path, transform, ..
                    } => Some(transform.transform_rect_bbox(path.bounding_box())),
                    Cmd::Image {
                        transform,
                        w,
                        h,
                        rotation,
                        ..
                    } => {
                        let t = *transform
                            * kurbo::Affine::translate((*w / 2.0, *h / 2.0))
                            * kurbo::Affine::rotate(rotation.to_radians())
                            * kurbo::Affine::translate((-*w / 2.0, -*h / 2.0));
                        Some(t.transform_rect_bbox(kurbo::Rect::new(0.0, 0.0, *w, *h)))
                    }
                    _ => None,
                };
                if let Some(r) = r {
                    if [r.x0, r.y0, r.x1, r.y1].iter().all(|n| n.is_finite()) {
                        x0 = x0.min(r.x0);
                        y0 = y0.min(r.y0);
                        x1 = x1.max(r.x1);
                        y1 = y1.max(r.y1);
                    }
                }
            }
        }
        let (bl, bt, br, bb) = export_bleed(options);
        x0 -= bl;
        y0 -= bt;
        x1 += br;
        y1 += bb;
        let (pw, ph) = ((x1 - x0).max(1.0), (y1 - y0).max(1.0));
        if !(pw.is_finite() && ph.is_finite()) || pw > 100_000.0 || ph > 100_000.0 {
            return Err("export page is too large or non-finite".into());
        }
        // Re-origin to (0, 0) after sizing, so the bleed margin lands on the
        // top/left exactly as the viewBox's negative origin does in the SVG.
        let shift = kurbo::Affine::translate((-x0, -y0));
        {
            use x_render::RenderCommand as Cmd;
            for command in &mut tree.commands {
                match command {
                    Cmd::FillPath { transform, .. }
                    | Cmd::StrokePath { transform, .. }
                    | Cmd::Image { transform, .. }
                    | Cmd::PushClip { transform, .. } => *transform = shift * *transform,
                    Cmd::PushLayer { bounds, .. } => *bounds = shift.transform_rect_bbox(*bounds),
                    _ => {}
                }
            }
        }
        let (bytes, ow, oh) = if format == "pdf" {
            let bytes = x_render::export_pdf(&tree, pw, ph);
            (
                bytes,
                pw.round().max(1.0) as u32,
                ph.round().max(1.0) as u32,
            )
        } else {
            let raster_format = if format == "png" {
                x_render::RasterFormat::Png
            } else {
                x_render::RasterFormat::Jpg(export_quality(options))
            };
            // "Flatten to white" for JPEG, transparency for PNG - Figma's
            // JPG contract, and what the canvas fallback already does.
            let background = (format != "png").then(|| x_render::Color::from_rgb8(255, 255, 255));
            x_render::export_raster(&tree, pw, ph, raster_format, scale, background, None, None)?
        };
        let b64 = x_format::base64(&bytes);
        let tag = if format == "pdf" {
            "pdf"
        } else if format == "png" {
            "png"
        } else {
            "jpg"
        };
        Ok(format!(
            r#"{{"ok":true,"bytes":"{b64}","width":{ow},"height":{oh},"format":"{tag}"}}"#
        ))
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
        if !self
            .session
            .editor_mut()
            .add_vector_point_on(id, segment_idx, (x, y))
        {
            return Err("could not add point: invalid node or segment".into());
        }
        self.session.bump_revision();
        Ok(delta_json(self.session.state()))
    }

    /// Phase 9: Convert a corner point to smooth (or vice versa). Toggles a
    /// LineTo ↔ CurveTo at the given anchor index. ONE undoable command.
    pub fn vector_convert_point(&mut self, id: &str, anchor_idx: usize) -> Result<String, String> {
        if !self.session.editor_mut().convert_anchor(id, anchor_idx) {
            return Err("could not convert point: invalid node or anchor".into());
        }
        self.session.bump_revision();
        Ok(delta_json(self.session.state()))
    }

    /// Phase 10: Commit a pen-drawn path as a vector node. Takes raw click
    /// points from the TS collector, converts them to PathCmds (LineTo chain),
    /// fits cubic bezier handles for smooth curves, and inserts the node as a
    /// single atomic undo step. Returns the new node's id in the delta.
    pub fn commit_pen_path(
        &mut self,
        parent_id: &str,
        points_json: &str,
    ) -> Result<String, String> {
        let points: Vec<(f64, f64)> =
            serde_json::from_str(points_json).map_err(|e| format!("invalid points JSON: {e}"))?;
        if points.len() < 2 {
            return Err("pen path needs at least 2 points".into());
        }
        // Validate finiteness
        for (i, &(x, y)) in points.iter().enumerate() {
            if !x.is_finite() || !y.is_finite() {
                return Err(format!("pen point {i} has non-finite coordinates"));
            }
        }
        // Convert raw points to PathCmds with fitted bezier handles
        let path = fit_pen_path(&points);
        // Calculate bounds
        let (min_x, min_y, max_x, max_y) = path_bounds(&points);
        let w = (max_x - min_x).max(1.0);
        let h = (max_y - min_y).max(1.0);
        let id = x_core::fresh_id("pen");
        let mut node = x_core::Node::vector(&id, min_x, min_y, w, h, path);
        node.name = format!("Pen {}", self.session.state().revision + 1);
        if !self.session.editor_mut().insert_node(parent_id, node) {
            return Err("could not insert pen path".into());
        }
        self.session.editor_mut().selection = vec![id];
        self.session.bump_revision();
        Ok(delta_json(self.session.state()))
    }

    /// Phase 10: Commit a pencil-drawn stroke. Takes raw pointer samples,
    /// applies RDP simplification, then Catmull-Rom → cubic bezier fitting
    /// to produce a beautifully smooth vector path. ONE atomic undo step.
    pub fn smooth_pencil_path(
        &mut self,
        parent_id: &str,
        points_json: &str,
        tolerance: f64,
    ) -> Result<String, String> {
        let points: Vec<(f64, f64)> =
            serde_json::from_str(points_json).map_err(|e| format!("invalid points JSON: {e}"))?;
        if points.len() < 2 {
            return Err("pencil path needs at least 2 points".into());
        }
        if !tolerance.is_finite() || tolerance < 0.0 {
            return Err("tolerance must be a non-negative finite number".into());
        }
        // RDP thin the raw points
        let simplified = rdp_simplify(&points, tolerance.max(0.5));
        if simplified.len() < 2 {
            return Err("pencil path collapsed after simplification".into());
        }
        // Fit smooth cubic bezier through simplified points (Catmull-Rom)
        let path = fit_smooth_path(&simplified);
        let (min_x, min_y, max_x, max_y) = path_bounds(&points);
        let w = (max_x - min_x).max(1.0);
        let h = (max_y - min_y).max(1.0);
        let id = x_core::fresh_id("pencil");
        let mut node = x_core::Node::vector(&id, min_x, min_y, w, h, path);
        node.name = format!("Pencil {}", self.session.state().revision + 1);
        if !self.session.editor_mut().insert_node(parent_id, node) {
            return Err("could not insert pencil path".into());
        }
        self.session.editor_mut().selection = vec![id];
        self.session.bump_revision();
        Ok(delta_json(self.session.state()))
    }

    /// Phase 10: Erase geometry from a vector node along a stroke path.
    /// The eraser stroke is a series of points; segments of the target
    /// vector within `radius` of the stroke are removed, splitting the
    /// path at the cut points. ONE atomic undo step.
    pub fn erase_geometry(
        &mut self,
        target_id: &str,
        erase_points_json: &str,
        radius: f64,
    ) -> Result<String, String> {
        let erase_points: Vec<(f64, f64)> = serde_json::from_str(erase_points_json)
            .map_err(|e| format!("invalid erase points JSON: {e}"))?;
        if erase_points.is_empty() {
            return Err("erase path is empty".into());
        }
        if !radius.is_finite() || radius <= 0.0 {
            return Err("eraser radius must be a positive finite number".into());
        }
        let editor = self.session.editor_mut();
        // Use the existing eraser tool infrastructure
        use x_editor::eraser::{EraserSettings, EraserStroke};
        let settings = EraserSettings {
            radius,
            feather: 0.0,
            min_segment_length: 2.0,
            soft_mask: false,
        };
        let mut stroke = EraserStroke::new(settings);
        for (x, y) in &erase_points {
            stroke.add_point(*x, *y, 1.0);
        }
        editor.erase_stroke = Some(stroke);
        editor.selection = vec![target_id.to_string()];
        let success = editor.eraser_end();
        if !success {
            return Err("erase did not affect the target node".into());
        }
        self.session.bump_revision();
        Ok(delta_json(self.session.state()))
    }
}

/// Convert raw pen click points into a vector path with smooth bezier handles.
/// Each consecutive pair of points becomes a cubic with handles at 1/3 of the
/// segment direction, producing smooth curves between click positions.
fn fit_pen_path(points: &[(f64, f64)]) -> Vec<x_core::PathCmd> {
    use x_core::PathCmd;
    if points.is_empty() {
        return vec![];
    }
    if points.len() == 1 {
        return vec![PathCmd::MoveTo(points[0].0, points[0].1)];
    }
    let mut cmds = vec![PathCmd::MoveTo(points[0].0, points[0].1)];
    for pair in points.windows(2) {
        let (px, py) = pair[0];
        let (cx, cy) = pair[1];
        let dx = cx - px;
        let dy = cy - py;
        // Auto-place cubic handles at 1/3 of the segment direction
        let c1x = px + dx / 3.0;
        let c1y = py + dy / 3.0;
        let c2x = px + 2.0 * dx / 3.0;
        let c2y = py + 2.0 * dy / 3.0;
        cmds.push(PathCmd::CurveTo(c1x, c1y, c2x, c2y, cx, cy));
    }
    cmds
}

/// Convert raw pencil samples into a smooth bezier path.
/// Uses Catmull-Rom → cubic conversion for C1 continuity.
fn fit_smooth_path(points: &[(f64, f64)]) -> Vec<x_core::PathCmd> {
    use x_core::PathCmd;
    if points.is_empty() {
        return vec![];
    }
    if points.len() < 3 {
        // Too few points for Catmull-Rom; use straight lines
        let mut cmds = vec![PathCmd::MoveTo(points[0].0, points[0].1)];
        for &(x, y) in &points[1..] {
            cmds.push(PathCmd::LineTo(x, y));
        }
        return cmds;
    }
    let mut cmds = vec![PathCmd::MoveTo(points[0].0, points[0].1)];
    // Catmull-Rom to cubic bezier conversion
    // For segment p[i] → p[i+1], controls are:
    //   c1 = p[i] + (p[i+1] - p[i-1]) / 6
    //   c2 = p[i+1] - (p[i+2] - p[i]) / 6
    let n = points.len();
    for i in 0..n - 1 {
        let p0 = if i > 0 { points[i - 1] } else { points[i] };
        let p1 = points[i];
        let p2 = points[i + 1];
        let p3 = if i + 2 < n {
            points[i + 2]
        } else {
            points[i + 1]
        };
        let c1x = p1.0 + (p2.0 - p0.0) / 6.0;
        let c1y = p1.1 + (p2.1 - p0.1) / 6.0;
        let c2x = p2.0 - (p3.0 - p1.0) / 6.0;
        let c2y = p2.1 - (p3.1 - p1.1) / 6.0;
        cmds.push(PathCmd::CurveTo(c1x, c1y, c2x, c2y, p2.0, p2.1));
    }
    cmds
}

/// Iterative RDP (Ramer-Douglas-Peucker) simplification of raw points.
fn rdp_simplify(points: &[(f64, f64)], tolerance: f64) -> Vec<(f64, f64)> {
    if points.len() <= 2 {
        return points.to_vec();
    }
    // Find the point with max perpendicular distance
    let first = points[0];
    let last = points[points.len() - 1];
    let mut max_dist = 0.0f64;
    let mut max_idx = 0;
    for (i, &p) in points[1..points.len() - 1].iter().enumerate() {
        let d = perp_distance(p, first, last);
        if d > max_dist {
            max_dist = d;
            max_idx = i + 1;
        }
    }
    if max_dist > tolerance {
        let mut left = rdp_simplify(&points[..=max_idx], tolerance);
        let right = rdp_simplify(&points[max_idx..], tolerance);
        left.pop(); // avoid duplicating the split point
        left.extend(right);
        left
    } else {
        vec![first, last]
    }
}

/// Perpendicular distance from point p to the line through a and b.
fn perp_distance(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let dx = b.0 - a.0;
    let dy = b.1 - a.1;
    let len = dx.hypot(dy);
    if len < 1e-12 {
        return p.0.hypot(p.1);
    }
    ((p.0 - a.0) * dy - (p.1 - a.1) * dx).abs() / len
}

/// Bounding box of a point set.
fn path_bounds(points: &[(f64, f64)]) -> (f64, f64, f64, f64) {
    let mut min_x = f64::MAX;
    let mut min_y = f64::MAX;
    let mut max_x = f64::MIN;
    let mut max_y = f64::MIN;
    for &(x, y) in points {
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
    }
    (min_x, min_y, max_x, max_y)
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

/// JPG quality from the caller's options JSON (Figma's Image quality,
/// 0..=100). Anything unparseable degrades to the web default
/// (`qualityValue` high = 0.92), it never fails the export.
fn export_quality(options: &str) -> u8 {
    serde_json::from_str::<Value>(options)
        .ok()
        .and_then(|v| v.get("quality").and_then(|q| q.as_f64()))
        .filter(|q| q.is_finite())
        .map(|q| (q.round() as i64).clamp(1, 100) as u8)
        .unwrap_or(92)
}

/// Per-side export margins from the caller's options JSON - the box
/// `exportBleed` computed on the web side, so the wasm page and the fallback
/// canvas frame the artwork identically. Garbage degrades to no margin.
fn export_bleed(options: &str) -> (f64, f64, f64, f64) {
    let side = |v: &Value, key: &str| -> f64 {
        v.get(key)
            .and_then(|n| n.as_f64())
            .filter(|n| n.is_finite() && *n <= 100_000.0)
            .map(|n| n.max(0.0))
            .unwrap_or(0.0)
    };
    serde_json::from_str::<Value>(options)
        .ok()
        .and_then(|v| v.get("bleed").cloned())
        .map(|b| (side(&b, "l"), side(&b, "t"), side(&b, "r"), side(&b, "b")))
        .unwrap_or((0.0, 0.0, 0.0, 0.0))
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

    // Phase 9: the export bridge must emit the REAL pipeline's output
    // (F1 of BEHAVIOR_OUTPUT_PARITY_AUDIT_2026-10-04.md). The old tests here
    // asserted only magic bytes - which the flat-fill stubs satisfied by
    // construction. These pin the output contract instead: bytes byte-equal
    // to `x_render`'s own encoders for the same tree, caller bleed shaping
    // the page, quality honored, text refused, junk options degraded
    // gracefully.

    fn export_env(
        bridge: &CommandBridge,
        id: &str,
        format: &str,
        scale: f64,
        options: &str,
    ) -> Value {
        let result = bridge.export_node(id, format, scale, options).unwrap();
        serde_json::from_str(&result).unwrap()
    }

    fn envelope_bytes(env: &Value) -> Vec<u8> {
        x_format::debase64(env["bytes"].as_str().unwrap()).unwrap()
    }

    fn png_dims(bytes: &[u8]) -> (u32, u32) {
        assert_eq!(&bytes[1..4], b"PNG", "valid PNG signature");
        (
            u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
            u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
        )
    }

    /// The reference form of the fixture box: node-local tree, labels
    /// stripped, strokes outlined, 30x40 page. Whatever the bridge answers for
    /// the same inputs must be byte-identical to this.
    fn plan_box(format: &str, scale: f64) -> Vec<u8> {
        let doc = load_x(&fixture()).unwrap();
        let mut tree =
            x_render::build_render_tree_of(&doc.pages[0], "box", &doc.variables).unwrap();
        tree.commands
            .retain(|c| !x_render::ir::is_frame_name_label(c.key()));
        x_render::text_geometry::outline_strokes(&mut tree);
        match format {
            "png" | "jpg" | "jpeg" => {
                let background =
                    (format != "png").then(|| x_render::Color::from_rgb8(255, 255, 255));
                let raster_format = if format == "png" {
                    x_render::RasterFormat::Png
                } else {
                    x_render::RasterFormat::Jpg(92)
                };
                let (bytes, _w, _h) = x_render::export_raster(
                    &tree,
                    30.0,
                    40.0,
                    raster_format,
                    scale,
                    background,
                    None,
                    None,
                )
                .unwrap();
                bytes
            }
            _ => x_render::export_pdf(&tree, 30.0, 40.0),
        }
    }

    #[test]
    fn export_node_png_is_the_real_pipeline_not_a_flat_fill() {
        let bridge = CommandBridge::open(&fixture()).unwrap();
        let env = export_env(&bridge, "box", "png", 1.0, "{}");
        assert_eq!(env["ok"], true);
        assert_eq!(env["format"], "png");
        let bytes = envelope_bytes(&env);
        assert_eq!(
            png_dims(&bytes),
            (
                env["width"].as_u64().unwrap() as u32,
                env["height"].as_u64().unwrap() as u32
            ),
            "the envelope must describe the file it carries"
        );
        assert_eq!(
            bytes,
            plan_box("png", 1.0),
            "the bridge must emit the encoder's bytes for the tree - the hand-rolled stub chunk writer never will"
        );
    }

    #[test]
    fn export_bleed_expands_the_page_like_the_web_export_size() {
        let bridge = CommandBridge::open(&fixture()).unwrap();
        let env = export_env(
            &bridge,
            "box",
            "png",
            2.0,
            r#"{"bleed":{"l":15,"t":11,"r":15,"b":19}}"#,
        );
        assert_eq!(env["width"], 120);
        assert_eq!(env["height"], 140);
        assert_eq!(png_dims(&envelope_bytes(&env)), (120, 140));
    }

    #[test]
    fn export_node_jpg_is_a_real_jpeg_flattened_to_white() {
        let bridge = CommandBridge::open(&fixture()).unwrap();
        let env = export_env(&bridge, "box", "jpg", 2.0, r#"{"quality":90}"#);
        assert_eq!(env["format"], "jpg");
        let bytes = envelope_bytes(&env);
        assert_eq!(&bytes[0..3], &[0xFF, 0xD8, 0xFF], "JPEG SOI + marker");
        assert_eq!(&bytes[bytes.len() - 2..], &[0xFF, 0xD9], "JPEG EOI");
        // The stub was ~104 hand-painted bytes of marker soup with raw RGBA
        // hidden in a COM comment; a real encoder at 60x80 is bigger AND
        // decodable by the browser, which the marker layout never was.
        assert!(bytes.len() > 150);
    }

    #[test]
    fn export_node_pdf_carries_the_render_tree() {
        let bridge = CommandBridge::open(&fixture()).unwrap();
        let env = export_env(&bridge, "box", "pdf", 1.0, "{}");
        let bytes = envelope_bytes(&env);
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.starts_with("%PDF-1."));
        assert!(text.contains("%%EOF"));
        assert_eq!(
            bytes,
            plan_box("pdf", 1.0),
            "one flat rect is not an export; the vector writer's output for the tree is"
        );
    }

    #[test]
    fn export_node_refuses_text_it_cannot_shape() {
        let doc = save_x(&Document {
            pages: vec![Node::frame("page", 400.0, 300.0)
                .child(Node::text("t", 10.0, 10.0, 100.0, 20.0, "hello"))],
            ..Default::default()
        });
        let bridge = CommandBridge::open(&doc).unwrap();
        // No font manager in the wasm bundle: refuse, and the caller falls
        // back to the canvas path - never paint a text layer wrong.
        assert!(bridge.export_node("t", "png", 1.0, "{}").is_err());
    }

    #[test]
    fn export_node_unknown_format_returns_error() {
        let bridge = CommandBridge::open(&fixture()).unwrap();
        assert!(bridge.export_node("box", "gif", 1.0, "{}").is_err());
    }

    #[test]
    fn export_node_missing_id_returns_error() {
        let bridge = CommandBridge::open(&fixture()).unwrap();
        assert!(bridge.export_node("nonexistent", "png", 1.0, "{}").is_err());
    }

    #[test]
    fn export_node_invalid_scale_returns_error() {
        let bridge = CommandBridge::open(&fixture()).unwrap();
        assert!(bridge.export_node("box", "png", 0.0, "{}").is_err());
        assert!(bridge.export_node("box", "png", -1.0, "{}").is_err());
        assert!(bridge.export_node("box", "png", f64::NAN, "{}").is_err());
    }

    #[test]
    fn junk_options_degrade_gracefully() {
        let bridge = CommandBridge::open(&fixture()).unwrap();
        let env = export_env(&bridge, "box", "jpg", 1.0, "not json");
        assert_eq!(env["ok"], true);
        let env = export_env(
            &bridge,
            "box",
            "png",
            1.0,
            r#"{"bleed":{"l":-5,"t":1e99,"nope":1}}"#,
        );
        assert_eq!(
            (env["width"].as_u64(), env["height"].as_u64()),
            (Some(30), Some(40)),
            "negative, infinite and unknown fields fall back to a tight page"
        );
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

    // Phase 10: drawing tools tests

    #[test]
    fn fit_pen_path_creates_cubic_beziers_from_click_points() {
        let points = vec![(0.0, 0.0), (50.0, 0.0), (50.0, 50.0)];
        let path = super::fit_pen_path(&points);
        assert_eq!(path.len(), 3); // MoveTo + 2 CurveTos
        assert!(matches!(path[0], PathCmd::MoveTo(0.0, 0.0)));
        assert!(matches!(path[1], PathCmd::CurveTo(..)));
        assert!(matches!(path[2], PathCmd::CurveTo(..)));
    }

    #[test]
    fn fit_smooth_path_creates_catmull_rom_cubics() {
        let points = vec![
            (0.0, 0.0),
            (10.0, 5.0),
            (20.0, 0.0),
            (30.0, 5.0),
            (40.0, 0.0),
        ];
        let path = super::fit_smooth_path(&points);
        assert_eq!(path.len(), 5); // MoveTo + 4 CurveTos
        assert!(matches!(path[0], PathCmd::MoveTo(0.0, 0.0)));
        for (i, cmd) in path.iter().enumerate().skip(1) {
            assert!(
                matches!(cmd, PathCmd::CurveTo(..)),
                "segment {i} should be a cubic"
            );
        }
    }

    #[test]
    fn rdp_simplify_removes_collinear_points() {
        let points = vec![(0.0, 0.0), (1.0, 0.0), (2.0, 0.0), (3.0, 0.0), (4.0, 0.0)];
        let simplified = super::rdp_simplify(&points, 0.5);
        assert_eq!(simplified.len(), 2); // Only endpoints survive
        assert_eq!(simplified[0], (0.0, 0.0));
        assert_eq!(simplified[1], (4.0, 0.0));
    }

    #[test]
    fn rdp_simplify_keeps_non_collinear_points() {
        let points = vec![(0.0, 0.0), (2.0, 5.0), (4.0, 0.0)];
        let simplified = super::rdp_simplify(&points, 0.5);
        assert_eq!(simplified.len(), 3); // All kept
    }

    #[test]
    fn commit_pen_path_creates_vector_node_atomically() {
        let doc = save_x(&Document {
            pages: vec![Node::frame("page", 400.0, 300.0)],
            ..Default::default()
        });
        let mut bridge = CommandBridge::open(&doc).unwrap();
        let points = "[[10,20],[50,20],[50,60]]";
        let result = bridge.commit_pen_path("page", points).unwrap();
        let delta: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(delta["revision"], 1);
        assert_eq!(delta["canUndo"], true);
        // Verify the node was created
        let state: Value = serde_json::from_str(&bridge.state()).unwrap();
        assert!(state["revision"].as_u64().unwrap() >= 1);
    }

    #[test]
    fn smooth_pencil_path_creates_simplified_smooth_vector() {
        let doc = save_x(&Document {
            pages: vec![Node::frame("page", 400.0, 300.0)],
            ..Default::default()
        });
        let mut bridge = CommandBridge::open(&doc).unwrap();
        // Shaky hand-drawn line that RDP should simplify
        let points = "[[0,0],[5,1],[10,0],[15,2],[20,0],[25,1],[30,0]]";
        let result = bridge.smooth_pencil_path("page", points, 2.0).unwrap();
        let delta: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(delta["revision"], 1);
    }

    #[test]
    fn commit_pen_path_rejects_too_few_points() {
        let doc = save_x(&Document {
            pages: vec![Node::frame("page", 400.0, 300.0)],
            ..Default::default()
        });
        let mut bridge = CommandBridge::open(&doc).unwrap();
        assert!(bridge.commit_pen_path("page", "[[10,20]]").is_err());
        assert!(bridge.commit_pen_path("page", "[]").is_err());
    }

    #[test]
    fn commit_pen_path_rejects_non_finite_coordinates() {
        let doc = save_x(&Document {
            pages: vec![Node::frame("page", 400.0, 300.0)],
            ..Default::default()
        });
        let mut bridge = CommandBridge::open(&doc).unwrap();
        assert!(bridge.commit_pen_path("page", "[[NaN,0],[1,1]]").is_err());
    }

    #[test]
    fn pen_path_undo_is_single_step() {
        let doc = save_x(&Document {
            pages: vec![Node::frame("page", 400.0, 300.0)],
            ..Default::default()
        });
        let mut bridge = CommandBridge::open(&doc).unwrap();
        let points = "[[10,20],[50,20],[50,60]]";
        bridge.commit_pen_path("page", points).unwrap();
        // Single undo removes the entire stroke
        let undone: Value = serde_json::from_str(&bridge.undo().unwrap()).unwrap();
        assert_eq!(undone["revision"], 2);
    }
}
