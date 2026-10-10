/**
 * The yaffle VS Code extension: starts the language server (bundled, or the one named by
 * `yaffle.server.path`) and adds the yaffle commands: Show IR, Decode Sample File…, Suggest
 * Layout from Sample…, and friends.
 */
import * as fs from "node:fs";
import * as vscode from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type NodeModule,
  RevealOutputChannelOn,
  type ServerOptions,
  TransportKind
} from "vscode-languageclient/node";
import type * as lsp from "vscode-languageclient/node";
import {
  RootParametersMethod,
  type RootParametersResult,
  ShowIrMethod,
  type ShowIrResult,
  SuggestLayoutMethod,
  type SuggestLayoutResult
} from "@yafflelang/lsp/protocol";
import { argPrompt, parseArg } from "./args.ts";
import { COMMANDS, LANGUAGE_ID } from "./commands.ts";
import { collectLocations, formatIr } from "./format.ts";
import { resolveServerLaunch, type ServerLaunch } from "./launch.ts";
import { baseName, SampleDecorations, type SampleSession, sampleSource } from "./sample.ts";

const IR_SCHEME = "yaffle-ir";

/** What `activate` returns (other extensions and tests can use it). */
export interface YaffleExtensionApi {
  readonly client: LanguageClient | undefined;
  restart(): Promise<void>;
}

let controller: Controller | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<YaffleExtensionApi> {
  controller = new Controller(context);
  await controller.start();
  return controller;
}

export async function deactivate(): Promise<void> {
  await controller?.stop();
  controller = undefined;
}

class Controller implements YaffleExtensionApi {
  client: LanguageClient | undefined;
  private readonly context: vscode.ExtensionContext;
  private readonly output: vscode.LogOutputChannel;
  private readonly samples: SampleDecorations;
  private readonly ir: IrDocuments;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.output = vscode.window.createOutputChannel("yaffle Language Server", { log: true });
    this.samples = new SampleDecorations(() => this.client);
    this.ir = new IrDocuments(() => this.client);
    const register = (id: string, fn: (...args: unknown[]) => unknown) =>
      context.subscriptions.push(vscode.commands.registerCommand(id, fn));
    context.subscriptions.push(
      this.output,
      this.samples,
      this.ir,
      vscode.workspace.registerTextDocumentContentProvider(IR_SCHEME, this.ir),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration("yaffle.server")) void this.restart();
      })
    );
    register(COMMANDS.showIr, () => this.showIr());
    register(COMMANDS.decodeSample, () => this.decodeSample());
    register(COMMANDS.suggestLayout, () => this.suggestLayout());
    register(COMMANDS.clearSample, () => this.samples.clear());
    register(COMMANDS.restartServer, () => this.restart());
    register(COMMANDS.showOutput, () => this.output.show(true));
    register(COMMANDS.showBindingSources, (...args) => this.showBindingSources(args));
  }

  // --- Client lifecycle ------------------------------------------------------------------------

  private launch(): ServerLaunch {
    const config = vscode.workspace.getConfiguration("yaffle");
    return resolveServerLaunch({
      serverPath: config.get<string>("server.path"),
      runtime: config.get<string>("server.runtime"),
      bundledServer: this.context.asAbsolutePath("dist/server.mjs"),
      workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    });
  }

  async start(): Promise<void> {
    const launch = this.launch();
    if (launch.kind === "module" && !fs.existsSync(launch.module)) {
      // Checked up front: a missing module makes the client fail in ways it can't report well.
      const message = `yaffle: the language server module ${launch.module} does not exist (check yaffle.server.path).`;
      this.output.error(message);
      void vscode.window.showErrorMessage(message);
      return;
    }
    const clientOptions: LanguageClientOptions = {
      documentSelector: [
        { scheme: "file", language: LANGUAGE_ID },
        { scheme: "untitled", language: LANGUAGE_ID }
      ],
      outputChannel: this.output,
      revealOutputChannelOn: RevealOutputChannelOn.Never,
      diagnosticCollectionName: LANGUAGE_ID,
      markdown: { isTrusted: false, supportHtml: false }
    };
    this.client = new LanguageClient(
      LANGUAGE_ID,
      "yaffle Language Server",
      serverOptions(launch),
      clientOptions
    );
    try {
      await this.client.start();
    } catch (error) {
      this.output.error(`yaffle: the language server failed to start: ${String(error)}`);
      void vscode.window
        .showErrorMessage("yaffle: the language server failed to start.", "Show Output")
        .then(choice => {
          if (choice) this.output.show(true);
        });
    }
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    try {
      await client?.stop();
    } catch {
      // already stopped or never started
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  private requireClient(): LanguageClient | undefined {
    if (this.client?.isRunning()) return this.client;
    void vscode.window
      .showErrorMessage("yaffle: the language server is not running.", "Restart")
      .then(choice => {
        if (choice) void this.restart();
      });
    return undefined;
  }

  // --- Commands --------------------------------------------------------------------------------

  /** The .yfl document a command applies to: the active editor's, else the most recent visible. */
  private activeYaffleDocument(): vscode.TextDocument | undefined {
    const active = vscode.window.activeTextEditor?.document;
    if (active?.languageId === LANGUAGE_ID) return active;
    const visible = vscode.window.visibleTextEditors.find(
      e => e.document.languageId === LANGUAGE_ID
    );
    if (visible) return visible.document;
    void vscode.window.showWarningMessage("yaffle: open a .yfl file first.");
    return undefined;
  }

  private async showIr(): Promise<void> {
    const doc = this.activeYaffleDocument();
    if (!doc || !this.requireClient()) return;
    const uri = this.ir.uriFor(doc.uri);
    this.ir.refresh(uri);
    const irDoc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(irDoc, "jsonc");
    await vscode.window.showTextDocument(irDoc, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true
    });
  }

  /**
   * What the sample commands start with: the active .yfl document, a root struct, a sample file
   * and the root's arguments. Undefined when the user cancels or something is missing.
   */
  private async askForSample(
    purpose: string
  ): Promise<{ client: LanguageClient; session: SampleSession } | undefined> {
    const doc = this.activeYaffleDocument();
    const client = doc && this.requireClient();
    if (!doc || !client) return undefined;
    const choice = await this.pickRootAndSample(doc, purpose);
    if (!choice) return undefined;
    const args = await this.rootArgs(doc, choice.root);
    if (!args) return undefined;
    return { client, session: { document: doc.uri, ...choice, args } };
  }

  /** Ask for a root struct (from the document's symbols) and a sample file. */
  private async pickRootAndSample(
    doc: vscode.TextDocument,
    purpose: string
  ): Promise<{ root: string; sample: vscode.Uri } | undefined> {
    const symbols =
      (await vscode.commands.executeCommand<
        (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined
      >("vscode.executeDocumentSymbolProvider", doc.uri)) ?? [];
    const structs = symbols.filter(s => s.kind === vscode.SymbolKind.Struct);
    if (structs.length === 0) {
      void vscode.window.showWarningMessage(`yaffle: ${baseName(doc.uri)} declares no structs.`);
      return undefined;
    }
    const state = this.context.workspaceState;
    const rootKey = `yaffle.lastRoot:${doc.uri.toString()}`;
    const lastRoot = state.get<string>(rootKey);
    const items: vscode.QuickPickItem[] = structs.map(s => {
      const item: vscode.QuickPickItem = { label: s.name, picked: s.name === lastRoot };
      if ("detail" in s && s.detail) item.description = s.detail;
      return item;
    });
    items.sort((a, b) => Number(b.picked ?? false) - Number(a.picked ?? false));
    const picked = await vscode.window.showQuickPick(items, {
      title: `yaffle: ${purpose}`,
      placeHolder: "Root struct"
    });
    if (!picked) return undefined;
    const lastSample = state.get<string>("yaffle.lastSample");
    const files = await vscode.window.showOpenDialog({
      title: `yaffle: sample file to decode as ${picked.label}`,
      openLabel: "Use Sample",
      canSelectMany: false,
      ...(lastSample ? { defaultUri: vscode.Uri.parse(lastSample) } : {})
    });
    const sample = files?.[0];
    if (!sample) return undefined;
    await state.update(rootKey, picked.label);
    await state.update("yaffle.lastSample", sample.toString());
    return { root: picked.label, sample };
  }

  /**
   * Ask for the root struct's parameters (`struct Node(u8 $key[32], u64 $nonce)`), one input box
   * each, prefilled with what was entered last time for this file and root. Byte arrays are typed
   * as hex. Resolves to undefined when the user cancels or the root can't be used.
   */
  private async rootArgs(
    doc: vscode.TextDocument,
    root: string
  ): Promise<Record<string, unknown> | undefined> {
    const client = this.client;
    if (!client) return undefined;
    const result = await client.sendRequest<RootParametersResult>(RootParametersMethod, {
      textDocument: { uri: doc.uri.toString() },
      root
    });
    if (result.error) {
      void vscode.window.showErrorMessage(`yaffle: ${result.error}`);
      return undefined;
    }
    const args: Record<string, unknown> = {};
    if (!result.parameters.length) return args;
    const stateKey = `yaffle.sampleArgs:${doc.uri.toString()}:${root}`;
    const saved = this.context.workspaceState.get<Record<string, string>>(stateKey) ?? {};
    const texts: Record<string, string> = { ...saved };
    for (const p of result.parameters) {
      const text = await vscode.window.showInputBox({
        title: `yaffle: ${root} needs ${p.label}`,
        prompt: argPrompt(p),
        value: saved[p.name] ?? "",
        ignoreFocusOut: true,
        validateInput: t => parseArg(p, t).error
      });
      if (text === undefined) return undefined;
      const r = parseArg(p, text);
      if (r.error) {
        void vscode.window.showErrorMessage(`yaffle: ${r.error}`);
        return undefined;
      }
      texts[p.name] = text;
      if (r.value !== undefined) args[p.name] = r.value;
    }
    await this.context.workspaceState.update(stateKey, texts);
    return args;
  }

  private async decodeSample(): Promise<void> {
    const input = await this.askForSample("Decode Sample File");
    if (!input) return;
    const { session } = input;
    const count = await this.samples.decode(session);
    if (count === 0) {
      void vscode.window.showInformationMessage(
        `yaffle: ${baseName(session.sample)} decoded, but nothing to show.`
      );
    }
  }

  private async suggestLayout(): Promise<void> {
    const input = await this.askForSample("Suggest Layout from Sample");
    if (!input) return;
    const { client, session } = input;
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `yaffle: analysing ${baseName(session.sample)}…`,
        cancellable: true
      },
      async (_progress, token) =>
        client.sendRequest<SuggestLayoutResult>(
          SuggestLayoutMethod,
          {
            textDocument: { uri: session.document.toString() },
            root: session.root,
            sample: await sampleSource(session.sample),
            args: session.args
          },
          token
        )
    );
    if (result.error) {
      void vscode.window.showErrorMessage(`yaffle: ${result.error}`);
      return;
    }
    if (!result.edit) {
      void vscode.window.showInformationMessage(
        `yaffle: ${baseName(session.sample)} already follows the default layout; no rules needed.`
      );
      return;
    }
    const edit = await client.protocol2CodeConverter.asWorkspaceEdit(
      result.edit as lsp.WorkspaceEdit
    );
    if (!(await vscode.workspace.applyEdit(edit))) {
      void vscode.window.showErrorMessage("yaffle: could not apply the suggested layout.");
    }
  }

  /** Code lens command: peek the locations in its arguments (see ShowBindingSourcesCommand). */
  private async showBindingSources(args: unknown[]): Promise<void> {
    const client = this.client;
    if (!client) return;
    const locations = collectLocations(args).map(l =>
      client.protocol2CodeConverter.asLocation(l as lsp.Location)
    );
    if (locations.length === 0) {
      void vscode.window.showInformationMessage("yaffle: no binding sources found.");
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const anchorUri = editor?.document.uri ?? locations[0]!.uri;
    const anchor = editor?.selection.active ?? locations[0]!.range.start;
    await vscode.commands.executeCommand(
      "editor.action.showReferences",
      anchorUri,
      anchor,
      locations
    );
  }
}

/** A module server runs over IPC (with an inspector port when debugging); an executable over stdio. */
function serverOptions(launch: ServerLaunch): ServerOptions {
  if (launch.kind === "executable") {
    return { command: launch.command, args: launch.args, transport: TransportKind.stdio };
  }
  const run: NodeModule = {
    module: launch.module,
    transport: TransportKind.ipc,
    options: { execArgv: launch.execArgv }
  };
  if (launch.runtime) run.runtime = launch.runtime;
  const debug: NodeModule = {
    ...run,
    options: { execArgv: [...launch.execArgv, "--nolazy", "--inspect=6011"] }
  };
  return { run, debug };
}

/** Read-only `yaffle-ir:` documents showing the IR of a .yfl file, refreshed on save. */
class IrDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly open = new Set<string>();
  private readonly getClient: () => LanguageClient | undefined;
  private readonly listeners: vscode.Disposable[];

  constructor(getClient: () => LanguageClient | undefined) {
    this.getClient = getClient;
    this.listeners = [
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.languageId !== LANGUAGE_ID) return;
        // Imports may have changed too: refresh every open IR view.
        for (const uri of this.open) this.changed.fire(vscode.Uri.parse(uri));
      }),
      vscode.workspace.onDidCloseTextDocument(doc => {
        if (doc.uri.scheme === IR_SCHEME) this.open.delete(doc.uri.toString());
      })
    ];
  }

  uriFor(source: vscode.Uri): vscode.Uri {
    return vscode.Uri.from({
      scheme: IR_SCHEME,
      path: `/${baseName(source)}.ir.jsonc`,
      query: encodeURIComponent(source.toString())
    });
  }

  refresh(uri: vscode.Uri): void {
    this.changed.fire(uri);
  }

  async provideTextDocumentContent(
    uri: vscode.Uri,
    token: vscode.CancellationToken
  ): Promise<string> {
    this.open.add(uri.toString());
    const source = decodeURIComponent(uri.query);
    const client = this.getClient();
    if (!client?.isRunning()) return "// yaffle: the language server is not running.\n";
    const result = await client.sendRequest<ShowIrResult>(
      ShowIrMethod,
      { textDocument: { uri: source } },
      token
    );
    return formatIr(result, source);
  }

  dispose(): void {
    for (const listener of this.listeners) listener.dispose();
    this.changed.dispose();
  }
}
