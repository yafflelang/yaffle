//! `extern codec rle`: (count, byte) pairs with count 1..255, greedy encoder (see ../ts/rle.ts).
//! Mapped as `#RLE`.
use yaffle_runtime::{Codec, CodecCtx};

pub fn rle_decode(input: &[u8]) -> Result<Vec<u8>, String> {
    if input.len() % 2 != 0 {
        return Err(format!("rle: odd input length {}", input.len()));
    }
    let mut out = Vec::new();
    for (i, pair) in input.chunks(2).enumerate() {
        if pair[0] == 0 {
            return Err(format!("rle: zero run length at {}", i * 2));
        }
        out.extend(std::iter::repeat(pair[1]).take(pair[0] as usize));
    }
    Ok(out)
}

pub fn rle_encode(input: &[u8]) -> Vec<u8> {
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

pub struct Rle;
pub const RLE: Rle = Rle;

impl Codec for Rle {
    fn decode(&self, input: &[u8], ctx: &CodecCtx) -> Result<Vec<u8>, String> {
        let out = rle_decode(input)?;
        if let Some(n) = ctx.output_size {
            if n != out.len() {
                return Err(format!("rle: decoded {} bytes, expected {}", out.len(), n));
            }
        }
        Ok(out)
    }
    fn encode(&self, input: &[u8], _ctx: &CodecCtx) -> Result<Vec<u8>, String> {
        Ok(rle_encode(input))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runs() {
        let ctx = CodecCtx { args: &[], output_size: None, position: None };
        let mut long = vec![7u8; 256];
        long.push(1);
        assert_eq!(RLE.encode(&long, &ctx).unwrap(), vec![255, 7, 1, 7, 1, 1]);
        let sized = CodecCtx { args: &[], output_size: Some(3), position: None };
        assert_eq!(RLE.decode(&[2, 9, 1, 8], &sized).unwrap(), vec![9, 9, 8]);
        assert!(RLE.decode(&[0, 9], &ctx).is_err());
        assert!(RLE.decode(&[1], &ctx).is_err());
        let wrong = CodecCtx { args: &[], output_size: Some(2), position: None };
        assert!(RLE.decode(&[1, 1], &wrong).is_err());
    }
}
