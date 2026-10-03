//! AssetManager end-to-end (review item): embedded ZIP image data must
//! flow  → Import IR → content-addressed store → .x → render,
//! with NO filesystem dependency — that's document portability.

use x_native::fileio::{import_sketch, load_x, save_x};
use x_native::{
    build_render_tree, AssetSource, Assets, NodeKind, RenderCommand, Variables, VelloSink,
};

fn tiny_png(w: u32, h: u32) -> Vec<u8> {
    // real decodable 1-bit-ish PNG: header + zlib-deflated scanlines + IEND
    let mut raw = Vec::new();
    for _ in 0..h {
        let mut scanline = vec![0u8]; // filter none
        for x in 0..w {
            scanline.extend_from_slice(&[(x * 40) as u8, 0x99, 0xff, 0xff]);
        }
        raw.extend_from_slice(&scanline);
    }
    let compressed = miniz_oxide_stub_compress(&raw);
    let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let chunk = |tag: &[u8; 4], data: &[u8], png: &mut Vec<u8>| {
        png.extend_from_slice(&(data.len() as u32).to_be_bytes());
        png.extend_from_slice(tag);
        png.extend_from_slice(data);
        png.extend_from_slice(&crc32(&[tag.as_slice(), data].concat()).to_be_bytes());
    };
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    chunk(b"IHDR", &ihdr, &mut png);
    chunk(b"IDAT", &compressed, &mut png);
    chunk(b"IEND", b"", &mut png);
    png
}

/// stored zlib stream (deflate "stored" blocks) — valid, no compression
fn miniz_oxide_stub_compress(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78, 0x01]; // zlib header
    for (i, block) in data.chunks(65535).enumerate() {
        let last = if (i + 1) * 65535 >= data.len() {
            1u8
        } else {
            0u8
        };
        out.push(last);
        out.extend_from_slice(&(block.len() as u16).to_le_bytes());
        out.extend_from_slice(&(!(block.len() as u16)).to_le_bytes());
        out.extend_from_slice(block);
    }
    // adler32
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in data {
        a = (a + byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    out.extend_from_slice(&((b << 16) | a).to_be_bytes());
    out
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn zip_of(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, content) in files {
        let off = out.len() as u32;
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        out.extend_from_slice(&crc32(content).to_le_bytes());
        out.extend_from_slice(&(content.len() as u32).to_le_bytes());
        out.extend_from_slice(&(content.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(content);
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&[20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        central.extend_from_slice(&crc32(content).to_le_bytes());
        central.extend_from_slice(&(content.len() as u32).to_le_bytes());
        central.extend_from_slice(&(content.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&[0; 12]);
        central.extend_from_slice(&off.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let cd_off = out.len() as u32;
    let cd_size = central.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_off.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

fn sketch_with_embedded_bitmap() -> Vec<u8> {
    let png = tiny_png(6, 4);
    let docjson = br#"{"_class":"document","do_objectID":"doc-1","pages":[{"_class":"MSJSONFileReference","_ref":"pages/page-1"}]}"#;
    let page = r#"{"_class":"page","do_objectID":"page-1","layers":[
        {"_class":"bitmap","do_objectID":"photo","isVisible":true,
         "frame":{"x":10,"y":10,"width":120,"height":80},
         "image":{"_class":"MSJSONFileReference","_ref":"images/abcd1234.png"},
         "style":{"fills":[]}}
    ]}"#;
    zip_of(&[
        ("document.json", docjson.as_slice()),
        ("pages/page-1.json", page.as_bytes()),
        ("images/abcd1234.png", &png),
    ])
}

#[test]
fn sketch_embedded_bitmap_lands_in_the_store_with_asset_uri() {
    let doc = import_sketch(&sketch_with_embedded_bitmap()).expect("import");
    let img = &doc.pages[0].children[0];
    let NodeKind::Image { asset, .. } = &img.kind else {
        panic!("not an image: {:?}", img.kind)
    };
    assert!(
        asset.starts_with("asset://"),
        "bitmap ref rewritten to content id: {asset}"
    );
    let rec = doc
        .assets
        .get(asset)
        .expect("bytes registered in the store");
    assert_eq!(rec.mime, "image/png");
    assert_eq!(rec.dimensions, Some((6, 4)));
    assert_eq!(rec.source, AssetSource::Embedded);
    assert_eq!(rec.name, "abcd1234", "zip stem kept as display name");
}

#[test]
fn document_with_embedded_assets_is_portable_through_x() {
    // import -> save .x -> reload IN A VACUUM (no assets/ dir, no zip) ->
    // the image still resolves and renders. That's portability.
    let doc = import_sketch(&sketch_with_embedded_bitmap()).unwrap();
    let text = save_x(&doc);
    assert!(text.contains("asset://"), ".x carries the asset uri");
    assert!(text.contains("\"data\":\""), ".x embeds the bytes");
    let re = load_x(&text).expect("reload");
    assert_eq!(re.assets.len(), 1, "store restored from .x");
    let NodeKind::Image { asset, .. } = &re.pages[0].children[0].kind else {
        panic!()
    };
    let rec = re.assets.get(asset).expect("asset resolves after reload");
    assert_eq!(rec.dimensions, Some((6, 4)));
    // byte-stable round trip with assets present
    assert_eq!(
        save_x(&re),
        text,
        "save(load(save)) byte-identical with assets"
    );
    // and it actually RENDERS from memory: store -> decoded cache -> scene
    let mut cache = Assets::new();
    assert_eq!(cache.sync_store(&re.assets), 1, "decoded one embedded png");
    let tree = build_render_tree(&re.pages[0], &Variables::default());
    let has_image_cmd = tree
        .commands
        .iter()
        .any(|c| matches!(c, RenderCommand::Image { asset, .. } if asset.starts_with("asset://")));
    assert!(has_image_cmd, "render IR references the asset uri");
    let sink = VelloSink {
        assets: Some(&cache),
        fonts: None,
    };
    let _scene = sink.render(&tree); // no panic + decoded lookup path exercised
}

#[test]
fn dedup_same_image_used_twice_stored_once() {
    // two bitmap layers referencing the same bytes -> one store record
    let png = tiny_png(6, 4);
    let docjson = br#"{"_class":"document","do_objectID":"doc-1","pages":[{"_class":"MSJSONFileReference","_ref":"pages/page-1"}]}"#;
    let page = r#"{"_class":"page","do_objectID":"page-1","layers":[
        {"_class":"bitmap","do_objectID":"a","isVisible":true,"frame":{"x":0,"y":0,"width":10,"height":10},
         "image":{"_ref":"images/one.png"},"style":{"fills":[]}},
        {"_class":"bitmap","do_objectID":"b","isVisible":true,"frame":{"x":20,"y":0,"width":10,"height":10},
         "image":{"_ref":"images/two.png"},"style":{"fills":[]}}
    ]}"#;
    let zip = zip_of(&[
        ("document.json", docjson.as_slice()),
        ("pages/page-1.json", page.as_bytes()),
        ("images/one.png", &png),
        ("images/two.png", &png), // identical bytes, different names
    ]);
    let doc = import_sketch(&zip).unwrap();
    assert_eq!(doc.assets.len(), 1, "identical bytes deduped to one record");
    let ids: Vec<String> = doc.pages[0]
        .children
        .iter()
        .filter_map(|c| match &c.kind {
            NodeKind::Image { asset, .. } => Some(asset.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(ids.len(), 2);
    assert_eq!(ids[0], ids[1], "both nodes share the deduped asset id");
}
