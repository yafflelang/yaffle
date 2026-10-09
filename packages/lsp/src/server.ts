/**
 * The yaffle language server: a thin, defensive adapter from LSP to the yaffle LanguageService
 * (packages/compiler/src/service/api.ts). It owns protocol concerns only:
 *
 * - document sync (incremental) and URI ↔ path conversion;
 * - projects (one service per yaffle.json), config discovery and file watching;
 * - debounced, merged push diagnostics for every affected file;
 * - request mapping with cancellation, stale-request detection and fault isolation.
 *
 * Language knowledge lives in the service, which is injected (`createService`), as are the
 * compiler entry points used by custom requests.
 */
import {
  CodeActionKind,
  CodeLensRefreshRequest,
  type CancellationToken,
  type ClientCapabilities,
  type Connection,
  DidChangeConfigurationNotification,
  DidChangeWatchedFilesNotification,
  type DidChangeWatchedFilesParams,
  DocumentHighlightKind,
  ErrorCodes,
  FileChangeType,
  type FileSystemWatcher,
  type InitializeParams,
  type InitializeResult,
  LSPErrorCodes,
  MessageType,
  ResponseError,
  ShowMessageNotification,
  TextDocuments,
  TextDocumentSyncKind,
  WatchKind,
  type WorkspaceFoldersChangeEvent
} from "vscode-languageserver";
import type * as lsp from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { alignAttributeLine, reindentAfterContinuation } from "./attributeAlign.ts";
import { fallbackLoadProjectConfig, type LoadProjectConfig, resolveSettings } from "./config.ts";
import {
  type ConvertContext,
  diagnosticKey,
  flattenDocumentSymbols,
  fromLspDiagnostic,
  kindMatches,
  toLspCodeAction,
  toLspCodeLens,
  toLspCompletion,
  toLspDiagnostic,
  toLspDocumentSymbol,
  toLspFoldingRange,
  toLspHover,
  toLspInlayHint,
  toLspLocation,
  toLspRange,
  toLspSignatureHelp,
  toLspTextEdit,
  toLspWorkspaceEdit,
  toLspWorkspaceSymbol
} from "./convert.ts";
import {
  type CompileFunction,
  registerCustomRequests,
  type Reply,
  type RequestTarget
} from "./custom.ts";
import { DiagnosticsStore, type StoredDiagnostic, uniqueDiagnostics } from "./diagnostics.ts";
import { type FileSystem, nodeFileSystem, withOverlay } from "./fs.ts";
import { CONFIG_FILE_NAME, type Project, ProjectManager, type ServiceFactory } from "./projects.ts";
import { DEFAULT_SETTINGS, type YaffleSettings } from "./protocol.ts";
import { ErrorReporter, type Logger, quietLogger } from "./safe.ts";
import { prepareTokens, SEMANTIC_TOKENS_LEGEND, SemanticTokensCache } from "./semanticTokens.ts";
import {
  currentPlatform,
  isPathInside,
  normalizePath,
  pathApi,
  type Platform,
  UriMapper
} from "./uri.ts";
import { errorMessage, isRecord, uniqueBy } from "./util.ts";

export const SERVER_NAME = "yaffle-lsp";
export const SERVER_VERSION = "0.1.0";

export type { CompileFunction };

export interface ServerOptions {
  /** Creates a language service for a project: once per yaffle.json, and once for loose files. */
  createService: ServiceFactory;
  /** The compiler's `compile`, for `yaffle/showIr`. */
  compile?: CompileFunction;
  /** The compiler's `loadProjectConfig`. Defaults to a minimal built-in JSONC loader. */
  loadProjectConfig?: LoadProjectConfig;
  /** Filesystem for files the editor hasn't opened. Defaults to the real one. */
  fileSystem?: FileSystem;
  /** Path flavour. Defaults to the current OS. */
  platform?: Platform;
  /** Defaults to the connection's console (window/logMessage). */
  logger?: Logger;
  /** Settings to start from (a partial `yaffle` section), before the client sends any. */
  settings?: unknown;
}

interface Target extends RequestTarget {
  document: TextDocument | undefined;
}

interface FileChange {
  path: string;
  type: FileChangeType;
}

type RefreshableFeature = "inlayHint" | "codeLens" | "semanticTokens";

const REFRESH_REQUESTS: Record<RefreshableFeature, (c: Connection) => Promise<void>> = {
  inlayHint: c => c.languages.inlayHint.refresh(),
  codeLens: c => c.sendRequest(CodeLensRefreshRequest.type),
  semanticTokens: c => c.languages.semanticTokens.refresh()
};

const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

/**
 * Yield long enough for messages that already arrived to be dispatched: the JSON-RPC layer hands
 * each incoming message over in its own setImmediate, which a single immediate queued earlier
 * would beat.
 */
const yieldForMessages = async () => {
  await yieldToEventLoop();
  await yieldToEventLoop();
};

export class YaffleServer {
  readonly reporter: ErrorReporter;
  readonly projects: ProjectManager;
  private readonly connection: Connection;
  private readonly platform: Platform;
  private readonly uris: UriMapper;
  private readonly documents = new TextDocuments(TextDocument);
  private readonly compile: CompileFunction | undefined;
  private readonly fs: FileSystem;
  private readonly logger: Logger;
  private readonly store: DiagnosticsStore;
  private readonly tokens = new SemanticTokensCache();
  private readonly docProject = new Map<string, Project>();
  /** Keys of projects kept alive without open files (configs at workspace folder roots). */
  private readonly pinned = new Set<string>();
  private readonly running = new Set<Promise<void>>();
  private readonly watchedDirs = new Set<string>();
  private settings: YaffleSettings;
  private capabilities: ClientCapabilities = {};
  private workspaceFolders: string[] = [];
  private initialized = false;
  private shutdown = false;
  private serviceFailureShown = false;

  constructor(connection: Connection, options: ServerOptions) {
    this.connection = connection;
    this.compile = options.compile;
    this.platform = options.platform ?? currentPlatform();
    this.uris = new UriMapper(this.platform);
    this.fs = options.fileSystem ?? nodeFileSystem;
    this.logger = options.logger ?? quietLogger(connection.console);
    this.reporter = new ErrorReporter(this.logger);
    this.settings = resolveSettings(options.settings ?? {}, DEFAULT_SETTINGS);
    this.store = new DiagnosticsStore((uri, diagnostics) => {
      const params: lsp.PublishDiagnosticsParams = { uri, diagnostics };
      const version = this.documents.get(uri)?.version;
      if (version !== undefined) params.version = version;
      this.send(() => this.connection.sendDiagnostics(params), "publishDiagnostics");
    });
    this.projects = new ProjectManager({
      fs: this.fs,
      platform: this.platform,
      logger: this.logger,
      reporter: this.reporter,
      createService: options.createService,
      loadProjectConfig: options.loadProjectConfig ?? fallbackLoadProjectConfig,
      openText: path => this.openText(path),
      onServiceFailure: (project, error) => this.onServiceFailure(project, error),
      onProjectCreated: project => this.publishConfigDiagnostics(project)
    });
  }

  /** Current settings (after client configuration). */
  get currentSettings(): YaffleSettings {
    return this.settings;
  }

  // -------------------------------------------------------------------------------------------
  // Wiring

  /** Register every handler on the connection. The caller then calls `connection.listen()`. */
  listen(): void {
    const c = this.connection;
    c.onInitialize(params => this.onInitialize(params));
    c.onInitialized(() => {
      this.onInitialized().catch(error => this.reporter.report("initialized", error));
    });
    c.onShutdown(() => this.dispose());

    this.documents.onDidChangeContent(e =>
      this.guard("didChange", () => this.onDocumentChanged(e.document))
    );
    this.documents.onDidClose(e => this.guard("didClose", () => this.onDocumentClosed(e.document)));
    this.documents.listen(c);

    c.onDidChangeWatchedFiles(params =>
      this.guard("didChangeWatchedFiles", () => this.onWatchedFiles(params))
    );
    c.onDidChangeConfiguration(params => {
      this.onConfigurationChanged(params?.settings).catch(error =>
        this.reporter.report("didChangeConfiguration", error)
      );
    });

    c.onHover((p, token) =>
      this.run("hover", p.textDocument, token, null, t => {
        const hover = t.service.getHover(t.path, p.position);
        return hover ? toLspHover(hover, this.ctx()) : null;
      })
    );
    c.onCompletion((p, token) =>
      this.run("completion", p.textDocument, token, null, t => {
        const ctx = this.ctx();
        const items = t.service.getCompletions(t.path, p.position);
        return { isIncomplete: false, items: items.map(i => toLspCompletion(i, ctx)) };
      })
    );
    c.onSignatureHelp((p, token) =>
      this.run("signatureHelp", p.textDocument, token, null, t => {
        const help = t.service.getSignatureHelp(t.path, p.position);
        return help ? toLspSignatureHelp(help, this.ctx()) : null;
      })
    );
    c.onDefinition((p, token) =>
      this.run("definition", p.textDocument, token, [], t => {
        const ctx = this.ctx();
        return t.service.getDefinition(t.path, p.position).map(l => toLspLocation(l, ctx));
      })
    );
    c.onReferences((p, token) =>
      this.run("references", p.textDocument, token, [], t => {
        const ctx = this.ctx();
        const includeDeclaration = p.context?.includeDeclaration ?? true;
        return t.service
          .getReferences(t.path, p.position, includeDeclaration)
          .map(l => toLspLocation(l, ctx));
      })
    );
    c.onDocumentHighlight((p, token) =>
      this.run("documentHighlight", p.textDocument, token, [], t => this.highlights(t, p.position))
    );
    c.onPrepareRename((p, token) =>
      this.run("prepareRename", p.textDocument, token, null, t => {
        const result = t.service.prepareRename(t.path, p.position);
        if (!result || !result.range) return null;
        return { range: toLspRange(result.range), placeholder: String(result.placeholder ?? "") };
      })
    );
    c.onRenameRequest((p, token) =>
      this.run("rename", p.textDocument, token, null, t => {
        const edit = t.service.rename(t.path, p.position, p.newName);
        if (!edit) {
          return new ResponseError(ErrorCodes.InvalidRequest, "This element can't be renamed.");
        }
        return toLspWorkspaceEdit(edit, this.ctx());
      })
    );
    c.onDocumentSymbol((p, token) =>
      this.run("documentSymbol", p.textDocument, token, [], t => {
        const symbols = t.service.getDocumentSymbols(t.path).map(toLspDocumentSymbol);
        return this.capabilities.textDocument?.documentSymbol?.hierarchicalDocumentSymbolSupport
          ? symbols
          : flattenDocumentSymbols(symbols, t.uri);
      })
    );
    c.onWorkspaceSymbol((p, token) =>
      this.execute("workspaceSymbol", token, [], () => this.workspaceSymbols(p.query))
    );
    c.languages.inlayHint.on((p, token) =>
      this.run("inlayHint", p.textDocument, token, [], t => {
        if (!this.settings.inlayHints.enabled) return [];
        const ctx = this.ctx();
        const hints = t.service.getInlayHints(t.path, toLspRange(p.range));
        return hints.map(h => toLspInlayHint(h, ctx));
      })
    );
    c.onCodeLens((p, token) =>
      this.run("codeLens", p.textDocument, token, [], t => {
        if (!this.settings.codeLens.enabled) return [];
        const ctx = this.ctx();
        return t.service.getCodeLenses(t.path).map(l => toLspCodeLens(l, ctx));
      })
    );
    c.onCodeAction((p, token) =>
      this.run("codeAction", p.textDocument, token, [], t => this.codeActions(t, p))
    );
    c.languages.semanticTokens.on((p, token) =>
      this.run("semanticTokens", p.textDocument, token, { data: [] }, t =>
        this.tokens.full(t.uri, this.preparedTokens(t))
      )
    );
    c.languages.semanticTokens.onDelta((p, token) =>
      this.run("semanticTokensDelta", p.textDocument, token, { data: [] }, t =>
        this.tokens.delta(t.uri, p.previousResultId, this.preparedTokens(t))
      )
    );
    c.languages.semanticTokens.onRange((p, token) =>
      this.run("semanticTokensRange", p.textDocument, token, { data: [] }, t =>
        this.tokens.range(this.preparedTokens(t), p.range)
      )
    );
    c.onFoldingRanges((p, token) =>
      this.run("foldingRange", p.textDocument, token, [], t =>
        t.service.getFoldingRanges(t.path).flatMap(r => toLspFoldingRange(r) ?? [])
      )
    );
    c.onDocumentFormatting((p, token) =>
      this.run("formatting", p.textDocument, token, null, t => {
        if (!this.settings.format.enabled) return null;
        const { tabSize, insertSpaces } = p.options ?? { tabSize: 2, insertSpaces: true };
        return t.service.format(t.path, { tabSize, insertSpaces }).map(toLspTextEdit);
      })
    );
    c.onDocumentOnTypeFormatting(p =>
      this.run("onTypeFormatting", p.textDocument, undefined, null, t =>
        this.onTypeFormatting(t, p)
      )
    );

    registerCustomRequests(c, {
      // Custom requests have no positions, so edits don't make them stale.
      run: (method, uri, token, fallback, fn) =>
        this.execute(method, token, fallback, () => fn(this.target(uri))),
      uris: this.uris,
      fs: this.fs,
      files: withOverlay(this.fs, path => this.openText(path)),
      compile: this.compile,
      reporter: this.reporter,
      logger: this.logger,
      convertContext: () => this.ctx()
    });
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle

  private onInitialize(params: InitializeParams): InitializeResult {
    this.capabilities = params.capabilities ?? {};
    const folders =
      params.workspaceFolders?.map(f => f.uri) ?? (params.rootUri ? [params.rootUri] : []);
    if (folders.length === 0 && params.rootPath) {
      this.workspaceFolders = [normalizePath(params.rootPath, this.platform)];
    } else {
      this.workspaceFolders = folders.map(uri => this.uris.toPath(uri));
    }
    const init = params.initializationOptions;
    if (isRecord(init) && init.settings !== undefined) {
      this.settings = resolveSettings(init.settings, this.settings);
    }
    return {
      capabilities: serverCapabilities(this.capabilities),
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
    };
  }

  private async onInitialized(): Promise<void> {
    this.initialized = true;
    const ws = this.capabilities.workspace;
    if (ws?.didChangeWatchedFiles?.dynamicRegistration) {
      const watchers: FileSystemWatcher[] = [
        { globPattern: `**/${CONFIG_FILE_NAME}` },
        { globPattern: "**/*.yfl" }
      ];
      await this.connection.client
        .register(DidChangeWatchedFilesNotification.type, { watchers })
        .catch(error => this.reporter.report("register file watchers", error));
    }
    if (ws?.didChangeConfiguration?.dynamicRegistration) {
      await this.connection.client
        .register(DidChangeConfigurationNotification.type, { section: "yaffle" })
        .catch(error => this.reporter.report("register configuration", error));
    }
    if (ws?.workspaceFolders) {
      try {
        this.connection.workspace.onDidChangeWorkspaceFolders(e =>
          this.guard("didChangeWorkspaceFolders", () => this.onWorkspaceFoldersChanged(e))
        );
      } catch (error) {
        this.reporter.report("workspace folder events", error);
      }
    }
    if (ws?.configuration) await this.pullConfiguration();
    this.loadWorkspaceProjects();
  }

  private onWorkspaceFoldersChanged(e: WorkspaceFoldersChangeEvent): void {
    const removed = new Set(e.removed.map(f => this.uris.key(this.uris.toPath(f.uri))));
    this.workspaceFolders = this.workspaceFolders
      .filter(f => !removed.has(this.uris.key(f)))
      .concat(e.added.map(f => this.uris.toPath(f.uri)));
    this.loadWorkspaceProjects();
  }

  /** Create (and pin) the projects whose yaffle.json sits at a workspace folder root. */
  private loadWorkspaceProjects(): void {
    const api = pathApi(this.platform);
    const wanted = new Set<string>();
    for (const folder of this.workspaceFolders) {
      const configPath = api.join(folder, CONFIG_FILE_NAME);
      if (!this.fs.fileExists(configPath)) continue;
      const project = this.projects.ensureProject(configPath);
      wanted.add(project.key);
      if (!this.pinned.has(project.key)) {
        this.pinned.add(project.key);
        this.scheduleDiagnostics(project, 0);
      }
    }
    for (const key of [...this.pinned]) {
      if (wanted.has(key)) continue;
      this.pinned.delete(key);
      const project = this.projects.get(key);
      if (project) this.maybeDisposeProject(project);
    }
  }

  dispose(): void {
    this.shutdown = true;
    this.projects.disposeAll();
    this.docProject.clear();
  }

  /** Resolves once no diagnostics pass is scheduled or running (for tests and embedders). */
  async idle(): Promise<void> {
    for (;;) {
      await yieldToEventLoop();
      const pending = this.projects.all().some(p => p.timer !== undefined);
      if (!pending && this.running.size === 0) return;
      if (this.running.size > 0) await Promise.all([...this.running]);
      else await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  private onServiceFailure(project: Project, error: unknown): void {
    if (this.serviceFailureShown) return;
    this.serviceFailureShown = true;
    // A plain notification: nothing to wait for, and no request the client might not answer.
    this.send(
      () =>
        this.connection.sendNotification(ShowMessageNotification.type, {
          type: MessageType.Error,
          message: `yaffle: the language service failed to start for ${project.label}: ${errorMessage(error)}`
        }),
      "showMessage"
    );
  }

  // -------------------------------------------------------------------------------------------
  // Settings

  private async pullConfiguration(): Promise<void> {
    try {
      const raw: unknown = await this.connection.workspace.getConfiguration("yaffle");
      this.applySettings(resolveSettings(raw, this.settings));
    } catch (error) {
      this.reporter.report("workspace/configuration", error);
    }
  }

  private async onConfigurationChanged(settings: unknown): Promise<void> {
    if (this.capabilities.workspace?.configuration) await this.pullConfiguration();
    else this.applySettings(resolveSettings(settings, this.settings));
  }

  private applySettings(next: YaffleSettings): void {
    const previous = this.settings;
    this.settings = next;
    if (previous.inlayHints.enabled !== next.inlayHints.enabled) this.refresh("inlayHint");
    if (previous.codeLens.enabled !== next.codeLens.enabled) this.refresh("codeLens");
    if (previous.diagnostics.scope !== next.diagnostics.scope) {
      for (const project of this.projects.all()) this.scheduleDiagnostics(project, 0);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Documents

  private openText(path: string): string | undefined {
    return this.documents.get(this.uris.toUri(path))?.getText();
  }

  private isOpen(path: string): boolean {
    return this.documents.get(this.uris.toUri(path)) !== undefined;
  }

  /** The project for a path (virtual documents go to the first workspace project, if any). */
  private projectForPath(path: string): Project {
    if (this.uris.isVirtual(path)) {
      const key = [...this.pinned][0];
      const pinned = key !== undefined ? this.projects.get(key) : undefined;
      return pinned ?? this.projects.ensureProject(undefined);
    }
    return this.projects.projectFor(path);
  }

  /** Make `project` the owner of an open document. */
  private attach(uri: string, path: string, project: Project): void {
    this.docProject.set(uri, project);
    project.openFiles.set(this.uris.key(path), path);
  }

  /** Take an open document from its project, whose service falls back to the file on disk. */
  private detach(path: string, project: Project): void {
    project.openFiles.delete(this.uris.key(path));
    project.service.closeFile(path);
  }

  private onDocumentChanged(document: TextDocument): void {
    const uri = document.uri;
    const path = this.uris.remember(uri);
    let project = this.docProject.get(uri);
    const opened = project === undefined;
    if (!project) {
      project = this.projectForPath(path);
      this.attach(uri, path, project);
    }
    project.service.updateFile(path, document.getText());
    this.notifyOtherProjects(project, [path]);
    this.scheduleDiagnostics(project, opened ? 0 : undefined);
  }

  private onDocumentClosed(document: TextDocument): void {
    const uri = document.uri;
    const path = this.uris.toPath(uri);
    const project = this.docProject.get(uri);
    this.docProject.delete(uri);
    this.tokens.forget(uri);
    if (project) {
      this.detach(path, project);
      this.notifyOtherProjects(project, [path]);
      if (!this.maybeDisposeProject(project)) this.scheduleDiagnostics(project, 0);
    }
    this.uris.forget(uri);
  }

  /** Tell projects other than `owner` that read these files that their contents changed. */
  private notifyOtherProjects(owner: Project, paths: string[]): void {
    for (const project of this.projects.all()) {
      if (project === owner) continue;
      const touched = paths.filter(p => project.touches(p));
      if (touched.length === 0) continue;
      project.service.filesChanged(touched);
      this.scheduleDiagnostics(project);
    }
  }

  /** Dispose a project nobody needs any more. Returns true when disposed. */
  private maybeDisposeProject(project: Project): boolean {
    if (project.openFiles.size > 0 || this.pinned.has(project.key)) return false;
    this.projects.remove(project);
    this.store.clearSource(`project:${project.key}`);
    this.store.clearSource(`config:${project.key}`);
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Watched files

  private onWatchedFiles(params: DidChangeWatchedFilesParams): void {
    const api = pathApi(this.platform);
    const configChanges: FileChange[] = [];
    const sourceChanges: FileChange[] = [];
    for (const change of params.changes ?? []) {
      if (typeof change?.uri !== "string") continue;
      const path = this.uris.toPath(change.uri);
      const isConfig = api.basename(path).toLowerCase() === CONFIG_FILE_NAME;
      (isConfig ? configChanges : sourceChanges).push({ path, type: change.type });
    }
    if (configChanges.length > 0) this.onConfigFilesChanged(configChanges);
    if (sourceChanges.length > 0) this.onSourceFilesChanged(sourceChanges);
  }

  private onConfigFilesChanged(changes: FileChange[]): void {
    let structural = false;
    for (const change of changes) {
      if (change.type !== FileChangeType.Changed) {
        structural = true;
        continue;
      }
      const project = this.projects.get(this.uris.key(change.path));
      if (!project) continue;
      project.loadConfig();
      this.publishConfigDiagnostics(project);
      this.scheduleDiagnostics(project, undefined, true);
    }
    if (!structural) return;
    this.projects.invalidateLookups();
    this.loadWorkspaceProjects();
    this.reassignDocuments();
    for (const project of this.projects.all()) {
      if (project.configPath !== undefined && !this.fs.fileExists(project.configPath)) {
        this.pinned.delete(project.key);
        this.maybeDisposeProject(project);
      }
    }
  }

  /** Move open documents to the project they now belong to (after configs came or went). */
  private reassignDocuments(): void {
    for (const document of this.documents.all()) {
      const uri = document.uri;
      const path = this.uris.toPath(uri);
      const current = this.docProject.get(uri);
      const next = this.projectForPath(path);
      if (current === next) continue;
      if (current) this.detach(path, current);
      this.attach(uri, path, next);
      next.service.updateFile(path, document.getText());
      this.scheduleDiagnostics(next, 0, true);
      if (current && !this.maybeDisposeProject(current)) this.scheduleDiagnostics(current, 0, true);
    }
  }

  private onSourceFilesChanged(changes: FileChange[]): void {
    const relevant = changes.filter(c => !this.isOpen(c.path));
    if (relevant.length === 0) return;
    for (const project of this.projects.all()) {
      const affected = relevant
        .filter(
          c =>
            project.touches(c.path) ||
            (c.type !== FileChangeType.Changed && project.contains(c.path))
        )
        .map(c => c.path);
      if (affected.length === 0) continue;
      project.service.filesChanged(affected);
      this.scheduleDiagnostics(project, undefined, true);
    }
  }

  /**
   * Watch files a service read from outside the workspace folders (the `**` watchers only cover
   * the workspace). Needs relative-pattern support; one watcher per directory.
   */
  private watchExternalFiles(project: Project): void {
    if (!this.initialized || this.shutdown) return;
    const ws = this.capabilities.workspace?.didChangeWatchedFiles;
    if (!ws?.dynamicRegistration || !ws.relativePatternSupport) return;
    const api = pathApi(this.platform);
    const watchers: FileSystemWatcher[] = [];
    for (const path of project.touchedPaths()) {
      if (this.uris.isVirtual(path)) continue;
      if (this.workspaceFolders.some(f => isPathInside(path, f, this.platform))) continue;
      const dir = api.dirname(path);
      const key = this.uris.key(dir);
      if (this.watchedDirs.has(key)) continue;
      this.watchedDirs.add(key);
      watchers.push({
        globPattern: { baseUri: this.uris.toUri(dir), pattern: `{*.yfl,${CONFIG_FILE_NAME}}` },
        kind: WatchKind.Create | WatchKind.Change | WatchKind.Delete
      });
    }
    if (watchers.length === 0) return;
    this.send(
      () => this.connection.client.register(DidChangeWatchedFilesNotification.type, { watchers }),
      "register external file watchers"
    );
  }

  // -------------------------------------------------------------------------------------------
  // Diagnostics

  /**
   * Debounce a diagnostics pass for a project. Every edit bumps the generation, which also
   * aborts a pass that is already running (it yields between files).
   */
  private scheduleDiagnostics(project: Project, delay?: number, refresh = false): void {
    if (project.disposed || this.shutdown) return;
    project.generation++;
    if (refresh) project.needsRefresh = true;
    if (project.timer) clearTimeout(project.timer);
    const ms = delay ?? this.settings.diagnostics.delay;
    project.timer = setTimeout(() => {
      project.timer = undefined;
      const run = this.runDiagnostics(project, project.generation).catch(error =>
        this.reporter.report("diagnostics", error)
      );
      this.running.add(run);
      void run.finally(() => this.running.delete(run));
    }, ms);
  }

  private async runDiagnostics(project: Project, generation: number): Promise<void> {
    const stale = () => project.disposed || this.shutdown || project.generation !== generation;
    const ctx = this.ctx();
    const files = new Map<string, StoredDiagnostic[]>();
    for (const path of this.filesToCheck(project)) {
      await yieldForMessages();
      if (stale()) return;
      // Every checked file gets an entry first, so files are published in the order checked.
      const uri = this.uris.toUri(path);
      if (!files.has(uri)) files.set(uri, []);
      for (const d of project.service.getDiagnostics(path)) {
        if (!d || typeof d !== "object") continue;
        // A service may report problems in other files (an import's target, say).
        const target = typeof d.path === "string" && d.path !== "" ? d.path : path;
        const original = { ...d, path: target };
        push(files, this.uris.toUri(target), { lsp: toLspDiagnostic(original, ctx), original });
      }
    }
    if (stale()) return;
    const published = new Map<string, StoredDiagnostic[]>();
    for (const [uri, list] of files) {
      if (list.length > 0) published.set(uri, uniqueDiagnostics(list));
    }
    this.store.set(`project:${project.key}`, published);
    this.watchExternalFiles(project);
    if (project.needsRefresh || project.openFiles.size > 1) {
      project.needsRefresh = false;
      this.refresh("inlayHint");
      this.refresh("codeLens");
      this.refresh("semanticTokens");
    }
  }

  /** The project's open files, and with the "project" scope every file of the project. */
  private filesToCheck(project: Project): Iterable<string> {
    const paths = new Map(project.openFiles);
    if (this.settings.diagnostics.scope === "project") {
      for (const path of project.service.getProjectFiles()) {
        const key = this.uris.key(path);
        if (!paths.has(key)) paths.set(key, path);
      }
    }
    return paths.values();
  }

  private publishConfigDiagnostics(project: Project): void {
    if (project.configPath === undefined) return;
    const ctx = this.ctx();
    const files = new Map<string, StoredDiagnostic[]>();
    for (const original of project.configDiagnostics) {
      const uri = this.uris.toUri(original.path || project.configPath);
      push(files, uri, { lsp: toLspDiagnostic(original, ctx), original });
    }
    this.store.set(`config:${project.key}`, files);
  }

  /**
   * Fire-and-forget a message to the client. Failures (including the synchronous throw of a
   * closed connection) never propagate; they are logged under `context` when one is given.
   */
  private send(fn: () => PromiseLike<unknown> | void, context?: string): void {
    const fail = (error: unknown) => {
      if (context !== undefined && !this.shutdown) this.reporter.report(context, error);
    };
    try {
      const result = fn();
      if (result && typeof result.then === "function") result.then(undefined, fail);
    } catch (error) {
      fail(error);
    }
  }

  /** Ask the client to request a feature's results again, when it supports that. */
  private refresh(feature: RefreshableFeature): void {
    const supported = this.capabilities.workspace?.[feature]?.refreshSupport;
    if (!this.initialized || this.shutdown || supported !== true) return;
    this.send(() => REFRESH_REQUESTS[feature](this.connection));
  }

  // -------------------------------------------------------------------------------------------
  // Requests

  private ctx(): ConvertContext {
    const td = this.capabilities.textDocument;
    const hoverFormats = td?.hover?.contentFormat;
    return {
      uris: this.uris,
      markdown: hoverFormats === undefined || hoverFormats.includes("markdown"),
      snippets: td?.completion?.completionItem?.snippetSupport === true,
      documentChanges: this.capabilities.workspace?.workspaceEdit?.documentChanges === true,
      versionOf: uri => this.documents.get(uri)?.version ?? null
    };
  }

  private target(uri: string): Target {
    const document = this.documents.get(uri);
    const path = document ? this.uris.remember(uri) : this.uris.toPath(uri);
    const project = this.docProject.get(uri) ?? this.projectForPath(path);
    return { uri, path, service: project.service, document };
  }

  /** Run a notification handler, logging instead of throwing. */
  private guard(name: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.reporter.report(name, error);
    }
  }

  /**
   * Run a request on a document (see {@link execute}). A request whose document changed while it
   * waited answers ContentModified: its positions are stale.
   */
  private async run<R>(
    method: string,
    textDocument: { uri: string } | undefined,
    token: CancellationToken | undefined,
    fallback: R,
    fn: (target: Target) => Reply<R>
  ): Promise<R | ResponseError<void>> {
    const uri = textDocument?.uri;
    if (typeof uri !== "string") {
      return new ResponseError(ErrorCodes.InvalidParams, "Expected a textDocument with a uri");
    }
    const versionBefore = this.documents.get(uri)?.version;
    return this.execute(method, token, fallback, () => {
      if (this.documents.get(uri)?.version !== versionBefore) {
        return new ResponseError(LSPErrorCodes.ContentModified, "The document changed");
      }
      return fn(this.target(uri));
    });
  }

  /**
   * Run a request: yield once (so a pending cancellation or edit can arrive), bail out if it was
   * cancelled meanwhile, then compute. Any exception is logged and answered with `fallback`.
   */
  private async execute<R>(
    method: string,
    token: CancellationToken | undefined,
    fallback: R,
    fn: () => Reply<R>
  ): Promise<R | ResponseError<void>> {
    await yieldForMessages();
    if (token?.isCancellationRequested) {
      return new ResponseError(LSPErrorCodes.RequestCancelled, "Request cancelled");
    }
    try {
      return await fn();
    } catch (error) {
      this.reporter.report(method, error);
      return fallback;
    }
  }

  /** Document highlights: the references in the same file. */
  private highlights(t: Target, position: lsp.Position): lsp.DocumentHighlight[] {
    const key = this.uris.key(t.path);
    const ranges = t.service
      .getReferences(t.path, position, true)
      .filter(l => typeof l?.path === "string" && this.uris.key(l.path) === key)
      .map(l => toLspRange(l.range));
    return uniqueBy(ranges, r => JSON.stringify(r)).map(range => ({
      range,
      kind: DocumentHighlightKind.Text
    }));
  }

  /** Workspace symbols from every project (or a fresh inferred one when there is none). */
  private workspaceSymbols(query: string): lsp.SymbolInformation[] {
    const ctx = this.ctx();
    const projects = this.projects.all();
    if (projects.length === 0) projects.push(this.projects.ensureProject(undefined));
    const symbols = projects
      .flatMap(project => project.service.getWorkspaceSymbols(query ?? ""))
      .filter(symbol => typeof symbol?.location?.path === "string")
      .map(symbol => toLspWorkspaceSymbol(symbol, ctx));
    return uniqueBy(
      symbols,
      s => `${s.name}|${s.location.uri}|${JSON.stringify(s.location.range)}`
    );
  }

  /** The service's code actions, plus the fixes attached to the diagnostics in context. */
  private codeActions(t: Target, params: lsp.CodeActionParams): lsp.CodeAction[] {
    const ctx = this.ctx();
    // Clients pass every diagnostic in range, whoever produced it: keep only ours.
    const contextDiagnostics = (params.context?.diagnostics ?? []).filter(
      d => d.source === undefined || d.source === "yaffle"
    );
    // Recover the service's own diagnostic objects (with fixes and related info) when the
    // client sends back diagnostics we published.
    const published = new Map(
      this.store.forUri(t.uri).map(stored => [diagnosticKey(stored.lsp), stored.original])
    );
    const originals = contextDiagnostics.map(
      d => published.get(diagnosticKey(d)) ?? fromLspDiagnostic(d, t.path)
    );
    const actions = t.service.getCodeActions(t.path, toLspRange(params.range), originals);
    const fixes = originals.flatMap(original =>
      (original.fixes ?? []).map(fix => ({
        ...fix,
        diagnosticCodes: fix.diagnosticCodes ?? [original.code]
      }))
    );
    const converted = [...actions, ...fixes]
      .filter(action => action && typeof action.title === "string")
      .map(action => toLspCodeAction(action, contextDiagnostics, ctx))
      .filter(action => kindMatches(action.kind ?? "", params.context?.only));
    return uniqueBy(converted, a => `${a.title}|${JSON.stringify(a.edit)}`);
  }

  /** `@` aligns a continuation line; Enter after one goes back to the field's indentation. */
  private onTypeFormatting(
    t: Target,
    p: lsp.DocumentOnTypeFormattingParams
  ): lsp.TextEdit[] | null {
    const doc = t.document;
    if (!this.settings.alignAttributesOnType.enabled || !doc) return null;
    const getLine = (line: number) =>
      line >= 0 && line < doc.lineCount ? lineText(doc, line) : undefined;
    const edit =
      p.ch === "@"
        ? alignAttributeLine(getLine, p.position.line, p.position.character)
        : p.ch === "\n"
          ? reindentAfterContinuation(getLine, p.position.line)
          : undefined;
    if (!edit) return null;
    const range = {
      start: { line: edit.line, character: 0 },
      end: { line: edit.line, character: edit.oldIndent }
    };
    return [{ range, newText: edit.newIndent }];
  }

  private preparedTokens(t: Target) {
    const doc = t.document;
    return prepareTokens(
      t.service.getSemanticTokens(t.path),
      doc ? line => (line < doc.lineCount ? lineText(doc, line).length : 0) : undefined
    );
  }
}

function serverCapabilities(client: ClientCapabilities): lsp.ServerCapabilities {
  const prepareSupport = client.textDocument?.rename?.prepareSupport === true;
  return {
    positionEncoding: "utf-16",
    textDocumentSync: {
      openClose: true,
      change: TextDocumentSyncKind.Incremental,
      save: { includeText: false }
    },
    hoverProvider: true,
    completionProvider: {
      triggerCharacters: [".", "@", "$", '"', "/", ":", "<"],
      resolveProvider: false
    },
    signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [")"] },
    definitionProvider: true,
    referencesProvider: true,
    documentHighlightProvider: true,
    renameProvider: prepareSupport ? { prepareProvider: true } : true,
    documentSymbolProvider: { label: "yaffle" },
    workspaceSymbolProvider: true,
    inlayHintProvider: { resolveProvider: false },
    codeLensProvider: { resolveProvider: false },
    codeActionProvider: {
      codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.Refactor, CodeActionKind.Source],
      resolveProvider: false
    },
    semanticTokensProvider: {
      legend: SEMANTIC_TOKENS_LEGEND,
      full: { delta: true },
      range: true
    },
    foldingRangeProvider: true,
    documentFormattingProvider: true,
    documentOnTypeFormattingProvider: {
      firstTriggerCharacter: "@",
      moreTriggerCharacter: ["\n"]
    },
    workspace: { workspaceFolders: { supported: true, changeNotifications: true } }
  };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function lineText(doc: TextDocument, line: number): string {
  return doc
    .getText({ start: { line, character: 0 }, end: { line: line + 1, character: 0 } })
    .replace(/\r?\n$/, "");
}

/** Create the server and register its handlers. Call `connection.listen()` afterwards. */
export function startServer(connection: Connection, options: ServerOptions): YaffleServer {
  const server = new YaffleServer(connection, options);
  server.listen();
  return server;
}
