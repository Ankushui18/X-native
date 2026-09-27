//! WebAssembly bridge: the first slice connecting the Rust engine to the web app.
//!
//! Scope is deliberately one capability — reading a design file — because the
//! behaviour suite in `apps/web/e2e/behaviour.mjs` already pins what the
//! TypeScript importers produce. That gives an equivalence oracle: the Rust
//! path can be proven against the same checks before anything is deleted.
//! See `docs/ARCHITECTURE_BOUNDARY.md`.
//!
//! The bridge is intentionally thin. It owns no document logic; it converts
//! bytes to a `.x` JSON string using `x-format`'s existing, tested importers
//! and serializer. Anything more would be a second implementation, which is
//! the thing the boundary rule exists to prevent.
//!
//! Every entry point is pure: bytes in, string out, no filesystem. That is why
//! the `*_bytes` importers are used rather than the path-based convenience
//! wrappers, which call `std::fs` and cannot run under wasm.

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
            let metrics: serde_json::Map<String, serde_json::Value> = report.text_metrics.iter().map(|(id, m)| {
                (id.clone(), serde_json::json!({ "width": m.width, "height": m.height, "fontSize": m.font_size }))
            }).collect();
            let metadata = serde_json::json!({ "version": 1, "nodes": metrics });
            let coordinates = if source == "fig" {
                let nodes: serde_json::Map<String, serde_json::Value> = report
                    .source_positions
                    .iter()
                    .map(|(id, (x, y))| (id.clone(), serde_json::json!({ "x": x, "y": y })))
                    .collect();
                format!(
                    ",\"figmaCoordinates\":{}",
                    serde_json::json!({ "version": 1, "nodes": nodes })
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
    envelope(svg_import::import_svg(text).map(|page| {
        let doc = x_core::Document {
            pages: vec![page],
            ..Default::default()
        };
        save_x(&doc)
    }))
}

/// Build identifier, so the web app can report which engine answered and a
/// bridged build is distinguishable from the TypeScript path at a glance.
pub fn engine_version() -> String {
    format!("x-wasm {} (rust)", env!("CARGO_PKG_VERSION"))
}

// The wasm_bindgen surface is a thin re-export of the functions above, so the
// native `cargo test` build does not need wasm-bindgen present at all.
#[cfg(target_arch = "wasm32")]
mod bindings {
    use wasm_bindgen::prelude::*;

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
        assert!(
            sketch.get("figmaCoordinates").is_none(),
            "do not apply FIG coordinate semantics to Sketch"
        );
    }

    #[test]
    fn the_version_names_the_rust_engine() {
        assert!(engine_version().contains("rust"));
    }
}
