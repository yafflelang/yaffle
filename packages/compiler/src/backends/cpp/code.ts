/** A small indented code builder plus identifier and literal helpers for the C++ backend. */

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
    for (const l of s.split("\n")) this.lines.push(l ? "  ".repeat(this.depth) + l : "");
    return this;
  }

  /** `head {` … `}` with the body indented. `tail` is appended after the closing brace. */
  block(head: string, body: () => void, tail = ""): this {
    this.line(head ? `${head} {` : "{");
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

  /** A fresh local name like `t3_` (unique within builders sharing a counter). */
  fresh(prefix = "t"): string {
    return `${prefix}${++this.counter.n}_`;
  }

  /** `h0 { … } h1 { … }`: try/catch, if/else chains. */
  chain(parts: [string, () => void][]): this {
    parts.forEach(([head, body], i) => {
      if (i === 0) this.line(`${head} {`);
      else {
        this.depth--;
        this.line(`} ${head} {`);
      }
      this.depth++;
      body();
      if (i === parts.length - 1) {
        this.depth--;
        this.line("}");
      }
    });
    return this;
  }

  /** `try { body } catch (yaffle::Error& e) { handler…; throw; }`: errors gain path context. */
  rethrow(body: () => void, ...handler: string[]): this {
    return this.chain([
      ["try", body],
      [
        "catch (yaffle::Error& e)",
        () => {
          for (const l of handler) this.line(l);
          this.line("throw;");
        }
      ]
    ]);
  }

  /** Appends the lines of another builder at the current indentation. */
  append(other: Code): this {
    for (const l of other.lines) this.lines.push(l ? "  ".repeat(this.depth) + l : "");
    return this;
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
    "alignas alignof and and_eq asm auto bitand bitor bool break case catch char char8_t char16_t " +
    "char32_t class compl concept const consteval constexpr constinit const_cast continue co_await " +
    "co_return co_yield decltype default delete do double dynamic_cast else enum explicit export " +
    "extern false float for friend goto if inline int long mutable namespace new noexcept not " +
    "not_eq nullptr operator or or_eq private protected public register reinterpret_cast requires " +
    "return short signed sizeof static static_assert static_cast struct switch template this " +
    "thread_local throw true try typedef typeid typename union unsigned using virtual void volatile " +
    "wchar_t while xor xor_eq final override import module " +
    // macros and names that commonly collide in C/C++ headers
    "EOF NULL TRUE FALSE stdin stdout stderr errno assert offsetof INFINITY NAN DOMAIN BIG_ENDIAN " +
    "LITTLE_ENDIAN BYTE_ORDER unix linux major minor min max std yaffle"
  ).split(" ")
);

/** Names generated code uses for its own locals and parameters. */
const RESERVED_LOCALS = new Set(["r", "w", "v", "le", "endian", "self", "fr", "index"]);

/** A safe C++ identifier for a user name. */
export function ident(name: string): string {
  let s = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(s)) s = "_" + s;
  if (s === "") s = "_";
  // Identifiers with double underscores or a leading underscore + capital are reserved.
  s = s.replace(/__+/g, "_");
  if (/^_[A-Z]/.test(s)) s = "x" + s;
  if (KEYWORDS.has(s)) s += "_";
  return s;
}

/** Member names of generated structs that user fields must not take. */
const API_MEMBERS = new Set([
  "parse",
  "serialize",
  "to_json",
  "from_json",
  "options_from_json",
  "Value",
  "Options",
  "yaffle_meta_"
]);

/** A C++ data member name for a field. */
export function memberName(name: string): string {
  const s = ident(name);
  return API_MEMBERS.has(s) ? `${s}_` : s;
}

/** A C++ identifier for a parameter or local derived from a user name (never clashes with ours). */
export function localName(name: string): string {
  const s = ident(name);
  return RESERVED_LOCALS.has(s) || /_$/.test(s) ? `p_${s}` : s;
}

/** A C++ string literal (UTF-8 bytes; non-ASCII and control characters as octal escapes). */
export function str(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = '"';
  for (const b of bytes) {
    if (b === 0x22) out += '\\"';
    else if (b === 0x5c) out += "\\\\";
    else if (b === 0x0a) out += "\\n";
    else if (b === 0x0d) out += "\\r";
    else if (b === 0x09) out += "\\t";
    else if (b < 0x20 || b >= 0x7f) out += "\\" + b.toString(8).padStart(3, "0");
    else out += String.fromCharCode(b);
  }
  return out + '"';
}

/** A C++ integer literal for any value that fits 128 bits. */
export function intLit(v: bigint): string {
  const I64_MIN = -(1n << 63n);
  const I64_MAX = (1n << 63n) - 1n;
  if (v >= -(1n << 31n) && v < 1n << 31n) return v.toString();
  if (v > I64_MIN && v <= I64_MAX) return `INT64_C(${v.toString()})`;
  if (v === I64_MIN) return "(INT64_C(-9223372036854775807) - 1)";
  if (v > I64_MAX && v < 1n << 64n) return `static_cast<yaffle::i128>(UINT64_C(${v.toString()}))`;
  // Beyond 64 bits: (hi << 64) | lo in i128.
  const neg = v < 0n;
  const a = neg ? -v : v;
  const hi = a >> 64n;
  const lo = a & ((1n << 64n) - 1n);
  const mag = `((static_cast<yaffle::i128>(UINT64_C(${hi})) << 64) | static_cast<yaffle::i128>(UINT64_C(${lo})))`;
  return neg ? `(-${mag})` : mag;
}

/** A C++ double literal. */
export function floatLit(x: number): string {
  if (Number.isNaN(x)) return "std::numeric_limits<double>::quiet_NaN()";
  if (x === Infinity) return "std::numeric_limits<double>::infinity()";
  if (x === -Infinity) return "(-std::numeric_limits<double>::infinity())";
  if (Object.is(x, -0)) return "(-0.0)";
  const s = String(x);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}
