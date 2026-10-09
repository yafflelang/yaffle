/** Tokenize yaffle source with the real TextMate engine (vscode-textmate + oniguruma WASM). */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import vsctm from "vscode-textmate";
import oniguruma from "vscode-oniguruma";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
export const GRAMMAR_FILE = path.resolve(here, "../syntaxes/yaffle.tmLanguage.json");

export interface Token {
  text: string;
  scopes: string[];
  line: number;
}

let grammarPromise: Promise<vsctm.IGrammar> | undefined;

async function loadGrammar(): Promise<vsctm.IGrammar> {
  const wasm = fs.readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"));
  await oniguruma.loadWASM(
    wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer
  );
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
      createOnigString: s => new oniguruma.OnigString(s)
    }),
    loadGrammar: async scope =>
      scope === "source.yaffle"
        ? vsctm.parseRawGrammar(fs.readFileSync(GRAMMAR_FILE, "utf8"), GRAMMAR_FILE)
        : null
  });
  const grammar = await registry.loadGrammar("source.yaffle");
  if (!grammar) throw new Error("grammar failed to load");
  return grammar;
}

export function grammar(): Promise<vsctm.IGrammar> {
  grammarPromise ??= loadGrammar();
  return grammarPromise;
}

export async function tokenize(source: string): Promise<Token[]> {
  const g = await grammar();
  let state = vsctm.INITIAL;
  const out: Token[] = [];
  source.split(/\r?\n/).forEach((line, lineNo) => {
    const result = g.tokenizeLine(line, state);
    state = result.ruleStack;
    for (const t of result.tokens) {
      out.push({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes, line: lineNo });
    }
  });
  return out;
}

/** Render tokens for debugging failures. */
export function dump(tokens: Token[]): string {
  return tokens
    .filter(t => t.text.trim() !== "")
    .map(t => `${t.line}: ${JSON.stringify(t.text)} ${t.scopes.slice(1).join(" ")}`)
    .join("\n");
}
