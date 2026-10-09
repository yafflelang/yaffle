/**
 * Per-generated-class bookkeeping: names of runtime/JDK classes, hoisted static constants
 * (regexes, byte literals, big integers, layouts) and references to extern implementations.
 */
import { str } from "./code.ts";
import type { CExpr, ExprCtx } from "./expr.ts";
import type { Model } from "./model.ts";

/** How generated code reaches one extern's host implementation. */
export interface ExternRef {
  /** Fully qualified host class. */
  cls: string;
  /** Static member: the method (fn) or field (codec, type). */
  item: string;
}

export class ClassCtx {
  readonly model: Model;
  /** Runtime and JDK names the class uses (they are imported unless shadowed). */
  readonly used = new Set<string>();
  readonly hoistedLines: string[] = [];
  private readonly hoisted = new Map<string, string>();
  private readonly externs: Record<string, ExternRef>;
  private readonly externLocals = new Map<string, string>();

  constructor(model: Model, externs: Record<string, ExternRef>) {
    this.model = model;
    this.externs = externs;
  }

  /** A runtime or JDK class name. */
  use(n: string): string {
    this.used.add(n);
    return this.model.isJdk(n) ? this.model.jdk(n) : this.model.rt(n);
  }

  /** Hoists `code` into a `private static final` constant and returns its name. */
  hoist(code: string, type: string, hint: string): string {
    const key = `${type}|${code}`;
    const hit = this.hoisted.get(key);
    if (hit) return hit;
    const name = `$${hint}${this.hoisted.size + 1}`;
    this.hoisted.set(key, name);
    this.hoistedLines.push(`private static final ${type} ${name} = ${code};`);
    return name;
  }

  /** `code` (an Object) as a value of Java type `javaType` (boxed; generic types unchecked). */
  castFromObject(javaType: string, code: string): string {
    if (javaType.includes("<")) return `${this.use("Rt")}.cast(${code})`;
    if (javaType === this.model.lang("Object")) return code;
    return `(${this.model.boxedOf(javaType)}) ${code}`;
  }

  private externRef(id: string): ExternRef | undefined {
    return this.externs[this.model.extern(id).name] ?? this.externs[id];
  }

  /** Code calling an extern fn's host method: `Host.method(args)`. */
  externCall(id: string, args: string[]): string {
    const ref = this.externRef(id);
    if (!ref) return `${this.use("Rt")}.missingFn(${str(this.model.extern(id).name)})`;
    return `${ref.cls}.${ref.item}(${args.join(", ")})`;
  }

  /**
   * A class-level constant holding an extern codec's or type's host object. Async codecs are
   * wrapped as blocking codecs: generated code runs on virtual threads, where waiting parks.
   */
  externObj(id: string): string {
    const hit = this.externLocals.get(id);
    if (hit) return hit;
    const x = this.model.extern(id);
    const ref = this.externRef(id);
    const host = ref ? `${ref.cls}.${ref.item}` : undefined;
    const Rt = this.use("Rt");
    let type: string;
    let init: string;
    if (x.kind === "codec") {
      type = this.use("Codec");
      if (!host) init = `${Rt}.missingCodec(${str(x.name)})`;
      else init = x.async ? `${this.use("Codecs")}.blocking(${host})` : host;
    } else {
      type = `${this.use("ExternType")}<?>`;
      if (host) init = host;
      else if (x.kind === "type" && x.builtin) {
        init = `${this.use("Leb128")}.${x.name === "sleb128" ? "SIGNED" : "UNSIGNED"}`;
      } else init = `${Rt}.missingType(${str(x.name)})`;
    }
    const local = `$ext_${x.name.replace(/[^A-Za-z0-9_]/g, "_")}`;
    this.externLocals.set(id, local);
    this.hoistedLines.push(`private static final ${type} ${local} = ${init};`);
    return local;
  }

  /** A context for constant expressions (parameter defaults, case labels). */
  constExprCtx(): ExprCtx {
    const none = (): CExpr => ({ code: "null", repr: "obj" });
    return {
      field: none,
      param: none,
      it: none,
      lambda: n => n,
      builtin: () => "0L",
      sizeof: () => "0",
      offsetof: () => "0L",
      encodedSize: () => "0",
      bytesof: () => "null",
      encode: () => "null",
      externCall: (id, args) => this.externCall(id, args),
      hoist: (code, type, hint) => this.hoist(code, type, hint),
      fieldType: () => undefined,
      use: n => this.use(n)
    };
  }
}
