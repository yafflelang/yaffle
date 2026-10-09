/**
 * A fake LanguageService for protocol tests. It implements every method with simple text rules
 * (so results are predictable) and records each call. Rules:
 *
 * - diagnostics: the word `ERROR` → error "fake-error" (with a quick fix); `WARN` → warning;
 *   `HINT` → hint with the "unnecessary" tag; `import … from "x"` → "unresolved-import" when x
 *   doesn't exist, "import-has-errors" when x contains `ERROR` (cross-file); `ELSEWHERE <path>`
 *   → a diagnostic reported for another file.
 * - symbols: `struct Name {` … `}` blocks, with `type name` fields inside.
 * - hover/definition/references/rename: the identifier under the cursor.
 */
import * as nodePath from "node:path";
import type {
  CodeAction,
  CodeLens,
  CompletionItem,
  Diagnostic,
  DocumentSymbol,
  FoldingRange,
  Hover,
  InlayHint,
  LanguageService,
  Location,
  Position,
  ProjectConfig,
  ProjectHost,
  Range,
  RootParameter,
  SampleAnnotation,
  SemanticToken,
  SignatureHelp,
  TextEdit,
  WorkspaceEdit,
  WorkspaceSymbol
} from "yaffle/service";

export type Platform = "posix" | "win32";

export interface Call {
  method: string;
  args: unknown[];
}

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const PRIMITIVES = new Set([
  "u8",
  "u16",
  "u32",
  "u64",
  "i8",
  "i16",
  "i32",
  "i64",
  "f32",
  "f64",
  "bool",
  "char",
  "str"
]);
const KEYWORDS = new Set([
  "struct",
  "import",
  "from",
  "export",
  "enum",
  "if",
  "else",
  "switch",
  "case"
]);

function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

function range(line: number, start: number, end: number): Range {
  return { start: { line, character: start }, end: { line, character: end } };
}

export class FakeService implements LanguageService {
  readonly host: ProjectHost;
  readonly platform: Platform;
  readonly files = new Map<string, string>();
  readonly calls: Call[] = [];
  project: { config: ProjectConfig | undefined; rootDir: string | undefined } | undefined;
  /** Methods that throw. */
  readonly failing = new Set<string>();
  /** Per-method overrides (take precedence over the built-in rules). */
  readonly overrides: Partial<
    Record<keyof LanguageService | "filesChanged", (...args: never[]) => unknown>
  > = {};
  /** Set to a number to make getDiagnostics busy-wait (ms), to test aborting passes. */
  diagnosticsDelayMs = 0;
  /** What getProjectFiles returns. */
  projectFiles: string[] = [];

  constructor(host: ProjectHost, platform: Platform = "posix") {
    this.host = host;
    this.platform = platform;
  }

  private record<T>(method: string, args: unknown[], fallback: () => T): T {
    this.calls.push({ method, args });
    if (this.failing.has(method)) throw new Error(`fake ${method} failure`);
    const override = this.overrides[method as keyof FakeService["overrides"]];
    if (override) return (override as (...a: unknown[]) => T)(...args);
    return fallback();
  }

  callsTo(method: string): Call[] {
    return this.calls.filter(c => c.method === method);
  }

  private get path(): typeof nodePath.posix {
    return this.platform === "win32" ? nodePath.win32 : nodePath.posix;
  }

  text(path: string): string {
    return this.files.get(this.key(path)) ?? this.host.readFile(path) ?? "";
  }

  private key(path: string): string {
    return this.platform === "win32" ? path.toLowerCase() : path;
  }

  private wordAt(path: string, pos: Position): { word: string; range: Range } | undefined {
    const line = lines(this.text(path))[pos.line];
    if (line === undefined) return undefined;
    for (const m of line.matchAll(IDENT)) {
      const start = m.index;
      const end = start + m[0].length;
      if (pos.character >= start && pos.character <= end)
        return { word: m[0], range: range(pos.line, start, end) };
    }
    return undefined;
  }

  private occurrences(path: string, word: string): Location[] {
    const out: Location[] = [];
    lines(this.text(path)).forEach((line, i) => {
      for (const m of line.matchAll(IDENT)) {
        if (m[0] === word) out.push({ path, range: range(i, m.index, m.index + word.length) });
      }
    });
    return out;
  }

  private resolveImport(from: string, spec: string): string {
    return this.path.resolve(this.path.dirname(from), spec);
  }

  // --- LanguageService -------------------------------------------------------------------------

  updateFile(path: string, text: string): void {
    this.record("updateFile", [path, text], () => this.files.set(this.key(path), text));
  }

  closeFile(path: string): void {
    this.record("closeFile", [path], () => this.files.delete(this.key(path)));
  }

  setProject(config: ProjectConfig | undefined, rootDir: string | undefined): void {
    this.record("setProject", [config, rootDir], () => {
      this.project = { config, rootDir };
    });
  }

  dispose(): void {
    this.record("dispose", [], () => undefined);
  }

  filesChanged(paths: string[]): void {
    this.record("filesChanged", [paths], () => undefined);
  }

  getDiagnostics(path: string): Diagnostic[] {
    return this.record("getDiagnostics", [path], () => {
      if (this.diagnosticsDelayMs > 0) {
        const until = Date.now() + this.diagnosticsDelayMs;
        while (Date.now() < until) {
          // busy wait
        }
      }
      const out: Diagnostic[] = [];
      lines(this.text(path)).forEach((line, i) => {
        const err = line.indexOf("ERROR");
        if (err >= 0) {
          const fix: CodeAction = {
            title: "Remove ERROR",
            kind: "quickfix",
            edit: { changes: { [path]: [{ range: range(i, err, err + 5), newText: "" }] } },
            diagnosticCodes: ["fake-error"],
            isPreferred: true
          };
          out.push({
            path,
            range: range(i, err, err + 5),
            severity: "error",
            code: "fake-error",
            message: `Fake error on line ${i + 1}`,
            related: [{ location: { path, range: range(0, 0, 1) }, message: "first line" }],
            fixes: [fix]
          });
        }
        const warn = line.indexOf("WARN");
        if (warn >= 0) {
          out.push({
            path,
            range: range(i, warn, warn + 4),
            severity: "warning",
            code: "fake-warning",
            message: "Fake warning"
          });
        }
        const hint = line.indexOf("HINT");
        if (hint >= 0) {
          out.push({
            path,
            range: range(i, hint, hint + 4),
            severity: "hint",
            code: "fake-hint",
            message: "Fake hint",
            tags: ["unnecessary"]
          });
        }
        const imp = /import .* from "([^"]+)"/.exec(line);
        if (imp) {
          const target = this.resolveImport(path, imp[1]!);
          const exists = this.files.has(this.key(target)) || this.host.fileExists(target);
          const start = line.indexOf('"');
          if (!exists) {
            out.push({
              path,
              range: range(i, start, start + imp[1]!.length + 2),
              severity: "error",
              code: "unresolved-import",
              message: `Cannot find ${imp[1]}`
            });
          } else if (this.text(target).includes("ERROR")) {
            out.push({
              path,
              range: range(i, start, start + imp[1]!.length + 2),
              severity: "error",
              code: "import-has-errors",
              message: `${imp[1]} has errors`,
              related: [{ location: { path: target, range: range(0, 0, 0) }, message: "here" }]
            });
          }
        }
        const elsewhere = /ELSEWHERE (\S+)/.exec(line);
        if (elsewhere) {
          out.push({
            path: elsewhere[1]!,
            range: range(0, 0, 1),
            severity: "info",
            code: "elsewhere",
            message: `Reported from ${path}`
          });
        }
      });
      return out;
    });
  }

  getHover(path: string, position: Position): Hover | undefined {
    return this.record("getHover", [path, position], () => {
      const w = this.wordAt(path, position);
      if (!w) return undefined;
      return {
        contents: "```yaffle\n" + w.word + "\n```\nHover for `" + w.word + "`",
        range: w.range
      };
    });
  }

  getCompletions(path: string, position: Position): CompletionItem[] {
    return this.record("getCompletions", [path, position], () => [
      { label: "u32", kind: "primitive", detail: "4 bytes" },
      {
        label: "count",
        kind: "field",
        detail: "u32",
        documentation: "The **count**",
        sortText: "0"
      },
      {
        label: "$version",
        kind: "bound",
        insertText: "$version",
        range: range(position.line, Math.max(0, position.character - 1), position.character)
      },
      {
        label: "struct",
        kind: "snippet",
        insertText: "struct ${1:Name} {\n  ${2:u32} ${3:field}\n}$0",
        insertTextFormat: "snippet",
        detail: "struct declaration"
      },
      { label: "@align", kind: "attribute" },
      { label: "zstd", kind: "codec" }
    ]);
  }

  getSignatureHelp(path: string, position: Position): SignatureHelp | undefined {
    return this.record("getSignatureHelp", [path, position], () => {
      const line = lines(this.text(path))[position.line] ?? "";
      const before = line.slice(0, position.character);
      const open = before.lastIndexOf("(");
      if (open < 0) return undefined;
      const commas = before.slice(open).split(",").length - 1;
      return {
        signatures: [
          {
            label: "@align(n: u64, fill?: u8)",
            documentation: "Pad before the field",
            parameters: [{ label: "n: u64", documentation: "alignment" }, { label: "fill?: u8" }]
          }
        ],
        activeSignature: 0,
        activeParameter: commas
      };
    });
  }

  private structs(path: string): {
    name: string;
    line: number;
    start: number;
    end: number;
    fields: { type: string; name: string; line: number; start: number }[];
  }[] {
    const out: ReturnType<FakeService["structs"]> = [];
    const ls = lines(this.text(path));
    for (let i = 0; i < ls.length; i++) {
      const m = /^(\s*)(?:export\s+)?struct\s+([A-Za-z_]\w*)/.exec(ls[i]!);
      if (!m) continue;
      const name = m[2]!;
      const start = ls[i]!.indexOf(name, m[1]!.length);
      let end = i;
      const fields: { type: string; name: string; line: number; start: number }[] = [];
      for (let j = i + 1; j < ls.length; j++) {
        if (/^\s*}/.test(ls[j]!)) {
          end = j;
          break;
        }
        const f = /^\s*([A-Za-z_]\w*)\s+(\$?[A-Za-z_]\w*)/.exec(ls[j]!);
        if (f)
          fields.push({
            type: f[1]!,
            name: f[2]!,
            line: j,
            start: ls[j]!.indexOf(f[2]!, ls[j]!.indexOf(f[1]!) + f[1]!.length)
          });
        end = j;
      }
      out.push({ name, line: i, start, end, fields });
    }
    return out;
  }

  getDefinition(path: string, position: Position): Location[] {
    return this.record("getDefinition", [path, position], () => {
      const w = this.wordAt(path, position);
      if (!w) return [];
      const candidates = [path, ...[...this.files.keys()].filter(k => k !== this.key(path))];
      for (const file of candidates) {
        for (const s of this.structs(file)) {
          if (s.name === w.word)
            return [{ path: file, range: range(s.line, s.start, s.start + s.name.length) }];
        }
      }
      return [];
    });
  }

  getReferences(path: string, position: Position, includeDeclaration: boolean): Location[] {
    return this.record("getReferences", [path, position, includeDeclaration], () => {
      const w = this.wordAt(path, position);
      if (!w) return [];
      const all = this.occurrences(path, w.word);
      if (includeDeclaration) return all;
      const decl = this.getDefinition(path, position)[0];
      return all.filter(l => !decl || JSON.stringify(l.range) !== JSON.stringify(decl.range));
    });
  }

  prepareRename(
    path: string,
    position: Position
  ): { range: Range; placeholder: string } | undefined {
    return this.record("prepareRename", [path, position], () => {
      const w = this.wordAt(path, position);
      if (!w || KEYWORDS.has(w.word) || PRIMITIVES.has(w.word)) return undefined;
      return { range: w.range, placeholder: w.word };
    });
  }

  rename(path: string, position: Position, newName: string): WorkspaceEdit | undefined {
    return this.record("rename", [path, position, newName], () => {
      const prep = this.prepareRename(path, position);
      if (!prep) return undefined;
      const edits: TextEdit[] = this.occurrences(path, prep.placeholder).map(l => ({
        range: l.range,
        newText: newName
      }));
      return { changes: { [path]: edits } };
    });
  }

  getDocumentSymbols(path: string): DocumentSymbol[] {
    return this.record("getDocumentSymbols", [path], () =>
      this.structs(path).map(s => ({
        name: s.name,
        kind: "struct" as const,
        detail: `${s.fields.length} fields`,
        range: { start: { line: s.line, character: 0 }, end: { line: s.end, character: 1 } },
        selectionRange: range(s.line, s.start, s.start + s.name.length),
        children: s.fields.map(f => ({
          name: f.name,
          kind: "field" as const,
          detail: f.type,
          range: range(f.line, 0, f.start + f.name.length),
          selectionRange: range(f.line, f.start, f.start + f.name.length)
        }))
      }))
    );
  }

  getWorkspaceSymbols(query: string): WorkspaceSymbol[] {
    return this.record("getWorkspaceSymbols", [query], () => {
      const out: WorkspaceSymbol[] = [];
      for (const file of this.files.keys()) {
        for (const s of this.structs(file)) {
          if (s.name.toLowerCase().includes(query.toLowerCase())) {
            out.push({
              name: s.name,
              kind: "struct",
              location: { path: file, range: range(s.line, s.start, s.start + s.name.length) },
              containerName: "fake"
            });
          }
        }
      }
      return out;
    });
  }

  getInlayHints(path: string, r: Range): InlayHint[] {
    return this.record("getInlayHints", [path, r], () => {
      const out: InlayHint[] = [];
      lines(this.text(path)).forEach((line, i) => {
        if (i < r.start.line || i > r.end.line) return;
        const m = /\bcount\b/.exec(line);
        if (m) {
          out.push({
            position: { line: i, character: m.index + 5 },
            label: "= entries.length",
            kind: "type",
            tooltip: "Derived **automatically**",
            paddingLeft: true
          });
        }
      });
      return out;
    });
  }

  getCodeLenses(path: string): CodeLens[] {
    return this.record("getCodeLenses", [path], () =>
      this.structs(path)
        .filter(() => this.text(path).includes("$version"))
        .map(s => ({
          range: range(s.line, 0, 0),
          title: "needs: $version (u32)",
          command: {
            id: "yaffle.showBindingSources",
            arguments: [
              path,
              { line: s.line, character: 0 },
              [{ path, range: range(s.line, s.start, s.start + 1) }]
            ]
          }
        }))
    );
  }

  getCodeActions(path: string, r: Range, diagnostics: Diagnostic[]): CodeAction[] {
    return this.record("getCodeActions", [path, r, diagnostics], () => {
      const out: CodeAction[] = [];
      for (const d of diagnostics) {
        if (d.code === "fake-warning") {
          out.push({
            title: "Silence warning",
            kind: "quickfix",
            edit: { changes: { [path]: [{ range: d.range, newText: "ok" }] } },
            diagnosticCodes: ["fake-warning"]
          });
        }
      }
      out.push({ title: "Sort fields", kind: "source", edit: { changes: { [path]: [] } } });
      out.push({ title: "Extract struct", kind: "refactor", edit: { changes: { [path]: [] } } });
      return out;
    });
  }

  getSemanticTokens(path: string): SemanticToken[] {
    return this.record("getSemanticTokens", [path], () => {
      const out: SemanticToken[] = [];
      lines(this.text(path)).forEach((line, i) => {
        for (const m of line.matchAll(IDENT)) {
          if (KEYWORDS.has(m[0]))
            out.push({
              line: i,
              character: m.index,
              length: m[0].length,
              type: "keyword",
              modifiers: []
            });
          else if (PRIMITIVES.has(m[0]))
            out.push({
              line: i,
              character: m.index,
              length: m[0].length,
              type: "type",
              modifiers: ["defaultLibrary"]
            });
          else if (m[0].startsWith("$"))
            out.push({
              line: i,
              character: m.index,
              length: m[0].length,
              type: "variable",
              modifiers: ["readonly"]
            });
        }
      });
      return out;
    });
  }

  getFoldingRanges(path: string): FoldingRange[] {
    return this.record("getFoldingRanges", [path], () => {
      const out: FoldingRange[] = this.structs(path).map(s => ({
        startLine: s.line,
        endLine: s.end
      }));
      const ls = lines(this.text(path));
      const imports = ls.map((l, i) => (l.startsWith("import") ? i : -1)).filter(i => i >= 0);
      if (imports.length > 1)
        out.push({
          startLine: imports[0]!,
          endLine: imports[imports.length - 1]!,
          kind: "imports"
        });
      return out;
    });
  }

  getProjectFiles(): string[] {
    return this.record("getProjectFiles", [], () => this.projectFiles);
  }

  format(path: string, options?: unknown): TextEdit[] {
    return this.record("format", [path, options], () => {
      const out: TextEdit[] = [];
      lines(this.text(path)).forEach((line, i) => {
        const trimmed = line.trimEnd();
        if (trimmed.length !== line.length)
          out.push({ range: range(i, trimmed.length, line.length), newText: "" });
      });
      return out;
    });
  }

  getRootParameters(path: string, root: string): RootParameter[] {
    return this.record("getRootParameters", [path, root], () => {
      const s = this.structs(path).find(x => x.name === root);
      if (!s) throw new Error(`No struct ${root}`);
      // `struct Name(u8 $key[4], u32 n)`: u8 arrays are bytes, other uN/iN integers
      const decl = lines(this.text(path))[s.line] ?? "";
      const params = /struct\s+\w+\s*\(([^)]*)\)/.exec(decl)?.[1] ?? "";
      const out: RootParameter[] = [];
      for (const part of params.split(",")) {
        const m = /^\s*([ui])(\d+)\s+(\$?)(\w+)(?:\[(\d+)\])?/.exec(part);
        if (!m) continue;
        const [, sign, bits, dollar, name, len] = m;
        out.push(
          len !== undefined && bits === "8"
            ? {
                name: name!,
                label: dollar + name!,
                type: `u8[${len}]`,
                kind: "bytes",
                length: Number(len),
                optional: false
              }
            : {
                name: name!,
                label: dollar + name!,
                type: sign! + bits!,
                kind: "int",
                bits: Number(bits),
                signed: sign === "i",
                optional: false
              }
        );
      }
      return out;
    });
  }

  async decodeSample(
    path: string,
    root: string,
    bytes: Uint8Array,
    args?: Record<string, unknown>
  ): Promise<SampleAnnotation[]> {
    return this.record("decodeSample", [path, root, bytes, args], () => {
      const s = this.structs(path).find(x => x.name === root);
      if (!s) throw new Error(`No struct ${root}`);
      return s.fields.map((f, index) => ({
        path,
        range: range(f.line, f.start, f.start + f.name.length),
        // arguments are echoed after the first value, so tests can see them arrive
        value:
          String(bytes[index] ?? 0) +
          (index === 0 && args && Object.keys(args).length ? ` ${JSON.stringify(args)}` : ""),
        offset: index,
        size: 1
      }));
    });
  }

  async suggestLayout(
    path: string,
    root: string,
    bytes: Uint8Array
  ): Promise<WorkspaceEdit | undefined> {
    return this.record("suggestLayout", [path, root, bytes], () => {
      const s = this.structs(path).find(x => x.name === root);
      if (!s) return undefined;
      return {
        changes: {
          [path]: [{ range: range(s.end, 0, 0), newText: `  layout { ${bytes.length} }\n` }]
        }
      };
    });
  }
}

/** A factory that records the services it creates. */
export function fakeFactory(platform: Platform = "posix"): {
  factory: (host: ProjectHost) => LanguageService;
  instances: FakeService[];
  configure: (fn: (service: FakeService) => void) => void;
} {
  const instances: FakeService[] = [];
  const configurers: ((service: FakeService) => void)[] = [];
  return {
    instances,
    factory: host => {
      const service = new FakeService(host, platform);
      for (const c of configurers) c(service);
      instances.push(service);
      return service;
    },
    configure: fn => {
      configurers.push(fn);
      for (const s of instances) fn(s);
    }
  };
}
