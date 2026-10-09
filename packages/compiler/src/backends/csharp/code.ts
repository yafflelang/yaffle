/** A small indented code builder plus identifier helpers for the C# backend. */

export class Code {
  private readonly lines: string[] = [];
  private depth = 0;
  private readonly counter: { n: number };

  constructor(counter: { n: number } = { n: 0 }) {
    this.counter = counter;
  }

  /** Appends one line (or several, split on newlines) at the current indentation. */
  line(s = ""): this {
    if (s === "") {
      this.lines.push("");
      return this;
    }
    for (const l of s.split("\n")) this.lines.push(l ? "    ".repeat(this.depth) + l : "");
    return this;
  }

  /** `head` / `{` … `}` with the body indented. `tail` is appended after the closing brace. */
  block(head: string, body: () => void, tail = ""): this {
    if (head) this.line(head);
    this.line("{");
    this.depth++;
    body();
    this.depth--;
    this.line(`}${tail}`);
    return this;
  }

  indent(body: () => void): this {
    this.depth++;
    body();
    this.depth--;
    return this;
  }

  /** A fresh local name like `__t3` (unique within builders sharing a counter). */
  fresh(prefix = "t"): string {
    return `__${prefix}${++this.counter.n}`;
  }

  /** `h0 { … } h1 { … }`: try/catch, if/else chains (each head on its own line). */
  chain(parts: [string, () => void][]): this {
    for (const [head, body] of parts) {
      this.line(head);
      this.line("{");
      this.depth++;
      body();
      this.depth--;
      this.line("}");
    }
    return this;
  }

  /** Appends the lines of another builder at the current indentation. */
  append(other: Code): this {
    for (const l of other.lines) this.lines.push(l ? "    ".repeat(this.depth) + l : "");
    return this;
  }

  get empty(): boolean {
    return this.lines.length === 0;
  }

  toString(): string {
    return this.lines.join("\n");
  }

  /** A builder sharing this one's temp counter (for code assembled out of order). */
  child(): Code {
    return new Code(this.counter);
  }
}

const KEYWORDS = new Set(
  (
    "abstract as base bool break byte case catch char checked class const continue decimal default " +
    "delegate do double else enum event explicit extern false finally fixed float for foreach goto if " +
    "implicit in int interface internal is lock long namespace new null object operator out override " +
    "params private protected public readonly ref return sbyte sealed short sizeof stackalloc static " +
    "string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual " +
    "void volatile while"
  ).split(" ")
);

/** Contextual keywords that are awkward as plain identifiers. */
const CONTEXTUAL = new Set(
  "var dynamic value await async nameof when yield global record".split(" ")
);

/** A safe C# identifier for a user name (parameters and locals). Never starts with `__`. */
export function ident(name: string): string {
  let s = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (s === "") s = "_x";
  if (/^[0-9]/.test(s)) s = "_" + s;
  if (s.startsWith("__")) s = "u" + s;
  if (KEYWORDS.has(s) || CONTEXTUAL.has(s)) s = "@" + s;
  return s;
}

/** PascalCase form of a name (`entry_count` → `EntryCount`, `ofs` → `Ofs`). */
export function pascal(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(p => p.length > 0);
  let s = parts.map(p => p[0]!.toUpperCase() + p.slice(1)).join("");
  if (s === "") s = "Value";
  if (/^[0-9]/.test(s)) s = "N" + s;
  return s;
}

/**
 * Names generated code uses unqualified. A user type with one of these names gets a trailing
 * underscore so it does not shadow them.
 */
const SHADOWED = new Set(
  (
    "System Rt List Dictionary Math String Object Array Exception Func Action Task ValueTask Half " +
    "Int128 BigInteger BitConverter Convert Enum Nullable Type JsonNode JsonObject JsonArray JsonValue " +
    "IReadOnlyList IList ICollection Span ReadOnlySpan Memory ReadOnlyMemory Regex RegexOptions " +
    "YaffleImpl YaffleExterns Externs Byte SByte Int16 UInt16 Int32 UInt32 Int64 UInt64 Single Double " +
    "Boolean Char Decimal Attribute Buffer Encoding Text Linq Collections Generic Numerics Threading Tasks"
  ).split(" ")
);

/** C# name of a user type (struct class, enum, options class). */
export function typeName(name: string): string {
  let s = ident(name).replace(/^@/, "");
  if (s.startsWith("_")) s = "T" + s;
  s = s[0]!.toUpperCase() + s.slice(1);
  return SHADOWED.has(s) || KEYWORDS.has(s.toLowerCase()) ? `${s}_` : s;
}

/** A C# string literal. */
export function str(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || (c >= 0x7f && c < 0xa0)) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else if (c > 0xffff) {
      out += `\\U${c.toString(16).padStart(8, "0")}`;
    } else if (c >= 0xd800 && c <= 0xdfff) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  // Lone surrogates in JS strings iterate as single code units.
  return out + '"';
}
