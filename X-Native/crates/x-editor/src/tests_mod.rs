#[allow(unused_imports)]
use crate::*;
use x_core::kurbo::{Point, Rect};
use x_core::*;

// -------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::{Color, Node};

    /// Frames and sections draw their own name as a canvas label (the QA-004
    /// block in scene.rs), and every glyph of that label counts as one path in
    /// the scene stats. The names used in these tests are ASCII, so one glyph
    /// per character — spell the label out instead of hardcoding the sum, so a
    /// renamed fixture shows up as a label change, not as a mystery off-by-N.
    fn label_paths(name: &str) -> usize {
        name.chars().count()
    }

    fn doc() -> Node {
        Node::frame("page", 800.0, 600.0)
            .child(Node::rect(
                "a",
                10.0,
                10.0,
                100.0,
                50.0,
                Color::from_rgb8(255, 0, 0),
            ))
            .child(Node::rect(
                "b",
                200.0,
                10.0,
                100.0,
                50.0,
                Color::from_rgb8(0, 255, 0),
            ))
            .child(Node::ellipse(
                "c",
                400.0,
                10.0,
                80.0,
                80.0,
                Color::from_rgb8(0, 0, 255),
            ))
    }

    #[test]
    fn dev_mode_emits_text_wrap_css() {
        let mut n = Node::text("t", 0.0, 0.0, 200.0, 20.0, "headline");
        n.bindings.insert("tw".into(), "pretty".into());
        let css = node_to_css(&n, &Variables::default());
        assert!(
            css.contains("text-wrap: pretty;"),
            "pretty wrap emits CSS: {css}"
        );
        // default stays silent (byte-stable legacy output)
        let mut plain = Node::text("t2", 0.0, 0.0, 200.0, 20.0, "body");
        plain.bindings.remove("tw");
        let css2 = node_to_css(&plain, &Variables::default());
        assert!(!css2.contains("text-wrap"), "auto is implicit: {css2}");
    }

    /// Figma text-properties parity: the CODE panel must mirror the typed
    /// Node fields (the same source the canvas + exports honor).
    #[test]
    fn dev_mode_css_mirrors_typed_text_properties() {
        let mut n = Node::text("t", 0.0, 0.0, 200.0, 60.0, "Body copy");
        n.text_align = x_core::TextAlign::Justified;
        n.text_decoration = x_core::TextDecoration::Underline;
        n.bindings.insert("sc".into(), "1".into()); // small caps mode
        n.paragraph_spacing = 6.0;
        n.paragraph_indent = 14.0;
        n.list_style = x_core::ListStyle::Bulleted;
        n.wrap_style = x_core::WrapStyle::BreakWord;
        n.vertical_trim = true;
        n.hanging_punctuation = x_core::HangingPunctuation {
            quotes: true,
            lists: false,
        };
        n.text_truncation = x_core::TextTruncation::End;
        n.max_lines = Some(3);
        n.text_wrap = x_core::TextWrap::Balance;
        let css = node_to_css(&n, &Variables::default());
        for frag in [
            "text-align: justify;",
            "text-align-last: justify;",
            "text-decoration: underline;",
            "font-variant-caps: small-caps;",
            "margin-bottom: 6px; /* paragraph spacing */",
            "text-indent: 14px;",
            "list-style: disc;",
            "overflow-wrap: break-word;",
            "text-wrap: balance;",
            "overflow: hidden;",
            "-webkit-line-clamp: 3;",
            "text-overflow: ellipsis;",
            "hanging-punctuation: first;",
            "vertical trim",
        ] {
            assert!(css.contains(frag), "missing `{frag}` in:\n{css}");
        }
    }

    #[test]
    fn dev_mode_css_stays_quiet_for_plain_text() {
        let n = Node::text("t", 0.0, 0.0, 200.0, 20.0, "Plain");
        let css = node_to_css(&n, &Variables::default());
        for frag in [
            "text-align",
            "text-decoration",
            "text-transform",
            "text-indent",
            "line-clamp",
            "list-style",
            "hanging-punctuation",
            "vertical trim",
        ] {
            assert!(!css.contains(frag), "plain text emits no `{frag}`: {css}");
        }
    }

    #[test]
    fn segment_at_finds_line_curve_and_close() {
        let path = vec![
            PathCmd::MoveTo(0.0, 0.0),
            PathCmd::LineTo(100.0, 0.0),
            PathCmd::CurveTo(100.0, 50.0, 50.0, 100.0, 0.0, 100.0),
            PathCmd::Close,
        ];
        // mid first segment (a line)
        assert_eq!(segment_at(&path, 50.0, 0.0, 4.0), Some(1));
        // mid cubic, sampled: bezier at t=0.5 of that curve is ~(62,75)
        assert_eq!(segment_at(&path, 62.0, 75.0, 6.0), Some(2));
        // the closing segment (last anchor -> first) reports anchor 0
        assert_eq!(segment_at(&path, 0.0, 50.0, 4.0), Some(0));
        // far away
        assert_eq!(segment_at(&path, -50.0, -50.0, 4.0), None);
    }

    #[test]
    fn eraser_splits_open_path_one_undo() {
        let mut e = Editor::new(Node::frame("page", 400.0, 400.0).child(Node::vector(
            "v",
            0.0,
            0.0,
            1.0,
            1.0,
            vec![
                PathCmd::MoveTo(0.0, 0.0),
                PathCmd::LineTo(100.0, 0.0),
                PathCmd::LineTo(100.0, 100.0),
                PathCmd::LineTo(0.0, 100.0),
            ],
        )));
        assert!(e.erase_segments("v", &[2]));
        let n = find(&e.root, "v").unwrap();
        let NodeKind::Vector { path } = &n.kind else {
            panic!("vector")
        };
        // segment 100,0 -> 100,100 erased; the tail becomes its own subpath
        assert_eq!(path.len(), 3);
        assert!(matches!(path[0], PathCmd::MoveTo(0.0, 0.0)));
        assert!(matches!(path[1], PathCmd::LineTo(100.0, 0.0)));
        assert!(matches!(path[2], PathCmd::MoveTo(0.0, 100.0)));
        // one undo restores the full path
        e.undo();
        let n = find(&e.root, "v").unwrap();
        let NodeKind::Vector { path } = &n.kind else {
            panic!("vector")
        };
        assert_eq!(path.len(), 4);
    }

    #[test]
    fn eraser_opens_closed_path_and_eats_close() {
        let closed = || {
            Node::vector(
                "v",
                0.0,
                0.0,
                1.0,
                1.0,
                vec![
                    PathCmd::MoveTo(0.0, 0.0),
                    PathCmd::LineTo(100.0, 0.0),
                    PathCmd::LineTo(100.0, 100.0),
                    PathCmd::Close,
                ],
            )
        };
        // erasing an explicit segment of a closed loop: loop opens, the
        // orphaned tail becomes a subpath, Close disappears
        let mut e = Editor::new(Node::frame("page", 400.0, 400.0).child(closed()));
        assert!(e.erase_segments("v", &[1]));
        let n = find(&e.root, "v").unwrap();
        let NodeKind::Vector { path } = &n.kind else {
            panic!("vector")
        };
        assert_eq!(path.len(), 2, "M(0,0) + M(100,100): {path:?}");
        assert!(!matches!(path.last(), Some(PathCmd::Close)));

        // erasing the CLOSING segment itself just removes the Close
        let mut e = Editor::new(Node::frame("page", 400.0, 400.0).child(closed()));
        assert!(e.erase_segments("v", &[0]));
        let n = find(&e.root, "v").unwrap();
        let NodeKind::Vector { path } = &n.kind else {
            panic!("vector")
        };
        assert_eq!(path.len(), 3);
        assert!(!matches!(path.last(), Some(PathCmd::Close)));
    }

    #[test]
    fn eraser_multi_drag_is_one_replace() {
        let mut e = Editor::new(Node::frame("page", 400.0, 400.0).child(Node::vector(
            "v",
            0.0,
            0.0,
            1.0,
            1.0,
            vec![
                PathCmd::MoveTo(0.0, 0.0),
                PathCmd::LineTo(100.0, 0.0),
                PathCmd::LineTo(100.0, 100.0),
                PathCmd::LineTo(0.0, 100.0),
            ],
        )));
        let depth = e.undo_depth();
        assert!(e.erase_segments("v", &[1, 2]));
        assert_eq!(e.undo_depth(), depth + 1, "one undo group for the drag");
        let n = find(&e.root, "v").unwrap();
        let NodeKind::Vector { path } = &n.kind else {
            panic!("vector")
        };
        assert_eq!(path.len(), 2, "M(0,0) + M(0,100)");
        e.undo();
        let n = find(&e.root, "v").unwrap();
        let NodeKind::Vector { path } = &n.kind else {
            panic!("vector")
        };
        assert_eq!(path.len(), 4, "single undo restores everything");
    }

    #[test]
    fn set_export_settings_is_undoable() {
        let mut e = Editor::new(doc());
        let settings = vec![
            ExportSettings {
                format: "png".into(),
                scale: 1.0,
                quality: 90,
                suffix: "".into(),
            },
            ExportSettings {
                format: "png".into(),
                scale: 2.0,
                quality: 90,
                suffix: "@2x".into(),
            },
        ];
        assert!(e.set_export_settings("a", settings.clone()));
        assert_eq!(find(&e.root, "a").unwrap().export_settings, settings);
        // undo restores the empty list, redo re-applies
        e.undo();
        assert!(find(&e.root, "a").unwrap().export_settings.is_empty());
        e.redo();
        assert_eq!(find(&e.root, "a").unwrap().export_settings, settings);
        // unknown id is a no-op
        assert!(!e.set_export_settings("nope", vec![]));
    }

    #[test]
    fn prototype_interactions_and_starting_point_are_undoable() {
        let mut e = Editor::new(doc());
        let interactions = vec![
            Interaction::click("page-2"),
            Interaction {
                trigger: Trigger::OnHover,
                action: Action::Back,
                actions: vec![],
                transition_ms: 150,
                animation: Animation::Instant,
            },
        ];
        assert!(e.set_interactions("a", interactions.clone()));
        assert_eq!(find(&e.root, "a").unwrap().interactions, interactions);
        assert!(e.set_starting_point("a", true));
        assert!(find(&e.root, "a").unwrap().is_starting_point);
        // undo both, redo both
        e.undo();
        e.undo();
        assert!(find(&e.root, "a").unwrap().interactions.is_empty());
        assert!(!find(&e.root, "a").unwrap().is_starting_point);
        e.redo();
        e.redo();
        assert_eq!(find(&e.root, "a").unwrap().interactions, interactions);
        assert!(find(&e.root, "a").unwrap().is_starting_point);
        assert!(!e.set_interactions("nope", vec![]));
        assert!(!e.set_starting_point("nope", true));
    }

    #[test]
    fn overflow_and_scroll_are_undoable() {
        let mut e = Editor::new(doc());
        assert!(e.set_overflow("a", Overflow::ScrollBoth));
        assert_eq!(find(&e.root, "a").unwrap().overflow, Overflow::ScrollBoth);
        assert!(e.set_scroll("a", 10.0, 20.0));
        assert_eq!(find(&e.root, "a").unwrap().scroll, (10.0, 20.0));
        e.undo();
        e.undo();
        assert_eq!(find(&e.root, "a").unwrap().overflow, Overflow::Visible);
        assert_eq!(find(&e.root, "a").unwrap().scroll, (0.0, 0.0));
        e.redo();
        e.redo();
        assert_eq!(find(&e.root, "a").unwrap().overflow, Overflow::ScrollBoth);
        assert_eq!(find(&e.root, "a").unwrap().scroll, (10.0, 20.0));
        assert!(!e.set_overflow("nope", Overflow::Clip));
    }

    #[test]
    fn hit_test_finds_topmost() {
        let d = Node::frame("page", 800.0, 600.0)
            .child(Node::rect("under", 0.0, 0.0, 100.0, 100.0, Color::WHITE))
            .child(Node::rect("over", 50.0, 50.0, 100.0, 100.0, Color::WHITE));
        assert_eq!(hit_test(&d, Point::new(75.0, 75.0)), Some("over".into()));
        assert_eq!(hit_test(&d, Point::new(25.0, 25.0)), Some("under".into()));
        assert_eq!(hit_test(&d, Point::new(500.0, 500.0)), None);
    }

    #[test]
    fn hit_test_respects_ellipse_shape_and_lock() {
        let mut d = doc();
        // corner of the ellipse's AABB is OUTSIDE the ellipse
        assert_eq!(hit_test(&d, Point::new(402.0, 12.0)), None);
        // center is inside
        assert_eq!(hit_test(&d, Point::new(440.0, 50.0)), Some("c".into()));
        find_mut(&mut d, "c").unwrap().locked = true;
        assert_eq!(hit_test(&d, Point::new(440.0, 50.0)), None);
    }

    #[test]
    fn hit_test_respects_rotation() {
        let d = Node::frame("page", 400.0, 400.0).child(
            Node::rect("r", 100.0, 100.0, 100.0, 20.0, Color::WHITE)
                .rotate(std::f64::consts::FRAC_PI_2),
        );
        // rotated 90° about center (150,110): occupies x∈[140,160], y∈[60,160]
        assert_eq!(hit_test(&d, Point::new(150.0, 70.0)), Some("r".into()));
        assert_eq!(hit_test(&d, Point::new(105.0, 110.0)), None); // original spot now empty
    }

    #[test]
    fn marquee_selects_intersecting() {
        let mut e = Editor::new(doc());
        e.marquee(Rect::new(0.0, 0.0, 320.0, 100.0));
        assert_eq!(e.selection, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn marquee_contained_selects_only_fully_inside() {
        let mut e = Editor::new(doc());
        // rect fully wraps a + b (both 10..60 tall, a 10..110, b 200..300 wide)
        e.marquee_contained(Rect::new(0.0, 0.0, 320.0, 100.0));
        assert_eq!(e.selection, vec!["a".to_string(), "b".to_string()]);
        // a rect that clips a's right edge (110 > 60) contains nothing
        e.marquee_contained(Rect::new(0.0, 0.0, 60.0, 100.0));
        assert!(e.selection.is_empty());
    }

    #[test]
    fn skew_and_origin_are_undoable() {
        let mut e = Editor::new(doc());
        e.skew("a", 0.3, -0.2);
        let a = find(&e.root, "a").unwrap();
        assert!((a.transform.skew_x - 0.3).abs() < 1e-9 && (a.transform.skew_y + 0.2).abs() < 1e-9);
        e.set_origin("a", 0.0, 1.0);
        let a = find(&e.root, "a").unwrap();
        assert_eq!((a.transform.origin_x, a.transform.origin_y), (0.0, 1.0));
        e.undo();
        let a = find(&e.root, "a").unwrap();
        assert_eq!((a.transform.origin_x, a.transform.origin_y), (0.5, 0.5));
        e.undo();
        let a = find(&e.root, "a").unwrap();
        assert!((a.transform.skew_x - 0.0).abs() < 1e-9 && (a.transform.skew_y - 0.0).abs() < 1e-9);
        e.redo();
        e.redo();
        let a = find(&e.root, "a").unwrap();
        assert!(
            (a.transform.skew_x - 0.3).abs() < 1e-9 && (a.transform.origin_y - 1.0).abs() < 1e-9
        );
    }

    #[test]
    fn move_undo_redo_roundtrip() {
        let mut e = Editor::new(doc());
        e.selection = vec!["a".into()];
        e.move_selection(30.0, 40.0);
        assert_eq!(find(&e.root, "a").unwrap().transform.x, 40.0);
        assert!(e.undo());
        assert_eq!(find(&e.root, "a").unwrap().transform.x, 10.0);
        assert!(e.redo());
        assert_eq!(find(&e.root, "a").unwrap().transform.x, 40.0);
        assert!(!e.redo()); // stack empty
    }

    #[test]
    fn set_text_clamps_rich_runs_to_new_length() {
        // editing text CLAMPS rich-run char ranges (Figma semantics): a run
        // that still fits survives, one pushed out of range is dropped
        let mut t = Node::text("t", 0.0, 200.0, 100.0, 20.0, "OLD TEXT");
        t.text_runs = vec![
            TextRun {
                start: 0,
                len: 3,
                color: Some(Color::from_rgb8(255, 0, 0)),
                ..Default::default()
            },
            TextRun {
                start: 4,
                len: 5,
                weight: Some(700),
                ..Default::default()
            },
        ];
        let mut e = Editor::new(doc().child(t));
        e.set_text("t", "NEW TEXT");
        assert!(
            matches!(&find(&e.root, "t").unwrap().kind, NodeKind::Text{text} if text=="NEW TEXT")
        );
        let runs = &find(&e.root, "t").unwrap().text_runs;
        assert_eq!(runs.len(), 2, "same-length edit keeps both runs: {runs:?}");
        assert_eq!((runs[0].start, runs[0].len), (0, 3));
        e.set_text("t", "NE");
        let runs = &find(&e.root, "t").unwrap().text_runs;
        assert_eq!(
            runs.len(),
            1,
            "only the still-fitting run survives: {runs:?}"
        );
        assert_eq!(
            (runs[0].start, runs[0].len),
            (0, 2),
            "run clamped to 2 chars"
        );
    }

    #[test]
    fn resize_rotate_fill_text_are_undoable() {
        let mut e = Editor::new(doc().child(Node::text("t", 0.0, 200.0, 100.0, 20.0, "OLD")));
        e.resize("a", 150.0, 75.0);
        e.rotate("a", 0.5);
        e.set_fill("a", Paint::Solid(Color::from_rgb8(1, 2, 3)));
        e.set_text("t", "NEW");
        assert_eq!(find(&e.root, "a").unwrap().w, 150.0);
        assert!(matches!(&find(&e.root, "t").unwrap().kind, NodeKind::Text{text} if text=="NEW"));
        e.undo();
        e.undo();
        e.undo();
        e.undo();
        let a = find(&e.root, "a").unwrap();
        assert_eq!((a.w, a.transform.rotation), (100.0, 0.0));
        assert!(matches!(&a.fill, Paint::Solid(c) if (c.components[0]*255.0).round() as u8 == 255));
        assert!(matches!(&find(&e.root, "t").unwrap().kind, NodeKind::Text{text} if text=="OLD"));
    }

    #[test]
    fn set_corners_is_undoable_uniform_and_per_corner() {
        let mut e = Editor::new(doc());
        // uniform radius
        assert!(e.set_corners("a", 12.0, None));
        match find(&e.root, "a").unwrap().kind {
            NodeKind::Rect { radius } => assert_eq!(radius, 12.0),
            _ => panic!("a should be a rect"),
        }
        assert!(find(&e.root, "a").unwrap().corner_radii.is_none());
        // promote to per-corner
        assert!(e.set_corners("a", 12.0, Some([4.0, 8.0, 12.0, 16.0])));
        assert_eq!(
            find(&e.root, "a").unwrap().corner_radii,
            Some([4.0, 8.0, 12.0, 16.0])
        );
        // undo per-corner -> back to uniform 12.0
        assert!(e.undo());
        let a = find(&e.root, "a").unwrap();
        assert!(a.corner_radii.is_none());
        match a.kind {
            NodeKind::Rect { radius } => assert_eq!(radius, 12.0),
            _ => panic!(),
        }
        // undo uniform -> back to 0.0
        assert!(e.undo());
        match find(&e.root, "a").unwrap().kind {
            NodeKind::Rect { radius } => assert_eq!(radius, 0.0),
            _ => panic!(),
        }
        // redo both
        assert!(e.redo());
        assert!(e.redo());
        assert_eq!(
            find(&e.root, "a").unwrap().corner_radii,
            Some([4.0, 8.0, 12.0, 16.0])
        );
    }

    #[test]
    fn delete_and_undo_restores_at_same_index() {
        let mut e = Editor::new(doc());
        e.selection = vec!["b".into()];
        e.delete_selection();
        assert!(find(&e.root, "b").is_none());
        e.undo();
        assert_eq!(e.root.children[1].id, "b"); // back at index 1, not appended
    }

    #[test]
    fn z_order_ops() {
        let mut e = Editor::new(doc());
        e.bring_to_front("a");
        assert_eq!(e.root.children.last().unwrap().id, "a");
        e.send_to_back("a");
        assert_eq!(e.root.children[0].id, "a");
        e.undo(); // back to front
        assert_eq!(e.root.children.last().unwrap().id, "a");
    }

    #[test]
    fn group_and_undo() {
        let mut e = Editor::new(doc());
        e.selection = vec!["a".into(), "b".into()];
        e.group_selection("g1");
        let g = find(&e.root, "g1").expect("group exists");
        assert_eq!(g.children.len(), 2);
        assert_eq!(g.transform.x, 10.0); // group wraps collective bounds
        assert_eq!(g.children[0].transform.x, 0.0); // members re-based
        assert!(e.undo());
        assert!(find(&e.root, "g1").is_none());
        assert_eq!(find(&e.root, "a").unwrap().transform.x, 10.0);
    }

    #[test]
    fn select_similar_matches_kind_and_fill() {
        let mut e = Editor::new(doc());
        // a second RED rect elsewhere in the tree
        let mut red2 = Node::rect("a2", 40.0, 400.0, 30.0, 30.0, Color::from_rgb8(255, 0, 0));
        red2.transform.x = 40.0;
        red2.transform.y = 400.0;
        e.root.children.push(red2);
        e.selection = vec!["a".into()];
        let n = e.select_similar();
        assert_eq!(n, 2, "both red rects");
        assert!(e.selection.contains(&"a".into()));
        assert!(e.selection.contains(&"a2".into()));
        // a green rect does NOT match
        e.selection = vec!["b".into()];
        let n = e.select_similar();
        assert_eq!(n, 1, "only itself: fill differs");
        // the ellipse neither (kind differs)
        e.selection = vec!["c".into()];
        assert_eq!(e.select_similar(), 1);
    }

    #[test]
    fn select_inside_descends_one_level() {
        let mut e = Editor::new(doc());
        e.selection = vec!["a".into(), "b".into(), "c".into()];
        e.group_selection("g");
        e.selection = vec!["g".into()];
        let n = e.select_inside();
        assert_eq!(n, 3, "a, b, c inside the group");
        assert!(e.selection.contains(&"a".into()));
        assert!(!e.selection.contains(&"g".into()));
        // leaves stay selected
        e.selection = vec!["a".into()];
        assert_eq!(e.select_inside(), 1);
        assert_eq!(e.selection, vec!["a".to_string()]);
    }

    #[test]
    fn tidy_up_grids_selected_siblings_undoably() {
        let mut e = Editor::new(doc());
        e.root.children.truncate(2); // just a and b
                                     // scatter: a at (0,0), b at (60,50)
        {
            let b = find_mut(&mut e.root, "b").unwrap();
            b.transform.x = 60.0;
            b.transform.y = 50.0;
        }
        e.selection = vec!["a".into(), "b".into()];
        let (moved, cols, rows) = e.tidy_up().expect("tidy");
        assert_eq!((moved, cols, rows), (1, 2, 1), "only b moves; 2x1 grid");
        let (ax, ay) = {
            let a = find(&e.root, "a").unwrap();
            (a.transform.x, a.transform.y)
        };
        let (bx, by) = {
            let b = find(&e.root, "b").unwrap();
            (b.transform.x, b.transform.y)
        };
        assert_eq!((ax, ay), (10.0, 10.0), "a stays at the min corner");
        // gap defaults to 20 when nothing aligned
        assert_eq!((bx, by), (10.0 + 100.0 + 20.0, 10.0));
        assert!(e.undo(), "undoable");
        let b = find(&e.root, "b").unwrap();
        assert_eq!((b.transform.x, b.transform.y), (60.0, 50.0));
    }

    #[test]
    fn tidy_up_works_on_a_selected_group() {
        let mut e = Editor::new(doc());
        e.selection = vec!["a".into(), "b".into(), "c".into()];
        e.group_selection("g");
        e.selection = vec!["g".into()];
        let (moved, cols, _rows) = e.tidy_up().expect("tidy group children");
        assert!(moved >= 1, "at least one child moved");
        assert_eq!(cols, 2, "three kids -> 2 columns");
        // children keep their SIZES, gaps uniform: c sits in row 2 col 1
        let g = find(&e.root, "g").unwrap();
        let xs: Vec<f64> = g.children.iter().map(|c| c.transform.x).collect();
        let ys: Vec<f64> = g.children.iter().map(|c| c.transform.y).collect();
        assert_eq!(ys.len(), 3);
        // two rows -> row 2 is exactly max_h + gap below row 1
        let row1: Vec<usize> = (0..3)
            .filter(|&i| ys[i] == ys.iter().cloned().fold(f64::INFINITY, f64::min))
            .collect();
        let row2: Vec<usize> = (0..3)
            .filter(|&i| ys[i] > ys.iter().cloned().fold(f64::INFINITY, f64::min))
            .collect();
        assert_eq!(row1.len(), 2);
        assert_eq!(row2.len(), 1);
        let _ = xs;
    }

    #[test]
    fn section_selection_wraps_labels_and_ungroups() {
        let mut e = Editor::new(doc());
        e.selection = vec!["a".into(), "b".into()];
        e.section_selection("sec1");
        let s = find(&e.root, "sec1").expect("section exists");
        assert!(matches!(s.kind, NodeKind::Section), "kind is Section");
        assert_eq!(s.children.len(), 2);
        assert_eq!(s.name, "Section");
        // tint + border + rounded defaults
        assert!(s.stroke.width > 0.0);
        assert!(s.corner_radii.is_some());
        assert_eq!(e.selection, vec!["sec1".to_string()]);
        // undo restores
        assert!(e.undo());
        assert!(find(&e.root, "sec1").is_none());
        // redo re-wraps as a section
        assert!(e.redo());
        assert!(matches!(
            find(&e.root, "sec1").map(|n| n.kind.clone()),
            Some(NodeKind::Section)
        ));
        // ungroup dissolves a section like a group
        assert!(e.ungroup("sec1"));
        assert!(find(&e.root, "sec1").is_none());
        assert_eq!(e.root.children.len(), 3, "a, b and the untouched ellipse c");
    }

    #[test]
    fn frame_selection_wraps_and_is_undoable() {
        let mut e = Editor::new(doc());
        e.selection = vec!["a".into(), "b".into()];
        e.frame_selection("f1");
        let f = find(&e.root, "f1").expect("frame exists");
        assert!(matches!(f.kind, NodeKind::Frame { .. }), "kind is Frame");
        assert_eq!(f.children.len(), 2);
        // collective AABB of a (10..110) and b (200..300): x∈[10,300] y∈[10,60]
        assert_eq!((f.transform.x, f.transform.y), (10.0, 10.0));
        assert_eq!((f.w, f.h), (290.0, 50.0));
        assert_eq!(f.children[0].transform.x, 0.0); // members re-based
        assert_eq!(f.children[1].transform.x, 190.0); // b re-based to 200-10
                                                      // Figma frames default to white fill
        assert!(matches!(f.fill, Paint::Solid(c) if c == Color::WHITE));
        // selection collapses onto the new frame
        assert_eq!(e.selection, vec!["f1".to_string()]);
        // undo restores the pre-frame tree
        assert!(e.undo());
        assert!(find(&e.root, "f1").is_none());
        assert_eq!(find(&e.root, "a").unwrap().transform.x, 10.0);
        assert_eq!(find(&e.root, "b").unwrap().transform.x, 200.0);
        // redo re-applies the wrap
        assert!(e.redo());
        assert!(find(&e.root, "f1").is_some());
    }

    #[test]
    fn apply_run_style_overlays_and_undoes() {
        let mut e =
            Editor::new(doc().child(Node::text("t", 0.0, 200.0, 200.0, 20.0, "hello world")));
        let red = Color::from_rgb8(0xff, 0x00, 0x00);
        // bold+red over "hello" (chars 0..5)
        assert!(e.apply_run_style(
            "t",
            0,
            5,
            TextRun {
                start: 0,
                len: 0,
                color: Some(red),
                weight: Some(700),
                ..Default::default()
            }
        ));
        let t = find(&e.root, "t").unwrap();
        assert_eq!(t.text_runs.len(), 1);
        assert_eq!((t.text_runs[0].start, t.text_runs[0].len), (0, 5));
        assert_eq!(t.text_runs[0].color, Some(red));
        assert_eq!(t.text_runs[0].weight, Some(700));
        // overlaid style over "wor" (chars 6..9) — splits nothing, adds a run
        assert!(e.apply_run_style(
            "t",
            6,
            9,
            TextRun {
                start: 0,
                len: 0,
                italic: Some(true),
                ..Default::default()
            }
        ));
        let t = find(&e.root, "t").unwrap();
        assert_eq!(t.text_runs.len(), 2);
        // re-styling a sub-range of the first run splits it
        assert!(e.apply_run_style(
            "t",
            1,
            3,
            TextRun {
                start: 0,
                len: 0,
                size: Some(9.0),
                ..Default::default()
            }
        ));
        let t = find(&e.root, "t").unwrap();
        let starts: Vec<usize> = t.text_runs.iter().map(|r| r.start).collect();
        assert!(starts.windows(2).all(|w| w[0] <= w[1]), "runs stay sorted");
        // undo all three
        assert!(e.undo());
        assert!(e.undo());
        assert!(e.undo());
        assert!(find(&e.root, "t").unwrap().text_runs.is_empty());
    }

    #[test]
    fn apply_run_style_merges_with_effective_style() {
        let mut e =
            Editor::new(doc().child(Node::text("t", 0.0, 200.0, 200.0, 20.0, "hello world")));
        let red = Color::from_rgb8(0xff, 0x00, 0x00);
        assert!(e.apply_run_style(
            "t",
            0,
            5,
            TextRun {
                start: 0,
                len: 0,
                color: Some(red),
                ..Default::default()
            }
        ));
        // bolding the same range keeps the color (patch merges over eff)
        assert!(e.apply_run_style(
            "t",
            0,
            5,
            TextRun {
                start: 0,
                len: 0,
                weight: Some(700),
                ..Default::default()
            }
        ));
        let t = find(&e.root, "t").unwrap();
        assert_eq!(
            t.text_runs.len(),
            1,
            "no duplicate overlay: {:?}",
            t.text_runs
        );
        assert_eq!(t.text_runs[0].color, Some(red), "color carried over");
        assert_eq!(t.text_runs[0].weight, Some(700), "weight applied");
    }

    #[test]
    fn toggle_span_style_flips_bold_and_italic() {
        let mut e =
            Editor::new(doc().child(Node::text("t", 0.0, 200.0, 200.0, 20.0, "hello world")));
        assert!(e.toggle_span_style("t", 0, 5, true));
        assert_eq!(find(&e.root, "t").unwrap().text_runs[0].weight, Some(700));
        // toggling again turns it off
        assert!(e.toggle_span_style("t", 0, 5, true));
        assert_eq!(find(&e.root, "t").unwrap().text_runs[0].weight, Some(400));
        assert!(e.toggle_span_style("t", 6, 11, false));
        assert_eq!(find(&e.root, "t").unwrap().text_runs[1].italic, Some(true));
    }

    #[test]
    fn set_text_clamps_out_of_range_runs() {
        let mut e =
            Editor::new(doc().child(Node::text("t", 0.0, 200.0, 200.0, 20.0, "abcdefghij")));
        assert!(e.apply_run_style(
            "t",
            5,
            10,
            TextRun {
                start: 0,
                len: 0,
                italic: Some(true),
                ..Default::default()
            }
        ));
        // shrink the text to 3 chars: the run [5,10) is now fully out of range
        e.set_text("t", "abc");
        let t = find(&e.root, "t").unwrap();
        assert!(t.text_runs.is_empty(), "out-of-range runs dropped");
        assert!(matches!(&t.kind, NodeKind::Text { text } if text == "abc"));
    }

    #[test]
    fn frame_selection_wraps_single_node() {
        // unlike group (2+), frame-selection wraps a single selection.
        let mut e = Editor::new(doc());
        e.selection = vec!["a".into()];
        e.frame_selection("f2");
        let f = find(&e.root, "f2").expect("frame exists");
        assert_eq!(f.children.len(), 1);
        assert_eq!((f.transform.x, f.transform.y), (10.0, 10.0));
        assert_eq!((f.w, f.h), (100.0, 50.0));
        assert_eq!(f.children[0].transform.x, 0.0);
        // empty selection is a no-op
        let mut e2 = Editor::new(doc());
        e2.frame_selection("f3");
        assert!(find(&e2.root, "f3").is_none());
    }

    #[test]
    fn align_and_distribute() {
        let mut d = doc();
        let ids = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        align(&mut d, &ids, AlignKind::Top);
        assert!(d.children.iter().all(|c| c.transform.y == 10.0));
        // spread them out then distribute
        d.children[0].transform.x = 0.0;
        d.children[1].transform.x = 50.0;
        d.children[2].transform.x = 400.0;
        distribute_horizontal(&mut d, &ids);
        let xs: Vec<f64> = d.children.iter().map(|c| c.transform.x).collect();
        let gap1 = xs[1] - (xs[0] + d.children[0].w);
        let gap2 = xs[2] - (xs[1] + d.children[1].w);
        assert!((gap1 - gap2).abs() < 1e-9);
    }

    #[test]
    fn snapping_to_edges_and_grid() {
        let s = Snapper {
            grid: 8.0,
            threshold: 6.0,
        };
        let others = vec![("b".to_string(), Rect::new(200.0, 0.0, 300.0, 50.0))];
        // proposed left edge 204, within 6 of b's left edge 200 -> snap to 200
        let (x, hit) = s.snap_x(204.0, 100.0, &others);
        assert_eq!(x, 200.0);
        assert_eq!(hit, Some("b".into()));
        // far from everything -> falls back to 8px grid
        let (x, hit) = s.snap_x(701.0, 100.0, &[]);
        assert_eq!(x, 704.0);
        assert!(hit.is_none());
    }

    #[test]
    fn constraints_solver() {
        let mut f = Node::frame("f", 400.0, 300.0)
            .child(
                Node::rect("right", 300.0, 10.0, 80.0, 40.0, Color::WHITE)
                    .pin(x_core::HPin::Right, x_core::VPin::Top),
            )
            .child(
                Node::rect("stretch", 10.0, 10.0, 380.0, 40.0, Color::WHITE)
                    .pin(x_core::HPin::StretchH, x_core::VPin::Top),
            )
            .child(
                Node::rect("center", 150.0, 100.0, 100.0, 40.0, Color::WHITE)
                    .pin(x_core::HPin::CenterH, x_core::VPin::CenterV),
            );
        let (ow, oh) = (f.w, f.h);
        f.w = 600.0;
        f.h = 400.0;
        apply_constraints(&mut f, ow, oh);
        assert_eq!(find(&f, "right").unwrap().transform.x, 500.0); // +200
        assert_eq!(find(&f, "stretch").unwrap().w, 580.0); // +200
        assert_eq!(find(&f, "center").unwrap().transform.x, 250.0); // +100
        assert_eq!(find(&f, "center").unwrap().transform.y, 150.0); // +50
    }

    #[test]
    fn prototype_player_navigates_and_goes_back() {
        let doc = Node::frame("doc", 2000.0, 800.0)
            .child(
                Node::frame("screen-1", 400.0, 800.0).child(
                    Node::rect("cta", 100.0, 700.0, 200.0, 60.0, Color::WHITE)
                        .prototype("screen-2", 300),
                ),
            )
            .child(Node::frame("screen-2", 400.0, 800.0).child(Node::rect(
                "back-btn",
                10.0,
                10.0,
                60.0,
                40.0,
                Color::WHITE,
            )));
        let mut p = Player::new(&doc, "screen-1");
        let ms = p.click(Point::new(200.0, 730.0));
        assert_eq!(ms, Some(300));
        assert_eq!(p.current, "screen-2");
        assert!(p.back());
        assert_eq!(p.current, "screen-1");
        assert!(!p.back());
    }

    #[test]
    fn spatial_grid_indexes_100k_and_queries_fast() {
        let scene = x_render::benchmark_scene(100_000);
        let t0 = std::time::Instant::now();
        let grid = SpatialGrid::build(&scene, 256.0);
        let build_ms = t0.elapsed().as_millis();
        assert_eq!(grid.len(), 100_000);
        let t1 = std::time::Instant::now();
        let mut total = 0usize;
        for i in 0..1000 {
            total += grid
                .query_point(Point::new((i * 4) as f64, (i * 4) as f64))
                .len();
        }
        let query_us = t1.elapsed().as_micros();
        assert!(total > 0);
        // generous sandbox bounds; on real hardware these are far lower
        assert!(build_ms < 5000, "grid build too slow: {build_ms}ms");
        assert!(query_us < 2_000_000, "1000 queries too slow: {query_us}us");
    }

    #[test]
    fn merge_last_collapses_a_drag_gesture() {
        let mut e = Editor::new(doc());
        e.selection = vec!["a".into()];
        let before = e.undo_depth();
        e.move_selection(5.0, 0.0);
        e.move_selection(5.0, 0.0);
        e.move_selection(5.0, 0.0);
        e.merge_last(e.undo_depth() - before);
        assert_eq!(find(&e.root, "a").unwrap().transform.x, 25.0);
        e.undo(); // ONE undo reverts the whole gesture
        assert_eq!(find(&e.root, "a").unwrap().transform.x, 10.0);
    }

    #[test]
    fn insert_node_is_undoable() {
        let mut e = Editor::new(doc());
        assert!(e.insert_node(
            "page",
            Node::rect("new", 5.0, 5.0, 10.0, 10.0, Color::WHITE)
        ));
        assert!(find(&e.root, "new").is_some());
        e.undo();
        assert!(find(&e.root, "new").is_none());
    }

    #[test]
    fn node_lookup_and_structural_helpers() {
        let mut e = Editor::new(doc());
        e.insert_node(
            "page",
            Node::rect("r1", 0.0, 0.0, 10.0, 10.0, Color::WHITE),
        );
        assert!(e.get_node("r1").is_some(), "get_node sees the page tree");
        let ids: Vec<String> = e.iter_nodes().map(|n| n.id.clone()).collect();
        assert!(ids.contains(&"r1".to_string()) && ids.contains(&"page".to_string()));
        assert!(e.delete_node("r1"), "delete_node removes it");
        assert!(e.get_node("r1").is_none());
        e.undo();
        assert!(e.get_node("r1").is_some(), "delete is one undo deep");
        assert!(e.add_node(Node::rect("r2", 0.0, 0.0, 4.0, 4.0, Color::WHITE)));
        assert!(e.get_node("r2").is_some(), "add_node appends to the page");
        let serial = e.edit_serial;
        e.mark_dirty();
        assert!(e.edit_serial != serial, "mark_dirty ticks the redraw serial");
    }

    #[test]
    fn offset_vector_offsets_along_normals_not_diagonally() {
        let mut e = Editor::new(doc());
        let square = vec![
            PathCmd::MoveTo(0.0, 0.0),
            PathCmd::LineTo(100.0, 0.0),
            PathCmd::LineTo(100.0, 100.0),
            PathCmd::LineTo(0.0, 100.0),
            PathCmd::Close,
        ];
        e.insert_node("page", Node::vector("v", 0.0, 0.0, 100.0, 100.0, square));
        assert!(e.offset_vector("v", 10.0), "positive distance grows the ring");
        let n = e.get_node("v").expect("vector node");
        let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        if let NodeKind::Vector { path } = &n.kind {
            for c in path {
                let pts: Vec<(f64, f64)> = match *c {
                    PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => vec![(x, y)],
                    PathCmd::CurveTo(a, b, cc, d, ee, f) => vec![(a, b), (cc, d), (ee, f)],
                    PathCmd::Close => vec![],
                };
                for (x, y) in pts {
                    x0 = x0.min(x);
                    y0 = y0.min(y);
                    x1 = x1.max(x);
                    y1 = y1.max(y);
                }
            }
        } else {
            panic!("still a vector");
        }
        // grown 10px on EVERY side (the old code slid +10,+10: min corner
        // would have stayed at 10,10)
        assert!(
            x0 < -9.0 && y0 < -9.0 && x1 > 109.0 && y1 > 109.0,
            "offset grew the bbox to ({x0},{y0},{x1},{y1})"
        );
        assert!(path_is_closed_v(&n.kind), "ring re-closed");

        fn path_is_closed_v(kind: &NodeKind) -> bool {
            if let NodeKind::Vector { path } = kind {
                matches!(path.last(), Some(PathCmd::Close))
            } else {
                false
            }
        }
    }

    #[test]
    fn copy_paste_remaps_ids_and_is_undoable() {
        let mut e = Editor::new(doc());
        e.selection = vec!["a".into()];
        e.copy();
        let ids = e.paste("page", (20.0, 20.0));
        assert_eq!(ids, vec!["a-copy".to_string()]);
        let copy = find(&e.root, "a-copy").unwrap();
        assert_eq!(copy.transform.x, 30.0); // 10 + 20 offset
        assert_eq!(find(&e.root, "a").unwrap().transform.x, 10.0); // original untouched
                                                                   // second paste gets a distinct id
        let ids2 = e.paste("page", (40.0, 40.0));
        assert_eq!(ids2, vec!["a-copy-2".to_string()]);
        e.undo();
        assert!(find(&e.root, "a-copy-2").is_none());
        assert!(find(&e.root, "a-copy").is_some());
    }

    #[test]
    fn duplicate_selects_the_new_copies() {
        let mut e = Editor::new(doc());
        e.selection = vec!["b".into()];
        let ids = e.duplicate_selection((10.0, 10.0));
        assert_eq!(e.selection, ids);
        assert!(find(&e.root, "b-copy").is_some());
    }

    #[test]
    fn paste_remaps_nested_child_ids_too() {
        let mut e = Editor::new(Node::frame("page", 800.0, 600.0).child(
            Node::group("g", 100.0, 100.0).child(Node::rect(
                "inner",
                0.0,
                0.0,
                50.0,
                50.0,
                Color::WHITE,
            )),
        ));
        e.selection = vec!["g".into()];
        e.copy();
        e.paste("page", (0.0, 0.0));
        let pasted = find(&e.root, "g-copy").unwrap();
        assert_eq!(pasted.children[0].id, "inner-copy"); // child renamed, no dup ids
    }

    #[test]
    fn paste_in_place_keeps_coordinates() {
        let mut e = Editor::new(doc());
        e.selection = vec!["a".into()];
        e.copy();
        let ids = e.paste_in_place("page");
        let copy = find(&e.root, &ids[0]).unwrap();
        assert_eq!((copy.transform.x, copy.transform.y), (10.0, 10.0)); // same as original
    }

    #[test]
    fn multi_paste_fans_out_into_each_container_one_undo() {
        let mut page = doc();
        page.children.push(Node::frame("f1", 200.0, 200.0));
        page.children.push(Node::frame("f2", 200.0, 200.0));
        let mut e = Editor::new(page);
        e.selection = vec!["a".into()];
        e.copy();
        let ids = e.paste_into_each(&[("f1".into(), (0.0, 0.0)), ("f2".into(), (0.0, 0.0))]);
        assert_eq!(ids.len(), 2, "one clipboard root per container (2 targets)");
        let f1 = find(&e.root, "f1").unwrap();
        let f2 = find(&e.root, "f2").unwrap();
        assert_eq!(f1.children.len(), 1, "copy landed in f1");
        assert_eq!(f2.children.len(), 1, "copy landed in f2");
        assert_ne!(f1.children[0].id, f2.children[0].id, "fresh ids each");
        // ONE undo reverts the whole fan-out
        e.undo();
        assert_eq!(find(&e.root, "f1").unwrap().children.len(), 0);
        assert_eq!(find(&e.root, "f2").unwrap().children.len(), 0);
        assert!(find(&e.root, "a").is_some(), "original untouched");
    }

    #[test]
    fn paste_over_each_replaces_whole_selection_one_undo() {
        let mut e = Editor::new(doc());
        e.selection = vec!["a".into()];
        e.copy();
        // capture slots the way the app layer does (parent + position)
        let slots: Vec<(String, (f64, f64))> = ["b", "c"]
            .iter()
            .map(|id| {
                let n = find(&e.root, id).unwrap();
                ("page".to_string(), (n.transform.x, n.transform.y))
            })
            .collect();
        let (ox, oy) = e.clipboard_origin().unwrap();
        let slots: Vec<(String, (f64, f64))> = slots
            .into_iter()
            .map(|(p, (x, y))| (p, (x - ox, y - oy)))
            .collect();
        e.selection = vec!["b".into(), "c".into()];
        let ids = e.paste_over_each(&slots);
        assert_eq!(ids.len(), 2, "one replacement per slot");
        assert!(find(&e.root, "b").is_none(), "b replaced");
        assert!(find(&e.root, "c").is_none(), "c replaced");
        for id in &ids {
            let n = find(&e.root, id).unwrap();
            assert!(
                (n.transform.x - 200.0).abs() < 0.5 || (n.transform.x - 400.0).abs() < 0.5,
                "copy sits at a replaced slot, got {}",
                n.transform.x
            );
        }
        // ONE undo brings both originals back
        e.undo();
        assert!(find(&e.root, "b").is_some(), "b restored");
        assert!(find(&e.root, "c").is_some(), "c restored");
    }

    #[test]
    fn paste_over_selection_replaces_and_stays_in_place() {
        let mut e = Editor::new(doc());
        e.selection = vec!["a".into()];
        e.copy();
        // paste_over_selection deletes the selection, then pastes in place
        e.selection = vec!["b".into()];
        let ids = e.paste_over_selection("page");
        assert!(find(&e.root, "b").is_none()); // replaced
        assert!(find(&e.root, "a").is_some()); // original "a" still there
        let copy = find(&e.root, &ids[0]).unwrap();
        assert_eq!((copy.transform.x, copy.transform.y), (10.0, 10.0));
    }

    #[test]
    fn clipboard_origin_reports_first_node_position() {
        let mut e = Editor::new(doc());
        e.selection = vec!["b".into()];
        e.copy();
        assert_eq!(e.clipboard_origin(), Some((200.0, 10.0)));
    }

    #[test]
    fn rename_node_changes_name_not_id_and_preserves_references() {
        // "b" carries a prototype link that navigates to "a". Renaming "a"
        // must change ONLY its display name — the id (and every reference
        // pointing at it) stays intact (Figma parity).
        let mut e = Editor::new(
            Node::frame("page", 800.0, 600.0)
                .child(Node::rect(
                    "a",
                    10.0,
                    10.0,
                    100.0,
                    50.0,
                    Color::from_rgb8(255, 0, 0),
                ))
                .child(
                    Node::rect("b", 200.0, 10.0, 100.0, 50.0, Color::from_rgb8(0, 255, 0))
                        .interaction(Interaction::click("a")),
                ),
        );
        assert!(e.rename_node("a", "Renamed A"));
        let a = find(&e.root, "a").expect("id must be stable");
        assert_eq!(a.name, "Renamed A");
        assert!(
            find(&e.root, "Renamed A").is_none(),
            "rename must not change the id"
        );
        // the navigation target on "b" still points at the unchanged id "a"
        let b = find(&e.root, "b").unwrap();
        assert_eq!(b.interactions[0].action.target(), Some("a"));
        // undo restores the name (and only the name)
        assert!(e.undo());
        assert_eq!(find(&e.root, "a").unwrap().name, "a");
        // duplicate names are allowed (Figma), unlike the old id-rename path
        assert!(e.rename_node("b", "Renamed A"));
        assert_eq!(find(&e.root, "b").unwrap().name, "Renamed A");
        // refusals: empty + no-op + unknown id
        assert!(!e.rename_node("a", "   "));
        assert!(!e.rename_node("b", "Renamed A"));
        assert!(!e.rename_node("nope", "X"));
    }

    #[test]
    fn smart_animate_interpolates_matching_ids() {
        let from = Node::frame("s1", 400.0, 400.0)
            .child(Node::rect(
                "box",
                0.0,
                0.0,
                100.0,
                100.0,
                Color::from_rgb8(255, 0, 0),
            ))
            .child(Node::rect(
                "leaving",
                300.0,
                300.0,
                50.0,
                50.0,
                Color::WHITE,
            ));
        let to = Node::frame("s2", 400.0, 400.0)
            .child(Node::rect(
                "box",
                200.0,
                100.0,
                200.0,
                100.0,
                Color::from_rgb8(0, 0, 255),
            ))
            .child(Node::rect("entering", 0.0, 300.0, 50.0, 50.0, Color::WHITE));
        let mid = smart_animate(&from, &to, 0.5);
        let boxn = find(&mid, "box").unwrap();
        assert_eq!(boxn.transform.x, 100.0); // (0+200)/2
        assert_eq!(boxn.transform.y, 50.0);
        assert_eq!(boxn.w, 150.0);
        if let Paint::Solid(c) = &boxn.fill {
            assert_eq!(
                (
                    (c.components[0] * 255.0).round() as u8,
                    (c.components[2] * 255.0).round() as u8
                ),
                (128, 128)
            ); // red->blue midpoint
        } else {
            panic!("expected solid fill")
        }
        // entering fades in, leaving fades out
        assert!((find(&mid, "entering").unwrap().opacity - 0.5).abs() < 1e-6);
        assert!((find(&mid, "leaving").unwrap().opacity - 0.5).abs() < 1e-6);
        // endpoints match the destinations exactly
        let end = smart_animate(&from, &to, 1.0);
        assert_eq!(find(&end, "box").unwrap().transform.x, 200.0);
        assert_eq!(find(&end, "leaving").unwrap().opacity, 0.0);
    }

    #[test]
    fn smart_animate_frames_are_renderable() {
        let from = Node::frame("s1", 400.0, 400.0).child(Node::rect(
            "box",
            0.0,
            0.0,
            100.0,
            100.0,
            Color::WHITE,
        ));
        let to = Node::frame("s2", 400.0, 400.0).child(Node::rect(
            "box",
            200.0,
            200.0,
            100.0,
            100.0,
            Color::WHITE,
        ));
        let mid = smart_animate(&from, &to, 0.25);
        let (_, s) = x_render::build_scene(&mid, None, &Variables::default());
        // the interpolated box, plus the morph frame's own name label
        assert_eq!(s.paths, 1 + label_paths("s1"));
    }

    #[test]
    fn set_opacity_is_undoable() {
        let mut e = Editor::new(doc());
        e.set_opacity("a", 0.4);
        assert!((find(&e.root, "a").unwrap().opacity - 0.4).abs() < 1e-6);
        e.undo();
        assert_eq!(find(&e.root, "a").unwrap().opacity, 1.0);
    }

    #[test]
    fn alignment_guides_detect_edges_and_centers() {
        // b: x∈[200,300] y∈[10,60]; move a to share b's top edge and left edge
        let mut d = doc();
        find_mut(&mut d, "a").unwrap().transform.x = 200.0; // left edges align
        let g = alignment_guides(&d, "a", 1.0);
        assert!(g.contains(&(true, 200.0)), "left-edge guide missing: {g:?}");
        assert!(g.contains(&(false, 10.0)), "top-edge guide missing: {g:?}");
        // center alignment: move a so its center-x hits b's center-x (250)
        find_mut(&mut d, "a").unwrap().transform.x = 200.0; // a: [200,300] center 250 == b center
        let g = alignment_guides(&d, "a", 1.0);
        assert!(g.contains(&(true, 250.0)), "center guide missing: {g:?}");
        // far away -> no guides
        find_mut(&mut d, "a").unwrap().transform.x = 500.0;
        find_mut(&mut d, "a").unwrap().transform.y = 400.0;
        let g = alignment_guides(&d, "a", 1.0);
        assert!(g.is_empty(), "expected no guides, got {g:?}");
    }

    #[test]
    fn set_auto_layout_solves_and_undoes_atomically() {
        use x_core::{AutoLayout, LayoutDirection, Sizing};
        let mut e = Editor::new(
            Node::frame("page", 800.0, 600.0).child(
                Node::frame("f", 400.0, 200.0)
                    .child(Node::rect("a", 300.0, 90.0, 50.0, 40.0, Color::WHITE))
                    .child(Node::rect("b", 20.0, 15.0, 70.0, 40.0, Color::WHITE)),
            ),
        );
        let vars = Variables::default();
        assert!(e.set_auto_layout(
            "f",
            Some(AutoLayout {
                direction: LayoutDirection::Horizontal,
                gap: 10.0,
                padding: [8.0; 4],
                sizing: Sizing::Fixed,
                ..Default::default()
            }),
            &vars
        ));
        // children re-stacked: a at padding, b after a + gap
        assert_eq!(find(&e.root, "a").unwrap().transform.x, 8.0);
        assert_eq!(find(&e.root, "b").unwrap().transform.x, 68.0); // 8+50+10
        assert!(e.auto_layout_of("f").is_some());
        // ONE undo restores the scattered originals AND removes the layout
        assert!(e.undo());
        assert_eq!(find(&e.root, "a").unwrap().transform.x, 300.0);
        assert_eq!(find(&e.root, "b").unwrap().transform.x, 20.0);
        assert!(e.auto_layout_of("f").is_none());
        // redo brings it back
        assert!(e.redo());
        assert_eq!(find(&e.root, "b").unwrap().transform.x, 68.0);
        // clearing layout keeps positions but removes the layout config
        assert!(e.set_auto_layout("f", None, &vars));
        assert!(e.auto_layout_of("f").is_none());
        assert_eq!(find(&e.root, "b").unwrap().transform.x, 68.0);
        // non-frames are rejected
        assert!(!e.set_auto_layout("a", None, &vars));
    }

    #[test]
    fn make_component_and_place_instances() {
        let mut e = Editor::new(doc());
        e.selection = vec!["a".into(), "b".into()];
        assert!(e.make_component("Card"));
        // selection is now the replacing instance
        assert_eq!(e.selection, vec!["Card-1".to_string()]);
        let inst = find(&e.root, "Card-1").unwrap();
        assert!(matches!(&inst.kind, NodeKind::Instance { component } if component == "Card"));
        assert_eq!(inst.transform.x, 10.0); // collective origin of a+b
        assert_eq!(inst.w, 290.0); // spans a(10..110) to b(200..300)
                                   // master exists, hidden, with re-based members
        let master = find(&e.root, "comp-Card").unwrap();
        assert!(!master.visible);
        assert_eq!(master.children.len(), 2);
        assert_eq!(master.children[0].transform.x, 0.0);
        // originals moved off the page INTO the master (still findable there)
        assert!(!e.root.children.iter().any(|c| c.id == "a"));
        assert!(master.children.iter().any(|c| c.id == "a"));
        // rendering resolves the instance -> master children paths
        let (_, s) = x_render::build_scene(&e.root, None, &Variables::default());
        // c (ellipse) + 2 resolved members + the page frame's label
        assert_eq!(s.paths, 3 + label_paths("page"));
        // stamp two more instances
        let id2 = e.place_instance("Card", 400.0, 300.0).unwrap();
        assert_eq!(id2, "Card-2");
        let (_, s) = x_render::build_scene(&e.root, None, &Variables::default());
        assert_eq!(s.paths, 5 + label_paths("page"));
        // editing the MASTER's child updates every instance render
        assert_eq!(e.component_names(), vec!["Card".to_string()]);
        // undo the placement, then undo the componentization entirely
        e.undo();
        assert!(find(&e.root, "Card-2").is_none());
        e.undo();
        assert!(find(&e.root, "a").is_some());
        assert!(find(&e.root, "comp-Card").is_none());
    }

    #[test]
    fn component_properties_add_set_and_undo() {
        use x_core::ComponentProp;
        let master = Node::component("comp-Btn", "Btn", 200.0, 50.0)
            .child(Node::text("lbl", 0.0, 0.0, 100.0, 20.0, "OK"))
            .child(Node::rect("icon", 110.0, 0.0, 30.0, 30.0, Color::WHITE))
            .child(Node::rect("bar", 0.0, 30.0, 200.0, 10.0, Color::WHITE));
        let page = Node::frame("page", 800.0, 600.0)
            .child(master)
            .child(Node::instance("Btn-1", "Btn", 10.0, 10.0, 200.0, 50.0));
        let mut e = Editor::new(page);

        // text + bool + number properties
        assert!(e.add_component_prop(
            "Btn",
            ComponentProp::Text {
                name: "Label".into(),
                target: "lbl".into(),
                default: "OK".into()
            }
        ));
        assert!(e.add_component_prop(
            "Btn",
            ComponentProp::Bool {
                name: "Show icon".into(),
                target: "icon".into(),
                default: true
            }
        ));
        assert!(e.add_component_prop(
            "Btn",
            ComponentProp::Number {
                name: "Bar width".into(),
                target: "bar".into(),
                target_property: "width".into(),
                default: 200.0,
                min: None,
                max: None
            }
        ));
        assert_eq!(e.component_props("Btn").len(), 3);

        // set each property on the instance -> typed overrides
        assert!(e.set_prop_value("Btn-1", "Label", "Hi"));
        assert!(e.set_prop_value("Btn-1", "Show icon", "false"));
        assert!(e.set_prop_value("Btn-1", "Bar width", "140"));
        let inst = find(&e.root, "Btn-1").unwrap();
        assert_eq!(
            inst.overrides.get("lbl").map(String::as_str),
            Some("text:Hi")
        );
        assert_eq!(
            inst.overrides.get("icon").map(String::as_str),
            Some("visible:false")
        );
        assert_eq!(
            inst.overrides.get("bar").map(String::as_str),
            Some("num:140")
        );

        // single undo restores the last (number) override
        assert!(e.undo());
        let inst = find(&e.root, "Btn-1").unwrap();
        assert!(!inst.overrides.contains_key("bar"));
        assert_eq!(
            inst.overrides.get("lbl").map(String::as_str),
            Some("text:Hi")
        );

        // removing a property drops it from the master
        assert!(e.remove_component_prop("Btn", "Label"));
        assert_eq!(e.component_props("Btn").len(), 2);
        assert!(e.component_props("Btn").iter().all(|p| p.name() != "Label"));
        assert!(e.undo());
        assert_eq!(e.component_props("Btn").len(), 3);

        // bad instance / bad prop / bad value are rejected
        assert!(!e.set_prop_value("nope", "Label", "x"));
        assert!(!e.set_prop_value("Btn-1", "nope", "x"));
        assert!(!e.set_prop_value("Btn-1", "Bar width", "abc"));
    }

    #[test]
    fn stroke_bound_color_property_repaints_only_the_stroke() {
        use x_core::ComponentProp;
        let master = Node::component("comp-Btn", "Btn", 200.0, 50.0).child(Node::rect(
            "body",
            0.0,
            0.0,
            200.0,
            50.0,
            Color::WHITE,
        ));
        let page = Node::frame("page", 800.0, 600.0)
            .child(master)
            .child(Node::instance("Btn-1", "Btn", 10.0, 10.0, 200.0, 50.0));
        let mut e = Editor::new(page);
        assert!(e.add_component_prop(
            "Btn",
            ComponentProp::Color {
                name: "Border".into(),
                target: "body".into(),
                target_property: "stroke".into(),
                default: Color::BLACK,
            }
        ));

        assert!(e.set_prop_value("Btn-1", "Border", "#00ff00"));
        let inst = find(&e.root, "Btn-1").unwrap();
        assert_eq!(
            inst.overrides.get("body").map(String::as_str),
            Some("stroke:#00ff00"),
            "a border colour must not encode as a fill"
        );

        // applying that override repaints the stroke, and only the stroke
        let root = e.root.clone();
        let inst = find(&root, "Btn-1").unwrap();
        let group = x_core::detach_instance(&root, inst, &Variables::default()).expect("detach");
        let body = group.children.iter().find(|c| c.name == "body").unwrap();
        assert!(
            matches!(&body.fill, Paint::Solid(c) if x_core::color_to_hex(*c) == "#ffffff"),
            "the interior keeps the master's fill, got {:?}",
            body.fill
        );
        assert_eq!(
            body.stroke.solid_color().map(x_core::color_to_hex),
            Some("#00ff00".to_string())
        );
        assert_eq!(
            body.stroke.width, 1.0,
            "a zero-width stroke is given a width so the override is visible"
        );

        // and the write is undoable like every other property assignment
        assert!(e.undo());
        let inst = find(&e.root, "Btn-1").unwrap();
        assert!(!inst.overrides.contains_key("body"));
    }

    #[test]
    fn rename_component_and_combine_variants() {
        let page = Node::frame("page", 800.0, 600.0)
            .child(Node::component("comp-Primary", "Primary", 100.0, 40.0))
            .child(Node::component("comp-Danger", "Danger", 100.0, 40.0))
            .child(Node::instance(
                "Primary-1",
                "Primary",
                10.0,
                10.0,
                100.0,
                40.0,
            ))
            .child(Node::instance(
                "Danger-1", "Danger", 10.0, 60.0, 100.0, 40.0,
            ));
        let mut e = Editor::new(page);

        // rename a component: master name + id and every instance follow
        assert!(e.rename_component("Primary", "Primary Renamed"));
        assert!(find(&e.root, "comp-Primary Renamed").is_some());
        assert!(find(&e.root, "comp-Primary").is_none());
        let inst = find(&e.root, "Primary-1").unwrap();
        assert!(
            matches!(&inst.kind, NodeKind::Instance { component } if component == "Primary Renamed")
        );
        assert!(e.undo());
        let inst = find(&e.root, "Primary-1").unwrap();
        assert!(matches!(&inst.kind, NodeKind::Instance { component } if component == "Primary"));
        // rename refusals: empty / unchanged / colliding / unknown
        assert!(!e.rename_component("Primary", "  "));
        assert!(!e.rename_component("Primary", "Primary"));
        assert!(!e.rename_component("Primary", "Danger"));
        assert!(!e.rename_component("Nope", "X"));

        // combine the two selected instances into one variant set
        e.selection = vec!["Primary-1".into(), "Danger-1".into()];
        assert_eq!(e.combine_as_variants("Button"), 2);
        assert_eq!(variants_of(&e.root, "Button").len(), 2);
        let inst = find(&e.root, "Primary-1").unwrap();
        assert!(
            matches!(&inst.kind, NodeKind::Instance { component } if component == "Button/Primary")
        );
        let inst = find(&e.root, "Danger-1").unwrap();
        assert!(
            matches!(&inst.kind, NodeKind::Instance { component } if component == "Button/Danger")
        );
        // masters were renamed too (id follows name)
        assert!(find(&e.root, "comp-Button/Primary").is_some());
        assert!(find(&e.root, "comp-Button/Danger").is_some());

        // same-set variant switch keeps overrides
        let mut i = find(&e.root, "Primary-1").unwrap().clone();
        i.overrides.insert("x".into(), "text:Hi".into());
        assert!(switch_variant(&mut i, "Button/Danger"));
        assert_eq!(i.overrides.get("x").map(String::as_str), Some("text:Hi"));

        // combine under a new name reuses existing variant parts
        e.selection = vec!["Primary-1".into(), "Danger-1".into()];
        assert_eq!(e.combine_as_variants("Widget"), 2);
        assert_eq!(variants_of(&e.root, "Widget").len(), 2);
        let inst = find(&e.root, "Primary-1").unwrap();
        assert!(
            matches!(&inst.kind, NodeKind::Instance { component } if component == "Widget/Primary")
        );

        // undo unwinds the renames one component at a time (reverse order)
        assert!(e.undo());
        assert!(
            matches!(&find(&e.root, "Danger-1").unwrap().kind, NodeKind::Instance { component } if component == "Button/Danger")
        );
        assert!(
            matches!(&find(&e.root, "Primary-1").unwrap().kind, NodeKind::Instance { component } if component == "Widget/Primary")
        );
        assert!(e.undo());
        assert!(
            matches!(&find(&e.root, "Primary-1").unwrap().kind, NodeKind::Instance { component } if component == "Button/Primary")
        );
    }

    #[test]
    fn variant_prop_defaults_grid() {
        use x_core::ComponentProp;
        let page = Node::frame("page", 800.0, 600.0)
            .child(
                Node::component("comp-Btn/Primary", "Btn/Primary", 200.0, 50.0)
                    .child(Node::text("lbl", 0.0, 0.0, 100.0, 20.0, "OK")),
            )
            .child(
                Node::component("comp-Btn/Danger", "Btn/Danger", 200.0, 50.0)
                    .child(Node::text("lbl", 0.0, 0.0, 100.0, 20.0, "Cancel")),
            );
        let mut e = Editor::new(page);
        let text_prop = ComponentProp::Text {
            name: "Label".into(),
            target: "lbl".into(),
            default: "OK".into(),
        };
        assert!(e.add_component_prop("Btn/Primary", text_prop.clone()));
        assert!(e.add_component_prop(
            "Btn/Danger",
            ComponentProp::Text {
                name: "Label".into(),
                target: "lbl".into(),
                default: "Cancel".into()
            }
        ));

        // editing a variant's default (grid cell) is undoable
        assert!(e.set_prop_default("Btn/Danger", "Label", "Stop"));
        assert!(
            matches!(&e.component_props("Btn/Danger")[0], ComponentProp::Text { default, .. } if default == "Stop")
        );
        assert!(e.undo());
        assert!(
            matches!(&e.component_props("Btn/Danger")[0], ComponentProp::Text { default, .. } if default == "Cancel")
        );

        // rejections: unknown component / unknown prop / bad bool / bad number
        assert!(!e.set_prop_default("Nope", "Label", "x"));
        assert!(!e.set_prop_default("Btn/Primary", "Nope", "x"));

        // add a bool prop to the whole set -> both variants share the column
        let bool_prop = ComponentProp::Bool {
            name: "Enabled".into(),
            target: "lbl".into(),
            default: true,
        };
        assert_eq!(e.add_component_prop_to_set("Btn", bool_prop), 2);
        assert!(e
            .component_props("Btn/Primary")
            .iter()
            .any(|p| p.name() == "Enabled"));
        assert!(e
            .component_props("Btn/Danger")
            .iter()
            .any(|p| p.name() == "Enabled"));
        // bool default parse path (valid + invalid)
        assert!(e.set_prop_default("Btn/Primary", "Enabled", "false"));
        assert!(
            matches!(&e.component_props("Btn/Primary")[1], ComponentProp::Bool { default, .. } if !*default)
        );
        assert!(!e.set_prop_default("Btn/Primary", "Enabled", "not-a-bool"));

        // remove from the whole set
        assert_eq!(e.remove_component_prop_from_set("Btn", "Enabled"), 2);
        assert!(e
            .component_props("Btn/Primary")
            .iter()
            .all(|p| p.name() != "Enabled"));
        assert!(e
            .component_props("Btn/Danger")
            .iter()
            .all(|p| p.name() != "Enabled"));
    }

    #[test]
    fn scale_tool_scales_subtree_uniformly() {
        let mut e = Editor::new(
            Node::frame("page", 800.0, 600.0).child(
                Node::frame("f", 200.0, 100.0)
                    .child(Node::rect("r", 20.0, 10.0, 50.0, 30.0, Color::WHITE).radius(8.0)),
            ),
        );
        assert!(e.scale_node("f", 2.0));
        let f = find(&e.root, "f").unwrap();
        assert_eq!((f.w, f.h), (400.0, 200.0));
        let r = find(&e.root, "r").unwrap();
        assert_eq!((r.transform.x, r.transform.y), (40.0, 20.0)); // offsets scaled
        assert_eq!((r.w, r.h), (100.0, 60.0));
        assert!(matches!(r.kind, NodeKind::Rect { radius } if radius == 16.0)); // radius scaled
        e.undo();
        assert_eq!(find(&e.root, "f").unwrap().w, 200.0);
        assert_eq!(find(&e.root, "r").unwrap().w, 50.0);
        // zero/negative factor rejected
        assert!(!e.scale_node("f", 0.0));
    }

    #[test]
    fn set_prototype_is_undoable() {
        let mut e = Editor::new(doc());
        e.set_prototype(
            "a",
            Some(x_core::PrototypeAction {
                destination: "page-2".into(),
                transition_ms: 300,
            }),
        );
        assert_eq!(
            find(&e.root, "a")
                .unwrap()
                .prototype
                .as_ref()
                .unwrap()
                .destination,
            "page-2"
        );
        e.undo();
        assert!(find(&e.root, "a").unwrap().prototype.is_none());
        e.redo();
        // clearing works too
        e.set_prototype("a", None);
        assert!(find(&e.root, "a").unwrap().prototype.is_none());
    }

    #[test]
    fn figma_click_selects_top_level_then_drills() {
        // page > group g > rect inner
        let d = Node::frame("page", 800.0, 600.0).child(
            Node::group("g", 200.0, 200.0).child(Node::rect(
                "inner",
                10.0,
                10.0,
                100.0,
                100.0,
                Color::WHITE,
            )),
        );
        let mut e = Editor::new(d);
        // plain click on inner selects TOP-LEVEL group (standard behavior)
        e.click_select(Point::new(50.0, 50.0), false, false);
        assert_eq!(e.selection, vec!["g".to_string()]);
        // deep click (ctrl) selects the exact node
        e.click_select(Point::new(50.0, 50.0), false, true);
        assert_eq!(e.selection, vec!["inner".to_string()]);
        // drill: from g, double-click goes one level down
        e.selection = vec!["g".into()];
        let next = e.drill_into(Point::new(50.0, 50.0));
        assert_eq!(next.as_deref(), Some("inner"));
    }

    #[test]
    fn ungroup_dissolves_and_preserves_positions() {
        let d = Node::frame("page", 800.0, 600.0).child({
            let mut g = Node::group("g", 200.0, 100.0)
                .child(Node::rect("a", 5.0, 6.0, 50.0, 40.0, Color::WHITE))
                .child(Node::rect("b", 60.0, 6.0, 50.0, 40.0, Color::WHITE));
            g.transform.x = 100.0;
            g.transform.y = 50.0;
            g
        });
        let mut e = Editor::new(d);
        assert!(e.ungroup("g"));
        assert!(find(&e.root, "g").is_none());
        let a = find(&e.root, "a").unwrap();
        assert_eq!((a.transform.x, a.transform.y), (105.0, 56.0)); // world position preserved
        assert_eq!(e.selection, vec!["a".to_string(), "b".to_string()]);
        // snapshot-undo restores the group
        assert!(e.undo());
        assert!(find(&e.root, "g").is_some());
        assert_eq!(find(&e.root, "a").unwrap().transform.x, 5.0);
    }

    #[test]
    fn select_all_scopes_to_selected_frame() {
        let d = Node::frame("page", 800.0, 600.0)
            .child(Node::rect("x", 0.0, 0.0, 10.0, 10.0, Color::WHITE))
            .child(
                Node::frame("f", 200.0, 200.0)
                    .child(Node::rect("c1", 0.0, 0.0, 10.0, 10.0, Color::WHITE))
                    .child(Node::rect("c2", 20.0, 0.0, 10.0, 10.0, Color::WHITE)),
            );
        let mut e = Editor::new(d);
        e.select_all();
        assert_eq!(e.selection.len(), 2); // x and f
                                          // with frame f selected, select-all scopes inside it
        e.selection = vec!["f".into()];
        e.select_all();
        assert_eq!(e.selection, vec!["c1".to_string(), "c2".to_string()]);
    }

    #[test]
    fn snap_delta_pulls_to_nearby_edges() {
        let mut d = doc();
        // a: x∈[10,110]; b: x∈[200,300]. Move a so its right edge is 3px from b's left.
        find_mut(&mut d, "a").unwrap().transform.x = 97.0; // right edge 197, b.x0=200, d=3
        let (dx, _) = snap_delta(&d, "a", 6.0);
        assert_eq!(dx, 3.0); // pulled right to touch exactly
                             // vertical: a.y=10 already aligns with b.y=10 -> dy 0 (already snapped)
        let (_, dy) = snap_delta(&d, "a", 6.0);
        assert_eq!(dy, 0.0);
        // far away -> no snap
        find_mut(&mut d, "a").unwrap().transform.x = 400.0;
        find_mut(&mut d, "a").unwrap().transform.y = 400.0;
        assert_eq!(snap_delta(&d, "a", 6.0), (0.0, 0.0));
    }

    #[test]
    fn set_pin_is_undoable() {
        let mut e = Editor::new(doc());
        e.set_pin("a", x_core::HPin::Right, x_core::VPin::Bottom);
        assert_eq!(
            find(&e.root, "a").unwrap().pin,
            (x_core::HPin::Right, x_core::VPin::Bottom)
        );
        e.undo();
        assert_eq!(
            find(&e.root, "a").unwrap().pin,
            (x_core::HPin::Left, x_core::VPin::Top)
        );
    }

    #[test]
    fn detach_is_undoable_and_applies_overrides() {
        use x_components::{set_override, OverrideValue};
        let mut comp = Node::component("c", "Chip", 60.0, 24.0);
        comp.visible = false;
        comp.children
            .push(Node::rect("chip-bg", 0.0, 0.0, 60.0, 24.0, Color::BLACK));
        let mut inst = Node::instance("i1", "Chip", 100.0, 100.0, 60.0, 24.0);
        set_override(
            &mut inst,
            "chip-bg",
            OverrideValue::Fill(Color::from_rgb8(0, 0xff, 0)),
        );
        let mut e = Editor::new(Node::frame("page", 400.0, 300.0).child(comp).child(inst));
        assert!(!e.detach_selected_instance(&Variables::default())); // nothing selected
        e.selection = vec!["i1".into()];
        assert!(e.detach_selected_instance(&Variables::default()));
        let g = find(&e.root, "i1").unwrap();
        assert!(
            matches!(g.kind, NodeKind::Group),
            "detach retains external identity"
        );
        assert_eq!(g.transform.x, 100.0);
        let bg = g.children.iter().find(|c| c.name == "chip-bg").unwrap();
        assert!(
            matches!(&bg.fill, Paint::Solid(c) if (c.components[1]*255.0).round() as u8 == 0xff)
        );
        e.undo();
        assert!(find(&e.root, "i1").is_some());
        assert!(matches!(
            find(&e.root, "i1").unwrap().kind,
            NodeKind::Instance { .. }
        ));
    }

    #[test]
    fn swap_instance_is_undoable() {
        let mut e = Editor::new(Node::frame("page", 400.0, 300.0).child(Node::instance(
            "i",
            "Button/Primary",
            0.0,
            0.0,
            100.0,
            40.0,
        )));
        assert!(e.swap_instance("i", "Button/Danger"));
        assert!(
            matches!(&find(&e.root, "i").unwrap().kind, NodeKind::Instance { component } if component == "Button/Danger")
        );
        e.undo();
        assert!(
            matches!(&find(&e.root, "i").unwrap().kind, NodeKind::Instance { component } if component == "Button/Primary")
        );
    }

    #[test]
    fn checkpoints_restore() {
        let mut e = Editor::new(doc());
        e.checkpoint("v1");
        e.selection = vec!["a".into()];
        e.move_selection(500.0, 0.0);
        assert_eq!(find(&e.root, "a").unwrap().transform.x, 510.0);
        assert!(e.restore_checkpoint("v1"));
        assert_eq!(find(&e.root, "a").unwrap().transform.x, 10.0);
    }

    #[test]
    fn dev_mode_xml_export() {
        let n = Node::rect(
            "hero-card",
            0.0,
            0.0,
            240.0,
            120.0,
            Color::from_rgb8(0x0d, 0x99, 0xff),
        )
        .radius(16.0)
        .opacity(0.9);
        let xml = node_to_xml(&n, &Variables::default());
        assert!(xml.contains("<View"), "{xml}");
        assert!(xml.contains("android:id=\"@+id/hero_card\""), "{xml}");
        assert!(xml.contains("android:layout_width=\"240dp\""), "{xml}");
        assert!(xml.contains("android:layout_height=\"120dp\""), "{xml}");
        assert!(xml.contains("android:background=\"#FF0D99FF\""), "{xml}");
        assert!(xml.contains("corner radius 16dp"), "{xml}");
        assert!(xml.contains("android:alpha=\"0.90\""), "{xml}");
    }

    #[test]
    fn dev_mode_xml_text_and_flex() {
        let t = Node::text("t1", 0.0, 0.0, 16.0, 20.0, "Tea & \"Crumpets\"");
        let xml = node_to_xml(&t, &Variables::default());
        assert!(xml.contains("<TextView"), "{xml}");
        assert!(
            xml.contains("android:text=\"Tea &amp; &quot;Crumpets&quot;\""),
            "{xml}"
        );
        assert!(xml.contains("android:textSize=\"20sp\""), "{xml}");

        let f = Node::frame("row", 400.0, 80.0).auto_layout(x_core::AutoLayout {
            direction: x_core::LayoutDirection::Horizontal,
            gap: 12.0,
            padding: [8.0, 8.0, 4.0, 4.0],
            ..Default::default()
        });
        let xml = node_to_xml(&f, &Variables::default());
        assert!(xml.contains("<LinearLayout"), "{xml}");
        assert!(xml.contains("android:orientation=\"horizontal\""), "{xml}");
        assert!(xml.contains("android:paddingStart=\"8dp\""), "{xml}");
        assert!(xml.contains("item gap 12dp"), "{xml}");
    }

    #[test]
    fn code_connect_comment_in_all_platforms() {
        let mut n = Node::rect("c", 0.0, 0.0, 10.0, 10.0, Color::WHITE);
        n.bindings.insert("code".into(), "repo/ui/Card.kt".into());
        let vars = Variables::default();
        assert!(node_to_css(&n, &vars).contains("/* code connect: repo/ui/Card.kt */"));
        assert!(node_to_swift(&n, &vars).contains("// code connect: repo/ui/Card.kt"));
        assert!(node_to_compose(&n, &vars).contains("// code connect: repo/ui/Card.kt"));
        assert!(node_to_xml(&n, &vars).contains("<!-- code connect: repo/ui/Card.kt -->"));
    }

    #[test]
    fn dev_mode_css_export() {
        let n = Node::rect(
            "card",
            0.0,
            0.0,
            240.0,
            120.0,
            Color::from_rgb8(0x0d, 0x99, 0xff),
        )
        .radius(16.0)
        .opacity(0.9)
        .effect(x_core::Effect::DropShadow {
            dx: 0.0,
            dy: 4.0,
            blur: 12.0,
            color: Color::from_rgba8(0, 0, 0, 128),
        });
        let css = node_to_css(&n, &Variables::default());
        assert!(css.contains("width: 240px"));
        assert!(css.contains("background: #0d99ff"));
        assert!(css.contains("border-radius: 16px"));
        assert!(css.contains("box-shadow: 0px 4px 12px"));
    }

    #[test]
    fn reset_instance_overrides_is_undoable_and_keeps_slots() {
        // master + instance with an override and slot content
        let mut master = Node::component("def", "Card", 200.0, 100.0)
            .child(Node::text("title", 0.0, 0.0, 180.0, 16.0, "Card"));
        master.props.push(x_core::ComponentProp::Slot {
            name: "Content".into(),
            target: "title".into(),
            default: None,
        });
        let mut inst = Node::instance("i1", "Card", 10.0, 10.0, 200.0, 100.0);
        x_core::set_override(&mut inst, "title", x_core::OverrideValue::Text("Hi".into()));
        x_core::set_slot_content(
            &mut inst,
            "Content",
            Node::rect("badge", 0.0, 0.0, 40.0, 12.0, Color::WHITE),
        );
        let mut e = Editor::new(Node::frame("r", 500.0, 500.0).child(master).child(inst));

        assert!(e.reset_instance_overrides("i1"));
        let n = crate::find(&e.root, "i1").unwrap();
        assert!(n.overrides.is_empty());
        assert_eq!(n.children.len(), 1, "slot content kept");

        // not an instance -> no-op
        assert!(!e.reset_instance_overrides("r"));

        e.undo();
        let n = crate::find(&e.root, "i1").unwrap();
        assert_eq!(n.overrides.len(), 1, "reset undone");
    }

    #[test]
    fn detach_instance_is_undoable() {
        let master = Node::component("def", "Card", 200.0, 100.0).child(Node::rect(
            "bg",
            0.0,
            0.0,
            200.0,
            100.0,
            Color::BLACK,
        ));
        let mut inst = Node::instance("i1", "Card", 10.0, 10.0, 200.0, 100.0);
        x_core::set_override(&mut inst, "bg", x_core::OverrideValue::Fill(Color::WHITE));
        let mut e = Editor::new(Node::frame("r", 500.0, 500.0).child(master).child(inst));

        let new_id = e.detach("i1", &Variables::default()).expect("detach");
        assert_eq!(new_id, "i1", "detach preserves incoming references");
        let g = crate::find(&e.root, &new_id).unwrap();
        assert!(matches!(g.kind, x_core::NodeKind::Group));
        assert!(matches!(&g.children[0].kind, x_core::NodeKind::Rect { .. }));
        assert_eq!(
            g.children[0].fill,
            Paint::Solid(Color::WHITE),
            "override applied"
        );

        e.undo();
        assert!(crate::find(&e.root, "i1").is_some(), "instance restored");
        assert!(matches!(
            crate::find(&e.root, &new_id).unwrap().kind,
            NodeKind::Instance { .. }
        ));
    }
    #[test]
    fn dev_mode_css_emits_flex_for_auto_layout_frames() {
        let mut f = Node::frame("row", 400.0, 300.0);
        if let NodeKind::Frame { layout } = &mut f.kind {
            *layout = Some(AutoLayout {
                direction: LayoutDirection::Horizontal,
                gap: 12.0,
                // [left, right, top, bottom] — asymmetric to pin CSS order
                padding: [8.0, 16.0, 4.0, 12.0],
                sizing: Sizing::Fixed,
                align: CrossAlign::Baseline,
                distribute: Distribute::Between,
                wrap: AutoLayoutWrap::Wrap,
                min_width: Some(200.0),
                max_width: Some(600.0),
                ..Default::default()
            });
        }
        let css = node_to_css(&f, &Variables::default());
        assert!(css.contains("display: flex;"), "{css}");
        assert!(css.contains("flex-direction: row;"), "{css}");
        assert!(css.contains("gap: 12px;"), "{css}");
        // CSS shorthand is top right bottom left: [l,r,t,b]=[8,16,4,12]
        // -> "4px 16px 12px 8px"
        assert!(css.contains("padding: 4px 16px 12px 8px;"), "{css}");
        assert!(css.contains("align-items: baseline;"), "{css}");
        assert!(css.contains("justify-content: space-between;"), "{css}");
        assert!(css.contains("flex-wrap: wrap;"), "{css}");
        assert!(css.contains("min-width: 200px;"), "{css}");
        assert!(css.contains("max-width: 600px;"), "{css}");
    }

    #[test]
    fn dev_mode_css_emits_grid_for_grid_frames() {
        let mut f = Node::frame("gallery", 600.0, 400.0);
        if let NodeKind::Frame { layout } = &mut f.kind {
            *layout = Some(AutoLayout {
                direction: LayoutDirection::Vertical,
                sizing: Sizing::Fixed,
                grid: Some(GridLayout {
                    columns: vec![
                        GridTrack::Fixed(120.0),
                        GridTrack::Fr(1.0),
                        GridTrack::Fr(2.0),
                        GridTrack::Auto,
                    ],
                    rows: vec![GridTrack::Fixed(60.0)],
                    column_gap: 12.0,
                    row_gap: 8.0,
                    padding: [8.0, 8.0, 8.0, 8.0],
                    auto_flow: GridAutoFlow::Row,
                }),
                ..Default::default()
            });
        }
        let mut hero = Node::rect("hero", 10.0, 10.0, 50.0, 50.0, Color::WHITE);
        hero.constraints.grid_col = Some(0);
        hero.constraints.grid_row = Some(0);
        hero.constraints.grid_col_span = 2;
        f.children.push(hero);
        let css = node_to_css(&f, &Variables::default());
        assert!(css.contains("display: grid;"), "{css}");
        assert!(
            css.contains("grid-template-columns: 120px 1fr 2fr auto;"),
            "{css}"
        );
        assert!(css.contains("grid-template-rows: 60px;"), "{css}");
        assert!(css.contains("gap: 8px 12px;"), "{css}");
        assert!(css.contains("padding: 8px;"), "{css}");
        assert!(css.contains("grid-column: 1 / span 2;"), "{css}");
        assert!(css.contains("grid-row: 1"), "{css}");
        assert!(!css.contains("flex-direction"), "grid replaces flex: {css}");
    }
    #[test]
    fn dev_mode_css_text_color_blend_blurs_inner_shadow_and_note() {
        let mut t = Node::text("t", 0.0, 0.0, 200.0, 24.0, "hello");
        t.fill = Paint::Solid(Color::from_rgb8(0x33, 0x33, 0x33));
        let css = node_to_css(&t, &Variables::default());
        assert!(css.contains("color: #333333;"), "text fill -> color: {css}");
        assert!(
            !css.contains("background: #333333"),
            "text fill must not emit background"
        );

        let mut r = Node::rect("glass", 0.0, 0.0, 100.0, 60.0, Color::WHITE);
        r.blend = BlendKind::Multiply;
        r.effects = vec![
            x_core::Effect::InnerShadow {
                dx: 0.0,
                dy: 2.0,
                blur: 4.0,
                color: Color::BLACK,
            },
            x_core::Effect::LayerBlur { radius: 8.0 },
            x_core::Effect::BackgroundBlur { radius: 6.0 },
        ];
        r.set_note(Some("Card background — blur token: blur/md"));
        let css = node_to_css(&r, &Variables::default());
        assert!(css.contains("mix-blend-mode: multiply;"), "{css}");
        assert!(css.contains("inset 0px 2px 4px"), "{css}");
        assert!(css.contains("filter: blur(8px);"), "{css}");
        assert!(css.contains("backdrop-filter: blur(6px);"), "{css}");
        assert!(css.contains("/* note: Card background"), "{css}");
    }

    #[test]
    fn export_tokens_w3c_dtcg_structure() {
        let mut doc = Document::new();
        doc.variables
            .colors
            .insert("brand".into(), Color::from_rgb8(0x0d, 0x99, 0xff));
        doc.variables
            .collections
            .insert("brand".into(), "Semantic".into());
        doc.variables.numbers.insert("space/md".into(), 16.0);
        doc.variables
            .strings
            .insert("app/name".into(), "X-Native".into());
        doc.variables.bools.insert("dark".into(), true);
        doc.variables
            .aliases
            .insert("brand-alias".into(), "brand".into());
        doc.variables
            .colors
            .insert("brand-alias".into(), Color::BLACK);
        doc.variables.modes.insert(
            "dark".into(),
            [("brand".to_string(), Color::from_rgb8(0x99, 0x0d, 0xff))]
                .into_iter()
                .collect(),
        );

        let json = export_tokens(&doc);
        assert!(
            json.contains("\"$schema\": \"https://tr.designtokens.org/format/\""),
            "{json}"
        );
        assert!(json.contains("\"Semantic\": {"), "{json}");
        assert!(
            json.contains("\"brand\": {\"$type\": \"color\", \"$value\": \"#0d99ff\""),
            "{json}"
        );
        assert!(
            json.contains("\"$value\": \"{brand}\""),
            "alias uses DTCG reference: {json}"
        );
        assert!(
            json.contains("\"space/md\": {\"$type\": \"number\", \"$value\": 16"),
            "{json}"
        );
        assert!(
            json.contains("\"app/name\": {\"$type\": \"string\", \"$value\": \"X-Native\""),
            "{json}"
        );
        assert!(
            json.contains("\"dark\": {\"$type\": \"boolean\", \"$value\": true"),
            "{json}"
        );
        assert!(
            json.contains("\"com.x-native.modes\": {\"dark\": \"#990dff\""),
            "mode values ride the extension: {json}"
        );
    }
    #[test]
    fn dev_mode_css_includes_position_pins_and_image_fills() {
        let mut img = Node::image("hero", 12.0, 34.0, 100.0, 50.0, "asset://abc123");
        img.pin = (HPin::StretchH, VPin::ScaleV);
        let css = node_to_css(&img, &Variables::default());
        assert!(css.contains("position: absolute;"));
        assert!(css.contains("left: 12px;"));
        assert!(css.contains("top: 34px;"));
        assert!(css.contains("background-image: url(\"asset://abc123\")"));
        assert!(css.contains("/* resize: pinned stretch-h / scale-v */"));
        // default pins stay silent
        let plain = node_to_css(
            &Node::rect("r", 0.0, 0.0, 10.0, 10.0, Color::BLACK),
            &Variables::default(),
        );
        assert!(!plain.contains("resize"));
    }

    #[test]
    fn dev_mode_css_hints_rich_text_runs() {
        let mut t = Node::text("t1", 0.0, 0.0, 200.0, 18.0, "Mixed style");
        t.text_runs = vec![
            TextRun {
                start: 0,
                len: 5,
                color: Some(Color::from_rgb8(255, 0, 0)),
                size: None,
                font: None,
                weight: None,
                italic: None,
                ls: None,
            },
            TextRun {
                start: 6,
                len: 5,
                color: None,
                size: Some(28.0),
                font: None,
                weight: None,
                italic: None,
                ls: None,
            },
        ];
        let css = node_to_css(&t, &Variables::default());
        assert!(
            css.contains("2 rich text run(s)"),
            "dev mode surfaces the run count: {css}"
        );
        let plain = node_to_css(
            &Node::text("t2", 0.0, 0.0, 100.0, 18.0, "plain"),
            &Variables::default(),
        );
        assert!(!plain.contains("rich text run"), "plain text gets no hint");
    }

    #[test]
    fn dev_mode_css_hints_pattern_fills() {
        let r = Node::rect("r", 0.0, 0.0, 100.0, 50.0, Color::WHITE).fill_paint(Paint::Pattern {
            asset: "asset://cafe".into(),
            fit: ImageFit::Tile,
        });
        let css = node_to_css(&r, &Variables::default());
        assert!(
            css.contains("background-image: url(asset://cafe); /* image pattern */"),
            "pattern hint: {css}"
        );
    }

    #[test]
    fn dev_mode_css_emits_typography_for_text() {
        let mut t = Node::text("t1", 0.0, 0.0, 200.0, 18.0, "Headline");
        t.bindings.insert("font".into(), "Roboto-Medium".into());
        t.bindings.insert("lh".into(), "1.5".into());
        t.bindings.insert("ls".into(), "0.5".into());
        let css = node_to_css(&t, &Variables::default());
        assert!(css.contains("font-size: 18px;"));
        assert!(css.contains("font-family: \"Roboto-Medium\";"));
        assert!(css.contains("line-height: 1.5;"));
        assert!(css.contains("letter-spacing: 0.5px;"));
        // non-text nodes get no typography lines
        let rect = node_to_css(
            &Node::rect("r", 0.0, 0.0, 10.0, 10.0, Color::BLACK),
            &Variables::default(),
        );
        assert!(!rect.contains("font-size"));
    }

    #[test]
    fn dev_mode_css_emits_borders() {
        let mut n = Node::rect("r", 0.0, 0.0, 10.0, 10.0, Color::BLACK);
        n.stroke = x_core::Stroke::solid(Color::from_rgb8(0x11, 0x22, 0x33), 2.0);
        let css = node_to_css(&n, &Variables::default());
        assert!(css.contains("border: 2px solid #112233;"));
        // gradient stroke degrades to a commented hint
        n.stroke = x_core::Stroke {
            paint: Paint::LinearGradient {
                start: (0.0, 0.0),
                end: (10.0, 0.0),
                stops: vec![(0.0, Color::BLACK), (1.0, Color::WHITE)],
                space: x_core::GradSpace::Srgb,
            },
            width: 3.0,
        };
        let css = node_to_css(&n, &Variables::default());
        assert!(css.contains("border: 3px solid; /* gradient stroke */"));
    }

    #[test]
    fn dev_mode_swift_and_compose_export() {
        let n = Node::rect(
            "card",
            0.0,
            0.0,
            240.0,
            120.0,
            Color::from_rgb8(0x0d, 0x99, 0xff),
        )
        .radius(16.0)
        .opacity(0.9);
        let swift = node_to_swift(&n, &Variables::default());
        assert!(swift.contains("RoundedRectangle(cornerRadius: 16)"));
        assert!(swift.contains(".frame(width: 240, height: 120)"));
        assert!(swift.contains("Color(hex: 0x0D99FF)"));
        assert!(swift.contains(".opacity(0.90)"));
        let compose = node_to_compose(&n, &Variables::default());
        assert!(compose.contains(".size(240.dp, 120.dp)"));
        assert!(compose.contains("RoundedCornerShape(16.dp)"));
        assert!(compose.contains(".background(Color(0x0D99FFFF))"));
    }

    #[test]
    fn dev_mode_tokens_and_measurements() {
        let mut vars = Variables::default();
        vars.colors
            .insert("accent".into(), Color::from_rgb8(0x0d, 0x99, 0xff));
        let mut n = Node::rect(
            "card",
            20.0,
            10.0,
            100.0,
            50.0,
            Color::from_rgb8(0x0d, 0x99, 0xff),
        );
        n.bindings.insert("radius".into(), "r-token".into());
        let page = Node::frame("page", 400.0, 300.0).child(n);
        // color token: solid fill matches the "accent" variable
        let tokens = node_tokens(find(&page, "card").unwrap(), &vars);
        assert!(
            tokens.iter().any(|(_, t)| t == "accent"),
            "color token found"
        );
        assert!(
            tokens.iter().any(|(_, t)| t == "r-token"),
            "radius binding found"
        );
        // measurements: card at (20,10) size 100x50 in a 400x300 page
        let m = node_measurements(&page, "card").unwrap();
        assert_eq!(
            (m.left, m.top, m.right, m.bottom),
            (20.0, 10.0, 280.0, 240.0)
        );
        assert_eq!(
            (m.w, m.h, m.parent_w, m.parent_h),
            (100.0, 50.0, 400.0, 300.0)
        );
        // a variable-bound fill surfaces as a "Fill" token
        let mut vn = Node::rect("v", 0.0, 0.0, 10.0, 10.0, Color::WHITE);
        vn.fill = Paint::Variable("accent".into());
        let vtokens = node_tokens(&vn, &vars);
        assert!(vtokens.iter().any(|(k, t)| k == "Fill" && t == "accent"));
    }

    #[test]
    fn dev_mode_gap_and_assets() {
        // gap between two side-by-side siblings
        let page = Node::frame("page", 400.0, 300.0)
            .child(Node::rect("a", 0.0, 0.0, 100.0, 50.0, Color::WHITE))
            .child(Node::rect("b", 120.0, 0.0, 100.0, 50.0, Color::WHITE));
        let g = node_gap(&page, "a", "b").unwrap();
        assert!((g.horizontal - 20.0).abs() < 1e-9, "20px gap: {g:?}");
        assert!(g.vertical < 0.0, "y-ranges overlap: {g:?}");
        // order-insensitive
        let g2 = node_gap(&page, "b", "a").unwrap();
        assert_eq!(g.horizontal, g2.horizontal);
        // stacked
        let page2 = Node::frame("page", 400.0, 300.0)
            .child(Node::rect("a", 0.0, 0.0, 100.0, 50.0, Color::WHITE))
            .child(Node::rect("b", 0.0, 70.0, 100.0, 50.0, Color::WHITE));
        let g3 = node_gap(&page2, "a", "b").unwrap();
        assert!((g3.vertical - 20.0).abs() < 1e-9, "stacked gap: {g3:?}");
        assert!(g3.horizontal < 0.0, "x-ranges overlap: {g3:?}");

        // assets: an instance + an image in the selection
        let mut img = Node::image("img", 0.0, 0.0, 50.0, 50.0, "asset://cat");
        let _ = &mut img;
        let doc = Node::frame("page", 400.0, 300.0)
            .child(Node::image("i1", 0.0, 0.0, 50.0, 50.0, "asset://cat"))
            .child(Node::instance("inst", "Button", 60.0, 0.0, 100.0, 40.0));
        let assets = selection_assets(&doc, &["i1".into(), "inst".into()]);
        assert!(assets
            .iter()
            .any(|a| a.kind == "IMAGE" && a.name == "asset://cat"));
        assert!(assets
            .iter()
            .any(|a| a.kind == "COMPONENT" && a.name == "Button"));
    }

    #[test]
    fn dev_mode_gradient_and_text_fidelity() {
        // linear gradient emits its angle
        let mut n = Node::rect("g", 0.0, 0.0, 200.0, 200.0, Color::WHITE);
        n.fill = Paint::LinearGradient {
            start: (0.0, 0.0),
            end: (200.0, 0.0),
            stops: vec![(0.0, Color::BLACK), (1.0, Color::WHITE)],
            space: x_core::GradSpace::Srgb,
        };
        let css = node_to_css(&n, &Variables::default());
        assert!(
            css.contains("linear-gradient(90.0deg"),
            "left→right = 90deg: {css}"
        );
        // radial gradient
        let mut r = Node::rect("r", 0.0, 0.0, 200.0, 200.0, Color::WHITE);
        r.fill = Paint::RadialGradient {
            center: (100.0, 100.0),
            radius: 80.0,
            stops: vec![(0.0, Color::WHITE), (1.0, Color::BLACK)],
            space: x_core::GradSpace::Srgb,
        };
        let css_r = node_to_css(&r, &Variables::default());
        assert!(css_r.contains("radial-gradient"), "radial emitted: {css_r}");
        // text node with a full bold span emits font-weight + letter-spacing
        let mut t = Node::text("t", 0.0, 0.0, 100.0, 20.0, "hi");
        t.text_runs = vec![TextRun {
            start: 0,
            len: 2,
            weight: Some(700),
            ls: Some(2.0),
            ..Default::default()
        }];
        let css_t = node_to_css(&t, &Variables::default());
        assert!(css_t.contains("font-size:"), "font-size: {css_t}");
        assert!(css_t.contains("font-weight: bold"), "bold: {css_t}");
        assert!(css_t.contains("letter-spacing: 2px"), "ls: {css_t}");
        let swift_t = node_to_swift(&t, &Variables::default());
        assert!(swift_t.contains(".bold()") && swift_t.contains(".tracking(2.0)"));
        let compose_t = node_to_compose(&t, &Variables::default());
        assert!(
            compose_t.contains(".fontWeight(FontWeight.Bold)")
                && compose_t.contains(".letterSpacing(2.0.sp)")
        );
    }

    #[test]
    fn dev_mode_nested_offsets() {
        // a child nested inside a frame -> edge insets, not a disjoint gap
        let mut frame = Node::frame("frame", 200.0, 120.0).child(Node::rect(
            "child",
            10.0,
            10.0,
            100.0,
            40.0,
            Color::WHITE,
        ));
        frame.transform.x = 20.0;
        frame.transform.y = 20.0;
        let page = Node::frame("page", 400.0, 300.0).child(frame);
        let g = node_gap(&page, "frame", "child").unwrap();
        let nst = g.nested.expect("nested detection");
        assert!(nst.a_contains_b, "frame contains child");
        // child at (30,30) in world; frame at (20,20) size 200x120
        assert!((nst.left - 10.0).abs() < 1e-9, "left inset: {nst:?}");
        assert!((nst.top - 10.0).abs() < 1e-9, "top inset: {nst:?}");
        assert!((nst.right - 90.0).abs() < 1e-9, "right inset: {nst:?}");
        assert!((nst.bottom - 70.0).abs() < 1e-9, "bottom inset: {nst:?}");
        // reversed argument order still detects nesting (b contains a)
        let g2 = node_gap(&page, "child", "frame").unwrap();
        let nst2 = g2.nested.expect("nested detection (reversed)");
        assert!(!nst2.a_contains_b);
        assert!((nst2.left - 10.0).abs() < 1e-9);
        // disjoint siblings have no nested info
        let page2 = Node::frame("page", 400.0, 300.0)
            .child(Node::rect("a", 0.0, 0.0, 100.0, 50.0, Color::WHITE))
            .child(Node::rect("b", 120.0, 0.0, 100.0, 50.0, Color::WHITE));
        assert!(node_gap(&page2, "a", "b").unwrap().nested.is_none());
    }

    #[test]
    fn dev_mode_multispan_letter_spacing_falls_back_to_node_default() {
        // multi-span text (no full-span override) must still export the node's
        // base letter-spacing from the `ls` binding instead of dropping it.
        let mut t = Node::text("t", 0.0, 0.0, 100.0, 20.0, "hello world");
        t.bindings.insert("ls".into(), "1.5".into());
        t.text_runs = vec![
            TextRun {
                start: 0,
                len: 5,
                color: Some(Color::from_rgb8(255, 0, 0)),
                ..Default::default()
            },
            TextRun {
                start: 6,
                len: 5,
                weight: Some(700),
                ..Default::default()
            },
        ];
        let css = node_to_css(&t, &Variables::default());
        assert!(
            css.contains("letter-spacing: 1.5px"),
            "multi-span ls fallback: {css}"
        );
        let swift = node_to_swift(&t, &Variables::default());
        assert!(
            swift.contains(".tracking(1.5)"),
            "swift multi-span ls: {swift}"
        );
        let compose = node_to_compose(&t, &Variables::default());
        assert!(
            compose.contains(".letterSpacing(1.5.sp)"),
            "compose multi-span ls: {compose}"
        );
    }
}

#[test]
fn reorder_top_level_roundtrip() {
    let mut e = Editor::new(Node::frame("root", 1000.0, 1000.0));
    let r = x_core::Node::rect(
        "r1",
        0.0,
        0.0,
        10.0,
        10.0,
        x_core::Color::from_rgb8(1, 2, 3),
    );
    let el = x_core::Node::ellipse(
        "e1",
        20.0,
        0.0,
        10.0,
        10.0,
        x_core::Color::from_rgb8(4, 5, 6),
    );
    e.insert_node("root", r);
    e.insert_node("root", el);
    e.send_to_back("e1");
    assert_eq!(e.root.children[0].id, "e1");
    e.bring_to_front("e1");
    assert_eq!(e.root.children[1].id, "e1", "front again");
}

#[cfg(test)]
mod component_and_proto_engine {
    use crate::prototype::Player;
    use crate::*;
    use x_core::kurbo::Point;
    use x_core::*;

    fn doc_with_set() -> Node {
        let mut root = Node::frame("root", 800.0, 600.0);
        let mut master = Node::frame("m1", 100.0, 40.0);
        master.kind = NodeKind::Component {
            name: "Button/Primary".into(),
        };
        master.transform.x = 0.0;
        let mut master2 = Node::frame("m2", 100.0, 40.0);
        master2.kind = NodeKind::Component {
            name: "Button/Ghost".into(),
        };
        master2.transform.x = 200.0;
        let mut inst = Node::rect("i1", 0.0, 100.0, 100.0, 40.0, Color::WHITE);
        inst.kind = NodeKind::Instance {
            component: "Button/Primary".into(),
        };
        root.children.push(master);
        root.children.push(master2);
        root.children.push(inst);
        root
    }

    fn find<'a>(n: &'a Node, id: &str) -> Option<&'a Node> {
        if n.id == id {
            return Some(n);
        }
        n.children.iter().find_map(|c| find(c, id))
    }

    #[test]
    fn variant_siblings_and_switch() {
        let mut e = Editor::new(doc_with_set());
        assert_eq!(
            e.variant_siblings("Button/Primary"),
            vec!["Ghost", "Primary"]
        );
        assert!(e.variant_siblings("Loose").is_empty());
        assert!(e.set_instance_component("i1", "Button/Ghost"));
        let NodeKind::Instance { component } = &find(&e.root, "i1").unwrap().kind else {
            panic!("still instance")
        };
        assert_eq!(component, "Button/Ghost");
        assert!(
            !e.set_instance_component("i1", "Button/Ghost"),
            "no-op rejected"
        );
        e.undo();
        let NodeKind::Instance { component } = &find(&e.root, "i1").unwrap().kind else {
            panic!("still instance")
        };
        assert_eq!(component, "Button/Primary", "undo restores variant");
    }

    #[test]
    fn interactions_and_start_point_are_undoable() {
        let mut e = Editor::new(doc_with_set());
        assert!(e.set_node_interactions("i1", vec![Interaction::click("m2")]));
        let n = find(&e.root, "i1").unwrap();
        assert_eq!(n.interactions.len(), 1);
        assert!(n.prototype.is_none(), "legacy link cleared");
        assert_eq!(effective_interactions(n).len(), 1);
        assert!(e.set_node_starting_point("m1", true));
        assert!(find(&e.root, "m1").unwrap().is_starting_point);
        e.undo();
        assert!(!find(&e.root, "m1").unwrap().is_starting_point);
        e.undo();
        assert!(find(&e.root, "i1").unwrap().interactions.is_empty());
        assert!(e.set_node_starting_point("m1", true));
        assert!(!e.set_node_starting_point("m1", true), "no-op rejected");
    }

    #[test]
    fn player_fires_rich_interactions() {
        let mut root = doc_with_set();
        let inst = root.children.iter_mut().find(|c| c.id == "i1").unwrap();
        inst.interactions = vec![Interaction {
            trigger: Trigger::OnClick,
            action: Action::Navigate {
                destination: "m2".into(),
            },
            actions: vec![],
            transition_ms: 200,
            animation: Animation::Instant,
        }];
        let mut p = Player::new(&root, "root");
        // click inside the instance rect (0,100)-(100,140)
        assert_eq!(p.click(Point::new(50.0, 120.0)), Some(200));
        assert_eq!(p.current, "m2");
        assert_eq!(
            p.click(Point::new(10.0, 10.0)),
            None,
            "no interaction on m2 body"
        );
        assert!(p.back());
        assert_eq!(p.current, "root");
    }

    #[test]
    fn player_back_action_navigates_history() {
        let mut root = doc_with_set();
        // interactions live on CHILD bodies (the frame root itself is the
        // canvas for hit purposes, matching selection behaviour)
        let mut go = Node::rect("go", 10.0, 10.0, 40.0, 20.0, Color::WHITE);
        go.interactions = vec![Interaction::click("m2")];
        let mut ret = Node::rect("ret", 10.0, 10.0, 40.0, 20.0, Color::WHITE);
        ret.interactions = vec![Interaction {
            trigger: Trigger::OnClick,
            action: Action::Back,
            actions: vec![],
            transition_ms: 0,
            animation: Animation::Instant,
        }];
        root.children[0].children.push(go); // inside m1 @ (0,0)
        root.children[1].children.push(ret); // inside m2 @ (200,0)
        let mut p = Player::new(&root, "root");
        assert_eq!(p.click(Point::new(150.0, 300.0)), None, "blank area: no-op");
        assert_eq!(p.click(Point::new(30.0, 20.0)), Some(350));
        assert_eq!(p.current, "m2");
        assert!(p.click(Point::new(240.0, 20.0)).is_some(), "Back fires");
        assert_eq!(p.current, "root");
    }
}
