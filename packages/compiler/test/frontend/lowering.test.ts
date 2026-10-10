/**
 * Lowering of layout groups, alignment origins, strict fills, virtual fields, derived arrays and
 * slice carriers: a golden IR dump per feature (test/frontend/golden/lowering-*.txt) plus exact
 * assertions on the shapes the backends rely on.
 * Every program is validated against the IR invariants (helpers.check).
 */
import { describe, expect, it } from "vitest";
import { irToText } from "../../src/frontend/irtext.ts";
import type { IrExpr, IrLayer, IrType } from "../../src/ir/index.ts";
import { codes, expectDiag, field, ok, struct } from "../helpers.ts";

async function golden(name: string, source: string) {
  const p = ok(source);
  await expect(irToText(p)).toMatchFileSnapshot(`./golden/lowering-${name}.txt`);
  return p;
}

const layers = (t: IrType): IrLayer[] => (t.kind === "layered" ? t.layers : []);
/** An IR expression without its types, for compact shape assertions. */
function bare(e: unknown): unknown {
  return JSON.parse(JSON.stringify(e), (k, v) => (k === "type" ? undefined : v));
}

describe("per-element layout groups", () => {
  it("lowers the group's path without [*] and its items relative to the element", async () => {
    const p = await golden(
      "groups",
      `struct Leaf { u8 v }
struct Portal { u8 n  u8 ofs  Leaf points[n] at ofs }
struct Volume {
  u8     np
  Leaf  *pieces[np] : u8
  u8     nq
  Portal portals[nq]
}
export struct Cop {
  u8     n
  Volume volumes[n]
  layout {
    volumes[*] @align(4) { pieces[*]  portals[*].points @align(2)  this }
  }
}`
    );
    expect(struct(p, "Cop").layout).toEqual([
      {
        path: [{ kind: "field", name: "volumes" }],
        layers: [
          {
            kind: "align",
            to: { kind: "literal", value: { kind: "int", value: "4" }, type: { kind: "bigint" } },
            fill: { kind: "byte", value: 0 }
          }
        ],
        group: {
          items: [
            { path: [{ kind: "field", name: "pieces" }, { kind: "each" }], layers: [] },
            {
              path: [
                { kind: "field", name: "portals" },
                { kind: "each" },
                { kind: "field", name: "points" }
              ],
              layers: [
                {
                  kind: "align",
                  to: {
                    kind: "literal",
                    value: { kind: "int", value: "2" },
                    type: { kind: "bigint" }
                  },
                  fill: { kind: "byte", value: 0 }
                }
              ]
            },
            { path: "this", layers: [] }
          ]
        }
      }
    ]);
  });
  it("nested groups and groups over pointer elements", async () => {
    const p = await golden(
      "groups-nested",
      `struct Leaf { u8 v }
struct Node { Leaf *x : u8  Leaf *y : u8 }
struct Outer { u8 m  Node inner[m] }
export struct S {
  u8     n
  Outer  outers[n]
  Node  *nodes[n] : u8
  layout {
    outers[*] { inner[*] { y  x } }
    nodes[*] { this  y }
  }
}`
    );
    const l = struct(p, "S").layout!;
    expect(l[0]!.group!.items[0]).toMatchObject({
      path: [{ kind: "field", name: "inner" }],
      group: {
        items: [{ path: [{ kind: "field", name: "y" }] }, { path: [{ kind: "field", name: "x" }] }]
      }
    });
    expect(l[1]).toMatchObject({ path: [{ kind: "field", name: "nodes" }] });
  });
  it("diagnoses groups that aren't over arrays of structs", () => {
    expectDiag(
      "struct S { u8 n  u16 xs[n]  layout { xs[*] { a } } }",
      "unknown-layout-path",
      /array of structs/
    );
    expectDiag(
      "struct L { u8 v }\nstruct E { L *p : u8 }\nstruct S { E es[2]  layout { es { p } } }",
      "unknown-layout-path",
      /write 'es\[\*\] \{ … \}'/
    );
    expectDiag(
      "struct L { u8 v }\nstruct E { L *p : u8 }\nstruct S { E es[2]  layout { es[*] { q } } }",
      "unknown-layout-path",
      /'E' has no field 'q'/
    );
  });
});

describe("alignment origin and offset; strict fill", () => {
  it("emits from only for file, offset only when not 0, strict on every padding kind", async () => {
    const p = await golden(
      "align-strict",
      `struct E @alignEnd(8, from: file, strict) { u8 a }
export struct S {
  u8 a @align(4, offset: 3)
  u8 b @align(4, from: base, offset: 0)
  u8 c @align(16, 0xff, from: file)
  u8 d @padUntil(4, strict) @padBefore(1, strict) @padAfter(1, 0xcc, strict)
  u8 k
  u8 e @alignEnd(8, offset: k)
  @padUntil(8, strict) { u8 f }
  E  g
}`
    );
    const s = struct(p, "S");
    expect(bare(layers(field(s, "a").type))).toEqual([
      {
        kind: "align",
        to: { kind: "literal", value: { kind: "int", value: "4" } },
        fill: { kind: "byte", value: 0 },
        offset: { kind: "literal", value: { kind: "int", value: "3" } }
      }
    ]);
    expect(layers(field(s, "b").type)[0]).not.toHaveProperty("from");
    expect(layers(field(s, "b").type)[0]).not.toHaveProperty("offset");
    expect(layers(field(s, "c").type)[0]).toMatchObject({
      from: "file",
      fill: { kind: "byte", value: 0xff }
    });
    expect(layers(field(s, "d").type).map(l => [l.kind, "strict" in l && l.strict])).toEqual([
      ["padUntil", true],
      ["padBefore", true],
      ["padAfter", true]
    ]);
    expect(bare(layers(field(s, "e").type)[0])).toMatchObject({
      offset: { kind: "field", name: "k" }
    });
    expect(s.members[6]).toMatchObject({
      kind: "block",
      layers: [{ kind: "padUntil", strict: true }]
    });
    expect(struct(p, "E").layers).toEqual([
      expect.objectContaining({ kind: "alignEnd", from: "file", strict: true })
    ]);
  });
  it("diagnoses misuse", () => {
    expectDiag(
      "struct S { u8 a @padUntil(4, from: file) }",
      "invalid-attribute-argument",
      /no argument named 'from'/
    );
    expectDiag(
      "struct S { u8 a @align(4, from: files) }",
      "invalid-attribute-argument",
      /Did you mean 'file'/
    );
    expectDiag(
      "struct S { u8 a @align(strict) }",
      "invalid-attribute-argument",
      /takes 1 to 2 arguments, but 0 were given/
    );
    expectDiag(
      "struct S { u8 a @align(4, strict, 0xff) }",
      "invalid-attribute-argument",
      /`strict` comes last/
    );
    expectDiag(
      "struct L { u8 v }\nstruct S { L *p : u8  layout { p @align(4, strict) } }",
      "invalid-attribute-argument",
      /no effect in a layout item/
    );
    // a field named `strict` is an expression, not the word
    expect(codes("struct S { u8 strict  u8 a @padUntil(4, strict) }")).toContain("not-constant");
  });
});

describe("virtual fields", () => {
  it("lowers the read side and derives the parts", async () => {
    const p = await golden(
      "virtual",
      `export struct S {
  u8  hi
  u32 lo
  virtual u40 size = (hi << 32) | lo
  u8  a
  u8  b in (0..9)
  virtual u16 dec = a * 10 + b ?= 7
  u16 n
  virtual u32 bytes = (n - 1) * 4 where it % 4 == 0
}`
    );
    const s = struct(p, "S");
    const size = field(s, "size");
    expect(size).toMatchObject({
      input: "required",
      output: true,
      type: { kind: "prim", prim: "u40" }
    });
    expect(size).not.toHaveProperty("derive");
    expect(bare(size.virtual!.read)).toEqual({
      kind: "binary",
      op: "|",
      left: {
        kind: "binary",
        op: "<<",
        left: { kind: "convert", operand: { kind: "field", name: "hi" } },
        right: { kind: "literal", value: { kind: "int", value: "32" } }
      },
      right: { kind: "convert", operand: { kind: "field", name: "lo" } }
    });
    const derive = (n: string) => bare(field(s, n).derive);
    const v = (name: string) => ({ kind: "convert", operand: { kind: "field", name } });
    const int = (n: number) => ({ kind: "literal", value: { kind: "int", value: String(n) } });
    expect(derive("hi")).toEqual({ kind: "binary", op: ">>", left: v("size"), right: int(32) });
    expect(derive("lo")).toEqual({
      kind: "binary",
      op: "&",
      left: v("size"),
      right: int(0xffffffff)
    });
    expect(derive("a")).toEqual({ kind: "binary", op: "/", left: v("dec"), right: int(10) });
    expect(derive("b")).toEqual({ kind: "binary", op: "%", left: v("dec"), right: int(10) });
    expect(derive("n")).toEqual({
      kind: "binary",
      op: "/",
      left: { kind: "binary", op: "+", left: v("bytes"), right: int(4) },
      right: int(4)
    });
    for (const n of ["hi", "lo", "a", "b", "n"])
      expect(field(s, n)).toMatchObject({ deriveKind: "auto", input: "absent", output: true });
    expect(field(s, "dec")).toMatchObject({ input: "optional", deriveKind: "formula" });
    expect(field(s, "bytes").checks).toHaveLength(1);
  });
  it("reports what can't be inverted, and misuse", () => {
    expectDiag(
      "struct S { u8 a  u8 b  virtual u16 v = a * b }",
      "virtual-not-invertible",
      /multiplied together/
    );
    expectDiag(
      "struct S { u8 a  virtual u16 v = a >> 1 }",
      "virtual-not-invertible",
      /`>>` can't be inverted/
    );
    expectDiag(
      "struct S { u8 a  u8 b  virtual u16 v = a * 10 + b }",
      "virtual-not-invertible",
      /reaches 10/
    );
    expectDiag(
      "struct S { i8 a  u8 b  virtual i16 v = (b << 8) | a }",
      "virtual-not-invertible",
      /can be negative/
    );
    expectDiag(
      "struct S { u8 a  u8 b = 1  virtual u16 v = (a << 8) | b }",
      "virtual-not-invertible",
      /remove its formula/
    );
    expectDiag("struct S { u8 a  virtual u16 v }", "invalid-virtual", /needs `= expression`/);
    expectDiag("struct S { u8 a  virtual u16 v = a @align(4) }", "invalid-virtual", /no bytes/);
    expectDiag("struct S { u8 a  virtual u16 v = a at 4 }", "invalid-virtual", /takes no `at`/);
    expectDiag("struct S { virtual u16 v = w  u8 w }", "forward-reference");
  });
});

describe("derived arrays", () => {
  it("lowers lambdas, builtins, isNull and composite equality", async () => {
    const p = await golden(
      "derived",
      `struct M { u8 x }
struct R { M *model : u8 @nullable  u8 flags }
struct K { u8 len  char name[len] }
export struct S {
  u8 r
  u8 s
  R  records[r]
  u8 index[s] = indicesWhere(records, r => r.model != null)
  u8 n
  K  keys[n] where it == sortedBy(it, k => k.name)
  u8 m
  u8 ids[m] = concat(map(records, x => x.flags), unique(index))
}`
    );
    const s = struct(p, "S");
    const index = field(s, "index");
    expect(index).toMatchObject({ deriveKind: "formula", input: "absent" });
    expect(index.derive).toEqual({
      kind: "call",
      callee: { kind: "builtin", name: "indicesWhere" },
      args: [
        {
          kind: "field",
          name: "records",
          type: { kind: "array", element: { kind: "struct", struct: "R" } }
        },
        {
          kind: "lambda",
          param: "r",
          type: { kind: "struct", struct: "R" },
          body: {
            kind: "unary",
            op: "!",
            type: { kind: "bool" },
            operand: {
              kind: "call",
              callee: { kind: "builtin", name: "isNull" },
              type: { kind: "bool" },
              args: [
                {
                  kind: "member",
                  name: "model",
                  object: { kind: "lambdaParam", name: "r", type: { kind: "struct", struct: "R" } },
                  type: { kind: "nullable", inner: { kind: "struct", struct: "M" } }
                }
              ]
            }
          }
        }
      ],
      type: { kind: "array", element: { kind: "bigint" } }
    });
    expect(field(s, "s")).toMatchObject({ deriveKind: "auto", input: "absent" });
    const check = field(s, "keys").checks[0]!.expr as IrExpr & { kind: "binary" };
    expect(check).toMatchObject({ kind: "binary", op: "==", left: { kind: "it" } });
    expect(check.right).toMatchObject({
      kind: "call",
      callee: { name: "sortedBy" },
      type: { kind: "array", element: { kind: "struct", struct: "K" } }
    });
    expect(field(s, "ids").derive).toMatchObject({
      kind: "call",
      callee: { name: "concat" },
      type: { kind: "array", element: { kind: "int", bits: 8, signed: false } }
    });
  });
  it("types and diagnoses lambdas", () => {
    expectDiag("struct S { u8 n  u8 xs[n]  u8 y = n => 1 }", "invalid-lambda", /only allowed/);
    expectDiag(
      "struct S { u8 n  u8 xs[n]  u8 ys[n] = filter(xs, x => x + 1) }",
      "type-mismatch",
      /must be bool/
    );
    expectDiag(
      "struct S { u8 n  u8 xs[n]  u8 ys[n] = map(n, x => x) }",
      "type-mismatch",
      /needs an array/
    );
    expectDiag(
      "struct S { u8 n  u8 xs[n]  u8 y = n where it != null }",
      "type-mismatch",
      /never null/
    );
    expectDiag(
      "struct K { u8 a }\nstruct S { u8 n  K ks[n] where it == sortedBy(it, k => k) }",
      "type-mismatch",
      /keys are numbers, strings or bytes/
    );
  });
});

describe("slice carriers", () => {
  it("marks a fully covered or hidden field as assembled from its slices", async () => {
    const p = await golden(
      "slices",
      `struct H { u16 a  u16 b }
export struct S {
  u8 raw[8] @hidden
  H  hdr  from raw[0..4]
  H  more from raw[4..]
  u8 n
  u8 sized[] @size(n)
  H  first from sized[0..4]
  u8 kept[8]
  H  part from kept[0..4]
}`
    );
    const s = struct(p, "S");
    expect(field(s, "raw")).toMatchObject({ carrier: "slices", input: "absent", hidden: true });
    expect(field(s, "sized")).toMatchObject({ carrier: "slices", input: "absent", output: true });
    expect(field(s, "n")).toMatchObject({ deriveKind: "auto", input: "absent" });
    expect(field(s, "kept")).toMatchObject({ input: "required" });
    expect(field(s, "kept")).not.toHaveProperty("carrier");
  });
});
