/**
 * View descriptor emitter: `$view_X` per struct, what the runtime's lazy views need (scan
 * function, static size, which fields can be patched in place, which are structural).
 */
import type { IrExpr, IrStruct } from "../../ir/index.ts";
import { Code, propKey, str } from "./code.ts";
import {
  allMembers,
  forEachDerive,
  forEachLayoutArg,
  forEachReadExpr,
  someExpr,
  walkExpr,
  type Model
} from "./model.ts";
import type { ModuleCtx } from "./module.ts";
import type { WriteEmitter } from "./write.ts";

/** Calls `f` with the name of every field `e` reads. */
function forEachFieldRef(e: IrExpr, f: (name: string) => void): void {
  walkExpr(e, x => {
    if (x.kind === "field") f(x.name);
  });
}

export class ViewEmitter {
  readonly model: Model;
  readonly mod: ModuleCtx;
  readonly writer: WriteEmitter;
  constructor(model: Model, mod: ModuleCtx, writer: WriteEmitter) {
    this.model = model;
    this.mod = mod;
    this.writer = writer;
  }

  /**
   * Fields that read-side expressions (other than their own checks) or layout items depend on:
   * setting one changes the structure.
   */
  structuralFields(s: IrStruct): Set<string> {
    const out = new Set<string>();
    const add = (e: IrExpr): void => forEachFieldRef(e, n => out.add(n));
    // A field's own checks only validate it; checks that mention other fields count.
    const own = new Map<string, Set<IrExpr>>();
    for (const m of allMembers(s.members)) {
      if (m.kind === "field") own.set(m.name, new Set(m.checks.map(c => c.expr)));
    }
    const allOwn = new Set<IrExpr>();
    for (const set of own.values()) for (const e of set) allOwn.add(e);
    forEachReadExpr(s, e => {
      if (!allOwn.has(e)) add(e);
    });
    for (const [name, set] of own) {
      for (const e of set) {
        forEachFieldRef(e, n => {
          if (n !== name) out.add(n);
        });
      }
    }
    if (s.layout) forEachLayoutArg(s.layout, add);
    return out;
  }

  /** Fields that some derive expression references. */
  derivedFrom(s: IrStruct): Set<string> {
    const out = new Set<string>();
    forEachDerive(s.members, e => forEachFieldRef(e, n => out.add(n)));
    return out;
  }

  /** No derive depends on the content of inline children (checksums, member access, externs). */
  childSafe(s: IrStruct): boolean {
    let safe = true;
    forEachDerive(s.members, e => {
      if (safe && someExpr(e, readsContent)) safe = false;
    });
    return safe;
  }

  emitStruct(code: Code, s: IrStruct): void {
    const name = this.model.structName(s.id);
    const structural = this.structuralFields(s);
    const derived = this.derivedFrom(s);
    const size = s.base ? undefined : this.model.structStaticSize(s.id);
    const fields: string[] = [];
    const encoders: string[] = [];
    for (const f of this.model.fields(s)) {
      const output = f.field ? f.field.output : f.bit!.output;
      if (!output) continue;
      const input = f.field ? f.field.input : f.bit!.input;
      const enc = input === "absent" ? undefined : this.writer.encoderFor(s, f.name);
      const patch = enc !== undefined && !derived.has(f.name);
      fields.push(
        `${propKey(f.name)}: { input: ${str(input)}, patch: ${patch}, structural: ${structural.has(f.name)} }`
      );
      if (enc && patch) encoders.push(`${propKey(f.name)}: ${enc.replace(/\n/g, "\n    ")}`);
    }
    code.line(`/** View descriptor of ${s.name} (lazy views, in-place patches). */`);
    code.block(
      `export const $view_${name}: $rt.StructInfo =`,
      () => {
        code.line(`name: ${str(s.name)},`);
        code.line(`key: ${str(this.model.typeKey({ kind: "struct", struct: s.id, args: [] }))},`);
        code.line(`scan: scan_${name},`);
        code.line(`staticSize: ${size ?? "undefined"},`);
        code.line(`base: ${s.base},`);
        code.line(`childSafe: ${this.childSafe(s)},`);
        // A base struct's region (targets included) is measured with the eager reader.
        if (s.base && !s.async) code.line(`measure: ${this.mod.structFn(s.id, "read")},`);
        code.block(
          "fields:",
          () => {
            for (const f of fields) code.line(`${f},`);
          },
          ","
        );
        code.block("encode:", () => {
          for (const e of encoders) code.line(`${e},`);
        });
      },
      ";"
    );
  }
}

/** Expressions that look into values: member access, indexing, checksums, encodings, externs. */
function readsContent(x: IrExpr): boolean {
  if (x.kind === "member" || x.kind === "index" || x.kind === "map") return true;
  if (x.kind !== "call") return false;
  return (
    x.callee.kind === "extern" || ["bytesof", "encode", "crc32", "adler32"].includes(x.callee.name)
  );
}
