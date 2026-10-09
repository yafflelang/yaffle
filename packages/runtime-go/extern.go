package yaffle

import (
	"context"
	"fmt"
	"math"
	"math/big"
)

// ── host shapes (docs/IR.md §5, adapted to Go) ──────────────────────────────

// CodecCtx is what a codec gets besides its input.
type CodecCtx struct {
	// Context comes from the ParseXContext / SerializeXContext entry points (Background
	// otherwise). Codecs declared `async` in yaffle are plain blocking calls in Go; they may
	// honour cancellation through it.
	Context context.Context
	// Args are the codec's arguments in declaration order: integers as their Go type (u8 →
	// uint8, u64 → uint64), u8[n] → []byte, strings → string, bools → bool, floats → float64.
	Args []any
	// OutputSize is the decoded size when an inner @size layer gives it, -1 otherwise.
	OutputSize int
	// Position is the offset of the input within the whole encoded region (@ranged codecs).
	Position int
}

// Codec is the host side of `extern codec name(params)`.
type Codec interface {
	Decode(input []byte, ctx *CodecCtx) ([]byte, error)
	Encode(input []byte, ctx *CodecCtx) ([]byte, error)
}

// StreamingCodec is the host side of a `@streaming` codec: Decode gets the rest of the region
// and reports how many input bytes it consumed.
type StreamingCodec interface {
	Decode(input []byte, ctx *CodecCtx) (output []byte, consumed int, err error)
	Encode(input []byte, ctx *CodecCtx) ([]byte, error)
}

// ExternType is the host side of `extern type Name(params) : T`.
type ExternType[T any] interface {
	// Size returns how many bytes the value at the start of data occupies; ok=false means
	// "need more bytes".
	Size(data []byte, args []any) (n int, ok bool, err error)
	Read(data []byte, args []any) (T, error)
	Write(value T, args []any) ([]byte, error)
}

// callHost runs host code: an error it returns or a panic is a CODEC error (an *Error passes
// through unchanged).
func callHost(what string, offset int, f func() error) {
	err := func() (err error) {
		defer func() {
			if p := recover(); p != nil {
				if e, ok := p.(*Error); ok {
					panic(e)
				}
				err = fmt.Errorf("%v", p)
			}
		}()
		return f()
	}()
	if err != nil {
		panic(wrapHost(what, offset, err))
	}
}

// ReadExtern reads an extern type: host Size (unless fixed >= 0), then Read.
func ReadExtern[T any](r *Reader, host ExternType[T], args []any, fixed int) (v T) {
	at := r.At(r.Pos)
	size := fixed
	if size < 0 {
		size = externSize(r, host, args, at)
	}
	b := r.Bytes(size)
	callHost("extern type read()", at, func() (err error) {
		v, err = host.Read(b, args)
		return
	})
	return
}

// externSize asks the host how many bytes the value at Pos occupies, offering 16 bytes and twice
// as many each time it needs more.
func externSize[T any](r *Reader, host ExternType[T], args []any, at int) int {
	for probe := min(r.End-r.Pos, 16); ; probe = min(r.End-r.Pos, probe*2) {
		data := r.peek(probe)
		var n int
		var ok bool
		callHost("extern type size()", at, func() (err error) {
			n, ok, err = host.Size(data, args)
			return
		})
		if ok {
			return n
		}
		if probe >= r.End-r.Pos {
			r.Fail(EOF, "extern type needs more bytes than the region has")
		}
	}
}

// WriteExtern writes an extern type through its host Write.
func WriteExtern[T any](w *Writer, host ExternType[T], v T, args []any, fixed int) {
	var out []byte
	callHost("extern type write()", -1, func() (err error) {
		out, err = host.Write(v, args)
		return
	})
	if fixed >= 0 && len(out) != fixed {
		Fail(DERIVE, "extern type wrote %d bytes, its fixed size is %d", len(out), fixed)
	}
	w.B.bytes(out)
}

// CallFn calls a host function (extern fn); a panic in it is a CODEC error.
func CallFn[R any](name string, f func() R) (v R) {
	callHost("extern "+name, -1, func() error {
		v = f()
		return nil
	})
	return
}

// ── missing implementations ─────────────────────────────────────────────────

// MissingExtern is the placeholder for an extern without an implementation for the Go target.
func MissingExtern(name string) {
	Fail(INPUT, "extern %s has no implementation (configure targets.go.externs in yaffle.json)", name)
}

type missingCodec struct{ name string }

func (m missingCodec) Decode([]byte, *CodecCtx) ([]byte, error) {
	MissingExtern(m.name)
	return nil, nil
}

func (m missingCodec) Encode([]byte, *CodecCtx) ([]byte, error) {
	MissingExtern(m.name)
	return nil, nil
}

// MissingCodec stands in for a codec without an implementation (fails with INPUT when used).
func MissingCodec(name string) Codec { return missingCodec{name} }

type missingType[T any] struct{ name string }

func (m missingType[T]) Size([]byte, []any) (int, bool, error) {
	MissingExtern(m.name)
	return 0, false, nil
}

func (m missingType[T]) Read([]byte, []any) (T, error) {
	MissingExtern(m.name)
	var zero T
	return zero, nil
}

func (m missingType[T]) Write(T, []any) ([]byte, error) {
	MissingExtern(m.name)
	return nil, nil
}

// MissingType stands in for an extern type without an implementation.
func MissingType[T any](name string) ExternType[T] { return missingType[T]{name} }

// ── built-in extern types: LEB128 ───────────────────────────────────────────

// Uleb128 is the built-in unsigned LEB128 type (value uint64).
var Uleb128 ExternType[uint64] = uleb128{}

// Sleb128 is the built-in signed LEB128 type (value int64).
var Sleb128 ExternType[int64] = sleb128{}

type uleb128 struct{}

func lebMax(args []any) int {
	if len(args) > 0 {
		switch x := args[0].(type) {
		case uint8:
			return int(x)
		case int:
			return x
		case int64:
			return int(x)
		case uint64:
			return int(x)
		}
	}
	return 10
}

func (uleb128) Size(b []byte, args []any) (int, bool, error) {
	maxBytes := lebMax(args)
	for i := 0; i < len(b) && i < maxBytes; i++ {
		if b[i]&0x80 == 0 {
			return i + 1, true, nil
		}
	}
	if len(b) >= maxBytes {
		return 0, false, newErr(CHECK, -1, "LEB128 longer than %d bytes", maxBytes)
	}
	return 0, false, nil
}

// lebBits is the value of LEB128 bytes (7 bits each, least significant first).
func lebBits(b []byte) *big.Int {
	v := new(big.Int)
	for i := len(b) - 1; i >= 0; i-- {
		v.Lsh(v, 7)
		v.Or(v, big.NewInt(int64(b[i]&0x7f)))
	}
	return v
}

func (uleb128) Read(b []byte, _ []any) (uint64, error) {
	v := lebBits(b)
	if !v.IsUint64() {
		return 0, newErr(RANGE, -1, "LEB128 value exceeds 64 bits")
	}
	return v.Uint64(), nil
}

func (uleb128) Write(v uint64, _ []any) ([]byte, error) {
	var out []byte
	for {
		b := byte(v & 0x7f)
		v >>= 7
		if v != 0 {
			b |= 0x80
		}
		out = append(out, b)
		if v == 0 {
			return out, nil
		}
	}
}

type sleb128 struct{}

func (sleb128) Size(b []byte, args []any) (int, bool, error) { return uleb128{}.Size(b, args) }

func (sleb128) Read(b []byte, _ []any) (int64, error) {
	v := lebBits(b)
	if len(b) > 0 && b[len(b)-1]&0x40 != 0 {
		v.Sub(v, new(big.Int).Lsh(big.NewInt(1), uint(len(b)*7)))
	}
	if !v.IsInt64() {
		return 0, newErr(RANGE, -1, "LEB128 value exceeds 64 bits")
	}
	return v.Int64(), nil
}

func (sleb128) Write(v int64, _ []any) ([]byte, error) {
	var out []byte
	for {
		b := byte(v & 0x7f)
		v >>= 7
		if (v == 0 && b&0x40 == 0) || (v == -1 && b&0x40 != 0) {
			return append(out, b), nil
		}
		out = append(out, b|0x80)
	}
}

// ── argument helpers for host code ──────────────────────────────────────────

// ArgInt returns codec/extern argument i as an int64 (any Go integer type).
func ArgInt(args []any, i int) (int64, error) {
	if i >= len(args) {
		return 0, fmt.Errorf("missing argument %d", i)
	}
	switch x := args[i].(type) {
	case int:
		return int64(x), nil
	case int8:
		return int64(x), nil
	case int16:
		return int64(x), nil
	case int32:
		return int64(x), nil
	case int64:
		return x, nil
	case uint8:
		return int64(x), nil
	case uint16:
		return int64(x), nil
	case uint32:
		return int64(x), nil
	case uint64:
		if x > math.MaxInt64 {
			return 0, fmt.Errorf("argument %d is too large", i)
		}
		return int64(x), nil
	}
	return 0, fmt.Errorf("argument %d is not an integer (%T)", i, args[i])
}

// ArgUint returns argument i as a uint64.
func ArgUint(args []any, i int) (uint64, error) {
	if i < len(args) {
		if x, ok := args[i].(uint64); ok {
			return x, nil
		}
	}
	v, err := ArgInt(args, i)
	if err != nil {
		return 0, err
	}
	if v < 0 {
		return 0, fmt.Errorf("argument %d is negative", i)
	}
	return uint64(v), nil
}

// ArgBytes returns argument i as a byte slice.
func ArgBytes(args []any, i int) ([]byte, error) {
	if i < len(args) {
		if b, ok := args[i].([]byte); ok {
			return b, nil
		}
	}
	return nil, fmt.Errorf("argument %d is not bytes", i)
}
