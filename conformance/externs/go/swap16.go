// `extern fn swap16(u16 v) -> u16`: swaps the two bytes. Its own inverse.
package externs

func swap16(v uint16) uint16 { return v<<8 | v>>8 }
