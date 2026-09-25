//! AssetManager — content-addressed asset store (review item).
//!
//! Every binary asset a document uses (images now; fonts/svg later) is
//! registered here and referenced by a STABLE content-derived id
//! (`asset://<fnv1a128-of-bytes>`) instead of by filename. One record carries id, hash, mime (sniffed
//! from magic bytes, never trusted from extensions), intrinsic pixel
//! dimensions (header parse only — no decoding in x-core), the bytes,
//! and where it came from (embedded in a source file vs. external disk
//! path). Registration deduplicates by content hash, which makes
//! imports idempotent and documents portable: the .x format serializes
//! embedded assets so a file opens identically on a machine with no
//! assets/ directory at all.
//!
//! The GPU-side decode cache (x-render::Assets) is a *consumer* of this
//! store — it decodes bytes into textures keyed by the same asset id.

use crate::node::{Node, NodeKind};
use std::{collections::HashMap, sync::Arc};

// -------------------------------------------------------------- identity

/// FNV-1a 128 over raw bytes (same family as the .x uuid scheme).
pub fn hash_bytes(data: &[u8]) -> String {
    const OFFSET: u128 = 0x6c62272e07bb014262b821756295c58d;
    const PRIME: u128 = 0x0000000001000000000000000000013b;
    let mut h = OFFSET;
    for b in data {
        h ^= *b as u128;
        h = h.wrapping_mul(PRIME);
    }
    format!("{h:032x}")
}

pub const ASSET_URI_PREFIX: &str = "asset://";

/// Is this node "asset" reference an asset:// uri (vs a legacy filename)?
pub fn is_asset_uri(s: &str) -> bool {
    s.starts_with(ASSET_URI_PREFIX)
}

// ---------------------------------------------------------------- records

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetKind {
    Image,
    Font,
    Svg,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetSource {
    /// carried inside a document / import archive; serialized into .x
    Embedded,
    /// referenced from the local filesystem; NOT serialized into .x
    External,
}

#[derive(Debug, Clone)]
pub struct AssetRecord {
    /// "asset://<hash>"
    pub id: String,
    /// content hash (the id without the scheme)
    pub hash: String,
    /// sniffed mime: image/png, image/jpeg, image/svg+xml, font/ttf, …
    pub mime: String,
    pub kind: AssetKind,
    /// intrinsic pixel size for images (header parse), None otherwise
    pub dimensions: Option<(u32, u32)>,
    pub bytes: Vec<u8>,
    pub source: AssetSource,
    /// human name from the origin (filename /  ref) — display only,
    /// NEVER used for identity
    pub name: String,
}

// ---------------------------------------------------------------- sniffing

/// Magic-byte mime sniffing (extensions lie; bytes don't).
pub fn sniff_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return "image/png";
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return "image/jpeg";
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return "image/gif";
    }
    if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return "image/webp";
    }
    if bytes.starts_with(&[0x00, 0x01, 0x00, 0x00]) {
        return "font/ttf";
    }
    if bytes.starts_with(b"OTTO") {
        return "font/otf";
    }
    if bytes.starts_with(b"wOF2") {
        return "font/woff2";
    }
    let head = &bytes[..bytes.len().min(256)];
    if head.windows(4).any(|w| w == b"<svg") {
        return "image/svg+xml";
    }
    "application/octet-stream"
}

fn kind_of(mime: &str) -> AssetKind {
    if mime == "image/svg+xml" {
        return AssetKind::Svg;
    }
    if mime.starts_with("image/") {
        return AssetKind::Image;
    }
    if mime.starts_with("font/") {
        return AssetKind::Font;
    }
    AssetKind::Other
}

/// Header-only dimension probe (PNG IHDR, JPEG SOF, GIF screen desc).
pub fn probe_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    match sniff_mime(bytes) {
        "image/png" => {
            if bytes.len() < 24 || &bytes[12..16] != b"IHDR" {
                return None;
            }
            let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
            let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
            (w > 0 && h > 0).then_some((w, h))
        }
        "image/jpeg" => {
            // scan segments for SOF0/1/2 (0xC0/C1/C2)
            let mut i = 2usize;
            while i + 9 < bytes.len() {
                if bytes[i] != 0xFF {
                    return None;
                }
                let marker = bytes[i + 1];
                let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
                if (0xC0..=0xC2).contains(&marker) {
                    let h = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32;
                    let w = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]) as u32;
                    return (w > 0 && h > 0).then_some((w, h));
                }
                i += 2 + len;
            }
            None
        }
        "image/gif" => {
            if bytes.len() < 10 {
                return None;
            }
            let w = u16::from_le_bytes([bytes[6], bytes[7]]) as u32;
            let h = u16::from_le_bytes([bytes[8], bytes[9]]) as u32;
            (w > 0 && h > 0).then_some((w, h))
        }
        _ => None,
    }
}

// ------------------------------------------------------------------ store

/// The document-level asset manager. Content-addressed, deduplicating.
#[derive(Debug, Clone, Default)]
pub struct AssetStore {
    records: Arc<HashMap<String, AssetRecord>>, // id -> record
}

impl AssetStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register bytes; returns the stable `asset://<hash>` id. Same bytes
    /// -> same id, one stored copy (dedup), regardless of `name`.
    pub fn register(&mut self, name: &str, bytes: Vec<u8>, source: AssetSource) -> String {
        let hash = hash_bytes(&bytes);
        let id = format!("{ASSET_URI_PREFIX}{hash}");
        if let Some(existing) = self.records.get(&id) {
            // Receiving embedded bytes (e.g. cross-document paste) must not
            // keep an older external-only record that would vanish on save.
            if source == AssetSource::Embedded && existing.source == AssetSource::External {
                Arc::make_mut(&mut self.records)
                    .get_mut(&id)
                    .unwrap()
                    .source = AssetSource::Embedded;
            }
            return id;
        }
        Arc::make_mut(&mut self.records)
            .entry(id.clone())
            .or_insert_with(|| {
                let mime = sniff_mime(&bytes).to_string();
                AssetRecord {
                    kind: kind_of(&mime),
                    dimensions: probe_dimensions(&bytes),
                    id: id.clone(),
                    hash,
                    mime,
                    bytes,
                    source,
                    name: name.to_string(),
                }
            });
        id
    }

    pub fn get(&self, id: &str) -> Option<&AssetRecord> {
        self.records.get(id)
    }
    pub fn len(&self) -> usize {
        self.records.len()
    }
    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }
    /// deterministic iteration (sorted by id) for serialization/UI
    pub fn iter_sorted(&self) -> Vec<&AssetRecord> {
        let mut v: Vec<&AssetRecord> = self.records.values().collect();
        v.sort_by(|a, b| a.id.cmp(&b.id));
        v
    }
    /// only embedded records participate in .x serialization
    pub fn embedded_sorted(&self) -> Vec<&AssetRecord> {
        self.iter_sorted()
            .into_iter()
            .filter(|r| r.source == AssetSource::Embedded)
            .collect()
    }
    pub fn remove(&mut self, id: &str) -> Option<AssetRecord> {
        if !self.records.contains_key(id) {
            return None;
        }
        Arc::make_mut(&mut self.records).remove(id)
    }

    /// Garbage-collect: keep only assets referenced by `used_ids`.
    /// Returns the number of dropped records.
    pub fn retain_used(&mut self, used_ids: &std::collections::HashSet<String>) -> usize {
        let before = self.records.len();
        if self.records.keys().any(|id| !used_ids.contains(id)) {
            Arc::make_mut(&mut self.records).retain(|id, _| used_ids.contains(id));
        }
        before - self.records.len()
    }

    /// Rename the DISPLAY name (identity is content-derived and immutable).
    pub fn rename(&mut self, id: &str, new_name: &str) -> bool {
        if new_name.trim().is_empty() || !self.records.contains_key(id) {
            return false;
        }
        match Arc::make_mut(&mut self.records).get_mut(id) {
            Some(r) if !new_name.trim().is_empty() => {
                r.name = new_name.trim().to_string();
                true
            }
            _ => false,
        }
    }
}

/// Collect every asset:// id referenced by Image nodes in a subtree.
pub fn collect_asset_ids(n: &Node, out: &mut std::collections::HashSet<String>) {
    if let NodeKind::Image { asset, .. } = &n.kind {
        if is_asset_uri(asset) {
            out.insert(asset.clone());
        }
    }
    for c in &n.children {
        collect_asset_ids(c, out);
    }
}

/// Usage count of one asset id across a subtree.
pub fn asset_usage(n: &Node, id: &str) -> usize {
    let mut count = matches!(&n.kind, NodeKind::Image { asset, .. } if asset == id) as usize;
    for c in &n.children {
        count += asset_usage(c, id);
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny_png(w: u32, h: u32) -> Vec<u8> {
        let mut b = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        b.extend_from_slice(&13u32.to_be_bytes());
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0]);
        b.extend_from_slice(&[0; 4]);
        b
    }

    #[test]
    fn register_is_content_addressed_and_dedups() {
        let mut s = AssetStore::new();
        let a = s.register("photo.png", tiny_png(8, 4), AssetSource::Embedded);
        let b = s.register("copy-of-photo.png", tiny_png(8, 4), AssetSource::External);
        assert_eq!(a, b, "same bytes -> same id regardless of name/source");
        assert_eq!(s.len(), 1, "one stored copy");
        assert!(a.starts_with("asset://"));
        let c = s.register("other.png", tiny_png(9, 4), AssetSource::Embedded);
        assert_ne!(a, c);
        assert_eq!(s.len(), 2);
    }

    #[test]
    fn records_carry_mime_dims_hash() {
        let mut s = AssetStore::new();
        let id = s.register("x", tiny_png(64, 48), AssetSource::Embedded);
        let r = s.get(&id).unwrap();
        assert_eq!(r.mime, "image/png");
        assert_eq!(r.kind, AssetKind::Image);
        assert_eq!(r.dimensions, Some((64, 48)));
        assert_eq!(format!("asset://{}", r.hash), r.id);
        assert!(!r.bytes.is_empty());
    }

    #[test]
    fn sniffing_uses_magic_bytes_not_names() {
        assert_eq!(sniff_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), "image/jpeg");
        assert_eq!(sniff_mime(b"GIF89a\x10\x00\x10\x00"), "image/gif");
        assert_eq!(sniff_mime(b"<svg xmlns=\"x\">"), "image/svg+xml");
        assert_eq!(sniff_mime(&[0x00, 0x01, 0x00, 0x00, 0x00]), "font/ttf");
        assert_eq!(sniff_mime(b"random junk"), "application/octet-stream");
    }

    #[test]
    fn jpeg_and_gif_dimension_probes() {
        // minimal JPEG: SOI + SOF0 with 21x37
        let mut j = vec![0xFF, 0xD8];
        j.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x0B, 8]);
        j.extend_from_slice(&37u16.to_be_bytes());
        j.extend_from_slice(&21u16.to_be_bytes());
        j.extend_from_slice(&[3, 0]);
        assert_eq!(probe_dimensions(&j), Some((21, 37)));
        let mut g = b"GIF89a".to_vec();
        g.extend_from_slice(&300u16.to_le_bytes());
        g.extend_from_slice(&200u16.to_le_bytes());
        assert_eq!(probe_dimensions(&g), Some((300, 200)));
    }

    #[test]
    fn gc_retains_only_used() {
        let mut s = AssetStore::new();
        let a = s.register("a", tiny_png(1, 1), AssetSource::Embedded);
        let _b = s.register("b", tiny_png(2, 2), AssetSource::Embedded);
        let mut used = std::collections::HashSet::new();
        used.insert(a.clone());
        assert_eq!(s.retain_used(&used), 1);
        assert!(s.get(&a).is_some());
        assert_eq!(s.len(), 1);
    }
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;
    #[test]
    fn asset_snapshots_share_bytes_until_a_mutation() {
        let mut original = AssetStore::new();
        let id = original.register("image", vec![1, 2, 3, 4], AssetSource::Embedded);
        let snapshot = original.clone();
        assert!(Arc::ptr_eq(&original.records, &snapshot.records));
        let before = original.get(&id).unwrap().bytes.as_ptr();
        original.register("same bytes", vec![1, 2, 3, 4], AssetSource::Embedded);
        assert_eq!(before, original.get(&id).unwrap().bytes.as_ptr());
        assert!(Arc::ptr_eq(&original.records, &snapshot.records));
        original.rename(&id, "renamed");
        assert_eq!(snapshot.get(&id).unwrap().name, "image");
        original.remove(&id);
        assert_eq!(snapshot.get(&id).unwrap().bytes, vec![1, 2, 3, 4]);
    }
}

#[cfg(test)]
mod embedded_transfer_tests {
    use super::*;
    #[test]
    fn embedded_transfer_promotes_external_record_without_changing_its_id() {
        let mut store = AssetStore::new();
        let id = store.register("external", vec![9, 8, 7], AssetSource::External);
        let before = store.clone();
        let again = store.register("copied", vec![9, 8, 7], AssetSource::Embedded);
        assert_eq!(id, again);
        assert_eq!(store.embedded_sorted().len(), 1);
        assert!(before.embedded_sorted().is_empty());
        store.register("external again", vec![9, 8, 7], AssetSource::External);
        assert_eq!(store.embedded_sorted().len(), 1);
    }
}
