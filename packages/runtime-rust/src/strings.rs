//! Text encodings: utf8, ascii, latin1 (1-byte units), utf16 (2-byte), utf32 (4-byte).

use super::prim::{get_uint, put_uint, Endian};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Encoding {
    Utf8,
    Ascii,
    Latin1,
    Utf16,
    Utf32,
}

impl Encoding {
    pub fn unit(self) -> usize {
        match self {
            Encoding::Utf8 | Encoding::Ascii | Encoding::Latin1 => 1,
            Encoding::Utf16 => 2,
            Encoding::Utf32 => 4,
        }
    }
}

/// Position of the first NUL unit in `b` (whole units), or `None`.
pub fn find_nul(b: &[u8], unit: usize) -> Option<usize> {
    match unit {
        1 => b.iter().position(|&x| x == 0),
        _ => b.chunks_exact(unit).position(|c| c.iter().all(|&x| x == 0)).map(|i| i * unit),
    }
}

/// Decodes whole code units (no NUL handling). Errors describe invalid data.
pub fn decode(b: &[u8], enc: Encoding, e: Endian) -> Result<String, String> {
    match enc {
        Encoding::Utf8 => std::str::from_utf8(b).map(|s| s.to_string()).map_err(|_| "invalid UTF-8".to_string()),
        Encoding::Ascii => {
            if let Some(p) = b.iter().position(|&x| x >= 0x80) {
                return Err(format!("non-ASCII byte 0x{:02x} at {}", b[p], p));
            }
            Ok(b.iter().map(|&x| x as char).collect())
        }
        Encoding::Latin1 => Ok(b.iter().map(|&x| x as char).collect()),
        Encoding::Utf16 => {
            if !b.len().is_multiple_of(2) {
                return Err("odd number of bytes in UTF-16 text".into());
            }
            let units: Vec<u16> = b.as_chunks::<2>().0.iter().map(|c| get_uint(c, 2, e) as u16).collect();
            String::from_utf16(&units).map_err(|_| "invalid UTF-16".to_string())
        }
        Encoding::Utf32 => {
            if !b.len().is_multiple_of(4) {
                return Err("byte count not a multiple of 4 in UTF-32 text".into());
            }
            let mut s = String::with_capacity(b.len() / 4);
            for c in b.as_chunks::<4>().0 {
                let cp = get_uint(c, 4, e) as u32;
                s.push(char::from_u32(cp).ok_or_else(|| format!("invalid UTF-32 code point 0x{cp:x}"))?);
            }
            Ok(s)
        }
    }
}

/// Encodes text as code units. Errors: characters the encoding can't represent, and NUL
/// characters (they would end the text on read).
pub fn encode(s: &str, enc: Encoding, e: Endian) -> Result<Vec<u8>, String> {
    if s.contains('\0') {
        return Err("text contains a NUL character".into());
    }
    match enc {
        Encoding::Utf8 => Ok(s.as_bytes().to_vec()),
        Encoding::Ascii => {
            let mut out = Vec::with_capacity(s.len());
            for c in s.chars() {
                if (c as u32) >= 0x80 {
                    return Err(format!("character {c:?} is not ASCII"));
                }
                out.push(c as u8);
            }
            Ok(out)
        }
        Encoding::Latin1 => {
            let mut out = Vec::with_capacity(s.len());
            for c in s.chars() {
                if (c as u32) > 0xff {
                    return Err(format!("character {c:?} is not Latin-1"));
                }
                out.push(c as u32 as u8);
            }
            Ok(out)
        }
        Encoding::Utf16 => {
            let mut out = Vec::with_capacity(s.len() * 2);
            for u in s.encode_utf16() {
                put_uint(&mut out, u as u64, 2, e);
            }
            Ok(out)
        }
        Encoding::Utf32 => {
            let mut out = Vec::with_capacity(s.len() * 4);
            for c in s.chars() {
                put_uint(&mut out, c as u64, 4, e);
            }
            Ok(out)
        }
    }
}

/// Number of code units `s` takes in an encoding (`encodedLength`).
pub fn unit_count(s: &str, enc: Encoding) -> usize {
    match enc {
        Encoding::Utf8 => s.len(),
        Encoding::Ascii | Encoding::Latin1 | Encoding::Utf32 => s.chars().count(),
        Encoding::Utf16 => s.encode_utf16().count(),
    }
}

/// `len(string)`: UTF-16 code units, like JS `string.length`.
pub fn js_length(s: &str) -> usize {
    s.encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips() {
        for enc in [Encoding::Utf8, Encoding::Utf16, Encoding::Utf32] {
            for e in [Endian::Le, Endian::Be] {
                let s = "héllo 😀";
                let b = encode(s, enc, e).unwrap();
                assert_eq!(b.len() % enc.unit(), 0);
                assert_eq!(decode(&b, enc, e).unwrap(), s);
                assert_eq!(unit_count(s, enc) * enc.unit(), b.len());
            }
        }
        assert_eq!(encode("é", Encoding::Latin1, Endian::Le).unwrap(), vec![0xe9]);
        assert_eq!(decode(&[0xe9], Encoding::Latin1, Endian::Le).unwrap(), "é");
        assert!(encode("€", Encoding::Latin1, Endian::Le).is_err());
        assert!(encode("é", Encoding::Ascii, Endian::Le).is_err());
        assert!(decode(&[0x80], Encoding::Ascii, Endian::Le).is_err());
        assert!(decode(&[0xff, 0xfe], Encoding::Utf8, Endian::Le).is_err());
        assert!(decode(&[0x00, 0xd8], Encoding::Utf16, Endian::Le).is_err()); // lone surrogate
        assert!(decode(&[0x00, 0x00, 0x11, 0x00], Encoding::Utf32, Endian::Le).is_err());
        assert!(encode("a\0b", Encoding::Utf8, Endian::Le).is_err());
        assert_eq!(encode("AB", Encoding::Utf16, Endian::Be).unwrap(), vec![0, 0x41, 0, 0x42]);
    }

    #[test]
    fn nul_search() {
        assert_eq!(find_nul(b"ab\0cd", 1), Some(2));
        assert_eq!(find_nul(&[0x41, 0, 0, 0, 0x42, 0], 2), Some(2));
        assert_eq!(find_nul(&[0, 0x41, 0x42, 0], 2), None);
        assert_eq!(js_length("😀a"), 3);
    }
}
