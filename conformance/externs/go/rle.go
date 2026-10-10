// `extern codec rle`: run-length encoding as (count, byte) pairs with count 1..255.
//
//   - decode: an odd input length or a zero count is an error; so is a decoded length that
//     differs from OutputSize when one is given.
//   - encode: greedy, runs of at most 255 (deterministic, so conformance cases can predict it).
package externs

import (
	"fmt"

	"yafflelang.org/go/yaffle"
)

func rleDecodePairs(in []byte) ([]byte, error) {
	if len(in)%2 != 0 {
		return nil, fmt.Errorf("rle: odd input length %d", len(in))
	}
	out := []byte{}
	for i := 0; i < len(in); i += 2 {
		n := int(in[i])
		if n == 0 {
			return nil, fmt.Errorf("rle: zero run length at %d", i)
		}
		for k := 0; k < n; k++ {
			out = append(out, in[i+1])
		}
	}
	return out, nil
}

func rleEncodePairs(in []byte) []byte {
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
	return out
}

type rleCodec struct{}

func (rleCodec) Decode(in []byte, ctx *yaffle.CodecCtx) ([]byte, error) {
	out, err := rleDecodePairs(in)
	if err != nil {
		return nil, err
	}
	if ctx.OutputSize >= 0 && ctx.OutputSize != len(out) {
		return nil, fmt.Errorf("rle: decoded %d bytes, expected %d", len(out), ctx.OutputSize)
	}
	return out, nil
}

func (rleCodec) Encode(in []byte, _ *yaffle.CodecCtx) ([]byte, error) { return rleEncodePairs(in), nil }

var rle yaffle.Codec = rleCodec{}
