import { describe, expect, it } from "vitest";
import { lexSource } from "../helpers.ts";

const kinds = (text: string) => lexSource(text).tokens.map(t => t.kind);
const values = (text: string) =>
  lexSource(text)
    .tokens.filter(t => t.kind !== "eof")
    .map(t => t.value);

describe("lexer", () => {
  it("lexes identifiers and keywords as identifiers", () => {
    expect(kinds("struct Entry u32be _x9")).toEqual(["ident", "ident", "ident", "ident", "eof"]);
    expect(values("struct Entry u32be _x9")).toEqual(["struct", "Entry", "u32be", "_x9"]);
  });

  it("lexes unicode identifiers", () => {
    expect(values("größe ñ")).toEqual(["größe", "ñ"]);
  });

  it("lexes decimal, hex, binary and octal integers with separators", () => {
    expect(values("1_000 0x5643_5241 0b1010 0o17 0 007")).toEqual([
      "1000",
      String(0x56435241),
      "10",
      "15",
      "0",
      "7"
    ]);
    expect(kinds("1_000 0x4c")).toEqual(["int", "int", "eof"]);
  });

  it("lexes floats", () => {
    expect(kinds("360.0 1.5e3 2e-2 1E+2")).toEqual(["float", "float", "float", "float", "eof"]);
    expect(values("360.0 1.5e3 2e-2")).toEqual(["360", "1500", "0.02"]);
  });

  it("does not eat .. after an integer (ranges)", () => {
    expect(kinds("5..9")).toEqual(["int", "..", "int", "eof"]);
    expect(kinds("raw[a..b]")).toEqual(["ident", "[", "ident", "..", "ident", "]", "eof"]);
  });

  it("reports malformed numbers", () => {
    expect(lexSource("0x").diagnostics).toEqual(["invalid-number"]);
    expect(lexSource("12ab").diagnostics).toEqual(["invalid-number"]);
    expect(lexSource("1__0").diagnostics).toEqual(["invalid-number"]);
    expect(lexSource("1_").diagnostics).toEqual(["invalid-number"]);
    expect(lexSource("0b102").diagnostics).toEqual(["invalid-number"]);
  });

  it("lexes strings with escapes", () => {
    const t = lexSource(String.raw`"a\n\t\0\\\"\x41B\u{1F600}"`).tokens[0]!;
    expect(t.kind).toBe("string");
    expect(t.value).toBe('a\n\t\0\\"AB\u{1F600}');
  });

  it("reports unterminated strings and bad escapes", () => {
    expect(lexSource('"abc').diagnostics).toEqual(["unterminated-string"]);
    expect(lexSource('"a\nb"').diagnostics).toContain("unterminated-string");
    expect(lexSource(String.raw`"\q"`).diagnostics).toEqual(["invalid-escape"]);
    expect(lexSource(String.raw`"\xZ1"`).diagnostics).toEqual(["invalid-escape"]);
  });

  it("lexes hex byte literals", () => {
    const t = lexSource('x"5f2a 91c3"').tokens[0]!;
    expect(t.kind).toBe("hexbytes");
    expect(t.value).toBe("5f2a91c3");
    expect(lexSource('x"abc"').diagnostics).toEqual(["invalid-hex-bytes"]);
    expect(lexSource('x"zz"').diagnostics).toEqual(["invalid-hex-bytes"]);
  });

  it("lexes base64 byte literals", () => {
    const t = lexSource('b64"AQID"').tokens[0]!;
    expect(t.kind).toBe("b64bytes");
    expect(t.value).toBe("010203");
    expect(lexSource('b64"!!"').diagnostics).toEqual(["invalid-base64"]);
  });

  it("lexes four-character codes", () => {
    const t = lexSource("'ARCV'").tokens[0]!;
    expect(t.kind).toBe("fourcc");
    expect(t.value).toBe("ARCV");
    expect(lexSource("''").diagnostics).toEqual(["invalid-fourcc"]);
    expect(lexSource("'TOOLONGXX'").diagnostics).toEqual(["invalid-fourcc"]);
  });

  it("lexes a regex only directly after `in`", () => {
    const toks = lexSource(String.raw`str ver in /v\d\.\d{1,2}/`).tokens;
    expect(toks.map(t => t.kind)).toEqual(["ident", "ident", "ident", "regex", "eof"]);
    expect(toks[3]!.value).toBe(String.raw`v\d\.\d{1,2}`);
    expect(kinds("a / b")).toEqual(["ident", "/", "ident", "eof"]);
  });

  it("handles slashes inside regex character classes", () => {
    const toks = lexSource("x in /[/]+/").tokens;
    expect(toks[2]!.value).toBe("[/]+");
  });

  it("reports unterminated regexes", () => {
    expect(lexSource("x in /abc").diagnostics).toEqual(["unterminated-regex"]);
  });

  it("lexes $names and @attributes", () => {
    const toks = lexSource("$version @padUntil @").tokens;
    expect(toks.map(t => [t.kind, t.value])).toEqual([
      ["dollar", "version"],
      ["attr", "padUntil"],
      ["attr", ""],
      ["eof", ""]
    ]);
    expect(lexSource("@").diagnostics).toEqual(["syntax-error"]);
  });

  it("lexes all operators", () => {
    expect(
      kinds("== != <= >= && || << >> -> => .. ! ~ + - * / % & | ^ ? : ; , . = < > ( ) [ ] { }")
    ).toEqual([
      "==",
      "!=",
      "<=",
      ">=",
      "&&",
      "||",
      "<<",
      ">>",
      "->",
      "=>",
      "..",
      "!",
      "~",
      "+",
      "-",
      "*",
      "/",
      "%",
      "&",
      "|",
      "^",
      "?",
      ":",
      ";",
      ",",
      ".",
      "=",
      "<",
      ">",
      "(",
      ")",
      "[",
      "]",
      "{",
      "}",
      "eof"
    ]);
  });

  it("tracks newlines before tokens", () => {
    const toks = lexSource("a b\nc /* x\ny */ d // e\nf").tokens;
    expect(toks.map(t => t.newlineBefore)).toEqual([true, false, true, true, true, true]);
  });

  it("collects comments, marking doc comments", () => {
    const { comments } = lexSource("/** doc */ // line\n/* block */ /// triple\n//// quad");
    expect(comments.map(c => [c.kind, c.doc])).toEqual([
      ["block", true],
      ["line", false],
      ["block", false],
      ["line", true],
      ["line", false]
    ]);
  });

  it("reports unterminated block comments", () => {
    expect(lexSource("/* never closed").diagnostics).toEqual(["unterminated-comment"]);
  });

  it("reports invalid characters", () => {
    const r = lexSource("u32 a § b");
    expect(r.diagnostics).toEqual(["invalid-character"]);
    expect(r.tokens.map(t => t.kind)).toEqual(["ident", "ident", "error", "ident", "eof"]);
  });

  it("gives exact spans", () => {
    const toks = lexSource("  u32  $v").tokens;
    expect(toks[0]).toMatchObject({ start: 2, end: 5 });
    expect(toks[1]).toMatchObject({ start: 7, end: 9 });
  });

  it("does not treat x or b64 prefixes as byte strings unless a quote follows", () => {
    expect(kinds("x b64 xs")).toEqual(["ident", "ident", "ident", "eof"]);
  });
});
