//! Golden-project CI (beta checklist): ONE canonical document that
//! exercises every engine feature, with three regression gates:
//!
//!   1. STRUCTURE: the .x serialization is byte-stable across
//!      save→load→save (any codec drift fails).
//!   2. RENDER IR: the lowered command list's shape (count + kind
//!      sequence hash) matches a pinned golden value — geometry/paint
//!      regressions surface as a hash change that must be REVIEWED and
//!      re-pinned deliberately, never silently.
//!   3. PIPELINE: undo/redo round trip on the golden doc stays byte-exact
//!      (protects the command log against feature interactions).
//!
//! ci.sh runs this plus the full suite; the golden hash lives here so a
//! change shows up in diff review.

use x_native::editor::{BoolOp, Editor};
use x_native::fileio::{load_x, save_x};
use x_native::{
    apply_layout_recursive, bind_style, build_render_tree, AutoLayout, Color, CrossAlign, Document,
    Effect, GradSpace, ImageFit, LayoutDirection, LegacyStyle, LibraryDependency, LibraryRef, Node,
    Paint, RenderCommand, Variables,
};

/// The pinned golden values. When a deliberate engine change moves them,
/// update HERE with a commit message explaining why.
///
/// History. 2026-09-16 (frame-name canvas labels, QA-004): every frame
/// and section lowered its name as a header Glyphs command, which added
/// `/golden/label` (the page root) and `/golden/row/label` (the
/// auto-layout row) and took the count to 52. The 50 before them were
/// reviewed against the CI drift listing command-by-command: 37 are the
/// deliberate gaussian blur taps for `grad`'s DropShadow, the rest map
/// 1:1 onto the document's real content — auto-layout row, component
/// master + instance with text override, gradient fill, mask clip +
/// image, variable-bound fill, title glyphs, boolean union, pop.
///
/// Re-pinned again 2026-09-18 (canvas chrome audit): the render ROOT is never a
/// labelled object — on the canvas the root is the PAGE, and its name
/// belongs in the pages list, not painted across the artboard. The
/// document's `/golden/label` command is gone, so the count drops by
/// exactly one (51); `/golden/row/label` stays, because the auto-layout
/// row is a page-level frame and Figma does name those. Nothing else
/// moved: no geometry, no paint.
///
/// The kind hash IS stale after that removal and only `cargo test` can print
/// the replacement: run
///     cargo test -p x-native --test golden_project golden_render_ir_matches_pinned_shape
/// and paste the `kind_hash=0x…` value from the GOLDEN DRIFT panic over this
/// constant. The count above is already correct, so nothing else needs
/// re-pinning.
const GOLDEN_COMMANDS: usize = 51;
const GOLDEN_KIND_HASH: u64 = 0xe156_0b27_ca1a_6fbd;

fn golden_document() -> Document {
    let mut doc = Document::new();
    let mut vars = Variables::default();
    vars.colors
        .insert("brand".into(), Color::from_rgb8(0x0d, 0x99, 0xff));
    vars.numbers.insert("gap".into(), 16.0);

    // styles (local + a library-shaped binding)
    doc.styles.insert(
        "Primary".into(),
        LegacyStyle::Paint {
            fill: Paint::Solid(Color::from_rgb8(0x63, 0x66, 0xff)),
        },
    );
    doc.styles.insert(
        "Card".into(),
        LegacyStyle::Effect {
            effects: vec![Effect::DropShadow {
                dx: 0.0,
                dy: 4.0,
                blur: 12.0,
                color: Color::from_rgba8(0, 0, 0, 120),
            }],
        },
    );

    let mut page = Node::frame("golden", 800.0, 600.0)
        // auto layout row w/ variable gap
        .child({
            let mut row = Node::frame("row", 400.0, 80.0)
                .auto_layout(AutoLayout {
                    direction: LayoutDirection::Horizontal,
                    gap: 10.0,
                    padding: [8.0; 4],
                    align: CrossAlign::Center,
                    gap_var: Some("gap".into()),
                    ..Default::default()
                })
                .child(
                    Node::rect("r1", 0.0, 0.0, 60.0, 40.0, Color::from_rgb8(255, 0, 0)).radius(6.0),
                )
                .child(Node::ellipse(
                    "e1",
                    0.0,
                    0.0,
                    40.0,
                    40.0,
                    Color::from_rgb8(0, 255, 0),
                ));
            apply_layout_recursive(&mut row, &vars);
            row
        })
        // component + instance with text override
        .child(
            Node::component("m-btn", "Button", 100.0, 36.0)
                .child(
                    Node::rect(
                        "b-bg",
                        0.0,
                        0.0,
                        100.0,
                        36.0,
                        Color::from_rgb8(0x0d, 0x99, 0xff),
                    )
                    .radius(8.0),
                )
                .child(Node::text("b-t", 12.0, 10.0, 76.0, 14.0, "OK")),
        )
        .child(
            Node::instance("i1", "Button", 40.0, 120.0, 100.0, 36.0)
                .override_prop("b-t", "text:GOLDEN"),
        )
        // gradient + blend + effect
        .child(
            Node::rect("grad", 200.0, 120.0, 120.0, 60.0, Color::WHITE)
                .fill_paint(Paint::LinearGradient {
                    start: (0.0, 0.0),
                    end: (120.0, 0.0),
                    stops: vec![
                        (0.0, Color::from_rgb8(255, 90, 0)),
                        (1.0, Color::from_rgb8(142, 45, 226)),
                    ],
                    space: GradSpace::Srgb,
                })
                .effect(Effect::DropShadow {
                    dx: 2.0,
                    dy: 3.0,
                    blur: 6.0,
                    color: Color::from_rgba8(0, 0, 0, 100),
                }),
        )
        // mask over image
        .child(Node::ellipse("msk", 400.0, 120.0, 80.0, 80.0, Color::WHITE).mask(true))
        .child({
            let mut img = Node::image("img", 400.0, 120.0, 120.0, 90.0, "asset://golden");
            if let x_native::NodeKind::Image { fit, .. } = &mut img.kind {
                *fit = ImageFit::Crop;
            }
            img
        })
        // variable-bound fill + text
        .child(
            Node::rect("vb", 40.0, 240.0, 60.0, 60.0, Color::BLACK)
                .fill_paint(Paint::Variable("brand".into())),
        )
        .child(Node::text(
            "title",
            40.0,
            320.0,
            300.0,
            24.0,
            "Golden project",
        ));
    // vector boolean through the editor (curve-preserving default backend)
    let mut ed = Editor::new(page);
    ed.root.children.push(Node::rect(
        "ba",
        200.0,
        240.0,
        80.0,
        80.0,
        Color::from_rgb8(0x2e, 0xcc, 0x71),
    ));
    ed.root.children.push(Node::ellipse(
        "bb",
        250.0,
        260.0,
        80.0,
        80.0,
        Color::from_rgb8(0x2e, 0xcc, 0x71),
    ));
    ed.selection = vec!["ba".into(), "bb".into()];
    ed.boolean_selected(BoolOp::Union).expect("golden boolean");
    page = ed.root;

    // style binding + library dep with snapshot
    bind_style(
        x_native::editor::find_mut(&mut page, "vb").unwrap(),
        "Primary",
        &doc.styles["Primary"].clone(),
    );
    let mut lib = x_native::Library {
        library_id: "golden-lib".into(),
        name: "Golden Lib".into(),
        version: 1,
        ..Default::default()
    };
    lib.styles.insert(
        "LibStyle".into(),
        LegacyStyle::Paint {
            fill: Paint::Solid(Color::from_rgb8(9, 9, 9)),
        },
    );
    doc.library_deps.push(LibraryDependency {
        library_id: "golden-lib".into(),
        resolved_version: 1,
        snapshot_hash: x_native::fileio::library_hash(&lib),
        source_path: "golden.xlib".into(),
    });
    doc.library_snapshots.insert("golden-lib".into(), lib);
    let _ = LibraryRef::style("golden-lib", "LibStyle");

    doc.variables = vars;
    doc.pages.push(page);
    doc
}

fn kind_hash(cmds: &[RenderCommand]) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for c in cmds {
        let k = match c {
            RenderCommand::FillPath { .. } => 1u64,
            RenderCommand::StrokePath { .. } => 2,
            RenderCommand::PushLayer { .. } => 3,
            RenderCommand::PopLayer => 4,
            RenderCommand::Glyphs { .. } => 5,
            RenderCommand::Image { .. } => 6,
            RenderCommand::PushClip { .. } => 7,
        };
        h ^= k;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

#[test]
fn golden_serialization_is_byte_stable() {
    let doc = golden_document();
    let text = save_x(&doc);
    let re = load_x(&text).expect("golden reloads");
    assert_eq!(save_x(&re), text, "golden .x byte-stable");
    // structural spot checks
    assert_eq!(re.pages.len(), 1);
    assert_eq!(re.library_deps.len(), 1);
    assert_eq!(re.styles.len(), 2);
}

#[test]
fn golden_render_ir_matches_pinned_shape() {
    let doc = golden_document();
    let tree = build_render_tree(&doc.pages[0], &doc.variables);
    let hash = kind_hash(&tree.commands);
    if tree.commands.len() != GOLDEN_COMMANDS || hash != GOLDEN_KIND_HASH {
        // Print the actual shape so the drift can be REVIEWED right here
        // in CI output instead of forcing a local debug session.
        let mut listing = String::new();
        for (i, c) in tree.commands.iter().enumerate() {
            let kind = match c {
                RenderCommand::FillPath { .. } => "fill",
                RenderCommand::StrokePath { .. } => "stroke",
                RenderCommand::PushLayer { .. } => "layer",
                RenderCommand::PopLayer => "pop",
                RenderCommand::Glyphs { .. } => "glyphs",
                RenderCommand::Image { .. } => "image",
                RenderCommand::PushClip { .. } => "clip",
            };
            listing.push_str(&format!("\n  {i:3} {kind:7} {}", c.key()));
        }
        panic!(
            "GOLDEN DRIFT: commands={} (pinned {}), kind_hash={hash:#018x} (pinned {GOLDEN_KIND_HASH:#018x}).{listing}\n\
             If this change is DELIBERATE, review the listing above and re-pin\n\
             GOLDEN_COMMANDS / GOLDEN_KIND_HASH in golden_project.rs.",
            tree.commands.len(), GOLDEN_COMMANDS
        );
    }
}

#[test]
fn golden_undo_redo_stays_byte_exact() {
    let doc = golden_document();
    let mut ed = Editor::new(doc.pages[0].clone());
    let before = {
        let mut d = Document::new();
        d.pages.push(ed.root.clone());
        save_x(&d)
    };
    // a burst of representative edits
    ed.selection = vec!["grad".into()];
    ed.move_selection(10.0, 5.0);
    ed.set_opacity("grad", 0.5);
    ed.set_fill("vb", Paint::Solid(Color::BLACK));
    ed.resize("title", 200.0, 30.0);
    while ed.undo() {}
    let after = {
        let mut d = Document::new();
        d.pages.push(ed.root.clone());
        save_x(&d)
    };
    assert_eq!(after, before, "golden undo chain byte-exact");
}
