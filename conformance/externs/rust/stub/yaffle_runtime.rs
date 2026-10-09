//! A stand-in for the host-interface part of the Rust runtime (`yaffle_runtime`), so the extern
//! files can be unit-tested without it (conformance/scripts/test-rust-externs.sh). It mirrors
//! `packages/runtime-rust/src/codec.rs` (Arg, CodecCtx, Codec, ExternType) as the Rust backend
//! defined them; the real crate is what generated code links against.

/// Byte order (`prim::Endian` in the runtime).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Endian {
    #[default]
    Le,
    Be,
}

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
}

#[derive(Debug, Clone, Copy)]
pub struct CodecCtx<'c> {
    pub args: &'c [Arg],
    pub output_size: Option<usize>,
    pub position: Option<u64>,
}

pub trait Codec {
    fn decode(&self, input: &[u8], ctx: &CodecCtx) -> Result<Vec<u8>, String>;
    fn encode(&self, input: &[u8], ctx: &CodecCtx) -> Result<Vec<u8>, String>;
    fn decode_streaming(&self, input: &[u8], ctx: &CodecCtx) -> Result<(Vec<u8>, usize), String> {
        self.decode(input, ctx).map(|o| (o, input.len()))
    }
}

pub trait ExternType {
    type Value;
    fn size(&self, bytes: &[u8], args: &[Arg]) -> Option<usize>;
    fn read(&self, bytes: &[u8], args: &[Arg]) -> Result<Self::Value, String>;
    fn write(&self, value: &Self::Value, args: &[Arg]) -> Result<Vec<u8>, String>;
}
