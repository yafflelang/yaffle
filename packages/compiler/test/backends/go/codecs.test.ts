/** Go backend: externs (by import path, by file, missing), codec reuse, blocking codecs and contexts. */
import { describe, expect, it } from "vitest";
import { compileOk, hasGo, mainGo, makeModule, run } from "./harness.ts";

const d = hasGo ? describe : describe.skip;

const SRC = `
extern codec noisy
extern fn twice(u8 v) -> u8

struct Body { u8 a  u8 b }

export struct Packed {
  u8   n
  Body body @via(noisy) @size(n)
  u8   t = twice(body.a)
}
`;

// A codec that doesn't re-encode to the same bytes: encode appends a varying junk byte that
// decode ignores. Byte-exact rebuilds must reuse the original encoded bytes.
const EXT = `package ext

import (
	"context"
	"errors"

	"yafflelang.org/go/yaffle"
)

var counter byte

type noisyCodec struct{}

func (noisyCodec) Decode(in []byte, ctx *yaffle.CodecCtx) ([]byte, error) {
	if err := ctx.Context.Err(); err != nil {
		return nil, err
	}
	if len(in) == 0 {
		return nil, errors.New("empty")
	}
	return append([]byte{}, in[:len(in)-1]...), nil
}

func (noisyCodec) Encode(in []byte, _ *yaffle.CodecCtx) ([]byte, error) {
	counter++
	return append(append([]byte{}, in...), 0xe0+counter), nil
}

// Noisy is the host implementation of extern codec noisy.
var Noisy yaffle.Codec = noisyCodec{}

// Twice doubles a byte.
func Twice(v uint8) uint8 { return v * 2 }

var _ = context.Background
`;

d("go: externs and codecs", () => {
  it("imports externs by Go import path and reuses original codec bytes", async () => {
    const mod = makeModule("codecs-import", compileOk(SRC), {
      externs: { noisy: "yafflecase/ext.Noisy", twice: "yafflecase/ext.Twice" },
      files: {
        "ext/ext.go": EXT,
        "main.go": mainGo(
          `
	data := []byte{3, 1, 2, 0x99, 2}
	p := must(gen.ParsePacked(data, nil))
	fmt.Println(p.Body.A, p.Body.B, p.T)
	fmt.Printf("%x\\n", must(gen.SerializePacked(p, nil)))
	p.Body.B = 7
	fmt.Printf("%x\\n", must(gen.SerializePacked(p, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := gen.ParsePackedContext(ctx, data, nil)
	e, _ := yaffle.AsError(err)
	fmt.Println(e.Code, yaffle.FormatPath(e.Path))
`,
          ["context"]
        )
      }
    });
    const lines = (await run(mod)).trim().split("\n");
    expect(lines[0]).toBe("1 2 2");
    expect(lines[1]).toBe("03010299" + "02"); // original encoded bytes reused
    expect(lines[2]).toMatch(/^030107e[0-9a-f]02$/); // changed content: re-encoded
    expect(lines[3]).toBe("CODEC body");
  });

  it("compiles with missing externs and fails with INPUT when they are used", async () => {
    const mod = makeModule("codecs-missing", compileOk(SRC), {
      files: {
        "main.go": mainGo(`
	_, err := gen.ParsePacked([]byte{3, 1, 2, 0x99, 2}, nil)
	e, _ := yaffle.AsError(err)
	fmt.Println(e.Code, yaffle.FormatPath(e.Path))
`)
      }
    });
    expect((await run(mod)).trim()).toBe("INPUT body");
  });
});
