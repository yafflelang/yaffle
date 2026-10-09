/** A tiny indented code builder plus identifier helpers for the TS backend. */

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
    this.line(`${head} {`);
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

const RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false " +
    "finally for function if import in instanceof new null return super switch this throw true try " +
    "typeof var void while with as implements interface let package private protected public static " +
    "yield any boolean constructor declare get module require number set string symbol type from of " +
    "async await bigint never object unknown undefined arguments eval"
  ).split(" ")
);

/** A safe TS identifier for a user name (used for parameters and locals). */
export function ident(name: string): string {
  let s = name.replace(/[^A-Za-z0-9_$]/g, "_");
  if (/^[0-9]/.test(s)) s = "_" + s;
  if (RESERVED.has(s)) s += "_";
  return s;
}

/**
 * Globals that generated code uses unqualified. A user type with one of these names gets a
 * trailing underscore so it does not shadow the global inside the generated module.
 */
const SHADOWED = new Set(
  "BigInt Number String Math Promise Object Array Map Set Uint8Array DataView Error JSON Symbol Boolean Date RegExp ReadonlyMap Function Infinity NaN globalThis".split(
    " "
  )
);

/** TS name of a user type (struct, enum, root API object). */
export function typeName(name: string): string {
  const s = ident(name);
  return SHADOWED.has(s) ? `${s}_` : s;
}

/** A property key: bare if it is a valid identifier, quoted otherwise. */
export function propKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/** Property access `obj.name` or `obj["name"]`. */
export function prop(obj: string, name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? `${obj}.${name}`
    : `${obj}[${JSON.stringify(name)}]`;
}

export function str(s: string): string {
  return JSON.stringify(s);
}

/** True if `code` is one parenthesized group: `(a + b)`, not `(a) + (b)`. */
function isGroup(code: string): boolean {
  if (!code.startsWith("(") || !code.endsWith(")")) return false;
  let depth = 0;
  for (let i = 0; i < code.length - 1; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")") depth--;
    if (depth === 0) return false;
  }
  return true;
}

/** `code` as an operand: unchanged if it is a name or one group, else parenthesized. */
export function group(code: string): string {
  return /^[A-Za-z0-9_$.]+$/.test(code) || isGroup(code) ? code : `(${code})`;
}

/** `code` without its outer parentheses, if it is one group (for `if (…)`). */
export function ungroup(code: string): string {
  return isGroup(code) ? code.slice(1, -1) : code;
}

/** Relative module specifier from one generated file to another (both output-relative). */
export function relImport(fromFile: string, toFile: string): string {
  const from = fromFile.split("/").slice(0, -1);
  const to = toFile.split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const up = from.length - i;
  const rest = to.slice(i).join("/");
  return (up === 0 ? "./" : "../".repeat(up)) + rest;
}
