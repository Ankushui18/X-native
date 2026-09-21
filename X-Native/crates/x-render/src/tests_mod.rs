#[allow(unused_imports)]
use crate::*;
use std::collections::HashMap;
use vello::peniko::Color;
use x_core::*;

// -------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feature_model_has_expected_nodes() {
        let d = Node::frame("r", 500.0, 500.0)
            .child(Node::text("t", 0.0, 0.0, 100.0, 20.0, "hello"))
            .child(Node::image("i", 0.0, 30.0, 50.0, 50.0, "asset-1"))
            .child(Node::component("c", "Button", 100.0, 40.0))
            .child(Node::instance("x", "Button", 0.0, 90.0, 100.0, 40.0));
        assert_eq!(d.children.len(), 4)
    }

    #[test]
    fn auto_layout_positions_children() {
        let mut d = Node::frame("r", 100.0, 100.0)
            .auto_layout(AutoLayout {
                direction: LayoutDirection::Horizontal,
                gap: 10.0,
                padding: [5.0; 4],
                sizing: Sizing::Fixed,
                ..Default::default()
            })
            .child(Node::rect("a", 0.0, 0.0, 20.0, 20.0, Color::WHITE))
            .child(Node::rect("b", 0.0, 0.0, 30.0, 20.0, Color::WHITE));
        apply_auto_layout(&mut d, &Variables::default());
        assert_eq!(d.children[0].transform.x, 5.0);
        assert_eq!(d.children[1].transform.x, 35.0)
    }

    #[test]
    fn viewport_culls_offscreen_nodes() {
        let d = Node::frame("r", 1000.0, 1000.0)
            .child(Node::rect("on", 10.0, 10.0, 20.0, 20.0, Color::WHITE))
            .child(Node::rect("off", 900.0, 900.0, 20.0, 20.0, Color::WHITE));
        let (_, s) = build_scene(
            &d,
            Some(Viewport {
                x: 0.0,
                y: 0.0,
                w: 100.0,
                h: 100.0,
            }),
            &Variables::default(),
        );
        // one rect — and NO label: the frame here is the root of the
        // scene, and the root of a render is never a labelled object
        assert_eq!(s.paths, 1);
        assert_eq!(s.culled, 1)
    }

    #[test]
    fn rotation_and_radius_render() {
        let d = Node::rect("a", 0.0, 0.0, 40.0, 20.0, Color::WHITE)
            .radius(8.0)
            .rotate(1.0)
            .opacity(0.5);
        let (scene, s) = build_scene(&d, None, &Variables::default());
        assert_eq!(s.paths, 1);
        assert_eq!(scene.encoding().n_paths, 1)
    }

    #[test]
    fn stress_10k() {
        let (_, s) = build_scene(&benchmark_scene(10_000), None, &Variables::default());
        assert_eq!(s.nodes, 10_001);
        assert_eq!(s.paths, 10_000)
    }

    #[test]
    fn number_variable_resolves_into_layout_gap() {
        let mut vars = Variables::default();
        vars.numbers.insert("gap".into(), 40.0);
        let mut d = Node::frame("r", 400.0, 100.0)
            .auto_layout(AutoLayout {
                direction: LayoutDirection::Horizontal,
                gap: 10.0,
                padding: [0.0; 4],
                gap_var: Some("gap".into()),
                ..Default::default()
            })
            .child(Node::rect("a", 0.0, 0.0, 20.0, 20.0, Color::WHITE))
            .child(Node::rect("b", 0.0, 0.0, 20.0, 20.0, Color::WHITE));
        apply_auto_layout(&mut d, &vars);
        assert_eq!(d.children[1].transform.x, 60.0); // 20 + 40, not 20 + 10
    }

    #[test]
    fn number_variable_missing_falls_back_to_literal() {
        let mut d = Node::frame("r", 400.0, 100.0)
            .auto_layout(AutoLayout {
                direction: LayoutDirection::Horizontal,
                gap: 10.0,
                padding: [0.0; 4],
                gap_var: Some("missing".into()),
                ..Default::default()
            })
            .child(Node::rect("a", 0.0, 0.0, 20.0, 20.0, Color::WHITE))
            .child(Node::rect("b", 0.0, 0.0, 20.0, 20.0, Color::WHITE));
        apply_auto_layout(&mut d, &Variables::default());
        assert_eq!(d.children[1].transform.x, 30.0);
    }

    #[test]
    fn instance_resolves_component_children_and_renders_them() {
        let mut master = Node::component("def", "Button", 100.0, 40.0).child(Node::rect(
            "bg",
            0.0,
            0.0,
            100.0,
            40.0,
            Color::BLACK,
        ));
        master.visible = false;
        let d = Node::frame("r", 500.0, 500.0)
            .child(master)
            .child(Node::instance("i1", "Button", 10.0, 10.0, 100.0, 40.0));
        let (_, s) = build_scene(&d, None, &Variables::default());
        // the instance's resolved bg — the root frame contributes no label
        assert_eq!(s.paths, 1);
    }

    #[test]
    fn instance_override_changes_resolved_child_fill() {
        let bg = Node::rect("bg", 0.0, 0.0, 100.0, 40.0, Color::BLACK);
        let mut ovr = HashMap::new();
        ovr.insert("bg".to_string(), "#ff0000".to_string());
        let c = effective_fill(&bg, &ovr, &Variables::default());
        let rgba = c.to_rgba8();
        assert_eq!((rgba.r, rgba.g, rgba.b), (255, 0, 0));
    }

    #[test]
    fn slot_content_replaces_anchor_in_rendered_instance() {
        // Card master with a Slot anchored on the "body" frame
        let mut master = Node::component("def", "Card", 200.0, 100.0)
            .child(Node::rect("bg", 0.0, 0.0, 200.0, 100.0, Color::BLACK))
            .child(Node::frame("body", 184.0, 60.0));
        master.props.push(x_core::ComponentProp::Slot {
            name: "Content".into(),
            target: "body".into(),
            default: None,
        });
        master.visible = false;

        // instance with slot content: a distinctive red badge
        let mut inst = Node::instance("i1", "Card", 0.0, 0.0, 200.0, 100.0);
        x_core::set_slot_content(
            &mut inst,
            "Content",
            Node::rect(
                "badge",
                0.0,
                0.0,
                60.0,
                20.0,
                Color::from_rgb8(0xff, 0x00, 0x00),
            ),
        );
        let d = Node::frame("r", 500.0, 500.0).child(master).child(inst);

        let tree = build_render_tree(&d, &Variables::default());
        // two painted paths: master bg + slot badge (anchor frame paints nothing)
        let fills: Vec<String> = tree
            .commands
            .iter()
            .filter_map(|c| match c {
                RenderCommand::FillPath { brush, .. } => Some(format!("{brush:?}")),
                _ => None,
            })
            .collect();
        let keys: Vec<String> = tree
            .commands
            .iter()
            .filter_map(|c| match c {
                RenderCommand::FillPath { key, .. } => Some(key.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(keys.len(), 2, "bg + badge only: {keys:?}");
        // peniko colors debug as normalized f32 components: red = [1, 0, 0]
        assert!(
            fills.iter().any(|f| f.contains("1.0, 0.0, 0.0")),
            "badge rendered: {fills:?}"
        );

        // without content, the anchor placeholder renders instead (a frame
        // with no fill produces no extra rect — only the master bg fills,
        // plus the QA-004 name labels of the root and the anchor frame)
        let mut master2 = Node::component("def2", "Card", 200.0, 100.0)
            .child(Node::rect("bg", 0.0, 0.0, 200.0, 100.0, Color::BLACK))
            .child(Node::frame("body", 184.0, 60.0));
        master2.props.push(x_core::ComponentProp::Slot {
            name: "Content".into(),
            target: "body".into(),
            default: None,
        });
        master2.visible = false;
        let plain = Node::frame("r2", 500.0, 500.0)
            .child(master2)
            .child(Node::instance("i2", "Card", 0.0, 0.0, 200.0, 100.0));
        let tree2 = build_render_tree(&plain, &Variables::default());
        let fills2: Vec<&RenderCommand> = tree2
            .commands
            .iter()
            .filter(|c| matches!(c, RenderCommand::FillPath { .. }))
            .collect();
        let cmds_dbg = format!("{:?}", tree2.commands);
        assert_eq!(fills2.len(), 1, "only master bg fills: {cmds_dbg}");
        // ...and NOTHING here is a name label: the render root is the page's
        // frame (never labelled) and a master's internal frames are not named
        // either, so the slot placeholder adds no glyph commands at all.
        assert!(
            !tree2
                .commands
                .iter()
                .any(|c| matches!(c, RenderCommand::Glyphs { .. })),
            "no canvas name labels inside an instance: {cmds_dbg}"
        );
        assert_eq!(tree2.commands.len(), 1, "the master's background alone");
    }

    #[test]
    fn slot_default_component_resolves_through_registry() {
        // Badge master + Card master whose slot defaults to "Badge"
        let mut badge = Node::component("def", "Badge", 40.0, 12.0).child(Node::rect(
            "dot",
            0.0,
            0.0,
            40.0,
            12.0,
            Color::from_rgb8(0x00, 0xff, 0x00),
        ));
        badge.visible = false;
        let mut card =
            Node::component("def2", "Card", 100.0, 40.0).child(Node::frame("body", 100.0, 40.0));
        card.props.push(x_core::ComponentProp::Slot {
            name: "Content".into(),
            target: "body".into(),
            default: Some("Badge".into()),
        });
        card.visible = false;
        let d = Node::frame("r", 500.0, 500.0)
            .child(badge)
            .child(card)
            .child(Node::instance("i1", "Card", 0.0, 0.0, 100.0, 40.0));
        let tree = build_render_tree(&d, &Variables::default());
        // the Badge default resolved through the registry and painted green
        let has_green = tree
            .commands
            .iter()
            .any(|c| format!("{c:?}").contains("0.0, 1.0, 0.0"));
        assert!(has_green, "Badge (green dot) filled the slot default");
    }

    #[test]
    fn self_referencing_instance_does_not_infinite_loop() {
        let master = Node::component("def", "Evil", 50.0, 50.0)
            .child(Node::instance("self", "Evil", 0.0, 0.0, 50.0, 50.0));
        let d = Node::frame("r", 500.0, 500.0)
            .child(master)
            .child(Node::instance("i", "Evil", 0.0, 0.0, 50.0, 50.0));
        let (_, s) = build_scene(&d, None, &Variables::default());
        assert!(s.nodes > 0); // terminated
    }

    // ---- v0.4 additions ----

    #[test]
    fn text_renders_real_paths() {
        let d = Node::text("t", 0.0, 0.0, 200.0, 24.0, "HELLO 123");
        let (scene, s) = build_scene(&d, None, &Variables::default());
        // "HELLO 123" = 8 visible glyphs (space is free) = 8 stroke paths
        assert_eq!(s.paths, 8);
        assert_eq!(scene.encoding().n_paths, 8);
    }

    #[test]
    fn text_override_replaces_content() {
        let label = Node::text("label", 0.0, 0.0, 100.0, 20.0, "OLD");
        let mut ovr = HashMap::new();
        ovr.insert("label".to_string(), "text:NEW".to_string());
        assert_eq!(effective_text(&label, &ovr), Some("NEW"));
    }

    #[test]
    fn gradient_paint_encodes() {
        let d = Node::rect("g", 0.0, 0.0, 100.0, 100.0, Color::WHITE).fill_paint(
            Paint::LinearGradient {
                start: (0.0, 0.0),
                end: (100.0, 0.0),
                stops: vec![
                    (0.0, Color::from_rgb8(255, 0, 0)),
                    (1.0, Color::from_rgb8(0, 0, 255)),
                ],
                space: x_core::GradSpace::Srgb,
            },
        );
        let (scene, s) = build_scene(&d, None, &Variables::default());
        assert_eq!(s.paths, 1);
        assert_eq!(scene.encoding().n_paths, 1);
    }

    #[test]
    fn drop_shadow_adds_a_path() {
        let d = Node::rect("s", 0.0, 0.0, 100.0, 50.0, Color::WHITE).effect(Effect::DropShadow {
            dx: 4.0,
            dy: 4.0,
            blur: 8.0,
            color: Color::BLACK,
        });
        let (_, s) = build_scene(&d, None, &Variables::default());
        assert_eq!(s.paths, 2); // shadow + fill
    }

    #[test]
    fn blend_mode_pushes_layer() {
        let plain = Node::rect("p", 0.0, 0.0, 50.0, 50.0, Color::WHITE);
        let blended =
            Node::rect("b", 0.0, 0.0, 50.0, 50.0, Color::WHITE).blend(BlendKind::Multiply);
        let (s1, _) = build_scene(&plain, None, &Variables::default());
        let (s2, _) = build_scene(&blended, None, &Variables::default());
        // The mix layer adds a clip path to the encoding.
        assert!(s2.encoding().n_clips > s1.encoding().n_clips);
    }

    #[test]
    fn vector_node_renders_real_path() {
        let star = Node::vector(
            "v",
            0.0,
            0.0,
            100.0,
            100.0,
            vec![
                PathCmd::MoveTo(50.0, 0.0),
                PathCmd::LineTo(61.0, 35.0),
                PathCmd::LineTo(98.0, 35.0),
                PathCmd::LineTo(68.0, 57.0),
                PathCmd::LineTo(79.0, 91.0),
                PathCmd::LineTo(50.0, 70.0),
                PathCmd::LineTo(21.0, 91.0),
                PathCmd::LineTo(32.0, 57.0),
                PathCmd::LineTo(2.0, 35.0),
                PathCmd::LineTo(39.0, 35.0),
                PathCmd::Close,
            ],
        );
        let (scene, s) = build_scene(&star, None, &Variables::default());
        assert_eq!(s.paths, 1);
        assert_eq!(scene.encoding().n_paths, 1);
        // empty vector renders nothing (no phantom paths)
        let empty = Node::vector("e", 0.0, 0.0, 10.0, 10.0, vec![]);
        let (_, s2) = build_scene(&empty, None, &Variables::default());
        assert_eq!(s2.paths, 0);
    }

    #[test]
    fn direct_vector_encoder_honors_visual_stacks_and_stroke_options() {
        let mut vector = Node::vector(
            "layered",
            0.0,
            0.0,
            100.0,
            100.0,
            vec![
                PathCmd::MoveTo(0.0, 0.0),
                PathCmd::LineTo(100.0, 0.0),
                PathCmd::LineTo(100.0, 100.0),
                PathCmd::Close,
            ],
        );
        vector.materialize_visual_stacks();
        vector.fill_layers[0].paint = Paint::LinearGradient {
            start: (0.0, 0.0),
            end: (100.0, 0.0),
            stops: vec![
                (0.0, Color::from_rgb8(255, 0, 0)),
                (1.0, Color::from_rgb8(0, 0, 255)),
            ],
            space: GradSpace::Srgb,
        };
        vector.fill_layers.push(PaintLayer {
            paint: Paint::Solid(Color::from_rgba8(0, 255, 0, 128)),
            opacity: 0.5,
            visible: true,
            blend: BlendKind::Normal,
        });
        vector.stroke_layers.push(StrokeLayer {
            stroke: Stroke::solid(Color::WHITE, 4.0),
            opacity: 1.0,
            visible: true,
            blend: BlendKind::Normal,
            options: StrokeOptions {
                cap_start: StrokeCap::Round,
                cap_end: StrokeCap::Round,
                join: StrokeJoin::Round,
                ..StrokeOptions::default()
            },
        });
        let (scene, stats) = build_scene(&vector, None, &Variables::default());
        assert_eq!(stats.paths, 3, "two fills plus one stroke");
        assert_eq!(scene.encoding().n_paths, 3);
    }

    #[test]
    fn pattern_fill_renders_clipped_image() {
        let path = std::env::temp_dir().join("xnative_pattern_test.png");
        {
            let f = std::fs::File::create(&path).unwrap();
            let mut enc = png::Encoder::new(std::io::BufWriter::new(f), 2, 2);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut w = enc.write_header().unwrap();
            w.write_image_data(&[
                255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
            ])
            .unwrap();
        }
        let mut assets = Assets::new();
        assets
            .load_png("pat", path.to_str().unwrap())
            .expect("decode");
        let d = Node::rect("r", 0.0, 0.0, 100.0, 50.0, Color::WHITE).fill_paint(
            x_core::Paint::Pattern {
                asset: "pat".into(),
                fit: x_core::ImageFit::Tile,
            },
        );
        let tree = build_render_tree(&d, &Variables::default());
        let sink = VelloSink {
            assets: Some(&assets),
            fonts: None,
        };
        let scene = sink.render(&tree);
        assert!(
            scene.encoding().n_clips > 0,
            "pattern renders inside a clip layer"
        );
        // missing bytes: no panic, still emits the commands
        let sink2 = VelloSink {
            assets: None,
            fonts: None,
        };
        let _ = sink2.render(&tree);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn png_asset_decodes_and_renders() {
        // write a tiny 2x2 red PNG, decode via Assets, render via Image node
        let path = std::env::temp_dir().join("xnative_asset_test.png");
        {
            let f = std::fs::File::create(&path).unwrap();
            let mut enc = png::Encoder::new(std::io::BufWriter::new(f), 2, 2);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut w = enc.write_header().unwrap();
            w.write_image_data(&[
                255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
            ])
            .unwrap();
        }
        let mut assets = Assets::new();
        assets
            .load_png("logo", path.to_str().unwrap())
            .expect("decode");
        assert_eq!(assets.len(), 1);
        assert_eq!(assets.get("logo").unwrap().image.width, 2);

        let d = Node::image("img", 0.0, 0.0, 100.0, 100.0, "logo");
        let (_, s) = build_scene_with_assets(&d, None, &Variables::default(), Some(&assets));
        assert_eq!(s.paths, 1);
        // without assets it still renders the placeholder (no panic)
        let (_, s2) = build_scene(&d, None, &Variables::default());
        assert_eq!(s2.paths, 1);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn per_corner_radii_render() {
        let d = Node::rect("c", 0.0, 0.0, 80.0, 40.0, Color::WHITE).corners(0.0, 20.0, 0.0, 20.0);
        let (_, s) = build_scene(&d, None, &Variables::default());
        assert_eq!(s.paths, 1);
    }

    #[test]
    fn layout_v2_cross_axis_center_and_space_between() {
        let mut d = Node::frame("r", 400.0, 100.0)
            .auto_layout(AutoLayout {
                direction: LayoutDirection::Horizontal,
                padding: [0.0; 4],
                align: CrossAlign::Center,
                distribute: Distribute::Between,
                ..Default::default()
            })
            .child(Node::rect("a", 0.0, 0.0, 50.0, 40.0, Color::WHITE))
            .child(Node::rect("b", 0.0, 0.0, 50.0, 60.0, Color::WHITE));
        apply_auto_layout(&mut d, &Variables::default());
        assert_eq!(d.children[0].transform.y, 30.0); // (100-40)/2
        assert_eq!(d.children[1].transform.y, 20.0); // (100-60)/2
        assert_eq!(d.children[1].transform.x, 350.0); // pushed to far edge
    }

    #[test]
    fn layout_distribution_around_and_evenly() {
        // 400px fixed frame, two 50px items, zero padding: leftover = 300.
        //   Around: u = 150 -> first edge 75, inner gap 150 -> x = 75 / 275
        //   Evenly: g = 100 -> every gap 100 (incl. edges)   -> x = 100 / 250
        for (mode, x0, x1) in [
            (Distribute::Around, 75.0, 275.0),
            (Distribute::Evenly, 100.0, 250.0),
        ] {
            let mut d = Node::frame("r", 400.0, 100.0)
                .auto_layout(AutoLayout {
                    direction: LayoutDirection::Horizontal,
                    padding: [0.0; 4],
                    align: CrossAlign::Center,
                    distribute: mode,
                    ..Default::default()
                })
                .child(Node::rect("a", 0.0, 0.0, 50.0, 40.0, Color::WHITE))
                .child(Node::rect("b", 0.0, 0.0, 50.0, 60.0, Color::WHITE));
            apply_auto_layout(&mut d, &Variables::default());
            assert_eq!(d.children[0].transform.x, x0, "{mode:?} first");
            assert_eq!(d.children[1].transform.x, x1, "{mode:?} second");
        }
    }

    #[test]
    fn layout_distribution_wrap_rows_spread_full_width() {
        // wrap layout: one row of two 50px items in a 300px frame (gap 0)
        // distributes per-row like justify-content on that line.
        let mut d = Node::frame("r", 300.0, 100.0)
            .auto_layout(AutoLayout {
                direction: LayoutDirection::Horizontal,
                padding: [0.0; 4],
                gap: 0.0,
                wrap: AutoLayoutWrap::Wrap,
                distribute: Distribute::Evenly,
                ..Default::default()
            })
            .child(Node::rect("a", 0.0, 0.0, 50.0, 40.0, Color::WHITE))
            .child(Node::rect("b", 0.0, 0.0, 50.0, 60.0, Color::WHITE));
        apply_auto_layout(&mut d, &Variables::default());
        // leftover 200, gaps 200/3 -> edge 66.66.., inner gap the same
        assert!((d.children[0].transform.x - 200.0 / 3.0).abs() < 1e-9);
        assert!((d.children[1].transform.x - (200.0 / 3.0 + 50.0 + 200.0 / 3.0)).abs() < 1e-9);
    }

    #[test]
    fn layout_v2_recursive_hug_propagates() {
        let inner = Node::frame("inner", 0.0, 0.0)
            .auto_layout(AutoLayout {
                direction: LayoutDirection::Vertical,
                gap: 10.0,
                padding: [5.0; 4],
                sizing: Sizing::Hug,
                ..Default::default()
            })
            .child(Node::rect("a", 0.0, 0.0, 30.0, 20.0, Color::WHITE))
            .child(Node::rect("b", 0.0, 0.0, 30.0, 20.0, Color::WHITE));
        let mut outer = Node::frame("outer", 0.0, 0.0)
            .auto_layout(AutoLayout {
                direction: LayoutDirection::Horizontal,
                gap: 0.0,
                padding: [0.0; 4],
                sizing: Sizing::Hug,
                ..Default::default()
            })
            .child(inner);
        apply_layout_recursive(&mut outer, &Variables::default());
        // inner hugged: h = 5+20+10+20+5 = 60, w = 30+10 = 40
        assert_eq!(outer.children[0].h, 60.0);
        assert_eq!(outer.children[0].w, 40.0);
        // outer hugged around inner
        assert_eq!(outer.w, 40.0);
        assert_eq!(outer.h, 60.0);
    }

    #[test]
    fn variables_v2_modes_and_aliases() {
        let mut vars = Variables::default();
        vars.colors
            .insert("bg".into(), Color::from_rgb8(255, 255, 255));
        let mut dark = HashMap::new();
        dark.insert("bg".to_string(), Color::from_rgb8(0, 0, 0));
        vars.modes.insert("dark".into(), dark);
        vars.aliases.insert("surface".into(), "bg".into());

        // no mode: alias chases to base value
        assert_eq!(vars.color("surface", Color::TRANSPARENT).to_rgba8().r, 255);
        // dark mode wins over base
        vars.active_mode = Some("dark".into());
        assert_eq!(vars.color("surface", Color::TRANSPARENT).to_rgba8().r, 0);
        // strings + bools exist
        vars.strings.insert("brand".into(), "X Native".into());
        vars.bools.insert("beta".into(), true);
        assert_eq!(vars.string("brand", ""), "X Native");
        assert!(vars.boolean("beta", false));
    }

    #[test]
    fn alias_cycle_terminates() {
        let mut vars = Variables::default();
        vars.aliases.insert("a".into(), "b".into());
        vars.aliases.insert("b".into(), "a".into());
        // must not hang; falls back
        assert_eq!(
            (vars.color("a", Color::from_rgb8(1, 2, 3)).components[0] * 255.0).round() as u8,
            1
        );
    }
}

#[cfg(test)]
mod variable_bindings {
    use super::*;

    #[test]
    fn radius_and_opacity_bind_to_number_variables() {
        let mut vars = Variables::default();
        vars.numbers.insert("radius-lg".into(), 20.0);
        vars.numbers.insert("dim".into(), 0.25);
        let d = Node::frame("page", 200.0, 200.0).child(
            Node::rect("r", 0.0, 0.0, 100.0, 60.0, Color::WHITE)
                .radius(2.0)
                .bind("radius", "radius-lg")
                .bind("opacity", "dim"),
        );
        // renders without panic and produces the path
        let (_, s) = build_scene(&d, None, &vars);
        assert_eq!(s.paths, 1);
        // resolution helpers give bound values
        let n = &d.children[0];
        assert_eq!(n.bound_number("radius", &vars, 2.0), 20.0);
        assert_eq!(n.bound_number("opacity", &vars, 1.0), 0.25);
        // missing variable -> fallback
        assert_eq!(n.bound_number("fontsize", &vars, 16.0), 16.0);
    }

    /// The three typography tokens Figma lets you bind — font size, line
    /// height, letter spacing — have to reach the render tree, not just the
    /// `bound_number` helper. Before this, "fontsize" was documented on
    /// `Node::bind` and asserted in the test above while every sink ignored
    /// it, so binding a type scale to a variable changed nothing on canvas.
    #[test]
    fn typography_tokens_reach_the_render_tree() {
        let mut vars = Variables::default();
        vars.numbers.insert("type-scale-lg".into(), 40.0);
        vars.numbers.insert("leading".into(), 48.0);
        vars.numbers.insert("tracking".into(), 2.0);
        let d = Node::frame("page", 400.0, 200.0).child(
            Node::text("t", 0.0, 0.0, 200.0, 20.0, "hello")
                .bind("fontsize", "type-scale-lg")
                .bind("lineheight", "leading")
                .bind("letterspacing", "tracking"),
        );
        // the literal bindings a style/inspector would have written
        let mut literal = d.clone();
        {
            let t = &mut literal.children[0];
            t.bindings.insert("fs".into(), "12".into());
            t.bindings.insert("ls".into(), "0".into());
            t.bindings.insert("lhm".into(), "px".into());
            t.bindings.insert("lhpx".into(), "14".into());
        }
        let glyphs = |root: &Node| {
            build_render_tree(root, &vars)
                .commands
                .iter()
                .find_map(|c| match c {
                    RenderCommand::Glyphs {
                        text,
                        size,
                        letter_spacing,
                        lh_mode,
                        lh_value,
                        ..
                    } if text == "hello" => Some((*size, *letter_spacing, *lh_mode, *lh_value)),
                    _ => None,
                })
                .expect("the text node renders")
        };
        let (size, ls, mode, value) = glyphs(&literal);
        assert_eq!(size, 40.0, "the fontsize token outranks the literal fs");
        assert_eq!(ls, 2.0, "the letterspacing token outranks the literal ls");
        assert_eq!(
            (mode, value),
            (1, 48.0),
            "the lineheight token is a px line box (mode 1)"
        );
        // a token that is missing from the table falls back to the literal,
        // so a renamed variable degrades instead of collapsing the type
        let mut unresolved = literal.clone();
        unresolved.children[0]
            .bindings
            .insert("fontsize".into(), "no-such-token".into());
        assert_eq!(glyphs(&unresolved).0, 12.0);
    }

    /// The vello path resolves the same tokens: `build_rich_spans_px` is where
    /// per-run letter spacing is decided.
    #[test]
    fn letterspacing_token_reaches_the_shaped_spans() {
        let mut fm = x_text::FontManager::new();
        if fm.load_system_fonts() == 0 {
            return;
        } // headless env w/o fonts: skip
        let f = fm.default_font().unwrap();
        let mut vars = Variables::default();
        vars.numbers.insert("tracking-wide".into(), 3.0);
        let mut d = Node::text("t", 0.0, 0.0, 400.0, 24.0, "abc");
        d.bindings.insert("ls".into(), "0.5".into());
        d.bindings
            .insert("letterspacing".into(), "tracking-wide".into());
        let spans = build_rich_spans_px(&d, "abc", Color::BLACK, &fm, f, d.h * 0.72, &vars);
        assert_eq!(spans.len(), 1);
        assert_eq!(
            spans[0].letter_spacing, 3.0,
            "the token outranks the literal ls"
        );
    }
}

#[cfg(test)]
mod component2_render {
    use super::*;

    use x_components::{set_override, OverrideValue};

    fn doc_with_masters() -> Node {
        let mut icon_a = Node::component("ca", "Icon/Check", 16.0, 16.0);
        icon_a.visible = false;
        icon_a.children.push(Node::rect(
            "ic-a",
            0.0,
            0.0,
            16.0,
            16.0,
            Color::from_rgb8(0, 0xff, 0),
        ));
        let mut icon_b = Node::component("cb", "Icon/Cross", 16.0, 16.0);
        icon_b.visible = false;
        // cross = TWO rects so swap changes path count
        icon_b.children.push(Node::rect(
            "ic-b1",
            0.0,
            0.0,
            16.0,
            4.0,
            Color::from_rgb8(0xff, 0, 0),
        ));
        icon_b.children.push(Node::rect(
            "ic-b2",
            0.0,
            6.0,
            16.0,
            4.0,
            Color::from_rgb8(0xff, 0, 0),
        ));
        let mut btn = Node::component("cbtn", "Button", 100.0, 40.0);
        btn.visible = false;
        btn.children
            .push(Node::rect("bg", 0.0, 0.0, 100.0, 40.0, Color::BLACK));
        btn.children
            .push(Node::instance("slot", "Icon/Check", 4.0, 4.0, 16.0, 16.0));
        Node::frame("page", 800.0, 600.0)
            .child(icon_a)
            .child(icon_b)
            .child(btn)
    }

    #[test]
    fn visibility_override_hides_node_inside_instance() {
        let mut doc = doc_with_masters();
        let mut i = Node::instance("i1", "Button", 200.0, 0.0, 100.0, 40.0);
        let (_, s_before) = {
            doc.children.push(i.clone());
            let r = build_scene(&doc, None, &Variables::default());
            doc.children.pop();
            r
        };
        set_override(&mut i, "bg", OverrideValue::Visible(false));
        doc.children.push(i);
        let (_, s_after) = build_scene(&doc, None, &Variables::default());
        assert_eq!(s_after.paths, s_before.paths - 1, "bg should vanish");
    }

    #[test]
    fn swap_override_replaces_nested_component() {
        let mut doc = doc_with_masters();
        let mut i = Node::instance("i1", "Button", 200.0, 0.0, 100.0, 40.0);
        let (_, s_check) = {
            doc.children.push(i.clone());
            let r = build_scene(&doc, None, &Variables::default());
            doc.children.pop();
            r
        };
        set_override(&mut i, "slot", OverrideValue::Swap("Icon/Cross".into()));
        doc.children.push(i);
        let (_, s_cross) = build_scene(&doc, None, &Variables::default());
        // Check icon = 1 path; Cross icon = 2 paths
        assert_eq!(
            s_cross.paths,
            s_check.paths + 1,
            "swap to 2-path icon adds a path"
        );
    }
}

#[cfg(test)]
mod typography_integration {
    use super::*;

    #[test]
    fn text_node_renders_with_real_font_when_available() {
        let mut fm = x_text::FontManager::new();
        if fm.load_system_fonts() == 0 {
            return;
        } // headless env w/o fonts: skip
        let d = Node::text("t", 0.0, 0.0, 400.0, 24.0, "Real Type");
        let (scene, s) = build_scene_full(&d, None, &Variables::default(), None, Some(&fm));
        // "Real Type" = 8 visible glyphs (space skipped as no-outline? no—space HAS no outline) -> >= 8 filled outlines
        assert!(s.paths >= 8, "expected real glyph paths, got {}", s.paths);
        assert!(scene.encoding().n_paths >= 8);
        // segment-font path still works without fonts
        let (_, s2) = build_scene(&d, None, &Variables::default());
        assert!(s2.paths > 0);
    }

    #[test]
    fn rich_spans_segment_text_into_styled_runs() {
        let mut fm = x_text::FontManager::new();
        if fm.load_system_fonts() == 0 {
            return;
        }
        let f = fm.default_font().unwrap();
        // "abcdef" with a red bold span over bytes [1,4) ("bcd")
        let red = Color::from_rgb8(0xff, 0x00, 0x00);
        let mut d = Node::text("t", 0.0, 0.0, 400.0, 24.0, "abcdef");
        d.text_runs = vec![TextRun {
            start: 1,
            len: 3,
            color: Some(red),
            size: Some(30.0),
            weight: Some(700),
            ..Default::default()
        }];
        let base = Color::BLACK;
        let spans = build_rich_spans_px(
            &d,
            "abcdef",
            base,
            &fm,
            f,
            d.h * 0.72,
            &Variables::default(),
        );
        // three segments: "a" (base), "bcd" (styled), "ef" (base)
        assert_eq!(spans.len(), 3);
        assert_eq!(spans[0].text, "a");
        assert_eq!(spans[0].color, base);
        assert_eq!(spans[1].text, "bcd");
        assert_eq!(spans[1].color, red);
        // px contract: an explicit run size is used as REAL px (the base
        // falls back to the legacy em -> 0.72 * node.h)
        assert!((spans[1].size - 30.0).abs() < 1e-6, "got {}", spans[1].size);
        assert!(
            (spans[0].size - d.h * 0.72).abs() < 1e-6,
            "got {}",
            spans[0].size
        );
        assert!(spans[1].variations.iter().any(|(a, _)| a == "wght"));
        assert_eq!(spans[2].text, "ef");
        assert_eq!(spans[2].color, base);
    }

    #[test]
    fn rich_spans_render_more_paths_than_plain() {
        let mut fm = x_text::FontManager::new();
        if fm.load_system_fonts() == 0 {
            return;
        }
        // plain text renders; a styled span must still produce glyph outlines
        let mut t = Node::text("t", 0.0, 0.0, 400.0, 24.0, "hello world");
        t.text_runs = vec![TextRun {
            start: 0,
            len: 5,
            size: Some(40.0),
            ..Default::default()
        }];
        let d = Node::frame("p", 400.0, 100.0).child(t);
        let (scene, s) = build_scene_full(&d, None, &Variables::default(), None, Some(&fm));
        assert!(
            s.paths >= 10,
            "styled text should render glyphs, got {}",
            s.paths
        );
        assert!(scene.encoding().n_paths >= 10);
    }
}

#[test]
fn explicit_line_height_routes_to_styled_pipeline() {
    let plain = x_core::Node::text("t", 0.0, 0.0, 200.0, 14.0, "line one\nline two");
    assert!(!super::text_needs_styled(&plain));
    let mut styled = plain.clone();
    styled.bindings.insert("lhm".into(), "px".into());
    styled.bindings.insert("lhpx".into(), "80".into());
    assert!(super::text_needs_styled(&styled));
    let mut legacy = plain.clone();
    legacy.bindings.insert("lh".into(), "1.5".into());
    assert!(super::text_needs_styled(&legacy));
    // the fast path drops baseline shift / word / paragraph / letter spacing
    for key in ["bs", "ws", "ps", "ls"] {
        let mut spaced = plain.clone();
        spaced.bindings.insert(key.into(), "4".into());
        assert!(
            super::text_needs_styled(&spaced),
            "{key} must take the styled shaper"
        );
        let mut zero = plain.clone();
        zero.bindings.insert(key.into(), "0".into());
        assert!(
            !super::text_needs_styled(&zero),
            "zero {key} is a no-op on the fast path"
        );
    }
}

#[cfg(test)]
mod outline_view_tests {
    use super::*;
    use crate::ir::RenderCommand;
    use vello::peniko::Brush;

    /// The wireframe contract of `outline_view`: per node, no fill, no
    /// effects, a Normal blend, and the one hairline stroke; Image and Text
    /// become the plain box they own; geometry, ids and nesting are kept;
    /// the source document is never touched.
    #[test]
    fn outline_view_is_a_wireframe_copy_of_the_document() {
        let mut card = Node::rect("card", 10.0, 10.0, 40.0, 40.0, Color::from_rgb8(0xff, 0, 0));
        card.corner_radii = Some([4.0; 4]);
        card.blend = BlendKind::Multiply;
        card.effects.push(Effect::DropShadow {
            dx: 3.0,
            dy: 5.0,
            blur: 8.0,
            color: Color::from_rgba8(0, 0, 0, 128),
        });
        card.visual_stacks_materialized = true;
        card.fill_layers = vec![PaintLayer::new(Paint::Solid(Color::from_rgb8(0xff, 0, 0)))];
        card.stroke_layers = vec![StrokeLayer::new(Stroke::solid(Color::WHITE, 2.0))];
        let inner = Node::ellipse("inner", 5.0, 5.0, 20.0, 20.0, Color::from_rgb8(0, 0xff, 0));
        let page = Node::frame("page", 200.0, 200.0)
            .child(card.child(inner))
            .child(Node::text("t", 60.0, 10.0, 80.0, 20.0, "hello"))
            .child(Node::image("i", 60.0, 60.0, 40.0, 40.0, "asset-1"));

        let stripped = outline_view(&page, 2.5);

        // the source document keeps its paint, its kinds and its stacks
        assert_eq!(page.children[0].blend, BlendKind::Multiply);
        assert_eq!(page.children[0].effects.len(), 1);
        assert_eq!(page.children[0].fill_layers.len(), 1);
        assert!(matches!(page.children[1].kind, NodeKind::Text { .. }));
        assert!(matches!(page.children[2].kind, NodeKind::Image { .. }));

        let check = |n: &Node, what: &str| {
            assert!(
                matches!(&n.fill, Paint::Solid(c) if *c == Color::TRANSPARENT),
                "{what}: the fill is cleared, got {:?}",
                n.fill
            );
            assert!(
                n.effects.is_empty() && n.effect_layers.is_empty(),
                "{what}: the effects are cleared"
            );
            assert_eq!(n.blend, BlendKind::Normal, "{what}: the blend is Normal");
            assert_eq!(
                n.stroke,
                Stroke::solid(OUTLINE_COLOR, 2.5),
                "{what}: the stroke is the hairline outline"
            );
            assert_eq!(
                n.active_fills(),
                vec![PaintLayer::new(Paint::Solid(Color::TRANSPARENT))],
                "{what}: nothing paints a fill"
            );
            let strokes = n.active_strokes();
            assert_eq!(
                strokes,
                vec![StrokeLayer::new(Stroke::solid(OUTLINE_COLOR, 2.5))],
                "{what}: exactly one outline stroke"
            );
        };
        // the render root is the page — and the page is not a layer, so it
        // keeps no outline of its own (everything under it does)
        assert_eq!(
            stripped.stroke,
            Stroke::default(),
            "the page itself is not outlined"
        );
        check(&stripped.children[0], "card");
        check(&stripped.children[0].children[0], "inner");

        // geometry, ids and nesting are the copy's — not a rewrite
        assert_eq!(stripped.id, page.id);
        assert_eq!(stripped.children[0].corner_radii, Some([4.0; 4]));
        assert_eq!(stripped.children[0].transform.x, 10.0);
        assert_eq!(stripped.children[0].children[0].id, "inner");
        // Image and Text paint themselves and would swallow the stroke:
        // they become the plain box they own (the named delta: Figma
        // outlines the glyphs, we outline the text layer's box)
        assert!(
            matches!(
                stripped.children[1].kind,
                NodeKind::Rect { radius } if radius == 0.0
            ),
            "text becomes its box"
        );
        assert!(
            matches!(
                stripped.children[2].kind,
                NodeKind::Rect { radius } if radius == 0.0
            ),
            "image becomes its box"
        );
    }

    /// An instance resolves from the STRIPPED registry: the master's
    /// children in the copy are the ones resolved, so an instance's chip is
    /// a wireframe like everything else — no blue fill, only the outline.
    #[test]
    fn outline_view_strips_the_instances_master_too() {
        let mut master = Node::component("m", "Chip", 40.0, 20.0);
        master.visible = false;
        master.children.push(Node::rect(
            "chip-bg",
            0.0,
            0.0,
            40.0,
            20.0,
            Color::from_rgb8(0, 0, 0xff),
        ));
        let page = Node::frame("page", 100.0, 100.0)
            .child(master)
            .child(Node::instance("i", "Chip", 10.0, 40.0, 40.0, 20.0));
        let stripped = outline_view(&page, 1.0);
        let tree = crate::ir::build_render_tree(&stripped, &Variables::default());
        // the instance's chip carries the outline stroke…
        let chip_stroke = tree
            .commands
            .iter()
            .find_map(|c| match c {
                RenderCommand::StrokePath {
                    key, brush, width, ..
                } if key.contains("chip-bg") => Some((brush.clone(), *width)),
                _ => None,
            })
            .expect("the resolved chip is outlined");
        assert!(
            matches!(chip_stroke.0, Brush::Solid(c) if c == OUTLINE_COLOR),
            "outline ink, got {:?}",
            chip_stroke.0
        );
        assert_eq!(chip_stroke.1, 1.0, "at the hairline width");
        // …and no fill from the master's blue
        let fills: Vec<&Brush> = tree
            .commands
            .iter()
            .filter_map(|c| match c {
                RenderCommand::FillPath { brush, .. } => Some(brush),
                _ => None,
            })
            .collect();
        let blue = Color::from_rgb8(0, 0, 0xff);
        let any_blue = fills
            .iter()
            .any(|b| matches!(b, Brush::Solid(x) if *x == blue));
        assert!(!any_blue, "the master's blue fill must not paint");
        // …and no image or glyph command at all
        let image_or_glyph = tree.commands.iter().any(|c| {
            matches!(
                c,
                RenderCommand::Image { .. } | RenderCommand::Glyphs { .. }
            )
        });
        assert!(
            !image_or_glyph,
            "the wireframe carries no image or glyph command"
        );
    }
}
