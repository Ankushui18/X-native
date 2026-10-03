//! Import conformance — the SAME semantic assertions across every
//! importer (review: "don't let  → Node, SVG → Node,  → Node
//! each develop completely different semantics").
//!
//! Every importer produces a fixture containing the same logical scene —
//! a red 100×50 rect at (10,20) and a text run — and every one must
//! come out of `lower()` with identical semantics:
//!   * unique, non-empty, sanitized ids
//!   * unstyled text = BLACK fill (never transparent)
//!   * pages sized > 0 (auto-enveloped when the source doesn't say)
//!   * opacity within [0,1]
//!   * geometry finite everywhere
//!   * the document round-trips byte-stable through the .x format
//!   * the render IR produces paint commands (imports actually RENDER)

use std::collections::HashSet;
use x_native::fileio::{import_figma_json, import_png, import_sketch, import_svg, load_x, save_x};
use x_native::{build_render_tree, Color, Document, Node, NodeKind, Paint, Variables};

// ---------------------------------------------------------- shared checks

fn walk<'a>(n: &'a Node, f: &mut dyn FnMut(&'a Node)) {
    f(n);
    for c in &n.children {
        walk(c, f);
    }
}

/// The conformance contract. Every importer's output goes through this.
fn assert_conformant(doc: &Document, source: &str) {
    assert!(!doc.pages.is_empty(), "{source}: no pages");
    let mut ids = HashSet::new();
    for page in &doc.pages {
        assert!(
            page.w > 0.0 && page.h > 0.0,
            "{source}: page {} is {}x{}",
            page.id,
            page.w,
            page.h
        );
        walk(page, &mut |n| {
            assert!(!n.id.is_empty(), "{source}: empty id");
            assert!(ids.insert(n.id.clone()), "{source}: duplicate id {}", n.id);
            assert!(
                n.id.chars()
                    .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == ':'),
                "{source}: unsanitized id {:?}",
                n.id
            );
            assert!(
                (0.0..=1.0).contains(&n.opacity),
                "{source}: opacity {} on {}",
                n.opacity,
                n.id
            );
            for v in [n.transform.x, n.transform.y, n.w, n.h, n.transform.rotation] {
                assert!(v.is_finite(), "{source}: non-finite geometry on {}", n.id);
            }
            if let NodeKind::Text { .. } = n.kind {
                assert_ne!(
                    n.fill,
                    Paint::Solid(Color::TRANSPARENT),
                    "{source}: text {} imported transparent",
                    n.id
                );
            }
        });
    }
    // .x round trip is byte-stable
    let text = save_x(doc);
    let re = load_x(&text).unwrap_or_else(|e| panic!("{source}: reload failed: {e}"));
    assert_eq!(save_x(&re), text, "{source}: .x round trip not byte-stable");
    // the import actually renders: at least one paint command
    let tree = build_render_tree(&doc.pages[0], &Variables::default());
    assert!(!tree.commands.is_empty(), "{source}: render IR is empty");
}

// ------------------------------------------------------------- fixtures

fn sketch_fixture() -> Vec<u8> {
    // stored-entry zip (mirrors zipfile.rs test helper)
    fn zip_of(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, content) in files {
            let off = out.len() as u32;
            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            out.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            out.extend_from_slice(&crc32(content).to_le_bytes());
            out.extend_from_slice(&(content.len() as u32).to_le_bytes());
            out.extend_from_slice(&(content.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(content);
            central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            central.extend_from_slice(&[20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            central.extend_from_slice(&crc32(content).to_le_bytes());
            central.extend_from_slice(&(content.len() as u32).to_le_bytes());
            central.extend_from_slice(&(content.len() as u32).to_le_bytes());
            central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            central.extend_from_slice(&[0; 12]);
            central.extend_from_slice(&off.to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }
        let cd_off = out.len() as u32;
        let cd_size = central.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&cd_size.to_le_bytes());
        out.extend_from_slice(&cd_off.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }
    let docjson = br#"{"_class":"document","do_objectID":"doc-1","pages":[{"_class":"MSJSONFileReference","_ref":"pages/page-1"}]}"#;
    let page = r#"{"_class":"page","do_objectID":"page 1!","layers":[
        {"_class":"rectangle","do_objectID":"r 1","isVisible":true,
         "frame":{"x":10,"y":20,"width":100,"height":50},
         "style":{"fills":[{"isEnabled":true,"fillType":0,"color":{"red":1,"green":0,"blue":0,"alpha":1}}]}},
        {"_class":"rectangle","do_objectID":"r 1","isVisible":true,
         "frame":{"x":150,"y":20,"width":100,"height":50},"style":{"fills":[]}},
        {"_class":"text","do_objectID":"t1","isVisible":true,
         "frame":{"x":10,"y":90,"width":200,"height":20},
         "attributedString":{"string":"conformance"},"style":{"fills":[]}}
    ]}"#;
    zip_of(&[
        ("document.json", docjson.as_slice()),
        ("pages/page-1.json", page.as_bytes()),
    ])
}

const FIGMA_FIXTURE: &str = r##"{
  "components": {},
  "document": { "id": "0:0", "type": "DOCUMENT", "children": [{
    "id": "0:1", "type": "CANVAS",
    "children": [
      { "id": "1:1", "type": "RECTANGLE",
        "absoluteBoundingBox": {"x": 10, "y": 20, "width": 100, "height": 50},
        "fills": [{"type": "SOLID", "color": {"r": 1, "g": 0, "b": 0, "a": 1}}] },
      { "id": "1:1", "type": "RECTANGLE",
        "absoluteBoundingBox": {"x": 150, "y": 20, "width": 100, "height": 50},
        "fills": [] },
      { "id": "1:2", "type": "TEXT", "characters": "conformance",
        "absoluteBoundingBox": {"x": 10, "y": 90, "width": 200, "height": 20},
        "fills": [] }
    ] }] }
}"##;

const SVG_FIXTURE: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
  <rect id="r 1" x="10" y="20" width="100" height="50" fill="#ff0000"/>
  <rect id="r 1" x="150" y="20" width="100" height="50"/>
  <text id="t1" x="10" y="105" font-size="16">conformance</text>
</svg>"##;

fn png_fixture() -> Vec<u8> {
    let mut b = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    b.extend_from_slice(&13u32.to_be_bytes());
    b.extend_from_slice(b"IHDR");
    b.extend_from_slice(&64u32.to_be_bytes());
    b.extend_from_slice(&48u32.to_be_bytes());
    b.extend_from_slice(&[8, 6, 0, 0, 0]);
    b.extend_from_slice(&[0; 4]);
    b
}

// ---------------------------------------------------------------- tests

#[test]
fn sketch_import_is_conformant() {
    let doc = import_sketch(&sketch_fixture()).expect("sketch import");
    assert_conformant(&doc, "sketch");
    // format-specific spot checks THROUGH the shared contract:
    let page = &doc.pages[0];
    assert_eq!(
        page.children[0].fill,
        Paint::Solid(Color::new([1.0, 0.0, 0.0, 1.0]))
    );
    assert_eq!(page.children[0].transform.x, 10.0);
}

#[test]
fn figma_import_is_conformant() {
    let doc = import_figma_json(FIGMA_FIXTURE).expect("figma import");
    assert_conformant(&doc, "figma");
}

#[test]
fn svg_import_is_conformant() {
    let root = import_svg(SVG_FIXTURE).expect("svg import");
    let mut doc = Document::new();
    doc.pages.push(root);
    assert_conformant(&doc, "svg");
    assert_eq!(
        doc.pages[0].children[0].fill,
        Paint::Solid(Color::from_rgb8(0xff, 0, 0))
    );
}

#[test]
fn png_import_is_conformant() {
    let doc = import_png("shot", &png_fixture()).expect("png import");
    assert_conformant(&doc, "png");
    let img = &doc.pages[0].children[0];
    assert_eq!((img.w, img.h), (64.0, 48.0));
}

#[test]
fn same_scene_same_semantics_across_importers() {
    // The heart of the review item: identical logical content from three
    // different source formats must land with identical semantics.
    let sk = import_sketch(&sketch_fixture()).unwrap();
    let fg = import_figma_json(FIGMA_FIXTURE).unwrap();
    let sv = {
        let mut d = Document::new();
        d.pages.push(import_svg(SVG_FIXTURE).unwrap());
        d
    };

    for (name, doc) in [("sketch", &sk), ("figma", &fg), ("svg", &sv)] {
        let page = &doc.pages[0];
        // red rect kept its fill in every format
        let red = page
            .children
            .iter()
            .find(|c| {
                c.fill == Paint::Solid(Color::new([1.0, 0.0, 0.0, 1.0]))
                    || c.fill == Paint::Solid(Color::from_rgb8(0xff, 0, 0))
            })
            .unwrap_or_else(|| panic!("{name}: no red rect"));
        assert_eq!((red.w, red.h), (100.0, 50.0), "{name}: rect size");
        // duplicate source ids were deduped the same way (suffix -2)
        let dedup = page
            .children
            .iter()
            .filter(|c| c.id.starts_with("r-1") || c.id.starts_with("1:1"))
            .count();
        assert_eq!(dedup, 2, "{name}: both rects present after id dedup");
        // text imported black in every format
        let text = page
            .children
            .iter()
            .find(|c| matches!(c.kind, NodeKind::Text { .. }))
            .unwrap_or_else(|| panic!("{name}: no text node"));
        assert_eq!(text.fill, Paint::Solid(Color::BLACK), "{name}: text fill");
        match &text.kind {
            NodeKind::Text { text: t } => assert_eq!(t, "conformance"),
            _ => unreachable!(),
        }
    }
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & 0u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}
