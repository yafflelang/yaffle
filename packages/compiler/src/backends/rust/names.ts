/** Rust identifiers: keyword escaping, case conversion, uniqueness. */

const KEYWORDS = new Set([
  "as",
  "break",
  "const",
  "continue",
  "crate",
  "else",
  "enum",
  "extern",
  "false",
  "fn",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "match",
  "mod",
  "move",
  "mut",
  "pub",
  "ref",
  "return",
  "self",
  "Self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "type",
  "unsafe",
  "use",
  "where",
  "while",
  "async",
  "await",
  "dyn",
  "abstract",
  "become",
  "box",
  "do",
  "final",
  "macro",
  "override",
  "priv",
  "typeof",
  "unsized",
  "virtual",
  "yield",
  "try",
  "gen"
]);

/** Keywords that cannot be raw identifiers. */
const NO_RAW = new Set(["crate", "self", "Self", "super", "_"]);

/** Replaces characters that are not valid in identifiers. */
export function sanitize(name: string): string {
  let s = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (s === "" || /^[0-9]/.test(s)) s = "_" + s;
  return s;
}

/** Splits an identifier into words (camelCase, snake_case, digits). */
function words(name: string): string[] {
  return sanitize(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[_\s]+/)
    .filter(w => w.length > 0);
}

/** snake_case field or function name, escaped if it is a keyword. */
export function snake(name: string): string {
  const w = words(name);
  let s = w.map(x => x.toLowerCase()).join("_");
  if (s === "") s = "_";
  if (/^[0-9]/.test(s)) s = "_" + s;
  if (name.startsWith("_") && !s.startsWith("_")) s = "_" + s;
  return escapeKeyword(s);
}

/** CamelCase type or variant name. */
export function camel(name: string): string {
  const w = words(name);
  let s = w.map(x => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase()).join("");
  if (s === "") s = "X";
  if (/^[0-9]/.test(s)) s = "V" + s;
  return escapeKeyword(s);
}

/** Keeps a name as is when it is a valid identifier (escaping keywords). */
export function ident(name: string): string {
  return escapeKeyword(sanitize(name));
}

export function escapeKeyword(s: string): string {
  if (KEYWORDS.has(s)) return NO_RAW.has(s) ? s + "_" : "r#" + s;
  if (NO_RAW.has(s)) return s + "_";
  return s;
}

/** A Rust string literal. */
export function strLit(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += `\\u{${c.toString(16)}}`;
    else out += ch;
  }
  return out + '"';
}

/** Allocates unique names within a scope. */
export class NameSet {
  private used = new Set<string>();
  constructor(reserved: Iterable<string> = []) {
    for (const r of reserved) this.used.add(r);
  }
  take(base: string): string {
    let n = base;
    let i = 2;
    while (this.used.has(n)) n = `${base}${i++}`;
    this.used.add(n);
    return n;
  }
}
