//! Host extension points: codecs (`extern codec`), extern types (`extern type`), and the cache
//! that makes codec output byte-exact on rebuilds.
//!
//! Extern functions (`extern fn`) need no trait: generated code calls the configured Rust path
//! directly with typed arguments, so rustc checks the signature.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt;
use std::rc::Rc;

use super::checksum::fingerprint;
use super::prim::Endian;

/// An argument passed to a codec or an extern type (the codec's declared parameters, in order).
#[derive(Debug, Clone, PartialEq)]
pub enum Arg {
    Int(i128),
    Float(f64),
    Bool(bool),
    Str(String),
    Bytes(Vec<u8>),
    Endian(Endian),
}

impl Arg {
    pub fn as_int(&self) -> Option<i128> {
        match self {
            Arg::Int(i) => Some(*i),
            _ => None,
        }
    }
    pub fn as_u64(&self) -> Option<u64> {
        self.as_int().and_then(|i| u64::try_from(i).ok())
    }
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Arg::Float(f) => Some(*f),
            Arg::Int(i) => Some(*i as f64),
            _ => None,
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Arg::Bool(b) => Some(*b),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Arg::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_bytes(&self) -> Option<&[u8]> {
        match self {
            Arg::Bytes(b) => Some(b),
            _ => None,
        }
    }
    pub fn as_endian(&self) -> Option<Endian> {
        match self {
            Arg::Endian(e) => Some(*e),
            _ => None,
        }
    }
    fn fingerprint_into(&self, out: &mut Vec<u8>) {
        match self {
            Arg::Int(i) => {
                out.push(0);
                out.extend_from_slice(&i.to_le_bytes())
            }
            Arg::Float(f) => {
                out.push(1);
                out.extend_from_slice(&f.to_bits().to_le_bytes())
            }
            Arg::Bool(b) => out.extend_from_slice(&[2, *b as u8]),
            Arg::Str(s) => {
                out.push(3);
                out.extend_from_slice(&(s.len() as u64).to_le_bytes());
                out.extend_from_slice(s.as_bytes())
            }
            Arg::Bytes(b) => {
                out.push(4);
                out.extend_from_slice(&(b.len() as u64).to_le_bytes());
                out.extend_from_slice(b)
            }
            Arg::Endian(e) => out.extend_from_slice(&[5, *e as u8]),
        }
    }
}

/// What a codec gets besides its input.
#[derive(Debug, Clone, Copy)]
pub struct CodecCtx<'c> {
    /// The codec's arguments (`@via(chacha20(KEY_A, nonce))`).
    pub args: &'c [Arg],
    /// The decoded size, when an inner `@size` layer gives it (Oodle and LZ4 need it).
    pub output_size: Option<usize>,
    /// For `@ranged` codecs: the slice's offset within the encoded region.
    pub position: Option<u64>,
}

/// `extern codec name(params) [@ranged] [@streaming]`. Errors become `CODEC` errors.
pub trait Codec {
    /// Decodes a whole encoded region.
    fn decode(&self, input: &[u8], ctx: &CodecCtx) -> Result<Vec<u8>, String>;
    /// Encodes decoded bytes.
    fn encode(&self, input: &[u8], ctx: &CodecCtx) -> Result<Vec<u8>, String>;
    /// `@streaming` codecs find their own end: decode a prefix of `input` and return the output
    /// and the number of input bytes consumed. The default decodes everything.
    fn decode_streaming(&self, input: &[u8], ctx: &CodecCtx) -> Result<(Vec<u8>, usize), String> {
        self.decode(input, ctx).map(|o| (o, input.len()))
    }
}

/// `extern type Name(params) : T [@size(n)]`: a host-implemented primitive.
pub trait ExternType {
    type Value;
    /// The encoded size of the value at the start of `bytes`, or `None` if more bytes are needed.
    fn size(&self, bytes: &[u8], args: &[Arg]) -> Option<usize>;
    fn read(&self, bytes: &[u8], args: &[Arg]) -> Result<Self::Value, String>;
    fn write(&self, value: &Self::Value, args: &[Arg]) -> Result<Vec<u8>, String>;
}

// ─── Built-in extern types ───────────────────────────────────────────────────

/// `uleb128`: unsigned LEB128 (a `u64`).
pub struct Uleb128;
pub const ULEB128: Uleb128 = Uleb128;

/// `sleb128`: signed LEB128 (an `i64`).
pub struct Sleb128;
pub const SLEB128: Sleb128 = Sleb128;

fn leb_size(bytes: &[u8]) -> Option<usize> {
    bytes.iter().position(|b| b & 0x80 == 0).map(|p| p + 1)
}

impl ExternType for Uleb128 {
    type Value = u64;
    fn size(&self, bytes: &[u8], _args: &[Arg]) -> Option<usize> {
        leb_size(bytes)
    }
    fn read(&self, bytes: &[u8], _args: &[Arg]) -> Result<u64, String> {
        const TOO_BIG: &str = "uleb128: value exceeds u64";
        if bytes.len() > 10 {
            return Err(TOO_BIG.into());
        }
        let v = bytes.iter().enumerate().fold(0u128, |v, (i, b)| v | ((b & 0x7f) as u128) << (7 * i));
        u64::try_from(v).map_err(|_| TOO_BIG.to_string())
    }
    fn write(&self, value: &u64, _args: &[Arg]) -> Result<Vec<u8>, String> {
        let mut v = *value;
        let mut out = Vec::new();
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(b);
                return Ok(out);
            }
            out.push(b | 0x80);
        }
    }
}

impl ExternType for Sleb128 {
    type Value = i64;
    fn size(&self, bytes: &[u8], _args: &[Arg]) -> Option<usize> {
        leb_size(bytes)
    }
    fn read(&self, bytes: &[u8], _args: &[Arg]) -> Result<i64, String> {
        let mut v: i128 = 0;
        let mut shift = 0u32;
        for b in bytes {
            if shift >= 70 {
                return Err("sleb128: value exceeds i64".into());
            }
            v |= ((b & 0x7f) as i128) << shift;
            shift += 7;
        }
        if shift < 128 && bytes.last().is_some_and(|b| b & 0x40 != 0) {
            v -= 1i128 << shift;
        }
        i64::try_from(v).map_err(|_| "sleb128: value exceeds i64".to_string())
    }
    fn write(&self, value: &i64, _args: &[Arg]) -> Result<Vec<u8>, String> {
        let mut v = *value;
        let mut out = Vec::new();
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            let done = (v == 0 && b & 0x40 == 0) || (v == -1 && b & 0x40 != 0);
            if done {
                out.push(b);
                return Ok(out);
            }
            out.push(b | 0x80);
        }
    }
}

// ─── Codec reuse ─────────────────────────────────────────────────────────────

#[derive(Debug)]
struct CacheEntry {
    decoded: (u64, u64),
    decoded_len: usize,
    args: (u64, u64),
    encoded: Rc<Vec<u8>>,
}

/// Remembers, per `via` region of a parsed value, a fingerprint of the decoded content and the
/// original encoded bytes. On write, unchanged content reuses the original encoding instead of
/// re-running the codec, so `serialize(parse(x)) == x` even for non-deterministic encoders.
///
/// It is a hidden field of generated structs. It compares equal to every other cache, is
/// shared by clones, and is empty in values built by hand or from JSON.
#[derive(Clone, Default)]
pub struct ViaCache(Option<Rc<RefCell<HashMap<String, CacheEntry>>>>);

impl PartialEq for ViaCache {
    fn eq(&self, _other: &Self) -> bool {
        true
    }
}

impl fmt::Debug for ViaCache {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.0 {
            None => f.write_str("ViaCache(empty)"),
            Some(m) => write!(f, "ViaCache({} entries)", m.borrow().len()),
        }
    }
}

fn args_fingerprint(args: &[Arg]) -> (u64, u64) {
    let mut b = Vec::new();
    for a in args {
        a.fingerprint_into(&mut b);
    }
    fingerprint(&b)
}

impl ViaCache {
    pub fn new() -> Self {
        ViaCache(None)
    }
    /// Makes clones share this cache's entries (views record regions read on demand into their
    /// node's cache).
    pub fn share(&mut self) {
        self.0.get_or_insert_with(Default::default);
    }
    /// Records the region `key` (field and indices) after decoding.
    pub fn record(&mut self, key: String, decoded: &[u8], args: &[Arg], encoded: &[u8]) {
        let m = self.0.get_or_insert_with(Default::default);
        m.borrow_mut().insert(
            key,
            CacheEntry {
                decoded: fingerprint(decoded),
                decoded_len: decoded.len(),
                args: args_fingerprint(args),
                encoded: Rc::new(encoded.to_vec()),
            },
        );
    }
    /// Moves every entry of `other` into this cache.
    pub fn absorb(&mut self, other: ViaCache) {
        if let Some(o) = other.0 {
            let entries: Vec<(String, CacheEntry)> = o.borrow_mut().drain().collect();
            let m = self.0.get_or_insert_with(Default::default);
            m.borrow_mut().extend(entries);
        }
    }
    /// The original encoded bytes, if `decoded` and `args` are unchanged.
    pub fn lookup(&self, key: &str, decoded: &[u8], args: &[Arg]) -> Option<Rc<Vec<u8>>> {
        let m = self.0.as_ref()?.borrow();
        let e = m.get(key)?;
        if e.decoded_len == decoded.len() && e.decoded == fingerprint(decoded) && e.args == args_fingerprint(args) {
            Some(e.encoded.clone())
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Rev;
    impl Codec for Rev {
        fn decode(&self, input: &[u8], _: &CodecCtx) -> Result<Vec<u8>, String> {
            Ok(input.iter().rev().copied().collect())
        }
        fn encode(&self, input: &[u8], _: &CodecCtx) -> Result<Vec<u8>, String> {
            Ok(input.iter().rev().copied().collect())
        }
    }

    #[test]
    fn default_streaming_consumes_everything() {
        let ctx = CodecCtx { args: &[], output_size: None, position: None };
        assert_eq!(Rev.decode_streaming(&[1, 2, 3], &ctx).unwrap(), (vec![3, 2, 1], 3));
    }

    #[test]
    fn leb128() {
        for v in [0u64, 1, 127, 128, 300, u64::MAX] {
            let b = ULEB128.write(&v, &[]).unwrap();
            assert_eq!(ULEB128.size(&b, &[]), Some(b.len()));
            assert_eq!(ULEB128.read(&b, &[]).unwrap(), v);
        }
        assert_eq!(ULEB128.write(&300, &[]).unwrap(), vec![0xac, 0x02]);
        for v in [0i64, 1, -1, 63, 64, -64, -65, i64::MIN, i64::MAX] {
            let b = SLEB128.write(&v, &[]).unwrap();
            assert_eq!(SLEB128.read(&b, &[]).unwrap(), v, "{v}");
        }
        assert_eq!(SLEB128.write(&-1, &[]).unwrap(), vec![0x7f]);
        assert_eq!(ULEB128.size(&[0x80, 0x80], &[]), None);
        assert!(ULEB128.read(&[0xff; 11], &[]).is_err());
    }

    #[test]
    fn cache_hits_only_when_unchanged() {
        let mut c = ViaCache::new();
        assert!(c.lookup("body", b"decoded", &[]).is_none());
        let args = [Arg::Int(5)];
        c.record("body".into(), b"decoded", &args, b"ENC");
        assert_eq!(c.lookup("body", b"decoded", &args).unwrap().as_slice(), b"ENC");
        assert!(c.lookup("body", b"decodeD", &args).is_none());
        assert!(c.lookup("body", b"decoded", &[Arg::Int(6)]).is_none());
        assert!(c.lookup("other", b"decoded", &args).is_none());
        let clone = c.clone();
        assert!(clone.lookup("body", b"decoded", &args).is_some());
        assert_eq!(c, ViaCache::new());
        assert_eq!(Arg::Int(3).as_u64(), Some(3));
        assert_eq!(Arg::Int(-3).as_u64(), None);
    }
}
