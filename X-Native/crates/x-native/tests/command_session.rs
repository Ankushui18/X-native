//! A native host uses the same command session directly, without wasm-bindgen
//! or a second document/undo implementation in the UI.

use x_native::editor::{BoolOp, DocumentSession, SessionCommand};
use x_native::fileio::{load_x, save_x};
use x_native::{Color, Document, Node};

#[test]
fn native_host_edits_and_saves_the_same_rust_document() {
    let box_node = Node::rect("box", 10.0, 20.0, 30.0, 40.0, Color::BLACK);
    let page = Node::frame("page", 400.0, 300.0).child(box_node);
    let doc = Document {
        pages: vec![page],
        ..Default::default()
    };
    let mut session = DocumentSession::new(load_x(&save_x(&doc)).unwrap()).unwrap();
    assert_eq!(session.state().revision, 0);
    let update = session
        .dispatch(SessionCommand::Move {
            id: "box",
            dx: 5.0,
            dy: -2.0,
        })
        .unwrap();
    assert_eq!(update.node.as_ref().unwrap().x, 15.0);
    assert!(session.dispatch(SessionCommand::Undo).unwrap().can_redo);
    let resized = session
        .dispatch(SessionCommand::Resize {
            id: "box",
            w: 65.0,
            h: 48.0,
        })
        .unwrap();
    let resized_node = resized.node.as_ref().unwrap();
    assert_eq!((resized_node.w, resized_node.h), (65.0, 48.0));
    let undone = session.dispatch(SessionCommand::Undo).unwrap();
    assert_eq!(undone.node.unwrap().w, 30.0);
    let redone = session.dispatch(SessionCommand::Redo).unwrap();
    assert_eq!(redone.node.unwrap().h, 48.0);
    let saved = save_x(&session.into_document());
    let reopened = load_x(&saved).unwrap();
    assert_eq!(reopened.pages[0].children[0].transform.x, 10.0);
    assert_eq!(reopened.pages[0].children[0].transform.y, 20.0);
    let node = &reopened.pages[0].children[0];
    assert_eq!((node.w, node.h), (65.0, 48.0));
}

#[test]
fn native_host_boolean_uses_the_same_atomic_session_and_edit_history() {
    let page = Node::frame("page", 400.0, 300.0)
        .child(Node::rect("a", 0.0, 0.0, 10.0, 10.0, Color::BLACK))
        .child(Node::rect("b", 5.0, 5.0, 10.0, 10.0, Color::BLACK));
    let doc = Document {
        pages: vec![page],
        ..Default::default()
    };
    let mut session = DocumentSession::new(doc).unwrap();
    let result = session.dispatch(SessionCommand::Boolean {
        first: "a", second: "b", op: BoolOp::Exclude,
    }).unwrap();
    let patch = result.boolean.unwrap();
    assert_eq!(patch.removed, ["a", "b"]);
    assert_eq!(patch.upsert[0].rings.as_ref().unwrap().len(), 2);
    assert_eq!(session.snapshot().pages[0].children.len(), 1);
    let undo = session.dispatch(SessionCommand::Undo).unwrap();
    assert_eq!(undo.boolean.unwrap().upsert.len(), 2);
    assert_eq!(session.snapshot().pages[0].children.len(), 2);
    let redo = session.dispatch(SessionCommand::Redo).unwrap();
    assert_eq!(redo.boolean.unwrap().upsert.len(), 1);
    assert_eq!(load_x(&save_x(&session.into_document())).unwrap().pages[0].children.len(), 1);
}
