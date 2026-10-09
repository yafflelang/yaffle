/**
 * TextMate grammar tests: tokenize yaffle with vscode-textmate + oniguruma (the engine VS Code
 * uses) and assert the scopes of every construct.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { grammarJson } from "../scripts/build.ts";
import { dump, GRAMMAR_FILE, tokenize } from "./tokenize.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

async function scopesOf(source: string, text: string, nth = 0): Promise<string[]> {
  const tokens = await tokenize(source);
  const token = tokens.filter(t => t.text.trim() === text)[nth];
  if (!token) throw new Error(`no token ${JSON.stringify(text)} #${nth} in:\n${dump(tokens)}`);
  return token.scopes;
}

type Case = [source: string, token: string, scope: string, nth?: number];

function cases(title: string, table: Case[]) {
  describe(title, () => {
    it.each(table)("%s  ⟶  %j is %s", async (source, token, scope, nth = 0) => {
      const scopes = await scopesOf(source, token, nth);
      expect(scopes, dump(await tokenize(source))).toContain(scope);
    });
  });
}

describe("the generated grammar", () => {
  it("is up to date with src/grammar.ts", async () => {
    expect(fs.readFileSync(GRAMMAR_FILE, "utf8")).toBe(await grammarJson());
  });

  it("tokenizes every DESIGN.md example without illegal tokens or leaked scopes", async () => {
    const source = fs.readFileSync(path.join(here, "fixtures/design.yfl"), "utf8");
    const tokens = await tokenize(source);
    const illegal = tokens.filter(t => t.scopes.some(s => s.startsWith("invalid.")));
    expect(illegal, dump(illegal)).toEqual([]);
    // Every top-level declaration line starts at the root scope: no region leaked across it.
    const lines = source.split("\n");
    lines.forEach((line, i) => {
      if (/^(struct|export|union|enum|type|extern|import)\b/.test(line)) {
        const first = tokens.find(t => t.line === i)!;
        expect(
          first.scopes.length,
          `line ${i + 1}: ${line}\n${dump(tokens.filter(t => t.line === i))}`
        ).toBeLessThanOrEqual(3);
      }
    });
    // Every identifier gets some scope beyond the root.
    const bare = tokens.filter(t => /^[A-Za-z_$]\w*$/.test(t.text.trim()) && t.scopes.length === 1);
    expect(bare, dump(bare)).toEqual([]);
  });
});

cases("comments", [
  ["// note", "note", "comment.line.double-slash.yaffle"],
  ["// note", "//", "punctuation.definition.comment.yaffle"],
  ["/* block */ u8 x", "block", "comment.block.yaffle"],
  ["/** Doc */", "Doc", "comment.block.documentation.yaffle"],
  ["/* multi\nline */ u8 x", "line", "comment.block.yaffle"],
  ["struct A { u8 x // trailing\n}", "trailing", "comment.line.double-slash.yaffle"],
  ["u8 x = 1 // c", "c", "comment.line.double-slash.yaffle"]
]);

cases("primitives", [
  ...[
    "u8",
    "u16",
    "u24",
    "u32",
    "u40",
    "u48",
    "u56",
    "u64",
    "i8",
    "i16",
    "i24",
    "i32",
    "i40",
    "i48",
    "i56",
    "i64"
  ].map((p): Case => [`struct A { ${p} x }`, p, "support.type.primitive.yaffle"]),
  ...["f16", "f32", "f64", "bool", "char", "char16", "char32", "str", "str16", "str32"].map(
    (p): Case => [`struct A { ${p} x }`, p, "support.type.primitive.yaffle"]
  ),
  ["struct A { u32be crc }", "u32be", "support.type.primitive.yaffle"],
  ["struct A { i16le v }", "i16le", "support.type.primitive.yaffle"],
  ["struct A { f64be v }", "f64be", "support.type.primitive.yaffle"],
  ["struct A { char16le s[4] }", "char16le", "support.type.primitive.yaffle"],
  ["struct A { str16be s }", "str16be", "support.type.primitive.yaffle"],
  ["struct A { uleb128 n }", "uleb128", "support.type.builtin.yaffle"],
  ["struct A { u33 x }", "u33", "entity.name.type.yaffle"],
  ["struct A { u8 x : 4 }", "4", "constant.numeric.decimal.yaffle"]
]);

cases("declarations", [
  ["struct Entry {", "struct", "storage.type.struct.yaffle"],
  ["struct Entry {", "Entry", "entity.name.type.struct.yaffle"],
  ["export struct Archive {", "export", "keyword.control.export.yaffle"],
  ["struct Header @padUntil(0x80) {", "padUntil", "entity.name.function.decorator.yaffle"],
  ["struct Span<T> {", "T", "entity.name.type.parameter.yaffle"],
  ["struct Blob(u32 n) { u8 data[n] }", "n", "variable.parameter.yaffle"],
  ["struct Body(Header hdr) {}", "Header", "entity.name.type.yaffle"],
  ["struct Body(Header hdr) {}", "hdr", "variable.parameter.yaffle"],
  ["struct Node(u8 $key[32]) {}", "key", "variable.other.bound.yaffle"],
  ["struct Outer {\n  struct Inner { u8 x }\n}", "Inner", "entity.name.type.struct.yaffle"],
  ["union Node { Archive  Dict }", "union", "storage.type.union.yaffle"],
  ["union Node { Archive  Dict }", "Node", "entity.name.type.union.yaffle"],
  ["union Node { Archive  Dict }", "Dict", "entity.name.type.yaffle"],
  ["enum MemKind : u16 { Sys = 0, Gpu = 1 }", "enum", "storage.type.enum.yaffle"],
  ["enum MemKind : u16 { Sys = 0, Gpu = 1 }", "MemKind", "entity.name.type.enum.yaffle"],
  ["enum MemKind : u16 { Sys = 0, Gpu = 1 }", "u16", "support.type.primitive.yaffle"],
  ["enum MemKind : u16 { Sys = 0, Gpu = 1 }", "Gpu", "variable.other.enummember.yaffle"],
  ["enum MemKind : u16 { Sys = 0, Gpu = 1 }", "1", "constant.numeric.decimal.yaffle"],
  ["enum E : u8 @open {\n  A = 1 << 2,\n  B\n}", "B", "variable.other.enummember.yaffle"],
  ["enum E : u8 @open {\n  A = 1 << 2,\n  B\n}", "<<", "keyword.operator.bitwise.shift.yaffle"],
  ["enum E : u8 @open { A }", "open", "entity.name.function.decorator.yaffle"],
  ["bits u8 {\n  bool compressed : 1\n}", "bits", "storage.type.bits.yaffle"],
  ["bits u8 {\n  bool compressed : 1\n}", "compressed", "variable.other.member.yaffle"],
  ["type Fixed16 = i16 as it / 256.0", "type", "storage.type.type.yaffle"],
  ["type Fixed16 = i16 as it / 256.0", "Fixed16", "entity.name.type.alias.yaffle"],
  ["type Fixed16 = i16 as it / 256.0", "it", "variable.language.it.yaffle"],
  ["type Fixed(u8 bits) = i32 as it / (1 << bits)", "bits", "variable.parameter.yaffle"],
  ["type EncRec = Record @via(xor(0x5a))", "Record", "entity.name.type.yaffle"],
  ["type EncRec = Record @via(xor(0x5a))", "xor", "entity.name.function.yaffle"],
  ["type Name = char[0x20]", "char", "support.type.primitive.yaffle"],
  ["extern fn pathHash(char path[]) -> u32", "extern", "storage.modifier.extern.yaffle"],
  ["extern fn pathHash(char path[]) -> u32", "fn", "storage.type.function.yaffle"],
  ["extern fn pathHash(char path[]) -> u32", "pathHash", "entity.name.function.yaffle"],
  ["extern fn pathHash(char path[]) -> u32", "path", "variable.parameter.yaffle"],
  ["extern fn pathHash(char path[]) -> u32", "->", "keyword.operator.arrow.yaffle"],
  ["extern codec zstd", "codec", "storage.type.codec.yaffle"],
  ["extern codec zstd", "zstd", "entity.name.function.codec.yaffle"],
  ["extern async codec oodle", "async", "storage.modifier.async.yaffle"],
  ["extern codec chacha20(u8 key[32], u64 nonce) @ranged", "nonce", "variable.parameter.yaffle"],
  [
    "extern codec chacha20(u8 key[32], u64 nonce) @ranged",
    "ranged",
    "entity.name.function.decorator.yaffle"
  ],
  ["extern type VarInt(u8 maxBytes) : u64", "VarInt", "entity.name.type.alias.yaffle"],
  ["extern type VarInt(u8 maxBytes) : u64", "u64", "support.type.primitive.yaffle"],
  ["extern type Half : f32 @size(2)", "size", "entity.name.function.decorator.yaffle"],
  ["export const u32 SECTOR = 0x800", "const", "storage.modifier.const.yaffle"],
  ["export const u32 SECTOR = 0x800", "SECTOR", "variable.other.constant.yaffle"],
  ["export const u32 SECTOR = 0x800", "0x800", "constant.numeric.hex.yaffle"]
]);

cases("imports", [
  ['import { Span, Name } from "./common.yfl"', "import", "keyword.control.import.yaffle"],
  ['import { Span, Name } from "./common.yfl"', "Span", "variable.other.readwrite.alias.yaffle"],
  ['import { Span, Name } from "./common.yfl"', "from", "keyword.control.from.yaffle"],
  ['import { Span, Name } from "./common.yfl"', "./common.yfl", "string.quoted.double.yaffle"],
  ['import { Span as S } from "./c.yfl"', "as", "keyword.control.as.yaffle"],
  ['import { Span as S } from "./c.yfl"', "S", "variable.other.readwrite.alias.yaffle"],
  ['import * as lib from "./lib.yfl"', "*", "constant.language.import-export-all.yaffle"],
  ['import * as lib from "./lib.yfl"', "lib", "entity.name.namespace.yaffle"],
  ['import {\n  A,\n  B\n} from "./x.yfl"', "B", "variable.other.readwrite.alias.yaffle"],
  ['import {\n  A,\n  B\n} from "./x.yfl"', "from", "keyword.control.from.yaffle"]
]);

cases("fields", [
  ["struct A {\n  u16 handler\n}", "handler", "variable.other.member.yaffle"],
  ["struct A {\n  Entry entries[count]\n}", "Entry", "entity.name.type.yaffle"],
  ["struct A {\n  Entry entries[count]\n}", "entries", "variable.other.member.yaffle"],
  ["struct A {\n  Entry entries[count]\n}", "count", "variable.other.readwrite.yaffle"],
  ["struct A {\n  Model *model : u64\n}", "*", "keyword.operator.pointer.yaffle"],
  ["struct A {\n  Model *model : u64\n}", "model", "variable.other.member.yaffle"],
  ["struct A {\n  Model *model : u64\n}", ":", "punctuation.separator.colon.yaffle"],
  ["struct A {\n  Model *model : u64\n}", "u64", "support.type.primitive.yaffle"],
  ["struct A {\n  Record *recs[count] : u64\n}", "recs", "variable.other.member.yaffle"],
  ["struct A {\n  u32 $version\n}", "$", "punctuation.definition.variable.yaffle"],
  ["struct A {\n  u32 $version\n}", "version", "variable.other.bound.yaffle"],
  ["struct A {\n  Blob(16) a\n}", "Blob", "entity.name.type.yaffle"],
  ["struct A {\n  Blob(16) a\n}", "16", "constant.numeric.decimal.yaffle"],
  ["struct A {\n  Blob(16) a\n}", "a", "variable.other.member.yaffle"],
  ["struct A {\n  Blob(n: 32) b\n}", "n", "variable.parameter.named.yaffle"],
  ["struct A {\n  Span<Point> spans\n}", "Point", "entity.name.type.yaffle"],
  ["struct A {\n  Span<Point> spans\n}", "<", "punctuation.definition.typeparameters.begin.yaffle"],
  ["struct A {\n  Span<Point> spans\n}", "spans", "variable.other.member.yaffle"],
  ["struct A {\n  lib.Record r\n}", "lib", "entity.name.namespace.yaffle"],
  ["struct A {\n  lib.Record r\n}", "Record", "entity.name.type.yaffle"],
  ["struct A {\n  u16 type\n}", "type", "variable.other.member.yaffle"],
  ["struct A {\n  u8 bits\n}", "bits", "variable.other.member.yaffle"],
  ["struct A { u64 n  u64 ofs  T items[n] at ofs }", "ofs", "variable.other.member.yaffle"],
  ["struct A { u64 n  u64 ofs  T items[n] at ofs }", "items", "variable.other.member.yaffle"],
  ["struct A { u32 tag = 'ARCV'  u64 big = 1 }", "big", "variable.other.member.yaffle"],
  ["struct A {\n  u16 sizeHigh : 12\n}", "sizeHigh", "variable.other.member.yaffle"],
  ["struct A {\n  u8 x; u8 y\n}", ";", "punctuation.terminator.statement.yaffle"],
  ["struct A {\n  u8 x; u8 y\n}", "y", "variable.other.member.yaffle"]
]);

cases("arrays", [
  ["struct A {\n  u16 list[until 0xffff]\n}", "until", "keyword.control.until.yaffle"],
  ['struct A {\n  str pool[until ""]\n}', "until", "keyword.control.until.yaffle"],
  ["struct A {\n  u16 ids[pairs * 2]\n}", "*", "keyword.operator.arithmetic.yaffle"],
  ["struct A {\n  u8 flags[(n + 7) / 8]\n}", "+", "keyword.operator.arithmetic.yaffle"],
  ["struct A {\n  u8 rest[]\n}", "[", "punctuation.definition.brackets.begin.yaffle"],
  ["struct A {\n  u8 raw[a..b]\n}", "..", "keyword.operator.range.yaffle"]
]);

cases("attributes", [
  ["struct A {\n  u32 a @padBefore(4)\n}", "@", "punctuation.definition.decorator.yaffle"],
  ["struct A {\n  u32 a @padBefore(4)\n}", "padBefore", "entity.name.function.decorator.yaffle"],
  ["struct A {\n  u32 a @padBefore(4)\n}", "4", "constant.numeric.decimal.yaffle"],
  [
    "struct A {\n  u8 t[] @align(0x10, i => i & 0xff) @strict\n}",
    "=>",
    "storage.type.function.arrow.yaffle"
  ],
  [
    "struct A {\n  u8 t[] @align(0x10, i => i & 0xff) @strict\n}",
    "&",
    "keyword.operator.bitwise.yaffle"
  ],
  [
    "struct A {\n  u8 t[] @align(0x10, i => i & 0xff) @strict\n}",
    "strict",
    "entity.name.function.decorator.yaffle"
  ],
  [
    "struct A {\n  u64 offset   @align(8)\n               @padAfter(8)\n}",
    "padAfter",
    "entity.name.function.decorator.yaffle"
  ],
  [
    'struct A {\n  @endian(order == "MM" ? be : le) {\n    u16 magic\n  }\n}',
    "be",
    "constant.language.endian.yaffle"
  ],
  [
    'struct A {\n  @endian(order == "MM" ? be : le) {\n    u16 magic\n  }\n}',
    "le",
    "constant.language.endian.yaffle"
  ],
  [
    'struct A {\n  @endian(order == "MM" ? be : le) {\n    u16 magic\n  }\n}',
    "?",
    "keyword.operator.ternary.yaffle"
  ],
  [
    'struct A {\n  @endian(order == "MM" ? be : le) {\n    u16 magic\n  }\n}',
    "magic",
    "variable.other.member.yaffle"
  ],
  [
    "struct A {\n  F f @via(chacha20(KEY_A, nonce)) @size(size)\n}",
    "chacha20",
    "entity.name.function.yaffle"
  ],
  [
    "struct A {\n  F f @via(chacha20(KEY_A, nonce)) @size(size)\n}",
    "KEY_A",
    "variable.other.constant.yaffle"
  ],
  [
    "struct A {\n  F f @via(chacha20(KEY_A, nonce)) @size(size)\n}",
    "size",
    "entity.name.function.decorator.yaffle"
  ],
  [
    "struct A {\n  Extra *extra : u64 @nullable(0xffffffff)\n}",
    "nullable",
    "entity.name.function.decorator.yaffle"
  ]
]);

cases("bound values and built-ins", [
  ["struct A {\n  u8 r[$end - $offset]\n}", "end", "variable.language.bound.yaffle"],
  ["struct A {\n  u8 r[$end - $offset]\n}", "offset", "variable.language.bound.yaffle"],
  ["struct A {\n  if ($index > 0) { u8 x }\n}", "index", "variable.language.bound.yaffle"],
  ["struct A {\n  u8 x @endian($endian)\n}", "endian", "variable.language.bound.yaffle", 1],
  ["struct A {\n  if ($version >= 144) { u32 extra }\n}", "version", "variable.other.bound.yaffle"],
  ["struct A {\n  u32 size where it % 4 == 0\n}", "it", "variable.language.it.yaffle"],
  ["struct A {\n  u32 s = sizeof(body)\n}", "sizeof", "support.function.builtin.yaffle"],
  ["struct A {\n  u32 s = offsetof(t) - base\n}", "offsetof", "support.function.builtin.yaffle"],
  ["struct A {\n  u32 s = crc32(body)\n}", "crc32", "support.function.builtin.yaffle"],
  ["struct A {\n  u8 b = bytesof(x)\n}", "bytesof", "support.function.builtin.yaffle"],
  ["struct A {\n  u8 e = encode(x)\n}", "encode", "support.function.builtin.yaffle"],
  [
    "struct A {\n  F f[] at max($index * 0x10000, 0x20)\n}",
    "max",
    "support.function.builtin.yaffle"
  ],
  ["struct A {\n  u32 h = pathHash(path)\n}", "pathHash", "entity.name.function.yaffle"],
  ["struct A {\n  bool b = true\n}", "true", "constant.language.boolean.yaffle"],
  ["layout {\n  x.points, this\n}", "this", "variable.language.this.yaffle"]
]);

cases("clauses", [
  ["struct A {\n  u32 n = flags.length * 8\n}", "=", "keyword.operator.assignment.yaffle"],
  ["struct A {\n  u32 n = flags.length * 8\n}", "length", "variable.other.property.yaffle"],
  ["struct A {\n  u32 n = flags.length * 8\n}", "flags", "meta.clause.formula.yaffle"],
  ["struct A {\n  u32 n = rows * cols\n}", "cols", "variable.other.readwrite.yaffle"],
  ["struct A {\n  u16 angle as it * 360.0 / 65536\n}", "as", "keyword.other.as.yaffle"],
  ["struct A {\n  u16 angle as it * 360.0 / 65536\n}", "360.0", "constant.numeric.float.yaffle"],
  ["struct A {\n  u8 name as names[it]\n}", "names", "variable.other.readwrite.yaffle"],
  [
    "struct A {\n  u32 tag as decodeTag(it) = encodeTag(it)\n}",
    "encodeTag",
    "entity.name.function.yaffle"
  ],
  ["struct A {\n  u32 size where it % 4 == 0\n}", "where", "keyword.other.where.yaffle"],
  ["struct A {\n  u32 size where it % 4 == 0\n}", "==", "keyword.operator.comparison.yaffle"],
  ["struct A {\n  u32 version in (1, 2, 5..9)\n}", "in", "keyword.other.in.yaffle"],
  ["struct A {\n  u32 version in (1, 2, 5..9)\n}", "..", "keyword.operator.range.yaffle"],
  ['struct A {\n  char order[2] in ("II", "MM")\n}', "II", "string.quoted.double.yaffle"],
  ["struct A {\n  Record t[n] at tableOfs\n}", "at", "keyword.other.at.yaffle"],
  ["struct A {\n  Record t[n] at tableOfs\n}", "tableOfs", "variable.other.readwrite.yaffle"],
  ["struct A {\n  u8 data[size] at sector * 0x800\n}", "0x800", "constant.numeric.hex.yaffle"],
  [
    "struct A {\n  Archive file from frags[*].data @split(fit)\n}",
    "from",
    "keyword.other.from.yaffle"
  ],
  [
    "struct A {\n  Archive file from frags[*].data @split(fit)\n}",
    "*",
    "keyword.operator.wildcard.yaffle"
  ],
  [
    "struct A {\n  Archive file from frags[*].data @split(fit)\n}",
    "data",
    "variable.other.property.yaffle"
  ],
  [
    "struct A {\n  Archive file from frags[*].data @split(fit)\n}",
    "split",
    "entity.name.function.decorator.yaffle"
  ],
  ["struct A {\n  u32 flags = it | 0x80\n}", "|", "keyword.operator.bitwise.yaffle"],
  ["struct A {\n  u32 x = a != b && !c || d >= e\n}", "&&", "keyword.operator.logical.yaffle"],
  ["struct A {\n  u32 x = a != b && !c || d >= e\n}", "!=", "keyword.operator.comparison.yaffle"],
  ["struct A {\n  u32 x = a >> 2 ^ ~b\n}", ">>", "keyword.operator.bitwise.shift.yaffle"],
  ["struct A {\n  u32 x = a >> 2 ^ ~b\n}", "~", "keyword.operator.bitwise.yaffle"],
  ["struct A {\n  u32 k = MemKind.Sys\n}", "Sys", "variable.other.property.yaffle"]
]);

cases("regex literals after `in`", [
  ["struct A {\n  str ver in /v\\d\\.\\d{1,2}/\n}", "in", "keyword.other.in.yaffle"],
  ["struct A {\n  str ver in /v\\d\\.\\d{1,2}/\n}", "v", "string.regexp.yaffle"],
  [
    "struct A {\n  str ver in /v\\d\\.\\d{1,2}/\n}",
    "\\d",
    "constant.character.character-class.regexp"
  ],
  [
    "struct A {\n  str ver in /v\\d\\.\\d{1,2}/\n}",
    "\\.",
    "constant.character.escape.backslash.regexp"
  ],
  ["struct A {\n  str ver in /v\\d\\.\\d{1,2}/\n}", "{1,2}", "keyword.operator.quantifier.regexp"],
  [
    "struct A {\n  str ver in /v\\d\\.\\d{1,2}/\n}",
    "/",
    "punctuation.definition.string.begin.yaffle"
  ],
  ["struct A {\n  str s in /^[a-z]+(?:_x|y)*$/i\n}", "^", "keyword.control.anchor.regexp"],
  [
    "struct A {\n  str s in /^[a-z]+(?:_x|y)*$/i\n}",
    "a-z",
    "constant.other.character-class.set.regexp"
  ],
  ["struct A {\n  str s in /^[a-z]+(?:_x|y)*$/i\n}", "|", "keyword.operator.or.regexp"],
  ["struct A {\n  str s in /^[a-z]+(?:_x|y)*$/i\n}", "i", "keyword.other.flag.regexp"],
  ["struct A {\n  u32 n = a / b / c\n}", "/", "keyword.operator.arithmetic.yaffle"]
]);

cases("control flow", [
  [
    "struct A {\n  if (version >= 3) { u32 extra } else { u16 legacy }\n}",
    "if",
    "keyword.control.if.yaffle"
  ],
  [
    "struct A {\n  if (version >= 3) { u32 extra } else { u16 legacy }\n}",
    "else",
    "keyword.control.else.yaffle"
  ],
  [
    "struct A {\n  if (version >= 3) { u32 extra } else { u16 legacy }\n}",
    "version",
    "variable.other.readwrite.yaffle"
  ],
  [
    "struct A {\n  if (version >= 3) { u32 extra } else { u16 legacy }\n}",
    "legacy",
    "variable.other.member.yaffle"
  ],
  [
    'switch (tag) {\n  case "ARCV": Archive body\n  default: u8 body[size]\n}',
    "switch",
    "keyword.control.switch.yaffle"
  ],
  [
    'switch (tag) {\n  case "ARCV": Archive body\n  default: u8 body[size]\n}',
    "case",
    "keyword.control.case.yaffle"
  ],
  [
    'switch (tag) {\n  case "ARCV": Archive body\n  default: u8 body[size]\n}',
    "ARCV",
    "string.quoted.double.yaffle"
  ],
  [
    'switch (tag) {\n  case "ARCV": Archive body\n  default: u8 body[size]\n}',
    "Archive",
    "entity.name.type.yaffle"
  ],
  [
    'switch (tag) {\n  case "ARCV": Archive body\n  default: u8 body[size]\n}',
    "default",
    "keyword.control.default.yaffle"
  ],
  ["switch (tag) {\n  case 1, 2: u8 small\n}", "small", "variable.other.member.yaffle"]
]);

cases("layout", [
  ["layout {\n  records[*].model @align(0x80)\n}", "layout", "keyword.other.layout.yaffle"],
  ["layout {\n  records[*].model @align(0x80)\n}", "records", "variable.other.property.yaffle"],
  ["layout {\n  records[*].model @align(0x80)\n}", "*", "keyword.operator.wildcard.yaffle"],
  ["layout {\n  records[*].model @align(0x80)\n}", "model", "variable.other.property.yaffle"],
  [
    "layout {\n  records[*].model @align(0x80)\n}",
    "align",
    "entity.name.function.decorator.yaffle"
  ],
  ["struct R { u8 x  layout { curves, motions } }", "motions", "variable.other.property.yaffle"]
]);

cases("literals", [
  ["u32 x = 0x5643_5241", "0x5643_5241", "constant.numeric.hex.yaffle"],
  ["u32 x = 0XFF", "0XFF", "constant.numeric.hex.yaffle"],
  ["u32 x = 0b1010", "0b1010", "constant.numeric.binary.yaffle"],
  ["u32 x = 0b1010_0101", "0b1010_0101", "constant.numeric.binary.yaffle"],
  ["u32 x = 1_000", "1_000", "constant.numeric.decimal.yaffle"],
  ["f32 x = 1.5", "1.5", "constant.numeric.float.yaffle"],
  ["f32 x = 2.5e-3", "2.5e-3", "constant.numeric.float.yaffle"],
  ["f64 x = 1e9", "1e9", "constant.numeric.float.yaffle"],
  ['u8 a[4] = x"5f2a 91c3"', "x", "storage.type.string.yaffle"],
  ['u8 a[4] = x"5f2a 91c3"', "5f2a 91c3", "string.quoted.double.hex.yaffle"],
  ['u8 a[4] = x"5f2z"', "z", "invalid.illegal.hex.yaffle"],
  ['u8 a[3] = b64"AAEC+/=="', "b64", "storage.type.string.yaffle"],
  ['u8 a[3] = b64"AAEC+/=="', "AAEC+/==", "string.quoted.double.base64.yaffle"],
  ['u8 a[3] = b64"AA!C"', "!", "invalid.illegal.base64.yaffle"],
  ["u32 tag = 'ARCV'", "ARCV", "string.quoted.single.fourcc.yaffle"],
  ["u32 tag = 'ARCV'", "'", "punctuation.definition.string.begin.yaffle"],
  ['char t[4] = "ARCV"', "ARCV", "string.quoted.double.yaffle"],
  ['char t[8] = "a\\n\\x41\\u{1F426}"', "\\n", "constant.character.escape.yaffle"],
  ['char t[8] = "a\\n\\x41\\u{1F426}"', "\\x41", "constant.character.escape.yaffle"],
  ['char t[8] = "a\\n\\x41\\u{1F426}"', "\\u{1F426}", "constant.character.escape.yaffle"],
  ['char t[8] = "bad\\q"', "\\q", "invalid.illegal.escape.yaffle"],
  ['char t[8] = "unterminated\nu8 next', "next", "variable.other.member.yaffle"],
  ["u8 v = prefix", "prefix", "variable.other.readwrite.yaffle"]
]);

describe("robustness", () => {
  it("doesn't mistake identifiers ending in x or b64 for byte literals", async () => {
    expect(await scopesOf('struct A {\n  u8 hex = idx"..."\n}', "idx")).not.toContain(
      "storage.type.string.yaffle"
    );
  });

  it("doesn't treat digits inside identifiers as numbers", async () => {
    const scopes = await scopesOf("struct A {\n  FragHeader hdr\n}", "FragHeader");
    expect(scopes).toContain("entity.name.type.yaffle");
  });

  it("recovers after an unterminated block comment ends", async () => {
    const scopes = await scopesOf("/* open\nstill comment */ struct B {}", "B");
    expect(scopes).toContain("entity.name.type.struct.yaffle");
  });

  it("keeps CRLF sources working", async () => {
    const scopes = await scopesOf("struct A {\r\n  u8 x\r\n}\r\n", "x");
    expect(scopes).toContain("variable.other.member.yaffle");
  });
});

// ── layout groups, virtual fields, derived arrays ─────────────────────────────────

describe("advanced fixture", () => {
  it("tokenizes without illegal tokens, leaked scopes or bare identifiers", async () => {
    const source = fs.readFileSync(path.join(here, "fixtures/advanced.yfl"), "utf8");
    const tokens = await tokenize(source);
    expect(tokens.filter(t => t.scopes.some(s => s.startsWith("invalid.")))).toEqual([]);
    source.split("\n").forEach((line, i) => {
      if (/^(struct|export)\b/.test(line)) {
        const first = tokens.find(t => t.line === i)!;
        expect(first.scopes.length, `line ${i + 1}: ${line}`).toBeLessThanOrEqual(3);
      }
    });
    const bare = tokens.filter(t => /^[A-Za-z_$]\w*$/.test(t.text.trim()) && t.scopes.length === 1);
    expect(bare, dump(bare)).toEqual([]);
  });
});

cases("virtual fields and defaults", [
  ["struct S { virtual u40 size = (hi << 32) | lo }", "virtual", "storage.modifier.virtual.yaffle"],
  ["struct S { virtual u40 size = (hi << 32) | lo }", "u40", "support.type.primitive.yaffle"],
  ["struct S { virtual u40 size = (hi << 32) | lo }", "size", "variable.other.member.yaffle"],
  [
    "struct S { virtual u16 v = (a << 8) | b ?= 3 }",
    "?=",
    "keyword.operator.assignment.default.yaffle"
  ],
  ["struct S { u32 align ?= 0x100 }", "?=", "keyword.operator.assignment.default.yaffle"],
  ["struct S { u32 align ?= 0x100 }", "align", "variable.other.member.yaffle"],
  // a field named `virtual` stays a field
  ["struct S { u8 virtual }", "virtual", "variable.other.member.yaffle"]
]);

cases("lambdas, null and derived-array builtins", [
  [
    "struct S { u8 i[s] = indicesWhere(rs, r => r.model != null) }",
    "indicesWhere",
    "support.function.builtin.yaffle"
  ],
  [
    "struct S { u8 i[s] = indicesWhere(rs, r => r.model != null) }",
    "r",
    "variable.parameter.lambda.yaffle"
  ],
  [
    "struct S { u8 i[s] = indicesWhere(rs, r => r.model != null) }",
    "=>",
    "storage.type.function.arrow.yaffle"
  ],
  [
    "struct S { u8 i[s] = indicesWhere(rs, r => r.model != null) }",
    "null",
    "constant.language.null.yaffle"
  ],
  [
    "struct S { Key keys[n] where it == sortedBy(it, k => k.name) }",
    "sortedBy",
    "support.function.builtin.yaffle"
  ],
  [
    "struct S { Key keys[n] where it == sortedBy(it, k => k.name) }",
    "k",
    "variable.parameter.lambda.yaffle"
  ],
  ...["map", "filter", "unique", "concat", "sum", "round"].map((f): Case => [
    `struct S { u8 x[n] = ${f}(a) }`,
    f,
    "support.function.builtin.yaffle"
  ])
]);

cases("attribute arguments", [
  ["struct S { u8 a @padUntil(0x80, strict) }", "strict", "keyword.other.strict.yaffle"],
  ["struct S { u8 a @align(4, 0xff, strict) }", "strict", "keyword.other.strict.yaffle"],
  ["struct S { u8 a @align(0x100, from: file) }", "from", "variable.parameter.named.yaffle"],
  ["struct S { u8 a @align(0x100, from: file) }", "file", "constant.language.origin.yaffle"],
  ["struct S { u8 a @alignEnd(8, from: base) }", "base", "constant.language.origin.yaffle"],
  ["struct S { u8 a @align(4, offset: 0x19) }", "offset", "variable.parameter.named.yaffle"],
  ["struct S { u8 a @align(4, offset: 0x19) }", "0x19", "constant.numeric.hex.yaffle"],
  // `strict` as a field read in an expression stays a variable
  ["struct S { u8 strict  u8 a[strict] }", "strict", "variable.other.readwrite.yaffle", 1]
]);

cases("layout groups", [
  [
    "struct S {\n  layout {\n    vols[*] { pieces[*]  portals[*].points }\n  }\n}",
    "pieces",
    "meta.layout.group.yaffle"
  ],
  [
    "struct S {\n  layout {\n    vols[*] { pieces[*]  portals[*].points }\n  }\n}",
    "points",
    "variable.other.property.yaffle"
  ],
  [
    "struct S {\n  layout {\n    vols[*] { pieces }\n    tail\n  }\n}",
    "tail",
    "meta.layout.yaffle"
  ],
  [
    "struct S {\n  layout {\n    vols[*] @align(16) {\n      pieces\n    }\n    tail\n  }\n  u8 after\n}",
    "tail",
    "variable.other.property.yaffle"
  ],
  [
    "struct S {\n  layout {\n    vols[*] @align(16) {\n      pieces\n    }\n  }\n  u8 after\n}",
    "after",
    "variable.other.member.yaffle"
  ],
  ["struct S {\n  layout { a[*] { this  b } }\n}", "this", "variable.language.this.yaffle"]
]);
