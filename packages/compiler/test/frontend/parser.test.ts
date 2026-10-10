import { describe, expect, it } from "vitest";
import type * as A from "../../src/frontend/ast.ts";
import { printExpr } from "../../src/frontend/printer.ts";
import { parseSource } from "../helpers.ts";

function only<T extends A.Decl["kind"]>(text: string, kind: T): Extract<A.Decl, { kind: T }> {
  const r = parseSource(text);
  expect(r.diagnostics).toEqual([]);
  const d = r.module.decls.find(x => x.kind === kind);
  expect(d).toBeDefined();
  return d as Extract<A.Decl, { kind: T }>;
}

function members(text: string): A.Member[] {
  return only(`struct S {\n${text}\n}`, "StructDecl").members;
}

function fields(text: string): A.FieldDecl[] {
  return members(text).filter((m): m is A.FieldDecl => m.kind === "FieldDecl");
}

function expr(text: string): string {
  const f = fields(`u32 x = ${text}`)[0]!;
  return printExpr(f.clauses.formula!);
}

/** Fully parenthesized form, to check precedence. */
function paren(e: A.Expr): string {
  switch (e.kind) {
    case "Binary":
      return `(${paren(e.left)} ${e.op} ${paren(e.right)})`;
    case "Unary":
      return `(${e.op}${paren(e.operand)})`;
    case "Cond":
      return `(${paren(e.test)} ? ${paren(e.then)} : ${paren(e.else)})`;
    case "Paren":
      return paren(e.expr);
    default:
      return printExpr(e);
  }
}

function prec(text: string): string {
  return paren(fields(`u32 x = ${text}`)[0]!.clauses.formula!);
}

describe("parser: declarations", () => {
  it("parses a struct with fields", () => {
    const s = only("struct Entry {\n  u16 handler\n  u32be crc\n}", "StructDecl");
    expect(s.name.name).toBe("Entry");
    expect(s.members.map(m => (m as A.FieldDecl).name?.name)).toEqual(["handler", "crc"]);
  });

  it("parses several fields on one line without separators", () => {
    const s = only("struct Span<T> { u64 n  u64 ofs  T items[n] at ofs }", "StructDecl");
    expect(s.typeParams.map(t => t.name)).toEqual(["T"]);
    expect(s.members.map(m => (m as A.FieldDecl).name?.name)).toEqual(["n", "ofs", "items"]);
  });

  it("parses Ghidra-style C structs with semicolons", () => {
    const s = only("struct Foo {\n    u32 a;\n    u16 b[4];\n    struct Bar c;\n};", "StructDecl");
    expect(s.members).toHaveLength(3);
    expect((s.members[2] as A.FieldDecl).type.name[0]!.name).toBe("Bar");
  });

  it("parses multiple declarators sharing a type", () => {
    const fs = fields("u8 r, g, b");
    expect(fs.map(f => f.name?.name)).toEqual(["r", "g", "b"]);
    expect(fields("u8 a, u16 b").map(f => f.name?.name)).toEqual(["a", "b"]);
  });

  it("parses struct parameters, bound parameters and defaults", () => {
    const s = only("struct Blob(u32 n, u8 $key[32], u16 m = 4) { u8 data[n] }", "StructDecl");
    expect(s.params!.map(p => [p.name.name, p.bound, p.arrays.length, !!p.default])).toEqual([
      ["n", false, 0, false],
      ["key", true, 1, false],
      ["m", false, 0, true]
    ]);
  });

  it("parses struct attributes between the name and the body", () => {
    const s = only("struct Header @padUntil(0x80) @base {\n  u32 a\n}", "StructDecl");
    expect(s.attrs.map(a => a.name.name)).toEqual(["padUntil", "base"]);
  });

  it("parses exported declarations and doc comments", () => {
    const r = parseSource(
      "/** The header. */\nexport struct H { u32 a }\n/// A constant\nexport const u32 SECTOR = 0x800"
    );
    expect(r.diagnostics).toEqual([]);
    const [h, c] = r.module.decls as [A.StructDecl, A.ConstDecl];
    expect(h.exported).toBe(true);
    expect(h.doc).toBe("The header.");
    expect(c.exported).toBe(true);
    expect(c.doc).toBe("A constant");
  });

  it("parses enums with storage, values and @open", () => {
    const e = only("enum MemKind : u16 @open { Sys = 0, Gpu = 1\n Other }", "EnumDecl");
    expect(e.storage?.name[0]!.name).toBe("u16");
    expect(e.attrs[0]!.name.name).toBe("open");
    expect(e.members.map(m => m.name.name)).toEqual(["Sys", "Gpu", "Other"]);
  });

  it("parses unions", () => {
    const u = only("union Node { Archive  Dict }", "UnionDecl");
    expect(u.variants.map(v => v.name[0]!.name)).toEqual(["Archive", "Dict"]);
  });

  it("parses type aliases", () => {
    const a = only("type Fixed(u8 bits) = i32 as it / (1 << bits)", "TypeAliasDecl");
    expect(a.params![0]!.name.name).toBe("bits");
    expect(printExpr(a.body!.clauses.asRead!)).toBe("it / (1 << bits)");
    const n = only("type Name = char[0x20]", "TypeAliasDecl");
    expect(n.body!.arrays[0]!.mode).toBe("count");
    const e = only("type EncRec = Record @via(xor(0x5a))", "TypeAliasDecl");
    expect(e.body!.attrs[0]!.name.name).toBe("via");
  });

  it("parses externs", () => {
    const r = parseSource(
      "extern fn pathHash(char path[]) -> u32\nextern codec zstd\nextern codec inflate @streaming\nextern async codec oodle\nextern codec chacha20(u8 key[32], u64 nonce) @ranged\nextern type VarInt(u8 maxBytes) : u64\nextern type Half : f32 @size(2)"
    );
    expect(r.diagnostics).toEqual([]);
    const ds = r.module.decls;
    expect(ds.map(d => d.kind)).toEqual([
      "ExternFnDecl",
      "ExternCodecDecl",
      "ExternCodecDecl",
      "ExternCodecDecl",
      "ExternCodecDecl",
      "ExternTypeDecl",
      "ExternTypeDecl"
    ]);
    expect((ds[3] as A.ExternCodecDecl).async).toBe(true);
    expect((ds[4] as A.ExternCodecDecl).params).toHaveLength(2);
    expect((ds[4] as A.ExternCodecDecl).attrs[0]!.name.name).toBe("ranged");
    expect((ds[6] as A.ExternTypeDecl).attrs[0]!.name.name).toBe("size");
  });

  it("parses imports", () => {
    const r = parseSource(
      'import { Span, Name as N, SECTOR } from "./common.yfl"\nimport * as lib from "./lib.yfl"'
    );
    expect(r.diagnostics).toEqual([]);
    const [a, b] = r.module.decls as [A.ImportDecl, A.ImportDecl];
    expect(a.names!.map(n => [n.name.name, n.alias?.name])).toEqual([
      ["Span", undefined],
      ["Name", "N"],
      ["SECTOR", undefined]
    ]);
    expect(a.source!.value).toBe("./common.yfl");
    expect(b.namespace!.name).toBe("lib");
  });

  it("parses constants with and without types", () => {
    const r = parseSource(
      'const u32 SECTOR = 0x800\nconst u8 KEY[4] = x"00010203"\nconst NAME = "x"'
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.module.decls.map(d => (d as A.ConstDecl).name.name)).toEqual([
      "SECTOR",
      "KEY",
      "NAME"
    ]);
  });
});

describe("parser: field declarators and clauses", () => {
  it("parses pointers with storage", () => {
    const [f] = fields("Record *recs[count] : u64 @ref");
    expect(f!.pointer).toBe(true);
    expect(f!.arrays[0]!.mode).toBe("count");
    expect(f!.storage!.name[0]!.name).toBe("u64");
    expect(f!.attrs[0]!.name.name).toBe("ref");
  });

  it("parses array modes", () => {
    const fs = fields("u8 a[4]\nu8 b[]\nu16 c[until 0xffff]\nchar d[4][8]");
    expect(fs.map(f => f.arrays.map(a => a.mode).join(","))).toEqual([
      "count",
      "rest",
      "until",
      "count,count"
    ]);
  });

  it("parses bound fields", () => {
    const [f] = fields("u32 $version");
    expect(f!.bound).toBe(true);
    expect(f!.name!.name).toBe("version");
  });

  it("parses every clause", () => {
    const [a, b, c, d, e, g, h] = fields(
      [
        "Record table[count] at tableOfs",
        "Archive file from frags[*].data @split(fit)",
        "u32 size = sizeof(body)",
        "u32 tag as decodeTag(it) = encodeTag(it)",
        'char order[2] in ("II", "MM")',
        "str ver in /v\\d/",
        "u32 size2 where it % 4 == 0"
      ].join("\n")
    );
    expect(printExpr(a!.clauses.at!)).toBe("tableOfs");
    expect(printExpr(b!.clauses.from!)).toBe("frags[*].data");
    expect(printExpr(c!.clauses.formula!)).toBe("sizeof(body)");
    expect(printExpr(d!.clauses.asRead!)).toBe("decodeTag(it)");
    expect(printExpr(d!.clauses.asWrite!)).toBe("encodeTag(it)");
    expect(e!.clauses.inItems).toHaveLength(2);
    expect(g!.clauses.regex!.pattern).toBe("v\\d");
    expect(printExpr(h!.clauses.where!)).toBe("it % 4 == 0");
  });

  it("parses in-ranges", () => {
    const [f] = fields("u32 version in (1, 2, 5..9)");
    expect(f!.clauses.inItems!.map(i => i.kind)).toEqual(["InValue", "InValue", "InRange"]);
  });

  it("parses slices in streams", () => {
    const [f] = fields("Body b from raw[0x10..0x800]");
    expect(printExpr(f!.clauses.from!)).toBe("raw[0x10..0x800]");
  });

  it("parses C bitfields and unnamed reserved bits", () => {
    const fs = fields("u16 sizeHigh : 12\nu16 level : 4\nu8 : 3");
    expect(fs.map(f => [f.name?.name, printExpr(f.bitWidth!)])).toEqual([
      ["sizeHigh", "12"],
      ["level", "4"],
      [undefined, "3"]
    ]);
  });

  it("parses struct types with positional and named arguments", () => {
    const [a, b] = fields("Blob(16) a\nBlob(n: 32) b");
    expect(a!.type.args![0]!.name).toBeUndefined();
    expect(b!.type.args![0]!.name!.name).toBe("n");
  });

  it("parses generic types, including nested >>", () => {
    const [a] = fields("Span<Span<Point>> s");
    expect(a!.type.typeArgs![0]!.type.typeArgs![0]!.type.name[0]!.name).toBe("Point");
  });

  it("parses qualified type names", () => {
    const [a] = fields("lib.Record r");
    expect(a!.type.name.map(n => n.name)).toEqual(["lib", "Record"]);
  });

  it("allows keywords as field names", () => {
    expect(fields("u8 type\nu32 from\nu16 at").map(f => f.name?.name)).toEqual([
      "type",
      "from",
      "at"
    ]);
  });
});

describe("parser: attributes and continuation lines", () => {
  it("collects postfix attributes, leftmost first", () => {
    const [f] = fields("Chunk body @size(expSize) @via(oodle) @size(compSize)");
    expect(f!.attrs.map(a => a.name.name)).toEqual(["size", "via", "size"]);
  });

  it("continues the previous field on a line starting with @", () => {
    const fs = fields("u64 offset   @align(8)\n             @padAfter(8)\nu32 next");
    expect(fs.map(f => f.name?.name)).toEqual(["offset", "next"]);
    expect(fs[0]!.attrs.map(a => a.name.name)).toEqual(["align", "padAfter"]);
  });

  it("treats an @ line containing { as block attributes", () => {
    const ms = members(
      'char order[2] in ("II", "MM")\n@endian(order == "MM" ? be : le) {\n  u16 magic = 42\n}'
    );
    expect(ms.map(m => m.kind)).toEqual(["FieldDecl", "BlockMember"]);
    const b = ms[1] as A.BlockMember;
    expect(b.attrs[0]!.name.name).toBe("endian");
    expect(b.members).toHaveLength(1);
  });

  it("parses single-line blocks with prefix attributes", () => {
    const ms = members("u32 a\n@strict { u8 x }");
    expect(ms.map(m => m.kind)).toEqual(["FieldDecl", "BlockMember"]);
  });

  it("continues a field on a line starting with a clause keyword", () => {
    const fs = fields("Record table[count]\n    at tableOfs\nu32 crc\n    = crc32(body)");
    expect(fs).toHaveLength(2);
    expect(printExpr(fs[0]!.clauses.at!)).toBe("tableOfs");
    expect(printExpr(fs[1]!.clauses.formula!)).toBe("crc32(body)");
  });

  it("parses lambdas in attribute arguments", () => {
    const [f] = fields("u8 tail[] @align(0x10, i => i & 0xff)");
    const arg = f!.attrs[0]!.args![1]!.value;
    expect(arg.kind).toBe("Lambda");
    expect(printExpr(arg)).toBe("i => i & 0xff");
  });
});

describe("parser: members", () => {
  it("parses if/else and else-if chains", () => {
    const ms = members(
      "if (version >= 3) { u32 extra } else if (version == 2) { u16 mid } else { u16 legacy }"
    );
    const i = ms[0] as A.IfMember;
    expect(printExpr(i.condition!)).toBe("version >= 3");
    expect(i.elseIf).toBe(true);
    const inner = i.else![0] as A.IfMember;
    expect(inner.else).toHaveLength(1);
  });

  it("parses switch with cases and default", () => {
    const ms = members(
      'switch (tag) {\n case "ARCV": Archive body\n case "CHNK", "CNK2": Chunk body\n default: u8 body[size]\n}'
    );
    const s = ms[0] as A.SwitchMember;
    expect(s.cases.map(c => [c.values.length, c.isDefault, c.members.length])).toEqual([
      [1, false, 1],
      [2, false, 1],
      [0, true, 1]
    ]);
  });

  it("parses bits blocks", () => {
    const ms = members(
      "bits u8 @bitorder(msb) {\n bool compressed : 1\n MemKind kind : 3\n u8 : 4\n}"
    );
    const b = ms[0] as A.BitsMember;
    expect(b.storage!.name[0]!.name).toBe("u8");
    expect(b.attrs[0]!.name.name).toBe("bitorder");
    expect(b.fields.map(f => f.name?.name)).toEqual(["compressed", "kind", undefined]);
  });

  it("parses layout blocks", () => {
    const ms = members("layout {\n records[*].model @align(0x80)\n records\n this\n}");
    const l = ms[0] as A.LayoutMember;
    expect(
      l.items.map(i =>
        i.path === "this"
          ? "this"
          : i.path.map(s => (s.kind === "each" ? "[*]" : s.name.name)).join(".")
      )
    ).toEqual(["records.[*].model", "records", "this"]);
    expect(l.items[0]!.attrs[0]!.name.name).toBe("align");
  });

  it("parses comma-separated layout items", () => {
    const ms = members("layout { x.points, y.points, x, y, this }");
    expect((ms[0] as A.LayoutMember).items).toHaveLength(5);
  });

  it("parses nested structs", () => {
    const ms = members("u32 r\nstruct Inner { u8 data[r] }\nInner inner");
    expect(ms.map(m => m.kind)).toEqual(["FieldDecl", "StructDecl", "FieldDecl"]);
  });

  it("parses blocks", () => {
    const ms = members("@padUntil(0x80) {\n  u32 a\n}");
    expect(ms[0]!.kind).toBe("BlockMember");
  });
});

describe("parser: expressions", () => {
  it("respects precedence", () => {
    expect(prec("a + b * c")).toBe("(a + (b * c))");
    expect(prec("a & 0x80 == 0")).toBe("((a & 0x80) == 0)");
    expect(prec("a << 2 + 1")).toBe("(a << (2 + 1))");
    expect(prec("a || b && c")).toBe("(a || (b && c))");
    expect(prec("-a * b")).toBe("((-a) * b)");
    expect(prec("a ? b : c ? d : e")).toBe("(a ? b : (c ? d : e))");
    expect(prec("a - b - c")).toBe("((a - b) - c)");
  });

  it("parses postfix chains", () => {
    expect(expr("names[it].x.length")).toBe("names[it].x.length");
    expect(expr("frags[*].data")).toBe("frags[*].data");
    expect(expr("f(a, b)")).toBe("f(a, b)");
  });

  it("parses literals", () => {
    expect(expr('"s"')).toBe('"s"');
    expect(expr("'ARCV'")).toBe("'ARCV'");
    expect(expr('x"0102"')).toBe('x"0102"');
    expect(expr("true")).toBe("true");
    expect(expr("be")).toBe("be");
    expect(expr("$offset")).toBe("$offset");
    expect(expr("1.5")).toBe("1.5");
  });

  it("parses `in` inside parentheses and conditions", () => {
    const ms = members('if (tag in ("A", "B")) { u8 x }');
    expect(((ms[0] as A.IfMember).condition as A.InExpr).kind).toBe("In");
  });

  it("continues an expression across lines after an operator", () => {
    const [f] = fields("u32 x = a +\n  b\nu32 y");
    expect(printExpr(f!.clauses.formula!)).toBe("a + b");
  });

  it("ignores newlines inside parentheses", () => {
    const [f] = fields("u32 x = max(a,\n  b)");
    expect(printExpr(f!.clauses.formula!)).toBe("max(a, b)");
  });
});

describe("parser: error recovery", () => {
  it("recovers from a missing field name", () => {
    const r = parseSource("struct S {\n  u32\n  u32 b\n}");
    expect(r.diagnostics).toEqual([
      "2:6 syntax-error: Expected a field name after the type but found 'u32'."
    ]);
    const s = r.module.decls[0] as A.StructDecl;
    expect(s.members.map(m => (m as A.FieldDecl).name?.name)).toEqual([undefined, "b"]);
  });

  it("recovers from a missing expression after =", () => {
    const r = parseSource("struct S {\n  u32 a =\n  u32 b\n}");
    expect(r.diagnostics).toEqual(["2:10 syntax-error: Expected an expression."]);
    const s = r.module.decls[0] as A.StructDecl;
    expect(s.members).toHaveLength(2);
    expect((s.members[0] as A.FieldDecl).clauses.formula!.kind).toBe("Error");
  });

  it("recovers from garbage inside a struct", () => {
    const r = parseSource("struct S {\n  u32 a\n  ) ) )\n  u32 b\n}\nstruct T { u8 c }");
    expect(r.diagnostics.length).toBeGreaterThan(0);
    const [s, t] = r.module.decls as [A.StructDecl, A.StructDecl];
    expect(s.members.map(m => (m as A.FieldDecl).name?.name)).toEqual(["a", "b"]);
    expect(t.name.name).toBe("T");
  });

  it("recovers from an unclosed struct at end of file", () => {
    const r = parseSource("struct S {\n  u32 a\n  u32 b");
    expect(r.diagnostics.some(d => d.includes("'}'"))).toBe(true);
    expect((r.module.decls[0] as A.StructDecl).members).toHaveLength(2);
  });

  it("keeps parsing after a broken declaration", () => {
    const r = parseSource("struct { u32 a }\nstruct T { u8 c }");
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.module.decls.some(d => d.kind === "StructDecl" && d.name.name === "T")).toBe(true);
  });

  it("reports fields at top level", () => {
    const r = parseSource("u32 a\nstruct T { u8 c }");
    expect(r.diagnostics).toEqual(["1:1 syntax-error: Fields must be declared inside a struct."]);
    expect(r.module.decls).toHaveLength(1);
  });

  it("recovers inside unclosed parentheses", () => {
    const r = parseSource("struct S {\n  u8 data[(n + 1]\n  u32 b\n}");
    expect(r.diagnostics.length).toBeGreaterThan(0);
    const s = r.module.decls[0] as A.StructDecl;
    expect(s.members.some(m => (m as A.FieldDecl).name?.name === "b")).toBe(true);
  });

  it("reports else without if and stray case", () => {
    expect(parseSource("struct S { else { u8 a } }").diagnostics[0]).toContain(
      "'else' without a matching 'if'"
    );
    expect(parseSource("struct S { case 1: u8 a }").diagnostics[0]).toContain(
      "'case' outside a switch"
    );
  });

  it("reports declarations nested where not allowed", () => {
    expect(parseSource('struct S { import { a } from "x" }').diagnostics[0]).toContain(
      "only allowed at the top level"
    );
  });

  it("reports a missing '{' after block attributes", () => {
    const r = parseSource("struct S {\n @padUntil(4)\n}");
    expect(r.diagnostics[0]).toContain(
      "Expected '{', 'if', 'switch' or 'bits' after block attributes"
    );
    // an @ line ending the struct still continues the previous field
    expect(parseSource("struct S { u8 a\n @padUntil(4) }").diagnostics).toEqual([]);
  });

  it("records precise spans on every node", () => {
    const text = "struct S {\n  u8 data[n] @align(4)\n}";
    const r = parseSource(text);
    const f = (r.module.decls[0] as A.StructDecl).members[0] as A.FieldDecl;
    expect(text.slice(f.span.start, f.span.end)).toBe("u8 data[n] @align(4)");
    expect(text.slice(f.name!.span.start, f.name!.span.end)).toBe("data");
    expect(text.slice(f.attrs[0]!.span.start, f.attrs[0]!.span.end)).toBe("@align(4)");
    expect(text.slice(f.arrays[0]!.span.start, f.arrays[0]!.span.end)).toBe("[n]");
  });

  it("produces a module for an empty file", () => {
    const r = parseSource("");
    expect(r.module.decls).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  it("parses a struct whose body is partially typed (completion scenarios)", () => {
    const r = parseSource("struct S {\n  u32 count\n  Entry entries[\n}");
    const s = r.module.decls[0] as A.StructDecl;
    expect(s.members.length).toBeGreaterThanOrEqual(2);
  });
});

describe("parser: regressions", () => {
  it("a field's same-line attribute stays on it when the next line opens an attributed block", () => {
    const r = parseSource("struct S {\n  u8 c @align(8)\n  @padUntil(0x10) { u8 d }\n}");
    expect(r.diagnostics).toEqual([]);
    const s = r.module.decls[0] as A.StructDecl;
    const c = s.members[0] as A.FieldDecl;
    expect(c.attrs.map(a => a.name.name)).toEqual(["align"]);
    const block = s.members[1] as A.BlockMember;
    expect(block.kind).toBe("BlockMember");
    expect(block.attrs.map(a => a.name.name)).toEqual(["padUntil"]);
  });
  it("same-line attributes before a `{` still prefix the block", () => {
    const r = parseSource("struct S {\n  u8 a  @align(4) { u8 b }\n}");
    const s = r.module.decls[0] as A.StructDecl;
    expect((s.members[0] as A.FieldDecl).attrs).toEqual([]);
    expect((s.members[1] as A.BlockMember).attrs.map(a => a.name.name)).toEqual(["align"]);
  });
});
