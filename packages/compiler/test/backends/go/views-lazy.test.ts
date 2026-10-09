/**
 * Go views over lazy streams and @ranged codecs (docs/targets/go.md, "Views"): a view
 * decodes only the stream pieces and codec blocks a read touches. Codec calls are counted by test
 * externs that become part of the generated package.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, compileOk, hasGo, mainGo, makeModule, run } from "./harness.ts";

const DEPS = { "github.com/klauspost/compress": "v1.20.1" };

const d = hasGo ? describe : describe.skip;

/** Counting codecs: zstd (klauspost) and xorpos (@ranged), with exported counters. */
const EXTERNS = `package externs

import (
	"sync/atomic"

	kzstd "github.com/klauspost/compress/zstd"
	"yaffle.dev/yaffle"
)

// Counters read by the tests.
var (
	ZstdDecodes  atomic.Int64
	XorDecodes   atomic.Int64
	XorBytes     atomic.Int64
	zstdDec, _   = kzstd.NewReader(nil, kzstd.WithDecoderConcurrency(1), kzstd.WithDecoderMaxMemory(1<<32))
	zstdEnc, _   = kzstd.NewWriter(nil, kzstd.WithEncoderConcurrency(1))
)

type countingZstd struct{}

func (countingZstd) Decode(in []byte, _ *yaffle.CodecCtx) ([]byte, error) {
	ZstdDecodes.Add(1)
	return zstdDec.DecodeAll(in, nil)
}

func (countingZstd) Encode(in []byte, _ *yaffle.CodecCtx) ([]byte, error) {
	return zstdEnc.EncodeAll(in, nil), nil
}

var zstd yaffle.Codec = countingZstd{}

type countingXorpos struct{}

func xp(in []byte, ctx *yaffle.CodecCtx) []byte {
	key := int(ctx.Args[0].(uint8))
	out := make([]byte, len(in))
	for i, b := range in {
		out[i] = b ^ byte(key+ctx.Position+i)
	}
	return out
}

func (countingXorpos) Decode(in []byte, ctx *yaffle.CodecCtx) ([]byte, error) {
	XorDecodes.Add(1)
	XorBytes.Add(int64(len(in)))
	return xp(in, ctx), nil
}

func (countingXorpos) Encode(in []byte, ctx *yaffle.CodecCtx) ([]byte, error) { return xp(in, ctx), nil }

var xorpos yaffle.Codec = countingXorpos{}
`;

function externsFile(name: string): string {
  const dir = join(ROOT, `${name}-externs`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "counting.go");
  writeFileSync(file, EXTERNS);
  return file;
}

d("go views: lazy streams", () => {
  it("decodes only the stream pieces a read touches (sizes from the data)", async () => {
    const p = compileOk(`
extern codec zstd
extern codec xorpos(u8 key) @ranged
export struct Frags {
  u32  n
  Frag frags[n]
  Body file from frags[*].data
}
struct Frag { u32 exp  u32 comp  u8 data[] @size(exp) @via(zstd) @size(comp) @hidden }
export struct Body { u32 count  Item items[count] }
struct Item { u32 a  u32 b }
`);
    const ext = externsFile("lazy-frags");
    const mod = makeModule("views-lazy-frags", p, {
      externs: { zstd: ext, xorpos: ext },
      deps: DEPS,
      targetOptions: { materialize: true },
      files: {
        "main.go": mainGo(`
	// 400 items (3204 bytes) in pieces of 100 bytes.
	items := make([]*gen.Item, 400)
	for i := range items {
		items[i] = &gen.Item{A: uint32(i), B: uint32(i * 3)}
	}
	plain := must(gen.SerializeBody(&gen.Body{Items: items}, nil))
	var frags []*gen.Frag
	for at := 0; at < len(plain); at += 100 {
		frags = append(frags, &gen.Frag{})
	}
	exp := make([]uint32, len(frags))
	for k := range frags {
		exp[k] = uint32(min(100, len(plain)-k*100))
		frags[k].Exp = &exp[k]
	}
	data := must(gen.SerializeFrags(&gen.Frags{Frags: frags, File: &gen.Body{Items: items}}, nil))
	gen.ZstdDecodes.Store(0)
	v := must(gen.ViewFrags(data, nil))
	fmt.Println(gen.ZstdDecodes.Load())
	f := must(v.FileView())
	is := must(f.ItemsViews())
	fmt.Println(len(is), must(is[300].B()), gen.ZstdDecodes.Load())
	// The whole value through the view equals parse.
	w := must(gen.ViewFrags(data, nil))
	m := must(gen.MaterializeFragsView(w))
	fmt.Println(string(must(gen.FragsToJSON(m))) == string(must(gen.FragsToJSON(must(gen.ParseFrags(data, nil))))))
	// A bad piece fails where a parse fails.
	bad := append([]byte{}, data...)
	bad[16] ^= 0xff
	_, perr := gen.ParseFrags(bad, nil)
	bv := must(gen.ViewFrags(bad, nil))
	_, verr := gen.MaterializeFragsView(bv)
	pe, _ := yaffle.AsError(perr)
	ve, _ := yaffle.AsError(verr)
	fmt.Println(pe.Code, yaffle.FormatPath(pe.Path), ve.Code, yaffle.FormatPath(ve.Path))
`)
      }
    });
    const lines = (await run(mod)).trim().split("\n");
    // Nothing is decoded before the view of the stream is opened (its scan then reads the
    // inline items, which span every piece).
    expect(lines[0]).toBe("0");
    expect(lines[1]!.split(" ").slice(0, 2)).toEqual(["400", "900"]);
    expect(lines[2]).toBe("true");
    expect(lines[3]).toBe("CODEC frags[0].data CODEC frags[0].data");
  }, 300_000);

  it("decodes only the @ranged blocks a read touches", async () => {
    const p = compileOk(`
extern codec zstd
extern codec xorpos(u8 key) @ranged
export struct Enc { u32 size  Blob body @via(xorpos(7)) @size(size) }
struct Blob { u32 n  u32 ofs  u8 tail[n] at ofs  u32 bigOfs  u8 big[0x10000] at bigOfs }
`);
    const ext = externsFile("lazy-ranged");
    const mod = makeModule("views-lazy-ranged", p, {
      externs: { zstd: ext, xorpos: ext },
      deps: DEPS,
      targetOptions: { materialize: true },
      files: {
        "main.go": mainGo(`
	big := make([]byte, 0x10000)
	for i := range big {
		big[i] = byte(i * 7)
	}
	data := must(gen.SerializeEnc(&gen.Enc{Body: &gen.Blob{Tail: []byte{1, 2, 3, 4}, Big: big}}, nil))
	gen.XorDecodes.Store(0)
	gen.XorBytes.Store(0)
	v := must(gen.ViewEnc(data, nil))
	b := must(v.BodyView())
	fmt.Println(must(b.N()), must(b.Tail()), gen.XorBytes.Load() <= 2*0x1000)
	w := must(gen.ViewEnc(data, nil))
	m := must(gen.MaterializeEncView(w))
	fmt.Println(string(must(gen.EncToJSON(m))) == string(must(gen.EncToJSON(must(gen.ParseEnc(data, nil))))))
	out := must(w.Commit(yaffle.CommitOptions{}))
	fmt.Println(string(out) == string(data))
`)
      }
    });
    const lines = (await run(mod)).trim().split("\n");
    expect(lines).toEqual(["4 [1 2 3 4] true", "true", "true"]);
  }, 300_000);
});
