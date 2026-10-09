import { describe, expect, it } from "vitest";
import { open, posOf } from "./util.ts";

const ALL = { start: { line: 0, character: 0 }, end: { line: 999, character: 0 } };

describe("inlay hints", () => {
  const SRC = `extern async codec oodle
struct Blob(u32 n) { u8 d[n] }
export struct T {
  u32 count
  u32 expSize
  u32 compSize
  u8  entries[count]
  u8  body[] @size(expSize) @via(oodle) @size(compSize)
  u16 angle as it * 360.0 / 65536
  Blob(16) b
  Blob(n: 4) c
}`;

  it("derived formulas after the field, with where they come from", () => {
    const { ls, path } = open(SRC);
    const h = ls.getInlayHints(path, ALL);
    const count = h.find(x => x.label === "= entries.length")!;
    expect(count.position).toEqual(posOf(SRC, "count\n", 5));
    expect(count.tooltip).toContain("element count of entries");
    expect(h.map(x => x.label)).toEqual(
      expect.arrayContaining(["= decoded size of body", "= on-disk size of body"])
    );
  });

  it("@size labels around a codec", () => {
    const { ls, path } = open(SRC);
    const h = ls.getInlayHints(path, ALL).filter(x => x.kind === "type");
    expect(h.map(x => [x.label, x.position])).toEqual([
      ["decoded", posOf(SRC, "@size(expSize)", 14)],
      ["on disk", posOf(SRC, "@size(compSize)", 15)]
    ]);
  });

  it("inferred transform reverses", () => {
    const { ls, path } = open(SRC);
    const h = ls.getInlayHints(path, ALL).find(x => x.label.startsWith("= round"))!;
    expect(h.label).toBe("= round(it * 65536.0 / 360.0)");
    expect(h.position).toEqual(posOf(SRC, "65536", 5));
  });

  it("parameter names for positional struct arguments", () => {
    const { ls, path } = open(SRC);
    const h = ls.getInlayHints(path, ALL).filter(x => x.kind === "parameter");
    expect(h.map(x => [x.label, x.position])).toEqual([["n:", posOf(SRC, "16)")]]);
  });

  it("only hints inside the requested range, sorted", () => {
    const { ls, path } = open(SRC);
    const h = ls.getInlayHints(path, {
      start: { line: 3, character: 0 },
      end: { line: 3, character: 99 }
    });
    expect(h.map(x => x.label)).toEqual(["= entries.length"]);
  });
});

describe("code lenses", () => {
  it("needs: $value (type) with binding sources", () => {
    const src =
      "export struct R { u32 $version  u16 $flags  M m }\nstruct M { if ($version > $flags) { u8 x } }";
    const { ls, path } = open(src);
    const lenses = ls.getCodeLenses(path).filter(l => l.title.startsWith("needs"));
    expect(lenses.map(l => [l.title, l.range.start.line])).toEqual([
      ["needs: $flags (u16)", 1],
      ["needs: $version (u32)", 1]
    ]);
    expect(lenses[1]!.command).toEqual({
      id: "yaffle.showBindingSources",
      arguments: [
        {
          path,
          binding: "version",
          sources: [
            { path, range: { start: posOf(src, "version"), end: posOf(src, "version", 7) } }
          ]
        }
      ]
    });
  });

  it("sizes of fixed-size structs", () => {
    const { ls, path } = open("struct E { u16 a  u32 b }\nstruct V { u8 n  u8 d[n] }");
    expect(ls.getCodeLenses(path).map(l => l.title)).toEqual(["size: 0x6 (6 bytes)"]);
  });
});

describe("code actions", () => {
  it("returns the fixes of diagnostics in range", () => {
    const src = "struct S { u32 count  u8 d[cnt] }";
    const { ls, path } = open(src);
    const diags = ls.getDiagnostics(path);
    const actions = ls.getCodeActions(path, diags[0]!.range, diags);
    expect(actions).toEqual([
      {
        title: "Change to 'count'",
        kind: "quickfix",
        edit: { changes: { [path]: [{ range: diags[0]!.range, newText: "count" }] } },
        diagnosticCodes: ["unknown-name"],
        isPreferred: true
      }
    ]);
  });

  it("nothing outside the diagnostics' ranges", () => {
    const { ls, path } = open("struct S { u32 count  u8 d[cnt] }\n\nstruct T { u8 x }");
    expect(
      ls.getCodeActions(
        path,
        { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } },
        []
      )
    ).toEqual([]);
  });

  it("redundant formula, size inside codec, missing binding", () => {
    const check = (src: string, title: string) => {
      const { ls, path } = open(src);
      const d = ls.getDiagnostics(path);
      const all = d.flatMap(x => ls.getCodeActions(path, x.range, [x]));
      expect(all.map(a => a.title)).toContain(title);
    };
    check("struct S { u32 n = d.length  u8 d[n] }", "Remove the formula");
    check(
      "extern codec zstd\nstruct S { u32 n  u8 d[] @size(n) @via(zstd) }",
      "Move @size(n) after @via(zstd)"
    );
    check("export struct R { M m }\nstruct M { u8 d[$v] }", "Add parameter u32 $v to R");
    check('import { X } from "./x.yfl"\nstruct S { u8 a }', "Remove the import");
  });
});

describe("semantic tokens", () => {
  it("classifies declarations, references, literals and comments", () => {
    const src = `// note
enum K : u8 { A }
const u32 N = 4
export struct S(u32 p) {
  u32 $v
  K   k = A
  u8  d[p] @align(4)
  str s in /x/
  u32 c = N + $offset
}`;
    const { ls, path } = open(src);
    const toks = ls.getSemanticTokens(path);
    const at = (needle: string, delta = 0) => {
      const p = posOf(src, needle, delta);
      const t = toks.find(x => x.line === p.line && x.character === p.character);
      return t && `${t.type}${t.modifiers.length ? ":" + t.modifiers.join(",") : ""}`;
    };
    expect(at("// note")).toBe("comment");
    expect(at("enum")).toBe("keyword");
    expect(at("K :")).toBe("enum:declaration");
    expect(at("u8 {")).toBe("type:defaultLibrary");
    expect(at("A }")).toBe("enumMember:declaration,readonly");
    expect(at("N =")).toBe("variable:declaration,readonly");
    expect(at("4\n")).toBe("number");
    expect(at("S(")).toBe("struct:declaration");
    expect(at("p)")).toBe("parameter:declaration");
    expect(at("$v")).toBe("variable:readonly");
    expect(at("K   k")).toBe("enum");
    expect(at("k =")).toBe("property:declaration");
    expect(at("A\n")).toBe("enumMember:readonly");
    expect(at("p]")).toBe("parameter");
    expect(at("@align")).toBe("decorator");
    expect(at("/x/")).toBe("regexp");
    expect(at("N +")).toBe("variable:readonly");
    expect(at("$offset")).toBe("variable:defaultLibrary,readonly");
  });

  it("are sorted and split multi-line comments per line", () => {
    const src = "/* a\n   b */\nstruct S { u8 x }";
    const { ls, path } = open(src);
    const toks = ls.getSemanticTokens(path);
    expect(toks.slice(0, 2)).toEqual([
      { line: 0, character: 0, length: 4, type: "comment", modifiers: [] },
      { line: 1, character: 0, length: 7, type: "comment", modifiers: [] }
    ]);
    for (let i = 1; i < toks.length; i++) {
      const a = toks[i - 1]!;
      const b = toks[i]!;
      expect(b.line > a.line || (b.line === a.line && b.character >= a.character + a.length)).toBe(
        true
      );
    }
  });
});

describe("folding", () => {
  it("folds bodies, branches, comments and imports", () => {
    const src = `import { A } from "./a.yfl"
import { B } from "./b.yfl"
/*
 block
*/
// one
// two
struct S {
  u8 v
  if (v > 1) {
    u8 x
  } else {
    u8 y
  }
  switch (v) {
    case 1:
      u8 a
      u8 b
  }
}`;
    const { ls, path } = open(src);
    const f = ls.getFoldingRanges(path);
    expect(f).toEqual(
      expect.arrayContaining([
        { startLine: 0, endLine: 1, kind: "imports" },
        { startLine: 2, endLine: 4, kind: "comment" },
        { startLine: 5, endLine: 6, kind: "comment" },
        { startLine: 7, endLine: 19 },
        { startLine: 9, endLine: 11 },
        { startLine: 11, endLine: 13 },
        { startLine: 14, endLine: 18 },
        { startLine: 15, endLine: 17 }
      ])
    );
  });
});

describe("formatting", () => {
  it("formats the whole document", () => {
    const src = "struct S{u16 a;u32be crc // c\n}";
    const { ls, path } = open(src);
    const e = ls.format(path);
    expect(e).toEqual([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } },
        newText: "struct S {\n  u16   a\n  u32be crc  // c\n}\n"
      }
    ]);
  });

  it("honours tab size and tabs", () => {
    const { ls, path } = open("struct S {\nu8 a\n}");
    expect(ls.format(path, { tabSize: 4, insertSpaces: true })[0]!.newText).toBe(
      "struct S {\n    u8 a\n}\n"
    );
    expect(ls.format(path, { tabSize: 4, insertSpaces: false })[0]!.newText).toBe(
      "struct S {\n\tu8 a\n}\n"
    );
  });

  it("returns nothing for formatted or broken files", () => {
    expect(open("struct S {\n  u8 a\n}\n").ls.format("/w/main.yfl")).toEqual([]);
    expect(open("struct S { u8 a[ }").ls.format("/w/main.yfl")).toEqual([]);
  });
});
