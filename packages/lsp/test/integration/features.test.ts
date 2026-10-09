/**
 * Feature by feature, with the expected content, through the real server on the test project:
 * hover, completion contexts, signature help, navigation across files, rename and quick fixes
 * applied end to end, inlay hints, code lenses, on-type formatting, formatting and the custom
 * requests.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as lsp from "vscode-languageserver";
import type { TestServer } from "../harness.ts";
import {
  applyEdits,
  editsByUri,
  errorLogs,
  find,
  PROJECT,
  startRealServer,
  validRange,
  WS
} from "./realServer.ts";

let t: TestServer;
afterEach(() => t?.dispose());

const path = (name: string) => `${WS}/${name}`;

async function openAll(): Promise<void> {
  for (const [name, text] of Object.entries(PROJECT)) await t.open(path(name), text);
  await t.settle();
}

async function hover(name: string, needle: string, occurrence = 0): Promise<string> {
  const h = await t.request<lsp.Hover | null>("textDocument/hover", {
    textDocument: { uri: t.uri(path(name)) },
    position: find(PROJECT[name]!, needle, occurrence)
  });
  return h ? (h.contents as lsp.MarkupContent).value : "";
}

async function complete(
  name: string,
  text: string,
  position: lsp.Position
): Promise<lsp.CompletionItem[]> {
  const uri = t.uri(path(name));
  if (text !== PROJECT[name]) await t.change(path(name), text);
  const list = await t.request<lsp.CompletionList>("textDocument/completion", {
    textDocument: { uri },
    position
  });
  return list.items;
}

const labels = (items: lsp.CompletionItem[]) => items.map(i => i.label);

describe("hover", () => {
  beforeEach(async () => {
    t = await startRealServer();
    await openAll();
  });

  it("types, fields, imported structs and enums", async () => {
    expect(await hover("archive.yfl", "  Ent|ry   entries")).toContain("struct Entry");
    expect(await hover("archive.yfl", "  Ent|ry   entries")).toContain("**Size:** 0x18 bytes");
    const records = await hover("archive.yfl", "Entry   ent|ries[n]");
    expect(records).toContain("Entry entries[n] at entriesOfs");
    expect(records).toContain("**Type:** `Entry[]`");
    expect(records).toContain("**Size:** n × 0x18 bytes");
    // a field used in a clause, with how it's written
    const ofs = await hover("archive.yfl", "at entri|esOfs");
    expect(ofs).toContain("u32 entriesOfs");
    expect(ofs).toContain("**Written as:** `entriesOfs = offsetof(entries)`");
    expect(await hover("archive.yfl", "  Comm|ent *note")).toContain("struct Comment");
    expect(await hover("common.yfl", "    Co|dec codec")).toContain("enum Codec : u8");
    expect(await hover("common.yfl", "Deflate = 1, Zs|td")).toContain("Zstd");
    // the pointer storage type
    expect(await hover("archive.yfl", "*dir[n] : u|32")).toContain("unsigned 32-bit integer");
  });

  it("attributes, $values, builtins, keywords", async () => {
    expect(await hover("archive.yfl", "entries[*].data @ali|gn(0x40)")).toContain(
      "@align(to, fill?, strict?, from: file | base, offset: n)"
    );
    expect(await hover("archive.yfl", "@padAf|ter(4) @strict")).toContain(
      "@padAfter(n, fill?, strict?)"
    );
    expect(await hover("chunks.yfl", "pad[tocOfs - $off|set]")).toContain("Current position");
    expect(await hover("chunks.yfl", "rel[$ind|ex]")).toContain("Index of the element");
    expect(await hover("sealed.yfl", "xor($k|ey")).toContain("$key");
    expect(await hover("archive.yfl", "size > 0 ? offset|of(data)")).toContain(
      "offsetof(field) -> int"
    );
    expect(await hover("sealed.yfl", "at ma|x($index")).toContain("max(");
    expect(await hover("archive.yfl", "entries[n]  a|t entriesOfs")).toContain(
      "from the nearest `@base`"
    );
    expect(await hover("sealed.yfl", "data @split(fi|t)")).toContain("@split");
  });

  it("with the cursor right after a word, and nothing in comments", async () => {
    expect(await hover("archive.yfl", "Entry   entries|[n]")).toContain("Entry entries[n]");
    expect(await hover("archive.yfl", "holds na|mes nothing")).toBe("");
  });
});

describe("completion contexts", () => {
  beforeEach(async () => {
    t = await startRealServer();
    await openAll();
  });

  it("at the start of a member: types (local, imported, primitive), member keywords", async () => {
    const text = PROJECT["archive.yfl"]!;
    const items = await complete("archive.yfl", text, find(text, "  Entry   entries", 0, 2));
    const l = labels(items);
    for (const x of [
      "Entry",
      "Archive",
      "Comment",
      "Attrs",
      "u32",
      "f32",
      "char",
      "str",
      "if",
      "switch",
      "layout"
    ])
      expect(l, x).toContain(x);
    expect(items.find(i => i.label === "Entry")?.kind).toBe(22); // Struct
  });

  it("after @: the attributes valid there", async () => {
    const text = PROJECT["archive.yfl"]!;
    const fieldAttrs = labels(
      await complete("archive.yfl", text, find(text, "@padAfter(4)", 0, 1))
    );
    expect(fieldAttrs).toEqual(
      expect.arrayContaining(["align", "padAfter", "size", "via", "strict", "nullable", "ref"])
    );
    expect(fieldAttrs).not.toContain("base");
    const structAttrs = labels(
      await complete("archive.yfl", text, find(text, "@base @alignEnd", 0, 1))
    );
    expect(structAttrs).toEqual(expect.arrayContaining(["base", "alignEnd", "padUntil"]));
  });

  it("inside expressions: fields and builtins, not types", async () => {
    const text = PROJECT["archive.yfl"]!;
    const items = labels(
      await complete("archive.yfl", text, find(text, "u32      dataOfs = |size"))
    );
    expect(items).toEqual(
      expect.arrayContaining(["size", "flags", "data", "attrs", "offsetof", "sizeof"])
    );
    expect(items).not.toContain("Entry");
    expect(items).not.toContain("u32");
    // at an offset expression
    const at = labels(
      await complete("archive.yfl", text, find(text, "entries[n]  at |entriesOfs"))
    );
    expect(at).toEqual(expect.arrayContaining(["entriesOfs", "keepOfs", "offsetof"]));
  });

  it("after $: the built-in and bound values", async () => {
    const text = PROJECT["chunks.yfl"]!;
    const items = labels(await complete("chunks.yfl", text, find(text, "- $|offset]")));
    expect(items).toEqual(expect.arrayContaining(["offset", "end", "index", "endian"]));
  });

  it("after a dot: the members of a struct-typed field", async () => {
    const text = PROJECT["chunks.yfl"]!;
    expect(labels(await complete("chunks.yfl", text, find(text, "toc.|slots")))).toEqual(
      expect.arrayContaining(["slots", "rel", "chunks"])
    );
    expect(labels(await complete("chunks.yfl", text, find(text, "toc.slots[0].|offset")))).toEqual([
      "offset",
      "size",
      "data"
    ]);
  });

  it("in a layout block, an import list, after a pointer's ':' and after a type", async () => {
    const archive = PROJECT["archive.yfl"]!;
    expect(labels(await complete("archive.yfl", archive, find(archive, "layout { |note")))).toEqual(
      expect.arrayContaining(["note", "data", "this"])
    );
    // an import list offers what the file exports and isn't imported yet
    const withImport = archive.replace(
      'import { Comment } from "./notes.yfl"',
      'import {  } from "./notes.yfl"'
    );
    expect(
      labels(await complete("archive.yfl", withImport, find(withImport, "import { | }")))
    ).toContain("Comment");
    await t.change(path("archive.yfl"), archive);
    const storage = labels(await complete("archive.yfl", archive, find(archive, "*dir[n] : |u32")));
    expect(storage).toEqual(expect.arrayContaining(["u64", "u32", "u16le"]));
    expect(storage.every(l => /^[ui]\d+(le|be)?$/.test(l))).toBe(true);
    // the field's name: anything goes
    expect(await complete("archive.yfl", archive, find(archive, "  Entry   |entries"))).toEqual([]);
    // after the name: the clause keywords
    const spaced = archive.replace("u32  keepOfs\n", "u32  keepOfs \n");
    expect(labels(await complete("archive.yfl", spaced, find(spaced, "u32  keepOfs |")))).toEqual(
      expect.arrayContaining(["at", "where", "in"])
    );
  });

  it("at the top level: declaration keywords", async () => {
    const archive = PROJECT["archive.yfl"]!;
    expect(
      labels(await complete("archive.yfl", archive, find(archive, "|struct Entry {")))
    ).toEqual(expect.arrayContaining(["struct", "enum", "import", "export", "extern"]));
  });

  it("an accepted completion compiles", async () => {
    const text = PROJECT["sealed.yfl"]!;
    const at = find(text, "  u64   stamp\n", 0, 13);
    const edited = applyEdits(text, [
      { range: { start: at, end: at }, newText: "\n  u32 copy = unit" }
    ]);
    await t.change(path("sealed.yfl"), edited);
    const pos = find(edited, "u32 copy = unit", 0, 11);
    const items = await complete("sealed.yfl", edited, pos);
    const item = items.find(i => i.label === "rawSize")!;
    expect(item).toBeDefined();
    const accepted = applyEdits(edited, [
      {
        range: { start: pos, end: { ...pos, character: pos.character + "unit".length } },
        newText: item.insertText ?? item.label
      }
    ]);
    await t.change(path("sealed.yfl"), accepted);
    await t.settle();
    const p = t.diagnostics(path("sealed.yfl"));
    expect(p?.diagnostics.filter(d => d.severity === 1) ?? []).toEqual([]);
  });
});

describe("signature help", () => {
  beforeEach(async () => {
    t = await startRealServer();
    await openAll();
  });

  const sig = async (name: string, needle: string) =>
    t.request<lsp.SignatureHelp | null>("textDocument/signatureHelp", {
      textDocument: { uri: t.uri(path(name)) },
      position: find(PROJECT[name]!, needle)
    });

  it("builtins, attributes and struct arguments, with the active parameter", async () => {
    expect((await sig("archive.yfl", "offsetof(|data)"))?.signatures[0]!.label).toBe(
      "offsetof(field) -> int"
    );
    const pad = await sig("archive.yfl", "@strict @padUntil(|0x40)");
    expect(pad?.signatures[0]!.label).toBe("@padUntil(size, fill?, strict?)");
    expect(pad?.activeParameter).toBe(0);
    const table = await sig("chunks.yfl", "Toc(count, |tocOfs)");
    expect(table?.signatures[0]!.label).toBe("Toc(u16 n, u32 t)");
    expect(table?.activeParameter).toBe(1);
    const max = await sig("sealed.yfl", "max($index * 0x1000, |0x14)");
    expect(max?.signatures[0]!.label).toMatch(/^max\(/);
    expect(max?.activeParameter).toBe(1);
    expect(await sig("archive.yfl", "  Entry   ent|ries")).toBeNull();
  });
});

describe("navigation across files", () => {
  beforeEach(async () => {
    t = await startRealServer();
  });

  it("definition of an imported struct and of a field in a clause", async () => {
    const archive = PROJECT["archive.yfl"]!;
    await t.open(path("archive.yfl"), archive);
    await t.settle();
    const uri = t.uri(path("archive.yfl"));
    const def = await t.request<lsp.Location[]>("textDocument/definition", {
      textDocument: { uri },
      position: find(archive, "  Comm|ent *note")
    });
    expect(def).toEqual([
      {
        uri: t.uri(path("notes.yfl")),
        range: {
          start: find(PROJECT["notes.yfl"]!, "struct |Comment"),
          end: find(PROJECT["notes.yfl"]!, "struct Comment|")
        }
      }
    ]);
    const fromImport = await t.request<lsp.Location[]>("textDocument/definition", {
      textDocument: { uri },
      position: find(archive, "import { At|trs }")
    });
    expect(fromImport[0]!.uri).toBe(t.uri(path("common.yfl")));
    const field = await t.request<lsp.Location[]>("textDocument/definition", {
      textDocument: { uri },
      position: find(archive, "at entri|esOfs")
    });
    expect(field).toEqual([
      {
        uri,
        range: { start: find(archive, "u32  |entriesOfs"), end: find(archive, "u32  entriesOfs|") }
      }
    ]);
  });

  it("references from the declaring file reach importers that aren't open", async () => {
    const notes = PROJECT["notes.yfl"]!;
    await t.open(path("notes.yfl"), notes);
    await t.settle();
    const refs = await t.request<lsp.Location[]>("textDocument/references", {
      textDocument: { uri: t.uri(path("notes.yfl")) },
      position: find(notes, "struct Comm|ent"),
      context: { includeDeclaration: true }
    });
    const archiveUri = t.uri(path("archive.yfl"));
    expect(refs.filter(r => r.uri === archiveUri).map(r => r.range.start.line)).toEqual([
      find(PROJECT["archive.yfl"]!, "import { Comment").line,
      find(PROJECT["archive.yfl"]!, "  Comment *note").line
    ]);
    expect(refs.some(r => r.uri === t.uri(path("notes.yfl")))).toBe(true);
    const noDecl = await t.request<lsp.Location[]>("textDocument/references", {
      textDocument: { uri: t.uri(path("notes.yfl")) },
      position: find(notes, "struct Comm|ent"),
      context: { includeDeclaration: false }
    });
    expect(noDecl.length).toBe(refs.length - 1);
    // Archive is used by chunks.yfl
    const archiveRefs = await t.request<lsp.Location[]>("textDocument/references", {
      textDocument: { uri: archiveUri },
      position: find(PROJECT["archive.yfl"]!, "export struct Arc|hive"),
      context: { includeDeclaration: false }
    });
    expect(archiveRefs.map(r => r.uri)).toContain(t.uri(path("chunks.yfl")));
  });

  it("document highlights stay in the file", async () => {
    const archive = PROJECT["archive.yfl"]!;
    await t.open(path("archive.yfl"), archive);
    await t.settle();
    const hl = await t.request<lsp.DocumentHighlight[]>("textDocument/documentHighlight", {
      textDocument: { uri: t.uri(path("archive.yfl")) },
      position: find(archive, "u32  entries|Ofs")
    });
    expect(hl.map(h => h.range.start.line).sort((a, b) => a - b)).toEqual([
      find(archive, "u32  entriesOfs").line,
      find(archive, "at entriesOfs").line
    ]);
  });
});

describe("rename, applied end to end", () => {
  beforeEach(async () => {
    t = await startRealServer();
  });

  async function applyWorkspaceEdit(
    edit: lsp.WorkspaceEdit,
    texts: Map<string, string>
  ): Promise<void> {
    for (const [uri, edits] of editsByUri(edit)) {
      const name = uri.slice(uri.lastIndexOf("/") + 1);
      const before = texts.get(name) ?? PROJECT[name]!;
      const after = applyEdits(before, edits);
      texts.set(name, after);
      if (t.diagnostics(path(name)) !== undefined || before !== PROJECT[name])
        await t.change(path(name), after);
      else await t.open(path(name), after);
    }
  }

  it("a field: every use in the file, and the file stays clean", async () => {
    const archive = PROJECT["archive.yfl"]!;
    await t.open(path("archive.yfl"), archive);
    await t.settle();
    const uri = t.uri(path("archive.yfl"));
    const prepared = await t.request<{ range: lsp.Range; placeholder: string }>(
      "textDocument/prepareRename",
      {
        textDocument: { uri },
        position: find(archive, "at entri|esOfs")
      }
    );
    expect(prepared.placeholder).toBe("entriesOfs");
    const edit = await t.request<lsp.WorkspaceEdit>("textDocument/rename", {
      textDocument: { uri },
      position: find(archive, "at entri|esOfs"),
      newName: "listOfs"
    });
    const edits = editsByUri(edit).get(uri)!;
    expect(edits).toHaveLength(2);
    const texts = new Map<string, string>([["archive.yfl", archive]]);
    await applyWorkspaceEdit(edit, texts);
    expect(texts.get("archive.yfl")).toContain("u32  listOfs\n");
    expect(texts.get("archive.yfl")).toContain("at listOfs");
    await t.settle();
    expect(t.diagnostics(path("archive.yfl"))?.diagnostics ?? []).toEqual([]);
  });

  it("an exported struct: its file and every importer", async () => {
    const notes = PROJECT["notes.yfl"]!;
    await t.open(path("notes.yfl"), notes);
    await t.open(path("archive.yfl"), PROJECT["archive.yfl"]!);
    await t.settle();
    const edit = await t.request<lsp.WorkspaceEdit>("textDocument/rename", {
      textDocument: { uri: t.uri(path("notes.yfl")) },
      position: find(notes, "export struct Comm|ent"),
      newName: "Remark"
    });
    const byUri = editsByUri(edit);
    expect([...byUri.keys()].sort()).toEqual(
      [t.uri(path("archive.yfl")), t.uri(path("notes.yfl"))].sort()
    );
    const texts = new Map<string, string>();
    await applyWorkspaceEdit(edit, texts);
    expect(texts.get("archive.yfl")).toContain('import { Remark } from "./notes.yfl"');
    expect(texts.get("archive.yfl")).toContain("Remark *note");
    await t.settle();
    for (const name of ["archive.yfl", "notes.yfl", "chunks.yfl"])
      expect(t.diagnostics(path(name))?.diagnostics ?? [], name).toEqual([]);
    expect(errorLogs(t)).toEqual([]);
  });

  it("built-in names can't be renamed", async () => {
    const archive = PROJECT["archive.yfl"]!;
    await t.open(path("archive.yfl"), archive);
    await t.settle();
    const uri = t.uri(path("archive.yfl"));
    expect(
      await t.request("textDocument/prepareRename", {
        textDocument: { uri },
        position: find(archive, "u1|6  n ")
      })
    ).toBeNull();
    await expect(
      t.request("textDocument/rename", {
        textDocument: { uri },
        position: find(archive, "u1|6  n "),
        newName: "x"
      })
    ).rejects.toThrow("can't be renamed");
  });
});

describe("quick fixes, applied end to end", () => {
  beforeEach(async () => {
    t = await startRealServer();
  });

  async function fixAll(name: string, text: string, code: string): Promise<string> {
    await t.open(path(name), PROJECT[name]!);
    await t.settle();
    await t.change(path(name), text);
    const p = await t.waitForDiagnostics(
      path(name),
      d => d.diagnostics.some(x => x.code === code),
      10_000
    );
    const d = p.diagnostics.find(x => x.code === code)!;
    const actions = await t.request<lsp.CodeAction[]>("textDocument/codeAction", {
      textDocument: { uri: t.uri(path(name)) },
      range: d.range,
      context: { diagnostics: [d], only: ["quickfix"] }
    });
    const action = actions.find(a => a.isPreferred) ?? actions[0];
    expect(action, `no fix for ${code}`).toBeDefined();
    expect(action!.diagnostics?.[0]?.code).toBe(code);
    const edits = editsByUri(action!.edit!).get(t.uri(path(name)))!;
    for (const e of edits) expect(validRange(text, e.range)).toBe(true);
    const fixed = applyEdits(text, edits);
    await t.change(path(name), fixed);
    await t.waitForDiagnostics(path(name), x => !x.diagnostics.some(y => y.code === code), 10_000);
    return fixed;
  }

  it("unknown type → did-you-mean", async () => {
    const text = PROJECT["archive.yfl"]!;
    const fixed = await fixAll(
      "archive.yfl",
      text.replace("Entry   entries", "Entrx   entries"),
      "unknown-type"
    );
    expect(fixed).toBe(text);
  });

  it("unknown type → import it", async () => {
    const text = PROJECT["chunks.yfl"]!.replace(/\}\s*$/, "  Comment extra\n}\n");
    const fixed = await fixAll("chunks.yfl", text, "unknown-type");
    expect(fixed).toContain('import { Comment } from "./notes.yfl"');
    expect(t.diagnostics(path("chunks.yfl"))?.diagnostics ?? []).toEqual([]);
  });

  it("unused import → remove it", async () => {
    const text = PROJECT["chunks.yfl"]!.replace(
      'import { Archive } from "./archive.yfl"',
      'import { Archive } from "./archive.yfl"\nimport { Attrs } from "./common.yfl"'
    );
    expect(await fixAll("chunks.yfl", text, "unused-import")).toBe(PROJECT["chunks.yfl"]);
  });

  it("redundant formula → remove it", async () => {
    const text = PROJECT["archive.yfl"]!.replace("    u16  n  ", "    u16  n = entries.length  ");
    expect(text).not.toBe(PROJECT["archive.yfl"]);
    const fixed = await fixAll("archive.yfl", text, "redundant-formula");
    expect(fixed).toContain("u16  n ");
    expect(fixed).not.toContain("entries.length  ");
  });
});

describe("inlay hints and code lenses", () => {
  beforeEach(async () => {
    t = await startRealServer();
  });

  it("archive: the derived values of 6 fields, and the size of the fixed-size struct", async () => {
    const archive = PROJECT["archive.yfl"]!;
    await t.open(path("archive.yfl"), archive);
    await t.settle();
    const uri = t.uri(path("archive.yfl"));
    const hints = await t.request<lsp.InlayHint[]>("textDocument/inlayHint", {
      textDocument: { uri },
      range: {
        start: { line: 0, character: 0 },
        end: { line: archive.split("\n").length, character: 0 }
      }
    });
    expect(hints).toHaveLength(6);
    const s = hints.find(h => h.position.line === find(archive, "    u16  k ").line);
    expect(s?.label).toBe("= keep.length");
    const lenses = await t.request<lsp.CodeLens[]>("textDocument/codeLens", {
      textDocument: { uri }
    });
    const record = lenses.find(l => l.range.start.line === find(archive, "struct Entry {").line);
    expect(record?.command?.title).toBe("size: 0x18 (24 bytes)");
    expect(lenses).toHaveLength(1);
  });

  it("a bound value's lens lists where it comes from, as LSP locations", async () => {
    const text = [
      "export struct Root {",
      "  u8 $version",
      "  Inner inner",
      "}",
      "struct Inner {",
      "  u8 extra[$version]",
      "}",
      ""
    ].join("\n");
    await t.open("/ws/other/bound.yfl", text);
    await t.settle();
    const lenses = await t.request<lsp.CodeLens[]>("textDocument/codeLens", {
      textDocument: { uri: t.uri("/ws/other/bound.yfl") }
    });
    const lens = lenses.find(l => l.command?.command === "yaffle.showBindingSources");
    expect(lens, JSON.stringify(lenses)).toBeDefined();
    const [arg] = lens!.command!.arguments as [{ binding: string; sources: lsp.Location[] }];
    expect(arg.binding).toBe("version");
    expect(arg.sources).toEqual([
      {
        uri: t.uri("/ws/other/bound.yfl"),
        range: { start: { line: 1, character: 6 }, end: { line: 1, character: 13 } }
      }
    ]);
  });
});

describe("formatting", () => {
  beforeEach(async () => {
    t = await startRealServer();
  });

  it("a messy file formats in one go, and formatting again changes nothing", async () => {
    const messy = "struct  S{u32 a;u8 b // the b\n   Entry *e:u64 @nullable\n}\nstruct Entry{u8 x}";
    await t.open("/ws/other/messy.yfl", messy);
    await t.settle();
    const uri = t.uri("/ws/other/messy.yfl");
    const opts = { tabSize: 2, insertSpaces: true };
    const edits = await t.request<lsp.TextEdit[]>("textDocument/formatting", {
      textDocument: { uri },
      options: opts
    });
    const once = applyEdits(messy, edits);
    expect(once).toBe(
      "struct S {\n  u32    a\n  u8     b  // the b\n  Entry *e : u64 @nullable\n}\n\nstruct Entry { u8 x }\n"
    );
    await t.change("/ws/other/messy.yfl", once);
    expect(
      await t.request("textDocument/formatting", { textDocument: { uri }, options: opts })
    ).toEqual([]);
    const tabs = applyEdits(
      once,
      await t.request<lsp.TextEdit[]>("textDocument/formatting", {
        textDocument: { uri },
        options: { tabSize: 4, insertSpaces: false }
      })
    );
    expect(tabs).toContain("\n\tu32    a\n");
  });

  it("typing @ on a continuation line aligns it with the attributes above", async () => {
    const archive = PROJECT["archive.yfl"]!;
    await t.open(path("archive.yfl"), archive);
    await t.settle();
    const at = find(archive, "  u16      flags");
    const lineEnd = { line: at.line, character: archive.split("\n")[at.line]!.length };
    const typed = applyEdits(archive, [
      { range: { start: lineEnd, end: lineEnd }, newText: "\n@" }
    ]);
    await t.change(path("archive.yfl"), typed);
    const edits = await t.request<lsp.TextEdit[] | null>("textDocument/onTypeFormatting", {
      textDocument: { uri: t.uri(path("archive.yfl")) },
      position: { line: at.line + 1, character: 1 },
      ch: "@",
      options: { tabSize: 2, insertSpaces: true }
    });
    expect(edits).not.toBeNull();
    const aligned = applyEdits(typed, edits!).split("\n")[at.line + 1]!;
    expect(aligned.indexOf("@")).toBe(archive.split("\n")[at.line + 1]!.indexOf("@"));
  });
});

describe("custom requests", () => {
  beforeEach(async () => {
    t = await startRealServer();
  });

  it("yaffle/showIr compiles the unsaved text, imports included", async () => {
    const archive = PROJECT["archive.yfl"]!;
    await t.open(path("archive.yfl"), archive);
    await t.change(path("archive.yfl"), archive.replace(/\bEntry\b/g, "Entrz"));
    const ir = await t.request<{
      program: { structs: { name: string }[] } | null;
      diagnostics: unknown[];
      error?: string;
    }>("yaffle/showIr", { textDocument: { uri: t.uri(path("archive.yfl")) } });
    expect(ir.error).toBeUndefined();
    expect(ir.diagnostics).toEqual([]);
    const names = ir.program!.structs.map(s => s.name);
    expect(names).toEqual(expect.arrayContaining(["Archive", "Entrz", "Comment", "Attrs"]));
    expect(names).not.toContain("Entry");
  });

  it("yaffle/showIr reports compile errors as diagnostics with URIs", async () => {
    await t.open("/ws/other/bad.yfl", "export struct A { Nope x }\n");
    const ir = await t.request<{ program: unknown; diagnostics: { uri: string; code: string }[] }>(
      "yaffle/showIr",
      {
        textDocument: { uri: t.uri("/ws/other/bad.yfl") }
      }
    );
    expect(ir.program).toBeNull();
    expect(ir.diagnostics).toEqual([
      expect.objectContaining({ uri: t.uri("/ws/other/bad.yfl"), code: "unknown-type" })
    ]);
  });

  it("decodeSample and suggestLayout answer with a message when they can't", async () => {
    await t.open(path("archive.yfl"), PROJECT["archive.yfl"]!);
    const params = {
      textDocument: { uri: t.uri(path("archive.yfl")) },
      root: "Nope",
      sample: { base64: "AAAA" }
    };
    const decoded = await t.request<{ annotations: unknown[]; error?: string }>(
      "yaffle/decodeSample",
      params
    );
    expect(decoded.annotations).toEqual([]);
    expect(decoded.error).toMatch(/^No struct `Nope` in archive\.yfl/);
    const layout = await t.request<{ edit: unknown; error?: string }>(
      "yaffle/suggestLayout",
      params
    );
    expect(layout.edit).toBeNull();
    expect(layout.error).toMatch(/^No struct `Nope`/);
    const missing = await t.request<{ annotations: unknown[]; error?: string }>(
      "yaffle/decodeSample",
      { ...params, root: "Archive", sample: { uri: t.uri("/nowhere/sample.bin") } }
    );
    expect(missing.error).toMatch(/Cannot read the sample file/);
    expect(errorLogs(t)).toEqual([]);
  });
});
