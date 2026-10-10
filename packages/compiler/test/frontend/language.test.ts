/**
 * Language features: stream carriers, integer types from ranges, roots, syntax variants, `this`,
 * aggregates, pointers to arrays, terminators, defaults, pointer origins and layout arguments.
 */
import { describe, expect, it } from "vitest";
import type { IrBits, IrSwitch, IrType } from "../../src/ir/index.ts";
import { printIrExpr } from "../../src/frontend/printer.ts";
import { checkFiles, codes, expectDiag, expectNoDiag, field, fmt, ok, struct } from "../helpers.ts";
import { formatSource } from "../../src/frontend/format.ts";

const valueType = (src: string, name: string) =>
  (field(struct(ok(src), "S"), name).type as Extract<IrType, { kind: "transform" }>).valueType;

describe("stream carriers", () => {
  it("a `from field` carrier is derived on write but stays in the output", () => {
    const s = struct(ok("struct P { u8 x }\nexport struct S { u8 raw[4]  P p from raw }"), "S");
    expect(field(s, "raw")).toMatchObject({ input: "absent", output: true });
  });
  it("@hidden carriers and pieces are derivable", () => {
    expectNoDiag(
      "struct P { u8 x }\nexport struct S { u8 raw[4] @hidden  P p from raw }",
      "hidden-not-derivable"
    );
    expectNoDiag(
      "extern codec zstd\nstruct F { u32 n  u8 data[] @hidden @size(n) }\nstruct P { u8 x }\nexport struct S { F frags[2] @hidden  P p from frags[*].data }",
      "hidden-not-derivable"
    );
  });
  it("a sliced field whose slices leave gaps stays an input", () => {
    const s = struct(
      ok("struct P { u8 x }\nexport struct S { u8 raw[8]  P p from raw[2..4] }"),
      "S"
    );
    expect(field(s, "raw").input).toBe("required");
  });
  it("other @hidden fields still need a derivation", () => {
    expectDiag("export struct S { u32 a @hidden }", "hidden-not-derivable");
  });
});

describe("integer types from the static range", () => {
  it("transform value types", () => {
    expect(valueType("export struct S { u8 v as it + 100 }", "v")).toEqual({
      kind: "int",
      bits: 16,
      signed: false
    });
    expect(valueType("export struct S { u8 v as it - 1 }", "v")).toEqual({
      kind: "int",
      bits: 16,
      signed: true
    });
    expect(valueType("export struct S { u16 v as it >> 8 }", "v")).toEqual({
      kind: "int",
      bits: 8,
      signed: false
    });
    expect(valueType("export struct S { u32 v as it & 0xff }", "v")).toEqual({
      kind: "int",
      bits: 8,
      signed: false
    });
    expect(valueType("export struct S { u64 v as it * 2 }", "v")).toEqual({
      kind: "int",
      bits: 64,
      signed: false
    });
    expect(valueType("export struct S { i64 v as it * 2 }", "v")).toEqual({
      kind: "int",
      bits: 64,
      signed: true
    });
    expect(valueType("export struct S { u8 a  u16 v as it + a }", "v")).toEqual({
      kind: "int",
      bits: 32,
      signed: false
    });
    expect(valueType("export struct S { i8 v as -it }", "v")).toEqual({
      kind: "int",
      bits: 16,
      signed: true
    });
  });
  it("untyped constants", () => {
    expect(
      ok(
        "export const N = 4\nexport const M = 70000\nexport const K = -1\nexport struct S { u8 d[N] }"
      ).consts.map(c => c.type)
    ).toEqual([
      { kind: "int", bits: 8, signed: false },
      { kind: "int", bits: 32, signed: false },
      { kind: "int", bits: 8, signed: true }
    ]);
  });
});

describe("exported generics and imported roots", () => {
  it("exported generics are importable but not roots", () => {
    const r = checkFiles(
      {
        "/m/main.yfl":
          'import { Span, Name } from "./common.yfl"\nstruct P { u8 x }\nexport struct Uses { Span<P> s  Name n }',
        "/m/common.yfl":
          "export struct Span<T> { u8 n  T items[n] }\nexport type Name = char[4]\nexport struct Plain { u8 y }"
      },
      "/m/main.yfl"
    );
    expect(r.diagnostics.map(fmt)).toEqual([]);
    expect(r.program!.roots.map(x => x.name)).toEqual(["Plain", "Uses"]);
  });
});

describe("not-implemented diagnostics", () => {
  it.each([["before on strings", "struct S { char s[before 0] }"]])("%s", (_name, src) => {
    expect(codes(src)).toContain("not-implemented");
  });
  it.each([
    [
      "per-element layout groups",
      "struct P { u8 x }\nstruct V { P *p : u64 }\nstruct S { V *vs[2] : u64  layout { vs[*] { p } } }"
    ],
    ["@align origin and offset", "struct S { u8 a  u8 b @align(4, offset: 0x19, from: file) }"],
    ["virtual fields", "struct S { u8 hi  u32 lo  virtual u40 size = (hi << 32) | lo }"],
    ["strict fill shorthand", "struct S { u8 a @padUntil(0x80, strict) }"],
    ["derived arrays", "struct S { u8 n  u8 xs[n]  u8 m[2] = indicesWhere(xs, x => x > 0) }"]
  ])("%s are implemented", (_name, src) => {
    expect(codes(src)).not.toContain("not-implemented");
    ok(src);
  });
});

describe("syntax confirmations", () => {
  it("multi-value cases, Enum.Member, @open enums, bits @bitorder, struct params with attributes", () => {
    const p = ok(`export enum K : u8 @open { Sys = 0, Gpu = 1 }
export struct S(u32 n) @base {
  K k
  switch (k) { case K.Sys, K.Gpu: u8 a  default: u8 b }
  bits u8 @bitorder(msb) { u8 hi : 4  u8 lo : 4 }
  char16 w[2]
  char32 x[1]
  u32 ofs
  u8 data[n] at ofs @size(n)
}
export struct R { S(4) s }`);
    const s = struct(p, "S");
    expect(
      (s.members[1] as IrSwitch).cases[0]!.values.map(v => (v.kind === "enum" ? v.member : ""))
    ).toEqual(["Sys", "Gpu"]);
    expect((s.members[2] as IrBits).bitOrder).toBe("msb");
    expect(field(s, "data")).toMatchObject({
      placement: { offset: { kind: "field", name: "ofs" } },
      type: { kind: "layered", layers: [{ kind: "size" }] }
    });
    expect(p.enums[0]!.open).toBe(true);
  });
});

describe("sizeof(this) and offsetof(this)", () => {
  it("lowers to the `this` expression", () => {
    const s = struct(
      ok("export struct S { u32 size = sizeof(this)  u32 at = offsetof(this) }"),
      "S"
    );
    expect(field(s, "size").derive).toMatchObject({
      callee: { name: "sizeof" },
      args: [{ kind: "this", type: { kind: "struct", struct: "S" } }]
    });
    expect(field(s, "at").derive).toMatchObject({
      callee: { name: "offsetof" },
      args: [{ kind: "this" }]
    });
  });
  it("sizeof(this) isn't available while reading", () => {
    expectDiag(
      "export struct S { u8 pad[⟦this⟧] }".replace("[⟦this⟧]", "[sizeof(⟦this⟧)]"),
      "self-reference"
    );
  });
  it("works in generic instances", () => {
    const p = ok("struct Box<T> { u32 size = sizeof(this)  T t }\nexport struct S { Box<u8> b }");
    expect(field(struct(p, "Box<u8>"), "size").derive).toMatchObject({
      args: [{ kind: "this", type: { struct: "Box<u8>" } }]
    });
  });
});

describe("string lengths and aggregates", () => {
  it(".length on strings is in code units", () => {
    const s = struct(ok("export struct S { u16 len = text.length  str text }"), "S");
    expect(printIrExpr(field(s, "len").derive!)).toBe("text.length");
  });
  it("min/max/sum over arr[*].field and arrays", () => {
    const s = struct(
      ok(
        "struct P { u32 total }\nexport struct S { u8 n  P ps[n]  u32 hi = max(ps[*].total)  u32 lo = min(ps[*].total)  u64 all = sum(ps[*].total)  u8 b[4]  u32 bs = sum(b) }"
      ),
      "S"
    );
    expect(field(s, "hi").derive).toMatchObject({
      callee: { name: "max" },
      args: [{ kind: "map", field: "total" }],
      type: { kind: "int", bits: 32 }
    });
    expect(field(s, "all").derive).toMatchObject({
      callee: { name: "sum" },
      type: { kind: "bigint" }
    });
    expect(field(s, "bs").derive).toMatchObject({
      callee: { name: "sum" },
      args: [{ kind: "field", name: "b" }]
    });
  });
  it("aggregates need arrays of numbers", () => {
    expectDiag(
      "export struct S { u8 a  u32 x = sum(⟦a⟧) }",
      "type-mismatch",
      "takes an array of numbers"
    );
  });
});

describe("pointers to arrays", () => {
  it("T[n] *p : u64 derives n from the target's length", () => {
    const s = struct(
      ok("struct Pt { f32 x  f32 y }\nexport struct S @base { u64 n  Pt[n] *points : u64 }"),
      "S"
    );
    expect(field(s, "points").type).toMatchObject({
      kind: "pointer",
      storage: "u64",
      target: { kind: "array", element: { struct: "Pt" } }
    });
    expect(printIrExpr(field(s, "n").derive!)).toBe("points.length");
  });
  it("u8[n] x is the same as u8 x[n]", () => {
    const s = struct(ok("export struct S { u8 n  u8[n] x  char[4] t }"), "S");
    expect(field(s, "x").type).toMatchObject({ kind: "bytes" });
    expect(field(s, "t").type).toMatchObject({ kind: "string" });
  });
  it("@nullable(empty) on array pointers and at arrays", () => {
    const s = struct(
      ok(
        "export struct S @base { u16 n  u16[n] *list : u64 @nullable(empty)  u32 ofs  u8 m  u8 data[m] at ofs @nullable(empty) }"
      ),
      "S"
    );
    expect(field(s, "list").type).toMatchObject({
      kind: "pointer",
      nullValue: "0",
      emptyIsNull: true
    });
    expect(field(s, "data").placement).toMatchObject({ emptyIsNull: true });
    expectDiag(
      "struct P { u8 x }\nexport struct S @base { P *p : u64 ⟦@nullable(empty)⟧ }",
      "invalid-attribute-argument",
      "needs a pointer to an array"
    );
    expectDiag("export struct S { u32 a ⟦@nullable⟧(empty) }", "pointer-attribute");
  });
  it("element-wise lengths: lens = lengths(lists)", () => {
    const s = struct(
      ok("export struct S @base { u16 lens[9]  u16[lens[$index]] *lists[9] : u64 }"),
      "S"
    );
    expect(field(s, "lens")).toMatchObject({
      deriveKind: "auto",
      input: "absent",
      derive: {
        kind: "call",
        callee: { name: "lengths" },
        args: [{ kind: "field", name: "lists" }]
      }
    });
    expect(field(s, "lists").type).toMatchObject({
      kind: "array",
      element: {
        kind: "pointer",
        target: {
          kind: "array",
          length: { expr: { kind: "index", index: { kind: "builtinValue", name: "index" } } }
        }
      }
    });
    expectNoDiag(
      "export struct S @base { u16 lens[9]  u16[lens[$index]] *lists[9] : u64 }",
      "index-unavailable"
    );
  });
});

describe("chains and non-consuming terminators", () => {
  it("until with a predicate on it (inclusive)", () => {
    const s = struct(
      ok(
        "struct Bank { u32 nextOfs  u8 x }\nexport struct S { Bank banks[until it.nextOfs == 0] }"
      ),
      "S"
    );
    expect(field(s, "banks").type).toMatchObject({
      kind: "array",
      length: {
        kind: "untilPredicate",
        predicate: { kind: "binary", op: "==", left: { kind: "member", object: { kind: "it" } } }
      }
    });
  });
  it("before a value", () => {
    const s = struct(ok('export struct S { str pool[before ""]  u16 xs[before 0xffff] }'), "S");
    expect(field(s, "pool").type).toMatchObject({
      kind: "array",
      length: { kind: "before", terminator: { value: { kind: "string", value: "" } } }
    });
    expect(field(s, "xs").type).toMatchObject({ length: { kind: "before" } });
  });
  it("predicates must be bool", () => {
    expectDiag(
      "struct B { u8 x }\nexport struct S { B bs[until ⟦it.x⟧] }",
      "type-mismatch",
      "must be bool"
    );
  });
});

describe("optional inputs with defaults", () => {
  it("?= gives an optional input whose derive is the default", () => {
    const s = struct(ok("export struct S { u32 align ?= 0x100  u16 x22 ?= 3 }"), "S");
    expect(field(s, "align")).toMatchObject({
      input: "optional",
      deriveKind: "formula",
      derive: { kind: "literal", value: { value: "256" } },
      checks: []
    });
  });
  it("can't combine with =", () => {
    expectDiag("export struct S { u32 a = 1 ⟦?= 2⟧ }", "syntax-error", "both `=` and `?=`");
  });
  it("formats", () => {
    expect(formatSource("struct S{u32 a?=0x100}").text).toBe("struct S { u32 a ?= 0x100 }\n");
  });
});

describe("pointer origins", () => {
  it("@origin is evaluated like a computed field", () => {
    const s = struct(
      ok("export struct S @base { str *name : i32 @ref @origin(offsetof(values))  u8 values[4] }"),
      "S"
    );
    expect(field(s, "name").type).toMatchObject({
      kind: "pointer",
      ownership: "ref",
      origin: { callee: { name: "offsetof" }, args: [{ kind: "field", name: "values" }] }
    });
  });
  it("offsetof(this) is the struct's start", () => {
    const s = struct(ok("export struct S @base { str *name : i32 @origin(offsetof(this)) }"), "S");
    expect(field(s, "name").type).toMatchObject({ origin: { args: [{ kind: "this" }] } });
  });
  it("only on pointers", () => {
    expectDiag("export struct S { u32 a ⟦@origin⟧(4) }", "pointer-attribute");
  });
});

describe("layout items reading fields, shared externs", () => {
  it("layout item alignment can read fields", () => {
    const s = struct(
      ok(
        "export struct S @base { u32 align  u32 n  u32 ofs  u8 data[n] at ofs  layout { data @align(align) } }"
      ),
      "S"
    );
    expect(s.layout![0]!.layers).toMatchObject([
      { kind: "align", to: { kind: "field", name: "align" } }
    ]);
  });
  it("export extern codecs are importable by name", () => {
    const r = checkFiles(
      {
        "/m/main.yfl":
          'import { zstd } from "./codecs.yfl"\nexport struct S { u32 n  u8 d[] @via(zstd) @size(n) }',
        "/m/codecs.yfl": "export extern codec zstd\nexport extern fn h(u32 x) -> u32"
      },
      "/m/main.yfl"
    );
    expect(r.diagnostics.map(fmt)).toEqual([]);
    expect(r.program!.externs).toMatchObject([{ kind: "codec", id: "zstd", module: "codecs.yfl" }]);
  });
});

describe("@encoding on str", () => {
  it("applies to str fields", () => {
    expect(
      field(struct(ok('export struct S { str s @encoding("latin1") }'), "S"), "s").type
    ).toMatchObject({ kind: "string", encoding: "latin1", length: { kind: "until" } });
    expectDiag('export struct S { u32 a ⟦@encoding⟧("ascii") }', "invalid-attribute-target");
  });
});
