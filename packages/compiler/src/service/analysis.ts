/**
 * The language service's view of the workspace: runs the frontend over open files and project
 * sources (parse results are cached per file), and indexes the result for queries.
 */
import { globSync } from "node:fs";
import type * as A from "../frontend/ast.ts";
import type { Diag } from "../frontend/diagnostics.ts";
import type { Elaborator } from "../frontend/elaborate.ts";
import type { FieldResult, StructResult, SymRef } from "../frontend/model.ts";
import { ParseCache, runFrontend, type FrontendResult } from "../frontend/program.ts";
import {
  allDecls,
  type DeclSym,
  type FieldSym,
  type ModuleInfo,
  type StructSym,
  type Sym
} from "../frontend/symbols.ts";
import { expandGlobs, joinPath, normalizePath } from "../frontend/util.ts";
import type { ProjectConfig, ProjectHost } from "./api.ts";

export class Workspace {
  readonly host: ProjectHost;
  readonly overlays = new Map<string, string>();
  readonly cache = new ParseCache();
  project?: { config: ProjectConfig; rootDir: string };
  private version = 0;
  private analysis?: { version: number; entriesKey: string; value: Analysis };
  private projectFiles?: { version: number; files: string[] };

  constructor(host: ProjectHost) {
    this.host = host;
  }

  bump(): void {
    this.version++;
  }

  readFile(path: string): string | undefined {
    return this.overlays.get(path) ?? this.host.readFile(path);
  }

  fileExists(path: string): boolean {
    return this.overlays.has(path) || this.host.fileExists(path);
  }

  private projectSources(): string[] {
    if (!this.project) return [];
    if (this.projectFiles && this.projectFiles.version === this.version)
      return this.projectFiles.files;
    let files: string[] = [];
    const { rootDir, config } = this.project;
    try {
      if (this.host.readDirectory) {
        const read = this.host.readDirectory.bind(this.host);
        files = expandGlobs(rootDir, config.sources, read).filter(f => f.endsWith(".yfl"));
      } else {
        for (const pattern of config.sources) {
          for (const f of globSync(pattern, { cwd: rootDir })) {
            if (f.endsWith(".yfl")) files.push(joinPath(rootDir, f));
          }
        }
      }
    } catch {
      // no filesystem access: only open files
    }
    this.projectFiles = { version: this.version, files };
    return files;
  }

  dispose(): void {
    this.overlays.clear();
    delete this.analysis;
    delete this.projectFiles;
    delete this.project;
    this.bump();
  }

  /** The analysis containing `path` (re-run when anything changed). */
  get(path?: string): Analysis {
    const entries = new Set<string>([...this.overlays.keys(), ...this.projectSources()]);
    if (path) entries.add(normalizePath(path));
    const list = [...entries].sort();
    const key = list.join("\n");
    const cur = this.analysis;
    if (
      cur &&
      cur.version === this.version &&
      (cur.entriesKey === key || (path && cur.value.module(path)))
    )
      return cur.value;
    const value = new Analysis(
      runFrontend(
        list,
        { readFile: p => this.readFile(p), fileExists: p => this.fileExists(p) },
        {
          parseCache: this.cache,
          assembleOnError: true,
          ...(this.project
            ? { rootDir: this.project.rootDir, targets: this.project.config.targets }
            : {})
        }
      )
    );
    this.analysis = { version: this.version, entriesKey: key, value };
    return value;
  }
}

export class Analysis {
  readonly result: FrontendResult;
  readonly el: Elaborator;
  private readonly modules = new Map<string, ModuleInfo>();
  readonly structByDecl = new Map<A.StructDecl, StructSym>();
  readonly declByNode = new Map<A.Decl | A.Member, DeclSym>();
  readonly fieldByDecl = new Map<A.FieldDecl, FieldSym>();

  constructor(result: FrontendResult) {
    this.result = result;
    this.el = result.elaborator;
    for (const m of result.modules) {
      this.modules.set(m.path, m);
      for (const d of allDecls(m)) {
        this.declByNode.set(d.decl, d);
        if (d.kind === "struct") {
          this.structByDecl.set(d.decl, d);
          for (const f of d.fields) this.fieldByDecl.set(f.decl, f);
        }
      }
    }
  }

  module(path: string): ModuleInfo | undefined {
    return this.modules.get(normalizePath(path));
  }

  allModules(): ModuleInfo[] {
    return [...this.modules.values()];
  }

  diagnosticsFor(path: string): Diag[] {
    const p = normalizePath(path);
    return this.result.diagnostics.filter(d => d.file.path === p);
  }

  refs(path: string): SymRef[] {
    return this.el.model.refsIn(normalizePath(path));
  }

  /** The reference (or declaration) at an offset; the smallest span wins. */
  refAt(path: string, offset: number): SymRef | undefined {
    let best: SymRef | undefined;
    for (const r of this.refs(path)) {
      if (offset < r.span.start || offset > r.span.end) continue;
      if (!best || r.span.end - r.span.start < best.span.end - best.span.start) best = r;
    }
    return best;
  }

  structResult(sym: StructSym): StructResult | undefined {
    return this.el.model.structs.get(sym);
  }

  fieldResult(f: FieldSym): FieldResult | undefined {
    return this.structResult(f.owner)?.fields.get(f);
  }

  /** Every reference to `sym` in the workspace. */
  referencesTo(sym: Sym): { path: string; ref: SymRef }[] {
    const out: { path: string; ref: SymRef }[] = [];
    for (const [path, list] of this.el.model.refs) {
      for (const r of list) if (sameSym(r.sym, sym)) out.push({ path, ref: r });
    }
    return out;
  }
}

function sameSym(a: Sym, b: Sym): boolean {
  if (a === b) return true;
  if (a.kind === "builtinType" && b.kind === "builtinType") return a.name === b.name;
  if (a.kind === "builtinFn" && b.kind === "builtinFn") return a.name === b.name;
  if (a.kind === "lambdaParam" && b.kind === "lambdaParam")
    return a.nameSpan.start === b.nameSpan.start && a.module === b.module;
  return false;
}
