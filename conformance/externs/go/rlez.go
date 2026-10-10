// `extern codec rlez @streaming`: rle pairs followed by a single 0x00 terminator. It finds its own
// end, so it needs no outer @size: Decode reports how many bytes it consumed (terminator included).
// A missing terminator is an error.
package externs

import (
	"bytes"
	"errors"
	"fmt"

	"yafflelang.org/go/yaffle"
)

type rlezCodec struct{}

func (rlezCodec) Decode(in []byte, ctx *yaffle.CodecCtx) ([]byte, int, error) {
	out := []byte{}
	i := 0
	for ; i < len(in) && in[i] != 0; i += 2 {
		if i+1 < len(in) {
			out = append(out, bytes.Repeat(in[i+1:i+2], int(in[i]))...)
		}
	}
	if i >= len(in) {
		return nil, 0, errors.New("rlez: missing terminator")
	}
	if ctx.OutputSize >= 0 && ctx.OutputSize != len(out) {
		return nil, 0, fmt.Errorf("rlez: decoded %d bytes, expected %d", len(out), ctx.OutputSize)
	}
	return out, i + 1, nil
}

func (rlezCodec) Encode(in []byte, _ *yaffle.CodecCtx) ([]byte, error) {
	out := []byte{}
	for i := 0; i < len(in); {
		b := in[i]
		n := 1
		for i+n < len(in) && in[i+n] == b && n < 255 {
			n++
		}
		out = append(out, byte(n), b)
		i += n
	}
	return append(out, 0), nil
}

var rlez yaffle.StreamingCodec = rlezCodec{}
