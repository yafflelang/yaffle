package yaffle

import (
	"bytes"
	"context"
	"strconv"
	"strings"
)

// Codecs (`@via`): calling host codecs, and codec reuse for byte-exact rebuilds
// (docs/IR.md §3.6).

func ctxOf(c context.Context) context.Context {
	if c == nil {
		return context.Background()
	}
	return c
}

// Decode runs a codec's Decode. Failures are CODEC errors at offset.
func Decode(c Codec, name string, input []byte, ctx *CodecCtx, offset int) []byte {
	ctx.Context = ctxOf(ctx.Context)
	var out []byte
	callHost("codec "+name+" failed to decode", offset, func() (err error) {
		out, err = c.Decode(input, ctx)
		return
	})
	if out == nil {
		out = []byte{}
	}
	return out
}

// DecodeStreaming runs a streaming codec's Decode; it returns the output and the bytes consumed.
func DecodeStreaming(c StreamingCodec, name string, input []byte, ctx *CodecCtx, offset int) ([]byte, int) {
	ctx.Context = ctxOf(ctx.Context)
	var out []byte
	var n int
	callHost("codec "+name+" failed to decode", offset, func() (err error) {
		out, n, err = c.Decode(input, ctx)
		return
	})
	if n < 0 || n > len(input) {
		FailAt(CODEC, offset, "streaming codec %s consumed %d of %d bytes", name, n, len(input))
	}
	if out == nil {
		out = []byte{}
	}
	return out, n
}

// Encoder is what Encode needs from a codec (plain and streaming codecs both have it).
type Encoder interface {
	Encode(input []byte, ctx *CodecCtx) ([]byte, error)
}

// Encode runs a codec's Encode. Failures are CODEC errors.
func Encode(c Encoder, name string, input []byte, ctx *CodecCtx) []byte {
	ctx.Context = ctxOf(ctx.Context)
	var out []byte
	callHost("codec "+name+" failed to encode", -1, func() (err error) {
		out, err = c.Encode(input, ctx)
		return
	})
	return out
}

// ── reuse ───────────────────────────────────────────────────────────────────

type codecOrigin struct {
	encoded []byte
	decoded []byte
}

type metaData struct {
	codecs map[string]codecOrigin
	lazy   map[string]*LazyPiece
}

// Meta is bookkeeping that generated structs carry in an unexported field: the original encoded
// bytes of the codec regions they were read from (codec reuse), and the stream pieces a view left
// undecoded. Copying a struct shares it.
type Meta struct {
	m *metaData
}

func (m *Meta) data() *metaData {
	if m.m == nil {
		m.m = &metaData{}
	}
	return m.m
}

// RememberCodec records that the content under `slot` was decoded from `encoded`. `decoded` must
// not be aliased by values.
func (m *Meta) RememberCodec(slot string, encoded, decoded []byte) {
	d := m.data()
	if d.codecs == nil {
		d.codecs = map[string]codecOrigin{}
	}
	d.codecs[slot] = codecOrigin{encoded: encoded, decoded: decoded}
}

// ReuseCodec returns the original encoded bytes if the plain encoding is unchanged.
func (m *Meta) ReuseCodec(slot string, plain []byte) []byte {
	if m == nil || m.m == nil {
		return nil
	}
	o, ok := m.m.codecs[slot]
	if !ok || !bytes.Equal(o.decoded, plain) {
		return nil
	}
	return o.encoded
}

// Slot builds a codec-reuse slot key for values inside arrays.
func Slot(base string, idx ...int) string {
	var b strings.Builder
	b.WriteString(base)
	for _, i := range idx {
		b.WriteByte('@')
		b.WriteString(strconv.Itoa(i))
	}
	return b.String()
}
