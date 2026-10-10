// `extern codec xor(u8 key) @ranged`: every byte XOR key. Its own inverse, and position
// independent, so any slice decodes on its own.
package externs

import (
	"fmt"

	yaffle "yafflelang.org/runtime"
)

type xorCodec struct{}

func xorApply(in []byte, ctx *yaffle.CodecCtx) ([]byte, error) {
	key, err := yaffle.ArgInt(ctx.Args, 0)
	if err != nil || key < 0 || key > 255 {
		return nil, fmt.Errorf("codec key must be a u8, got %v", ctx.Args)
	}
	out := make([]byte, len(in))
	for i, b := range in {
		out[i] = b ^ byte(key)
	}
	return out, nil
}

func (xorCodec) Decode(in []byte, ctx *yaffle.CodecCtx) ([]byte, error) {
	out, err := xorApply(in, ctx)
	if err != nil {
		return nil, err
	}
	if ctx.OutputSize >= 0 && ctx.OutputSize != len(out) {
		return nil, fmt.Errorf("xor: decoded %d bytes, expected %d", len(out), ctx.OutputSize)
	}
	return out, nil
}

func (xorCodec) Encode(in []byte, ctx *yaffle.CodecCtx) ([]byte, error) { return xorApply(in, ctx) }

var xor yaffle.Codec = xorCodec{}
