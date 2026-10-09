/** Hex helpers of the runner. */

/** Normalizes hex written in cases.json: strips whitespace and `_`, lowercases. Throws if invalid. */
export function normalizeHex(text: string): string {
  const hex = text.replace(/[\s_]/g, "").toLowerCase();
  if (hex.length % 2 !== 0) throw new Error(`hex has an odd number of digits (${hex.length})`);
  if (!/^[0-9a-f]*$/.test(hex))
    throw new Error(`invalid hex: ${JSON.stringify(text.slice(0, 40))}`);
  return hex;
}

export function isCanonicalHex(text: string): boolean {
  return text.length % 2 === 0 && /^[0-9a-f]*$/.test(text);
}

/** Bytes of context shown on each side of the first difference. */
const CONTEXT = 8;

/**
 * Describes where two hex strings differ: the first differing byte offset, the lengths, and a few
 * bytes of context from both sides. Returns undefined if they are equal.
 */
export function diffHex(expected: string, actual: string): string | undefined {
  if (expected === actual) return undefined;
  const byteAt = (h: string, i: number) => h.slice(i * 2, i * 2 + 2);
  const n = Math.min(expected.length, actual.length) / 2;
  let first = 0;
  while (first < n && byteAt(expected, first) === byteAt(actual, first)) first++;
  const start = Math.max(0, first - CONTEXT);
  const end = first + CONTEXT + 1;
  const show = (h: string) => {
    const bytes: string[] = [];
    for (let i = start; i < Math.min(h.length / 2, end); i++)
      bytes.push(i === first ? `[${byteAt(h, i)}]` : byteAt(h, i));
    return (start > 0 ? "… " : "") + bytes.join(" ") + (h.length / 2 > end ? " …" : "");
  };
  return [
    `bytes differ at offset ${first} (0x${first.toString(16)}); expected ${expected.length / 2} bytes, got ${actual.length / 2}`,
    `  expected: ${show(expected)}`,
    `  actual:   ${show(actual)}`
  ].join("\n");
}
