/** Cases for conformance/cases/endianness. */
import { area, parse, parseOnly, perr, ser, serr, w, type Case, type Endian } from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);

const inner = (x: number, y: number, e: Endian) => w().u16(x, e).u32(y, e);
const innerJ = (x: number, y: number) => ({ x, y });
const be = { args: { endian: "be" } };

add(
  parse(
    "nested inherits le",
    "Nested",
    w()
      .raw(inner(0x0102, 0x03040506, "le"))
      .u16(0x0708, "be"),
    { a: innerJ(0x0102, 0x03040506), b: 0x0708 }
  ),
  parse(
    "nested inherits root be",
    "Nested",
    w()
      .raw(inner(0x0102, 0x03040506, "be"))
      .u16(0x0708, "be"),
    { a: innerJ(0x0102, 0x03040506), b: 0x0708 },
    be
  ),
  ser(
    "nested serialize le",
    "Nested",
    { a: innerJ(1, 2), b: 3 },
    w()
      .raw(inner(1, 2, "le"))
      .u16(3, "be")
  ),
  ser(
    "nested serialize be",
    "Nested",
    { a: innerJ(1, 2), b: 3 },
    w()
      .raw(inner(1, 2, "be"))
      .u16(3, "be"),
    be
  ),
  parse(
    "block switches to be and back",
    "BlockBe",
    w()
      .raw(inner(1, 2, "le"))
      .raw(inner(3, 4, "be"))
      .u16(5, "be")
      .u16(6, "le"),
    { a: innerJ(1, 2), b: innerJ(3, 4), c: 5, d: 6 }
  ),
  parse(
    "block be under root be",
    "BlockBe",
    w()
      .raw(inner(1, 2, "be"))
      .raw(inner(3, 4, "be"))
      .u16(5, "be")
      .u16(6, "be"),
    { a: innerJ(1, 2), b: innerJ(3, 4), c: 5, d: 6 },
    be
  ),
  parse(
    "field attribute be",
    "FieldBe",
    w()
      .raw(inner(1, 2, "be"))
      .raw(inner(3, 4, "le")),
    { a: innerJ(1, 2), b: innerJ(3, 4) }
  ),
  parse(
    "field attribute be under root be",
    "FieldBe",
    w()
      .raw(inner(1, 2, "be"))
      .raw(inner(3, 4, "be")),
    { a: innerJ(1, 2), b: innerJ(3, 4) },
    be
  ),
  parse(
    "struct attribute be",
    "StructBe",
    w()
      .u16(0x0a0b, "be")
      .raw(inner(1, 2, "be"))
      .raw(inner(3, 4, "le")),
    { s: { x: 0x0a0b, inner: innerJ(1, 2) }, t: innerJ(3, 4) }
  ),
  parse(
    "struct attribute be ignores root le explicitly",
    "StructBe",
    w()
      .u16(0x0a0b, "be")
      .raw(inner(1, 2, "be"))
      .raw(inner(3, 4, "le")),
    { s: { x: 0x0a0b, inner: innerJ(1, 2) }, t: innerJ(3, 4) },
    { args: { endian: "le" } }
  ),
  parse(
    "fixed suffixes keep their order",
    "Fixed",
    w().u16(1, "le").u16(2, "be").u16(3, "be").u16(4, "le").u16(5, "be").u16(6, "le"),
    { f: { l: 1, b: 2, i: 3 }, g: { l: 4, b: 5, i: 6 } }
  ),
  parse(
    "fixed suffixes under root be",
    "Fixed",
    w().u16(1, "le").u16(2, "be").u16(3, "be").u16(4, "le").u16(5, "be").u16(6, "be"),
    { f: { l: 1, b: 2, i: 3 }, g: { l: 4, b: 5, i: 6 } },
    be
  ),
  parse(
    "probe flag 0 is le",
    "Probe",
    w()
      .u8(0)
      .u16(0x1234)
      .raw(inner(5, 6, "le")),
    { flag: 0, v: 0x1234, s: innerJ(5, 6) }
  ),
  parse(
    "probe flag 1 is be",
    "Probe",
    w()
      .u8(1)
      .u16(0x1234, "be")
      .raw(inner(5, 6, "be")),
    { flag: 1, v: 0x1234, s: innerJ(5, 6) }
  ),
  parse(
    "probe flag 0 ignores root be",
    "Probe",
    w()
      .u8(0)
      .u16(0x1234)
      .raw(inner(5, 6, "le")),
    { flag: 0, v: 0x1234, s: innerJ(5, 6) },
    be
  ),
  ser(
    "probe serialize be",
    "Probe",
    { flag: 7, v: 1, s: innerJ(2, 3) },
    w()
      .u8(7)
      .u16(1, "be")
      .raw(inner(2, 3, "be"))
  ),
  parse(
    "nested blocks: innermost wins",
    "NestedBlocks",
    w().u16(1, "be").u16(2, "le").u16(3, "be"),
    { a: 1, b: 2, c: 3 }
  ),
  parse(
    "widths le",
    "Widths",
    w().u24(0x010203).int(40, -2).u48(0x0a0b0c0d0e0f).f32(1.5).f64(-2.25).f16(0.5),
    { a: 0x010203, b: -2, c: 0x0a0b0c0d0e0f, d: 1.5, e: -2.25, f: 0.5 }
  ),
  parse(
    "widths be",
    "Widths",
    w()
      .u24(0x010203, "be")
      .int(40, -2, "be")
      .u48(0x0a0b0c0d0e0f, "be")
      .f32(1.5, "be")
      .f64(-2.25, "be")
      .f16(0.5, "be"),
    { a: 0x010203, b: -2, c: 0x0a0b0c0d0e0f, d: 1.5, e: -2.25, f: 0.5 },
    be
  )
);

// ── TIFF ────────────────────────────────────────────────────────────────────────────────────────
const tiff = (e: Endian, ifdOfs = 8) => {
  const b = w()
    .text(e === "le" ? "II" : "MM")
    .u16(42, e)
    .u32(ifdOfs, e);
  b.padTo(ifdOfs);
  b.u16(2, e);
  b.u16(256, e).u16(3, e).u32(1, e).u32(640, e);
  b.u16(257, e).u16(4, e).u32(1, e).u32(0x01020304, e);
  b.u32(0, e);
  return b;
};
const tiffJson = (order: string, firstIfd = 8) => ({
  order,
  magic: 42,
  firstIfd,
  ifd: {
    count: 2,
    entries: [
      { tag: 256, type: 3, count: 1, value: 640 },
      { tag: 257, type: 4, count: 1, value: 0x01020304 }
    ],
    next: 0
  }
});
const tiffInput = (order: string) => {
  const j = tiffJson(order) as Record<string, unknown>;
  delete j.magic;
  delete j.firstIfd;
  const ifd = { ...(j.ifd as Record<string, unknown>) };
  delete ifd.count;
  j.ifd = ifd;
  return j;
};
add(
  parse("tiff little endian", "Tiff", tiff("le"), tiffJson("II")),
  parse("tiff big endian", "Tiff", tiff("be"), tiffJson("MM")),
  parse("tiff big endian ignores root le", "Tiff", tiff("be"), tiffJson("MM"), {
    args: { endian: "le" }
  }),
  parseOnly("tiff with the IFD after a gap", "Tiff", tiff("be", 0x10), tiffJson("MM", 0x10)),
  ser("tiff serialize II places the IFD after the header", "Tiff", tiffInput("II"), tiff("le")),
  ser("tiff serialize MM", "Tiff", tiffInput("MM"), tiff("be")),
  perr("tiff bad byte order", "Tiff", w().text("XX").u16(42).u32(8), "CHECK", ["order"]),
  perr(
    "tiff wrong magic for the byte order",
    "Tiff",
    w().text("MM").u16(42, "le").u32(8, "be"),
    "CHECK",
    ["magic"]
  ),
  // The path is left out: a reader may notice the target is outside the data before reading it.
  perr("tiff IFD past the end", "Tiff", w().text("II").u16(42).u32(0x100), "EOF"),
  serr("tiff serialize bad byte order", "Tiff", { ...tiffInput("II"), order: "XY" }, "CHECK", [
    "order"
  ])
);

add(
  parse("$endian tested inside a be block", "EndianCond", w().u8(5).u16(0x0102, "be"), {
    a: 5,
    marker: 0x0102
  }),
  parse(
    "$endian tested at a be root",
    "EndianCond",
    w().u8(5).u16(0x0102, "be").u8(7),
    { a: 5, marker: 0x0102, rootIsBe: 7 },
    be
  ),
  ser(
    "$endian on write",
    "EndianCond",
    { a: 1, marker: 2, rootIsBe: 3 },
    w().u8(1).u16(2, "be").u8(3),
    be
  )
);

export default area(
  "endianness",
  "Inherited $endian through nested structs, @endian on blocks/fields/structs, field-driven endianness (TIFF).",
  cases
);
