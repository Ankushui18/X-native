#[allow(unused_imports)]
use crate::*;
use x_core::*;

// -------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::{Effect, HPin, VPin};
    use x_editor::{find, find_mut};

    /// Frames and sections draw their own name as a canvas label (the QA-004
    /// block in scene.rs), and every glyph of that label counts as one path in
    /// the scene stats. The names used in these tests are ASCII, so one glyph
    /// per character — spell the label out instead of hardcoding the sum, so a
    /// renamed fixture shows up as a label change, not as a mystery off-by-N.
    fn label_paths(name: &str) -> usize {
        name.chars().count()
    }

    fn sample_doc() -> Document {
        let mut doc = Document::new();
        doc.variables
            .colors
            .insert("brand".into(), Color::from_rgb8(0x0d, 0x99, 0xff));
        doc.variables.numbers.insert("gap-lg".into(), 28.0);
        let page = Node::frame("page-1", 800.0, 600.0)
            .auto_layout(AutoLayout {
                direction: LayoutDirection::Horizontal,
                gap: 20.0,
                padding: [24.0; 4],
                align: CrossAlign::Center,
                distribute: Distribute::Between,
                gap_var: Some("gap-lg".into()),
                ..Default::default()
            })
            .child(
                Node::rect(
                    "card",
                    10.0,
                    20.0,
                    240.0,
                    120.0,
                    Color::from_rgb8(255, 0, 0),
                )
                .radius(16.0)
                .rotate(0.3)
                .opacity(0.9)
                .corners(1.0, 2.0, 3.0, 4.0)
                .blend(BlendKind::Multiply)
                .effect(Effect::DropShadow {
                    dx: 0.0,
                    dy: 4.0,
                    blur: 12.0,
                    color: Color::from_rgba8(0, 0, 0, 128),
                })
                .pin(HPin::Right, VPin::Bottom)
                .prototype("page-2", 250),
            )
            .child(Node::text(
                "label",
                0.0,
                0.0,
                120.0,
                20.0,
                "Hello \"X\"\nworld",
            ))
            .child(
                Node::instance("i1", "Button", 0.0, 0.0, 100.0, 40.0)
                    .override_prop("bg", "#00ff00")
                    .override_prop("label", "text:Buy"),
            )
            .child(
                Node::rect("grad", 0.0, 0.0, 100.0, 100.0, Color::WHITE).fill_paint(
                    Paint::LinearGradient {
                        start: (0.0, 0.0),
                        end: (100.0, 0.0),
                        stops: vec![
                            (0.0, Color::from_rgb8(255, 0, 0)),
                            (1.0, Color::from_rgb8(0, 0, 255)),
                        ],
                        space: x_core::GradSpace::Srgb,
                    },
                ),
            );
        doc.pages.push(page);
        doc.pages.push(Node::frame("page-2", 800.0, 600.0));
        doc
    }

    #[test]
    fn styles_roundtrip_through_x_format() {
        let mut doc = sample_doc();
        doc.styles.insert(
            "Brand/Primary".into(),
            LegacyStyle::Paint {
                fill: Paint::Solid(Color::from_rgb8(0x0d, 0x99, 0xff)),
            },
        );
        doc.styles.insert(
            "Brand/Grad".into(),
            LegacyStyle::Paint {
                fill: Paint::LinearGradient {
                    start: (0.0, 0.0),
                    end: (100.0, 0.0),
                    stops: vec![
                        (0.0, Color::from_rgb8(255, 90, 0)),
                        (1.0, Color::from_rgb8(142, 45, 226)),
                    ],
                    space: x_core::GradSpace::Srgb,
                },
            },
        );
        doc.styles.insert(
            "Heading/H1".into(),
            LegacyStyle::Text {
                font: "Inter 700".into(),
                size: 34.0,
                letter_spacing: 0.5,
                line_height: 1.3,
            },
        );
        doc.styles.insert(
            "Elevation/2".into(),
            LegacyStyle::Effect {
                effects: vec![
                    Effect::DropShadow {
                        dx: 0.0,
                        dy: 4.0,
                        blur: 12.0,
                        color: Color::from_rgba8(0, 0, 0, 128),
                    },
                    Effect::LayerBlur { radius: 2.0 },
                ],
            },
        );
        let text = save_x(&doc);
        let loaded = load_x(&text).expect("load styles");
        assert_eq!(loaded.styles.len(), 4);
        assert_eq!(
            loaded.styles["Brand/Primary"],
            LegacyStyle::Paint {
                fill: Paint::Solid(Color::from_rgb8(0x0d, 0x99, 0xff))
            }
        );
        match &loaded.styles["Heading/H1"] {
            LegacyStyle::Text {
                font,
                size,
                letter_spacing,
                line_height,
            } => {
                assert_eq!(font, "Inter 700");
                assert_eq!(*size, 34.0);
                assert_eq!(*letter_spacing, 0.5);
                assert_eq!(*line_height, 1.3);
            }
            other => panic!("expected text style, got {other:?}"),
        }
        match &loaded.styles["Elevation/2"] {
            LegacyStyle::Effect { effects } => assert_eq!(effects.len(), 2),
            other => panic!("expected effect style, got {other:?}"),
        }
        // determinism: save(load(save)) is byte-identical with styles present
        assert_eq!(save_x(&loaded), text);
    }

    #[test]
    fn x_format_roundtrips_everything() {
        let doc = sample_doc();
        let text = save_x(&doc);
        let loaded = load_x(&text).expect("load");
        assert_eq!(loaded.pages.len(), 2);
        assert_eq!(
            loaded.variables.colors.get("brand").unwrap().to_rgba8().r,
            0x0d
        );
        assert_eq!(*loaded.variables.numbers.get("gap-lg").unwrap(), 28.0);

        let page = &loaded.pages[0];
        if let NodeKind::Frame { layout: Some(l) } = &page.kind {
            assert_eq!(l.direction, LayoutDirection::Horizontal);
            assert_eq!(l.align, CrossAlign::Center);
            assert_eq!(l.distribute, Distribute::Between);
            assert_eq!(l.gap_var.as_deref(), Some("gap-lg"));
        } else {
            panic!("layout lost");
        }

        let card = find(page, "card").unwrap();
        assert_eq!(card.w, 240.0);
        assert_eq!(card.transform.rotation, 0.3);
        assert_eq!(card.corner_radii, Some([1.0, 2.0, 3.0, 4.0]));
        assert_eq!(card.blend, BlendKind::Multiply);
        assert_eq!(card.effects.len(), 1);
        assert_eq!(card.prototype.as_ref().unwrap().destination, "page-2");
        assert!((card.opacity - 0.9).abs() < 1e-6);

        let label = find(page, "label").unwrap();
        assert!(matches!(&label.kind, NodeKind::Text { text } if text == "Hello \"X\"\nworld"));

        let inst = find(page, "i1").unwrap();
        assert_eq!(
            inst.overrides.get("bg").map(String::as_str),
            Some("#00ff00")
        );
        assert_eq!(
            inst.overrides.get("label").map(String::as_str),
            Some("text:Buy")
        );

        let grad = find(page, "grad").unwrap();
        assert!(matches!(&grad.fill, Paint::LinearGradient { stops, .. } if stops.len() == 2));
    }

    #[test]
    fn text_runs_roundtrip_through_x_format() {
        let mut doc = sample_doc();
        let n = doc.pages[0]
            .children
            .iter_mut()
            .find(|c| c.id == "label")
            .unwrap();
        n.text_runs = vec![
            TextRun {
                start: 0,
                len: 5,
                color: Some(Color::from_rgb8(255, 0, 0)),
                size: Some(28.0),
                font: Some("Inter".into()),
                weight: None,
                italic: None,
                ls: None,
            },
            TextRun {
                start: 6,
                len: 5,
                color: None,
                size: Some(14.0),
                font: None,
                weight: None,
                italic: None,
                ls: None,
            },
        ];
        let a = save_x(&doc);
        assert!(a.contains("\"textRuns\""), "runs serialize");
        let back = load_x(&a).unwrap();
        let n2 = find(&back.pages[0], "label").unwrap();
        assert_eq!(n2.text_runs.len(), 2);
        assert_eq!(n2.text_runs[0].start, 0);
        assert_eq!(n2.text_runs[0].len, 5);
        let c = n2.text_runs[0].color.expect("color survives");
        assert!(c.components[0] > 0.99 && c.components[1] < 0.01);
        assert_eq!(n2.text_runs[0].size, Some(28.0));
        assert_eq!(n2.text_runs[0].font.as_deref(), Some("Inter"));
        assert_eq!(n2.text_runs[1].size, Some(14.0));
        assert!(n2.text_runs[1].color.is_none());
        // byte-stable double round-trip
        assert_eq!(a, save_x(&back));
    }

    #[test]
    fn slice_roundtrips_through_x_format() {
        let mut doc = Document::new();
        let page = Node::frame("page-1", 800.0, 600.0)
            .child(Node::rect(
                "r",
                0.0,
                0.0,
                100.0,
                100.0,
                Color::from_rgb8(255, 0, 0),
            ))
            .child(Node::slice("s", 20.0, 30.0, 60.0, 40.0));
        doc.pages.push(page);
        let text = save_x(&doc);
        let loaded = load_x(&text).expect("load");
        let s = find(&loaded.pages[0], "s").expect("slice survives");
        assert!(matches!(s.kind, NodeKind::Slice), "slice kind preserved");
        assert_eq!(
            (s.transform.x, s.transform.y, s.w, s.h),
            (20.0, 30.0, 60.0, 40.0)
        );
        // determinism
        assert_eq!(save_x(&loaded), text);
    }

    #[test]
    fn export_settings_roundtrip_through_x_format() {
        let mut doc = Document::new();
        let page =
            Node::frame("page-1", 800.0, 600.0).child(Node::slice("s", 0.0, 0.0, 100.0, 80.0));
        doc.pages.push(page);
        // attach export settings to the slice
        if let Some(s) = find_mut(&mut doc.pages[0], "s") {
            s.export_settings = vec![
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
                ExportSettings {
                    format: "jpg".into(),
                    scale: 3.0,
                    quality: 70,
                    suffix: "@3x".into(),
                },
            ];
        }
        let text = save_x(&doc);
        let loaded = load_x(&text).expect("load");
        let s = find(&loaded.pages[0], "s").expect("slice survives");
        assert_eq!(s.export_settings.len(), 3);
        assert_eq!(
            s.export_settings[0],
            ExportSettings {
                format: "png".into(),
                scale: 1.0,
                quality: 90,
                suffix: "".into()
            }
        );
        assert_eq!(s.export_settings[1].suffix, "@2x");
        assert_eq!(
            s.export_settings[2],
            ExportSettings {
                format: "jpg".into(),
                scale: 3.0,
                quality: 70,
                suffix: "@3x".into()
            }
        );
        // determinism
        assert_eq!(save_x(&loaded), text);
    }

    #[test]
    fn prototype_interactions_roundtrip_through_x_format() {
        let mut doc = Document::new();
        let page = Node::frame("page-1", 800.0, 600.0).child(
            Node::rect("btn", 0.0, 0.0, 120.0, 40.0, Color::from_rgb8(255, 0, 0))
                .interaction(Interaction::click("page-2"))
                .interaction(Interaction {
                    trigger: Trigger::OnHover,
                    action: Action::OpenOverlay {
                        overlay: "tooltip".into(),
                        position: OverlayPosition::TopRight,
                    },
                    transition_ms: 200,
                    animation: Animation::Dissolve,
                })
                .starting_point(true),
        );
        doc.pages.push(page);
        doc.pages.push(Node::frame("page-2", 800.0, 600.0));
        let text = save_x(&doc);
        let loaded = load_x(&text).expect("load");
        let btn = find(&loaded.pages[0], "btn").expect("btn survives");
        assert_eq!(btn.interactions.len(), 2);
        assert_eq!(btn.interactions[0].trigger, Trigger::OnClick);
        assert!(
            matches!(&btn.interactions[0].action, Action::Navigate { destination } if destination == "page-2")
        );
        assert_eq!(btn.interactions[1].trigger, Trigger::OnHover);
        assert_eq!(btn.interactions[1].animation, Animation::Dissolve);
        match &btn.interactions[1].action {
            Action::OpenOverlay { overlay, position } => {
                assert_eq!(overlay, "tooltip");
                assert_eq!(*position, OverlayPosition::TopRight);
            }
            other => panic!("expected overlay, got {other:?}"),
        }
        assert!(btn.is_starting_point);
        // determinism
        assert_eq!(save_x(&loaded), text);
    }

    #[test]
    fn openlink_and_mouseup_roundtrip_through_x_format() {
        let mut doc = Document::new();
        let page = Node::frame("page-1", 800.0, 600.0).child(
            Node::rect("ext", 0.0, 0.0, 120.0, 40.0, Color::from_rgb8(255, 0, 0)).interaction(
                Interaction {
                    trigger: Trigger::MouseUp,
                    action: Action::OpenLink {
                        url: "https://example.com/docs".into(),
                    },
                    transition_ms: 0,
                    animation: Animation::Instant,
                },
            ),
        );
        doc.pages.push(page);
        let text = save_x(&doc);
        assert!(text.contains("\"action\":\"link\""), "link kind survives: {text}");
        assert!(text.contains("https://example.com/docs"), "url survives: {text}");
        let loaded = load_x(&text).expect("load");
        let ext = find(&loaded.pages[0], "ext").expect("ext survives");
        assert_eq!(ext.interactions.len(), 1);
        assert_eq!(ext.interactions[0].trigger, Trigger::MouseUp);
        match &ext.interactions[0].action {
            Action::OpenLink { url } => assert_eq!(url, "https://example.com/docs"),
            other => panic!("expected open-link, got {other:?}"),
        }
        // determinism
        assert_eq!(save_x(&loaded), text);
    }

    #[test]
    fn scroll_overflow_fixed_sticky_roundtrip() {
        let mut doc = Document::new();
        let page = Node::frame("page-1", 800.0, 600.0).child(
            Node::frame("scroller", 300.0, 300.0)
                .overflow(Overflow::ScrollY)
                .scroll(0.0, 120.0)
                .child(Node::rect("a", 0.0, 0.0, 100.0, 50.0, Color::from_rgb8(255, 0, 0)).fixed())
                .child(
                    Node::rect("b", 0.0, 100.0, 100.0, 50.0, Color::from_rgb8(0, 255, 0)).sticky(),
                ),
        );
        doc.pages.push(page);
        let text = save_x(&doc);
        let loaded = load_x(&text).expect("load");
        let scroller = find(&loaded.pages[0], "scroller").expect("scroller survives");
        assert_eq!(scroller.overflow, Overflow::ScrollY);
        assert_eq!(scroller.scroll, (0.0, 120.0));
        assert!(find(&loaded.pages[0], "a").unwrap().constraints.fixed);
        assert!(find(&loaded.pages[0], "b").unwrap().constraints.sticky);
        assert!(!find(&loaded.pages[0], "a").unwrap().constraints.sticky);
        // determinism
        assert_eq!(save_x(&loaded), text);
    }

    #[test]
    fn child_constraints_roundtrip_through_x_format() {
        let mut doc = Document::new();
        let page = Node::frame("page", 800.0, 600.0)
            .auto_layout(AutoLayout {
                direction: LayoutDirection::Vertical,
                gap: 8.0,
                padding: [10.0, 10.0, 10.0, 10.0],
                sizing: Sizing::Fixed,
                ..Default::default()
            })
            .child(
                Node::rect("a", 0.0, 0.0, 20.0, 20.0, Color::WHITE)
                    .align_self(Alignment::Center)
                    .grow(1.5),
            )
            .child(Node::rect("abs", 50.0, 70.0, 10.0, 10.0, Color::WHITE).absolute());
        doc.pages.push(page);
        let text = save_x(&doc);
        let loaded = load_x(&text).expect("load constraints");
        let a = find(&loaded.pages[0], "a").unwrap();
        assert_eq!(a.constraints.align_self, Some(Alignment::Center));
        assert_eq!(a.constraints.grow, 1.5);
        let abs = find(&loaded.pages[0], "abs").unwrap();
        assert!(abs.constraints.is_absolute);
        // byte-stable across a second round-trip
        assert_eq!(save_x(&loaded), text);
    }

    #[test]
    fn distribution_roundtrips_and_legacy_bool_still_reads() {
        let mut doc = Document::new();
        let page = Node::frame("page-1", 800.0, 600.0).auto_layout(AutoLayout {
            direction: LayoutDirection::Horizontal,
            distribute: Distribute::Around,
            ..Default::default()
        });
        doc.pages.push(page);
        let text = save_x(&doc);
        assert!(
            text.contains("\"distribute\":\"around\""),
            "new key written"
        );
        let loaded = load_x(&text).expect("load");
        match &loaded.pages[0].kind {
            NodeKind::Frame { layout: Some(l) } => assert_eq!(l.distribute, Distribute::Around),
            _ => panic!("layout lost"),
        }
        // pre-distribute files: a bare `space_between:true` still loads as Between
        let legacy = text.replace(
            "\"space_between\":false,\"distribute\":\"around\"",
            "\"space_between\":true",
        );
        assert_ne!(legacy, text, "legacy rewrite applied");
        let loaded = load_x(&legacy).expect("load legacy");
        match &loaded.pages[0].kind {
            NodeKind::Frame { layout: Some(l) } => assert_eq!(l.distribute, Distribute::Between),
            _ => panic!("layout lost"),
        }
    }

    #[test]
    fn plain_text_stays_byte_identical_without_runs() {
        let doc = sample_doc();
        let a = save_x(&doc);
        assert!(!a.contains("textRuns"), "no runs key for plain text");
        assert_eq!(a, save_x(&load_x(&a).unwrap()));
    }

    #[test]
    fn pattern_paints_roundtrip_through_x_format() {
        let mut doc = sample_doc();
        let n = doc.pages[0]
            .children
            .iter_mut()
            .find(|c| c.id == "card")
            .unwrap();
        n.fill = Paint::Pattern {
            asset: "asset://deadbeef".into(),
            fit: ImageFit::Tile,
        };
        let a = save_x(&doc);
        assert!(
            a.contains("\"t\":\"pattern\""),
            "pattern paint serializes: {a}"
        );
        assert!(a.contains("\"fit\":\"tile\""));
        let back = load_x(&a).unwrap();
        let n2 = find(&back.pages[0], "card").unwrap();
        assert_eq!(
            n2.fill,
            Paint::Pattern {
                asset: "asset://deadbeef".into(),
                fit: ImageFit::Tile
            }
        );
        // byte-stable double round-trip
        assert_eq!(a, save_x(&back));
    }

    #[test]
    fn oklab_gradient_space_roundtrips_through_x_format() {
        let mut doc = sample_doc();
        {
            let n = doc.pages[0]
                .children
                .iter_mut()
                .find(|c| c.id == "card")
                .unwrap();
            n.fill = Paint::LinearGradient {
                start: (0.0, 0.0),
                end: (100.0, 0.0),
                stops: vec![
                    (0.0, Color::from_rgb8(255, 90, 0)),
                    (1.0, Color::from_rgb8(142, 45, 226)),
                ],
                space: x_core::GradSpace::Oklab,
            };
        }
        let a = save_x(&doc);
        assert!(
            a.contains("\"gs\":\"oklab\""),
            "perceptual flag written: {a}"
        );
        let back = load_x(&a).unwrap();
        let n2 = find(&back.pages[0], "card").unwrap();
        assert!(
            matches!(
                &n2.fill,
                Paint::LinearGradient {
                    space: x_core::GradSpace::Oklab,
                    ..
                }
            ),
            "oklab space survives the round trip"
        );
        // legacy/default gradients keep byte-stable files (no gs key)
        {
            let n = doc.pages[0]
                .children
                .iter_mut()
                .find(|c| c.id == "card")
                .unwrap();
            n.fill = Paint::LinearGradient {
                start: (0.0, 0.0),
                end: (100.0, 0.0),
                stops: vec![
                    (0.0, Color::from_rgb8(255, 90, 0)),
                    (1.0, Color::from_rgb8(142, 45, 226)),
                ],
                space: x_core::GradSpace::Srgb,
            };
        }
        let b = save_x(&doc);
        assert!(!b.contains("\"gs\""), "srgb default omits gs: {b}");
    }

    #[test]
    fn gradient_strokes_survive_x_roundtrip() {
        // gradient strokes serialize through "paint" (solid keeps the
        // legacy "color" key, so old files stay byte-identical)
        let mut doc = sample_doc();
        let n = doc.pages[0]
            .children
            .iter_mut()
            .find(|c| c.id == "card")
            .unwrap();
        n.stroke = x_core::Stroke {
            paint: Paint::LinearGradient {
                start: (0.0, 0.0),
                end: (100.0, 0.0),
                stops: vec![
                    (0.0, Color::from_rgb8(255, 0, 0)),
                    (1.0, Color::from_rgb8(0, 0, 255)),
                ],
                space: x_core::GradSpace::Srgb,
            },
            width: 3.0,
        };
        let a = save_x(&doc);
        let back = load_x(&a).unwrap();
        let n2 = find(&back.pages[0], "card").unwrap();
        match &n2.stroke.paint {
            Paint::LinearGradient {
                start, end, stops, ..
            } => {
                assert_eq!(*start, (0.0, 0.0));
                assert_eq!(*end, (100.0, 0.0));
                assert_eq!(stops.len(), 2);
            }
            other => panic!("gradient stroke lost: {other:?}"),
        }
        assert_eq!(n2.stroke.width, 3.0);
        // and the save is byte-stable across a second round-trip
        let b = save_x(&back);
        assert_eq!(a, b);
    }

    #[test]
    fn double_roundtrip_is_stable() {
        let doc = sample_doc();
        let a = save_x(&doc);
        let b = save_x(&load_x(&a).unwrap());
        assert_eq!(a, b, "save(load(save(x))) must equal save(x)");
    }

    #[test]
    fn rejects_wrong_format_and_newer_versions() {
        assert!(load_x("{\"format\":\"figma\",\"version\":1}").is_err());
        assert!(load_x(&format!(
            "{{\"format\":\"x-native\",\"version\":{}}}",
            X_FORMAT_VERSION + 1
        ))
        .is_err());
        assert!(load_x("not json at all").is_err());
    }

    #[test]
    fn file_roundtrip_on_disk() {
        let doc = sample_doc();
        let path = std::env::temp_dir().join("xnative_test.x");
        let path = path.to_str().unwrap();
        save_x_file(&doc, path).unwrap();
        let loaded = load_x_file(path).unwrap();
        assert_eq!(loaded.pages.len(), 2);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn vector_path_roundtrips_through_x_format() {
        let mut doc = Document::new();
        let tri = Node::vector(
            "tri",
            0.0,
            0.0,
            100.0,
            100.0,
            vec![
                PathCmd::MoveTo(50.0, 0.0),
                PathCmd::LineTo(100.0, 100.0),
                PathCmd::CurveTo(75.0, 90.0, 25.0, 90.0, 0.0, 100.0),
                PathCmd::Close,
            ],
        );
        doc.pages.push(Node::frame("p", 200.0, 200.0).child(tri));
        let loaded = load_x(&save_x(&doc)).unwrap();
        let n = find(&loaded.pages[0], "tri").unwrap();
        if let NodeKind::Vector { path } = &n.kind {
            assert_eq!(path.len(), 4);
            assert_eq!(path[0], PathCmd::MoveTo(50.0, 0.0));
            assert!(matches!(path[2], PathCmd::CurveTo(..)));
            assert_eq!(path[3], PathCmd::Close);
        } else {
            panic!("vector kind lost")
        }
    }

    #[test]
    fn svg_import_basic_shapes() {
        let svg = r##"<?xml version="1.0"?>
        <svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
          <rect id="bg" x="10" y="20" width="100" height="50" rx="8" fill="#ff0000"/>
          <circle id="c1" cx="200" cy="100" r="40" fill="#00ff00"/>
          <g id="grp" transform="translate(50 60)">
            <ellipse cx="30" cy="20" rx="30" ry="20" fill="#0000ff"/>
          </g>
          <text id="label" x="10" y="290" font-size="20" fill="#000000">Hi there</text>
        </svg>"##;
        let root = import_svg(svg).expect("import");
        assert_eq!((root.w, root.h), (400.0, 300.0));
        let bg = find(&root, "bg").unwrap();
        assert_eq!((bg.transform.x, bg.w), (10.0, 100.0));
        assert!(matches!(bg.kind, NodeKind::Rect { radius } if radius == 8.0));
        assert!(
            matches!(&bg.fill, Paint::Solid(c) if c.to_rgba8().r == 255 && c.to_rgba8().g == 0)
        );
        let c1 = find(&root, "c1").unwrap();
        assert_eq!((c1.transform.x, c1.w), (160.0, 80.0)); // cx-r, 2r
        let grp = find(&root, "grp").unwrap();
        assert_eq!((grp.transform.x, grp.transform.y), (50.0, 60.0));
        assert_eq!(grp.children.len(), 1);
        let label = find(&root, "label").unwrap();
        assert!(matches!(&label.kind, NodeKind::Text { text } if text == "Hi there"));
    }

    #[test]
    fn svg_import_path_with_relative_commands() {
        let svg = r##"<svg width="100" height="100">
          <path id="p" d="M 10 10 l 20 0 L 30 30 h 10 v 10 C 35 45 25 45 20 40 z" fill="#123456"/>
        </svg>"##;
        let root = import_svg(svg).unwrap();
        let p = find(&root, "p").unwrap();
        if let NodeKind::Vector { path } = &p.kind {
            assert_eq!(path[0], PathCmd::MoveTo(10.0, 10.0));
            assert_eq!(path[1], PathCmd::LineTo(30.0, 10.0)); // relative l resolved
            assert_eq!(path[2], PathCmd::LineTo(30.0, 30.0));
            assert_eq!(path[3], PathCmd::LineTo(40.0, 30.0)); // h
            assert_eq!(path[4], PathCmd::LineTo(40.0, 40.0)); // v
            assert!(matches!(path[5], PathCmd::CurveTo(..)));
            assert_eq!(*path.last().unwrap(), PathCmd::Close);
        } else {
            panic!("not a vector")
        }
        // imported vector actually renders
        let (_, s) = x_render::build_scene(&root, None, &Variables::default());
        assert!(s.paths >= 1);
    }

    #[test]
    fn svg_roundtrip_export_then_import() {
        // Export our own scene, re-import it, and check the shapes survive.
        let page = Node::frame("page", 500.0, 400.0)
            .child(
                Node::rect(
                    "r1",
                    20.0,
                    30.0,
                    120.0,
                    60.0,
                    Color::from_rgb8(0x0d, 0x99, 0xff),
                )
                .radius(10.0),
            )
            .child(Node::ellipse(
                "e1",
                200.0,
                50.0,
                80.0,
                80.0,
                Color::from_rgb8(0xf2, 0x48, 0x22),
            ));
        let svg = export_svg(&page, &Variables::default());
        let re = import_svg(&svg).expect("re-import own export");
        // our exporter wraps each node in <g transform=translate(...)>, so
        // position lands on the wrapping group; shape + fill must survive.
        fn count_kind(n: &Node, pred: &dyn Fn(&NodeKind) -> bool) -> usize {
            (pred(&n.kind) as usize)
                + n.children
                    .iter()
                    .map(|c| count_kind(c, pred))
                    .sum::<usize>()
        }
        assert_eq!(count_kind(&re, &|k| matches!(k, NodeKind::Rect { .. })), 1);
        assert_eq!(count_kind(&re, &|k| matches!(k, NodeKind::Ellipse)), 1);
        let (_, s) = x_render::build_scene(&re, None, &Variables::default());
        // rect + ellipse, plus the imported root frame's own name label: the
        // importer names the root after its id ("svg-root")
        assert_eq!(s.paths, 2 + label_paths("svg-root"));
    }

    #[test]
    fn full_variable_engine_roundtrips() {
        let mut doc = Document::new();
        let v = &mut doc.variables;
        v.colors
            .insert("bg".into(), Color::from_rgb8(0xff, 0xff, 0xff));
        v.numbers.insert("gap".into(), 12.0);
        v.strings.insert("brand".into(), "X Native".into());
        v.bools.insert("beta".into(), true);
        v.collections.insert("bg".into(), "Semantic".into());
        v.collections.insert("gap".into(), "Primitives".into());
        let mut dark = std::collections::HashMap::new();
        dark.insert("bg".to_string(), Color::from_rgb8(0x11, 0x11, 0x11));
        v.modes.insert("dark".into(), dark);
        doc.pages.push(Node::frame("page", 100.0, 100.0));
        let text = save_x(&doc);
        let loaded = load_x(&text).unwrap();
        let lv = &loaded.variables;
        assert_eq!(lv.string("brand", ""), "X Native");
        assert!(lv.boolean("beta", false));
        assert_eq!(lv.collection_of("bg"), "Semantic");
        assert_eq!(lv.collection_of("gap"), "Primitives");
        assert_eq!(lv.collection_of("unknown"), "Local");
        assert_eq!(lv.modes["dark"]["bg"].to_rgba8().r, 0x11);
        assert_eq!(save_x(&load_x(&text).unwrap()), text);
        // catalog groups by collection for the UI
        let cat = lv.catalog();
        assert!(cat.contains(&("Semantic".into(), "bg".into(), "color")));
        assert!(cat.contains(&("Primitives".into(), "gap".into(), "number")));
    }

    #[test]
    fn mask_and_image_fit_roundtrip() {
        let mut doc = Document::new();
        let mut img = Node::image("img", 0.0, 0.0, 100.0, 80.0, "photo");
        if let NodeKind::Image { fit, .. } = &mut img.kind {
            *fit = ImageFit::Crop;
        }
        doc.pages.push(
            Node::frame("p", 400.0, 300.0)
                .child(Node::ellipse("m", 0.0, 0.0, 50.0, 50.0, Color::WHITE).mask(true))
                .child(img),
        );
        let loaded = load_x(&save_x(&doc)).unwrap();
        let m = find(&loaded.pages[0], "m").unwrap();
        assert!(m.is_mask, "mask flag must roundtrip");
        let i = find(&loaded.pages[0], "img").unwrap();
        assert!(
            matches!(
                i.kind,
                NodeKind::Image {
                    fit: ImageFit::Crop,
                    ..
                }
            ),
            "fit must roundtrip"
        );
        assert_eq!(save_x(&load_x(&save_x(&doc)).unwrap()), save_x(&doc));
    }

    #[test]
    fn variable_bindings_roundtrip() {
        let mut doc = Document::new();
        doc.variables.numbers.insert("radius-lg".into(), 20.0);
        doc.variables
            .collections
            .insert("radius-lg".into(), "Primitives".into());
        doc.pages.push(
            Node::frame("page", 100.0, 100.0).child(
                Node::rect("r", 0.0, 0.0, 50.0, 50.0, Color::WHITE)
                    .bind("radius", "radius-lg")
                    .bind("opacity", "dim"),
            ),
        );
        let loaded = load_x(&save_x(&doc)).unwrap();
        let n = find(&loaded.pages[0], "r").unwrap();
        assert_eq!(
            n.bindings.get("radius").map(String::as_str),
            Some("radius-lg")
        );
        assert_eq!(n.bindings.get("opacity").map(String::as_str), Some("dim"));
        assert_eq!(save_x(&load_x(&save_x(&doc)).unwrap()), save_x(&doc));
    }

    #[test]
    fn component_system_2_serialization_roundtrips() {
        use x_components::{set_override, typed_overrides, OverrideValue};
        let mut doc = Document::new();
        // master with variants + typed overrides on instances
        let mut m1 = Node::component("c1", "Button/Primary", 100.0, 40.0);
        m1.visible = false;
        m1.children.push(Node::rect(
            "bg",
            0.0,
            0.0,
            100.0,
            40.0,
            Color::from_rgb8(0, 0, 0xff),
        ));
        m1.children
            .push(Node::text("label", 8.0, 8.0, 80.0, 16.0, "OK"));
        m1.children
            .push(Node::instance("nested", "Icon", 4.0, 4.0, 16.0, 16.0));
        let mut inst = Node::instance("i1", "Button/Primary", 200.0, 100.0, 100.0, 40.0);
        set_override(&mut inst, "label", OverrideValue::Text("Buy now".into()));
        set_override(
            &mut inst,
            "bg",
            OverrideValue::Fill(Color::from_rgb8(0xff, 0, 0)),
        );
        set_override(&mut inst, "icon", OverrideValue::Visible(false));
        set_override(&mut inst, "half", OverrideValue::Opacity(0.5));
        set_override(
            &mut inst,
            "nested",
            OverrideValue::Swap("Icon/Cross".into()),
        );
        doc.pages
            .push(Node::frame("page", 800.0, 600.0).child(m1).child(inst));

        let text = save_x(&doc);
        let loaded = load_x(&text).expect("load");
        let page = &loaded.pages[0];
        let li = find(page, "i1").unwrap();
        let t = typed_overrides(li);
        assert_eq!(t.get("label"), Some(&OverrideValue::Text("Buy now".into())));
        assert_eq!(
            t.get("bg"),
            Some(&OverrideValue::Fill(Color::from_rgb8(0xff, 0, 0)))
        );
        assert_eq!(t.get("icon"), Some(&OverrideValue::Visible(false)));
        assert_eq!(t.get("half"), Some(&OverrideValue::Opacity(0.5)));
        assert_eq!(
            t.get("nested"),
            Some(&OverrideValue::Swap("Icon/Cross".into()))
        );
        // variant name survives; master hidden flag survives
        let lm = find(page, "c1").unwrap();
        assert!(matches!(&lm.kind, NodeKind::Component { name } if name == "Button/Primary"));
        assert!(!lm.visible);
        // double-roundtrip stability with typed overrides present
        assert_eq!(save_x(&load_x(&text).unwrap()), text);
    }

    #[test]
    fn component_autolayout_state_roundtrips() {
        // hug frame inside a master serializes with sizing=hug intact
        let mut doc = Document::new();
        let mut comp = Node::component("c", "Chip", 60.0, 24.0);
        comp.visible = false;
        comp.children.push(
            Node::frame("chip-root", 0.0, 0.0)
                .auto_layout(AutoLayout {
                    direction: LayoutDirection::Horizontal,
                    gap: 4.0,
                    padding: [6.0; 4],
                    sizing: x_core::Sizing::Hug,
                    ..Default::default()
                })
                .child(Node::text("chip-label", 0.0, 0.0, 30.0, 12.0, "tag")),
        );
        doc.pages
            .push(Node::frame("page", 400.0, 300.0).child(comp));
        let loaded = load_x(&save_x(&doc)).unwrap();
        let root = find(&loaded.pages[0], "chip-root").unwrap();
        if let NodeKind::Frame { layout: Some(l) } = &root.kind {
            assert_eq!(l.sizing, x_core::Sizing::Hug);
            assert_eq!(l.gap, 4.0);
        } else {
            panic!("hug layout lost in serialization");
        }
    }

    #[test]
    fn svg_export_contains_shapes_and_gradients() {
        let doc = sample_doc();
        let svg = export_svg(&doc.pages[0], &doc.variables);
        assert!(svg.starts_with("<svg"));
        assert!(svg.contains("<rect"));
        assert!(svg.contains("<text"));
        assert!(svg.contains("linearGradient"));
        assert!(svg.contains("rotate("));
    }

    #[test]
    fn svg_export_emits_tspan_for_rich_runs() {
        let red = Color::from_rgb8(0xff, 0x00, 0x00);
        let mut t = Node::text("t", 0.0, 0.0, 200.0, 24.0, "hello world");
        t.text_runs = vec![
            TextRun {
                start: 0,
                len: 5,
                color: Some(red),
                weight: Some(700),
                ..Default::default()
            },
            TextRun {
                start: 6,
                len: 5,
                size: Some(30.0),
                italic: Some(true),
                ..Default::default()
            },
        ];
        let page = Node::frame("page", 300.0, 300.0).child(t);
        // export WITHOUT a text outliner -> the <tspan> fallback path
        let svg = export_svg(&page, &Variables::default());
        assert!(svg.contains("<tspan"), "tspans emitted: {svg}");
        assert!(svg.contains("font-weight=\"bold\""), "bold span: {svg}");
        assert!(svg.contains("font-style=\"italic\""), "italic span: {svg}");
    }

    #[test]
    fn svg_export_applies_skew_and_transform_origin() {
        let mut skewed = Node::rect("s", 0.0, 0.0, 40.0, 40.0, Color::WHITE);
        skewed.transform.skew_x = 0.3;
        skewed.transform.origin_x = 0.0;
        skewed.transform.origin_y = 1.0;
        let page = Node::frame("page", 200.0, 200.0).child(skewed);
        let svg = export_svg(&page, &Variables::default());
        assert!(svg.contains("skewX("), "skewX exported: {svg}");
        // origin is applied via the pivot-local translate offsets (bottom-left)
        assert!(
            svg.contains("translate(-0 -40)"),
            "bottom-left origin: {svg}"
        );
    }

    #[test]
    fn visual_stacks_roundtrip_with_layer_state() {
        let mut node = Node::rect("stacked", 0.0, 0.0, 100.0, 80.0, Color::BLACK);
        node.visual_stacks_materialized = true;
        node.fill_layers = vec![
            PaintLayer::new(Paint::Solid(Color::from_rgb8(255, 0, 0))),
            PaintLayer {
                paint: Paint::LinearGradient {
                    start: (0.0, 0.0),
                    end: (100.0, 0.0),
                    stops: vec![(0.0, Color::WHITE), (1.0, Color::BLACK)],
                    space: x_core::GradSpace::Srgb,
                },
                opacity: 0.65,
                visible: false,
                blend: BlendKind::Screen,
            },
        ];
        node.stroke_layers = vec![StrokeLayer {
            stroke: Stroke::solid(Color::WHITE, 3.0),
            opacity: 0.8,
            visible: true,
            blend: BlendKind::Multiply,
            options: StrokeOptions::default(),
        }];
        node.effect_layers = vec![EffectLayer {
            effect: Effect::DropShadow {
                dx: 2.0,
                dy: 4.0,
                blur: 12.0,
                color: Color::BLACK,
            },
            opacity: 0.5,
            visible: false,
            blend: BlendKind::SoftLight,
        }];
        let mut doc = Document::new();
        doc.pages
            .push(Node::frame("page", 200.0, 200.0).child(node));
        let loaded = load_x(&save_x(&doc)).expect("visual stacks reload");
        let n = find(&loaded.pages[0], "stacked").unwrap();
        assert_eq!(n.fill_layers.len(), 2);
        assert_eq!(n.stroke_layers.len(), 1);
        assert_eq!(n.effect_layers.len(), 1);
        assert!(!n.fill_layers[1].visible);
        assert_eq!(n.fill_layers[1].blend, BlendKind::Screen);
        assert_eq!(n.stroke_layers[0].stroke.width, 3.0);
        assert!(!n.effect_layers[0].visible);
        assert_eq!(n.effect_layers[0].blend, BlendKind::SoftLight);
    }

    #[test]
    fn node_display_name_roundtrips_independently_of_id() {
        // name is only serialized when it differs from id; both directions
        // must round-trip deterministically.
        let mut doc = Document::new();
        let page = Node::frame("page", 200.0, 200.0)
            .child(Node::rect("a", 0.0, 0.0, 50.0, 50.0, Color::WHITE).name("Submit button"))
            .child(Node::rect("b", 60.0, 0.0, 50.0, 50.0, Color::WHITE));
        doc.pages.push(page);
        let text = save_x(&doc);
        let loaded = load_x(&text).expect("load");
        assert_eq!(find(&loaded.pages[0], "a").unwrap().name, "Submit button");
        // a node whose name == id keeps id as its name (nothing serialized)
        assert_eq!(find(&loaded.pages[0], "b").unwrap().name, "b");
        assert_eq!(find(&loaded.pages[0], "a").unwrap().id, "a");
        assert_eq!(save_x(&loaded), text, "deterministic");
    }

    #[test]
    fn skew_and_transform_origin_roundtrip() {
        // skew + non-center origin are only serialized when non-default, and
        // must round-trip deterministically in both directions.
        let mut skewed = Node::rect("s", 0.0, 0.0, 40.0, 40.0, Color::WHITE);
        skewed.transform.skew_x = 0.3;
        skewed.transform.skew_y = -0.2;
        skewed.transform.origin_x = 0.0;
        skewed.transform.origin_y = 1.0;
        let plain = Node::rect("p", 60.0, 0.0, 40.0, 40.0, Color::WHITE);
        let mut doc = Document::new();
        doc.pages
            .push(Node::frame("page", 200.0, 200.0).child(skewed).child(plain));
        let text = save_x(&doc);
        assert!(text.contains("\"skew\""), "skew serialized: {text}");
        assert!(text.contains("\"origin\""), "origin serialized: {text}");
        let loaded = load_x(&text).expect("load");
        let s = find(&loaded.pages[0], "s").unwrap();
        assert!((s.transform.skew_x - 0.3).abs() < 1e-9 && (s.transform.skew_y + 0.2).abs() < 1e-9);
        assert_eq!((s.transform.origin_x, s.transform.origin_y), (0.0, 1.0));
        // defaults (center origin, no skew) are preserved and not serialized
        let p = find(&loaded.pages[0], "p").unwrap();
        assert_eq!(
            (
                p.transform.origin_x,
                p.transform.origin_y,
                p.transform.skew_x,
                p.transform.skew_y
            ),
            (0.5, 0.5, 0.0, 0.0)
        );
        assert_eq!(save_x(&loaded), text, "deterministic");
    }

    #[test]
    fn rich_text_style_fields_roundtrip() {
        let red = Color::from_rgb8(0xff, 0x00, 0x00);
        let mut t = Node::text("t", 0.0, 0.0, 200.0, 20.0, "hello world");
        t.text_runs = vec![
            TextRun {
                start: 0,
                len: 5,
                color: Some(red),
                weight: Some(700),
                ..Default::default()
            },
            TextRun {
                start: 6,
                len: 5,
                size: Some(30.0),
                italic: Some(true),
                ls: Some(1.5),
                ..Default::default()
            },
        ];
        let mut doc = Document::new();
        doc.pages.push(Node::frame("page", 300.0, 300.0).child(t));
        let text = save_x(&doc);
        assert!(text.contains("\"textRuns\""), "runs serialized: {text}");
        assert!(text.contains("\"weight\":700"), "weight serialized: {text}");
        assert!(
            text.contains("\"italic\":true"),
            "italic serialized: {text}"
        );
        assert!(text.contains("\"ls\":1.5"), "ls serialized: {text}");
        let loaded = load_x(&text).expect("load");
        let runs = &find(&loaded.pages[0], "t").unwrap().text_runs;
        assert_eq!(runs.len(), 2);
        assert_eq!((runs[0].start, runs[0].len), (0, 5));
        assert_eq!(runs[0].color, Some(red));
        assert_eq!(runs[0].weight, Some(700));
        assert_eq!(runs[1].size, Some(30.0));
        assert_eq!(runs[1].italic, Some(true));
        assert_eq!(runs[1].ls, Some(1.5));
        assert_eq!(save_x(&loaded), text, "deterministic");
    }

    #[test]
    fn legacy_spans_file_converts_to_text_runs() {
        // the pre-unification "spans" format (BYTE ranges) must still load,
        // converted to char-index text_runs
        let text = r##"{"format":"x-native","version":1,"pages":[{"id":"page","kind":{"t":"frame"},"w":300,"h":300,"children":[{"id":"t","kind":{"t":"text","text":"hello world"},"x":0,"y":0,"w":200,"h":20,"spans":[{"s":0,"e":5,"fill":"#ff0000","w":700},{"s":6,"e":11,"size":30,"i":true}]}]}]}"##;
        let loaded = load_x(text).expect("legacy spans load");
        let runs = &find(&loaded.pages[0], "t").unwrap().text_runs;
        assert_eq!(runs.len(), 2, "converted: {runs:?}");
        assert_eq!((runs[0].start, runs[0].len), (0, 5));
        assert_eq!(runs[0].weight, Some(700));
        assert_eq!(runs[1].size, Some(30.0));
        assert_eq!(runs[1].italic, Some(true));
    }

    #[test]
    fn extended_blend_modes_roundtrip_without_fallback() {
        for blend in [
            BlendKind::ColorBurn,
            BlendKind::ColorDodge,
            BlendKind::SoftLight,
            BlendKind::HardLight,
            BlendKind::Difference,
            BlendKind::Exclusion,
            BlendKind::Hue,
            BlendKind::Saturation,
            BlendKind::Color,
            BlendKind::Luminosity,
        ] {
            let mut node = Node::rect("blend", 0.0, 0.0, 40.0, 40.0, Color::WHITE);
            node.blend = blend;
            let mut doc = Document::new();
            doc.pages
                .push(Node::frame("page", 100.0, 100.0).child(node));
            let loaded = load_x(&save_x(&doc)).expect("extended blend should deserialize");
            assert_eq!(loaded.pages[0].children[0].blend, blend);
        }
    }

    #[test]
    fn per_side_padding_cross_sizing_and_pin_round_trip() {
        let mut doc = Document::new();
        let page = Node::frame("p", 200.0, 200.0).child(
            Node::frame("f", 80.0, 60.0)
                .auto_layout(AutoLayout {
                    direction: LayoutDirection::Horizontal,
                    gap: 4.0,
                    padding: [10.0, 4.0, 6.0, 2.0],
                    sizing: Sizing::Fixed,
                    cross_sizing: Some(Sizing::Hug),
                    ..Default::default()
                })
                .pin(HPin::StretchH, VPin::CenterV),
        );
        doc.pages.push(page);
        let text = save_x(&doc);
        // non-uniform padding + cross_sizing + pin must be written
        assert!(
            text.contains("\"padding\":[10,4,6,2]"),
            "per-side padding serializes as an array: {text}"
        );
        assert!(text.contains("\"cross_sizing\":\"hug\""));
        assert!(text.contains("\"pin\":\"stretch center\""));
        let loaded = load_x(&text).expect("load");
        let f = find(&loaded.pages[0], "f").unwrap();
        let NodeKind::Frame { layout: Some(l) } = &f.kind else {
            panic!("frame layout")
        };
        assert_eq!(l.padding, [10.0, 4.0, 6.0, 2.0]);
        assert_eq!(l.cross_sizing, Some(Sizing::Hug));
        assert_eq!(f.pin, (HPin::StretchH, VPin::CenterV));
        // byte-stable across save/load
        assert_eq!(save_x(&loaded), text);
    }

    #[test]
    fn uniform_padding_and_default_pins_stay_legacy_shaped() {
        let mut doc = Document::new();
        doc.pages.push(Node::frame("p", 100.0, 100.0).child(
            Node::frame("f", 40.0, 30.0).auto_layout(AutoLayout {
                direction: LayoutDirection::Vertical,
                gap: 2.0,
                padding: [8.0; 4],
                sizing: Sizing::Hug,
                ..Default::default()
            }),
        ));
        let text = save_x(&doc);
        assert!(
            text.contains("\"padding\":8") && !text.contains("\"padding\":["),
            "uniform padding stays scalar: {text}"
        );
        assert!(
            !text.contains("\"pin\""),
            "default Left/Top pin is never written"
        );
        // legacy scalar parses back as all-four-sides
        let legacy = text.replace("\"padding\":8", "\"padding\":12");
        let loaded = load_x(&legacy).unwrap();
        let f = find(&loaded.pages[0], "f").unwrap();
        let NodeKind::Frame { layout: Some(l) } = &f.kind else {
            panic!("frame layout")
        };
        assert_eq!(
            l.padding, [12.0; 4],
            "legacy scalar padding loads onto all four sides"
        );
    }

    #[test]
    fn section_roundtrips_through_x_format() {
        use x_core::*;

        let mut sec = Node::section("s", 300.0, 200.0);
        sec.name = "Hero region".into();
        sec.children
            .push(Node::rect("inner", 0.0, 0.0, 50.0, 50.0, Color::WHITE));
        let page = Node::frame("page", 400.0, 300.0).child(sec);
        let mut doc = Document::new();
        doc.pages.push(page);

        let text = save_x(&doc);
        assert!(text.contains(r#""t":"section""#), "{text}");
        let back = load_x(&text).expect("load");
        let s = &back.pages[0].children[0];
        assert!(matches!(s.kind, NodeKind::Section));
        assert_eq!(s.name, "Hero region");
        assert_eq!(s.children.len(), 1, "children survive the round-trip");
    }

    #[test]
    fn arc_roundtrips_through_x_format() {
        use x_core::*;

        let page = Node::frame("page", 400.0, 300.0).child(Node::arc(
            "a",
            10.0,
            20.0,
            100.0,
            60.0,
            30.0,
            240.0,
            Color::WHITE,
        ));
        let mut doc = Document::new();
        doc.pages.push(page);

        let text = save_x(&doc);
        assert!(text.contains(r#""t":"arc""#), "{text}");
        assert!(
            text.contains(r#""start":30"#) || text.contains(r#""start":30.0"#),
            "{text}"
        );
        let back = load_x(&text).expect("load");
        let NodeKind::Arc { start, end } = &back.pages[0].children[0].kind else {
            panic!("not an arc after round-trip");
        };
        assert_eq!((*start, *end), (30.0, 240.0));
    }

    #[test]
    fn grid_layout_roundtrips_through_x_format() {
        use x_core::*;

        let mut f = Node::frame("gallery", 600.0, 400.0);
        if let NodeKind::Frame { layout } = &mut f.kind {
            *layout = Some(AutoLayout {
                direction: LayoutDirection::Vertical,
                gap: 0.0,
                padding: [8.0, 8.0, 8.0, 8.0],
                sizing: Sizing::Fixed,
                cross_sizing: Some(Sizing::Fixed),
                align: CrossAlign::Start,
                grid: Some(GridLayout {
                    columns: vec![GridTrack::Fixed(120.0), GridTrack::Fr(1.0), GridTrack::Auto],
                    rows: vec![GridTrack::Fixed(60.0)],
                    column_gap: 12.0,
                    row_gap: 8.0,
                    padding: [4.0, 6.0, 8.0, 10.0],
                }),
                ..Default::default()
            });
        }
        let mut hero = Node::rect("hero", 0.0, 0.0, 50.0, 50.0, peniko::Color::WHITE);
        hero.constraints.grid_col = Some(0);
        hero.constraints.grid_row = Some(1);
        hero.constraints.grid_col_span = 2;
        hero.constraints.grid_row_span = 3;
        f.children.push(hero);
        let mut doc = Document::new();
        doc.pages.push(f);

        let text = save_x(&doc);
        assert!(
            text.contains("\"grid\":{\"cols\":[{\"t\":\"fixed\",\"v\":120},{\"t\":\"fr\",\"v\":1},{\"t\":\"auto\"}]"),
            "{text}"
        );
        assert!(
            text.contains("\"rows\":[{\"t\":\"fixed\",\"v\":60}]"),
            "{text}"
        );
        assert!(text.contains("\"cgap\":12,\"rgap\":8"), "{text}");
        assert!(
            text.contains("\"col\":0,\"row\":1,\"col_span\":2,\"row_span\":3"),
            "{text}"
        );

        let loaded = load_x(&text).expect("load");
        assert_eq!(save_x(&loaded), text, "byte-stable round trip");

        let f2 = find(&loaded.pages[0], "gallery").unwrap();
        let NodeKind::Frame { layout: Some(l) } = &f2.kind else {
            panic!("frame layout")
        };
        let g = l.grid.as_ref().expect("grid survived");
        assert_eq!(
            g.columns,
            vec![GridTrack::Fixed(120.0), GridTrack::Fr(1.0), GridTrack::Auto]
        );
        assert_eq!(g.rows, vec![GridTrack::Fixed(60.0)]);
        assert_eq!((g.column_gap, g.row_gap), (12.0, 8.0));
        assert_eq!(g.padding, [4.0, 6.0, 8.0, 10.0]);
        let c = &f2.children[0];
        assert_eq!(c.constraints.grid_col, Some(0));
        assert_eq!(c.constraints.grid_row, Some(1));
        assert_eq!(c.constraints.grid_col_span, 2);
        assert_eq!(c.constraints.grid_row_span, 3);

        // and the loaded grid still solves
        let mut f3 = f2.clone();
        apply_auto_layout(&mut f3, &Variables::default());
        // grid padding is [l=4, r=6]: content = 590. Auto col (no items) = 0.
        // fixed+gaps = 120 + 2*12 = 144 -> 1fr = 446.
        // hero spans columns 0-1: 120 + 12 + 446 = 578.
        assert!(
            (f3.children[0].w - 578.0).abs() < 1e-9,
            "span width = {:?}",
            f3.children[0].w
        );
        // row 0 is Fixed(60); hero is placed at row 1 (implicit Auto row),
        // stretching to its own natural height 50
        assert_eq!(
            f3.children[0].transform.y,
            8.0 + 60.0 + 8.0,
            "y = pad.top + row0 + rgap"
        );
        // multi-row spans don't size implicit Auto rows (single-span items
        // only, CSS-style) -> empty rows are 0, so the span is just the
        // two interior row gaps
        assert_eq!(f3.children[0].h, 16.0);

        // a plain stack frame still round-trips WITHOUT a grid key
        let mut doc2 = Document::new();
        doc2.pages.push(Node::frame("stack", 100.0, 100.0));
        let t2 = save_x(&doc2);
        assert!(!t2.contains("\"grid\""), "{t2}");
    }
    #[test]
    fn slot_props_and_content_roundtrip_through_x_format() {
        use x_core::*;

        let mut master =
            Node::component("def", "Card", 200.0, 100.0).child(Node::frame("body", 184.0, 60.0));
        master.props.push(ComponentProp::Slot {
            name: "Content".into(),
            target: "body".into(),
            default: Some("Badge".into()),
        });
        master.props.push(ComponentProp::Text {
            name: "Title".into(),
            target: "t".into(),
            default: "Card".into(),
        });
        let mut inst = Node::instance("i1", "Card", 10.0, 10.0, 200.0, 100.0);
        set_override(&mut inst, "t", OverrideValue::Text("Hi".into()));
        set_slot_content(
            &mut inst,
            "Content",
            Node::rect("badge", 0.0, 0.0, 40.0, 12.0, peniko::Color::WHITE),
        );
        let mut doc = Document::new();
        doc.pages
            .push(Node::frame("p", 500.0, 500.0).child(master).child(inst));

        let text = save_x(&doc);
        assert!(text.contains("\"t\":\"slot\""), "{text}");
        assert!(text.contains("\"default\":\"Badge\""), "{text}");

        let loaded = load_x(&text).expect("load");
        assert_eq!(save_x(&loaded), text, "byte-stable round trip");

        // master's Slot prop survives
        let m = find(&loaded.pages[0], "def").unwrap();
        assert_eq!(m.props.len(), 2);
        match &m.props[0] {
            ComponentProp::Slot {
                name,
                target,
                default,
            } => {
                assert_eq!(name, "Content");
                assert_eq!(target, "body");
                assert_eq!(default.as_deref(), Some("Badge"));
            }
            other => panic!("expected Slot prop, got {other:?}"),
        }
        // instance's slot content + override survive
        let i = find(&loaded.pages[0], "i1").unwrap();
        assert_eq!(i.children.len(), 1);
        assert_eq!(
            i.children[0].bindings.get("slot").map(|s| s.as_str()),
            Some("Content"),
            "slot tag round-trips via bindings"
        );
        assert_eq!(i.children[0].id, "badge");
        assert!(i.overrides.contains_key("t"));

        // and the loaded slot still resolves for rendering
        let kids = resolve_slots(m, i).expect("slots");
        assert_eq!(kids[0].id, "badge", "content replaces the anchor");
    }
    #[test]
    fn prototype_logic_roundtrips_through_x_format() {
        use x_core::*;

        let mut doc = sample_doc();

        // typed mode tables + active mode
        doc.variables.numbers.insert("step".into(), 1.0);
        doc.variables.strings.insert("who".into(), "ada".into());
        doc.variables.bools.insert("vip".into(), false);
        doc.variables.num_modes.insert(
            "dense".into(),
            [("step".to_string(), 9.0)].into_iter().collect(),
        );
        doc.variables.str_modes.insert(
            "dense".into(),
            [("who".to_string(), "x".to_string())].into_iter().collect(),
        );
        doc.variables.bool_modes.insert(
            "dense".into(),
            [("vip".to_string(), true)].into_iter().collect(),
        );
        doc.variables.active_mode = Some("dense".into());
        // exposed variables (present-mode viewer inputs)
        doc.variables.exposed.insert("who".into());
        doc.variables.exposed.insert("step".into());

        // a logic-laden interaction: if step >= 2 navigate on, else increment
        let logic = Interaction {
            trigger: Trigger::KeyDown {
                key: "Enter".into(),
            },
            action: Action::Cond {
                cond: Condition {
                    lhs: Expr::var("step"),
                    op: CondOp::Ge,
                    rhs: Expr::num(2.0),
                },
                then: Box::new(Action::Navigate {
                    destination: "page-2".into(),
                }),
                els: Some(Box::new(Action::SetVar {
                    name: "step".into(),
                    value: Expr::Add(Box::new(Expr::var("step")), Box::new(Expr::num(1.0))),
                })),
            },
            transition_ms: 200,
            animation: Animation::MoveIn(Direction::Bottom),
        };
        if let Some(n) = doc.pages[0].children.first_mut() {
            n.interactions.push(logic);
        }

        let text = save_x(&doc);
        // spot-check the wire format
        assert!(text.contains("\"trigger\":\"key\""), "{text}");
        assert!(text.contains("\"key\":\"Enter\""), "{text}");
        assert!(text.contains("\"anim\":\"movein-bottom\""), "{text}");
        assert!(text.contains("\"action\":\"cond\""), "{text}");
        assert!(
            text.contains("\"num_modes\":{\"dense\":{\"step\":9}}"),
            "{text}"
        );
        assert!(text.contains("\"active_mode\":\"dense\""), "{text}");
        // sorted wire order regardless of insertion order
        assert!(text.contains("\"exposed\":[\"step\",\"who\"]"), "{text}");

        let loaded = load_x(&text).expect("load logic doc");
        assert_eq!(save_x(&loaded), text, "byte-stable round trip");

        // semantics survive
        assert_eq!(
            loaded.variables.number("step", 0.0),
            9.0,
            "active mode drives number lookup"
        );
        assert_eq!(loaded.variables.string("who", ""), "x");
        assert!(loaded.variables.boolean("vip", false));
        assert_eq!(
            loaded.variables.exposed,
            ["step".to_string(), "who".to_string()]
                .into_iter()
                .collect()
        );

        let n = &loaded.pages[0].children[0];
        assert_eq!(n.interactions.len(), 1);
        let i = &n.interactions[0];
        assert_eq!(
            i.trigger,
            Trigger::KeyDown {
                key: "Enter".into()
            }
        );
        assert_eq!(i.animation, Animation::MoveIn(Direction::Bottom));
        let Action::Cond { cond, then, els } = &i.action else {
            panic!("cond action");
        };
        assert_eq!(cond.op, CondOp::Ge);
        assert!(matches!(&**then, Action::Navigate { destination } if destination == "page-2"));
        let Some(els) = els else {
            panic!("else branch")
        };
        let Action::SetVar { name, value } = &**els else {
            panic!("setvar else")
        };
        assert_eq!(name, "step");
        assert_eq!(
            value,
            &Expr::Add(Box::new(Expr::var("step")), Box::new(Expr::num(1.0)))
        );

        // and the loaded logic actually runs
        let mut vars = loaded.variables.clone();
        vars.active_mode = None; // base table: step = 1
        let nav = run_action(&i.action, &mut vars);
        assert!(nav.is_none(), "else branch increments, no navigation");
        assert_eq!(vars.numbers["step"], 2.0);
        let nav2 = run_action(&i.action, &mut vars);
        assert!(
            matches!(nav2, Some(Action::Navigate { destination }) if destination == "page-2"),
            "condition now true -> navigate"
        );
    }

    #[test]
    fn layout_grids_roundtrip() {
        let mut doc = sample_doc();
        let frame = doc
            .pages
            .iter_mut()
            .find(|p| {
                p.children
                    .iter()
                    .any(|c| matches!(c.kind, x_core::NodeKind::Frame { .. }))
            })
            .and_then(|p| {
                p.children
                    .iter_mut()
                    .find(|c| matches!(c.kind, x_core::NodeKind::Frame { .. }))
            });
        let Some(frame) = frame else {
            // no frame in the sample: make one
            if let Some(p) = doc.pages.first_mut() {
                p.children
                    .push(x_core::Node::frame("grid-frame", 320.0, 240.0));
                p.children.last_mut().unwrap().layout_grids = vec![
                    x_core::LayoutGridDef::default(),
                    x_core::LayoutGridDef {
                        pattern: x_core::GridPattern::Rows,
                        count: 6,
                        gutter: 12.0,
                        margin: 0.0,
                        cell: 8.0,
                    },
                ];
            }
            let text = save_x(&doc);
            assert!(
                text.contains(
                    "\"grids\":[{\"pattern\":\"columns\",\"count\":12,\"gutter\":20,\"margin\":20,\"cell\":8}"
                ),
                "{text}"
            );
            assert!(text.contains("\"pattern\":\"rows\""), "{text}");
            let loaded = load_x(&text).expect("load grids");
            let f = loaded
                .pages
                .iter()
                .flat_map(|p| p.children.iter())
                .find(|c| c.id == "grid-frame")
                .expect("frame survived");
            assert_eq!(f.layout_grids.len(), 2);
            assert_eq!(f.layout_grids[0], x_core::LayoutGridDef::default());
            assert_eq!(f.layout_grids[1].pattern, x_core::GridPattern::Rows);
            assert_eq!(f.layout_grids[1].count, 6);
            assert_eq!(save_x(&loaded), text, "byte-stable");
            return;
        };
        // sample has a frame: mutate it instead
        frame.layout_grids = vec![x_core::LayoutGridDef {
            pattern: x_core::GridPattern::Grid,
            count: 12,
            gutter: 20.0,
            margin: 20.0,
            cell: 10.0,
        }];
        let text = save_x(&doc);
        assert!(text.contains("\"pattern\":\"grid\""), "{text}");
        let loaded = load_x(&text).expect("load");
        let f = loaded
            .pages
            .iter()
            .flat_map(|p| p.children.iter())
            .find(|c| matches!(c.kind, x_core::NodeKind::Frame { .. }))
            .expect("frame");
        assert_eq!(f.layout_grids.len(), 1);
        assert_eq!(f.layout_grids[0].cell, 10.0);
        assert_eq!(save_x(&loaded), text, "byte-stable");
        // and a plain doc emits nothing
        let mut plain = sample_doc();
        for p in plain.pages.iter_mut() {
            for c in p.children.iter_mut() {
                c.layout_grids.clear();
            }
        }
        assert!(!save_x(&plain).contains("\"grids\""));
    }

    #[test]
    fn exposed_variables_absent_when_empty() {
        // no exposed vars -> no "exposed" key on the wire (old files unchanged)
        let doc = sample_doc();
        let text = save_x(&doc);
        assert!(!text.contains("\"exposed\""), "{text}");
        let loaded = load_x(&text).unwrap();
        assert!(loaded.variables.exposed.is_empty());
        assert_eq!(save_x(&loaded), text, "byte-stable without exposed");
    }
}
