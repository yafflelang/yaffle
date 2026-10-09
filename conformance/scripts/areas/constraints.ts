/** Cases for conformance/cases/constraints. */
import { area, parse, perr, ser, serr, w, type Case } from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);

// ── Constants ───────────────────────────────────────────────────────────────────────────────────
add(
  parse("constant matches", "Magic", "2a00 07", { magic: 42, v: 7 }),
  perr("constant mismatch", "Magic", "2b00 07", "CHECK", ["magic"]),
  ser("constant written automatically", "Magic", { v: 7 }, "2a00 07"),
  ser("constant ignores a given value", "Magic", { magic: 1, v: 7 }, "2a00 07"),
  parse("string constant", "Tag", w().text("ARCV").u8(1), { tag: "ARCV", v: 1 }),
  perr("string constant mismatch", "Tag", w().text("PACB").u8(1), "CHECK", ["tag"]),
  ser("string constant written", "Tag", { v: 2 }, w().text("ARCV").u8(2)),
  parse("byte constant", "Sig", "89504e47", { sig: "89504e47" }),
  perr("byte constant mismatch", "Sig", "89504e48", "CHECK", ["sig"]),
  ser("byte constant written", "Sig", {}, "89504e47"),
  parse("negative constants", "NegConst", w().i8(-5).int(32, -100000, "be"), { a: -5, b: -100000 }),
  perr("negative constant mismatch", "NegConst", w().i8(5).int(32, -100000, "be"), "CHECK", ["a"]),
  ser("negative constants written", "NegConst", {}, w().i8(-5).int(32, -100000, "be")),
  parse("float constant", "FloatConst", "0000803f", { one: 1 }),
  perr("float constant mismatch", "FloatConst", "0000003f", "CHECK", ["one"]),
  ser("float constant written", "FloatConst", {}, "0000803f"),
  parse("bool constant", "BoolConst", "01", { on: true }),
  perr("bool constant mismatch", "BoolConst", "00", "CHECK", ["on"]),
  ser("bool constant written", "BoolConst", {}, "01")
);

// ── in ──────────────────────────────────────────────────────────────────────────────────────────
add(
  parse("in literal II", "InSet", w().text("II"), { order: "II" }),
  parse("in literal MM", "InSet", w().text("MM"), { order: "MM" }),
  perr("in literal rejects", "InSet", w().text("IM"), "CHECK", ["order"]),
  ser("in literal write", "InSet", { order: "MM" }, w().text("MM")),
  serr("in literal write rejects", "InSet", { order: "XX" }, "CHECK", ["order"]),
  parse("in set value", "InRange", "02000000", { version: 2 }),
  parse("in range low end", "InRange", "05000000", { version: 5 }),
  parse("in range high end", "InRange", "09000000", { version: 9 }),
  perr("in gap between items", "InRange", "03000000", "CHECK", ["version"]),
  perr("in above the range", "InRange", "0a000000", "CHECK", ["version"]),
  perr("in zero", "InRange", "00000000", "CHECK", ["version"]),
  serr("in write rejects", "InRange", { version: 4 }, "CHECK", ["version"]),
  ser("in write accepts", "InRange", { version: 7 }, "07000000"),
  parse("in negative range", "InNeg", "fd", { v: -3 }),
  parse("in negative range bound", "InNeg", "fb", { v: -5 }),
  parse("in single value after range", "InNeg", "0a", { v: 10 }),
  perr("in negative outside", "InNeg", "00", "CHECK", ["v"]),
  perr("in negative below", "InNeg", "fa", "CHECK", ["v"]),
  parse("in u64 max", "InU64", "ffffffffffffffff", { v: "18446744073709551615" }),
  perr("in u64 rejects", "InU64", "feffffffffffffff", "CHECK", ["v"])
);

// ── Regex ───────────────────────────────────────────────────────────────────────────────────────
add(
  parse("regex one digit", "Regex", w().cstr("v1.2"), { ver: "v1.2" }),
  parse("regex two digits", "Regex", w().cstr("v9.10"), { ver: "v9.10" }),
  perr("regex must match the whole string", "Regex", w().cstr("v1.234"), "CHECK", ["ver"]),
  perr("regex prefix mismatch", "Regex", w().cstr("x1.2"), "CHECK", ["ver"]),
  perr("regex is not a substring search", "Regex", w().cstr("av1.2"), "CHECK", ["ver"]),
  perr("regex empty", "Regex", "00", "CHECK", ["ver"]),
  serr("regex write rejects", "Regex", { ver: "1.2" }, "CHECK", ["ver"]),
  ser("regex write accepts", "Regex", { ver: "v0.1" }, w().cstr("v0.1")),
  parse("regex class on a fixed string", "RegexClass", w().text("Ab9"), { code: "Ab9" }),
  parse("regex class with padding", "RegexClass", w().text("Q_").u8(0), { code: "Q_" }),
  perr("regex class lowercase start", "RegexClass", w().text("ab9"), "CHECK", ["code"]),
  parse("regex alternation", "RegexAlt", w().cstr("dogs"), { word: "dogs" }),
  parse("regex alternation optional", "RegexAlt", w().cstr("cat"), { word: "cat" }),
  perr("regex alternation rejects", "RegexAlt", w().cstr("cow"), "CHECK", ["word"]),
  perr("regex alternation does not match a longer string", "RegexAlt", w().cstr("catss"), "CHECK", [
    "word"
  ])
);

// ── where ───────────────────────────────────────────────────────────────────────────────────────
add(
  parse("where holds", "Where", "08000000", { size: 8 }),
  parse("where zero", "Where", "00000000", { size: 0 }),
  perr("where fails", "Where", "06000000", "CHECK", ["size"]),
  serr("where write rejects", "Where", { size: 6 }, "CHECK", ["size"]),
  ser("where write accepts", "Where", { size: 12 }, "0c000000"),
  parse("where uses an earlier field", "WhereDep", "03 05", { lo: 3, hi: 5 }),
  parse("where equal", "WhereDep", "03 03", { lo: 3, hi: 3 }),
  perr("where uses an earlier field and fails", "WhereDep", "05 03", "CHECK", ["hi"]),
  serr("where write uses another field", "WhereDep", { lo: 9, hi: 1 }, "CHECK", ["hi"]),
  parse("where on a string", "WhereStr", w().cstr("x"), { name: "x" }),
  perr("where on an empty string", "WhereStr", "00", "CHECK", ["name"]),
  parse("where with &&", "WhereAnd", "8001", { v: 0x180 }),
  perr("where with && fails low", "WhereAnd", "ff00", "CHECK", ["v"]),
  perr("where with && fails high", "WhereAnd", "0002", "CHECK", ["v"]),
  parse("in and where both hold", "Both", "40", { v: 64 }),
  perr("in holds but where fails", "Both", "41", "CHECK", ["v"]),
  perr("where holds but in fails", "Both", "c8", "CHECK", ["v"]),
  serr("in and where on write", "Both", { v: 0 }, "CHECK", ["v"])
);

export default area(
  "constraints",
  "Constants of every kind, `in` with sets/ranges/literals, `in /regex/`, `where`.",
  cases
);
