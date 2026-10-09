/** A tiny indented code builder plus identifier helpers for the Java backend. */

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

  /** A fresh local name like `$t3` (unique within builders sharing a counter). */
  fresh(prefix = "$t"): string {
    return `${prefix}${++this.counter.n}`;
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

  /** Appends the lines of another builder at the current indentation. */
  append(other: Code): this {
    for (const l of other.lines) this.lines.push(l ? "  ".repeat(this.depth) + l : "");
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
    "abstract assert boolean break byte case catch char class const continue default do double " +
    "else enum extends final finally float for goto if implements import instanceof int interface " +
    "long native new package private protected public return short static strictfp super switch " +
    "synchronized this throw throws transient try void volatile while true false null var yield " +
    "record sealed permits non-sealed when _"
  ).split(" ")
);

/** A safe Java identifier for a user name (fields, parameters, types). */
export function ident(name: string): string {
  let s = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(s) || s === "") s = "_" + s;
  if (KEYWORDS.has(s)) s += "_";
  return s;
}

/** The Java constant name of an enum member. */
export function enumConst(open: boolean, member: string): string {
  // `when` is only a contextual keyword, so it stays a valid constant name.
  let s = member === "when" ? member : ident(member);
  // Open enums are records: their constants must not clash with the components.
  if (open && (s === "value" || s === "member")) s += "_";
  return s;
}

/** A Java string literal. */
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
      const hi = 0xd800 + ((c - 0x10000) >> 10);
      const lo = 0xdc00 + ((c - 0x10000) & 0x3ff);
      out += `\\u${hi.toString(16)}\\u${lo.toString(16)}`;
    } else if (c >= 0xd800 && c <= 0xdfff) out += `\\u${c.toString(16)}`;
    else out += ch;
  }
  return out + '"';
}

/** A Java long literal. */
export function longLit(v: bigint): string {
  if (v === -(1n << 63n)) return "Long.MIN_VALUE";
  const a = v < 0n ? -v : v;
  let body: string;
  if (a >= 0x10000n && (a & 0xffn) === 0n) body = "0x" + a.toString(16);
  else if (a >= 256n && (a & (a - 1n)) === 0n) body = "0x" + a.toString(16);
  else body = a.toString();
  return `${v < 0n ? "-" : ""}${body}L`;
}

/** A Java int literal. */
export function intLit(v: bigint): string {
  if (v === -(1n << 31n)) return "Integer.MIN_VALUE";
  return v.toString();
}

/** A Java double literal. */
export function doubleLit(x: number): string {
  if (Number.isNaN(x)) return "Double.NaN";
  if (x === Infinity) return "Double.POSITIVE_INFINITY";
  if (x === -Infinity) return "Double.NEGATIVE_INFINITY";
  if (Object.is(x, -0)) return "-0.0";
  const s = String(x);
  return /[.eE]/.test(s) ? s.replace("e+", "e") : `${s}.0`;
}

/** Strips one pair of enclosing parentheses if they wrap the whole expression. */
export function stripParens(s: string): string {
  if (!s.startsWith("(") || !s.endsWith(")")) return s;
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    if (depth === 0 && i < s.length - 1) return s;
  }
  return s.slice(1, -1);
}

/** Wraps in parentheses unless the expression is atomic. */
export function wrap(code: string): string {
  if (/^[A-Za-z0-9_$.]+$/.test(code)) return code;
  if (/^\(.*\)$/s.test(code) && stripParens(code) !== code) return code;
  return `(${code})`;
}
