/** Rust backend: awkward names, recursive types, empty structs, struct-level strict. */
import { beforeAll, describe, expect, it } from "vitest";
import { L, S, block, check, e, enumDecl, f, len, lenOf, program, t, vt } from "./ir-builder.ts";
import { build, hasRust, type Built } from "./rust-utils.ts";

const P = program(
  [
    // Names that collide with Rust keywords, generated locals and runtime names.
    S("Value", [
      f("type", t.u8),
      f("self", t.u8),
      f("v", t.u8),
      f("w", t.u8),
      f("r", t.u8),
      f("j", t.u8),
      f("fn", t.u8),
      f("Result", t.u8)
    ]),
    S("Table", [f("value", t.s("Value")), f("count", t.u8)]),
    S("TableParams", [f("x", t.u8)]),
    S("Empty", []),
    S("HasEmpty", [f("e", t.s("Empty")), f("tail", t.u8)]),
    // Recursive types: a tree through an array, a list through a nullable pointer.
    S("Tree", [
      f("v", t.u8),
      f("n", t.u8, { derive: lenOf("kids", vt.array(vt.struct("Tree"))) }),
      f("kids", t.array(t.s("Tree"), len.count(e.f("n", vt.u8))))
    ]),
    S("List", [f("v", t.u8), f("next", t.ptr(t.s("List"), { storage: "u8", nullable: "0" }))]),
    S("Strict", [f("a", t.layered(t.u8, L.padAfter(1, L.fill(0xab)))), f("flag", t.bool)], {
      strict: true
    }),
    S("Opens", [f("k", t.enum("Nothing"))]),
    // A chain through an inline field of its own type (boxed in Rust).
    S("Bank", [
      f("next", t.u8),
      block([f("data", t.u8), f("more", t.s("Bank"))], {
        condition: e.ne(e.f("next", vt.u8), e.int(0)),
        else: [f("name", t.str())]
      })
    ]),
    S("Wrapper", [f("bank", t.s("Bank")), f("tail", t.u8)])
  ],
  ["Table", "TableParams", "HasEmpty", "Tree", "List", "Strict", "Opens", "Wrapper"],
  { enums: [enumDecl("Nothing", "u16", [], true)] }
);

describe.skipIf(!hasRust)("rust backend: robustness", () => {
  let b: Built;
  beforeAll(async () => {
    b = await build("yaffle_t_robust", [{ name: "rb", program: P }]);
  }, 600_000);

  const rt = async (root: string, bytes: string, json: unknown) => {
    expect(await b.value({ op: "parse", module: "rb", root, bytes })).toEqual(json);
    expect(await b.value({ op: "serialize", module: "rb", root, json })).toBe(bytes);
  };

  it("compiles without warnings", () => {
    expect(b.warnings, b.log).toBe(0);
  });

  it("escapes awkward names", async () => {
    await rt("Table", "0102030405060708" + "09", {
      value: { type: 1, self: 2, v: 3, w: 4, r: 5, j: 6, fn: 7, Result: 8 },
      count: 9
    });
    await rt("TableParams", "07", { x: 7 });
  });

  it("handles empty structs", async () => {
    await rt("HasEmpty", "05", { e: {}, tail: 5 });
  });

  it("handles recursive types", async () => {
    // Tree: v=1, two kids (v=2 no kids, v=3 one kid v=4)
    await rt("Tree", "0102" + "0200" + "0301" + "0400", {
      v: 1,
      n: 2,
      kids: [
        { v: 2, n: 0, kids: [] },
        { v: 3, n: 1, kids: [{ v: 4, n: 0, kids: [] }] }
      ]
    });
    // List: 3 nodes laid out in pre-order: node0 at 0, node1 at 2, node2 at 4
    await rt("List", "0a02" + "0b04" + "0c00", {
      v: 10,
      next: { v: 11, next: { v: 12, next: null } }
    });
    expect(await b.error({ op: "parse", module: "rb", root: "List", bytes: "0a05" })).toMatchObject(
      { code: "EOF", path: ["next"] }
    );
  });

  it("reads and writes cyclic pointers", async () => {
    await rt("List", "0a02" + "0b02", { v: 10, next: { v: 11, next: { $ref: "/next" } } });
  });

  it("applies struct-level strict", async () => {
    await rt("Strict", "01ab01", { a: 1, flag: true });
    expect(
      await b.error({ op: "parse", module: "rb", root: "Strict", bytes: "010001" })
    ).toMatchObject({ code: "CHECK" });
    expect(
      await b.error({ op: "parse", module: "rb", root: "Strict", bytes: "01ab02" })
    ).toMatchObject({ code: "CHECK", path: ["flag"] });
  });

  it("boxes recursive inline fields", async () => {
    await rt("Wrapper", "01" + "aa" + "01" + "bb" + "00" + "6869" + "00" + "ff", {
      bank: { next: 1, data: 0xaa, more: { next: 1, data: 0xbb, more: { next: 0, name: "hi" } } },
      tail: 0xff
    });
  });

  it("supports open enums without members", async () => {
    await rt("Opens", "0500", { k: 5 });
  });
});

export { check };
