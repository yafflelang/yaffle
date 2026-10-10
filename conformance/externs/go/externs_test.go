package externs

import (
	"bytes"
	"context"
	"testing"

	yaffle "yafflelang.org/runtime"
)

func ctx(args ...any) *yaffle.CodecCtx {
	return &yaffle.CodecCtx{Context: context.Background(), Args: args, OutputSize: -1}
}

func TestXor(t *testing.T) {
	enc, err := xor.Encode([]byte{1, 2, 3}, ctx(uint8(0x5a)))
	if err != nil || !bytes.Equal(enc, []byte{0x5b, 0x58, 0x59}) {
		t.Fatal(enc, err)
	}
	c := ctx(uint8(0x5a))
	c.OutputSize = 2
	if _, err := xor.Decode(enc, c); err == nil {
		t.Fatal("outputSize not checked")
	}
	if _, err := xor.Decode(enc, ctx(300)); err == nil {
		t.Fatal("bad key accepted")
	}
}

func TestXorpos(t *testing.T) {
	c := ctx(uint8(0x10))
	c.Position = 2
	out, _ := xorpos.Decode([]byte{0, 0}, c)
	if !bytes.Equal(out, []byte{0x12, 0x13}) {
		t.Fatal(out)
	}
}

func TestAxor(t *testing.T) {
	out, err := axor.Decode([]byte{0x11}, ctx(uint8(0x11)))
	if err != nil || out[0] != 0 {
		t.Fatal(out, err)
	}
	cc, cancel := context.WithCancel(context.Background())
	cancel()
	c := ctx(uint8(1))
	c.Context = cc
	for i := 0; i < 100; i++ {
		if _, err := axor.Decode(make([]byte, 1<<16), c); err != nil {
			return // cancellation observed
		}
	}
}

func TestRle(t *testing.T) {
	enc, _ := rle.Encode([]byte{7, 7, 7, 1}, ctx())
	if !bytes.Equal(enc, []byte{3, 7, 1, 1}) {
		t.Fatal(enc)
	}
	dec, err := rle.Decode(enc, ctx())
	if err != nil || !bytes.Equal(dec, []byte{7, 7, 7, 1}) {
		t.Fatal(dec, err)
	}
	if _, err := rle.Decode([]byte{0, 1}, ctx()); err == nil {
		t.Fatal("zero run accepted")
	}
	if _, err := rle.Decode([]byte{1}, ctx()); err == nil {
		t.Fatal("odd length accepted")
	}
}

func TestRlez(t *testing.T) {
	out, n, err := rlez.Decode([]byte{2, 9, 0, 0xff}, ctx())
	if err != nil || n != 3 || !bytes.Equal(out, []byte{9, 9}) {
		t.Fatal(out, n, err)
	}
	if _, _, err := rlez.Decode([]byte{2, 9}, ctx()); err == nil {
		t.Fatal("missing terminator accepted")
	}
	enc, _ := rlez.Encode([]byte{9, 9}, ctx())
	if !bytes.Equal(enc, []byte{2, 9, 0}) {
		t.Fatal(enc)
	}
}

func TestFns(t *testing.T) {
	if sum8([]byte{200, 100}) != 44 || swap16(0x1234) != 0x3412 {
		t.Fatal("fns")
	}
}

func TestVarInt(t *testing.T) {
	b, err := VarInt.Write(300, []any{uint8(5)})
	if err != nil || !bytes.Equal(b, []byte{0xac, 0x02}) {
		t.Fatal(b, err)
	}
	if n, ok, _ := VarInt.Size([]byte{0xac}, []any{uint8(5)}); ok || n != 0 {
		t.Fatal("need more")
	}
	if _, _, err := VarInt.Size([]byte{0x80, 0x80}, []any{uint8(2)}); err == nil {
		t.Fatal("too long accepted")
	}
	if v, _ := VarInt.Read(b, []any{uint8(5)}); v != 300 {
		t.Fatal(v)
	}
	if _, err := VarInt.Write(1<<40, []any{uint8(2)}); err == nil {
		t.Fatal("overflow accepted")
	}
	max, _ := VarInt.Write(^uint64(0), []any{uint8(10)})
	if v, err := VarInt.Read(max, []any{uint8(10)}); err != nil || v != ^uint64(0) {
		t.Fatal(v, err)
	}
}

func TestBcd16(t *testing.T) {
	b, _ := Bcd16.Write(1234, nil)
	if !bytes.Equal(b, []byte{0x12, 0x34}) {
		t.Fatal(b)
	}
	if v, _ := Bcd16.Read([]byte{0x20, 0x26}, nil); v != 2026 {
		t.Fatal(v)
	}
	if _, err := Bcd16.Read([]byte{0x1a, 0}, nil); err == nil {
		t.Fatal("bad digit accepted")
	}
	if _, err := Bcd16.Write(10000, nil); err == nil {
		t.Fatal("out of range accepted")
	}
}
