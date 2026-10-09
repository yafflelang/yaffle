package yaffle

import (
	"bytes"
	"errors"
	"math"
	"math/big"
	"strings"
	"testing"
)

// catch runs f and returns the *Error it raised (or nil).
func catch(f func()) *Error {
	ps := &PathStack{}
	err := Catch(ps, f)
	if err == nil {
		return nil
	}
	e, _ := AsError(err)
	return e
}

func wantCode(t *testing.T, code Code, f func()) *Error {
	t.Helper()
	e := catch(f)
	if e == nil {
		t.Fatalf("expected %s, got no error", code)
	}
	if e.Code != code {
		t.Fatalf("expected %s, got %v", code, e)
	}
	return e
}

func TestErrorFormatting(t *testing.T) {
	e := &Error{Code: CHECK, Path: []any{"entries", 2, "x"}, Offset: 16, Detail: "bad"}
	if got := e.Error(); got != "CHECK at entries[2].x (offset 0x10): bad" {
		t.Fatal(got)
	}
	var err error = e
	if x, ok := AsError(err); !ok || x != e {
		t.Fatal("AsError")
	}
	if _, ok := AsError(errors.New("x")); ok {
		t.Fatal("AsError of a plain error")
	}
}

func TestPathStack(t *testing.T) {
	ps := &PathStack{}
	err := Catch(ps, func() {
		f := ps.Enter()
		ps.Field(f, "entries")
		ix := ps.PushIndex()
		ps.SetIndex(ix, 3)
		g := ps.Enter()
		ps.Field(g, "")
		ps.Field(g, "y")
		Fail(EOF, "boom")
	})
	e, _ := AsError(err)
	if e == nil || FormatPath(e.Path) != "entries[3].y" {
		t.Fatalf("path: %v", err)
	}
	// Try keeps the relative path and restores the stack.
	ps2 := &PathStack{}
	f := ps2.Enter()
	ps2.Field(f, "a")
	got := Try(ps2, func() {
		g := ps2.Enter()
		ps2.Field(g, "b")
		Fail(RANGE, "x")
	})
	if got == nil || FormatPath(got.Path) != "b" || len(ps2.segs) != 1 {
		t.Fatalf("try: %v depth %d", got, len(ps2.segs))
	}
}

func TestHalf(t *testing.T) {
	cases := map[uint16]float32{0x3c00: 1, 0xc000: -2, 0x7bff: 65504, 0x0001: 5.960464477539063e-08, 0x0000: 0}
	for h, f := range cases {
		if got := HalfToFloat(h); got != f {
			t.Fatalf("%#x: %v", h, got)
		}
		if got := FloatToHalf(float64(f)); got != h {
			t.Fatalf("%v: %#x", f, got)
		}
	}
	if FloatToHalf(math.NaN()) != 0x7e00 || FloatToHalf(math.Inf(-1)) != 0xfc00 || FloatToHalf(1e6) != 0x7c00 {
		t.Fatal("specials")
	}
	if FloatToHalf(math.Copysign(0, -1)) != 0x8000 {
		t.Fatal("-0")
	}
	// ties to even: 1 + 2^-11 lies halfway between 1 and 1 + 2^-10
	if FloatToHalf(1+math.Ldexp(1, -11)) != 0x3c00 || FloatToHalf(1+3*math.Ldexp(1, -11)) != 0x3c02 {
		t.Fatal("rounding")
	}
}

func TestUints(t *testing.T) {
	b := make([]byte, 8)
	PutUint(b, 3, 0x123456, true)
	if !bytes.Equal(b[:3], []byte{0x56, 0x34, 0x12}) || GetUint(b, 3, true) != 0x123456 {
		t.Fatal("le")
	}
	PutUint(b, 5, 0x0102030405, false)
	if !bytes.Equal(b[:5], []byte{1, 2, 3, 4, 5}) || GetUint(b, 5, false) != 0x0102030405 {
		t.Fatal("be")
	}
	if SignExtend(0xffffff, 24) != -1 || SignExtend(0x7fffff, 24) != 0x7fffff {
		t.Fatal("sign")
	}
	if !PrimRangeI64(I24, -0x800000) || PrimRangeI64(I24, 0x800000) || !PrimRangeU64(U40, 1<<40-1) || PrimRangeU64(U40, 1<<40) {
		t.Fatal("ranges")
	}
}

func TestIntSemantics(t *testing.T) {
	if Div(-7, 2) != -3 || Mod(-7, 2) != -1 || Mod(7, -2) != 1 {
		t.Fatal("trunc")
	}
	wantCode(t, RANGE, func() { Div(1, 0) })
	wantCode(t, RANGE, func() { ShiftCount(64) })
	if BigDiv(BigI(-7), BigI(2)).Int64() != -3 || BigMod(BigI(-7), BigI(2)).Int64() != -1 {
		t.Fatal("big trunc")
	}
	if BigShr(BigI(-8), 1).Int64() != -4 || BigNot(BigI(5)).Int64() != -6 {
		t.Fatal("big bits")
	}
	if Round(2.5) != 3 || Round(-2.5) != -3 || Round(0.49) != 0 {
		t.Fatal("round")
	}
	wantCode(t, RANGE, func() { Round(math.NaN()) })
	wantCode(t, RANGE, func() { Len(-1, "n") })
	wantCode(t, RANGE, func() { CheckI64(300, 0, 255, "u8") })
	wantCode(t, RANGE, func() { BigToU64(new(big.Int).Lsh(BigI(1), 64), math.MaxUint64, "u64") })
	if Sum([]uint16{1, 2, 3}) != 6 || MinOf([]int8{3, -1, 2}) != -1 || MaxOf([]float32{1, 4, 2}) != 4 {
		t.Fatal("aggregates")
	}
	wantCode(t, RANGE, func() { MinOf([]int{}) })
	if SumU([]uint64{math.MaxUint64, 1}).String() != "18446744073709551616" {
		t.Fatal("sumU")
	}
	wantCode(t, RANGE, func() { At([]int{1}, 1) })
	wantCode(t, INPUT, func() { Get[int](nil, "x") })
}

func TestStrings(t *testing.T) {
	if DecodeString([]byte{0xe9}, Latin1, true, 0) != "é" {
		t.Fatal("latin1")
	}
	wantCode(t, CHECK, func() { DecodeString([]byte{0x80}, ASCII, true, 0) })
	wantCode(t, CHECK, func() { DecodeString([]byte{0xc3}, UTF8, true, 0) })
	if DecodeString([]byte{0x3d, 0xd8, 0x00, 0xde}, UTF16, true, 0) != "😀" {
		t.Fatal("utf16 pair")
	}
	wantCode(t, CHECK, func() { DecodeString([]byte{0x00, 0xdc}, UTF16, true, 0) })
	wantCode(t, CHECK, func() { DecodeString([]byte{0, 0, 0x11, 0}, UTF32, true, 0) })
	if !bytes.Equal(EncodeString("😀", UTF16, false), []byte{0xd8, 0x3d, 0xde, 0x00}) {
		t.Fatal("utf16 encode")
	}
	wantCode(t, INPUT, func() { EncodeString("a\x00b", UTF8, true) })
	wantCode(t, INPUT, func() { EncodeString("€", Latin1, true) })
	if EncodedLen("😀a", UTF16) != 6 || CodeUnits("😀a", UTF32) != 2 || CodeUnits("é", UTF8) != 2 {
		t.Fatal("lengths")
	}
	wantCode(t, INPUT, func() { EncodeFixedString("abcde", 4, UTF8, true) })
}

func TestReader(t *testing.T) {
	r := NewReader([]byte{1, 0, 2, 0, 0, 0, 'h', 'i', 0, 9}, false)
	if r.U16(true) != 1 || r.U32(true) != 2 || r.StrUntil(1, UTF8, true) != "hi" || r.U8() != 9 {
		t.Fatal("reads")
	}
	wantCode(t, EOF, func() { r.U8() })
	r2 := NewReader([]byte{5, 6}, true)
	wantCode(t, CHECK, func() { r2.Bool(true) })
	r3 := NewReader([]byte{1, 2, 3}, false)
	wantCode(t, RANGE, func() { r3.Count(-1, 1) })
	wantCode(t, EOF, func() { r3.CountU(math.MaxUint64, 1) })
	if n := r3.Count(3, 1); n != 3 {
		t.Fatal("count")
	}
	// windows and strict padding
	r4 := NewReader([]byte{1, 0, 7, 2}, false)
	w := r4.Window(3)
	r4.U8()
	wantCode(t, CHECK, func() { r4.CloseWindow(w, true) })
	r5 := NewReader([]byte{1, 0, 0, 2}, false)
	w5 := r5.Window(3)
	r5.U8()
	r5.CloseWindow(w5, true)
	if r5.U8() != 2 {
		t.Fatal("window")
	}
}

type node struct {
	V    uint8
	Next *node
}

func TestTargetsIdentityAndCycles(t *testing.T) {
	// node at 0: v=1, next=2; node at 2: v=2, next=0 (a cycle)
	data := []byte{1, 2, 2, 0}
	var read func(r *Reader) *node
	read = func(r *Reader) *node {
		v := Into[node](r)
		v.V = r.U8()
		p := int(r.U8())
		v.Next = TargetStruct(r, p, "node", func() *node { return read(r) })
		return v
	}
	r := NewReader(data, false)
	root := Inline(r, "node", func() *node { return read(r) })
	if root.Next.Next != root || root.Next.V != 2 {
		t.Fatal("cycle identity")
	}
	j := NewJSONWriter()
	var emit func(n *node, p string)
	emit = func(n *node, p string) {
		j.BeginObject()
		j.Key("v")
		j.Uint(uint64(n.V))
		j.Key("next")
		if !j.Ref(n.Next, JPtr(p, "next")) {
			emit(n.Next, JPtr(p, "next"))
		}
		j.EndObject()
	}
	j.Ref(root, "")
	emit(root, "")
	if got := string(j.Bytes()); got != `{"v":1,"next":{"v":2,"next":{"$ref":""}}}` {
		t.Fatal(got)
	}
}

func TestUnion(t *testing.T) {
	r := NewReader([]byte{2, 7}, false)
	got := r.Union([]string{"A", "B"}, func(i int) {
		tag := r.U8()
		if int(tag) != i+1 {
			FailAt(CHECK, r.Pos-1, "tag")
		}
	})
	if got != 1 || r.Pos != 1 {
		t.Fatalf("variant %d pos %d", got, r.Pos)
	}
	r2 := NewReader([]byte{9}, false)
	e := wantCode(t, UNION, func() {
		r2.Union([]string{"A", "B"}, func(i int) { FailAt(CHECK, 0, "no") })
	})
	if len(e.Causes) != 2 || FormatPath(e.Causes[1].Path) != "B" {
		t.Fatalf("causes %v", e.Causes)
	}
}

func TestWriterLayout(t *testing.T) {
	// root: [u8 ptrA][u8 ptrB]; targets laid out per items {b, a}
	w := NewWriter([]LayoutItem{{Path: []string{"b"}}, {Path: []string{"a"}}})
	out, err := SerializeWith(nil, w.Region.Layout, func(w *Writer) LEntry {
		l := NewLStruct(w.Region.Layout)
		pa := w.Target(nil, "u16", "a", func() LEntry { w.U16(0x1111, true); return nil }, PlaceOpts{}, nil)
		w.Pointer(U8, true, pa, false, nil, nil)
		pb := w.Target(nil, "u16", "b", func() LEntry { w.U16(0x2222, true); return nil }, PlaceOpts{}, nil)
		w.Pointer(U8, true, pb, false, nil, nil)
		l.Set("a", pa)
		l.Set("b", pb)
		return l
	})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out, []byte{4, 2, 0x22, 0x22, 0x11, 0x11}) {
		t.Fatalf("% x", out)
	}
	// fixed placements overlapping the inline bytes
	_, err = SerializeWith(nil, nil, func(w *Writer) LEntry {
		w.U16(0, true)
		w.Place("x", nil, func() LEntry { w.U8(1); return nil }, PlaceOpts{Fixed: 1, HasFixed: true}, nil)
		return nil
	})
	if e, _ := AsError(err); e == nil || e.Code != OVERLAP {
		t.Fatalf("overlap: %v", err)
	}
	// alignment and deferred values
	out, err = SerializeWith(nil, nil, func(w *Writer) LEntry {
		x := w.Extent()
		w.DeferPrim(U8, true, 0, func() any { return int64(x.Size()) })
		w.U8(9)
		w.Align(4, Fill{Byte: 0xcc})
		w.Close(x)
		return nil
	})
	if err != nil || !bytes.Equal(out, []byte{4, 9, 0xcc, 0xcc}) {
		t.Fatalf("% x %v", out, err)
	}
	// a deferred value out of range has the path captured when it was registered
	_, err = SerializeWith(nil, nil, func(w *Writer) LEntry {
		f := w.Enter()
		w.Field(f, "n")
		w.DeferPrim(U8, true, 0, func() any { return int64(300) })
		w.Leave(f)
		return nil
	})
	if e, _ := AsError(err); e == nil || e.Code != RANGE || FormatPath(e.Path) != "n" {
		t.Fatalf("deferred: %v", err)
	}
}

func TestInstanceLayout(t *testing.T) {
	// Layout items computed per instance: an alignment below 1 is RANGE, in groups too.
	ok := []LayoutItem{{Path: []string{"d"}, Layers: []LayoutLayer{{Kind: LAlign, N: 1}}}}
	if got := InstanceLayout(ok); len(got) != 1 || got[0].Layers[0].N != 1 {
		t.Fatalf("%v", got)
	}
	e := wantCode(t, RANGE, func() {
		InstanceLayout([]LayoutItem{{Path: []string{"d"}, Layers: []LayoutLayer{{Kind: LAlign, N: 0}}}})
	})
	if !strings.Contains(e.Detail, "layout item d is 0") {
		t.Fatalf("detail %q", e.Detail)
	}
	e = wantCode(t, RANGE, func() {
		InstanceLayout([]LayoutItem{{Path: []string{"vs"}, Group: []LayoutItem{
			{Path: []string{"pieces", "*", "body"}, Layers: []LayoutLayer{{Kind: LAlign, N: -4, Offset: 1}}},
		}}})
	})
	if !strings.Contains(e.Detail, "pieces[*].body is -4") {
		t.Fatalf("detail %q", e.Detail)
	}
	// a target aligned by an instance layout
	out, err := SerializeWith(nil, nil, func(w *Writer) LEntry {
		l := NewLStruct(nil)
		w.U8(3)
		p := w.Target(nil, "u8", "d", func() LEntry { w.U8(0xaa); return nil }, PlaceOpts{}, nil)
		w.Pointer(U8, true, p, false, nil, nil)
		l.Set("d", p)
		l.Layout = InstanceLayout([]LayoutItem{{Path: []string{"d"}, Layers: []LayoutLayer{{Kind: LAlign, N: 3}}}})
		return l
	})
	if err != nil || !bytes.Equal(out, []byte{3, 3, 0, 0xaa}) {
		t.Fatalf("% x %v", out, err)
	}
}

func TestRefPointers(t *testing.T) {
	out, err := SerializeWith(nil, nil, func(w *Writer) LEntry {
		s := w.Offset()
		w.Str("ab", 1, UTF8, true, 'u', 0)
		w.RefSite("str", s, nil)
		w.RefPointer(U8, true, "str", false, nil, func() []byte { return []byte("ab\x00") }, false, nil, nil)
		return nil
	})
	if err != nil || !bytes.Equal(out, []byte{'a', 'b', 0, 0}) {
		t.Fatalf("% x %v", out, err)
	}
	_, err = SerializeWith(nil, nil, func(w *Writer) LEntry {
		w.RefPointer(U8, true, "str", false, nil, func() []byte { return []byte("zz\x00") }, false, nil, nil)
		return nil
	})
	if e, _ := AsError(err); e == nil || e.Code != REF {
		t.Fatalf("ref: %v", err)
	}
}

type failing struct{}

func (failing) Decode([]byte, *CodecCtx) ([]byte, error) { return nil, errors.New("corrupt") }
func (failing) Encode(b []byte, _ *CodecCtx) ([]byte, error) {
	panic("encoder exploded")
}

func TestCodecs(t *testing.T) {
	e := wantCode(t, CODEC, func() { Decode(failing{}, "f", []byte{1}, &CodecCtx{OutputSize: -1}, 5) })
	if e.Offset != 5 || !strings.Contains(e.Detail, "corrupt") {
		t.Fatal(e)
	}
	wantCode(t, CODEC, func() { Encode(failing{}, "f", []byte{1}, &CodecCtx{}) })
	var m Meta
	m.RememberCodec("s", []byte{9}, []byte{1, 2})
	if !bytes.Equal(m.ReuseCodec("s", []byte{1, 2}), []byte{9}) || m.ReuseCodec("s", []byte{1}) != nil {
		t.Fatal("reuse")
	}
	if got := splitBySizes([]byte{1, 2, 3}, []int{1, 2}); len(got) != 2 || got[1][1] != 3 {
		t.Fatal("split")
	}
	wantCode(t, DERIVE, func() { splitBySizes([]byte{1, 2, 3}, []int{1}) })
}

func TestJSON(t *testing.T) {
	j := NewJSONWriter()
	j.BeginArray()
	j.Float(math.NaN())
	j.Float(math.Copysign(0, -1))
	j.Float(0.1)
	j.UintStr(math.MaxUint64)
	j.Hex([]byte{0xab, 1})
	j.Str("a\"\n\x01")
	j.EndArray()
	if got := string(j.Bytes()); got != `["NaN","-0",0.1,"18446744073709551615","ab01","a\"\n\u0001"]` {
		t.Fatal(got)
	}
	v := ParseJSON([]byte(`{"a": 1, "b": "18446744073709551615", "c": 1.5}`))
	o := JObject(v)
	if JUint(o["a"], 255, false, "u8") != 1 || JUint(o["b"], math.MaxUint64, true, "u64") != math.MaxUint64 {
		t.Fatal("ints")
	}
	wantCode(t, RANGE, func() { JUint(o["c"], 255, false, "u8") })
	wantCode(t, RANGE, func() { JInt(ParseJSON([]byte("200")), -128, 127, false, "i8") })
	wantCode(t, INPUT, func() { JUint(o["b"], 255, false, "u8") })
	wantCode(t, INPUT, func() { JBytes("abc") })
	if !math.IsInf(JFloat("-Infinity"), -1) || RoundToHalf(JFloat(ParseJSON([]byte("0.1")))) != HalfToFloat(0x2e66) {
		t.Fatal("floats")
	}
	c := NewFromJSON()
	x := &node{}
	c.Register("/a", x)
	if got, ok := DerefAs[*node](c, map[string]any{"$ref": "/a"}); !ok || got != x {
		t.Fatal("deref")
	}
	wantCode(t, INPUT, func() { c.Deref(map[string]any{"$ref": "/nope"}) })
}

func TestDiff(t *testing.T) {
	orig := []byte("0123456789abcdef")
	out := []byte("0123X56789abcdefZZ")
	ps := Diff(orig, out, nil)
	if !bytes.Equal(ApplyPatches(orig, ps), out) {
		t.Fatalf("%v", ps)
	}
	// Same length: only the differing run.
	ps1 := Diff(orig, []byte("0123X56789abcdeF"), nil)
	if len(ps1) != 2 || ps1[0].At != 4 || ps1[0].Remove != 1 || ps1[1].At != 15 {
		t.Fatalf("%+v", ps1)
	}
	// An insertion inside: anchors keep the moved tail out of the patches.
	out2 := []byte("0123456789++abcdef")
	ps2 := Diff(orig, out2, []Anchor{{N: 12, O: 10, Len: 6}})
	if !bytes.Equal(ApplyPatches(orig, ps2), out2) || len(ps2) != 1 || ps2[0].Remove != 0 {
		t.Fatalf("%+v", ps2)
	}
}

func TestLEB128(t *testing.T) {
	b, _ := Uleb128.Write(624485, nil)
	if !bytes.Equal(b, []byte{0xe5, 0x8e, 0x26}) {
		t.Fatalf("% x", b)
	}
	if n, ok, _ := Uleb128.Size([]byte{0xe5, 0x8e}, nil); ok || n != 0 {
		t.Fatal("need more")
	}
	if v, _ := Uleb128.Read(b, nil); v != 624485 {
		t.Fatal("read")
	}
	s, _ := Sleb128.Write(-123456, nil)
	if v, _ := Sleb128.Read(s, nil); v != -123456 || !bytes.Equal(s, []byte{0xc0, 0xbb, 0x78}) {
		t.Fatalf("sleb % x", s)
	}
}
