package yaffle

import "context"

// The glue of the generated entry points: each runs generated code and converts the *Error it
// panics with into a returned error.

// ParseWith runs a generated root reader over data.
func ParseWith[T any](ctx context.Context, data []byte, strict bool, read func(r *Reader) T) (v T, err error) {
	r := NewReader(data, strict)
	if ctx != nil {
		r.Ctx = ctx
	}
	err = Catch(r.PS, func() { v = read(r) })
	return
}

// SerializeWith runs a generated root writer in a fresh root region and returns the bytes.
func SerializeWith(ctx context.Context, layout []LayoutItem, write func(w *Writer) LEntry) (out []byte, err error) {
	w := NewWriter(layout)
	if ctx != nil {
		w.Ctx = ctx
	}
	err = Catch(w.PS, func() { out = w.Serialize(func() LEntry { return write(w) }) })
	return
}

// ToJSONWith runs a generated toJSON function.
func ToJSONWith(write func(j *JSONWriter)) (out []byte, err error) {
	j := NewJSONWriter()
	err = Catch(nil, func() { write(j) })
	if err == nil {
		out = j.Bytes()
	}
	return
}

// FromJSONWith runs a generated fromJSON function over JSON text.
func FromJSONWith[T any](data []byte, read func(c *FromJSON, j any) T) (v T, err error) {
	c := NewFromJSON()
	err = Catch(c.PS, func() { v = read(c, ParseJSON(data)) })
	return
}
