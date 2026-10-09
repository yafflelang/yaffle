package yaffle

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"math"
	"math/big"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
	"unsafe"
)

// Canonical JSON (docs/CONFORMANCE.md §3): bytes as lowercase hex, 56/64-bit integers as decimal
// strings, non-finite floats and -0 as strings, shared targets as JSON-Pointer `$ref`s.

// ── writing ─────────────────────────────────────────────────────────────────

// JSONWriter builds canonical JSON text.
type JSONWriter struct {
	buf   []byte
	comma []bool
	key   bool
	seen  map[any]string
}

// NewJSONWriter creates a writer.
func NewJSONWriter() *JSONWriter { return &JSONWriter{seen: map[any]string{}} }

// Bytes returns the JSON text.
func (j *JSONWriter) Bytes() []byte { return j.buf }

func (j *JSONWriter) pre() {
	if j.key {
		j.key = false
		return
	}
	if n := len(j.comma); n > 0 {
		if j.comma[n-1] {
			j.buf = append(j.buf, ',')
		}
		j.comma[n-1] = true
	}
}

// BeginObject starts an object.
func (j *JSONWriter) BeginObject() {
	j.pre()
	j.buf = append(j.buf, '{')
	j.comma = append(j.comma, false)
}

// EndObject ends an object.
func (j *JSONWriter) EndObject() {
	j.comma = j.comma[:len(j.comma)-1]
	j.buf = append(j.buf, '}')
}

// BeginArray starts an array.
func (j *JSONWriter) BeginArray() {
	j.pre()
	j.buf = append(j.buf, '[')
	j.comma = append(j.comma, false)
}

// EndArray ends an array.
func (j *JSONWriter) EndArray() {
	j.comma = j.comma[:len(j.comma)-1]
	j.buf = append(j.buf, ']')
}

// Key writes an object key.
func (j *JSONWriter) Key(k string) {
	j.pre()
	j.buf = appendJSONString(j.buf, k)
	j.buf = append(j.buf, ':')
	j.key = true
}

// Null writes null.
func (j *JSONWriter) Null() {
	j.pre()
	j.buf = append(j.buf, "null"...)
}

// Bool writes a bool.
func (j *JSONWriter) Bool(b bool) {
	j.pre()
	j.buf = strconv.AppendBool(j.buf, b)
}

// Int writes an integer as a number.
func (j *JSONWriter) Int(v int64) {
	j.pre()
	j.buf = strconv.AppendInt(j.buf, v, 10)
}

// Uint writes an unsigned integer as a number.
func (j *JSONWriter) Uint(v uint64) {
	j.pre()
	j.buf = strconv.AppendUint(j.buf, v, 10)
}

// IntStr writes a 56/64-bit integer as a decimal string.
func (j *JSONWriter) IntStr(v int64) {
	j.pre()
	j.buf = append(j.buf, '"')
	j.buf = strconv.AppendInt(j.buf, v, 10)
	j.buf = append(j.buf, '"')
}

// UintStr writes a 56/64-bit unsigned integer as a decimal string.
func (j *JSONWriter) UintStr(v uint64) {
	j.pre()
	j.buf = append(j.buf, '"')
	j.buf = strconv.AppendUint(j.buf, v, 10)
	j.buf = append(j.buf, '"')
}

// Float writes a float (NaN, ±Infinity and -0 as strings).
func (j *JSONWriter) Float(f float64) {
	switch {
	case math.IsNaN(f):
		j.Str("NaN")
	case math.IsInf(f, 1):
		j.Str("Infinity")
	case math.IsInf(f, -1):
		j.Str("-Infinity")
	case f == 0 && math.Signbit(f):
		j.Str("-0")
	default:
		j.pre()
		j.buf = strconv.AppendFloat(j.buf, f, 'g', -1, 64)
	}
}

// Str writes a string.
func (j *JSONWriter) Str(s string) {
	j.pre()
	j.buf = appendJSONString(j.buf, s)
}

// Hex writes bytes as a lowercase hex string.
func (j *JSONWriter) Hex(b []byte) {
	j.pre()
	j.buf = append(j.buf, '"')
	n := len(j.buf)
	j.buf = append(j.buf, make([]byte, len(b)*2)...)
	hex.Encode(j.buf[n:], b)
	j.buf = append(j.buf, '"')
}

// Ref writes `{"$ref": first}` and returns true if the object identified by key was written
// before; otherwise it records path for it and returns false. A nil key is never shared.
func (j *JSONWriter) Ref(key any, path string) bool {
	if key == nil {
		return false
	}
	if prev, ok := j.seen[key]; ok {
		j.BeginObject()
		j.Key("$ref")
		j.Str(prev)
		j.EndObject()
		return true
	}
	j.seen[key] = path
	return false
}

func appendJSONString(b []byte, s string) []byte {
	b = append(b, '"')
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			switch {
			case c == '"':
				b = append(b, '\\', '"')
			case c == '\\':
				b = append(b, '\\', '\\')
			case c < 0x20:
				switch c {
				case '\n':
					b = append(b, '\\', 'n')
				case '\r':
					b = append(b, '\\', 'r')
				case '\t':
					b = append(b, '\\', 't')
				default:
					b = append(b, '\\', 'u', '0', '0', "0123456789abcdef"[c>>4], "0123456789abcdef"[c&0xf])
				}
			default:
				b = append(b, c)
			}
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			b = append(b, `�`...)
		} else {
			b = append(b, s[i:i+size]...)
		}
		i += size
	}
	return append(b, '"')
}

// JPtr appends an RFC 6901 reference token to a JSON pointer.
func JPtr(path, seg string) string {
	if strings.ContainsAny(seg, "~/") {
		seg = strings.ReplaceAll(strings.ReplaceAll(seg, "~", "~0"), "/", "~1")
	}
	return path + "/" + seg
}

// JPtrI appends an array index to a JSON pointer.
func JPtrI(path string, i int) string { return path + "/" + strconv.Itoa(i) }

// SliceID identifies a slice (its first element and length) for `$ref` tracking and target
// identity on write; empty slices are never shared (nil).
func SliceID[T any](s []T) any {
	if len(s) == 0 {
		return nil
	}
	return sliceKey{unsafe.Pointer(unsafe.SliceData(s)), len(s), reflect.TypeOf(s)}
}

type sliceKey struct {
	p unsafe.Pointer
	n int
	t reflect.Type
}

// ── reading ─────────────────────────────────────────────────────────────────

// ParseJSON parses JSON text into a tree of map[string]any, []any, json.Number, string, bool and
// nil (INPUT on a syntax error).
func ParseJSON(data []byte) any {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var v any
	if err := d.Decode(&v); err != nil {
		Fail(INPUT, "invalid JSON: %v", err)
	}
	return v
}

// FromJSON is the state of a fromJSON conversion: the path stack and values by JSON pointer (to
// restore identity from `$ref`s).
type FromJSON struct {
	PS     *PathStack
	byPath map[string]any
}

// NewFromJSON creates the state.
func NewFromJSON() *FromJSON { return &FromJSON{PS: &PathStack{}, byPath: map[string]any{}} }

// Register records the value converted at path (objects and arrays).
func (c *FromJSON) Register(path string, v any) { c.byPath[path] = v }

// Deref returns the value a `{"$ref": …}` object points at (INPUT if dangling), and whether j
// was such an object.
func (c *FromJSON) Deref(j any) (any, bool) {
	o, ok := j.(map[string]any)
	if !ok || len(o) != 1 {
		return nil, false
	}
	t, ok := o["$ref"].(string)
	if !ok {
		return nil, false
	}
	v, found := c.byPath[t]
	if !found {
		Fail(INPUT, "$ref %s does not point at an earlier value", t)
	}
	return v, true
}

// DerefAs is Deref with the expected Go type.
func DerefAs[T any](c *FromJSON, j any) (T, bool) {
	v, ok := c.Deref(j)
	if !ok {
		var zero T
		return zero, false
	}
	t, ok := v.(T)
	if !ok {
		Fail(INPUT, "$ref points at a value of another type")
	}
	return t, true
}

// Obj converts a JSON struct value (or a `$ref` to one).
func Obj[T any](c *FromJSON, j any, p string, f func(c *FromJSON, j any, p string) *T) *T {
	if v, ok := DerefAs[*T](c, j); ok {
		return v
	}
	return f(c, j, p)
}

// Arr converts a JSON array (or a `$ref` to one). Element errors get the index in their path.
func Arr[T any](c *FromJSON, j any, p string, f func(e any, p string) T) []T {
	if v, ok := DerefAs[[]T](c, j); ok {
		return v
	}
	a := JArray(j)
	out := make([]T, len(a))
	if len(a) > 0 {
		c.Register(p, out)
	}
	ix := c.PS.PushIndex()
	for i, e := range a {
		c.PS.SetIndex(ix, i)
		out[i] = f(e, JPtrI(p, i))
	}
	c.PS.Leave(ix)
	return out
}

// JNullable converts a JSON value whose null is the zero value (nil pointers and slices).
func JNullable[T any](j any, f func(j any) T) T {
	if j == nil {
		var zero T
		return zero
	}
	return f(j)
}

// JNullablePtr converts a JSON value into a pointer, nil for null.
func JNullablePtr[T any](j any, f func(j any) T) *T {
	if j == nil {
		return nil
	}
	v := f(j)
	return &v
}

// Describe renders a JSON value for messages.
func Describe(j any) string { return describe(j) }

func describe(j any) string {
	switch x := j.(type) {
	case nil:
		return "null"
	case string:
		if len(x) > 40 {
			x = x[:40] + "…"
		}
		return strconv.Quote(x)
	case json.Number:
		return string(x)
	case bool:
		return strconv.FormatBool(x)
	case []any:
		return "array(" + strconv.Itoa(len(x)) + ")"
	case map[string]any:
		return "object"
	}
	return "?"
}

// JObject expects a JSON object.
func JObject(j any) map[string]any {
	o, ok := j.(map[string]any)
	if !ok {
		Fail(INPUT, "expected an object, got %s", describe(j))
	}
	return o
}

// JArray expects a JSON array.
func JArray(j any) []any {
	a, ok := j.([]any)
	if !ok {
		Fail(INPUT, "expected an array, got %s", describe(j))
	}
	return a
}

// JBool expects a bool.
func JBool(j any) bool {
	b, ok := j.(bool)
	if !ok {
		Fail(INPUT, "expected a boolean, got %s", describe(j))
	}
	return b
}

// JString expects a string.
func JString(j any) string {
	s, ok := j.(string)
	if !ok {
		Fail(INPUT, "expected a string, got %s", describe(j))
	}
	return s
}

// JBytes expects a hex string (whitespace allowed).
func JBytes(j any) []byte {
	s, ok := j.(string)
	if !ok {
		Fail(INPUT, "expected a hex string, got %s", describe(j))
	}
	clean := s
	if strings.ContainsAny(s, " \t\r\n") {
		clean = strings.Join(strings.Fields(s), "")
	}
	b, err := hex.DecodeString(clean)
	if err != nil {
		Fail(INPUT, "invalid hex string %s", describe(j))
	}
	return b
}

// jnum parses a JSON number exactly (as a big integer when integral).
func jnum(j any) (*big.Int, bool) {
	n, ok := j.(json.Number)
	if !ok {
		Fail(INPUT, "expected an integer, got %s", describe(j))
	}
	s := string(n)
	if b, ok := new(big.Int).SetString(s, 10); ok {
		return b, true
	}
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		Fail(INPUT, "invalid number %s", s)
	}
	if r.IsInt() {
		return r.Num(), true
	}
	return nil, false
}

// jIntBig parses an integer of up to 48 bits (a JSON number) as a big integer. A non-integer is
// RANGE, other JSON types INPUT.
func jIntBig(j any) *big.Int {
	b, ok := jnum(j)
	if !ok {
		Fail(RANGE, "%s is not an integer", describe(j))
	}
	return b
}

// jBigStr parses a 56/64-bit integer (a decimal string).
func jBigStr(j any) *big.Int {
	s, ok := j.(string)
	if ok {
		if b, ok := new(big.Int).SetString(s, 10); ok && decimalRe.MatchString(s) {
			return b
		}
	}
	Fail(INPUT, "expected a decimal integer string, got %s", describe(j))
	return nil
}

var decimalRe = regexp.MustCompile(`^-?[0-9]+$`)

// jIntIn parses an integer (a number, or a decimal string when str) in [lo, hi] (RANGE otherwise).
func jIntIn(j any, str bool, lo, hi *big.Int, what string) *big.Int {
	var b *big.Int
	if str {
		b = jBigStr(j)
	} else {
		b = jIntBig(j)
	}
	if b.Cmp(lo) < 0 || b.Cmp(hi) > 0 {
		Fail(RANGE, "%s is out of range for %s", b.String(), what)
	}
	return b
}

// JUint parses an unsigned integer into [0, hi]: a number, or a decimal string when str.
func JUint(j any, hi uint64, str bool, what string) uint64 {
	return jIntIn(j, str, new(big.Int), new(big.Int).SetUint64(hi), what).Uint64()
}

// JInt parses a signed integer into [lo, hi]: a number, or a decimal string when str.
func JInt(j any, lo, hi int64, str bool, what string) int64 {
	return jIntIn(j, str, big.NewInt(lo), big.NewInt(hi), what).Int64()
}

// JFloat parses a float: a number or "NaN", "Infinity", "-Infinity", "-0".
func JFloat(j any) float64 {
	switch x := j.(type) {
	case json.Number:
		f, err := strconv.ParseFloat(string(x), 64)
		if err != nil {
			if ne, ok := err.(*strconv.NumError); ok && ne.Err == strconv.ErrRange {
				return f
			}
			Fail(INPUT, "invalid number %s", string(x))
		}
		return f
	case string:
		switch x {
		case "NaN":
			return math.NaN()
		case "Infinity":
			return math.Inf(1)
		case "-Infinity":
			return math.Inf(-1)
		case "-0":
			return math.Copysign(0, -1)
		}
	}
	Fail(INPUT, "expected a number, got %s", describe(j))
	return 0
}

// JEndian parses "le" or "be".
func JEndian(j any) Endian {
	switch JString(j) {
	case "le":
		return LE
	case "be":
		return BE
	}
	Fail(INPUT, "expected \"le\" or \"be\", got %s", describe(j))
	return LE
}

// JUnion parses `{ "type": …, "value": … }` and returns the variant name and the value.
func JUnion(j any, names ...string) (string, any) {
	o := JObject(j)
	t, ok := o["type"].(string)
	if ok {
		for _, n := range names {
			if n == t {
				return t, o["value"]
			}
		}
	}
	Fail(INPUT, "unknown union variant %s", describe(o["type"]))
	return "", nil
}
