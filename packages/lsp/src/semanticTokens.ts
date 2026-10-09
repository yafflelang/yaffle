/**
 * Semantic tokens: the legend comes straight from the language service API's token types and
 * modifiers (a compile-time check keeps the lists exhaustive). Full, delta and range requests
 * share one validated token list.
 */
import type * as lsp from "vscode-languageserver";
import type { SemanticToken, SemanticTokenModifier, SemanticTokenType } from "yaffle/service";

export const TOKEN_TYPES = [
  "namespace",
  "struct",
  "enum",
  "enumMember",
  "type",
  "typeParameter",
  "parameter",
  "property",
  "variable",
  "function",
  "keyword",
  "decorator",
  "number",
  "string",
  "regexp",
  "comment",
  "operator"
] as const satisfies readonly SemanticTokenType[];

export const TOKEN_MODIFIERS = [
  "declaration",
  "readonly",
  "defaultLibrary",
  "deprecated"
] as const satisfies readonly SemanticTokenModifier[];

// Exhaustiveness: adding a type or modifier to the service API without listing it here fails
// to typecheck.
type Missing<All, Listed> = Exclude<All, Listed> extends never ? true : Exclude<All, Listed>;
const typesComplete: Missing<SemanticTokenType, (typeof TOKEN_TYPES)[number]> = true;
const modifiersComplete: Missing<SemanticTokenModifier, (typeof TOKEN_MODIFIERS)[number]> = true;
void typesComplete;
void modifiersComplete;

export const SEMANTIC_TOKENS_LEGEND: lsp.SemanticTokensLegend = {
  tokenTypes: [...TOKEN_TYPES],
  tokenModifiers: [...TOKEN_MODIFIERS]
};

const TYPE_INDEX = new Map<string, number>(TOKEN_TYPES.map((t, i) => [t, i]));
const MODIFIER_BIT = new Map<string, number>(TOKEN_MODIFIERS.map((m, i) => [m, 1 << i]));

export interface EncodedToken {
  line: number;
  character: number;
  length: number;
  type: number;
  modifiers: number;
}

function isCount(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/**
 * Validate, sort and de-overlap service tokens. Unknown types, negative or zero lengths and
 * tokens overlapping an earlier one are dropped; `lineLength` (when known) clamps tokens to
 * their line, since LSP tokens can't span lines.
 */
export function prepareTokens(
  tokens: SemanticToken[],
  lineLength?: (line: number) => number | undefined
): EncodedToken[] {
  const valid: EncodedToken[] = [];
  for (const t of tokens) {
    if (!t || !isCount(t.line) || !isCount(t.character) || !isCount(t.length) || t.length === 0) {
      continue;
    }
    const type = TYPE_INDEX.get(t.type);
    if (type === undefined) continue;
    let modifiers = 0;
    for (const m of Array.isArray(t.modifiers) ? t.modifiers : []) {
      modifiers |= MODIFIER_BIT.get(m) ?? 0;
    }
    let length = t.length;
    const max = lineLength?.(t.line);
    if (max !== undefined) {
      if (t.character >= max) continue;
      length = Math.min(length, max - t.character);
    }
    valid.push({ line: t.line, character: t.character, length, type, modifiers });
  }
  valid.sort((a, b) => a.line - b.line || a.character - b.character);
  const out: EncodedToken[] = [];
  for (const t of valid) {
    const prev = out[out.length - 1];
    if (prev && prev.line === t.line && t.character < prev.character + prev.length) continue;
    out.push(t);
  }
  return out;
}

/** Delta-encode prepared tokens into the LSP integer array. */
export function encodeTokens(tokens: EncodedToken[]): number[] {
  const data: number[] = [];
  let prevLine = 0;
  let prevChar = 0;
  for (const t of tokens) {
    const deltaLine = t.line - prevLine;
    const deltaChar = deltaLine === 0 ? t.character - prevChar : t.character;
    data.push(deltaLine, deltaChar, t.length, t.type, t.modifiers);
    prevLine = t.line;
    prevChar = t.character;
  }
  return data;
}

/**
 * Per-document results, so delta requests can send only what changed. Result ids come from a
 * counter (the library's builder uses Date.now(), which repeats within a millisecond).
 */
export class SemanticTokensCache {
  private readonly last = new Map<string, { resultId: string; data: number[] }>();
  private counter = 0;

  full(uri: string, tokens: EncodedToken[]): lsp.SemanticTokens {
    const data = encodeTokens(tokens);
    const resultId = String(++this.counter);
    this.last.set(uri, { resultId, data });
    return { resultId, data };
  }

  delta(
    uri: string,
    previousResultId: string,
    tokens: EncodedToken[]
  ): lsp.SemanticTokens | lsp.SemanticTokensDelta {
    const previous = this.last.get(uri);
    if (!previous || previous.resultId !== previousResultId) return this.full(uri, tokens);
    const data = encodeTokens(tokens);
    const old = previous.data;
    let prefix = 0;
    while (prefix < old.length && prefix < data.length && old[prefix] === data[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < old.length - prefix &&
      suffix < data.length - prefix &&
      old[old.length - 1 - suffix] === data[data.length - 1 - suffix]
    ) {
      suffix++;
    }
    const resultId = String(++this.counter);
    this.last.set(uri, { resultId, data });
    const deleteCount = old.length - prefix - suffix;
    const inserted = data.slice(prefix, data.length - suffix);
    if (deleteCount === 0 && inserted.length === 0) return { resultId, edits: [] };
    return { resultId, edits: [{ start: prefix, deleteCount, data: inserted }] };
  }

  range(tokens: EncodedToken[], range: lsp.Range): lsp.SemanticTokens {
    const selected = tokens.filter(t => {
      const before =
        t.line < range.start.line ||
        (t.line === range.start.line && t.character + t.length <= range.start.character);
      const after =
        t.line > range.end.line ||
        (t.line === range.end.line && t.character >= range.end.character);
      return !before && !after;
    });
    return { data: encodeTokens(selected) };
  }

  forget(uri: string): void {
    this.last.delete(uri);
  }
}
