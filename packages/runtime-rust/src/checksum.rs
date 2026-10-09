//! Built-in checksums: `crc32` (IEEE 802.3, as zlib) and `adler32`.

const fn make_crc_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        t[i] = c;
        i += 1;
    }
    t
}

static CRC_TABLE: [u32; 256] = make_crc_table();

/// CRC-32 (zlib/PNG polynomial, reflected, init and xorout 0xffffffff).
pub fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &b in data {
        c = CRC_TABLE[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    c ^ 0xffff_ffff
}

/// Adler-32 (zlib).
pub fn adler32(data: &[u8]) -> u32 {
    const M: u32 = 65521;
    let (mut a, mut b) = (1u32, 0u32);
    for chunk in data.chunks(5552) {
        for &x in chunk {
            a += x as u32;
            b += a;
        }
        a %= M;
        b %= M;
    }
    (b << 16) | a
}

/// A fast 128-bit content fingerprint (two independent 64-bit multiply-mix hashes), used to
/// detect unchanged decoded content for codec reuse.
pub fn fingerprint(data: &[u8]) -> (u64, u64) {
    const K1: u64 = 0x9e37_79b9_7f4a_7c15;
    const K2: u64 = 0xc2b2_ae3d_27d4_eb4f;
    let mut h1: u64 = 0x243f_6a88_85a3_08d3 ^ data.len() as u64;
    let mut h2: u64 = 0x1319_8a2e_0370_7344 ^ (data.len() as u64).rotate_left(32);
    let (chunks, rest) = data.as_chunks::<8>();
    for c in chunks {
        let w = u64::from_le_bytes(*c);
        h1 = (h1 ^ w).wrapping_mul(K1).rotate_left(29);
        h2 = (h2.rotate_left(17) ^ w).wrapping_mul(K2) ^ (h2 >> 31);
    }
    for (i, &b) in rest.iter().enumerate() {
        h1 = (h1 ^ ((b as u64) << (8 * i))).wrapping_mul(K1);
        h2 = (h2 ^ (b as u64)).wrapping_mul(K2).rotate_left(7);
    }
    let fin = |mut h: u64| {
        h ^= h >> 33;
        h = h.wrapping_mul(0xff51_afd7_ed55_8ccd);
        h ^= h >> 33;
        h = h.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
        h ^ (h >> 33)
    };
    (fin(h1), fin(h2))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_values() {
        assert_eq!(crc32(b""), 0);
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(crc32(b"The quick brown fox jumps over the lazy dog"), 0x414f_a339);
        assert_eq!(adler32(b""), 1);
        assert_eq!(adler32(b"Wikipedia"), 0x11e6_0398);
        let big = vec![0xffu8; 100_000];
        // Reference computed with a naive modular implementation.
        assert_eq!(adler32(&big), 0x149a_302c);
    }

    #[test]
    fn fingerprints_differ() {
        assert_ne!(fingerprint(b"abc"), fingerprint(b"abd"));
        assert_ne!(fingerprint(b""), fingerprint(b"\0"));
        assert_eq!(fingerprint(b"hello world!"), fingerprint(b"hello world!"));
    }
}
