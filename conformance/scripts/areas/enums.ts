/** Cases for conformance/cases/enums. */
import { area, parse, perr, ser, serr, w, type Case } from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);

add(
  parse("closed enum first member", "E", "0000", { kind: "Sys" }),
  parse("closed enum second member", "E", "0100", { kind: "Vram" }),
  parse("closed enum hex value", "E", "1000", { kind: "Other" }),
  perr("closed enum unknown value", "E", "0200", "CHECK", ["kind"]),
  ser("closed enum write by name", "E", { kind: "Vram" }, "0100"),
  serr("closed enum write unknown name", "E", { kind: "Nope" }, "INPUT", ["kind"]),
  serr("closed enum write a number", "E", { kind: 1 }, "INPUT", ["kind"]),
  parse("enum follows endianness", "EBe", "0010", { kind: "Other" }),
  parse("enum follows root be", "E", "0001", { kind: "Vram" }, { args: { endian: "be" } }),
  ser("enum writes be", "EBe", { kind: "Vram" }, "0001"),

  parse("open enum member", "O", "01", { o: "A" }),
  parse("open enum unknown passes through", "O", "03", { o: 3 }),
  parse("open enum zero is unknown", "O", "00", { o: 0 }),
  ser("open enum write a member", "O", { o: "B" }, "02"),
  ser("open enum write a number", "O", { o: 7 }, "07"),
  ser("open enum write a member's number", "O", { o: 2 }, "02"),
  serr("open enum number out of range", "O", { o: 256 }, "RANGE", ["o"]),
  serr("open enum unknown name", "O", { o: "C" }, "INPUT", ["o"]),

  parse("signed enum negative", "S", "ff", { s: "Neg" }),
  parse("signed enum positive", "S", "01", { s: "Pos" }),
  perr("signed enum unknown", "S", "fe", "CHECK", ["s"]),
  ser("signed enum write", "S", { s: "Neg" }, "ff"),

  parse("u64 enum member", "B64", "ffffffffffffffff", { b: "Huge" }),
  parse("u64 open enum unknown is a decimal string", "B64", "0500000000000000", { b: "5" }),
  ser("u64 open enum write a member", "B64", { b: "One" }, "0100000000000000"),
  ser("u64 open enum write a number", "B64", { b: "18446744073709551614" }, "feffffffffffffff"),

  parse("sparse values", "Sp", w().u32(0x10000), { s: "First" }),
  parse("sparse max", "Sp", w().u32(0x7fffffff), { s: "Second" }),
  perr("sparse unknown", "Sp", w().u32(0), "CHECK", ["s"]),

  parse("array of enums", "Many", "03 0000 0100 1000", { n: 3, kinds: ["Sys", "Vram", "Other"] }),
  perr("array of enums unknown element", "Many", "02 0000 0500", "CHECK", ["kinds", 1]),
  ser("array of enums write", "Many", { kinds: ["Other", "Sys"] }, "02 1000 0000"),

  parse("enum in a condition: taken", "Cond", "0100 00100000", { kind: "Vram", vramSize: 0x1000 }),
  parse("enum in a condition: not taken", "Cond", "0000", { kind: "Sys" }),
  ser("enum in a condition write", "Cond", { kind: "Vram", vramSize: 5 }, "0100 05000000"),
  parse("enum with in", "InEnum", "0100", { kind: "Vram" }),
  perr("enum with in rejects a member", "InEnum", "1000", "CHECK", ["kind"]),
  serr("enum with in rejects on write", "InEnum", { kind: "Other" }, "CHECK", ["kind"])
);

export default area(
  "enums",
  "Closed and @open enums, signed and u64 storage, endianness, arrays, enums in conditions and `in`.",
  cases
);
