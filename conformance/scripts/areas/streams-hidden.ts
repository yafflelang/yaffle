/** Cases for conformance/cases/streams-hidden: carriers of streams marked @hidden. */
import { area, parse, ser, w, xorBytes, type Case } from "../lib.ts";
import { abc, abcContent, content, fit, inner } from "./streams.ts";

const cases: Case[] = [
  parse(
    "from a hidden field",
    "FromFieldHidden",
    w()
      .u8(4)
      .raw(xorBytes(inner(1, 2), 0x20)),
    {
      n: 4,
      inner: { a: 1, b: 2 }
    }
  ),
  ser(
    "from a hidden field on write",
    "FromFieldHidden",
    { inner: { a: 0, b: 0xffff } },
    w()
      .u8(4)
      .raw(xorBytes(inner(0, 0xffff), 0x20))
  ),
  parse("hidden fragments", "MiniFragHidden", fit, { version: 1, content }),
  ser("hidden fragments split where each piece fits", "MiniFragHidden", { content }, fit),
  parse("three hidden fragments", "MiniFragHidden", abc, { version: 1, content: abcContent }),
  ser("three hidden fragments on write", "MiniFragHidden", { content: abcContent }, abc),
  ser("no content, no hidden fragments", "MiniFragHidden", { content: "" }, "01"),
  parse("no hidden fragments", "MiniFragHidden", "01", { version: 1, content: "" })
];

export default area(
  "streams-hidden",
  "@hidden carriers of streams: out of the JSON, derived on write from the `from` field.",
  cases
);
