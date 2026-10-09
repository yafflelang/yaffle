/**
 * The yaffle-specific parts of the protocol: custom requests, settings and initialization options.
 * Shared by the server and editor clients (the VS Code extension imports this file), so it has no
 * runtime dependencies.
 */

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface TextDocumentRef {
  uri: string;
}

// ---------------------------------------------------------------------------------------------
// yaffle/showIr

/** `yaffle/showIr`: compile a file (with unsaved editor contents) and return its IR as JSON. */
export const ShowIrMethod = "yaffle/showIr";

export interface ShowIrParams {
  textDocument: TextDocumentRef;
}

export interface IrDiagnostic {
  uri: string;
  range: LspRange;
  severity: "error" | "warning" | "info" | "hint";
  code: string;
  message: string;
}

export interface ShowIrResult {
  /** The IrProgram (plain JSON), or null when compilation produced errors or failed. */
  program: unknown;
  diagnostics: IrDiagnostic[];
  /** Set when the compiler itself failed (threw); the message is meant for the user. */
  error?: string;
}

// ---------------------------------------------------------------------------------------------
// yaffle/decodeSample, yaffle/suggestLayout

/** Where the sample bytes come from: a file the server reads, or the bytes inline (base64). */
export type SampleSource = { uri: string } | { base64: string };

export interface SampleParams {
  /** The .yfl file that declares (or imports) the root struct. */
  textDocument: TextDocumentRef;
  /** The root struct's name. */
  root: string;
  sample: SampleSource;
  /**
   * Root arguments as canonical JSON (docs/CONFORMANCE.md): explicit parameters by name, bound
   * ones without `$`; 64-bit integers as decimal strings, bytes as lowercase hex.
   */
  args?: Record<string, unknown>;
}

/** `yaffle/rootParameters`: the parameters a root struct needs (to ask for `args`). */
export const RootParametersMethod = "yaffle/rootParameters";

export interface RootParametersParams {
  textDocument: TextDocumentRef;
  root: string;
}

export interface RootParameterDto {
  /** Key in `args`. */
  name: string;
  /** As declared (`$key` for bound parameters). */
  label: string;
  /** Declared type, e.g. `u8[32]`. */
  type: string;
  kind: "int" | "float" | "bool" | "string" | "bytes" | "enum" | "other";
  bits?: number;
  signed?: boolean;
  /** Bytes: the fixed length, when constant. */
  length?: number;
  members?: string[];
  optional: boolean;
  defaultText?: string;
}

export interface RootParametersResult {
  parameters: RootParameterDto[];
  /** Set when the root can't be used (unknown, errors in the file); meant for the user. */
  error?: string;
}

/** `yaffle/decodeSample`: decode a sample file and annotate fields with decoded values. */
export const DecodeSampleMethod = "yaffle/decodeSample";

export type DecodeSampleParams = SampleParams;

export interface SampleAnnotationDto {
  uri: string;
  range: LspRange;
  /** Short rendering of the decoded value, e.g. `17`, `"ARCV"`, `[598 items]`. */
  value: string;
  /** Absolute offset and size in the sample file. */
  offset: number;
  size: number;
}

export interface DecodeSampleResult {
  annotations: SampleAnnotationDto[];
  /** Set when decoding failed; the message is meant for the user. */
  error?: string;
}

/** `yaffle/suggestLayout`: suggest `layout { … }` rules reproducing a sample's target order. */
export const SuggestLayoutMethod = "yaffle/suggestLayout";

export type SuggestLayoutParams = SampleParams;

export interface SuggestLayoutResult {
  /** Edits in LSP `WorkspaceEdit` form (`changes` keyed by URI), or null when nothing to change. */
  edit: { changes: Record<string, LspTextEdit[]> } | null;
  error?: string;
}

// ---------------------------------------------------------------------------------------------
// Commands

/**
 * Client-side command of the `needs: $name` code lens: show where the bound value comes from.
 * The server converts every service `{ path, range }` location in command arguments to an LSP
 * `{ uri, range }` location; the client peeks the locations it finds anywhere in the arguments.
 */
export const ShowBindingSourcesCommand = "yaffle.showBindingSources";

// ---------------------------------------------------------------------------------------------
// Settings

/** The `yaffle` settings section (VS Code: `yaffle.*`). */
export interface YaffleSettings {
  diagnostics: {
    /** Debounce delay in ms between the last edit and recomputing diagnostics. */
    delay: number;
    /**
     * `project`: also check the project's files that aren't open (when the service can list
     * them); `openFiles`: only open files.
     */
    scope: "project" | "openFiles";
  };
  inlayHints: { enabled: boolean };
  codeLens: { enabled: boolean };
  format: { enabled: boolean };
  /** Align a line starting with `@` with the attributes of the field above when typing `@`. */
  alignAttributesOnType: { enabled: boolean };
}

export const DEFAULT_SETTINGS: YaffleSettings = {
  diagnostics: { delay: 250, scope: "project" },
  inlayHints: { enabled: true },
  codeLens: { enabled: true },
  format: { enabled: true },
  alignAttributesOnType: { enabled: true }
};

/** `initializationOptions` the server understands. */
export interface InitializationOptions {
  /** Initial settings, for clients that don't support `workspace/configuration`. */
  settings?: unknown;
}
