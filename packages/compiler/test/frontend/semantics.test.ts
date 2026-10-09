import { describe, expect, it } from "vitest";
import type { IrBits, IrExpr, IrType } from "../../src/ir/index.ts";
import { printIrExpr } from "../../src/frontend/printer.ts";
import { check, codes, expectDiag, expectNoDiag, field, fmt, ok, struct } from "../helpers.ts";

const transformWrite = (src: string, name: string): string | undefined => {
  const t = field(struct(ok(src), "S"), name).type as Extract<IrType, { kind: "transform" }>;
  return t.write ? printIrExpr(t.write) : undefined;
};

describe("bound values", () => {
  it("flow through generic instances", () => {
    const p = ok(`struct Motion { if ($version > 1) { u8 x } }
struct Box<T> { u8 tag  T inner }
export struct R { u16 $version  Box<Motion> b }`);
    expect(struct(p, "Box<Motion>").params.map(x => x.name)).toEqual(["endian", "version"]);
    expect(field(struct(p, "R"), "b").type).toMatchObject({
      args: [{}, { kind: "field", name: "version" }]
    });
  });

  it("flow through pointers, unions and arrays", () => {
    const p = ok(`struct M { u8 d[$n] }
union U { M  N }
struct N { u8 e[$n] }
export struct R @base { u8 $n  M *p : u32  U u  M arr[2] }`);
    const r = struct(p, "R");
    expect(field(r, "p").type).toMatchObject({
      kind: "pointer",
      target: { args: [{}, { kind: "field", name: "n" }] }
    });
    expect(field(r, "u").type).toMatchObject({
      kind: "union",
      variants: [
        { type: { args: [{}, { kind: "field", name: "n" }] } },
        { type: { args: [{}, { kind: "field", name: "n" }] } }
      ]
    });
    expect(field(r, "arr").type).toMatchObject({
      element: { args: [{}, { kind: "field", name: "n" }] }
    });
  });

  it("a struct reading before its own binding needs the value from callers", () => {
    const p = ok(`struct M { u8 a[$v]  u8 $v  u8 b[$v] }
export struct R { u8 $v  M m }`);
    const m = struct(p, "M");
    expect(m.params.map(x => x.name)).toEqual(["endian", "v"]);
    expect(field(m, "a").type).toMatchObject({ length: { expr: { kind: "param", name: "v" } } });
    expect(field(m, "b").type).toMatchObject({ length: { expr: { kind: "field", name: "v" } } });
  });

  it("warns when an inner binding shadows an outer one", () => {
    const d = expectDiag(
      "export struct R { u32 $v  M m }\nstruct M { u16 $v  u8 d[$v] }",
      "bound-shadowing"
    );
    expect(d.message).toContain("shadows the binding from R");
    expectNoDiag("export struct R { M m }\nstruct M { u16 $v  u8 d[$v] }", "bound-shadowing");
  });

  it("integer binding types widen", () => {
    const p = ok(
      "export struct A { u8 $v  M m }\nexport struct B { u32 $v  M m }\nstruct M { u8 d[$v] }"
    );
    expect(struct(p, "M").params[1]!.type).toEqual({ kind: "int", bits: 32, signed: false });
  });

  it("declared $ parameters: passed explicitly or filled from the binding", () => {
    const p = ok(
      "struct S(u32 $version) { if ($version > 1) { u8 x } }\nexport struct R { u32 $version  S a  S(7) b  S(version: 9) c }"
    );
    const r = struct(p, "R");
    expect(field(r, "a").type).toMatchObject({ args: [{}, { kind: "field", name: "version" }] });
    expect(field(r, "b").type).toMatchObject({ args: [{}, { kind: "literal" }] });
    expect(field(r, "c").type).toMatchObject({
      args: [{}, { kind: "literal", value: { value: "9" } }]
    });
  });

  it("a declared $ parameter omitted without a binding is missing", () => {
    expectDiag(
      "struct S(u32 $version) { u8 x }\nexport struct R { S a }",
      "missing-binding",
      "R → a (S)"
    );
  });

  it("implicit parameter names avoid declared ones", () => {
    const p = ok(
      "struct M(u8 version) { u8 d[$version + version] }\nexport struct R { u8 $version  M(1) m }"
    );
    expect(struct(p, "M").params.map(x => [x.name, x.origin, x.boundName])).toEqual([
      ["endian", "endian", undefined],
      ["version", "explicit", undefined],
      ["version_bound", "bound", "version"]
    ]);
  });

  it("$endian is the endian parameter", () => {
    const p = ok("export struct S { @endian($endian == be ? le : be) { u32 x } }");
    expect(struct(p, "S").usesEndian).toBe(true);
  });
});

describe("lexical nesting", () => {
  it("passes outer fields through intermediate nested structs", () => {
    const p = ok(`export struct O {
  u32 n
  struct A { struct B { u8 d[n] }  B b }
  A a
}`);
    expect(struct(p, "O.A.B").params[1]).toMatchObject({ name: "n", origin: "outer" });
    expect(struct(p, "O.A").params[1]).toMatchObject({ name: "n", origin: "outer" });
    expect(field(struct(p, "O.A"), "b").type).toMatchObject({
      args: [{}, { kind: "param", name: "n" }]
    });
    expect(field(struct(p, "O"), "a").type).toMatchObject({
      args: [{}, { kind: "field", name: "n" }]
    });
  });

  it("outer parameters", () => {
    const p = ok(
      "export struct O(u32 k) { struct I { u8 d[k] }  I i }\nexport struct R { O(3) o }"
    );
    expect(field(struct(p, "O"), "i").type).toMatchObject({
      args: [{}, { kind: "param", name: "k" }]
    });
  });

  it("using a nested struct before the outer field it reads is an error", () => {
    expectDiag(
      "export struct O { struct I { u8 d[n] }  I i  u32 n }",
      "outer-unavailable",
      "declared after this use"
    );
  });

  it("nested types are visible by qualified name", () => {
    const p = ok("struct O { struct I { u8 x }  I i }\nexport struct R { O.I direct  O o }");
    expect(field(struct(p, "R"), "direct").type).toMatchObject({ struct: "O.I" });
  });
});

describe("$index", () => {
  it("is fine inside array elements, also nested", () => {
    expectNoDiag(
      "export struct R { E e[2] }\nstruct E { F f }\nstruct F { u8 d[$index] }",
      "index-unavailable"
    );
  });
  it("element placement uses the element's own index", () => {
    const p = ok("struct F { u8 x }\nexport struct R { F fs[] at $index * 0x10 }");
    expect(field(struct(p, "R"), "fs").type).toMatchObject({
      elementPlacement: { kind: "binary", op: "*", left: { kind: "builtinValue", name: "index" } }
    });
  });
});

describe("transforms", () => {
  it("inverts linear integer transforms", () => {
    expect(transformWrite("export struct S { u8 a as it + 5 }", "a")).toBe("it - 5");
    expect(transformWrite("export struct S { u8 a as it - 5 }", "a")).toBe("it + 5");
    expect(transformWrite("export struct S { u8 a as 10 - it }", "a")).toBe("10 - it");
    expect(transformWrite("export struct S { u8 a as it * 4 }", "a")).toBe("it / 4");
    expect(transformWrite("export struct S { u8 a as it << 2 }", "a")).toBe("it >> 2");
    expect(transformWrite("export struct S { u8 a as it ^ 0x5a }", "a")).toBe("it ^ 90");
    expect(transformWrite("export struct S { u8 a as ~it }", "a")).toBe("~it");
    expect(transformWrite("export struct S { u8 a as (it + 1) * 2 }", "a")).toBe("it / 2 - 1");
  });

  it("float transforms round on the way back", () => {
    expect(transformWrite("export struct S { i16 a as it / 256.0 }", "a")).toBe(
      "round(it * 256.0)"
    );
    expect(transformWrite("export struct S { u8 a as it * 0.5 + 10 }", "a")).toBe(
      "round((it - 10.0) / 0.5)"
    );
  });

  it("uses other fields in the transform", () => {
    expect(transformWrite("export struct S { u8 scale  u16 a as it * scale }", "a")).toBe(
      "it / scale"
    );
  });

  it("lookups invert to indexOf", () => {
    expect(transformWrite("export struct S { u8 n  str names[n]  u8 k as names[it] }", "k")).toBe(
      "indexOf(names, it)"
    );
  });

  it("non-invertible transforms are one-way", () => {
    expect(transformWrite("export struct S { u8 a as it * it }", "a")).toBeUndefined();
    expect(codes("export struct S { u8 a as it * it }")).toEqual(["one-way-transform"]);
  });

  it("the explicit write side sees every field", () => {
    expect(
      transformWrite(
        "extern fn d(u32 x) -> u32\nextern fn e(u32 x, u32 k) -> u32\nexport struct S { u32 t as d(it) = e(it, key)  u32 key }",
        "t"
      )
    ).toBe("e(it, key)");
  });
});

describe("placements and derivations", () => {
  it("constraint remainders for offset expressions", () => {
    const p = ok("struct P { u8 x }\nexport struct S @base { u32 sec  P p at sec * 0x10 + 4 }");
    const s = struct(p, "S");
    expect(field(s, "p").placement).toMatchObject({
      constraint: { modulus: "16", remainder: "4" },
      fixed: false
    });
    expect(printIrExpr(field(s, "sec").derive!)).toBe("(offsetof(p) - 4) / 16");
  });

  it("offsets from parameters are fixed", () => {
    const p = ok("struct P { u8 x }\nstruct S(u32 o) { P p at o }\nexport struct R { S(4) s }");
    expect(field(struct(p, "S"), "p").placement).toMatchObject({ fixed: true });
  });

  it("explicit offset formulas keep placements movable", () => {
    const p = ok(
      "struct P { u8 x }\nexport struct S @base { u32 o = offsetof(p) - 8  P p at o + 8 }"
    );
    expect(field(struct(p, "S"), "p").placement).toMatchObject({ fixed: false });
  });

  it("derives through shifts and subtraction", () => {
    expect(
      printIrExpr(field(struct(ok("export struct S { u8 n  u8 d[n << 2] }"), "S"), "n").derive!)
    ).toBe("d.length / 4");
    expect(
      printIrExpr(field(struct(ok("export struct S { u8 n  u8 d[n - 2] }"), "S"), "n").derive!)
    ).toBe("d.length + 2");
  });

  it("derives a length through a struct argument", () => {
    const p = ok("struct Blob(u32 n) { u8 data[n * 2] }\nexport struct S { u32 len  Blob(len) b }");
    expect(printIrExpr(field(struct(p, "S"), "len").derive!)).toBe("b.data.length / 2");
  });

  it("doesn't derive from conditional arrays", () => {
    const p = ok("export struct S { u8 n  u8 v  if (v > 0) { u8 d[n] } }");
    expect(field(struct(p, "S"), "n").input).toBe("required");
  });

  it("derives a bitfield used as a length", () => {
    const p = ok("export struct S { bits u16 { u16 count : 12  u8 kind : 4 }  u8 d[count] }");
    const b = struct(p, "S").members[0] as IrBits;
    expect(b.fields[0]).toMatchObject({ name: "count", deriveKind: "auto", input: "absent" });
  });

  it("derived sizes for nested size layers", () => {
    const p = ok(
      "export struct S { u32 outer  u32 inner  u8 d[] @size(inner) @padUntil(16) @size(outer) }"
    );
    const s = struct(p, "S");
    expect(printIrExpr(field(s, "inner").derive!)).toBe("encodedSize(d, 0)");
    expect(printIrExpr(field(s, "outer").derive!)).toBe("encodedSize(d, 2)");
  });
});

describe("bitfields", () => {
  it("C-style runs start a new unit when full or when the type changes", () => {
    const p = ok("export struct S { u8 a : 6  u8 b : 4  u16 c : 3 }");
    const units = struct(p, "S").members as IrBits[];
    expect(units.map(u => [u.storage, u.fields.filter(f => f.name).map(f => f.name)])).toEqual([
      ["u8", ["a"]],
      ["u8", ["b"]],
      ["u16", ["c"]]
    ]);
  });

  it("an unnamed zero-width field starts a new unit", () => {
    const units = struct(ok("export struct S { u8 a : 2  u8 : 0  u8 b : 2 }"), "S")
      .members as IrBits[];
    expect(units.length).toBe(2);
  });

  it("enum bitfields must hold every value", () => {
    expectDiag(
      "enum E : u8 { A, B, C, D, E5 = 9 }\nexport struct S { bits u8 { E e : ⟦3⟧ } }",
      "bitfield-width",
      "can't hold every value"
    );
  });

  it("constants and checks on bitfields", () => {
    const b = struct(ok("export struct S { bits u8 { u8 ver : 4 = 2  u8 k : 4 in (1, 2) } }"), "S")
      .members[0] as IrBits;
    expect(b.fields[0]).toMatchObject({ deriveKind: "constant", input: "absent" });
    expect(b.fields[1]!.checks[0]!.message).toBe("k in (1, 2)");
  });

  it("follow $endian unless the storage is fixed", () => {
    expect(struct(ok("export struct S { bits u16 { u8 a : 8  u8 b : 8 } }"), "S").usesEndian).toBe(
      true
    );
    expect(
      struct(ok("export struct S { bits u16be { u8 a : 8  u8 b : 8 } }"), "S").usesEndian
    ).toBe(false);
  });
});

describe("aliases and generics", () => {
  it("alias clauses merge into fields that use them directly", () => {
    const p = ok(
      "type Even = u32 where it % 2 == 0\ntype Magic = u16 = 0xbeef\nexport struct S { Even e  Magic m }"
    );
    const s = struct(p, "S");
    expect(field(s, "e").checks[0]!.message).toBe("e % 2 == 0");
    expect(field(s, "m")).toMatchObject({ deriveKind: "constant", input: "absent" });
  });

  it("alias checks can't apply per array element", () => {
    expectDiag(
      "type Even = u32 where it % 2 == 0\nexport struct S { Even e[4] }",
      "type-mismatch",
      "can't apply per element"
    );
  });

  it("aliases of aliases and generic aliases", () => {
    const p = ok(
      "type A = u32\ntype B = A\ntype Arr<T> = T[4]\nstruct P { u8 x }\nexport struct S { B b  Arr<P> ps }"
    );
    const s = struct(p, "S");
    expect(field(s, "b").type).toEqual({ kind: "prim", prim: "u32", endian: "inherit" });
    expect(field(s, "ps").type).toMatchObject({
      kind: "array",
      element: { kind: "struct", struct: "P" }
    });
  });

  it("nested generic instances get distinct ids and names", () => {
    const p = ok(
      "struct P { u8 x }\nstruct Sp<T> { u8 n  T items[n] }\nexport struct S { Sp<Sp<P>> a  Sp<P> b  Sp<u8> c }"
    );
    expect(p.structs.map(s => [s.id, s.name]).filter(([id]) => id!.startsWith("Sp"))).toEqual([
      ["Sp<Sp<P>>", "Sp_Sp_P"],
      ["Sp<P>", "Sp_P"],
      ["Sp<u8>", "Sp_u8"]
    ]);
  });

  it("generic arguments with constant struct arguments", () => {
    const p = ok(
      "struct Blob(u32 n) { u8 d[n] }\nstruct Box<T> { T t }\nexport struct S { Box<Blob(4)> a  Box<Blob(8)> b }"
    );
    expect(p.structs.map(s => s.id).filter(id => id.startsWith("Box"))).toEqual([
      "Box<Blob(4)>",
      "Box<Blob(8)>"
    ]);
  });

  it("generic bodies are checked once with opaque parameters", () => {
    expectDiag("struct Box<T> { T t  u8 d[t.⟦size⟧] }", "unknown-member", "type parameter");
  });
});

describe("expressions", () => {
  it("compares enums with members, bare or qualified", () => {
    const p = ok(
      "enum K : u8 { A, B }\nexport struct S { K k  if (k == B) { u8 x }  if (K.A != k) { u8 y } }"
    );
    expect(struct(p, "S").members[1]).toMatchObject({
      condition: { right: { value: { kind: "enum", member: "B" } } }
    });
  });

  it("rejects comparing enums with numbers", () => {
    expectDiag(
      "enum K : u8 { A }\nexport struct S { K k  if (k == ⟦1⟧) { u8 x } }",
      "type-mismatch",
      "Compare enums with members"
    );
  });

  it("character codes with a fixed-endian discriminant", () => {
    const p = ok("export struct S { u32be t  switch (t) { case 'ARCV': u8 a } }");
    expect(struct(p, "S").members[1]).toMatchObject({
      cases: [{ values: [{ kind: "int", value: String(0x41524356) }] }]
    });
  });

  it("integer literal comparisons take the field's type", () => {
    const p = ok("export struct S { u16 v  if (v >= 3) { u8 x } }");
    const cond = (struct(p, "S").members[1] as { condition: IrExpr }).condition;
    expect(cond).toMatchObject({
      left: { kind: "field", type: { bits: 16 } },
      right: { kind: "literal", type: { kind: "int", bits: 16 } }
    });
  });

  it("mixed int/float arithmetic converts to f64", () => {
    const p = ok("export struct S { u8 a  f32 b  f64 c = a * b }");
    expect(field(struct(p, "S"), "c").derive).toMatchObject({
      type: { kind: "float", bits: 64 },
      left: { kind: "convert", type: { kind: "float" } },
      right: { kind: "convert" }
    });
  });

  it("folds constant expressions", () => {
    const p = ok(
      "const u32 A = 2\nconst u32 B = A << 4\nexport struct S { u8 d[B * 2 + max(1, 3)] }"
    );
    expect(field(struct(p, "S"), "d").type).toMatchObject({
      length: { expr: { kind: "literal", value: { value: "67" } } }
    });
  });

  it("string lengths count code units in their encoding", () => {
    const p = ok("export struct S { u8 n  char16 t[n]  u32 total = t.length * 2 }");
    expect(printIrExpr(field(struct(p, "S"), "n").derive!)).toBe("t.length");
    expect(field(struct(p, "S"), "n").derive).toMatchObject({
      kind: "binary",
      op: "/",
      left: { callee: { name: "encodedLength" } },
      right: { value: { value: "2" } }
    });
  });

  it("struct-typed members in expressions", () => {
    const p = ok(
      "struct H { u32 n  u8 flags }\nexport struct S { H h  u8 d[h.n]  if (h.flags & 1 == 1) { u8 x } }"
    );
    expect(field(struct(p, "S"), "d").type).toMatchObject({
      length: { expr: { kind: "member", name: "n" } }
    });
  });

  it("arr[*].field in expressions is a map", () => {
    const p = ok(
      "struct E { u32 size }\nextern fn sum(u32 xs[]) -> u32\nexport struct S { u8 n  E es[n]  u32 total = sum(es[*].size) }"
    );
    expect(field(struct(p, "S"), "total").derive).toMatchObject({
      args: [{ kind: "map", field: "size" }]
    });
  });
});

describe("program contents", () => {
  it("includes only reachable structs, used enums and externs, exported consts", () => {
    const p = ok(`enum Used : u8 { A }
enum Unused : u8 { B }
extern codec zstd
extern codec unusedCodec
const u32 PRIVATE = 1
export const u32 PUBLIC = 2
struct Reached { Used u }
struct Unreached { u8 x }
export struct Root { Reached r  u8 d[] @via(zstd) @size(PRIVATE) }`);
    expect(p.structs.map(s => s.id)).toEqual(["Root", "Reached"]);
    expect(p.enums.map(e => e.id)).toEqual(["Used"]);
    expect(p.externs.map(e => e.id)).toEqual(["zstd"]);
    expect(p.consts.map(c => c.name)).toEqual(["PUBLIC"]);
  });

  it("files without exports produce an empty program", () => {
    const r = check("struct S { u8 x }");
    expect(r.program?.structs).toEqual([]);
  });

  it("async and usesEndian propagate through several levels", () => {
    const p = ok(
      "extern async codec oodle\nstruct C { u8 d[] @via(oodle) }\nstruct B { C c }\nstruct E { u8 x }\nexport struct A { B b  E e }"
    );
    expect(p.structs.map(s => [s.id, s.async])).toEqual([
      ["A", true],
      ["B", true],
      ["E", false],
      ["C", true]
    ]);
  });

  it("errors anywhere suppress the program", () => {
    const r = check("export struct A { u8 x }\nstruct B { u8 y[nope] }");
    expect(r.program).toBeUndefined();
    expect(r.diagnostics.map(fmt)).toEqual(["2:17 error unknown-name: Unknown name 'nope'."]);
  });
});
