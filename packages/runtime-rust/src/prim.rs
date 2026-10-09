//! Primitive encodings: N-byte integers in either byte order, IEEE half floats.

/// Byte order. The root defaults to little endian.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Endian {
    #[default]
    Le,
    Be,
}

impl Endian {
    pub fn as_str(self) -> &'static str {
        match self {
            Endian::Le => "le",
            Endian::Be => "be",
        }
    }
    pub fn from_name(s: &str) -> Option<Endian> {
        match s {
            "le" => Some(Endian::Le),
            "be" => Some(Endian::Be),
            _ => None,
        }
    }
}

/// Reads an unsigned `n`-byte integer (1 ≤ n ≤ 8) from the start of `b`.
#[inline]
pub fn get_uint(b: &[u8], n: usize, e: Endian) -> u64 {
    let mut v: u64 = 0;
    match e {
        Endian::Le => {
            for i in (0..n).rev() {
                v = (v << 8) | b[i] as u64;
            }
        }
        Endian::Be => {
            for &x in &b[..n] {
                v = (v << 8) | x as u64;
            }
        }
    }
    v
}

/// Sign-extends the low `bits` bits of `v`.
#[inline]
pub fn sign_extend(v: u64, bits: u32) -> i64 {
    if bits >= 64 {
        return v as i64;
    }
    let shift = 64 - bits;
    ((v << shift) as i64) >> shift
}

/// Appends the low `n` bytes of `v`.
#[inline]
pub fn put_uint(out: &mut Vec<u8>, v: u64, n: usize, e: Endian) {
    match e {
        Endian::Le => {
            for i in 0..n {
                out.push((v >> (8 * i)) as u8);
            }
        }
        Endian::Be => {
            for i in (0..n).rev() {
                out.push((v >> (8 * i)) as u8);
            }
        }
    }
}

/// The low `n` bytes of `v` as a vector.
#[inline]
pub fn enc_uint(v: u64, n: usize, e: Endian) -> Vec<u8> {
    let mut out = Vec::with_capacity(n);
    put_uint(&mut out, v, n, e);
    out
}

/// IEEE 754 binary16 → f32 (exact).
pub fn f16_to_f32(h: u16) -> f32 {
    let sign = ((h >> 15) & 1) as u32;
    let exp = ((h >> 10) & 0x1f) as u32;
    let frac = (h & 0x3ff) as u32;
    let bits = if exp == 0 {
        if frac == 0 {
            sign << 31
        } else {
            // Subnormal: normalize.
            let mut e: i32 = -14;
            let mut f = frac;
            while f & 0x400 == 0 {
                f <<= 1;
                e -= 1;
            }
            f &= 0x3ff;
            (sign << 31) | (((e + 127) as u32) << 23) | (f << 13)
        }
    } else if exp == 0x1f {
        (sign << 31) | (0xff << 23) | (frac << 13)
    } else {
        (sign << 31) | ((exp + 127 - 15) << 23) | (frac << 13)
    };
    f32::from_bits(bits)
}

/// f64 → IEEE 754 binary16, rounding to nearest even. Overflow gives ±Infinity.
pub fn f64_to_f16(x: f64) -> u16 {
    let bits = x.to_bits();
    let sign = ((bits >> 63) as u16) << 15;
    let exp = ((bits >> 52) & 0x7ff) as i32;
    let frac = bits & ((1u64 << 52) - 1);
    if exp == 0x7ff {
        if frac == 0 {
            return sign | 0x7c00;
        }
        // NaN: keep the top payload bits, force quiet.
        let payload = ((frac >> 42) as u16) & 0x3ff;
        return sign | 0x7c00 | 0x200 | payload;
    }
    if exp == 0 && frac == 0 {
        return sign;
    }
    // Unbiased exponent and 53-bit significand.
    let (e, sig) = if exp == 0 { (-1022, frac) } else { (exp - 1023, frac | (1u64 << 52)) };
    if e > 15 {
        return sign | 0x7c00;
    }
    // Target: value = sig * 2^(e-52). Half normal: 1.f * 2^(E-15), E in 1..30 ; subnormal: f * 2^-24.
    let (half_exp, shift) = if e >= -14 {
        ((e + 15) as u32, 52 - 10)
    } else {
        // Subnormal half: significand = value / 2^-24.
        (0u32, (52 - 10) + (-14 - e) as u32)
    };
    if shift >= 64 {
        return sign;
    }
    let mut m = sig >> shift;
    let rest = sig & ((1u64 << shift) - 1);
    let halfway = 1u64 << (shift - 1);
    if rest > halfway || (rest == halfway && (m & 1) == 1) {
        m += 1;
    }
    let mut he = half_exp;
    if he == 0 {
        // Subnormal (may round up into the smallest normal, which the bit layout handles).
        return sign | (m as u16);
    }
    // m includes the implicit bit (0x400). Rounding may carry into 0x800.
    if m & 0x800 != 0 {
        m >>= 1;
        he += 1;
    }
    if he >= 31 {
        return sign | 0x7c00;
    }
    sign | ((he as u16) << 10) | ((m as u16) & 0x3ff)
}

/// f32 → binary16 (via f64, exact).
pub fn f32_to_f16(x: f32) -> u16 {
    f64_to_f16(x as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uint_roundtrip_all_widths() {
        for n in 1..=8usize {
            for e in [Endian::Le, Endian::Be] {
                let v: u64 = 0x0102_0304_0506_0708u64 & if n == 8 { u64::MAX } else { (1u64 << (8 * n)) - 1 };
                let b = enc_uint(v, n, e);
                assert_eq!(b.len(), n);
                assert_eq!(get_uint(&b, n, e), v);
            }
        }
        assert_eq!(enc_uint(0x010203, 3, Endian::Le), vec![3, 2, 1]);
        assert_eq!(enc_uint(0x010203, 3, Endian::Be), vec![1, 2, 3]);
    }

    #[test]
    fn sign_extension() {
        assert_eq!(sign_extend(0xff_ffff, 24), -1);
        assert_eq!(sign_extend(0x7f_ffff, 24), 0x7f_ffff);
        assert_eq!(sign_extend(0x80_0000_0000, 40), -(1i64 << 39));
        assert_eq!(sign_extend(u64::MAX, 64), -1);
    }

    #[test]
    fn half_floats() {
        assert_eq!(f16_to_f32(0x3c00), 1.0);
        assert_eq!(f16_to_f32(0xc000), -2.0);
        assert_eq!(f16_to_f32(0x7bff), 65504.0);
        assert_eq!(f16_to_f32(0x0001), 2f32.powi(-24));
        assert_eq!(f16_to_f32(0x0400), 2f32.powi(-14));
        assert!(f16_to_f32(0x7e00).is_nan());
        assert_eq!(f16_to_f32(0x7c00), f32::INFINITY);
        assert_eq!(f16_to_f32(0x8000).to_bits(), (-0.0f32).to_bits());
        // Every half value round-trips.
        for h in 0..=0xffffu16 {
            let f = f16_to_f32(h);
            let back = f32_to_f16(f);
            if f.is_nan() {
                assert!(f16_to_f32(back).is_nan());
            } else {
                assert_eq!(back, h, "h={h:#x} f={f}");
            }
        }
        // Rounding to nearest even.
        assert_eq!(f64_to_f16(1.0 + 1.0 / 2048.0), 0x3c00); // halfway, even stays
        assert_eq!(f64_to_f16(1.0 + 3.0 / 2048.0), 0x3c02); // halfway, odd rounds up
        assert_eq!(f64_to_f16(1e6), 0x7c00);
        assert_eq!(f64_to_f16(1e-10), 0);
    }
}
