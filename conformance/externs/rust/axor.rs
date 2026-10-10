//! `extern async codec axor(u8 key)`: the same transform as `xor` (see ../ts/axor.ts).
//! The Rust runtime calls async codecs through the same synchronous `Codec` trait, so this is
//! `xor` under another name: an async codec must give the same bytes as its sync twin.
//! Mapped as `#AXOR`.
use yaffle::{Codec, CodecCtx};

fn apply(input: &[u8], ctx: &CodecCtx) -> Result<Vec<u8>, String> {
    let key = ctx
        .args
        .first()
        .and_then(|a| a.as_int())
        .and_then(|k| u8::try_from(k).ok())
        .ok_or("axor: key must be a u8")?;
    Ok(input.iter().map(|b| b ^ key).collect())
}

pub struct AXor;
pub const AXOR: AXor = AXor;

impl Codec for AXor {
    fn decode(&self, input: &[u8], ctx: &CodecCtx) -> Result<Vec<u8>, String> {
        let out = apply(input, ctx)?;
        if let Some(n) = ctx.output_size {
            if n != out.len() {
                return Err(format!("axor: decoded {} bytes, expected {}", out.len(), n));
            }
        }
        Ok(out)
    }
    fn encode(&self, input: &[u8], ctx: &CodecCtx) -> Result<Vec<u8>, String> {
        apply(input, ctx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yaffle::Arg;
    #[test]
    fn same_as_xor() {
        let args = [Arg::Int(0x0f)];
        let ctx = CodecCtx { args: &args, output_size: None, position: None };
        assert_eq!(AXOR.encode(&[0xff], &ctx).unwrap(), vec![0xf0]);
    }
}
