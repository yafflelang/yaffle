/** `extern fn sum8(u8 data[]) -> u8`: the sum of the bytes, modulo 256. */
export function sum8(data: Uint8Array): number {
  let s = 0;
  for (const b of data) s = (s + b) & 0xff;
  return s;
}
