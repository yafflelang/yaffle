/**
 * Rust backend: layout items that read fields (IR.md §4.4). Item arguments are
 * evaluated in the write context of the struct that owns the layout (input and derived fields,
 * parameters, `$index`), through paths and groups, and in view commits; below 1 is `RANGE`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { compileSource } from "../../../src/index.ts";
import { testHarness } from "../../../src/backends/rust/harness.ts";
import { build, hasRust, scratch, type Built } from "./rust-utils.ts";

const SOURCE = `
export struct AlignByField {
  u8 align
  u8 size
  u8 offset
  u8 data[size] at offset
  layout { data @align(align) }
}
export struct SignedAlign {
  i8 align
  u8 size
  u8 offset
  u8 data[size] at offset
  layout { data @align(align) }
}
export struct DerivedAlign {
  u8 lg
  u8 al = 1 << lg
  u8 size
  u8 offset
  u8 data[size] at offset
  layout { data @align(al) }
}
struct Inner(u8 k) {
  u8 size
  u8 offset
  u8 data[size] at offset
  layout { data @align(k * 2) }
}
export struct ByParam {
  u8 k
  Inner(k) inner
}
struct IRec {
  u8 n
  u8 ofs
  u8 body[n] at ofs
  layout { body @align(($index + 1) * 2) }
}
export struct ByIndex {
  u8   count
  IRec recs[count]
}
struct Pt { u8 v }
struct Vol { Pt *a : u8  Pt *b : u8 }
export struct Grp {
  u8  al
  u8  n
  Vol vols[n]
  layout {
    vols[*] { b @align(al)  a }
  }
}
`;

function realProgram() {
  const r = compileSource(SOURCE, "/memory/layout-fields.yfl");
  if (!r.program) throw new Error(JSON.stringify(r.diagnostics, null, 1));
  return r.program;
}

const VIEW_TESTS = `
#[cfg(test)]
mod layout_fields_view_tests {
    use super::*;
    use yaffle_runtime as yr;

    fn unhex(s: &str) -> Vec<u8> { yr::json::unhex(s).unwrap() }

    #[test]
    fn commits_lay_out_again_with_the_edited_field() {
        let bytes = unhex("04020400aabb");
        // A field a layout item reads is a structural edit: commit() keeps the bytes.
        let v = s::AlignByField::view(bytes.clone()).unwrap();
        v.set_align(8).unwrap();
        assert_eq!(v.commit().unwrap(), bytes);
        // The target is no longer aligned where it was: it moves (append, splice), or fails (error).
        assert_eq!(v.commit_with(yr::Grow::Splice).unwrap(), unhex("080208${"00".repeat(5)}aabb"));
        let v = s::AlignByField::view(bytes.clone()).unwrap();
        v.set_align(8).unwrap();
        assert_eq!(v.commit_with(yr::Grow::Append).unwrap(), unhex("080208${"00".repeat(5)}aabb"));
        let v = s::AlignByField::view(bytes.clone()).unwrap();
        v.set_align(8).unwrap();
        assert!(v.commit_with(yr::Grow::Error).is_err());
        // Still aligned where it was: append keeps it there (serializing would move it to 3).
        let v = s::AlignByField::view(bytes.clone()).unwrap();
        v.set_align(1).unwrap();
        assert_eq!(v.commit_with(yr::Grow::Append).unwrap(), unhex("01020400aabb"));
        let v = s::AlignByField::view(bytes.clone()).unwrap();
        v.set_align(1).unwrap();
        assert_eq!(v.commit_with(yr::Grow::Splice).unwrap(), unhex("010203aabb"));
        // An alignment of 0 fails the commit.
        let v = s::AlignByField::view(bytes.clone()).unwrap();
        v.set_align(0).unwrap();
        assert_eq!(v.commit_with(yr::Grow::Append).unwrap_err().code, yr::ErrorCode::Range);
    }

    #[test]
    fn replaced_targets_are_appended_at_the_fields_alignment() {
        let bytes = unhex("080208${"00".repeat(5)}aabb");
        let v = s::AlignByField::view(bytes.clone()).unwrap();
        v.replace_data(vec![1, 2, 3]).unwrap();
        assert_eq!(v.offset().unwrap(), 16);
        let out = v.commit().unwrap();
        assert_eq!(out.len(), 19);
        let full = s::AlignByField::parse(&out).unwrap();
        assert_eq!(full.data, vec![1, 2, 3]);
    }
}
`;

describe.skipIf(!hasRust)("rust backend: layout items that read fields", () => {
  let b: Built;
  beforeAll(async () => {
    b = await build("yaffle_t_layout_fields", [{ name: "s", program: realProgram(), views: true }]);
  }, 600_000);

  const ser = (root: string, json: unknown) =>
    b.value({ op: "serialize", module: "s", root, json });
  /** Parse, serialize back, and the same through the view. */
  const rt = async (root: string, bytes: string, json: unknown) => {
    expect(await b.value({ op: "parse", module: "s", root, bytes })).toEqual(json);
    expect(await ser(root, json)).toBe(bytes);
    expect(await b.value({ op: "view:rt", module: "s", root, bytes })).toEqual({
      json,
      rt: { hex: bytes }
    });
  };
  const serErr = async (root: string, json: unknown) =>
    (await b.error({ op: "serialize", module: "s", root, json })).code;

  it("compiles without warnings", () => {
    expect(b.warnings, b.log).toBe(0);
  });

  it("aligns by an input field; below 1 is RANGE", async () => {
    await rt("AlignByField", "080108" + "00".repeat(5) + "cc", {
      align: 8,
      size: 1,
      offset: 8,
      data: "cc"
    });
    expect(await ser("AlignByField", { align: 1, data: "ddeeff" })).toBe("010303ddeeff");
    expect(await serErr("AlignByField", { align: 0, data: "aa" })).toBe("RANGE");
    expect(await serErr("SignedAlign", { align: -4, data: "aa" })).toBe("RANGE");
    expect(await ser("SignedAlign", { align: 4, data: "aa" })).toBe("040104" + "00" + "aa");
  });

  it("aligns by a derived field, a parameter and $index", async () => {
    // al = 1 << 2 = 4: header 4 bytes, data at 4.
    await rt("DerivedAlign", "02040104" + "aa", { lg: 2, al: 4, size: 1, offset: 4, data: "aa" });
    expect(await ser("DerivedAlign", { lg: 3, data: "aa" })).toBe(
      "03080108" + "00".repeat(4) + "aa"
    );
    // k = 3 → align 6: header 3 bytes, data at 6.
    await rt("ByParam", "030106" + "000000" + "aa", {
      k: 3,
      inner: { size: 1, offset: 6, data: "aa" }
    });
    expect(await serErr("ByParam", { k: 0, inner: { data: "aa" } })).toBe("RANGE");
    // recs[0].body aligned to 2 (at 6), recs[1].body to 4 (at 8).
    await rt("ByIndex", "02" + "0106" + "0208" + "00" + "aa" + "00" + "bbcc", {
      count: 2,
      recs: [
        { n: 1, ofs: 6, body: "aa" },
        { n: 2, ofs: 8, body: "bbcc" }
      ]
    });
  });

  it("aligns group items by the owning struct's field", async () => {
    const vols = [
      { a: { v: 1 }, b: { v: 2 } },
      { a: { v: 3 }, b: { v: 4 } }
    ];
    await rt("Grp", "0202" + "0706" + "0908" + "02010403", { al: 2, n: 2, vols });
    await rt("Grp", "0402" + "0908" + "0d0c" + "0000" + "0201" + "0000" + "0403", {
      al: 4,
      n: 2,
      vols
    });
    expect(await serErr("Grp", { al: 0, vols })).toBe("RANGE");
  });

  it("lays out again in view commits and replaces targets aligned (Rust tests)", async () => {
    const r = await testHarness({
      dir: scratch("yaffle_t_layout_fields_views"),
      crateName: "yaffle_t_layout_fields_views",
      modules: [{ name: "s", program: realProgram(), views: true }],
      tests: VIEW_TESTS
    });
    expect(r.ok, r.output.slice(0, 20000)).toBe(true);
    expect(r.passed).toBe(2);
    expect(r.output).not.toMatch(/warning/);
  }, 600_000);
});
