/**
 * Sample sessions: decode a sample file with a root struct and show the decoded values next to
 * the fields (end-of-line decorations with hovers). The session is re-decoded when a .yfl file
 * is saved, so the values follow the format as you edit it.
 */
import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import {
  DecodeSampleMethod,
  type DecodeSampleResult,
  type SampleParams,
  type SampleSource
} from "@yaffle/lsp/protocol";
import { type RenderedAnnotation, renderAnnotations } from "./annotations.ts";
import { COMMANDS, LANGUAGE_ID } from "./commands.ts";

export interface SampleSession {
  document: vscode.Uri;
  root: string;
  sample: vscode.Uri;
  /** Root arguments (canonical JSON), asked for when the root has parameters. */
  args?: Record<string, unknown>;
}

/** What a sample request sends: a file URI the server can read, or the bytes inline. */
export async function sampleSource(uri: vscode.Uri): Promise<SampleSource> {
  if (uri.scheme === "file") return { uri: uri.toString() };
  const bytes = await vscode.workspace.fs.readFile(uri);
  return { base64: Buffer.from(bytes).toString("base64") };
}

const STATUS_TOOLTIP = "Decoded sample values are shown in the editor. Click to clear.";

export class SampleDecorations implements vscode.Disposable {
  private readonly type: vscode.TextEditorDecorationType;
  private readonly status: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private byUri = new Map<string, RenderedAnnotation[]>();
  private readonly getClient: () => LanguageClient | undefined;
  private session: SampleSession | undefined;

  constructor(getClient: () => LanguageClient | undefined) {
    this.getClient = getClient;
    this.type = vscode.window.createTextEditorDecorationType({
      after: {
        margin: "0 0 0 2em",
        color: new vscode.ThemeColor("editorCodeLens.foreground"),
        fontStyle: "italic"
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = COMMANDS.clearSample;
    this.status.tooltip = STATUS_TOOLTIP;
    this.disposables.push(
      this.type,
      this.status,
      vscode.window.onDidChangeVisibleTextEditors(editors => editors.forEach(e => this.apply(e))),
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.languageId !== LANGUAGE_ID || !this.session) return;
        const redecode = vscode.workspace
          .getConfiguration("yaffle")
          .get<boolean>("sample.redecodeOnSave", true);
        if (redecode) void this.decode(this.session, { quiet: true });
      })
    );
  }

  /** Decode a sample and show its annotations. Returns the number of annotations. */
  async decode(
    session: SampleSession,
    options: { quiet?: boolean } = {}
  ): Promise<number | undefined> {
    const client = this.getClient();
    if (!client) {
      void vscode.window.showErrorMessage("yaffle: the language server is not running.");
      return undefined;
    }
    const params: SampleParams = {
      textDocument: { uri: session.document.toString() },
      root: session.root,
      sample: await sampleSource(session.sample),
      ...(session.args && Object.keys(session.args).length ? { args: session.args } : {})
    };
    const run = (token?: vscode.CancellationToken) =>
      client.sendRequest<DecodeSampleResult>(DecodeSampleMethod, params, token);
    const result = options.quiet
      ? await run()
      : await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `yaffle: decoding ${baseName(session.sample)} as ${session.root}…`,
            cancellable: true
          },
          (_progress, token) => run(token)
        );
    if (result.error) {
      if (options.quiet) {
        // Keep the last good values, but say they're stale.
        this.status.text = `$(warning) ${baseName(session.sample)}: ${session.root}`;
        this.status.tooltip = `Decoding failed: ${result.error}\nClick to clear the sample annotations.`;
        this.status.show();
      } else {
        void vscode.window.showErrorMessage(`yaffle: ${result.error}`);
      }
      return undefined;
    }
    this.session = session;
    this.show(renderAnnotations(result.annotations));
    this.status.text = `$(file-binary) ${baseName(session.sample)}: ${session.root}`;
    this.status.tooltip = STATUS_TOOLTIP;
    this.status.show();
    return result.annotations.length;
  }

  private show(rendered: RenderedAnnotation[]): void {
    this.byUri = new Map();
    for (const r of rendered) {
      const list = this.byUri.get(r.uri);
      if (list) list.push(r);
      else this.byUri.set(r.uri, [r]);
    }
    for (const editor of vscode.window.visibleTextEditors) this.apply(editor);
  }

  private apply(editor: vscode.TextEditor): void {
    const list = this.byUri.get(editor.document.uri.toString()) ?? [];
    editor.setDecorations(
      this.type,
      list.map(r => ({
        range: new vscode.Range(
          r.range.start.line,
          r.range.start.character,
          r.range.end.line,
          r.range.end.character
        ),
        hoverMessage: new vscode.MarkdownString(r.hover),
        renderOptions: { after: { contentText: r.text } }
      }))
    );
  }

  clear(): void {
    this.session = undefined;
    this.byUri = new Map();
    for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(this.type, []);
    this.status.hide();
  }

  dispose(): void {
    this.clear();
    for (const d of this.disposables) d.dispose();
  }
}

export function baseName(uri: vscode.Uri): string {
  const parts = uri.path.split("/");
  return parts[parts.length - 1] || uri.path;
}
