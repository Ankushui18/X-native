//! The Master -> Instance -> Text override -> Text measurement ->
//! Auto Layout -> Parent resize pipeline (P0's stress test).
//!
//! `resolve_instance_layout` produces a solved, override-applied copy of
//! an instance's content and returns the size the instance WANTS to be
//! after text remeasurement + auto-layout re-solve. `sync_instance_sizes`
//! walks a tree and grows Hug-sized instances to fit, then re-solves the
//! parent chain so layout parents resize too.

use crate::model::{find_master, typed_overrides, OverrideValue};
use x_core::{apply_auto_layout, Node, NodeKind, Sizing, Variables};

/// Text measurement callback: (content, font_size_px) -> width_px.
/// The engine stays measurement-agnostic; x-text supplies a real one.
pub type MeasureFn<'a> = &'a dyn Fn(&str, f64) -> f64;

/// Resolve one instance: master children cloned, typed overrides applied,
/// TEXT NODES REMEASURED via `measure`, auto layout re-solved recursively.
/// Returns (resolved children, solved_w, solved_h).
pub fn resolve_instance_layout(
    root: &Node,
    instance: &Node,
    vars: &Variables,
    measure: MeasureFn,
) -> Option<(Vec<Node>, f64, f64)> {
    let NodeKind::Instance { component } = &instance.kind else {
        return None;
    };
    let master = find_master(root, component)?;
    let mut work = master.clone();
    // 1) overrides + text remeasurement, deep (respecting nested-instance scope)
    fn pass(n: &mut Node, ovr: &std::collections::HashMap<String, String>, measure: MeasureFn) {
        for (k, enc) in ovr {
            let target = k.split('\x1f').next().unwrap_or(k);
            if target != n.id {
                continue;
            }
            let Some(v) = OverrideValue::decode(enc) else {
                continue;
            };
            match v {
                OverrideValue::Text(t) => {
                    if let NodeKind::Text { text } = &mut n.kind {
                        *text = t;
                    }
                }
                OverrideValue::Fill(c) => n.fill = x_core::Paint::Solid(c),
                OverrideValue::Stroke(c) => x_core::apply_stroke_paint(n, c),
                OverrideValue::Visible(b) => n.visible = b,
                OverrideValue::Opacity(o) => n.opacity = o,
                OverrideValue::Swap(c) => {
                    if let NodeKind::Instance { component } = &mut n.kind {
                        *component = c;
                    }
                }
            }
        }
        // remeasure ANY text node (overridden or not — master edits count too)
        if let NodeKind::Text { text } = &n.kind {
            let new_w = measure(text, n.h);
            n.w = new_w;
        }
        if matches!(n.kind, NodeKind::Instance { .. }) {
            return;
        }
        for c in &mut n.children {
            pass(c, ovr, measure);
        }
    }
    for c in &mut work.children {
        pass(c, &instance.overrides, measure);
    }

    // 2) re-solve auto layout bottom-up so Hug frames grow around new text
    fn solve(n: &mut Node, vars: &Variables) {
        for c in &mut n.children {
            solve(c, vars);
        }
        apply_auto_layout(n, vars);
    }
    solve(&mut work, vars);

    // solved size = extent of resolved children (masters are Component
    // nodes; their hug frame is a child, so measure the content itself)
    let (mut w, mut h) = (0.0f64, 0.0f64);
    for c in &work.children {
        w = w.max(c.transform.x + c.w);
        h = h.max(c.transform.y + c.h);
    }
    if w == 0.0 {
        w = work.w;
    }
    if h == 0.0 {
        h = work.h;
    }
    Some((work.children.clone(), w, h))
}

/// Does this master's content hug (any direct child frame with Hug sizing)?
fn master_hugs(master: &Node) -> bool {
    master
        .children
        .iter()
        .any(|c| matches!(&c.kind, NodeKind::Frame { layout: Some(l) } if l.sizing == Sizing::Hug))
}

/// Walk `root`; every instance whose master is Hug-sized gets its w/h
/// updated to the solved size, then layout parents are re-solved so the
/// parent chain resizes. Returns how many instances changed size.
pub fn sync_instance_sizes(root: &mut Node, vars: &Variables, measure: MeasureFn) -> usize {
    let snapshot = root.clone();
    let mut changed = 0usize;
    fn walk(n: &mut Node, doc: &Node, vars: &Variables, measure: MeasureFn, changed: &mut usize) {
        for c in &mut n.children {
            walk(c, doc, vars, measure, changed);
        }
        if matches!(n.kind, NodeKind::Instance { .. }) {
            if let Some((_, w, h)) = resolve_instance_layout(doc, n, vars, measure) {
                // only masters whose content hugs adopt content size
                if let NodeKind::Instance { component } = &n.kind {
                    if let Some(master) = find_master(doc, component) {
                        if master_hugs(master) && ((n.w - w).abs() > 0.01 || (n.h - h).abs() > 0.01)
                        {
                            n.w = w;
                            n.h = h;
                            *changed += 1;
                        }
                    }
                }
            }
        }
        // after children potentially resized, re-solve this container
        apply_auto_layout(n, vars);
    }
    walk(root, &snapshot, vars, measure, &mut changed);
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;
    use x_core::{AutoLayout, Color, LayoutDirection, Node, Variables};

    /// deterministic fake measurement: 10px per char at size 20, linear.
    fn m(text: &str, size: f64) -> f64 {
        text.chars().count() as f64 * size * 0.5
    }

    fn button_doc() -> Node {
        // master: Hug-sized horizontal frame [icon 16px] [label text]
        let mut master = Node::component("comp-btn", "Button", 0.0, 0.0);
        master.kind = NodeKind::Component {
            name: "Button".into(),
        };
        let mut inner = Node::frame("btn-root", 0.0, 0.0)
            .auto_layout(AutoLayout {
                direction: LayoutDirection::Horizontal,
                gap: 8.0,
                padding: [12.0; 4],
                sizing: x_core::Sizing::Hug,
                ..Default::default()
            })
            .child(Node::rect("btn-icon", 0.0, 0.0, 16.0, 16.0, Color::WHITE))
            .child(Node::text("btn-label", 0.0, 0.0, 40.0, 20.0, "OK"));
        // master itself is the hug frame (component wraps one frame's children)
        let mut mnode = Node::component("comp-btn", "Button", 0.0, 0.0);
        mnode.kind = NodeKind::Component {
            name: "Button".into(),
        };
        // for the master to be layout-solvable we give it the layout directly
        mnode.children = std::mem::take(&mut inner.children);
        // attach layout to the master by wrapping kind in a Frame? Components
        // are their own kind, so we model the master's layout via a root frame child.
        let master_frame = Node::frame("btn-frame", 0.0, 0.0).auto_layout(AutoLayout {
            direction: LayoutDirection::Horizontal,
            gap: 8.0,
            padding: [12.0; 4],
            sizing: x_core::Sizing::Hug,
            ..Default::default()
        });
        let _ = (master, master_frame);
        // simplest correct modeling: master component node with Hug layout metadata
        // lives as a Frame master — but NodeKind::Component has no layout.
        // So: the component's single child IS the hug frame.
        let mut comp = Node::component("comp-btn", "Button", 100.0, 44.0);
        comp.visible = false;
        let hug = Node::frame("btn-root", 0.0, 0.0)
            .auto_layout(AutoLayout {
                direction: LayoutDirection::Horizontal,
                gap: 8.0,
                padding: [12.0; 4],
                sizing: x_core::Sizing::Hug,
                ..Default::default()
            })
            .child(Node::rect("btn-icon", 0.0, 0.0, 16.0, 16.0, Color::WHITE))
            .child(Node::text("btn-label", 0.0, 0.0, 20.0, 20.0, "OK"));
        comp.children.push(hug);

        Node::frame("page", 800.0, 600.0)
            .child(comp)
            .child(Node::instance("i1", "Button", 50.0, 50.0, 100.0, 44.0))
    }

    #[test]
    fn the_p0_pipeline_master_instance_text_measure_layout_resize() {
        // Master -> Instance -> Text override -> measurement -> Auto Layout -> resize
        let mut doc = button_doc();
        let vars = Variables::default();

        // 1) resolve WITHOUT override: label "OK" = 2 chars * 10px = 20px
        let inst = doc.children.iter().find(|c| c.id == "i1").unwrap().clone();
        let (resolved, _, _) = resolve_instance_layout(&doc, &inst, &vars, &m).unwrap();
        let root = &resolved[0];
        // hug width = pad + icon 16 + gap 8 + label 20 + pad = 12+16+8+20+12 = 68
        assert_eq!(root.w, 68.0);

        // 2) override the text to something long
        {
            let inst_mut = doc.children.iter_mut().find(|c| c.id == "i1").unwrap();
            set_override(
                inst_mut,
                "btn-label",
                OverrideValue::Text("CONFIRM PURCHASE".into()),
            );
        }
        let inst2 = doc.children.iter().find(|c| c.id == "i1").unwrap().clone();
        let (resolved2, _, _) = resolve_instance_layout(&doc, &inst2, &vars, &m).unwrap();
        let root2 = &resolved2[0];
        // 16 chars * 10 = 160 label -> hug = 12+16+8+160+12 = 208
        assert_eq!(root2.w, 208.0);
        // label repositioned by layout after icon: x = 12+16+8 = 36
        let label = root2.children.iter().find(|c| c.id == "btn-label").unwrap();
        assert_eq!(label.transform.x, 36.0);
        assert_eq!(label.w, 160.0);
    }

    #[test]
    fn sync_grows_instance_and_resizes_layout_parent() {
        let vars = Variables::default();
        // page contains a horizontal Hug toolbar holding the instance + a rect
        let mut doc = button_doc();
        // move instance into a hug toolbar
        let inst = {
            // remove from page
            let idx = doc.children.iter().position(|c| c.id == "i1").unwrap();
            doc.children.remove(idx)
        };
        let toolbar = Node::frame("toolbar", 0.0, 0.0)
            .auto_layout(AutoLayout {
                direction: LayoutDirection::Horizontal,
                gap: 10.0,
                padding: [6.0; 4],
                sizing: x_core::Sizing::Hug,
                ..Default::default()
            })
            .child(inst)
            .child(Node::rect("spacer", 0.0, 0.0, 30.0, 20.0, Color::WHITE));
        doc.children.push(toolbar);

        // long text override
        {
            fn find_mut<'a>(n: &'a mut Node, id: &str) -> Option<&'a mut Node> {
                if n.id == id {
                    return Some(n);
                }
                n.children.iter_mut().find_map(|c| find_mut(c, id))
            }
            let i = find_mut(&mut doc, "i1").unwrap();
            set_override(
                i,
                "btn-label",
                OverrideValue::Text("CONFIRM PURCHASE".into()),
            );
        }

        let changed = sync_instance_sizes(&mut doc, &vars, &m);
        assert_eq!(changed, 1);
        fn find<'a>(n: &'a Node, id: &str) -> Option<&'a Node> {
            if n.id == id {
                return Some(n);
            }
            n.children.iter().find_map(|c| find(c, id))
        }
        let i = find(&doc, "i1").unwrap();
        assert_eq!(i.w, 208.0); // instance adopted hug width
                                // toolbar re-solved around it: 6 + 208 + 10 + 30 + 6 = 260
        let tb = find(&doc, "toolbar").unwrap();
        assert_eq!(tb.w, 260.0);
        // spacer pushed after the grown instance: x = 6+208+10 = 224
        assert_eq!(find(&doc, "spacer").unwrap().transform.x, 224.0);
    }

    #[test]
    fn bool_and_swap_and_opacity_overrides_roundtrip() {
        for v in [
            OverrideValue::Fill(Color::from_rgb8(1, 2, 3)),
            OverrideValue::Text("hi there".into()),
            OverrideValue::Visible(false),
            OverrideValue::Opacity(0.35),
            OverrideValue::Swap("Button/Danger".into()),
        ] {
            let enc = v.encode();
            assert_eq!(
                OverrideValue::decode(&enc).unwrap(),
                v,
                "roundtrip failed for {enc}"
            );
        }
    }

    #[test]
    fn component_properties_bind_to_targets() {
        let mut reg = PropRegistry::default();
        reg.props.insert(
            "Button".into(),
            vec![
                ComponentProp::Text {
                    name: "Label".into(),
                    target: "btn-label".into(),
                    default: "OK".into(),
                },
                ComponentProp::Bool {
                    name: "Show icon".into(),
                    target: "btn-icon".into(),
                    default: true,
                },
                ComponentProp::Swap {
                    name: "Icon".into(),
                    target: "icon-slot".into(),
                    default: "Icon/Check".into(),
                },
            ],
        );
        let mut inst = Node::instance("i", "Button", 0.0, 0.0, 100.0, 40.0);
        assert!(reg.apply("Button", &mut inst, "Label", "Buy now"));
        assert!(reg.apply("Button", &mut inst, "Show icon", "false"));
        assert!(reg.apply("Button", &mut inst, "Icon", "Icon/Cross"));
        assert!(!reg.apply("Button", &mut inst, "Nope", "x"));
        let t = typed_overrides(&inst);
        assert_eq!(
            t.get("btn-label"),
            Some(&OverrideValue::Text("Buy now".into()))
        );
        assert_eq!(t.get("btn-icon"), Some(&OverrideValue::Visible(false)));
        assert_eq!(
            t.get("icon-slot"),
            Some(&OverrideValue::Swap("Icon/Cross".into()))
        );
    }

    #[test]
    fn variants_listed_and_switched() {
        let doc = Node::frame("page", 800.0, 600.0)
            .child(Node::component("c1", "Button/Primary", 100.0, 40.0))
            .child(Node::component("c2", "Button/Danger", 100.0, 40.0))
            .child(Node::component("c3", "Card", 200.0, 100.0));
        assert_eq!(
            variants_of(&doc, "Button"),
            vec!["Button/Danger", "Button/Primary"]
        );
        let mut inst = Node::instance("i", "Button/Primary", 0.0, 0.0, 100.0, 40.0);
        assert!(switch_variant(&mut inst, "Button/Danger"));
        assert!(
            matches!(&inst.kind, NodeKind::Instance { component } if component == "Button/Danger")
        );
        // cross-set switch refused
        assert!(!switch_variant(&mut inst, "Card"));
    }

    #[test]
    fn detach_applies_overrides_and_keeps_nested_instances() {
        let vars = Variables::default();
        let mut comp = Node::component("comp-card", "Card", 200.0, 100.0);
        comp.visible = false;
        comp.children
            .push(Node::rect("card-bg", 0.0, 0.0, 200.0, 100.0, Color::BLACK));
        comp.children
            .push(Node::text("card-title", 8.0, 8.0, 100.0, 16.0, "Title"));
        comp.children
            .push(Node::instance("card-btn", "Button", 8.0, 60.0, 80.0, 32.0));
        let doc = Node::frame("page", 800.0, 600.0).child(comp).child({
            let mut i = Node::instance("i1", "Card", 300.0, 200.0, 200.0, 100.0);
            set_override(
                &mut i,
                "card-bg",
                OverrideValue::Fill(Color::from_rgb8(0xff, 0, 0)),
            );
            set_override(&mut i, "card-title", OverrideValue::Text("Hello".into()));
            i
        });
        let inst = doc.children.iter().find(|c| c.id == "i1").unwrap();
        let detached = detach_instance(&doc, inst, &vars).unwrap();
        assert_eq!(detached.transform.x, 300.0);
        assert_eq!(detached.children.len(), 3);
        let bg = detached
            .children
            .iter()
            .find(|c| c.id == "card-bg")
            .unwrap();
        assert!(
            matches!(&bg.fill, x_core::Paint::Solid(c) if (c.components[0] * 255.0).round() as u8 == 0xff)
        );
        let title = detached
            .children
            .iter()
            .find(|c| c.id == "card-title")
            .unwrap();
        assert!(matches!(&title.kind, NodeKind::Text { text } if text == "Hello"));
        // nested instance survives as an instance
        let btn = detached
            .children
            .iter()
            .find(|c| c.id == "card-btn")
            .unwrap();
        assert!(matches!(btn.kind, NodeKind::Instance { .. }));
    }

    #[test]
    fn dependency_graph_detects_cycles_and_dependents() {
        let doc = Node::frame("page", 800.0, 600.0)
            .child({
                let mut c = Node::component("c-icon", "Icon", 16.0, 16.0);
                c.children
                    .push(Node::rect("ic", 0.0, 0.0, 16.0, 16.0, Color::BLACK));
                c
            })
            .child({
                let mut c = Node::component("c-btn", "Button", 100.0, 40.0);
                c.children
                    .push(Node::instance("b-ic", "Icon", 4.0, 4.0, 16.0, 16.0));
                c
            })
            .child({
                let mut c = Node::component("c-card", "Card", 200.0, 100.0);
                c.children
                    .push(Node::instance("cd-btn", "Button", 8.0, 8.0, 100.0, 40.0));
                c
            });
        let g = DependencyGraph::build(&doc);
        assert_eq!(g.edges["Card"], vec!["Button"]);
        assert_eq!(g.edges["Button"], vec!["Icon"]);
        // editing Icon must re-render Button and Card
        assert_eq!(g.dependents_of("Icon"), vec!["Button", "Card"]);
        // cycle checks
        assert!(g.would_cycle("Icon", "Card")); // Card->Button->Icon, so Icon containing Card cycles
        assert!(g.would_cycle("Button", "Button"));
        assert!(!g.would_cycle("Card", "Icon")); // Card already (transitively) uses Icon: fine
    }
}
