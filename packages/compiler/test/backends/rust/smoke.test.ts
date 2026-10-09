import { describe, expect, it, beforeAll } from "vitest";
import { S, e, f, konst, len, lenOf, program, t, vt } from "./ir-builder.ts";
import { build, hasRust, type Built } from "./rust-utils.ts";

const Entry = S("Entry", [f("a", t.u16), f("b", t.u32)]);
const Table = S("Table", [
  konst("magic", t.u16, e.int(0x4142), vt.u16),
  f("count", t.u32, { derive: lenOf("entries", vt.array(vt.struct("Entry"))) }),
  f("entries", t.array(t.s("Entry"), len.count(e.f("count")))),
  f("name", t.str()),
  f("tail", t.bytes(len.rest))
]);

describe.skipIf(!hasRust)("rust backend smoke", () => {
  let b: Built;
  beforeAll(async () => {
    b = await build("yaffle_t_smoke", [{ name: "m", program: program([Entry, Table], ["Table"]) }]);
  }, 600_000);

  it("parses and round-trips", async () => {
    const bytes =
      "4241" + "02000000" + "0100" + "02000000" + "0300" + "04000000" + "686900" + "ffee";
    const json = await b.value({ op: "parse", module: "m", root: "Table", bytes });
    expect(json).toEqual({
      magic: 0x4142,
      count: 2,
      entries: [
        { a: 1, b: 2 },
        { a: 3, b: 4 }
      ],
      name: "hi",
      tail: "ffee"
    });
    const out = await b.value({ op: "serialize", module: "m", root: "Table", json });
    expect(out).toBe(bytes);
  });
});
