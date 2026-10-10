/**
 * IR features checked from hand-written IR: the sources are compiled without the syntax and the
 * IR is patched (layout groups, alignment origin and offset, virtual fields, strict padding,
 * derived arrays, slice carriers). Parse, serialize and views are checked.
 */
import type {
  IrExpr,
  IrField,
  IrMember,
  IrProgram,
  IrStruct,
  IrValueType
} from "../../../src/ir/index.ts";
import { describeJava } from "./harness.ts";

const schema = `
struct Inner @base {
  u8  a
  u32 b @align(4)
}

export struct AlignFile {
  u8    pad[3]
  Inner inner
}

export struct AlignOffset {
  u8 n
  u8 head[3] @align(4)
  u8 tail
}

export struct StrictPad {
  u16 a @padAfter(2)
  u8  b
}

export struct Virt {
  u8  sizeHigh
  u32 sizeLow
  u8  tail
}

export struct Derived {
  u8 n
  u8 vals[n]
  u8 m
  u8 big[m]
  u8 k
  u8 doubled[k]
  u8 j
  u8 uq[j]
}

struct Vol {
  u32 oa
  u32 ob
  u8  x[2] at oa
  u8  y[2] at ob
}

export struct Groups {
  Vol vols[2]
}

struct P {
  u16 a
  u16 b
}

export struct Carrier {
  u8 raw[8]
  P  first  from raw[0..4]
  P  second from raw[4..8]
}

export struct Overlap {
  u8 raw[6]
  P  first  from raw[0..4]
  P  second from raw[2..6]
}
`;

// ── IR helpers ──────────────────────────────────────────────────────────────────

const u = (bits: 8 | 16 | 32 | 40 | 64, signed = false): IrValueType => ({
  kind: "int",
  bits,
  signed
});
const big: IrValueType = { kind: "bigint" };
const lit = (v: number | bigint, type: IrValueType = big): IrExpr => ({
  kind: "literal",
  value: { kind: "int", value: String(v) },
  type
});
const fld = (name: string, type: IrValueType): IrExpr => ({ kind: "field", name, type });
const bin = (
  op: Extract<IrExpr, { kind: "binary" }>["op"],
  left: IrExpr,
  right: IrExpr,
  type: IrValueType = big
): IrExpr => ({ kind: "binary", op, left, right, type });
const call = (
  name: Extract<Extract<IrExpr, { kind: "call" }>["callee"], { kind: "builtin" }>["name"],
  args: IrExpr[],
  type: IrValueType
): IrExpr => ({ kind: "call", callee: { kind: "builtin", name }, args, type });
const lambda = (param: string, type: IrValueType, body: IrExpr): IrExpr => ({
  kind: "lambda",
  param,
  type,
  body
});
const lp = (name: string, type: IrValueType): IrExpr => ({ kind: "lambdaParam", name, type });
const arr = (element: IrValueType): IrValueType => ({ kind: "array", element });

function struct(p: IrProgram, id: string): IrStruct {
  const s = p.structs.find(x => x.id === id);
  if (!s) throw new Error(`no struct ${id}`);
  return s;
}

function field(s: IrStruct, name: string): IrField {
  const f = s.members.find((m): m is IrField => m.kind === "field" && m.name === name);
  if (!f) throw new Error(`no field ${name} in ${s.id}`);
  return f;
}

function layerOf(f: IrField, kind: string): Record<string, unknown> {
  if (f.type.kind !== "layered") throw new Error(`${f.name} has no layers`);
  const l = f.type.layers.find(x => x.kind === kind);
  if (!l) throw new Error(`${f.name} has no ${kind} layer`);
  return l as unknown as Record<string, unknown>;
}

function patch(p: IrProgram): IrProgram {
  // Alignment from the file start, and with an offset.
  layerOf(field(struct(p, "Inner"), "b"), "align").from = "file";
  layerOf(field(struct(p, "AlignOffset"), "head"), "align").offset = lit(3);
  // This padding's fill is checked outside strict mode.
  layerOf(field(struct(p, "StrictPad"), "a"), "padAfter").strict = true;

  // virtual u40 size = (sizeHigh << 32) | sizeLow; the parts derive from it.
  const v = struct(p, "Virt");
  const hi = field(v, "sizeHigh");
  const lo = field(v, "sizeLow");
  const size = fld("size", u(40));
  Object.assign(hi, { derive: bin(">>", size, lit(32)), deriveKind: "formula", input: "absent" });
  Object.assign(lo, {
    derive: bin("&", size, lit(0xffffffff)),
    deriveKind: "formula",
    input: "absent"
  });
  const virt: IrField = {
    kind: "field",
    name: "size",
    source: lo.source,
    type: { kind: "prim", prim: "u40", endian: "inherit" },
    checks: [],
    hidden: false,
    output: true,
    input: "required",
    virtual: {
      read: bin("|", bin("<<", fld("sizeHigh", u(8)), lit(32)), fld("sizeLow", u(32)))
    }
  };
  v.members.splice(v.members.indexOf(lo) + 1, 0, virt);

  // Derived arrays and a check stating a rule.
  const d = struct(p, "Derived");
  const bytes: IrValueType = { kind: "bytes" };
  const vals = fld("vals", bytes);
  Object.assign(field(d, "big"), {
    derive: call(
      "indicesWhere",
      [vals, lambda("v", u(8), bin(">", lp("v", u(8)), lit(10), { kind: "bool" }))],
      arr(u(32))
    ),
    deriveKind: "formula",
    input: "absent"
  });
  Object.assign(field(d, "doubled"), {
    derive: call(
      "map",
      [
        call(
          "filter",
          [vals, lambda("v", u(8), bin("<", lp("v", u(8)), lit(12), { kind: "bool" }))],
          arr(u(8))
        ),
        lambda("w", u(8), bin("*", lp("w", u(8)), lit(2)))
      ],
      arr(big)
    ),
    deriveKind: "formula",
    input: "absent"
  });
  Object.assign(field(d, "uq"), {
    derive: call("unique", [call("concat", [vals, vals], arr(u(8)))], arr(u(8))),
    deriveKind: "formula",
    input: "absent"
  });
  field(d, "vals").checks.push({
    expr: bin(
      "==",
      { kind: "it", type: bytes },
      call("sortedBy", [{ kind: "it", type: bytes }, lambda("x", u(8), lp("x", u(8)))], arr(u(8))),
      { kind: "bool" }
    ),
    message: "vals are sorted",
    strictOnly: false
  });

  // Layout groups: for each volume, y then x.
  struct(p, "Groups").layout = [
    {
      path: [{ kind: "field", name: "vols" }],
      layers: [],
      group: {
        items: [
          { path: [{ kind: "field", name: "y" }], layers: [] },
          { path: [{ kind: "field", name: "x" }], layers: [] }
        ]
      }
    }
  ];

  // The sliced field is assembled from its slices.
  for (const id of ["Carrier", "Overlap"]) {
    Object.assign(field(struct(p, id), "raw"), {
      carrier: "slices",
      input: "absent",
      hidden: true,
      output: false
    });
    for (const m of struct(p, id).members as IrMember[]) {
      if (m.kind === "field" && m.from) m.input = "required";
    }
  }
  return p;
}

const helpers = `
  static String js(Object o) {
    return org.yafflelang.runtime.Json.write(o);
  }
`;

/** Parse, view and serialize round trip of one root. */
const roundTrip = (root: string, hexIn: string, json: string): string => `
    byte[] b = hex("${hexIn}");
    ${root} v = ${root}.parse(b);
    json(${JSON.stringify(json)}, ${root}.toJson(v));
    eq("${hexIn}", hex(${root}.serialize(${root}.fromJson(${root}.toJson(v)))));
    ${root}.View w = ${root}.view(b);
    json(${JSON.stringify(json)}, ${root}.toJson((${root}) org.yafflelang.runtime.ViewRead.materialize(w)));
    eq("${hexIn}", hex(w.commit()));
`;

const tests: Record<string, string> = {
  "align from the file start inside a base": roundTrip(
    "AlignFile",
    "000000aa11223344",
    `{"pad":"000000","inner":{"a":170,"b":1144201745}}`
  ),
  "align with an offset": roundTrip(
    "AlignOffset",
    "01aabbccdd",
    `{"n":1,"head":"aabbcc","tail":221}`
  ),
  "strict padding is checked outside strict mode": `
    json("{\\"a\\":4660,\\"b\\":5}", StrictPad.toJson(StrictPad.parse(hex("3412000005"))));
    path("[\\"a\\"]", fails("CHECK", () -> StrictPad.parse(hex("3412000105"))));
    path("[\\"a\\"]", fails("CHECK", () -> StrictPad.view(hex("3412000105")).getA()));
  `,
  "virtual fields read from their parts": roundTrip(
    "Virt",
    "014433221107",
    `{"sizeHigh":1,"sizeLow":287454020,"size":4582421316,"tail":7}`
  ),
  "the parts derive from a virtual field": `
    eq("024433221107", hex(Virt.serialize(Virt.fromJson(org.yafflelang.runtime.Json.parse("{\\"size\\":8877388612,\\"tail\\":7}")))));
    fails("RANGE", () -> Virt.serialize(Virt.fromJson(org.yafflelang.runtime.Json.parse("{\\"size\\":1099511627776,\\"tail\\":7}"))));
  `,
  "a virtual field edited through a view": `
    Virt.View v = Virt.view(hex("014433221107"));
    v.setSize(0x0300000005L);
    eq("030500000007", hex(v.commit()));
  `,
  "derived arrays": roundTrip(
    "Derived",
    "03050b0c020102020a160305 0b0c".replace(/ /g, ""),
    `{"n":3,"vals":"050b0c","m":2,"big":"0102","k":2,"doubled":"0a16","j":3,"uq":"050b0c"}`
  ),
  "derived arrays on write": `
    Derived d = Derived.fromJson(org.yafflelang.runtime.Json.parse("{\\"vals\\":\\"01141e1e\\"}"));
    eq("04" + "01141e1e" + "03" + "010203" + "01" + "02" + "03" + "01141e", hex(Derived.serialize(d)));
  `,
  "a check stating a rule": `
    path("[\\"vals\\"]", fails("CHECK", () -> Derived.parse(hex("020b05010000000000"))));
    fails("CHECK", () -> Derived.serialize(Derived.fromJson(org.yafflelang.runtime.Json.parse("{\\"vals\\":\\"0b05\\"}"))));
  `,
  "layout groups place each element's items in order": `
    Groups g = Groups.fromJson(org.yafflelang.runtime.Json.parse("{\\"vols\\":[{\\"x\\":\\"0102\\",\\"y\\":\\"0304\\"},{\\"x\\":\\"0506\\",\\"y\\":\\"0708\\"}]}"));
    byte[] b = Groups.serialize(g);
    eq("12000000100000001600000014000000" + "0304" + "0102" + "0708" + "0506", hex(b));
    json("{\\"vols\\":[{\\"oa\\":18,\\"ob\\":16,\\"x\\":\\"0102\\",\\"y\\":\\"0304\\"},{\\"oa\\":22,\\"ob\\":20,\\"x\\":\\"0506\\",\\"y\\":\\"0708\\"}]}", Groups.toJson(Groups.parse(b)));
    Groups.View v = Groups.view(b);
    v.getVols().get(0).setX(hex("0a0b"));
    Groups p = Groups.parse(v.commit());
    eq("0a0b", hex(p.vols.get(0).x));
    eq("0708", hex(p.vols.get(1).y));
  `,
  "slice carriers are assembled from their slices": `
    Carrier c = Carrier.fromJson(org.yafflelang.runtime.Json.parse("{\\"first\\":{\\"a\\":1,\\"b\\":2},\\"second\\":{\\"a\\":3,\\"b\\":4}}"));
    eq("0100020003000400", hex(Carrier.serialize(c)));
    json("{\\"first\\":{\\"a\\":1,\\"b\\":2},\\"second\\":{\\"a\\":3,\\"b\\":4}}", Carrier.toJson(Carrier.parse(hex("0100020003000400"))));
    Carrier.View v = Carrier.view(hex("0100020003000400"));
    v.getSecond().setB(9);
    eq("0100020003000900", hex(v.commit()));
  `,
  "overlapping slices must agree": `
    eq("010002000300", hex(Overlap.serialize(Overlap.fromJson(org.yafflelang.runtime.Json.parse("{\\"first\\":{\\"a\\":1,\\"b\\":2},\\"second\\":{\\"a\\":2,\\"b\\":3}}")))));
    fails("DERIVE", () -> Overlap.serialize(Overlap.fromJson(org.yafflelang.runtime.Json.parse("{\\"first\\":{\\"a\\":1,\\"b\\":2},\\"second\\":{\\"a\\":9,\\"b\\":3}}"))));
  `
};

describeJava("java IR features from patched IR", "ir-features", { "doc.yfl": schema }, tests, {
  helpers,
  transform: patch
});
