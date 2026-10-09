/**
 * A realistic schema: TIFF (byte-order mark, open enums, inline or out-of-line values). It lives
 * in test/frontend/fixtures and is compiled from the real filesystem.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.ts";
import { irToText } from "../../src/frontend/irtext.ts";
import type { IrProgram, IrSwitch } from "../../src/ir/index.ts";
import { expectValidIr, field, fmt, struct } from "../helpers.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function build(name: string): IrProgram {
  const r = compile([fixture(name)]);
  expect(r.diagnostics.map(fmt)).toEqual([]);
  expect(r.program).toBeDefined();
  expectValidIr(r.program!);
  return r.program!;
}

describe("TIFF", () => {
  const p = build("tiff.yfl");

  it("matches the golden IR", async () => {
    await expect(irToText(p)).toMatchFileSnapshot("./golden/tiff.txt");
  });

  it("follows the byte-order mark", () => {
    const t = struct(p, "Tiff");
    expect(t.usesEndian).toBe(false);
    expect(t.members[1]).toMatchObject({
      kind: "block",
      layers: [{ kind: "endian", value: { kind: "cond" } }]
    });
    expect(struct(p, "Ifd").usesEndian).toBe(true);
  });

  it("switches on the open enum with inline or out-of-line values", () => {
    const e = struct(p, "IfdEntry");
    const sw = e.members.find(m => m.kind === "switch") as IrSwitch;
    expect(sw.cases.map(c => c.values.map(v => (v.kind === "enum" ? v.member : "?")))).toEqual([
      ["Short"],
      ["Long"],
      ["Ascii"],
      ["Rational"]
    ]);
    expect(field(e, "count").input).toBe("required");
    expect(field(e, "shortsOfs").input).toBe("absent");
    expect(p.enums[0]!.open).toBe(true);
  });
});
