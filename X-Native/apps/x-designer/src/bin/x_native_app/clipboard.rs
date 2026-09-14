//! In-session object clipboard. Copies are portable snapshots, not a page's
//! private Editor clipboard. Resource name conflicts fail before any mutation.
use crate::state::{App, OpenDoc};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
};
use x_native::{Affine, ComponentProp, Document, Node, NodeKind, Variables};

#[derive(Default)]
pub struct Clipboard {
    nodes: Vec<Node>,
    dependencies: Vec<Node>,
    context: Document,
    source: PathBuf,
    error: Option<String>,
}

fn components<'a>(n: &'a Node, map: &mut HashMap<String, &'a Node>) {
    if let NodeKind::Component { name } = &n.kind {
        map.insert(name.clone(), n);
    }
    for c in &n.children {
        components(c, map);
    }
}
fn references(n: &Node, out: &mut HashSet<String>) {
    if let NodeKind::Instance { component } = &n.kind {
        out.insert(component.clone());
    }
    for v in n.overrides.values() {
        if let Some(name) = v.strip_prefix("swap:") {
            out.insert(name.into());
        }
    }
    for prop in &n.props {
        match prop {
            ComponentProp::Swap { default, .. } => {
                out.insert(default.clone());
            }
            ComponentProp::Slot {
                default: Some(name),
                ..
            } => {
                out.insert(name.clone());
            }
            _ => {}
        }
    }
    for c in &n.children {
        references(c, out);
    }
}
fn child_parent(n: &Node, c: &Node, world: Affine) -> Affine {
    if !n.overflow.scrollable() || c.constraints.fixed {
        world
    } else if c.constraints.sticky {
        world
            * Affine::translate((
                -n.scroll.0.min(c.transform.x),
                -n.scroll.1.min(c.transform.y),
            ))
    } else {
        world * Affine::translate((-n.scroll.0, -n.scroll.1))
    }
}

impl Clipboard {
    fn capture(doc: &OpenDoc) -> Self {
        fn selected(n: &Node, parent: Affine, selection: &[String], out: &mut Vec<Node>) {
            let world = parent * n.transform.matrix(n.w, n.h);
            if selection.contains(&n.id) {
                let mut copy = n.clone();
                copy.transform = x_native::Transform::from_affine(world);
                out.push(copy);
                return; // don't duplicate a selected descendant
            }
            for c in &n.children {
                selected(c, child_parent(n, c, world), selection, out);
            }
        }
        let mut nodes = vec![];
        selected(
            &doc.editor_ref().root,
            Affine::IDENTITY,
            &doc.editor_ref().selection,
            &mut nodes,
        );
        let mut registry = HashMap::new();
        for editor in &doc.editors {
            components(&editor.root, &mut registry);
        }
        let mut already = HashMap::new();
        for n in &nodes {
            components(n, &mut already);
        }
        let mut seen: HashSet<String> = already.keys().cloned().collect();
        let mut need = HashSet::new();
        for n in &nodes {
            references(n, &mut need);
        }
        let mut dependencies = vec![];
        let mut error = None;
        while let Some(name) = need.iter().next().cloned() {
            need.remove(&name);
            if !seen.insert(name.clone()) {
                continue;
            }
            if let Some(n) = registry.get(&name) {
                dependencies.push((*n).clone());
                references(n, &mut need);
            } else {
                error = Some(format!("component dependency '{name}' is missing"));
                break;
            }
        }
        let context = Document {
            variables: doc.doc.variables.clone(),
            styles: doc.doc.styles.clone(),
            assets: doc.doc.assets.clone(),
            library_deps: doc.doc.library_deps.clone(),
            library_snapshots: doc.doc.library_snapshots.clone(),
            component_props: doc.doc.component_props.clone(),
            ..Default::default()
        };
        Self {
            nodes,
            dependencies,
            context,
            source: doc.recovery_path.clone(),
            error,
        }
    }

    fn paste(&self, target: &mut OpenDoc) -> Result<bool, String> {
        if let Some(e) = &self.error {
            return Err(e.clone());
        }
        if self.nodes.is_empty() {
            return Ok(false);
        }
        target.sync();
        let mut candidate = target.doc.clone();
        if self.source != target.recovery_path {
            merge_variables(&mut candidate.variables, &self.context.variables)?;
            merge_map(&mut candidate.styles, &self.context.styles, "style")?;
            for dep in &self.context.library_deps {
                if let Some(old) = candidate
                    .library_deps
                    .iter()
                    .find(|d| d.library_id == dep.library_id)
                {
                    if old != dep {
                        return Err(format!(
                            "conflicting library '{}' — no changes made",
                            dep.library_id
                        ));
                    }
                } else {
                    candidate.library_deps.push(dep.clone());
                    if let Some(snap) = self.context.library_snapshots.get(&dep.library_id) {
                        candidate
                            .library_snapshots
                            .insert(dep.library_id.clone(), snap.clone());
                    }
                }
            }
        }
        for r in self.context.assets.iter_sorted() {
            candidate
                .assets
                .register(&r.name, r.bytes.clone(), x_native::AssetSource::Embedded);
        }
        let mut forest = Node::group(&x_native::fresh_id("clipboard"), 0.0, 0.0);
        forest.children = self.nodes.clone();
        let selected_count = forest.children.len();
        let mut existing = HashMap::new();
        components(&target.editor_ref().root, &mut existing);
        for dep in &self.dependencies {
            let NodeKind::Component { name } = &dep.kind else {
                continue;
            };
            if self.source == target.recovery_path && existing.contains_key(name) {
                continue;
            }
            let mut dep = dep.clone();
            dep.visible = false; // registry-only dependency, not extra canvas artwork
            forest.children.push(dep);
        }
        // Overlapping component graphs need scoped-ID resolution, not guessing.
        let mut ids = HashSet::new();
        let mut stack = vec![&forest];
        while let Some(n) = stack.pop() {
            if !ids.insert(n.id.clone()) {
                return Err("overlapping component dependencies; copy the master with its instances instead".into());
            }
            stack.extend(&n.children);
        }
        let mut names: HashSet<String> = candidate.component_props.keys().cloned().collect();
        for page in &candidate.pages {
            let mut registry = HashMap::new();
            components(page, &mut registry);
            names.extend(registry.into_keys());
        }
        let component_map = rename_components(&mut forest, &mut names);
        let id_map = x_native::remap_node_ids(&mut forest, |_| x_native::fresh_id("node"));
        for (old, new) in component_map {
            if let Some(props) = self.context.component_props.get(&old) {
                let mut props = props.clone();
                for p in &mut props {
                    if let Some(id) = id_map.get(&p.target) {
                        p.target = id.clone();
                    }
                }
                candidate.component_props.insert(new, props);
            }
        }
        // Clipboard roots were captured in page/world space; retain it even on
        // a page whose own transform is non-identity.
        let root = &target.editor_ref().root;
        let to_page = root.transform.matrix(root.w, root.h).inverse();
        for n in &mut forest.children[..selected_count] {
            n.transform = x_native::Transform::from_affine(to_page * n.transform.matrix(n.w, n.h));
        }
        let selected: Vec<_> = forest.children[..selected_count]
            .iter()
            .map(|n| n.id.clone())
            .collect();
        candidate.pages[target.page]
            .children
            .extend(forest.children.clone());
        x_native::fileio::validate_admission(&candidate)?;
        target.checkpoint();
        target.doc = candidate;
        let parent = target.editor_ref().root.id.clone();
        if !target.editor().insert_nodes(&parent, forest.children) {
            target.undo_document();
            return Err("clipboard insertion refused; no changes kept".into());
        }
        target.editor().selection = selected;
        target.frame_cache = x_native::FrameCache::new();
        target.finish_document_edit();
        Ok(true)
    }
}

fn merge_map<T: PartialEq + Clone>(
    dest: &mut HashMap<String, T>,
    source: &HashMap<String, T>,
    kind: &str,
) -> Result<(), String> {
    for (name, value) in source {
        if dest.get(name).is_some_and(|old| old != value) {
            return Err(format!("conflicting {kind} '{name}' — paste into a blank document or resolve the name conflict first"));
        }
        dest.insert(name.clone(), value.clone());
    }
    Ok(())
}
fn merge_variables(dest: &mut Variables, source: &Variables) -> Result<(), String> {
    let empty = |v: &Variables| {
        v.colors.is_empty()
            && v.numbers.is_empty()
            && v.strings.is_empty()
            && v.bools.is_empty()
            && v.aliases.is_empty()
    };
    if empty(dest) {
        *dest = source.clone();
        return Ok(());
    }
    if empty(source) {
        return Ok(());
    }
    if dest.active_mode != source.active_mode {
        return Err("variable modes differ; no clipboard changes made".into());
    }
    macro_rules! merge { ($($field:ident),+) => { $(merge_map(&mut dest.$field, &source.$field, "variable")?;)+ }; }
    merge!(
        colors,
        numbers,
        strings,
        bools,
        aliases,
        collections,
        modes,
        num_modes,
        str_modes,
        bool_modes
    );
    dest.exposed.extend(source.exposed.iter().cloned());
    Ok(())
}

/// Rename definitions and every matching instance/swap reference together.
/// Used both by clipboard transfer and page duplication.
pub fn rename_components(root: &mut Node, taken: &mut HashSet<String>) -> HashMap<String, String> {
    let mut defs = HashMap::new();
    components(root, &mut defs);
    let mut ordered: Vec<_> = defs.into_keys().collect();
    ordered.sort();
    let mut map = HashMap::new();
    for name in ordered {
        let mut next = format!("{name} copy");
        let mut i = 2;
        while taken.contains(&next) {
            next = format!("{name} copy {i}");
            i += 1;
        }
        taken.insert(next.clone());
        map.insert(name, next);
    }
    fn rewrite(n: &mut Node, map: &HashMap<String, String>) {
        let rename = |s: &mut String| {
            if let Some(new) = map.get(s) {
                *s = new.clone();
            }
        };
        match &mut n.kind {
            NodeKind::Component { name } => rename(name),
            NodeKind::Instance { component } => rename(component),
            _ => {}
        }
        for v in n.overrides.values_mut() {
            if let Some(name) = v.strip_prefix("swap:") {
                if let Some(new) = map.get(name) {
                    *v = format!("swap:{new}");
                }
            }
        }
        for p in &mut n.props {
            match p {
                ComponentProp::Swap { default, .. } => rename(default),
                ComponentProp::Slot {
                    default: Some(s), ..
                } => rename(s),
                _ => {}
            }
        }
        for c in &mut n.children {
            rewrite(c, map);
        }
    }
    rewrite(root, &map);
    map
}

impl App {
    pub fn copy_nodes(&mut self) -> bool {
        self.clipboard = Clipboard::capture(self.doc());
        if let Some(e) = &self.clipboard.error {
            self.status = format!("Copy refused: {e}");
            false
        } else {
            !self.clipboard.nodes.is_empty()
        }
    }
    /// Whether a paste would have anything to do. `paste_nodes` reports the
    /// empty case in `status` itself, so callers use this only to explain *why*
    /// they are overriding that message (QA-001: method, not field access).
    pub fn has_clipboard_content(&self) -> bool {
        !self.clipboard.nodes.is_empty()
    }
    pub fn paste_nodes(&mut self) {
        let clipboard = std::mem::take(&mut self.clipboard);
        let result = clipboard.paste(self.doc());
        self.clipboard = clipboard;
        match result {
            Ok(true) => {
                self.mark_dirty();
                self.status = "Pasted — embedded assets and component dependencies retained".into();
            }
            Ok(false) => self.status = "Object clipboard is empty".into(),
            Err(e) => self.status = format!("Paste refused: {e}"),
        }
    }
}
