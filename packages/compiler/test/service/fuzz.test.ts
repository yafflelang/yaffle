/**
 * Robustness: random edits of realistic sources (deterministic PRNG) must never make the
 * frontend or any language-service feature throw.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLanguageService } from "../../src/service/index.ts";
import { formatSource } from "../../src/frontend/format.ts";
import { host } from "./util.ts";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../frontend/fixtures/${name}`, import.meta.url)), "utf8");

/** A container with an entry table, layout rules, and a stream joined from compressed pieces. */
const ARCHIVE = `extern codec zstd

enum Kind : u16 {
  Data = 0
  Code = 1
}

/// One byte range of the archive (0x16 bytes).
struct Entry {
  Kind    kind
  u32     align   = 0x100
  u64     offset            // where the data starts
  u32     size              // written as data.length
  u32     reserved = 0
  u8      data[size] at offset
}

/// The archive: header, entry table, then each entry's data (0x100-aligned).
export struct Archive @base {
  @padUntil(0x80) {
    char tag[4] = "ARCV"
    u32  count
  }
  Entry entries[count]
  layout {
    entries[*].data @align(0x100)
  }
}

struct Frag {
  char    magic[4] = "FRAG"
  u32     exp           // decoded size: where the split falls
  u32     comp
  u8      data[] @size(exp) @via(zstd) @size(comp)
}

/// One compressed piece per 4 KiB block; the decoded pieces joined are the archive.
export struct Fragmented {
  Frag    frags[] at max($index * 0x1000, 0x10)
  Archive file from frags[*].data @split(fit)
}
`;

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const SNIPPETS = [
  "{",
  "}",
  "(",
  ")",
  "[",
  "]",
  "@",
  "$",
  ":",
  "=",
  "*",
  ",",
  ";",
  "\n",
  "if",
  "at",
  "as",
  "in",
  "struct ",
  "u32 ",
  "..",
  "'",
  '"',
  "/",
  "//",
  "/*",
  "[*]",
  "it",
  "<",
  ">",
  "0x",
  "@size(",
  "@via(",
  "switch (",
  "case ",
  "layout {"
];

function mutate(text: string, rnd: () => number): string {
  let t = text;
  const n = 1 + Math.floor(rnd() * 4);
  for (let k = 0; k < n; k++) {
    const pos = Math.floor(rnd() * (t.length + 1));
    const r = rnd();
    if (r < 0.4) t = t.slice(0, pos) + t.slice(pos + 1 + Math.floor(rnd() * 8));
    else if (r < 0.8)
      t = t.slice(0, pos) + SNIPPETS[Math.floor(rnd() * SNIPPETS.length)]! + t.slice(pos);
    else {
      const a = Math.floor(rnd() * t.length);
      t = t.slice(0, pos) + t.slice(a, a + 10) + t.slice(pos);
    }
  }
  return t;
}

describe("fuzz: broken edits never throw", () => {
  const files = {
    "/f/archive.yfl": ARCHIVE,
    "/f/tiff.yfl": read("tiff.yfl")
  };

  for (const [path, text] of Object.entries(files)) {
    it(`mutations of ${path.split("/").pop()}`, () => {
      const rnd = prng(path.length * 7919);
      const ls = createLanguageService(host({ ...files }));
      for (let i = 0; i < 60; i++) {
        const t = mutate(text, rnd);
        ls.updateFile(path, t);
        const lines = t.split("\n");
        const line = Math.floor(rnd() * lines.length);
        const pos = { line, character: Math.floor(rnd() * ((lines[line]?.length ?? 0) + 1)) };
        try {
          ls.getDiagnostics(path);
          ls.getHover(path, pos);
          ls.getCompletions(path, pos);
          ls.getSignatureHelp(path, pos);
          ls.getDefinition(path, pos);
          ls.getReferences(path, pos, true);
          ls.prepareRename(path, pos);
          ls.rename(path, pos, "renamed");
          ls.getDocumentSymbols(path);
          ls.getWorkspaceSymbols("a");
          ls.getInlayHints(path, {
            start: { line: 0, character: 0 },
            end: { line: lines.length, character: 0 }
          });
          ls.getCodeLenses(path);
          ls.getSemanticTokens(path);
          ls.getFoldingRanges(path);
          ls.format(path);
          for (const d of ls.getDiagnostics(path)) ls.getCodeActions(path, d.range, [d]);
          const f = formatSource(t);
          if (f.formatted) expect(formatSource(f.text).text).toBe(f.text);
        } catch (e) {
          throw new Error(
            `threw on mutation ${i} at ${JSON.stringify(pos)}:\n${t}\n\n${(e as Error).stack}`,
            { cause: e }
          );
        }
      }
    });
  }
});
