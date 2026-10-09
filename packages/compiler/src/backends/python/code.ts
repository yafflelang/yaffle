/**
 * An indented Python code builder, plus literal and identifier helpers.
 *
 * Fresh temporaries are named `_<letters><number>`, with one counter per builder tree. Nested
 * functions bind the temporaries they read from enclosing scopes as default arguments (see
 * `closureParams`): Python closures capture variables, not values, and generated closures
 * (fixups, ref encoders) may run after a loop has moved on.
 */

export interface Counter {
  n: number;
}

export class Code {
  private readonly lines: string[] = [];
  private depth = 0;
  readonly counter: Counter;

  constructor(counter: Counter = { n: 0 }) {
    this.counter = counter;
  }

  /** Appends one line (or several, split on newlines) at the current indentation. */
  line(s = ""): this {
    for (const l of s.split("\n")) this.lines.push(l ? "    ".repeat(this.depth) + l : "");
    return this;
  }

  /** `head:` with the body indented (`pass` if the body emits nothing). */
  block(head: string, body: () => void): this {
    this.line(`${head}:`);
    const before = this.lines.length;
    this.indent(body);
    if (this.lines.length === before) this.indent(() => this.line("pass"));
    return this;
  }

  indent(body: () => void): this {
    this.depth++;
    body();
    this.depth--;
    return this;
  }

  /** `if a: … elif b: … else: …` from `[head, body]` pairs (heads include the keyword). */
  chain(parts: [string, () => void][]): this {
    for (const [head, body] of parts) this.block(head, body);
    return this;
  }

  /** A fresh local name like `_t3` (unique within builders sharing a counter). */
  fresh(prefix = "t"): string {
    return `_${prefix}${++this.counter.n}`;
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

  /** The current counter value: temporaries created later have larger numbers. */
  get mark(): number {
    return this.counter.n;
  }
}

const TEMP = /(?<![A-Za-z0-9_])_([a-z]+)(\d+)(?![A-Za-z0-9_])/g;

/**
 * Default-argument bindings (`_t3: _t.Any = _t3`) for the temporaries a closure body reads from
 * enclosing scopes, i.e. those created before the closure was opened (number <= `openedAt`).
 */
export function closureParams(body: string, openedAt: number): string[] {
  const seen = new Set<string>();
  for (const m of body.matchAll(TEMP)) {
    if (Number(m[2]) <= openedAt) seen.add(m[0]);
  }
  return [...seen].sort().map(n => `${n}: _t.Any = ${n}`);
}

/** Hard keywords: never valid as identifiers. */
export const PY_HARD_KEYWORDS = new Set(
  (
    "False None True and as assert async await break class continue def del elif else except " +
    "finally for from global if import in is lambda nonlocal not or pass raise return try while " +
    "with yield"
  ).split(" ")
);

/** Keywords, soft keywords included (avoided for module-level and local names). */
export const PY_KEYWORDS = new Set([...PY_HARD_KEYWORDS, "match", "case", "type", "_"]);

/** Builtins generated code uses unqualified (user names must not shadow them). */
export const PY_BUILTINS = new Set(
  (
    "abs all any bool bytearray bytes callable chr classmethod dict divmod enumerate filter float " +
    "frozenset getattr hasattr hash id int isinstance issubclass iter len list map max memoryview " +
    "min next object ord pow print property range repr reversed round set setattr slice sorted " +
    "staticmethod str sum super tuple vars zip Exception BaseException ValueError TypeError " +
    "KeyError IndexError AttributeError NotImplemented Ellipsis self cls"
  ).split(" ")
);

/** A valid Python identifier for a user name (no leading underscore, not a keyword). */
export function pyIdent(name: string, avoid?: ReadonlySet<string>): string {
  let s = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (s === "") s = "x";
  if (/^[0-9]/.test(s)) s = "n" + s;
  if (s.startsWith("_")) s = "u" + s;
  while (PY_KEYWORDS.has(s) || PY_BUILTINS.has(s) || avoid?.has(s)) s += "_";
  return s;
}

/** A Python string literal. */
export function pyStr(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, "0")}`;
    else if (c >= 0xd800 && c <= 0xdfff) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else if (c > 0xffff) out += `\\U${c.toString(16).padStart(8, "0")}`;
    else if (c > 0x7e) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

/** A Python bytes literal from hex. */
export function pyBytes(hex: string): string {
  let out = 'b"';
  for (let i = 0; i < hex.length; i += 2) {
    const c = parseInt(hex.slice(i, i + 2), 16);
    if (c >= 0x20 && c < 0x7f && c !== 0x22 && c !== 0x5c) out += String.fromCharCode(c);
    else out += `\\x${c.toString(16).padStart(2, "0")}`;
  }
  return out + '"';
}

/** A Python float literal. */
export function pyFloat(x: number): string {
  if (Number.isNaN(x)) return 'float("nan")';
  if (x === Infinity) return 'float("inf")';
  if (x === -Infinity) return 'float("-inf")';
  if (Object.is(x, -0)) return "-0.0";
  const s = String(x);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

/** A Python integer literal (hex for round numbers). */
export function pyInt(b: bigint): string {
  const a = b < 0n ? -b : b;
  const round = (a >= 0x10000n && (a & 0xffn) === 0n) || (a >= 256n && (a & (a - 1n)) === 0n);
  return round ? (b < 0n ? "-0x" : "0x") + a.toString(16) : b.toString();
}

export function pyBool(b: boolean): string {
  return b ? "True" : "False";
}

/** A tuple display (`(a,)` for one item). */
export function pyTuple(items: readonly string[]): string {
  return `(${items.join(", ")}${items.length === 1 ? "," : ""})`;
}

/** Removes one pair of outer parentheses if they enclose the whole expression. */
export function stripParens(s: string): string {
  if (!s.startsWith("(") || !s.endsWith(")")) return s;
  let depth = 0;
  let inStr: string | undefined;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === inStr) inStr = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (depth === 0 && i < s.length - 1) return s;
  }
  return s.slice(1, -1);
}

/** Wraps in parentheses unless it is clearly atomic. */
export function paren(s: string): string {
  if (/^[A-Za-z0-9_.]+$/.test(s)) return s;
  if (s.startsWith("(") && stripParens(s) !== s) return s;
  return `(${s})`;
}
