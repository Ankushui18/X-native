//! Review hardening: realistic full-workflow undo/redo integration test.
//!
//! Chain (all through the command log):
//!   Create -> Auto Layout -> Component -> Variable bind -> Boolean ->
//!   Mask -> Image placement -> Style -> Export
//! then: full Undo to empty, full Redo to final, Save, Reload — the
//! reloaded document must byte-match the saved final state.

use std::collections::HashMap;
use x_native::editor::{BoolOp, Editor};
use x_native::fileio::export_svg;
use x_native::fileio::{load_x, save_x};
use x_native::{
    bind_style, build_render_tree, export_pdf, AutoLayout, Color, CrossAlign, Document, ImageFit,
    ImagePlacement, LayoutDirection, LegacyStyle, Node, NodeKind, Paint, Variables,
};

fn snapshot(ed: &Editor) -> String {
    let mut d = Document::new();
    d.pages.push(ed.root.clone());
    save_x(&d)
}

#[test]
fn full_workflow_chain_undo_redo_save_reload() {
    let mut vars = Variables::default();
    vars.numbers.insert("gap".into(), 12.0);
    let mut styles: HashMap<String, LegacyStyle> = HashMap::new();
    styles.insert(
        "Brand".into(),
        LegacyStyle::Paint {
            fill: Paint::Solid(Color::from_rgb8(0x0d, 0x99, 0xff)),
        },
    );

    let mut ed = Editor::new(Node::frame("page", 800.0, 600.0));
    let empty_snapshot = snapshot(&ed);

    // 1. CREATE: rect + ellipse + a frame with children + an image
    ed.insert_node(
        "page",
        Node::rect("r1", 20.0, 20.0, 100.0, 80.0, Color::from_rgb8(255, 0, 0)),
    );
    ed.insert_node(
        "page",
        Node::ellipse("e1", 80.0, 40.0, 100.0, 100.0, Color::from_rgb8(0, 0, 255)),
    );
    ed.insert_node(
        "page",
        Node::frame("row", 220.0, 90.0)
            .child(Node::rect(
                "c1",
                0.0,
                0.0,
                40.0,
                40.0,
                Color::from_rgb8(0, 200, 0),
            ))
            .child(Node::rect(
                "c2",
                0.0,
                0.0,
                40.0,
                40.0,
                Color::from_rgb8(200, 0, 200),
            )),
    );
    ed.insert_node(
        "page",
        Node::image("img", 400.0, 40.0, 160.0, 120.0, "checker"),
    );

    // 2. AUTO LAYOUT on the row (undoable ReplaceNode), gap bound to variable
    assert!(ed.set_auto_layout(
        "row",
        Some(AutoLayout {
            direction: LayoutDirection::Horizontal,
            gap: 8.0,
            padding: [10.0; 4],
            align: CrossAlign::Center,
            gap_var: Some("gap".into()),
            ..Default::default()
        }),
        &vars
    ));

    // 3. COMPONENT from the row's first child
    ed.selection = vec!["c1".into()];
    assert!(ed.make_component("Chip"));

    // 3b. VARIANT: build a Button variant set + an instance, then switch
    // the instance variant through an undoable ReplaceNode
    ed.insert_node(
        "page",
        Node::component("m-def", "Button/Default", 80.0, 30.0).child(Node::rect(
            "bg-d",
            0.0,
            0.0,
            80.0,
            30.0,
            Color::from_rgb8(0x44, 0x44, 0x44),
        )),
    );
    ed.insert_node(
        "page",
        Node::component("m-pri", "Button/Primary", 80.0, 30.0).child(Node::rect(
            "bg-p",
            0.0,
            0.0,
            80.0,
            30.0,
            Color::from_rgb8(0x0d, 0x99, 0xff),
        )),
    );
    ed.insert_node(
        "page",
        Node::instance("btn", "Button/Default", 500.0, 300.0, 80.0, 30.0),
    );
    {
        let n = x_native::editor::find(&ed.root, "btn").unwrap().clone();
        let mut after = n.clone();
        assert!(x_native::components::switch_variant(
            &mut after,
            "Button/Primary"
        ));
        ed.replace_node("btn", after);
    }

    // 4. VARIABLE: bind r1's fill to a color variable (undoable SetFill)
    vars.colors
        .insert("accent".into(), Color::from_rgb8(0xf3, 0x9c, 0x12));
    ed.set_fill("r1", Paint::Variable("accent".into()));

    // 5. BOOLEAN: union r1 + e1 -> vector node
    ed.selection = vec!["r1".into(), "e1".into()];
    let bool_id = ed.boolean_selected(BoolOp::Union).expect("union");

    // 6. MASK: mark the boolean result as a mask (undoable ReplaceNode)
    {
        let n = x_native::editor::find(&ed.root, &bool_id).unwrap().clone();
        let mut after = n.clone();
        after.is_mask = true;
        ed.replace_node(&bool_id, after);
    }

    // 7. IMAGE PLACEMENT: crop fit + focal + flip (undoable ReplaceNode)
    {
        let n = x_native::editor::find(&ed.root, "img").unwrap().clone();
        let mut after = n.clone();
        if let NodeKind::Image { fit, placement, .. } = &mut after.kind {
            *fit = ImageFit::Crop;
            *placement = ImagePlacement {
                focal: (0.3, 0.7),
                scale: 1.5,
                flip_h: true,
                flip_v: false,
            };
        }
        ed.replace_node("img", after);
    }

    // 8. STYLE: bind the Brand paint style to c2 (undoable via ReplaceNode)
    {
        let n = x_native::editor::find(&ed.root, "c2").unwrap().clone();
        let mut after = n.clone();
        bind_style(&mut after, "Brand", &styles["Brand"]);
        ed.replace_node("c2", after);
    }

    let final_snapshot = snapshot(&ed);
    assert_ne!(final_snapshot, empty_snapshot);
    let depth = ed.undo_depth();
    assert!(depth >= 13, "every step logged a command (depth {depth})");

    // 9. EXPORT works on the final state (svg + pdf, no panic, non-trivial)
    let svg = export_svg(&ed.root, &vars);
    assert!(
        svg.contains("<path") && svg.contains("<mask"),
        "svg has boolean path + mask"
    );
    let tree = build_render_tree(&ed.root, &vars);
    let pdf = export_pdf(&tree, 800.0, 600.0);
    assert!(
        pdf.len() > 500 && String::from_utf8_lossy(&pdf).contains("W n"),
        "pdf has clip ops"
    );

    // ---- FULL UNDO: must return exactly to the empty page ----
    while ed.undo() {}
    assert_eq!(
        snapshot(&ed),
        empty_snapshot,
        "undo chain returns to the initial document"
    );
    assert_eq!(ed.root.children.len(), 0);

    // ---- FULL REDO: must return exactly to the final state ----
    while ed.redo() {}
    assert_eq!(
        snapshot(&ed),
        final_snapshot,
        "redo chain returns to the final document"
    );

    // spot-check semantic state after redo
    let img = x_native::editor::find(&ed.root, "img").unwrap();
    match &img.kind {
        NodeKind::Image { fit, placement, .. } => {
            assert_eq!(*fit, ImageFit::Crop);
            assert_eq!(placement.focal, (0.3, 0.7));
            assert!(placement.flip_h);
        }
        k => panic!("img is {k:?}"),
    }
    let b = x_native::editor::find(&ed.root, &bool_id).unwrap();
    assert!(b.is_mask, "boolean-result mask survived undo/redo");
    let c2 = x_native::editor::find(&ed.root, "c2").unwrap();
    assert_eq!(
        c2.bindings.get("style:paint").map(String::as_str),
        Some("Brand")
    );
    assert_eq!(c2.fill, Paint::Solid(Color::from_rgb8(0x0d, 0x99, 0xff)));
    let btn = x_native::editor::find(&ed.root, "btn").unwrap();
    match &btn.kind {
        NodeKind::Instance { component } => assert_eq!(
            component, "Button/Primary",
            "variant switch survived undo/redo"
        ),
        k => panic!("btn is {k:?}"),
    }

    // ---- SAVE + RELOAD: byte-exact round trip of the final state ----
    let mut doc = Document::new();
    doc.variables = vars.clone();
    doc.styles = styles.clone();
    doc.pages.push(ed.root.clone());
    let text = save_x(&doc);
    let re = load_x(&text).expect("reload");
    assert_eq!(save_x(&re), text, "save(load(save)) byte-identical");
    // placement survived disk round trip
    let img2 = x_native::editor::find(&re.pages[0], "img").unwrap();
    match &img2.kind {
        NodeKind::Image { placement, .. } => {
            assert_eq!(placement.focal, (0.3, 0.7));
            assert_eq!(placement.scale, 1.5);
            assert!(placement.flip_h && !placement.flip_v);
        }
        k => panic!("reloaded img is {k:?}"),
    }
    assert_eq!(re.styles.len(), 1);
}
