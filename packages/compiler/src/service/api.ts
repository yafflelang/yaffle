/**
 * The yaffle language service: the contract between the compiler (which implements it) and the
 * language server (packages/lsp, a thin protocol adapter over it). Modelled on TypeScript's
 * LanguageService. All positions are 0-based line/character in UTF-16 code units, the same as
 * LSP. Files are identified by **absolute filesystem paths** (the LSP converts URIs).
 */

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  path: string;
  range: Range;
}

export type Severity = "error" | "warning" | "info" | "hint";

export interface Diagnostic {
  path: string;
  range: Range;
  severity: Severity;
  /** Stable kebab-case code, e.g. "unknown-name", "forward-reference", "size-outside-codec". */
  code: string;
  message: string;
  related?: { location: Location; message: string }[];
  tags?: ("unnecessary" | "deprecated")[];
  /** Quick fixes for this diagnostic (also returned by getCodeActions). */
  fixes?: CodeAction[];
}

export interface TextEdit {
  range: Range;
  newText: string;
}

/** Edits per file path. */
export interface WorkspaceEdit {
  changes: Record<string, TextEdit[]>;
}

export interface CodeAction {
  title: string;
  kind: "quickfix" | "refactor" | "source";
  edit: WorkspaceEdit;
  /** Codes of the diagnostics this action fixes. */
  diagnosticCodes?: string[];
  isPreferred?: boolean;
}

export type CompletionKind =
  | "keyword"
  | "struct"
  | "enum"
  | "enumMember"
  | "type"
  | "primitive"
  | "field"
  | "parameter"
  | "bound"
  | "builtin"
  | "function"
  | "codec"
  | "const"
  | "attribute"
  | "module"
  | "snippet";

export interface CompletionItem {
  label: string;
  kind: CompletionKind;
  /** Short type/signature shown next to the label. */
  detail?: string;
  /** Markdown. */
  documentation?: string;
  insertText?: string;
  insertTextFormat?: "plain" | "snippet";
  sortText?: string;
  /** Replace this range instead of the word at the cursor. */
  range?: Range;
}

export interface Hover {
  /** Markdown, with ```yaffle code blocks for signatures. */
  contents: string;
  range?: Range;
}

export interface SignatureHelp {
  signatures: {
    label: string;
    documentation?: string;
    parameters: { label: string; documentation?: string }[];
  }[];
  activeSignature: number;
  activeParameter: number;
}

export type SymbolKind =
  "struct" | "field" | "enum" | "enumMember" | "type" | "extern" | "const" | "union" | "module";

export interface DocumentSymbol {
  name: string;
  kind: SymbolKind;
  detail?: string;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface WorkspaceSymbol {
  name: string;
  kind: SymbolKind;
  location: Location;
  containerName?: string;
}

export interface InlayHint {
  position: Position;
  label: string;
  kind?: "type" | "parameter";
  /** Markdown. */
  tooltip?: string;
  paddingLeft?: boolean;
  paddingRight?: boolean;
}

export interface CodeLens {
  range: Range;
  title: string;
  /**
   * Optional command the editor runs when clicked. `yaffle.showBindingSources` (the
   * `needs: $version (u32)` lens) has arguments
   * `[{ path: string; binding: string; sources: Location[] }]`: the struct's file, the bound name
   * without `$`, and the fields/parameters that bind it.
   */
  command?: { id: string; arguments?: unknown[] };
}

export type SemanticTokenType =
  | "namespace"
  | "struct"
  | "enum"
  | "enumMember"
  | "type"
  | "typeParameter"
  | "parameter"
  | "property"
  | "variable"
  | "function"
  | "keyword"
  | "decorator"
  | "number"
  | "string"
  | "regexp"
  | "comment"
  | "operator";

export type SemanticTokenModifier = "declaration" | "readonly" | "defaultLibrary" | "deprecated";

export interface SemanticToken {
  line: number;
  character: number;
  length: number;
  type: SemanticTokenType;
  modifiers: SemanticTokenModifier[];
}

export interface FoldingRange {
  startLine: number;
  endLine: number;
  kind?: "comment" | "imports" | "region";
}

/** Decoded value annotations for a sample file (shown as inlay hints or in a side panel). */
export interface SampleAnnotation {
  path: string;
  range: Range;
  /** Short rendering of the decoded value, e.g. `17`, `"ARCV"`, `[598 items]`. */
  value: string;
  /** Absolute offset and size in the sample file. */
  offset: number;
  size: number;
}

/**
 * A root struct's parameter (explicit or `$` bound), so a client can ask for the arguments of
 * `decodeSample`/`suggestLayout`.
 */
export interface RootParameter {
  /** Key in the canonical-JSON arguments: the name, without `$` for bound parameters. */
  name: string;
  /** As declared: `$key` for bound parameters. */
  label: string;
  /** Declared type, e.g. `u8[32]`, `u64`, `Kind`. */
  type: string;
  /** How to enter it: `bytes` (hex), `int`, `float`, `bool`, `string`, `enum` (a member name). */
  kind: "int" | "float" | "bool" | "string" | "bytes" | "enum" | "other";
  /** Integers: width and signedness (64-bit values are decimal strings in JSON). */
  bits?: number;
  signed?: boolean;
  /** Bytes: the fixed length, when constant. */
  length?: number;
  /** Enums: the member names. */
  members?: string[];
  /** True when the parameter has a default (so the argument may be left out). */
  optional: boolean;
  /** The default, as written. */
  defaultText?: string;
}

/** Parsed yaffle.json. */
export interface ProjectConfig {
  sources: string[];
  targets: Record<
    string,
    { out: string; externs?: Record<string, string>; [option: string]: unknown }
  >;
}

export interface ProjectHost {
  /** Files the editor hasn't opened (imports, yaffle.json) are read through the host. */
  readFile(path: string): string | undefined;
  fileExists(path: string): boolean;
  /**
   * Entries of a directory: names, with a trailing `/` for directories; undefined if it doesn't
   * exist. Used to expand the project's `sources` globs. Without it the service falls back to
   * `node:fs`.
   */
  readDirectory?(path: string): string[] | undefined;
}

/** LSP formatting options. */
export interface FormatOptions {
  tabSize: number;
  insertSpaces: boolean;
}

export interface LanguageService {
  /** Open or change a file's in-memory contents. These override the host. */
  updateFile(path: string, text: string): void;
  /** Close a file: fall back to the host's contents. */
  closeFile(path: string): void;
  /** Set or clear the project (yaffle.json) and the directory it lives in. */
  setProject(config: ProjectConfig | undefined, rootDir: string | undefined): void;

  getDiagnostics(path: string): Diagnostic[];
  getHover(path: string, position: Position): Hover | undefined;
  getCompletions(path: string, position: Position): CompletionItem[];
  getSignatureHelp(path: string, position: Position): SignatureHelp | undefined;
  getDefinition(path: string, position: Position): Location[];
  getReferences(path: string, position: Position, includeDeclaration: boolean): Location[];
  prepareRename(
    path: string,
    position: Position
  ): { range: Range; placeholder: string } | undefined;
  rename(path: string, position: Position, newName: string): WorkspaceEdit | undefined;
  getDocumentSymbols(path: string): DocumentSymbol[];
  getWorkspaceSymbols(query: string): WorkspaceSymbol[];
  getInlayHints(path: string, range: Range): InlayHint[];
  getCodeLenses(path: string): CodeLens[];
  getCodeActions(path: string, range: Range, diagnostics: Diagnostic[]): CodeAction[];
  getSemanticTokens(path: string): SemanticToken[];
  getFoldingRanges(path: string): FoldingRange[];
  /**
   * Whole-document formatting (canonical style; indentation from `options`, default 2 spaces).
   * Returns no edits for files with syntax errors.
   */
  format(path: string, options?: FormatOptions): TextEdit[];
  /**
   * Decode a sample file with the given root struct (declared in or imported into `path`) and
   * annotate the fields of struct instances declared in `path` with their values. The decode is
   * lazy: only what leads to such instances is read, with caps on array elements and on the
   * number of annotations. Fields whose bytes come out of a codec are annotated with the encoded
   * region's offset and size. Rejects with a user-facing message when it can't (unknown root,
   * errors in the file, a root that needs parameters it can't get).
   */
  decodeSample(
    path: string,
    root: string,
    bytes: Uint8Array,
    args?: Record<string, unknown>
  ): Promise<SampleAnnotation[]>;
  /**
   * The parameters a root needs (explicit and `$` bound, in declaration order), so a client can
   * ask for `args`: canonical JSON keyed by name (bound parameters without `$`; integers as
   * numbers, 64-bit ones as decimal strings; bytes as lowercase hex). Throws like `decodeSample`.
   */
  getRootParameters(path: string, root: string): RootParameter[];
  /**
   * Suggest `layout { … }` rules that reproduce a sample file's target order and alignment
   * (IR.md §4): inserts, replaces or removes `layout` blocks. Resolves to undefined when
   * the sample already follows the schema's layout. Rejects with a user-facing message when it
   * can't.
   */
  suggestLayout(
    path: string,
    root: string,
    bytes: Uint8Array,
    args?: Record<string, unknown>
  ): Promise<WorkspaceEdit | undefined>;
  /** Files changed on disk (created, changed or deleted) that aren't open: drop cached reads. */
  filesChanged(paths: string[]): void;
  /**
   * Every source file of the project: the `sources` globs (when a project is set), open files, and
   * everything they import. The server publishes diagnostics for these.
   */
  getProjectFiles(): string[];
  /** Release caches; the service isn't used afterwards. */
  dispose(): void;
}
