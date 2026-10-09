import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_CODES } from "../../src/frontend/diagnostics.ts";
import { check, checkFiles, expectDiag, expectNoDiag, fmt } from "../helpers.ts";

/**
 * One positive case (the code is reported) and one negative case (a close, valid variant isn't)
 * for every diagnostic code. `⟦…⟧` marks the expected range.
 */
const CASES: Record<string, { bad: string; good: string; message?: string | RegExp }> = {
  // lexer
  "invalid-character": { bad: "struct S { u32 a ⟦§⟧ }", good: "struct S { u32 a }" },
  "unterminated-string": {
    bad: 'struct S { char t[4] = ⟦"ARCV⟧\n}',
    good: 'struct S { char t[4] = "ARCV" }'
  },
  "unterminated-comment": {
    bad: "struct S { u32 a }\n⟦/*⟧ never closed",
    good: "struct S { u32 a }\n/* closed */"
  },
  "unterminated-regex": {
    bad: "struct S { str v in ⟦/abc⟧\n}",
    good: "struct S { str v in /abc/ }"
  },
  "invalid-escape": { bad: 'struct S { str v = "a⟦\\q⟧" }', good: 'struct S { str v = "a\\n" }' },
  "invalid-number": { bad: "struct S { u8 a[⟦0x⟧] }", good: "struct S { u8 a[0x10] }" },
  "invalid-hex-bytes": { bad: 'const u8 K[2] = ⟦x"abc"⟧', good: 'const u8 K[2] = x"abcd"' },
  "invalid-base64": { bad: 'const u8 K[2] = ⟦b64"!!"⟧', good: 'const u8 K[3] = b64"AQID"' },
  "invalid-fourcc": { bad: "struct S { u32 t = ⟦''⟧ }", good: "struct S { u32le t = 'ARCV' }" },
  // parser
  "syntax-error": { bad: "struct S { u32 a = ⟦)⟧ }", good: "struct S { u32 a = 1 }" },
  "reserved-word": { bad: "struct ⟦if⟧ { u32 a }", good: "struct If { u32 a }" },
  // names
  "unknown-name": {
    bad: "struct S { u32 count  u8 data[⟦cnt⟧] }",
    good: "struct S { u32 count  u8 data[count] }",
    message: "Did you mean 'count'?"
  },
  "unknown-type": {
    bad: "struct S { ⟦Entyr⟧ e }\nstruct Entry { u8 a }",
    good: "struct S { Entry e }\nstruct Entry { u8 a }",
    message: "Did you mean 'Entry'?"
  },
  "unknown-member": {
    bad: "struct H { u32 n }\nstruct S { H h  u8 d[h.⟦m⟧] }",
    good: "struct H { u32 n }\nstruct S { H h  u8 d[h.n] }"
  },
  "unknown-function": {
    bad: "struct S { u8 b[4]  u32 c = ⟦crc33⟧(b) }",
    good: "struct S { u8 b[4]  u32 c = crc32(b) }",
    message: "Did you mean 'crc32'?"
  },
  "unknown-codec": {
    bad: "extern codec zstd\nstruct S { u32 n  u8 d[] @via(⟦zstdd⟧) @size(n) }",
    good: "extern codec zstd\nstruct S { u32 n  u8 d[] @via(zstd) @size(n) }"
  },
  "unknown-attribute": {
    bad: "struct S { u32 a ⟦@algin⟧(4) }",
    good: "struct S { u32 a @align(4) }",
    message: "Did you mean @align?"
  },
  "duplicate-declaration": {
    bad: "struct S { u8 a }\nstruct ⟦S⟧ { u8 b }",
    good: "struct S { u8 a }\nstruct T { u8 b }"
  },
  "duplicate-field": {
    bad: "struct S { u8 a  u16 ⟦a⟧ }",
    good: "struct S { u8 k  if (k > 0) { u8 a } else { u16 a } }"
  },
  "duplicate-param": {
    bad: "struct S(u8 n, u16 ⟦n⟧) { u8 d[n] }",
    good: "struct S(u8 n, u16 m) { u8 d[n + m] }"
  },
  "duplicate-enum-member": { bad: "enum E : u8 { A, ⟦A⟧ }", good: "enum E : u8 { A, B }" },
  "duplicate-enum-value": {
    bad: "enum E : u8 { A = 1, ⟦B⟧ = 1 }",
    good: "enum E : u8 { A = 1, B = 2 }"
  },
  "duplicate-variant": {
    bad: "struct A { u8 x }\nunion U { A ⟦A⟧ }",
    good: "struct A { u8 x }\nstruct B { u8 y }\nunion U { A B }"
  },
  "duplicate-attribute": {
    bad: "struct S { u32 a @hidden ⟦@hidden⟧ = 1 }",
    good: "struct S { u32 a @hidden = 1 }"
  },
  "forward-reference": {
    bad: "struct S { u8 d[⟦n⟧]  u32 n }",
    good: "struct S { u32 n  u8 d[n] }",
    message: "declared later"
  },
  "possibly-absent": {
    bad: "struct S { u8 v  if (v > 1) { u32 n }  u8 d[⟦n⟧] }",
    good: "struct S { u8 v  if (v > 1) { u32 n  u8 d[n] } }"
  },
  "missing-binding": {
    bad: "export struct R { M m }\nstruct M { if (⟦$version⟧ > 1) { u8 x } }",
    good: "export struct R { u32 $version  M m }\nstruct M { if ($version > 1) { u8 x } }",
    message: "on the path R → m (M)"
  },
  "bound-shadowing": {
    bad: "export struct R { u32 $v  M m }\nstruct M { u16 ⟦v⟧  u8 d[$v] }\n".replace(
      "u16 ⟦v⟧",
      "u16 $⟦v⟧"
    ),
    good: "export struct R { u32 $v  M m }\nstruct M { u8 d[$v] }"
  },
  "bound-type-conflict": {
    bad: "export struct R { u32 $v  M m }\nexport struct Q { char $⟦v⟧[4]  M m }\nstruct M { u8 x }",
    good: "export struct R { u32 $v  M m }\nexport struct Q { u16 $v  M m }\nstruct M { u8 x }"
  },
  "outer-unavailable": {
    bad: "struct O { u32 n  struct I { u8 d[n] } }\nexport struct X { ⟦O.I⟧ i }",
    good: "export struct O { u32 n  struct I { u8 d[n] }  I i }"
  },
  "index-unavailable": {
    bad: "export struct R { E e }\nstruct E { u8 d[⟦$index⟧] }",
    good: "export struct R { E e[4] }\nstruct E { u8 d[$index] }"
  },
  "self-reference": { bad: "struct S { u8 n[⟦n⟧] }", good: "struct S { u8 n  u8 d[n] }" },
  // types
  "type-mismatch": { bad: 'struct S { u8 d[⟦"x"⟧] }', good: "struct S { u8 d[4] }" },
  "value-out-of-range": { bad: "struct S { u8 a = ⟦300⟧ }", good: "struct S { u8 a = 255 }" },
  "string-too-long": {
    bad: 'struct S { char t[2] = ⟦"ARCV"⟧ }',
    good: 'struct S { char t[4] = "ARCV" }'
  },
  "fourcc-size": { bad: "struct S { u16 t = ⟦'ARCV'⟧ }", good: "struct S { u32 t = 'ARCV' }" },
  "fourcc-endian": {
    bad: "struct S { u32 t  switch (t) { case ⟦'ARCV'⟧: u8 a } }",
    good: "struct S { u32le t  switch (t) { case 'ARCV': u8 a } }"
  },
  "wrong-argument-count": {
    bad: "struct B(u32 n) { u8 d[n] }\nstruct S { ⟦B⟧ b }",
    good: "struct B(u32 n) { u8 d[n] }\nstruct S { B(4) b }"
  },
  "unknown-argument": {
    bad: "struct B(u32 n) { u8 d[n] }\nstruct S { B(⟦m⟧: 4) b }",
    good: "struct B(u32 n) { u8 d[n] }\nstruct S { B(n: 4) b }"
  },
  "duplicate-argument": {
    bad: "struct B(u32 n) { u8 d[n] }\nstruct S { B(4, ⟦n: 5⟧) b }",
    good: "struct B(u32 n) { u8 d[n] }\nstruct S { B(n: 5) b }"
  },
  "wrong-type-argument-count": {
    bad: "struct P { u8 x }\nstruct Sp<T> { T t }\nstruct S { ⟦Sp⟧ s }",
    good: "struct P { u8 x }\nstruct Sp<T> { T t }\nstruct S { Sp<P> s }"
  },
  "generic-argument": {
    bad: "struct B(u32 n) { u8 d[n] }\nstruct Sp<T> { T t }\nstruct S { u32 k  Sp<⟦B(k)⟧> s }",
    good: "struct B(u32 n) { u8 d[n] }\nstruct Sp<T> { T t }\nstruct S { Sp<B(4)> s }"
  },
  "not-a-type": {
    bad: "const u32 N = 4\nstruct S { ⟦N⟧ x }",
    good: "const u32 N = 4\nstruct S { u8 x[N] }"
  },
  "not-a-value": {
    bad: "struct P { u8 x }\nstruct S { u8 d[⟦P⟧] }",
    good: "struct P { u8 x }\nstruct S { u8 d[sizeof(P)] }"
  },
  "not-constant": { bad: "struct S { u8 n  u8 b : ⟦n⟧ }", good: "struct S { u8 n  u8 b : 4 }" },
  "division-by-zero": { bad: "const u32 N = ⟦4 / 0⟧", good: "const u32 N = 4 / 2" },
  "alias-cycle": {
    bad: "type A = B\ntype B = ⟦A⟧\nstruct S { A a }",
    good: "type A = u32\ntype B = A\nstruct S { B a }"
  },
  "recursive-struct": {
    bad: "export struct L { u8 v  L ⟦next⟧ }",
    good: "export struct L { u8 v  if (v > 0) { L next } }"
  },
  "const-cycle": {
    bad: "const u32 A = B\nconst u32 B = ⟦A⟧",
    good: "const u32 A = 1\nconst u32 B = A"
  },
  "not-implemented": {
    bad: "struct S { char s⟦[before 0]⟧ }",
    good: 'struct S { str pool[before ""] }'
  },
  "invalid-regex": {
    bad: "struct S { str v in ⟦/(a)\\1/⟧ }",
    good: "struct S { str v in /(a)b/ }"
  },
  "invalid-stream": {
    bad: "struct P { u8 x }\nstruct S { u32 r  P p from ⟦r⟧ }",
    good: "struct P { u8 x }\nstruct S { u8 r[4]  P p from r }"
  },
  "invalid-length": { bad: "struct S { char s[until ⟦1⟧] }", good: "struct S { char s[until 0] }" },
  "rest-not-last": {
    bad: "struct S { u8 ⟦rest⟧[]  u32 after }",
    good: "struct S { u32 n  u8 rest[] @size(n)  u32 after }"
  },
  "unreachable-case": {
    bad: "struct S { u8 t  switch (t) { case 1: u8 a  case ⟦1⟧: u16 b } }",
    good: "struct S { u8 t  switch (t) { case 1: u8 a  case 2: u16 b } }"
  },
  "invalid-case": {
    bad: "struct S { u8 t  u8 n  switch (t) { case ⟦n⟧: u8 a } }",
    good: "const u8 ONE = 1\nstruct S { u8 t  switch (t) { case ONE: u8 a } }"
  },
  // attributes
  "invalid-attribute-target": {
    bad: "struct S { u32 a ⟦@base⟧ }",
    good: "struct S @base { u32 a }"
  },
  "invalid-attribute-argument": {
    bad: "struct S { u32 a @align⟦(4, 5, 6)⟧ }",
    good: "struct S { u32 a @align(4, 5) }"
  },
  // bitfields, enums, pointers
  "bitfield-overflow": {
    bad: "struct S { bits u8 { u8 a : 5  u8 b : ⟦4⟧ } }",
    good: "struct S { bits u8 { u8 a : 4  u8 b : 4 } }"
  },
  "bitfield-width": { bad: "struct S { u8 a : ⟦9⟧ }", good: "struct S { u8 a : 8 }" },
  "bitfield-type": {
    bad: "struct S { bits ⟦f32⟧ { u8 a : 4 } }",
    good: "struct S { bits u32 { u8 a : 4 } }"
  },
  "enum-value-range": { bad: "enum E : u8 { A = ⟦256⟧ }", good: "enum E : u8 { A = 255 }" },
  "pointer-storage": {
    bad: "struct P { u8 x }\nstruct S { P *p : ⟦f32⟧ }",
    good: "struct P { u8 x }\nstruct S { P *p : u32 }"
  },
  "pointer-attribute": {
    bad: "struct S { u32 a ⟦@relative⟧ }",
    good: "struct P { u8 x }\nstruct S { P *p : i32 @relative }"
  },
  // derivation and consistency
  "contradictory-formula": {
    bad: "struct S { u32 n ⟦= d.length + 1⟧  u8 d[n] }",
    good: "struct S { u32 n  u8 d[n] }"
  },
  "formula-mismatch": {
    bad: "struct S { u32 n ⟦= d.length * 4⟧  u8 d[(n + 7) / 8] }",
    good: "struct S { u32 n = d.length * 8  u8 d[(n + 7) / 8] }"
  },
  "lossy-formula": {
    bad: "struct S { u32 n ⟦= d.length * 8⟧  u8 d[(n + 7) / 8] }",
    good: "struct S { u32 n = d.length / 2  u8 d[n * 2] }"
  },
  "redundant-formula": {
    bad: "struct S { u32 n ⟦= d.length⟧  u8 d[n] }",
    good: "struct S { u32 n  u8 d[n] }"
  },
  "size-inside-codec": {
    bad: "extern codec zstd\nstruct S { u32 n  u8 d[] ⟦@size(n)⟧ @via(zstd) }",
    good: "extern codec zstd\nstruct S { u32 n  u8 d[] @via(zstd) @size(n) }"
  },
  "layout-cycle": {
    bad: "struct P { u8 x }\nstruct S @base { uleb128 ⟦o⟧  P p at o }",
    good: "struct P { u8 x }\nstruct S @base { u32 o  P p at o }"
  },
  "hidden-not-derivable": {
    bad: "struct S { u32 a ⟦@hidden⟧ }",
    good: "struct S { u32 a @hidden = 7 }"
  },
  "unknown-layout-path": {
    bad: "struct P { u8 x }\nstruct S { P *p : u64  layout { ⟦q⟧ } }",
    good: "struct P { u8 x }\nstruct S { P *p : u64  layout { p } }"
  },
  "layout-not-placeable": {
    bad: "struct S { u32 a  layout { ⟦a⟧ } }",
    good: "struct P { u8 x }\nstruct S { P *p : u64  layout { p } }"
  },
  "duplicate-layout-item": {
    bad: "struct P { u8 x }\nstruct S { P *p : u64  layout { p, ⟦p⟧ } }",
    good: "struct P { u8 x }\nstruct S { P *p : u64  layout { p, this } }"
  },
  "one-way-transform": {
    bad: "extern fn hex(u32 v) -> str\nstruct S { u32 h ⟦as hex(it)⟧ }",
    good: "struct S { u16 a as it * 360.0 / 65536 }"
  },
  "not-invertible": {
    bad: "extern fn d(u32 v) -> u32\nstruct S { u32 t as d(it) = ⟦5⟧ }",
    good: "extern fn d(u32 v) -> u32\nextern fn e(u32 v) -> u32\nstruct S { u32 t as d(it) = e(it) }"
  },
  // virtual fields, derived arrays, slices
  "invalid-virtual": {
    bad: "struct S { u8 a  virtual ⟦f32⟧ v = a }",
    good: "struct S { u8 a  virtual u16 v = a }"
  },
  "virtual-not-reversible": {
    bad: "struct S { u8 hi  u32 lo  virtual u64 v ⟦= (hi << 16) | lo⟧ }",
    good: "struct S { u8 hi  u32 lo  virtual u64 v = (hi << 32) | lo }",
    message: "Shift 'hi' by at least 32"
  },
  "invalid-lambda": {
    bad: "struct S { u8 n  u8 xs[n]  u8 c[2] = filter(xs, ⟦x⟧) }",
    good: "struct S { u8 n  u8 xs[n]  u8 c[2] = filter(xs, x => x > 1) }"
  },
  "slice-carrier-input": {
    bad: "struct P { u16 a }\nstruct S { u8 ⟦raw⟧[8]  P p from raw[0..2] }",
    good: "struct P { u16 a }\nstruct S { u8 raw[8] @hidden  P p from raw[0..2] }",
    message: "bytes 2..8 aren't covered"
  },
  "slice-overlap": {
    bad: "struct P { u16 a }\nstruct S { u8 raw[4]  P p from raw[0..2]  P q ⟦from raw[1..3]⟧  P r from raw[2..4] }",
    good: "struct P { u16 a }\nstruct S { u8 raw[4]  P p from raw[0..2]  P q from raw[2..4] }"
  },
  // project
  "import-not-found": {
    bad: 'import { A } from ⟦"./missing.yfl"⟧\nstruct S { u8 x }',
    good: "struct S { u8 x }"
  },
  "unknown-import-name": { bad: "", good: "" },
  "unused-import": { bad: "", good: "" },
  "duplicate-import": { bad: "", good: "" },
  "extern-missing-implementation": { bad: "", good: "" },
  "config-error": { bad: "", good: "" }
};

const MULTI_FILE = new Set([
  "unknown-import-name",
  "unused-import",
  "duplicate-import",
  "extern-missing-implementation",
  "config-error"
]);

describe("every diagnostic code has a test case", () => {
  it("covers the whole registry", () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(DIAGNOSTIC_CODES).sort());
  });
});

describe("diagnostics: positive and negative", () => {
  for (const [code, c] of Object.entries(CASES)) {
    if (MULTI_FILE.has(code)) continue;
    it(`${code}: reported`, () => {
      expectDiag(c.bad, code, c.message);
    });
    it(`${code}: not reported for valid code`, () => {
      expectNoDiag(c.good, code);
    });
  }
});

describe("diagnostics: modules", () => {
  const common =
    "export struct Span { u32 n }\nexport const u32 SECTOR = 0x800\nstruct Hidden { u8 x }";
  it("unknown-import-name with a suggestion", () => {
    const r = checkFiles({
      "/p/main.yfl": 'import { Spam } from "./common.yfl"\nstruct S { u8 x }',
      "/p/common.yfl": common
    });
    const d = r.diagnostics.find(x => x.code === "unknown-import-name")!;
    expect(d.message).toContain("Did you mean 'Span'?");
    expect(d.fixes?.[0]?.edit.changes["/p/main.yfl"]?.[0]?.newText).toBe("Span");
  });
  it("imports work without .yfl and any declaration can be imported", () => {
    const r = checkFiles({
      "/p/main.yfl":
        'import { Span, Hidden } from "./common"\nexport struct S { Span s  Hidden h }',
      "/p/common.yfl": common
    });
    expect(r.diagnostics.filter(d => d.severity === "error").map(fmt)).toEqual([]);
  });
  it("unused-import: reported with a removal fix, not when used", () => {
    const r = checkFiles({
      "/p/main.yfl": 'import { Span, SECTOR } from "./common.yfl"\nexport struct S { Span s }',
      "/p/common.yfl": common
    });
    const d = r.diagnostics.filter(x => x.code === "unused-import");
    expect(d.map(x => x.message)).toEqual(["'SECTOR' is imported but never used."]);
    expect(d[0]!.tags).toEqual(["unnecessary"]);
    expect(d[0]!.fixes?.[0]?.title).toBe("Remove 'SECTOR'");
    const ok = checkFiles({
      "/p/main.yfl":
        'import { Span, SECTOR } from "./common.yfl"\nexport struct S { Span s  u8 d[SECTOR] }',
      "/p/common.yfl": common
    });
    expect(ok.diagnostics.filter(x => x.code === "unused-import")).toEqual([]);
  });
  it("unused namespace import", () => {
    const r = checkFiles({
      "/p/main.yfl": 'import * as c from "./common.yfl"\nexport struct S { u8 x }',
      "/p/common.yfl": common
    });
    expect(r.diagnostics.some(x => x.code === "unused-import")).toBe(true);
    const ok = checkFiles({
      "/p/main.yfl":
        'import * as c from "./common.yfl"\nexport struct S { c.Span s  u8 d[c.SECTOR] }',
      "/p/common.yfl": common
    });
    expect(ok.diagnostics.filter(x => x.severity === "error").map(fmt)).toEqual([]);
    expect(ok.diagnostics.some(x => x.code === "unused-import")).toBe(false);
  });
  it("duplicate-import: twice, or clashing with a local declaration", () => {
    const r = checkFiles({
      "/p/main.yfl":
        'import { Span } from "./common.yfl"\nimport { Span } from "./common.yfl"\nstruct S { Span s }',
      "/p/common.yfl": common
    });
    expect(r.diagnostics.some(x => x.code === "duplicate-import")).toBe(true);
    const r2 = checkFiles({
      "/p/main.yfl": 'import { Span } from "./common.yfl"\nstruct Span { u8 x }',
      "/p/common.yfl": common
    });
    expect(r2.diagnostics.some(x => x.code === "duplicate-import")).toBe(true);
    const ok = checkFiles({
      "/p/main.yfl": 'import { Span as S2 } from "./common.yfl"\nstruct Span { S2 s }',
      "/p/common.yfl": common
    });
    expect(ok.diagnostics.some(x => x.code === "duplicate-import")).toBe(false);
  });
  it("extern-missing-implementation only with configured targets", () => {
    const src =
      "extern fn pathHash(char p[]) -> u32\nextern codec zstd\nexport struct S { char p[4]  u32 h = pathHash(p) }";
    expect(check(src).diagnostics.some(d => d.code === "extern-missing-implementation")).toBe(
      false
    );
    const r = check(src, { targets: { ts: { out: "gen", externs: { pathHash: "./hash.ts" } } } });
    const ds = r.diagnostics.filter(d => d.code === "extern-missing-implementation");
    expect(ds.map(d => d.message)).toEqual([
      "Extern 'zstd' has no implementation for target 'ts'. Add it to targets.ts.externs in yaffle.json."
    ]);
    expect(ds[0]!.severity).toBe("warning");
  });
  it("cross-file cycles between types are allowed", () => {
    const r = checkFiles({
      "/p/a.yfl": 'import { B } from "./b.yfl"\nexport struct A { u8 n  if (n > 0) { B b } }',
      "/p/b.yfl": 'import { A } from "./a.yfl"\nexport struct B { u8 m  if (m > 0) { A a } }'
    });
    expect(r.diagnostics.filter(d => d.severity === "error").map(fmt)).toEqual([]);
    expect(r.program!.modules.map(m => m.path).sort()).toEqual(["a.yfl", "b.yfl"]);
  });
  it("imports resolve relative to the importing file", () => {
    const r = checkFiles({
      "/p/x/main.yfl": 'import { C } from "../lib/c.yfl"\nexport struct M { C c }',
      "/p/lib/c.yfl": "export struct C { u8 v }"
    });
    expect(r.diagnostics.filter(d => d.severity === "error").map(fmt)).toEqual([]);
    expect(r.program!.modules.map(m => m.path)).toEqual(["lib/c.yfl", "x/main.yfl"]);
  });
  it("import-not-found has no other fallout", () => {
    const r = check('import { A } from "./nope.yfl"\nexport struct S { u8 x }');
    expect(r.diagnostics.map(d => d.code)).toEqual(["import-not-found"]);
  });
  it("a module can't import itself", () => {
    const r = checkFiles({ "/p/a.yfl": 'import { A } from "./a.yfl"\nstruct A { u8 x }' });
    expect(
      r.diagnostics.some(d => d.code === "import-not-found" && d.message.includes("itself"))
    ).toBe(true);
  });
});

describe("diagnostics: quick fixes and details", () => {
  it("unknown-name offers a rename fix", () => {
    const d = expectDiag("struct S { u32 count  u8 data[cnt] }", "unknown-name");
    expect(d.fixes?.[0]?.title).toBe("Change to 'count'");
  });
  it("unknown-name hints at $ for bound values", () => {
    expectDiag(
      "export struct R { u32 $version  M m }\nstruct M { u8 d[version] }",
      "unknown-name",
      "written $version"
    );
  });
  it("unknown-type offers an import from another module", () => {
    const r = checkFiles(
      { "/p/main.yfl": "struct S { Span s }", "/p/common.yfl": "export struct Span { u32 n }" },
      "/p/main.yfl"
    );
    expect(r.diagnostics.length).toBe(1);
    const d = r.diagnostics[0]!;
    expect(d.code).toBe("unknown-type");
    // the other module isn't loaded unless imported: no import fix, but still a clean error
    expect(d.message).toContain("Unknown type 'Span'");
  });
  it("unknown-type suggests yaffle types for C names", () => {
    const d = expectDiag("struct S { uint32_t a }", "unknown-type", "Did you mean 'u32'?");
    expect(d.fixes?.[0]?.edit.changes["/memory/main.yfl"]?.[0]?.newText).toBe("u32");
  });
  it("type-mismatch float → int offers round()", () => {
    const d = expectDiag("struct S { f32 x  u32 y = x * 2 }", "type-mismatch", "must be u32");
    expect(d.fixes?.[0]?.title).toBe("Wrap in round()");
    expect(d.fixes?.[0]?.edit.changes["/memory/main.yfl"]?.[0]?.newText).toBe("round(x * 2)");
  });
  it("redundant-formula offers to remove the formula", () => {
    const d = expectDiag("struct S { u32 n = d.length  u8 d[n] }", "redundant-formula");
    expect(d.severity).toBe("hint");
    expect(d.tags).toEqual(["unnecessary"]);
    const edit = d.fixes![0]!.edit.changes["/memory/main.yfl"]![0]!;
    expect(edit.newText).toBe("");
    expect(edit.range).toEqual({
      start: { line: 0, character: 16 },
      end: { line: 0, character: 27 }
    });
  });
  it("redundant-formula recognizes equivalent forms", () => {
    expectDiag("struct S { u32 p = ids.length / 2  u16 ids[p * 2] }", "redundant-formula");
    expectDiag("struct S @base { u64 o = offsetof(t)  u32 t at o }", "redundant-formula");
    expectDiag(
      "extern codec zstd\nstruct S { u32 c = sizeof(d)  u8 d[] @via(zstd) @size(c) }",
      "redundant-formula"
    );
  });
  it("lossy-formula only counts values the field's checks allow (nodeSize)", () => {
    // without the check, nodeSize 1 would read like 0; with it, 1 can't be read at all
    expectNoDiag(
      "struct Node { u8 b[24] }\nstruct S { u32 nodeSize = nodes.length * 24 where it % 24 == 0  Node nodes[nodeSize / 24] }",
      "lossy-formula"
    );
    expectNoDiag("struct S { u8 n = d.length * 4 in (0, 4, 8, 12)  u8 d[n / 4] }", "lossy-formula");
    // a check that still allows two values reading the same is lossy
    expectDiag("struct S { u32 n = d.length * 4 where it % 2 == 0  u8 d[n / 4] }", "lossy-formula");
    // a bitfield's width bounds its values too
    expectNoDiag("struct S { bits u8 { u8 n : 1  u8 : 7 }  u8 d[n] }", "lossy-formula");
  });
  it("lossy-formula offers to drop the formula", () => {
    const d = expectDiag(
      "struct S { u32 n = flags.length * 8  u8 flags[(n + 7) / 8] }",
      "lossy-formula"
    );
    expect(d.fixes?.[0]?.title).toBe("Remove the formula");
  });
  it("size-inside-codec offers to move @size after @via", () => {
    const src = "extern codec zstd\nstruct S { u32 n  u8 d[] @size(n) @via(zstd) }";
    const d = expectDiag(src, "size-inside-codec");
    const edits = d.fixes![0]!.edit.changes["/memory/main.yfl"]!;
    expect(edits.map(e => e.newText)).toEqual(["", " @size(n)"]);
  });
  it("size-inside-codec doesn't apply to streaming codecs or with an outer size", () => {
    expectNoDiag(
      "extern codec inflate @streaming\nstruct S { u32 n  u8 d[] @size(n) @via(inflate) }",
      "size-inside-codec"
    );
    expectNoDiag(
      "extern async codec oodle\nstruct S { u32 a  u32 b  u8 d[] @size(a) @via(oodle) @size(b) }",
      "size-inside-codec"
    );
  });
  it("missing-binding offers to add a parameter to the root", () => {
    const d = expectDiag(
      "export struct R { M m }\nstruct M { if ($version > 1) { u8 x } }",
      "missing-binding"
    );
    expect(d.fixes?.[0]?.title).toBe("Add parameter u32 $version to R");
    expect(d.fixes?.[0]?.edit.changes["/memory/main.yfl"]?.[0]?.newText).toBe("(u32 $version)");
    expect(d.related?.[0]?.message).toBe("the path starts at export R");
  });
  it("missing-binding when nothing binds the value at all", () => {
    expectDiag("struct M { if ($nope > 1) { u8 x } }", "missing-binding", "Nothing binds $nope");
  });
  it("missing-binding is satisfied by a declared root parameter", () => {
    expectNoDiag(
      "export struct R(u32 $version) { M m }\nstruct M { if ($version > 1) { u8 x } }",
      "missing-binding"
    );
  });
  it("missing-binding follows every path", () => {
    const r = check(
      "export struct A { u32 $v  M m }\nexport struct B { M m }\nstruct M { u8 d[$v] }"
    );
    const d = r.diagnostics.filter(x => x.code === "missing-binding");
    expect(d.length).toBe(1);
    expect(d[0]!.message).toContain("B → m (M)");
  });
  it("forward-reference points at the declaration", () => {
    const d = expectDiag("struct S { u8 d[n]  u32 n }", "forward-reference");
    expect(d.related?.[0]?.location.range.start).toEqual({ line: 0, character: 24 });
  });
  it("duplicate-field relates to the first declaration", () => {
    const d = expectDiag("struct S { u8 a\n  u16 a }", "duplicate-field");
    expect(d.related?.[0]?.location.range.start).toEqual({ line: 0, character: 14 });
  });
  it("possibly-absent is fine with the same guard", () => {
    expectNoDiag(
      "struct S { u8 v  if (v > 1) { u32 n }  if (v > 1) { u8 d[n] } }",
      "possibly-absent"
    );
    expectNoDiag("struct S { u8 v  if (v > 1) { u32 n }  u8 d[v > 1 ? n : 0] }", "possibly-absent");
    expectNoDiag(
      "struct S { u8 t  switch (t) { case 1: u8 n  default: u16 n }  u8 d[n] }",
      "possibly-absent"
    );
    expectDiag(
      "struct S { u8 t  switch (t) { case 1: u8 n  case 2: u16 m }  u8 d[n] }",
      "possibly-absent"
    );
  });
  it("unreachable-case for values outside the field's in (…) and for a useless default", () => {
    expectDiag(
      'struct S { char o[2] in ("II", "MM")  switch (o) { case "XX": u8 a  case "II": u8 b } }',
      "unreachable-case",
      "can only be"
    );
    expectDiag(
      "struct S { bool b  switch (b) { case true: u8 x  case false: u8 y  default: u8 z } }",
      "unreachable-case",
      "default case is unreachable"
    );
    expectDiag(
      "enum E : u8 { A, B }\nstruct S { E e  switch (e) { case A: u8 x  case B: u8 y  default: u8 z } }",
      "unreachable-case",
      "default case is unreachable"
    );
  });
  it("invalid-attribute-target names where the attribute applies", () => {
    expectDiag("struct S { u32 a @open }", "invalid-attribute-target", "it applies to enums");
  });
  it("hidden-not-derivable offers to remove @hidden", () => {
    const d = expectDiag("struct S { u32 a @hidden }", "hidden-not-derivable");
    expect(d.fixes?.[0]?.title).toBe("Remove @hidden");
  });
  it("@hidden derived automatically is fine", () => {
    expectNoDiag("struct S { u32 n @hidden  u8 d[n] }", "hidden-not-derivable");
  });
  it("recursive-struct through another struct", () => {
    expectDiag("export struct A { u8 x  B b }\nstruct B { A a }", "recursive-struct");
    expectNoDiag("export struct A { u8 x  B *b : u32 }\nstruct B { A a }", "recursive-struct");
    expectNoDiag("export struct A { u8 n  A kids[n] }", "recursive-struct");
  });
  it("value-out-of-range for enum comparisons and arguments", () => {
    expectDiag("struct B(u8 n) { u8 d[n] }\nstruct S { B(⟦999⟧) b }", "value-out-of-range");
  });
  it("type errors don't cascade", () => {
    const r = check("struct S { u32 a  u8 d[a + nope]  u8 e[d.length] }");
    expect(r.diagnostics.map(d => d.code)).toEqual(["unknown-name"]);
  });
});
