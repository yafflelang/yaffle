/**
 * Go backend: IR → one Go file per IR module, all in one package (cross-module type cycles are
 * allowed in yaffle, Go packages can't import each other in cycles). Typed structs, enums and
 * unions; generated readers, writers, canonical JSON converters, views and the root API. See
 * docs/targets/go.md.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IrExpr, IrProgram, IrValueType } from "../../ir/index.ts";
import type { Backend, BackendOptions, GeneratedFile } from "../backend.ts";
import { ApiEmitter, rootNames } from "./api.ts";
import { Code } from "./code.ts";
import { emitConst, emitEnum, emitMissingExtern, emitStructType, emitUnionType } from "./decls.ts";
import { ExprCompiler, type CExpr, type ExprCtx } from "./expr.ts";
import { gofmt } from "./gofmt.ts";
import type { HarnessRoot } from "./harness.ts";
import { JsonEmitter } from "./json.ts";
import { BackendError, Model } from "./model.ts";
import { ModuleCtx, externFileContents, resolveExtern, type ExternRef } from "./module.ts";
import { ReadEmitter } from "./read.ts";
import { ViewEmitter } from "./view.ts";
import { WriteEmitter } from "./write.ts";

export interface GoTargetOptions {
  /** Package name of the generated code (default "gen"). */
  package?: string;
  /** Import path of the runtime (default "yafflelang.org/go/yaffle"). */
  runtimeModule?: string;
  /** Generate lazy views (`XView`, `ViewX`; default true). */
  views?: boolean;
  /**
   * Also generate `Materialize<Root>View` per root: every field read through the view's getters
   * (the conformance view mode, docs/CONFORMANCE.md §7). Default false.
   */
  materialize?: boolean;
}

export const DEFAULT_RUNTIME = "yafflelang.org/go/yaffle";

export function generateGo(input: IrProgram, options: BackendOptions): GeneratedFile[] {
  return generateGoWithInfo(input, options).files;
}

/** Generated files plus the Go names of every root's API (the conformance harness uses them). */
export function generateGoWithInfo(
  input: IrProgram,
  options: BackendOptions
): { files: GeneratedFile[]; roots: HarnessRoot[] } {
  const model = new Model(input);
  const x = new ExprCompiler(model);
  model.normalizeTransforms((e, it) => rangeOf(x, e, it));
  const program = model.program;
  const target = (options.targetOptions ?? {}) as GoTargetOptions;
  const pkg = target.package ?? "gen";
  const views = target.views ?? true;
  const materialize = views && (target.materialize ?? false);
  const runtime = target.runtimeModule ?? DEFAULT_RUNTIME;

  const externRefs = new Map<string, ExternRef>();
  const aliases = new Map<string, string>();
  const aliasOf = (path: string): string => {
    let a = aliases.get(path);
    if (!a) aliases.set(path, (a = `ext${aliases.size + 1}`));
    return a;
  };
  for (const xt of program.externs) {
    const spec = options.externs[xt.name] ?? options.externs[xt.id];
    externRefs.set(xt.id, resolveExtern(xt, spec, aliasOf));
  }

  // Declarations name their module by path or by name; every module gets a file.
  const modules = new Map<string, string>();
  for (const m of program.modules) modules.set(m.path, m.name);
  const owner = (path: string): string => {
    if (modules.has(path)) return path;
    for (const [p, n] of modules) if (n === path) return p;
    modules.set(path, path.replace(/\.yfl$/, ""));
    return path;
  };
  for (const s of program.structs) owner(s.module);
  for (const e of program.enums) owner(e.module);
  const roots = program.roots.map(r => ({ root: r, names: rootNames(model, r) }));
  const files: GeneratedFile[] = [];
  const fileNames = new Set<string>();
  /** The first of nameFor(1), nameFor(2), … that no other file has. */
  const uniqueName = (nameFor: (i: number) => string): string => {
    let name = nameFor(1);
    for (let i = 2; fileNames.has(name); i++) name = nameFor(i);
    fileNames.add(name);
    return name;
  };
  const emitFile = (path: string, header: string, ctx: ModuleCtx, body: Code): void => {
    const out = new Code();
    out.line(header);
    out.line("");
    out.line(`package ${pkg}`);
    out.line("");
    for (const l of ctx.importBlock()) out.line(l);
    out.line("");
    for (const l of ctx.hoistedLines) out.line(l);
    out.line("");
    out.append(body);
    files.push({ path, contents: gofmt(tidy(out.toString())) });
  };

  for (const [path, mname] of modules) {
    const ctx = new ModuleCtx(model, runtime, externRefs);
    const reader = new ReadEmitter(model, x, ctx);
    const writer = new WriteEmitter(model, x, ctx);
    const json = new JsonEmitter(model);
    const api = new ApiEmitter(model, ctx, reader, writer, json);
    const viewer = new ViewEmitter(model, writer);
    reader.views = views;
    api.views = views;
    viewer.materialize = materialize;
    const body = new Code();
    const inModule = (m: string): boolean => owner(m) === path;

    for (const c of program.consts.filter(k => inModule(k.module))) {
      emitConst(body, model, c);
      body.line("");
    }
    for (const e of program.enums.filter(k => inModule(k.module))) emitEnum(body, model, e.id);
    const structs = program.structs.filter(k => inModule(k.module));
    for (const s of structs) {
      body.line("");
      emitStructType(body, model, s);
      body.line("");
      reader.emitStruct(body, s);
      body.line("");
      writer.emitStruct(body, s);
      body.line("");
      json.emitStruct(body, s);
      if (views) {
        body.line("");
        viewer.emitStruct(body, s);
      }
    }
    for (const { root, names } of roots) {
      if (!inModule(model.struct(root.struct).module)) continue;
      body.line("");
      api.emitRoot(body, root, names);
      if (materialize) {
        body.line("");
        viewer.emitRootMaterializer(body, root.struct, names.materialize);
      }
    }
    if (body.empty && !structs.length) continue;
    const file = uniqueName(i => fileName(i === 1 ? mname : `${mname}_${i}`));
    emitFile(file, `// Code generated by yaffle from ${path}. DO NOT EDIT.`, ctx, body);
  }

  // Package-wide support: unions, extern placeholders.
  const sctx = new ModuleCtx(model, runtime, externRefs);
  const sjson = new JsonEmitter(model);
  const support = new Code();
  for (const u of model.unions.values()) {
    support.line("");
    emitUnionType(support, u);
  }
  for (const [go, type] of model.unionFromJSON) {
    support.line("");
    sjson.emitUnionFromJSON(support, go, type);
  }
  for (const xt of program.externs) {
    const ref = externRefs.get(xt.id)!;
    if (!ref.missing) continue;
    support.line("");
    emitMissingExtern(support, model, xt, ref.expr);
  }
  if (!support.empty)
    emitFile("yaffle_support.go", "// Code generated by yaffle. DO NOT EDIT.", sctx, support);

  // `inlineRuntime`: the runtime's sources go into `yaffle/` next to the generated files; the
  // generated code imports it as targetOptions.runtimeModule (its import path in the user's module).
  if (options.inlineRuntime) {
    if (!target.runtimeModule) {
      throw new BackendError(
        "inlineRuntime needs targets.go.runtimeModule: the import path of the inlined runtime (<package import path>/yaffle)"
      );
    }
    files.push(...runtimeFiles());
  }

  // Extern files referenced by path become files of the package.
  const copied = new Set<string>();
  for (const ref of externRefs.values()) {
    if (!ref.file || copied.has(ref.file)) continue;
    copied.add(ref.file);
    const text = externFileContents(ref.file, pkg);
    if (text === undefined) continue;
    const base = ref.file
      .split("/")
      .pop()!
      .replace(/\.go$/, "")
      .replace(/[^A-Za-z0-9_]/g, "_");
    const name = uniqueName(i => (i === 1 ? `extern_${base}.go` : `extern_${base}_${i}.go`));
    files.push({ path: name, contents: text });
  }
  return {
    files,
    roots: roots.map(({ root, names }) => ({
      name: root.name,
      type: model.structName(root.struct),
      parse: names.parse,
      serialize: names.serialize,
      toJSON: names.toJSON,
      fromJSON: names.fromJSON,
      optionsFromJSON: names.optionsFromJSON,
      view: views ? names.view : undefined,
      materialize: materialize ? names.materialize : undefined
    }))
  };
}

/** Directory of the Go runtime's sources (packages/runtime-go). */
export function runtimeDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../../runtime-go");
}

/** The runtime's sources, for `inlineRuntime` (in `yaffle/`). */
export function runtimeFiles(): GeneratedFile[] {
  const dir = runtimeDir();
  return readdirSync(dir)
    .filter(f => f.endsWith(".go") && !f.endsWith("_test.go"))
    .sort()
    .map(f => ({ path: `yaffle/${f}`, contents: readFileSync(join(dir, f), "utf8") }));
}

/** A Go file name for a module. */
function fileName(module: string): string {
  // Go ignores files whose names start with "_" or ".".
  const base = module
    .replace(/^\/+/, "")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^_+/, "")
    .toLowerCase();
  // A name ending in _test or in a GOOS/GOARCH suffix would be a test file or build-constrained.
  const special = new RegExp(`_(test|${GO_OS_ARCH.join("|")})$`);
  return `${base || "module"}${special.test(base) ? "_yfl" : ""}.go`;
}

const GO_OS_ARCH = (
  "aix android darwin dragonfly freebsd hurd illumos ios js linux nacl netbsd openbsd plan9 " +
  "solaris wasip1 windows zos 386 amd64 amd64p32 arm armbe arm64 arm64be loong64 mips mipsle " +
  "mips64 mips64le mips64p32 mips64p32le ppc ppc64 ppc64le riscv riscv64 s390 s390x sparc " +
  "sparc64 wasm"
).split(" ");

/** Collapses blank-line runs and trailing whitespace. */
function tidy(s: string): string {
  return (
    s
      .split("\n")
      .map(l => l.replace(/[ \t]+$/, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\{\n\n/g, "{\n")
      .replace(/\n\n(\t*\})/g, "\n$1")
      .trimEnd() + "\n"
  );
}

/** The value range of a transform's read expression (fields and parameters at their full range). */
function rangeOf(x: ExprCompiler, e: IrExpr, it: IrValueType): [bigint, bigint] | undefined {
  const stub = (t: IrValueType): CExpr => x.typed("x", t);
  const ctx: ExprCtx = {
    mode: "read",
    field: (_n, t) => stub(t),
    param: (_n, t) => stub(t),
    it: () => stub(it),
    lambda: () => "x",
    builtin: () => "x",
    sizeof: () => "x",
    offsetof: () => "x",
    encodedSize: () => "x",
    bytesof: () => "x",
    encode: () => "x",
    externFn: () => "x",
    hoist: () => "x",
    use: () => {},
    fieldType: () => undefined
  };
  return x.compile(e, ctx).range;
}

export const goBackend: Backend = {
  name: "go",
  generate(program: IrProgram, options: BackendOptions): GeneratedFile[] {
    return generateGo(program, options);
  }
};
