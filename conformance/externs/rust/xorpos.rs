//! `extern codec xorpos(u8 key) @ranged`: byte i of the region XOR `(key + i) & 0xff`, where i
//! counts from the start of the whole encoded region (see ../ts/xorpos.ts). Mapped as `#XORPOS`.
use yaffle_runtime::{Codec, CodecCtx};

fn apply(input: &[u8], ctx: &CodecCtx) -> Result<Vec<u8>, String> {
    let key = ctx
        .args
        .first()
        .and_then(|a| a.as_int())
        .and_then(|k| u8::try_from(k).ok())
        .ok_or("xorpos: key must be a u8")?;
    let pos = ctx.position.unwrap_or(0);
    Ok(input
        .iter()
        .enumerate()
        .map(|(i, b)| b ^ ((key as u64 + pos + i as u64) & 0xff) as u8)
        .collect())
}

pub struct XorPos;
pub const XORPOS: XorPos = XorPos;

impl Codec for XorPos {
    fn decode(&self, input: &[u8], ctx: &CodecCtx) -> Result<Vec<u8>, String> {
        apply(input, ctx)
    }
    fn encode(&self, input: &[u8], ctx: &CodecCtx) -> Result<Vec<u8>, String> {
        apply(input, ctx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yaffle_runtime::Arg;
    #[test]
    fn positions() {
        let args = [Arg::Int(0xfe)];
        let at0 = CodecCtx { args: &args, output_size: None, position: None };
        assert_eq!(XORPOS.encode(&[0, 0, 0], &at0).unwrap(), vec![0xfe, 0xff, 0x00]);
        let at1 = CodecCtx { args: &args, output_size: None, position: Some(1) };
        assert_eq!(XORPOS.decode(&[0, 0], &at1).unwrap(), vec![0xff, 0x00]);
    }
}
