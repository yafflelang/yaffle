// `extern codec xorpos(u8 key) @ranged`: byte i of the encoded region is XORed with
// (key + i) & 0xff, where i counts from the start of the whole region. A slice decodes on its own
// only when it is given its position (ctx.Position).
package externs

import (
	"fmt"

	yaffle "yafflelang.org/runtime"
)

type xorposCodec struct{}

func xorposApply(in []byte, ctx *yaffle.CodecCtx) ([]byte, error) {
	key, err := yaffle.ArgInt(ctx.Args, 0)
	if err != nil || key < 0 || key > 255 {
		return nil, fmt.Errorf("codec key must be a u8, got %v", ctx.Args)
	}
	out := make([]byte, len(in))
	for i, b := range in {
		out[i] = b ^ byte(int(key)+ctx.Position+i)
	}
	return out, nil
}

func (xorposCodec) Decode(in []byte, ctx *yaffle.CodecCtx) ([]byte, error) {
	return xorposApply(in, ctx)
}

func (xorposCodec) Encode(in []byte, ctx *yaffle.CodecCtx) ([]byte, error) {
	return xorposApply(in, ctx)
}

var xorpos yaffle.Codec = xorposCodec{}
