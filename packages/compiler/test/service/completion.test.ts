import { describe, expect, it } from "vitest";
import { open } from "./util.ts";

function labels(text: string, files: Record<string, string> = {}): string[] {
  const { ls, path, pos } = open(text, "/w/main.yfl", files);
  return ls.getCompletions(path, pos).map(c => c.label);
}

function items(text: string) {
  const { ls, path, pos } = open(text);
  return ls.getCompletions(path, pos);
}

describe("completion", () => {
  it("top level: declaration keywords and snippets", () => {
    const l = labels("|");
    expect(l).toEqual(
      expect.arrayContaining([
        "struct",
        "enum",
        "union",
        "type",
        "extern",
        "const",
        "import",
        "export",
        "struct …",
        "import …"
      ])
    );
    expect(l).not.toContain("u32");
  });

  it("member start: types (built-in and declared), member keywords and snippets", () => {
    const l = labels("struct Entry { u8 x }\nenum K : u8 { A }\nstruct S {\n  |\n}");
    expect(l).toEqual(
      expect.arrayContaining([
        "u32",
        "u32be",
        "bool",
        "char",
        "str",
        "uleb128",
        "Entry",
        "K",
        "S",
        "if",
        "switch",
        "bits",
        "layout",
        "if …"
      ])
    );
    expect(l).not.toContain("x");
  });

  it("member start while typing a type name", () => {
    const l = labels("struct Entry { u8 x }\nstruct S {\n  En|\n}");
    expect(l).toContain("Entry");
  });

  it("type parameters and nested structs", () => {
    const l = labels("struct Sp<T> {\n  struct In { u8 x }\n  |\n}");
    expect(l).toEqual(expect.arrayContaining(["T", "In"]));
  });

  it("imported types and namespaces", () => {
    const l = labels(
      'import { L } from "./lib.yfl"\nimport * as ns from "./lib.yfl"\nstruct S {\n  |\n}',
      { "/w/lib.yfl": "export struct L { u8 x }" }
    );
    expect(l).toEqual(expect.arrayContaining(["L", "ns"]));
  });

  it("read side: only earlier fields, parameters, constants, builtins", () => {
    const l = labels("const u32 N = 4\nstruct S(u32 p) {\n  u32 a\n  u8 d[|]\n  u32 later\n}");
    expect(l).toEqual(expect.arrayContaining(["a", "p", "N", "sizeof", "max"]));
    expect(l).not.toContain("later");
    expect(l).not.toContain("d");
    expect(l).not.toContain("it");
  });

  it("computed fields: every field", () => {
    const l = labels("struct S {\n  u32 n = |\n  u8 body[16]\n}");
    expect(l).toEqual(expect.arrayContaining(["body", "it"]));
    expect(l).not.toContain("n");
  });

  it("`it` in where and as", () => {
    expect(labels("struct S {\n  u32 a where |\n}")).toContain("it");
    expect(labels("struct S {\n  u16 a as |\n}")).toContain("it");
  });

  it("fields of enclosing structs", () => {
    const l = labels("struct O {\n  u32 count\n  struct I {\n    u8 d[|]\n  }\n}");
    expect(l).toContain("count");
  });

  it("conditions and switch discriminants are read side", () => {
    expect(labels("struct S {\n  u8 v\n  if (|) { u8 x }\n}")).toContain("v");
    expect(labels("struct S {\n  u8 v\n  switch (|) { }\n}")).toContain("v");
  });

  it("enum members in case of an enum switch", () => {
    const l = labels(
      "enum K : u8 { Alpha, Beta }\nstruct S {\n  K k\n  switch (k) {\n    case |\n  }\n}"
    );
    expect(l).toEqual(["Alpha", "Beta"]);
  });

  it("clause keywords after a field name", () => {
    const l = labels("struct S {\n  u32 a |\n}");
    expect(l).toEqual(["at", "from", "as", "in", "where"]);
  });

  it("attributes valid on fields", () => {
    const l = labels("struct S {\n  u32 a @|\n}");
    expect(l).toEqual(
      expect.arrayContaining([
        "size",
        "via",
        "align",
        "padUntil",
        "hidden",
        "relative",
        "nullable",
        "ref",
        "encoding",
        "split",
        "endian",
        "strict"
      ])
    );
    expect(l).not.toContain("base");
    expect(l).not.toContain("open");
  });

  it("attributes valid on structs, enums, codecs, blocks, layout items", () => {
    expect(labels("struct S @| {\n}")).toEqual(
      expect.arrayContaining(["base", "padUntil", "endian", "strict", "bitorder"])
    );
    expect(labels("struct S @| {\n}")).not.toContain("hidden");
    expect(labels("enum E : u8 @| { A }")).toEqual(["open"]);
    expect(labels("extern codec zstd @|")).toEqual(["ranged", "streaming"]);
    const block = labels("struct S {\n  @|\n  u8 a\n}");
    expect(block).toEqual(expect.arrayContaining(["endian", "padUntil"]));
    expect(block).not.toContain("hidden");
    expect(labels("struct P { u8 x }\nstruct S {\n  P *p : u64\n  layout { p @| }\n}")).toEqual([
      "align"
    ]);
  });

  it("attribute completions are snippets with documentation", () => {
    const size = items("struct S {\n  u32 a @|\n}").find(i => i.label === "size")!;
    expect(size.insertText).toBe("size(${1:n})");
    expect(size.insertTextFormat).toBe("snippet");
    expect(size.detail).toBe("@size(n)");
    expect(size.documentation).toContain("Measures whatever it wraps");
  });

  it("attribute arguments: codecs, words, encodings, endianness", () => {
    expect(labels("extern codec zstd\nextern codec lz4\nstruct S {\n  u8 d[] @via(|)\n}")).toEqual([
      "zstd",
      "lz4"
    ]);
    expect(labels("struct S {\n  u8 d from x @split(|)\n}")).toEqual(["fit", "sizes"]);
    expect(labels("struct S {\n  char t[4] @encoding(|)\n}")).toEqual([
      '"utf8"',
      '"ascii"',
      '"latin1"'
    ]);
    expect(labels("struct S {\n  u8 o\n  @endian(|) { u8 x }\n}")).toEqual(
      expect.arrayContaining(["le", "be", "o"])
    );
  });

  it("bound values after $", () => {
    const l = labels("export struct R { u32 $version  M m }\nstruct M {\n  if ($|) { u8 x }\n}");
    expect(l).toEqual(expect.arrayContaining(["endian", "offset", "end", "index", "version"]));
    const v = items(
      "export struct R { u32 $version  M m }\nstruct M {\n  if ($|) { u8 x }\n}"
    ).find(i => i.label === "version")!;
    expect(v.detail).toBe("u32 — bound by R.version");
  });

  it("bound values after $: only bindings that can reach the struct", () => {
    const src = [
      "export struct R { u32 $version  M m }",
      "export struct Other(u8 $key[32]) { u8 $mode  u8 x }",
      "struct M {",
      "  Leaf l",
      "  if ($|) { u8 x }",
      "}",
      "struct Leaf { u8 y }",
      "struct Lone(u16 $own) { u8 z[$own] }"
    ].join("\n");
    const l = labels(src);
    expect(l).toContain("version");
    expect(l).not.toContain("key");
    expect(l).not.toContain("mode");
    // a struct's own `$` params and bound fields
    expect(
      labels(src.replace("if ($|)", "if ($version)").replace("u8 z[$own]", "u8 z[$|]"))
    ).toEqual(expect.arrayContaining(["own"]));
    expect(labels(src.replace("if ($|)", "if (1)").replace("u8 x }", "u8 x[$|] }"))).toEqual(
      expect.arrayContaining(["key", "mode"])
    );
  });

  it("members after a dot: struct fields, length, enum members, namespaces", () => {
    expect(labels("struct H { u32 n  u8 m }\nstruct S {\n  H h\n  u8 d[h.|]\n}")).toEqual([
      "n",
      "m"
    ]);
    expect(labels("struct S {\n  u8 a[4]\n  u32 n = a.|\n}")).toEqual(["length"]);
    expect(labels("enum K : u8 { Alpha, Beta }\nstruct S {\n  K k = K.|\n}")).toEqual([
      "Alpha",
      "Beta"
    ]);
    expect(
      labels('import * as ns from "./lib.yfl"\nstruct S {\n  u8 d[ns.|]\n}', {
        "/w/lib.yfl": "export const u32 N = 4\nstruct L { u8 x }"
      })
    ).toEqual(["N", "L"]);
  });

  it("members after arr[*].", () => {
    expect(
      labels("struct F { u8 data[4]  u32 n }\nstruct S {\n  F fs[2]\n  F f from fs[*].|\n}")
    ).toEqual(["data", "n"]);
  });

  it("layout paths", () => {
    const l = labels(
      "struct P { u8 x }\nstruct S {\n  P *p : u64\n  u8 a\n  layout {\n    |\n  }\n}"
    );
    expect(l).toEqual(["p", "a", "this"]);
  });

  it("import lists offer the target module's declarations", () => {
    const l = labels('import { A, | } from "./lib.yfl"', {
      "/w/lib.yfl": "export struct A { u8 x }\nstruct B { u8 y }\nconst u32 C = 1"
    });
    expect(l).toEqual(["B", "C"]);
  });

  it("nothing inside comments and strings", () => {
    expect(labels("struct S {\n  u8 a // co|\n}")).toEqual([]);
    expect(labels('struct S {\n  char t[4] = "PA|\n}')).toEqual([]);
  });

  it("field items carry their type", () => {
    const a = items("struct S {\n  u32 a\n  u8 d[|]\n}").find(i => i.label === "a")!;
    expect(a).toMatchObject({ kind: "field", detail: "u32" });
  });

  it("length keywords right after [", () => {
    const l = labels("struct S {\n  u32 n\n  u8 d[|]\n}");
    expect(l.slice(0, 2)).toEqual(["until", "before"]);
    expect(labels("struct S {\n  u32 n\n  u8 d[n + |]\n}")).not.toContain("until");
  });

  it("works while the line is incomplete", () => {
    expect(labels("struct S {\n  u32 count\n  Entry entries[|\n}")).toContain("count");
    expect(labels("struct S {\n  u32 count\n  u8 data[count +|\n}")).toContain("count");
  });
});

describe("signature help", () => {
  function sig(text: string, files: Record<string, string> = {}) {
    const { ls, path, pos } = open(text, "/w/main.yfl", files);
    return ls.getSignatureHelp(path, pos);
  }

  it("struct arguments", () => {
    const s = sig("struct Blob(u32 n, u8 m) { u8 d[n] }\nstruct S {\n  Blob(4, |) b\n}")!;
    expect(s.signatures[0]!.label).toBe("Blob(u32 n, u8 m)");
    expect(s.signatures[0]!.parameters.map(p => p.label)).toEqual(["u32 n", "u8 m"]);
    expect(s.activeParameter).toBe(1);
  });

  it("named arguments select their parameter", () => {
    const s = sig("struct Blob(u32 n, u8 m) { u8 d[n] }\nstruct S {\n  Blob(m: |) b\n}")!;
    expect(s.activeParameter).toBe(1);
  });

  it("builtin functions", () => {
    const s = sig("struct S {\n  u8 a\n  u32 x = max(a, |)\n}")!;
    expect(s.signatures[0]!.label).toBe("max(a, b, …)");
    expect(s.activeParameter).toBe(1);
  });

  it("attributes", () => {
    const s = sig("struct S {\n  u32 a @align(4, |)\n}")!;
    expect(s.signatures[0]!.label).toBe("@align(to, fill?, strict?, from: file | base, offset: n)");
    expect(s.activeParameter).toBe(1);
  });

  it("codecs inside @via and extern functions", () => {
    expect(
      sig("extern codec chacha(u8 key[32], u64 nonce)\nstruct S {\n  u8 d[] @via(chacha(|))\n}")!
        .signatures[0]!.label
    ).toBe("extern codec chacha(u8 key[32], u64 nonce)");
    expect(
      sig("extern fn h(char p[]) -> u32\nstruct S {\n  char p[4]\n  u32 x = h(|)\n}")!
        .signatures[0]!.parameters[0]!.label
    ).toBe("char p[]");
  });

  it("type aliases with parameters", () => {
    expect(
      sig("type Fixed(u8 bits) = i32 as it / (1 << bits)\nstruct S {\n  Fixed(|) f\n}")!
        .signatures[0]!.label
    ).toBe("Fixed(u8 bits)");
  });

  it("nothing outside parentheses", () => {
    expect(sig("struct S {\n  u32 a|\n}")).toBeUndefined();
  });
});
