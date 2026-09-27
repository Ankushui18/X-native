//! Stateful, UI-independent command session over an x-core document.
//!
//! A native host calls this directly; the web host calls the same Rust code
//! through x-wasm. Only the changed node's identity, label and position cross
//! the command boundary. A complete document is read at open and produced
//! again only at an explicit save/checkpoint, never on every interaction.

use std::collections::HashSet;

use crate::{find, Editor};
use x_core::{Document, Node};

/// The first bounded command slice. Further mutations need their own state
/// delta and equivalence tests before they can be added to the bridge.
#[derive(Debug, Clone, Copy)]
pub enum SessionCommand<'a> {
    Rename { id: &'a str, name: &'a str },
    Move { id: &'a str, dx: f64, dy: f64 },
    Undo,
    Redo,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NodeDelta {
    pub id: String,
    pub name: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionDelta {
    /// Increases only after a successful document edit, including undo/redo.
    pub revision: u64,
    /// `None` for a no-op/status read; never a whole-page snapshot.
    pub node: Option<NodeDelta>,
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
        })
    }

    pub fn state(&self) -> SessionDelta {
        SessionDelta {
            revision: self.revision,
            node: None,
            can_undo: self.editor.undo_depth() > 0,
            can_redo: self.editor.next_redo_node().is_some(),
        }
    }

    fn target(&self, id: &str) -> Result<&Node, String> {
        if id == self.page_id() {
            return Err("page root is not a layer command target".into());
        }
        find(&self.editor.root, id).ok_or_else(|| format!("node not found: {id}"))
    }

    pub fn dispatch(&mut self, command: SessionCommand<'_>) -> Result<SessionDelta, String> {
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
            SessionCommand::Undo => {
                let id = self.editor.next_undo_node().map(str::to_string);
                if id.is_some() && self.editor.undo() {
                    id
                } else {
                    None
                }
            }
            SessionCommand::Redo => {
                let id = self.editor.next_redo_node().map(str::to_string);
                if id.is_some() && self.editor.redo() {
                    id
                } else {
                    None
                }
            }
        };
        if changed.is_some() {
            self.revision += 1;
        }
        let mut delta = self.state();
        delta.node = changed.and_then(|id| self.node(&id));
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
        for command in [blank, no_move] {
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
        duplicate_page.pages.push(Node::frame("page-2", 200.0, 100.0));
        assert!(DocumentSession::new(duplicate_page).is_err());
        let mut duplicate_id = sample();
        duplicate_id.pages[0]
            .children
            .push(Node::rect("box", 0.0, 0.0, 1.0, 1.0, Color::BLACK));
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
    fn renaming_one_layer_does_not_snapshot_sibling_subtrees_into_history() {
        let mut doc = sample();
        for i in 0..300 {
            doc.pages[0].children.push(Node::rect(
                &format!("sibling-{i}"), 0.0, 0.0, 1.0, 1.0, Color::BLACK,
            ));
        }
        let mut session = DocumentSession::new(doc).unwrap();
        session
            .dispatch(SessionCommand::Rename {
                id: "box",
                name: "Small",
            })
            .unwrap();
        assert!(session.editor.history_bytes() < 10_000, "rename history captured the page");
    }
}
