package yaffle

import (
	"context"
	"math"
	"math/big"
	"reflect"
)

// The relocation-style writer (docs/IR.md §3.2):
//
//  1. Generated writers encode bottom-up into blocks: inline bytes plus fixups (a position, a
//     width and a closure computing the value once sizes and positions are final).
//  2. Pointer and `at` targets become placeables, each with its own block. Generated code also
//     records the structure (LStruct / LArray) the layout engine matches `layout` paths against.
//  3. When a base region (the root, a @base struct, a codec's decoded side) is complete, the
//     layout engine assigns every block a position, the blocks are assembled, and the fixups run.

// ── the writer used by generated code ───────────────────────────────────────

// Writer is the write context of generated writers.
type Writer struct {
	// B is the current block (inline bytes go here).
	B *Block
	// Region is the current base region.
	Region *Region
	// Index is the current array element index ($index).
	Index int
	// PS is the path stack.
	PS *PathStack
	// Ctx is passed to codecs.
	Ctx   context.Context
	depth int

	// Commit mode (views).
	Commit  *CommitHooks
	rootRg  *Region
	provBuf []byte
	origB   int
}

// NewWriter creates a writer over a fresh root region.
func NewWriter(layout []LayoutItem) *Writer {
	r := newRegion()
	r.Layout = layout
	w := &Writer{B: r.Root, Region: r, Index: -1, PS: &PathStack{}, Ctx: context.Background()}
	w.rootRg = r
	return w
}

// Enter pushes a struct frame.
func (w *Writer) Enter() Frame {
	w.depth++
	return w.PS.Enter()
}

// Field names the field being written.
func (w *Writer) Field(f Frame, name string) { w.PS.Field(f, name) }

// Leave pops a struct frame.
func (w *Writer) Leave(f Frame) {
	w.depth--
	w.PS.Leave(f)
}

// PushIndex pushes an array index slot.
func (w *Writer) PushIndex() Frame { return w.PS.PushIndex() }

// SetIndex sets the current array index.
func (w *Writer) SetIndex(f Frame, i int) { w.PS.SetIndex(f, i) }

// PopIndex pops an array index slot.
func (w *Writer) PopIndex(f Frame) { w.PS.Leave(f) }

// Offset is the offset of the next byte within the current block.
func (w *Writer) Offset() int { return w.B.Size }

// Position is `$offset` on write: the base-relative position (exact in a region's own block).
func (w *Writer) Position() int {
	p := w.B.Pos
	if p < 0 {
		p = 0
	}
	return p + w.B.Size
}

// Mark returns the current position as a mark.
func (w *Writer) Mark() Mark { return Mark{w.B, w.B.Size} }

// Extent starts an extent at the current position.
func (w *Writer) Extent() *Extent { return &Extent{block: w.B, start: w.B.Size, end: -1} }

// Close ends an extent.
func (w *Writer) Close(e *Extent) { e.end = w.B.Size }

// RegionExtent is `this` of a base struct: its whole region (size known once finished).
func (w *Writer) RegionExtent() *Extent {
	region := w.Region
	return &Extent{block: region.Root, start: 0, end: -1, regionSize: func() int {
		if region.Output != nil {
			return len(region.Output)
		}
		return region.Root.Size
	}}
}

// BindExtent binds a pending extent to the placeable that holds the field.
func (w *Writer) BindExtent(e *Extent, p *Placeable, emptyIsNull bool) {
	e.placeable = p
	e.block = p.Block
	e.start = 0
	e.end = p.Block.Size
	e.emptyNull = emptyIsNull
}

// ── primitives ──────────────────────────────────────────────────────────────

// U8 writes a byte.
func (w *Writer) U8(v uint8) { w.B.u8(v) }

// U16 writes a uint16.
func (w *Writer) U16(v uint16, le bool) { order(le).PutUint16(w.B.grow(2), v) }

// U32 writes a uint32.
func (w *Writer) U32(v uint32, le bool) { order(le).PutUint32(w.B.grow(4), v) }

// U64 writes a uint64.
func (w *Writer) U64(v uint64, le bool) { order(le).PutUint64(w.B.grow(8), v) }

// I8 writes an int8.
func (w *Writer) I8(v int8) { w.B.u8(uint8(v)) }

// I16 writes an int16.
func (w *Writer) I16(v int16, le bool) { w.U16(uint16(v), le) }

// I32 writes an int32.
func (w *Writer) I32(v int32, le bool) { w.U32(uint32(v), le) }

// I64 writes an int64.
func (w *Writer) I64(v int64, le bool) { w.U64(uint64(v), le) }

// F16 writes a half-precision float (NaN: canonical 0x7e00).
func (w *Writer) F16(v float64, le bool) { w.U16(FloatToHalf(v), le) }

// F32 writes a float32 (NaN: canonical 0x7fc00000).
func (w *Writer) F32(v float32, le bool) { w.U32(float32Bits(v), le) }

// F64 writes a float64 (NaN: canonical 0x7ff8000000000000).
func (w *Writer) F64(v float64, le bool) { w.U64(float64Bits(v), le) }

// Uint writes an unsigned value as primitive p (RANGE if it doesn't fit).
func (w *Writer) Uint(p Prim, v uint64, le bool) {
	bits := uintBits(p, v)
	PutUint(w.B.grow(p.Size()), p.Size(), bits, le)
}

// Int writes a signed value as primitive p (RANGE if it doesn't fit).
func (w *Writer) Int(p Prim, v int64, le bool) {
	bits := intBits(p, v)
	PutUint(w.B.grow(p.Size()), p.Size(), bits, le)
}

// Bool writes a bool byte.
func (w *Writer) Bool(v bool) { w.B.u8(byte(BoolBit(v))) }

// prov is the provenance of bytes copied unchanged from a view's document (commit mode).
func (w *Writer) prov(v []byte) int {
	if w.provBuf == nil || w.Region != w.rootRg {
		return -1
	}
	return aliasOffset(w.provBuf, v)
}

// Bytes writes a byte slice (nil is empty).
func (w *Writer) Bytes(v []byte) { w.B.bytesProv(v, w.prov(v)) }

// BytesN writes exactly n bytes (other lengths would read back differently: DERIVE).
func (w *Writer) BytesN(v []byte, n int) {
	if len(v) != n {
		Fail(DERIVE, "%d bytes given, the length expression says %d", len(v), n)
	}
	w.Bytes(v)
}

// BytesUntil writes bytes followed by a terminator byte (which must not occur inside).
func (w *Writer) BytesUntil(v []byte, term byte) {
	for _, b := range v {
		if b == term {
			Fail(INPUT, "the bytes contain the terminator 0x%x", term)
		}
	}
	w.B.bytes(v)
	w.B.u8(term)
}

// Str writes text: mode 'c' (count) pads with NUL units up to n (longer is INPUT), 'u' (until)
// appends one NUL unit, 'r' (rest) writes the text alone.
func (w *Writer) Str(v string, unit int, enc Encoding, le bool, mode byte, n int) {
	b := EncodeString(v, enc, le)
	switch mode {
	case 'c':
		if len(b) > n*unit {
			Fail(INPUT, "string of %d units exceeds the length %d", len(b)/unit, n)
		}
		w.B.bytes(b)
		w.B.fill(n*unit-len(b), Fill{})
	case 'u':
		w.B.bytes(b)
		w.B.fill(unit, Fill{})
	default:
		w.B.bytes(b)
	}
}

// ── padding ─────────────────────────────────────────────────────────────────

// Pad writes n fill bytes.
func (w *Writer) Pad(n int, f Fill) {
	if n < 0 {
		Fail(RANGE, "invalid padding length %d", n)
	}
	w.B.fill(n, f)
}

// Align pads until the base-relative position is a multiple of to.
func (w *Writer) Align(to int, f Fill) { w.AlignAt(to, 0, false, f) }

// AlignAt pads until (position + offset) is a multiple of to, the position counted from the base
// or, with file, from the start of the byte space. A block whose position is only known
// after layout is placed at a multiple of to, and aligns as if it started there.
func (w *Writer) AlignAt(to, offset int, file bool, f Fill) {
	if to <= 0 {
		Fail(RANGE, "invalid alignment %d", to)
	}
	known, ok := 0, true
	if w.B != w.Region.Root {
		known, ok = w.B.fixedAt, w.B.hasFixedAt
	}
	if !ok {
		w.B.align = lcm(w.B.align, to)
		known = 0
	}
	if file {
		known = fileStart(w.B, to)
	}
	w.B.fill(mod(-(known+w.B.Size+offset), to), f)
}

// PadUntil pads content that started at start (block offset) to size bytes (INPUT if larger).
func (w *Writer) PadUntil(start, size int, f Fill) {
	used := w.B.Size - start
	if used > size {
		Fail(INPUT, "content of %d bytes exceeds padUntil(%d)", used, size)
	}
	w.B.fill(size-used, f)
}

// SizeWindow closes a size(n) window opened at start: longer content is DERIVE, shorter is padded.
func (w *Writer) SizeWindow(start, n int) {
	if n < 0 {
		Fail(RANGE, "invalid size %d", n)
	}
	used := w.B.Size - start
	if used > n {
		Fail(DERIVE, "content of %d bytes does not fit size %d", used, n)
	}
	w.B.fill(n-used, Fill{})
}

// ── fixups ──────────────────────────────────────────────────────────────────

func (w *Writer) addFixup(at, n, phase int, run func(out []byte, abs int)) {
	block := w.B
	if n > 0 {
		block.fill(n, Fill{})
	}
	w.Region.fixups = append(w.Region.fixups, &fixup{block: block, at: at, phase: phase, depth: w.depth, path: w.PS.Snapshot(), run: run})
}

// DeferPrim reserves a primitive whose value is computed after layout (see putPrim).
func (w *Writer) DeferPrim(p Prim, le bool, phase int, compute func() any) {
	w.addFixup(w.B.Size, p.Size(), phase, func(out []byte, abs int) {
		putPrim(out[abs:], p, compute(), le)
	})
}

// putPrim writes a computed value (any Go number or bool, named types included, or a *big.Int)
// as primitive p.
func putPrim(b []byte, p Prim, v any, le bool) {
	v = numValue(v)
	switch p {
	case F16:
		order(le).PutUint16(b, FloatToHalf(toFloat(v)))
		return
	case F32:
		order(le).PutUint32(b, float32Bits(float32(toFloat(v))))
		return
	case F64:
		order(le).PutUint64(b, float64Bits(toFloat(v)))
		return
	}
	switch x := v.(type) {
	case bool:
		PutUint(b, p.Size(), BoolBit(x), le)
	case int64:
		PutUint(b, p.Size(), intBits(p, x), le)
	case uint64:
		PutUint(b, p.Size(), uintBits(p, x), le)
	case *big.Int:
		switch {
		case x.IsInt64():
			PutUint(b, p.Size(), intBits(p, x.Int64()), le)
		case x.IsUint64():
			PutUint(b, p.Size(), uintBits(p, x.Uint64()), le)
		default:
			Fail(RANGE, "%s is out of range for %s", x.String(), p)
		}
	default:
		Fail(INPUT, "unexpected value %v for %s", v, p)
	}
}

// numValue converts any integer, float or bool (named types included) to int64, uint64, float64
// or bool; anything else is returned as it is.
func numValue(v any) any {
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return rv.Int()
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return rv.Uint()
	case reflect.Float32, reflect.Float64:
		return rv.Float()
	case reflect.Bool:
		return rv.Bool()
	}
	return v
}

// toFloat converts a value numValue returned.
func toFloat(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int64:
		return float64(x)
	case uint64:
		return float64(x)
	case *big.Int:
		return BigFloat(x)
	}
	return 0
}

// DeferBytes reserves n bytes whose content is computed after layout.
func (w *Writer) DeferBytes(n int, phase int, compute func() []byte) {
	w.addFixup(w.B.Size, n, phase, func(out []byte, abs int) {
		v := compute()
		if len(v) != n {
			Fail(DERIVE, "derived bytes have length %d, expected %d", len(v), n)
		}
		copy(out[abs:], v)
	})
}

// DeferCheck runs a check after layout (e.g. read-side offsets must match).
func (w *Writer) DeferCheck(phase int, check func()) {
	w.addFixup(0, 0, phase, func([]byte, int) { check() })
}

// ── checks ──────────────────────────────────────────────────────────────────

// Need fails with INPUT (path: the field) when a required value is missing.
func Need(ps *PathStack, f Frame, missing bool, name string) {
	if missing {
		ps.Field(f, name)
		Fail(INPUT, "missing required field %s", name)
	}
}

// CheckLength fails with DERIVE when an array has another length than its length expression.
func CheckLength(actual, expected int) {
	if actual != expected {
		Fail(DERIVE, "%d elements given, the length expression says %d", actual, expected)
	}
}

// CheckPlacement fails with DERIVE when a placed field's offset expression disagrees with where it
// was placed. An empty target reads back the same wherever its offset points.
func CheckPlacement(offset int, p *Placeable, name string) {
	if p.Block.Size > 0 && offset != p.Block.Pos {
		Fail(DERIVE, "%s was placed at %d but its offset expression gives %d", name, p.Block.Pos, offset)
	}
}

// CheckRoundTrip fails with INPUT unless read(write(v)) == v.
func CheckRoundTrip[T comparable](v, back T) {
	if v != back {
		Fail(INPUT, "value %v does not survive the transform (reads back as %v)", v, back)
	}
}

// CheckFloatRoundTrip fails with INPUT unless v is within half a storage step of what reads back
// (back, and next for the neighbouring stored value).
func CheckFloatRoundTrip(v, back, next float64) {
	if v != v && back != back {
		return
	}
	half := math.Abs(next-back) / 2
	if !(math.Abs(v-back) <= half*(1+1e-9)) {
		Fail(INPUT, "value %v does not survive the transform (reads back as %v)", v, back)
	}
}

// BitsU returns v as unsigned bits of width (RANGE if it doesn't fit).
func BitsU(v uint64, width int) uint64 {
	if width < 64 && v >= uint64(1)<<width {
		Fail(RANGE, "%d does not fit in %d bits", v, width)
	}
	return v
}

// BitsI returns a signed v as two's complement bits of width (RANGE if it doesn't fit).
func BitsI(v int64, width int) uint64 {
	if width == 64 {
		return uint64(v)
	}
	if lo, hi := -(int64(1) << (width - 1)), int64(1)<<(width-1)-1; v < lo || v > hi {
		Fail(RANGE, "%d does not fit in %d bits", v, width)
	}
	return uint64(v) & (uint64(1)<<width - 1)
}

// BoolBit is 1 for true.
func BoolBit(b bool) uint64 {
	if b {
		return 1
	}
	return 0
}

// ── targets ─────────────────────────────────────────────────────────────────

// Target places a pointer target: the same object (identity key, non-nil) with the same type key
// shares one placeable. write encodes the target into the placeable's block and returns its
// structure.
func (w *Writer) Target(identity any, key, name string, write func() LEntry, opts PlaceOpts, owner any) *Placeable {
	if identity != nil {
		byKey := w.Region.identity[identity]
		if p := byKey[key]; p != nil {
			return p
		}
		if byKey == nil {
			byKey = map[string]*Placeable{}
			w.Region.identity[identity] = byKey
		}
		p := newPlaceable(w.Region.newBlock(), name, opts)
		byKey[key] = p
		w.fillPlaceable(p, write, identity, owner)
		return p
	}
	p := newPlaceable(w.Region.newBlock(), name, opts)
	w.fillPlaceable(p, write, nil, owner)
	return p
}

// Place places an `at` field's value (no identity sharing).
func (w *Writer) Place(name string, value any, write func() LEntry, opts PlaceOpts, owner any) *Placeable {
	p := newPlaceable(w.Region.newBlock(), name, opts)
	w.fillPlaceable(p, write, value, owner)
	return p
}

func (w *Writer) fillPlaceable(p *Placeable, write func() LEntry, value, owner any) {
	w.noteOrigin(p, value, owner)
	w.Region.placeables = append(w.Region.placeables, p)
	saveB, saveIndex := w.B, w.Index
	w.B = p.Block
	w.Index = -1
	defer func() { w.B, w.Index = saveB, saveIndex }()
	if e := write(); e != nil && !isNilEntry(e) {
		p.Content = e
	}
}

// Pointer writes an owned pointer: the offset of p (nil → the null value, which must exist).
func (w *Writer) Pointer(kind Prim, le bool, p *Placeable, relative bool, nullVal *uint64, origin func() int) {
	if p == nil {
		if nullVal == nil {
			Fail(INPUT, "null for a pointer that is not nullable")
		}
		nv := *nullVal
		w.addFixup(w.B.Size, kind.Size(), 0, func(out []byte, abs int) {
			PutUint(out[abs:], kind.Size(), nv, le)
		})
		return
	}
	w.addFixup(w.B.Size, kind.Size(), 0, func(out []byte, abs int) {
		if p.Block.Pos < 0 {
			Fail(DERIVE, "target %s was not placed", p.Name)
		}
		o := 0
		if origin != nil {
			o = origin()
		}
		v := p.Block.Pos
		if relative {
			v = p.Block.Pos - abs
		}
		writeOffset(out, abs, kind, le, v-o, nullVal)
	})
}

// RefPointer writes a @ref pointer: resolved after layout to the first placed value in this base
// (or an enclosing one) with the same identity, or else an equal encoding of type key.
// identity is the object (nil for scalars); isNull writes the null value.
func (w *Writer) RefPointer(kind Prim, le bool, key string, isNull bool, identity any, encode func() []byte, relative bool, nullVal *uint64, origin func() int) {
	if isNull {
		w.Pointer(kind, le, nil, relative, nullVal, nil)
		return
	}
	mark := w.Mark()
	w.B.fill(kind.Size(), Fill{})
	u := refUse{key: key, path: w.PS.Snapshot(), value: identity, origin: origin, mark: mark, kind: kind, le: le, relative: relative, nullVal: nullVal}
	if identity != nil {
		u.encode = encode
	} else {
		u.encoding = encode()
	}
	w.Region.refUses = append(w.Region.refUses, u)
}

func (w *Writer) adoptRefs(nested *Region, block *Block, at int) {
	for _, u := range nested.unresolved {
		inner := 0
		if u.base != nil {
			inner = u.base.Abs()
		}
		nu := u
		nu.mark = Mark{block, at + u.mark.Abs()}
		nu.base = &Mark{block, at + inner}
		w.Region.refUses = append(w.Region.refUses, nu)
	}
}

// RefSite registers an encoded value (from block offset start to the current offset) as a
// possible @ref target. identity is the object, or nil.
func (w *Writer) RefSite(key string, start int, identity any) {
	w.Region.refSites = append(w.Region.refSites, refSite{key: key, block: w.B, start: start, end: w.B.Size, value: identity})
}

// ── regions ─────────────────────────────────────────────────────────────────

// inRegion writes into a fresh region (set up by init, if any) and finishes it; the writer is back
// in the enclosing region afterwards.
func (w *Writer) inRegion(layout []LayoutItem, value any, init func(*Region), write func() LEntry) (*Region, []byte) {
	region := newRegion()
	region.Layout = layout
	leaveCommit := w.commitEnterRegion(region, value)
	saveB, saveR, saveIndex := w.B, w.Region, w.Index
	defer func() {
		w.Region, w.B, w.Index = saveR, saveB, saveIndex
		leaveCommit()
	}()
	w.Region, w.B = region, region.Root
	if init != nil {
		init(region)
	}
	attach(region, write())
	return region, region.finish()
}

func attach(region *Region, l LEntry) {
	if l == nil || isNilEntry(l) {
		return
	}
	if s, ok := l.(*LStruct); ok {
		region.LRoot = s
		return
	}
	s := NewLStruct(nil)
	s.Set("$", l)
	region.LRoot = s
}

// EncodeAlone encodes a value in a fresh region of its own (a codec's decoded side, a stream's
// encoding, a @ref target's encoding) and returns the finished bytes. Nothing inside escapes to
// the enclosing region.
func (w *Writer) EncodeAlone(write func() LEntry) []byte {
	_, out := w.inRegion(nil, nil, nil, write)
	return out
}

// Base writes a @base struct inline: its region (own block, targets, @alignEnd) is laid out and
// finished on its own, then appended. @ref pointers it can't resolve search this base and the
// ones enclosing it.
func (w *Writer) Base(layout []LayoutItem, write func() LEntry, value any) {
	anchor, at := w.B, w.B.Size
	region, out := w.inRegion(layout, value, func(r *Region) {
		r.anchor, r.anchorAt, r.escalate = anchor, at, true
	}, write)
	w.Bytes(out)
	w.adoptRefs(region, anchor, at)
}

// Serialize runs a root writer in the writer's root region and returns the bytes.
func (w *Writer) Serialize(write func() LEntry) []byte {
	attach(w.Region, write())
	return w.Region.finish()
}
