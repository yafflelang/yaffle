/**
 * Starts the yaffle server over in-memory streams and drives it with a JSON-RPC client, exactly
 * as an editor would. The server connection uses a no-op watchdog so `exit` doesn't end the test
 * process.
 */
import { PassThrough } from "node:stream";
import {
  type ClientCapabilities,
  createConnection,
  type InitializeResult,
  ProposedFeatures,
  type PublishDiagnosticsParams,
  type Registration,
  type TextDocumentContentChangeEvent
} from "vscode-languageserver";
import {
  createProtocolConnection,
  type ProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter
} from "vscode-languageserver-protocol/node";
import { MemoryFileSystem } from "../src/fs.ts";
import { quietLogger } from "../src/safe.ts";
import { type ServerOptions, startServer, type YaffleServer } from "../src/server.ts";
import { pathToFileUri, type Platform } from "../src/uri.ts";
import { fakeFactory, type FakeService } from "./fakeService.ts";

export const VSCODE_LIKE_CAPABILITIES: ClientCapabilities = {
  general: { positionEncodings: ["utf-16"] },
  textDocument: {
    synchronization: { dynamicRegistration: true, didSave: true },
    hover: { contentFormat: ["markdown", "plaintext"] },
    completion: { completionItem: { snippetSupport: true } },
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    rename: { prepareSupport: true },
    publishDiagnostics: {
      relatedInformation: true,
      versionSupport: true,
      tagSupport: { valueSet: [1, 2] }
    }
  },
  workspace: {
    workspaceFolders: true,
    configuration: true,
    didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
    didChangeConfiguration: { dynamicRegistration: true },
    workspaceEdit: { documentChanges: true },
    inlayHint: { refreshSupport: true },
    codeLens: { refreshSupport: true },
    semanticTokens: { refreshSupport: true }
  }
};

export interface TestServerOptions {
  platform?: Platform;
  files?: Record<string, string | Uint8Array>;
  capabilities?: ClientCapabilities;
  workspaceFolders?: string[];
  initializationOptions?: unknown;
  /** What the client answers to workspace/configuration (section "yaffle"). */
  configuration?: unknown;
  serverOptions?: Partial<ServerOptions>;
  /** Diagnostics debounce (default 10ms to keep tests fast). */
  delay?: number;
  /** Configure every fake service, including ones created during initialize. */
  setupFake?: (service: FakeService) => void;
  /** Skip the initialize handshake. */
  noInitialize?: boolean;
}

export interface LogEntry {
  type: number;
  message: string;
}

export class TestServer {
  readonly client: ProtocolConnection;
  readonly server: YaffleServer;
  readonly fs: MemoryFileSystem;
  readonly platform: Platform;
  readonly fakes: FakeService[];
  readonly configureFakes: (fn: (s: FakeService) => void) => void;
  readonly published: PublishDiagnosticsParams[] = [];
  readonly logs: LogEntry[] = [];
  readonly shownMessages: LogEntry[] = [];
  readonly registrations: Registration[] = [];
  readonly refreshes: string[] = [];
  readonly configurationRequests: unknown[] = [];
  configuration: unknown;
  initializeResult: InitializeResult | undefined;
  exitCode: number | undefined;
  private readonly versions = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly streams: PassThrough[];

  constructor(options: TestServerOptions) {
    this.platform = options.platform ?? "posix";
    this.fs = new MemoryFileSystem(this.platform, options.files ?? {});
    this.configuration = options.configuration ?? {};
    const fake = fakeFactory(this.platform);
    this.fakes = fake.instances;
    this.configureFakes = fake.configure;
    if (options.setupFake) fake.configure(options.setupFake);

    const toServer = new PassThrough();
    const toClient = new PassThrough();
    this.streams = [toServer, toClient];
    const connection = createConnection(
      // The JSON-RPC layer logs write failures through this logger (the remote console), which
      // itself throws once the connection is closed: keep it quiet during teardown.
      logger =>
        createProtocolConnection(
          new StreamMessageReader(toServer),
          new StreamMessageWriter(toClient),
          quietLogger(logger)
        ),
      {
        shutdownReceived: false,
        initialize: () => undefined,
        exit: code => {
          this.exitCode = code;
        }
      },
      ProposedFeatures.all
    );
    this.server = startServer(connection, {
      createService: fake.factory,
      fileSystem: this.fs,
      platform: this.platform,
      settings: { diagnostics: { delay: options.delay ?? 10 } },
      ...options.serverOptions
    });
    connection.listen();

    this.client = createProtocolConnection(
      new StreamMessageReader(toClient),
      new StreamMessageWriter(toServer)
    );
    this.client.onNotification("textDocument/publishDiagnostics", (p: PublishDiagnosticsParams) => {
      this.published.push(p);
      this.notify();
    });
    this.client.onNotification("window/logMessage", (p: LogEntry) => {
      this.logs.push(p);
      this.notify();
    });
    this.client.onNotification("window/showMessage", (p: LogEntry) => {
      this.shownMessages.push(p);
      this.notify();
    });
    this.client.onRequest("client/registerCapability", (p: { registrations: Registration[] }) => {
      this.registrations.push(...p.registrations);
      this.notify();
      return null;
    });
    this.client.onRequest("client/unregisterCapability", () => null);
    this.client.onRequest("workspace/configuration", (p: { items: { section?: string }[] }) => {
      this.configurationRequests.push(p);
      return p.items.map(() => this.configuration);
    });
    for (const method of [
      "workspace/inlayHint/refresh",
      "workspace/codeLens/refresh",
      "workspace/semanticTokens/refresh",
      "workspace/diagnostic/refresh"
    ]) {
      this.client.onRequest(method, () => {
        this.refreshes.push(method);
        this.notify();
        return null;
      });
    }
    this.client.onRequest("window/workDoneProgress/create", () => null);
    this.client.onRequest("window/showMessageRequest", (p: LogEntry) => {
      this.shownMessages.push(p);
      this.notify();
      return null;
    });
    this.client.listen();
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  /** Resolve when `check` returns a value (re-checked on every incoming message). */
  waitFor<T>(check: () => T | undefined, timeoutMs = 3000, what = "condition"): Promise<T> {
    return new Promise((resolve, reject) => {
      const tryNow = () => {
        let value: T | undefined;
        try {
          value = check();
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        if (value !== undefined) {
          cleanup();
          resolve(value);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for ${what}`));
      }, timeoutMs);
      const poll = setInterval(tryNow, 10);
      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(poll);
        this.listeners.delete(tryNow);
      };
      this.listeners.add(tryNow);
      tryNow();
    });
  }

  uri(path: string): string {
    return pathToFileUri(path, this.platform);
  }

  /** A URI as is, or a path (posix or win32) as a file URI. */
  private toUri(pathOrUri: string): string {
    const isUri = pathOrUri.includes(":") && !/^[a-zA-Z]:\\/.test(pathOrUri);
    return isUri ? pathOrUri : this.uri(pathOrUri);
  }

  /** The latest diagnostics published for a path (or URI), if any. */
  diagnostics(pathOrUri: string): PublishDiagnosticsParams | undefined {
    return this.publishedFor(pathOrUri).at(-1);
  }

  publishedFor(pathOrUri: string): PublishDiagnosticsParams[] {
    const uri = this.toUri(pathOrUri);
    return this.published.filter(p => p.uri === uri);
  }

  /** Wait until diagnostics for a path satisfy a predicate. */
  waitForDiagnostics(
    pathOrUri: string,
    predicate: (p: PublishDiagnosticsParams) => boolean = () => true,
    timeoutMs = 3000
  ): Promise<PublishDiagnosticsParams> {
    return this.waitFor(
      () => {
        const p = this.diagnostics(pathOrUri);
        return p && predicate(p) ? p : undefined;
      },
      timeoutMs,
      `diagnostics for ${pathOrUri}`
    );
  }

  async initialize(options: TestServerOptions = {}): Promise<InitializeResult> {
    const folders = options.workspaceFolders ?? [];
    this.initializeResult = await this.client.sendRequest("initialize", {
      processId: null,
      rootUri: folders[0] ? this.uri(folders[0]) : null,
      capabilities: options.capabilities ?? VSCODE_LIKE_CAPABILITIES,
      workspaceFolders: folders.map(f => ({ uri: this.uri(f), name: f })),
      initializationOptions: options.initializationOptions
    });
    await this.client.sendNotification("initialized", {});
    await this.settle();
    return this.initializeResult!;
  }

  /** Let pending messages flow and diagnostics passes finish. */
  async settle(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      await this.server.idle();
    }
  }

  async open(path: string, text: string, version = 1, languageId = "yaffle"): Promise<string> {
    const uri = this.toUri(path);
    this.versions.set(uri, version);
    await this.client.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text }
    });
    return uri;
  }

  async change(
    path: string,
    change: string | TextDocumentContentChangeEvent[],
    version?: number
  ): Promise<void> {
    const uri = this.toUri(path);
    const next = version ?? (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, next);
    const contentChanges = typeof change === "string" ? [{ text: change }] : change;
    await this.client.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: next },
      contentChanges
    });
  }

  async close(path: string): Promise<void> {
    const uri = this.toUri(path);
    await this.client.sendNotification("textDocument/didClose", { textDocument: { uri } });
  }

  request<R = unknown>(method: string, params: unknown): Promise<R> {
    return this.client.sendRequest(method, params) as Promise<R>;
  }

  /** Find the fake service whose project root (or none, for the inferred one) matches. */
  fakeFor(rootDir: string | undefined): FakeService {
    const found = this.fakes.find(f => f.project?.rootDir === rootDir);
    if (!found) throw new Error(`no fake service for ${rootDir ?? "inferred project"}`);
    return found;
  }

  dispose(): void {
    this.server.dispose();
    this.client.dispose();
    for (const s of this.streams) s.destroy();
  }
}

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const t = new TestServer(options);
  if (!options.noInitialize) await t.initialize(options);
  return t;
}
