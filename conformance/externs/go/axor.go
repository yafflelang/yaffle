// `extern async codec axor(u8 key)`: the same transform as xor. Async codecs are blocking calls in
// Go; this one runs on another goroutine and honours the context's cancellation, the way a real
// asynchronous codec (a decompression service, a device) would.
package externs

import (
	"fmt"

	yaffle "yafflelang.org/runtime"
)

type axorCodec struct{}

func axorApply(in []byte, ctx *yaffle.CodecCtx) ([]byte, error) {
	key, err := yaffle.ArgInt(ctx.Args, 0)
	if err != nil || key < 0 || key > 255 {
		return nil, fmt.Errorf("codec key must be a u8, got %v", ctx.Args)
	}
	done := make(chan []byte, 1)
	go func() {
		out := make([]byte, len(in))
		for i, b := range in {
			out[i] = b ^ byte(key)
		}
		done <- out
	}()
	select {
	case out := <-done:
		return out, nil
	case <-ctx.Context.Done():
		return nil, ctx.Context.Err()
	}
}

func (axorCodec) Decode(in []byte, ctx *yaffle.CodecCtx) ([]byte, error) {
	out, err := axorApply(in, ctx)
	if err != nil {
		return nil, err
	}
	if ctx.OutputSize >= 0 && ctx.OutputSize != len(out) {
		return nil, fmt.Errorf("axor: decoded %d bytes, expected %d", len(out), ctx.OutputSize)
	}
	return out, nil
}

func (axorCodec) Encode(in []byte, ctx *yaffle.CodecCtx) ([]byte, error) { return axorApply(in, ctx) }

var axor yaffle.Codec = axorCodec{}
