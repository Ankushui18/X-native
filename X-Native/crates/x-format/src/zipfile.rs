//! Minimal ZIP reader for external-format importers (.).
//!
//! Reads the end-of-central-directory record, walks the central directory,
//! and extracts entries. Supports method 0 (stored) and method 8 (deflate,
//! via miniz_oxide — already in the workspace tree through `png`). That
//! covers every . file in practice:  writes deflate entries.
//!
//! Not supported (returns Err, never panics): zip64, encryption, data
//! descriptors without sizes in the central directory, multi-disk.

use std::collections::HashMap;

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &byte in bytes {
        crc ^= byte as u32;
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320u32 & (0u32.wrapping_sub(crc & 1)));
        }
    }
    !crc
}

/// Deterministic, standards-compliant stored-entry ZIP writer used by the
///  exporter. Checksums are written in both headers so packages also
/// open in strict ZIP readers, not only in our tolerant importer.
pub(crate) fn write_stored(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, content) in files {
        let local_offset = out.len() as u32;
        let crc = crc32(content);
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(content.len() as u32).to_le_bytes());
        out.extend_from_slice(&(content.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(content);
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&[0; 4]);
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&(content.len() as u32).to_le_bytes());
        central.extend_from_slice(&(content.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&local_offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let cd_offset = out.len() as u32;
    let cd_size = central.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

pub(crate) struct ZipArchive<'a> {
    bytes: &'a [u8],
    /// name -> (method, compressed_size, uncompressed_size, local_header_offset)
    entries: HashMap<String, (u16, u32, u32, u32, u32)>,
}

fn rd_u16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(at)?, *b.get(at + 1)?]))
}
fn rd_u32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *b.get(at)?,
        *b.get(at + 1)?,
        *b.get(at + 2)?,
        *b.get(at + 3)?,
    ]))
}

impl<'a> ZipArchive<'a> {
    pub(crate) fn open(bytes: &'a [u8]) -> Result<Self, String> {
        // find EOCD (0x06054b50) scanning backwards — comment can pad the tail
        const EOCD: u32 = 0x0605_4b50;
        if bytes.len() < 22 {
            return Err("zip too small".into());
        }
        let mut eocd_at = None;
        let lo = bytes.len().saturating_sub(22 + 65_535);
        for i in (lo..=bytes.len() - 22).rev() {
            if rd_u32(bytes, i) == Some(EOCD) {
                eocd_at = Some(i);
                break;
            }
        }
        let eocd = eocd_at.ok_or("no zip end-of-central-directory")?;
        let count = rd_u16(bytes, eocd + 10).ok_or("bad eocd")? as usize;
        let cd_offset = rd_u32(bytes, eocd + 16).ok_or("bad eocd")? as usize;
        if rd_u16(bytes, eocd + 4) != Some(0)
            || rd_u16(bytes, eocd + 6) != Some(0)
            || rd_u16(bytes, eocd + 8) != Some(count as u16)
        {
            return Err("multi-disk ZIP is unsupported".into());
        }

        if bytes.len() > crate::admission::MAX_INPUT_BYTES || count > 10_000 {
            return Err("ZIP exceeds input/entry budget".into());
        }
        let mut total_size = 0u64;
        let mut entries = HashMap::new();
        let mut at = cd_offset;
        for _ in 0..count {
            crate::cancellation::checkpoint()?;
            if rd_u32(bytes, at) != Some(0x0201_4b50) {
                return Err("bad central directory entry".into());
            }
            let method = rd_u16(bytes, at + 10).ok_or("bad cd")?;
            let flags = rd_u16(bytes, at + 8).ok_or("bad cd")?;
            if flags & 1 != 0 {
                return Err("encrypted ZIP is unsupported".into());
            }
            let crc = rd_u32(bytes, at + 16).ok_or("bad cd")?;
            let csize = rd_u32(bytes, at + 20).ok_or("bad cd")?;
            let usize_ = rd_u32(bytes, at + 24).ok_or("bad cd")?;
            total_size += usize_ as u64;
            if usize_ > 32 * 1024 * 1024 || total_size > 128 * 1024 * 1024 {
                return Err("ZIP exceeds 32 MiB per-entry / 128 MiB expanded budget".into());
            }
            let name_len = rd_u16(bytes, at + 28).ok_or("bad cd")? as usize;
            let extra_len = rd_u16(bytes, at + 30).ok_or("bad cd")? as usize;
            let comment_len = rd_u16(bytes, at + 32).ok_or("bad cd")? as usize;
            let local_offset = rd_u32(bytes, at + 42).ok_or("bad cd")?;
            let name = std::str::from_utf8(
                bytes
                    .get(at + 46..at + 46 + name_len)
                    .ok_or("bad cd name")?,
            )
            .map_err(|_| "non-utf8 zip entry name")?
            .to_string();
            if entries
                .insert(name, (method, csize, usize_, local_offset, crc))
                .is_some()
            {
                return Err("duplicate ZIP entry name".into());
            }
            at += 46 + name_len + extra_len + comment_len;
        }
        Ok(Self { bytes, entries })
    }

    /// Read + decompress one entry by exact name.
    pub(crate) fn read(&self, name: &str) -> Result<Vec<u8>, String> {
        crate::cancellation::checkpoint()?;
        let (method, csize, usize_, local_offset, crc) = *self
            .entries
            .get(name)
            .ok_or_else(|| format!("zip entry not found: {name}"))?;
        let lo = local_offset as usize;
        if rd_u32(self.bytes, lo) != Some(0x0403_4b50) {
            return Err("bad local header".into());
        }
        let name_len = rd_u16(self.bytes, lo + 26).ok_or("bad local")? as usize;
        let extra_len = rd_u16(self.bytes, lo + 28).ok_or("bad local")? as usize;
        if rd_u16(self.bytes, lo + 8) != Some(method)
            || self.bytes.get(lo + 30..lo + 30 + name_len) != Some(name.as_bytes())
        {
            return Err("ZIP local/central header mismatch".into());
        }
        let data_at = lo + 30 + name_len + extra_len;
        let data = self
            .bytes
            .get(data_at..data_at + csize as usize)
            .ok_or("entry data out of range")?;
        let output = match method {
            0 => Ok(data.to_vec()),
            8 => miniz_oxide::inflate::decompress_to_vec_with_limit(data, usize_ as usize)
                .map_err(|e| format!("deflate error in {name}: {e:?}")),
            m => Err(format!("unsupported zip method {m} for {name}")),
        }?;
        crate::cancellation::checkpoint()?;
        if output.len() != usize_ as usize {
            return Err("ZIP entry size mismatch".into());
        }
        if crc32(&output) != crc {
            return Err("ZIP CRC mismatch".into());
        }
        Ok(output)
    }

    /// Read every entry whose name matches the predicate (sorted by name
    /// for deterministic iteration).
    pub(crate) fn read_matching(
        &self,
        pred: impl Fn(&str) -> bool,
    ) -> Result<std::collections::BTreeMap<String, Vec<u8>>, String> {
        let mut out = std::collections::BTreeMap::new();
        for name in self.entries.keys() {
            if pred(name) {
                out.insert(name.clone(), self.read(name)?);
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// stored-entry zip builder (tests only)
    fn zip_of(files: &[(&str, &[u8])]) -> Vec<u8> {
        crate::zipfile::write_stored(
            &files
                .iter()
                .map(|(n, b)| (n.to_string(), b.to_vec()))
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn stored_roundtrip() {
        let z = zip_of(&[("a.json", b"{\"k\":1}"), ("dir/b.txt", b"hello")]);
        let a = ZipArchive::open(&z).unwrap();
        assert_eq!(a.read("a.json").unwrap(), b"{\"k\":1}");
        assert_eq!(a.read("dir/b.txt").unwrap(), b"hello");
        assert!(a.read("missing").is_err());
    }

    #[test]
    fn deflate_entry_roundtrip() {
        // build a deflate entry by hand: compress with miniz_oxide
        let payload = b"the quick brown fox jumps over the lazy dog. ".repeat(20);
        let compressed = miniz_oxide::deflate::compress_to_vec(&payload, 6);
        let mut out = Vec::new();
        let name = b"c.json";
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&8u16.to_le_bytes()); // deflate
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name);
        out.extend_from_slice(&compressed);
        let mut central = Vec::new();
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&8u16.to_le_bytes());
        central.extend_from_slice(&[0; 4]);
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        central.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&[0; 8]);
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&0u32.to_le_bytes()); // local offset 0
        central.extend_from_slice(name);
        let cd_offset = out.len() as u32;
        let cd_size = central.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&cd_size.to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());

        let crc = crc32(&payload);
        out[14..18].copy_from_slice(&crc.to_le_bytes());
        let cd = cd_offset as usize;
        out[cd + 16..cd + 20].copy_from_slice(&crc.to_le_bytes());
        let a = ZipArchive::open(&out).unwrap();
        assert_eq!(a.read("c.json").unwrap(), payload);
    }

    #[test]
    fn garbage_is_error_not_panic() {
        assert!(ZipArchive::open(b"PK not a zip").is_err());
        assert!(ZipArchive::open(&[]).is_err());
    }
}

#[cfg(test)]
mod safety_regressions {
    use super::*;
    #[test]
    fn rejects_declared_expansion_bombs_and_corrupted_payloads() {
        let mut zip = write_stored(&[("a".into(), b"hello".to_vec())]);
        let eocd = zip.len() - 22;
        let cd = rd_u32(&zip, eocd + 16).unwrap() as usize;
        zip[cd + 24..cd + 28].copy_from_slice(&(33u32 * 1024 * 1024).to_le_bytes());
        assert!(ZipArchive::open(&zip).is_err());
        let mut zip = write_stored(&[("a".into(), b"hello".to_vec())]);
        zip[31] ^= 1;
        assert!(ZipArchive::open(&zip).unwrap().read("a").is_err());
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    }
    #[test]
    fn duplicate_archive_names_are_not_ambiguous() {
        let zip = write_stored(&[("a".into(), b"one".to_vec()), ("a".into(), b"two".to_vec())]);
        assert!(ZipArchive::open(&zip).is_err());
    }
}
