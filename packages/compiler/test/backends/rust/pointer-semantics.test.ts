/**
 * Rust backend on real frontend IR: `@nullable(empty)` pointers and `at` fields, `@origin`,
 * object identity of pointer targets, and the layout reaching fixed placements.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { compileSource } from "../../../src/index.ts";
import type { IrProgram } from "../../../src/ir/index.ts";
import { build, hasRust, type Built } from "./rust-utils.ts";

const SOURCE = `
// An empty array is written as null (0), and null reads as empty.
export struct PtrEmpty {
  u8 n
  u16[n] *list : u32 @nullable(empty)
}
export struct AtEmpty {
  u8 n
  u32 ofs
  u8 data[n] at ofs @nullable(empty)
}

// Target = base + origin + value; the origin may use later fields and offsetof(this).
struct V { u8 x }
export struct OriginLater {
  u8 n
  str *name : i32 @ref @origin(offsetof(vals))
  V vals[n]
  str pool[n]
}
struct E {
  u8 k
  str *s : i8 @origin(offsetof(this))
}
export struct OriginThis {
  u8 n
  E items[n]
}

// One object per address and type, inline values and pointer targets alike.
struct Rec { u8 a  u8 b }
export struct Shared {
  u8  n
  Rec recs[n]
  Rec *ptrs[n] : u8 @ref
}

// When layout reaches a fixed placement, the running position moves to its end.
export struct Fixed {
  u8 ofs
  u8 fixedData[2] at ofs % 64   // not derivable: fixed
  u8 *after : u8
}
`;

function program(): IrProgram {
  const r = compileSource(SOURCE, "/memory/pointer-semantics.yfl");
  if (!r.program) throw new Error(JSON.stringify(r.diagnostics, null, 1));
  return r.program;
}

describe.skipIf(!hasRust)("rust backend: pointer semantics on real IR", () => {
  let b: Built;
  beforeAll(async () => {
    b = await build("yaffle_t_pointer_semantics", [{ name: "d", program: program() }]);
  }, 600_000);

  const rt = async (root: string, bytes: string, json: unknown) => {
    expect(await b.value({ op: "parse", module: "d", root, bytes })).toEqual(json);
    expect(await b.value({ op: "serialize", module: "d", root, json })).toBe(bytes);
  };

  it("compiles without warnings", () => {
    expect(b.warnings, b.log).toBe(0);
  });

  it("writes empty array pointers as null and reads null as empty", async () => {
    await rt("PtrEmpty", "02" + "05000000" + "0100" + "0200", { n: 2, list: [1, 2] });
    await rt("PtrEmpty", "00" + "00000000", { n: 0, list: [] });
    expect(
      await b.value({ op: "serialize", module: "d", root: "PtrEmpty", json: { list: [] } })
    ).toBe("0000000000");
  });

  it("writes empty `at` arrays with offset 0 and reads offset 0 as empty", async () => {
    await rt("AtEmpty", "02" + "05000000" + "aabb", { n: 2, ofs: 5, data: "aabb" });
    await rt("AtEmpty", "00" + "00000000", { n: 0, ofs: 0, data: "" });
    // A non-zero offset with no elements reads as empty too, and is rewritten as 0.
    expect(
      await b.value({ op: "parse", module: "d", root: "AtEmpty", bytes: "00" + "05000000" })
    ).toEqual({ n: 0, ofs: 5, data: "" });
    expect(
      await b.value({ op: "serialize", module: "d", root: "AtEmpty", json: { data: "" } })
    ).toBe("0000000000");
  });

  it("counts pointers from an origin that uses a later field", async () => {
    // name -> pool[0] at 6, counted from offsetof(vals) = 5.
    await rt("OriginLater", "01" + "01000000" + "07" + "616200", {
      n: 1,
      name: "ab",
      vals: [{ x: 7 }],
      pool: ["ab"]
    });
  });

  it("counts pointers from offsetof(this)", async () => {
    // Targets after the inline part: "a" at 5 (from 1), "b" at 7 (from 3).
    await rt("OriginThis", "02" + "0a04" + "0b04" + "6100" + "6200", {
      n: 2,
      items: [
        { k: 10, s: "a" },
        { k: 11, s: "b" }
      ]
    });
  });

  it("gives inline values and pointer targets one identity", async () => {
    const bytes = "02" + "0102" + "0304" + "03" + "01";
    const json = {
      n: 2,
      recs: [
        { a: 1, b: 2 },
        { a: 3, b: 4 }
      ],
      ptrs: [{ $ref: "/recs/1" }, { $ref: "/recs/0" }]
    };
    await rt("Shared", bytes, json);
    // Equal values that aren't the same object: the first equal one wins.
    const twins = {
      recs: [
        { a: 5, b: 5 },
        { a: 5, b: 5 }
      ],
      ptrs: [{ $ref: "/recs/1" }, { a: 5, b: 5 }]
    };
    expect(await b.value({ op: "serialize", module: "d", root: "Shared", json: twins })).toBe(
      "02" + "0505" + "0505" + "03" + "01"
    );
  });

  it("moves the layout past a fixed placement it reaches", async () => {
    // The fixed data is at 4..6: the pointer target goes after it, not into the gap at 2.
    expect(
      await b.value({
        op: "serialize",
        module: "d",
        root: "Fixed",
        json: { ofs: 4, fixedData: "aabb", after: 9 }
      })
    ).toBe("04" + "06" + "0000" + "aabb" + "09");
  });
});
