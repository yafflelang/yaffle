/**
 * The yaffle lexer. Newlines are significant (optional semicolons, `@` continuation lines), so
 * every token records whether a line break precedes it. Comments are collected separately (the
 * formatter, folding and semantic tokens use them; `/** … *\/` doc comments attach to
 * declarations).
 */
import { DiagnosticBag, type DiagnosticCode } from "./diagnostics.ts";
import type { SourceFile, Span } from "./source.ts";

export type PunctKind =
  | "{"
  | "}"
  | "("
  | ")"
  | "["
  | "]"
  | "<"
  | ">"
  | ","
  | ";"
  | ":"
  | "."
  | ".."
  | "="
  | "=="
  | "!="
  | "<="
  | ">="
  | "&&"
  | "||"
  | "!"
  | "~"
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "<<"
  | ">>"
  | "&"
  | "|"
  | "^"
  | "?"
  | "->"
  | "=>";

export type TokenKind =
  | "ident"
  /** `$name`; `value` is the name without `$`. */
  | "dollar"
  /** `@name`; `value` is the name without `@`. */
  | "attr"
  | "int"
  | "float"
  | "string"
  /** `x"5f2a 91c3"`; `value` is lowercase hex without spaces. */
  | "hexbytes"
  /** `b64"…"`; `value` is lowercase hex of the decoded bytes. */
  | "b64bytes"
  /** `'ARCV'`; `value` is the characters. */
  | "fourcc"
  /** `/re/` (only directly after `in`); `value` is the pattern source. */
  | "regex"
  | PunctKind
  | "eof"
  | "error";

export interface Token {
  kind: TokenKind;
  start: number;
  end: number;
  /** Raw source text. */
  text: string;
  /** Decoded value: identifier/string text, number value, or bytes as hex. */
  value: string;
  /** True if a line break separates this token from the previous one (or it's the first token). */
  newlineBefore: boolean;
}

export interface Comment extends Span {
  kind: "line" | "block";
  text: string;
  /** `/** … *\/` */
  doc: boolean;
}

export interface LexResult {
  tokens: Token[];
  comments: Comment[];
}

const PUNCT2 = ["..", "==", "!=", "<=", ">=", "&&", "||", "<<", ">>", "->", "=>"];
const PUNCT1 = "{}()[]<>,;:.=!~+-*/%&|^?";

const ID_START = /[\p{ID_Start}_]/u;
const ID_CONTINUE = /[\p{ID_Continue}_]/u;

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}
function isHexDigit(c: string): boolean {
  return /^[0-9a-fA-F]$/.test(c);
}

export function lex(file: SourceFile, diagnostics: DiagnosticBag = new DiagnosticBag()): LexResult {
  return new Lexer(file, diagnostics).run();
}

type Push = (kind: TokenKind, start: number, end: number, value?: string) => void;

class Lexer {
  private readonly file: SourceFile;
  private readonly text: string;
  private readonly diagnostics: DiagnosticBag;
  private readonly tokens: Token[] = [];
  private readonly comments: Comment[] = [];
  private i = 0;
  /** A line break since the last token. */
  private newline = true;

  constructor(file: SourceFile, diagnostics: DiagnosticBag) {
    this.file = file;
    this.text = file.text;
    this.diagnostics = diagnostics;
  }

  run(): LexResult {
    const { text } = this;
    while (this.i < text.length) {
      const c = text[this.i]!;
      if (c === "\n" || c === "\r") {
        this.newline = true;
        this.i++;
      } else if (
        c === " " ||
        c === "\t" ||
        c === "\f" ||
        c === "\v" ||
        c === "\uFEFF" ||
        c === "\u00A0"
      )
        this.i++;
      else if (c === "/" && text[this.i + 1] === "/") this.lineComment();
      else if (c === "/" && text[this.i + 1] === "*") this.blockComment();
      else if (c === "/" && this.afterIn()) this.regex();
      else if (
        (c === "x" && text[this.i + 1] === '"') ||
        (text.startsWith("b64", this.i) && text[this.i + 3] === '"')
      )
        this.byteString(c === "x");
      else if (this.atIdentStart()) {
        const start = this.i;
        this.i = scanIdent(text, this.i);
        this.push("ident", start, this.i);
      } else if (c === "$" || c === "@") this.sigil(c);
      else if (isDigit(c))
        this.i = scanNumber(text, this.i, this.file, this.diagnostics, this.push);
      else if (c === '"' || c === "'") this.quoted(c);
      else this.punctuation(c);
    }
    this.tokens.push({
      kind: "eof",
      start: text.length,
      end: text.length,
      text: "",
      value: "",
      newlineBefore: true
    });
    return { tokens: this.tokens, comments: this.comments };
  }

  private readonly push: Push = (kind, start, end, value) => {
    this.tokens.push({
      kind,
      start,
      end,
      text: this.text.slice(start, end),
      value: value ?? this.text.slice(start, end),
      newlineBefore: this.newline
    });
    this.newline = false;
  };

  private report(start: number, end: number, code: DiagnosticCode, msg: string): void {
    this.diagnostics.report(this.file, { start, end: Math.max(end, start) }, code, msg);
  }

  private lineComment(): void {
    const { text } = this;
    const start = this.i;
    while (this.i < text.length && text[this.i] !== "\n" && text[this.i] !== "\r") this.i++;
    this.comments.push({
      kind: "line",
      start,
      end: this.i,
      text: text.slice(start, this.i),
      doc: text[start + 2] === "/" && text[start + 3] !== "/"
    });
  }

  private blockComment(): void {
    const { text } = this;
    const start = this.i;
    const close = text.indexOf("*/", start + 2);
    const end = close < 0 ? text.length : close + 2;
    if (close < 0)
      this.report(start, start + 2, "unterminated-comment", "Unterminated comment: missing */.");
    const body = text.slice(start, end);
    if (/[\r\n]/.test(body)) this.newline = true;
    this.comments.push({
      kind: "block",
      start,
      end,
      text: body,
      doc: body.startsWith("/**") && body !== "/**/" && !body.startsWith("/***")
    });
    this.i = end;
  }

  /** Regex literals are only recognized directly after `in`. */
  private afterIn(): boolean {
    const prev = this.tokens[this.tokens.length - 1];
    return !!prev && prev.kind === "ident" && prev.value === "in";
  }

  private regex(): void {
    const { text } = this;
    const start = this.i;
    let j = start + 1;
    let inClass = false;
    let closed = false;
    while (j < text.length) {
      const d = text[j]!;
      if (d === "\n" || d === "\r") break;
      if (d === "\\") {
        j += 2;
        continue;
      }
      if (d === "[") inClass = true;
      else if (d === "]") inClass = false;
      else if (d === "/" && !inClass) {
        closed = true;
        break;
      }
      j++;
    }
    if (closed) {
      this.push("regex", start, j + 1, text.slice(start + 1, j));
      this.i = j + 1;
      return;
    }
    const end = Math.min(j, text.length);
    this.report(start, end, "unterminated-regex", "Unterminated regex literal: missing closing /.");
    this.push("regex", start, end, text.slice(start + 1, end));
    this.i = end;
  }

  /** `x"…"` (hex) or `b64"…"`; the token value is lowercase hex. */
  private byteString(isHex: boolean): void {
    const { text } = this;
    const start = this.i;
    const qStart = isHex ? start + 1 : start + 3;
    const { end, closed } = scanQuoted(text, qStart, '"');
    const inner = text.slice(qStart + 1, closed ? end - 1 : end);
    if (!closed)
      this.report(
        start,
        end,
        "unterminated-string",
        "Unterminated byte string: missing closing quote."
      );
    let hex = "";
    if (isHex) {
      const digits = inner.replace(/[\s_]/g, "");
      if (!/^[0-9a-fA-F]*$/.test(digits))
        this.report(
          start,
          end,
          "invalid-hex-bytes",
          "Hex bytes may only contain hex digits and spaces."
        );
      else if (digits.length % 2 !== 0)
        this.report(start, end, "invalid-hex-bytes", "Hex bytes need an even number of digits.");
      else hex = digits.toLowerCase();
      this.push("hexbytes", start, end, hex);
    } else {
      const b64 = inner.replace(/\s/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || (b64.length % 4 !== 0 && b64.includes("=")))
        this.report(start, end, "invalid-base64", 'Invalid base64 in b64"…" literal.');
      else hex = Buffer.from(b64, "base64").toString("hex");
      this.push("b64bytes", start, end, hex);
    }
    this.i = end;
  }

  private atIdentStart(): boolean {
    const c = this.text[this.i]!;
    const code = c.charCodeAt(0);
    return (
      ID_START.test(c) ||
      (code >= 0xd800 && code <= 0xdbff && ID_START.test(this.text.slice(this.i, this.i + 2)))
    );
  }

  /** `$name` or `@name`. */
  private sigil(c: "$" | "@"): void {
    const { text } = this;
    const start = this.i;
    let j = start + 1;
    if (j < text.length && ID_START.test(text[j]!)) j = scanIdent(text, j);
    const name = text.slice(start + 1, j);
    if (!name)
      this.report(
        start,
        start + 1,
        "syntax-error",
        c === "$" ? "Expected a name after $." : "Expected an attribute name after @."
      );
    this.push(c === "$" ? "dollar" : "attr", start, j, name);
    this.i = j;
  }

  /** A string literal, or a character code in single quotes. */
  private quoted(quote: '"' | "'"): void {
    const { text } = this;
    const start = this.i;
    const { end, closed, value, badEscapes } = scanString(text, start, quote);
    if (!closed)
      this.report(
        start,
        end,
        "unterminated-string",
        quote === '"'
          ? "Unterminated string: missing closing quote."
          : "Unterminated four-character code: missing closing '."
      );
    for (const b of badEscapes)
      this.report(
        b.start,
        b.end,
        "invalid-escape",
        `Unknown escape sequence ${text.slice(b.start, b.end)}.`
      );
    const ascii = [...value].every(ch => ch.charCodeAt(0) < 0x80);
    if (quote === "'" && closed && (value.length === 0 || value.length > 8 || !ascii))
      this.report(start, end, "invalid-fourcc", "A character code needs 1 to 8 ASCII characters.");
    this.push(quote === '"' ? "string" : "fourcc", start, end, value);
    this.i = end;
  }

  private punctuation(c: string): void {
    const start = this.i;
    const two = this.text.slice(start, start + 2);
    if (PUNCT2.includes(two)) {
      this.i += 2;
      this.push(two as TokenKind, start, this.i);
    } else if (PUNCT1.includes(c)) {
      this.i++;
      this.push(c as TokenKind, start, this.i);
    } else {
      const cp = this.text.codePointAt(start)!;
      const len = cp > 0xffff ? 2 : 1;
      this.report(
        start,
        start + len,
        "invalid-character",
        `Unexpected character '${String.fromCodePoint(cp)}'.`
      );
      this.i += len;
      this.push("error", start, this.i);
    }
  }
}

function scanIdent(text: string, i: number): number {
  i += text.codePointAt(i)! > 0xffff ? 2 : 1;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (!ID_CONTINUE.test(ch)) break;
    i += ch.length;
  }
  return i;
}

function scanQuoted(text: string, i: number, quote: string): { end: number; closed: boolean } {
  let j = i + 1;
  while (j < text.length) {
    const d = text[j]!;
    if (d === "\\") {
      j += 2;
      continue;
    }
    if (d === quote) return { end: j + 1, closed: true };
    if (d === "\n" || d === "\r") return { end: j, closed: false };
    j++;
  }
  return { end: text.length, closed: false };
}

function scanString(
  text: string,
  i: number,
  quote: string
): { end: number; closed: boolean; value: string; badEscapes: Span[] } {
  let j = i + 1;
  let value = "";
  const badEscapes: Span[] = [];
  while (j < text.length) {
    const d = text[j]!;
    if (d === quote) return { end: j + 1, closed: true, value, badEscapes };
    if (d === "\n" || d === "\r") return { end: j, closed: false, value, badEscapes };
    if (d === "\\") {
      const e = text[j + 1];
      const escStart = j;
      j += 2;
      switch (e) {
        case "n":
          value += "\n";
          break;
        case "t":
          value += "\t";
          break;
        case "r":
          value += "\r";
          break;
        case "0":
          value += "\0";
          break;
        case "\\":
          value += "\\";
          break;
        case '"':
          value += '"';
          break;
        case "'":
          value += "'";
          break;
        case "x": {
          const h = text.slice(j, j + 2);
          if (h.length === 2 && isHexDigit(h[0]!) && isHexDigit(h[1]!)) {
            value += String.fromCharCode(parseInt(h, 16));
            j += 2;
          } else badEscapes.push({ start: escStart, end: j });
          break;
        }
        case "u": {
          if (text[j] === "{") {
            const close = text.indexOf("}", j);
            const h = close > 0 ? text.slice(j + 1, close) : "";
            if (close > 0 && /^[0-9a-fA-F]{1,6}$/.test(h) && parseInt(h, 16) <= 0x10ffff) {
              value += String.fromCodePoint(parseInt(h, 16));
              j = close + 1;
            } else badEscapes.push({ start: escStart, end: close > 0 ? close + 1 : j });
          } else {
            const h = text.slice(j, j + 4);
            if (/^[0-9a-fA-F]{4}$/.test(h)) {
              value += String.fromCharCode(parseInt(h, 16));
              j += 4;
            } else badEscapes.push({ start: escStart, end: j });
          }
          break;
        }
        default:
          if (e === undefined || e === "\n" || e === "\r") {
            j--;
            badEscapes.push({ start: escStart, end: j });
          } else {
            badEscapes.push({ start: escStart, end: j });
            value += e;
          }
      }
      continue;
    }
    value += d;
    j++;
  }
  return { end: text.length, closed: false, value, badEscapes };
}

function scanNumber(
  text: string,
  i: number,
  file: SourceFile,
  diagnostics: DiagnosticBag,
  push: (kind: TokenKind, start: number, end: number, value?: string) => void
): number {
  const start = i;
  let bad = false;
  const digitsWith = (pred: (c: string) => boolean): string => {
    let s = "";
    let lastUnderscore = false;
    while (i < text.length && (pred(text[i]!) || text[i] === "_")) {
      if (text[i] === "_") {
        if (lastUnderscore || s === "") bad = true;
        lastUnderscore = true;
      } else {
        s += text[i];
        lastUnderscore = false;
      }
      i++;
    }
    if (lastUnderscore) bad = true;
    return s;
  };
  const prefix = text.slice(i, i + 2).toLowerCase();
  if (prefix === "0x" || prefix === "0b" || prefix === "0o") {
    i += 2;
    const radix = prefix === "0x" ? 16 : prefix === "0b" ? 2 : 8;
    const pred =
      radix === 16
        ? isHexDigit
        : radix === 2
          ? (c: string) => c === "0" || c === "1"
          : (c: string) => c >= "0" && c <= "7";
    const digits = digitsWith(pred);
    // trailing identifier characters make it malformed (e.g. 0x12g)
    while (i < text.length && ID_CONTINUE.test(text[i]!)) {
      bad = true;
      i++;
    }
    if (!digits) bad = true;
    if (bad) {
      diagnostics.report(
        file,
        { start, end: i },
        "invalid-number",
        `Malformed number literal '${text.slice(start, i)}'.`
      );
      push("int", start, i, "0");
    } else {
      const value = BigInt((radix === 16 ? "0x" : radix === 2 ? "0b" : "0o") + digits);
      push("int", start, i, value.toString());
    }
    return i;
  }
  let intPart = digitsWith(isDigit);
  let isFloat = false;
  let frac = "";
  let exp = "";
  if (text[i] === "." && isDigit(text[i + 1] ?? "")) {
    isFloat = true;
    i++;
    frac = digitsWith(isDigit);
  }
  if (
    (text[i] === "e" || text[i] === "E") &&
    (isDigit(text[i + 1] ?? "") ||
      ((text[i + 1] === "+" || text[i + 1] === "-") && isDigit(text[i + 2] ?? "")))
  ) {
    isFloat = true;
    i++;
    let sign = "";
    if (text[i] === "+" || text[i] === "-") sign = text[i++]!;
    exp = sign + digitsWith(isDigit);
  }
  while (i < text.length && ID_CONTINUE.test(text[i]!)) {
    bad = true;
    i++;
  }
  if (bad) {
    diagnostics.report(
      file,
      { start, end: i },
      "invalid-number",
      `Malformed number literal '${text.slice(start, i)}'.`
    );
    push(isFloat ? "float" : "int", start, i, "0");
    return i;
  }
  if (isFloat) {
    const v = Number(`${intPart}.${frac || "0"}${exp ? "e" + exp : ""}`);
    push("float", start, i, String(v));
  } else {
    if (intPart.length > 1 && intPart.startsWith("0")) intPart = intPart.replace(/^0+(?=\d)/, "");
    push("int", start, i, BigInt(intPart).toString());
  }
  return i;
}
