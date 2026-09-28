//! Editor integration for vector booleans. The geometry core lives in
//! `x_core::booleans` (shared with the format importers —  boolean
//! shapeGroups flatten through it); this module keeps the historical
//! `x_editor::booleans` path alive and adds the undoable editor command.

pub use x_core::booleans::{
    boolean, boolean_paths, boolean_with, node_to_path, path_is_closed, path_to_polylines,
    stroke_outline, Backend, BoolOp, BooleanResult, PositionedPath,
};

use crate::{find, parent_id, Command, Editor};
use x_core::web_raster::boolean_web_raster_shaped;
use x_core::{
    outline_stroke_path, Color, Node, NodeKind, Paint, PaintLayer, PathCmd, Stroke, StrokeLayer,
};

// The web raster's cell-centre boundary walker deliberately preserves the TS
// ring order. It can trace a contained hole in the SAME direction as its
// enclosing contour. The web region uses EVENODD, but native .x vectors paint
// with NONZERO: orient only nested rings before committing a session vector.
// Do not alter the proven x-geo/TS raw-raster parity contract.
fn orient_web_rings_for_nonzero(rings: &mut [Vec<(f64, f64)>]) {
    if rings.len() < 2 {
        return;
    }
    fn area(ring: &[(f64, f64)]) -> f64 {
        ring.iter()
            .zip(ring.iter().cycle().skip(1))
            .map(|(&(x, y), &(u, v))| x * v - u * y)
            .sum::<f64>()
            / 2.0
    }
    fn contains(ring: &[(f64, f64)], (x, y): (f64, f64)) -> bool {
        let mut inside = false;
        let mut prev = ring[ring.len() - 1];
        for &current in ring {
            if (current.1 > y) != (prev.1 > y)
                && x < (prev.0 - current.0) * (y - current.1) / (prev.1 - current.1) + current.0
            {
                inside = !inside;
            }
            prev = current;
        }
        inside
    }
    let mut areas: Vec<f64> = rings.iter().map(|ring| area(ring)).collect();
    let mut largest_first: Vec<usize> = (0..rings.len()).collect();
    largest_first.sort_by(|&a, &b| areas[b].abs().total_cmp(&areas[a].abs()));
    for i in largest_first {
        if !areas[i].is_finite() || areas[i].abs() <= 1e-8 {
            continue;
        }
        let parent = (0..rings.len())
            .filter(|&j| {
                j != i
                    && areas[j].is_finite()
                    && areas[j].abs() > areas[i].abs()
                    && contains(&rings[j], rings[i][0])
            })
            .min_by(|&a, &b| areas[a].abs().total_cmp(&areas[b].abs()));
        if let Some(j) = parent {
            if areas[i].signum() == areas[j].signum() {
                // Preserve the first anchor: only winding changes, not the
                // raster's chosen origin, filled cells, or vector bounds.
                rings[i][1..].reverse();
                areas[i] = -areas[i];
            }
        }
    }
}

impl Editor {
    /// Boolean the two selected nodes -> one new Vector node (undoable).
    /// Keeps the FIRST node's fill; deletes both inputs.
    pub fn boolean_selected(&mut self, op: BoolOp) -> Option<String> {
        if self.selection.len() != 2 {
            return None;
        }
        let (ida, idb) = (self.selection[0].clone(), self.selection[1].clone());
        let na = find(&self.root, &ida)?.clone();
        let nb = find(&self.root, &idb)?.clone();
        let pa = node_to_path(&na)?;
        let pb = node_to_path(&nb)?;
        let res = boolean(
            op,
            &PositionedPath {
                cmds: pa,
                offset: (na.transform.x, na.transform.y),
            },
            &PositionedPath {
                cmds: pb,
                offset: (nb.transform.x, nb.transform.y),
            },
        );
        let (path, origin, size) = (res.cmds, res.origin, res.size);
        if path.is_empty() {
            return None;
        }
        let new_id = x_core::fresh_id("bool");
        let mut v = Node::vector(&new_id, 0.0, 0.0, size.0, size.1, path);
        v.transform.x = origin.0;
        v.transform.y = origin.1;
        v.fill = na.fill.clone();
        self.commit_boolean_result(&ida, &idb, v)
    }

    /// The promoted x-geo grid, scoped to two anchor-only shapes admitted by
    /// DocumentSession. Unlike the general native curve-preserving Boolean
    /// backend, this is the exact raster + simplifier matched by the web
    /// oracle. The same single Rust editor history owns edit/undo/redo.
    pub fn boolean_web_selected(&mut self, op: BoolOp) -> Result<String, &'static str> {
        if self.selection.len() != 2 || self.selection[0] == self.selection[1] {
            return Err("Boolean requires two distinct selected layers");
        }
        let (ida, idb) = (self.selection[0].clone(), self.selection[1].clone());
        let na = find(&self.root, &ida)
            .ok_or("first Boolean operand missing")?
            .clone();
        let nb = find(&self.root, &idb)
            .ok_or("second Boolean operand missing")?
            .clone();
        let a = PositionedPath {
            cmds: node_to_path(&na).ok_or("unsupported first Boolean operand")?,
            offset: (na.transform.x, na.transform.y),
        };
        let b = PositionedPath {
            cmds: node_to_path(&nb).ok_or("unsupported second Boolean operand")?,
            offset: (nb.transform.x, nb.transform.y),
        };
        let mut rings = boolean_web_raster_shaped(op, &[a, b])?;
        if rings.len() > 512
            || rings.iter().any(|ring| ring.len() < 3)
            || rings.iter().map(Vec::len).sum::<usize>() > 4096
        {
            return Err("Boolean result exceeds the bounded vector dialect");
        }
        orient_web_rings_for_nonzero(&mut rings);
        let (mut min_x, mut min_y, mut max_x, mut max_y) = (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        );
        for &(x, y) in rings.iter().flatten() {
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
        if !min_x.is_finite() {
            // A real empty Boolean is a valid, undoable empty vector.
            min_x = na.transform.x;
            min_y = na.transform.y;
            max_x = min_x;
            max_y = min_y;
        }
        let mut path = Vec::new();
        for ring in &rings {
            for (i, &(x, y)) in ring.iter().enumerate() {
                if i == 0 {
                    path.push(PathCmd::MoveTo(x - min_x, y - min_y));
                } else {
                    path.push(PathCmd::LineTo(x - min_x, y - min_y));
                }
            }
            path.push(PathCmd::Close);
        }
        // The editor serial is Rust-owned and monotonic. Unlike fresh_id it
        // does not ask std::time/process for browser-unavailable host APIs.
        // A bounded collision suffix handles documents that already contain
        // the generated prefix (including a saved/reopened Boolean result).
        let new_id = (0..2049)
            .map(|suffix| format!("bool-{:x}-{suffix:x}", self.edit_serial))
            .find(|id| find(&self.root, id).is_none())
            .ok_or("cannot allocate unique Boolean result id")?;
        let mut result = Node::vector(
            &new_id,
            min_x,
            min_y,
            (max_x - min_x).max(1.0),
            (max_y - min_y).max(1.0),
            path,
        );
        result.fill = na.fill.clone();
        result.name = format!("{:?}", op);
        // The admitted web dialect hides shape labels; preserve that native
        // style on the new vector so an explicit web checkpoint stays exact.
        result.show_name = false;
        self.commit_boolean_result(&ida, &idb, result)
            .ok_or("Boolean operands are not direct page siblings")
    }

    /// One structural command group: remove the two inputs and insert the
    /// result at their previous position. This is shared by the native exact
    /// backend and the web-compatible session backend, not a second history.
    fn commit_boolean_result(&mut self, ida: &str, idb: &str, v: Node) -> Option<String> {
        let new_id = v.id.clone();
        // undoable: delete both inputs, insert result (snapshot style)
        let parent_id = self.root.id.clone();
        let idx_a = self.root.children.iter().position(|c| c.id == ida)?;
        let node_a = self.root.children[idx_a].clone();
        let idx_b0 = self.root.children.iter().position(|c| c.id == idb)?;
        let node_b = self.root.children[idx_b0].clone();
        // delete higher index first
        let (first, second) = if idx_a > idx_b0 {
            (idx_a, idx_b0)
        } else {
            (idx_b0, idx_a)
        };
        let (nfirst, nsecond) = if idx_a > idx_b0 {
            (node_a.clone(), node_b.clone())
        } else {
            (node_b.clone(), node_a.clone())
        };
        self.push_cmds(vec![
            Command::Delete {
                parent_id: parent_id.clone(),
                index: first,
                node: nfirst,
            },
            Command::Delete {
                parent_id: parent_id.clone(),
                index: second,
                node: nsecond,
            },
            Command::Insert {
                parent_id,
                index: second,
                node: v,
            },
        ]);
        self.selection = vec![new_id.clone()];
        Some(new_id)
    }

    /// Replace one child of `parent` with `node` at the same index,
    /// undoable, and select the new node.
    fn replace_child(&mut self, parent: &str, id: &str, node: Node) -> Option<String> {
        let (idx, old) = {
            let p = find(&self.root, parent)?;
            let idx = p.children.iter().position(|c| c.id == id)?;
            (idx, p.children[idx].clone())
        };
        let new_id = node.id.clone();
        self.push_cmds(vec![
            Command::Delete {
                parent_id: parent.to_string(),
                index: idx,
                node: old,
            },
            Command::Insert {
                parent_id: parent.to_string(),
                index: idx,
                node,
            },
        ]);
        self.selection = vec![new_id.clone()];
        Some(new_id)
    }

    /// Flatten Selection (): bake a shape primitive or a group of
    /// shapes into ONE editable vector path. Returns the new node id
    /// (None = nothing to flatten: already a path, or non-shape content).
    pub fn flatten_selected(&mut self) -> Option<String> {
        if self.selection.len() != 1 {
            return None;
        }
        let id = self.selection[0].clone();
        let n = find(&self.root, &id)?.clone();
        let parent = parent_id(&self.root, &id)?;
        let mut subs: Vec<Vec<PathCmd>> = vec![];
        match &n.kind {
            NodeKind::Vector { .. } => return None, // already flat
            NodeKind::Group => {
                fn collect(node: &Node, ox: f64, oy: f64, subs: &mut Vec<Vec<PathCmd>>) {
                    let (cx, cy) = (ox + node.transform.x, oy + node.transform.y);
                    if let Some(p) = node_to_path(node) {
                        subs.push(p.into_iter().map(|c| c_shift(c, cx, cy)).collect());
                    }
                    for c in &node.children {
                        collect(c, cx, cy, subs);
                    }
                }
                for c in &n.children {
                    collect(c, n.transform.x, n.transform.y, &mut subs);
                }
            }
            _ => subs.push(node_to_path(&n)?),
        }
        if subs.is_empty() {
            return None;
        }
        // bounds over every subpath's points
        let (mut minx, mut miny, mut maxx, mut maxy) = (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        );
        let mut see = |x: f64, y: f64| {
            minx = minx.min(x);
            miny = miny.min(y);
            maxx = maxx.max(x);
            maxy = maxy.max(y);
        };
        for sub in &subs {
            for c in sub {
                match *c {
                    PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => see(x, y),
                    PathCmd::CurveTo(a, b, _, _, x, y) => {
                        see(a, b);
                        see(x, y);
                    }
                    PathCmd::Close => {}
                }
            }
        }
        let cmds: Vec<PathCmd> = subs
            .into_iter()
            .flat_map(|sub| {
                sub.into_iter()
                    .map(|c| c_shift(c, -minx, -miny))
                    .collect::<Vec<_>>()
            })
            .collect();
        // a fresh id, NOT one derived from the undo depth: two flattens at the
        // same depth would otherwise mint the same id, and a duplicate id makes
        // every `find` in the engine ambiguous
        let new_id = x_core::fresh_id("flat");
        let mut v = Node::vector(
            &new_id,
            0.0,
            0.0,
            (maxx - minx).max(1.0),
            (maxy - miny).max(1.0),
            cmds,
        );
        v.transform.x = minx;
        v.transform.y = miny;
        v.name = n.name.clone();
        v.fill = n.fill.clone();
        v.stroke = n.stroke.clone();
        // flattening must not silently drop the layer's other appearance: the
        // opacity and the effect stack always travel with the baked path, and a
        // single shape's paint stacks travel too. A GROUP's stacks describe the
        // group, not its children's geometry, so they are left behind rather
        // than being applied twice.
        v.opacity = n.opacity;
        v.effects = n.effects.clone();
        v.effect_layers = n.effect_layers.clone();
        if !matches!(n.kind, NodeKind::Group) {
            v.fill_layers = n.fill_layers.clone();
            v.stroke_layers = n.stroke_layers.clone();
            v.visual_stacks_materialized = n.visual_stacks_materialized;
        }
        self.replace_child(&parent, &id, v)
    }

    /// Outline Stroke (): replace the single selected shape with its
    /// stroke's outline. Returns the new node id (None when the selection is not
    /// exactly one node, or that node refuses outlining).
    pub fn outline_stroke_selected(&mut self) -> Option<String> {
        if self.selection.len() != 1 {
            return None;
        }
        let id = self.selection[0].clone();
        self.outline_stroke_node(&id)
    }

    /// Outline Stroke for an explicit node.
    ///
    /// The core expansion is the same bounded geometry used by export: it
    /// honors the persisted dash phase, asymmetric caps, join/miter behavior,
    /// alignment, and variable-width profile. This method deliberately owns no
    /// second history: it is one `ReplaceNode` command, keeps the layer's
    /// identity/selection, and is therefore one undo/redo operation even in a
    /// nested parent.
    ///
    /// A vector can carry one filled paint stack. We therefore decline a source
    /// with more than one ordered stroke layer rather than flattening two
    /// different paints/blends into an incorrect single fill. The caller can
    /// outline layers separately after splitting that appearance stack.
    pub fn outline_stroke_node(&mut self, id: &str) -> Option<String> {
        let source = find(&self.root, id)?.clone();
        if source.visual_stacks_materialized && source.stroke_layers.len() != 1 {
            return None;
        }
        let strokes = source.active_strokes();
        let layer = match strokes.as_slice() {
            [layer] => layer,
            _ => return None,
        };
        let centerline = node_to_path(&source)?;
        let outline = outline_stroke_path(&centerline, layer.stroke.width, &layer.options).ok()?;
        let after = outline_node_from_layer(&source, layer, outline);
        self.replace_node(id, after).then(|| id.to_string())
    }

    /// Atomically replace one source layer with several sibling vectors.
    ///
    /// This is the dependency-safe command boundary for text glyph outlining:
    /// x-native supplies genuinely shaped glyph paths, while x-editor owns the
    /// parent slot, selection and one Rust undo entry. It intentionally does
    /// not know anything about fonts and never manufactures a fallback glyph.
    pub fn replace_node_with_siblings(
        &mut self,
        id: &str,
        replacements: Vec<Node>,
    ) -> Option<Vec<String>> {
        if replacements.is_empty() {
            return None;
        }
        let parent = parent_id(&self.root, id)?;
        let (index, source) = {
            let parent_node = find(&self.root, &parent)?;
            let index = parent_node
                .children
                .iter()
                .position(|child| child.id == id)?;
            (index, parent_node.children[index].clone())
        };
        if !replacement_ids_are_fresh(&self.root, id, &replacements) {
            return None;
        }
        let mut commands = Vec::with_capacity(replacements.len() + 1);
        commands.push(Command::Delete {
            parent_id: parent.clone(),
            index,
            node: source,
        });
        let selection = replacements
            .iter()
            .map(|node| node.id.clone())
            .collect::<Vec<_>>();
        for (offset, node) in replacements.into_iter().enumerate() {
            commands.push(Command::Insert {
                parent_id: parent.clone(),
                index: index + offset,
                node,
            });
        }
        let before = self.undo_depth();
        self.push_cmds(commands);
        if self.undo_depth() == before {
            return None;
        }
        self.selection = selection.clone();
        Some(selection)
    }
}

/// Reject duplicate IDs not only at replacement roots but anywhere in a
/// supplied subtree. The text converter emits childless vectors today, yet the
/// public structural helper must not let a future caller smuggle a duplicate
/// descendant into the document tree.
fn replacement_ids_are_fresh(root: &Node, source_id: &str, replacements: &[Node]) -> bool {
    fn visit(
        root: &Node,
        source_id: &str,
        node: &Node,
        ids: &mut std::collections::HashSet<String>,
    ) -> bool {
        if node.id.is_empty()
            || node.id == source_id
            || !ids.insert(node.id.clone())
            || find(root, &node.id).is_some()
        {
            return false;
        }
        node.children
            .iter()
            .all(|child| visit(root, source_id, child, ids))
    }
    let mut ids = std::collections::HashSet::new();
    replacements
        .iter()
        .all(|node| visit(root, source_id, node, &mut ids))
}

/// Turn a local materialized outline into a node without changing any world
/// pixels. `Transform::matrix` pivots around `w`/`h`, so simply adding the
/// outline's min corner to x/y breaks rotated, flipped or skewed layers. Keep
/// the old affine's linear part and solve the new translation after rebasing
/// local path coordinates to (0, 0).
fn outline_node_from_layer(
    source: &Node,
    layer: &StrokeLayer,
    outline: x_core::StrokeOutline,
) -> Node {
    let old_w = source.w;
    let old_h = source.h;
    let matrix = source.transform.matrix(old_w, old_h);
    let [a, b, c, d, e, f] = matrix.as_coeffs();
    let min_x = outline.bounds.min_x;
    let min_y = outline.bounds.min_y;
    let new_w = outline.bounds.width().max(1.0);
    let new_h = outline.bounds.height().max(1.0);
    // M_old(q + min) has this translation in the new local coordinate space.
    let target_x = a * min_x + c * min_y + e;
    let target_y = b * min_x + d * min_y + f;
    let pivot_x = source.transform.origin_x * new_w;
    let pivot_y = source.transform.origin_y * new_h;

    let mut after = source.clone();
    after.kind = NodeKind::Vector {
        path: outline
            .path
            .into_iter()
            .map(|command| c_shift(command, -min_x, -min_y))
            .collect(),
    };
    after.w = new_w;
    after.h = new_h;
    after.transform.x = target_x - pivot_x + a * pivot_x + c * pivot_y;
    after.transform.y = target_y - pivot_y + b * pivot_x + d * pivot_y;
    // The stroke paint becomes the editable fill. It keeps its layer opacity
    // and blend while the node-level opacity/effects/visibility/constraints/
    // transform/identity remain exactly on the cloned source.
    after.fill = layer.stroke.paint.clone();
    after.stroke = Stroke {
        paint: Paint::Solid(Color::TRANSPARENT),
        width: 0.0,
    };
    after.visual_stacks_materialized = true;
    after.fill_layers = vec![PaintLayer {
        paint: layer.stroke.paint.clone(),
        opacity: layer.opacity,
        visible: true,
        blend: layer.blend,
    }];
    after.stroke_layers.clear();
    // Rectangle-only shape parameters must not remain meaningful after a
    // vector rewrite. Other metadata (effects, auto-layout constraints,
    // interactions, custom name, etc.) remains on `after` by cloning.
    after.corner_radii = None;
    after.corner_smoothing = 0.0;
    after.dirty = true;
    after
}

/// Translate a PathCmd by (dx, dy). Shared with `vector_edit` (join/offset
/// move paths between node-local spaces), so it is crate-visible rather than
/// a second copy of the same match.
pub(crate) fn c_shift(c: PathCmd, dx: f64, dy: f64) -> PathCmd {
    match c {
        PathCmd::MoveTo(x, y) => PathCmd::MoveTo(x + dx, y + dy),
        PathCmd::LineTo(x, y) => PathCmd::LineTo(x + dx, y + dy),
        PathCmd::CurveTo(a, b, e, f, x, y) => {
            PathCmd::CurveTo(a + dx, b + dy, e + dx, f + dy, x + dx, y + dy)
        }
        PathCmd::Close => PathCmd::Close,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::{Color, NodeKind, PathCmd, StrokeJoin};

    #[test]
    fn session_boolean_hole_keeps_nonzero_winding_through_bevel_inset() {
        let page = x_core::Node::frame("page", 180.0, 120.0)
            .child(x_core::Node::rect(
                "outer",
                12.0,
                18.0,
                50.0,
                44.0,
                Color::BLACK,
            ))
            .child(x_core::Node::rect(
                "hole",
                27.0,
                31.0,
                20.0,
                16.0,
                Color::BLACK,
            ));
        let mut ed = Editor::new(page);
        ed.selection = vec!["outer".into(), "hole".into()];
        let id = ed.boolean_web_selected(BoolOp::Subtract).unwrap();
        let node = find(&ed.root, &id).unwrap();
        let NodeKind::Vector { path } = &node.kind else {
            panic!("Boolean did not create a vector");
        };
        let rings = path_to_polylines(path, 1);
        assert_eq!(rings.len(), 2, "raster subtraction must retain a hole");
        let areas: Vec<f64> = rings
            .iter()
            .map(|ring| {
                ring.iter()
                    .zip(ring.iter().cycle().skip(1))
                    .map(|(&(x, y), &(u, v))| x * v - u * y)
                    .sum::<f64>()
            })
            .collect();
        assert!(
            areas[0] * areas[1] < 0.0,
            "holes need opposite NONZERO winding"
        );
        let original_kind = node.kind.clone();
        let inset = ed
            .preview_filled_offset(&id, -4.0, StrokeJoin::Bevel)
            .unwrap()
            .unwrap();
        let NodeKind::Vector { path } = &inset.kind else {
            panic!("inset did not create a vector");
        };
        assert_eq!(
            path_to_polylines(path, 1).len(),
            2,
            "thin inset cannot fill the hole"
        );
        assert!(ed.offset_filled_node(&id, -4.0, StrokeJoin::Bevel).unwrap());
        assert_eq!(ed.root.children[0].kind, inset.kind);
        assert!(ed.undo(), "one Rust undo restores the hollow source");
        assert_eq!(ed.root.children[0].kind, original_kind);
    }

    #[test]
    fn flatten_group_bakes_children_into_one_vector() {
        let mut g = x_core::Node::group("g", 0.0, 0.0);
        g.transform.x = 100.0;
        g.transform.y = 50.0;
        let mut r = x_core::Node::rect("r", 0.0, 0.0, 40.0, 20.0, Color::from_rgb8(255, 0, 0));
        r.transform.x = 10.0;
        r.transform.y = 20.0;
        let mut e = x_core::Node::ellipse("e", 0.0, 0.0, 30.0, 30.0, Color::from_rgb8(0, 0, 255));
        e.transform.x = 60.0;
        e.transform.y = 10.0;
        g.children = vec![r, e];
        let page = x_core::Node::frame("page", 400.0, 300.0).child(g);
        let mut ed = crate::Editor::new(page);
        ed.selection = vec!["g".into()];
        let id = ed.flatten_selected().expect("flatten");
        assert_eq!(ed.selection, vec![id.clone()], "new node selected");
        let n = crate::find(&ed.root, &id).unwrap();
        // same parent, same slot, and a freshly minted id rather than one
        // derived from the undo depth — see the collision test below
        assert!(n.id.starts_with("flat-"), "unexpected id {}", n.id);
        assert_eq!(ed.root.children.len(), 1, "group replaced in place");
        let x_core::NodeKind::Vector { path } = &n.kind else {
            panic!("not a vector")
        };
        // rect contributed 4 LineTo + Close, ellipse 4 curves + Close
        assert_eq!(
            path.iter().filter(|c| matches!(c, PathCmd::Close)).count(),
            2
        );
        assert!(path.iter().any(|c| matches!(c, PathCmd::CurveTo(..))));
        // r sits at group(100,50)+own(10,20) = (110,70); normalized path
        // starts at 0 and the node carries the min corner
        assert_eq!(n.transform.x, 110.0);
        assert_eq!(n.transform.y, 60.0); // min(70, 50+10)
                                         // fill preserved from the group
        assert_eq!(n.fill, x_core::Node::group("x", 0.0, 0.0).fill);
    }

    /// The id used to be `format!("flat-{}", undo_depth())`. Flatten pushes one
    /// undo group, so undoing a flatten puts the depth back where it was and the
    /// next flatten minted the SAME id — and a duplicate id makes every `find`
    /// in the engine ambiguous, silently editing the wrong node. `fresh_id` is
    /// depth-independent; this is the regression witness.
    #[test]
    fn flatten_twice_at_one_undo_depth_mints_distinct_ids() {
        let mut ed = crate::Editor::new(
            x_core::Node::frame("page", 400.0, 300.0)
                .child(x_core::Node::rect("r1", 0.0, 0.0, 10.0, 10.0, Color::BLACK))
                .child(x_core::Node::rect(
                    "r2",
                    20.0,
                    0.0,
                    10.0,
                    10.0,
                    Color::BLACK,
                )),
        );
        ed.selection = vec!["r1".into()];
        let first = ed.flatten_selected().expect("first flatten");
        assert_eq!(ed.undo_depth(), 1, "one undo group");
        assert!(ed.undo(), "undo");
        assert_eq!(
            ed.undo_depth(),
            0,
            "depth is back where the collision lived"
        );
        ed.selection = vec!["r2".into()];
        let second = ed.flatten_selected().expect("second flatten");
        assert_ne!(first, second, "two flattens must never share an id");
        assert!(
            crate::find(&ed.root, &first).is_none(),
            "the undone flatten is gone from the tree"
        );
        assert!(
            crate::find(&ed.root, &second).is_some(),
            "and this one is live"
        );
    }

    #[test]
    fn flatten_vector_is_noop_and_line_flattens() {
        let page = x_core::Node::frame("page", 400.0, 300.0)
            .child(x_core::Node::line("l", 5.0, 10.0, 30.0, 40.0, Color::BLACK))
            .child(x_core::Node::vector(
                "v",
                0.0,
                0.0,
                10.0,
                10.0,
                vec![PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(10.0, 0.0)],
            ));
        let mut ed = crate::Editor::new(page);
        ed.selection = vec!["v".into()];
        assert!(ed.flatten_selected().is_none(), "already a vector: no-op");
        ed.selection = vec!["l".into()];
        let id = ed.flatten_selected().expect("line flattens");
        let n = crate::find(&ed.root, &id).unwrap();
        let x_core::NodeKind::Vector { path } = &n.kind else {
            panic!("not a vector")
        };
        assert_eq!(
            path,
            &vec![PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(30.0, 40.0)]
        );
    }

    #[test]
    fn outline_stroke_turns_line_into_thick_poly() {
        let mut l = x_core::Node::line("l", 0.0, 0.0, 20.0, 0.0, Color::BLACK);
        l.stroke.paint = x_core::Paint::Solid(x_core::Color::from_rgb8(9, 8, 7));
        l.stroke.width = 4.0;
        let page = x_core::Node::frame("page", 400.0, 300.0).child(l);
        let mut ed = crate::Editor::new(page);
        ed.selection = vec!["l".into()];
        let id = ed.outline_stroke_selected().expect("outline");
        let n = crate::find(&ed.root, &id).unwrap();
        let x_core::NodeKind::Vector { path } = &n.kind else {
            panic!("not a vector")
        };
        // filled band: 4 corners (MoveTo + 3 LineTo + Close), one
        // stroke-width tall, normalized to the min corner
        assert_eq!(path.len(), 5);
        assert_eq!(n.w, 20.0);
        assert!((n.h - 4.0).abs() < 1e-9, "band is one stroke-width tall");
        assert_eq!(
            n.fill,
            x_core::Paint::Solid(x_core::Color::from_rgb8(9, 8, 7))
        );
        assert_eq!(n.stroke.width, 0.0, "no stroke on the outline itself");
    }

    #[test]
    fn outline_stroke_closed_makes_ring_and_zero_width_noop() {
        let mut r = x_core::Node::rect("r", 0.0, 0.0, 20.0, 20.0, Color::BLACK);
        r.stroke.paint = x_core::Paint::Solid(Color::BLACK);
        r.stroke.width = 2.0;
        let page = x_core::Node::frame("page", 400.0, 300.0).child(r);
        let mut ed = crate::Editor::new(page);
        ed.selection = vec!["r".into()];
        let id = ed.outline_stroke_selected().expect("outline");
        let n = crate::find(&ed.root, &id).unwrap();
        let x_core::NodeKind::Vector { path } = &n.kind else {
            panic!("not a vector")
        };
        // rect is closed -> two subpaths (outer + reversed inner)
        assert_eq!(
            path.iter().filter(|c| matches!(c, PathCmd::Close)).count(),
            2
        );
        assert!(ed.undo(), "undo restores the rect");
        assert_eq!(ed.root.children[0].id, "r", "undo restores the rect");
        // zero-width stroke -> no-op
        ed.root.children[0].stroke.width = 0.0;
        ed.selection = vec!["r".into()];
        assert!(ed.outline_stroke_selected().is_none());
    }

    #[test]
    fn arc_flattens_and_outlines() {
        let mut a = x_core::Node::arc("a", 0.0, 0.0, 100.0, 100.0, 0.0, 270.0, 0.0, Color::BLACK);
        a.stroke.paint = x_core::Paint::Solid(Color::from_rgb8(1, 2, 3));
        a.stroke.width = 6.0;
        let page = x_core::Node::frame("page", 400.0, 300.0).child(a);
        let mut ed = crate::Editor::new(page);

        // flatten: arc -> editable vector, 3 quarter curves + the closes the
        // wedge/ring outline needs (the Flatten is what makes the box hug
        // the shape; the arc itself keeps its own box)
        ed.selection = vec!["a".into()];
        let id = ed.flatten_selected().expect("flatten arc");
        let n = crate::find(&ed.root, &id).unwrap();
        let x_core::NodeKind::Vector { path } = &n.kind else {
            panic!("not a vector")
        };
        assert_eq!(
            path.iter()
                .filter(|c| matches!(c, PathCmd::CurveTo(..)))
                .count(),
            3,
            "270-deg sweep -> 3 curve segments"
        );
        assert!(
            path.iter().filter(|c| matches!(c, PathCmd::Close)).count() == 1,
            "a wedge is one closed region"
        );

        // outline stroke on a fresh arc: filled band, stroke paint as fill
        let mut b = x_core::Node::arc("b", 0.0, 0.0, 100.0, 100.0, 0.0, 180.0, 0.0, Color::BLACK);
        b.stroke.paint = x_core::Paint::Solid(Color::from_rgb8(4, 5, 6));
        b.stroke.width = 4.0;
        let page2 = x_core::Node::frame("page", 400.0, 300.0).child(b);
        let mut ed2 = crate::Editor::new(page2);
        ed2.selection = vec!["b".into()];
        let id2 = ed2.outline_stroke_selected().expect("outline arc");
        let n2 = crate::find(&ed2.root, &id2).unwrap();
        let x_core::NodeKind::Vector { path: p2 } = &n2.kind else {
            panic!("not a vector")
        };
        // a closed path outlines as TWO bands: the outer edge forward and the
        // inner edge back (an open one would be a single quad) — now that the
        // arc's own outline is closed, that is what its stroke traces
        assert_eq!(p2.iter().filter(|c| matches!(c, PathCmd::Close)).count(), 2);
        assert_eq!(
            n2.fill,
            x_core::Paint::Solid(Color::from_rgb8(4, 5, 6)),
            "outline takes the stroke paint"
        );
    }

    #[test]
    fn booleans_2_0_default_backend_preserves_curves_end_to_end() {
        // ellipse ∪ rect through the DEFAULT backend: the result path must
        // still contain CurveTo commands (the old polygon default emitted
        // only LineTo) — this is the review's "Bezier output" requirement
        // verified at the boolean_selected level the app actually calls.
        let page = x_core::Node::frame("page", 400.0, 300.0)
            .child(x_core::Node::ellipse(
                "e",
                40.0,
                40.0,
                120.0,
                120.0,
                Color::from_rgb8(255, 0, 0),
            ))
            .child(x_core::Node::rect(
                "r",
                100.0,
                40.0,
                120.0,
                120.0,
                Color::from_rgb8(0, 0, 255),
            ));
        let mut ed = crate::Editor::new(page);
        ed.selection = vec!["e".into(), "r".into()];
        let id = ed.boolean_selected(BoolOp::Union).expect("union");
        let n = crate::find(&ed.root, &id).unwrap();
        let x_core::NodeKind::Vector { path } = &n.kind else {
            panic!("not a vector")
        };
        let curves = path
            .iter()
            .filter(|c| matches!(c, PathCmd::CurveTo(..)))
            .count();
        assert!(
            curves >= 2,
            "union of ellipse+rect keeps {curves} real curve segments"
        );
        // and a SECOND boolean on the result still preserves curves
        // (the anti-degradation property, applied through the real API)
        let idx = ed.root.children.iter().position(|c| c.id == id).unwrap();
        let mut bite = x_core::Node::rect("bite", 60.0, 90.0, 40.0, 40.0, Color::BLACK);
        bite.transform.x = 60.0;
        bite.transform.y = 90.0;
        ed.root.children.insert(idx, bite);
        ed.selection = vec![id.clone(), "bite".into()];
        let id2 = ed.boolean_selected(BoolOp::Subtract).expect("second op");
        let n2 = crate::find(&ed.root, &id2).unwrap();
        let x_core::NodeKind::Vector { path: p2 } = &n2.kind else {
            panic!()
        };
        let curves2 = p2
            .iter()
            .filter(|c| matches!(c, PathCmd::CurveTo(..)))
            .count();
        assert!(
            curves2 >= 2,
            "second-generation boolean still has {curves2} curves"
        );
    }

    #[test]
    fn editor_boolean_replaces_selection_undoably() {
        let mut e = Editor::new(
            Node::frame("page", 400.0, 300.0)
                .child(Node::rect(
                    "a",
                    10.0,
                    10.0,
                    100.0,
                    100.0,
                    Color::from_rgb8(255, 0, 0),
                ))
                .child(Node::ellipse(
                    "b",
                    60.0,
                    10.0,
                    100.0,
                    100.0,
                    Color::from_rgb8(0, 255, 0),
                )),
        );
        e.selection = vec!["a".into(), "b".into()];
        let id = e.boolean_selected(BoolOp::Union).expect("union");
        assert!(find(&e.root, "a").is_none() && find(&e.root, "b").is_none());
        let v = find(&e.root, &id).unwrap();
        assert!(matches!(&v.kind, NodeKind::Vector { path } if !path.is_empty()));
        assert!(
            matches!(&v.fill, x_core::Paint::Solid(c) if c.to_rgba8().r == 255),
            "keeps A's fill"
        );
        // one undo restores both inputs and removes the result
        e.undo();
        assert!(find(&e.root, "a").is_some() && find(&e.root, "b").is_some());
        assert!(find(&e.root, &id).is_none());
    }

    #[test]
    fn outline_stroke_keeps_world_affine_identity_and_history_for_profiled_dashes() {
        let mut source = Node::rect("ink", 30.0, 40.0, 80.0, 40.0, Color::from_rgb8(1, 2, 3));
        source.name = "Tapered ink".into();
        source.opacity = 0.65;
        source.transform.rotation = 0.43;
        source.transform.scale_x = -1.2;
        source.transform.scale_y = 0.8;
        source.transform.skew_x = 0.12;
        source.transform.origin_x = 0.25;
        source.transform.origin_y = 0.75;
        source.visual_stacks_materialized = true;
        source.stroke_layers = vec![StrokeLayer {
            stroke: Stroke::solid(Color::from_rgb8(8, 9, 10), 6.0),
            opacity: 0.7,
            visible: true,
            blend: x_core::BlendKind::Multiply,
            options: x_core::StrokeOptions {
                cap_start: x_core::StrokeCap::Round,
                cap_end: x_core::StrokeCap::Square,
                join: x_core::StrokeJoin::Round,
                dash: vec![18.0, 7.0],
                dash_offset: 3.0,
                width_profile: vec![
                    x_core::VariableWidthPoint {
                        position: 0.0,
                        width_multiplier: 0.5,
                    },
                    x_core::VariableWidthPoint {
                        position: 0.45,
                        width_multiplier: 2.0,
                    },
                    x_core::VariableWidthPoint {
                        position: 1.0,
                        width_multiplier: 0.75,
                    },
                ],
                ..Default::default()
            },
        }];
        let source_path = node_to_path(&source).unwrap();
        let expected = outline_stroke_path(
            &source_path,
            source.stroke_layers[0].stroke.width,
            &source.stroke_layers[0].options,
        )
        .unwrap();
        let old_matrix = source.transform.matrix(source.w, source.h);
        let page = Node::frame("page", 300.0, 200.0).child(source.clone());
        let mut editor = Editor::new(page);
        editor.selection = vec!["ink".into()];
        let id = editor.outline_stroke_selected().expect("profiled outline");
        assert_eq!(id, "ink", "outline preserves the selected layer identity");
        let outlined = find(&editor.root, "ink").unwrap();
        assert_eq!(outlined.name, source.name);
        assert_eq!(outlined.opacity, source.opacity);
        assert!(outlined.stroke_layers.is_empty());
        assert_eq!(outlined.fill, source.stroke_layers[0].stroke.paint);
        assert!(matches!(&outlined.kind, NodeKind::Vector { .. }));
        let new_matrix = outlined.transform.matrix(outlined.w, outlined.h);
        let NodeKind::Vector { path } = &outlined.kind else {
            unreachable!()
        };
        let expected_points = expected.path.iter().filter_map(|command| match *command {
            PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => Some((x, y)),
            PathCmd::CurveTo(..) | PathCmd::Close => None,
        });
        let actual_points = path.iter().filter_map(|command| match *command {
            PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => Some((x, y)),
            PathCmd::CurveTo(..) | PathCmd::Close => None,
        });
        for ((x, y), (qx, qy)) in expected_points.zip(actual_points) {
            let [a, b, c, d, e, f] = old_matrix.as_coeffs();
            let before = (a * x + c * y + e, b * x + d * y + f);
            let [a, b, c, d, e, f] = new_matrix.as_coeffs();
            let after = (a * qx + c * qy + e, b * qx + d * qy + f);
            assert!(
                (before.0 - after.0).abs() < 1e-8 && (before.1 - after.1).abs() < 1e-8,
                "world anchor changed: before={before:?}, after={after:?}"
            );
        }
        assert!(editor.undo(), "one undo restores the source stroke");
        assert!(matches!(
            &find(&editor.root, "ink").unwrap().kind,
            NodeKind::Rect { .. }
        ));
        assert!(editor.redo(), "one redo restores the outlined vector");
        assert!(matches!(
            &find(&editor.root, "ink").unwrap().kind,
            NodeKind::Vector { .. }
        ));
    }

    #[test]
    fn sibling_replacement_is_atomic_and_rejects_duplicate_subtrees() {
        let page = Node::frame("page", 100.0, 100.0)
            .child(Node::rect("before", 0.0, 0.0, 1.0, 1.0, Color::BLACK))
            .child(Node::text("text", 0.0, 0.0, 30.0, 20.0, "Hi"))
            .child(Node::rect("after", 0.0, 0.0, 1.0, 1.0, Color::BLACK));
        let mut editor = Editor::new(page);
        let first = Node::vector(
            "glyph-a",
            0.0,
            0.0,
            4.0,
            5.0,
            vec![
                PathCmd::MoveTo(0.0, 0.0),
                PathCmd::LineTo(4.0, 0.0),
                PathCmd::LineTo(0.0, 5.0),
                PathCmd::Close,
            ],
        );
        let second = Node::vector(
            "glyph-b",
            5.0,
            0.0,
            4.0,
            5.0,
            vec![
                PathCmd::MoveTo(0.0, 0.0),
                PathCmd::LineTo(4.0, 0.0),
                PathCmd::LineTo(0.0, 5.0),
                PathCmd::Close,
            ],
        );
        assert_eq!(
            editor.replace_node_with_siblings("text", vec![first.clone(), second.clone()]),
            Some(vec!["glyph-a".into(), "glyph-b".into()])
        );
        assert_eq!(
            editor
                .root
                .children
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec!["before", "glyph-a", "glyph-b", "after"],
            "siblings occupy the source slot in order"
        );
        assert!(editor.undo());
        assert_eq!(editor.root.children[1].id, "text");
        assert!(editor.redo());
        let duplicate = Node::vector("glyph-a", 0.0, 0.0, 1.0, 1.0, vec![]);
        assert!(editor
            .replace_node_with_siblings("glyph-a", vec![duplicate])
            .is_none());
    }
}
