/** Built-in checksums (docs/IR.md §5): crc32 (IEEE 802.3, reflected) and adler32. */

let table: Uint32Array | undefined;

function crcTable(): Uint32Array {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

/** CRC-32 of `data`. `prev` continues a running checksum. */
export function crc32(data: Uint8Array, prev = 0): number {
  const t = crcTable();
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Adler-32 of `data`. `prev` continues a running checksum (default 1). */
export function adler32(data: Uint8Array, prev = 1): number {
  let a = prev & 0xffff;
  let b = (prev >>> 16) & 0xffff;
  const MOD = 65521;
  for (let i = 0; i < data.length;) {
    const end = Math.min(data.length, i + 3800);
    for (; i < end; i++) {
      a += data[i]!;
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}
