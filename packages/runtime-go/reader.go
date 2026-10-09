package yaffle

import (
	"context"
	"encoding/binary"
	"math"
	"math/big"
	"strings"
)

// Fill is a padding fill: a byte, or a function of the byte's index within the padding run (the
// low 8 bits of its result are used).
type Fill struct {
	Byte byte
	Fn   func(i int) int64
}

func (f Fill) at(i int) byte {
	if f.Fn != nil {
		return byte(f.Fn(i))
	}
	return f.Byte
}

type identKey struct {
	addr int
	key  string
}

// Reader is the read context (docs/IR.md §2.1) used by generated readers: position, base,
// region end, array index and strict flag over a byte slice. Positions are absolute within the
// slice; Base and End are absolute too.
type Reader struct {
	buf    []byte
	Pos    int
	Base   int
	End    int
	Index  int
	Strict bool
	// MaxEnd is the furthest position read inside the current base (inline and targets): a base
	// struct consumes it all.
	MaxEnd int
	// LastTargetEnd is the end of the last target read with Target/TargetStruct.
	LastTargetEnd int
	// PS is the path stack shared by every reader of one parse.
	PS *PathStack
	// Ctx is passed to codecs (blocking "async" codecs may honour cancellation).
	Ctx context.Context

	copyBytes  bool
	into       any
	ident      map[identKey]any
	identEnd   map[identKey]int
	inProgress map[identKey]bool
	// outer is the offset errors inside a decoded region or stream report (-1: none).
	outer int
	// sc is set while a view scans or tracks the document (scan.go); nil for plain parses.
	sc *scanState
	// src is set for readers over a store (views: lazy streams and @ranged regions): buf is then
	// a window of it starting at off. size is the number of bytes (len(buf) without a store).
	src  Store
	off  int
	size int
	// space: the reader is not over the document's own bytes (views can't patch in place).
	space bool
}

// NewReader reads data from offset 0 (base 0, end len(data)).
func NewReader(data []byte, strict bool) *Reader {
	return &Reader{
		buf: data, End: len(data), Index: -1, Strict: strict, PS: &PathStack{},
		Ctx: context.Background(), outer: -1, size: len(data),
	}
}

// child is a reader over another byte space (a decoded region, a virtual stream) whose errors
// report offset at, or the offset this reader's errors report.
func (r *Reader) child(data []byte, at int) *Reader {
	if r.outer >= 0 {
		at = r.outer
	}
	c := &Reader{
		buf: data, End: len(data), Index: -1, Strict: r.Strict, PS: r.PS, Ctx: r.Ctx,
		outer: at, copyBytes: r.copyBytes, size: len(data), space: r.space, into: r.into,
	}
	r.into = nil
	return c
}

func (r *Reader) childStore(src Store, at int) *Reader {
	c := r.child(nil, at)
	c.src, c.size, c.End, c.copyBytes = src, src.Size(), src.Size(), true
	return c
}

// Sub is a reader for a fresh region (a virtual stream): base 0, end its length.
func (r *Reader) Sub(s Stream) *Reader {
	if s.store != nil {
		return r.childStore(s.store, r.Pos)
	}
	return r.child(s.data, r.Pos)
}

// Decoded is a reader over a codec's decoded output. Byte values are copies.
func (r *Reader) Decoded(data []byte, at int) *Reader {
	c := r.child(data, at)
	c.copyBytes = true
	return c
}

// fetch makes buf a window of the store covering [pos, pos+n).
func (r *Reader) fetch(pos, n int) {
	if pos < r.off || pos+n > r.off+len(r.buf) {
		r.buf = r.src.Window(pos, n)
		r.off = pos
	}
}

// PeekBytes returns bytes [start, end) (absolute) without moving Pos.
func (r *Reader) PeekBytes(start, end int) []byte {
	if start < 0 || end > r.size || start > end {
		r.FailAt(EOF, start, "range [0x%x, 0x%x) is outside the data", start, end)
	}
	if r.src != nil {
		if start == end {
			return []byte{}
		}
		r.fetch(start, end-start)
		return r.buf[start-r.off : end-r.off : end-r.off]
	}
	return r.buf[start:end:end]
}

// ── errors ──────────────────────────────────────────────────────────────────

// At maps an offset to the absolute offset reported in errors (the encoded window inside
// decoded regions).
func (r *Reader) At(offset int) int {
	if r.outer >= 0 {
		return r.outer
	}
	return offset
}

// Fail panics with an error at the current position.
func (r *Reader) Fail(code Code, format string, args ...any) {
	FailAt(code, r.At(r.Pos), format, args...)
}

// FailAt panics with an error at an offset.
func (r *Reader) FailAt(code Code, offset int, format string, args ...any) {
	FailAt(code, r.At(offset), format, args...)
}

// CheckFail reports a failed check.
func (r *Reader) CheckFail(message string, offset int) {
	FailAt(CHECK, r.At(offset), "check failed: %s", message)
}

// ── path ────────────────────────────────────────────────────────────────────

// EnterV pushes the frame of struct value v (views record where each value is).
func (r *Reader) EnterV(v any) Frame {
	if r.sc != nil {
		r.sc.enter(r, v)
	}
	return r.PS.Enter()
}

// Field names the field being read.
func (r *Reader) Field(f Frame, name string) {
	r.PS.Field(f, name)
	if r.sc != nil {
		r.sc.field(r, name)
	}
}

// Leave pops a struct frame.
func (r *Reader) Leave(f Frame) {
	r.PS.Leave(f)
	if r.sc != nil {
		r.sc.leave(r)
	}
}

// PushIndex pushes an array index slot.
func (r *Reader) PushIndex() Frame { return r.PS.PushIndex() }

// SetIndex sets the current array index.
func (r *Reader) SetIndex(f Frame, i int) { r.PS.SetIndex(f, i) }

// PopIndex pops an array index slot.
func (r *Reader) PopIndex(f Frame) { r.PS.Leave(f) }

// ── bounds and windows ──────────────────────────────────────────────────────

func (r *Reader) need(n int) {
	if n < 0 || r.Pos+n > r.End {
		r.eof(n)
	}
	if r.src != nil && n > 0 {
		r.fetch(r.Pos, n)
	}
}

func (r *Reader) eof(n int) {
	r.Fail(EOF, "need %d bytes at 0x%x, region ends at 0x%x", n, r.Pos, r.End)
}

// peek returns the n bytes at Pos (EOF if the region ends first).
func (r *Reader) peek(n int) []byte {
	r.need(n)
	at := r.Pos - r.off
	return r.buf[at : at+n : at+n]
}

// take is peek, consuming the bytes.
func (r *Reader) take(n int) []byte {
	b := r.peek(n)
	r.Pos += n
	return b
}

// Window narrows the region to n bytes from Pos and returns the previous end.
func (r *Reader) Window(n int) int {
	saved := r.End
	if n < 0 {
		r.Fail(RANGE, "invalid size %d", n)
	}
	if r.Pos+n > saved {
		r.Fail(EOF, "size %d at 0x%x exceeds the region end 0x%x", n, r.Pos, saved)
	}
	r.End = r.Pos + n
	return saved
}

// CloseWindow skips the rest of the window (padding; zero in strict mode) and restores the end.
func (r *Reader) CloseWindow(saved int, strict bool) {
	if left := r.End - r.Pos; left > 0 {
		r.Pad(left, Fill{}, strict)
	}
	r.End = saved
}

// ── integers and floats ─────────────────────────────────────────────────────

func order(le bool) binary.ByteOrder {
	if le {
		return binary.LittleEndian
	}
	return binary.BigEndian
}

// U8 reads a byte.
func (r *Reader) U8() uint8 { return r.take(1)[0] }

// I8 reads a signed byte.
func (r *Reader) I8() int8 { return int8(r.U8()) }

// U16 reads a uint16.
func (r *Reader) U16(le bool) uint16 { return order(le).Uint16(r.take(2)) }

// I16 reads an int16.
func (r *Reader) I16(le bool) int16 { return int16(r.U16(le)) }

// U32 reads a uint32.
func (r *Reader) U32(le bool) uint32 { return order(le).Uint32(r.take(4)) }

// I32 reads an int32.
func (r *Reader) I32(le bool) int32 { return int32(r.U32(le)) }

// U64 reads a uint64.
func (r *Reader) U64(le bool) uint64 { return order(le).Uint64(r.take(8)) }

// I64 reads an int64.
func (r *Reader) I64(le bool) int64 { return int64(r.U64(le)) }

// UN reads an unsigned integer of n bytes (u24, u40, u48, u56).
func (r *Reader) UN(n int, le bool) uint64 { return GetUint(r.take(n), n, le) }

// IN reads a signed integer of n bytes (i24, i40, i48, i56).
func (r *Reader) IN(n int, le bool) int64 { return SignExtend(r.UN(n, le), n*8) }

// F16 reads a half-precision float.
func (r *Reader) F16(le bool) float32 { return HalfToFloat(r.U16(le)) }

// F32 reads a float32.
func (r *Reader) F32(le bool) float32 { return math.Float32frombits(r.U32(le)) }

// F64 reads a float64.
func (r *Reader) F64(le bool) float64 { return math.Float64frombits(r.U64(le)) }

// Uint reads any unsigned storage primitive (bitfield units) as a uint64.
func (r *Reader) Uint(p Prim, le bool) uint64 { return r.UN(p.Size(), le) }

// Bool reads a bool byte (strict: only 0 or 1).
func (r *Reader) Bool(strict bool) bool {
	at := r.Pos
	b := r.U8()
	if strict && b > 1 {
		r.FailAt(CHECK, at, "bool byte 0x%x is not 0 or 1", b)
	}
	return b != 0
}

// Count validates a count read from the data: negative is RANGE; more units than any region can
// hold is EOF (smaller counts fail on the element that crosses the end).
func (r *Reader) Count(v int64, unit int) int {
	if v < 0 {
		r.Fail(RANGE, "length %d is negative", v)
	}
	if v > maxSafe || (unit > 0 && v > maxSafe/int64(unit)) {
		r.Fail(EOF, "length %d needs more than the %d bytes left", v, max(0, r.End-r.Pos))
	}
	return int(v)
}

// CountU is Count for unsigned values.
func (r *Reader) CountU(v uint64, unit int) int {
	if v > maxSafe {
		r.Fail(EOF, "length %d needs more than the %d bytes left", v, max(0, r.End-r.Pos))
	}
	return r.Count(int64(v), unit)
}

// CountBig is Count for big values.
func (r *Reader) CountBig(v *big.Int, unit int) int {
	if v.Sign() < 0 {
		r.Fail(RANGE, "length %s is negative", v.String())
	}
	if !v.IsInt64() {
		r.Fail(EOF, "length %s needs more than the %d bytes left", v.String(), max(0, r.End-r.Pos))
	}
	return r.Count(v.Int64(), unit)
}

// ── bytes ───────────────────────────────────────────────────────────────────

// Bytes reads n bytes. They alias the source unless the reader copies (decoded regions).
func (r *Reader) Bytes(n int) []byte {
	out := r.take(n)
	if r.copyBytes {
		out = append([]byte{}, out...)
	}
	return out
}

// BytesUntil reads bytes up to a terminator byte (consumed, not part of the value).
func (r *Reader) BytesUntil(term byte) []byte {
	i := r.findUnit(1, func(u uint64) bool { return u == uint64(term) })
	out := r.Bytes(i)
	r.Pos++
	return out
}

// BytesRest reads to the end of the region.
func (r *Reader) BytesRest() []byte { return r.Bytes(r.End - r.Pos) }

// findUnit returns the index of the first unit (big-endian value of unit bytes) for which pred
// holds, counted in units from Pos (EOF if none does before the region end).
func (r *Reader) findUnit(unit int, pred func(uint64) bool) int {
	avail := (r.End - r.Pos) / unit
	for i := 0; i < avail; i++ {
		p := r.Pos + i*unit
		if r.src != nil {
			r.fetch(p, unit)
		}
		if pred(GetUint(r.buf[p-r.off:], unit, false)) {
			return i
		}
	}
	r.Fail(EOF, "terminator not found before the region end")
	return 0
}

// ── strings ─────────────────────────────────────────────────────────────────

// Str reads n code units; the value stops at the first NUL unit.
func (r *Reader) Str(n, unit int, enc Encoding, le bool) string {
	at := r.At(r.Pos)
	b := r.take(n * unit)
	if nul := findNul(b, unit); nul >= 0 {
		b = b[:nul*unit]
	}
	return DecodeString(b, enc, le, at)
}

// StrUntil reads units up to a NUL unit (consumed).
func (r *Reader) StrUntil(unit int, enc Encoding, le bool) string {
	i := r.findUnit(unit, func(u uint64) bool { return u == 0 })
	s := r.Str(i, unit, enc, le)
	r.Pos += unit
	return s
}

// StrRest reads to the end of the region (the value stops at the first NUL unit).
func (r *Reader) StrRest(unit int, enc Encoding, le bool) string {
	return r.Str((r.End-r.Pos)/unit, unit, enc, le)
}

// ── padding ─────────────────────────────────────────────────────────────────

// Pad skips n padding bytes; in strict mode they must match the fill.
func (r *Reader) Pad(n int, fill Fill, strict bool) {
	if n < 0 {
		r.Fail(RANGE, "invalid padding length %d", n)
	}
	if r.Pos+n > r.End {
		r.eof(n)
	}
	if strict && n > 0 {
		for i, got := range r.peek(n) {
			if want := fill.at(i); got != want {
				r.FailAt(CHECK, r.Pos+i, "padding byte 0x%x is not 0x%x", got, want)
			}
		}
	}
	r.Pos += n
}

// Align pads until (Pos - Base) % to == 0.
func (r *Reader) Align(to int, fill Fill, strict bool) { r.AlignAt(to, 0, false, fill, strict) }

// AlignAt pads until (position + offset) % to == 0, the position counted from the base or, with
// file, from the start of the byte space being read (the source, a decoded region, a virtual
// stream).
func (r *Reader) AlignAt(to, offset int, file bool, fill Fill, strict bool) {
	if to <= 0 {
		r.Fail(RANGE, "invalid alignment %d", to)
	}
	rel := r.Pos + offset
	if !file {
		rel -= r.Base
	}
	r.Pad(mod(-rel, to), fill, strict)
}

// PadUntil pads after content that started at start until it occupies size bytes.
func (r *Reader) PadUntil(start, size int, fill Fill, strict bool) {
	used := r.Pos - start
	if used > size {
		r.FailAt(CHECK, start, "content of %d bytes exceeds padUntil(%d)", used, size)
	}
	r.Pad(size-used, fill, strict)
}

// ── targets ─────────────────────────────────────────────────────────────────

// Target reads a pointer or `at` target at absolute addr without moving Pos. The same address and
// type key give the same value within this region.
func Target[T any](r *Reader, addr int, key string, read func() T) T {
	var zero T
	if r.skipTarget(addr, key, func() any { return Target(r, addr, key, read) }, func() any { return read() }) {
		return zero
	}
	k := identKey{addr, key}
	if v, ok := r.cachedTarget(k); ok {
		return v.(T)
	}
	if r.inProgress[k] {
		r.Fail(CHECK, "pointer cycle at 0x%x", addr)
	}
	r.inProgress[k] = true
	defer delete(r.inProgress, k)
	v := follow(r, k, read)
	r.ident[k] = v
	return v
}

// TargetStruct reads a struct target: the object is registered under (address, type) before its
// contents are read, so pointers back to it (cycles) get the same object.
func TargetStruct[T any](r *Reader, addr int, key string, read func() *T) *T {
	if r.skipTarget(addr, key, func() any { return TargetStruct(r, addr, key, read) }, func() any { return read() }) {
		return nil
	}
	k := identKey{addr, key}
	if v, ok := r.cachedTarget(k); ok {
		return v.(*T)
	}
	obj := new(T)
	r.ident[k], r.identEnd[k] = obj, addr
	r.into = obj
	done := false
	defer func() {
		r.into = nil
		if !done {
			delete(r.ident, k)
			delete(r.identEnd, k)
		}
	}()
	v := follow(r, k, read)
	done = true
	return v
}

// skipTarget records a target while a view scans; true when the scan is shallow (the target is
// not read now).
func (r *Reader) skipTarget(addr int, key string, follow, inner func() any) bool {
	if r.sc == nil {
		return false
	}
	r.sc.target(r, addr, key, follow, inner)
	return r.sc.shallow
}

// cachedTarget returns the value already read at k, if any. On a miss the address is checked.
func (r *Reader) cachedTarget(k identKey) (any, bool) {
	r.identMaps()
	v, ok := r.ident[k]
	if !ok {
		if k.addr < 0 || k.addr > r.size {
			r.Fail(EOF, "target address 0x%x is outside the data", k.addr)
		}
		return nil, false
	}
	r.LastTargetEnd = k.addr
	if end, ok := r.identEnd[k]; ok {
		r.LastTargetEnd = end
	}
	if r.sc != nil {
		r.sc.origin(r, v, k.addr, r.LastTargetEnd)
	}
	return v, true
}

func (r *Reader) identMaps() {
	if r.ident == nil {
		r.ident = map[identKey]any{}
		r.identEnd = map[identKey]int{}
		r.inProgress = map[identKey]bool{}
	}
}

// follow runs read at the target's address (no array index), records where the target ends, and
// restores Pos and Index.
func follow[T any](r *Reader, k identKey, read func() T) T {
	savePos, saveIndex := r.Pos, r.Index
	defer func() { r.Pos, r.Index = savePos, saveIndex }()
	r.Pos, r.Index = k.addr, -1
	v := read()
	r.identEnd[k] = r.Pos
	r.LastTargetEnd = r.Pos
	r.MaxEnd = max(r.MaxEnd, r.Pos)
	if r.sc != nil {
		r.sc.origin(r, v, k.addr, r.Pos)
	}
	return v
}

// Inline reads an inline struct of a type pointers can target: one object per (address, type).
func Inline[T any](r *Reader, key string, read func() *T) *T {
	r.identMaps()
	k := identKey{r.Pos, key}
	obj, _ := r.ident[k].(*T)
	if obj == nil {
		obj = new(T)
		r.ident[k] = obj
	}
	r.into = obj
	defer func() { r.into = nil }()
	return read()
}

// Into returns the object a struct reader fills: the pre-registered one (identity, cycles) or a
// new one.
func Into[T any](r *Reader) *T {
	p, ok := r.into.(*T)
	r.into = nil
	if ok {
		return p
	}
	return new(T)
}

// PeekAt runs read at absolute addr and restores Pos (no identity tracking).
func PeekAt[T any](r *Reader, addr int, read func() T) T {
	savePos := r.Pos
	r.Pos = addr
	defer func() { r.Pos = savePos }()
	v := read()
	r.MaxEnd = max(r.MaxEnd, r.Pos)
	return v
}

// Union tries each variant at Pos (try(i) reads variant i); the first that reads without error
// wins and its index is returned. Failed variants restore the reader. No match is a UNION error
// listing every variant's error.
func (r *Reader) Union(names []string, try func(i int)) int {
	start, saveEnd, saveBase, saveMax, saveIndex, saveStrict := r.Pos, r.End, r.Base, r.MaxEnd, r.Index, r.Strict
	scDepth, scShallow := 0, false
	if r.sc != nil {
		scDepth, scShallow = len(r.sc.frames), r.sc.shallow
	}
	var errs []*Error
	for i, name := range names {
		e := Try(r.PS, func() { try(i) })
		if e == nil {
			return i
		}
		e.Path = append([]any{name}, e.Path...)
		errs = append(errs, e)
		r.Pos, r.End, r.Base, r.MaxEnd, r.Index, r.Strict = start, saveEnd, saveBase, saveMax, saveIndex, saveStrict
		r.into = nil
		if r.sc != nil {
			r.sc.frames = r.sc.frames[:scDepth]
			r.sc.shallow = scShallow
		}
	}
	msgs := make([]string, len(errs))
	for i, e := range errs {
		msgs[i] = e.Error()
	}
	panic(&Error{Code: UNION, Offset: r.At(start), Detail: "no variant matched (" + strings.Join(msgs, "; ") + ")", Causes: errs})
}
