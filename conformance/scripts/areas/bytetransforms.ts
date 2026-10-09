/** Cases for conformance/cases/bytetransforms (uses the conformance externs). */
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
const body = (a: number, b: number) => w().u8(a).u16(b).out;

add(
  parse("xor over the rest of the region", "XorRest", w().raw(xorBytes(body(1, 2), 0x5a)), {
    body: { a: 1, b: 2 }
  }),
  ser(
    "xor on write",
    "XorRest",
    { body: { a: 0xff, b: 0x1234 } },
    w().raw(xorBytes(body(0xff, 0x1234), 0x5a))
  ),
  parseOnly(
    "decoded bytes the struct doesn't read are dropped",
    "XorRest",
    w().raw(xorBytes([...body(1, 2), 9], 0x5a)),
    { body: { a: 1, b: 2 } }
  ),
  parse(
    "codec argument from a field",
    "XorKey",
    w()
      .u8(0x0f)
      .u8(3)
      .raw(xorBytes(body(1, 0x0203), 0x0f)),
    { key: 15, n: 3, body: { a: 1, b: 0x0203 } }
  ),
  ser(
    "codec argument from a field on write",
    "XorKey",
    { key: 0x80, body: { a: 0, b: 0 } },
    w()
      .u8(0x80)
      .u8(3)
      .raw(xorBytes(body(0, 0), 0x80))
  )
);

const rle7 = rleEncode(body(7, 0x0707));
add(
  parse("layered sizes", "Rle", w().u8(3).u8(2).raw(rle7).u8(0xff), {
    expSize: 3,
    compSize: 2,
    body: { a: 7, b: 0x0707 },
    after: 255
  }),
  ser(
    "layered sizes are both derived",
    "Rle",
    { body: { a: 1, b: 2 }, after: 0 },
    w()
      .u8(3)
      .u8(6)
      .raw(rleEncode(body(1, 2)))
      .u8(0)
  ),
  perr(
    "decoded size disagrees with the codec",
    "Rle",
    w().u8(4).u8(2).raw(rle7).u8(0xff),
    "CODEC",
    ["body"]
  ),
  perr("corrupt encoded data", "Rle", w().u8(3).u8(2).raw("0007").u8(0xff), "CODEC", ["body"]),
  perr("on-disk size past the end", "Rle", w().u8(3).u8(9).raw(rle7), "EOF", ["body"]),
  parse(
    "codec reuse keeps non-canonical encodings",
    "Rle",
    w().u8(3).u8(4).raw("01070207").u8(0xff),
    { expSize: 3, compSize: 4, body: { a: 7, b: 0x0707 }, after: 255 },
    { roundtrip: "value" }
  ),
  ser(
    "the same value re-encoded canonically",
    "Rle",
    { body: { a: 7, b: 0x0707 }, after: 255 },
    w().u8(3).u8(2).raw(rle7).u8(0xff)
  ),
  parse("bytes through a codec", "RleBytes", w().u8(2).raw("06aa").u8(1), {
    n: 2,
    data: "aa".repeat(6),
    after: 1
  }),
  ser(
    "bytes through a codec, long runs",
    "RleBytes",
    { data: "00".repeat(300), after: 2 },
    w().u8(4).raw("ff002d00").u8(2)
  ),
  ser("bytes through a codec, empty", "RleBytes", { data: "", after: 3 }, w().u8(0).u8(3))
);

add(
  parse("streaming codec finds its end", "Stream", w().raw("03aa00").u8(0x7f), {
    data: "aaaaaa",
    after: 127
  }),
  ser(
    "streaming codec on write",
    "Stream",
    { data: "0102", after: 1 },
    w().raw("0101010200").u8(1)
  ),
  ser("streaming codec empty", "Stream", { data: "", after: 1 }, "00 01"),
  perr("streaming codec without its terminator", "Stream", "03aa", "CODEC", ["data"]),
  parse("streaming codec with a decoded size", "StreamSized", w().u8(3).raw("03aa00").u8(0x7f), {
    exp: 3,
    data: "aaaaaa",
    after: 127
  }),
  ser(
    "streaming codec decoded size derived",
    "StreamSized",
    { data: "ffff", after: 0 },
    w().u8(2).raw("02ff00").u8(0)
  ),
  perr(
    "streaming codec decoded size disagrees",
    "StreamSized",
    w().u8(4).raw("03aa00").u8(0x7f),
    "CODEC",
    ["data"]
  )
);

add(
  parse(
    "async codec",
    "Async",
    w()
      .u8(3)
      .raw(xorBytes(body(1, 2), 0x11)),
    { n: 3, body: { a: 1, b: 2 } }
  ),
  ser(
    "async codec on write",
    "Async",
    { body: { a: 5, b: 6 } },
    w()
      .u8(3)
      .raw(xorBytes(body(5, 6), 0x11))
  ),
  parse("codec chain", "Chain", w().u8(2).raw(xorBytes(rle7, 0x55)), {
    n: 2,
    body: { a: 7, b: 0x0707 }
  }),
  ser(
    "codec chain on write",
    "Chain",
    { body: { a: 1, b: 0x0101 } },
    w()
      .u8(2)
      .raw(xorBytes(rleEncode(body(1, 0x0101)), 0x55))
  ),
  parse(
    "codec chain with a size at every layer",
    "ChainSizes",
    w()
      .raw("050202")
      .raw(xorBytes(rleEncode([0, 0, 0, 0, 0]), 0xff)),
    { exp: 5, mid: 2, disk: 2, data: "0000000000" }
  ),
  ser(
    "codec chain sizes derived",
    "ChainSizes",
    { data: "0102" },
    w()
      .raw("020404")
      .raw(xorBytes(rleEncode([1, 2]), 0xff))
  ),
  parse("position-dependent ranged codec", "Pos", "baaadece", { data: "aabbccdd" }),
  ser("position-dependent ranged codec on write", "Pos", { data: "00000000" }, "10111213"),
  parse(
    "per-element codec through an alias",
    "Elements",
    w()
      .u8(2)
      .raw(xorBytes(body(1, 2), 0x0f))
      .raw(xorBytes(body(3, 4), 0x0f)),
    {
      n: 2,
      items: [
        { a: 1, b: 2 },
        { a: 3, b: 4 }
      ]
    }
  ),
  parse(
    "struct-level codec",
    "UsesHidden",
    w()
      .raw(xorBytes(w().u16(0x1234).out, 0xaa))
      .u8(1),
    { h: { v: 0x1234 }, after: 1 }
  ),
  ser(
    "struct-level codec on write",
    "UsesHidden",
    { h: { v: 1 }, after: 2 },
    w()
      .raw(xorBytes(w().u16(1).out, 0xaa))
      .u8(2)
  ),
  serr("range error after a codec field", "Rle", { body: { a: 1, b: 2 }, after: 300 }, "RANGE", [
    "after"
  ])
);

export default area(
  "bytetransforms",
  "@via codecs with arguments, layered @size, @streaming, async, chains, @ranged positions, failures, codec reuse.",
  cases
);
