import { describe, expect, it } from "vitest";
import { open, posOf } from "./util.ts";

const SRC = `extern async codec oodle
extern codec zstd
enum Kind : u8 { A, B = 5 }
const u32 SECTOR = 0x800
/// An entry.
struct Entry { u16 a  u32 b }
type Fixed16 = i16 as it / 256.0
export struct Table @base {
  u32   count
  u32   $version
  Entry entries[count]
  u32   expSize
  u32   compSize
  u8    body[] @size(expSize) @via(oodle) @size(compSize)
  bits u8 { bool c : 1  Kind k : 3  u8 : 4 }
  u16   angle as it * 360.0 / 65536
  u32be crc
  @endian(be) { u32 bigOne }
  u32   tagged where it % 4 == 0
  Fixed16 fx
  Rec   r
  u8    sec[SECTOR]
}
struct Rec { if ($version > 1) { u8 x } }
struct Blob(u32 n) { u8 data[n] }
`;

function hoverAt(needle: string, delta = 0, nth = 0, src = SRC): string {
  const { ls, path } = open(src);
  const h = ls.getHover(path, posOf(src, needle, delta, nth));
  expect(h, `no hover at '${needle}'`).toBeDefined();
  return h!.contents;
}

describe("hover", () => {
  it("fields: type, offset, size, byte order, derivation", () => {
    const h = hoverAt("count\n", 1);
    expect(h).toContain("```yaffle\nu32 count\n```");
    expect(h).toContain("**Type:** `u32`");
    expect(h).toContain("**Offset:** 0x0");
    expect(h).toContain("**Size:** 4 bytes");
    expect(h).toContain("inherits `$endian`");
    expect(h).toContain(
      "**Written as:** `count = entries.length` — derived automatically from the element count of entries. Not in the input type"
    );
  });

  it("symbolic offsets and array sizes", () => {
    expect(hoverAt("entries[", 1)).toContain("**Size:** count × 0x6 bytes");
    expect(hoverAt("expSize\n", 1)).toContain("**Offset:** 0x8 + count × 0x6");
    expect(hoverAt("angle", 1)).toContain("**Offset:** 0x11 + count × 0x6 + sizeof(body)");
  });

  it("layers labelled decoded / on disk", () => {
    const h = hoverAt("body[", 1);
    expect(h).toContain("1. `@size(expSize)` — decoded size");
    expect(h).toContain("2. `@via(oodle)` — codec");
    expect(h).toContain("3. `@size(compSize)` — size on disk");
  });

  it("size fields show where they come from", () => {
    expect(hoverAt("compSize\n", 1)).toContain(
      "derived automatically from the on-disk size of body"
    );
  });

  it("fixed and block byte order", () => {
    expect(hoverAt("crc", 1)).toContain("big-endian (fixed)");
    expect(hoverAt("bigOne", 1)).toContain("from `@endian(be)` on the enclosing block");
  });

  it("bitfields with a bit diagram", () => {
    const h = hoverAt("Kind k", 5);
    expect(h).toContain("**Bits:** 1–3 of the u8 unit (mask 0xe)");
    expect(h).toContain("```\n76543210\n····kkkc\n    ^^^\n```");
  });

  it("transforms show the inferred reverse", () => {
    expect(hoverAt("angle", 1)).toContain(
      "**Transform:** reads `it * 360.0 / 65536.0`, writes `round(it * 65536.0 / 360.0)` (reverse worked out by the compiler)"
    );
  });

  it("checks", () => {
    expect(hoverAt("tagged", 1)).toContain("**Checks:** `tagged % 4 == 0`");
  });

  it("bound fields and $values", () => {
    expect(hoverAt("$version\n", 2)).toContain("**Binds** `$version`");
    const h = hoverAt("$version > 1", 2);
    expect(h).toContain("```yaffle\n$version: u32\n```");
    expect(h).toContain("Provided by the structs that use this one");
    expect(h).toContain("- `Table.version` — u32");
  });

  it("built-in $values", () => {
    const src = "struct S { u32 p = $offset }";
    expect(hoverAt("$offset", 1, 0, src)).toContain("Current position, from the nearest `@base`.");
  });

  it("structs: size, needs, flags", () => {
    expect(hoverAt("Entry {", 1)).toContain("**Size:** 6 bytes");
    expect(hoverAt("Entry {", 1)).toContain("An entry.");
    const t = hoverAt("Table", 1);
    expect(t).toContain("export struct Table @base");
    expect(t).toContain("**Size:** variable");
    expect(t).toContain("**async:**");
    expect(t).toContain("**Export root:**");
    expect(hoverAt("Rec {", 1)).toContain("**Needs:** `$version` (u32)");
  });

  it("type references in field declarations", () => {
    expect(hoverAt("Entry entries", 1)).toContain("struct Entry");
  });

  it("enums, members, constants, aliases", () => {
    expect(hoverAt("Kind :", 1)).toContain("enum Kind : u8 { A = 0, B = 5 }");
    expect(hoverAt("B = 5", 0)).toContain("Kind.B = 5");
    expect(hoverAt("SECTOR]", 1)).toContain("const u32 SECTOR = 0x800");
    expect(hoverAt("Fixed16 fx", 1)).toContain("type Fixed16 = i16 as it / 256.0");
  });

  it("codecs", () => {
    const h = hoverAt("oodle)", 1);
    expect(h).toContain("extern async codec oodle");
    expect(h).toContain("**async:**");
  });

  it("attributes", () => {
    const h = hoverAt("@via", 1);
    expect(h).toContain("@via(codec)");
    expect(h).toContain("Byte transform");
  });

  it("built-in types", () => {
    expect(hoverAt("u32be", 1)).toContain("unsigned 32-bit integer (4 bytes, big-endian)");
    expect(hoverAt("bool c", 1)).toContain("nonzero reads as true");
  });

  it("parameters", () => {
    expect(hoverAt("n) {", 0)).toContain("Parameter of `Blob`: u32.");
    expect(hoverAt("data[n]", 5)).toContain("u32 n");
  });

  it("it and expression types", () => {
    expect(hoverAt("it % 4", 0)).toContain("it: u32");
    const src = "struct S { u32 a  u8 d[a + 1] }";
    expect(hoverAt("+", 0, 0, src)).toContain("int");
  });

  it("builtin functions", () => {
    const src = "struct S { u8 b[4]  u32 s = sizeof(b) }";
    expect(hoverAt("sizeof", 1, 0, src)).toContain("sizeof(field | Type) -> int");
  });

  it("returns a range for the hovered word", () => {
    const { ls, path } = open(SRC);
    const h = ls.getHover(path, posOf(SRC, "count\n", 2))!;
    expect(h.range).toEqual({ start: posOf(SRC, "count\n"), end: posOf(SRC, "count\n", 5) });
  });

  it("nothing on whitespace or comments", () => {
    const src = "struct S {   u8 x  } // note";
    const { ls, path } = open(src);
    expect(ls.getHover(path, { line: 0, character: 11 })).toBeUndefined();
    expect(ls.getHover(path, { line: 0, character: 25 })).toBeUndefined();
  });
});
