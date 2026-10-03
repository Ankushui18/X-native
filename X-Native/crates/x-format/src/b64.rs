//! Minimal std-only base64 (RFC 4648) — shared by SVG data-URI embedding
//! and .x embedded-asset serialization.

const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn val(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a' + 26) as u32),
        b'0'..=b'9' => Some((c - b'0' + 52) as u32),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

pub(crate) fn debase64(text: &str) -> Option<Vec<u8>> {
    let bytes: Vec<u8> = text.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for q in bytes.chunks(4) {
        let pad = q.iter().filter(|&&c| c == b'=').count();
        let v: u32 = q
            .iter()
            .take(4 - pad)
            .try_fold(0u32, |acc, &c| Some((acc << 6) | val(c)?))?;
        let v = v << (6 * pad);
        out.push((v >> 16) as u8);
        if pad < 2 {
            out.push((v >> 8) as u8);
        }
        if pad < 1 {
            out.push(v as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_all_pad_lengths() {
        for data in [
            b"".as_slice(),
            b"a",
            b"ab",
            b"abc",
            b"abcd",
            &[0u8, 255, 7, 9, 200],
        ] {
            let enc = base64(data);
            assert_eq!(
                debase64(&enc).unwrap(),
                data,
                "roundtrip {data:?} via {enc}"
            );
        }
    }

    #[test]
    fn rejects_garbage() {
        assert!(debase64("!!!!").is_none());
        assert!(debase64("abc").is_none()); // bad length
    }
}
