/** `extern fn swap16(u16 v) -> u16`: swaps the two bytes. Its own inverse. */
export function swap16(v: number): number {
  return ((v & 0xff) << 8) | ((v >> 8) & 0xff);
}
