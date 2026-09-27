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

use x_format::{figbinary, serialize::save_x, sketch, svg_import};

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
    use wasm_bindgen::prelude::*;

    fn js_error(error: String) -> JsValue {
        JsValue::from_str(&error)
    }

    /// Separate version from the import-only bridge; older optional bundles
    /// still serve imports, but v1 sessions lacked the size delta/resize command.
    #[wasm_bindgen(js_name = sessionBridgeVersion)]
    pub fn session_bridge_version() -> u32 {
        2
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
    fn the_version_names_the_rust_engine() {
        assert!(engine_version().contains("rust"));
    }
}
