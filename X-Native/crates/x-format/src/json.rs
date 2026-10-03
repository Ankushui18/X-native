//! Minimal recursive-descent JSON parser shared by the .x deserializer
//! and the external-format importers (.). Extracted from
//! deserialize.rs so importers don't grow a second hand-rolled parser.

// ------------------------------------------------------------------- parser

/// Recursion ceiling for untrusted documents (. packages,
/// REST JSON). Every legitimate file nests far below this; a hostile
/// deeply-nested input errors cleanly instead of overflowing the stack.
pub(crate) const MAX_JSON_DEPTH: usize = 512;

pub(crate) struct P<'a> {
    s: &'a [u8],
    i: usize,
    values: usize,
}
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum V {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<V>),
    Obj(Vec<(String, V)>),
}
impl V {
    pub(crate) fn get(&self, key: &str) -> Option<&V> {
        if let V::Obj(m) = self {
            m.iter().find(|(k, _)| k == key).map(|(_, v)| v)
        } else {
            None
        }
    }
    pub(crate) fn str(&self) -> Option<&str> {
        if let V::Str(s) = self {
            Some(s)
        } else {
            None
        }
    }
    pub(crate) fn num(&self) -> Option<f64> {
        if let V::Num(n) = self {
            Some(*n)
        } else {
            None
        }
    }
    pub(crate) fn boolean(&self) -> Option<bool> {
        if let V::Bool(b) = self {
            Some(*b)
        } else {
            None
        }
    }
    pub(crate) fn arr(&self) -> Option<&Vec<V>> {
        if let V::Arr(a) = self {
            Some(a)
        } else {
            None
        }
    }
}

impl<'a> P<'a> {
    pub(crate) fn new(s: &'a str) -> Self {
        Self {
            s: s.as_bytes(),
            i: 0,
            values: 0,
        }
    }
    fn ws(&mut self) {
        while self.i < self.s.len() && (self.s[self.i] as char).is_ascii_whitespace() {
            self.i += 1;
            if self.i.is_multiple_of(16_384) && crate::cancellation::is_cancelled() {
                break;
            }
        }
    }
    fn peek(&mut self) -> Option<u8> {
        self.ws();
        self.s.get(self.i).copied()
    }
    fn eat(&mut self, c: u8) -> Result<(), String> {
        self.ws();
        if self.s.get(self.i) == Some(&c) {
            self.i += 1;
            Ok(())
        } else {
            Err(format!("expected '{}' at {}", c as char, self.i))
        }
    }
    pub(crate) fn value(&mut self) -> Result<V, String> {
        if self.s.len() > crate::admission::MAX_INPUT_BYTES {
            return Err("JSON exceeds the 64 MiB input budget".into());
        }
        let value = self.value_at_depth(0)?;
        self.ws();
        if self.i != self.s.len() {
            return Err(format!("trailing data at {}", self.i));
        }
        Ok(value)
    }

    fn literal(&mut self, token: &[u8], value: V) -> Result<V, String> {
        if self.s.get(self.i..self.i + token.len()) != Some(token) {
            return Err(format!("invalid literal at {}", self.i));
        }
        self.i += token.len();
        Ok(value)
    }

    // Keep the escape decoder out of the recursive container parser's stack
    // frame. This preserves the documented depth ceiling on ordinary threads.
    fn string(&mut self) -> Result<String, String> {
        self.eat(b'"')?;
        let mut out = String::new();
        while let Some(&c) = self.s.get(self.i) {
            if self.i.is_multiple_of(16_384) {
                crate::cancellation::checkpoint()?;
            }
            self.i += 1;
            match c {
                b'"' => return Ok(out),
                b'\\' => {
                    let e = *self.s.get(self.i).ok_or("eof in escape")?;
                    self.i += 1;
                    match e {
                        b'n' => out.push('\n'),
                        b't' => out.push('\t'),
                        b'r' => out.push('\r'),
                        b'u' => {
                            let hex = std::str::from_utf8(
                                self.s.get(self.i..self.i + 4).ok_or("bad \\u")?,
                            )
                            .map_err(|_| "bad utf8")?;
                            let cp = u32::from_str_radix(hex, 16).map_err(|_| "bad hex")?;
                            self.i += 4;
                            // UTF-16 surrogate pair: a high surrogate
                            // followed by \uDC00-\uDFFF combines into one
                            // astral char (emoji in / text)
                            let ch = if (0xD800..0xDC00).contains(&cp) {
                                let low = self
                                    .s
                                    .get(self.i..self.i + 2)
                                    .filter(|sl| *sl == b"\\u")
                                    .and_then(|_| self.s.get(self.i + 2..self.i + 6))
                                    .and_then(|h| std::str::from_utf8(h).ok())
                                    .and_then(|h| u32::from_str_radix(h, 16).ok())
                                    .filter(|lo| (0xDC00..0xE000).contains(lo));
                                match low {
                                    Some(lo) => {
                                        self.i += 6;
                                        char::from_u32(
                                            0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00),
                                        )
                                        .unwrap_or('\u{fffd}')
                                    }
                                    None => '\u{fffd}',
                                }
                            } else {
                                char::from_u32(cp).unwrap_or('\u{fffd}')
                            };
                            out.push(ch);
                        }
                        b'b' => out.push('\u{0008}'),
                        b'f' => out.push('\u{000c}'),
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        _ => return Err("invalid JSON escape".into()),
                    }
                }
                c if c < 0x20 => return Err("unescaped control character".into()),
                c => {
                    // re-assemble multi-byte utf8
                    let start = self.i - 1;
                    let len = if c < 0x80 {
                        1
                    } else if c >> 5 == 0b110 {
                        2
                    } else if c >> 4 == 0b1110 {
                        3
                    } else {
                        4
                    };
                    let slice = self.s.get(start..start + len).ok_or("bad utf8")?;
                    out.push_str(std::str::from_utf8(slice).map_err(|_| "bad utf8")?);
                    self.i = start + len;
                }
            }
        }
        Err("unterminated string".into())
    }

    fn value_at_depth(&mut self, depth: usize) -> Result<V, String> {
        if self.values.is_multiple_of(256) {
            crate::cancellation::checkpoint()?;
        }
        self.values += 1;
        if self.values > 2_000_000 {
            return Err("JSON exceeds the value budget".into());
        }
        if depth > MAX_JSON_DEPTH {
            return Err(format!("JSON nesting deeper than {MAX_JSON_DEPTH}"));
        }
        match self.peek().ok_or("eof")? {
            b'{' => {
                self.eat(b'{')?;
                let mut m = vec![];
                let mut keys = std::collections::HashSet::new();
                if self.peek() == Some(b'}') {
                    self.eat(b'}')?;
                    return Ok(V::Obj(m));
                }
                loop {
                    let k = match self.value_at_depth(depth + 1)? {
                        V::Str(s) => s,
                        _ => return Err("key must be string".into()),
                    };
                    self.eat(b':')?;
                    let value = self.value_at_depth(depth + 1)?;
                    if !keys.insert(k.clone()) {
                        // Compatibility with one defective historical v2 emitter:
                        // its manifest and embedded bytes both used "assets".
                        if depth != 0
                            || k != "assets"
                            || keys.contains("asset_manifest")
                            || !repair_legacy_assets(&mut m, &value)
                        {
                            return Err(format!("duplicate key '{k}'"));
                        }
                        keys.insert("asset_manifest".into());
                    }
                    m.push((k, value));
                    match self.peek() {
                        Some(b',') => {
                            self.eat(b',')?;
                        }
                        _ => break,
                    }
                }
                self.eat(b'}')?;
                Ok(V::Obj(m))
            }
            b'[' => {
                self.eat(b'[')?;
                let mut a = vec![];
                if self.peek() == Some(b']') {
                    self.eat(b']')?;
                    return Ok(V::Arr(a));
                }
                loop {
                    a.push(self.value_at_depth(depth + 1)?);
                    match self.peek() {
                        Some(b',') => {
                            self.eat(b',')?;
                        }
                        _ => break,
                    }
                }
                self.eat(b']')?;
                Ok(V::Arr(a))
            }
            b'"' => self.string().map(V::Str),
            b't' => self.literal(b"true", V::Bool(true)),
            b'f' => self.literal(b"false", V::Bool(false)),
            b'n' => self.literal(b"null", V::Null),
            _ => {
                self.ws();
                let start = self.i;
                while self.i < self.s.len()
                    && matches!(
                        self.s[self.i],
                        b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E'
                    )
                {
                    self.i += 1;
                }
                let token = &self.s[start..self.i];
                if !valid_number(token) {
                    return Err(format!("bad number at {start}"));
                }
                std::str::from_utf8(token)
                    .ok()
                    .and_then(|t| t.parse::<f64>().ok())
                    .filter(|n| n.is_finite())
                    .map(V::Num)
                    .ok_or_else(|| format!("non-finite or invalid number at {start}"))
            }
        }
    }
}

fn valid_number(s: &[u8]) -> bool {
    let mut i = usize::from(s.first() == Some(&b'-'));
    if s.get(i) == Some(&b'0') {
        i += 1;
    } else {
        let start = i;
        while s.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    if s.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while s.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    if matches!(s.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(s.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let start = i;
        while s.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    i == s.len()
}

/// Parse a complete JSON document.
pub(crate) fn parse(text: &str) -> Result<V, String> {
    P::new(text).value()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deeply_nested_hostile_input_errors_instead_of_overflowing() {
        // 100k nested arrays: far past MAX_JSON_DEPTH. Without the depth
        // ceiling this overflows the stack (adversarial ./ file);
        // with it, the parser errors cleanly.
        let hostile = format!("{}1{}", "[".repeat(100_000), "]".repeat(100_000));
        let err = parse(&hostile).expect_err("must hit the depth ceiling");
        assert!(err.contains("nesting"), "unexpected error: {err}");
    }

    #[test]
    fn nesting_within_the_limit_still_parses() {
        let ok = format!("{}0{}", "[".repeat(500), "]".repeat(500));
        assert!(parse(&ok).is_ok());
    }

    #[test]
    fn surrogate_pairs_decode_to_astral_chars() {
        // \uD83D\uDE00 is the UTF-16 encoding of U+1F600
        let v = parse("\"a\\ud83d\\ude00b\"").expect("surrogate pair");
        assert_eq!(v, V::Str("a\u{1F600}b".into()));
    }

    #[test]
    fn unicode_escapes_decode_to_control_chars() {
        let v = parse(r#""a\tb""#).expect("tab escape");
        assert_eq!(v, V::Str("a\tb".into()));
        let v = parse("\"a\\u0009b\"").expect("\\u0009 escape");
        assert_eq!(v, V::Str("a\tb".into()));
    }
}

// Narrow, schema-aware migration. Arbitrary duplicate keys still error.
fn repair_legacy_assets(m: &mut [(String, V)], value: &V) -> bool {
    let get = |key: &str| m.iter().find(|(k, _)| k == key).map(|(_, v)| v);
    if get("format").and_then(V::str) != Some("x-native")
        || get("version").and_then(V::num) != Some(2.0)
    {
        return false;
    }
    let manifest = get("assets").and_then(V::arr).is_some_and(|a| {
        a.iter()
            .all(|r| r.get("data").is_none() && r.get("kind").and_then(V::str).is_some())
    });
    let embedded = value
        .arr()
        .is_some_and(|a| a.iter().all(|r| r.get("data").and_then(V::str).is_some()));
    if !manifest || !embedded {
        return false;
    }
    if let Some((key, _)) = m.iter_mut().find(|(k, _)| k == "assets") {
        *key = "asset_manifest".into();
    }
    true
}

#[cfg(test)]
mod strict_regressions {
    use super::*;
    #[test]
    fn malformed_literals_numbers_escapes_and_trailing_bytes_are_rejected() {
        for input in [
            "truX",
            "falsx",
            "nulx",
            "true false",
            "0 junk",
            "01",
            "+1",
            "1.",
            ".1",
            "1e",
            "1e+",
            "--1",
            "NaN",
            "1e999",
            r#""\q""#,
            "\"line\nbreak\"",
            r#"{"k":1,"k":2}"#,
            "[1,]",
            "{\"x\":true,}",
        ] {
            assert!(parse(input).is_err(), "accepted {input:?}");
        }
        for input in [
            "true",
            "false",
            "null",
            "-0",
            "1.25e-3",
            r#""emoji \uD83D\uDE03""#,
        ] {
            assert!(parse(input).is_ok(), "rejected {input:?}");
        }
    }
    #[test]
    fn invalid_unicode_and_empty_recovery_input_never_panics() {
        for input in ["", "🦀", "\"unfinished", "{{{{", "hello"] {
            let result = std::panic::catch_unwind(|| crate::load_x_lenient(input));
            assert!(result.is_ok());
        }
    }
}
