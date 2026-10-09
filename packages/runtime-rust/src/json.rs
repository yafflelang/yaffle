//! A small JSON value type with ordered objects, a parser and a printer, plus the canonical
//! JSON conventions of docs/CONFORMANCE.md §3 (u64 as strings, bytes as hex, special floats as
//! strings, `$ref` JSON Pointers for shared targets).
//!
//! Self-contained so the runtime has no dependencies.

use std::any::Any;
use std::collections::HashMap;
use std::fmt::{self, Write};
use std::rc::Rc;

use super::error::{Result, YaffleError};
use super::helpers::{Ident, IdentMap};
use super::prim::Endian;

/// A JSON value. Objects keep their key order.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    /// A number written without fraction or exponent.
    Int(i128),
    Float(f64),
    Str(String),
    Array(Vec<Value>),
    Object(Vec<(String, Value)>),
}

impl Value {
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(m) => m.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_array(&self) -> Option<&Vec<Value>> {
        match self {
            Value::Array(a) => Some(a),
            _ => None,
        }
    }
    pub fn as_object(&self) -> Option<&Vec<(String, Value)>> {
        match self {
            Value::Object(o) => Some(o),
            _ => None,
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }
}

/// Builds an object from pairs.
pub fn obj(pairs: Vec<(&str, Value)>) -> Value {
    Value::Object(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

// ─── Printing ────────────────────────────────────────────────────────────────

/// Compact JSON text.
impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Value::Null => f.write_str("null"),
            Value::Bool(b) => write!(f, "{b}"),
            Value::Int(i) => write!(f, "{i}"),
            Value::Float(x) => write_float(f, *x),
            Value::Str(s) => write_string(f, s),
            Value::Array(a) => {
                f.write_char('[')?;
                for (i, x) in a.iter().enumerate() {
                    if i > 0 {
                        f.write_char(',')?;
                    }
                    write!(f, "{x}")?;
                }
                f.write_char(']')
            }
            Value::Object(o) => {
                f.write_char('{')?;
                for (i, (k, x)) in o.iter().enumerate() {
                    if i > 0 {
                        f.write_char(',')?;
                    }
                    write_string(f, k)?;
                    write!(f, ":{x}")?;
                }
                f.write_char('}')
            }
        }
    }
}

/// Shortest round-trip representation, JS-like (exponent outside [1e-7, 1e21)).
fn write_float(out: &mut impl Write, f: f64) -> fmt::Result {
    let a = f.abs();
    if !f.is_finite() {
        out.write_str("null")
    } else if a != 0.0 && !(1e-7..1e21).contains(&a) {
        write!(out, "{f:e}")
    } else {
        write!(out, "{f}")
    }
}

fn write_string(out: &mut impl Write, s: &str) -> fmt::Result {
    out.write_char('"')?;
    for c in s.chars() {
        match c {
            '"' => out.write_str("\\\"")?,
            '\\' => out.write_str("\\\\")?,
            '\n' => out.write_str("\\n")?,
            '\r' => out.write_str("\\r")?,
            '\t' => out.write_str("\\t")?,
            '\u{08}' => out.write_str("\\b")?,
            '\u{0c}' => out.write_str("\\f")?,
            c if (c as u32) < 0x20 => write!(out, "\\u{:04x}", c as u32)?,
            c => out.write_char(c)?,
        }
    }
    out.write_char('"')
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

pub fn parse(text: &str) -> std::result::Result<Value, String> {
    let mut p = Parser { s: text.as_bytes(), i: 0 };
    p.ws();
    let v = p.value()?;
    p.ws();
    if p.i != p.s.len() {
        return Err(format!("trailing characters at {}", p.i));
    }
    Ok(v)
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }
    fn err<T>(&self, msg: &str) -> std::result::Result<T, String> {
        Err(format!("{msg} at {}", self.i))
    }
    fn value(&mut self) -> std::result::Result<Value, String> {
        if self.i >= self.s.len() {
            return self.err("unexpected end");
        }
        match self.s[self.i] {
            b'n' => self.lit("null", Value::Null),
            b't' => self.lit("true", Value::Bool(true)),
            b'f' => self.lit("false", Value::Bool(false)),
            b'"' => Ok(Value::Str(self.string()?)),
            b'[' => {
                self.i += 1;
                let mut a = Vec::new();
                self.ws();
                if self.peek() == Some(b']') {
                    self.i += 1;
                    return Ok(Value::Array(a));
                }
                loop {
                    self.ws();
                    a.push(self.value()?);
                    self.ws();
                    match self.peek() {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(Value::Array(a));
                        }
                        _ => return self.err("expected , or ]"),
                    }
                }
            }
            b'{' => {
                self.i += 1;
                let mut o = Vec::new();
                self.ws();
                if self.peek() == Some(b'}') {
                    self.i += 1;
                    return Ok(Value::Object(o));
                }
                loop {
                    self.ws();
                    if self.peek() != Some(b'"') {
                        return self.err("expected key");
                    }
                    let k = self.string()?;
                    self.ws();
                    if self.peek() != Some(b':') {
                        return self.err("expected :");
                    }
                    self.i += 1;
                    self.ws();
                    let v = self.value()?;
                    o.push((k, v));
                    self.ws();
                    match self.peek() {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(Value::Object(o));
                        }
                        _ => return self.err("expected , or }"),
                    }
                }
            }
            b'-' | b'0'..=b'9' => self.number(),
            _ => self.err("unexpected character"),
        }
    }
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }
    fn lit(&mut self, word: &str, v: Value) -> std::result::Result<Value, String> {
        if self.s[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Ok(v)
        } else {
            self.err("invalid literal")
        }
    }
    fn number(&mut self) -> std::result::Result<Value, String> {
        let start = self.i;
        let mut is_float = false;
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        while let Some(c) = self.peek() {
            match c {
                b'0'..=b'9' => self.i += 1,
                b'.' | b'e' | b'E' | b'+' | b'-' => {
                    is_float = true;
                    self.i += 1
                }
                _ => break,
            }
        }
        let t = std::str::from_utf8(&self.s[start..self.i]).map_err(|e| e.to_string())?;
        if !is_float {
            if let Ok(i) = t.parse::<i128>() {
                return Ok(Value::Int(i));
            }
        }
        t.parse::<f64>().map(Value::Float).map_err(|_| format!("invalid number {t}"))
    }
    fn hex4(&mut self) -> std::result::Result<u32, String> {
        if self.i + 4 > self.s.len() {
            return self.err("bad escape");
        }
        let t = std::str::from_utf8(&self.s[self.i..self.i + 4]).map_err(|e| e.to_string())?;
        let v = u32::from_str_radix(t, 16).map_err(|_| "bad \\u escape".to_string())?;
        self.i += 4;
        Ok(v)
    }
    fn string(&mut self) -> std::result::Result<String, String> {
        self.i += 1; // opening quote
        let mut out = String::new();
        loop {
            let start = self.i;
            while self.i < self.s.len() && self.s[self.i] != b'"' && self.s[self.i] != b'\\' {
                self.i += 1;
            }
            out.push_str(std::str::from_utf8(&self.s[start..self.i]).map_err(|e| e.to_string())?);
            match self.peek() {
                None => return self.err("unterminated string"),
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                _ => {
                    self.i += 1;
                    let c = self.peek().ok_or("bad escape")?;
                    self.i += 1;
                    match c {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{08}'),
                        b'f' => out.push('\u{0c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let cp = if (0xd800..0xdc00).contains(&hi) && self.s[self.i..].starts_with(b"\\u") {
                                self.i += 2;
                                let lo = self.hex4()?;
                                if (0xdc00..0xe000).contains(&lo) {
                                    0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00)
                                } else {
                                    return self.err("bad surrogate pair");
                                }
                            } else {
                                hi
                            };
                            out.push(char::from_u32(cp).ok_or("lone surrogate")?);
                        }
                        _ => return self.err("bad escape"),
                    }
                }
            }
        }
    }
}

// ─── Canonical JSON: values ──────────────────────────────────────────────────

/// Integers of up to 48 bits: a number.
#[inline]
pub fn int(v: impl Into<i128>) -> Value {
    Value::Int(v.into())
}
/// 56- and 64-bit integers: a decimal string.
#[inline]
pub fn big(v: impl Into<i128>) -> Value {
    Value::Str(v.into().to_string())
}
/// A float, with NaN/±Infinity/-0 as strings.
pub fn float(f: f64) -> Value {
    if f.is_nan() {
        Value::Str("NaN".into())
    } else if f == f64::INFINITY {
        Value::Str("Infinity".into())
    } else if f == f64::NEG_INFINITY {
        Value::Str("-Infinity".into())
    } else if f == 0.0 && f.is_sign_negative() {
        Value::Str("-0".into())
    } else if f == f.trunc() && f.abs() < 1e15 {
        Value::Int(f as i128)
    } else {
        Value::Float(f)
    }
}
/// Bytes as lowercase hex.
pub fn bytes(b: &[u8]) -> Value {
    Value::Str(hex(b))
}
pub fn hex(b: &[u8]) -> String {
    const D: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for &x in b {
        s.push(D[(x >> 4) as usize] as char);
        s.push(D[(x & 15) as usize] as char);
    }
    s
}
pub fn unhex(s: &str) -> std::result::Result<Vec<u8>, String> {
    let s: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace()).collect();
    if !s.len().is_multiple_of(2) {
        return Err("odd number of hex digits".into());
    }
    let digit = |c: u8| -> std::result::Result<u8, String> {
        match c {
            b'0'..=b'9' => Ok(c - b'0'),
            b'a'..=b'f' => Ok(c - b'a' + 10),
            b'A'..=b'F' => Ok(c - b'A' + 10),
            _ => Err(format!("invalid hex digit {:?}", c as char)),
        }
    };
    let mut out = Vec::with_capacity(s.len() / 2);
    for p in s.chunks(2) {
        out.push((digit(p[0])? << 4) | digit(p[1])?);
    }
    Ok(out)
}


// ─── Canonical JSON: reading input values ────────────────────────────────────

fn bad(what: &str, v: &Value) -> YaffleError {
    let mut s = v.to_string();
    if s.len() > 60 {
        s.truncate(s.floor_char_boundary(60));
        s.push('…');
    }
    YaffleError::input(format!("expected {what}, got {s}"))
}

/// An integer from a number or a decimal string.
pub fn get_int(v: &Value) -> Result<i128> {
    match v {
        Value::Int(i) => Ok(*i),
        Value::Float(f) if f.fract() == 0.0 && f.is_finite() => Ok(*f as i128),
        Value::Str(s) => s.trim().parse::<i128>().map_err(|_| bad("an integer", v)),
        _ => Err(bad("an integer", v)),
    }
}
pub fn get_float(v: &Value) -> Result<f64> {
    match v {
        Value::Int(i) => Ok(*i as f64),
        Value::Float(f) => Ok(*f),
        Value::Str(s) => match s.as_str() {
            "NaN" => Ok(f64::NAN),
            "Infinity" => Ok(f64::INFINITY),
            "-Infinity" => Ok(f64::NEG_INFINITY),
            "-0" => Ok(-0.0),
            _ => Err(bad("a number", v)),
        },
        _ => Err(bad("a number", v)),
    }
}
pub fn get_bool(v: &Value) -> Result<bool> {
    v.as_bool().ok_or_else(|| bad("a boolean", v))
}
pub fn get_string(v: &Value) -> Result<String> {
    v.as_str().map(|s| s.to_string()).ok_or_else(|| bad("a string", v))
}
pub fn get_bytes(v: &Value) -> Result<Vec<u8>> {
    let s = v.as_str().ok_or_else(|| bad("a hex string", v))?;
    unhex(s).map_err(YaffleError::input)
}
pub fn get_array(v: &Value) -> Result<&Vec<Value>> {
    v.as_array().ok_or_else(|| bad("an array", v))
}
pub fn get_object(v: &Value) -> Result<&Vec<(String, Value)>> {
    v.as_object().ok_or_else(|| bad("an object", v))
}
pub fn get_endian(v: &Value) -> Result<Endian> {
    v.as_str().and_then(Endian::from_name).ok_or_else(|| bad("\"le\" or \"be\"", v))
}

/// An integer in its canonical JSON form for a `bits`-wide destination: a number up to 48 bits,
/// a decimal string (or a number) for 56/64 bits. Anything else is `INPUT`.
pub fn get_int_bits(v: &Value, bits: u32) -> Result<i128> {
    match v {
        Value::Int(i) => Ok(*i),
        Value::Float(f) if f.fract() == 0.0 && f.is_finite() => Ok(*f as i128),
        Value::Str(s) if bits > 48 => s.trim().parse::<i128>().map_err(|_| bad("an integer", v)),
        _ => Err(bad(if bits > 48 { "an integer (decimal string)" } else { "an integer (number)" }, v)),
    }
}

/// `get_int_bits` converted to a typed destination (`RANGE` when out of range).
pub fn get_typed_bits<T: TryFrom<i128>>(v: &Value, bits: u32) -> Result<T> {
    let i = get_int_bits(v, bits)?;
    T::try_from(i).map_err(|_| YaffleError::range(format!("{i} out of range")))
}

/// A required member: missing is an `INPUT` error at that field.
pub fn required<'v>(o: &'v Value, name: &str) -> Result<&'v Value> {
    o.get(name).ok_or_else(|| YaffleError::input(format!("missing field {name}")).in_field(name))
}

// ─── Shared targets: `$ref` ──────────────────────────────────────────────────

/// A JSON Pointer path (RFC 6901): its segments, escaped.
#[derive(Default)]
struct PointerPath(Vec<String>);

impl PointerPath {
    fn push(&mut self, seg: &str) {
        self.0.push(seg.replace('~', "~0").replace('/', "~1"));
    }
    fn push_index(&mut self, i: usize) {
        self.0.push(i.to_string());
    }
    fn pop(&mut self) {
        self.0.pop();
    }
    fn pointer(&self) -> String {
        self.0.iter().map(|s| format!("/{s}")).collect()
    }
}

fn ref_obj(p: &str) -> Value {
    obj(vec![("$ref", Value::Str(p.to_string()))])
}

/// State for `to_json`: the current path and the first occurrence of every shared target.
#[derive(Default)]
pub struct JsonOut {
    path: PointerPath,
    seen: HashMap<(usize, &'static str), String>,
    seen_ids: HashMap<u64, String>,
}

impl JsonOut {
    pub fn new() -> Self {
        Self::default()
    }
    #[inline]
    pub fn push(&mut self, seg: &str) {
        self.path.push(seg);
    }
    #[inline]
    pub fn push_index(&mut self, i: usize) {
        self.path.push_index(i);
    }
    #[inline]
    pub fn pop(&mut self) {
        self.path.pop();
    }
    /// Emits a shared target: `{ "$ref": … }` if it was already emitted, else its JSON.
    pub fn shared<T>(&mut self, rc: &Rc<T>, key: &'static str, f: impl FnOnce(&mut Self) -> Value) -> Value {
        let addr = Rc::as_ptr(rc) as *const () as usize;
        if let Some(p) = self.seen.get(&(addr, key)) {
            return ref_obj(p);
        }
        self.seen.insert((addr, key), self.path.pointer());
        let v = f(self);
        // An object first emitted elsewhere (by identity): later pointers refer to that place.
        if let Some(Value::Str(t)) = v.get("$ref") {
            self.seen.insert((addr, key), t.clone());
        }
        v
    }
    /// A struct value with an identity: `{ "$ref": … }` if the object was already emitted, else
    /// `None` (and the current path is its first occurrence).
    pub fn ident_ref(&mut self, id: Ident) -> Option<Value> {
        if id.id == 0 {
            return None;
        }
        if let Some(p) = self.seen_ids.get(&id.id) {
            return Some(ref_obj(p));
        }
        self.seen_ids.insert(id.id, self.path.pointer());
        None
    }
}

/// State for `from_json`: the current path, the targets built so far (by JSON Pointer), and the
/// identities of the struct values seen, so every `$ref` to one path is one object.
#[derive(Default)]
pub struct JsonIn {
    path: PointerPath,
    built: HashMap<String, Rc<dyn Any>>,
    idents: IdentMap<String>,
    /// `$ref`s being resolved (guards against cycles through values without identity).
    resolving: Vec<String>,
    /// The document root, for `$ref`s to values not built yet. Valid while `with_root` runs.
    root: Option<*const Value>,
}

/// The `$ref` target of `{ "$ref": p }`.
fn ref_target(v: &Value) -> Option<&str> {
    match v.as_object()?.as_slice() {
        [(k, Value::Str(p))] if k == "$ref" => Some(p),
        _ => None,
    }
}

/// A JSON Pointer's (escaped) segments.
fn pointer_segments(p: &str) -> Option<Vec<String>> {
    if p.is_empty() {
        return Some(Vec::new());
    }
    p.strip_prefix('/').map(|rest| rest.split('/').map(String::from).collect())
}

/// The value at a JSON Pointer's segments.
fn lookup<'v>(root: &'v Value, segs: &[String]) -> Option<&'v Value> {
    segs.iter().try_fold(root, |node, seg| {
        let key = seg.replace("~1", "/").replace("~0", "~");
        match node {
            Value::Object(_) => node.get(&key),
            Value::Array(a) => key.parse::<usize>().ok().and_then(|i| a.get(i)),
            _ => None,
        }
    })
}

impl JsonIn {
    /// A context without a document root: `$ref`s must point at targets built earlier.
    pub fn new() -> Self {
        Self::default()
    }
    /// Runs `f` with a context whose `$ref`s can point anywhere in `root` (forward too).
    pub fn with_root<T>(root: &Value, f: impl FnOnce(&Value, &mut JsonIn) -> Result<T>) -> Result<T> {
        let mut j = JsonIn { root: Some(root as *const Value), ..Default::default() };
        f(root, &mut j)
    }
    #[inline]
    pub fn push(&mut self, seg: &str) {
        self.path.push(seg);
    }
    #[inline]
    pub fn push_index(&mut self, i: usize) {
        self.path.push_index(i);
    }
    #[inline]
    pub fn pop(&mut self) {
        self.path.pop();
    }

    /// Starts building the struct value at the current path; pair with [`JsonIn::end_ident`].
    pub fn begin_ident(&mut self) -> Ident {
        self.idents.begin(self.path.pointer()).0
    }
    pub fn end_ident(&mut self) {
        self.idents.end(&self.path.pointer());
    }

    /// Resolves `{ "$ref": p }`: the target built at `p`, a stub if `p` is still being built (a
    /// cycle), or `p`'s JSON built now (a value not built through a pointer yet).
    fn resolve<T: 'static>(
        &mut self,
        p: &str,
        stub: Option<fn(Ident) -> T>,
        f: impl FnOnce(&Value, &mut Self) -> Result<T>,
    ) -> Result<Rc<T>> {
        if let Some(target) = self.built.get(p) {
            return target
                .clone()
                .downcast::<T>()
                .map_err(|_| YaffleError::input(format!("$ref {p} points at a target of another type")));
        }
        if let (Some(mk), Some(id)) = (stub, self.idents.stub(&p.to_string())) {
            return Ok(Rc::new(mk(id)));
        }
        let segs = pointer_segments(p).ok_or_else(|| YaffleError::input(format!("$ref {p} is not a JSON Pointer")))?;
        let root = self.root.ok_or_else(|| YaffleError::input(format!("$ref {p} does not point at an earlier target")))?;
        if self.resolving.iter().any(|r| r == p) {
            return Err(YaffleError::input(format!("$ref {p} refers to itself")));
        }
        // SAFETY: `root` is set only by `with_root`, whose borrow outlives this context.
        let node = lookup(unsafe { &*root }, &segs)
            .ok_or_else(|| YaffleError::input(format!("$ref {p} does not point at a value")))?;
        self.resolving.push(p.to_string());
        let r = match ref_target(node) {
            // A reference to a reference: the same object.
            Some(p2) => self.resolve(p2, stub, f),
            None => {
                let saved = std::mem::replace(&mut self.path, PointerPath(segs));
                let r = f(node, self).map(Rc::new);
                self.path = saved;
                r
            }
        };
        self.resolving.pop();
        let rc = r?;
        self.built.insert(p.to_string(), rc.clone() as Rc<dyn Any>);
        Ok(rc)
    }

    /// Builds a pointer target, resolving `{ "$ref": … }` to the object at that pointer. For
    /// struct targets, `stub` makes the placeholder of an object that contains itself.
    pub fn shared<T: 'static>(
        &mut self,
        v: &Value,
        stub: Option<fn(Ident) -> T>,
        f: impl FnOnce(&Value, &mut Self) -> Result<T>,
    ) -> Result<Rc<T>> {
        if let Some(p) = ref_target(v) {
            return self.resolve(p, stub, f);
        }
        let here = self.path.pointer();
        let rc = Rc::new(f(v, self)?);
        self.built.insert(here, rc.clone() as Rc<dyn Any>);
        Ok(rc)
    }

    /// A struct value with an identity in an inline position: `{ "$ref": … }` gives a copy of the
    /// object at that pointer (same identity), else `None` (build it from `v`).
    pub fn inline_ref<T: Clone + 'static>(
        &mut self,
        v: &Value,
        stub: fn(Ident) -> T,
        f: impl FnOnce(&Value, &mut Self) -> Result<T>,
    ) -> Result<Option<T>> {
        match ref_target(v) {
            Some(p) => Ok(Some(self.resolve(p, Some(stub), f)?.as_ref().clone())),
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn parse_and_print() {
        let text = r#"{"a":1,"b":[true,false,null],"c":"x\"yé😀","d":-2.5,"e":18446744073709551615,"f":1e300}"#;
        let v = parse(text).unwrap();
        assert_eq!(v.get("a"), Some(&Value::Int(1)));
        assert_eq!(v.get("e"), Some(&Value::Int(u64::MAX as i128)));
        assert_eq!(v.get("c").unwrap().as_str().unwrap(), "x\"yé😀");
        let printed = v.to_string();
        assert_eq!(parse(&printed).unwrap(), v);
        assert_eq!(printed, text);
        assert!(parse("{").is_err());
        assert!(parse("[1,]").is_err());
        assert!(parse("1 2").is_err());
    }

    #[test]
    fn floats() {
        assert_eq!(float(1.059999942779541).to_string(), "1.059999942779541");
        assert_eq!(float(2.0).to_string(), "2");
        assert_eq!(float(0.1).to_string(), "0.1");
        assert_eq!(float(f64::NAN), Value::Str("NaN".into()));
        assert_eq!(float(-0.0), Value::Str("-0".into()));
        assert_eq!(float(f64::NEG_INFINITY), Value::Str("-Infinity".into()));
        assert_eq!(Value::Float(1e-9).to_string(), "1e-9");
        assert!(get_float(&Value::Str("-0".into())).unwrap().is_sign_negative());
    }

    #[test]
    fn ints_and_bytes() {
        assert_eq!(big(u64::MAX), Value::Str("18446744073709551615".into()));
        assert_eq!(get_int(&Value::Str("-5".into())).unwrap(), -5);
        assert_eq!(get_typed_bits::<u8>(&Value::Int(256), 8).unwrap_err().code, ErrorCode::Range);
        assert_eq!(get_int_bits(&Value::Str("5".into()), 64).unwrap(), 5);
        assert_eq!(get_int_bits(&Value::Str("5".into()), 32).unwrap_err().code, ErrorCode::Input);
        assert_eq!(hex(&[0, 0xab, 0x10]), "00ab10");
        assert_eq!(unhex("00AB10").unwrap(), vec![0, 0xab, 0x10]);
        assert!(unhex("0").is_err());
        assert!(get_bytes(&Value::Int(1)).is_err());
    }

    fn u32_of(v: &Value, _: &mut JsonIn) -> Result<u32> {
        get_typed_bits::<u32>(v, 32)
    }

    #[test]
    fn refs() {
        let shared = Rc::new(5u32);
        let mut out = JsonOut::new();
        out.push("a");
        let a = out.shared(&shared, "u32", |_| Value::Int(5));
        out.pop();
        out.push("b/c");
        let b = out.shared(&shared, "u32", |_| Value::Int(5));
        assert_eq!(a, Value::Int(5));
        assert_eq!(b, ref_obj("/a"));
        let mut p = PointerPath::default();
        p.push("a/b~c");
        assert_eq!(p.pointer(), "/a~1b~0c");

        let mut inp = JsonIn::new();
        inp.push("a");
        let x: Rc<u32> = inp.shared(&Value::Int(5), None, u32_of).unwrap();
        inp.pop();
        inp.push("b");
        let y: Rc<u32> = inp.shared(&ref_obj("/a"), None, u32_of).unwrap();
        assert!(Rc::ptr_eq(&x, &y));
        assert!(inp.shared(&ref_obj("/zz"), None, u32_of).is_err());
    }

    #[derive(Clone, Default)]
    struct N {
        id: Ident,
        v: u32,
        next: Option<Rc<N>>,
    }

    fn n_from(v: &Value, j: &mut JsonIn) -> Result<N> {
        if let Some(r) = j.inline_ref(v, |i| N { id: i, ..Default::default() }, n_from)? {
            return Ok(r);
        }
        let id = j.begin_ident();
        let x = get_typed_bits::<u32>(required(v, "v")?, 32)?;
        j.push("next");
        let next = match v.get("next") {
            Some(m) if !m.is_null() => Some(j.shared(m, Some(|i| N { id: i, ..Default::default() }), n_from)?),
            _ => None,
        };
        j.pop();
        j.end_ident();
        Ok(N { id, v: x, next })
    }

    #[test]
    fn identity_refs() {
        // A cycle: the inner $ref is a stub with the outer object's identity.
        let doc = parse(r#"{"first":{"v":1,"next":{"v":2,"next":{"$ref":"/first"}}}}"#).unwrap();
        let first = JsonIn::with_root(&doc, |d, j| {
            j.push("first");
            let r = n_from(required(d, "first")?, j);
            j.pop();
            r
        })
        .unwrap();
        let inner = first.next.as_ref().unwrap().next.as_ref().unwrap();
        assert!(inner.id.stub && inner.id.id == first.id.id);
        // A forward $ref to an inline value: built from the root, same identity.
        let doc = parse(r#"{"p":{"$ref":"/a"},"a":{"v":7}}"#).unwrap();
        let (p, a) = JsonIn::with_root(&doc, |d, j| {
            j.push("p");
            let p = j.shared(required(d, "p")?, Some(|i| N { id: i, ..Default::default() }), n_from)?;
            j.pop();
            j.push("a");
            let a = n_from(required(d, "a")?, j)?;
            j.pop();
            Ok((p, a))
        })
        .unwrap();
        assert_eq!(p.v, 7);
        assert_eq!(p.id.id, a.id.id);
        // Output: the second occurrence of an identity is a $ref.
        let mut out = JsonOut::new();
        out.push("x");
        assert!(out.ident_ref(a.id).is_none());
        out.pop();
        out.push("y");
        assert_eq!(out.ident_ref(p.id), Some(ref_obj("/x")));
    }
}
