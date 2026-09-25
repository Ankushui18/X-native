//! A Slice exports the REGION it covers.
//!
//! : "The Slice tool lets you specify a specific region of the screen for
//! export, even if it's not organized into a single group" — with Contents Only
//! off, "anything that overlaps the slice will be exported". The slice layer
//! itself draws nothing, so exporting it must build the flattened page content
//! inside its bounds rather than rendering the (empty) slice node.

use x_native::text::FontManager;
use x_native::{prepare_export, Color, Node, RenderCommand, Variables};

/// page 800x600 → a 50x50 red rect at (20, 30) → a 40x40 slice over its corner.
fn page() -> Node {
    Node::frame("page", 800.0, 600.0)
        .child(Node::rect(
            "r",
            20.0,
            30.0,
            50.0,
            50.0,
            Color::from_rgb8(255, 0, 0),
        ))
        .child(Node::slice("sl", 20.0, 30.0, 40.0, 40.0))
}

#[test]
fn a_slice_exports_the_content_inside_its_bounds() {
    let fonts = FontManager::new();
    let vars = Variables::default();
    let ids = vec!["sl".to_string()];
    let plan = prepare_export(&page(), &vars, Some(&ids), &fonts).expect("slice exports");

    // the slice's own size is the canvas, and the overlapped rect is IN the tree
    assert_eq!((plan.width, plan.height), (40.0, 40.0));
    assert!(
        plan.tree
            .commands
            .iter()
            .any(|c| matches!(c, RenderCommand::FillPath { .. })),
        "the content under the slice is what gets exported"
    );
    // re-origined: the rect sat at the slice's corner, so it starts at (0, 0)
    let shift = plan
        .tree
        .commands
        .iter()
        .find_map(|c| match c {
            RenderCommand::FillPath { transform, .. } => Some(transform.as_coeffs()),
            _ => None,
        })
        .expect("a fill");
    assert!(shift[4].abs() < 0.01 && shift[5].abs() < 0.01, "{shift:?}");
}

#[test]
fn an_empty_slice_still_exports_its_size() {
    let fonts = FontManager::new();
    let vars = Variables::default();
    let ids = vec!["empty".to_string()];
    let doc =
        Node::frame("page", 800.0, 600.0).child(Node::slice("empty", 700.0, 500.0, 30.0, 20.0));
    let plan = prepare_export(&doc, &vars, Some(&ids), &fonts).expect("size only");
    // the page's own background still overlaps the region (the rule takes
    // anything that does); what matters is that the slice sets the canvas
    assert_eq!((plan.width, plan.height), (30.0, 20.0));
}

#[test]
fn a_mixed_selection_refuses_to_guess() {
    let fonts = FontManager::new();
    let vars = Variables::default();
    // one file per export: a slice plus a layer cannot both land in it, so the
    // export says so instead of silently dropping one
    let ids = vec!["sl".to_string(), "r".to_string()];
    let err = match prepare_export(&page(), &vars, Some(&ids), &fonts) {
        Err(e) => e,
        Ok(_) => panic!("a mixed selection must be refused, not guessed"),
    };
    assert!(err.contains("on its own"), "{err}");
}
