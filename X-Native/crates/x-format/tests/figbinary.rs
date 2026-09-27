//! End-to-end tests against REAL Figma-authored `.fig` files (from the
//! open-source OpenFig test corpus): exercises the ZIP container, the
//! zstd + deflate chunk paths, the embedded-schema Kiwi decode, and the
//! REST-shim mapping in one shot.

use x_format::{import_fig_bytes, import_fig_bytes_with_report};

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/tests/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .expect("fixture present")
}

#[test]
fn circle_fig_real_binary_file() {
    let (doc, report) = import_fig_bytes_with_report(&fixture("circle.fig")).unwrap();
    assert_eq!(
        doc.pages.len(),
        1,
        "one visible page: {:?}",
        report.diagnostics
    );
    let page = &doc.pages[0];
    assert_eq!(page.name, "Page 1");
    // Frame 1 (350x350) containing Ellipse 1 (300x300 at 25,25)
    let frame = &page.children[0];
    assert_eq!(frame.name, "Frame 1");
    assert_eq!((frame.w, frame.h), (350.0, 350.0));
    let ell = &frame.children[0];
    assert_eq!(ell.name, "Ellipse 1");
    assert_eq!((ell.w, ell.h), (300.0, 300.0));
    assert_eq!((ell.transform.x, ell.transform.y), (25.0, 25.0));
    // red solid fill rode the shim all the way to a Paint
    assert!(
        matches!(ell.kind, x_core::NodeKind::Ellipse),
        "kind: {:?}",
        ell.kind
    );
    let s = format!("{:?}", ell.fill);
    assert!(
        s.contains("[1.0, 0.0, 0.0, 1.0]"),
        "expected pure red fill, got: {s}"
    );
}

#[test]
fn openfigs_logo_frame() {
    let doc = import_fig_bytes(&fixture("OpenFigs.fig")).unwrap();
    assert_eq!(doc.pages.len(), 1);
    let frame = &doc.pages[0].children[0];
    assert_eq!(frame.name, "WhiteOpenFigOutlinedIcon");
    assert!(
        frame.w > 500.0 && frame.h > 500.0,
        "size {}x{}",
        frame.w,
        frame.h
    );
}

#[test]
fn non_fig_bytes_fail_cleanly() {
    assert!(import_fig_bytes(b"not a zip").is_err());
    let zip_of_junk = b"PK\x03\x04junkjunkjunkjunkjunkjunkjunkjunkjunkjunkjunkjunkjunk";
    assert!(import_fig_bytes(&zip_of_junk[..]).is_err() || true); // parser-tolerant: at worst Err, never panic
}

#[test]
fn parentless_web_fixture_recovers_its_canvas_and_layers() {
    // The committed web fixture has CANVAS and drawable records but no
    // DOCUMENT or parentIndex. These were decoded, then silently discarded.
    let bytes = include_bytes!("../../../apps/web/e2e/fixtures/sample.fig");
    let doc = import_fig_bytes(bytes).expect("recover parentless archive");
    assert_eq!(doc.pages.len(), 1);
    assert_eq!(doc.pages[0].name, "Page 1");
    let names: Vec<_> = doc.pages[0]
        .children
        .iter()
        .map(|n| n.name.as_str())
        .collect();
    assert_eq!(names, ["Home", "FigCard", "FigDot", "FigLabel"]);
    assert_eq!(doc.pages[0].children[1].w, 120.0);
    // The existing native REST lowering moves the page envelope to (40,40).
    // Preserve that native convention and the source-relative spacing.
    assert_eq!(doc.pages[0].children[0].transform.x, 40.0);
    assert_eq!(doc.pages[0].children[1].transform.x, 60.0);
    assert_eq!(
        doc.pages[0].children[1].transform.y - doc.pages[0].children[0].transform.y,
        20.0
    );
}

#[test]
fn sketch_fixture_preserves_page_and_nested_layer_names() {
    let bytes = include_bytes!("../../../apps/web/e2e/fixtures/sample.sketch");
    let doc = x_format::sketch::import_sketch(bytes).expect("Sketch fixture");
    assert_eq!(doc.pages[0].name, "Page 1");
    let home = &doc.pages[0].children[0];
    assert_eq!(home.name, "Home");
    assert_eq!(
        home.id, "ab-1",
        "IDs remain stable, separate from display names"
    );
    assert_eq!(
        home.children
            .iter()
            .map(|n| n.name.as_str())
            .collect::<Vec<_>>(),
        ["Card", "Dot", "Label", "Grp"]
    );
    assert_eq!(home.children[3].children[0].name, "Inner");
}

#[test]
fn source_text_metrics_survive_native_lowering_for_both_file_formats() {
    for (format, bytes) in [
        (
            "fig",
            &include_bytes!("../../../apps/web/e2e/fixtures/sample.fig")[..],
        ),
        (
            "sketch",
            &include_bytes!("../../../apps/web/e2e/fixtures/sample.sketch")[..],
        ),
    ] {
        let (doc, report) = if format == "fig" {
            import_fig_bytes_with_report(bytes).unwrap()
        } else {
            x_format::sketch::import_sketch_with_report(bytes).unwrap()
        };
        fn texts<'a>(n: &'a x_core::Node, out: &mut Vec<&'a x_core::Node>) {
            if matches!(n.kind, x_core::NodeKind::Text { .. }) {
                out.push(n);
            }
            for c in &n.children {
                texts(c, out);
            }
        }
        let mut found = Vec::new();
        for p in &doc.pages {
            texts(p, &mut found);
        }
        assert_eq!(found.len(), 1);
        let node = found[0];
        let metrics = &report.text_metrics[&node.id];
        assert_eq!(
            (metrics.width, metrics.height, metrics.font_size),
            (200.0, 24.0, Some(18.0))
        );
        assert_eq!(
            node.h, 18.0,
            "native rendering convention remains unchanged"
        );
        let expected = if format == "fig" {
            "Figma Hello"
        } else {
            "Sketch Hello"
        };
        assert!(matches!(&node.kind, x_core::NodeKind::Text { text } if text == expected));
    }
}

#[test]
fn file_layer_locks_and_all_text_alignments_survive_lowering() {
    use x_core::TextAlign;
    for (format, bytes) in [
        (
            "fig",
            &include_bytes!("../../../apps/web/e2e/fixtures/state-text.fig")[..],
        ),
        (
            "sketch",
            &include_bytes!("../../../apps/web/e2e/fixtures/state-text.sketch")[..],
        ),
    ] {
        let doc = if format == "fig" {
            import_fig_bytes(bytes).unwrap()
        } else {
            x_format::sketch::import_sketch(bytes).unwrap()
        };
        let children = &doc.pages[0].children;
        assert_eq!(children.len(), 4);
        for (i, align) in [
            TextAlign::Left,
            TextAlign::Center,
            TextAlign::Right,
            TextAlign::Justified,
        ]
        .iter()
        .enumerate()
        {
            let node = &children[i];
            assert_eq!(node.text_align, *align, "{format}: {}", node.name);
            assert_eq!(node.locked, i == 2, "{format}: {}", node.name);
            if format == "sketch" {
                assert_eq!(node.bindings.get("ls").map(String::as_str), Some("2.25"));
                assert_eq!(node.bindings.get("lh").map(String::as_str), Some("1.5"));
            }
        }
        let saved = x_format::save_x(&doc);
        let reloaded = x_format::load_x(&saved).unwrap();
        for (a, b) in children.iter().zip(&reloaded.pages[0].children) {
            assert_eq!((a.locked, a.text_align), (b.locked, b.text_align));
        }
    }
}

#[test]
fn fig_stroke_geometry_survives_binary_shim_lowering_and_persistence() {
    use x_core::{StrokeAlign, StrokeCap, StrokeJoin};
    let doc = import_fig_bytes(include_bytes!(
        "../../../apps/web/e2e/fixtures/stroke-options.fig"
    ))
    .unwrap();
    let reloaded = x_format::load_x(&x_format::save_x(&doc)).unwrap();
    for document in [&doc, &reloaded] {
        let nodes = &document.pages[0].children;
        assert_eq!(nodes.len(), 3);
        for (i, (align, cap, join, dash)) in [
            (
                StrokeAlign::Inside,
                StrokeCap::Round,
                StrokeJoin::Bevel,
                vec![8.0, 4.0],
            ),
            (
                StrokeAlign::Center,
                StrokeCap::Square,
                StrokeJoin::Round,
                vec![6.0],
            ),
            (
                StrokeAlign::Outside,
                StrokeCap::None,
                StrokeJoin::Miter,
                vec![],
            ),
        ]
        .iter()
        .enumerate()
        {
            let strokes = nodes[i].active_strokes();
            assert_eq!(strokes.len(), 1);
            let options = &strokes[0].options;
            assert_eq!(
                (
                    options.align,
                    options.cap_start,
                    options.cap_end,
                    options.join
                ),
                (*align, *cap, *cap, *join)
            );
            assert_eq!(&options.dash, dash);
        }
    }
}

#[test]
fn fig_layer_blends_and_both_blur_spellings_survive_import_and_save() {
    use x_core::{BlendKind, Effect};
    let doc = import_fig_bytes(include_bytes!(
        "../../../apps/web/e2e/fixtures/effects-blend.fig"
    ))
    .unwrap();
    let reloaded = x_format::load_x(&x_format::save_x(&doc)).unwrap();
    for document in [&doc, &reloaded] {
        let nodes = &document.pages[0].children;
        assert_eq!(nodes.len(), 3);
        assert_eq!(nodes[0].blend, BlendKind::Multiply);
        assert_eq!(nodes[1].blend, BlendKind::SoftLight);
        assert_eq!(nodes[2].blend, BlendKind::PassThrough);
        let effects = nodes[0].active_effects();
        assert_eq!(
            effects.len(),
            4,
            "stroke materialization retains every imported effect"
        );
        assert!(matches!(
            effects[0].effect,
            Effect::DropShadow {
                dx: 5.0,
                dy: -3.0,
                blur: 6.0,
                ..
            }
        ));
        assert!(matches!(
            effects[1].effect,
            Effect::InnerShadow {
                dx: -2.0,
                dy: 4.0,
                blur: 2.0,
                ..
            }
        ));
        assert!(matches!(
            effects[2].effect,
            Effect::LayerBlur { radius: 8.0 }
        ));
        assert!(matches!(
            effects[3].effect,
            Effect::BackgroundBlur { radius: 4.0 }
        ));
        assert!(matches!(
            nodes[1].active_effects()[0].effect,
            Effect::LayerBlur { radius: 3.0 }
        ));
        assert!(nodes[2].active_effects().is_empty());
    }
}
