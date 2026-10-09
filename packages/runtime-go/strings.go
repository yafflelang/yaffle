package yaffle

import (
	"encoding/binary"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Text encodings: utf8 / ascii / latin1 (1-byte units), utf16 (2-byte units), utf32 (4-byte
// units). Lengths count code units. Reading stops the value at the first NUL unit. Invalid input
// on read is a CHECK error; text that can't be encoded (or contains NUL, which would read back
// differently) is an INPUT error on write.

// Encoding of a string field.
type Encoding uint8

// Encodings.
const (
	UTF8 Encoding = iota
	ASCII
	Latin1
	UTF16
	UTF32
)

func (e Encoding) unit() int {
	switch e {
	case UTF16:
		return 2
	case UTF32:
		return 4
	}
	return 1
}

// findNul returns the index (in units) of the first NUL unit in b, or -1.
func findNul(b []byte, unit int) int {
	if unit == 1 {
		for i, c := range b {
			if c == 0 {
				return i
			}
		}
		return -1
	}
	n := len(b) / unit
	for i := 0; i < n; i++ {
		zero := true
		for k := 0; k < unit; k++ {
			if b[i*unit+k] != 0 {
				zero = false
				break
			}
		}
		if zero {
			return i
		}
	}
	return -1
}

// DecodeString decodes code units (already cut at the NUL unit). `at` is the absolute offset of
// b[0] for errors.
func DecodeString(b []byte, enc Encoding, le bool, at int) string {
	switch enc {
	case Latin1:
		ascii := true
		for _, c := range b {
			if c >= 0x80 {
				ascii = false
				break
			}
		}
		if ascii {
			return string(b)
		}
		var sb strings.Builder
		for _, c := range b {
			sb.WriteRune(rune(c))
		}
		return sb.String()
	case ASCII:
		for i, c := range b {
			if c >= 0x80 {
				FailAt(CHECK, at+i, "byte 0x%x is not ASCII", c)
			}
		}
		return string(b)
	case UTF8:
		if !utf8.Valid(b) {
			FailAt(CHECK, at, "invalid UTF-8")
		}
		return string(b)
	case UTF16:
		n := len(b) / 2
		var sb strings.Builder
		for i := 0; i < n; i++ {
			u := unit16(b[i*2:], le)
			switch {
			case u >= 0xd800 && u <= 0xdbff:
				if i+1 >= n {
					FailAt(CHECK, at+i*2, "invalid UTF-16 (lone high surrogate)")
				}
				next := unit16(b[i*2+2:], le)
				if next < 0xdc00 || next > 0xdfff {
					FailAt(CHECK, at+i*2, "invalid UTF-16 (lone high surrogate)")
				}
				sb.WriteRune(utf16.DecodeRune(rune(u), rune(next)))
				i++
			case u >= 0xdc00 && u <= 0xdfff:
				FailAt(CHECK, at+i*2, "invalid UTF-16 (lone low surrogate)")
			default:
				sb.WriteRune(rune(u))
			}
		}
		return sb.String()
	case UTF32:
		n := len(b) / 4
		var sb strings.Builder
		for i := 0; i < n; i++ {
			var cp uint32
			if le {
				cp = binary.LittleEndian.Uint32(b[i*4:])
			} else {
				cp = binary.BigEndian.Uint32(b[i*4:])
			}
			if cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) {
				FailAt(CHECK, at+i*4, "invalid UTF-32 code point 0x%x", cp)
			}
			sb.WriteRune(rune(cp))
		}
		return sb.String()
	}
	return ""
}

func unit16(b []byte, le bool) uint16 {
	if le {
		return uint16(b[0]) | uint16(b[1])<<8
	}
	return uint16(b[0])<<8 | uint16(b[1])
}

// EncodeString encodes text without terminator or padding (INPUT for NUL, invalid text or
// characters the encoding can't represent).
func EncodeString(s string, enc Encoding, le bool) []byte {
	if !utf8.ValidString(s) {
		Fail(INPUT, "string is not valid UTF-8")
	}
	switch enc {
	case UTF8:
		if strings.IndexByte(s, 0) >= 0 {
			Fail(INPUT, "string contains NUL")
		}
		return []byte(s)
	case ASCII, Latin1:
		lim := rune(0x100)
		name := "latin1"
		if enc == ASCII {
			lim = 0x80
			name = "ascii"
		}
		out := make([]byte, 0, len(s))
		for _, r := range s {
			if r == 0 {
				Fail(INPUT, "string contains NUL")
			}
			if r >= lim {
				Fail(INPUT, "character U+%04x is not %s", r, name)
			}
			out = append(out, byte(r))
		}
		return out
	case UTF16:
		out := make([]byte, 0, len(s)*2)
		for _, r := range s {
			if r == 0 {
				Fail(INPUT, "string contains NUL")
			}
			if r >= 0x10000 {
				a, b := utf16.EncodeRune(r)
				out = appendUnit16(out, uint16(a), le)
				out = appendUnit16(out, uint16(b), le)
			} else {
				out = appendUnit16(out, uint16(r), le)
			}
		}
		return out
	case UTF32:
		out := make([]byte, 0, len(s)*4)
		for _, r := range s {
			if r == 0 {
				Fail(INPUT, "string contains NUL")
			}
			var w [4]byte
			if le {
				binary.LittleEndian.PutUint32(w[:], uint32(r))
			} else {
				binary.BigEndian.PutUint32(w[:], uint32(r))
			}
			out = append(out, w[:]...)
		}
		return out
	}
	return nil
}

func appendUnit16(out []byte, u uint16, le bool) []byte {
	if le {
		return append(out, byte(u), byte(u>>8))
	}
	return append(out, byte(u>>8), byte(u))
}

// EncodedLen is the number of bytes s occupies in the encoding (the IR builtin encodedLength).
func EncodedLen(s string, enc Encoding) int64 {
	return CodeUnits(s, enc) * int64(enc.unit())
}

// CodeUnits is the number of code units s occupies in the encoding.
func CodeUnits(s string, enc Encoding) int64 {
	switch enc {
	case UTF8:
		return int64(len(s))
	case UTF16:
		n := 0
		for _, r := range s {
			if r >= 0x10000 {
				n += 2
			} else {
				n++
			}
		}
		return int64(n)
	default:
		return int64(utf8.RuneCountInString(s))
	}
}

// EncodeFixedString encodes s padded with NUL units to exactly n bytes (INPUT if longer).
func EncodeFixedString(s string, n int, enc Encoding, le bool) []byte {
	b := EncodeString(s, enc, le)
	if len(b) > n {
		Fail(INPUT, "string of %d units exceeds the length %d", len(b)/enc.unit(), n/enc.unit())
	}
	out := make([]byte, n)
	copy(out, b)
	return out
}

// Utf8 returns the UTF-8 bytes of s (crc32 of a string).
func Utf8(s string) []byte { return []byte(s) }
