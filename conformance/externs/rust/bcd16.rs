//! `extern type Bcd16 : u16 @size(2)`: four BCD digits, most significant first (see ../ts/bcd16.ts).
//! Mapped as `#BCD16`.
use yaffle_runtime::{Arg, ExternType};

pub struct Bcd16;
pub const BCD16: Bcd16 = Bcd16;

impl ExternType for Bcd16 {
    type Value = u16;
    fn size(&self, _bytes: &[u8], _args: &[Arg]) -> Option<usize> {
        Some(2)
    }
    fn read(&self, bytes: &[u8], _args: &[Arg]) -> Result<u16, String> {
        let mut v: u16 = 0;
        for b in &bytes[..2] {
            let (hi, lo) = (b >> 4, b & 0x0f);
            if hi > 9 || lo > 9 {
                return Err(format!("Bcd16: invalid digit in 0x{:x}", b));
            }
            v = v * 100 + (hi as u16) * 10 + lo as u16;
        }
        Ok(v)
    }
    fn write(&self, value: &u16, _args: &[Arg]) -> Result<Vec<u8>, String> {
        let v = *value;
        if v > 9999 {
            return Err(format!("Bcd16: {} out of range", v));
        }
        let d = [v / 1000 % 10, v / 100 % 10, v / 10 % 10, v % 10];
        Ok(vec![((d[0] << 4) | d[1]) as u8, ((d[2] << 4) | d[3]) as u8])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn digits() {
        assert_eq!(BCD16.read(&[0x12, 0x34], &[]).unwrap(), 1234);
        assert_eq!(BCD16.write(&907, &[]).unwrap(), vec![0x09, 0x07]);
        assert!(BCD16.read(&[0x1a, 0x00], &[]).is_err());
        assert!(BCD16.write(&10000, &[]).is_err());
    }
}
