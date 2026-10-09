// `extern fn sum8(u8 data[]) -> u8`: the sum of the bytes, modulo 256.
package externs

func sum8(data []byte) uint8 {
	var s uint8
	for _, b := range data {
		s += b
	}
	return s
}
