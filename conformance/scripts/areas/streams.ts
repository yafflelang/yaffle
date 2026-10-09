/** Cases for conformance/cases/streams. The fit splits are worked out in the comments. */
import {
  area,
  parse,
  parseOnly,
  perr,
  rleEncode,
  ser,
  serr,
  w,
  xorBytes,
  type Case
} from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);
export const inner = (a: number, b: number) => w().u16(a).u16(b).out;

add(
  parse(
    "from a field",
    "FromField",
    w()
      .u8(4)
      .raw(xorBytes(inner(1, 2), 0x20)),
    {
      n: 4,
      raw: "01000200",
      inner: { a: 1, b: 2 }
    }
  ),
  ser(
    "from a field on write derives the field",
    "FromField",
    { inner: { a: 3, b: 4 } },
    w()
      .u8(4)
      .raw(xorBytes(inner(3, 4), 0x20))
  ),
  ser(
    "from a field ignores a given carrier value",
    "FromField",
    { raw: "ffffffff", inner: { a: 3, b: 4 } },
    w()
      .u8(4)
      .raw(xorBytes(inner(3, 4), 0x20))
  ),
  parseOnly(
    "from a field with unread bytes",
    "FromField",
    w()
      .u8(5)
      .raw(xorBytes([...inner(1, 2), 9], 0x20)),
    { n: 5, raw: "0100020009", inner: { a: 1, b: 2 } }
  ),
  perr(
    "from a field too short for the struct",
    "FromField",
    w()
      .u8(3)
      .raw(xorBytes([1, 0, 2], 0x20)),
    "EOF",
    ["inner", "b"]
  )
);

add(
  parse("joined pieces", "Joined", "02 02 0100 02 0200", {
    count: 2,
    pieces: [
      { n: 2, data: "0100" },
      { n: 2, data: "0200" }
    ],
    inner: { a: 1, b: 2 }
  }),
  parse("joined pieces split elsewhere", "Joined", "02 03 010002 01 00", {
    count: 2,
    pieces: [
      { n: 3, data: "010002" },
      { n: 1, data: "00" }
    ],
    inner: { a: 1, b: 2 }
  }),
  ser(
    "joined pieces split by the input sizes",
    "Joined",
    { pieces: [{ n: 1 }, { n: 3 }], inner: { a: 1, b: 2 } },
    "02 01 01 03 000200"
  ),
  ser(
    "joined pieces with an empty piece",
    "Joined",
    { pieces: [{ n: 0 }, { n: 4 }], inner: { a: 5, b: 6 } },
    "02 00 04 05000600"
  ),
  serr(
    "joined piece sizes don't cover the stream",
    "Joined",
    { pieces: [{ n: 1 }], inner: { a: 1, b: 2 } },
    "DERIVE"
  ),
  perr("joined pieces too short", "Joined", "01 03 010002", "EOF", ["inner", "b"])
);

// MiniFrag, content "aaabbcdddd":
// - frag 0 at 1, next block at 8: 7 bytes, 2 of header, so ≤ 5 encoded. "aaabb" encodes to 4
//   bytes ("aaabbc" would need 6): 05 04 03610262 at 1..7, then one zero byte.
// - frag 1 at 8, next block at 16: ≤ 6 encoded. "cdddd" encodes to 4: 05 04 01630464 at 8..14.
// - frag 2 would be at 16, past the end (14), so reading stops.
export const content = w().text("aaabbcdddd").hex();
export const fit = w()
  .u8(1)
  .u8(5)
  .u8(4)
  .raw(rleEncode(w().text("aaabb").out))
  .u8(0)
  .u8(5)
  .u8(4)
  .raw(rleEncode(w().text("cdddd").out));
const fitFrags = [
  { exp: 5, comp: 4, data: w().text("aaabb").hex() },
  { exp: 5, comp: 4, data: w().text("cdddd").hex() }
];
// Split from input sizes 3 and 7: "aaa" → 0361 at 1..5, zeros to 8, "bbcdddd" → 6 bytes at 8..16.
const sized = w()
  .u8(1)
  .raw("03020361")
  .zeros(3)
  .raw("0706")
  .raw(rleEncode(w().text("bbcdddd").out));
// "abcdefgh": every byte is its own run (2 bytes each): "ab" | "cde" | "fgh".
export const abcContent = w().text("abcdefgh").hex();
export const abc = w()
  .u8(1)
  .raw("0204")
  .raw(rleEncode(w().text("ab").out))
  .u8(0)
  .raw("0306")
  .raw(rleEncode(w().text("cde").out))
  .raw("0306")
  .raw(rleEncode(w().text("fgh").out));
if (fit.length !== 14 || sized.length !== 16 || abc.length !== 24) {
  throw new Error("MiniFrag layout drifted");
}

add(
  parse("fragments in fixed blocks", "MiniFrag", fit, { version: 1, frags: fitFrags, content }),
  ser("fragments split where each piece fits", "MiniFrag", { content }, fit),
  parse("fragments split by input sizes", "MiniFrag", sized, {
    version: 1,
    frags: [
      { exp: 3, comp: 2, data: w().text("aaa").hex() },
      { exp: 7, comp: 6, data: w().text("bbcdddd").hex() }
    ],
    content
  }),
  ser(
    "fragment sizes from the input win over fit",
    "MiniFrag",
    { frags: [{ exp: 3 }, { exp: 7 }], content },
    sized
  ),
  serr(
    "a fragment size from the input that doesn't fit its block",
    "MiniFrag",
    { frags: [{ exp: 7 }, { exp: 3 }], content },
    "OVERLAP"
  ),
  ser("three fragments by fit", "MiniFrag", { content: abcContent }, abc),
  ser("no content, no fragments", "MiniFrag", { content: "" }, "01"),
  parse("no fragments", "MiniFrag", "01", { version: 1, frags: [], content: "" }),
  perr("fragment with corrupt data", "MiniFrag", w().u8(1).raw("0504 0061 0262"), "CODEC", [
    "frags",
    0,
    "data"
  ])
);

export default area(
  "streams",
  "`from` fields, joined pieces, split by input sizes or @split(fit), a miniature fragmented stream.",
  cases
);
