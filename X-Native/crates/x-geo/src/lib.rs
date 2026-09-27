//! Binary geometry bridge v1. All geometry belongs to x-core; this crate only
//! validates/serializes the wire format documented in GEO_BRIDGE_DESIGN.
use x_core::booleans::{boolean_with, Backend, BoolOp, PositionedPath};
use x_core::PathCmd;

const REQUEST_MAGIC: u32 = 0x58474f31;
const RESPONSE_MAGIC: u32 = 0x58475231;
const MAX_RESPONSE: usize = 16 * 1024 * 1024;
const MAX_REQUEST: usize = 16 + 16 * (24 + 100_000 * 56);

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}
impl Reader<'_> {
    fn take<const N: usize>(&mut self) -> Result<[u8; N], String> {
        let data = self
            .bytes
            .get(self.pos..self.pos + N)
            .ok_or("truncated request")?;
        let mut out = [0; N];
        out.copy_from_slice(data);
        self.pos += N;
        Ok(out)
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take()?))
    }
    fn f64(&mut self) -> Result<f64, String> {
        let v = f64::from_le_bytes(self.take()?);
        if !v.is_finite() || v.abs() > 1e9 {
            return Err("non-finite or excessive coordinate".into());
        }
        Ok(v)
    }
    fn reserved(&mut self) -> Result<(), String> {
        if self.u32()? != 0 {
            return Err("nonzero reserved field".into());
        }
        Ok(())
    }
}

fn decode(bytes: &[u8]) -> Result<(BoolOp, Vec<PositionedPath>), String> {
    if bytes.len() > MAX_REQUEST {
        return Err("request too large".into());
    }
    let mut r = Reader { bytes, pos: 0 };
    if r.u32()? != REQUEST_MAGIC || r.u32()? as usize != bytes.len() {
        return Err("invalid request header".into());
    }
    let version = u16::from_le_bytes(r.take()?);
    let [op, reserved] = r.take()?;
    if version != 1 || reserved != 0 {
        return Err("version mismatch or reserved byte".into());
    }
    let op = match op {
        0 => BoolOp::Union,
        1 => BoolOp::Subtract,
        2 => BoolOp::Intersect,
        3 => BoolOp::Exclude,
        _ => return Err("unknown operation".into()),
    };
    let count = r.u32()? as usize;
    if !(2..=16).contains(&count) {
        return Err("expected 2 to 16 operands".into());
    }
    let mut shapes = Vec::with_capacity(count);
    for _ in 0..count {
        let offset = (r.f64()?, r.f64()?);
        let n = r.u32()? as usize;
        r.reserved()?;
        if !(3..=100_000).contains(&n) {
            return Err("expected 3 to 100000 points".into());
        }
        if n * 56 > bytes.len() - r.pos {
            return Err("truncated operand".into());
        }
        // x/y and incoming/outgoing relative handles; flags select the handles.
        let mut points = Vec::with_capacity(n);
        for _ in 0..n {
            let p = [r.f64()?, r.f64()?, r.f64()?, r.f64()?, r.f64()?, r.f64()?];
            let flags = r.u32()?;
            r.reserved()?;
            if flags & !3 != 0 {
                return Err("unknown point flags".into());
            }
            points.push((p, flags));
        }
        let mut cmds = vec![PathCmd::MoveTo(points[0].0[0], points[0].0[1])];
        // ABI v1 rasterizes anchors, just like booleanPathTs. Handles are
        // validated and reserved for a future curve-aware ABI, not consumed.
        for (p, _) in &points[1..] {
            cmds.push(PathCmd::LineTo(p[0], p[1]));
        }
        cmds.push(PathCmd::Close);
        shapes.push(PositionedPath { cmds, offset });
    }
    if r.pos != bytes.len() {
        return Err("trailing request bytes".into());
    }
    Ok((op, shapes))
}

fn header(status: u8, len: usize, bbox: [f64; 4], contours: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len);
    out.extend(RESPONSE_MAGIC.to_le_bytes());
    out.extend((len as u32).to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend([status, 0]);
    for v in bbox {
        out.extend(v.to_le_bytes());
    }
    out.extend((contours as u32).to_le_bytes());
    out.extend(0u32.to_le_bytes());
    out
}
fn error(message: &str) -> Vec<u8> {
    let mut out = header(2, 60 + message.len(), [0.0; 4], 0);
    out.extend((message.len() as u32).to_le_bytes());
    out.extend(0u32.to_le_bytes());
    out.extend(message.as_bytes());
    out
}
fn compute(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let (op, shapes) = decode(bytes)?;
    let mut result = shapes[0].clone();
    for next in &shapes[1..] {
        let r = boolean_with(Backend::RasterGuided, op, &result, next);
        result = PositionedPath {
            cmds: r.cmds,
            offset: r.origin,
        };
    }
    // RasterGuided emits only polylines. Do not silently throw away curves if
    // its contract ever changes: decline and let the host use its fallback.
    let mut rings: Vec<Vec<(f64, f64)>> = Vec::new();
    let mut current = Vec::new();
    for cmd in result.cmds {
        match cmd {
            PathCmd::MoveTo(x, y) => {
                if !current.is_empty() {
                    return Err("unclosed native contour".into());
                }
                current.push((x + result.offset.0, y + result.offset.1));
            }
            PathCmd::LineTo(x, y) => current.push((x + result.offset.0, y + result.offset.1)),
            PathCmd::Close => {
                if current.first() == current.last() {
                    current.pop();
                }
                if current.len() >= 3 {
                    rings.push(std::mem::take(&mut current));
                }
                current.clear();
            }
            PathCmd::CurveTo(..) => return Err("unexpected curved raster output".into()),
        }
    }
    if !current.is_empty() {
        return Err("unclosed native contour".into());
    }
    if rings.is_empty() {
        return Ok(header(1, 52, [0.0; 4], 0));
    }
    let len = 52 + rings.iter().map(|r| 8 + r.len() * 16).sum::<usize>();
    if len > MAX_RESPONSE {
        return Err("response too large".into());
    }
    let (mut x0, mut y0, mut x1, mut y1) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for &(x, y) in rings.iter().flatten() {
        if !x.is_finite() || !y.is_finite() {
            return Err("non-finite native output".into());
        }
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
    }
    let mut out = header(0, len, [x0, y0, x1 - x0, y1 - y0], rings.len());
    for ring in rings {
        out.extend((ring.len() as u32).to_le_bytes());
        out.extend(0u32.to_le_bytes());
        for (x, y) in ring {
            out.extend(x.to_le_bytes());
            out.extend(y.to_le_bytes());
        }
    }
    Ok(out)
}
/// Host-testable protocol entry point, identical to the wasm entry point.
pub fn boolean_request(bytes: &[u8]) -> Vec<u8> {
    compute(bytes).unwrap_or_else(|message| error(&message))
}

// `no_mangle` is classified by rustc's unsafe_code lint even without unsafe
// blocks. These uniquely prefixed ABI symbol declarations are the only reason
// for this exception. Pointers are NEVER dereferenced: a registry owns every
// allocation and validates all access, including free and output slots.
#[cfg(target_arch = "wasm32")]
#[allow(unsafe_code)]
mod abi {
    use std::cell::RefCell;
    use std::collections::HashMap;
    thread_local! {
        static ALLOCATIONS: RefCell<HashMap<u32, Box<[u8]>>> = RefCell::new(HashMap::new());
    }
    #[no_mangle]
    pub extern "C" fn xgeo_version() -> u32 {
        1
    }
    #[no_mangle]
    pub extern "C" fn xgeo_alloc(len: u32) -> u32 {
        let len = len as usize;
        if len == 0 || len > super::MAX_REQUEST.max(super::MAX_RESPONSE) {
            return 0;
        }
        ALLOCATIONS.with(|allocations| {
            let mut allocations = allocations.borrow_mut();
            if allocations.values().map(|v| v.len()).sum::<usize>() + len > 192 * 1024 * 1024 {
                return 0;
            }
            let mut bytes = Vec::new();
            if bytes.try_reserve_exact(len).is_err() {
                return 0;
            }
            bytes.resize(len, 0);
            let mut bytes = bytes.into_boxed_slice();
            let ptr = bytes.as_mut_ptr() as u32;
            allocations.insert(ptr, bytes);
            ptr
        })
    }
    #[no_mangle]
    pub extern "C" fn xgeo_free(ptr: u32, len: u32) {
        ALLOCATIONS.with(|a| {
            let mut a = a.borrow_mut();
            if a.get(&ptr).is_some_and(|b| b.len() == len as usize) {
                a.remove(&ptr);
            }
        });
    }
    #[no_mangle]
    pub extern "C" fn xgeo_boolean(req: u32, len: u32, out_ptr: u32, out_len: u32) -> u32 {
        let response = ALLOCATIONS.with(|a| {
            let a = a.borrow();
            if out_ptr == req
                || out_ptr.checked_add(4) != Some(out_len)
                || a.get(&out_ptr).is_none_or(|v| v.len() != 8)
            {
                return None;
            }
            let bytes = a.get(&req)?;
            if bytes.len() != len as usize {
                return None;
            }
            Some(super::boolean_request(bytes))
        });
        let Some(response) = response else {
            return 3;
        };
        let len = response.len() as u32;
        let ptr = xgeo_alloc(len);
        if ptr == 0 {
            return 4;
        }
        ALLOCATIONS.with(|a| {
            let mut a = a.borrow_mut();
            a.get_mut(&ptr).unwrap().copy_from_slice(&response);
            let slots = a.get_mut(&out_ptr).unwrap();
            slots[..4].copy_from_slice(&ptr.to_le_bytes());
            slots[4..].copy_from_slice(&len.to_le_bytes());
        });
        u32::from(response[10])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rectangle_request(op: u8) -> Vec<u8> {
        let len: u32 = 16 + 2 * (24 + 4 * 56);
        let mut b = Vec::new();
        b.extend(REQUEST_MAGIC.to_le_bytes());
        b.extend(len.to_le_bytes());
        b.extend(1u16.to_le_bytes());
        b.extend([op, 0]);
        b.extend(2u32.to_le_bytes());
        for offset in [0.0f64, 20.0] {
            b.extend(offset.to_le_bytes());
            b.extend(0f64.to_le_bytes());
            b.extend(4u32.to_le_bytes());
            b.extend(0u32.to_le_bytes());
            for (x, y) in [(0f64, 0f64), (60., 0.), (60., 40.), (0., 40.)] {
                for v in [x, y, 0., 0., 0., 0.] {
                    b.extend(v.to_le_bytes());
                }
                b.extend([0; 8]);
            }
        }
        b
    }
    #[test]
    fn all_operations_return_valid_envelopes() {
        for op in 0..4 {
            let out = boolean_request(&rectangle_request(op));
            assert_eq!(
                u32::from_le_bytes(out[..4].try_into().unwrap()),
                RESPONSE_MAGIC
            );
            assert_eq!(
                u32::from_le_bytes(out[4..8].try_into().unwrap()) as usize,
                out.len()
            );
            assert_eq!(out[10], 0);
        }
    }
    #[test]
    fn rejects_every_truncated_prefix() {
        let req = rectangle_request(0);
        for n in 0..req.len() {
            let mut prefix = req[..n].to_vec();
            if n >= 8 {
                prefix[4..8].copy_from_slice(&(n as u32).to_le_bytes());
            }
            assert_eq!(boolean_request(&prefix)[10], 2);
        }
    }
    #[test]
    fn rejects_non_finite_and_unknown_flags() {
        let mut req = rectangle_request(0);
        req[40..48].copy_from_slice(&f64::NAN.to_le_bytes());
        assert_eq!(boolean_request(&req)[10], 2);
        let mut req = rectangle_request(0);
        req[88..92].copy_from_slice(&4u32.to_le_bytes());
        assert_eq!(boolean_request(&req)[10], 2);
    }
    #[test]
    fn v1_validates_but_does_not_rasterize_handles() {
        let mut req = rectangle_request(0);
        req[56..64].copy_from_slice(&(-4f64).to_le_bytes());
        req[88..92].copy_from_slice(&1u32.to_le_bytes());
        let (_, shapes) = decode(&req).unwrap();
        let (_, plain) = decode(&rectangle_request(0)).unwrap();
        assert_eq!(shapes[0].cmds, plain[0].cmds);
    }
}
