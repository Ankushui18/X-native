fn main() {
    use x_native::fileio;
    use x_native::Library;
    use x_native::{Color, LegacyStyle, Node, NodeKind, Paint};

    let mut lib = Library {
        library_id: "brand-kit".into(),
        name: "Brand Kit".into(),
        version: 1,
        ..Default::default()
    };
    lib.styles.insert(
        "Brand/Primary".into(),
        LegacyStyle::Paint {
            fill: Paint::Solid(Color::from_rgb8(0x33, 0x66, 0xff)),
        },
    );
    lib.styles.insert(
        "Brand/Warn".into(),
        LegacyStyle::Paint {
            fill: Paint::Solid(Color::from_rgb8(0xff, 0x5a, 0x00)),
        },
    );
    let mut btn = Node::rect(
        "lib-btn",
        0.0,
        0.0,
        120.0,
        40.0,
        Color::from_rgb8(0x33, 0x66, 0xff),
    );
    btn.kind = NodeKind::Component {
        name: "LibButton".into(),
    };
    lib.components.push(btn);
    std::fs::write("library.xlib", fileio::save_xlib(&lib)).unwrap();
    println!("wrote library.xlib v{}", lib.version);
}
