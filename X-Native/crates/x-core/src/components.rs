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

use crate::{
    color_to_hex, find_node, parse_hex_color, Color, Node, NodeKind, Paint, PaintLayer,
    StrokeLayer, Variables,
};
use std::collections::HashMap;

/// A typed per-node override carried by an Instance.
#[derive(Debug, Clone, PartialEq)]
pub enum OverrideValue {
    Fill(Color),
    /// Stroke paint. A component color property bound to `target_property:
    /// "stroke"` writes this, so a border colour never repaints the interior
    /// of the node it is bound to.
    Stroke(Color),
    Text(String),
    Visible(bool),
    Opacity(f32),
    /// Replace a nested INSTANCE's component with another component name.
    Swap(String),
    /// Numeric override (number property) — sets the target node's width.
    Number(f64),
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
            OverrideValue::Number(n) => format!("num:{n}"),
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
        if let Some(n) = s.strip_prefix("num:") {
            return n.parse().ok().map(OverrideValue::Number);
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
        OverrideValue::Number(_) => "num",
    }
}

/// Target node id stored in an override map key. Composite keys are
/// `{id}\x1f{kind}` so one layer can carry fill AND text at once (Figma).
fn override_target_id(key: &str) -> &str {
    key.split('\x1f').next().unwrap_or(key)
}

pub fn typed_overrides(node: &Node) -> HashMap<String, OverrideValue> {
    // last-wins per target for the prop UI (`t.get("label")`).
    let mut out = HashMap::new();
    for (k, v) in &node.overrides {
        if let Some(ov) = OverrideValue::decode(v) {
            out.insert(override_target_id(k).to_string(), ov);
        }
    }
    out
}

/// Every typed override on `target`, in map order. Figma lets a layer hold
/// a text change and a fill change at the same time.
pub fn overrides_for(node: &Node, target: &str) -> Vec<OverrideValue> {
    node.overrides
        .iter()
        .filter(|(k, _)| override_target_id(k) == target)
        .filter_map(|(_, v)| OverrideValue::decode(v))
        .collect()
}

pub fn set_override(node: &mut Node, target: &str, value: OverrideValue) {
    let tag = override_kind_tag(&value);
    // Preserve the legacy `target` key for the first property on a layer;
    // additional properties use a namespaced key so old `.x` readers and
    // Figma's multi-property instances can coexist.
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

/// Set a property through the legacy one-value-per-layer path used by
/// component-property editing. Direct override commands use `set_override`
/// and may keep multiple property kinds on one target.
pub fn set_exclusive_override(node: &mut Node, target: &str, value: OverrideValue) {
    node.overrides
        .retain(|key, _| override_target_id(key) != target);
    node.overrides.insert(target.to_string(), value.encode());
}

/// Reset every override on an instance (Figma "reset overrides"). Slot
/// content lives in the instance's children, so it is kept.
pub fn reset_overrides(instance: &mut Node) {
    instance.overrides.clear();
}

/// One entry in an instance's change list (Figma's More-actions menu, help
/// 360039150733 "Reset changes": *"Figma only lists properties that have
/// changes applied"*). `node` is the target layer's id, `property` the
/// override kind's own word — the three the menu prints.
#[derive(Debug, Clone, PartialEq)]
pub struct InstanceChange {
    pub node: String,
    pub property: &'static str,
}

impl InstanceChange {
    /// The label Figma shows above the Reset row: the layer the change sits
    /// on, then the property that changed. `root` is the tree to name it
    /// from — an override targets a layer of the MASTER, so the lookup cannot
    /// start at the instance.
    pub fn label(&self, root: &Node) -> String {
        let layer = find_node(root, &self.node)
            .map(|n| n.name.clone())
            .unwrap_or_else(|| self.node.clone());
        format!("{layer} · {}", self.property)
    }
}

/// How far down Figma's list a change sits: the appearance rows first, then
/// the ones that name another layer. Overrides live in a map, so the menu has
/// to impose this order itself to read the same on every render.
fn change_rank(property: &str) -> u8 {
    match property {
        "Fill" => 0,
        "Text" => 1,
        "Visible" => 2,
        "Opacity" => 3,
        "Swap" => 4,
        "Width" => 5,
        _ => 6,
    }
}

/// Every override on `instance` — the change list the Reset menu is built from
/// — grouped in Figma's property order and stable within a group. Slot content
/// is not an override; it lives in the instance's children, so it is never
/// listed (and never reset).
pub fn instance_changes(instance: &Node) -> Vec<InstanceChange> {
    let mut out: Vec<InstanceChange> = instance
        .overrides
        .iter()
        .map(|(key, raw)| InstanceChange {
            node: override_target_id(key).to_string(),
            property: match OverrideValue::decode(raw) {
                Some(OverrideValue::Fill(_)) | Some(OverrideValue::Stroke(_)) => "Fill",
                Some(OverrideValue::Text(_)) => "Text",
                Some(OverrideValue::Visible(_)) => "Visible",
                Some(OverrideValue::Opacity(_)) => "Opacity",
                Some(OverrideValue::Swap(_)) => "Swap",
                Some(OverrideValue::Number(_)) => "Width",
                None => "Change",
            },
        })
        .collect();
    out.sort_by(|a, b| {
        change_rank(a.property)
            .cmp(&change_rank(b.property))
            .then_with(|| a.node.cmp(&b.node))
    });
    out
}

/// Drop ONE override — Figma's *"Reset > Reset [property]"*. Returns whether
/// that layer carried an override at all.
pub fn reset_override(instance: &mut Node, target: &str) -> bool {
    let before = instance.overrides.len();
    instance
        .overrides
        .retain(|k, _| override_target_id(k) != target);
    instance.overrides.len() != before
}

/// Reset every override on ONE LAYER of the instance — Figma's *"select a
/// specific layer to view changes for that layer only"* then *"Reset all
/// changes"*. Both the layer's own entry and any override naming one of its
/// descendants go, so resetting a group resets what it contains.
pub fn reset_layer_overrides(instance: &mut Node, layer: &str) -> usize {
    let mut targets = vec![layer.to_string()];
    if let Some(n) = find_node(instance, layer) {
        fn collect(n: &Node, out: &mut Vec<String>) {
            for c in &n.children {
                out.push(c.id.clone());
                collect(c, out);
            }
        }
        collect(n, &mut targets);
    }
    let before = instance.overrides.len();
    instance
        .overrides
        .retain(|k, _| !targets.iter().any(|t| override_target_id(k) == t));
    before - instance.overrides.len()
}

/// Figma's **push changes to main component** (help 360039150733): the
/// instance's overrides are written into the master, so every other instance
/// of it follows. Only layer *appearance* is pushed — fill, stroke, text,
/// visibility, opacity — because that is the set Figma lets an instance
/// override in the first place; a SWAP (which names another component) is not.
///
/// Returns the number of layers the master actually changed.
pub fn push_overrides_to_master(root: &mut Node, instance_id: &str) -> usize {
    let Some(instance) = find_node(root, instance_id).cloned() else {
        return 0;
    };
    let NodeKind::Instance { component } = &instance.kind else {
        return 0;
    };
    let component = component.clone();
    let Some(master_id) = find_master(root, &component).map(|m| m.id.clone()) else {
        return 0;
    };
    let mut pushed = 0;
    if let Some(master) = find_node_mut(root, &master_id) {
        for child in &mut master.children {
            pushed += push_into(child, &instance.overrides);
        }
    }
    pushed
}

/// Apply `overrides` to one master subtree, then its children. A node whose
/// override lands returns 1 plus whatever its children take, so a nested
/// target is found the same way the renderer finds it.
fn push_into(node: &mut Node, overrides: &std::collections::HashMap<String, String>) -> usize {
    let mut own = 0;
    for (k, raw) in overrides {
        if override_target_id(k) == node.id {
            if let Some(v) = OverrideValue::decode(raw) {
                own += apply_override(node, &v);
            }
        }
    }
    let mut n = own;
    for c in &mut node.children {
        n += push_into(c, overrides);
    }
    n
}

/// Write one typed override into a node; 0 when that kind cannot be pushed.
fn apply_override(node: &mut Node, v: &OverrideValue) -> usize {
    match v {
        OverrideValue::Fill(c) => {
            // The engine's own rule for writing a fill (`Editor::set_fill`): a
            // node that paints from materialized layers paints its top one, so
            // the write has to land there and not only in `fill`.
            if node.visual_stacks_materialized {
                if let Some(layer) = node.fill_layers.last_mut() {
                    layer.paint = Paint::Solid(*c);
                } else {
                    node.fill_layers.push(PaintLayer::new(Paint::Solid(*c)));
                }
            } else {
                node.fill = Paint::Solid(*c);
            }
            1
        }
        OverrideValue::Stroke(c) => {
            apply_stroke_paint(node, *c);
            1
        }
        OverrideValue::Text(t) => {
            if let NodeKind::Text { text } = &mut node.kind {
                *text = t.clone();
                node.text_runs.clear();
                1
            } else {
                0
            }
        }
        OverrideValue::Visible(b) => {
            node.visible = *b;
            1
        }
        OverrideValue::Opacity(o) => {
            node.opacity = *o;
            1
        }
        // a swap names another component, and a number is a bound property's
        // width — neither is a pushable appearance change
        OverrideValue::Swap(_) | OverrideValue::Number(_) => 0,
    }
}

/// First node with `id`, mutable.
fn find_node_mut<'a>(node: &'a mut Node, id: &str) -> Option<&'a mut Node> {
    if node.id == id {
        return Some(node);
    }
    node.children.iter_mut().find_map(|c| find_node_mut(c, id))
}

/// The typed override a color property writes, picked from its
/// `target_property` ("fill" or "stroke"). Anything that is not "stroke"
/// stays a fill, so documents written before the stroke variant existed
/// keep their meaning.
pub fn color_override(target_property: &str, color: Color) -> OverrideValue {
    if target_property.eq_ignore_ascii_case("stroke") {
        OverrideValue::Stroke(color)
    } else {
        OverrideValue::Fill(color)
    }
}

/// Write `color` into `node`'s stroke. The write has to be VISIBLE: a
/// zero-width stroke is given a 1px width, and a node that renders from
/// materialized stroke layers (`Node::active_strokes`) is recolored there
/// too — a materialized node paints from its layers, so a write to the
/// legacy `stroke` field alone would never show up.
pub fn apply_stroke_paint(node: &mut Node, color: Color) {
    node.stroke.paint = Paint::Solid(color);
    if node.stroke.width <= 0.0 {
        node.stroke.width = 1.0;
    }
    if node.visual_stacks_materialized {
        if node.stroke_layers.is_empty() {
            node.stroke_layers
                .push(StrokeLayer::new(node.stroke.clone()));
        } else {
            for l in &mut node.stroke_layers {
                if l.visible {
                    l.stroke.paint = Paint::Solid(color);
                }
            }
        }
    }
}

// ------------------------------------------------------------- properties

/// Document-level component property definition (serializable; the app
/// converts these into the override pipeline's `PropRegistry`). `kind`
/// selects how the value is edited and which override it produces:
/// Text -> `OverrideValue::Text`, Bool -> `Visible`, Swap -> `Swap`.
#[derive(Debug, Clone, PartialEq)]
pub struct ComponentPropEntry {
    pub name: String,
    pub target: String,
    pub kind: ComponentPropKind,
    pub default: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComponentPropKind {
    Text,
    Bool,
    Swap,
}

/// Phase P0: Component property types for designer-facing component properties
#[derive(Debug, Clone, PartialEq)]
pub enum ComponentPropertyType {
    Boolean {
        default: bool,
    },
    Text {
        default: String,
    },
    InstanceSwap {
        allowed_components: Vec<String>,
        default: Option<String>,
    },
    Color {
        default: Color,
    },
    Number {
        default: f64,
        min: Option<f64>,
        max: Option<f64>,
    },
    /// Slot insertion point (see [`ComponentProp::Slot`]).
    Slot {
        default: Option<String>,
    },
}

/// Phase P0: A designer-facing component property
#[derive(Debug, Clone, PartialEq)]
pub struct ComponentProperty {
    pub name: String,
    pub id: String, // unique within component
    pub prop_type: ComponentPropertyType,
    pub preferred_input: Option<String>, // UI hint
}

/// Phase P0: Property binding connects a property to a target node
#[derive(Debug, Clone, PartialEq)]
pub struct PropertyBinding {
    pub property_id: String,
    pub target_node_id: String,
    pub target_property: String, // "visible", "text", "fill", etc.
}

/// Phase P0: A designer-facing component property
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
    /// Number property: binds a numeric value to a target node property.
    Number {
        name: String,
        target: String,
        target_property: String, // "width", "height", "radius", "opacity", etc.
        default: f64,
        min: Option<f64>,
        max: Option<f64>,
    },
    /// Color property: sets a fill/stroke color on a target node.
    Color {
        name: String,
        target: String,
        target_property: String, // "fill" or "stroke"
        default: Color,
    },
    /// Slot property (Figma slots, 2024): an insertion point inside the
    /// master. `target` is the anchor node id — when an instance carries
    /// content for this slot, the anchor subtree is replaced by it; with
    /// no content, `default` (a component name) fills the anchor instead.
    Slot {
        name: String,
        target: String,
        default: Option<String>,
    },
}

impl ComponentProp {
    /// The property's designer-facing name.
    pub fn name(&self) -> &str {
        match self {
            ComponentProp::Text { name, .. }
            | ComponentProp::Bool { name, .. }
            | ComponentProp::Swap { name, .. }
            | ComponentProp::Number { name, .. }
            | ComponentProp::Color { name, .. }
            | ComponentProp::Slot { name, .. } => name,
        }
    }
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
                    set_exclusive_override(instance, target, OverrideValue::Text(value.into()));
                    return true;
                }
                ComponentProp::Bool { name, target, .. } if name == prop_name => {
                    if let Ok(b) = value.parse::<bool>() {
                        set_exclusive_override(instance, target, OverrideValue::Visible(b));
                        return true;
                    }
                }
                ComponentProp::Swap { name, target, .. } if name == prop_name => {
                    set_exclusive_override(instance, target, OverrideValue::Swap(value.into()));
                    return true;
                }
                ComponentProp::Number {
                    name,
                    target,
                    target_property,
                    ..
                } if name == prop_name => {
                    if let Ok(n) = value.parse::<f64>() {
                        // Apply to the specified target_property (width, height, opacity, etc.)
                        match target_property.as_str() {
                            "width" | "height" | "radius" => {
                                set_exclusive_override(instance, target, OverrideValue::Number(n));
                            }
                            "opacity" => {
                                set_exclusive_override(instance, target, OverrideValue::Opacity(n as f32));
                            }
                            _ => {
                                // Default to Number for backward compatibility
                                set_exclusive_override(instance, target, OverrideValue::Number(n));
                            }
                        }
                        return true;
                    }
                }
                ComponentProp::Color {
                    name,
                    target,
                    target_property,
                    ..
                } if name == prop_name => {
                    // Parse hex color and apply to the specified target_property (fill or stroke)
                    if let Some(color) = parse_hex_color(value) {
                        set_exclusive_override(instance, target, color_override(target_property, color));
                        return true;
                    }
                }
                _ => {}
            }
        }
        false
    }
}

// ------------------------------------------------------------------ slots

/// Binding key tagging an instance child as slot content
/// (`bindings["slot"] = <slot name>`).
pub const SLOT_TAG: &str = "slot";

/// The subtree an instance carries for `slot`, if any.
pub fn slot_content<'a>(instance: &'a Node, slot: &str) -> Option<&'a Node> {
    instance
        .children
        .iter()
        .find(|c| c.bindings.get(SLOT_TAG).map(|s| s.as_str()) == Some(slot))
}

/// Bind `content` into the instance's `slot`, replacing any previous
/// content for that slot. Stored as a tagged child of the instance, so
/// it serializes with the instance and renders in place of the master's
/// anchor node.
pub fn set_slot_content(instance: &mut Node, slot: &str, content: Node) {
    instance
        .children
        .retain(|c| c.bindings.get(SLOT_TAG).map(|s| s.as_str()) != Some(slot));
    let mut c = content;
    c.bindings.insert(SLOT_TAG.into(), slot.into());
    instance.children.push(c);
}

/// Remove the instance's content for `slot` (the anchor's default, if
/// any, applies again).
pub fn clear_slot_content(instance: &mut Node, slot: &str) {
    instance
        .children
        .retain(|c| c.bindings.get(SLOT_TAG).map(|s| s.as_str()) != Some(slot));
}

/// Slot-aware children for an instance render: anchors declared by the
/// master's `Slot` props are substituted with the instance's slot
/// content (or an Instance of the slot's default component).
///
/// Returns `None` when the master has no slots — the zero-clone fast
/// path; renderers should then lower `def.children` directly.
pub fn resolve_slots(def: &Node, instance: &Node) -> Option<Vec<Node>> {
    if !def
        .props
        .iter()
        .any(|p| matches!(p, ComponentProp::Slot { .. }))
    {
        return None;
    }
    // anchor node id -> (slot name, default component)
    let mut anchors: HashMap<String, (String, Option<String>)> = HashMap::new();
    for p in &def.props {
        if let ComponentProp::Slot {
            name,
            target,
            default,
        } = p
        {
            anchors.insert(target.clone(), (name.clone(), default.clone()));
        }
    }
    let content: HashMap<&str, &Node> = instance
        .children
        .iter()
        .filter_map(|c| c.bindings.get(SLOT_TAG).map(|s| (s.as_str(), c)))
        .collect();
    Some(
        def.children
            .iter()
            .map(|c| substitute_slots(c, &anchors, &content))
            .collect(),
    )
}

fn substitute_slots(
    n: &Node,
    anchors: &HashMap<String, (String, Option<String>)>,
    content: &HashMap<&str, &Node>,
) -> Node {
    if let Some((slot, default)) = anchors.get(&n.id) {
        if let Some(&c) = content.get(slot.as_str()) {
            return c.clone();
        }
        if let Some(d) = default {
            // no instance content: the default component fills the anchor
            let mut inst = Node::instance(&n.id, d, n.transform.x, n.transform.y, n.w, n.h);
            inst.name = n.name.clone();
            return inst;
        }
        // no content, no default: keep the placeholder anchor as-is
    }
    let mut out = n.clone();
    out.children = n
        .children
        .iter()
        .map(|c| substitute_slots(c, anchors, content))
        .collect();
    out
}

// ---------------------------------------------------------------- variants

/// Variant identity: "Set/VariantName". Components named with a slash are
/// variant members of a set ("Button/Primary", "Button/Danger").
pub fn variant_set(component_name: &str) -> Option<(&str, &str)> {
    component_name.split_once('/')
}

/// The variant set a frame **is**: every child is a component master named
/// `Set/Variant` and they all share one set prefix. Figma's set is not its own
/// kind of node — it is a frame holding variants — so the rule that "a set can
/// contain only components" falls straight out of this predicate.
pub fn variant_set_members(frame: &Node) -> Option<(&str, Vec<(&str, &str)>)> {
    if frame.children.is_empty() {
        return None;
    }
    let mut set: Option<&str> = None;
    let mut out = Vec::new();
    for c in &frame.children {
        let NodeKind::Component { name } = &c.kind else {
            return None;
        };
        let (s, v) = variant_set(name)?;
        match set {
            None => set = Some(s),
            Some(prev) if prev == s => {}
            Some(_) => return None,
        }
        out.push((v, name.as_str()));
    }
    set.map(|s| (s, out))
}

/// Is this frame a component set (see [`variant_set_members`])?
pub fn is_variant_set(frame: &Node) -> bool {
    variant_set_members(frame).is_some()
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
    let resolved = resolve_slots(master, instance);
    let kids: &[Node] = resolved.as_deref().unwrap_or(&master.children);
    for child in kids {
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
            OverrideValue::Number(n) => {
                node.w = n;
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

#[cfg(test)]
mod tests {
    use super::*;
    use peniko::Color;

    fn master_with_slot() -> Node {
        // Card master: label text + a slot anchored on the "body" frame
        let mut m = Node::component("Card", "Card", 200.0, 100.0);
        m.children
            .push(Node::text("title", 8.0, 8.0, 180.0, 16.0, "Card"));
        m.children.push(Node::frame("body", 184.0, 60.0));
        m.props.push(ComponentProp::Slot {
            name: "Content".into(),
            target: "body".into(),
            default: None,
        });
        m
    }

    #[test]
    fn slot_content_set_get_clear_roundtrip() {
        let mut inst = Node::instance("i1", "Card", 0.0, 0.0, 200.0, 100.0);
        assert!(slot_content(&inst, "Content").is_none());
        let mut c = Node::rect("badge", 0.0, 0.0, 60.0, 20.0, Color::from_rgb8(0xff, 0, 0));
        c.name = "Badge".into();
        set_slot_content(&mut inst, "Content", c);
        assert_eq!(slot_content(&inst, "Content").unwrap().id, "badge");
        assert_eq!(inst.children.len(), 1);
        // replacing swaps, doesn't accumulate
        let c2 = Node::rect("pill", 0.0, 0.0, 40.0, 12.0, Color::WHITE);
        set_slot_content(&mut inst, "Content", c2);
        assert_eq!(inst.children.len(), 1);
        assert_eq!(slot_content(&inst, "Content").unwrap().id, "pill");
        clear_slot_content(&mut inst, "Content");
        assert!(slot_content(&inst, "Content").is_none());
        assert!(inst.children.is_empty());
    }

    #[test]
    fn resolve_slots_substitutes_content_at_anchor() {
        let m = master_with_slot();
        let mut inst = Node::instance("i1", "Card", 0.0, 0.0, 200.0, 100.0);
        set_slot_content(
            &mut inst,
            "Content",
            Node::rect("badge", 0.0, 0.0, 60.0, 20.0, Color::from_rgb8(0xff, 0, 0)),
        );
        let kids = resolve_slots(&m, &inst).expect("slots resolved");
        assert_eq!(kids.len(), 2);
        assert_eq!(kids[0].id, "title");
        assert_eq!(kids[1].id, "badge", "anchor replaced by slot content");
        // no instance content: placeholder anchor kept
        let plain = Node::instance("i2", "Card", 0.0, 0.0, 200.0, 100.0);
        let kids2 = resolve_slots(&m, &plain).expect("slots resolved");
        assert_eq!(kids2[1].id, "body");
    }

    #[test]
    fn resolve_slots_default_component_fills_anchor() {
        // Badge master + Card master whose slot defaults to "Badge"
        let mut m = master_with_slot();
        if let ComponentProp::Slot { default, .. } = m.props.last_mut().unwrap() {
            *default = Some("Badge".into());
        }
        let plain = Node::instance("i2", "Card", 0.0, 0.0, 200.0, 100.0);
        let kids = resolve_slots(&m, &plain).expect("slots resolved");
        assert!(matches!(&kids[1].kind, NodeKind::Instance { component } if component == "Badge"));
        // instance content still wins over the default
        let mut inst = Node::instance("i1", "Card", 0.0, 0.0, 200.0, 100.0);
        set_slot_content(
            &mut inst,
            "Content",
            Node::rect("x", 0.0, 0.0, 10.0, 10.0, Color::WHITE),
        );
        let kids2 = resolve_slots(&m, &inst).expect("slots resolved");
        assert_eq!(kids2[1].id, "x");
    }

    #[test]
    fn resolve_slots_fast_path_without_slots() {
        let mut m = Node::component("Plain", "Plain", 10.0, 10.0);
        m.children
            .push(Node::rect("a", 0.0, 0.0, 5.0, 5.0, Color::WHITE));
        let inst = Node::instance("i", "Plain", 0.0, 0.0, 10.0, 10.0);
        assert!(resolve_slots(&m, &inst).is_none());
    }

    #[test]
    fn detach_instance_applies_slots_and_overrides() {
        let mut root = Node::frame("root", 800.0, 600.0);
        root.children.push(master_with_slot());
        let mut inst = Node::instance("i1", "Card", 100.0, 50.0, 200.0, 100.0);
        set_override(&mut inst, "title", OverrideValue::Text("Hi".into()));
        set_slot_content(
            &mut inst,
            "Content",
            Node::rect("badge", 0.0, 0.0, 60.0, 20.0, Color::from_rgb8(0xff, 0, 0)),
        );
        root.children.push(inst);

        let inst_ref = find(&root, "i1").unwrap();
        let group = detach_instance(&root, inst_ref, &Variables::default()).expect("detach");
        assert_eq!(group.id, "i1-detached");
        assert_eq!(group.children.len(), 2);
        let title = &group.children[0];
        assert!(matches!(&title.kind, NodeKind::Text { text } if text == "Hi"));
        assert_eq!(
            group.children[1].id, "badge",
            "slot content detached in place"
        );
    }

    #[test]
    fn reset_overrides_keeps_slot_content() {
        let mut inst = Node::instance("i1", "Card", 0.0, 0.0, 200.0, 100.0);
        set_override(&mut inst, "title", OverrideValue::Text("Hi".into()));
        set_slot_content(
            &mut inst,
            "Content",
            Node::rect("x", 0.0, 0.0, 10.0, 10.0, Color::WHITE),
        );
        reset_overrides(&mut inst);
        assert!(inst.overrides.is_empty());
        assert_eq!(inst.children.len(), 1, "slot content survives reset");
    }

    #[test]
    fn slot_prop_name_and_typed_twin() {
        let p = ComponentProp::Slot {
            name: "Content".into(),
            target: "body".into(),
            default: Some("Badge".into()),
        };
        assert_eq!(p.name(), "Content");
        let typed = ComponentPropertyType::Slot {
            default: Some("Badge".into()),
        };
        assert!(matches!(typed, ComponentPropertyType::Slot { .. }));
    }

    #[test]
    fn color_override_picks_the_variant_from_target_property() {
        let c = Color::from_rgb8(0, 0xff, 0);
        assert!(matches!(
            color_override("stroke", c),
            OverrideValue::Stroke(_)
        ));
        assert!(
            matches!(color_override("Stroke", c), OverrideValue::Stroke(_)),
            "target_property matching is case-insensitive"
        );
        assert!(matches!(color_override("fill", c), OverrideValue::Fill(_)));
        assert!(
            matches!(color_override("radius", c), OverrideValue::Fill(_)),
            "anything unknown keeps the pre-stroke-variant behaviour"
        );
    }

    #[test]
    fn stroke_override_encodes_and_decodes() {
        let c = Color::from_rgb8(0, 0xff, 0);
        let enc = OverrideValue::Stroke(c).encode();
        assert_eq!(enc, "stroke:#00ff00", "color_to_hex emits lowercase hex");
        assert_eq!(OverrideValue::decode(&enc), Some(OverrideValue::Stroke(c)));
        // the bare-hex serialization surface still means Fill
        assert_eq!(
            OverrideValue::decode("#00ff00"),
            Some(OverrideValue::Fill(c))
        );
        // a bad payload after the prefix is rejected, never silently a Fill
        assert_eq!(OverrideValue::decode("stroke:nope"), None);
    }

    #[test]
    fn apply_stroke_paint_sets_paint_and_makes_a_zero_width_visible() {
        let c = Color::from_rgb8(0, 0xff, 0);
        let mut n = Node::rect("r", 0.0, 0.0, 10.0, 10.0, Color::WHITE);
        assert_eq!(n.stroke.width, 0.0);
        apply_stroke_paint(&mut n, c);
        assert_eq!(n.stroke.solid_color(), Some(c));
        assert_eq!(n.stroke.width, 1.0, "zero-width stroke is made visible");
        // an existing width is kept, not overwritten
        n.stroke.width = 3.0;
        apply_stroke_paint(&mut n, Color::BLACK);
        assert_eq!(n.stroke.width, 3.0);
        assert_eq!(n.stroke.solid_color(), Some(Color::BLACK));
        // the fill of the node is never touched
        assert!(matches!(&n.fill, Paint::Solid(c) if *c == Color::WHITE));
    }

    #[test]
    fn apply_stroke_paint_recolors_materialized_stroke_layers() {
        let c = Color::from_rgb8(0, 0xff, 0);
        let mut n = Node::rect("r", 0.0, 0.0, 10.0, 10.0, Color::WHITE);
        n.materialize_visual_stacks();
        assert!(
            n.active_strokes().is_empty(),
            "width 0 materializes no layer"
        );
        apply_stroke_paint(&mut n, c);
        let strokes = n.active_strokes();
        assert_eq!(strokes.len(), 1, "the override adds a paintable layer");
        assert_eq!(strokes[0].stroke.solid_color(), Some(c));
        assert_eq!(strokes[0].stroke.width, 1.0);
        // an existing visible layer is recolored in place, not duplicated
        let mut m = Node::rect("m", 0.0, 0.0, 10.0, 10.0, Color::WHITE);
        m.stroke.width = 2.0;
        m.materialize_visual_stacks();
        apply_stroke_paint(&mut m, c);
        assert_eq!(m.stroke_layers.len(), 1);
        assert_eq!(m.stroke_layers[0].stroke.solid_color(), Some(c));
        assert_eq!(m.stroke_layers[0].stroke.width, 2.0);
    }

    #[test]
    fn prop_registry_apply_writes_stroke_and_fill_overrides() {
        let mut reg = PropRegistry::default();
        reg.props.insert(
            "Card".into(),
            vec![
                ComponentProp::Color {
                    name: "Border".into(),
                    target: "border".into(),
                    target_property: "stroke".into(),
                    default: Color::BLACK,
                },
                ComponentProp::Color {
                    name: "Surface".into(),
                    target: "border".into(),
                    target_property: "fill".into(),
                    default: Color::WHITE,
                },
            ],
        );
        let mut inst = Node::instance("i1", "Card", 0.0, 0.0, 200.0, 100.0);
        assert!(reg.apply("Card", &mut inst, "Border", "#00ff00"));
        assert_eq!(
            inst.overrides.get("border").map(String::as_str),
            Some("stroke:#00ff00"),
            "a stroke property must not encode as a fill"
        );
        assert!(reg.apply("Card", &mut inst, "Surface", "#ff0000"));
        assert_eq!(
            inst.overrides.get("border").map(String::as_str),
            Some("#ff0000")
        );
        // a bad colour is rejected outright
        assert!(!reg.apply("Card", &mut inst, "Border", "not-a-color"));
    }

    fn find<'a>(n: &'a Node, id: &str) -> Option<&'a Node> {
        if n.id == id {
            return Some(n);
        }
        n.children.iter().find_map(|c| find(c, id))
    }

    /// A Button master: a label text and an icon rect, with one instance of it
    /// on the page. The instance carries a text override, a fill override on
    /// the icon and a swap override — the three kinds the Reset menu sorts.
    fn master_and_instance() -> (Node, Node) {
        let mut master = Node::component("Button", "Button", 120.0, 44.0);
        master
            .children
            .push(Node::text("lbl", 12.0, 12.0, 80.0, 20.0, "Click me"));
        master.children.push(Node::rect(
            "ico",
            96.0,
            14.0,
            16.0,
            16.0,
            Color::from_rgb8(0x11, 0x22, 0x33),
        ));
        master
            .children
            .push(Node::instance("badge", "Badge", 96.0, 14.0, 16.0, 16.0));
        let mut inst = Node::instance("i1", "Button", 40.0, 300.0, 120.0, 44.0);
        set_override(&mut inst, "lbl", OverrideValue::Text("Hello".into()));
        set_override(
            &mut inst,
            "ico",
            OverrideValue::Fill(Color::from_rgb8(0xff, 0, 0)),
        );
        set_override(&mut inst, "badge", OverrideValue::Swap("Badge/Big".into()));
        (master, inst)
    }

    #[test]
    fn the_change_list_names_every_override_and_reset_clears_one() {
        let (master, inst) = master_and_instance();
        let changes = instance_changes(&inst);
        assert_eq!(changes.len(), 3, "one entry per override");
        // Figma's property order, not the map's
        assert_eq!(
            (changes[0].node.as_str(), changes[0].property),
            ("ico", "Fill")
        );
        assert_eq!(
            (changes[1].node.as_str(), changes[1].property),
            ("lbl", "Text")
        );
        assert_eq!(
            (changes[2].node.as_str(), changes[2].property),
            ("badge", "Swap")
        );
        // the label names the LAYER the change sits on (Figma's menu is a list
        // of layers-and-properties, not of internal ids)
        assert_eq!(changes[0].label(&master), "ico · Fill");
        assert_eq!(changes[1].label(&master), "lbl · Text");
        assert_eq!(changes[2].label(&master), "badge · Swap");

        // Figma's "Reset > Reset [property]": one override goes, the rest stay
        let mut after = inst.clone();
        assert!(reset_override(&mut after, "lbl"));
        assert_eq!(after.overrides.len(), 2);
        assert!(!after.overrides.contains_key("lbl"));
        assert!(
            !reset_override(&mut after, "lbl"),
            "a second reset has nothing to clear"
        );
    }

    #[test]
    fn resetting_a_layer_clears_its_subtree_and_nothing_else() {
        // a container override plus one on a layer inside it
        let mut inst = Node::instance("i1", "Card", 0.0, 0.0, 100.0, 60.0);
        set_override(&mut inst, "lbl", OverrideValue::Text("Hi".into()));
        set_override(&mut inst, "outer", OverrideValue::Opacity(0.5));
        set_override(&mut inst, "inner", OverrideValue::Visible(false));
        let mut outer = Node::group("outer", 100.0, 60.0);
        outer
            .children
            .push(Node::rect("inner", 0.0, 0.0, 10.0, 10.0, Color::WHITE));
        inst.children.push(outer);

        // selecting the group resets what the group and its children carry
        let cleared = reset_layer_overrides(&mut inst, "outer");
        assert_eq!(cleared, 2, "the group and the layer inside it");
        assert_eq!(inst.overrides.len(), 1);
        assert!(
            inst.overrides.contains_key("lbl"),
            "a sibling is untouched by a layer reset"
        );
        assert_eq!(reset_layer_overrides(&mut inst, "outer"), 0);
    }

    #[test]
    fn pushing_overrides_writes_the_master_for_every_instance() {
        let (master, inst) = master_and_instance();
        let mut root = Node::frame("page", 800.0, 600.0);
        let master_id = master.id.clone();
        root.children.push(master);
        root.children.push(inst.clone());
        // a second instance shows the same master
        root.children
            .push(Node::instance("i2", "Button", 40.0, 400.0, 120.0, 44.0));

        let changed = push_overrides_to_master(&mut root, "i1");
        assert_eq!(
            changed, 2,
            "fill + text are pushable; a swap names another component"
        );
        let m = find(&root, &master_id).expect("master still there");
        let NodeKind::Text { text } = &find(m, "lbl").unwrap().kind else {
            panic!("label is a text layer")
        };
        assert_eq!(text, "Hello", "the master's text took the override");
        assert!(
            matches!(
                &find(m, "ico").unwrap().fill,
                Paint::Solid(c) if *c == Color::from_rgb8(0xff, 0, 0)
            ),
            "the master's icon took the fill"
        );
        let badge = &find(m, "badge").unwrap().kind;
        assert!(
            matches!(badge, NodeKind::Instance { component } if component == "Badge"),
            "a swap override does not repoint the master's nested instance"
        );
        assert_eq!(
            root.children[1].overrides.len(),
            3,
            "the pushed instance keeps its own override list"
        );
    }

    #[test]
    fn pushing_from_an_instance_whose_master_is_gone_changes_nothing() {
        let (_, inst) = master_and_instance();
        let mut root = Node::frame("page", 800.0, 600.0);
        let mut orphan = inst.clone();
        orphan.kind = NodeKind::Instance {
            component: "Missing".into(),
        };
        root.children.push(orphan);
        assert_eq!(push_overrides_to_master(&mut root, "i1"), 0);
    }

    #[test]
    fn one_layer_can_hold_text_and_fill_overrides() {
        let mut inst = Node::instance("i", "Btn", 0.0, 0.0, 80.0, 32.0);
        set_override(&mut inst, "label", OverrideValue::Text("Hi".into()));
        set_override(
            &mut inst,
            "label",
            OverrideValue::Fill(Color::from_rgb8(0xff, 0, 0)),
        );
        let both = overrides_for(&inst, "label");
        assert!(
            both.iter()
                .any(|v| matches!(v, OverrideValue::Text(t) if t == "Hi")),
            "{both:?}"
        );
        assert!(
            both.iter().any(|v| matches!(v, OverrideValue::Fill(_))),
            "{both:?}"
        );
        assert_eq!(inst.overrides.len(), 2);
    }
}
