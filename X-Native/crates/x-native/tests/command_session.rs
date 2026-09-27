//! A native host uses the same command session directly, without wasm-bindgen
//! or a second document/undo implementation in the UI.

use x_native::editor::{DocumentSession, SessionCommand};
use x_native::fileio::{load_x, save_x};
use x_native::{Color, Document, Node};

#[test]
fn native_host_edits_and_saves_the_same_rust_document() {
    let doc = Document {
        pages: vec![Node::frame("page", 400.0, 300.0).child(Node::rect(
            "box", 10.0, 20.0, 30.0, 40.0, Color::BLACK,
        ))],
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
    let saved = save_x(&session.into_document());
    let reopened = load_x(&saved).unwrap();
    assert_eq!(reopened.pages[0].children[0].transform.x, 10.0);
    assert_eq!(reopened.pages[0].children[0].transform.y, 20.0);
}
