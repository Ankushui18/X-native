//! Component system 2.0 (P0).
//!
//! - Typed overrides: fill / text / visibility / opacity / instance-swap
//! - Component properties: text + boolean, bound to internal nodes
//! - Variants: "Button/Primary", "Button/Danger" — one component set,
//!   property-driven variant switching
//! - Nested components with per-instance override scoping (outer
//!   instance overrides its own subtree; inner instances own theirs)
//! - Detach: instance -> plain nodes (resolved, overrides applied)
//! - Dependency graph: which component uses which (cycle detection,
//!   update-impact queries)
//!
//! Overrides are stored as typed values keyed by target node id — the
//! legacy `HashMap<String, String>` ("#hex" / "text:") remains as a
//! serialization surface and is converted losslessly both ways.

use std::collections::HashMap;
use x_core::{
    apply_stroke_paint, color_to_hex, parse_hex_color, Color, Node, NodeKind, Paint, Variables,
};

/// A typed per-node override carried by an Instance.
#[derive(Debug, Clone, PartialEq)]
pub enum OverrideValue {
    Fill(Color),
    /// Stroke paint. A component color property bound to `target_property:
    /// "stroke"` writes this, so a border colour never repaints the interior
    /// of the node it is bound to. This copy still lacks `Number` — see
    /// docs/KNOWN_DEBT.md §4.
    Stroke(Color),
    Text(String),
    Visible(bool),
    Opacity(f32),
    /// Replace a nested INSTANCE's component with another component name.
    Swap(String),
}

impl OverrideValue {
    /// Encode into the legacy string form used by `.x` files and the
    /// renderer's override map.
    pub fn encode(&self) -> String {
        match self {
            OverrideValue::Fill(c) => color_to_hex(*c),
            OverrideValue::Stroke(c) => format!("stroke:{}", color_to_hex(*c)),
            OverrideValue::Text(t) => format!("text:{t}"),
            OverrideValue::Visible(v) => format!("visible:{v}"),
            OverrideValue::Opacity(o) => format!("opacity:{o}"),
            OverrideValue::Swap(c) => format!("swap:{c}"),
        }
    }
    pub fn decode(s: &str) -> Option<OverrideValue> {
        if let Some(t) = s.strip_prefix("text:") {
            return Some(OverrideValue::Text(t.into()));
        }
        if let Some(v) = s.strip_prefix("visible:") {
            return v.parse().ok().map(OverrideValue::Visible);
        }
        if let Some(o) = s.strip_prefix("opacity:") {
            return o.parse().ok().map(OverrideValue::Opacity);
        }
        if let Some(c) = s.strip_prefix("swap:") {
            return Some(OverrideValue::Swap(c.into()));
        }
        // checked BEFORE the bare-hex fallback: "#00ff00" still means Fill,
        // "stroke:#00ff00" does not
        if let Some(c) = s.strip_prefix("stroke:") {
            return parse_hex_color(c).map(OverrideValue::Stroke);
        }
        parse_hex_color(s).map(OverrideValue::Fill)
    }
}

/// Typed view over an instance's override map.
fn override_kind_tag(v: &OverrideValue) -> &'static str {
    match v {
        OverrideValue::Fill(_) => "fill",
        OverrideValue::Stroke(_) => "stroke",
        OverrideValue::Text(_) => "text",
        OverrideValue::Visible(_) => "visible",
        OverrideValue::Opacity(_) => "opacity",
        OverrideValue::Swap(_) => "swap",
    }
}

fn override_target_id(key: &str) -> &str {
    key.split('\x1f').next().unwrap_or(key)
}

pub fn typed_overrides(node: &Node) -> HashMap<String, OverrideValue> {
    let mut out = HashMap::new();
    for (k, v) in &node.overrides {
        if let Some(ov) = OverrideValue::decode(v) {
            out.insert(override_target_id(k).to_string(), ov);
        }
    }
    out
}

pub fn set_override(node: &mut Node, target: &str, value: OverrideValue) {
    let tag = override_kind_tag(&value);
    // Preserve the legacy `target` key for the first property on a layer;
    // additional properties use a namespaced key so old `.x` readers and
    // the multi-property instances can coexist.
    let key = node
        .overrides
        .iter()
        .find(|(k, raw)| {
            override_target_id(k) == target
                && OverrideValue::decode(raw)
                    .map(|existing| override_kind_tag(&existing) == tag)
                    .unwrap_or(false)
        })
        .map(|(k, _)| k.clone())
        .or_else(|| {
            let has_target = node
                .overrides
                .keys()
                .any(|k| override_target_id(k) == target);
            (!has_target).then(|| target.to_string())
        })
        .unwrap_or_else(|| format!("{target}\x1f{tag}"));
    node.overrides.insert(key, value.encode());
}

// ------------------------------------------------------------- properties

/// A designer-facing component property (component properties).
#[derive(Debug, Clone, PartialEq)]
pub enum ComponentProp {
    /// Text property: binds a property name to a text node id inside the master.
    Text {
        name: String,
        target: String,
        default: String,
    },
    /// Boolean property: toggles visibility of a node inside the master.
    Bool {
        name: String,
        target: String,
        default: bool,
    },
    /// Instance-swap property: swaps a nested instance's component.
    Swap {
        name: String,
        target: String,
        default: String,
    },
}

/// Component property definitions live per master, keyed by component name.
#[derive(Debug, Clone, Default)]
pub struct PropRegistry {
    pub props: HashMap<String, Vec<ComponentProp>>,
}

impl PropRegistry {
    /// Apply a property assignment to an instance as typed overrides.
    pub fn apply(
        &self,
        component: &str,
        instance: &mut Node,
        prop_name: &str,
        value: &str,
    ) -> bool {
        let Some(props) = self.props.get(component) else {
            return false;
        };
        for p in props {
            match p {
                ComponentProp::Text { name, target, .. } if name == prop_name => {
                    set_override(instance, target, OverrideValue::Text(value.into()));
                    return true;
                }
                ComponentProp::Bool { name, target, .. } if name == prop_name => {
                    if let Ok(b) = value.parse::<bool>() {
                        set_override(instance, target, OverrideValue::Visible(b));
                        return true;
                    }
                }
                ComponentProp::Swap { name, target, .. } if name == prop_name => {
                    set_override(instance, target, OverrideValue::Swap(value.into()));
                    return true;
                }
                _ => {}
            }
        }
        false
    }
}

// ---------------------------------------------------------------- variants

/// Variant identity: "Set/VariantName". Components named with a slash are
/// variant members of a set ("Button/Primary", "Button/Danger").
pub fn variant_set(component_name: &str) -> Option<(&str, &str)> {
    component_name.split_once('/')
}

/// All variants of a set present in the document.
pub fn variants_of<'a>(root: &'a Node, set: &str) -> Vec<&'a str> {
    let mut out = vec![];
    fn walk<'a>(n: &'a Node, set: &str, out: &mut Vec<&'a str>) {
        if let NodeKind::Component { name } = &n.kind {
            if let Some((s, _)) = variant_set(name) {
                if s == set {
                    out.push(name.as_str());
                }
            }
        }
        for c in &n.children {
            walk(c, set, out);
        }
    }
    walk(root, set, &mut out);
    out.sort();
    out
}

/// Switch an instance to a different variant of the same set. Keeps
/// overrides (they target ids shared across variants by convention).
pub fn switch_variant(instance: &mut Node, to_variant: &str) -> bool {
    if let NodeKind::Instance { component } = &mut instance.kind {
        let same_set = match (variant_set(component), variant_set(to_variant)) {
            (Some((a, _)), Some((b, _))) => a == b,
            _ => false,
        };
        if same_set {
            *component = to_variant.to_string();
            return true;
        }
    }
    false
}

// ------------------------------------------------------------------ detach

/// Find a component master by name anywhere in the tree.
pub fn find_master<'a>(root: &'a Node, name: &str) -> Option<&'a Node> {
    if let NodeKind::Component { name: n } = &root.kind {
        if n == name {
            return Some(root);
        }
    }
    root.children.iter().find_map(|c| find_master(c, name))
}

/// Detach an instance: resolve the master's children WITH the instance's
/// overrides applied, and return them re-based at the instance's position
/// wrapped in a Group. Nested instances stay instances (standard behavior).
pub fn detach_instance(root: &Node, instance: &Node, vars: &Variables) -> Option<Node> {
    let NodeKind::Instance { component } = &instance.kind else {
        return None;
    };
    let master = find_master(root, component)?;
    let mut group = Node::group(&format!("{}-detached", instance.id), instance.w, instance.h);
    group.transform = instance.transform;
    for child in &master.children {
        let mut c = child.clone();
        apply_overrides_raw(&mut c, &instance.overrides, vars);
        group.children.push(c);
    }
    Some(group)
}

fn apply_overrides_raw(node: &mut Node, ovr: &HashMap<String, String>, vars: &Variables) {
    for (k, enc) in ovr {
        if override_target_id(k) != node.id {
            continue;
        }
        let Some(v) = OverrideValue::decode(enc) else {
            continue;
        };
        match v {
            OverrideValue::Fill(c) => node.fill = Paint::Solid(c),
            OverrideValue::Stroke(c) => apply_stroke_paint(node, c),
            OverrideValue::Text(t) => {
                if let NodeKind::Text { text } = &mut node.kind {
                    *text = t;
                    node.text_runs.clear();
                }
            }
            OverrideValue::Visible(b) => node.visible = b,
            OverrideValue::Opacity(o) => node.opacity = o,
            OverrideValue::Swap(c) => {
                if let NodeKind::Instance { component } = &mut node.kind {
                    *component = c;
                }
            }
        }
    }
    let _ = vars;
    // nested instances keep their own override scope: do not descend into them
    if matches!(node.kind, NodeKind::Instance { .. }) {
        return;
    }
    for c in &mut node.children {
        apply_overrides_raw(c, ovr, vars);
    }
}

// -------------------------------------------------------- dependency graph

/// Component dependency graph: master name -> component names it instances.
#[derive(Debug, Default)]
pub struct DependencyGraph {
    pub edges: HashMap<String, Vec<String>>,
}

impl DependencyGraph {
    pub fn build(root: &Node) -> Self {
        let mut g = Self::default();
        fn masters(n: &Node, g: &mut DependencyGraph) {
            if let NodeKind::Component { name } = &n.kind {
                let mut deps = vec![];
                fn inner(c: &Node, deps: &mut Vec<String>) {
                    if let NodeKind::Instance { component } = &c.kind {
                        deps.push(component.clone());
                    }
                    for ch in &c.children {
                        inner(ch, deps);
                    }
                }
                for c in &n.children {
                    inner(c, &mut deps);
                }
                deps.sort();
                deps.dedup();
                g.edges.insert(name.clone(), deps);
            }
            for c in &n.children {
                masters(c, g);
            }
        }
        masters(root, &mut g);
        g
    }

    /// Every component whose render depends (transitively) on `name` —
    /// i.e. what must re-render when `name`'s master is edited.
    pub fn dependents_of(&self, name: &str) -> Vec<String> {
        let mut out = vec![];
        for (m, deps) in &self.edges {
            if self.reaches(m, name, &mut vec![]) && m != name && !deps.is_empty() {
                out.push(m.clone());
            }
        }
        out.sort();
        out
    }

    fn reaches(&self, from: &str, to: &str, seen: &mut Vec<String>) -> bool {
        if seen.iter().any(|s| s == from) {
            return false;
        }
        seen.push(from.to_string());
        let Some(deps) = self.edges.get(from) else {
            return false;
        };
        deps.iter().any(|d| d == to || self.reaches(d, to, seen))
    }

    /// True if adding an instance of `child` inside master `parent`
    /// would create a cycle.
    pub fn would_cycle(&self, parent: &str, child: &str) -> bool {
        parent == child || self.reaches(child, parent, &mut vec![])
    }
}
