//! Kiwi: the schema-based binary format that the `.fig` files encode
//! with (see `figbinary.rs`). Decodes the *self-describing* schema embedded
//! in the file, then decodes messages against it into `json::V` values, so
//! every downstream importer consumes one vocabulary.
//!
//! Wire format implemented per evanw/kiwi (js/binary.ts + js/js.ts +
//! js/bb.ts — the same reference the community `.fig` tooling uses):
//! - varuint: 7-bit LE groups, high bit continues, at most 5 bytes (u32 wrap)
//! - varint: zigzag over varuint with JS's `|0` truncation
//! - varuint64/varint64: 9 bytes max; the final byte is OR-ed in FULL
//! - varfloat: 0x00 byte = 0.0, else 4 raw bytes with the exponent rotated
//!   back into place: `bits = (bits << 23) | (bits >> 9)`
//! - string: UTF-8, NUL-terminated
//! - message: loop `sel = varuint`; 0 ends; otherwise the field whose
//!   numeric `value` equals `sel` is read (fields are tagged by absolute
//!   id, not delta)
//! - struct: fields read sequentially, in declaration order, always present
//! - enum: varuint index -> the name at that `value`
//! - array: varuint count, then elements; `byte[]` is length-prefixed raw
//!
//! Byte arrays decode to hex strings (`.fig` image hashes are file names in
//! the ZIP, and no other byte-array field matters to us). int64/uint64
//! become `Num(f64)`; ids below 2^53 are exact, and every `.fig` id is.

use crate::json::V;

// ------------------------------------------------------------------- schema

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KiwiTy {
    Bool,
    Byte,
    Int,
    Uint,
    Float,
    Str,
    Int64,
    Uint64,
    /// user definition (enum / struct / message) by index
    Def(usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KiwiKind {
    Enum,
    Struct,
    Message,
}

#[derive(Debug, Clone)]
pub struct KiwiField {
    pub name: String,
    pub ty: KiwiTy,
    pub is_array: bool,
    pub is_deprecated: bool,
    pub value: u32,
}

#[derive(Debug, Clone)]
pub struct KiwiDef {
    pub name: String,
    pub kind: KiwiKind,
    pub fields: Vec<KiwiField>,
}

#[derive(Debug, Clone)]
pub struct KiwiSchema {
    pub defs: Vec<KiwiDef>,
}

const BUILTINS: [(&str, KiwiTy); 8] = [
    ("bool", KiwiTy::Bool),
    ("byte", KiwiTy::Byte),
    ("int", KiwiTy::Int),
    ("uint", KiwiTy::Uint),
    ("float", KiwiTy::Float),
    ("string", KiwiTy::Str),
    ("int64", KiwiTy::Int64),
    ("uint64", KiwiTy::Uint64),
];
const KIND_CODES: [KiwiKind; 3] = [KiwiKind::Enum, KiwiKind::Struct, KiwiKind::Message];

impl KiwiSchema {
    pub fn def(&self, name: &str) -> Option<&KiwiDef> {
        self.defs.iter().find(|d| d.name == name)
    }
    pub fn def_index(&self, name: &str) -> Option<usize> {
        self.defs.iter().position(|d| d.name == name)
    }
}

// ------------------------------------------------------------------ reader

pub(crate) struct KiwiR<'a> {
    d: &'a [u8],
    i: usize,
}

fn hex(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for &x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

impl<'a> KiwiR<'a> {
    pub fn new(d: &'a [u8]) -> Self {
        Self { d, i: 0 }
    }
    fn byte(&mut self) -> Result<u8, String> {
        let b = *self.d.get(self.i).ok_or("kiwi: read past end")?;
        self.i += 1;
        Ok(b)
    }
    pub fn read_varuint(&mut self) -> Result<u32, String> {
        let mut v: u32 = 0;
        let mut sh: u32 = 0;
        loop {
            let b = self.byte()?;
            v |= (b as u32 & 127).wrapping_shl(sh);
            sh += 7;
            if b & 128 == 0 || sh >= 35 {
                break;
            }
        }
        Ok(v)
    }
    pub fn read_varint(&mut self) -> Result<i32, String> {
        let v = self.read_varuint()?;
        Ok(if v & 1 == 1 {
            (!(v >> 1)) as i32
        } else {
            (v >> 1) as i32
        })
    }
    pub fn read_varuint64(&mut self) -> Result<u64, String> {
        let mut v: u64 = 0;
        let mut sh: u32 = 0;
        loop {
            let b = self.byte()?;
            if b & 128 != 0 && sh < 56 {
                v |= (b as u64 & 127) << sh;
                sh += 7;
            } else {
                v |= (b as u64) << sh;
                break;
            }
        }
        Ok(v)
    }
    pub fn read_varint64(&mut self) -> Result<i64, String> {
        let v = self.read_varuint64()?;
        let x = (v >> 1) as i64;
        Ok(if v & 1 == 1 { !x } else { x })
    }
    pub fn read_string(&mut self) -> Result<String, String> {
        let start = self.i;
        while self.i < self.d.len() && self.d[self.i] != 0 {
            self.i += 1;
        }
        if self.i >= self.d.len() {
            return Err("kiwi: unterminated string".into());
        }
        let s = String::from_utf8_lossy(&self.d[start..self.i]).into_owned();
        self.i += 1; // NUL
        Ok(s)
    }
    pub fn read_varfloat(&mut self) -> Result<f32, String> {
        let first = *self.d.get(self.i).ok_or("kiwi: read past end")?;
        if first == 0 {
            self.i += 1;
            return Ok(0.0);
        }
        if self.i + 4 > self.d.len() {
            return Err("kiwi: truncated float".into());
        }
        let bits = u32::from_le_bytes([
            self.d[self.i],
            self.d[self.i + 1],
            self.d[self.i + 2],
            self.d[self.i + 3],
        ]);
        self.i += 4;
        let bits = bits.rotate_right(9);
        Ok(f32::from_bits(bits))
    }
    fn read_bytes(&mut self, n: usize) -> Result<&'a [u8], String> {
        let e = self.i.checked_add(n).ok_or("kiwi: length overflow")?;
        let b = self.d.get(self.i..e).ok_or("kiwi: read past end")?;
        self.i = e;
        Ok(b)
    }
}

// ----------------------------------------------------------- schema decode

pub fn decode_binary_schema(data: &[u8]) -> Result<KiwiSchema, String> {
    let mut r = KiwiR::new(data);
    let n = r.read_varuint()?;
    if n as usize > 100_000 {
        return Err("kiwi: implausible schema".into());
    }
    let mut defs = Vec::with_capacity(n as usize);
    for _ in 0..n {
        let name = r.read_string()?;
        let kind = *KIND_CODES
            .get(r.byte()? as usize)
            .ok_or("kiwi: bad definition kind")?;
        let fc = r.read_varuint()?;
        if fc as usize > 4000 {
            return Err("kiwi: implausible field count".into());
        }
        let mut fields = Vec::with_capacity(fc as usize);
        for _ in 0..fc {
            let fname = r.read_string()?;
            let t = r.read_varint()?;
            let is_array = r.byte()? & 1 != 0;
            let value = r.read_varuint()?;
            fields.push(KiwiField {
                name: fname,
                ty: Ty::bind(t),
                is_array,
                is_deprecated: false,
                value,
            });
        }
        defs.push(KiwiDef { name, kind, fields });
    }
    // enum fields have no stored type (the value slot is an index into the
    // enum's own fields); everything else bound above. JS nulls enum types
    // and rebinds the rest by definition index — done inline there, done
    // here at bind time since negative = builtin, non-negative = def idx.
    for d in &mut defs {
        if d.kind == KiwiKind::Enum {
            for f in &mut d.fields {
                f.ty = KiwiTy::Uint; // enums encode as varuint
            }
        }
    }
    Ok(KiwiSchema { defs })
}

/// indirection for type binding kept explicit (mirrors binary.ts)
struct Ty;
impl Ty {
    fn bind(t: i32) -> KiwiTy {
        if t < 0 {
            let i = !(t as i64) as usize; // ~t
            BUILTINS.get(i).map(|b| b.1).unwrap_or(KiwiTy::Uint)
        } else {
            KiwiTy::Def(t as usize)
        }
    }
}

// ----------------------------------------------------------- message decode

const MAX_DEPTH: usize = 512;

pub struct KiwiDec<'a> {
    pub schema: &'a KiwiSchema,
    r: KiwiR<'a>,
}

impl<'a> KiwiDec<'a> {
    pub fn new(schema: &'a KiwiSchema, data: &'a [u8]) -> Self {
        Self {
            schema,
            r: KiwiR::new(data),
        }
    }
    pub fn consumed(&self) -> usize {
        self.r.i
    }
    pub fn total(&self) -> usize {
        self.r.d.len()
    }

    /// Decode the message rooted at definition `root`.
    pub(crate) fn decode_root(&mut self, root: &str) -> Result<V, String> {
        let idx = self
            .schema
            .def_index(root)
            .ok_or_else(|| format!("kiwi: no definition {root}"))?;
        self.decode_def(idx, 0)
    }

    fn decode_def(&mut self, idx: usize, depth: usize) -> Result<V, String> {
        if depth > MAX_DEPTH {
            return Err("kiwi: nesting limit".into());
        }
        let d = self
            .schema
            .defs
            .get(idx)
            .ok_or("kiwi: definition index OOB")?;
        match d.kind {
            KiwiKind::Enum => {
                let v = self.r.read_varuint()?;
                let name = d
                    .fields
                    .iter()
                    .find(|f| f.value == v)
                    .map(|f| f.name.clone())
                    .unwrap_or_else(|| format!("#{v}"));
                Ok(V::Str(name))
            }
            KiwiKind::Struct => {
                let mut out = Vec::with_capacity(d.fields.len());
                let fields = d.fields.clone();
                for f in fields {
                    let v = self.decode_field(&f, depth)?;
                    if !f.is_deprecated {
                        out.push((f.name, v));
                    }
                }
                Ok(V::Obj(out))
            }
            KiwiKind::Message => {
                let mut out: Vec<(String, V)> = Vec::new();
                loop {
                    let sel = self.r.read_varuint()?;
                    if sel == 0 {
                        break;
                    }
                    let f = d
                        .fields
                        .iter()
                        .find(|f| f.value == sel)
                        .cloned()
                        .ok_or(format!("kiwi: unknown field {sel} in {}", d.name))?;
                    let v = self.decode_field(&f, depth)?;
                    if !f.is_deprecated {
                        out.push((f.name, v));
                    }
                }
                Ok(V::Obj(out))
            }
        }
    }

    fn decode_field(&mut self, f: &KiwiField, depth: usize) -> Result<V, String> {
        if f.is_array {
            let n = self.r.read_varuint()? as usize;
            if f.ty == KiwiTy::Byte {
                let b = self.r.read_bytes(n)?;
                return Ok(V::Str(hex(b)));
            }
            let mut arr = Vec::new();
            for _ in 0..n.min(4_000_000) {
                arr.push(self.decode_one(f.ty, depth + 1)?);
            }
            return Ok(V::Arr(arr));
        }
        self.decode_one(f.ty, depth)
    }

    fn decode_one(&mut self, ty: KiwiTy, depth: usize) -> Result<V, String> {
        match ty {
            KiwiTy::Bool => Ok(V::Bool(self.r.byte()? != 0)),
            KiwiTy::Byte => Ok(V::Num(self.r.byte()? as f64)),
            KiwiTy::Int => Ok(V::Num(self.r.read_varint()? as f64)),
            KiwiTy::Uint => Ok(V::Num(self.r.read_varuint()? as f64)),
            KiwiTy::Float => Ok(V::Num(self.r.read_varfloat()? as f64)),
            KiwiTy::Str => Ok(V::Str(self.r.read_string()?)),
            KiwiTy::Int64 => Ok(V::Num(self.r.read_varint64()? as f64)),
            KiwiTy::Uint64 => Ok(V::Num(self.r.read_varuint64()? as f64)),
            KiwiTy::Def(i) => self.decode_def(i, depth),
        }
    }
}

// ------------------------------------------------------------- encoders
// (used by tests and by any future .fig writing; self-consistent with the
// readers above)

fn w_varuint(o: &mut Vec<u8>, mut v: u32) {
    loop {
        let mut b = (v & 127) as u8;
        v >>= 7;
        if v > 0 {
            b |= 128;
            o.push(b);
        } else {
            o.push(b);
            return;
        }
    }
}
fn w_varint(o: &mut Vec<u8>, v: i32) {
    let z = ((v << 1) ^ (v >> 31)) as u32;
    w_varuint(o, z);
}
pub(crate) fn w_varfloat(o: &mut Vec<u8>, f: f32) {
    let bits = f.to_bits();
    if bits == 0 {
        o.push(0);
        return;
    }
    let r = bits.rotate_left(9);
    o.extend_from_slice(&r.to_le_bytes());
}
fn w_string(o: &mut Vec<u8>, s: &str) {
    o.extend_from_slice(s.as_bytes());
    o.push(0);
}
fn w_varuint64(o: &mut Vec<u8>, mut v: u64) {
    loop {
        if v >> 7 != 0 {
            o.push((v as u8 & 127) | 128);
            v >>= 7;
        } else {
            o.push(v as u8);
            return;
        }
    }
}

impl KiwiSchema {
    pub fn encode_binary(&self) -> Vec<u8> {
        let mut o = Vec::new();
        w_varuint(&mut o, self.defs.len() as u32);
        for d in &self.defs {
            w_string(&mut o, &d.name);
            o.push(match d.kind {
                KiwiKind::Enum => 0,
                KiwiKind::Struct => 1,
                KiwiKind::Message => 2,
            });
            w_varuint(&mut o, d.fields.len() as u32);
            for f in &d.fields {
                w_string(&mut o, &f.name);
                let code = match f.ty {
                    KiwiTy::Def(i) => i as i32,
                    b => {
                        let idx = BUILTINS.iter().position(|x| x.1 == b).unwrap_or(3);
                        !(idx as i32)
                    }
                };
                w_varint(&mut o, code);
                o.push(if f.is_array { 1 } else { 0 });
                w_varuint(&mut o, f.value);
            }
        }
        o
    }
}

/// Encode a `V` value (as produced by decode) for message `root`.
/// Kiwi message writer. Retained (and unit-tested) for the `.fig` **write**
/// path, which is deliberately not shipped yet — see docs/KNOWN_DEBT.md.
#[allow(dead_code)]
pub(crate) fn encode_message(schema: &KiwiSchema, root: &str, v: &V) -> Vec<u8> {
    let mut o = Vec::new();
    encode_def(schema, root, v, &mut o);
    o
}

fn encode_def(schema: &KiwiSchema, name: &str, v: &V, o: &mut Vec<u8>) {
    let Some(d) = schema.def(name) else { return };
    match d.kind {
        KiwiKind::Enum => {
            if let V::Str(s) = v {
                let idx = d.fields.iter().find(|f| &f.name == s).map(|f| f.value);
                w_varuint(o, idx.unwrap_or(0));
            }
        }
        KiwiKind::Struct => {
            for f in &d.fields {
                let fv = obj_get(v, &f.name).cloned().unwrap_or(V::Null);
                encode_field(schema, f, &fv, o);
            }
        }
        KiwiKind::Message => {
            let mut present: Vec<&(String, V)> = Vec::new();
            if let V::Obj(entries) = v {
                for e in entries {
                    if d.fields.iter().any(|f| f.name == e.0 && !f.is_deprecated) {
                        present.push(e);
                    }
                }
            }
            present.sort_by_key(|(k, _)| {
                d.fields
                    .iter()
                    .find(|f| &f.name == k)
                    .map(|f| f.value)
                    .unwrap_or(u32::MAX)
            });
            for (k, fv) in present {
                let f = d.fields.iter().find(|f| &f.name == k).unwrap();
                w_varuint(o, f.value);
                encode_field(schema, f, fv, o);
            }
            o.push(0);
        }
    }
}

fn obj_get<'a>(v: &'a V, key: &str) -> Option<&'a V> {
    if let V::Obj(m) = v {
        return m.iter().find(|(k, _)| k == key).map(|(_, x)| x);
    }
    None
}

fn encode_field(schema: &KiwiSchema, f: &KiwiField, v: &V, o: &mut Vec<u8>) {
    if f.is_array {
        if f.ty == KiwiTy::Byte {
            let bytes = match v {
                V::Str(hex) => unhex(hex),
                _ => vec![],
            };
            w_varuint(o, bytes.len() as u32);
            o.extend_from_slice(&bytes);
            return;
        }
        let arr = if let V::Arr(a) = v { a.as_slice() } else { &[] };
        w_varuint(o, arr.len() as u32);
        for x in arr {
            encode_one(schema, f.ty, x, o);
        }
        return;
    }
    encode_one(schema, f.ty, v, o);
}

fn encode_one(schema: &KiwiSchema, ty: KiwiTy, v: &V, o: &mut Vec<u8>) {
    match ty {
        KiwiTy::Bool => o.push(match v {
            V::Bool(true) => 1,
            V::Num(n) if *n != 0.0 => 1,
            _ => 0,
        }),
        KiwiTy::Byte => o.push(num(v) as u8),
        KiwiTy::Int => w_varint(o, num(v) as i32),
        KiwiTy::Uint => w_varuint(o, num(v) as u32),
        KiwiTy::Float => w_varfloat(o, num(v) as f32),
        KiwiTy::Str => {
            if let V::Str(s) = v {
                w_string(o, s);
            } else {
                o.push(0);
            }
        }
        KiwiTy::Int64 => {
            let x = num(v) as i64;
            let z = ((x << 1) ^ (x >> 63)) as u64;
            w_varuint64(o, z);
        }
        KiwiTy::Uint64 => w_varuint64(o, num(v) as u64),
        KiwiTy::Def(i) => {
            if let Some(d) = schema.defs.get(i) {
                let n = d.name.clone();
                encode_def(schema, &n, v, o);
            }
        }
    }
}

fn num(v: &V) -> f64 {
    match v {
        V::Num(n) => *n,
        V::Bool(b) => *b as i32 as f64,
        _ => 0.0,
    }
}
pub(crate) fn unhex(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len() / 2);
    let mut i = 0;
    while i + 1 < b.len() {
        let d = |c: u8| match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            _ => 0,
        };
        out.push(d(b[i]) << 4 | d(b[i + 1]));
        i += 2;
    }
    out
}

// -------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    fn test_schema() -> KiwiSchema {
        KiwiSchema {
            defs: vec![
                KiwiDef {
                    name: "MyEnum".into(),
                    kind: KiwiKind::Enum,
                    fields: vec![
                        KiwiField {
                            name: "A".into(),
                            ty: KiwiTy::Uint,
                            is_array: false,
                            is_deprecated: false,
                            value: 0,
                        },
                        KiwiField {
                            name: "B".into(),
                            ty: KiwiTy::Uint,
                            is_array: false,
                            is_deprecated: false,
                            value: 1,
                        },
                    ],
                },
                KiwiDef {
                    name: "Pt".into(),
                    kind: KiwiKind::Struct,
                    fields: vec![
                        KiwiField {
                            name: "x".into(),
                            ty: KiwiTy::Float,
                            is_array: false,
                            is_deprecated: false,
                            value: 0,
                        },
                        KiwiField {
                            name: "y".into(),
                            ty: KiwiTy::Float,
                            is_array: false,
                            is_deprecated: false,
                            value: 1,
                        },
                    ],
                },
                KiwiDef {
                    name: "Root".into(),
                    kind: KiwiKind::Message,
                    fields: vec![
                        KiwiField {
                            name: "kind".into(),
                            ty: KiwiTy::Def(0),
                            is_array: false,
                            is_deprecated: false,
                            value: 1,
                        },
                        KiwiField {
                            name: "n".into(),
                            ty: KiwiTy::Int,
                            is_array: false,
                            is_deprecated: false,
                            value: 2,
                        },
                        KiwiField {
                            name: "pts".into(),
                            ty: KiwiTy::Def(1),
                            is_array: true,
                            is_deprecated: false,
                            value: 3,
                        },
                        KiwiField {
                            name: "name".into(),
                            ty: KiwiTy::Str,
                            is_array: false,
                            is_deprecated: false,
                            value: 4,
                        },
                        KiwiField {
                            name: "hash".into(),
                            ty: KiwiTy::Byte,
                            is_array: true,
                            is_deprecated: false,
                            value: 5,
                        },
                    ],
                },
            ],
        }
    }

    #[test]
    fn varint_roundtrips() {
        let vals: [u32; 6] = [0, 1, 127, 128, 65535, 0xFFFF_FFFF];
        for v in vals {
            let mut o = Vec::new();
            w_varuint(&mut o, v);
            assert_eq!(KiwiR::new(&o).read_varuint().unwrap(), v, "varuint {v}");
        }
        for v in [-1i32, 0, 1, -64, 63, i32::MIN, i32::MAX] {
            let mut o = Vec::new();
            w_varint(&mut o, v);
            assert_eq!(KiwiR::new(&o).read_varint().unwrap(), v, "varint {v}");
        }
    }

    #[test]
    fn varfloat_roundtrips() {
        for v in [0.0f32, 1.0, -1.5, 256.0, 300.5, 1e30, 1e-30] {
            let mut o = Vec::new();
            w_varfloat(&mut o, v);
            let mut r = KiwiR::new(&o);
            let d = r.read_varfloat().unwrap();
            assert_eq!(d, v, "varfloat {v} ({} bytes)", o.len());
        }
    }

    #[test]
    fn schema_encode_decode_roundtrip() {
        let s = test_schema();
        let bin = s.encode_binary();
        let s2 = decode_binary_schema(&bin).unwrap();
        assert_eq!(s2.defs.len(), 3);
        assert_eq!(s2.defs[0].name, "MyEnum");
        assert_eq!(s2.defs[2].fields[2].name, "pts");
        assert!(s2.defs[2].fields[2].is_array);
        // Root.kind binds to definition 0 by index
        assert_eq!(s2.defs[2].fields[0].ty, KiwiTy::Def(0));
    }

    #[test]
    fn message_roundtrip_and_partial() {
        let s = test_schema();
        let msg = V::Obj(vec![
            ("kind".into(), V::Str("B".into())),
            ("n".into(), V::Num(-7.0)),
            (
                "pts".into(),
                V::Arr(vec![
                    V::Obj(vec![("x".into(), V::Num(1.5)), ("y".into(), V::Num(-2.25))]),
                    V::Obj(vec![("x".into(), V::Num(0.0)), ("y".into(), V::Num(3.0))]),
                ]),
            ),
            ("name".into(), V::Str("hello".into())),
            ("hash".into(), V::Str("deadbeef".into())),
        ]);
        let bytes = encode_message(&s, "Root", &msg);
        let mut dec = KiwiDec::new(&s, &bytes);
        let out = dec.decode_root("Root").unwrap();
        assert_eq!(dec.consumed(), dec.total(), "fully consumed");
        assert_eq!(out, msg);
    }
}
