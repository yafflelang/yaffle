/** Cases for conformance/cases/strings. */
import { area, parse, parseOnly, perr, ser, serr, utf8Hex, w, type Case } from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);

const fixed8 = (s: string) => w().text(s).padTo(8);

// ── Fixed char[n] ───────────────────────────────────────────────────────────────────────────────
add(
  parse("fixed short text is NUL padded", "Fixed", fixed8("hello"), { name: "hello" }),
  parse("fixed full length has no terminator", "Fixed", fixed8("abcdefgh"), { name: "abcdefgh" }),
  parse("fixed empty", "Fixed", fixed8(""), { name: "" }),
  parseOnly("fixed drops data after the NUL", "Fixed", w().text("ab").u8(0).text("xyz").zeros(2), {
    name: "ab"
  }),
  ser("fixed writes NUL padding", "Fixed", { name: "ab" }, fixed8("ab")),
  parse("fixed utf8 counts bytes", "Fixed", fixed8("héllo"), { name: "héllo" }),
  parse("fixed emoji", "Fixed", fixed8("😀"), { name: "😀" }),
  parse("fixed exactly full with multibyte", "Fixed", fixed8("éééé"), { name: "éééé" }),
  perr("fixed invalid utf8", "Fixed", w().raw("c328").zeros(6), "CHECK", ["name"]),
  perr(
    "fixed truncated utf8 sequence at the end",
    "Fixed",
    w().text("abcdefg").raw("c3"),
    "CHECK",
    ["name"]
  ),
  perr("fixed eof", "Fixed", w().text("abcd"), "EOF", ["name"]),
  serr("fixed too long", "Fixed", { name: "abcdefghi" }, "INPUT", ["name"]),
  serr("fixed too long in bytes, not characters", "Fixed", { name: "ééééé" }, "INPUT", ["name"]),
  serr("fixed with an embedded NUL can't be written", "Fixed", { name: "a\u0000b" }, "INPUT", [
    "name"
  ]),
  parse("fixed then byte", "FixedThenByte", w().text("PAC").u8(0).u8(7), { tag: "PAC", after: 7 })
);

// ── NUL-terminated str ──────────────────────────────────────────────────────────────────────────
add(
  parse("str hello", "Cstr", w().cstr("hello"), { s: "hello" }),
  parse("str empty", "Cstr", "00", { s: "" }),
  parse("str utf8", "Cstr", w().cstr("日本"), { s: "日本" }),
  perr("str missing terminator", "Cstr", w().text("abc"), "EOF", ["s"]),
  perr("str invalid utf8", "Cstr", "ff00", "CHECK", ["s"]),
  perr("str overlong utf8 encoding is invalid", "Cstr", "c0af00", "CHECK", ["s"]),
  parse("str pair", "CstrPair", w().cstr("a").cstr("bc").u8(9), { a: "a", b: "bc", after: 9 }),
  serr("str with an embedded NUL can't be written", "Cstr", { s: "a\u0000b" }, "INPUT", ["s"]),
  ser("str writes the terminator", "Cstr", { s: "xy" }, w().cstr("xy"))
);

// ── UTF-16 / UTF-32 ─────────────────────────────────────────────────────────────────────────────
add(
  parse("str16 le", "Wide", w().utf16("Hi").u16(0), { s: "Hi" }),
  parse("str16 empty", "Wide", "0000", { s: "" }),
  parse("str16 surrogate pair", "Wide", w().utf16("😀").u16(0), { s: "😀" }),
  parse(
    "str16 follows root be",
    "Wide",
    w().utf16("Hi", "be").u16(0),
    { s: "Hi" },
    { args: { endian: "be" } }
  ),
  parse("str16 be block", "WideBe", w().utf16("Hi", "be").u16(0), { s: "Hi" }),
  perr("str16 unpaired surrogate", "Wide", w().u16(0xd800).u16(0), "CHECK", ["s"]),
  perr("str16 lone low surrogate", "Wide", w().u16(0xdc00).u16(0x41).u16(0), "CHECK", ["s"]),
  perr("str16 missing terminator", "Wide", w().utf16("ab"), "EOF", ["s"]),
  perr("str16 odd trailing byte", "Wide", w().utf16("a").u8(0), "EOF", ["s"]),
  ser("str16 writes le", "Wide", { s: "é😀" }, w().utf16("é😀").u16(0)),
  parse("str32 le", "Wider", w().utf32("A😀").u32(0), { s: "A😀" }),
  parse("str32 empty", "Wider", "00000000", { s: "" }),
  parse("str32 be attribute", "WiderBe", w().utf32("A", "be").u32(0), { s: "A" }),
  perr("str32 code point too large", "Wider", w().u32(0x110000).u32(0), "CHECK", ["s"]),
  perr("str32 surrogate code point", "Wider", w().u32(0xd800).u32(0), "CHECK", ["s"]),
  ser("str32 writes code points", "Wider", { s: "😀b" }, w().utf32("😀b").u32(0)),
  parse("char16 fixed padded", "Fixed16", w().utf16("ab").zeros(4), { name: "ab" }),
  parse("char16 fixed full", "Fixed16", w().utf16("abcd"), { name: "abcd" }),
  parse("char16 fixed surrogate pair uses two units", "Fixed16", w().utf16("😀").zeros(4), {
    name: "😀"
  }),
  serr("char16 fixed too long", "Fixed16", { name: "abcde" }, "INPUT", ["name"]),
  serr("char16 fixed too long in units", "Fixed16", { name: "😀😀a" }, "INPUT", ["name"]),
  parse("char32 fixed", "Fixed32", w().utf32("😀").zeros(4), { name: "😀" })
);

// ── Length-prefixed (derived lengths count code units) ─────────────────────────────────────────
add(
  parse("prefixed ascii", "Prefixed", w().u8(5).text("hello"), { len: 5, text: "hello" }),
  parse("prefixed counts utf8 bytes", "Prefixed", w().u8(6).text("héllo"), {
    len: 6,
    text: "héllo"
  }),
  parse("prefixed empty", "Prefixed", "00", { len: 0, text: "" }),
  ser("prefixed derives the length", "Prefixed", { text: "héllo" }, w().u8(6).text("héllo")),
  ser("prefixed derives zero", "Prefixed", { text: "" }, "00"),
  parseOnly("prefixed stops at a NUL", "Prefixed", w().u8(4).raw("61006263"), {
    len: 4,
    text: "a"
  }),
  serr("prefixed length overflows u8", "Prefixed", { text: "x".repeat(256) }, "RANGE", ["len"]),
  ser(
    "prefixed 255 bytes fits",
    "Prefixed",
    { text: "x".repeat(255) },
    w().u8(255).text("x".repeat(255))
  ),
  perr("prefixed eof", "Prefixed", w().u8(5).text("hi"), "EOF", ["text"]),
  parse("prefixed16 counts utf16 units", "Prefixed16", w().u16(2).utf16("😀"), {
    n: 2,
    text: "😀"
  }),
  ser("prefixed16 derives units", "Prefixed16", { text: "a😀" }, w().u16(3).utf16("a😀")),
  parse("prefixed32 counts code points", "Prefixed32", w().u8(1).utf32("😀"), { n: 1, text: "😀" }),
  ser("prefixed32 derives code points", "Prefixed32", { text: "ab😀" }, w().u8(3).utf32("ab😀")),
  parse("length minus one", "PrefixedPlusOne", w().u8(4).text("abc").u8(0), {
    lenWithNul: 4,
    text: "abc",
    nul: 0
  }),
  parse("length minus one empty", "PrefixedPlusOne", "0100", { lenWithNul: 1, text: "", nul: 0 }),
  ser("length minus one derives", "PrefixedPlusOne", { text: "hey" }, w().u8(4).text("hey").u8(0))
);

// ── Encodings ───────────────────────────────────────────────────────────────────────────────────
add(
  parse("latin1 maps bytes to code points", "Latin1", w().latin1("café"), { name: "café" }),
  parse("latin1 0xff", "Latin1", w().raw("ff").zeros(3), { name: "ÿ" }),
  parse("latin1 padded", "Latin1", w().latin1("ab").zeros(2), { name: "ab" }),
  ser(
    "latin1 writes one byte per character",
    "Latin1",
    { name: "née" },
    w().latin1("née").zeros(1)
  ),
  serr("latin1 can't write the euro sign", "Latin1", { name: "€" }, "INPUT", ["name"]),
  parse("latin1 cstr", "Latin1Cstr", "e900", { s: "é" }),
  parse("ascii", "Ascii", w().text("ARCV"), { tag: "ARCV" }),
  perr("ascii rejects 0x80", "Ascii", "50418043", "CHECK", ["tag"]),
  serr("ascii can't write é", "Ascii", { tag: "é" }, "INPUT", ["tag"]),
  parse("ascii cstr", "AsciiCstr", w().cstr("ok"), { s: "ok" }),
  perr("ascii cstr rejects 0xc3", "AsciiCstr", "c3a900", "CHECK", ["s"]),
  parse("utf8 bytes are not latin1", "Cstr", "c3a900", { s: "é" }),
  parse("hex of utf8 matches", "Fixed", w().raw(utf8Hex("€")).zeros(5), { name: "€" })
);

// ── Lists of strings ────────────────────────────────────────────────────────────────────────────
add(
  parse("string list until empty", "List", w().cstr("a").cstr("bc").u8(0), { names: ["a", "bc"] }),
  parse("string list empty", "List", "00", { names: [] }),
  perr("string list missing terminator", "List", w().cstr("a"), "EOF", ["names", 1]),
  ser(
    "string list writes the empty terminator",
    "List",
    { names: ["x", "", "y"].slice(0, 1) },
    w().cstr("x").u8(0)
  ),
  serr("string list can't contain the terminator", "List", { names: ["x", "", "y"] }, "INPUT", [
    "names",
    1
  ]),
  parse("counted string list", "CountedList", w().u8(2).cstr("x").cstr("yz"), {
    n: 2,
    names: ["x", "yz"]
  }),
  ser(
    "counted string list derives n",
    "CountedList",
    { names: ["p", "", "q"] },
    w().u8(3).cstr("p").u8(0).cstr("q")
  )
);

export default area(
  "strings",
  "Fixed char[n], str/str16/str32, char16/char32 arrays, length-prefixed text, utf8/latin1/ascii.",
  cases
);
