import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatSource } from "../../src/frontend/format.ts";
import { compileSource } from "../../src/index.ts";

const fmt = (s: string) => {
  const r = formatSource(s);
  expect(r.formatted).toBe(true);
  return r.text;
};

/** Formatting is idempotent and keeps the program the same. */
function stable(s: string): string {
  const once = fmt(s);
  expect(fmt(once), "idempotent").toBe(once);
  const a = compileSource(s);
  const b = compileSource(once);
  expect(b.diagnostics.map(d => d.code)).toEqual(a.diagnostics.map(d => d.code));
  if (a.program) {
    const strip = (p: unknown) =>
      JSON.stringify(p, (k, v) => (k === "source" || k === "start" || k === "end" ? undefined : v));
    expect(strip(b.program)).toBe(strip(a.program));
  }
  return once;
}

describe("formatter", () => {
  it("canonical spacing, indentation and no semicolons", () => {
    expect(stable("struct S{u16 a;u32 b;\n}")).toBe("struct S {\n  u16 a\n  u32 b\n}\n");
  });

  it("aligns consecutive fields in columns, and their comments", () => {
    // no alignment in the source: aligned from scratch; the pointer's `*` hangs before the names
    expect(
      stable(
        "struct E {\n u16 handler // h\n u32be crc // fixed\n Entry *e : u64\n}\nstruct Entry { u8 x }"
      )
    ).toBe(
      "struct E {\n  u16    handler  // h\n  u32be  crc      // fixed\n  Entry *e : u64\n}\n\nstruct Entry { u8 x }\n"
    );
    // comments the source aligned stay aligned with each other
    expect(stable("struct E {\n u16 handler // h\n u32be crc   // fixed\n}")).toBe(
      "struct E {\n  u16   handler // h\n  u32be crc     // fixed\n}\n"
    );
  });

  it("keeps the alignment the author chose", () => {
    // a fixed comment column, wider than needed; a type too wide for the name column overflows
    const header = `struct H {
  u32 magic = 0x5b745163
  u32 x04                              // never read
  u32 nodeSize = nodes.length * 24 where it % 24 == 0
  VolInfo vols[2]
  u8  unknown1[4]                      // unknown
  u32 sectorSize where it % 0x400 == 0 // 0x800
}
`;
    expect(stable(header)).toBe(header);
    // two groups aligned differently in one run, and a pointer group next to a plain one
    const groups = `struct T {
  u16  block                           // block index
  i32  alignRel = 4
  u32  n
  Value       values[n]                // values
  u32         nFlagged = n | 0x10000000
  SortedTable(n) sorted                // sorted
}

struct R {
  MeshData  *model   : u64 @nullable
  SoundBank *bank    : u64 @nullable    // a chain
  u16 flags                               // bit 0
  u16 x22                                 // 1, 3, 4
      @padAfter(4) @strict                // +0x24: zero
}
`;
    expect(stable(groups)).toBe(groups);
    // clause columns
    const clauses = `struct A {
  str     pool[until ""]              // sorted
  Record  records[r]       at recordsOfs
  u8      index[s]         at indexOfs        // set i
  Record *recPtrs[r] : u64 at recPtrsOfs @ref // element k
}
`;
    expect(stable(clauses)).toBe(clauses);
  });

  it("snaps lines into an existing alignment", () => {
    expect(stable("struct S {\n  u32   a  // x\n  u8 b // y\n  u16 c\n}")).toBe(
      "struct S {\n  u32   a  // x\n  u8    b  // y\n  u16   c\n}\n"
    );
  });

  it("aligns from scratch only rows of similar width", () => {
    expect(stable("struct S {\n  u32 a\n  u8 b\n  Entry e\n}")).toBe(
      "struct S {\n  u32   a\n  u8    b\n  Entry e\n}\n"
    );
    expect(stable("struct S {\n  ClipGroup *group : u64 @ref\n  u32 x08\n  f32 x0c\n}")).toBe(
      "struct S {\n  ClipGroup *group : u64 @ref\n  u32 x08\n  f32 x0c\n}\n"
    );
    // later columns are never aligned from scratch
    expect(stable("struct S {\n  u32 a = 1\n  u32 bbbb = 2\n}")).toBe(
      "struct S {\n  u32 a = 1\n  u32 bbbb = 2\n}\n"
    );
  });

  it("keeps comment lines written under a trailing comment", () => {
    const src = `struct S {
  @strict {                           // header
    u32  size                         // the whole file. Stored:
                                      // no sizeof(this)
    u64  base = 0                     // 0 in files
    u32  version in (2..4)            // 4 in 1.44
         @padAfter(2)                 // +0x14, +0x15: zero
  }
}
`;
    expect(stable(src)).toBe(src);
    const decl = `extern codec c(u32 n)    // one\n${" ".repeat(25)}// two\n`;
    expect(stable(decl)).toBe(decl);
  });

  it("blank lines separate alignment groups and are kept (at most one)", () => {
    expect(stable("struct S {\n  u8 a\n\n\n\n  u32 bbb\n  u8 c\n}")).toBe(
      "struct S {\n  u8 a\n\n  u32 bbb\n  u8  c\n}\n"
    );
  });

  it("keeps comments: leading, trailing, inside bodies, at the end", () => {
    const src = `// file comment

/** doc */
struct S {
  // leading
  u8 a // trailing
  /* block */
  u8 b
  // last in body
}
// end`;
    expect(stable(src)).toBe(`// file comment

/** doc */
struct S {
  // leading
  u8 a  // trailing
  /* block */
  u8 b
  // last in body
}
// end
`);
  });

  it("keeps members with comments in the middle verbatim", () => {
    const src = "struct S {\n  u32 n = /* keep me */ 4\n}";
    expect(stable(src)).toBe("struct S {\n  u32 n = /* keep me */ 4\n}\n");
  });

  it("normalizes expressions and clauses", () => {
    expect(
      stable("struct S{u32 n=a+b*(c-1)\nu32 a at x*0x800\nu32 v in(1,2,5..9) where it%4==0}")
    ).toBe(
      "struct S {\n  u32 n = a + b * (c - 1)\n  u32 a at x * 0x800\n  u32 v in (1, 2, 5..9) where it % 4 == 0\n}\n"
    );
  });

  it("keeps @ continuation lines, aligned under the first attribute (or the name)", () => {
    expect(stable("struct S {\n  u64 offset @align(8)\n      @padAfter(8)\n  u8 x\n}")).toBe(
      "struct S {\n  u64 offset @align(8)\n             @padAfter(8)\n  u8  x\n}\n"
    );
    expect(stable("struct S {\n  u8 a\n  f32 x10\n  @padAfter(4) @strict // zero\n}")).toBe(
      "struct S {\n  u8  a\n  f32 x10\n      @padAfter(4) @strict  // zero\n}\n"
    );
  });

  it("keeps constructs written on one line on one line", () => {
    const src = `struct S {
  u8 v
  if (v > 1) { u8 a } else if (v == 1) { u8 b } else { u8 c }
  @endian(be) { u32 q }
  switch (v) {
    case 1: { u8 c  u8 d }
    default: u32 z
  }
}

struct Mid { u8 a  u8 b  layout { b, a } }
`;
    expect(stable(src)).toBe(src.replace("case 1: {", "case 1:  {"));
  });

  it("keeps a comment after an opening brace on its line", () => {
    const src =
      "struct S {  // s\n  @strict {  // block\n    u8 a\n  }\n  if (a > 0) {  // then\n    u8 b\n  } else {  // else\n    u8 c\n  }\n}\n";
    expect(stable(src)).toBe(src);
  });

  it("formats blocks, if/else chains and switches", () => {
    const src =
      "struct S{u8 v\nif(v>1){\nu8 a}else if(v==1){u8 b}else{u8 c}\nswitch(v){case 1:u8 x\ncase 2,3:u16 yy\ndefault:\nu8 z\nu8 w}\n@endian(be){\nu32 q}}";
    expect(stable(src)).toBe(`struct S {
  u8 v
  if (v > 1) {
    u8 a
  } else if (v == 1) {
    u8 b
  } else {
    u8 c
  }
  switch (v) {
    case 1:    u8  x
    case 2, 3: u16 yy
    default:
      u8 z
      u8 w
  }
  @endian(be) {
    u32 q
  }
}
`);
  });

  it("formats bits, layout, nested declarations", () => {
    const src =
      "struct S{bits u8 @bitorder(msb){bool c:1\nu8 k:3}\nlayout{a,b}\nstruct In{u8 x}\nIn i}";
    expect(stable(src)).toBe(
      "struct S {\n  bits u8 @bitorder(msb) {\n    bool c : 1\n    u8   k : 3\n  }\n  layout { a, b }\n  struct In { u8 x }\n  In i\n}\n"
    );
  });

  it("formats every top-level declaration", () => {
    const src = `import {A,B as C} from "./x.yfl"
import * as ns from "./y.yfl"
export const u32 N=0x800
extern fn h(char p[])->u32
extern async codec oodle @ranged
extern codec chacha(u8 key[32],u64 nonce)
extern type V(u8 max):u64 @size(2)
type F(u8 bits)=i32 as it/(1<<bits)
enum K:u16 @open{A=0,B=1}
union U{A  B}
struct Sp<T>(u32 n){T items[n]}`;
    expect(stable(src)).toBe(`import { A, B as C } from "./x.yfl"
import * as ns from "./y.yfl"
export const u32 N = 0x800
extern fn h(char p[]) -> u32
extern async codec oodle @ranged
extern codec chacha(u8 key[32], u64 nonce)
extern type V(u8 max) : u64 @size(2)
type F(u8 bits) = i32 as it / (1 << bits)
enum K : u16 @open { A = 0, B = 1 }
union U { A  B }
struct Sp<T>(u32 n) { T items[n] }
`);
  });

  it("multi-line enums and unions stay multi-line", () => {
    expect(stable("enum K : u8 {\nA = 1 // one\nB\n}")).toBe(
      "enum K : u8 {\n  A = 1  // one\n  B\n}\n"
    );
    expect(stable("union U {\nA\nB\n}")).toBe("union U {\n  A\n  B\n}\n");
  });

  it("separates multi-line declarations by a blank line", () => {
    expect(stable("struct A {\nu8 x\n}\nstruct B {\nu8 y\n}")).toBe(
      "struct A {\n  u8 x\n}\n\nstruct B {\n  u8 y\n}\n"
    );
  });

  it("refuses files with syntax errors", () => {
    expect(formatSource("struct S { u8 a[ }").formatted).toBe(false);
  });

  it("custom indentation", () => {
    expect(formatSource("struct S {\nu8 a\n}", "/x.yfl", { indent: "\t" }).text).toBe(
      "struct S {\n\tu8 a\n}\n"
    );
  });

  it("is idempotent on the test fixtures", () => {
    for (const f of ["tiff.yfl"]) {
      const text = readFileSync(fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url)), "utf8");
      const once = fmt(text);
      expect(fmt(once), f).toBe(once);
    }
  });

  it("is idempotent and keeps the program on every format and conformance schema", () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const files = globSync(["formats/**/*.yfl", "conformance/**/*.yfl"], { cwd: root });
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const text = readFileSync(root + f, "utf8");
      const once = fmt(text);
      expect(fmt(once), f).toBe(once);
      // same tokens apart from whitespace and semicolons
      const squash = (s: string) => s.replace(/[\s;]+/g, "");
      expect(squash(once), f).toBe(squash(text));
    }
  });

  it("is idempotent on schemas with scrambled spacing", () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const files = globSync(["formats/**/*.yfl", "conformance/**/*.yfl"], { cwd: root });
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (const f of files) {
      const text = readFileSync(root + f, "utf8");
      const variants = [
        text.replace(/(\S)[ \t]+/g, "$1 "),
        text.replace(
          /(\S)([ \t]+)/g,
          (_m, a: string, b: string) =>
            a + " ".repeat(Math.max(1, b.length + Math.floor(rnd() * 5) - 2))
        ),
        text.replace(
          /(\S)([ \t]+)/g,
          (_m, a: string, b: string) =>
            a + (rnd() < 0.3 ? " ".repeat(1 + Math.floor(rnd() * 8)) : b)
        ),
        text.replace(/^[ \t]+/gm, () => " ".repeat(Math.floor(rnd() * 6)))
      ];
      for (const v of variants) {
        const once = fmt(v);
        expect(fmt(once), f).toBe(once);
      }
    }
  });

  it("keeps an empty file empty", () => {
    expect(fmt("")).toBe("");
    expect(fmt("// only a comment\n")).toBe("// only a comment\n");
  });
});
