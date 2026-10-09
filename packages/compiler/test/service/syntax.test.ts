/**
 * Language service support for layout groups, alignment origins, strict fills, virtual fields,
 * derived arrays and slice carriers: hover, completion, signature help, semantic tokens, inlay
 * hints, quick fixes and formatting.
 */
import { describe, expect, it } from "vitest";
import { createLanguageService } from "../../src/service/index.ts";
import { host, posOf } from "./util.ts";

/**
 * A service with one open file. `‸` marks the cursor (`|` is an operator in these sources, so
 * the shared `open` helper's marker can't be used).
 */
function open(text: string, path = "/w/main.yfl") {
  const i = text.indexOf("‸");
  const clean = i >= 0 ? text.slice(0, i) + text.slice(i + 1) : text;
  const before = i >= 0 ? text.slice(0, i).split("\n") : [""];
  const pos = { line: before.length - 1, character: before[before.length - 1]!.length };
  const ls = createLanguageService(host({}));
  ls.updateFile(path, clean);
  return { ls, pos, path, text: clean };
}

const SRC = `struct M { u8 x }
struct R {
  M  *model : u64 @nullable
  u16 flags
}
struct Piece { u8 n }
struct Volume {
  u8     nPieces
  Piece *pieces[nPieces] : u64
}
struct Hdr { u16 a  u16 b }
export struct S {
  u8  s
  u8  r
  R   records[r]
  u8  index[s] = indicesWhere(records, rec => rec.model != null)
  u8  sizeHigh
  u32 sizeLow
  virtual u40 size = (sizeHigh << 32) | sizeLow
  u8  a @align(4, offset: 0x19)
  u8  b @align(16, from: file) @padUntil(0x20, strict)
  u8  raw[4] @hidden
  Hdr hdr from raw[0..4]
  u8  nv
  Volume vols[nv]
  layout {
    vols[*] { pieces[*] }
  }
}
`;

const ALL = { start: { line: 0, character: 0 }, end: { line: 100, character: 0 } };

function hoverAt(needle: string, delta = 0, nth = 0, src = SRC): string {
  const { ls, path } = open(src);
  const h = ls.getHover(path, posOf(src, needle, delta, nth));
  expect(h, `no hover at '${needle}'`).toBeDefined();
  return h!.contents;
}

function labelsAt(text: string): string[] {
  const { ls, path, pos } = open(text);
  return ls.getCompletions(path, pos).map(c => c.label);
}

describe("hover", () => {
  it("virtual fields show the read side and the derived parts", () => {
    const h = hoverAt("size =", 1);
    expect(h).toContain("virtual u40 size");
    expect(h).toContain("**Size:** none (virtual)");
    expect(h).toContain("**Offset:** virtual (no bytes)");
    expect(h).toContain("`sizeHigh = size >> 32`");
    expect(h).toContain("`sizeLow = size & 0xffffffff`");
  });
  it("the parts say where their value comes from", () => {
    const h = hoverAt("sizeLow\n", 1);
    expect(h).toContain("`sizeLow = size & 0xffffffff`");
    expect(h).toContain("part of the virtual field size");
    expect(h).toContain("Not in the input type");
  });
  it("lambda parameters: their element type", () => {
    const h = hoverAt("rec =>", 1);
    expect(h).toContain("rec: R");
    expect(h).toContain("element of records");
    // uses inside the body resolve to the same parameter
    expect(hoverAt("rec.model", 1)).toContain("rec: R");
  });
  it("derived-array builtins", () => {
    expect(hoverAt("indicesWhere", 2)).toContain("indicesWhere(array, x => bool)");
  });
  it("null, virtual and the attribute words", () => {
    expect(hoverAt("null", 1)).toContain("@nullable");
    expect(hoverAt("virtual u40", 2)).toContain("A field with no bytes");
    expect(hoverAt("offset: 0x19", 2)).toContain("Aligns the position k bytes ahead");
    expect(hoverAt("from: file", 2)).toContain("Where the alignment is measured from");
    expect(hoverAt("file)", 1)).toContain("start of the file");
    expect(hoverAt("strict)", 2)).toContain("Checks this padding's fill on read");
  });
  it("slice carriers", () => {
    const h = hoverAt("raw[4]", 1);
    expect(h).toContain("**Assembled on write**");
    expect(h).toContain("hdr");
  });
  it("layout group items resolve against the element struct", () => {
    expect(hoverAt("pieces[*] }", 2)).toContain("Piece *pieces[nPieces] : u64");
  });
});

describe("completion", () => {
  it("virtual at a member start, with a snippet", () => {
    const l = labelsAt("struct S {\n  ‸\n}");
    expect(l).toContain("virtual");
    expect(l).toContain("virtual …");
  });
  it("strict, from: and offset: after the first argument of @align", () => {
    const l = labelsAt("struct S {\n  u8 a @align(4, ‸)\n}");
    expect(l).toEqual(expect.arrayContaining(["strict", "from:", "offset:"]));
    const p = labelsAt("struct S {\n  u8 a @padUntil(4, ‸)\n}");
    expect(p).toContain("strict");
    expect(p).not.toContain("from:");
    expect(labelsAt("struct S {\n  u8 a @align(‸)\n}")).not.toContain("strict");
  });
  it("file and base after from:", () => {
    expect(labelsAt("struct S {\n  u8 a @align(4, from: ‸)\n}")).toEqual(["file", "base"]);
  });
  it("lambda parameters and their members", () => {
    const src = SRC.replace("rec => rec.model != null", "rec => rec.‸");
    const l = labelsAt(src);
    expect(l).toEqual(expect.arrayContaining(["model", "flags"]));
    const v = labelsAt(SRC.replace("rec => rec.model != null", "rec => ‸"));
    expect(v).toContain("rec");
    expect(v).toContain("null");
  });
  it("derived-array builtins with lambda snippets", () => {
    const { ls, path, pos } = open("struct S {\n  u8 n\n  u8 xs[n]\n  u8 ys[2] = ‸\n}");
    const items = ls.getCompletions(path, pos);
    const m = items.find(i => i.label === "indicesWhere")!;
    expect(m.insertText).toBe("indicesWhere(${1:array}, ${2:x} => ${3})");
    expect(items.map(i => i.label)).toEqual(
      expect.arrayContaining(["map", "filter", "sortedBy", "unique", "concat"])
    );
  });
  it("inside a layout group: the element struct's fields", () => {
    const src = SRC.replace("vols[*] { pieces[*] }", "vols[*] { ‸ }");
    const l = labelsAt(src);
    expect(l).toEqual(expect.arrayContaining(["nPieces", "pieces", "this"]));
    expect(l).not.toContain("records");
  });
});

describe("signature help", () => {
  it("builtins with lambdas", () => {
    const { ls, path } = open(SRC);
    const s = ls.getSignatureHelp(path, posOf(SRC, "rec.model", 0))!;
    expect(s.signatures[0]!.label).toBe("indicesWhere(array, x => bool) -> int[]");
    expect(s.activeParameter).toBe(1);
  });
  it("named attribute arguments and strict select their parameter", () => {
    const { ls, path } = open(SRC);
    const a = ls.getSignatureHelp(path, posOf(SRC, "0x19", 0))!;
    expect(a.signatures[0]!.parameters[a.activeParameter]!.label).toBe("offset: n");
    const b = ls.getSignatureHelp(path, posOf(SRC, "strict)", 6))!;
    expect(b.signatures[0]!.parameters[b.activeParameter]!.label).toBe("strict?");
  });
});

describe("semantic tokens, inlay hints, quick fixes", () => {
  it("virtual and null are keywords; builtins and lambda parameters are classified", () => {
    const { ls, path } = open(SRC);
    const toks = ls.getSemanticTokens(path);
    const at = (needle: string, nth = 0) => {
      const p = posOf(SRC, needle, 0, nth);
      return toks.find(t => t.line === p.line && t.character === p.character);
    };
    expect(at("virtual")?.type).toBe("keyword");
    expect(at("null)")?.type).toBe("keyword");
    expect(at("indicesWhere")?.type).toBe("function");
    expect(at("rec =>")?.type).toBe("parameter");
  });
  it("inlay hints on virtual parts and slice carriers", () => {
    const { ls, path } = open(SRC);
    const labels = ls.getInlayHints(path, ALL).map(h => h.label);
    expect(labels).toEqual(
      expect.arrayContaining(["= size >> 32", "= size & 0xffffffff", "= slices of hdr"])
    );
  });
  it("quick fixes: shift by the part's width, add [*] to a group, change from: word", () => {
    const fix = (src: string, code: string) => {
      const { ls, path } = open(src);
      const d = ls.getDiagnostics(path).find(x => x.code === code);
      expect(d, `no ${code}`).toBeDefined();
      return d!.fixes?.[0];
    };
    const shift = fix(
      "struct S { u8 hi  u32 lo  virtual u64 v = (hi << 16) | lo }",
      "virtual-not-reversible"
    )!;
    expect(shift.title).toBe("Shift by 32");
    expect(Object.values(shift.edit.changes)[0]![0]!.newText).toBe("32");
    const each = fix(
      "struct P { u8 x }\nstruct V { P *p : u64 }\nstruct S { V vs[2]  layout { vs { p } } }",
      "unknown-layout-path"
    )!;
    expect(each.title).toBe("Add [*]");
    const word = fix("struct S { u8 a @align(4, from: fil) }", "invalid-attribute-argument")!;
    expect(word.title).toBe("Change to 'file'");
    const hidden = fix(
      "struct P { u16 a }\nstruct S { u8 raw[8]  P p from raw[0..2] }",
      "slice-carrier-input"
    )!;
    expect(hidden.title).toContain("Add @hidden");
  });
});

describe("formatting", () => {
  it("keeps virtual, groups, lambdas and named arguments, idempotently", () => {
    const src = `struct P { u8 x }
struct V {
  P *ps[2] : u64
}
export struct S {
  u8   hi
  u32  lo
  virtual   u40 size = (hi << 32)|lo ?= 0
  u8 n
  u8 idx[n] = indicesWhere(vs,v=>v.ps[0].x!=0)
  u8 b @align( 16 ,from:file , offset : 3) @padUntil(0x20,strict)
  V  vs[2]
  layout {
    vs[*] { ps[*]  this }
    vs[*] @align(16) {
      ps
    }
  }
}
`;
    const { ls, path } = open(src);
    const edits = ls.format(path, { tabSize: 2, insertSpaces: true });
    const once = applyAll(src, edits);
    expect(once).toContain("virtual u40 size = (hi << 32) | lo ?= 0");
    expect(once).toContain("u8 idx[n] = indicesWhere(vs, v => v.ps[0].x != 0)");
    expect(once).toContain("@align(16, from: file, offset: 3) @padUntil(0x20, strict)");
    expect(once).toContain("    vs[*] { ps[*]  this }");
    expect(once).toContain("    vs[*] @align(16) {\n      ps\n    }");
    const again = open(once);
    expect(applyAll(once, again.ls.format(again.path, { tabSize: 2, insertSpaces: true }))).toBe(
      once
    );
  });
});

function applyAll(
  text: string,
  edits: {
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    newText: string;
  }[]
): string {
  const lines = text.split("\n");
  const offsetOf = (p: { line: number; character: number }) =>
    lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  const sorted = [...edits].sort((a, b) => offsetOf(b.range.start) - offsetOf(a.range.start));
  let out = text;
  for (const e of sorted)
    out = out.slice(0, offsetOf(e.range.start)) + e.newText + out.slice(offsetOf(e.range.end));
  return out;
}
