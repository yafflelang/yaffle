/**
 * Rust backend on hand-written IR and through the frontend, in parse and view mode: per-element
 * layout groups, alignment origins and offsets, virtual fields, strict padding, lambdas and derived
 * arrays with composite equality, and slice carriers.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type {
  IrExpr,
  IrField,
  IrLayer,
  IrLayoutItem,
  IrType,
  IrValueType
} from "../../../src/ir/index.ts";
import { compileSource } from "../../../src/index.ts";
import { L, S, check, e, f, layoutItem, len, lenOf, program, t, vt } from "./ir-builder.ts";
import { build, hasRust, type Built } from "./rust-utils.ts";

const zero = L.fill(0);
const call = (name: string, args: IrExpr[], type: IrValueType = vt.bytes): IrExpr =>
  ({ kind: "call", callee: { kind: "builtin", name }, args, type }) as IrExpr;
const lambda = (param: string, body: IrExpr, type: IrValueType = vt.u8): IrExpr => ({
  kind: "lambda",
  param,
  body,
  type
});
const lv = (name: string, type: IrValueType = vt.u8): IrExpr => ({
  kind: "lambdaParam",
  name,
  type
});
const layered = (inner: IrType, ...layers: IrLayer[]): IrType => t.layered(inner, ...layers);
const virt = (name: string, type: IrType, read: IrExpr, o: Partial<IrField> = {}): IrField => ({
  ...f(name, type),
  virtual: { read },
  ...o
});
const group = (path: string, items: IrLayoutItem[]): IrLayoutItem => ({
  path: [{ kind: "field", name: path }],
  layers: [],
  group: { items }
});

const keyArr = vt.array(vt.struct("Key"));

const prog = program(
  [
    // An alignment offset, and strict fill without strict mode.
    S("Al", [
      f("a", t.u8),
      f(
        "b",
        layered(t.bytes(len.n(3)), { kind: "align", to: e.int(4), fill: zero, offset: e.int(1) })
      ),
      f("c", layered(t.u8, { kind: "padUntil", size: e.int(2), fill: zero, strict: true }))
    ]),
    // Alignment from the file inside a @base at 3.
    S(
      "Inner",
      [
        f("x", t.u8),
        f("y", layered(t.u8, { kind: "align", to: e.int(4), fill: zero, from: "file" }))
      ],
      { base: true }
    ),
    S("FileAl", [f("pre", t.bytes(len.n(3))), f("inner", t.s("Inner"))]),
    // A layout group: for each volume, its b target, then its a target.
    S("P", [f("v", t.u8)]),
    S("Vol", [
      f("a", t.ptr(t.s("P"), { storage: "u8" })),
      f("b", t.ptr(t.s("P"), { storage: "u8" }))
    ]),
    S(
      "Grp",
      [
        f("n", t.u8, { derive: lenOf("vols", vt.array(vt.struct("Vol"))), deriveKind: "auto" }),
        f("vols", t.array(t.s("Vol"), len.count(e.f("n", vt.u8))))
      ],
      { layout: [group("vols", [layoutItem(["b"]), layoutItem(["a"])])] }
    ),
    // A virtual field: size = (hi << 8) | lo; hi and lo are derived from it.
    S("Virt", [
      f("hi", t.u8, { derive: e.shr(e.f("size", vt.u16), e.int(8)) }),
      f("lo", t.u8, { derive: e.and(e.f("size", vt.u16), e.int(0xff)) }),
      virt("size", t.u16, e.or(e.shl(e.f("hi", vt.u8), e.int(8)), e.f("lo", vt.u8)))
    ]),
    // Derived arrays and checks stating rules.
    S("Derived", [
      f("n", t.u8, { derive: lenOf("vals", vt.bytes), deriveKind: "auto" }),
      f("vals", t.bytes(len.count(e.f("n", vt.u8)))),
      f("k", t.u8, { derive: lenOf("big", vt.bytes), deriveKind: "auto" }),
      f("big", t.bytes(len.count(e.f("k", vt.u8))), {
        derive: call("filter", [e.f("vals", vt.bytes), lambda("v", e.gt(lv("v"), e.int(3)))])
      }),
      f("sorted", t.bytes(len.count(e.f("n", vt.u8))), {
        checks: [
          check(
            e.eq(e.it(vt.bytes), call("sortedBy", [e.it(vt.bytes), lambda("x", lv("x"))])),
            "sorted == sortedBy(sorted, x => x)"
          )
        ]
      }),
      f("idx", t.array(t.u16, len.count(e.f("k", vt.u8))), {
        derive: call(
          "indicesWhere",
          [e.f("vals", vt.bytes), lambda("v", e.gt(lv("v"), e.int(3)))],
          vt.array(vt.big)
        )
      }),
      f("dbl", t.array(t.u16, len.count(e.f("n", vt.u8))), {
        derive: call(
          "map",
          [e.f("vals", vt.bytes), lambda("v", e.mul(lv("v"), e.int(2)))],
          vt.array(vt.big)
        )
      }),
      f("m", t.u8, { derive: lenOf("u", vt.bytes), deriveKind: "auto" }),
      f("u", t.bytes(len.count(e.f("m", vt.u8))), {
        derive: call("unique", [call("concat", [e.f("vals", vt.bytes), e.f("sorted", vt.bytes)])])
      })
    ]),
    // Composite equality of struct arrays (sorted by a string key).
    S("Key", [f("name", t.str())]),
    S("Keys", [
      f("n", t.u8, { derive: lenOf("keys", keyArr), deriveKind: "auto" }),
      f("keys", t.array(t.s("Key"), len.count(e.f("n", vt.u8))), {
        checks: [
          check(
            e.eq(
              e.it(keyArr),
              call(
                "sortedBy",
                [
                  e.it(keyArr),
                  lambda("k", e.member(lv("k", vt.struct("Key")), "name", vt.str), vt.struct("Key"))
                ],
                keyArr
              )
            ),
            "keys == sortedBy(keys, k => k.name)"
          )
        ]
      })
    ])
  ],
  ["Al", "FileAl", "Grp", "Virt", "Derived", "Keys"]
);

/** The same features through the frontend's syntax, and slice carriers. */
const SOURCE = `
struct Header { u16 a  u16 b }
struct Footer { u32 c }
export struct Overlay {
  u8     raw[8] @hidden
  Header hdr  from raw[0..4]
  Footer foot from raw[4..8]
}
export struct OverlayRest {
  u8     raw[] @hidden
  Header hdr  from raw[0..4]
  Footer foot from raw[4..8]
}
struct Model { u8 x }
struct Rec { u8 v  Model *model : u8 @nullable }
export struct Idx {
  u8  n
  Rec records[n]
  u8  s
  u8  index[s] = indicesWhere(records, r => r.model != null)
}
export struct Node {
  u8  sizeHigh
  u32 sizeLow
  virtual u40 size = (sizeHigh << 32) | sizeLow
}
struct Pt { u8 v }
struct Vol { Pt *a : u8  Pt *b : u8 }
export struct Grp {
  u8  n
  Vol vols[n]
  layout {
    vols[*] { b a }
  }
}
export struct Al {
  u8 a
  u8 head[3] @align(4, offset: 1)
  u8 mid
  @padUntil(4, strict) { u8 z }
}
`;

function realProgram() {
  const r = compileSource(SOURCE, "/memory/layout-virtual-derived.yfl");
  if (!r.program) throw new Error(JSON.stringify(r.diagnostics, null, 1));
  return r.program;
}

describe.skipIf(!hasRust)(
  "rust backend: groups, virtual fields and derived arrays (frontend)",
  () => {
    let b: Built;
    beforeAll(async () => {
      b = await build("yaffle_t_lvd_src", [{ name: "s", program: realProgram(), views: true }]);
    }, 600_000);

    const rt = async (root: string, bytes: string, json: unknown) => {
      expect(await b.value({ op: "parse", module: "s", root, bytes })).toEqual(json);
      expect(await b.value({ op: "serialize", module: "s", root, json })).toBe(bytes);
      expect(await b.value({ op: "view:rt", module: "s", root, bytes })).toEqual({
        json,
        rt: { hex: bytes }
      });
    };

    it("compiles without warnings", () => {
      expect(b.warnings, b.log).toBe(0);
    });

    it("assembles slice carriers on write", async () => {
      await rt("Overlay", "0100" + "0200" + "03000000", { hdr: { a: 1, b: 2 }, foot: { c: 3 } });
      await rt("OverlayRest", "0100" + "0200" + "03000000", {
        hdr: { a: 1, b: 2 },
        foot: { c: 3 }
      });
    });

    it("derives arrays over nullable pointers", async () => {
      // records[1] has a model: index = [1].
      const json = {
        n: 2,
        records: [
          { v: 7, model: null },
          { v: 8, model: { x: 9 } }
        ],
        s: 1,
        index: "01"
      };
      const bytes = "02" + "0700" + "0807" + "01" + "01" + "09";
      await rt("Idx", bytes, json);
    });

    it("reads and writes virtual fields", async () => {
      await rt("Node", "01" + "02000000", { sizeHigh: 1, sizeLow: 2, size: 4294967298 });
      expect(
        await b.value({ op: "serialize", module: "s", root: "Node", json: { size: 0x0300000004 } })
      ).toBe("03" + "04000000");
    });

    it("places targets per element and aligns with offsets and strict fill", async () => {
      await rt("Grp", "02" + "06" + "05" + "08" + "07" + "02" + "01" + "04" + "03", {
        n: 2,
        vols: [
          { a: { v: 1 }, b: { v: 2 } },
          { a: { v: 3 }, b: { v: 4 } }
        ]
      });
      await rt("Al", "01" + "0000" + "aabbcc" + "06" + "05" + "000000", {
        a: 1,
        head: "aabbcc",
        mid: 6,
        z: 5
      });
      expect(
        (await b.error({ op: "parse", module: "s", root: "Al", bytes: "010000aabbcc0605000001" }))
          .code
      ).toBe("CHECK");
    });
  }
);

describe.skipIf(!hasRust)("rust backend: groups, virtual fields and derived arrays (IR)", () => {
  let b: Built;
  beforeAll(async () => {
    b = await build("yaffle_t_lvd", [{ name: "w", program: prog, views: true }]);
  }, 600_000);

  /** Parse, serialize back, and the same through the view. */
  const rt = async (root: string, bytes: string, json: unknown) => {
    expect(await b.value({ op: "parse", module: "w", root, bytes })).toEqual(json);
    expect(await b.value({ op: "serialize", module: "w", root, json })).toBe(bytes);
    expect(await b.value({ op: "view:rt", module: "w", root, bytes })).toEqual({
      json,
      rt: { hex: bytes }
    });
  };

  it("compiles without warnings", () => {
    expect(b.warnings, b.log).toBe(0);
  });

  it("aligns with an offset and checks strict padding", async () => {
    // (1 + 1) % 4 → 2 bytes of padding before b; c is padded to 2 bytes, checked.
    await rt("Al", "01" + "0000" + "aabbcc" + "05" + "00", { a: 1, b: "aabbcc", c: 5 });
    const err = await b.error({ op: "parse", module: "w", root: "Al", bytes: "010000aabbcc0507" });
    expect([err.code, err.path]).toEqual(["CHECK", ["c"]]);
    const verr = await b.error({
      op: "view:rt",
      module: "w",
      root: "Al",
      bytes: "010000aabbcc0507"
    });
    expect([verr.code, verr.path]).toEqual(["CHECK", ["c"]]);
  });

  it("aligns from the file inside a @base", async () => {
    // Inner is at 3: y aligns to 4 from the file (no padding), not to 3 + 4 from its base.
    await rt("FileAl", "aabbcc" + "01" + "02", { pre: "aabbcc", inner: { x: 1, y: 2 } });
  });

  it("places targets per element with layout groups", async () => {
    // this = n, a0, b0, a1, b1; then b0 a0 b1 a1.
    await rt("Grp", "02" + "06" + "05" + "08" + "07" + "02" + "01" + "04" + "03", {
      n: 2,
      vols: [
        { a: { v: 1 }, b: { v: 2 } },
        { a: { v: 3 }, b: { v: 4 } }
      ]
    });
  });

  it("derives the parts of virtual fields", async () => {
    await rt("Virt", "0102", { hi: 1, lo: 2, size: 258 });
    expect(
      await b.value({ op: "serialize", module: "w", root: "Virt", json: { size: 0xabcd } })
    ).toBe("abcd");
  });

  it("derives arrays and checks rules with lambdas", async () => {
    const json = {
      n: 5,
      vals: "0105020703",
      k: 2,
      big: "0507",
      sorted: "0102030507",
      idx: [1, 3],
      dbl: [2, 10, 4, 14, 6],
      m: 5,
      u: "0105020703"
    };
    const bytes =
      "05" +
      "0105020703" +
      "02" +
      "0507" +
      "0102030507" +
      "01000300" +
      "02000a0004000e000600" +
      "05" +
      "0105020703";
    await rt("Derived", bytes, json);
    expect(
      await b.value({
        op: "serialize",
        module: "w",
        root: "Derived",
        json: { vals: "0105020703", sorted: "0102030507" }
      })
    ).toBe(bytes);
    // An unsorted `sorted` fails its check on read and on write.
    const bad = bytes.replace("0102030507", "0201030507");
    expect((await b.error({ op: "parse", module: "w", root: "Derived", bytes: bad })).code).toBe(
      "CHECK"
    );
    expect(
      (
        await b.error({
          op: "serialize",
          module: "w",
          root: "Derived",
          json: { vals: "0105020703", sorted: "0201030507" }
        })
      ).code
    ).toBe("CHECK");
  });

  it("compares struct arrays by value", async () => {
    await rt("Keys", "02" + "6100" + "6200", { n: 2, keys: [{ name: "a" }, { name: "b" }] });
    const err = await b.error({
      op: "parse",
      module: "w",
      root: "Keys",
      bytes: "02" + "6200" + "6100"
    });
    expect([err.code, err.path]).toEqual(["CHECK", ["keys"]]);
  });
});
