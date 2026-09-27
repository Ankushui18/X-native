//! Thin serialization edge for the shared x-editor::DocumentSession.
//! Commands and undo live in Rust; only one changed node is encoded here.

use serde_json::{json, Value};
use x_editor::{DocumentSession, NodeDelta, SessionCommand, SessionDelta};
use x_format::{deserialize::load_x, serialize::save_x};

fn node_value(node: NodeDelta) -> Value {
    json!({ "id": node.id, "name": node.name, "x": node.x, "y": node.y })
}

fn delta_json(delta: SessionDelta) -> String {
    let node = delta.node.map(node_value);
    json!({
        "revision": delta.revision,
        "node": node,
        "canUndo": delta.can_undo,
        "canRedo": delta.can_redo,
    })
    .to_string()
}

/// Host-testable half of the WASM class. Native callers instead use the
/// typed DocumentSession directly (re-exported by x-native::editor).
pub struct CommandBridge {
    session: DocumentSession,
}

impl CommandBridge {
    pub fn open(x: &str) -> Result<Self, String> {
        let doc = load_x(x)?;
        Ok(Self {
            session: DocumentSession::new(doc)?,
        })
    }

    pub fn state(&self) -> String {
        delta_json(self.session.state())
    }

    pub fn get_node(&self, id: &str) -> String {
        self.session
            .node(id)
            .map(node_value)
            .unwrap_or(Value::Null)
            .to_string()
    }

    pub fn rename_node(&mut self, id: &str, name: &str) -> Result<String, String> {
        self.dispatch(SessionCommand::Rename { id, name })
    }

    pub fn move_node(&mut self, id: &str, dx: f64, dy: f64) -> Result<String, String> {
        self.dispatch(SessionCommand::Move { id, dx, dy })
    }

    pub fn undo(&mut self) -> Result<String, String> {
        self.dispatch(SessionCommand::Undo)
    }

    pub fn redo(&mut self) -> Result<String, String> {
        self.dispatch(SessionCommand::Redo)
    }

    fn dispatch(&mut self, command: SessionCommand<'_>) -> Result<String, String> {
        self.session.dispatch(command).map(delta_json)
    }

    /// Explicit export only. It is not used to acknowledge commands or paint.
    pub fn export_x(&self) -> String {
        save_x(&self.session.snapshot())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::{Color, Document, Node};

    fn fixture() -> String {
        save_x(&Document {
            pages: vec![Node::frame("page", 400.0, 300.0).child(Node::rect(
                "box",
                10.0,
                20.0,
                30.0,
                40.0,
                Color::BLACK,
            ))],
            default_font: Some("Inter".into()),
            ..Default::default()
        })
    }

    #[test]
    fn a_session_returns_small_deltas_and_explicit_persistence() {
        let mut bridge = CommandBridge::open(&fixture()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&bridge.state()).unwrap()["revision"],
            0
        );
        assert_eq!(
            serde_json::from_str::<Value>(&bridge.get_node("box")).unwrap()["x"],
            10.0
        );
        assert_eq!(bridge.get_node("missing"), "null");
        let renamed = bridge.rename_node("box", "Renamed").unwrap();
        let update: Value = serde_json::from_str(&renamed).unwrap();
        assert_eq!(update["node"]["name"], "Renamed");
        assert_eq!(update["canUndo"], true);
        assert!(
            renamed.len() < 256,
            "command returned a document, not a delta"
        );
        let moved = bridge.move_node("box", 3.0, -4.0).unwrap();
        let moved: Value = serde_json::from_str(&moved).unwrap();
        assert_eq!(moved["node"]["x"], 13.0);
        assert_eq!(moved["node"]["y"], 16.0);
        let undo: Value = serde_json::from_str(&bridge.undo().unwrap()).unwrap();
        assert_eq!(undo["node"]["x"], 10.0);
        let redo: Value = serde_json::from_str(&bridge.redo().unwrap()).unwrap();
        assert_eq!(redo["node"]["x"], 13.0);
        let saved = load_x(&bridge.export_x()).unwrap();
        assert_eq!(saved.pages[0].children[0].transform.x, 13.0);
        assert_eq!(saved.default_font.as_deref(), Some("Inter"));
    }

    #[test]
    fn errors_are_explicit_and_do_not_destroy_a_session() {
        assert!(CommandBridge::open("not an x document").is_err());
        let mut bridge = CommandBridge::open(&fixture()).unwrap();
        assert!(bridge.move_node("box", f64::NAN, 0.0).is_err());
        assert!(bridge.rename_node("missing", "X").is_err());
        assert_eq!(
            serde_json::from_str::<Value>(&bridge.state()).unwrap()["revision"],
            0
        );
        let undone: Value = serde_json::from_str(&bridge.undo().unwrap()).unwrap();
        assert_eq!(undone["node"], Value::Null);
    }
}
