//! Review hardening pass: mask semantics across node kinds and features.
//!
//! standard rule implemented in the IR: a node with `is_mask` clips its
//! FOLLOWING SIBLINGS inside the same parent. These tests prove the rule
//! composes with images, vectors, groups, components+auto-layout, booleans,
//! gradients, effects, and both exporters (SVG structural, PDF sink runs).

use x_native::fileio::export_svg;
use x_native::{
    apply_layout_recursive, build_render_tree, export_pdf, AutoLayout, Color, CrossAlign, Effect,
    GradSpace, LayoutDirection, Node, Paint, PathCmd, RenderCommand, Variables,
};

fn kinds(tree: &x_native::RenderTree) -> Vec<&'static str> {
    tree.commands
        .iter()
        .map(|c| match c {
            RenderCommand::FillPath { .. } => "fill",
            RenderCommand::StrokePath { .. } => "stroke",
            RenderCommand::PushLayer { .. } => "layer",
            RenderCommand::PushClip { .. } => "clip",
            RenderCommand::PopLayer => "pop",
            RenderCommand::Glyphs { .. } => "glyphs",
            RenderCommand::Image { .. } => "image",
        })
        .collect()
}

/// clip must open before the masked sibling's paint and close after it
fn assert_clip_wraps(tree: &x_native::RenderTree, inner: &str) {
    let ks = kinds(tree);
    let ci = ks
        .iter()
        .position(|k| *k == "clip")
        .expect("mask emits PushClip");
    let ii = ks
        .iter()
        .position(|k| *k == inner)
        .unwrap_or_else(|| panic!("no {inner} command"));
    let pi = ks.iter().rposition(|k| *k == "pop").expect("no PopLayer");
    assert!(ci < ii, "clip {ci} must open before {inner} {ii}: {ks:?}");
    assert!(pi > ii, "pop {pi} must close after {inner} {ii}: {ks:?}");
}

/// The alpha scope a mask pushes: one `PushLayer` per mask whose type asks
/// for a uniform figure. Everything else in these fixtures paints at 1.0, so
/// the list is the mask's own alpha.
fn mask_alphas(tree: &x_native::RenderTree) -> Vec<f32> {
    tree.commands
        .iter()
        .filter_map(|c| match c {
            RenderCommand::PushLayer { alpha, .. } => Some(*alpha),
            _ => None,
        })
        .collect()
}

/// the Mask-section types (help 360040450253): Vector is outline only —
/// *"the mask's translucency is ignored"* — while Alpha and Luminance key the
/// masked result on the mask's own opacity / brightness.
#[test]
fn mask_types_scale_the_masked_scope() {
    let doc = |kind: x_native::MaskType, fill: Color, opacity: f32| {
        let mut m = Node::rect("m", 0.0, 0.0, 100.0, 100.0, fill)
            .mask(true)
            .mask_type(kind);
        m.opacity = opacity;
        Node::frame("page", 400.0, 300.0)
            .child(m)
            .child(Node::image("photo", 0.0, 0.0, 200.0, 150.0, "checker"))
    };
    let half_black = Color::new([0.0, 0.0, 0.0, 0.5]);

    // Vector: the clip is the whole story, translucency or not
    let tree = build_render_tree(
        &doc(x_native::MaskType::Vector, half_black, 1.0),
        &Variables::default(),
    );
    assert_clip_wraps(&tree, "image");
    assert!(mask_alphas(&tree).is_empty(), "Vector ignores opacity");

    // Alpha: the mask fill's own alpha scales the scope
    let tree = build_render_tree(
        &doc(x_native::MaskType::Alpha, half_black, 1.0),
        &Variables::default(),
    );
    assert_clip_wraps(&tree, "image");
    assert_eq!(mask_alphas(&tree), vec![0.5], "50% fill reveals half");

    // …and the mask layer's own opacity multiplies in (0% reveals nothing)
    let tree = build_render_tree(
        &doc(x_native::MaskType::Alpha, half_black, 0.0),
        &Variables::default(),
    );
    assert_eq!(mask_alphas(&tree), vec![0.0], "an invisible mask hides all");

    // Luminance: the fill's brightness — black hides, so 0.0
    let tree = build_render_tree(
        &doc(x_native::MaskType::Luminance, half_black, 1.0),
        &Variables::default(),
    );
    assert_clip_wraps(&tree, "image");
    assert_eq!(mask_alphas(&tree), vec![0.0], "black masks nothing through");

    // a container mask has no fill of its own to key on: the clip does the work
    let mut group =
        Node::group("g", 0.0, 0.0).child(Node::rect("gm", 0.0, 0.0, 40.0, 40.0, Color::WHITE));
    group.is_mask = true;
    group.mask_type = x_native::MaskType::Alpha;
    let doc2 = Node::frame("page", 400.0, 300.0)
        .child(group)
        .child(Node::image("photo", 0.0, 0.0, 200.0, 150.0, "checker"));
    let tree = build_render_tree(&doc2, &Variables::default());
    assert_clip_wraps(&tree, "image");
    assert!(mask_alphas(&tree).is_empty(), "a group keeps full alpha");
}

#[test]
fn mask_clips_image_sibling() {
    let doc = Node::frame("page", 400.0, 300.0)
        .child(Node::ellipse("hole", 20.0, 20.0, 100.0, 100.0, Color::WHITE).mask(true))
        .child(Node::image("photo", 0.0, 0.0, 200.0, 150.0, "checker"));
    let tree = build_render_tree(&doc, &Variables::default());
    assert_clip_wraps(&tree, "image");
}

#[test]
fn mask_clips_vector_sibling() {
    let tri = vec![
        PathCmd::MoveTo(0.0, 80.0),
        PathCmd::LineTo(40.0, 0.0),
        PathCmd::LineTo(80.0, 80.0),
        PathCmd::Close,
    ];
    let doc = Node::frame("page", 400.0, 300.0)
        .child(Node::rect("m", 0.0, 0.0, 60.0, 60.0, Color::WHITE).mask(true))
        .child(Node::vector("v", 10.0, 10.0, 80.0, 80.0, tri));
    let tree = build_render_tree(&doc, &Variables::default());
    assert_clip_wraps(&tree, "fill");
}

#[test]
fn mask_clips_group_subtree() {
    // group AFTER the mask: every paint inside the group must be clipped
    let doc = Node::frame("page", 400.0, 300.0)
        .child(Node::ellipse("m", 0.0, 0.0, 120.0, 120.0, Color::WHITE).mask(true))
        .child(
            Node::group("g", 120.0, 60.0)
                .child(Node::rect(
                    "r1",
                    0.0,
                    0.0,
                    50.0,
                    50.0,
                    Color::from_rgb8(255, 0, 0),
                ))
                .child(Node::rect(
                    "r2",
                    60.0,
                    0.0,
                    50.0,
                    50.0,
                    Color::from_rgb8(0, 255, 0),
                )),
        );
    let tree = build_render_tree(&doc, &Variables::default());
    let ks = kinds(&tree);
    let ci = ks.iter().position(|k| *k == "clip").expect("clip");
    let pi = ks.iter().rposition(|k| *k == "pop").expect("pop");
    let fills: Vec<usize> = ks
        .iter()
        .enumerate()
        .filter(|(_, k)| **k == "fill")
        .map(|(i, _)| i)
        .collect();
    assert_eq!(fills.len(), 2, "both group children painted: {ks:?}");
    for f in fills {
        assert!(
            f > ci && f < pi,
            "group fill {f} outside clip [{ci},{pi}]: {ks:?}"
        );
    }
}

#[test]
fn mask_clips_component_instance_with_auto_layout() {
    // the review's hard case: Mask └── Component └── Auto Layout.
    // master (hidden elsewhere) has an auto-layout row; instance follows a mask.
    let master = Node::component("master", "Chip", 160.0, 40.0).child({
        let mut row = Node::frame("row", 160.0, 40.0)
            .auto_layout(AutoLayout {
                direction: LayoutDirection::Horizontal,
                gap: 8.0,
                padding: [6.0; 4],
                align: CrossAlign::Center,
                ..Default::default()
            })
            .child(Node::rect(
                "dot",
                0.0,
                0.0,
                20.0,
                20.0,
                Color::from_rgb8(0, 0, 255),
            ))
            .child(Node::rect(
                "bar",
                0.0,
                0.0,
                60.0,
                20.0,
                Color::from_rgb8(255, 0, 255),
            ));
        apply_layout_recursive(&mut row, &Variables::default());
        row
    });
    let doc = Node::frame("page", 400.0, 300.0)
        .child(master)
        .child(Node::rect("m", 10.0, 10.0, 80.0, 30.0, Color::WHITE).mask(true))
        .child(Node::instance("chip1", "Chip", 10.0, 10.0, 160.0, 40.0));
    let tree = build_render_tree(&doc, &Variables::default());
    let ks = kinds(&tree);
    let ci = ks.iter().position(|k| *k == "clip").expect("clip emitted");
    let pi = ks.iter().rposition(|k| *k == "pop").expect("pop emitted");
    // instance resolves to the master's auto-laid-out children -> >=2 fills inside the clip
    let inside_fills = ks
        .iter()
        .enumerate()
        .filter(|(i, k)| **k == "fill" && *i > ci && *i < pi)
        .count();
    assert!(
        inside_fills >= 2,
        "instance content ({inside_fills} fills) must render inside the mask clip: {ks:?}"
    );
    // auto layout positioned the children (dot at padding, bar after gap)
    let master_row = &doc.children[0].children[0];
    assert_eq!(master_row.children[0].transform.x, 6.0);
    assert_eq!(master_row.children[1].transform.x, 6.0 + 20.0 + 8.0);
}

#[test]
fn mask_boolean_gradient_effect_chain_survives_export() {
    // boolean two shapes -> gradient fill + shadow on result -> put it
    // after a mask -> SVG + PDF export both must succeed and contain it.
    use x_native::editor::{BoolOp, Editor};
    let page = Node::frame("page", 400.0, 300.0)
        .child(Node::rect(
            "a",
            40.0,
            40.0,
            120.0,
            120.0,
            Color::from_rgb8(255, 0, 0),
        ))
        .child(Node::ellipse(
            "b",
            100.0,
            100.0,
            120.0,
            120.0,
            Color::from_rgb8(0, 0, 255),
        ));
    let mut ed = Editor::new(page);
    ed.selection = vec!["a".into(), "b".into()];
    let bool_id = ed
        .boolean_selected(BoolOp::Union)
        .expect("boolean produced a node");
    // style the boolean result: gradient + drop shadow
    {
        let n = x_native::editor::find_mut(&mut ed.root, &bool_id).unwrap();
        n.fill = Paint::LinearGradient {
            start: (0.0, 0.0),
            end: (n.w, 0.0),
            stops: vec![
                (0.0, Color::from_rgb8(255, 90, 0)),
                (1.0, Color::from_rgb8(142, 45, 226)),
            ],
            space: GradSpace::Srgb,
        };
        n.effects.push(Effect::DropShadow {
            dx: 3.0,
            dy: 4.0,
            blur: 8.0,
            color: Color::from_rgba8(0, 0, 0, 120),
        });
    }
    // insert a mask BEFORE it (clips it, standard order)
    let idx = ed
        .root
        .children
        .iter()
        .position(|c| c.id == bool_id)
        .unwrap();
    ed.root.children.insert(
        idx,
        Node::ellipse("m", 30.0, 30.0, 200.0, 200.0, Color::WHITE).mask(true),
    );

    // IR: clip wraps the boolean's gradient fill
    let vars = Variables::default();
    let tree = build_render_tree(&ed.root, &vars);
    assert_clip_wraps(&tree, "fill");

    // SVG: exports without panic, carries a gradient def + a path
    let svg = export_svg(&ed.root, &vars);
    assert!(
        svg.contains("<linearGradient"),
        "svg carries the gradient def"
    );
    assert!(svg.contains("<path"), "svg carries the boolean path");

    // PDF: sink runs over the SAME tree and emits path + gradient-ish fill ops
    let pdf = export_pdf(&tree, 400.0, 300.0);
    let txt = String::from_utf8_lossy(&pdf);
    assert!(txt.starts_with("%PDF-1.4"));
    assert!(
        txt.contains(" c\n") || txt.contains(" l\n"),
        "pdf contains path segments"
    );
}
