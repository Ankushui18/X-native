//! PNG importer — drops a raster image into the document as an Image
//! node with its asset bytes registered, via the shared Import IR.
//!
//! Reads only the IHDR header (width/height) here — actual pixel
//! decoding stays in x-render's Assets loader (the app shell registers
//! `ImportDoc.assets` with it). This keeps x-format free of a png/image
//! dependency and keeps ONE decoder in the codebase.

use crate::import_ir::{lower, ImportDoc, ImportKind, ImportNode};
use x_core::Document;

/// PNG IHDR: bytes 16..24 are big-endian width/height (after the 8-byte
/// signature and the 8-byte IHDR chunk header).
pub(crate) fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    const SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if bytes.len() < 24 || bytes[..8] != SIG {
        return None;
    }
    if &bytes[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    if w == 0 || h == 0 || w > 32768 || h > 32768 {
        return None;
    }
    Some((w, h))
}

/// Import a PNG as a one-page document: an Image node at natural size,
/// asset registered under `name` for the caller to feed to Assets.
pub fn import_png(name: &str, bytes: &[u8]) -> Result<Document, String> {
    let (w, h) = png_dimensions(bytes).ok_or("not a valid PNG (bad signature or IHDR)")?;
    let doc = ImportDoc {
        source: "png",
        pages: vec![ImportNode::new(ImportKind::Frame)
            .id(format!("png-{name}"))
            .child(
                ImportNode::new(ImportKind::Image {
                    asset: name.to_string(),
                })
                .id(name)
                .at(40.0, 40.0)
                .size(w as f64, h as f64),
            )],
        assets: vec![(name.to_string(), bytes.to_vec())],
        diagnostics: vec![],
    };
    Ok(lower(doc))
}

/// The asset payload for the caller (same parse, kept symmetrical with
/// other importers that may carry multiple assets).
pub fn png_asset(name: &str, bytes: &[u8]) -> Option<(String, Vec<u8>)> {
    png_dimensions(bytes).map(|_| (name.to_string(), bytes.to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::NodeKind;

    fn tiny_png() -> Vec<u8> {
        // 3x2 RGBA PNG built by hand (IHDR only matters for the importer)
        let mut b = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        b.extend_from_slice(&13u32.to_be_bytes());
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&3u32.to_be_bytes());
        b.extend_from_slice(&2u32.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0]);
        b.extend_from_slice(&[0; 4]); // crc (unchecked here)
        b
    }

    #[test]
    fn imports_png_at_natural_size() {
        let doc = import_png("logo", &tiny_png()).expect("import");
        let img = &doc.pages[0].children[0];
        // the ref is the content-addressed asset:// id, NOT the filename
        match &img.kind {
            NodeKind::Image { asset, .. } => {
                assert!(asset.starts_with("asset://"), "content-addressed: {asset}");
                let rec = doc.assets.get(asset).expect("asset registered in store");
                assert_eq!(rec.mime, "image/png");
                assert_eq!(rec.name, "logo");
                assert_eq!(rec.dimensions, Some((3, 2)));
            }
            other => panic!("expected image, got {other:?}"),
        }
        assert_eq!((img.w, img.h), (3.0, 2.0));
        // page auto-sized by the SHARED lowering (not 0x0)
        assert!(doc.pages[0].w >= 800.0);
    }

    #[test]
    fn garbage_is_an_error() {
        assert!(import_png("x", b"JFIF not a png").is_err());
        assert!(import_png("x", &[]).is_err());
    }
}
