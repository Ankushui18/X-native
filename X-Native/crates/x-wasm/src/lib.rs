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
use x_core::{Color, Node};
use x_editor::Editor;
use x_format::{figbinary, serialize::save_x, sketch, svg_import};

/// One command in the foundation WASM proof of concept. The tagged Serde shape
/// is a JS object (`{ type: "createNode", nodeType: "rect", x, y }`), not a
/// JSON string. This is intentionally much smaller than the production editor
/// command vocabulary.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum Command {
    #[serde(rename = "createNode")]
    CreateNode {
        #[serde(rename = "nodeType")]
        node_type: String,
        x: f64,
        y: f64,
    },
}

/// Small renderable document projection returned by the WASM POC.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentState {
    pub revision: u32,
    pub can_undo: bool,
    pub nodes: Vec<NodeSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSnapshot {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Host-testable proof-of-concept owner of an x-editor Editor. Production web
/// documents continue to use the established, separately admitted session.
pub struct PocEngine {
    editor: Editor,
    revision: u32,
    next_id: u32,
}

impl PocEngine {
    pub fn new() -> Self {
        Self {
            editor: Editor::new(Node::frame("wasm-poc-page", 1200.0, 800.0)),
            revision: 0,
            next_id: 1,
        }
    }

    pub fn snapshot(&self) -> DocumentState {
        DocumentState {
            revision: self.revision,
            can_undo: self.editor.undo_depth() > 0,
            nodes: self
                .editor
                .root
                .children
                .iter()
                .map(|node| NodeSnapshot {
                    id: node.id.clone(),
                    name: node.name.clone(),
                    kind: "rect".into(),
                    x: node.transform.x,
                    y: node.transform.y,
                    w: node.w,
                    h: node.h,
                })
                .collect(),
        }
    }

    pub fn dispatch_command(&mut self, command: Command) -> Result<DocumentState, String> {
        let Command::CreateNode { node_type, x, y } = command;
        if node_type != "rect" && node_type != "rectangle" {
            return Err("the WASM POC currently creates rectangle nodes only".into());
        }
        if !x.is_finite() || !y.is_finite() {
            return Err("rectangle coordinates must be finite numbers".into());
        }
        let next_id = self
            .next_id
            .checked_add(1)
            .ok_or("WASM POC rectangle id limit reached")?;
        let revision = self
            .revision
            .checked_add(1)
            .ok_or("WASM POC revision limit reached")?;
        let id = format!("wasm-poc-rect-{}", self.next_id);
        let mut rectangle = Node::rect(&id, x, y, 100.0, 80.0, Color::BLACK);
        rectangle.name = format!("Rectangle {}", self.next_id);
        let page_id = self.editor.root.id.clone();
        if !self.editor.insert_node(&page_id, rectangle) {
            return Err("Rust editor rejected the rectangle command".into());
        }
        self.next_id = next_id;
        self.revision = revision;
        Ok(self.snapshot())
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

    thread_local! {
        /// Isolated test engine; it never shares the production import or
        /// RustDocumentSession state.
        static POC_ENGINE: RefCell<Option<super::PocEngine>> = const { RefCell::new(None) };
    }

    fn js_error(error: String) -> JsValue {
        JsValue::from_str(&error)
    }

    /// Start the isolated Phase 1 POC and return its initial typed snapshot.
    #[wasm_bindgen(js_name = init_wasm_engine)]
    pub fn init_wasm_engine() -> Result<JsValue, JsValue> {
        let state = POC_ENGINE.with(|slot| {
            let mut slot = slot.borrow_mut();
            *slot = Some(super::PocEngine::new());
            slot.as_ref()
                .expect("POC engine was just initialized")
                .snapshot()
        });
        serde_wasm_bindgen::to_value(&state).map_err(|error| js_error(error.to_string()))
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
        serde_wasm_bindgen::to_value(&state).map_err(|error| js_error(error.to_string()))
    }

    /// Independently versioned command session. V3 added Booleans, V4 added
    /// aligned strokes, V5 added bounded single-layer signed offsets, V6
    /// adds reversible Outline Stroke projections, V7 adds Phase 9 export
    /// and vector editing, and V8 adds Phase 10 advanced drawing tools
    /// (pen commit, pencil smoothing, eraser geometry splitting).
    #[wasm_bindgen(js_name = sessionBridgeVersion)]
    pub fn session_bridge_version() -> u32 {
        8
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

        /// Phase 9: Export a node to PNG, JPG, or PDF via the Rust render
        /// pipeline. Returns a JSON envelope with base64-encoded bytes.
        #[wasm_bindgen(js_name = exportNode)]
        pub fn export_node(&self, id: &str, format: &str, scale: f64) -> Result<String, JsValue> {
            self.bridge.export_node(id, format, scale).map_err(js_error)
        }

        /// Phase 9: Add a point to an existing vector path segment.
        #[wasm_bindgen(js_name = vectorAddPoint)]
        pub fn vector_add_point(
            &mut self,
            id: &str,
            segment_idx: u32,
            x: f64,
            y: f64,
        ) -> Result<String, JsValue> {
            self.bridge
                .vector_add_point(id, segment_idx as usize, x, y)
                .map_err(js_error)
        }

        /// Phase 9: Convert a corner point to smooth (or vice versa).
        #[wasm_bindgen(js_name = vectorConvertPoint)]
        pub fn vector_convert_point(
            &mut self,
            id: &str,
            anchor_idx: u32,
        ) -> Result<String, JsValue> {
            self.bridge
                .vector_convert_point(id, anchor_idx as usize)
                .map_err(js_error)
        }

        /// Phase 10: Commit a pen-drawn path as a vector node with smooth bezier
        /// curves. `points_json` is a JSON array of [x, y] pairs collected during
        /// the drag. Creates the node as ONE atomic undo step.
        #[wasm_bindgen(js_name = commitPenPath)]
        pub fn commit_pen_path(
            &mut self,
            parent_id: &str,
            points_json: &str,
        ) -> Result<String, JsValue> {
            self.bridge
                .commit_pen_path(parent_id, points_json)
                .map_err(js_error)
        }

        /// Phase 10: Commit a pencil-drawn stroke with RDP simplification and
        /// Catmull-Rom bezier fitting. `points_json` is the raw pointer samples.
        /// ONE atomic undo step.
        #[wasm_bindgen(js_name = smoothPencilPath)]
        pub fn smooth_pencil_path(
            &mut self,
            parent_id: &str,
            points_json: &str,
            tolerance: f64,
        ) -> Result<String, JsValue> {
            self.bridge
                .smooth_pencil_path(parent_id, points_json, tolerance)
                .map_err(js_error)
        }

        /// Phase 10: Erase geometry from a vector node along a stroke path.
        /// Segments within `radius` of the erase path are removed, splitting the
        /// vector. ONE atomic undo step.
        #[wasm_bindgen(js_name = eraseGeometry)]
        pub fn erase_geometry(
            &mut self,
            target_id: &str,
            erase_points_json: &str,
            radius: f64,
        ) -> Result<String, JsValue> {
            self.bridge
                .erase_geometry(target_id, erase_points_json, radius)
                .map_err(js_error)
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
    fn poc_engine_rejects_unknown_types_and_non_finite_coordinates_without_mutating() {
        let mut engine = PocEngine::new();
        assert!(engine
            .dispatch_command(Command::CreateNode {
                node_type: "ellipse".into(),
                x: 0.0,
                y: 0.0,
            })
            .is_err());
        assert!(engine
            .dispatch_command(Command::CreateNode {
                node_type: "rect".into(),
                x: f64::NAN,
                y: 0.0,
            })
            .is_err());
        assert_eq!(engine.snapshot().revision, 0);
        assert!(engine.snapshot().nodes.is_empty());
    }

    #[test]
    fn the_version_names_the_rust_engine() {
        assert!(engine_version().contains("rust"));
    }
}
