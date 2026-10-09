package yaffle

import (
	"math"
	"math/big"
)

// Endian is a byte order. The zero value is little endian (the root default).
type Endian uint8

// Byte orders.
const (
	LE Endian = 0
	BE Endian = 1
)

func (e Endian) String() string {
	if e == BE {
		return "be"
	}
	return "le"
}

// Prim identifies a primitive encoding.
type Prim uint8

// Primitive kinds.
const (
	U8 Prim = iota
	U16
	U24
	U32
	U40
	U48
	U56
	U64
	I8
	I16
	I24
	I32
	I40
	I48
	I56
	I64
	F16
	F32
	F64
)

var primNames = [...]string{"u8", "u16", "u24", "u32", "u40", "u48", "u56", "u64", "i8", "i16", "i24", "i32", "i40", "i48", "i56", "i64", "f16", "f32", "f64"}

func (p Prim) String() string { return primNames[p] }

// Size is the encoded size in bytes.
func (p Prim) Size() int {
	switch p {
	case U8, I8:
		return 1
	case U16, I16, F16:
		return 2
	case U24, I24:
		return 3
	case U32, I32, F32:
		return 4
	case U40, I40:
		return 5
	case U48, I48:
		return 6
	case U56, I56:
		return 7
	default:
		return 8
	}
}

// Signed reports whether the primitive is a signed integer.
func (p Prim) Signed() bool { return p >= I8 && p <= I64 }

// Bits is the width in bits.
func (p Prim) Bits() int { return p.Size() * 8 }

func (p Prim) minI64() int64 {
	if !p.Signed() {
		return 0
	}
	return -(int64(1) << (p.Bits() - 1))
}

func (p Prim) maxU64() uint64 {
	if p.Signed() {
		return uint64(1)<<(p.Bits()-1) - 1
	}
	if p.Bits() == 64 {
		return math.MaxUint64
	}
	return uint64(1)<<p.Bits() - 1
}

// ── raw integer access ──────────────────────────────────────────────────────

// GetUint reads an unsigned integer of n bytes (1..8).
func GetUint(b []byte, n int, le bool) uint64 {
	var v uint64
	if le {
		for i := n - 1; i >= 0; i-- {
			v = v<<8 | uint64(b[i])
		}
	} else {
		for i := 0; i < n; i++ {
			v = v<<8 | uint64(b[i])
		}
	}
	return v
}

// PutUint writes the low n bytes of v.
func PutUint(b []byte, n int, v uint64, le bool) {
	for i := 0; i < n; i++ {
		if le {
			b[i] = byte(v)
		} else {
			b[n-1-i] = byte(v)
		}
		v >>= 8
	}
}

// SignExtend sign-extends the low `bits` bits of v.
func SignExtend(v uint64, bits int) int64 {
	shift := 64 - bits
	return int64(v<<shift) >> shift
}

// ── half precision ──────────────────────────────────────────────────────────

// HalfToFloat converts IEEE 754 binary16 bits to a float32 (exact).
func HalfToFloat(h uint16) float32 {
	sign := float64(1)
	if h&0x8000 != 0 {
		sign = -1
	}
	exp := int(h>>10) & 0x1f
	frac := float64(h & 0x3ff)
	switch exp {
	case 0:
		return float32(sign * frac * math.Ldexp(1, -24))
	case 0x1f:
		if frac != 0 {
			return float32(math.NaN())
		}
		return float32(math.Inf(int(sign)))
	}
	return float32(sign * (1 + frac/1024) * math.Ldexp(1, exp-15))
}

// FloatToHalf converts a float64 to binary16 bits, rounding to nearest even directly from the
// double. NaN becomes the canonical quiet NaN 0x7e00.
func FloatToHalf(v float64) uint16 {
	if math.IsNaN(v) {
		return 0x7e00
	}
	var sign uint16
	if math.Signbit(v) {
		sign = 0x8000
	}
	a := math.Abs(v)
	if a == 0 {
		return sign
	}
	if math.IsInf(a, 0) {
		return sign | 0x7c00
	}
	_, e := math.Frexp(a) // a = frac * 2^e, frac in [0.5, 1)
	e--                   // a = (2*frac) * 2^e, 2*frac in [1, 2)
	if e < -14 {
		return sign | uint16(roundHalfEven(a*math.Ldexp(1, 24)))
	}
	q := roundHalfEven(a / math.Ldexp(1, e-10)) // 1024..2048
	if q == 2048 {
		q = 1024
		e++
	}
	if e > 15 {
		return sign | 0x7c00
	}
	return sign | uint16(e+15)<<10 | uint16(q-1024)
}

func roundHalfEven(x float64) float64 {
	f := math.Floor(x)
	d := x - f
	if d > 0.5 {
		return f + 1
	}
	if d < 0.5 {
		return f
	}
	if math.Mod(f, 2) == 0 {
		return f
	}
	return f + 1
}

// RoundToHalf rounds a float64 to the nearest binary16 value (ties to even) and returns it as a
// float32 (exactly representable). Used when a JSON number is stored in an f16 field.
func RoundToHalf(v float64) float32 { return HalfToFloat(FloatToHalf(v)) }

// ── range checks of integer values destined for typed locations ──────────────

// CheckI64 fails with RANGE unless lo <= v <= hi.
func CheckI64(v, lo, hi int64, what string) int64 {
	if v < lo || v > hi {
		Fail(RANGE, "%s %d is out of range %d..%d", what, v, lo, hi)
	}
	return v
}

// CheckU64 fails with RANGE unless v <= hi.
func CheckU64(v, hi uint64, what string) uint64 {
	if v > hi {
		Fail(RANGE, "%s %d is out of range 0..%d", what, v, hi)
	}
	return v
}

// I64ToU64 converts a non-negative int64 (RANGE if negative or above hi).
func I64ToU64(v int64, hi uint64, what string) uint64 {
	if v < 0 || uint64(v) > hi {
		Fail(RANGE, "%s %d is out of range 0..%d", what, v, hi)
	}
	return uint64(v)
}

// U64ToI64 converts a uint64 to int64 (RANGE above hi).
func U64ToI64(v uint64, hi int64, what string) int64 {
	if v > uint64(hi) {
		Fail(RANGE, "%s %d is out of range ..%d", what, v, hi)
	}
	return int64(v)
}

// BigToI64 converts a big integer within [lo, hi] (RANGE otherwise).
func BigToI64(b *big.Int, lo, hi int64, what string) int64 {
	if !b.IsInt64() || b.Int64() < lo || b.Int64() > hi {
		Fail(RANGE, "%s %s is out of range %d..%d", what, b.String(), lo, hi)
	}
	return b.Int64()
}

// BigToU64 converts a big integer within [0, hi] (RANGE otherwise).
func BigToU64(b *big.Int, hi uint64, what string) uint64 {
	if !b.IsUint64() || b.Uint64() > hi {
		Fail(RANGE, "%s %s is out of range 0..%d", what, b.String(), hi)
	}
	return b.Uint64()
}

// PrimRangeI64 checks a signed value against a primitive's range.
func PrimRangeI64(p Prim, v int64) bool {
	if v < p.minI64() {
		return false
	}
	return v < 0 || uint64(v) <= p.maxU64()
}

// PrimRangeU64 checks an unsigned value against a primitive's range.
func PrimRangeU64(p Prim, v uint64) bool { return v <= p.maxU64() }

// intBits returns the two's complement bits of v as primitive p (RANGE if it doesn't fit).
func intBits(p Prim, v int64) uint64 {
	if !PrimRangeI64(p, v) {
		Fail(RANGE, "%d is out of range for %s", v, p)
	}
	return uint64(v)
}

// uintBits returns v as the bits of primitive p (RANGE if it doesn't fit).
func uintBits(p Prim, v uint64) uint64 {
	if !PrimRangeU64(p, v) {
		Fail(RANGE, "%d is out of range for %s", v, p)
	}
	return v
}

// float32Bits are the bits of f, NaN canonical (0x7fc00000).
func float32Bits(f float32) uint32 {
	if f != f {
		return 0x7fc00000
	}
	return math.Float32bits(f)
}

// float64Bits are the bits of f, NaN canonical (0x7ff8000000000000).
func float64Bits(f float64) uint64 {
	if f != f {
		return 0x7ff8000000000000
	}
	return math.Float64bits(f)
}
