import { createLanguageService } from "../../src/service/index.ts";
import type { LanguageService, Position, ProjectHost } from "../../src/service/api.ts";

export interface TestHost extends ProjectHost {
  files: Record<string, string>;
  reads: string[];
}

export function host(files: Record<string, string> = {}, withDirs = true): TestHost {
  const h: TestHost = {
    files,
    reads: [],
    readFile(p) {
      h.reads.push(p);
      return h.files[p];
    },
    fileExists(p) {
      return p in h.files;
    }
  };
  if (withDirs) {
    h.readDirectory = (dir: string) => {
      const prefix = dir.endsWith("/") ? dir : dir + "/";
      const names = new Set<string>();
      for (const f of Object.keys(h.files)) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const i = rest.indexOf("/");
        names.add(i < 0 ? rest : rest.slice(0, i + 1));
      }
      return names.size ? [...names].sort() : undefined;
    };
  }
  return h;
}

/** A service with one open file containing `text` (a `|` marks the cursor). */
export function open(
  text: string,
  path = "/w/main.yfl",
  files: Record<string, string> = {}
): { ls: LanguageService; pos: Position; path: string; text: string } {
  const i = text.indexOf("|");
  const clean = i >= 0 ? text.slice(0, i) + text.slice(i + 1) : text;
  const before = i >= 0 ? text.slice(0, i).split("\n") : [""];
  const pos = { line: before.length - 1, character: before[before.length - 1]!.length };
  const ls = createLanguageService(host(files));
  ls.updateFile(path, clean);
  return { ls, pos, path, text: clean };
}

/** Position of the n-th occurrence of `needle` in `text` (plus an offset into it). */
export function posOf(text: string, needle: string, delta = 0, nth = 0): Position {
  let idx = -1;
  for (let k = 0; k <= nth; k++) idx = text.indexOf(needle, idx + 1);
  if (idx < 0) throw new Error(`'${needle}' not found`);
  const o = idx + delta;
  const lines = text.slice(0, o).split("\n");
  return { line: lines.length - 1, character: lines[lines.length - 1]!.length };
}
