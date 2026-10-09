/** Cases for conformance/cases/conditionals. */
import { area, parse, perr, ser, serr, w, type Case } from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);

add(
  parse("if taken", "IfElse", "03 01000000 09", { version: 3, extra: 1, tail: 9 }),
  parse("else taken", "IfElse", "02 0500 09", { version: 2, legacy: 5, tail: 9 }),
  ser("if branch on write", "IfElse", { version: 4, extra: 7, tail: 1 }, "04 07000000 01"),
  ser(
    "fields of the untaken branch are ignored",
    "IfElse",
    { version: 1, legacy: 2, extra: 99, tail: 1 },
    "01 0200 01"
  ),
  serr("missing field of the taken branch", "IfElse", { version: 4, tail: 1 }, "INPUT", ["extra"]),
  perr("eof inside a branch", "IfElse", "03 0100", "EOF", ["extra"]),
  parse("if without else not taken", "IfOnly", "00 07", { flag: 0, end: 7 }),
  parse("if without else taken", "IfOnly", "01 3412 07", { flag: 1, opt: 0x1234, end: 7 }),
  ser("if without else omitted on write", "IfOnly", { flag: 0, end: 7 }, "00 07"),
  ser("if without else on write", "IfOnly", { flag: 2, opt: 1, end: 7 }, "02 0100 07"),
  parse("bool condition taken", "BoolCond", "01 05000000 06", { hasX: true, x: 5, y: 6 }),
  parse("bool condition not taken", "BoolCond", "00", { hasX: false }),
  parse("nested if: inner if", "NestedIf", "01 01 07", { a: 1, b: 1, c: 7 }),
  parse("nested if: inner else", "NestedIf", "01 00 0200", { a: 1, b: 0, d: 2 }),
  parse("nested if: outer else", "NestedIf", "00 04000000", { a: 0, e: 4 }),
  ser("nested if on write", "NestedIf", { a: 5, b: 0, d: 3 }, "05 00 0300"),
  parse("condition on a count", "CondCount", "02 aabb", { n: 2, items: "aabb" }),
  parse("condition on a count, not taken", "CondCount", "00", { n: 0 }),
  ser(
    "a count used in a condition stays an input",
    "CondCount",
    { n: 2, items: "aabb" },
    "02 aabb"
  ),
  serr("a count used in a condition is checked", "CondCount", { n: 2, items: "aa" }, "DERIVE")
);

add(
  parse("switch on a string", "SwitchStr", w().text("ARCV").u32(5).u8(0xff), {
    tag: "ARCV",
    n: 5,
    after: 255
  }),
  parse("switch second case", "SwitchStr", w().text("CHNK").u16(7).u8(0xff), {
    tag: "CHNK",
    m: 7,
    after: 255
  }),
  parse("switch default", "SwitchStr", w().text("XXXX").raw("0102").u8(0xff), {
    tag: "XXXX",
    body: "0102",
    after: 255
  }),
  ser(
    "switch on write",
    "SwitchStr",
    { tag: "CHNK", m: 1, after: 0 },
    w().text("CHNK").u16(1).u8(0)
  ),
  ser(
    "switch default on write",
    "SwitchStr",
    { tag: "ABCD", body: "ffee", after: 0 },
    w().text("ABCD").raw("ffee").u8(0)
  ),
  parse("switch on an integer", "SwitchInt", "01 aa", { kind: 1, a: 0xaa }),
  parse("switch case with two values (first)", "SwitchInt", "02 3412", { kind: 2, b: 0x1234 }),
  parse("switch case with two values (second)", "SwitchInt", "03 3412", { kind: 3, b: 0x1234 }),
  parse("switch case with a block", "SwitchInt", "04 0102", { kind: 4, c: 1, d: 2 }),
  parse("switch integer default", "SwitchInt", "09 04030201", { kind: 9, z: 0x01020304 }),
  ser("switch block case on write", "SwitchInt", { kind: 4, c: 9, d: 8 }, "04 0908"),
  parse("switch without default, matched", "SwitchNoDefault", "02 0100", { k: 2, b: 1 }),
  perr("switch without a match", "SwitchNoDefault", "03", "CHECK"),
  serr("switch without a match on write", "SwitchNoDefault", { k: 3 }, "CHECK")
);

const A = (v: number) => ({ type: "A", value: { tag: 1, v } });
const B = (wv: number) => ({ type: "B", value: { tag: 2, w: wv } });
add(
  parse("union first variant", "U", "01 05 ff", { x: A(5), after: 255 }),
  parse("union second variant", "U", "02 0100 ff", { x: B(1), after: 255 }),
  perr("union no variant matches", "U", "03 0000 ff", "UNION", ["x"]),
  ser("union write", "U", { x: { type: "B", value: { w: 2 } }, after: 1 }, "02 0200 01"),
  ser(
    "union write first variant",
    "U",
    { x: { type: "A", value: { v: 9 } }, after: 1 },
    "01 09 01"
  ),
  serr("union write unknown variant", "U", { x: { type: "Z", value: {} }, after: 1 }, "INPUT", [
    "x"
  ]),
  parse("union fallback variant", "UF", "05 07", { x: { type: "C", value: { tag: 5, x: 7 } } }),
  parse("union fallback picks the first match", "UF", "01 05", { x: A(5) }),
  parse("union order decides", "UFirst", "01 05", { x: { type: "C", value: { tag: 1, x: 5 } } }),
  parse("array of unions", "UList", "02 0105 020100", { n: 2, items: [A(5), B(1)] }),
  ser(
    "array of unions on write",
    "UList",
    { items: [{ type: "B", value: { w: 3 } }] },
    "01 020300"
  ),
  parse("union variant failing with EOF falls through", "ULS", "09 2a", {
    x: { type: "Short", value: { tag: 9, small: 42 } }
  }),
  parse("union variant that fits wins", "ULS", "09 01000000", {
    x: { type: "Long", value: { tag: 9, big: 1 } }
  })
);

add(
  parse("switch on an enum", "SwitchEnum", "01 0500", { s: "Circle", radius: 5 }),
  parse("switch on an enum, block case", "SwitchEnum", "02 0300 0400", { s: "Square", w: 3, h: 4 }),
  perr("switch on an enum with an unknown value", "SwitchEnum", "03 0000", "CHECK", ["s"]),
  ser("switch on an enum on write", "SwitchEnum", { s: "Square", w: 1, h: 2 }, "02 0100 0200"),
  parse("condition on a nested field, taken", "NestedCond", "01 05000000", {
    f: { bits: 1 },
    extra: 5
  }),
  parse("condition on a nested field, not taken", "NestedCond", "02", { f: { bits: 2 } })
);

export default area(
  "conditionals",
  "if/else, if without else, nested ifs, switch (strings, integers, multi-value cases, default), unions.",
  cases
);
