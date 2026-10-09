/** Readers: `read_body` per struct (docs/IR.md §2). */
import type {
  IrBits,
  IrExpr,
  IrField,
  IrFill,
  IrLayer,
  IrMember,
  IrStreamExpr,
  IrSwitch,
  IrType
} from "../../ir/index.ts";
import { indent } from "./emit.ts";
import {
  asBool,
  asInt,
  compile,
  eqExpr,
  literal,
  load,
  tmp,
  toParamValue,
  toStored,
  encodingRust,
  type CExpr,
  type ExprCtx,
  type FieldRef
} from "./expr.ts";
import {
  BackendError,
  byReference,
  allFields,
  effectiveLayers,
  localPlace,
  measuredFields,
  memberExprs,
  splitLeading,
  primInfo,
  typeKey,
  walkExpr,
  type FieldInfo,
  type Model,
  type ParamModel,
  type RMember,
  type Shape,
  type StructModel,
  type SwitchModel
} from "./model.ts";
import { sanitize, strLit } from "./names.ts";

/** Short stable hash of a type key, for pointer identity keys. */
export function typeHash(t: IrType): string {
  const s = typeKey(t);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return "t" + h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export function endianCode(spec: "le" | "be" | "inherit", endianVar: string): string {
  if (spec === "le") return "yr::Endian::Le";
  if (spec === "be") return "yr::Endian::Be";
  return endianVar;
}

/** The `yr::PtrFormat` of a pointer type. */
export function ptrFormat(t: Extract<IrType, { kind: "pointer" }>, endianVar: string): string {
  const pi = primInfo(t.storage);
  return `yr::PtrFormat { width: ${pi.bytes}, endian: ${endianCode(t.storageEndian, endianVar)}, signed: ${pi.signed}, relative: ${t.relative} }`;
}

/** A param as an expression operand (references for non-Copy values). */
export function paramRef(p: ParamModel): FieldRef {
  const s = p.shape;
  if (s.k === "string") return { kind: "expr", e: { code: p.v, t: { k: "str" } } };
  if (s.k === "bytes") return { kind: "expr", e: { code: p.v, t: { k: "bytes" } } };
  if (s.k === "array" || byReference(s)) return { kind: "place", place: `(*${p.v})`, shape: s };
  if (s.k === "option")
    return {
      kind: "expr",
      e: { code: p.v, t: { k: "opt", shape: s.inner.k === "rc" ? s.inner.inner : s.inner } }
    };
  return { kind: "place", place: p.v, shape: s };
}

export function findParam(sm: StructModel, name: string): ParamModel {
  const p = sm.params.find(x => x.ir.name === name);
  if (!p) throw new BackendError(`${sm.name} has no parameter ${name}`);
  return p;
}

export interface Env {
  rv: string;
  endian: string;
  /** Array index variables in scope (for codec cache keys). */
  indices: string[];
  /** The field being read (for codec cache keys). */
  field: string;
}

/** A field being read: its model and environments, and the locals the read uses. */
interface FieldRead {
  f: IrField;
  info: FieldInfo;
  env: Env;
  /** `env` with the field as the codec cache key. */
  fenv: Env;
  /** The local holding the field's start (error offsets). */
  o: string;
  /** The local the value is read into. */
  target: string;
  ty: string;
  /** The suffix of the field's offset and size locals, if expressions measure it. */
  ms: string | undefined;
}

export interface ReadGenOptions {
  /**
   * Generate `scan_body` (views): inline members are read, pointer and `at` targets are not
   * followed (default placeholders), nested structs are scanned, and field spans are recorded.
   */
  scan?: boolean;
  /** Struct reads return `yr::Scan` (opening views of targets). */
  wantScan?: boolean;
}

export class ReadGen {
  private measured: Set<string>;
  /** Reads run after the struct's members (pointers whose `@origin` uses field offsets). */
  private deferred: string[] = [];
  private caseVars = new Map<SwitchModel, string>();
  private out: string[] = [];
  private scan: boolean;
  private wantScan: boolean;
  /** Declaration index of every field (span slots of views). */
  fieldIndex = new Map<IrField, number>();

  private m: Model;
  private sm: StructModel;
  constructor(m: Model, sm: StructModel, o: ReadGenOptions = {}) {
    this.m = m;
    this.sm = sm;
    this.measured = new Set([...measuredFields(memberExprs(sm.ir.members, false)).keys()]);
    this.measured.delete("$this");
    this.scan = o.scan ?? false;
    this.wantScan = o.wantScan ?? false;
    allFields(sm.ir.members).forEach((f, i) => this.fieldIndex.set(f, i));
  }

  /** Rust type of a stored value (struct reads are `yr::Scan` when opening views). */
  private ty(s: Shape): string {
    if (!this.wantScan) return this.m.rustType(s);
    switch (s.k) {
      case "struct": {
        const n = this.m.struct(s.id).name;
        return `yr::Scan<${n}, ${n}__Args>`;
      }
      case "array":
        return `Vec<${this.ty(s.elem)}>`;
      case "rc":
        return `Rc<${this.ty(s.inner)}>`;
      case "option":
        return `Option<${this.ty(s.inner)}>`;
      default:
        return this.m.rustType(s);
    }
  }

  ctx(env: Env, it?: ExprCtx["it"]): ExprCtx {
    const sm = this.sm;
    const ctx: ExprCtx = {
      m: this.m,
      sm,
      mode: "read",
      field: name => {
        const f = sm.fields.get(name);
        if (!f) throw new BackendError(`${sm.name} has no field ${name}`);
        return { kind: "place", place: localPlace(f, f.conditional), shape: f.shape };
      },
      param: name => {
        const p = findParam(sm, name);
        if (p.ir.origin === "endian")
          return { kind: "expr", e: { code: env.endian, t: { k: "endian" } } };
        return paramRef(p);
      },
      measure: name => ({ o: `o_${sanitize(name)}`, s: `s_${sanitize(name)}` }),
      offset: () => `${env.rv}.offset()`,
      end: () => `${env.rv}.end_rel()`,
      index: () => `${env.rv}.index_value()?`
    };
    if (it) ctx.it = it;
    return ctx;
  }

  generate(): string[] {
    const sm = this.sm;
    const s = sm.ir;
    const params = sm.params.map(p => `${p.v}: ${this.m.paramType(p.shape, "")}`);
    const lines: string[] = [];
    const ret = this.scan ? `yr::Scan<Self, ${sm.name}__Args>` : "Self";
    lines.push(
      `pub(crate) fn ${this.scan ? "scan_body" : "read_body"}(r: &mut yr::Reader<'_>${params.map(p => ", " + p).join("")}) -> yr::Result<${ret}> {`
    );
    const body: string[] = [];
    if (this.scan) {
      body.push(
        "let __loc = yr::Loc::of(r);",
        `let mut __spans: Vec<Option<yr::FieldSpan>> = vec![None; ${this.fieldIndex.size}];`
      );
    }
    if (s.base) body.push("let __saved_base = r.base;", "r.base = r.pos;");
    body.push("let __this_o: i128 = r.pos as i128 - r.base as i128;");
    const ident = this.m.identStructs.has(s.id);
    if (ident) body.push("let __id_at = r.pos;", `let __id = r.begin_ident(${strLit(sm.name)});`);
    if (s.strict) body.push("let __saved_strict = r.strict;", "r.strict = true;");
    if (sm.hasCache) body.push("let mut __cache = yr::ViaCache::new();");
    for (const f of new Set(sm.byDecl.values())) {
      if (f.conditional)
        body.push(`let mut ${f.local}: Option<${this.m.rustType(f.shape)}> = None;`);
    }
    for (const name of this.measured)
      body.push(`let mut o_${sanitize(name)}: i128 = 0;`, `let mut s_${sanitize(name)}: i128 = 0;`);
    sm.switches.forEach((sw, i) => {
      const v = `__case${i}`;
      this.caseVars.set(sw, v);
      body.push(`let mut ${v}: i32 = -2;`);
    });
    const endian = sm.params.find(p => p.ir.origin === "endian");
    const env: Env = {
      rv: "r",
      endian: endian ? endian.v : "yr::Endian::Le",
      indices: [],
      field: ""
    };
    this.out = body;
    this.deferred = [];
    this.members(s.members, env, false);
    body.push(...this.deferred);
    if (s.base) {
      for (const l of s.layers) {
        if (l.kind !== "alignEnd") continue;
        body.push(this.alignRead(l, env));
      }
      body.push("r.base = __saved_base;");
    }
    if (s.strict) body.push("r.strict = __saved_strict;");
    if (ident) body.push(`r.end_ident(__id_at, ${strLit(sm.name)});`);
    body.push(this.scan ? "let __value = Self {" : "Ok(Self {");
    body.push(...indent(this.construct(sm.members)));
    if (ident) body.push("    __id,");
    if (sm.hasCache) body.push("    __cache,");
    if (this.scan) {
      body.push("};");
      const args = sm.params.map(p => `${p.v}: ${ownedArg(p)}`);
      body.push(
        `Ok(yr::Scan { value: __value, spans: __spans, loc: __loc, end_pos: r.pos, args: ${sm.name}__Args { ${args.join(", ")} } })`
      );
    } else body.push("})");
    lines.push(...indent(body));
    lines.push("}");
    return lines;
  }

  private construct(members: RMember[], inVariant = false): string[] {
    const out: string[] = [];
    for (const mm of members) {
      if (mm.k === "field") {
        const f = mm.info;
        let v: string;
        if (inVariant) v = mm.optional ? f.local : `yr::take(${f.local}, ${strLit(f.name)})?`;
        else if (mm.optional) v = f.conditional ? f.local : `Some(${f.local})`;
        else v = f.conditional ? `yr::take(${f.local}, ${strLit(f.name)})?` : f.local;
        out.push(`${f.ident}: ${v},`);
      } else {
        const sw = mm.sw;
        const cv = this.caseVars.get(sw)!;
        const arms: string[] = [];
        for (const variant of sw.variants) {
          let val: string;
          if (sw.tuple) {
            const fm = variant.members[0] as Extract<RMember, { k: "field" }>;
            val = `${sw.enumName}::${variant.name}(yr::take(${fm.info.local}, ${strLit(fm.info.name)})?)`;
          } else if (variant.members.length === 0) {
            val = `${sw.enumName}::${variant.name}`;
          } else {
            val = `${sw.enumName}::${variant.name} { ${this.construct(variant.members, true).join(" ")} }`;
          }
          arms.push(`${variant.caseIndex} => ${mm.optional ? `Some(${val})` : val},`);
        }
        if (mm.optional) arms.push(`_ => None,`);
        else
          arms.push(
            `_ => return Err(yr::YaffleError::new(yr::ErrorCode::Check, "switch not read")),`
          );
        out.push(`${sw.ident}: match ${cv} {`, ...indent(arms), "},");
      }
    }
    return out;
  }

  private emit(...l: string[]) {
    this.out.push(...l);
  }

  // ─── Members ───────────────────────────────────────────────────────────────

  private members(ms: IrMember[], env: Env, conditional: boolean): void {
    for (const mem of ms) {
      if (mem.kind === "field") this.field(mem, env);
      else if (mem.kind === "bits") this.bits(mem, env);
      else if (mem.kind === "block") {
        if (mem.condition) {
          const c = asBool(compile(this.ctx(env), mem.condition));
          const saved = this.out;
          const thenL: string[] = [];
          this.out = thenL;
          this.blockLayers(mem.layers, env, e => this.members(mem.members, e, true));
          const elseL: string[] = [];
          this.out = elseL;
          if (mem.else) this.blockLayers(mem.layers, env, e => this.members(mem.else!, e, true));
          this.out = saved;
          this.emit(`if ${c} {`, ...indent(thenL));
          if (elseL.length) this.emit("} else {", ...indent(elseL));
          this.emit("}");
        } else {
          this.blockLayers(mem.layers, env, e => this.members(mem.members, e, conditional));
        }
      } else this.switch_(mem, env);
    }
  }

  private switch_(sw: IrSwitch, env: Env): void {
    const swm = this.sm.switches.find(x => x.ir === sw);
    if (!swm) throw new BackendError("switch model missing");
    const cv = this.caseVars.get(swm)!;
    const d = compile(this.ctx(env), sw.discriminant);
    const dv = tmp("d");
    this.emit(`let ${dv} = ${d.code};`);
    const saved = this.out;
    let first = true;
    sw.cases.forEach((c, i) => {
      const conds = c.values.map(v => eqExpr({ code: dv, t: d.t }, literal(this.ctx(env), v)));
      const body: string[] = [];
      this.out = body;
      this.emit(`${cv} = ${i};`);
      this.members(c.members, env, true);
      this.out = saved;
      this.emit(
        `${first ? "if" : "} else if"} ${conds.join(" || ") || "false"} {`,
        ...indent(body)
      );
      first = false;
    });
    const def: string[] = [];
    this.out = def;
    if (sw.default) {
      this.emit(`${cv} = -1;`);
      this.members(sw.default, env, true);
    } else {
      this.emit(`return Err(yr::YaffleError::check(${env.rv}.pos, "no switch case matches"));`);
    }
    this.out = saved;
    if (first) this.emit("{", ...indent(def), "}");
    else this.emit("} else {", ...indent(def), "}");
  }

  /** Applies block layers as sequential statements around `inner`. */
  private blockLayers(layers: IrLayer[], env: Env, inner: (env: Env) => void): void {
    if (layers.length === 0) return inner(env);
    const l = layers[layers.length - 1]!;
    const rest = layers.slice(0, -1);
    const rv = env.rv;
    const ctx = this.ctx(env);
    switch (l.kind) {
      case "align":
        this.emit(this.alignRead(l, env));
        return this.blockLayers(rest, env, inner);
      case "padBefore":
        this.emit(this.padRead(l, env));
        return this.blockLayers(rest, env, inner);
      case "padAfter":
        this.blockLayers(rest, env, inner);
        this.emit(this.padRead(l, env));
        return;
      case "padUntil": {
        const s = tmp("s");
        this.emit(`let ${s} = ${rv}.pos;`);
        this.blockLayers(rest, env, inner);
        this.emit(this.padUntilRead(l, s, env));
        return;
      }
      case "alignEnd":
        this.blockLayers(rest, env, inner);
        this.emit(this.alignRead(l, env));
        return;
      case "size": {
        const e = tmp("e");
        this.emit(`let ${e} = ${rv}.narrow(yr::int::len(${asInt(compile(ctx, l.size))})?)?;`);
        this.blockLayers(rest, env, inner);
        this.emit(`${rv}.close_window(${e})?;`);
        return;
      }
      case "endian": {
        const e = tmp("en");
        this.emit(`let ${e} = ${compile(ctx, l.value).code};`);
        return this.blockLayers(rest, { ...env, endian: e }, inner);
      }
      case "strict": {
        const s = tmp("st");
        this.emit(`let ${s} = ${rv}.strict;`, `${rv}.strict = true;`);
        this.blockLayers(rest, env, inner);
        this.emit(`${rv}.strict = ${s};`);
        return;
      }
      case "via": {
        const { setup, sub } = this.viaSetup(l, rest, env, "block");
        this.emit(...setup);
        return this.blockLayers(rest, { ...env, rv: sub }, inner);
      }
    }
  }

  /** Whether a padding layer's bytes are checked: strict layers always, others in strict mode. */
  private check(l: { strict?: boolean }, env: Env): string {
    return l.strict ? "true" : `${env.rv}.strict`;
  }

  /** Skipping an `align`/`alignEnd` layer's padding. */
  private alignRead(l: Extract<IrLayer, { kind: "align" | "alignEnd" }>, env: Env): string {
    const rv = env.rv;
    const ctx = this.ctx(env);
    const to = `yr::int::len(${asInt(compile(ctx, l.to))})?`;
    const origin = l.from === "file" ? "0" : `${rv}.base`;
    const off = l.offset ? asInt(compile(ctx, l.offset)) : "0";
    return `${rv}.align(${to}, ${origin}, ${off}, ${this.fill(l.fill, env)}, ${this.check(l, env)})?;`;
  }

  /** Skipping a `padBefore`/`padAfter` layer's padding. */
  private padRead(l: Extract<IrLayer, { kind: "padBefore" | "padAfter" }>, env: Env): string {
    const n = `yr::int::len(${asInt(compile(this.ctx(env), l.count))})?`;
    return `${env.rv}.pad(${n}, ${this.fill(l.fill, env)}, ${this.check(l, env)})?;`;
  }

  /** Skipping a `padUntil` layer's padding after content that started at `start`. */
  private padUntilRead(l: Extract<IrLayer, { kind: "padUntil" }>, start: string, env: Env): string {
    const n = `yr::int::len(${asInt(compile(this.ctx(env), l.size))})?`;
    return `${env.rv}.pad_until(${start}, ${n}, ${this.fill(l.fill, env)}, ${this.check(l, env)})?;`;
  }

  private fill(f: IrFill, env: Env): string {
    if (f.kind === "byte") return `yr::Fill::Byte(${f.value & 0xff})`;
    const ctx = this.ctx(env);
    ctx.lambda = { [f.param]: "__fi" };
    return `yr::Fill::Fn(&|__fi: i128| -> yr::Result<u8> { Ok((${asInt(compile(ctx, f.expr))} & 255) as u8) })`;
  }

  /** Statements that decode a codec region and open a sub-reader over it. */
  private viaSetup(
    l: Extract<IrLayer, { kind: "via" }>,
    rest: IrLayer[],
    env: Env,
    key: string
  ): { setup: string[]; sub: string } {
    const ctx = this.ctx(env);
    const codec = this.m.extern(l.codec);
    if (codec.kind !== "codec") throw new BackendError(`${codec.name} is not a codec`);
    const path = this.m.externPath(l.codec);
    const args = tmp("args");
    const dec = tmp("dec");
    const enc = tmp("enc");
    const sub = tmp("sr");
    const inner = [...rest].reverse().find(x => x.kind === "size");
    const os =
      inner && inner.kind === "size"
        ? `Some(yr::int::len(${asInt(compile(ctx, inner.size))})?)`
        : "None";
    // `@ranged`: views decode the region lazily, block by block.
    const ranged = codec.ranged
      ? `Some(Rc::new({ let __a2: Vec<yr::Arg> = ${args}.clone(); move |__inp: &[u8], __pos: u64| yr::Codec::decode(&${path}, __inp, &yr::CodecCtx { args: &__a2, output_size: None, position: Some(__pos) }) }) as yr::RangedFn)`
      : "None";
    const setup = [
      `let ${args}: Vec<yr::Arg> = vec![${l.args.map((a, i) => codecArg(compile(ctx, a), codec.params[i]?.type.kind)).join(", ")}];`,
      `let (${dec}, ${enc}) = ${env.rv}.decode(&${path}, ${codec.streaming}, &${args}, ${os}, ${ranged})?;`
    ];
    if (this.sm.hasCache)
      setup.push(
        `if !${dec}.data.is_lazy() { __cache.record(${cacheKey(env.field || key, env.indices)}, ${dec}.bytes()?, &${args}, ${enc}); }`
      );
    else setup.push(`let _ = ${enc};`);
    setup.push(`let mut ${sub}_v = ${env.rv}.sub_space(&${dec});`, `let ${sub} = &mut ${sub}_v;`);
    return { setup, sub };
  }

  // ─── Fields ────────────────────────────────────────────────────────────────

  private field(f: IrField, env: Env): void {
    const info = this.sm.byDecl.get(f)!;
    const rv = env.rv;
    const fs = tmp("fs");
    // Views: spans of every field, with the read context there.
    if (this.scan) this.emit(`let ${fs} = ${rv}.pos;`);
    const r: FieldRead = {
      f,
      info,
      env,
      fenv: { ...env, field: f.name },
      o: tmp("o"),
      target: info.conditional ? tmp("v") : info.local,
      ty: this.m.rustType(info.shape),
      ms: this.measured.has(f.name) ? sanitize(f.name) : undefined
    };
    let spanTarget = "None";
    if (f.virtual) this.virtualRead(r);
    else if (this.scan && f.from)
      this.emit(`let ${r.o} = ${rv}.pos;`, `let ${r.target}: ${r.ty} = Default::default();`);
    else if (this.scan && f.placement) spanTarget = this.placeholderAt(r);
    else if (f.from) this.streamRead(r);
    else if (f.placement) this.placedRead(r);
    else spanTarget = this.inlineRead(r);
    if (this.scan) {
      const idx = this.fieldIndex.get(f)!;
      this.emit(
        `__spans[${idx}] = Some(yr::FieldSpan::of(${rv}, ${fs}, ${rv}.pos, ${spanTarget}, ${env.endian}));`
      );
    }
    // Placeholders (unread targets, codec regions, streams) can't be checked.
    if (!(this.scan && this.m.lazyField(f))) this.checks(f.checks, info, r.target, r.o, env);
    if (info.conditional) this.emit(`${info.local} = Some(${r.target});`);
  }

  /** A virtual field: no bytes; the value is computed from earlier fields. */
  private virtualRead({ f, info, env, fenv, o, target, ty, ms }: FieldRead): void {
    const ctx = this.ctx(fenv);
    const val = toStored(ctx, compile(ctx, f.virtual!.read), info.shape);
    this.emit(
      `let ${o} = ${env.rv}.pos;`,
      `let ${target}: ${ty} = (|| -> yr::Result<${ty}> { Ok(${val}) })().rf(${strLit(f.name)}, ${o})?;`
    );
    if (ms) this.emit(`o_${ms} = ${env.rv}.offset();`, `s_${ms} = 0;`);
  }

  /** Scans: an `at` field's placeholder; returns its span's target address. */
  private placeholderAt({ f, env, o, target, ty, ms }: FieldRead): string {
    const rv = env.rv;
    const off = asInt(compile(this.ctx(env), f.placement!.offset));
    const pt = tmp("pt");
    this.emit(
      `let ${o} = ${rv}.pos;`,
      `let ${pt}: i128 = (|| -> yr::Result<i128> { Ok(${rv}.base as i128 + ${off}) })().rf(${strLit(f.name)}, ${o})?;`,
      `let ${target}: ${ty} = Default::default();`
    );
    if (ms) this.emit(`o_${ms} = ${pt} - ${rv}.base as i128;`);
    // `@nullable(empty)`: offset 0 is an empty value (no target).
    return f.placement!.emptyIsNull
      ? `(if ${pt} == ${rv}.base as i128 { None } else { usize::try_from(${pt}).ok() })`
      : `usize::try_from(${pt}).ok()`;
  }

  /** A `from` field, read from its stream's bytes. */
  private streamRead({ f, info, env, fenv, o, target, ty, ms }: FieldRead): void {
    const rv = env.rv;
    const sub = tmp("fr");
    const ssp = tmp("ssp");
    const inner = this.readType(f.type, { ...fenv, rv: sub });
    this.emit(
      `let ${o} = ${rv}.pos;`,
      `let ${ssp}: Rc<yr::Space> = ${this.stream(f, env)}.rf(${strLit(f.name)}, ${o})?;`,
      `let ${target}: ${ty} = { let mut ${sub}_v = ${rv}.sub_space(&${ssp}); let ${sub} = &mut ${sub}_v; (|| -> yr::Result<${ty}> { Ok(${boxed(info.shape, inner)}) })() }.rf(${strLit(f.name)}, ${o})?;`
    );
    if (ms) this.emit(`o_${ms} = 0;`, `s_${ms} = ${ssp}.len() as i128;`);
  }

  /** A field `at` an offset, read there (the position is kept). `@nullable(empty)`: 0 is empty. */
  private placedRead({ f, info, env, fenv, o, target, ty, ms }: FieldRead): void {
    const rv = env.rv;
    const name = strLit(f.name);
    const off = asInt(compile(this.ctx(env), f.placement!.offset));
    const saved = tmp("sp");
    const read = (at: string, into: string) => [
      `let ${at} = ${rv}.pos;`,
      ...(ms ? [`o_${ms} = ${rv}.offset();`] : []),
      `let ${into}: ${ty} = (|| -> yr::Result<${ty}> { Ok(${boxed(info.shape, this.readType(f.type, fenv))}) })().rf(${name}, ${at})?;`,
      ...(ms ? [`s_${ms} = (${rv}.pos - ${at}) as i128;`] : []),
      `${rv}.pos = ${saved};`
    ];
    if (!f.placement!.emptyIsNull) {
      this.emit(
        `let ${saved} = ${rv}.seek_rel(${off}).rf(${name}, ${rv}.pos)?;`,
        ...read(o, target)
      );
      return;
    }
    const pv = tmp("pv");
    this.emit(
      `let ${o} = ${rv}.pos;`,
      `let ${pv}: i128 = (|| -> yr::Result<i128> { Ok(${off}) })().rf(${name}, ${o})?;`,
      `let ${target}: ${ty} = if ${pv} == 0 {`,
      ...(ms ? [`    o_${ms} = 0;`, `    s_${ms} = 0;`] : []),
      "    Default::default()",
      "} else {",
      `    let ${saved} = ${rv}.seek_rel(${pv}).rf(${name}, ${rv}.pos)?;`,
      ...indent([...read(tmp("o"), "__x"), "__x"]),
      "};"
    );
  }

  /** A field read at the position (leading padding first); returns its span's target address. */
  private inlineRead({ f, info, env, fenv, o, target, ty, ms }: FieldRead): string {
    const rv = env.rv;
    const name = strLit(f.name);
    // Leading alignment and padding come before the field's measured span.
    const { inner, layers } = effectiveLayers(this.m, f.type);
    const { leading, rest } = splitLeading(layers);
    if (leading.length > 0) {
      const pads = leading.map(l =>
        l.kind === "align"
          ? this.alignRead(l, env)
          : this.padRead(l as Extract<IrLayer, { kind: "padBefore" }>, env)
      );
      this.emit(
        `{ let __lp = ${rv}.pos; (|| -> yr::Result<()> { ${pads.join(" ")} Ok(()) })().rf(${name}, __lp)?; }`
      );
    }
    this.emit(`let ${o} = ${rv}.pos;`);
    if (ms) this.emit(`o_${ms} = ${rv}.offset();`);
    const deferred =
      !this.scan &&
      inner.kind === "pointer" &&
      inner.origin &&
      originUsesFields(inner.origin) &&
      rest.length === 0 &&
      !info.conditional &&
      rv === "r" &&
      f.checks.length === 0;
    if (deferred) {
      // The origin uses field offsets (maybe of later fields): follow once the struct is read.
      const praw = tmp("praw");
      const pi = primInfo(inner.storage);
      this.emit(
        `let ${praw}: u64 = ${rv}.uint(${pi.bytes}, ${endianCode(inner.storageEndian, env.endian)}).rf(${name}, ${o})?;`
      );
      if (ms) this.emit(`s_${ms} = (${rv}.pos - ${o}) as i128;`);
      this.deferred.push(
        `let ${target}: ${ty} = (|| -> yr::Result<${ty}> { Ok(${this.pointer(inner, fenv, praw)}) })().rf(${name}, ${o})?;`
      );
      return "None";
    }
    this.emit(
      `let ${target}: ${ty} = (|| -> yr::Result<${ty}> { Ok(${boxed(info.shape, this.layered(inner, rest, fenv))}) })().rf(${name}, ${o})?;`
    );
    if (ms) this.emit(`s_${ms} = (${rv}.pos - ${o}) as i128;`);
    // Pointer targets (not with an `@origin`, which views evaluate when following).
    if (!this.scan || inner.kind !== "pointer" || inner.origin) return "None";
    const nullValue = inner.nullValue !== undefined ? `Some(${inner.nullValue}_i128)` : "None";
    return `yr::view::pointer_target(${rv}.src(), ${o}, ${ptrFormat(inner, env.endian)}, ${rv}.base, ${nullValue})`;
  }

  /** Views: statements checking a field read on demand (`place` holds the value). */
  checkCode(f: IrField, place: string, o: string, env: Env): string[] {
    const info = this.sm.byDecl.get(f)!;
    const saved = this.out;
    const out: string[] = [];
    this.out = out;
    this.checks(f.checks, info, place, o, env);
    this.out = saved;
    return out;
  }

  /** Views: a `from` field read at the reader's position (the stream is built and kept). */
  fromRead(f: IrField, env: Env): string {
    const info = this.sm.byDecl.get(f)!;
    const ty = this.m.rustType(info.shape);
    const sub = tmp("fr");
    const ssp = tmp("ssp");
    const inner = this.readType(f.type, { ...env, rv: sub, field: f.name });
    return `{ let ${ssp}: Rc<yr::Space> = ${this.stream(f, env)}?; let mut ${sub}_v = ${env.rv}.sub_space(&${ssp}); let ${sub} = &mut ${sub}_v; let __x: ${ty} = ${boxed(info.shape, inner)}; __x }`;
  }

  private checks(
    checks: IrField["checks"],
    info: FieldInfo,
    place: string,
    o: string,
    env: Env
  ): void {
    for (const c of checks) {
      const ctx = this.ctx(env, { place, shape: info.shape });
      const cond = asBool(compile(ctx, c.expr));
      const guard = c.strictOnly ? `${env.rv}.strict && !${cond}` : `!${cond}`;
      this.emit(
        `if ${guard} { return Err(yr::check_failed(${o}, ${strLit(c.message)}).in_field(${strLit(info.name)})); }`
      );
    }
  }

  private bits(b: IrBits, env: Env): void {
    const pi = primInfo(b.storage);
    const u = tmp("u");
    const o = tmp("o");
    const first = b.fields.find(f => f.name !== null)?.name ?? "bits";
    this.emit(`let ${o} = ${env.rv}.pos;`);
    this.emit(
      `let ${u}: u64 = ${env.rv}.uint(${pi.bytes}, ${endianCode(b.endian, env.endian)}).rf(${strLit(first)}, ${o})?;`
    );
    for (const bf of b.fields) {
      const mask =
        bf.width >= 64 ? "u64::MAX" : `0x${((1n << BigInt(bf.width)) - 1n).toString(16)}u64`;
      const raw = `((${u} >> ${bf.shift}) & ${mask})`;
      if (bf.name === null) {
        this.emit(
          `if ${env.rv}.strict && ${raw} != 0 { return Err(yr::YaffleError::check(${o}, "reserved bits are not zero")); }`
        );
        continue;
      }
      const info = this.sm.byDecl.get(bf)!;
      const target = info.conditional ? tmp("v") : info.local;
      const ty = this.m.rustType(info.shape);
      let val: string;
      const t = bf.type.kind === "layered" ? bf.type.inner : bf.type;
      if (t.kind === "bool") val = `(${raw} != 0)`;
      else if (t.kind === "enum") {
        const en = this.m.enum(t.enum);
        const st = en.storage;
        const rawT =
          st.k === "int" && st.signed
            ? `(yr::prim::sign_extend(${raw}, ${bf.width}) as ${st.rust})`
            : `(${raw} as ${this.m.rustType(st)})`;
        val = `${en.name}::from_raw(${rawT}).ok_or_else(|| yr::YaffleError::check(${o}, "not a member of ${en.name}").in_field(${strLit(bf.name)}))?`;
      } else if (t.kind === "prim") {
        const pinfo = primInfo(t.prim);
        val = pinfo.signed
          ? `(yr::prim::sign_extend(${raw}, ${bf.width}) as ${ty})`
          : `(${raw} as ${ty})`;
      } else throw new BackendError(`unsupported bitfield type ${t.kind}`);
      this.emit(`let ${target}: ${ty} = ${val};`);
      this.checks(bf.checks, info, target, o, env);
      if (info.conditional) this.emit(`${info.local} = Some(${target});`);
    }
  }

  private streamBytes(st: IrStreamExpr, env: Env): string {
    switch (st.kind) {
      case "field": {
        const f = this.sm.fields.get(st.field);
        if (!f) throw new BackendError(`unknown stream field ${st.field}`);
        return `${localPlace(f, f.conditional)}.clone()`;
      }
      case "each": {
        const f = this.sm.fields.get(st.array);
        if (!f || f.shape.k !== "array" || f.shape.elem.k !== "struct")
          throw new BackendError(`stream ${st.array}[*] is not an array of structs`);
        const esm = this.m.struct(f.shape.elem.id);
        const ef = esm.fields.get(st.field);
        if (!ef) throw new BackendError(`${esm.name} has no field ${st.field}`);
        return `${localPlace(f, f.conditional)}.iter().flat_map(|__e| __e.${ef.ident}.iter().copied()).collect()`;
      }
      case "slice": {
        const inner = this.streamBytes(st.stream, env);
        const ctx = this.ctx(env);
        const s = `yr::int::len(${asInt(compile(ctx, st.start))})?`;
        const e = st.end ? `yr::int::len(${asInt(compile(ctx, st.end))})?` : undefined;
        const v = tmp("sl");
        return `{ let ${v}: Vec<u8> = ${inner}; let __a = ${s}; let __b = ${e ?? `${v}.len()`}; if __a > __b || __b > ${v}.len() { return Err(yr::YaffleError::range("stream slice out of range")); } ${v}[__a..__b].to_vec() }`;
      }
    }
  }

  // ─── Types (expressions) ───────────────────────────────────────────────────

  readType(t: IrType, env: Env): string {
    const { inner, layers } = effectiveLayers(this.m, t);
    return this.layered(inner, layers, env);
  }

  private layered(inner: IrType, layers: IrLayer[], env: Env): string {
    if (layers.length === 0) return this.plain(inner, env);
    const l = layers[layers.length - 1]!;
    const rest = layers.slice(0, -1);
    const rv = env.rv;
    const ctx = this.ctx(env);
    const v = tmp("lv");
    switch (l.kind) {
      case "align":
        return `{ ${this.alignRead(l, env)} ${this.layered(inner, rest, env)} }`;
      case "padBefore":
        return `{ ${this.padRead(l, env)} ${this.layered(inner, rest, env)} }`;
      case "padAfter":
        return `{ let ${v} = ${this.layered(inner, rest, env)}; ${this.padRead(l, env)} ${v} }`;
      case "padUntil": {
        const s = tmp("s");
        return `{ let ${s} = ${rv}.pos; let ${v} = ${this.layered(inner, rest, env)}; ${this.padUntilRead(l, s, env)} ${v} }`;
      }
      case "alignEnd":
        return `{ let ${v} = ${this.layered(inner, rest, env)}; ${this.alignRead(l, env)} ${v} }`;
      case "size": {
        const e = tmp("e");
        return `{ let ${e} = ${rv}.narrow(yr::int::len(${asInt(compile(ctx, l.size))})?)?; let ${v} = ${this.layered(inner, rest, env)}; ${rv}.close_window(${e})?; ${v} }`;
      }
      case "endian": {
        const e = tmp("en");
        return `{ let ${e} = ${compile(ctx, l.value).code}; ${this.layered(inner, rest, { ...env, endian: e })} }`;
      }
      case "strict": {
        const s = tmp("st");
        return `{ let ${s} = ${rv}.strict; ${rv}.strict = true; let ${v} = ${this.layered(inner, rest, env)}; ${rv}.strict = ${s}; ${v} }`;
      }
      case "via": {
        const codec = this.m.extern(l.codec);
        if (this.scan && codec.kind === "codec" && !codec.streaming) {
          // Scans don't decode: the region is the window [pos, end), read on demand.
          return `{ ${rv}.need(0)?; ${rv}.pos = ${rv}.end; Default::default() }`;
        }
        const { setup, sub } = this.viaSetup(l, rest, env, "value");
        return `{ ${setup.join(" ")} let ${v} = ${this.layered(inner, rest, { ...env, rv: sub })}; ${v} }`;
      }
    }
  }

  /** A length or count (`usize`). */
  lengthOf(e: IrExpr, env: Env): string {
    return `yr::int::len(${asInt(compile(this.ctx(env), e))})?`;
  }

  /** A `from` field's stream: its bytes as a region keyed by the field (views keep it). */
  private stream(f: IrField, env: Env): string {
    const tag = strLit(`${this.sm.ir.id}.${f.name}`);
    return `${env.rv}.stream(yr::view::tag(${tag}), || -> yr::Result<Vec<u8>> { Ok(${this.streamBytes(f.from!.stream, env)}) })`;
  }

  private plain(t: IrType, env: Env): string {
    const rv = env.rv;
    switch (t.kind) {
      case "prim":
        return readPrim(rv, t.prim, endianCode(t.endian, env.endian));
      case "bool":
        return `${rv}.bool()?`;
      case "string": {
        const len =
          t.length.kind === "count"
            ? `yr::StrLen::Count(${this.lengthOf(t.length.expr, env)})`
            : t.length.kind === "until"
              ? "yr::StrLen::Until"
              : "yr::StrLen::Rest";
        return `${rv}.string(${encodingRust(t.encoding)}, ${endianCode(t.endian, env.endian)}, ${len})?`;
      }
      case "bytes":
        if (t.length.kind === "count") return `${rv}.bytes(${this.lengthOf(t.length.expr, env)})?`;
        if (t.length.kind === "until")
          return `${rv}.bytes_until(${byteTerm(t.length.terminator)})?`;
        return `${rv}.bytes_rest()?`;
      case "array":
        return this.array(t, env);
      case "struct": {
        const sm = this.m.struct(t.struct);
        const ctx = this.ctx(env);
        const args = sm.params.map((p, i) => {
          const a = t.args[i];
          if (!a) throw new BackendError(`missing argument ${p.ir.name} for ${sm.name}`);
          return toParamValue(ctx, compile(ctx, a), p.shape);
        });
        if (this.wantScan)
          return `${sm.name}::scan_body(${rv}${args.map(a => ", " + a).join("")})?`;
        if (this.scan)
          return `${sm.name}::scan_body(${rv}${args.map(a => ", " + a).join("")})?.value`;
        return `${sm.name}::read_body(${rv}${args.map(a => ", " + a).join("")})?`;
      }
      case "enum": {
        const en = this.m.enum(t.enum);
        const raw = tmp("raw");
        const at = tmp("at");
        const st = en.ir.storage;
        return `{ let ${at} = ${rv}.pos; let ${raw} = ${readPrim(rv, st, endianCode(t.endian, env.endian))}; ${en.name}::from_raw(${raw}).ok_or_else(|| yr::YaffleError::check(${at}, format!("{} is not a member of ${en.name}", ${raw})))? }`;
      }
      case "pointer":
        return this.pointer(t, env);
      case "extern": {
        const ex = this.m.extern(t.extern);
        if (ex.kind !== "type") throw new BackendError(`${ex.name} is not an extern type`);
        const path = this.m.externPath(t.extern);
        const ctx = this.ctx(env);
        const args = tmp("args");
        const at = tmp("at");
        const b = tmp("b");
        const fixed = ex.fixedSize !== undefined ? `Some(${ex.fixedSize})` : "None";
        return `{ let ${at} = ${rv}.pos; let ${args}: Vec<yr::Arg> = vec![${t.args.map((a, i) => codecArg(compile(ctx, a), ex.params[i]?.type.kind)).join(", ")}]; let ${b} = ${rv}.extern_bytes(|__x| yr::ExternType::size(&${path}, __x, &${args}), ${fixed})?; yr::ExternType::read(&${path}, ${b}, &${args}).map_err(|__m| yr::YaffleError::at(yr::ErrorCode::Codec, ${at}, __m))? }`;
      }
      case "union": {
        const u = this.m.unionFor(t, "");
        const lbl = tmp("u").replace("__", "'");
        const snap = tmp("snap");
        const errs = tmp("errs");
        const parts = u.variants.map(v => {
          const ty = this.ty(v.shape.k === "box" ? v.shape.inner : v.shape);
          return `match (|| -> yr::Result<${ty}> { Ok(${this.readType(v.type, env)}) })() { Ok(__x) => break ${lbl} ${u.name}::${v.name}(${v.shape.k === "box" ? "Box::new(__x)" : "__x"}), Err(__e) => { ${errs}.push((${strLit(v.irName)}.to_string(), __e)); ${rv}.restore(${snap}); } }`;
        });
        return `${lbl}: { let ${snap} = ${rv}.snapshot(); let mut ${errs}: Vec<(String, yr::YaffleError)> = Vec::new(); ${parts.join(" ")} return Err(yr::union_error(${rv}.pos, ${errs})); }`;
      }
      case "transform": {
        const it = tmp("it");
        const innerShape = this.m.shapeOfType(t.inner, "");
        const innerTy = this.m.rustType(innerShape);
        const ctx = this.ctx(env, { place: it, shape: innerShape });
        const valShape = this.m.shapeOfValue(t.valueType, "");
        const val = toStored(ctx, compile(ctx, t.read), valShape);
        if (t.write) return `{ let ${it}: ${innerTy} = ${this.readType(t.inner, env)}; ${val} }`;
        return `{ let ${it}: ${innerTy} = ${this.readType(t.inner, env)}; yr::OneWay { value: ${val}, raw: ${it} } }`;
      }
      case "layered":
        return this.readType(t, env);
    }
  }

  private array(t: Extract<IrType, { kind: "array" }>, env: Env): string {
    const rv = env.rv;
    const a = tmp("a");
    const i = tmp("i");
    const si = tmp("si");
    const elemShape = this.m.shapeOfType(t.element, "", false);
    const elemTy = this.ty(elemShape);
    const eenv: Env = { ...env, indices: [...env.indices, i] };
    const elem = `(|| -> yr::Result<${elemTy}> { Ok(${this.readType(t.element, eenv)}) })().ri(${i})?`;
    const pre = `let mut ${a}: Vec<${elemTy}> = Vec::new(); let ${si} = ${rv}.index;`;
    const post = `${rv}.index = ${si}; ${a}`;
    if (t.elementPlacement) {
      const off = tmp("off");
      const sp = tmp("sp");
      const offCode = asInt(compile(this.ctx(env), t.elementPlacement));
      const head =
        t.length.kind === "count"
          ? `for ${i} in 0..${this.lengthOf(t.length.expr, env)} {`
          : `for ${i} in 0usize.. {`;
      const stop = t.length.kind === "rest" ? `if ${off} >= ${rv}.end_rel() { break; }` : "";
      return `{ ${pre} ${head} ${rv}.index = Some(${i}); let ${off} = ${offCode}; ${stop} let ${sp} = ${rv}.seek_rel(${off}).ri(${i})?; let __x = ${elem}; ${rv}.pos = ${sp}; ${a}.push(__x); } ${post} }`;
    }
    switch (t.length.kind) {
      case "count": {
        const n = tmp("n");
        return `{ let ${n} = ${this.lengthOf(t.length.expr, env)}; ${pre} ${a}.reserve(${n}.min(1 << 16)); for ${i} in 0..${n} { ${rv}.index = Some(${i}); ${a}.push(${elem}); } ${post} }`;
      }
      case "until": {
        const term = compile(this.ctx(env), t.length.terminator);
        const x = tmp("x");
        const eq = eqExpr(load(x, elemShape), term);
        return `{ ${pre} let mut ${i}: usize = 0; loop { ${rv}.index = Some(${i}); let ${x}: ${elemTy} = ${elem}; if ${eq} { break; } ${a}.push(${x}); ${i} += 1; } ${post} }`;
      }
      case "rest":
        return `{ ${pre} let mut ${i}: usize = 0; while ${rv}.pos < ${rv}.end { ${rv}.index = Some(${i}); ${a}.push(${elem}); ${i} += 1; } ${post} }`;
      case "before": {
        // Stop before an element equal to the terminator (not consumed), or at the region end.
        const term = compile(this.ctx(env), t.length.terminator);
        const x = tmp("x");
        const snap = tmp("snap");
        const eq = eqExpr(load(x, elemShape), term);
        return `{ ${pre} let mut ${i}: usize = 0; loop { if ${rv}.pos >= ${rv}.end { break; } ${rv}.index = Some(${i}); let ${snap} = ${rv}.snapshot(); let ${x}: ${elemTy} = ${elem}; if ${eq} { ${rv}.restore(${snap}); break; } ${a}.push(${x}); ${i} += 1; } ${post} }`;
      }
      case "untilPredicate": {
        // Stop after the first element satisfying the predicate (`it` = that element).
        const x = tmp("x");
        const itPlace = this.wantScan && elemShape.k === "struct" ? `${x}.value` : x;
        const stop = asBool(
          compile(this.ctx(env, { place: itPlace, shape: elemShape }), t.length.predicate)
        );
        return `{ ${pre} let mut ${i}: usize = 0; loop { ${rv}.index = Some(${i}); let ${x}: ${elemTy} = ${elem}; let __stop = ${stop}; ${a}.push(${x}); if __stop { break; } ${i} += 1; } ${post} }`;
      }
    }
  }

  /** A pointer read here, or from its stored value `rawVar` (read earlier). */
  pointer(t: Extract<IrType, { kind: "pointer" }>, env: Env, rawVar?: string): string {
    const rv = env.rv;
    const pi = primInfo(t.storage);
    const fa = tmp("fa");
    const u = tmp("pu");
    const p = tmp("p");
    const e = endianCode(t.storageEndian, env.endian);
    const signedRaw = `(yr::prim::sign_extend(${u}, ${pi.bits}) as i128)`;
    const raw = pi.signed ? signedRaw : `(${u} as i128)`;
    const off = t.relative ? signedRaw : raw;
    const targetShape = this.m.shapeOfType(t.target, "", false);
    const targetTy = this.ty(targetShape);
    let follow: string;
    if (this.scan) {
      // Scans don't follow pointers: the target is a placeholder, its address is in the span.
      follow = `Rc::new(<${targetTy}>::default())`;
    } else {
      if (t.origin && originUsesFields(t.origin) && !rawVar)
        throw new BackendError(
          "@origin using field offsets is supported on plain pointer fields only (not in arrays, conditionals or layers) by the Rust target"
        );
      // `@origin(expr)`: target = base + origin + value.
      const origin = t.origin ? ` + ${asInt(compile(this.ctx(env), t.origin))}` : "";
      const addr = t.relative ? `${fa} as i128 + ${off}` : `${rv}.base as i128${origin} + ${off}`;
      if (this.wantScan) {
        // Views of targets: scanned where they are (identity comes when they are materialized).
        const sv = tmp("sv");
        follow = `{ let __ad: i128 = ${addr}; if __ad < 0 || __ad > ${rv}.end as i128 { return Err(yr::YaffleError::eof(${rv}.pos, format!("pointer target 0x{:x} is outside the region", __ad))); } let ${sv} = ${rv}.pos; ${rv}.pos = __ad as usize; let __x = ${this.readType(t.target, env)}; ${rv}.pos = ${sv}; Rc::new(__x) }`;
      } else {
        const stub =
          targetShape.k === "struct" && this.m.identStructs.has(targetShape.id)
            ? `Some((${strLit(this.m.struct(targetShape.id).name)}, |__i: yr::Ident| ${targetTy} { __id: __i, ..Default::default() }))`
            : "None";
        follow = `${rv}.follow::<${targetTy}>(${addr}, ${strLit(typeHash(t.target))}, ${stub}, |${p}| Ok(${this.readType(t.target, { ...env, rv: p })}))?`;
      }
    }
    const head = rawVar
      ? `let ${fa} = 0usize; let _ = ${fa}; let ${u}: u64 = ${rawVar};`
      : `let ${fa} = ${rv}.pos; let ${u} = ${rv}.uint(${pi.bytes}, ${e})?;`;
    if (t.nullValue !== undefined && t.emptyIsNull)
      return `{ ${head} if ${raw} == ${t.nullValue}_i128 { Rc::new(<${targetTy}>::default()) } else { ${follow} } }`;
    if (t.nullValue !== undefined) {
      return `{ ${head} if ${raw} == ${t.nullValue}_i128 { None } else { Some(${follow}) } }`;
    }
    return `{ ${head} ${follow} }`;
  }
}

export function readPrim(rv: string, p: string, e: string): string {
  switch (p) {
    case "u8":
      return `${rv}.u8()?`;
    case "i8":
      return `${rv}.i8()?`;
    case "u16":
    case "i16":
    case "u32":
    case "i32":
    case "u64":
    case "i64":
    case "f16":
    case "f32":
    case "f64":
      return `${rv}.${p}(${e})?`;
    case "u24":
      return `(${rv}.uint(3, ${e})? as u32)`;
    case "i24":
      return `(${rv}.sint(3, ${e})? as i32)`;
    default: {
      const bits = Number(p.slice(1));
      return p.startsWith("i")
        ? `${rv}.sint(${bits / 8}, ${e})?`
        : `${rv}.uint(${bits / 8}, ${e})?`;
    }
  }
}

function byteTerm(e: IrExpr): string {
  if (e.kind === "literal" && e.value.kind === "int") return `${Number(e.value.value) & 0xff}u8`;
  throw new BackendError("bytes terminator must be an integer literal");
}

export function codecArg(c: CExpr, kind: string | undefined): string {
  switch (c.t.k) {
    case "int":
      return `yr::Arg::Int(${c.code})`;
    case "float":
      return `yr::Arg::Float(${c.code})`;
    case "bool":
      return `yr::Arg::Bool(${c.code})`;
    case "str":
      return `yr::Arg::Str(${c.code}.to_string())`;
    case "bytes":
      return `yr::Arg::Bytes(${c.code}.to_vec())`;
    case "endian":
      return `yr::Arg::Endian(${c.code})`;
    case "enum":
      return `yr::Arg::Int(${asInt(c)})`;
    default:
      throw new BackendError(`unsupported codec argument (${c.t.k}${kind ? ", " + kind : ""})`);
  }
}

/** Does an `@origin` expression measure fields (other than `this`)? */
function originUsesFields(e: IrExpr): boolean {
  let uses = false;
  walkExpr(e, x => {
    if (x.kind === "call" && x.callee.kind === "builtin") {
      const a = x.args[0];
      if (a && a.kind === "field") uses = true;
    }
  });
  return uses;
}

/** Wraps a read value for a boxed (recursive) field. */
function boxed(s: Shape, code: string): string {
  return s.k === "box" ? `Box::new(${code})` : code;
}

/** An owned copy of a reader parameter (for a view's stored arguments). */
export function ownedArg(p: ParamModel): string {
  const s = p.shape;
  if (s.k === "string") return `${p.v}.to_string()`;
  if (s.k === "bytes" || s.k === "array") return `${p.v}.to_vec()`;
  if (byReference(s)) return `(*${p.v}).clone()`;
  return s.k === "option" ? `${p.v}.cloned()` : p.v;
}

/** A stored (owned) argument passed back as a reader/writer parameter. */
export function argAsParam(p: ParamModel, place: string): string {
  const s = p.shape;
  if (s.k === "string") return `${place}.as_str()`;
  if (s.k === "bytes" || s.k === "array") return `${place}.as_slice()`;
  if (byReference(s)) return `&${place}`;
  return s.k === "option" ? `${place}.as_ref()` : place;
}

export function cacheKey(field: string, indices: string[]): string {
  if (indices.length === 0) return `${strLit(field)}.to_string()`;
  return `format!("${field.replace(/[{}"\\]/g, "_")}${indices.map(() => "/{}").join("")}", ${indices.join(", ")})`;
}
