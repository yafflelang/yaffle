//! `extern codec rlez @streaming`: `rle` pairs then a 0x00 terminator (see ../ts/rlez.ts).
//! Mapped as `#RLEZ`; the runtime calls `decode_streaming` for @streaming codecs.
use yaffle::{Codec, CodecCtx};

fn pairs_encode(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < input.len() {
        let b = input[i];
        let mut n = 1;
        while i + n < input.len() && input[i + n] == b && n < 255 {
            n += 1;
        }
        out.push(n as u8);
        out.push(b);
        i += n;
    }
    out
}

pub struct RleZ;
pub const RLEZ: RleZ = RleZ;

impl Codec for RleZ {
    fn decode(&self, input: &[u8], ctx: &CodecCtx) -> Result<Vec<u8>, String> {
        self.decode_streaming(input, ctx).map(|(out, _)| out)
    }
    fn decode_streaming(&self, input: &[u8], ctx: &CodecCtx) -> Result<(Vec<u8>, usize), String> {
        let mut i = 0;
        while i < input.len() && input[i] != 0 {
            i += 2;
        }
        if i >= input.len() {
            return Err("rlez: missing terminator".to_string());
        }
        let mut out = Vec::new();
        for pair in input[..i].chunks(2) {
            out.extend(std::iter::repeat(pair[1]).take(pair[0] as usize));
        }
        if let Some(n) = ctx.output_size {
            if n != out.len() {
                return Err(format!("rlez: decoded {} bytes, expected {}", out.len(), n));
            }
        }
        Ok((out, i + 1))
    }
    fn encode(&self, input: &[u8], _ctx: &CodecCtx) -> Result<Vec<u8>, String> {
        let mut out = pairs_encode(input);
        out.push(0);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminator() {
        let ctx = CodecCtx { args: &[], output_size: None, position: None };
        assert_eq!(RLEZ.encode(&[5, 5], &ctx).unwrap(), vec![2, 5, 0]);
        assert_eq!(RLEZ.decode_streaming(&[2, 5, 0, 0xaa], &ctx).unwrap(), (vec![5, 5], 3));
        assert!(RLEZ.decode_streaming(&[2, 5], &ctx).is_err());
    }
}
