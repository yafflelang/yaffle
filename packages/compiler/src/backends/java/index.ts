/**
 * Java backend: IR → Java 21 sources (one file per struct, enum and union type, in one package),
 * with typed readers, writers, canonical JSON converters, views and the root API. See
 * docs/targets/java.md.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IrProgram, IrRoot } from "../../ir/index.ts";
import type { Backend, BackendOptions, GeneratedFile } from "../backend.ts";
import { ClassEmitter } from "./classes.ts";
import type { ExternRef } from "./ctx.ts";
import { Model, RUNTIME_PACKAGE } from "./model.ts";

export interface JavaTargetOptions {
  /** Java package of the generated classes (default "yaffle.gen"). */
  package?: string;
  /** Directory relative extern paths are resolved against (default: see `locate`). */
  externsRoot?: string;
}

export const DEFAULT_PACKAGE = "yaffle.gen";

/** A host source file the generated code needs (copied into the output). */
interface ExternSource {
  /** Output path (package directories + class name). */
  path: string;
  contents: string;
  /** Fully qualified class name. */
  cls: string;
}

/** Parses the package and public top-level class of a Java source. */
function javaClassOf(source: string): { pkg: string; cls: string } {
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(source)?.[1] ?? "";
  const cls =
    /^\s*public\s+(?:(?:final|abstract|sealed|non-sealed|strictfp)\s+)*(?:class|interface|enum|record)\s+(\w+)/m.exec(
      source
    )?.[1];
  if (!cls) throw new Error("extern source has no public top-level class");
  return { pkg, cls };
}

/**
 * Finds an extern source file. `yaffle build` passes paths relative to the output directory,
 * which backends don't receive: such a path is tried against `root` (targets.java.externsRoot),
 * then with its leading `../` segments dropped, against the current directory, its ancestors and
 * the filesystem root.
 */
function locate(path: string, root: string | undefined): string {
  if (isAbsolute(path)) return path;
  const direct = resolve(root ?? process.cwd(), path);
  if (existsSync(direct) || root) return direct;
  const rest = path.replace(/^(\.\.?\/)+/, "");
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const p = join(dir, rest);
    if (existsSync(p)) return p;
    if (dirname(dir) === dir) break;
  }
  return direct;
}

/**
 * Resolves `targets.java.externs` specs:
 * - `path/to/file.java[#ITEM]`: the file is copied into the output under its public class's
 *   name; ITEM (default: the extern's name) is the static method (fn) or field (codec, type);
 * - `com.example.Host[#ITEM]`: a class on the classpath.
 */
function resolveExterns(
  specs: Record<string, string>,
  root?: string
): { refs: Record<string, ExternRef>; sources: ExternSource[] } {
  const refs: Record<string, ExternRef> = {};
  const sources = new Map<string, ExternSource>();
  for (const [name, spec] of Object.entries(specs)) {
    const hash = spec.lastIndexOf("#");
    const target = hash > 0 ? spec.slice(0, hash) : spec;
    const item = hash > 0 ? spec.slice(hash + 1) : name;
    if (!target.endsWith(".java")) {
      refs[name] = { cls: target, item };
      continue;
    }
    const file = locate(target, root);
    let src = sources.get(file);
    if (!src) {
      if (!existsSync(file)) throw new Error(`extern ${name}: ${file} does not exist`);
      const contents = readFileSync(file, "utf8");
      const { pkg, cls } = javaClassOf(contents);
      src = {
        path: `${pkg ? pkg.replace(/\./g, "/") + "/" : ""}${cls}.java`,
        contents,
        cls: pkg ? `${pkg}.${cls}` : cls
      };
      sources.set(file, src);
    }
    refs[name] = { cls: src.cls, item };
  }
  return { refs, sources: [...sources.values()] };
}

export function generateJava(input: IrProgram, options: BackendOptions): GeneratedFile[] {
  const target = (options.targetOptions ?? {}) as JavaTargetOptions;
  const pkg = target.package ?? DEFAULT_PACKAGE;
  const model = new Model(input, pkg);
  const { refs, sources } = resolveExterns(options.externs, target.externsRoot);
  const emit = new ClassEmitter(model, refs);
  const dir = pkg ? pkg.replace(/\./g, "/") + "/" : "";
  // A struct exported under several names gets the root API once.
  const roots = new Map<string, IrRoot>();
  for (const r of model.program.roots) if (!roots.has(r.struct)) roots.set(r.struct, r);
  const files = [
    ...model.program.structs.map(s => emit.struct(s, roots.get(s.id))),
    ...model.program.enums.map(e => emit.enumFile(e)),
    ...[...model.unions.values()].map(u => emit.unionFile(u))
  ].map(f => ({ path: `${dir}${f.name}.java`, contents: f.contents }));
  files.push(...sources.map(s => ({ path: s.path, contents: s.contents })));
  if (options.inlineRuntime) files.push(...runtimeFiles());
  return files;
}

/** The runtime's source files (for `inlineRuntime`). */
function runtimeFiles(): GeneratedFile[] {
  const dir = runtimeSourceDir();
  const pkgDir = RUNTIME_PACKAGE.replace(/\./g, "/");
  return readdirSync(dir)
    .filter(f => f.endsWith(".java"))
    .map(f => ({ path: `${pkgDir}/${f}`, contents: readFileSync(join(dir, f), "utf8") }));
}

/** Directory of the runtime's Java sources. */
export function runtimeSourceDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/compiler/src/backends/java → packages/runtime-java/src/main/java/org/yafflelang/runtime
  return join(here, "../../../../runtime-java/src/main/java", RUNTIME_PACKAGE.replace(/\./g, "/"));
}

export const javaBackend: Backend = {
  name: "java",
  generate: generateJava
};
