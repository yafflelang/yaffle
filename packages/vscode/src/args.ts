/**
 * Root arguments for sample commands: what the user types for each root parameter, turned into
 * canonical JSON (docs/CONFORMANCE.md): integers as numbers (56- and 64-bit ones as decimal
 * strings), byte arrays as lowercase hex, strings as they are. The prompting is in extension.ts.
 */
import type { RootParameterDto } from "@yafflelang/lsp/protocol";

export type ArgResult = { value?: unknown; error?: string };

/** One parameter's text (empty: the default, when there is one). */
export function parseArg(p: RootParameterDto, raw: string): ArgResult {
  const text = raw.trim();
  if (text === "") return p.optional ? {} : { error: `${p.label} is required.` };
  switch (p.kind) {
    case "bytes": {
      const hex = text
        .replace(/^0x/i, "")
        .replace(/[\s_:,-]/g, "")
        .toLowerCase();
      if (!/^[0-9a-f]*$/.test(hex)) return { error: "Hex digits only (spaces are fine)." };
      if (hex.length % 2) return { error: "An even number of hex digits." };
      const n = hex.length / 2;
      if (p.length !== undefined && n !== p.length)
        return { error: `${p.length} bytes expected, got ${n}.` };
      return { value: hex };
    }
    case "int": {
      let v: bigint;
      try {
        const neg = text.startsWith("-");
        const body = text.replace(/^[-+]/, "").replace(/_/g, "");
        if (!/^(0x[0-9a-f]+|0b[01]+|\d+)$/i.test(body)) throw new Error();
        v = BigInt(body);
        if (neg) v = -v;
      } catch {
        return { error: "An integer (decimal, 0x… or 0b…)." };
      }
      const bits = BigInt(p.bits ?? 64);
      const lo = p.signed ? -(1n << (bits - 1n)) : 0n;
      const hi = p.signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
      if (v < lo || v > hi) return { error: `Out of range for ${p.type} (${lo}..${hi}).` };
      return { value: (p.bits ?? 64) > 48 ? v.toString() : Number(v) };
    }
    case "float": {
      const v = Number(text);
      if (Number.isNaN(v) && !/^nan$/i.test(text)) return { error: "A number." };
      return { value: v };
    }
    case "bool":
      if (/^(true|1|yes)$/i.test(text)) return { value: true };
      if (/^(false|0|no)$/i.test(text)) return { value: false };
      return { error: "true or false." };
    case "enum":
      if (p.members && !p.members.includes(text))
        return { error: `One of ${p.members.join(", ")}.` };
      return { value: text };
    default:
      return { value: text };
  }
}

/** The input box's prompt for a parameter. */
export function argPrompt(p: RootParameterDto): string {
  const what =
    p.kind === "bytes"
      ? `hex bytes${p.length !== undefined ? ` (${p.length})` : ""}`
      : p.kind === "int"
        ? "an integer (decimal or 0x…)"
        : p.kind === "enum" && p.members
          ? p.members.join(" | ")
          : p.kind;
  const fallback = p.defaultText ? ` (${p.defaultText})` : "";
  const optional = p.optional ? `; empty for the default${fallback}` : "";
  return `${p.label}: ${p.type} — ${what}${optional}`;
}
