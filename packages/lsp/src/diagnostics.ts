/**
 * Published diagnostics, merged across sources. Each project (and each project's yaffle.json
 * check) is a source; a file's published diagnostics are the union over sources, so a file that
 * shows up in two projects' results isn't clobbered by whichever finished last. Only files whose
 * diagnostics actually changed are re-published.
 */
import type * as lsp from "vscode-languageserver";
import type * as svc from "yaffle/service";
import { diagnosticKey } from "./convert.ts";
import { uniqueBy } from "./util.ts";

export interface StoredDiagnostic {
  lsp: lsp.Diagnostic;
  /** The service's own object, with its fixes, for code actions. */
  original: svc.Diagnostic;
}

/** Drop repeats: same range, code, message and severity. */
export function uniqueDiagnostics(list: StoredDiagnostic[]): StoredDiagnostic[] {
  return uniqueBy(list, d => `${diagnosticKey(d.lsp)}|${String(d.lsp.severity)}`);
}

type Publish = (uri: string, diagnostics: lsp.Diagnostic[]) => void;

export class DiagnosticsStore {
  private readonly bySource = new Map<string, Map<string, StoredDiagnostic[]>>();
  private readonly lastSent = new Map<string, string>();
  private readonly publish: Publish;

  constructor(publish: Publish) {
    this.publish = publish;
  }

  /** Replace everything a source reports. Files it no longer reports are cleared. */
  set(source: string, files: Map<string, StoredDiagnostic[]>): void {
    const previous = this.bySource.get(source);
    const affected = new Set<string>([...(previous?.keys() ?? []), ...files.keys()]);
    if (files.size === 0) this.bySource.delete(source);
    else this.bySource.set(source, files);
    for (const uri of affected) this.flush(uri);
  }

  clearSource(source: string): void {
    this.set(source, new Map());
  }

  /** Everything currently published for a file. */
  forUri(uri: string): StoredDiagnostic[] {
    const out: StoredDiagnostic[] = [];
    for (const files of this.bySource.values()) out.push(...(files.get(uri) ?? []));
    return out;
  }

  /** URIs with at least one published diagnostic. */
  uris(): string[] {
    return [...this.lastSent.keys()];
  }

  private flush(uri: string): void {
    const merged = uniqueDiagnostics(this.forUri(uri)).map(d => d.lsp);
    const serialized = JSON.stringify(merged);
    if ((this.lastSent.get(uri) ?? "[]") === serialized) return;
    if (merged.length === 0) this.lastSent.delete(uri);
    else this.lastSent.set(uri, serialized);
    this.publish(uri, merged);
  }
}
