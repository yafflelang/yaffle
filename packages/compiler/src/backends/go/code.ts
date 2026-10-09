/** A tiny tab-indented code builder plus identifier helpers for the Go backend. */

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
    for (const l of s.split("\n")) this.lines.push(l ? "\t".repeat(this.depth) + l : "");
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

  /** A fresh local name like `t3` (unique within builders sharing a counter). */
  fresh(prefix = "t"): string {
    return `${prefix}${++this.counter.n}`;
  }

  /** `h0 { … } h1 { … }`: if/else chains. */
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

  /** Declares `le` (endian is little) when body uses it. */
  declareLe(body: string): this {
    if (mentions(body, "le")) this.line("le := endian == yaffle.LE");
    return this;
  }

  /** Appends the lines of another builder at the current indentation. */
  append(other: Code): this {
    for (const l of other.lines) this.lines.push(l ? "\t".repeat(this.depth) + l : "");
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

const GO_KEYWORDS = new Set(
  "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var".split(
    " "
  )
);

/** Predeclared identifiers and package names generated code uses unqualified. */
const PREDECLARED = new Set(
  (
    "any append bool byte cap clear close complex complex128 complex64 copy delete error false float32 float64 " +
    "imag int int16 int32 int64 int8 iota len make max min new nil panic print println real recover rune string " +
    "true uint uint16 uint32 uint64 uint8 uintptr comparable " +
    "yaffle big bytes context math regexp strconv"
  ).split(" ")
);

/** Temporaries look like `t12` (Code.fresh): user names that do get a suffix. */
const TEMP = /^[a-z]{1,4}\d+$/;

/** Locals every generated function may use. */
const LOCALS = new Set("r w v j c o p fr le endian index L u e x ix i n s".split(" "));

function sanitize(name: string): string {
  let s = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (s === "") s = "x";
  if (/^[0-9]/.test(s)) s = "_" + s;
  return s;
}

/** An exported Go identifier for a user name (types, fields). */
export function exported(name: string): string {
  let s = sanitize(name).replace(/^_+/, "");
  if (s === "" || /^[0-9]/.test(s)) s = "X" + s;
  return s[0]!.toUpperCase() + s.slice(1);
}

/** An unexported Go identifier for a user name (hidden fields). */
export function unexported(name: string): string {
  let s = sanitize(name).replace(/^_+/, "");
  if (s === "" || /^[0-9]/.test(s)) s = "x" + s;
  s = s[0]!.toLowerCase() + s.slice(1);
  if (GO_KEYWORDS.has(s) || PREDECLARED.has(s) || TEMP.test(s)) s += "_";
  return s;
}

/** A Go local / parameter name for a user name. */
export function local(name: string): string {
  let s = sanitize(name);
  if (GO_KEYWORDS.has(s) || PREDECLARED.has(s) || LOCALS.has(s) || TEMP.test(s)) s += "_";
  return s;
}

/**
 * A func literal returning expr: one line when expr is, otherwise the body on its own lines (the
 * shape gofmt keeps). `head` is the signature, e.g. `func() []byte`.
 */
export function funcLit(head: string, expr: string): string {
  if (!expr.includes("\n")) return `${head} { return ${expr} }`;
  return `${head} {\n\treturn ${expr.split("\n").join("\n\t")}\n}`;
}

/** Go code with the contents of its string literals removed. */
function withoutStrings(code: string): string {
  return code.replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/`[^`]*`/g, "``");
}

/** True if Go code mentions identifier `name` outside string literals. */
export function mentions(code: string, name: string): boolean {
  const noStrings = withoutStrings(code);
  return new RegExp(`(?<![A-Za-z0-9_.])${name}(?![A-Za-z0-9_])`).test(noStrings);
}

/** Allocates unique names. */
export class NameSet {
  private readonly used = new Set<string>();
  constructor(reserved: Iterable<string> = []) {
    for (const r of reserved) this.used.add(r);
  }
  take(base: string): string {
    let n = base;
    for (let i = 2; this.used.has(n); i++) n = `${base}${i}`;
    this.used.add(n);
    return n;
  }
}

/** A Go interpreted string literal. */
export function goStr(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (cp >= 0xd800 && cp <= 0xdfff) out += "\\uFFFD";
    else out += ch;
  }
  return out + '"';
}

/** Strips one level of enclosing parentheses (if/for/switch headers, gofmt removes them). */
export function stripParens(s: string): string {
  if (!s.startsWith("(") || !s.endsWith(")")) return s;
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && i < s.length - 1) return s;
  }
  return s.slice(1, -1);
}

/**
 * Columns aligned like gofmt's tabwriter (cells padded to the widest + 1 space). Each row is a
 * list of cells; the last cell is not padded.
 */
export function alignRows(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const r of rows)
    r.forEach((cell, i) => {
      if (i < r.length - 1) widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  return rows.map(r =>
    r.map((cell, i) => (i < r.length - 1 ? cell.padEnd(widths[i]! + 1) : cell)).join("")
  );
}

/**
 * Generated functions declare temporaries that may end up unused (Go rejects them). Rewrites
 * `name := expr` of temps (names like `t12`) that are never mentioned again to `_ = expr`, and
 * drops `var name T` lines of unused temps.
 */
export function fixUnused(fn: string): string {
  const noStrings = withoutStrings(fn);
  const counts = new Map<string, number>();
  for (const m of noStrings.matchAll(/\b([a-z]{1,4}\d+)\b/g)) {
    counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  const lines = fn.split("\n");
  const out: string[] = [];
  for (const l of lines) {
    const decl = /^(\s*)([a-z]{1,4}\d+) := (.*)$/.exec(l);
    if (decl && (counts.get(decl[2]!) ?? 0) <= 1) {
      // A plain read (`r.Pos`) has no effect: drop it. Anything else keeps its side effects.
      if (!/^[A-Za-z0-9_.]+$/.test(decl[3]!)) out.push(`${decl[1]}_ = ${decl[3]}`);
      continue;
    }
    const v = /^\s*var ([a-z]{1,4}\d+) [^=]*$/.exec(l);
    if (v && (counts.get(v[1]!) ?? 0) <= 1) continue;
    out.push(l);
  }
  return out.join("\n");
}
