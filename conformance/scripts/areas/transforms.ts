/** Cases for conformance/cases/transforms. */
import { area, parse, parseOnly, perr, ser, serr, w, type Case } from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);

add(
  parse("angle quarter turn", "Angle", w().u16(16384), { angle: 90 }),
  parse("angle smallest step", "Angle", w().u16(1), { angle: 360 / 65536 }),
  parse("angle zero", "Angle", w().u16(0), { angle: 0 }),
  parse("angle max", "Angle", w().u16(65535), { angle: (65535 * 360) / 65536 }),
  ser("angle inferred inverse", "Angle", { angle: 180 }, w().u16(32768)),
  ser(
    "angle inferred inverse of the max",
    "Angle",
    { angle: (65535 * 360) / 65536 },
    w().u16(65535)
  ),
  serr("angle out of range", "Angle", { angle: 400 }, "RANGE", ["angle"]),

  parse("offset transform", "Offset", "05", { v: 105 }),
  ser("offset inverse", "Offset", { v: 150 }, "32"),
  serr("offset inverse below the raw range", "Offset", { v: 99 }, "RANGE", ["v"]),
  serr("offset inverse above the raw range", "Offset", { v: 356 }, "RANGE", ["v"]),

  parse("affine transform", "Affine", "03", { v: 8 }),
  ser("affine inverse", "Affine", { v: 8 }, "03"),
  serr("affine value that doesn't round trip", "Affine", { v: 7 }, "INPUT", ["v"]),
  serr("affine inverse negative", "Affine", { v: 0 }, "RANGE", ["v"]),

  parse("fixed point positive", "Fixed", w().int(16, 384), { x: 1.5 }),
  parse("fixed point negative", "Fixed", w().int(16, -256), { x: -1 }),
  ser("fixed point inverse", "Fixed", { x: -0.5 }, w().int(16, -128)),
  ser("fixed point inverse max", "Fixed", { x: 32767 / 256 }, w().int(16, 32767))
);

const names = w().u8(3).cstr("zero").cstr("one").cstr("two");
add(
  parse("lookup by index", "Names", w().raw(names).u8(2), {
    n: 3,
    names: ["zero", "one", "two"],
    pick: "two"
  }),
  ser(
    "lookup inverse is indexOf",
    "Names",
    { names: ["zero", "one", "two"], pick: "one" },
    w().raw(names).u8(1)
  ),
  ser(
    "lookup inverse takes the first match",
    "Names",
    { names: ["a", "a"], pick: "a" },
    w().u8(2).cstr("a").cstr("a").u8(0)
  ),
  serr("lookup inverse of a missing value", "Names", { names: ["zero"], pick: "four" }, "INPUT", [
    "pick"
  ]),
  perr("lookup index out of range", "Names", w().raw(names).u8(5), "RANGE", ["pick"]),

  parse("explicit inverse via extern fn", "Explicit", "3412", { v: 0x3412 }),
  ser("explicit inverse on write", "Explicit", { v: 0x3412 }, "3412"),
  ser("explicit inverse zero", "Explicit", { v: 0x00ff }, "00ff"),

  parse("one-way transform JSON is the raw value", "OneWay", "2a", { v: 42 }),
  ser("one-way transform input is the raw value", "OneWay", { v: 42 }, "2a"),
  parse("one-way bool JSON is raw (false)", "OneWayBool", "00", { b: 0 }),
  parse("one-way bool JSON is raw (true)", "OneWayBool", "05", { b: 5 }),
  ser("one-way bool input is raw", "OneWayBool", { b: 5 }, "05"),

  parse("normalize keeps an already normal value", "Normalize", "81", { flags: 0x81 }),
  parseOnly("normalize reads the raw value", "Normalize", "01", { flags: 1 }),
  ser("normalize on write", "Normalize", { flags: 1 }, "81"),

  parse("transformed elements", "DegList", "02 0a14", { n: 2, vals: [20, 40] }),
  ser("transformed elements inverse", "DegList", { vals: [4, 6] }, "02 0203"),
  serr("transformed element that doesn't round trip", "DegList", { vals: [3] }, "INPUT", [
    "vals",
    0
  ])
);

export default area(
  "transforms",
  "`as`/`=` transforms: inferred integer/float inverses, lookups, extern fn inverses, one-way, normalization.",
  cases
);
