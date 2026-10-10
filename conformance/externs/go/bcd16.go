// `extern type Bcd16 : u16 @size(2)`: four BCD digits, most significant first (`12 34` → 1234).
// Fixed size, so generated code never calls Size. A nibble above 9 is an error on read; a value
// above 9999 is an error on write.
package externs

import (
	"fmt"

	yaffle "yafflelang.org/runtime"
)

type bcd16 struct{}

func (bcd16) Size([]byte, []any) (int, bool, error) { return 2, true, nil }

func (bcd16) Read(b []byte, _ []any) (uint16, error) {
	var v uint16
	for i := 0; i < 2; i++ {
		hi, lo := b[i]>>4, b[i]&0x0f
		if hi > 9 || lo > 9 {
			return 0, fmt.Errorf("Bcd16: invalid digit in 0x%x", b[i])
		}
		v = v*100 + uint16(hi)*10 + uint16(lo)
	}
	return v, nil
}

func (bcd16) Write(v uint16, _ []any) ([]byte, error) {
	if v > 9999 {
		return nil, fmt.Errorf("Bcd16: %d out of range", v)
	}
	d := [4]byte{byte(v / 1000 % 10), byte(v / 100 % 10), byte(v / 10 % 10), byte(v % 10)}
	return []byte{d[0]<<4 | d[1], d[2]<<4 | d[3]}, nil
}

// Bcd16 is the host implementation.
var Bcd16 yaffle.ExternType[uint16] = bcd16{}
