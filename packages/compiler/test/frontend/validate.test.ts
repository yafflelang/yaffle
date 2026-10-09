import { describe, expect, it } from "vitest";
import { validateIr } from "../../src/ir/validate.ts";
import type { IrField, IrProgram } from "../../src/ir/index.ts";
import { ok } from "../helpers.ts";

const BASE = `extern codec zstd
extern fn h(u32 x) -> u32
enum K : u8 { A, B }
struct Inner(u32 n) { u8 d[n] }
export struct S {
  u32 n
  u8  data[n] @via(zstd) @size(n)
  K   k
  u32 hh = h(n)
  Inner(n) in
  bits u8 { u8 a : 4  u8 b : 4 }
}`;

function mutate(fn: (p: IrProgram) => void): string[] {
  const p = structuredClone(ok(BASE));
  fn(p);
  return validateIr(p);
}

const S = (p: IrProgram) => p.structs.find(s => s.id === "S")!;
const F = (p: IrProgram, name: string) =>
  S(p).members.find(m => m.kind === "field" && m.name === name) as IrField;

describe("IR validator", () => {
  it("accepts what the frontend produces", () => {
    expect(validateIr(ok(BASE))).toEqual([]);
  });

  it("struct references and argument counts", () => {
    expect(mutate(p => ((F(p, "in").type as { args: unknown[] }).args = []))).toEqual([
      expect.stringContaining("Inner has 2 params but 0 args")
    ]);
    expect(mutate(p => ((F(p, "in").type as { struct: string }).struct = "Nope"))).toEqual(
      expect.arrayContaining([expect.stringContaining("unknown struct Nope")])
    );
  });

  it("field and param references", () => {
    expect(
      mutate(
        p =>
          (F(p, "hh").derive = {
            kind: "field",
            name: "ghost",
            type: { kind: "int", bits: 32, signed: false }
          })
      )
    ).toEqual([expect.stringContaining("unknown field 'ghost'")]);
    expect(
      mutate(
        p =>
          (F(p, "hh").derive = {
            kind: "param",
            name: "ghost",
            type: { kind: "int", bits: 32, signed: false }
          })
      )
    ).toEqual([expect.stringContaining("unknown param 'ghost'")]);
  });

  it("read-side expressions only see earlier fields", () => {
    expect(
      mutate(p => {
        const d = F(p, "data");
        (d.type as { inner: { length: unknown } }).inner.length = {
          kind: "count",
          expr: { kind: "field", name: "k", type: { kind: "enum", enum: "K" } }
        };
      })
    ).toEqual([
      expect.stringContaining("field 'k' is not declared before this read-side expression")
    ]);
  });

  it("`it` only where allowed", () => {
    expect(
      mutate(
        p =>
          ((F(p, "in").type as { args: unknown[] }).args[1] = {
            kind: "it",
            type: { kind: "int", bits: 32, signed: false }
          })
      )
    ).toEqual([expect.stringContaining("`it` outside")]);
  });

  it("extern calls, codecs and enums", () => {
    expect(mutate(p => ((F(p, "hh").derive as { args: unknown[] }).args = []))).toEqual([
      expect.stringContaining("h takes 1 args, got 0")
    ]);
    expect(mutate(p => (p.externs = p.externs.filter(x => x.kind !== "codec")))).toEqual(
      expect.arrayContaining([expect.stringContaining("unknown codec zstd")])
    );
    expect(mutate(p => (p.enums = []))).toEqual(
      expect.arrayContaining([expect.stringContaining("unknown enum K")])
    );
  });

  it("arithmetic operand types match the result", () => {
    expect(
      mutate(p => {
        F(p, "hh").derive = {
          kind: "binary",
          op: "+",
          left: { kind: "field", name: "n", type: { kind: "int", bits: 32, signed: false } },
          right: { kind: "literal", value: { kind: "int", value: "1" }, type: { kind: "bigint" } },
          type: { kind: "bigint" }
        };
      })
    ).toEqual([
      expect.stringContaining("operands of '+' (int, bigint) don't match the result type bigint")
    ]);
  });

  it("int literals are decimal strings", () => {
    expect(
      mutate(
        p =>
          (F(p, "hh").derive = {
            kind: "literal",
            value: { kind: "int", value: "0x10" },
            type: { kind: "bigint" }
          })
      )
    ).toEqual([expect.stringContaining("not a decimal string")]);
  });

  it("bits fit their storage and don't overlap", () => {
    expect(
      mutate(p => {
        const b = S(p).members.find(m => m.kind === "bits")!;
        if (b.kind === "bits") b.fields[1]!.shift = 2;
      })
    ).toEqual([expect.stringContaining("overlaps")]);
    expect(
      mutate(p => {
        const b = S(p).members.find(m => m.kind === "bits")!;
        if (b.kind === "bits") b.fields[1]!.width = 9;
      })
    ).toEqual(expect.arrayContaining([expect.stringContaining("doesn't fit u8")]));
  });

  it("input / derive / hidden consistency", () => {
    expect(mutate(p => (F(p, "hh").input = "required"))).toEqual([
      expect.stringContaining("a required field's derive must use `it`")
    ]);
    expect(mutate(p => delete F(p, "hh").deriveKind)).toEqual([
      expect.stringContaining("derive and deriveKind must come together")
    ]);
    expect(mutate(p => (F(p, "k").hidden = true))).toEqual([
      expect.stringContaining("hidden fields have output false and input absent")
    ]);
    expect(mutate(p => (F(p, "k").input = "optional"))).toEqual([
      expect.stringContaining("optional input needs a derive")
    ]);
  });

  it("struct parameters: endian first, unique names", () => {
    expect(mutate(p => (S(p).params = []))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("the first param must be the implicit endian param")
      ])
    );
    expect(mutate(p => S(p).params.push({ ...S(p).params[0]!, origin: "explicit" }))).toEqual([
      expect.stringContaining("duplicate param endian")
    ]);
    expect(
      mutate(p => {
        const inner = p.structs.find(s => s.id === "Inner")!;
        inner.params = [inner.params[1]!, inner.params[0]!];
      })
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("the first param must be the implicit endian param")
      ])
    );
  });

  it("names, modules and roots", () => {
    expect(mutate(p => (S(p).name = "not an ident"))).toEqual([
      expect.stringContaining("is not an identifier")
    ]);
    expect(mutate(p => (p.roots[0]!.struct = "Gone"))).toEqual([
      expect.stringContaining("unknown struct Gone")
    ]);
    expect(mutate(p => (S(p).module = "elsewhere.yfl"))).toEqual([
      expect.stringContaining("unknown module elsewhere.yfl")
    ]);
    expect(mutate(p => p.structs.push(structuredClone(S(p))))).toEqual(
      expect.arrayContaining([expect.stringContaining("duplicate id")])
    );
  });

  it("internal marker types never pass", () => {
    expect(
      mutate(
        p =>
          (F(p, "hh").derive = {
            kind: "literal",
            value: { kind: "int", value: "0" },
            type: { kind: "struct", struct: "<error>" }
          })
      )
    ).toEqual([expect.stringContaining("unknown struct <error>")]);
  });

  it("plain JSON only", () => {
    expect(mutate(p => ((p as unknown as { version: unknown }).version = 2))).toEqual([
      expect.stringContaining("version 2 != 1")
    ]);
  });
});
