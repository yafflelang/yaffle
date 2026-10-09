//! Test codecs and extern types for the Rust backend tests.
use yaffle_runtime as yr;

/// `xor(key)`: XOR every byte with the key argument (default 0x5a).
pub struct Xor;
pub const XOR: Xor = Xor;

impl yr::Codec for Xor {
    fn decode(&self, input: &[u8], ctx: &yr::CodecCtx) -> Result<Vec<u8>, String> {
        let k = ctx.args.first().and_then(|a| a.as_u64()).unwrap_or(0x5a) as u8;
        Ok(input.iter().map(|b| b ^ k).collect())
    }
    fn encode(&self, input: &[u8], ctx: &yr::CodecCtx) -> Result<Vec<u8>, String> {
        self.decode(input, ctx)
    }
}

/// Raw DEFLATE (RFC 1951). Decoding finds its own end (`@streaming`).
pub struct Inflate;
pub const INFLATE: Inflate = Inflate;

impl yr::Codec for Inflate {
    fn decode(&self, input: &[u8], ctx: &yr::CodecCtx) -> Result<Vec<u8>, String> {
        let (out, used) = inflate(input)?;
        if used != input.len() {
            return Err(format!("{} bytes after the end of the deflate stream", input.len() - used));
        }
        if let Some(n) = ctx.output_size {
            if n != out.len() {
                return Err(format!("decoded {} bytes, expected {n}", out.len()));
            }
        }
        Ok(out)
    }
    fn decode_streaming(&self, input: &[u8], _ctx: &yr::CodecCtx) -> Result<(Vec<u8>, usize), String> {
        inflate(input)
    }
    fn encode(&self, input: &[u8], _ctx: &yr::CodecCtx) -> Result<Vec<u8>, String> {
        Ok(deflate(input))
    }
}

/// A codec whose encoder is not stable: it appends a stored empty block, so re-encoding
/// never reproduces the original bytes. Tests codec reuse.
pub struct Noisy;
pub const NOISY: Noisy = Noisy;

impl yr::Codec for Noisy {
    fn decode(&self, input: &[u8], ctx: &yr::CodecCtx) -> Result<Vec<u8>, String> {
        Inflate.decode(input, ctx)
    }
    fn encode(&self, input: &[u8], _ctx: &yr::CodecCtx) -> Result<Vec<u8>, String> {
        // A stored (uncompressed) final block: valid deflate, but different from zlib's output.
        let mut out = Vec::new();
        let chunks: Vec<&[u8]> = if input.is_empty() { vec![&[][..]] } else { input.chunks(65535).collect() };
        for (i, c) in chunks.iter().enumerate() {
            out.push(if i + 1 == chunks.len() { 1 } else { 0 });
            out.extend_from_slice(&(c.len() as u16).to_le_bytes());
            out.extend_from_slice(&(!(c.len() as u16)).to_le_bytes());
            out.extend_from_slice(c);
        }
        Ok(out)
    }
}

/// A codec that always fails (CODEC errors).
pub struct Broken;
pub const BROKEN: Broken = Broken;

impl yr::Codec for Broken {
    fn decode(&self, _input: &[u8], _ctx: &yr::CodecCtx) -> Result<Vec<u8>, String> {
        Err("broken codec".into())
    }
    fn encode(&self, _input: &[u8], _ctx: &yr::CodecCtx) -> Result<Vec<u8>, String> {
        Err("broken codec".into())
    }
}

/// `extern type VarInt : u64` (unsigned LEB128).
pub struct VarInt;
pub const VARINT: VarInt = VarInt;

impl yr::ExternType for VarInt {
    type Value = u64;
    fn size(&self, bytes: &[u8], _args: &[yr::Arg]) -> Option<usize> {
        bytes.iter().position(|b| b & 0x80 == 0).map(|p| p + 1)
    }
    fn read(&self, bytes: &[u8], _args: &[yr::Arg]) -> Result<u64, String> {
        let mut v: u64 = 0;
        for (i, b) in bytes.iter().enumerate() {
            v |= ((b & 0x7f) as u64) << (7 * i);
        }
        Ok(v)
    }
    fn write(&self, value: &u64, _args: &[yr::Arg]) -> Result<Vec<u8>, String> {
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

/// `extern type Fixed8(u8 scale) : f64 @size(2)`: a 2-byte fixed point value divided by `scale`.
pub struct Fixed;
pub const FIXED: Fixed = Fixed;

impl yr::ExternType for Fixed {
    type Value = f64;
    fn size(&self, _bytes: &[u8], _args: &[yr::Arg]) -> Option<usize> {
        Some(2)
    }
    fn read(&self, bytes: &[u8], args: &[yr::Arg]) -> Result<f64, String> {
        let scale = args.first().and_then(|a| a.as_f64()).unwrap_or(1.0);
        Ok(i16::from_le_bytes([bytes[0], bytes[1]]) as f64 / scale)
    }
    fn write(&self, value: &f64, args: &[yr::Arg]) -> Result<Vec<u8>, String> {
        let scale = args.first().and_then(|a| a.as_f64()).unwrap_or(1.0);
        let v = (value * scale).round();
        if v < i16::MIN as f64 || v > i16::MAX as f64 {
            return Err("fixed point value out of range".into());
        }
        Ok((v as i16).to_le_bytes().to_vec())
    }
}

// ─── Raw DEFLATE ─────────────────────────────────────────────────────────────

const LBASE: [u16; 29] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT: [u8; 29] = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE: [u16; 30] = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT: [u8; 30] = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
    bit: u32,
}

impl Bits<'_> {
    fn bits(&mut self, n: u32) -> Result<u32, String> {
        let mut v = 0u32;
        for i in 0..n {
            let byte = *self.data.get(self.pos).ok_or("unexpected end of deflate data")?;
            v |= (((byte >> self.bit) & 1) as u32) << i;
            self.bit += 1;
            if self.bit == 8 {
                self.bit = 0;
                self.pos += 1;
            }
        }
        Ok(v)
    }
    fn align(&mut self) {
        if self.bit != 0 {
            self.bit = 0;
            self.pos += 1;
        }
    }
}

struct Huff {
    counts: [u16; 16],
    symbols: Vec<u16>,
}

fn huff(lengths: &[u8]) -> Huff {
    let mut counts = [0u16; 16];
    for &l in lengths {
        counts[l as usize] += 1;
    }
    counts[0] = 0;
    let mut offs = [0u16; 16];
    for l in 1..15 {
        offs[l + 1] = offs[l] + counts[l];
    }
    let mut symbols = vec![0u16; lengths.len()];
    for (s, &l) in lengths.iter().enumerate() {
        if l != 0 {
            symbols[offs[l as usize] as usize] = s as u16;
            offs[l as usize] += 1;
        }
    }
    Huff { counts, symbols }
}

fn decode(b: &mut Bits, h: &Huff) -> Result<u16, String> {
    let (mut code, mut first, mut index) = (0i32, 0i32, 0i32);
    for len in 1..16 {
        code |= b.bits(1)? as i32;
        let count = h.counts[len] as i32;
        if code - count < first {
            return Ok(h.symbols[(index + (code - first)) as usize]);
        }
        index += count;
        first += count;
        first <<= 1;
        code <<= 1;
    }
    Err("bad huffman code".into())
}

fn block(b: &mut Bits, out: &mut Vec<u8>, lit: &Huff, dist: &Huff) -> Result<(), String> {
    loop {
        let sym = decode(b, lit)?;
        if sym < 256 {
            out.push(sym as u8);
        } else if sym == 256 {
            return Ok(());
        } else {
            let i = (sym - 257) as usize;
            if i >= 29 {
                return Err("bad length symbol".into());
            }
            let len = LBASE[i] as usize + b.bits(LEXT[i] as u32)? as usize;
            let ds = decode(b, dist)? as usize;
            if ds >= 30 {
                return Err("bad distance symbol".into());
            }
            let d = DBASE[ds] as usize + b.bits(DEXT[ds] as u32)? as usize;
            if d > out.len() {
                return Err("distance too far back".into());
            }
            let start = out.len() - d;
            for k in 0..len {
                let x = out[start + k];
                out.push(x);
            }
        }
    }
}

/// Inflates raw deflate data; returns the output and the number of input bytes used.
pub fn inflate(input: &[u8]) -> Result<(Vec<u8>, usize), String> {
    let mut b = Bits { data: input, pos: 0, bit: 0 };
    let mut out = Vec::new();
    loop {
        let last = b.bits(1)?;
        match b.bits(2)? {
            0 => {
                b.align();
                let d = b.data;
                if b.pos + 4 > d.len() {
                    return Err("truncated stored block".into());
                }
                let len = u16::from_le_bytes([d[b.pos], d[b.pos + 1]]) as usize;
                let nlen = u16::from_le_bytes([d[b.pos + 2], d[b.pos + 3]]) as usize;
                if len != (!nlen & 0xffff) {
                    return Err("bad stored block length".into());
                }
                b.pos += 4;
                if b.pos + len > d.len() {
                    return Err("truncated stored block".into());
                }
                out.extend_from_slice(&d[b.pos..b.pos + len]);
                b.pos += len;
            }
            1 => {
                let mut l = [0u8; 288];
                for (i, x) in l.iter_mut().enumerate() {
                    *x = if i < 144 { 8 } else if i < 256 { 9 } else if i < 280 { 7 } else { 8 };
                }
                block(&mut b, &mut out, &huff(&l), &huff(&[5u8; 30]))?;
            }
            2 => {
                let hlit = b.bits(5)? as usize + 257;
                let hdist = b.bits(5)? as usize + 1;
                let hclen = b.bits(4)? as usize + 4;
                const ORDER: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
                let mut cl = [0u8; 19];
                for &o in ORDER.iter().take(hclen) {
                    cl[o] = b.bits(3)? as u8;
                }
                let clh = huff(&cl);
                let mut lengths = Vec::with_capacity(hlit + hdist);
                while lengths.len() < hlit + hdist {
                    let sym = decode(&mut b, &clh)?;
                    match sym {
                        0..=15 => lengths.push(sym as u8),
                        16 => {
                            let prev = *lengths.last().ok_or("repeat without a previous length")?;
                            for _ in 0..3 + b.bits(2)? {
                                lengths.push(prev);
                            }
                        }
                        17 => {
                            for _ in 0..3 + b.bits(3)? {
                                lengths.push(0);
                            }
                        }
                        _ => {
                            for _ in 0..11 + b.bits(7)? {
                                lengths.push(0);
                            }
                        }
                    }
                }
                block(&mut b, &mut out, &huff(&lengths[..hlit]), &huff(&lengths[hlit..hlit + hdist]))?;
            }
            _ => return Err("bad block type".into()),
        }
        if last == 1 {
            break;
        }
    }
    b.align();
    Ok((out, b.pos))
}

struct BitW {
    out: Vec<u8>,
    acc: u32,
    n: u32,
}

impl BitW {
    fn put(&mut self, v: u32, bits: u32) {
        for i in 0..bits {
            self.acc |= ((v >> i) & 1) << self.n;
            self.n += 1;
            if self.n == 8 {
                self.out.push(self.acc as u8);
                self.acc = 0;
                self.n = 0;
            }
        }
    }
    /// A Huffman code, most significant bit first.
    fn code(&mut self, code: u32, len: u32) {
        for i in (0..len).rev() {
            self.put((code >> i) & 1, 1);
        }
    }
    fn lit(&mut self, v: u32) {
        match v {
            0..=143 => self.code(0x30 + v, 8),
            144..=255 => self.code(0x190 + v - 144, 9),
            256..=279 => self.code(v - 256, 7),
            _ => self.code(0xc0 + v - 280, 8),
        }
    }
}

/// Deflates with fixed Huffman codes and greedy LZ77 (deterministic).
pub fn deflate(input: &[u8]) -> Vec<u8> {
    let mut w = BitW { out: Vec::new(), acc: 0, n: 0 };
    w.put(1, 1);
    w.put(1, 2);
    let mut head: std::collections::HashMap<[u8; 3], Vec<usize>> = std::collections::HashMap::new();
    let mut i = 0;
    while i < input.len() {
        let mut best = (0usize, 0usize);
        if i + 3 <= input.len() {
            let key = [input[i], input[i + 1], input[i + 2]];
            if let Some(cands) = head.get(&key) {
                for &j in cands.iter().rev().take(32) {
                    if i - j > 32768 {
                        break;
                    }
                    let mut l = 0;
                    while l < 258 && i + l < input.len() && input[j + l] == input[i + l] {
                        l += 1;
                    }
                    if l > best.0 {
                        best = (l, i - j);
                    }
                }
            }
        }
        let step = if best.0 >= 3 {
            let (len, dist) = best;
            let li = LBASE.iter().rposition(|&b| b as usize <= len).unwrap();
            w.lit(257 + li as u32);
            w.put((len - LBASE[li] as usize) as u32, LEXT[li] as u32);
            let di = DBASE.iter().rposition(|&b| b as usize <= dist).unwrap();
            w.code(di as u32, 5);
            w.put((dist - DBASE[di] as usize) as u32, DEXT[di] as u32);
            len
        } else {
            w.lit(input[i] as u32);
            1
        };
        for k in i..(i + step).min(input.len().saturating_sub(2)) {
            head.entry([input[k], input[k + 1], input[k + 2]]).or_default().push(k);
        }
        i += step;
    }
    w.lit(256);
    if w.n > 0 {
        w.out.push(w.acc as u8);
    }
    w.out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deflate_roundtrip() {
        let data: Vec<u8> = (0..5000u32).map(|i| ((i * 7) % 13) as u8).collect();
        let enc = deflate(&data);
        assert!(enc.len() < data.len());
        let (dec, used) = inflate(&enc).unwrap();
        assert_eq!(dec, data);
        assert_eq!(used, enc.len());
        assert_eq!(inflate(&deflate(b"")).unwrap().0, b"");
    }
}
