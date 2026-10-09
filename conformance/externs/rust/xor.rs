//! `extern codec xor(u8 key) @ranged`: every byte XOR `key` (see ../ts/xor.ts).
//! Mapped as `"…/xor.rs#XOR"`: a value implementing `yaffle_runtime::Codec`.
use yaffle_runtime::{Arg, Codec, CodecCtx};

pub fn key_arg(args: &[Arg], name: &str) -> Result<u8, String> {
    args.first()
        .and_then(|a| a.as_int())
        .and_then(|k| u8::try_from(k).ok())
        .ok_or_else(|| format!("{name}: key must be a u8"))
}

pub fn apply(input: &[u8], key: u8) -> Vec<u8> {
    input.iter().map(|b| b ^ key).collect()
}

pub struct Xor;
pub const XOR: Xor = Xor;

impl Codec for Xor {
    fn decode(&self, input: &[u8], ctx: &CodecCtx) -> Result<Vec<u8>, String> {
        let out = apply(input, key_arg(ctx.args, "xor")?);
        if let Some(n) = ctx.output_size {
            if n != out.len() {
                return Err(format!("xor: decoded {} bytes, expected {}", out.len(), n));
            }
        }
        Ok(out)
    }
    fn encode(&self, input: &[u8], ctx: &CodecCtx) -> Result<Vec<u8>, String> {
        Ok(apply(input, key_arg(ctx.args, "xor")?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip() {
        let args = [Arg::Int(0x5a)];
        let ctx = CodecCtx { args: &args, output_size: Some(3), position: None };
        let e = XOR.encode(&[1, 2, 3], &ctx).unwrap();
        assert_eq!(e, vec![0x5b, 0x58, 0x59]);
        assert_eq!(XOR.decode(&e, &ctx).unwrap(), vec![1, 2, 3]);
        let bad = CodecCtx { args: &args, output_size: Some(4), position: None };
        assert!(XOR.decode(&e, &bad).is_err());
        let wide = [Arg::Int(256)];
        assert!(XOR.encode(&[0], &CodecCtx { args: &wide, output_size: None, position: None }).is_err());
    }
}
