//! Exact integer arithmetic (docs/IR.md §6).
//!
//! Every integer expression is computed in `i128`, which holds every 64-bit value and every
//! product of a 64-bit value with a 63-bit one. Overflowing `i128` (u64 × u64 near the top, or
//! long chains) is a `RANGE` error, as is landing out of range in a typed destination. Generated
//! code uses the `i128` bitwise operators directly: they agree with infinite precision two's
//! complement (like JS `bigint`) for every value that fits a 64-bit destination.

use super::error::{Result, YaffleError};

pub type Int = i128;

#[inline]
fn overflow() -> YaffleError {
    YaffleError::range("integer overflow")
}

#[inline]
pub fn add(a: Int, b: Int) -> Result<Int> {
    a.checked_add(b).ok_or_else(overflow)
}
#[inline]
pub fn sub(a: Int, b: Int) -> Result<Int> {
    a.checked_sub(b).ok_or_else(overflow)
}
#[inline]
pub fn mul(a: Int, b: Int) -> Result<Int> {
    a.checked_mul(b).ok_or_else(overflow)
}
/// Truncating division. Division by zero is a `RANGE` error.
#[inline]
pub fn div(a: Int, b: Int) -> Result<Int> {
    if b == 0 {
        return Err(YaffleError::range("division by zero"));
    }
    a.checked_div(b).ok_or_else(overflow)
}
/// Remainder with the sign of the dividend.
#[inline]
pub fn rem(a: Int, b: Int) -> Result<Int> {
    if b == 0 {
        return Err(YaffleError::range("division by zero"));
    }
    a.checked_rem(b).ok_or_else(overflow)
}
#[inline]
fn shift_count(n: Int) -> Result<u32> {
    if !(0..=63).contains(&n) {
        return Err(YaffleError::range(format!("shift count {n} out of range 0..63")));
    }
    Ok(n as u32)
}
/// Exact left shift (`a * 2^n`).
#[inline]
pub fn shl(a: Int, n: Int) -> Result<Int> {
    let n = shift_count(n)?;
    a.checked_mul(1i128 << n).ok_or_else(overflow)
}
/// Arithmetic right shift.
#[inline]
pub fn shr(a: Int, n: Int) -> Result<Int> {
    let n = shift_count(n)?;
    Ok(a >> n)
}
#[inline]
pub fn neg(a: Int) -> Result<Int> {
    a.checked_neg().ok_or_else(overflow)
}
#[inline]
pub fn abs(a: Int) -> Result<Int> {
    a.checked_abs().ok_or_else(overflow)
}

/// Converts to a typed destination (`u8`…`u64`, `i8`…`i64`, `usize`), with a `RANGE` check.
#[inline]
pub fn to<T: TryFrom<Int>>(v: Int) -> Result<T> {
    T::try_from(v).map_err(|_| YaffleError::range(format!("value {v} out of range for {}", std::any::type_name::<T>())))
}

/// Converts to an unsigned destination of `bits` bits (for u24/u40/u48/u56).
#[inline]
pub fn to_ubits(v: Int, bits: u32) -> Result<u64> {
    if v < 0 || (bits < 64 && v >= (1i128 << bits)) || v > u64::MAX as i128 {
        return Err(YaffleError::range(format!("value {v} out of range for u{bits}")));
    }
    Ok(v as u64)
}

/// Converts to a signed destination of `bits` bits (for i24/i40/i48/i56).
#[inline]
pub fn to_sbits(v: Int, bits: u32) -> Result<i64> {
    let lo = -(1i128 << (bits - 1));
    let hi = (1i128 << (bits - 1)) - 1;
    if v < lo || v > hi {
        return Err(YaffleError::range(format!("value {v} out of range for i{bits}")));
    }
    Ok(v as i64)
}

/// Checks that a value fits a typed integer (`convert` to `int(bits, signed)`), keeping it as `Int`.
#[inline]
pub fn fit(v: Int, bits: u32, signed: bool) -> Result<Int> {
    if signed {
        to_sbits(v, bits.min(64)).map(Int::from)
    } else {
        to_ubits(v, bits.min(64)).map(Int::from)
    }
}

/// A length or count: negative is a `RANGE` error ("negative length").
#[inline]
pub fn len(v: Int) -> Result<usize> {
    if v < 0 {
        return Err(YaffleError::range(format!("negative length {v}")));
    }
    usize::try_from(v).map_err(|_| YaffleError::range(format!("length {v} too large")))
}

/// A float converted to an integer (after `round`): must be finite and in range.
pub fn from_f64(f: f64) -> Result<Int> {
    if !f.is_finite() || f.abs() >= 1.7e38 {
        return Err(YaffleError::range(format!("float {f} cannot be converted to an integer")));
    }
    Ok(f.trunc() as i128)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn exact_arithmetic() {
        assert_eq!(add(u64::MAX as i128, 1).unwrap(), 1i128 << 64);
        assert_eq!(mul(u64::MAX as i128, i64::MAX as i128).unwrap(), (u64::MAX as i128) * (i64::MAX as i128));
        assert_eq!(mul(u64::MAX as i128, u64::MAX as i128).unwrap_err().code, ErrorCode::Range);
        assert_eq!(add(i128::MAX, 1).unwrap_err().code, ErrorCode::Range);
        assert_eq!(sub(0, 5).unwrap(), -5);
    }

    #[test]
    fn division_truncates_and_remainder_follows_dividend() {
        assert_eq!(div(7, 2).unwrap(), 3);
        assert_eq!(div(-7, 2).unwrap(), -3);
        assert_eq!(rem(-7, 2).unwrap(), -1);
        assert_eq!(rem(7, -2).unwrap(), 1);
        assert_eq!(div(1, 0).unwrap_err().code, ErrorCode::Range);
        assert_eq!(rem(1, 0).unwrap_err().code, ErrorCode::Range);
    }

    #[test]
    fn shifts() {
        assert_eq!(shl(1, 63).unwrap(), 1i128 << 63);
        assert_eq!(shl(u64::MAX as i128, 63).unwrap(), (u64::MAX as i128) << 63);
        assert_eq!(shl(1, 64).unwrap_err().code, ErrorCode::Range);
        assert_eq!(shl(1, -1).unwrap_err().code, ErrorCode::Range);
        assert_eq!(shr(-8, 1).unwrap(), -4);
        assert_eq!(shr(-1, 10).unwrap(), -1);
        assert_eq!(shr(256, 4).unwrap(), 16);
    }

    #[test]
    fn destinations() {
        assert_eq!(to::<u8>(255).unwrap(), 255u8);
        assert_eq!(to::<u8>(256).unwrap_err().code, ErrorCode::Range);
        assert_eq!(to::<i8>(-129).unwrap_err().code, ErrorCode::Range);
        assert_eq!(to::<u64>(u64::MAX as i128).unwrap(), u64::MAX);
        assert_eq!(to_ubits(0xff_ffff, 24).unwrap(), 0xff_ffff);
        assert!(to_ubits(0x100_0000, 24).is_err());
        assert!(to_ubits(-1, 24).is_err());
        assert_eq!(to_sbits(-(1 << 23), 24).unwrap(), -(1 << 23));
        assert!(to_sbits(1 << 23, 24).is_err());
        assert_eq!(fit(-1, 8, true).unwrap(), -1);
        assert!(fit(256, 8, false).is_err());
        assert_eq!(len(-1).unwrap_err().code, ErrorCode::Range);
        assert_eq!(len(10).unwrap(), 10);
    }

    #[test]
    fn floats() {
        assert_eq!(from_f64(3.7).unwrap(), 3);
        assert_eq!(from_f64(-3.7).unwrap(), -3);
        assert!(from_f64(f64::NAN).is_err());
    }
}
