//! Figma `.fig` binary importer.
//!
//! A `.fig` file is a ZIP archive whose `canvas.fig` entry is a `fig-kiwi`
//! container: 8-byte magic, u32 version, then length-prefixed chunks —
//! chunk 0 is the DEFLATE'd binary Kiwi schema (self-describing: Figma's
//! full field dictionary travels in every file), chunk 1 is the document
//! message, compressed with raw DEFLATE or Zstandard (detected by the
//! zstd frame magic). Images are sibling ZIP entries named `<hex-hash>.png`.
//!
//! Strategy: decode `NodeChange`s generically against the embedded schema,
//! then EMIT a Figma REST-JSON document from them and hand it to
//! `figma::import_figma_json_with_images`. One mapping layer, two front
//! doors (upload the JSON export or the raw binary — same importer core),
//! and the honest-scope story stays identical to the REST path.
//!
//! **Covered**: pages (skipping Figma's hidden `internalOnly` canvases),
//! FRAME/GROUP (`resizeToFit` heuristic)/SECTION, RECTANGLE (+cornerRadius),
//! ELLIPSE, LINE, TEXT (characters, base style, per-character runs via
//! `characterStyleIDs`/`styleOverrideTable`), solid/linear/radial gradient
//! fills and strokes, image fills (bytes from the ZIP), effects, opacity,
//! visibility, rotation + translation, auto-layout from `stack*`, resize
//! constraints, component/instance identity by `key`.
//! **Not covered (dropped with a diagnostic)**: VECTOR path outlines
//! (`commandsBlob` is a separate compressed path blob — the REST importer
//! has the same shape limitation), blend modes, per-corner radii, text
//! style overrides beyond color/size/font, prototype interactions,
//! variables, and slide/section metadata.

use crate::figma::import_figma_json_with_images;
use crate::import_ir::ImportReport;
use crate::json::V;
use crate::kiwi::{decode_binary_schema, KiwiDec, KiwiSchema};
use crate::zipfile::ZipArchive;
use std::collections::HashMap;
use x_core::Document;

// --------------------------------------------------------------- container

fn decompress_chunk(data: &[u8]) -> Result<Vec<u8>, String> {
    // zstd frame magic (0xFD2FB528 little-endian)
    if data.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) {
        let mut out = Vec::new();
        let mut dec = ruzstd::decoding::StreamingDecoder::new(std::io::Cursor::new(data))
            .map_err(|e| format!("zstd: {e}"))?;
        std::io::Read::read_to_end(&mut dec, &mut out).map_err(|e| format!("zstd read: {e}"))?;
        Ok(out)
    } else {
        miniz_oxide::inflate::decompress_to_vec(data)
            .map_err(|e| format!("kiwi chunk decompress: {e:?}"))
    }
}

fn parse_container(canvas: &[u8]) -> Result<(KiwiSchema, Vec<u8>), String> {
    if canvas.len() < 12 || &canvas[..8] != b"fig-kiwi" {
        return Err("not a fig-kiwi canvas (missing \"fig-kiwi\" prelude)".into());
    }
    let mut off = 12usize; // skip u32 version
    let mut chunks: Vec<&[u8]> = Vec::new();
    while off + 4 <= canvas.len() {
        let len = u32::from_le_bytes([
            canvas[off],
            canvas[off + 1],
            canvas[off + 2],
            canvas[off + 3],
        ]) as usize;
        off += 4;
        let end = off.checked_add(len).ok_or("chunk length overflow")?;
        if end > canvas.len() {
            return Err("truncated .fig chunk".into());
        }
        chunks.push(&canvas[off..end]);
        off = end;
    }
    if chunks.len() < 2 {
        return Err("fig-kiwi container has fewer than 2 chunks".into());
    }
    let schema = decode_binary_schema(&decompress_chunk(chunks[0])?)?;
    let msg = decompress_chunk(chunks[1])?;
    Ok((schema, msg))
}

// ------------------------------------------------------------------ helpers

fn gstr<'a>(v: &'a V, key: &str) -> Option<&'a str> {
    match v.get(key)? {
        V::Str(s) => Some(s.as_str()),
        _ => None,
    }
}
fn gnum(v: &V, key: &str) -> Option<f64> {
    match v.get(key)? {
        V::Num(n) => Some(*n),
        V::Bool(b) => Some(*b as i32 as f64),
        _ => None,
    }
}
fn gbool(v: &V, key: &str) -> Option<bool> {
    match v.get(key)? {
        V::Bool(b) => Some(*b),
        _ => None,
    }
}
fn garr<'a>(v: &'a V, key: &str) -> Option<&'a [V]> {
    match v.get(key)? {
        V::Arr(a) => Some(a),
        _ => None,
    }
}

/// id from a GUID struct value ({sessionID, localID})
fn gid(v: &V) -> Option<String> {
    Some(format!(
        "{}:{}",
        gnum(v, "sessionID")? as u64,
        gnum(v, "localID")? as u64
    ))
}
/// id from a node-like value that carries a `guid` field
fn guid_of(v: &V) -> Option<String> {
    v.get("guid").and_then(gid)
}

fn obj(pairs: Vec<(String, V)>) -> V {
    V::Obj(pairs)
}

// ------------------------------------------------------- paint conversion

/// kiwi Paint -> REST-style fill object. Returns None for paint types the
/// REST path can't express (EMOJI/VIDEO/PATTERN/NOISE) so callers can report.
fn paint_json(p: &V, w: f64, h: f64) -> Option<(V, String)> {
    let ty = gstr(p, "type").unwrap_or("SOLID");
    let visible = gbool(p, "visible").unwrap_or(true);
    let opacity = gnum(p, "opacity").unwrap_or(1.0);
    match ty {
        "SOLID" => {
            let c = p.get("color")?;
            Some((
                obj(vec![
                    ("type".into(), V::Str("SOLID".into())),
                    ("visible".into(), V::Bool(visible)),
                    ("opacity".into(), V::Num(opacity)),
                    (
                        "color".into(),
                        obj(vec![
                            ("r".into(), V::Num(gnum(c, "r").unwrap_or(0.0))),
                            ("g".into(), V::Num(gnum(c, "g").unwrap_or(0.0))),
                            ("b".into(), V::Num(gnum(c, "b").unwrap_or(0.0))),
                            ("a".into(), V::Num(gnum(c, "a").unwrap_or(1.0))),
                        ]),
                    ),
                ]),
                "SOLID".to_string(),
            ))
        }
        t @ ("GRADIENT_LINEAR" | "GRADIENT_RADIAL") => {
            let stops = garr(p, "stops")?;
            let out: Vec<V> = stops
                .iter()
                .filter_map(|st| {
                    let c = st.get("color")?;
                    Some(obj(vec![
                        (
                            "position".into(),
                            V::Num(gnum(st, "position").unwrap_or(0.0)),
                        ),
                        (
                            "color".into(),
                            obj(vec![
                                ("r".into(), V::Num(gnum(c, "r").unwrap_or(0.0))),
                                ("g".into(), V::Num(gnum(c, "g").unwrap_or(0.0))),
                                ("b".into(), V::Num(gnum(c, "b").unwrap_or(0.0))),
                                ("a".into(), V::Num(gnum(c, "a").unwrap_or(1.0))),
                            ]),
                        ),
                    ]))
                })
                .collect();
            // .fig keeps the gradient transform matrix; REST consumers here
            // want start/end handles in normalized node space. The matrix
            // maps unit-square gradient coords, and REST's canonical axis is
            // (0,.5)..(1,.5) — apply the matrix to those two points.
            let (a, b, cc, d, e, f) = p
                .get("transform")
                .map(|m| {
                    (
                        gnum(m, "m00").unwrap_or(1.0),
                        gnum(m, "m10").unwrap_or(0.0),
                        gnum(m, "m01").unwrap_or(0.0),
                        gnum(m, "m11").unwrap_or(1.0),
                        gnum(m, "m02").unwrap_or(0.0),
                        gnum(m, "m12").unwrap_or(0.5),
                    )
                })
                .unwrap_or((1.0, 0.0, 0.0, 1.0, 0.0, 0.5));
            let _ = (w, h); // handles are normalized; bbox scaling is the REST reader's job
            let hp = |x: f64| {
                obj(vec![
                    ("x".into(), V::Num(a * x + cc * 0.5 + e)),
                    ("y".into(), V::Num(b * x + d * 0.5 + f)),
                ])
            };
            Some((
                obj(vec![
                    ("type".into(), V::Str(t.into())),
                    ("visible".into(), V::Bool(visible)),
                    ("opacity".into(), V::Num(opacity)),
                    ("gradientStops".into(), V::Arr(out)),
                    (
                        "gradientHandlePositions".into(),
                        V::Arr(vec![hp(0.0), hp(1.0)]),
                    ),
                ]),
                t.to_string(),
            ))
        }
        "IMAGE" => {
            let img = p.get("image")?;
            let hash = match img.get("hash")? {
                V::Str(hex) => hex.clone(),
                _ => return None,
            };
            let scale = gstr(p, "imageScaleMode").unwrap_or("STRETCH");
            Some((
                obj(vec![
                    ("type".into(), V::Str("IMAGE".into())),
                    ("visible".into(), V::Bool(visible)),
                    ("opacity".into(), V::Num(opacity)),
                    ("imageRef".into(), V::Str(hash)),
                    ("scaleMode".into(), V::Str(scale.into())),
                ]),
                "IMAGE".to_string(),
            ))
        }
        _ => None,
    }
}

fn paints_json(list: Option<&[V]>, w: f64, h: f64, diags: &mut Vec<String>) -> Vec<V> {
    let mut out = vec![];
    for p in list.unwrap_or(&[]) {
        match paint_json(p, w, h) {
            Some((v, _)) => out.push(v),
            None => {
                if let Some(t) = gstr(p, "type") {
                    if t != "SOLID" && t != "IMAGE" && !t.starts_with("GRADIENT") {
                        diags.push(format!("dropped unsupported paint type {t}"));
                    }
                }
            }
        }
    }
    out
}

fn effects_json(nc: &V) -> Vec<V> {
    garr(nc, "effects")
        .map(|es| {
            es.iter()
                .filter_map(|e| {
                    let ty = match gstr(e, "type")? {
                        "DROP_SHADOW" | "INNER_SHADOW" => gstr(e, "type")?.to_string(),
                        "FOREGROUND_BLUR" => "LAYER_BLUR".to_string(),
                        "BACKGROUND_BLUR" => "BACKGROUND_BLUR".to_string(),
                        _ => return None,
                    };
                    let mut pairs = vec![("type".into(), V::Str(ty))];
                    if let Some(c) = e.get("color") {
                        pairs.push((
                            "color".into(),
                            obj(vec![
                                ("r".into(), V::Num(gnum(c, "r").unwrap_or(0.0))),
                                ("g".into(), V::Num(gnum(c, "g").unwrap_or(0.0))),
                                ("b".into(), V::Num(gnum(c, "b").unwrap_or(0.0))),
                                ("a".into(), V::Num(gnum(c, "a").unwrap_or(1.0))),
                            ]),
                        ));
                    }
                    if let Some(o) = e.get("offset") {
                        pairs.push((
                            "offset".into(),
                            obj(vec![
                                ("x".into(), V::Num(gnum(o, "x").unwrap_or(0.0))),
                                ("y".into(), V::Num(gnum(o, "y").unwrap_or(0.0))),
                            ]),
                        ));
                    }
                    if let Some(r) = gnum(e, "radius") {
                        pairs.push(("radius".into(), V::Num(r)));
                    }
                    if let Some(s) = gnum(e, "spread") {
                        pairs.push(("spread".into(), V::Num(s)));
                    }
                    pairs.push((
                        "visible".into(),
                        V::Bool(gbool(e, "visible").unwrap_or(true)),
                    ));
                    Some(obj(pairs))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn number_val(v: Option<&V>) -> Option<(f64, String)> {
    let n = v?;
    Some((
        gnum(n, "value")?,
        gstr(n, "units").unwrap_or("PIXELS").to_string(),
    ))
}

fn text_json(nc: &V, diags: &mut Vec<String>) -> Vec<(String, V)> {
    let Some(td) = nc.get("textData") else {
        return vec![];
    };
    let mut out = vec![];
    let chars = gstr(td, "characters").unwrap_or("").to_string();
    out.push(("characters".into(), V::Str(chars)));
    // Base style lives on the NodeChange itself (Figma's UI style fields
    // were hoisted onto the node in .fig; REST nests them under "style").
    let mut style: Vec<(String, V)> = vec![];
    if let Some(fs) = gnum(nc, "fontSize").filter(|v| *v > 0.0) {
        style.push(("fontSize".into(), V::Num(fs)));
    }
    if let Some(fn_) = nc.get("fontName") {
        if let Some(fam) = gstr(fn_, "family") {
            style.push(("fontFamily".into(), V::Str(fam.to_string())));
        }
        let st = gstr(fn_, "style").unwrap_or("");
        let weight = match st {
            _ if st.contains("Black") => 900,
            _ if st.contains("ExtraBold") || st.contains("UltraBold") => 800,
            _ if st.contains("Bold") => 700,
            _ if st.contains("SemiBold") || st.contains("DemiBold") => 600,
            _ if st.contains("Medium") => 500,
            _ if st.contains("Light") => 300,
            _ if st.contains("Thin") || st.contains("Hairline") => 100,
            _ => 400,
        };
        style.push(("fontWeight".into(), V::Num(weight as f64)));
        if st.contains("Italic") || st.contains("Oblique") {
            style.push(("fontStyle".into(), V::Str("ITALIC".into())));
        }
    }
    if let Some((v, units)) = number_val(nc.get("lineHeight")) {
        if units.contains("PIXEL") {
            style.push(("lineHeightPx".into(), V::Num(v)));
        } else {
            diags.push("text lineHeight unit not pixels: using default".into());
        }
    }
    if let Some((v, units)) = number_val(nc.get("letterSpacing")) {
        if units.contains("PIXEL") && v != 0.0 {
            style.push(("letterSpacing".into(), V::Num(v)));
        }
    }
    if !style.is_empty() {
        out.push(("style".into(), obj(style)));
    }
    // per-character runs: REST indexes styleOverrideTable by the raw id
    // (0 = base style); .fig's styleOverrideTable is a positional array
    // whose ids are 1-based. Re-key to match the REST reader's contract.
    if let Some(ids) = garr(td, "characterStyleIDs") {
        if ids
            .iter()
            .any(|x| gnum(x, "v").is_some() || matches!(x, V::Num(n) if *n != 0.0))
        {
            out.push(("characterStyleOverrides".into(), V::Arr(ids.to_vec())));
            if let Some(tbl) = garr(td, "styleOverrideTable") {
                let mut entries = vec![];
                for (i, e) in tbl.iter().enumerate() {
                    let id = gnum(e, "styleID").unwrap_or((i + 1) as f64) as usize;
                    let mut eo: Vec<(String, V)> = vec![];
                    if let Some(fs) = gnum(e, "fontSize").filter(|v| *v > 0.0) {
                        eo.push(("fontSize".into(), V::Num(fs)));
                    }
                    if let Some(fn_) = e.get("fontName") {
                        if let Some(fam) = gstr(fn_, "family") {
                            eo.push(("fontFamily".into(), V::Str(fam.to_string())));
                        }
                        let st = gstr(fn_, "style").unwrap_or("");
                        let weight = if st.contains("Bold") {
                            700.0
                        } else if st.contains("Medium") {
                            500.0
                        } else {
                            400.0
                        };
                        eo.push(("fontWeight".into(), V::Num(weight)));
                        if st.contains("Italic") || st.contains("Oblique") {
                            eo.push(("fontStyle".into(), V::Str("ITALIC".into())));
                        }
                    }
                    let fills = paints_json(garr(e, "fillPaints"), 0.0, 0.0, diags);
                    if !fills.is_empty() {
                        eo.push(("fills".into(), V::Arr(fills)));
                    }
                    entries.push((id.to_string(), obj(eo)));
                }
                if !entries.is_empty() {
                    out.push((
                        "styleOverrideTable".into(),
                        obj(entries.into_iter().collect()),
                    ));
                }
            }
        }
    }
    out
}

fn stack_json(nc: &V) -> Vec<(String, V)> {
    let mode = match gstr(nc, "stackMode") {
        Some(m @ ("HORIZONTAL" | "VERTICAL")) => m,
        _ => return vec![],
    };
    let mut out = vec![("layoutMode".into(), V::Str(mode.into()))];
    if let Some(g) = gnum(nc, "stackSpacing") {
        out.push(("itemSpacing".into(), V::Num(g)));
    }
    let ph = gnum(nc, "stackHorizontalPadding").unwrap_or(0.0);
    let pv = gnum(nc, "stackVerticalPadding").unwrap_or(0.0);
    out.push(("paddingLeft".into(), V::Num(ph)));
    out.push(("paddingTop".into(), V::Num(pv)));
    out.push((
        "paddingRight".into(),
        V::Num(gnum(nc, "stackPaddingRight").unwrap_or(ph)),
    ));
    out.push((
        "paddingBottom".into(),
        V::Num(gnum(nc, "stackPaddingBottom").unwrap_or(pv)),
    ));
    out.push((
        "primaryAxisAlignItems".into(),
        V::Str(gstr(nc, "stackPrimaryAlignItems").unwrap_or("MIN").into()),
    ));
    out.push((
        "counterAxisAlignItems".into(),
        V::Str(
            match gstr(nc, "stackCounterAlignItems").unwrap_or("MIN") {
                "MIN" => "MIN",
                "CENTER" => "CENTER",
                "MAX" => "MAX",
                _ => "MIN",
            }
            .into(),
        ),
    ));
    let hug = |k: &str| {
        gstr(nc, k) == Some("RESIZE_TO_FIT") || gstr(nc, k).is_some_and(|s| s.contains("FIT"))
    };
    out.push((
        "primaryAxisSizingMode".into(),
        V::Str(
            if hug("stackPrimarySizing") {
                "AUTO"
            } else {
                "FIXED"
            }
            .into(),
        ),
    ));
    out.push((
        "counterAxisSizingMode".into(),
        V::Str(
            if hug("stackCounterSizing") {
                "AUTO"
            } else {
                "FIXED"
            }
            .into(),
        ),
    ));
    if gstr(nc, "stackWrap") == Some("WRAP") {
        out.push(("layoutWrap".into(), V::Str("WRAP".into())));
    }
    out
}

// ------------------------------------------------------------- main mapping

/// Preserve ordered document children, but also recover canvases and layers
/// whose parent record is absent (older/partial archives). A layer attached to
/// a KNOWN parent is never promoted: in particular, hidden component canvases
/// must not leak their internals onto a visible page.
fn canvas_children(
    nodes: &[V],
    kids: &HashMap<String, Vec<usize>>,
    known: &HashMap<String, usize>,
    doc_id: &str,
) -> Vec<(usize, Vec<usize>)> {
    let parent = |n: &V| {
        n.get("parentIndex")
            .and_then(|p| p.get("guid"))
            .and_then(gid)
    };
    let orphan = |n: &V| parent(n).is_none_or(|id| !known.contains_key(&id));
    let mut page_ids = kids.get(doc_id).cloned().unwrap_or_default();
    let mut seen: std::collections::HashSet<usize> = page_ids.iter().copied().collect();
    for (i, n) in nodes.iter().enumerate() {
        if gstr(n, "type") == Some("CANVAS") && orphan(n) && seen.insert(i) {
            page_ids.push(i);
        }
    }
    let mut pages: Vec<(usize, Vec<usize>)> = page_ids
        .into_iter()
        .filter_map(|i| {
            let n = &nodes[i];
            if gstr(n, "type") != Some("CANVAS")
                || gbool(n, "internalOnly") == Some(true)
                || gbool(n, "visible") == Some(false)
            {
                return None;
            }
            let children = guid_of(n)
                .and_then(|id| kids.get(&id))
                .cloned()
                .unwrap_or_default();
            Some((i, children))
        })
        .collect();
    let orphans: Vec<usize> = nodes
        .iter()
        .enumerate()
        .filter_map(|(i, n)| {
            (!matches!(gstr(n, "type"), Some("DOCUMENT" | "CANVAS")) && orphan(n)).then_some(i)
        })
        .collect();
    // Match the web reader: first otherwise-empty page consumes orphans;
    // if all pages already have children, append them to the first page.
    let target = pages
        .iter()
        .position(|(_, children)| children.is_empty())
        .unwrap_or(0);
    if let Some((_, children)) = pages.get_mut(target) {
        children.extend(orphans);
    }
    pages
}

/// Import a `.fig` file's bytes (the ZIP container, not the raw canvas).
pub fn import_fig_bytes(bytes: &[u8]) -> Result<Document, String> {
    import_fig_bytes_with_report(bytes).map(|(d, _)| d)
}

pub fn import_fig_bytes_with_report(bytes: &[u8]) -> Result<(Document, ImportReport), String> {
    let zip = ZipArchive::open(bytes)?;
    let canvases = zip.read_matching(|n| n.ends_with("canvas.fig"))?;
    let canvas = canvases
        .values()
        .next()
        .ok_or("no canvas.fig entry in .fig archive")?
        .clone();
    let (schema, msg) = parse_container(&canvas)?;

    // Root message: fig-kiwi calls it "NodeChanges"; newer writers root it
    // in a "Message" definition that *contains* nodeChanges. Accept either.
    let root = ["Message", "NodeChanges"]
        .into_iter()
        .find(|r| {
            schema
                .def(r)
                .is_some_and(|d| d.fields.iter().any(|f| f.name == "nodeChanges"))
        })
        .ok_or("no nodeChanges root in embedded schema")?;
    let mut dec = KiwiDec::new(&schema, &msg);
    let m = dec
        .decode_root(root)
        .map_err(|e| format!("{e} (decoded {}/{})", dec.consumed(), dec.total()))?;
    let partial = dec.consumed() < dec.total();

    let changes = garr(&m, "nodeChanges")
        .map(|a| a.to_vec())
        .unwrap_or_default();

    // merge by guid: later changes patch earlier ones; REMOVED prunes
    let mut nodes: Vec<V> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut diags: Vec<String> = Vec::new();
    for nc in &changes {
        let Some(id) = guid_of(nc) else { continue };
        if gstr(nc, "phase") == Some("REMOVED") {
            if let Some(i) = index.remove(&id) {
                nodes.swap_remove(i);
                // swap_remove shifted the tail into slot i; reindex it
                if i < nodes.len() {
                    if let Some(nid) = nodes.get(i).and_then(guid_of) {
                        index.insert(nid, i);
                    }
                }
            }
            continue;
        }
        match index.get(&id).copied() {
            Some(i) => {
                // patch: field-wise override of the earlier snapshot
                if let (Some(V::Obj(old)), V::Obj(new)) = (nodes.get_mut(i), nc) {
                    for (k, v) in new.iter() {
                        if k == "guid" {
                            continue;
                        }
                        match old.iter_mut().find(|(ok, _)| ok == k) {
                            Some(slot) => slot.1 = v.clone(),
                            None => old.push((k.clone(), v.clone())),
                        }
                    }
                }
            }
            None => {
                index.insert(id, nodes.len());
                nodes.push(nc.clone());
            }
        }
    }

    // child lists keyed by parentIndex, ordered by Figma's position strings
    let mut kids: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, nc) in nodes.iter().enumerate() {
        let Some(pi) = nc.get("parentIndex") else {
            continue;
        };
        let Some(pguid) = pi.get("guid").and_then(gid) else {
            continue;
        };
        kids.entry(pguid).or_default().push(i);
    }
    for list in kids.values_mut() {
        list.sort_by(|&a, &b| {
            let pa = nodes[a]
                .get("parentIndex")
                .and_then(|p| gstr(p, "position"))
                .unwrap_or("");
            let pb = nodes[b]
                .get("parentIndex")
                .and_then(|p| gstr(p, "position"))
                .unwrap_or("");
            pa.cmp(pb).then(a.cmp(&b))
        });
    }

    // component master map: key -> name (REST shape: components {id:{name}})
    let mut comp_map: Vec<(String, V)> = Vec::new();
    for nc in &nodes {
        if matches!(gstr(nc, "type"), Some("COMPONENT") | Some("COMPONENT_SET")) {
            let key = gstr(nc, "key")
                .map(str::to_string)
                .or_else(|| guid_of(nc))
                .unwrap_or_default();
            let name = gstr(nc, "name").unwrap_or("Component").to_string();
            comp_map.push((key, obj(vec![("name".into(), V::Str(name))])));
        }
    }

    let doc_id = nodes
        .iter()
        .find(|nc| gstr(nc, "type") == Some("DOCUMENT"))
        .and_then(guid_of)
        .unwrap_or_else(|| "0:0".into());

    let mut seen_ids: HashMap<String, ()> = HashMap::new();
    let mut dropped_vectors = 0usize;

    fn emit_node(
        i: usize,
        nodes: &[V],
        kids: &HashMap<String, Vec<usize>>,
        parent_abs: (f64, f64),
        diags: &mut Vec<String>,
        seen: &mut HashMap<String, ()>,
        dropped_vectors: &mut usize,
        depth: usize,
    ) -> Option<V> {
        if depth > 512 {
            diags.push("nesting limit reached; subtree truncated".into());
            return None;
        }
        let nc = &nodes[i];
        let ty = gstr(nc, "type").unwrap_or("NONE");
        let id = guid_of(nc).unwrap_or_else(|| format!("auto{depth}i{i}"));
        let rid = if seen.contains_key(&id) {
            format!("{id}~")
        } else {
            id.clone()
        };
        seen.insert(rid.clone(), ());
        let (x, y) = nc
            .get("transform")
            .map(|t| (gnum(t, "m02").unwrap_or(0.0), gnum(t, "m12").unwrap_or(0.0)))
            .unwrap_or((0.0, 0.0));
        let (w, h) = nc
            .get("size")
            .map(|s| (gnum(s, "x").unwrap_or(0.0), gnum(s, "y").unwrap_or(0.0)))
            .unwrap_or((0.0, 0.0));
        let (m00, m01, m10) = nc
            .get("transform")
            .map(|t| {
                (
                    gnum(t, "m00").unwrap_or(1.0),
                    gnum(t, "m01").unwrap_or(0.0),
                    gnum(t, "m10").unwrap_or(0.0),
                )
            })
            .unwrap_or((1.0, 0.0, 0.0));
        let ax = parent_abs.0 + x;
        let ay = parent_abs.1 + y;
        let _ = m00;
        let mapped = match ty {
            "FRAME" => {
                if gbool(nc, "resizeToFit") == Some(true)
                    && garr(nc, "fillPaints").map(|f| f.is_empty()).unwrap_or(true)
                {
                    "GROUP"
                } else {
                    "FRAME"
                }
            }
            "SECTION" => "FRAME",
            "COMPONENT_SET" => "COMPONENT",
            "BOOLEAN_OPERATION" => "GROUP",
            "RECTANGLE" | "ELLIPSE" | "LINE" | "TEXT" | "GROUP" | "INSTANCE" | "COMPONENT" => {
                gstr(nc, "type").unwrap()
            }
            "VECTOR" | "STAR" | "REGULAR_POLYGON" | "SLIDE" | "SLIDE_ROW" | "SLIDE_GRID" => {
                *dropped_vectors += 1;
                "DROP"
            }
            "DOCUMENT" | "CANVAS" => return None,
            _ => return None,
        };
        if mapped == "DROP" {
            // still recurse so descendants of a dropped vector don't vanish
            // (their parentIndex stays; the REST importer reparents none —
            // v1: drop subtree with one diagnostic per node)
            return None;
        }
        let mut pairs: Vec<(String, V)> = vec![
            ("id".into(), V::Str(rid)),
            (
                "name".into(),
                V::Str(gstr(nc, "name").unwrap_or("").to_string()),
            ),
            ("type".into(), V::Str(mapped.to_string())),
            (
                "visible".into(),
                V::Bool(gbool(nc, "visible").unwrap_or(true)),
            ),
            ("opacity".into(), V::Num(gnum(nc, "opacity").unwrap_or(1.0))),
            (
                "absoluteBoundingBox".into(),
                obj(vec![
                    ("x".into(), V::Num(ax)),
                    ("y".into(), V::Num(ay)),
                    ("width".into(), V::Num(w)),
                    ("height".into(), V::Num(h)),
                ]),
            ),
        ];
        if m01.abs() > 1e-6 || m10.abs() > 1e-6 {
            // Figma REST rotation is CCW-positive; our transform's m10 is
            // -sin in y-down space — mirror the REST writer's negation.
            pairs.push(("rotation".into(), V::Num(-m10.atan2(m00))));
        }
        let fills = paints_json(garr(nc, "fillPaints"), w, h, diags);
        if !fills.is_empty() {
            pairs.push(("fills".into(), V::Arr(fills)));
        }
        let strokes = paints_json(garr(nc, "strokePaints"), w, h, diags);
        if !strokes.is_empty() {
            pairs.push(("strokes".into(), V::Arr(strokes)));
            if let Some(swt) = gnum(nc, "strokeWeight") {
                pairs.push(("strokeWeight".into(), V::Num(swt)));
            }
        }
        if let Some(cr) = gnum(nc, "cornerRadius").filter(|v| *v > 0.0) {
            pairs.push(("cornerRadius".into(), V::Num(cr)));
        }
        let fx = effects_json(nc);
        if !fx.is_empty() {
            pairs.push(("effects".into(), V::Arr(fx)));
        }
        if let Some(hc) = gstr(nc, "horizontalConstraint") {
            pairs.push(("horizontalConstraint".into(), V::Str(hc.into())));
        }
        if let Some(vc) = gstr(nc, "verticalConstraint") {
            pairs.push(("verticalConstraint".into(), V::Str(vc.into())));
        }
        if mapped == "INSTANCE" {
            if let Some(k) = gstr(nc, "componentKey") {
                pairs.push(("componentId".into(), V::Str(k.to_string())));
            }
        }
        let mut extra: Vec<(String, V)> = match mapped {
            "TEXT" => text_json(nc, diags),
            "FRAME" => stack_json(nc),
            _ => vec![],
        };
        pairs.append(&mut extra);
        if let Some(children) = kids.get(&id) {
            let mut out = Vec::new();
            for &c in children {
                if let Some(cn) = emit_node(
                    c,
                    nodes,
                    kids,
                    (ax, ay),
                    diags,
                    seen,
                    dropped_vectors,
                    depth + 1,
                ) {
                    out.push(cn);
                }
            }
            if !out.is_empty() {
                pairs.push(("children".into(), V::Arr(out)));
            }
        }
        Some(obj(pairs))
    }

    let mut pages = Vec::new();
    for (pi, child_list) in canvas_children(&nodes, &kids, &index, &doc_id) {
        let nc = &nodes[pi];
        if gstr(nc, "type") != Some("CANVAS") {
            continue;
        }
        if gbool(nc, "internalOnly") == Some(true) || gbool(nc, "visible") == Some(false) {
            continue;
        }
        let pid = guid_of(nc).unwrap_or_default();
        let mut page = obj(vec![
            ("id".into(), V::Str(pid.clone())),
            ("type".into(), V::Str("CANVAS".into())),
            (
                "name".into(),
                V::Str(gstr(nc, "name").unwrap_or("Page").to_string()),
            ),
            ("children".into(), V::Arr(vec![])),
        ]);
        let mut kidsout = Vec::new();
        {
            for c in child_list {
                if let Some(cn) = emit_node(
                    c,
                    &nodes,
                    &kids,
                    (0.0, 0.0),
                    &mut diags,
                    &mut seen_ids,
                    &mut dropped_vectors,
                    1,
                ) {
                    kidsout.push(cn);
                }
            }
        }
        if let V::Obj(entries) = &mut page {
            if let Some((_, V::Arr(a))) = entries.iter_mut().find(|(k, _)| k == "children") {
                *a = kidsout;
            }
        }
        pages.push(page);
    }
    if dropped_vectors > 0 {
        diags.push(format!(
            "{dropped_vectors} vector/path node(s) skipped: .fig geometry blobs are not decoded yet"
        ));
    }
    if partial {
        diags.push("kiwi message ended after partial read of data chunk".into());
    }

    let rest = obj(vec![
        (
            "document".into(),
            obj(vec![
                ("name".into(), V::Str("Document".into())),
                ("children".into(), V::Arr(pages)),
            ]),
        ),
        ("components".into(), obj(comp_map)),
    ]);
    let text = emit_json(&rest);

    // images: ZIP entries images/<hash>[.png] keyed by the same hex
    let mut images: HashMap<String, Vec<u8>> = HashMap::new();
    for (name, data) in zip.read_matching(|n| n.starts_with("images/") && !n.ends_with('/'))? {
        let key = name.rsplit('/').next().unwrap_or(&name);
        let key = key.strip_suffix(".png").unwrap_or(key);
        images.insert(key.to_string(), data);
    }

    let (doc, mut report) = import_figma_json_with_images(&text, &images)?;
    for d in diags.into_iter().rev() {
        if !report.diagnostics.contains(&d) {
            report.diagnostics.insert(0, d);
        }
    }
    report
        .diagnostics
        .push(format!("fig-kiwi schema defs: {}", schema.defs.len()));
    Ok((doc, report))
}

/// Convenience: import straight from disk (size-capped: a `.fig` over
/// 512 MiB is refused rather than slurped).
pub fn import_fig(path: &str) -> Result<Document, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {path}: {e}"))?;
    if bytes.len() > 512 * 1024 * 1024 {
        return Err("file too large to open as .fig".into());
    }
    import_fig_bytes(&bytes)
}

// ------------------------------------------------------------- json emitter

/// Serialize a V back to JSON text so the REST importer consumes one path.
/// Numbers: integers print bare, floats round-trip through Rust's shortest
/// representation. (The round-trip is cheap: canvas files are small, and
/// correctness of the shared parser beats a bespoke second tree type.)
pub(crate) fn emit_json(v: &V) -> String {
    let mut s = String::new();
    write_v(v, &mut s);
    s
}
fn write_v(v: &V, s: &mut String) {
    match v {
        V::Null => s.push_str("null"),
        V::Bool(true) => s.push_str("true"),
        V::Bool(false) => s.push_str("false"),
        V::Num(n) => {
            if !n.is_finite() {
                s.push('0');
            } else if *n == n.trunc() && n.abs() < 1e15 {
                s.push_str(&(*n as i64).to_string());
            } else {
                s.push_str(&n.to_string());
            }
        }
        V::Str(t) => {
            s.push('"');
            for c in t.chars() {
                match c {
                    '"' => s.push_str("\\\""),
                    '\\' => s.push_str("\\\\"),
                    '\n' => s.push_str("\\n"),
                    '\r' => s.push_str("\\r"),
                    '\t' => s.push_str("\\t"),
                    c if (c as u32) < 0x20 => s.push_str(&format!("\\u{:04x}", c as u32)),
                    c => s.push(c),
                }
            }
            s.push('"');
        }
        V::Arr(a) => {
            s.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    s.push(',');
                }
                write_v(x, s);
            }
            s.push(']');
        }
        V::Obj(m) => {
            s.push('{');
            for (i, (k, x)) in m.iter().enumerate() {
                if i > 0 {
                    s.push(',');
                }
                write_v(&V::Str(k.clone()), s);
                s.push(':');
                write_v(x, s);
            }
            s.push('}');
        }
    }
}

#[cfg(test)]
mod orphan_page_tests {
    use super::*;

    fn record(kind: &str, id: usize, parent: Option<usize>, internal: bool) -> V {
        let guid = |n| {
            obj(vec![
                ("sessionID".into(), V::Num(0.0)),
                ("localID".into(), V::Num(n as f64)),
            ])
        };
        let mut fields = vec![
            ("type".into(), V::Str(kind.into())),
            ("guid".into(), guid(id)),
            ("internalOnly".into(), V::Bool(internal)),
        ];
        if let Some(p) = parent {
            fields.push(("parentIndex".into(), obj(vec![("guid".into(), guid(p))])));
        }
        obj(fields)
    }

    #[test]
    fn recovers_missing_parents_without_leaking_hidden_canvas_children() {
        let nodes = vec![
            record("DOCUMENT", 0, None, false),
            record("CANVAS", 1, Some(0), false),
            record("CANVAS", 2, Some(0), true),
            record("RECTANGLE", 3, Some(2), false),
            record("RECTANGLE", 4, Some(99), false),
            record("RECTANGLE", 5, Some(1), false),
            record("CANVAS", 6, None, false),
        ];
        let known = nodes
            .iter()
            .enumerate()
            .map(|(i, n)| (guid_of(n).unwrap(), i))
            .collect();
        let kids = HashMap::from([
            ("0:0".into(), vec![1, 2]),
            ("0:1".into(), vec![5]),
            ("0:2".into(), vec![3]),
        ]);
        assert_eq!(
            canvas_children(&nodes, &kids, &known, "0:0"),
            vec![(1, vec![5]), (6, vec![4])]
        );
    }

    #[test]
    fn document_page_order_is_kept_and_orphans_are_not_duplicated() {
        let nodes = vec![
            record("DOCUMENT", 0, None, false),
            record("CANVAS", 1, Some(0), false),
            record("CANVAS", 2, Some(0), false),
            record("RECTANGLE", 3, None, false),
        ];
        let known = nodes
            .iter()
            .enumerate()
            .map(|(i, n)| (guid_of(n).unwrap(), i))
            .collect();
        let kids = HashMap::from([("0:0".into(), vec![2, 1])]);
        assert_eq!(
            canvas_children(&nodes, &kids, &known, "0:0"),
            vec![(2, vec![3]), (1, vec![])]
        );
    }
}
