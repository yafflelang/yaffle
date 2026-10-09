/**
 * Sample files: decoding a sample with a root struct, through the TS backend
 * and runtime in-process.
 *
 * The program is compiled with the chosen struct as a root, generated with the TS backend into a
 * temporary directory (types stripped when Node can), imported, and opened as a lazy *view*
 * (`@yaffle/runtime` views read only what is touched and record every field's byte range). The
 * walk below annotates the fields of struct instances declared in the source file, forcing only
 * what leads to such instances, with caps on array elements and annotations, so huge files
 * (a 120 MB archive) cost what their headers cost.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as runtime from "@yaffle/runtime";
import { typeName } from "../backends/ts/code.ts";
import { generateTs } from "../backends/ts/index.ts";
import { moduleFile } from "../backends/ts/module.ts";
import { fieldRefs, walkExpr } from "../ir/walk.ts";
import { runFrontend } from "../frontend/program.ts";
import type { FieldSym, StructSym } from "../frontend/symbols.ts";
import { joinPath, normalizePath } from "../frontend/util.ts";
import type { IrBitField, IrField, IrMember, IrProgram, IrStruct, IrType } from "../ir/index.ts";
import { printArraySuffix, printExpr, printTypeRef } from "../frontend/printer.ts";
import type { Range, RootParameter, SampleAnnotation } from "./api.ts";
import type { Analysis, Workspace } from "./analysis.ts";

// ── loading generated code ─────────────────────────────────────────────────────

const RUNTIME_GLOBAL = "__yaffleServiceRuntime";

type Namespace = Record<string, unknown>;

/** The view entry point of a generated root API. */
interface RootApi {
  view(bytes: Uint8Array, options?: object): object;
  optionsFromJson(json: unknown): object;
}

/**
 * Generated code, loaded once per distinct program. Every program gets a directory under one
 * temporary directory per service, removed by `dispose`. Generated modules import the runtime
 * through a shim that re-exports the service's own runtime instance.
 */
export class GeneratedCode {
  private dir: string | undefined;
  private readonly loaded = new Map<string, Promise<Namespace>>();
  /** Removes the directory when the process exits without `dispose`. */
  private readonly onExit = () => this.dispose();

  private root(): string {
    if (!this.dir) {
      this.dir = mkdtempSync(join(tmpdir(), "yaffle-samples-"));
      process.once("exit", this.onExit);
      (globalThis as Record<string, unknown>)[RUNTIME_GLOBAL] = runtime;
      const names = Object.keys(runtime).filter(n => /^[A-Za-z_$][\w$]*$/.test(n));
      writeFileSync(
        join(this.dir, "runtime.mjs"),
        `const rt = globalThis[${JSON.stringify(RUNTIME_GLOBAL)}];\nexport const { ${names.join(", ")} } = rt;\n`
      );
    }
    return this.dir;
  }

  /** Generates, writes and imports `program`; resolves to the namespace of `module`'s file. */
  load(program: IrProgram, externs: Record<string, string>, module: string): Promise<Namespace> {
    const dir = this.root();
    // the backend normalizes the program it is given (layouts move into its own tables)
    const files = generateTs(structuredClone(program), {
      externs,
      targetOptions: { runtimeModule: pathToFileURL(join(dir, "runtime.mjs")).href }
    });
    const hash = createHash("sha256");
    for (const f of files) hash.update(f.path).update("\0").update(f.contents).update("\0");
    const key = hash.digest("hex").slice(0, 16);
    const mod = program.modules.find(m => m.path === module || m.name === module);
    const entry = moduleFile(mod ? mod.name : module.replace(/\.yfl$/, ""));
    const cacheKey = `${key}:${entry}`;
    let hit = this.loaded.get(cacheKey);
    if (!hit) {
      hit = this.write(join(dir, key), files, entry);
      this.loaded.set(cacheKey, hit);
      hit.catch(() => this.loaded.delete(cacheKey));
    }
    return hit;
  }

  /**
   * Writes the generated TypeScript and imports it (Node strips the types). Where Node can't
   * import TypeScript, the types are stripped here (`module.stripTypeScriptTypes`) into `.mjs`.
   */
  private async write(
    out: string,
    files: { path: string; contents: string }[],
    entry: string
  ): Promise<Namespace> {
    for (const f of files) {
      const p = join(out, f.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.contents);
    }
    try {
      return (await import(pathToFileURL(join(out, entry)).href)) as Namespace;
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      const strip = (
        nodeModule as { stripTypeScriptTypes?: (code: string, options?: object) => string }
      ).stripTypeScriptTypes;
      if (code !== "ERR_UNKNOWN_FILE_EXTENSION" && !(e instanceof SyntaxError)) throw e;
      if (!strip)
        throw new Error("this needs Node.js 22.13 or later (TypeScript type stripping)", {
          cause: e
        });
      const js = join(out, "js");
      const mjs = (p: string) => p.replace(/\.ts$/, ".mjs");
      for (const f of files) {
        const p = join(js, mjs(f.path));
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(
          p,
          strip(f.contents, { mode: "strip" }).replace(
            /(from\s+")(\.{1,2}\/[^"]*?)\.ts(")/g,
            (_m, a: string, b: string, c: string) => `${a}${b}.mjs${c}`
          )
        );
      }
      return (await import(pathToFileURL(join(js, mjs(entry))).href)) as Namespace;
    }
  }

  dispose(): void {
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    process.removeListener("exit", this.onExit);
    this.dir = undefined;
    this.loaded.clear();
  }
}

// ── compiling the sample's program ─────────────────────────────────────────────

export interface SampleProgram {
  program: IrProgram;
  /** IR struct name → struct. */
  structs: Map<string, IrStruct>;
  /** IR module path → absolute path. */
  modulePath: (irModule: string) => string;
  root: IrStruct;
  api: RootApi;
  /** IR struct name → the analysis' symbol (declaration spans), when found. */
  syms: Map<string, StructSym>;
}

/** Compiles `path` with `root` as a root, loads the generated code. Throws user-facing errors. */
export async function loadSample(
  ws: Workspace,
  code: GeneratedCode,
  path: string,
  root: StructSym
): Promise<SampleProgram> {
  const file = normalizePath(path);
  const rootFile = normalizePath(root.module.path);
  const result = runFrontend(
    [...new Set([file, rootFile])],
    { readFile: p => ws.readFile(p), fileExists: p => ws.fileExists(p) },
    {
      parseCache: ws.cache,
      extraRoots: [{ path: rootFile, name: root.name }],
      ...(ws.project ? { targets: ws.project.config.targets } : {})
    }
  );
  const name = file.split(/[\\/]/).pop() ?? file;
  if (!result.program || result.hasErrors) {
    const first = result.diagnostics.find(d => d.severity === "error");
    throw new Error(
      `${root.name} can't be decoded on its own${first ? `: ${first.message}` : "."}`
    );
  }
  const program = result.program;
  const byIrPath = new Map(result.modules.map(m => [m.irPath, m.path]));
  const modulePath = (m: string) => byIrPath.get(m) ?? m;
  const irRoot = program.roots.find(
    r => r.name === root.name && normalizePath(modulePath(r.module)) === rootFile
  );
  const structs = new Map(program.structs.map(s => [s.name, s]));
  const rootStruct = irRoot ? program.structs.find(s => s.id === irRoot.struct) : undefined;
  if (!irRoot || !rootStruct) throw new Error(`${root.name} in ${name} isn't a root struct.`);
  const externs: Record<string, string> = {};
  const ts = ws.project?.config.targets?.ts?.externs ?? {};
  for (const [n, spec] of Object.entries(ts)) {
    const hash = spec.lastIndexOf("#");
    const fileSpec = hash > 0 ? spec.slice(0, hash) : spec;
    const item = hash > 0 ? spec.slice(hash) : "";
    externs[n] =
      ws.project && /^\.\.?[\\/]/.test(fileSpec)
        ? pathToFileURL(joinPath(ws.project.rootDir, fileSpec)).href + item
        : spec;
  }
  let ns: Namespace;
  try {
    ns = await code.load(program, externs, rootStruct.module);
  } catch (e) {
    throw new Error(
      `Loading the code generated for ${name} failed: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e }
    );
  }
  const api = ns[typeName(irRoot.name)] as RootApi | undefined;
  if (!api || typeof api.view !== "function")
    throw new Error(`The code generated for ${name} has no entry point for ${root.name}.`);
  // IR structs → declarations (for field ranges, bitfields included)
  const syms = new Map<string, StructSym>();
  const byKey = new Map<string, StructSym>();
  for (const m of result.modules) {
    const visit = (s: StructSym) => {
      const p = m.file.positionAt(s.decl.span.start);
      byKey.set(`${normalizePath(m.path)}:${p.line}:${p.character}`, s);
      for (const d of s.nested.values()) if (d.kind === "struct") visit(d);
    };
    for (const d of m.decls.values()) if (d.kind === "struct") visit(d);
  }
  for (const s of program.structs) {
    const k = `${normalizePath(modulePath(s.module))}:${s.source.start.line}:${s.source.start.character}`;
    const sym = byKey.get(k);
    if (sym) syms.set(s.name, sym);
  }
  return { program, structs, modulePath, root: rootStruct, api, syms };
}

/**
 * The view options for root arguments (canonical JSON, docs/CONFORMANCE.md §3). Throws a
 * user-facing error for arguments the generated code rejects or doesn't know.
 */
export function sampleOptions(sp: SampleProgram, args: Record<string, unknown> = {}): object {
  const known = new Set(
    sp.root.params.filter(p => p.origin !== "outer").map(p => p.boundName ?? p.name)
  );
  for (const k of Object.keys(args))
    if (!known.has(k))
      throw new Error(
        `${sp.root.name} has no parameter \`${k}\`${known.size > 1 ? ` (parameters: ${[...known].filter(n => n !== "endian").join(", ")})` : ""}.`
      );
  try {
    return sp.api.optionsFromJson(args);
  } catch (e) {
    throw new Error(`Invalid root arguments: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e
    });
  }
}

/** The parameters of a root struct, for clients asking the user for arguments. */
export function rootParameters(an: Analysis, s: StructSym): RootParameter[] {
  const out: RootParameter[] = [];
  for (const p of s.params) {
    const t = an.el.paramValueType(an.el.ctxForOwner(p.owner), p);
    const d = p.decl;
    const type = (d.type ? printTypeRef(d.type) : "?") + d.arrays.map(printArraySuffix).join("");
    const rp: RootParameter = {
      name: p.name,
      label: (p.bound ? "$" : "") + p.name,
      type,
      kind: "other",
      optional: !!d.default
    };
    if (d.default) rp.defaultText = printExpr(d.default);
    switch (t.kind) {
      case "int":
        rp.kind = "int";
        rp.bits = t.bits;
        rp.signed = t.signed;
        break;
      case "float":
        rp.kind = "float";
        break;
      case "bool":
        rp.kind = "bool";
        break;
      case "string":
        rp.kind = "string";
        break;
      case "bytes": {
        rp.kind = "bytes";
        const len = d.arrays.length === 1 ? d.arrays[0]!.expr : undefined;
        if (len && len.kind === "Int") rp.length = Number(len.value);
        break;
      }
      case "enum": {
        rp.kind = "enum";
        const e = an.el.enumsById.get(t.enum);
        if (e) rp.members = e.members.map(m => m.name);
        break;
      }
      default:
        break;
    }
    out.push(rp);
  }
  return out;
}

// ── IR helpers ─────────────────────────────────────────────────────────────────

type AnyField = IrField | (IrBitField & { name: string });

/** Every named field of a struct's members (blocks, switches and bits flattened). */
export function structFields(members: IrMember[]): AnyField[] {
  const out: AnyField[] = [];
  const visit = (ms: IrMember[]) => {
    for (const m of ms) {
      if (m.kind === "field") out.push(m);
      else if (m.kind === "block") {
        visit(m.members);
        if (m.else) visit(m.else);
      } else if (m.kind === "switch") {
        for (const c of m.cases) visit(c.members);
        if (m.default) visit(m.default);
      } else if (m.kind === "bits") {
        for (const f of m.fields) if (f.name) out.push(f as IrBitField & { name: string });
      }
    }
  };
  visit(members);
  return out;
}

/** The type without transforms and layers. */
export function bareType(t: IrType): IrType {
  while (t.kind === "transform" || t.kind === "layered") t = t.inner;
  return t;
}

/** Struct ids a type contains (inline, elements, pointer targets, union variants). */
function typeStructs(t: IrType, out: Set<string>): void {
  const b = bareType(t);
  switch (b.kind) {
    case "struct":
      out.add(b.struct);
      break;
    case "array":
      typeStructs(b.element, out);
      break;
    case "pointer":
      typeStructs(b.target, out);
      break;
    case "union":
      for (const v of b.variants) typeStructs(v.type, out);
      break;
    default:
      break;
  }
}

/** Ids of the structs whose instances can contain an instance of a struct in `wanted`. */
export function structsReaching(program: IrProgram, wanted: Set<string>): Set<string> {
  const deps = new Map<string, Set<string>>();
  for (const s of program.structs) {
    const set = new Set<string>();
    for (const f of structFields(s.members)) typeStructs(f.type, set);
    deps.set(s.id, set);
  }
  const out = new Set(wanted);
  for (let changed = true; changed;) {
    changed = false;
    for (const [id, set] of deps) {
      if (out.has(id)) continue;
      if ([...set].some(d => out.has(d))) {
        out.add(id);
        changed = true;
      }
    }
  }
  return out;
}

/** Fields shown in hex as well: offsets, sizes and anything used to place or size something. */
function addressLike(s: IrStruct): Set<string> {
  const out = new Set<string>();
  const note = (e: Parameters<typeof fieldRefs>[0]) => {
    for (const r of fieldRefs(e)) out.add(r);
  };
  const visitType = (t: IrType) => {
    let cur: IrType = t;
    for (;;) {
      if (cur.kind === "layered") {
        for (const l of cur.layers) if (l.kind === "size") note(l.size);
        cur = cur.inner;
      } else if (cur.kind === "transform") cur = cur.inner;
      else break;
    }
  };
  for (const f of structFields(s.members)) {
    if ("placement" in f && f.placement) note(f.placement.offset);
    if ("type" in f) visitType(f.type);
    if (f.derive) {
      walkExpr(f.derive, e => {
        if (
          e.kind === "call" &&
          e.callee.kind === "builtin" &&
          ["offsetof", "sizeof", "encodedSize", "bytesof"].includes(e.callee.name)
        )
          out.add(f.name);
      });
    }
    if (/(ofs|offset|size|addr|ptr|pos)$/i.test(f.name)) out.add(f.name);
  }
  return out;
}

// ── rendering values ───────────────────────────────────────────────────────────

const MAX_STRING = 40;
const MAX_INLINE_ITEMS = 6;

function hex(n: number | bigint): string {
  return "0x" + n.toString(16);
}

function quote(s: string): string {
  const q = JSON.stringify(s.length > MAX_STRING ? s.slice(0, MAX_STRING) : s);
  return s.length > MAX_STRING ? q.slice(0, -1) + '…"' : q;
}

function renderNumber(v: number | bigint, t: IrType | undefined, addr: boolean): string {
  const b = t ? bareType(t) : undefined;
  if (typeof v === "number" && !Number.isInteger(v)) {
    const digits =
      b?.kind === "prim" && b.prim === "f16" ? 4 : b?.kind === "prim" && b.prim === "f32" ? 7 : 15;
    return String(Number(v.toPrecision(digits)));
  }
  if (typeof v === "number" && b?.kind === "prim" && b.prim.startsWith("f")) return String(v);
  const big = typeof v === "bigint" ? v : BigInt(v);
  if (addr && (big >= 10n || big <= -10n))
    return `${big} (${big < 0n ? "-" + hex(-big) : hex(big)})`;
  return String(big);
}

function renderBytes(b: Uint8Array): string {
  const head = Array.from(b.subarray(0, 8), x => x.toString(16).padStart(2, "0")).join(" ");
  return `[${b.length} bytes]${b.length ? " " + head + (b.length > 8 ? " …" : "") : ""}`;
}

/** A short rendering of a decoded value (views are not forced beyond their length). */
function renderValue(v: unknown, t: IrType | undefined, addr: boolean): string {
  if (v === null) return "null";
  if (v === undefined) return "—";
  if (typeof v === "number" || typeof v === "bigint") return renderNumber(v, t, addr);
  if (typeof v === "boolean") return String(v);
  if (typeof v === "string") {
    const b = t ? bareType(t) : undefined;
    return b?.kind === "enum" ? v : quote(v);
  }
  if (v instanceof Uint8Array) return renderBytes(v);
  const node = runtime.nodeOf(v);
  if (node instanceof runtime.ArrayNode) {
    const n = node.length;
    if (n === 0) return "[]";
    const el = t ? bareType(t) : undefined;
    const elemType = el?.kind === "array" ? el.element : undefined;
    const eb = elemType ? bareType(elemType) : undefined;
    const scalar =
      eb &&
      (eb.kind === "prim" || eb.kind === "bool" || eb.kind === "enum" || eb.kind === "string");
    if (scalar && n <= MAX_INLINE_ITEMS) {
      const items: string[] = [];
      for (let i = 0; i < n; i++) items.push(renderValue(node.get(i), elemType, false));
      const s = `[${items.join(", ")}]`;
      if (s.length <= 60) return s;
    }
    return `[${n} item${n === 1 ? "" : "s"}]`;
  }
  if (node instanceof runtime.StructNode) return `${node.info.name} {…}`;
  if (typeof v === "object") {
    const u = v as { type?: unknown; value?: unknown };
    if (typeof u.type === "string" && "value" in u) return `${u.type} {…}`;
    if (Array.isArray(v)) return `[${v.length} items]`;
    return "{…}";
  }
  return String(v);
}

// ── walking a view ─────────────────────────────────────────────────────────────

/** Accesses a view value, completing async codec work (`NeedAsync`) as needed. */
export async function access<T>(f: () => T): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return f();
    } catch (e) {
      if (e instanceof runtime.NeedAsync && i < 64) {
        await e.run();
        continue;
      }
      throw e;
    }
  }
}

/** Where `[start, end)` of `space` is in the sample file (codec output maps to its encoded bytes). */
function fileSpan(
  space: runtime.Space,
  start: number,
  end: number
): { offset: number; size: number; inFile: boolean } {
  let s = space;
  let a = start;
  let b = end;
  let inFile = true;
  while (s.decoded) {
    a = s.decoded.start;
    b = s.decoded.end;
    s = s.decoded.parent;
    inFile = false;
  }
  if (s !== s.root.space) return { offset: start, size: end - start, inFile: false };
  return { offset: a, size: b - a, inFile };
}

interface DecodeLimits {
  /** Annotations returned at most. */
  maxAnnotations: number;
  /** Elements of one array walked into (for struct elements). */
  maxElements: number;
  /** Struct instances visited at most. */
  maxNodes: number;
}

const DEFAULT_LIMITS: DecodeLimits = {
  maxAnnotations: 5000,
  maxElements: 64,
  maxNodes: 20000
};

/** Decodes `bytes` with the sample program's root; annotates fields declared in `sourcePath`. */
export async function decodeWithSample(
  sp: SampleProgram,
  sourcePath: string,
  bytes: Uint8Array,
  limits: DecodeLimits = DEFAULT_LIMITS,
  args?: Record<string, unknown>
): Promise<SampleAnnotation[]> {
  const file = normalizePath(sourcePath);
  const inSource = new Set(
    sp.program.structs.filter(s => normalizePath(sp.modulePath(s.module)) === file).map(s => s.id)
  );
  const reaching = structsReaching(sp.program, inSource);
  const fieldsOf = new Map<string, Map<string, AnyField>>();
  const addrOf = new Map<string, Set<string>>();
  for (const s of sp.program.structs) {
    fieldsOf.set(s.name, new Map(structFields(s.members).map(f => [f.name, f])));
    addrOf.set(s.name, addressLike(s));
  }
  const rangeCache = new Map<FieldSym | undefined, Range | undefined>();
  const fieldRange = (s: IrStruct, name: string): { path: string; range: Range } | undefined => {
    const sym = sp.syms.get(s.name);
    const f = sym?.fieldsByName.get(name)?.[0];
    if (!sym || !f) return undefined;
    let r = rangeCache.get(f);
    if (!r) {
      r = f.module.file.rangeOf(f.decl.span);
      rangeCache.set(f, r);
    }
    return { path: f.module.path, range: r };
  };

  const view = sp.api.view(bytes, sampleOptions(sp, args));
  const out: SampleAnnotation[] = [];
  const seen = new Set<runtime.StructNode>();
  // breadth first: instances near the root first, so the caps cut the deepest ones
  const queue: runtime.StructNode[] = [];
  let nodes = 0;
  const full = () => out.length >= limits.maxAnnotations || nodes >= limits.maxNodes;

  const wanted = (t: IrType): boolean => {
    const ids = new Set<string>();
    typeStructs(t, ids);
    return [...ids].some(id => reaching.has(id));
  };

  /** Queues the struct instances inside a value (elements capped). */
  const enqueue = async (v: unknown, t: IrType | undefined): Promise<void> => {
    if (v === null || typeof v !== "object") return;
    const n = runtime.nodeOf(v);
    if (n instanceof runtime.StructNode) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
      return;
    }
    if (n instanceof runtime.ArrayNode) {
      const b = t ? bareType(t) : undefined;
      const elem = b?.kind === "array" ? b.element : undefined;
      if (!elem || !wanted(elem)) return;
      const count = Math.min(n.length, limits.maxElements);
      for (let i = 0; i < count; i++) {
        let el: unknown;
        try {
          el = await access(() => n.get(i));
        } catch {
          continue;
        }
        await enqueue(el, elem);
      }
      return;
    }
    const u = v as { type?: unknown; value?: unknown };
    if (typeof u.type === "string" && "value" in u && t) {
      const b = bareType(t);
      const variant = b.kind === "union" ? b.variants.find(x => x.name === u.type) : undefined;
      await enqueue(u.value, variant?.type);
    }
  };

  const visitNode = async (node: runtime.StructNode): Promise<void> => {
    nodes++;
    const s = sp.structs.get(node.info.name);
    if (!s || !reaching.has(s.id)) return;
    const annotate = inSource.has(s.id);
    const fields = fieldsOf.get(s.name)!;
    const addr = addrOf.get(s.name)!;
    let keys: string[];
    try {
      keys = await access(() => node.keys());
    } catch (e) {
      if (annotate) {
        const first = [...fields.keys()][0];
        const fr = first ? fieldRange(s, first) : undefined;
        if (fr) out.push({ ...fr, value: `⚠ ${errorText(e)}`, offset: node.pos, size: 0 });
      }
      return;
    }
    for (const [name, f] of fields) {
      if (full()) return;
      const type = "type" in f ? f.type : undefined;
      if (!keys.includes(name)) continue;
      const placement = "placement" in f ? f.placement : undefined;
      const raw = node.peek(name);
      const pointer = type && bareType(type).kind === "pointer";
      const target = runtime.isLazy(raw) ? raw.target : undefined;
      if (annotate) {
        const fr = fieldRange(s, name);
        if (fr) {
          let value: string;
          let span = node.range(name);
          let space = node.space;
          try {
            const v = await access(() => node.get(name));
            if (pointer && target) {
              const tv = runtime.nodeOf(v);
              const what =
                tv instanceof runtime.StructNode
                  ? tv.info.name
                  : renderValue(v, (bareType(type) as { target: IrType }).target, false);
              value = `→ ${what} @${hex(target.addr)}`;
            } else value = renderValue(v, type, addr.has(name));
            if (placement && target) {
              span = [target.addr, target.addr + (target.size ?? 0)];
              space = target.space;
            }
          } catch (e) {
            value = `⚠ ${errorText(e)}`;
          }
          const where = span ? fileSpan(space, span[0], span[1]) : undefined;
          out.push({
            ...fr,
            value: where && !where.inFile ? `${value} (decoded)` : value,
            offset: where?.offset ?? node.pos,
            size: where?.size ?? 0
          });
        }
      }
      if (type && wanted(type)) {
        try {
          await enqueue(await access(() => node.get(name)), type);
        } catch {
          // shown as ⚠ above when annotated
        }
      }
    }
  };

  await enqueue(view, undefined);
  while (queue.length && !full()) await visitNode(queue.shift()!);
  return out;
}

function errorText(e: unknown): string {
  if (e instanceof runtime.YaffleError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
