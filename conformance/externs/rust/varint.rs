//! `extern type VarInt(u8 maxBytes) : u64`: unsigned LEB128 (see ../ts/varint.ts).
//! Mapped as `#VARINT`: a value implementing `yaffle::ExternType<Value = u64>`.
//! (`size` can't report an error through the trait: a varint longer than `maxBytes` is given the
//! size `maxBytes + 1`, past what `read` accepts, so `read` reports it.)
use yaffle::{Arg, ExternType};

fn max_bytes(args: &[Arg]) -> usize {
    args.first().and_then(|a| a.as_u64()).unwrap_or(10) as usize
}

pub fn size(bytes: &[u8], max: usize) -> Option<usize> {
    for (i, b) in bytes.iter().take(max).enumerate() {
        if *b < 0x80 {
            return Some(i + 1);
        }
    }
    if bytes.len() < max {
        None
    } else {
        Some(max + 1)
    }
}

pub fn read(bytes: &[u8], max: usize) -> Result<u64, String> {
    let mut v: u128 = 0;
    for (i, b) in bytes.iter().take(max).enumerate() {
        v |= ((b & 0x7f) as u128) << (7 * i);
        if *b < 0x80 {
            return u64::try_from(v).map_err(|_| "VarInt: value exceeds u64".to_string());
        }
    }
    Err(format!("VarInt: longer than {max} bytes"))
}

pub fn write(value: u64, max: usize) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut v = value;
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            break;
        }
        out.push(b | 0x80);
    }
    if out.len() > max {
        return Err(format!("VarInt: {} needs {} bytes, more than {}", value, out.len(), max));
    }
    Ok(out)
}

pub struct VarInt;
pub const VARINT: VarInt = VarInt;

impl ExternType for VarInt {
    type Value = u64;
    fn size(&self, bytes: &[u8], args: &[Arg]) -> Option<usize> {
        size(bytes, max_bytes(args))
    }
    fn read(&self, bytes: &[u8], args: &[Arg]) -> Result<u64, String> {
        read(bytes, max_bytes(args))
    }
    fn write(&self, value: &u64, args: &[Arg]) -> Result<Vec<u8>, String> {
        write(*value, max_bytes(args))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn leb128() {
        let a10 = [Arg::Int(10)];
        assert_eq!(VARINT.write(&300, &a10).unwrap(), vec![0xac, 0x02]);
        assert_eq!(VARINT.read(&[0xac, 0x02], &a10).unwrap(), 300);
        assert_eq!(VARINT.size(&[0xac, 0x02, 0x99], &a10), Some(2));
        assert_eq!(VARINT.size(&[0xac], &a10), None);
        let a2 = [Arg::Int(2)];
        assert_eq!(VARINT.size(&[0x80, 0x80], &a2), Some(3));
        assert!(VARINT.read(&[0x80, 0x80, 0x01], &a2).is_err());
        assert!(VARINT.write(&(1 << 14), &a2).is_err());
        let max = VARINT.write(&u64::MAX, &a10).unwrap();
        assert_eq!(max.len(), 10);
        assert_eq!(VARINT.read(&max, &a10).unwrap(), u64::MAX);
    }
}
