/** Settings (the `yaffle` configuration section) and a fallback `yaffle.json` loader. */
import type { Diagnostic, ProjectConfig } from "yaffle/service";
import { DEFAULT_SETTINGS, type YaffleSettings } from "./protocol.ts";
import { errorMessage, isRecord } from "./util.ts";

/** Reads text files for config loading (the compiler's `CompilerHost` shape). */
export interface ConfigHost {
  readFile(path: string): string | undefined;
  fileExists(path: string): boolean;
}

/** The compiler's `loadProjectConfig` signature. */
export type LoadProjectConfig = (
  path: string,
  host: ConfigHost
) => { config?: ProjectConfig; diagnostics: Diagnostic[] };

/** Read `a.b.c` from nested objects or from flat dotted keys (`{ "a.b.c": … }`). */
function lookup(raw: Record<string, unknown>, dotted: string): unknown {
  if (dotted in raw) return raw[dotted];
  let cur: unknown = raw;
  for (const part of dotted.split(".")) {
    if (!isRecord(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function delay(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), 0), 10_000);
}

function scope(value: unknown, fallback: YaffleSettings["diagnostics"]["scope"]) {
  return value === "project" || value === "openFiles" ? value : fallback;
}

/** Merge raw settings (from the client, possibly partial or malformed) over `base`. */
export function resolveSettings(
  raw: unknown,
  base: YaffleSettings = DEFAULT_SETTINGS
): YaffleSettings {
  if (!isRecord(raw)) return base;
  const r = isRecord(raw.yaffle) ? raw.yaffle : raw;
  return {
    diagnostics: {
      delay: delay(lookup(r, "diagnostics.delay"), base.diagnostics.delay),
      scope: scope(lookup(r, "diagnostics.scope"), base.diagnostics.scope)
    },
    inlayHints: { enabled: bool(lookup(r, "inlayHints.enabled"), base.inlayHints.enabled) },
    codeLens: { enabled: bool(lookup(r, "codeLens.enabled"), base.codeLens.enabled) },
    format: { enabled: bool(lookup(r, "format.enabled"), base.format.enabled) },
    alignAttributesOnType: {
      enabled: bool(lookup(r, "alignAttributesOnType.enabled"), base.alignAttributesOnType.enabled)
    }
  };
}

/** Strip `//` and `/* *\/` comments and trailing commas from JSONC, keeping offsets intact. */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
      out += text.slice(start, i);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  // Trailing commas: `,` followed by whitespace and a closing bracket.
  return out.replace(/,(\s*[}\]])/g, " $1");
}

function offsetToPosition(text: string, offset: number): { line: number; character: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines[lines.length - 1]!.length };
}

/**
 * A minimal yaffle.json loader, the default when no `loadProjectConfig` is injected (a service
 * module without one). Accepts JSONC; checks only the shape the server needs (`sources`, `targets`).
 */
export const fallbackLoadProjectConfig: LoadProjectConfig = (path, host) => {
  const text = host.readFile(path);
  const at = (offset: number) => {
    const p = offsetToPosition(text ?? "", offset);
    return { start: p, end: { line: p.line, character: p.character + 1 } };
  };
  const problem = (message: string, offset = 0): Diagnostic => ({
    path,
    range: at(offset),
    severity: "error",
    code: "invalid-config",
    message
  });
  if (text === undefined) return { diagnostics: [problem("Cannot read yaffle.json")] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch (error) {
    const message = errorMessage(error);
    const pos = /position (\d+)/.exec(message);
    return { diagnostics: [problem(`Invalid JSON: ${message}`, pos ? Number(pos[1]) : 0)] };
  }
  if (!isRecord(parsed)) return { diagnostics: [problem("yaffle.json must contain an object")] };
  const diagnostics: Diagnostic[] = [];
  let sources: string[] = ["**/*.yfl"];
  if (parsed.sources !== undefined) {
    if (Array.isArray(parsed.sources) && parsed.sources.every(s => typeof s === "string")) {
      sources = parsed.sources as string[];
    } else {
      diagnostics.push(
        problem('"sources" must be an array of glob strings', text.indexOf('"sources"'))
      );
    }
  }
  const targets: ProjectConfig["targets"] = {};
  if (parsed.targets !== undefined) {
    if (isRecord(parsed.targets)) {
      for (const [name, target] of Object.entries(parsed.targets)) {
        if (isRecord(target) && typeof target.out === "string") {
          targets[name] = target as ProjectConfig["targets"][string];
        } else {
          diagnostics.push(
            problem(`Target "${name}" needs an "out" directory`, text.indexOf(`"${name}"`))
          );
        }
      }
    } else {
      diagnostics.push(problem('"targets" must be an object', text.indexOf('"targets"')));
    }
  }
  return { config: { sources, targets }, diagnostics };
};
