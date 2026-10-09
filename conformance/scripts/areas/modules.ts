/** Cases for conformance/cases/modules (schema.yfl imports common.yfl, shapes.yfl, cycle.yfl). */
import { area, parse, perr, ser, serr, w, type Case } from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);

/** The FourCC in the schema's FourCC struct, and its value read as a little- and big-endian u32. */
const FOURCC = "ARCV";
const fourccLe = Buffer.from(FOURCC, "latin1").readUInt32LE(0);
const fourccBe = Buffer.from(FOURCC, "latin1").readUInt32BE(0);

const imports = w().u16(1).u16(2).u8(1).u16(3).u16(4).text("ab").zeros(2).u32(0x800).u8(3);
add(
  parse("named imports", "Imports", imports, {
    p: { x: 1, y: 2 },
    pts: { n: 1, items: [{ x: 3, y: 4 }] },
    n: "ab",
    sector: 2048,
    version: 3
  }),
  ser(
    "named imports on write",
    "Imports",
    { p: { x: 1, y: 2 }, pts: { items: [{ x: 3, y: 4 }] }, n: "ab" },
    imports
  ),
  perr(
    "imported constant checked",
    "Imports",
    w().u16(1).u16(2).u8(0).text("ab").zeros(2).u32(0x400).u8(3),
    "CHECK",
    ["sector"]
  ),
  parse("an exported struct of an imported module is a root too", "Pt", w().u16(5).u16(6), {
    x: 5,
    y: 6
  }),
  parse("namespace import", "Namespaced", "0203 02", { r: { w: 2, h: 3 }, c: "Green" }),
  ser("namespace import on write", "Namespaced", { r: { w: 1, h: 1 }, c: "Red" }, "0101 01"),
  parse("cross-file cycle, null", "Cycle", "01 0a00", { f: { v: 10, back: null } }),
  parse("cross-file cycle", "Cycle", "01 0a03 0b01", {
    f: { v: 10, back: { w: 11, fwd: { $ref: "/f" } } }
  }),
  ser(
    "cross-file cycle on write",
    "Cycle",
    { f: { v: 1, back: { w: 2, fwd: null } } },
    "01 0103 0200"
  ),
  parse("non-exported struct through an exported one", "Reexport", "07", {
    u: { p: { secret: 7 } }
  }),
  parse("constants folded into expressions", "ConstExpr", "0800 01020304", {
    pages: 8,
    data: "01020304"
  }),
  serr("constant length from an import", "ConstExpr", { data: "010203" }, "DERIVE", ["data"])
);

const numbers = w().u32(0x4c434150).u8(0b1010).u32(1_000_000).i8(-5).u16(0xffff);
add(
  parse("number literals", "Numbers", numbers, {
    hex: 0x4c434150,
    bin: 10,
    dec: 1000000,
    neg: -5,
    big: 65535
  }),
  ser("number literals on write", "Numbers", {}, numbers),
  perr(
    "binary literal checked",
    "Numbers",
    w().u32(0x4c434150).u8(0b1011).u32(1_000_000).i8(-5).u16(0xffff),
    "CHECK",
    ["bin"]
  ),
  parse("byte literals", "ByteLiterals", "5f2a91c3 010203", {
    hex: "5f2a91c3",
    b64: "010203",
    empty: ""
  }),
  ser("byte literals on write", "ByteLiterals", {}, "5f2a91c3 010203"),
  perr("base64 literal checked", "ByteLiterals", "5f2a91c3 010204", "CHECK", ["b64"]),
  parse(
    "fourcc is written order in every endianness",
    "FourCC",
    w().text(FOURCC).text(FOURCC).text(FOURCC),
    { inherited: fourccLe, big: fourccBe, fixedBe: fourccBe }
  ),
  ser("fourcc on write", "FourCC", {}, w().text(FOURCC).text(FOURCC).text(FOURCC)),
  ser("fourcc under root be", "FourCC", {}, w().text(FOURCC).text(FOURCC).text(FOURCC), {
    args: { endian: "be" }
  }),
  perr(
    "fourcc checked",
    "FourCC",
    w()
      .text([...FOURCC].reverse().join(""))
      .text(FOURCC)
      .text(FOURCC),
    "CHECK",
    ["inherited"]
  ),
  parse("string literals", "Strings", w().text("CHNK").cstr("hi"), { tag: "CHNK", word: "hi" }),
  perr("string literal checked", "Strings", w().text("CHNK").cstr("ho"), "CHECK", ["word"])
);

export default area(
  "modules",
  "Named/namespace imports, exported constants, cross-file generics/aliases/cycles, every literal form.",
  cases
);
