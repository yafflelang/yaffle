// `extern type VarInt(u8 maxBytes) : u64`: unsigned LEB128, at most maxBytes bytes.
//
//   - Size: the index after the first byte below 0x80; ok=false if the bytes end first (need
//     more); an error if no terminating byte is found within maxBytes.
//   - Write: the shortest encoding; an error if it needs more than maxBytes bytes.
package externs

import (
	"errors"
	"fmt"
	"math/bits"

	"yafflelang.org/go/yaffle"
)

type varInt struct{}

func varIntMax(args []any) (int, error) {
	n, err := yaffle.ArgInt(args, 0)
	if err != nil {
		return 0, err
	}
	return int(n), nil
}

func (varInt) Size(b []byte, args []any) (int, bool, error) {
	maxBytes, err := varIntMax(args)
	if err != nil {
		return 0, false, err
	}
	for i := 0; i < len(b) && i < maxBytes; i++ {
		if b[i] < 0x80 {
			return i + 1, true, nil
		}
	}
	if len(b) < maxBytes {
		return 0, false, nil
	}
	return 0, false, fmt.Errorf("VarInt: longer than %d bytes", maxBytes)
}

func (varInt) Read(b []byte, args []any) (uint64, error) {
	maxBytes, err := varIntMax(args)
	if err != nil {
		return 0, err
	}
	var v uint64
	for i := 0; i < len(b) && i < maxBytes; i++ {
		part := uint64(b[i] & 0x7f)
		shift := uint(7 * i)
		if shift >= 64 || (shift > 0 && bits.Len64(part)+int(shift) > 64) {
			if part != 0 {
				return 0, errors.New("VarInt: value exceeds u64")
			}
		} else {
			v |= part << shift
		}
		if b[i] < 0x80 {
			return v, nil
		}
	}
	return 0, errors.New("VarInt: unterminated")
}

func (varInt) Write(v uint64, args []any) ([]byte, error) {
	maxBytes, err := varIntMax(args)
	if err != nil {
		return nil, err
	}
	out := []byte{}
	for {
		b := byte(v & 0x7f)
		v >>= 7
		if v != 0 {
			b |= 0x80
		}
		out = append(out, b)
		if v == 0 {
			break
		}
	}
	if len(out) > maxBytes {
		return nil, fmt.Errorf("VarInt: value needs %d bytes, more than %d", len(out), maxBytes)
	}
	return out, nil
}

// VarInt is the host implementation.
var VarInt yaffle.ExternType[uint64] = varInt{}
