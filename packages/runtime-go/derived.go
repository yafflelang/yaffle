package yaffle

import (
	"bytes"
	"cmp"
	"math"
	"math/big"
	"reflect"
	"slices"
)

// Derived arrays: map/filter/indicesWhere/sortedBy/unique/concat, used in write
// formulas and checks, and value equality of composite values (docs/IR.md §6).

// Filter returns the elements for which keep holds, in order.
func Filter[T any](s []T, keep func(T) bool) []T {
	out := make([]T, 0, len(s))
	for _, e := range s {
		if keep(e) {
			out = append(out, e)
		}
	}
	return out
}

// IndicesWhere returns the indices of the elements for which f holds.
func IndicesWhere[T any](s []T, f func(T) bool) []int64 {
	out := []int64{}
	for i, e := range s {
		if f(e) {
			out = append(out, int64(i))
		}
	}
	return out
}

// SortedBy is a stable sort by key (numbers, or strings by code points: UTF-8 bytes sort in code
// point order).
func SortedBy[T any, K cmp.Ordered](s []T, key func(T) K) []T {
	return sortedBy(s, key, cmp.Compare[K])
}

// SortedByBytes is a stable sort by a byte key (lexicographic).
func SortedByBytes[T any](s []T, key func(T) []byte) []T {
	return sortedBy(s, key, bytes.Compare)
}

// SortedByBig is a stable sort by a big integer key.
func SortedByBig[T any](s []T, key func(T) *big.Int) []T {
	return sortedBy(s, key, func(a, b *big.Int) int { return a.Cmp(b) })
}

func sortedBy[T, K any](s []T, key func(T) K, compare func(a, b K) int) []T {
	type pair struct {
		k K
		e T
	}
	ps := make([]pair, len(s))
	for i, e := range s {
		ps[i] = pair{key(e), e}
	}
	slices.SortStableFunc(ps, func(a, b pair) int { return compare(a.k, b.k) })
	out := make([]T, len(s))
	for i, p := range ps {
		out[i] = p.e
	}
	return out
}

// Unique returns the array without later duplicates (the first occurrence is kept; value
// equality).
func Unique[T any](s []T) []T {
	out := make([]T, 0, len(s))
	for _, e := range s {
		dup := false
		for _, o := range out {
			if Equal(e, o) {
				dup = true
				break
			}
		}
		if !dup {
			out = append(out, e)
		}
	}
	return out
}

// Concat joins arrays in order.
func Concat[T any](parts ...[]T) []T {
	n := 0
	for _, p := range parts {
		n += len(p)
	}
	out := make([]T, 0, n)
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

// Equal is value equality (docs/IR.md §6): numbers by mathematical value (whatever their Go
// types), strings, bytes and arrays element-wise, structs by their output (exported) fields, so
// two values are equal exactly when their canonical JSON is. Floats compare like their JSON:
// NaN equals NaN, and -0 differs from 0.
func Equal(a, b any) bool {
	if ab, ok := a.([]byte); ok {
		if bb, ok := b.([]byte); ok {
			return bytes.Equal(ab, bb)
		}
	}
	return equalV(reflect.ValueOf(a), reflect.ValueOf(b), map[[2]uintptr]bool{})
}

func isIntKind(k reflect.Kind) bool {
	return k >= reflect.Int && k <= reflect.Int64
}

func isUintKind(k reflect.Kind) bool {
	return k >= reflect.Uint && k <= reflect.Uintptr
}

var bigIntType = reflect.TypeOf((*big.Int)(nil))

func bigOf(v reflect.Value) (*big.Int, bool) {
	switch {
	case isIntKind(v.Kind()):
		return big.NewInt(v.Int()), true
	case isUintKind(v.Kind()):
		return new(big.Int).SetUint64(v.Uint()), true
	case v.Type() == bigIntType && !v.IsNil():
		return v.Interface().(*big.Int), true
	}
	return nil, false
}

func equalV(a, b reflect.Value, seen map[[2]uintptr]bool) bool {
	if !a.IsValid() || !b.IsValid() {
		return a.IsValid() == b.IsValid()
	}
	for a.Kind() == reflect.Interface && !a.IsNil() {
		a = a.Elem()
	}
	for b.Kind() == reflect.Interface && !b.IsNil() {
		b = b.Elem()
	}
	if x, ok := bigOf(a); ok {
		if y, ok := bigOf(b); ok {
			return x.Cmp(y) == 0
		}
		if b.Kind() == reflect.Float32 || b.Kind() == reflect.Float64 {
			f, acc := new(big.Float).SetInt(x).Float64()
			return acc == big.Exact && f == b.Float()
		}
		return false
	}
	switch a.Kind() {
	case reflect.Float32, reflect.Float64:
		var y float64
		switch {
		case b.Kind() == reflect.Float32 || b.Kind() == reflect.Float64:
			y = b.Float()
		default:
			if z, ok := bigOf(b); ok {
				f, acc := new(big.Float).SetInt(z).Float64()
				return acc == big.Exact && f == a.Float()
			}
			return false
		}
		x := a.Float()
		if math.IsNaN(x) || math.IsNaN(y) {
			return math.IsNaN(x) && math.IsNaN(y)
		}
		return x == y && math.Signbit(x) == math.Signbit(y)
	case reflect.Bool:
		return b.Kind() == reflect.Bool && a.Bool() == b.Bool()
	case reflect.String:
		return b.Kind() == reflect.String && a.String() == b.String()
	case reflect.Slice, reflect.Array:
		if b.Kind() != reflect.Slice && b.Kind() != reflect.Array {
			return false
		}
		if a.Len() != b.Len() {
			return false
		}
		for i := 0; i < a.Len(); i++ {
			if !equalV(a.Index(i), b.Index(i), seen) {
				return false
			}
		}
		return true
	case reflect.Pointer:
		if b.Kind() != reflect.Pointer {
			return false
		}
		if a.IsNil() || b.IsNil() {
			return a.IsNil() && b.IsNil()
		}
		if a.Pointer() == b.Pointer() {
			return true
		}
		k := [2]uintptr{a.Pointer(), b.Pointer()}
		if seen[k] {
			return true
		}
		seen[k] = true
		return equalV(a.Elem(), b.Elem(), seen)
	case reflect.Struct:
		if a.Type() != b.Type() {
			return false
		}
		for i := 0; i < a.NumField(); i++ {
			if !a.Type().Field(i).IsExported() {
				continue
			}
			if !equalV(a.Field(i), b.Field(i), seen) {
				return false
			}
		}
		return true
	case reflect.Interface:
		return b.Kind() == reflect.Interface && a.IsNil() && b.IsNil()
	}
	return reflect.DeepEqual(a.Interface(), b.Interface())
}
