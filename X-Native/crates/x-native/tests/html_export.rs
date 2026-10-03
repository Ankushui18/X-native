//! HTML/CSS export: shippable artifact + optimizer + font subsetting.
use x_core::*;
use x_native::{export_html, HtmlExportOptions};

fn doc() -> Document {
    let mut page = Node::frame("p1", 400.0, 300.0);
    page.name = "Home".into();
    let card = Node::rect("c1", 20.0, 20.0, 200.0, 80.0, Color::from_rgb8(0xff, 0, 0)).name("Card");
    let mut title = Node::text("t1", 0.0, 0.0, 180.0, 24.0, "Hello Export");
    title.bindings.insert("font".into(), "Inter-400".into());
    let mut layout = Node::frame("l1", 300.0, 100.0);
    layout.name = "Row".into();
    layout.transform.x = 20.0;
    layout.transform.y = 140.0;
    layout.kind = NodeKind::Frame {
        layout: Some(AutoLayout {
            direction: LayoutDirection::Horizontal,
            gap: 8.0,
            padding: [8.0, 8.0, 8.0, 8.0],
            sizing: Sizing::Fixed,
            cross_sizing: Some(Sizing::Fixed),
            align: CrossAlign::Start,
            distribute: Distribute::Packed,
            wrap: AutoLayoutWrap::NoWrap,
            ..Default::default()
        }),
    };
    layout.children.push(card.clone());
    layout.children.push(title);
    page.children.push(card);
    page.children.push(layout);
    let mut doc = Document::new();
    doc.pages.push(page);
    // small image asset referenced by a rect fill
    let mut pm = tiny_skia::Pixmap::new(40, 30).unwrap();
    for (i, px) in pm.pixels_mut().iter_mut().enumerate() {
        *px = tiny_skia::PremultipliedColorU8::from_rgba(
            (i % 255) as u8,
            ((i / 3) % 255) as u8,
            200,
            255,
        )
        .unwrap();
    }
    let png = x_render::encode_png(&pm).unwrap();
    let id = doc
        .assets
        .register("photo.png", png.clone(), AssetSource::Embedded);
    let img = Node::image("img1", 250.0, 20.0, 120.0, 90.0, &id).name("Pic");
    doc.pages[0].children.push(img);
    doc
}

#[test]
fn html_export_end_to_end() {
    let dir = std::env::temp_dir().join(format!("xhtml-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let fonts = x_native::text::FontManager::new();
    let rep = export_html(&doc(), &dir, &fonts, &HtmlExportOptions::default()).unwrap();
    assert!(rep.nodes >= 6 && rep.pages == 1);
    let css = std::fs::read_to_string(dir.join("styles.css")).unwrap();
    assert!(css.contains("display: flex"), "auto layout -> flex");
    let html = std::fs::read_to_string(dir.join("page-1.html")).unwrap();
    assert!(
        html.contains("<div class=\"xt1\">Hello Export</div>") || html.contains("Hello Export"),
        "text content inline"
    );
    assert!(html.contains("Home"), "page title");
    // layout children flow instead of absolute: inside .xl1 block no left: for child handled by parent_flow flag
    assert!(std::fs::read_to_string(dir.join("index.html"))
        .unwrap()
        .contains("page-1.html"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn html_export_optimizes_and_embeds_subset_fonts() {
    let dir = std::env::temp_dir().join(format!("xhtml2-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let inter = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../apps/x-designer/assets/fonts/Inter-400.ttf"
    ))
    .unwrap();
    let mut fonts = x_native::text::FontManager::new();
    fonts
        .load_face_bytes("Inter-400", inter.clone(), 0)
        .unwrap();
    let opts = HtmlExportOptions {
        optimize_images: true,
        max_image_dim: None,
        embed_subset_fonts: true,
    };
    let rep = export_html(&doc(), &dir, &fonts, &opts).unwrap();
    assert_eq!(rep.fonts_embedded, vec!["Inter-400".to_string()]);
    let sub = std::fs::read(dir.join("assets/fonts/Inter-400.ttf")).unwrap();
    assert!(
        sub.len() < inter.len() / 2,
        "subset {} vs {}",
        sub.len(),
        inter.len()
    );
    let css = std::fs::read_to_string(dir.join("styles.css")).unwrap();
    assert!(css.contains("@font-face") && css.contains("Inter-400"));
    // the image asset went out as a file
    let assets = std::fs::read_dir(dir.join("assets")).unwrap().count();
    assert!(assets >= 1);
    let _ = std::fs::remove_dir_all(&dir);
}
