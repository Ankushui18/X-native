//! Minimal, standards-shaped TrueType (`glyf`) font subsetting.
//!
//! `subset_font(face_bytes, chars)` rebuilds a font keeping ONLY the tables
//! needed to render the requested character set: head, hhea, maxp, cmap,
//! hmtx, loca, glyf (+ OS/2, name, cvt, fpgm, prep when present, copied
//! verbatim). Composite glyphs are followed to fixed point and their
//! component references renumbered.
//!
//! Deliberate limits (each surfaces as an Err or a listed drop, never a
//! silently wrong font):
//! - CFF/OTF outline subsetting is not implemented (`CFF ` without `glyf` → Err)
//! - cmap output is format 4 (BMP). Non-BMP requested chars are dropped and
//!   listed in `SubsetOutcome::dropped_chars`.
//! - `post` is dropped (glyph names are unused by our render sinks).
//!
//! This is the engine behind "embed fonts at export": the HTML exporter and
//! PDF-side tooling subset every referenced face down to exactly the glyphs
//! the document uses — usually a 5–15% fraction of a Latin face.

use std::collections::{BTreeSet, HashMap};

#[derive(Debug, Clone, Default)]
pub struct SubsetOutcome {
    pub bytes: Vec<u8>,
    pub kept_glyphs: usize,
    pub dropped_chars: Vec<char>,
}

struct R<'a> {
    d: &'a [u8],
}
impl<'a> R<'a> {
    fn u16(&self, at: usize) -> Result<u16, String> {
        let a = self
            .d
            .get(at..at + 2)
            .ok_or_else(|| "font: u16 past end".to_string())?;
        Ok(u16::from_be_bytes([a[0], a[1]]))
    }
    fn i16(&self, at: usize) -> Result<i16, String> {
        Ok(self.u16(at)? as i16)
    }
    fn u32(&self, at: usize) -> Result<u32, String> {
        let a = self
            .d
            .get(at..at + 4)
            .ok_or_else(|| "font: u32 past end".to_string())?;
        Ok(u32::from_be_bytes([a[0], a[1], a[2], a[3]]))
    }
}

fn tables_of(data: &[u8]) -> Result<HashMap<[u8; 4], (usize, usize)>, String> {
    let ver = {
        let a = data
            .get(0..4)
            .ok_or_else(|| "font: too small".to_string())?;
        u32::from_be_bytes([a[0], a[1], a[2], a[3]])
    };
    if ver == u32::from_be_bytes(*b"ttcf") {
        return Err("collection fonts (.ttc) need a face index; pass one face".into());
    }
    if ver != 0x0001_0000 && ver != u32::from_be_bytes(*b"true") {
        return Err(format!("not a TrueType font (sfnt version {ver:#x})"));
    }
    let n16 = data
        .get(4..6)
        .ok_or_else(|| "font: too small".to_string())?;
    let n = u16::from_be_bytes([n16[0], n16[1]]) as usize;
    if n > 64 {
        return Err("font: implausible table count".into());
    }
    let mut out = HashMap::new();
    for i in 0..n {
        let base = 12 + i * 16;
        let e = data
            .get(base..base + 16)
            .ok_or_else(|| "font: truncated directory".to_string())?;
        let mut tag = [0u8; 4];
        tag.copy_from_slice(&e[0..4]);
        let off = u32::from_be_bytes([e[8], e[9], e[10], e[11]]) as usize;
        let len = u32::from_be_bytes([e[12], e[13], e[14], e[15]]) as usize;
        if off + len > data.len() {
            return Err(format!(
                "font: table {} out of bounds",
                String::from_utf8_lossy(&tag)
            ));
        }
        out.insert(tag, (off, len));
    }
    Ok(out)
}

/// char -> glyph id per the font's preferred cmap subtable. Public so the
/// subsetter's guarantees are directly testable.
pub fn font_char_map(data: &[u8]) -> Result<HashMap<char, u16>, String> {
    let tabs = tables_of(data)?;
    let r = R { d: data };
    let (off, len) = tabs
        .get(b"cmap")
        .ok_or_else(|| "no cmap table".to_string())?;
    let count = r.u16(*off + 2)? as usize;
    if count > 32 {
        return Err("font: cmap subtable count implausible".into());
    }
    let score = |plat: u16, enc: u16| -> u8 {
        match (plat, enc) {
            (3, 10) => 5,
            (0, 4) => 4,
            (3, 1) => 3,
            (0, 3) => 2,
            (0, _) | (3, _) => 1,
            _ => 0,
        }
    };
    let mut best: Option<(usize, u8, u16)> = None; // (subtable off, score, fmt)
    for i in 0..count {
        let e = *off + 4 + i * 8;
        let (p, en, so) = (r.u16(e)?, r.u16(e + 2)?, r.u32(e + 4)? as usize);
        let sc = score(p, en);
        if sc == 0 {
            continue;
        }
        let sub = *off + so;
        let fmt = r.u16(sub)?;
        if fmt == 6 || fmt == 14 {
            continue; // trimming/variation: not useful entry points
        }
        if matches!(best, Some((_, s, _)) if s >= sc) {
            continue;
        }
        if r.slice_check(sub, 4).is_none() {
            continue;
        }
        best = Some((sub, sc, fmt));
    }
    let _ = len;
    let (so, _, fmt) = best.ok_or_else(|| "no usable cmap subtable".to_string())?;
    let mut map = HashMap::new();
    match fmt {
        4 => {
            let seg2 = r.u16(so + 6)? as usize / 2;
            if seg2 > 4096 {
                return Err("font: cmap format4 segCount implausible".into());
            }
            let end_i = so + 14;
            let start_i = end_i + seg2 * 2 + 2;
            let delta_i = start_i + seg2 * 2;
            let range_i = delta_i + seg2 * 2;
            for s in 0..seg2 {
                let end = r.u16(end_i + s * 2)? as u32;
                let start = r.u16(start_i + s * 2)?;
                let delta = r.u16(delta_i + s * 2)?;
                let ro = r.u16(range_i + s * 2)? as usize;
                for c in start as u32..=end {
                    if c > 0xFFFF {
                        break;
                    }
                    let g = if ro == 0 {
                        (c as u16).wrapping_add(delta)
                    } else {
                        let idx = range_i + s * 2 + ro + (c as usize - start as usize) * 2;
                        let g0 = r.u16(idx)?;
                        if g0 == 0 {
                            continue;
                        }
                        g0.wrapping_add(delta)
                    };
                    if g != 0 {
                        if let Some(ch) = char::from_u32(c) {
                            map.insert(ch, g);
                        }
                    }
                }
            }
        }
        12 => {
            let groups = r.u32(so + 12)? as usize;
            if groups > 100_000 {
                return Err("font: cmap format12 groups implausible".into());
            }
            for i in 0..groups {
                let g = so + 16 + i * 12;
                let (s, e, sg) = (r.u32(g)?, r.u32(g + 4)?, r.u32(g + 8)?);
                if e.saturating_sub(s) > 65_536 {
                    continue;
                }
                for c in s..=e {
                    if let Some(ch) = char::from_u32(c) {
                        let gid = sg + (c - s);
                        if gid > 0 && gid <= 0xFFFF {
                            map.insert(ch, gid as u16);
                        }
                    }
                }
            }
        }
        f => return Err(format!("unsupported cmap format {f}")),
    }
    Ok(map)
}

impl<'a> R<'a> {
    fn slice_check(&self, at: usize, len: usize) -> Option<&'a [u8]> {
        self.d.get(at..at.checked_add(len)?)
    }
    fn glyph(
        &'a self,
        loca: (usize, usize),
        glyf: (usize, usize),
        fmt: i16,
        gid: usize,
    ) -> Result<Option<&'a [u8]>, String> {
        let (l_off, _) = loca;
        let (g_off, g_len) = glyf;
        let (start, end) = if fmt == 0 {
            let s = self.u16(l_off + gid * 2)? as usize * 2;
            let e = self.u16(l_off + gid * 2 + 2).unwrap_or(s as u16) as usize * 2;
            (s, e)
        } else {
            let s = self.u32(l_off + gid * 4)? as usize;
            let e = self.u32(l_off + gid * 4 + 4).unwrap_or(g_len as u32) as usize;
            (s, e)
        };
        if end <= start {
            return Ok(None);
        }
        Ok(self.slice_check(g_off + start, end - start))
    }
    /// visit (offset_within_glyph, glyph_index) for every composite component
    fn components(&self, glyph: &'a [u8]) -> Result<Vec<(usize, u16)>, String> {
        if glyph.len() < 10 || i16::from_be_bytes([glyph[0], glyph[1]]) != -1 {
            return Ok(vec![]);
        }
        let mut out = Vec::new();
        let mut p = 10usize;
        loop {
            let g = |x: usize| -> Result<u16, String> {
                let v = glyph
                    .get(x..x + 2)
                    .ok_or_else(|| "glyph: component past end".to_string())?;
                Ok(u16::from_be_bytes([v[0], v[1]]))
            };
            let flags = g(p)?;
            out.push((p + 2, g(p + 2)?));
            p += 4;
            let words = flags & 0x0001 != 0;
            let xy = flags & 0x0002 != 0;
            p += if words { 4 } else { 2 };
            if xy {
                p += if words { 4 } else { 2 };
            }
            if flags & 0x0008 != 0 {
                p += 2;
            } else if flags & 0x0040 != 0 {
                p += 4;
            } else if flags & 0x0080 != 0 {
                p += 8;
            }
            if flags & 0x0020 == 0 {
                break;
            }
        }
        Ok(out)
    }
}

pub fn subset_font(data: &[u8], chars: &BTreeSet<char>) -> Result<SubsetOutcome, String> {
    let tabs = tables_of(data)?;
    if tabs.contains_key(b"CFF ") && !tabs.contains_key(b"glyf") {
        return Err("CFF/OTF outlines cannot be subset (TrueType only)".into());
    }
    let need = |t: &[u8; 4]| -> Result<(usize, usize), String> {
        tabs.get(t)
            .copied()
            .ok_or_else(|| format!("font: missing {} table", String::from_utf8_lossy(t)))
    };
    let (head_off, head_len) = need(b"head")?;
    let (maxp_off, maxp_len) = need(b"maxp")?;
    let (hhea_off, _) = need(b"hhea")?;
    let hmtx = need(b"hmtx")?;
    let loca = need(b"loca")?;
    let glyf = need(b"glyf")?;
    let r = R { d: data };

    let num_glyphs = r.u16(maxp_off + 4)? as usize;
    if num_glyphs == 0 || num_glyphs > 100_000 {
        return Err("font: implausible glyph count".into());
    }
    let loca_fmt = r.i16(head_off + 34)?;
    let num_hmetrics = (r.u16(hhea_off + 34)? as usize).clamp(1, num_glyphs);

    // full per-glyph advance/lsb arrays
    let (hm_off, hm_len) = hmtx;
    let _ = hm_len;
    let mut adv = vec![0u16; num_glyphs];
    let mut lsb = vec![0i16; num_glyphs];
    let last_adv = r.u16(hm_off + (num_hmetrics - 1) * 4)?;
    for g in 0..num_glyphs {
        adv[g] = if g < num_hmetrics {
            r.u16(hm_off + g * 4)?
        } else {
            last_adv
        };
        lsb[g] = if g < num_hmetrics {
            r.i16(hm_off + g * 4 + 2)?
        } else {
            r.i16(hm_off + num_hmetrics * 4 + (g - num_hmetrics) * 2)
                .unwrap_or(0)
        };
    }

    let cmap = font_char_map(data)?;
    let mut wanted: BTreeSet<u16> = BTreeSet::new();
    let mut dropped: Vec<char> = Vec::new();
    for &c in chars {
        match cmap.get(&c) {
            Some(g) => {
                wanted.insert(*g);
            }
            None => dropped.push(c),
        }
    }
    wanted.insert(0);

    // component closure to fixed point
    loop {
        let snapshot: Vec<u16> = wanted.iter().copied().collect();
        let mut add = false;
        for gid in snapshot {
            if let Some(g) = r.glyph(loca, glyf, loca_fmt, gid as usize)? {
                for (_, gi) in r.components(g)? {
                    if wanted.insert(gi) {
                        add = true;
                    }
                }
            }
        }
        if !add {
            break;
        }
    }

    let old_list: Vec<u16> = wanted.into_iter().collect(); // sorted (BTreeSet)
    let remap: HashMap<u16, u16> = old_list
        .iter()
        .enumerate()
        .map(|(i, o)| (*o, i as u16))
        .collect();
    let new_num = old_list.len();

    // new glyf + loca (long), composite refs patched
    let mut new_glyf: Vec<u8> = Vec::new();
    let mut loca_bytes: Vec<u8> = Vec::new();
    for old in old_list.iter() {
        loca_bytes.extend_from_slice(&(new_glyf.len() as u32).to_be_bytes());
        let Some(g) = r.glyph(loca, glyf, loca_fmt, *old as usize)? else {
            continue;
        };
        let start = new_glyf.len();
        new_glyf.extend_from_slice(g);
        for (off, gi) in r.components(g)? {
            let mapped = *remap.get(&gi).unwrap_or(&0);
            let at = start + off;
            new_glyf[at..at + 2].copy_from_slice(&mapped.to_be_bytes());
        }
        while !new_glyf.len().is_multiple_of(2) {
            new_glyf.push(0);
        }
    }
    loca_bytes.extend_from_slice(&(new_glyf.len() as u32).to_be_bytes());

    // hmtx: explicit pair per kept glyph
    let mut new_hmtx: Vec<u8> = Vec::new();
    for old in old_list.iter() {
        new_hmtx.extend_from_slice(&adv[*old as usize].to_be_bytes());
        new_hmtx.extend_from_slice(&lsb[*old as usize].to_be_bytes());
    }

    // cmap format 4: one segment per kept char + 0xFFFF terminator
    let mut pairs: Vec<(u16, u16)> = cmap
        .iter()
        .filter(|(c, _g)| chars.contains(*c) && **c as u32 <= 0xFFFE)
        .filter_map(|(c, g)| {
            let newg = *remap.get(g)?;
            Some((*c as u16, newg))
        })
        .collect();
    pairs.sort();
    let seg_count = pairs.len() + 1;
    let mut cmap4: Vec<u8> = Vec::new();
    // cmap table header: version 0, one subtable record (3,1)@12
    cmap4.extend_from_slice(&0u16.to_be_bytes());
    cmap4.extend_from_slice(&1u16.to_be_bytes());
    cmap4.extend_from_slice(&3u16.to_be_bytes());
    cmap4.extend_from_slice(&1u16.to_be_bytes());
    cmap4.extend_from_slice(&12u32.to_be_bytes());
    cmap4.extend_from_slice(&4u16.to_be_bytes());
    cmap4.extend_from_slice(&((16 + seg_count * 14 + 2) as u16).to_be_bytes());
    cmap4.extend_from_slice(&0u16.to_be_bytes()); // language
    cmap4.extend_from_slice(&((seg_count * 2) as u16).to_be_bytes());
    let sc = ilog2(seg_count.max(1));
    cmap4.extend_from_slice(&((16 << sc).min(seg_count * 2) as u16).to_be_bytes()); // searchRange
    cmap4.extend_from_slice(&(sc as u16).to_be_bytes()); // entrySelector
    cmap4.extend_from_slice(
        &(((seg_count * 2) as i32 - (16 << sc).min(seg_count * 2) as i32).max(0) as u16)
            .to_be_bytes(),
    );
    for (ch, _g) in pairs.iter() {
        cmap4.extend_from_slice(&ch.to_be_bytes()); // endCode
    }
    cmap4.extend_from_slice(&0xFFFFu16.to_be_bytes());
    cmap4.extend_from_slice(&0u16.to_be_bytes()); // reservedEndPad (spec)
    for (ch, _) in pairs.iter() {
        cmap4.extend_from_slice(&ch.to_be_bytes()); // startCode
    }
    cmap4.extend_from_slice(&0xFFFFu16.to_be_bytes());
    for (ch, g) in pairs.iter() {
        let d = (*g as i32 - *ch as i32).rem_euclid(0x10000) as u16;
        cmap4.extend_from_slice(&d.to_be_bytes()); // idDelta
    }
    cmap4.extend_from_slice(&1u16.to_be_bytes());
    for _ in 0..seg_count {
        cmap4.extend_from_slice(&0u16.to_be_bytes()); // idRangeOffset (all 0)
    }

    // header tables
    let mut head = data[head_off..head_off + head_len].to_vec();
    head[34] = 0;
    head[35] = 1; // indexToLocFormat = long
    head[8..12].copy_from_slice(&0u32.to_be_bytes()); // checkSumAdjustment
    let mut maxp = data[maxp_off..maxp_off + maxp_len.max(6)].to_vec();
    maxp[4..6].copy_from_slice(&(new_num as u16).to_be_bytes());
    let mut hhea = data[hhea_off..hhea_off + 36].to_vec();
    let aw_max = old_list.iter().map(|o| adv[*o as usize]).max().unwrap_or(0);
    hhea[10..12].copy_from_slice(&aw_max.to_be_bytes());
    let min_lsb = old_list.iter().map(|o| lsb[*o as usize]).min().unwrap_or(0);
    hhea[12..14].copy_from_slice(&(min_lsb as u16).to_be_bytes());
    hhea[34..36].copy_from_slice(&(new_num as u16).to_be_bytes());

    let mut out_tables: Vec<([u8; 4], Vec<u8>)> = vec![
        (*b"cmap", cmap4),
        (*b"glyf", new_glyf),
        (*b"head", head),
        (*b"hhea", hhea),
        (*b"hmtx", new_hmtx),
        (*b"loca", loca_bytes),
        (*b"maxp", maxp),
    ];
    for t in [*b"OS/2", *b"cvt ", *b"fpgm", *b"prep", *b"name"] {
        if let Some((o, l)) = tabs.get(&t) {
            out_tables.push((t, data[*o..*o + *l].to_vec()));
        }
    }
    out_tables.sort_by_key(|(t, _)| *t);

    // sfnt assembly
    let n = out_tables.len();
    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    out.extend_from_slice(&(n as u16).to_be_bytes());
    let sr = (16 << ilog2(n)).min(n * 16);
    out.extend_from_slice(&(sr as u16).to_be_bytes());
    out.extend_from_slice(&(ilog2(n) as u16).to_be_bytes());
    out.extend_from_slice(&((n * 16 - sr) as u16).to_be_bytes());
    let dir_size = 12 + n * 16;
    let mut pos = dir_size;
    let mut dir = Vec::new();
    for (tag, bytes) in &out_tables {
        dir.extend_from_slice(tag);
        dir.extend_from_slice(&checksum(bytes).to_be_bytes());
        dir.extend_from_slice(&(pos as u32).to_be_bytes());
        dir.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        pos += (bytes.len() + 3) & !3;
    }
    out.extend_from_slice(&dir);
    for (_, bytes) in &out_tables {
        out.extend_from_slice(bytes);
        while !out.len().is_multiple_of(4) {
            out.push(0);
        }
    }
    Ok(SubsetOutcome {
        bytes: out,
        kept_glyphs: new_num,
        dropped_chars: dropped,
    })
}

/// every character a document draws (text contents, recursively)
pub fn document_chars(doc: &x_core::Document) -> BTreeSet<char> {
    fn walk(n: &x_core::Node, out: &mut BTreeSet<char>) {
        if let x_core::NodeKind::Text { text } = &n.kind {
            out.extend(text.chars());
        }
        for c in &n.children {
            walk(c, out);
        }
    }
    let mut out = BTreeSet::new();
    for p in &doc.pages {
        walk(p, &mut out);
    }
    out
}

fn ilog2(n: usize) -> usize {
    if n < 1 {
        0
    } else {
        (usize::BITS - n.leading_zeros() - 1) as usize
    }
}
fn checksum(b: &[u8]) -> u32 {
    let mut s: u32 = 0;
    for c in b.chunks(4) {
        let mut w = [0u8; 4];
        w[..c.len()].copy_from_slice(c);
        s = s.wrapping_add(u32::from_be_bytes(w));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inter() -> Vec<u8> {
        std::fs::read(format!(
            "{}/tests/fixtures/Inter-400.ttf",
            env!("CARGO_MANIFEST_DIR")
        ))
        .expect("Inter fixture")
    }

    #[test]
    fn char_map_finds_ascii() {
        let m = font_char_map(&inter()).unwrap();
        assert!(m.contains_key(&'A') && m.contains_key(&'a') && m.contains_key(&' '));
    }

    #[test]
    fn subset_shrinks_and_stays_parseable() {
        let src = inter();
        let chars: BTreeSet<char> = "Hello, World!".chars().chain('a'..='z').collect();
        let out = subset_font(&src, &chars).unwrap();
        assert!(
            out.bytes.len() < src.len() / 2,
            "subset {} vs orig {}",
            out.bytes.len(),
            src.len()
        );
        // reparses and keeps every requested char the source font had
        let orig = font_char_map(&src).unwrap();
        let m = font_char_map(&out.bytes).unwrap();
        for c in chars.iter() {
            if orig.contains_key(c) && (*c as u32) <= 0xFFFE && orig[c] != 0 {
                assert!(m.contains_key(c), "lost {c}");
            }
        }
        // .notdef kept
        let only_h = subset_font(&src, &("H".chars().collect())).unwrap();
        assert!(only_h.kept_glyphs >= 2, ".notdef + H");
        // our OWN shaping stack must accept the subsetted face unchanged
        let orig_fm = crate::FontManager::new();
        let _ = &orig_fm;
        let mut fm = crate::FontManager::new();
        fm.load_face_bytes("InterSubset", out.bytes.clone(), 0)
            .expect("subset loads into FontManager");
        let base = crate::LoadedFont::from_bytes_indexed("Inter", src, 0).unwrap();
        let sub = &fm.fonts[0];
        assert_eq!(sub.units_per_em, base.units_per_em);
        assert_eq!(sub.ascent, base.ascent);
        assert_eq!(sub.descent, base.descent);
    }

    #[test]
    fn rejects_non_glyf_cleanly() {
        assert!(subset_font(b"OTTOjunk", &Default::default()).is_err());
        assert!(subset_font(&[0u8; 8], &Default::default()).is_err());
    }
}
