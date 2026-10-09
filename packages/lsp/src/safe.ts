/**
 * Fault isolation between the server and the language service. Every service call goes through
 * {@link SafeService}: an exception is logged (throttled) and turned into an empty result, and
 * results of the wrong shape are coerced, so a buggy service can never take the server down.
 */
import type {
  CodeAction,
  CodeLens,
  CompletionItem,
  Diagnostic,
  DocumentSymbol,
  FoldingRange,
  FormatOptions,
  Hover,
  InlayHint,
  LanguageService,
  Location,
  Position,
  ProjectConfig,
  Range,
  SemanticToken,
  SignatureHelp,
  TextEdit,
  WorkspaceEdit,
  WorkspaceSymbol
} from "yaffle/service";
import { errorMessage } from "./util.ts";

export interface Logger {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  log(message: string): void;
}

export const silentLogger: Logger = {
  error() {},
  warn() {},
  info() {},
  log() {}
};

/** Wraps a logger so that logging never throws (the client connection may already be closed). */
export function quietLogger(target: Logger): Logger {
  const quiet = (level: keyof Logger) => (message: string) => {
    try {
      target[level](message);
    } catch {
      // nobody left to tell
    }
  };
  return { error: quiet("error"), warn: quiet("warn"), info: quiet("info"), log: quiet("log") };
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Logs failures without flooding the log: the first few occurrences of an error (by context and
 * message) are logged with their stack, then only every 100th with a count.
 */
export class ErrorReporter {
  private readonly logger: Logger;
  private readonly counts = new Map<string, number>();
  /** Total failures reported. */
  total = 0;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  report(context: string, error: unknown): void {
    this.total++;
    const signature = `${context}\u0000${errorMessage(error)}`;
    const count = (this.counts.get(signature) ?? 0) + 1;
    this.counts.set(signature, count);
    if (count <= 3) {
      this.logger.error(`yaffle: ${context} failed: ${errorDetail(error)}`);
    } else if (count % 100 === 0) {
      this.logger.error(`yaffle: ${context} failed ${count} times: ${errorMessage(error)}`);
    }
  }
}

export type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * A language service wrapper that never throws. `inner` undefined means the service failed to
 * start. Methods a service module given with `--service` may lack (`filesChanged`, `dispose`,
 * `getProjectFiles`, `getRootParameters`) are checked before they are called.
 */
export class SafeService {
  private readonly inner: LanguageService | undefined;
  private readonly reporter: ErrorReporter;
  private readonly label: string;

  constructor(inner: LanguageService | undefined, reporter: ErrorReporter, label: string) {
    this.inner = inner;
    this.reporter = reporter;
    this.label = label;
  }

  /**
   * Run `fn` against the inner service, capturing any exception. It is reported as a service
   * failure unless `report` is false (methods whose errors are messages for the user).
   */
  attempt<T>(method: string, fn: (service: LanguageService) => T, report = true): Attempt<T> {
    if (!this.inner) return { ok: false, error: new Error("the language service is not running") };
    try {
      return { ok: true, value: fn(this.inner) };
    } catch (error) {
      if (report) this.reporter.report(`${method} (${this.label})`, error);
      return { ok: false, error };
    }
  }

  /** Like `attempt` for methods that return a promise: a rejection counts as an exception. */
  async attemptAsync<T>(
    method: string,
    fn: (service: LanguageService) => T | Promise<T>,
    report = true
  ): Promise<Attempt<T>> {
    const first = this.attempt(method, fn, report);
    if (!first.ok) return first;
    try {
      return { ok: true, value: await first.value };
    } catch (error) {
      if (report) this.reporter.report(`${method} (${this.label})`, error);
      return { ok: false, error };
    }
  }

  private list<T>(method: string, fn: (service: LanguageService) => unknown): T[] {
    const result = this.attempt(method, fn);
    return result.ok && Array.isArray(result.value) ? (result.value as T[]) : [];
  }

  private object<T>(method: string, fn: (service: LanguageService) => unknown): T | undefined {
    const result = this.attempt(method, fn);
    const value = result.ok ? result.value : undefined;
    return value !== null && typeof value === "object" ? (value as T) : undefined;
  }

  updateFile(path: string, text: string): void {
    this.attempt("updateFile", s => s.updateFile(path, text));
  }
  closeFile(path: string): void {
    this.attempt("closeFile", s => s.closeFile(path));
  }
  setProject(config: ProjectConfig | undefined, rootDir: string | undefined): void {
    this.attempt("setProject", s => s.setProject(config, rootDir));
  }
  /** Files changed on disk; a service without `filesChanged` gets `closeFile` for each. */
  filesChanged(paths: string[]): void {
    if (paths.length === 0) return;
    this.attempt("filesChanged", s => {
      if (typeof s.filesChanged === "function") s.filesChanged(paths);
      else for (const path of paths) s.closeFile(path);
    });
  }
  dispose(): void {
    this.attempt("dispose", s => {
      if (typeof s.dispose === "function") s.dispose();
    });
  }

  getDiagnostics(path: string): Diagnostic[] {
    return this.list("getDiagnostics", s => s.getDiagnostics(path));
  }
  getHover(path: string, position: Position): Hover | undefined {
    return this.object("getHover", s => s.getHover(path, position));
  }
  getCompletions(path: string, position: Position): CompletionItem[] {
    return this.list("getCompletions", s => s.getCompletions(path, position));
  }
  getSignatureHelp(path: string, position: Position): SignatureHelp | undefined {
    return this.object("getSignatureHelp", s => s.getSignatureHelp(path, position));
  }
  getDefinition(path: string, position: Position): Location[] {
    return this.list("getDefinition", s => s.getDefinition(path, position));
  }
  getReferences(path: string, position: Position, includeDeclaration: boolean): Location[] {
    return this.list("getReferences", s => s.getReferences(path, position, includeDeclaration));
  }
  prepareRename(
    path: string,
    position: Position
  ): { range: Range; placeholder: string } | undefined {
    return this.object("prepareRename", s => s.prepareRename(path, position));
  }
  rename(path: string, position: Position, newName: string): WorkspaceEdit | undefined {
    return this.object("rename", s => s.rename(path, position, newName));
  }
  getDocumentSymbols(path: string): DocumentSymbol[] {
    return this.list("getDocumentSymbols", s => s.getDocumentSymbols(path));
  }
  getWorkspaceSymbols(query: string): WorkspaceSymbol[] {
    return this.list("getWorkspaceSymbols", s => s.getWorkspaceSymbols(query));
  }
  getInlayHints(path: string, range: Range): InlayHint[] {
    return this.list("getInlayHints", s => s.getInlayHints(path, range));
  }
  getCodeLenses(path: string): CodeLens[] {
    return this.list("getCodeLenses", s => s.getCodeLenses(path));
  }
  getCodeActions(path: string, range: Range, diagnostics: Diagnostic[]): CodeAction[] {
    return this.list("getCodeActions", s => s.getCodeActions(path, range, diagnostics));
  }
  getSemanticTokens(path: string): SemanticToken[] {
    return this.list("getSemanticTokens", s => s.getSemanticTokens(path));
  }
  getFoldingRanges(path: string): FoldingRange[] {
    return this.list("getFoldingRanges", s => s.getFoldingRanges(path));
  }
  format(path: string, options: FormatOptions): TextEdit[] {
    return this.list("format", s => s.format(path, options));
  }
  /** The project's source files; empty when the service can't list them. */
  getProjectFiles(): string[] {
    return this.list<unknown>("getProjectFiles", s =>
      typeof s.getProjectFiles === "function" ? s.getProjectFiles() : []
    ).filter((p): p is string => typeof p === "string" && p !== "");
  }
}
