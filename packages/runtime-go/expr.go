package yaffle

import (
	"hash/adler32"
	"hash/crc32"
	"math"
	"math/big"
	"reflect"
	"strconv"
)

// Expression semantics (docs/IR.md §6): exact arithmetic, truncating division, % with the sign of
// the dividend, shift counts 0..63, 64-bit two's complement bitwise operators, rounding half away
// from zero, and range checks where a value lands in a typed location. The code generator
// computes in int64 or uint64 when interval analysis proves the result fits, and with *big.Int
// (the Big… helpers) otherwise.

// Integer is any Go integer type a field can have.
type Integer interface {
	~int | ~int8 | ~int16 | ~int32 | ~int64 | ~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64
}

// Number is any Go numeric type a field can have.
type Number interface {
	Integer | ~float32 | ~float64
}

// Div truncates toward zero (RANGE on division by zero).
func Div(a, b int64) int64 {
	if b == 0 {
		Fail(RANGE, "division by zero")
	}
	return a / b
}

// Mod takes the sign of the dividend (RANGE on division by zero).
func Mod(a, b int64) int64 {
	if b == 0 {
		Fail(RANGE, "division by zero")
	}
	return a % b
}

// DivU divides unsigned values (RANGE on division by zero).
func DivU(a, b uint64) uint64 {
	if b == 0 {
		Fail(RANGE, "division by zero")
	}
	return a / b
}

// ModU is the unsigned remainder (RANGE on division by zero).
func ModU(a, b uint64) uint64 {
	if b == 0 {
		Fail(RANGE, "division by zero")
	}
	return a % b
}

// ShiftCount validates a shift count (0..63).
func ShiftCount(n int64) uint {
	if n < 0 || n > 63 {
		Fail(RANGE, "shift count %d is not in 0..63", n)
	}
	return uint(n)
}

// ── big integers ────────────────────────────────────────────────────────────

// BigI makes a big integer from an int64.
func BigI(v int64) *big.Int { return big.NewInt(v) }

// BigU makes a big integer from a uint64.
func BigU(v uint64) *big.Int { return new(big.Int).SetUint64(v) }

// BigLit parses a decimal big integer literal.
func BigLit(s string) *big.Int {
	b, ok := new(big.Int).SetString(s, 10)
	if !ok {
		panic("yaffle: bad big literal " + s)
	}
	return b
}

// BigAdd returns a + b.
func BigAdd(a, b *big.Int) *big.Int { return new(big.Int).Add(a, b) }

// BigSub returns a - b.
func BigSub(a, b *big.Int) *big.Int { return new(big.Int).Sub(a, b) }

// BigMul returns a * b.
func BigMul(a, b *big.Int) *big.Int { return new(big.Int).Mul(a, b) }

// BigDiv truncates toward zero (RANGE on division by zero).
func BigDiv(a, b *big.Int) *big.Int {
	if b.Sign() == 0 {
		Fail(RANGE, "division by zero")
	}
	return new(big.Int).Quo(a, b)
}

// BigMod takes the sign of the dividend (RANGE on division by zero).
func BigMod(a, b *big.Int) *big.Int {
	if b.Sign() == 0 {
		Fail(RANGE, "division by zero")
	}
	return new(big.Int).Rem(a, b)
}

// BigShl shifts left (count 0..63).
func BigShl(a *big.Int, n int64) *big.Int { return new(big.Int).Lsh(a, ShiftCount(n)) }

// BigShr shifts right arithmetically (count 0..63).
func BigShr(a *big.Int, n int64) *big.Int { return new(big.Int).Rsh(a, ShiftCount(n)) }

// BigAnd returns a & b (two's complement semantics, like BigOr, BigXor and BigNot).
func BigAnd(a, b *big.Int) *big.Int { return new(big.Int).And(a, b) }

// BigOr returns a | b.
func BigOr(a, b *big.Int) *big.Int { return new(big.Int).Or(a, b) }

// BigXor returns a ^ b.
func BigXor(a, b *big.Int) *big.Int { return new(big.Int).Xor(a, b) }

// BigNot returns ^a (= -a - 1).
func BigNot(a *big.Int) *big.Int { return new(big.Int).Not(a) }

// BigNeg returns -a.
func BigNeg(a *big.Int) *big.Int { return new(big.Int).Neg(a) }

// BigAbs returns |a|.
func BigAbs(a *big.Int) *big.Int { return new(big.Int).Abs(a) }

// BigCmp compares a and b (-1, 0, 1).
func BigCmp(a, b *big.Int) int { return a.Cmp(b) }

// BigMin returns the smaller value.
func BigMin(a, b *big.Int) *big.Int {
	if a.Cmp(b) <= 0 {
		return a
	}
	return b
}

// BigMax returns the larger value.
func BigMax(a, b *big.Int) *big.Int {
	if a.Cmp(b) >= 0 {
		return a
	}
	return b
}

// BigFloat converts to float64.
func BigFloat(a *big.Int) float64 {
	f, _ := new(big.Float).SetInt(a).Float64()
	return f
}

// ── lengths, offsets ────────────────────────────────────────────────────────

// maxSafe bounds lengths and offsets (2^53 - 1, like the other targets).
const maxSafe = 1<<53 - 1

// Len converts a length or count to int (RANGE if negative or too large).
func Len(v int64, what string) int {
	if v < 0 {
		Fail(RANGE, "%s %d is negative", what, v)
	}
	if v > maxSafe {
		Fail(RANGE, "%s %d is too large", what, v)
	}
	return int(v)
}

// LenU converts an unsigned length to int.
func LenU(v uint64, what string) int {
	if v > maxSafe {
		Fail(RANGE, "%s %d is too large", what, v)
	}
	return int(v)
}

// LenBig converts a big length to int.
func LenBig(v *big.Int, what string) int {
	if v.Sign() < 0 {
		Fail(RANGE, "%s %s is negative", what, v.String())
	}
	if !v.IsInt64() || v.Int64() > maxSafe {
		Fail(RANGE, "%s %s is too large", what, v.String())
	}
	return int(v.Int64())
}

// Off converts an offset to int (RANGE if beyond what a buffer can hold).
func Off(v int64, what string) int {
	if v < -(maxSafe) || v > maxSafe {
		Fail(RANGE, "%s %d is too large", what, v)
	}
	return int(v)
}

// OffU converts an unsigned offset to int.
func OffU(v uint64, what string) int {
	if v > maxSafe {
		Fail(RANGE, "%s %d is too large", what, v)
	}
	return int(v)
}

// OffBig converts a big offset to int.
func OffBig(v *big.Int, what string) int {
	if !v.IsInt64() {
		Fail(RANGE, "%s %s is too large", what, v.String())
	}
	return Off(v.Int64(), what)
}

// ── misc builtins ───────────────────────────────────────────────────────────

// Round rounds half away from zero (RANGE for NaN, infinities and values beyond int64).
func Round(x float64) int64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		Fail(RANGE, "cannot round %v to an integer", x)
	}
	r := math.Round(x)
	if r < -9.223372036854775808e18 || r >= 9.223372036854775808e18 {
		Fail(RANGE, "%v is out of the integer range", x)
	}
	return int64(r)
}

// RoundBig rounds half away from zero to a big integer.
func RoundBig(x float64) *big.Int {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		Fail(RANGE, "cannot round %v to an integer", x)
	}
	b, _ := big.NewFloat(math.Round(x)).Int(nil)
	return b
}

// Trunc converts a float to an integer, truncating (RANGE for NaN or out of range).
func Trunc(x float64) int64 {
	if math.IsNaN(x) || x < -9.223372036854775808e18 || x >= 9.223372036854775808e18 {
		Fail(RANGE, "cannot convert %v to an integer", x)
	}
	return int64(x)
}

// Abs64 returns |a| (a must not be MinInt64; the generator proves it).
func Abs64(a int64) int64 {
	if a < 0 {
		return -a
	}
	return a
}

// FMod is the float remainder with the sign of the dividend.
func FMod(a, b float64) float64 { return math.Mod(a, b) }

// AbsF returns |x|.
func AbsF(x float64) float64 { return math.Abs(x) }

// If picks a or b (both already evaluated).
func If[T any](c bool, a, b T) T {
	if c {
		return a
	}
	return b
}

// Cond evaluates only the branch taken.
func Cond[T any](c bool, a, b func() T) T {
	if c {
		return a()
	}
	return b()
}

// At indexes an array or byte slice (RANGE if out of bounds).
func At[T any](s []T, i int64) T {
	if i < 0 || i >= int64(len(s)) {
		Fail(RANGE, "index %d is out of bounds (length %d)", i, len(s))
	}
	return s[i]
}

// Get dereferences an optional field (INPUT if it is missing).
func Get[T any](p *T, name string) T {
	if p == nil {
		Fail(INPUT, "missing field %s", name)
	}
	return *p
}

// Ptr returns a pointer to a copy of v.
func Ptr[T any](v T) *T { return &v }

// Map applies f to every element (`arr[*].field` in expressions).
func Map[T, U any](s []T, f func(T) U) []U {
	out := make([]U, len(s))
	for i, e := range s {
		out[i] = f(e)
	}
	return out
}

// Sum adds an array of integers (RANGE if the sum leaves int64).
func Sum[T Integer](s []T) int64 {
	var acc int64
	for _, e := range s {
		x := int64(e)
		if (x > 0 && acc > math.MaxInt64-x) || (x < 0 && acc < math.MinInt64-x) {
			Fail(RANGE, "sum is too large")
		}
		acc += x
	}
	return acc
}

// SumU adds an array of uint64 values exactly.
func SumU[T ~uint64](s []T) *big.Int {
	acc := new(big.Int)
	for _, e := range s {
		acc.Add(acc, new(big.Int).SetUint64(uint64(e)))
	}
	return acc
}

// SumF adds an array of floats.
func SumF[T ~float32 | ~float64](s []T) float64 {
	acc := 0.0
	for _, e := range s {
		acc += float64(e)
	}
	return acc
}

// MinOf returns the smallest element (RANGE for an empty array).
func MinOf[T Number](s []T) T {
	if len(s) == 0 {
		Fail(RANGE, "min of an empty array")
	}
	m := s[0]
	for _, e := range s[1:] {
		if e < m {
			m = e
		}
	}
	return m
}

// MaxOf returns the largest element (RANGE for an empty array).
func MaxOf[T Number](s []T) T {
	if len(s) == 0 {
		Fail(RANGE, "max of an empty array")
	}
	m := s[0]
	for _, e := range s[1:] {
		if e > m {
			m = e
		}
	}
	return m
}

// Lengths returns the length of each element of an array of arrays.
func Lengths[T any](s [][]T) []int64 {
	out := make([]int64, len(s))
	for i, e := range s {
		out[i] = int64(len(e))
	}
	return out
}

// IndexOf is the reverse of `names[it]`: the first index of v (INPUT if absent).
func IndexOf[T comparable](s []T, v T) int64 {
	for i, e := range s {
		if e == v {
			return int64(i)
		}
	}
	Fail(INPUT, "value %v is not in the table", v)
	return 0
}

// Or returns *p, or the default computed by f when p is nil (optional inputs).
func Or[T any](p *T, f func() T) T {
	if p != nil {
		return *p
	}
	return f()
}

// Crc32 is CRC-32 (IEEE 802.3, reflected), the builtin crc32.
func Crc32(data []byte) uint32 { return crc32.ChecksumIEEE(data) }

// Adler32 is the builtin adler32.
func Adler32(data []byte) uint32 { return adler32.Checksum(data) }

// KeyArg renders a value for an identity key (struct arguments and lengths).
func KeyArg(v any) string {
	switch x := v.(type) {
	case int, int8, int16, int32, int64:
		return strconv.FormatInt(reflect.ValueOf(x).Int(), 10)
	case uint8, uint16, uint32, uint64:
		return strconv.FormatUint(reflect.ValueOf(x).Uint(), 10)
	case *big.Int:
		return x.String()
	case Endian:
		return x.String()
	case string:
		return strconv.Quote(x)
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return strconv.FormatFloat(x, 'g', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(x), 'g', -1, 32)
	}
	return "?"
}

// FormatInt renders an integer (the String of unknown enum values).
func FormatInt(v int64) string { return strconv.FormatInt(v, 10) }

// FormatUint renders an unsigned integer.
func FormatUint(v uint64) string { return strconv.FormatUint(v, 10) }
