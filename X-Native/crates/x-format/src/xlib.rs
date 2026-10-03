//! `.xlib` — the versioned library artifact, plus the .x-side
//! serialization of a document's pinned dependencies and snapshots.
//!
//! An .xlib is JSON: {"format":"x-native-library","library_id","name",
//! "version","styles","variables","components","assets"} — reusing the
//! exact same style/variable/node/asset encoders as the .x format so
//! there is one serialization dialect in the codebase.

use crate::json::{self, V};
use crate::{legacy_style_json, node_json, parse_hex_color_v, parse_node, parse_style_v};
use x_core::*;

/// Serialize a library to .xlib text (deterministic key order).
pub fn save_xlib(l: &Library) -> String {
    let mut out =
        format!(
        "{{\"format\":\"x-native-library\",\"library_id\":\"{}\",\"name\":\"{}\",\"version\":{},",
        esc(&l.library_id), esc(&l.name), l.version);
    // styles (sorted)
    let mut keys: Vec<_> = l.styles.keys().collect();
    keys.sort();
    out.push_str("\"styles\":{");
    out.push_str(
        &keys
            .iter()
            .map(|k| {
                format!(
                    "\"{}\":{}",
                    esc(k),
                    legacy_style_json(&l.styles[k.as_str()])
                )
            })
            .collect::<Vec<_>>()
            .join(","),
    );
    // variables: colors + numbers (the two library-relevant tables)
    let mut colors: Vec<_> = l.variables.colors.iter().collect();
    colors.sort_by_key(|(k, _)| (*k).clone());
    let mut numbers: Vec<_> = l.variables.numbers.iter().collect();
    numbers.sort_by_key(|(k, _)| (*k).clone());
    out.push_str("},\"variables\":{\"colors\":{");
    out.push_str(
        &colors
            .iter()
            .map(|(k, v)| format!("\"{}\":\"{}\"", esc(k), color_to_hex(**v)))
            .collect::<Vec<_>>()
            .join(","),
    );
    out.push_str("},\"numbers\":{");
    out.push_str(
        &numbers
            .iter()
            .map(|(k, v)| format!("\"{}\":{}", esc(k), v))
            .collect::<Vec<_>>()
            .join(","),
    );
    out.push_str("}},\"components\":[");
    for (i, c) in l.components.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        node_json(c, &mut out);
    }
    // embedded assets, same encoding as .x
    out.push_str("],\"assets\":[");
    let asset_strs: Vec<String> = l
        .assets
        .embedded_sorted()
        .iter()
        .map(|r| {
            format!(
                "{{\"id\":\"{}\",\"mime\":\"{}\",\"name\":\"{}\",\"data\":\"{}\"}}",
                esc(&r.id),
                esc(&r.mime),
                esc(&r.name),
                crate::b64::base64(&r.bytes)
            )
        })
        .collect();
    out.push_str(&asset_strs.join(","));
    out.push_str("]}");
    out
}

pub fn load_xlib(text: &str) -> Result<Library, String> {
    let v = json::parse(text)?;
    if v.get("format").and_then(V::str) != Some("x-native-library") {
        return Err("not an .xlib file".into());
    }
    parse_library_v(&v).ok_or_else(|| "library_id missing".into())
}

/// Parse a library from an already-parsed JSON value (file loads AND the
/// inline snapshots embedded in .x documents share this).
pub(crate) fn parse_library_v(v: &V) -> Option<Library> {
    let mut l = Library {
        library_id: v
            .get("library_id")
            .and_then(V::str)
            .unwrap_or("")
            .to_string(),
        name: v.get("name").and_then(V::str).unwrap_or("").to_string(),
        version: v.get("version").and_then(V::num).unwrap_or(0.0) as u32,
        ..Default::default()
    };
    if l.library_id.is_empty() {
        return None;
    }
    if let Some(V::Obj(styles)) = v.get("styles") {
        for (name, sv) in styles {
            if let Some(s) = parse_style_v(sv) {
                l.styles.insert(name.clone(), s);
            }
        }
    }
    if let Some(vars) = v.get("variables") {
        if let Some(V::Obj(m)) = vars.get("colors") {
            for (k, val) in m {
                if let Some(c) = val.str().and_then(parse_hex_color_v) {
                    l.variables.colors.insert(k.clone(), c);
                }
            }
        }
        if let Some(V::Obj(m)) = vars.get("numbers") {
            for (k, val) in m {
                if let Some(n) = val.num() {
                    l.variables.numbers.insert(k.clone(), n);
                }
            }
        }
    }
    if let Some(comps) = v.get("components").and_then(V::arr) {
        l.components = comps.iter().map(parse_node).collect();
    }
    if let Some(assets) = v.get("assets").and_then(V::arr) {
        for a in assets {
            let (Some(data), Some(name)) = (
                a.get("data").and_then(V::str),
                a.get("name").and_then(V::str),
            ) else {
                continue;
            };
            if let Some(bytes) = crate::b64::debase64(data) {
                l.assets.register(name, bytes, AssetSource::Embedded);
            }
        }
    }
    Some(l)
}

fn esc(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

// ------------------------------------------------------------- integrity

/// Canonical integrity hash of a library: fnv1a128 over its deterministic
/// .xlib serialization. Save-time and load-time use the SAME function, so
/// any snapshot mutation (hand-edited .x, truncation, bit rot) changes it.
pub fn library_hash(l: &Library) -> String {
    hash_bytes(save_xlib(l).as_bytes())
}

/// Result of verifying one dependency's snapshot on load.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IntegrityStatus {
    /// hash present and matches — safe to resolve against
    Verified,
    /// legacy document with no hash recorded — accepted, flagged
    LegacyUnhashed,
    /// hash mismatch — snapshot corrupted or tampered; the app must warn
    /// and treat bindings as frozen rather than resolving
    Corrupt { expected: String, actual: String },
    /// dependency present but its snapshot is missing entirely
    MissingSnapshot,
}

/// Verify a dependency against its (optional) loaded snapshot.
pub fn verify_dependency(dep: &LibraryDependency, snapshot: Option<&Library>) -> IntegrityStatus {
    let Some(l) = snapshot else {
        return IntegrityStatus::MissingSnapshot;
    };
    if dep.snapshot_hash.is_empty() {
        return IntegrityStatus::LegacyUnhashed;
    }
    let actual = library_hash(l);
    if actual == dep.snapshot_hash {
        IntegrityStatus::Verified
    } else {
        IntegrityStatus::Corrupt {
            expected: dep.snapshot_hash.clone(),
            actual,
        }
    }
}

/// Verify every dependency of a document (load-time sweep).
pub fn verify_document_libraries(doc: &Document) -> Vec<(String, IntegrityStatus)> {
    doc.library_deps
        .iter()
        .map(|d| {
            (
                d.library_id.clone(),
                verify_dependency(d, doc.library_snapshots.get(&d.library_id)),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xlib_roundtrip_is_byte_stable() {
        let mut l = Library {
            library_id: "brand-system".into(),
            name: "Brand System".into(),
            version: 3,
            ..Default::default()
        };
        l.styles.insert(
            "Primary/500".into(),
            LegacyStyle::Paint {
                fill: Paint::Solid(Color::from_rgb8(0x63, 0x66, 0xFF)),
            },
        );
        l.styles.insert(
            "Heading".into(),
            LegacyStyle::Text(TextStyleData {
                font_family: "Inter".into(),
                font_weight: 700,
                font_size: 32.0,
                line_height: LineHeight::Multiple(1.3),
                ..Default::default()
            }),
        );
        l.variables
            .colors
            .insert("brand".into(), Color::from_rgb8(0x63, 0x66, 0xFF));
        l.variables.numbers.insert("radius".into(), 12.0);
        l.components.push(
            Node::component("m1", "Button", 100.0, 40.0).child(Node::rect(
                "bg",
                0.0,
                0.0,
                100.0,
                40.0,
                Color::from_rgb8(0x63, 0x66, 0xFF),
            )),
        );
        let text = save_xlib(&l);
        let re = load_xlib(&text).expect("load");
        assert_eq!(re.library_id, "brand-system");
        assert_eq!(re.version, 3);
        assert_eq!(re.styles.len(), 2);
        assert_eq!(re.variables.numbers.get("radius"), Some(&12.0));
        assert_eq!(re.components.len(), 1);
        assert_eq!(save_xlib(&re), text, "save(load(save)) byte-identical");
    }

    #[test]
    fn garbage_is_an_error() {
        assert!(load_xlib("{}").is_err());
        assert!(load_xlib("not json").is_err());
        assert!(
            load_xlib("{\"format\":\"x-native-library\"}").is_err(),
            "id required"
        );
    }
}
