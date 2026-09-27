//! Stateful, UI-independent command session over an x-core document.
//!
//! A native host calls this directly; the web host calls the same Rust code
//! through x-wasm. Only the changed node's identity, label, position and size
//! cross the command boundary. A complete document is read at open and produced
//! again only at an explicit save/checkpoint, never on every interaction.

use std::collections::HashSet;

use crate::{find, Editor};
use x_core::booleans::BoolOp;
use x_core::{Document, Node, NodeKind, Paint, PathCmd};

/// The first bounded command slice. Further mutations need their own state
/// delta and equivalence tests before they can be added to the bridge.
#[derive(Debug, Clone, Copy)]
pub enum SessionCommand<'a> {
    Rename {
        id: &'a str,
        name: &'a str,
    },
    Move {
        id: &'a str,
        dx: f64,
        dy: f64,
    },
    /// Absolute rectangle size; validation belongs here, not in a web UI.
    Resize {
        id: &'a str,
        w: f64,
        h: f64,
    },
    /// Atomic two-layer Boolean. Only direct, plain rectangles are admitted
    /// until other shapes have their own command-session proof of parity.
    Boolean {
        first: &'a str,
        second: &'a str,
        op: BoolOp,
    },
    Undo,
    Redo,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NodeDelta {
    pub id: String,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// A bounded per-layer projection for an atomic Boolean edit. The path is a
/// list of NODE-LOCAL, already simplified contour anchors, not a page JSON.
#[derive(Debug, Clone, PartialEq)]
pub struct GeometryNodeDelta {
    pub node: NodeDelta,
    pub index: usize,
    pub fill: String,
    pub visible: bool,
    pub locked: bool,
    /// `None` = rectangle, `Some` = vector (possibly empty).
    pub rings: Option<Vec<Vec<(f64, f64)>>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BooleanDelta {
    pub upsert: Vec<GeometryNodeDelta>,
    pub removed: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionDelta {
    /// Increases only after a successful document edit, including undo/redo.
    pub revision: u64,
    /// `None` for a no-op/status read; never a whole-page snapshot.
    pub node: Option<NodeDelta>,
    /// Only structural Boolean edits/undo/redo return this bounded change set.
    pub boolean: Option<BooleanDelta>,
    pub can_undo: bool,
    pub can_redo: bool,
}

/// One-page session for now: declining other shapes is safer than silently
/// dropping pages or pretending that per-page Editor stacks are one history.
/// The page root lives ONLY in Editor; the rest of the document's metadata
/// remains in `document` until an explicit snapshot/export.
pub struct DocumentSession {
    document: Document,
    editor: Editor,
    revision: u64,
}

impl DocumentSession {
    pub fn new(mut document: Document) -> Result<Self, String> {
        if document.pages.len() != 1 {
            return Err("command session requires exactly one page".into());
        }
        let page = document.pages.pop().expect("one page was checked above");
        {
            let mut ids = HashSet::new();
            let mut stack = vec![&page];
            while let Some(node) = stack.pop() {
                if node.id.is_empty() || !ids.insert(node.id.as_str()) {
                    return Err(format!("empty or duplicate node id: {}", node.id));
                }
                stack.extend(node.children.iter());
            }
        }
        Ok(Self {
            document,
            editor: Editor::new(page),
            revision: 0,
        })
    }

    pub fn page_id(&self) -> &str {
        &self.editor.root.id
    }

    /// A single node query is explicit; it does not copy the page to JS.
    pub fn node(&self, id: &str) -> Option<NodeDelta> {
        let node = find(&self.editor.root, id)?;
        Some(NodeDelta {
            id: node.id.clone(),
            name: node.name.clone(),
            x: node.transform.x,
            y: node.transform.y,
            w: node.w,
            h: node.h,
        })
    }

    pub fn state(&self) -> SessionDelta {
        SessionDelta {
            revision: self.revision,
            node: None,
            boolean: None,
            can_undo: self.editor.undo_depth() > 0,
            can_redo: self.editor.next_redo_node().is_some()
                || self.editor.next_redo_boolean().is_some(),
        }
    }

    fn target(&self, id: &str) -> Result<&Node, String> {
        if id == self.page_id() {
            return Err("page root is not a layer command target".into());
        }
        find(&self.editor.root, id).ok_or_else(|| format!("node not found: {id}"))
    }

    fn boolean_operand(&self, id: &str) -> Result<(), String> {
        let node = self.target(id)?;
        if !self.editor.root.children.iter().any(|child| child.id == id)
            || !matches!(&node.kind, NodeKind::Rect { radius } if *radius == 0.0)
            || !node.children.is_empty()
            || id.len() > 256
            || node.name.len() > 1024
            || !node.visible
            || node.locked
            || node.opacity != 1.0
            || node.stroke.width != 0.0
            || !node.fill_layers.is_empty()
            || !node.stroke_layers.is_empty()
            || !node.effects.is_empty()
            || !node.effect_layers.is_empty()
            || node.corner_radii.is_some()
            || node.corner_smoothing != 0.0
            || node.transform.rotation != 0.0
            || node.transform.scale_x != 1.0
            || node.transform.scale_y != 1.0
            || node.transform.skew_x != 0.0
            || node.transform.skew_y != 0.0
            || ![node.transform.x, node.transform.y, node.w, node.h]
                .iter()
                .all(|v| v.is_finite() && v.abs() <= 1e9)
            || node.w <= 0.0
            || node.h <= 0.0
            || !matches!(&node.fill, Paint::Solid(color) if color.to_rgba8().a == 255)
        {
            return Err(
                "Boolean session admits only plain visible, unlocked solid rectangles".into(),
            );
        }
        Ok(())
    }

    fn geometry_node(&self, id: &str) -> Result<GeometryNodeDelta, String> {
        let node = self.target(id)?;
        let index = self
            .editor
            .root
            .children
            .iter()
            .position(|n| n.id == id)
            .ok_or("Boolean delta target is not a page child")?;
        let Paint::Solid(color) = &node.fill else {
            return Err("Boolean delta requires a solid fill".into());
        };
        let rgba = color.to_rgba8();
        let rings = match &node.kind {
            NodeKind::Rect { radius } if *radius == 0.0 => None,
            NodeKind::Vector { path } => {
                let mut rings = Vec::new();
                let mut ring = Vec::new();
                for cmd in path {
                    match *cmd {
                        PathCmd::MoveTo(x, y) => {
                            if !ring.is_empty() {
                                return Err("unclosed Boolean path".into());
                            }
                            ring.push((x, y));
                        }
                        PathCmd::LineTo(x, y) => ring.push((x, y)),
                        PathCmd::Close => {
                            if ring.len() < 3 {
                                return Err("degenerate Boolean contour".into());
                            }
                            rings.push(std::mem::take(&mut ring));
                        }
                        PathCmd::CurveTo(..) => return Err("unexpected Boolean curve".into()),
                    }
                }
                if !ring.is_empty() {
                    return Err("unclosed Boolean path".into());
                }
                Some(rings)
            }
            _ => return Err("unsupported Boolean delta layer".into()),
        };
        Ok(GeometryNodeDelta {
            node: self.node(id).ok_or("Boolean node missing")?,
            index,
            fill: format!("#{:02x}{:02x}{:02x}", rgba.r, rgba.g, rgba.b),
            visible: node.visible,
            locked: node.locked,
            rings,
        })
    }

    pub fn dispatch(&mut self, command: SessionCommand<'_>) -> Result<SessionDelta, String> {
        // One structural edit can change three node identities. The editor's
        // command stack remains the only history; this is just a delta hint.
        let mut boolean: Option<([String; 2], String, bool)> = None;
        let changed = match command {
            SessionCommand::Rename { id, name } => {
                self.target(id)?;
                self.editor.rename_node(id, name).then(|| id.to_string())
            }
            SessionCommand::Move { id, dx, dy } => {
                if !dx.is_finite() || !dy.is_finite() {
                    return Err("move delta must be finite".into());
                }
                let node = self.target(id)?;
                let next_x = node.transform.x + dx;
                let next_y = node.transform.y + dy;
                if !next_x.is_finite() || !next_y.is_finite() {
                    return Err("move would overflow the node position".into());
                }
                if next_x == node.transform.x && next_y == node.transform.y {
                    None
                } else {
                    let before = self.editor.undo_depth();
                    self.editor.move_node(id, dx, dy);
                    (self.editor.undo_depth() > before).then(|| id.to_string())
                }
            }
            SessionCommand::Resize { id, w, h } => {
                // Editor::resize clamps dimensions below one; refuse instead of
                // silently reporting a different size. This is the SAME Rust
                // undo command used by native, not a web-side resize history.
                if !w.is_finite() || !h.is_finite() || w < 1.0 || h < 1.0 {
                    return Err("resize dimensions must be finite and at least one".into());
                }
                let node = self.target(id)?;
                if matches!(&node.kind, NodeKind::Vector { .. }) {
                    return Err("resizing Boolean vectors needs a proved contour transform".into());
                }
                if node.w == w && node.h == h {
                    None
                } else {
                    let before = self.editor.undo_depth();
                    self.editor.resize(id, w, h);
                    (self.editor.undo_depth() > before).then(|| id.to_string())
                }
            }
            SessionCommand::Boolean { first, second, op } => {
                if first == second {
                    return Err("Boolean operands must be distinct".into());
                }
                self.boolean_operand(first)?;
                self.boolean_operand(second)?;
                let previous = std::mem::replace(
                    &mut self.editor.selection,
                    vec![first.to_string(), second.to_string()],
                );
                let result = self.editor.boolean_web_selected(op);
                if result.is_err() {
                    self.editor.selection = previous;
                }
                let result = result.map_err(str::to_string)?;
                boolean = Some(([first.to_string(), second.to_string()], result, true));
                None
            }
            SessionCommand::Undo => {
                let id = self.editor.next_undo_node().map(str::to_string);
                let structural = self.editor.next_undo_boolean();
                if self.editor.undo() {
                    boolean = structural.map(|(ids, result)| (ids, result, false));
                    id
                } else {
                    None
                }
            }
            SessionCommand::Redo => {
                let id = self.editor.next_redo_node().map(str::to_string);
                let structural = self.editor.next_redo_boolean();
                if self.editor.redo() {
                    boolean = structural.map(|(ids, result)| (ids, result, true));
                    id
                } else {
                    None
                }
            }
        };
        if let Some((sources, result, applied)) = &boolean {
            self.editor.selection = if *applied {
                vec![result.clone()]
            } else {
                sources.to_vec()
            };
        }
        if changed.is_some() || boolean.is_some() {
            self.revision += 1;
        }
        let mut delta = self.state();
        delta.node = changed.and_then(|id| self.node(&id));
        if let Some((sources, result, applied)) = boolean {
            delta.boolean = Some(if applied {
                BooleanDelta {
                    upsert: vec![self.geometry_node(&result)?],
                    removed: sources.into_iter().collect(),
                }
            } else {
                BooleanDelta {
                    upsert: sources
                        .iter()
                        .map(|id| self.geometry_node(id))
                        .collect::<Result<_, _>>()?,
                    removed: vec![result],
                }
            });
        }
        Ok(delta)
    }

    /// Explicit, potentially large save/checkpoint path. Never call this from
    /// a paint loop or to acknowledge a command.
    pub fn snapshot(&self) -> Document {
        let mut document = self.document.clone();
        document.pages.push(self.editor.root.clone());
        document
    }

    /// Native hosts can also take ownership at close without cloning the tree.
    pub fn into_document(self) -> Document {
        let Self {
            mut document,
            editor,
            ..
        } = self;
        document.pages.push(editor.root);
        document
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::{Color, Node};

    fn sample() -> Document {
        Document {
            default_font: Some("Sample font".into()),
            pages: vec![Node::frame("page", 400.0, 300.0).child(Node::rect(
                "box",
                10.0,
                20.0,
                30.0,
                40.0,
                Color::BLACK,
            ))],
            ..Default::default()
        }
    }

    #[test]
    fn rename_move_and_undo_redo_return_only_changed_node() {
        let mut session = DocumentSession::new(sample()).unwrap();
        assert_eq!(session.page_id(), "page");
        assert_eq!(session.state().revision, 0);
        let before = session.node("box").unwrap();
        assert_eq!((before.x, before.y), (10.0, 20.0));

        let renamed = session
            .dispatch(SessionCommand::Rename {
                id: "box",
                name: "  New name  ",
            })
            .unwrap();
        assert_eq!(renamed.revision, 1);
        assert_eq!(renamed.node.as_ref().unwrap().name, "New name");
        assert!(renamed.can_undo);
        assert!(!renamed.can_redo);
        let moved = session
            .dispatch(SessionCommand::Move {
                id: "box",
                dx: -3.0,
                dy: 4.0,
            })
            .unwrap();
        assert_eq!(moved.revision, 2);
        let moved_node = moved.node.unwrap();
        assert_eq!((moved_node.x, moved_node.y), (7.0, 24.0));

        let undone = session.dispatch(SessionCommand::Undo).unwrap();
        assert_eq!(undone.revision, 3);
        assert!(undone.can_redo);
        let undone_node = undone.node.unwrap();
        assert_eq!((undone_node.x, undone_node.y), (10.0, 20.0));
        let undone = session.dispatch(SessionCommand::Undo).unwrap();
        assert_eq!(undone.node.unwrap().name, before.name);
        let redone = session.dispatch(SessionCommand::Redo).unwrap();
        assert_eq!(redone.node.unwrap().name, "New name");
        assert_eq!(redone.revision, 5);
        assert_eq!(session.node("box").unwrap().id, "box");
        let doc = session.into_document();
        assert_eq!(doc.default_font.as_deref(), Some("Sample font"));
        assert_eq!(doc.pages[0].children[0].name, "New name");
        assert_eq!(doc.pages[0].children[0].transform.x, 10.0);
    }

    #[test]
    fn resize_is_shared_rust_history_with_one_node_delta() {
        let mut session = DocumentSession::new(sample()).unwrap();
        let original = session.node("box").unwrap();
        assert_eq!((original.w, original.h), (30.0, 40.0));
        let resized = session
            .dispatch(SessionCommand::Resize {
                id: "box",
                w: 75.25,
                h: 42.5,
            })
            .unwrap();
        assert_eq!(resized.revision, 1);
        assert!(resized.can_undo);
        let node = resized.node.unwrap();
        assert_eq!((node.id.as_str(), node.w, node.h), ("box", 75.25, 42.5));
        let undone = session.dispatch(SessionCommand::Undo).unwrap();
        let undone_node = undone.node.as_ref().unwrap();
        assert_eq!((undone_node.w, undone_node.h), (30.0, 40.0));
        assert_eq!(undone.revision, 2);
        assert!(undone.can_redo);
        let redone = session.dispatch(SessionCommand::Redo).unwrap();
        let redone_node = redone.node.as_ref().unwrap();
        assert_eq!((redone_node.w, redone_node.h), (75.25, 42.5));
        assert_eq!(redone.revision, 3);
        assert!(redone.can_undo);
        assert_eq!(session.snapshot().pages[0].children[0].w, 75.25);
    }

    #[test]
    fn web_booleans_are_atomic_rust_commands_with_only_changed_layer_deltas() {
        for (op, loop_sizes) in [
            (BoolOp::Union, vec![11]),
            (BoolOp::Subtract, vec![8]),
            (BoolOp::Intersect, vec![5]),
            (BoolOp::Exclude, vec![8, 8]),
        ] {
            let document = Document {
                pages: vec![Node::frame("page", 400.0, 300.0)
                    .child(Node::rect("a", 0.0, 0.0, 10.0, 10.0, Color::BLACK))
                    .child(Node::rect("middle", 40.0, 40.0, 10.0, 10.0, Color::BLACK))
                    .child(Node::rect("b", 5.0, 5.0, 10.0, 10.0, Color::BLACK))],
                ..Default::default()
            };
            let mut session = DocumentSession::new(document).unwrap();
            let changed = session
                .dispatch(SessionCommand::Boolean {
                    first: "a",
                    second: "b",
                    op,
                })
                .unwrap();
            assert_eq!(changed.revision, 1);
            assert!(changed.node.is_none());
            assert!(changed.can_undo);
            let patch = changed.boolean.unwrap();
            assert_eq!(patch.removed, vec!["a", "b"]);
            assert_eq!(patch.upsert.len(), 1);
            let result = &patch.upsert[0];
            assert_eq!(result.index, 0);
            assert_eq!(result.fill, "#000000");
            assert_eq!(
                result
                    .rings
                    .as_ref()
                    .unwrap()
                    .iter()
                    .map(Vec::len)
                    .collect::<Vec<_>>(),
                loop_sizes
            );
            let result_id = result.node.id.clone();
            let saved = session.snapshot();
            assert_eq!(saved.pages[0].children.len(), 2);
            assert_eq!(saved.pages[0].children[0].id, result_id);
            assert_eq!(saved.pages[0].children[1].id, "middle");
            assert_eq!(session.editor.undo_depth(), 1);

            let undo = session.dispatch(SessionCommand::Undo).unwrap();
            assert!(undo.can_redo);
            let undo_patch = undo.boolean.unwrap();
            assert_eq!(undo_patch.removed, vec![result_id.as_str()]);
            assert_eq!(
                undo_patch
                    .upsert
                    .iter()
                    .map(|n| n.index)
                    .collect::<Vec<_>>(),
                [0, 2]
            );
            assert!(undo_patch.upsert.iter().all(|n| n.rings.is_none()));
            assert_eq!(
                session.snapshot().pages[0]
                    .children
                    .iter()
                    .map(|n| n.id.as_str())
                    .collect::<Vec<_>>(),
                ["a", "middle", "b"]
            );
            let redo = session.dispatch(SessionCommand::Redo).unwrap();
            assert_eq!(redo.boolean.unwrap().upsert[0].node.id, result_id);
            assert_eq!(session.state().revision, 3);
        }
    }

    #[test]
    fn empty_intersection_still_commits_an_undoable_empty_vector() {
        let doc = Document {
            pages: vec![Node::frame("page", 600.0, 300.0)
                .child(Node::rect("a", 0.0, 0.0, 10.0, 10.0, Color::BLACK))
                .child(Node::rect("b", 500.0, 0.0, 10.0, 10.0, Color::BLACK))],
            ..Default::default()
        };
        let mut session = DocumentSession::new(doc).unwrap();
        let result = session
            .dispatch(SessionCommand::Boolean {
                first: "a",
                second: "b",
                op: BoolOp::Intersect,
            })
            .unwrap();
        assert!(result.boolean.unwrap().upsert[0]
            .rings
            .as_ref()
            .unwrap()
            .is_empty());
        assert_eq!(session.snapshot().pages[0].children.len(), 1);
        assert_eq!(
            session
                .dispatch(SessionCommand::Undo)
                .unwrap()
                .boolean
                .unwrap()
                .upsert
                .len(),
            2
        );
        assert_eq!(session.snapshot().pages[0].children.len(), 2);
    }

    #[test]
    fn refused_boolean_keeps_both_nodes_and_history_unchanged() {
        let mut doc = sample();
        doc.pages[0]
            .children
            .push(Node::rect("b", 12.0, 20.0, 20.0, 20.0, Color::BLACK));
        let mut session = DocumentSession::new(doc).unwrap();
        for (a, b) in [("box", "box"), ("box", "missing"), ("page", "b")] {
            assert!(session
                .dispatch(SessionCommand::Boolean {
                    first: a,
                    second: b,
                    op: BoolOp::Union,
                })
                .is_err());
        }
        session.editor.root.children[1].locked = true;
        assert!(session
            .dispatch(SessionCommand::Boolean {
                first: "box",
                second: "b",
                op: BoolOp::Union,
            })
            .is_err());
        assert_eq!(session.state().revision, 0);
        assert!(!session.state().can_undo);
        assert_eq!(session.snapshot().pages[0].children.len(), 2);
    }

    #[test]
    fn refusals_and_no_ops_leave_history_and_revision_unchanged() {
        let mut session = DocumentSession::new(sample()).unwrap();
        let first = SessionCommand::Rename {
            id: "box",
            name: "First",
        };
        session.dispatch(first).unwrap();
        session.dispatch(SessionCommand::Undo).unwrap();
        let state = session.state();
        let blank = SessionCommand::Rename {
            id: "box",
            name: "   ",
        };
        let no_move = SessionCommand::Move {
            id: "box",
            dx: 0.0,
            dy: 0.0,
        };
        let no_resize = SessionCommand::Resize {
            id: "box",
            w: 30.0,
            h: 40.0,
        };
        for command in [blank, no_move, no_resize] {
            assert_eq!(session.dispatch(command).unwrap(), state);
        }
        assert!(session.state().can_redo, "no-op must preserve redo");
        let nan = SessionCommand::Move {
            id: "box",
            dx: f64::NAN,
            dy: 1.0,
        };
        let infinity = SessionCommand::Move {
            id: "box",
            dx: f64::INFINITY,
            dy: 1.0,
        };
        assert!(session.dispatch(nan).is_err());
        assert!(session.dispatch(infinity).is_err());
        let unknown = SessionCommand::Rename {
            id: "missing",
            name: "X",
        };
        let root = SessionCommand::Rename {
            id: "page",
            name: "X",
        };
        assert!(session.dispatch(unknown).is_err());
        assert!(session.dispatch(root).is_err());
        for (id, w, h) in [
            ("box", f64::NAN, 20.0),
            ("box", 30.0, f64::INFINITY),
            ("box", 0.0, 40.0),
            ("box", 20.0, -1.0),
            ("page", 20.0, 40.0),
            ("missing", 20.0, 40.0),
        ] {
            assert!(session
                .dispatch(SessionCommand::Resize { id, w, h })
                .is_err());
        }
        assert_eq!(session.state(), state);
        let redone = session.dispatch(SessionCommand::Redo).unwrap();
        assert_eq!(redone.node.unwrap().name, "First");
        assert_eq!(session.dispatch(SessionCommand::Redo).unwrap().node, None);

        let mut overflow_doc = sample();
        overflow_doc.pages[0].children[0].transform.x = f64::MAX;
        let mut overflow = DocumentSession::new(overflow_doc).unwrap();
        let move_overflow = SessionCommand::Move {
            id: "box",
            dx: f64::MAX,
            dy: 0.0,
        };
        assert!(overflow.dispatch(move_overflow).is_err());
        assert_eq!(overflow.state().revision, 0);
    }

    #[test]
    fn single_page_unique_id_contract_and_explicit_snapshot() {
        assert!(DocumentSession::new(Document::default()).is_err());
        let mut duplicate_page = sample();
        let extra_page = Node::frame("page-2", 200.0, 100.0);
        duplicate_page.pages.push(extra_page);
        assert!(DocumentSession::new(duplicate_page).is_err());
        let mut duplicate_id = sample();
        let duplicate = Node::rect("box", 0.0, 0.0, 1.0, 1.0, Color::BLACK);
        duplicate_id.pages[0].children.push(duplicate);
        assert!(DocumentSession::new(duplicate_id).is_err());

        let mut session = DocumentSession::new(sample()).unwrap();
        session
            .dispatch(SessionCommand::Move {
                id: "box",
                dx: 3.0,
                dy: 4.0,
            })
            .unwrap();
        let saved = x_format::serialize::save_x(&session.snapshot());
        let reopened = x_format::deserialize::load_x(&saved).unwrap();
        assert_eq!(reopened.pages[0].children[0].transform.x, 13.0);
        assert_eq!(reopened.default_font.as_deref(), Some("Sample font"));
    }

    #[test]
    fn small_layer_edits_do_not_snapshot_sibling_subtrees_into_history() {
        let mut doc = sample();
        for i in 0..300 {
            let id = format!("sibling-{i}");
            let child = Node::rect(&id, 0.0, 0.0, 1.0, 1.0, Color::BLACK);
            doc.pages[0].children.push(child);
        }
        let mut session = DocumentSession::new(doc).unwrap();
        session
            .dispatch(SessionCommand::Rename {
                id: "box",
                name: "Small",
            })
            .unwrap();
        session
            .dispatch(SessionCommand::Resize {
                id: "box",
                w: 2.0,
                h: 3.0,
            })
            .unwrap();
        let bytes = session.editor.history_bytes();
        assert!(
            bytes < 10_000,
            "rename/resize history captured the page: {bytes}"
        );
    }
}
