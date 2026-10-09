import { describe, expect, it } from "vitest";
import { createLanguageService } from "../../src/service/index.ts";
import { host, open, posOf } from "./util.ts";

const LIB = "export struct Entry { u16 kind  u32 size }\nexport const u32 SECTOR = 0x800\n";
const MAIN = `import { Entry, SECTOR } from "./lib.yfl"
enum K : u8 { Alpha, Beta }
export struct Table {
  u32   count
  u32   $version
  Entry entries[count]
  K     k = Alpha
  u8    pad[SECTOR]
  Rec   r
}
struct Rec { if ($version > 1) { u8 x[$version] } }
`;

function ws() {
  const ls = createLanguageService(host({ "/w/lib.yfl": LIB }));
  ls.updateFile("/w/main.yfl", MAIN);
  return ls;
}

describe("definition", () => {
  it("field reference → declaration", () => {
    const ls = ws();
    expect(ls.getDefinition("/w/main.yfl", posOf(MAIN, "count]", 1))).toEqual([
      {
        path: "/w/main.yfl",
        range: { start: posOf(MAIN, "count\n"), end: posOf(MAIN, "count\n", 5) }
      }
    ]);
  });

  it("type in another file", () => {
    const ls = ws();
    const d = ls.getDefinition("/w/main.yfl", posOf(MAIN, "Entry entries", 1));
    expect(d).toEqual([
      { path: "/w/lib.yfl", range: { start: posOf(LIB, "Entry"), end: posOf(LIB, "Entry", 5) } }
    ]);
  });

  it("imported name in the import list", () => {
    const ls = ws();
    expect(ls.getDefinition("/w/main.yfl", posOf(MAIN, "SECTOR }", 1))[0]!.path).toBe("/w/lib.yfl");
  });

  it("import path → module", () => {
    const ls = ws();
    expect(ls.getDefinition("/w/main.yfl", posOf(MAIN, "./lib.yfl", 2))).toEqual([
      {
        path: "/w/lib.yfl",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
      }
    ]);
  });

  it("$value → its binding sites", () => {
    const ls = ws();
    const d = ls.getDefinition("/w/main.yfl", posOf(MAIN, "$version >", 2));
    expect(d).toEqual([
      {
        path: "/w/main.yfl",
        range: { start: posOf(MAIN, "version\n"), end: posOf(MAIN, "version\n", 7) }
      }
    ]);
  });

  it("enum members, constants, struct names", () => {
    const ls = ws();
    expect(ls.getDefinition("/w/main.yfl", posOf(MAIN, "Alpha\n", 1))[0]!.range.start).toEqual(
      posOf(MAIN, "Alpha")
    );
    expect(ls.getDefinition("/w/main.yfl", posOf(MAIN, "SECTOR]", 1))[0]!.path).toBe("/w/lib.yfl");
    expect(ls.getDefinition("/w/main.yfl", posOf(MAIN, "Rec   r", 1))[0]!.range.start).toEqual(
      posOf(MAIN, "Rec {")
    );
  });

  it("nothing on built-in types or whitespace", () => {
    const ls = ws();
    expect(ls.getDefinition("/w/main.yfl", posOf(MAIN, "u32   count", 1))).toEqual([]);
    expect(ls.getDefinition("/w/main.yfl", { line: 3, character: 0 })).toEqual([]);
  });
});

describe("references", () => {
  it("field: uses, with or without the declaration", () => {
    const ls = ws();
    const at = posOf(MAIN, "count\n", 1);
    expect(ls.getReferences("/w/main.yfl", at, false).map(l => l.range.start)).toEqual([
      posOf(MAIN, "count]")
    ]);
    expect(ls.getReferences("/w/main.yfl", at, true).length).toBe(2);
  });

  it("struct across files", () => {
    const ls = ws();
    const refs = ls.getReferences("/w/lib.yfl", posOf(LIB, "Entry", 1), true);
    expect(refs.map(r => r.path)).toEqual(["/w/lib.yfl", "/w/main.yfl", "/w/main.yfl"]);
  });

  it("bound fields include every $read", () => {
    const ls = ws();
    const refs = ls.getReferences("/w/main.yfl", posOf(MAIN, "version\n", 1), true);
    expect(refs.length).toBe(3);
  });
});

describe("rename", () => {
  it("prepareRename gives the range and placeholder", () => {
    const ls = ws();
    expect(ls.prepareRename("/w/main.yfl", posOf(MAIN, "count]", 2))).toEqual({
      range: { start: posOf(MAIN, "count]"), end: posOf(MAIN, "count]", 5) },
      placeholder: "count"
    });
    expect(ls.prepareRename("/w/main.yfl", posOf(MAIN, "u32   count", 1))).toBeUndefined();
  });

  it("renames a field and its uses", () => {
    const ls = ws();
    const e = ls.rename("/w/main.yfl", posOf(MAIN, "count]", 1), "n")!;
    expect(e.changes["/w/main.yfl"]!.map(t => [t.range.start, t.newText])).toEqual([
      [posOf(MAIN, "count\n"), "n"],
      [posOf(MAIN, "count]"), "n"]
    ]);
  });

  it("keeps import aliases when renaming", () => {
    const ls = createLanguageService(host({ "/w/lib.yfl": "export struct Entry { u8 x }" }));
    const src = 'import { Entry as E } from "./lib.yfl"\nexport struct T { E e }';
    ls.updateFile("/w/main.yfl", src);
    const e = ls.rename("/w/lib.yfl", { line: 0, character: 15 }, "Item")!;
    expect(e.changes["/w/main.yfl"]!.map(t => t.range.start)).toEqual([{ line: 0, character: 9 }]);
  });

  it("renames a struct across files, including the import", () => {
    const ls = ws();
    const e = ls.rename("/w/lib.yfl", posOf(LIB, "Entry", 1), "Item")!;
    expect(Object.keys(e.changes).sort()).toEqual(["/w/lib.yfl", "/w/main.yfl"]);
    expect(e.changes["/w/main.yfl"]!.length).toBe(2);
  });

  it("renames a bound value everywhere ($ kept)", () => {
    const ls = ws();
    const e = ls.rename("/w/main.yfl", posOf(MAIN, "$version >", 3), "ver")!;
    const edits = e.changes["/w/main.yfl"]!;
    expect(edits.length).toBe(3);
    for (const t of edits)
      expect(MAIN.split("\n")[t.range.start.line]![t.range.start.character - 1]).toBe("$");
  });

  it("refuses invalid names and built-ins", () => {
    const ls = ws();
    expect(ls.rename("/w/main.yfl", posOf(MAIN, "count]", 1), "not valid")).toBeUndefined();
    expect(ls.rename("/w/main.yfl", posOf(MAIN, "u32   count", 1), "x")).toBeUndefined();
  });

  it("renames enum members and constants", () => {
    const ls = ws();
    const e = ls.rename("/w/main.yfl", posOf(MAIN, "Alpha\n", 1), "First")!;
    expect(e.changes["/w/main.yfl"]!.length).toBe(2);
    const c = ls.rename("/w/main.yfl", posOf(MAIN, "SECTOR]", 1), "SEC")!;
    expect(c.changes["/w/lib.yfl"]!.length).toBe(1);
    expect(c.changes["/w/main.yfl"]!.length).toBe(2);
  });
});

describe("symbols", () => {
  it("document symbols form a hierarchy", () => {
    const ls = ws();
    const s = ls.getDocumentSymbols("/w/main.yfl");
    expect(s.map(x => [x.name, x.kind])).toEqual([
      ["K", "enum"],
      ["Table", "struct"],
      ["Rec", "struct"]
    ]);
    expect(s[0]!.children!.map(c => c.name)).toEqual(["Alpha", "Beta"]);
    expect(s[1]!.children!.map(c => [c.name, c.detail])).toEqual([
      ["count", "u32"],
      ["version", "u32"],
      ["entries", "Entry[]"],
      ["k", "K"],
      ["pad", "bytes"],
      ["r", "Rec"]
    ]);
    expect(s[2]!.children!.map(c => c.name)).toEqual(["x"]);
    const t = s[1]!;
    expect(t.selectionRange.start).toEqual(posOf(MAIN, "Table"));
    expect(t.range.start).toEqual(posOf(MAIN, "export struct Table"));
  });

  it("nested declarations appear under their struct", () => {
    const { ls, path } = open("struct O {\n  struct I { u8 x }\n  I i\n}");
    const s = ls.getDocumentSymbols(path);
    expect(s[0]!.children!.map(c => [c.name, c.kind])).toEqual([
      ["I", "struct"],
      ["i", "field"]
    ]);
  });

  it("workspace symbols: fuzzy, with containers", () => {
    const ls = ws();
    const all = ls.getWorkspaceSymbols("");
    expect(all.map(s => s.name).sort()).toEqual(["Entry", "K", "Rec", "SECTOR", "Table"]);
    expect(ls.getWorkspaceSymbols("tbl").map(s => s.name)).toEqual(["Table"]);
    const nested = createLanguageService(host());
    nested.updateFile("/w/a.yfl", "struct O { struct Inner { u8 x } }");
    expect(nested.getWorkspaceSymbols("inner")).toEqual([
      {
        name: "Inner",
        kind: "struct",
        location: {
          path: "/w/a.yfl",
          range: { start: { line: 0, character: 18 }, end: { line: 0, character: 23 } }
        },
        containerName: "O"
      }
    ]);
  });
});
