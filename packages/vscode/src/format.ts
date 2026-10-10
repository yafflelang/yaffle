/** Pure helpers of the extension's commands (no `vscode` import, so they can be unit tested). */
import type { LspRange, ShowIrResult } from "@yafflelang/lsp/protocol";

export interface LspLocation {
  uri: string;
  range: LspRange;
}

/** LSP locations anywhere in (code lens) command arguments. */
export function collectLocations(value: unknown, depth = 0): LspLocation[] {
  if (depth > 6 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(v => collectLocations(v, depth + 1));
  const v = value as Record<string, unknown>;
  if (typeof v.uri === "string" && typeof v.range === "object" && v.range !== null) {
    return [value as LspLocation];
  }
  return Object.values(v).flatMap(x => collectLocations(x, depth + 1));
}

/** The text of an IR view: diagnostics as comments, then the IR JSON. */
export function formatIr(result: ShowIrResult, source: string): string {
  const lines = [`// IR of ${source}`];
  if (result.error) lines.push(`// ${result.error}`);
  for (const d of result.diagnostics) {
    const file = d.uri === source ? "" : `${d.uri} `;
    const at = `${d.range.start.line + 1}:${d.range.start.character + 1}`;
    lines.push(`// ${d.severity} ${file}${at} ${d.message} [${d.code}]`);
  }
  if (result.program === null || result.program === undefined) {
    if (!result.error) lines.push("// No IR: fix the errors above.");
    return lines.join("\n") + "\n";
  }
  return lines.join("\n") + "\n" + JSON.stringify(result.program, null, 2) + "\n";
}
