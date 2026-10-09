/**
 * Structural validation of an IR program against the invariants of docs/IR.md. Returns a list of
 * problems (empty when valid). The frontend's tests run this on every lowered program; backends
 * may run it on fixtures.
 */
import type {
  IrEnum,
  IrExpr,
  IrExtern,
  IrLayer,
  IrLayoutItem,
  IrLength,
  IrMember,
  IrPathSegment,
  IrProgram,
  IrStruct,
  IrType,
  IrValueType
} from "./ir.ts";
import { IR_VERSION } from "./ir.ts";
import { containsIt, flatFields, visitExpr, visitLayer, visitType, type Visitor } from "./walk.ts";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INT = /^-?\d+$/;
const PRIM_BITS: Record<string, number> = {
  u8: 8,
  u16: 16,
  u24: 24,
  u32: 32,
  u40: 40,
  u48: 48,
  u56: 56,
  u64: 64,
  i8: 8,
  i16: 16,
  i24: 24,
  i32: 32,
  i40: 40,
  i48: 48,
  i56: 56,
  i64: 64,
  f16: 16,
  f32: 32,
  f64: 64
};

const BUILTIN_ARITY: Record<string, [number, number]> = {
  sizeof: [1, 1],
  encodedSize: [2, 2],
  offsetof: [1, 1],
  bytesof: [1, 1],
  encode: [1, 1],
  crc32: [1, 1],
  adler32: [1, 1],
  min: [1, 99],
  max: [1, 99],
  abs: [1, 1],
  round: [1, 1],
  indexOf: [2, 2],
  len: [1, 1],
  encodedLength: [3, 3],
  sum: [1, 1],
  lengths: [1, 1],
  map: [2, 2],
  filter: [2, 2],
  indicesWhere: [2, 2],
  sortedBy: [2, 2],
  unique: [1, 1],
  concat: [1, 99],
  isNull: [1, 1]
};

/** Builtins whose second argument is a lambda (and the only places a lambda may appear). */
const LAMBDA_BUILTINS = new Set(["map", "filter", "indicesWhere", "sortedBy"]);

/** Builtins whose first argument names a field (or `this`). */
const FIELD_BUILTINS = ["sizeof", "offsetof", "bytesof", "encode", "encodedSize"];

const ARITH_OPS = ["+", "-", "*", "/", "%", "<<", ">>", "&", "|", "^"];

interface ExprCtx {
  struct: IrStruct;
  /** Field names visible (undefined: every field, i.e. the write context). */
  visible?: Set<string> | undefined;
  allFields: Set<string>;
  it: boolean;
  /** Lambda parameters in scope (fill functions and derived-array lambdas). */
  lambdas?: string[];
  where: string;
}

/** Per-struct state while walking its members. */
interface StructScope {
  s: IrStruct;
  base: ExprCtx;
  /** Fields declared so far (read-side visibility). */
  visible: Set<string>;
  allFields: Set<string>;
  carriers: string[];
}

export function validateIr(p: IrProgram): string[] {
  return new Validator(p).run();
}

class Validator {
  private readonly p: IrProgram;
  private readonly errors: string[] = [];
  private readonly modules = new Set<string>();
  private readonly structs = new Map<string, IrStruct>();
  private readonly enums: Map<string, IrEnum>;
  private readonly externs: Map<string, IrExtern>;

  constructor(p: IrProgram) {
    this.p = p;
    this.enums = new Map(p.enums.map(e => [e.id, e]));
    this.externs = new Map(p.externs.map(x => [x.id, x]));
  }

  run(): string[] {
    this.checkProgram();
    for (const s of this.p.structs) this.checkStruct(s);
    return this.errors;
  }

  private err(where: string, msg: string): void {
    this.errors.push(`${where}: ${msg}`);
  }

  // ── program ──────────────────────────────────────────────────────────────

  private checkProgram(): void {
    const { p, modules, structs } = this;
    if (p.version !== IR_VERSION)
      this.err("program", `version ${String(p.version)} != ${IR_VERSION}`);
    // plain JSON: no bigints or undefined surprises
    try {
      const s = JSON.stringify(p);
      if (JSON.stringify(JSON.parse(s)) !== s)
        this.err("program", "not stable under JSON round trip");
    } catch (e) {
      this.err("program", `not JSON-serializable: ${(e as Error).message}`);
    }
    for (const m of p.modules) {
      if (modules.has(m.path)) this.err("modules", `duplicate module ${m.path}`);
      modules.add(m.path);
    }
    const names = new Set<string>();
    for (const s of p.structs) {
      const where = `struct ${s.id}`;
      if (structs.has(s.id)) this.err(where, "duplicate id");
      structs.set(s.id, s);
      if (!IDENT.test(s.name)) this.err(where, `name '${s.name}' is not an identifier`);
      if (names.has(s.name)) this.err(where, `duplicate name '${s.name}'`);
      names.add(s.name);
      if (!modules.has(s.module)) this.err(where, `unknown module ${s.module}`);
    }
    for (const e of p.enums) {
      const where = `enum ${e.id}`;
      if (!modules.has(e.module)) this.err(where, `unknown module ${e.module}`);
      if (!isIntPrim(e.storage)) this.err(where, `storage ${e.storage} is not an integer`);
      const seen = new Set<string>();
      for (const m of e.members) {
        if (seen.has(m.name)) this.err(where, `duplicate member ${m.name}`);
        seen.add(m.name);
        if (!INT.test(m.value))
          this.err(where, `member ${m.name} value '${m.value}' is not a decimal string`);
      }
    }
    for (const x of p.externs) {
      const builtin = x.kind === "type" && x.builtin;
      if (!builtin && !modules.has(x.module))
        this.err(`extern ${x.id}`, `unknown module ${x.module}`);
    }
    for (const c of p.consts)
      if (!modules.has(c.module)) this.err(`const ${c.name}`, `unknown module ${c.module}`);
    for (const r of p.roots) {
      if (!structs.has(r.struct)) this.err(`root ${r.name}`, `unknown struct ${r.struct}`);
      if (!modules.has(r.module)) this.err(`root ${r.name}`, `unknown module ${r.module}`);
    }
  }

  // ── expressions and types ────────────────────────────────────────────────

  private checkValueType(t: IrValueType, where: string): void {
    switch (t.kind) {
      case "struct":
        if (!this.structs.has(t.struct))
          this.err(where, `value type references unknown struct ${t.struct}`);
        break;
      case "enum":
        if (!this.enums.has(t.enum))
          this.err(where, `value type references unknown enum ${t.enum}`);
        break;
      case "array":
        this.checkValueType(t.element, where);
        break;
      case "nullable":
        this.checkValueType(t.inner, where);
        break;
      case "union":
        for (const v of t.variants) this.checkValueType(v.type, where);
        break;
      case "extern":
        if (!this.externs.has(t.extern))
          this.err(where, `value type references unknown extern ${t.extern}`);
        break;
      default:
        break;
    }
  }

  private checkExpr(e: IrExpr, c: ExprCtx): void {
    const where = `${c.struct.id} (${c.where})`;
    this.checkValueType(e.type, where);
    switch (e.kind) {
      case "literal":
        if (e.value.kind === "int" && !INT.test(e.value.value))
          this.err(where, `int literal '${e.value.value}' is not a decimal string`);
        if (e.value.kind === "enum") {
          const lit = e.value;
          const en = this.enums.get(lit.enum);
          if (!en) this.err(where, `unknown enum ${lit.enum}`);
          else if (!en.members.some(m => m.name === lit.member))
            this.err(where, `enum ${en.id} has no member ${lit.member}`);
        }
        break;
      case "field":
        if (!c.allFields.has(e.name)) this.err(where, `unknown field '${e.name}'`);
        else if (c.visible && !c.visible.has(e.name))
          this.err(where, `field '${e.name}' is not declared before this read-side expression`);
        break;
      case "param":
        if (!c.struct.params.some(p => p.name === e.name))
          this.err(where, `unknown param '${e.name}'`);
        break;
      case "it":
        if (!c.it) this.err(where, "`it` outside a transform, check or derive");
        break;
      case "lambdaParam":
        if (!c.lambdas?.includes(e.name))
          this.err(where, `lambda parameter '${e.name}' outside its lambda`);
        break;
      case "lambda":
        this.err(where, "a lambda outside the second argument of map/filter/indicesWhere/sortedBy");
        break;
      case "builtinValue":
        break;
      case "member":
        this.checkExpr(e.object, c);
        break;
      case "index":
        this.checkExpr(e.object, c);
        this.checkExpr(e.index, c);
        break;
      case "map":
        this.checkExpr(e.array, c);
        break;
      case "unary":
        this.checkExpr(e.operand, c);
        break;
      case "binary":
        this.checkExpr(e.left, c);
        this.checkExpr(e.right, c);
        if (ARITH_OPS.includes(e.op)) {
          if (e.type.kind !== "bigint" && e.type.kind !== "float")
            this.err(
              where,
              `arithmetic '${e.op}' has type ${e.type.kind} (expected bigint or float)`
            );
          if (e.left.type.kind !== e.type.kind || e.right.type.kind !== e.type.kind) {
            this.err(
              where,
              `operands of '${e.op}' (${e.left.type.kind}, ${e.right.type.kind}) don't match the result type ${e.type.kind}`
            );
          }
        } else if (e.type.kind !== "bool") this.err(where, `'${e.op}' must have type bool`);
        break;
      case "cond":
        this.checkExpr(e.test, c);
        this.checkExpr(e.then, c);
        this.checkExpr(e.else, c);
        if (e.test.type.kind !== "bool") this.err(where, "condition test is not bool");
        break;
      case "call":
        this.checkCall(e, c, where);
        break;
      case "in":
        this.checkExpr(e.value, c);
        for (const it of e.items) {
          if (it.kind === "value") this.checkExpr(it.value, c);
          else {
            this.checkExpr(it.low, c);
            this.checkExpr(it.high, c);
          }
        }
        break;
      case "regex":
        this.checkExpr(e.value, c);
        try {
          new RegExp(e.pattern, "u");
        } catch {
          this.err(where, `invalid regex ${e.pattern}`);
        }
        break;
      case "convert":
        this.checkExpr(e.operand, c);
        break;
      case "this":
        if (!(e.type.kind === "struct" && e.type.struct === c.struct.id))
          this.err(where, "`this` must have the current struct's type");
        break;
    }
  }

  private checkCall(e: IrExpr & { kind: "call" }, c: ExprCtx, where: string): void {
    const builtin = e.callee.kind === "builtin" ? e.callee.name : undefined;
    const takesLambda = builtin !== undefined && LAMBDA_BUILTINS.has(builtin);
    e.args.forEach((a, i) => {
      if (i === 1 && a.kind === "lambda" && takesLambda) {
        this.checkValueType(a.type, where);
        this.checkExpr(a.body, { ...c, lambdas: [...(c.lambdas ?? []), a.param] });
      } else this.checkExpr(a, c);
    });
    if (takesLambda) {
      if (e.args[1]?.kind !== "lambda")
        this.err(where, `${builtin} needs a lambda as its second argument`);
      if (e.type.kind !== "array" && e.type.kind !== "bytes")
        this.err(where, `${builtin} must have an array type`);
    }
    if (builtin === "isNull" && e.args[0] && e.args[0].type.kind !== "nullable")
      this.err(where, "isNull needs a nullable operand");
    if (e.callee.kind === "builtin") {
      const name = e.callee.name;
      const ar = BUILTIN_ARITY[name];
      if (!ar) this.err(where, `unknown builtin ${name}`);
      else if (e.args.length < ar[0] || e.args.length > ar[1])
        this.err(where, `${name} takes ${ar[0]}..${ar[1]} args, got ${e.args.length}`);
      if (
        FIELD_BUILTINS.includes(name) &&
        e.args[0]?.kind !== "field" &&
        e.args[0]?.kind !== "this"
      ) {
        this.err(where, `${name} needs a field argument`);
      }
    } else {
      const x = this.externs.get(e.callee.extern);
      if (!x || x.kind !== "fn") this.err(where, `call to unknown extern fn ${e.callee.extern}`);
      else if (x.params.length !== e.args.length)
        this.err(where, `${x.name} takes ${x.params.length} args, got ${e.args.length}`);
    }
  }

  private checkLength(l: IrLength, c: ExprCtx): void {
    if (l.kind === "count") this.checkExpr(l.expr, c);
    else if (l.kind === "until" || l.kind === "before") this.checkExpr(l.terminator, c);
    else if (l.kind === "untilPredicate") this.checkExpr(l.predicate, { ...c, it: true });
  }

  private checkLayer(l: IrLayer, c: ExprCtx): void {
    const where = `${c.struct.id} (${c.where})`;
    switch (l.kind) {
      case "size":
        this.checkExpr(l.size, c);
        break;
      case "via": {
        const x = this.externs.get(l.codec);
        if (!x || x.kind !== "codec") this.err(where, `via references unknown codec ${l.codec}`);
        else if (x.params.length !== l.args.length)
          this.err(where, `codec ${x.name} takes ${x.params.length} args, got ${l.args.length}`);
        for (const a of l.args) this.checkExpr(a, c);
        break;
      }
      case "align":
      case "alignEnd":
        this.checkExpr(l.to, c);
        if (l.fill.kind === "fn") this.checkExpr(l.fill.expr, { ...c, lambdas: [l.fill.param] });
        if (l.from !== undefined && l.from !== "base" && l.from !== "file")
          this.err(where, `${l.kind} from must be "base" or "file"`);
        if (l.offset) this.checkExpr(l.offset, c);
        break;
      case "padBefore":
      case "padAfter":
        this.checkExpr(l.count, c);
        if (l.fill.kind === "fn") this.checkExpr(l.fill.expr, { ...c, lambdas: [l.fill.param] });
        break;
      case "padUntil":
        this.checkExpr(l.size, c);
        if (l.fill.kind === "fn") this.checkExpr(l.fill.expr, { ...c, lambdas: [l.fill.param] });
        break;
      case "endian":
        this.checkExpr(l.value, c);
        if (l.value.type.kind !== "endian") this.err(where, "endian layer value is not an endian");
        break;
      case "strict":
        break;
    }
    if ("strict" in l && l.strict !== undefined && l.strict !== true)
      this.err(where, `${l.kind} strict must be true when present`);
  }

  private checkType(t: IrType, c: ExprCtx): void {
    const where = `${c.struct.id} (${c.where})`;
    switch (t.kind) {
      case "prim":
        if (!PRIM_BITS[t.prim]) this.err(where, `unknown prim ${t.prim}`);
        break;
      case "string":
        if ((t.unit === 1) !== ["utf8", "ascii", "latin1"].includes(t.encoding))
          this.err(where, `string unit ${t.unit} doesn't match encoding ${t.encoding}`);
        this.checkLength(t.length, c);
        break;
      case "bytes":
        this.checkLength(t.length, c);
        break;
      case "array":
        this.checkType(t.element, c);
        this.checkLength(t.length, c);
        if (t.elementPlacement) this.checkExpr(t.elementPlacement, c);
        break;
      case "struct": {
        const s = this.structs.get(t.struct);
        if (!s) this.err(where, `unknown struct ${t.struct}`);
        else if (s.params.length !== t.args.length)
          this.err(
            where,
            `${t.struct} has ${s.params.length} params but ${t.args.length} args are passed`
          );
        for (const a of t.args) this.checkExpr(a, c);
        break;
      }
      case "enum":
        if (!this.enums.has(t.enum)) this.err(where, `unknown enum ${t.enum}`);
        break;
      case "pointer":
        if (!isIntPrim(t.storage))
          this.err(where, `pointer storage ${t.storage} is not an integer`);
        if (t.nullValue !== undefined && !INT.test(t.nullValue))
          this.err(where, `pointer nullValue '${t.nullValue}' is not a decimal string`);
        if (t.emptyIsNull && t.nullValue === undefined)
          this.err(where, "emptyIsNull needs a nullValue");
        if (t.origin) this.checkExpr(t.origin, { ...c, visible: undefined });
        this.checkType(t.target, c);
        break;
      case "extern": {
        const x = this.externs.get(t.extern);
        if (!x || x.kind !== "type") this.err(where, `unknown extern type ${t.extern}`);
        else if (x.params.length !== t.args.length)
          this.err(where, `${x.name} takes ${x.params.length} args, got ${t.args.length}`);
        for (const a of t.args) this.checkExpr(a, c);
        break;
      }
      case "union":
        if (!t.variants.length) this.err(where, "union without variants");
        for (const v of t.variants) this.checkType(v.type, c);
        break;
      case "transform":
        this.checkType(t.inner, c);
        this.checkExpr(t.read, { ...c, it: true });
        if (t.write) this.checkExpr(t.write, { ...c, it: true, visible: undefined });
        break;
      case "layered":
        if (!t.layers.length) this.err(where, "layered type without layers");
        this.checkType(t.inner, c);
        for (const l of t.layers) this.checkLayer(l, c);
        break;
      case "bool":
        break;
    }
  }

  // ── structs ──────────────────────────────────────────────────────────────

  private checkStruct(s: IrStruct): void {
    this.checkParams(s);
    const allFields = new Set(flatFields(s.members).map(f => f.name as string));
    const visible = new Set<string>();
    const base: ExprCtx = { struct: s, visible, allFields, it: false, where: "struct" };
    for (const l of s.layers) this.checkLayer(l, { ...base, visible: new Set() });
    const scope: StructScope = { s, base, visible, allFields, carriers: [] };
    this.checkMembers(s.members, scope);
    for (const name of scope.carriers) this.checkCarrierReads(s, name);
    this.checkLayoutItems(s.layout ?? [], s, `${s.id} layout`, base);
  }

  private checkParams(s: IrStruct): void {
    const where = `struct ${s.id}`;
    const names = new Set<string>();
    if (!s.params.length) this.err(where, "the first param must be the implicit endian param");
    s.params.forEach((pp, i) => {
      if (names.has(pp.name)) this.err(where, `duplicate param ${pp.name}`);
      names.add(pp.name);
      if (i === 0 && (pp.origin !== "endian" || pp.name !== "endian"))
        this.err(where, "the first param must be the implicit endian param");
      if (pp.origin === "endian" && pp.type.kind !== "endian")
        this.err(where, "endian param must have type endian");
      if ((pp.origin === "bound") !== (pp.boundName !== undefined))
        this.err(where, `param ${pp.name}: boundName iff origin bound`);
      this.checkValueType(pp.type, where);
    });
  }

  private writeCtx(sc: StructScope, where: string): ExprCtx {
    return { struct: sc.s, allFields: sc.allFields, it: true, where };
  }

  private checkMembers(ms: IrMember[], sc: StructScope): void {
    const { s, base, visible } = sc;
    for (const m of ms) {
      switch (m.kind) {
        case "field":
          this.checkField(m, sc);
          break;
        case "bits": {
          const bits = PRIM_BITS[m.storage];
          if (!isIntPrim(m.storage))
            this.err(`${s.id} bits`, `storage ${m.storage} is not an integer`);
          let used = 0n;
          for (const f of m.fields) {
            const label = f.name ?? "(reserved)";
            if (f.width <= 0 || f.shift < 0 || (bits !== undefined && f.shift + f.width > bits))
              this.err(
                `${s.id} bits`,
                `field ${label} shift ${f.shift} width ${f.width} doesn't fit ${m.storage}`
              );
            const mask = ((1n << BigInt(f.width)) - 1n) << BigInt(f.shift);
            if (used & mask) this.err(`${s.id} bits`, `field ${label} overlaps another bitfield`);
            used |= mask;
            const c: ExprCtx = { ...base, visible: new Set(visible), where: `bitfield ${f.name}` };
            if (f.name) visible.add(f.name);
            for (const ch of f.checks)
              this.checkExpr(ch.expr, { ...c, visible: new Set(visible), it: true });
            if (f.derive) this.checkExpr(f.derive, this.writeCtx(sc, `derive of ${f.name}`));
          }
          break;
        }
        case "block": {
          const c: ExprCtx = { ...base, visible: new Set(visible), where: "block" };
          if (m.condition) {
            this.checkExpr(m.condition, c);
            if (m.condition.type.kind !== "bool")
              this.err(`${s.id} block`, "condition is not bool");
          }
          for (const l of m.layers) this.checkLayer(l, c);
          this.checkMembers(m.members, sc);
          if (m.else) this.checkMembers(m.else, sc);
          break;
        }
        case "switch": {
          const c: ExprCtx = { ...base, visible: new Set(visible), where: "switch" };
          this.checkExpr(m.discriminant, c);
          if (
            m.discriminantField &&
            !(m.discriminant.kind === "field" && m.discriminant.name === m.discriminantField)
          ) {
            this.err(`${s.id} switch`, "discriminantField must name the discriminant field");
          }
          const dk = m.discriminant.type.kind === "bigint" ? "int" : m.discriminant.type.kind;
          for (const cs of m.cases) {
            for (const v of cs.values) {
              if (v.kind !== dk && dk !== "extern")
                this.err(
                  `${s.id} switch`,
                  `case value kind ${v.kind} doesn't match discriminant ${m.discriminant.type.kind}`
                );
            }
            this.checkMembers(cs.members, sc);
          }
          if (m.default) this.checkMembers(m.default, sc);
          break;
        }
      }
    }
  }

  private checkField(m: IrMember & { kind: "field" }, sc: StructScope): void {
    const { s, base, visible } = sc;
    const fw = `${s.id} field ${m.name}`;
    const c: ExprCtx = { ...base, visible: new Set(visible), where: `field ${m.name}` };
    this.checkType(m.type, c);
    if (m.placement) {
      this.checkExpr(m.placement.offset, c);
      const k = m.placement.constraint;
      if (k && (!INT.test(k.modulus) || !INT.test(k.remainder)))
        this.err(fw, "placement constraint values must be decimal strings");
    }
    if (m.placement && m.from) this.err(fw, "both placement and from");
    if (m.from) {
      let st = m.from.stream;
      while (st.kind === "slice") {
        this.checkExpr(st.start, c);
        if (st.end) this.checkExpr(st.end, c);
        st = st.stream;
      }
      const n = st.kind === "field" ? st.field : st.array;
      if (!visible.has(n)) this.err(fw, `stream source '${n}' is not an earlier field`);
    }
    if (m.virtual) {
      if (m.type.kind !== "prim" || m.type.prim.startsWith("f"))
        this.err(fw, "a virtual field must have an integer prim type");
      if (m.placement || m.from) this.err(fw, "a virtual field has no placement or stream");
      if (m.hidden) this.err(fw, "a virtual field can't be hidden");
      if (m.input === "absent") this.err(fw, "a virtual field's value comes from the input");
      if (m.carrier) this.err(fw, "a virtual field can't be a carrier");
      this.checkExpr(m.virtual.read, { ...c, where: `virtual ${m.name}` });
    }
    if (m.carrier !== undefined) {
      if (m.carrier !== "slices") this.err(fw, `unknown carrier ${String(m.carrier)}`);
      if (coreType(m.type).kind !== "bytes") this.err(fw, "a slices carrier must be a bytes field");
      if (m.input !== "absent") this.err(fw, "a slices carrier has input absent");
      if (m.derive) this.err(fw, "a slices carrier has no derive");
      sc.carriers.push(m.name);
    }
    visible.add(m.name);
    for (const ch of m.checks)
      this.checkExpr(ch.expr, {
        ...c,
        visible: new Set(visible),
        it: true,
        where: `check of ${m.name}`
      });
    if (m.derive) this.checkExpr(m.derive, this.writeCtx(sc, `derive of ${m.name}`));
    if ((m.derive === undefined) !== (m.deriveKind === undefined))
      this.err(fw, "derive and deriveKind must come together");
    if (m.hidden && (m.output || m.input !== "absent"))
      this.err(fw, "hidden fields have output false and input absent");
    if (!m.hidden && !m.output) this.err(fw, "output is false only for hidden fields");
    if (m.input === "required" && m.derive && !containsIt(m.derive))
      this.err(fw, "a required field's derive must use `it` (normalize on write)");
    if (m.input === "optional" && !m.derive) this.err(fw, "optional input needs a derive");
  }

  /** A slices carrier is read only through `from` slices (derives may measure it). */
  private checkCarrierReads(s: IrStruct, name: string): void {
    let sliced = false;
    let direct = false;
    const v: Visitor = {
      expr: x => {
        if (x.kind === "field" && x.name === name) direct = true;
      }
    };
    const readSide = (ms: IrMember[]) => {
      for (const m of ms) {
        if (m.kind === "field") {
          visitType(m.type, v);
          if (m.placement) visitExpr(m.placement.offset, v);
          if (m.virtual) visitExpr(m.virtual.read, v);
          for (const c of m.checks) visitExpr(c.expr, v);
          let st = m.from?.stream;
          while (st && st.kind === "slice") {
            visitExpr(st.start, v);
            if (st.end) visitExpr(st.end, v);
            st = st.stream;
          }
        } else if (m.kind === "bits") {
          for (const f of m.fields) for (const c of f.checks) visitExpr(c.expr, v);
        } else if (m.kind === "block") {
          if (m.condition) visitExpr(m.condition, v);
          for (const l of m.layers) visitLayer(l, v);
          readSide(m.members);
          if (m.else) readSide(m.else);
        } else {
          visitExpr(m.discriminant, v);
          for (const c of m.cases) readSide(c.members);
          if (m.default) readSide(m.default);
        }
      }
    };
    readSide(s.members);
    for (const f of flatFields(s.members)) {
      if (f.kind !== "field" || !f.from) continue;
      let st = f.from.stream;
      const isSlice = st.kind === "slice";
      while (st.kind === "slice") st = st.stream;
      const src = st.kind === "field" ? st.field : st.array;
      if (src !== name) continue;
      if (isSlice) sliced = true;
      else direct = true;
    }
    if (!sliced) this.err(`${s.id} field ${name}`, "a slices carrier needs `from` slices of it");
    if (direct)
      this.err(`${s.id} field ${name}`, "a slices carrier is read only through its slices");
  }

  /** Layout items; per-element groups resolve against the element struct. */
  private checkLayoutItems(list: IrLayoutItem[], owner: IrStruct, where: string, base: ExprCtx) {
    const ownerFields = new Set(flatFields(owner.members).map(f => f.name));
    for (const item of list) {
      if (item.path !== "this") {
        const first = item.path[0];
        if (!first || first.kind !== "field" || !ownerFields.has(first.name))
          this.err(where, `path must start with a field of ${owner.id}`);
        else {
          const t = resolvePath(owner, item.path, this.structs);
          if (typeof t === "string") this.err(where, t);
          else if (item.group) {
            const elem = groupElement(t, this.structs);
            if (typeof elem === "string") this.err(where, elem);
            else
              this.checkLayoutItems(
                item.group.items,
                elem,
                `${where} group ${pathText(item.path)}`,
                base
              );
          }
        }
      } else if (item.group) this.err(where, "`this` can't have a group");
      for (const l of item.layers) this.checkLayer(l, { ...base, visible: undefined });
    }
  }
}

function isIntPrim(p: string): boolean {
  return !!PRIM_BITS[p] && !p.startsWith("f");
}

function pathText(p: IrPathSegment[]): string {
  return p.map((x, i) => (x.kind === "each" ? "[*]" : (i ? "." : "") + x.name)).join("");
}

function coreType(t: IrType): IrType {
  while (t.kind === "layered" || t.kind === "transform") t = t.inner;
  return t;
}

/** Strips layers, transforms and one pointer level. */
function targetCore(t: IrType): IrType {
  const u = coreType(t);
  return u.kind === "pointer" ? coreType(u.target) : u;
}

/** The type a layout path names inside `s`, or a problem. */
function resolvePath(
  s: IrStruct,
  path: IrPathSegment[],
  structs: Map<string, IrStruct>
): IrType | string {
  let owner: IrStruct | undefined = s;
  let t: IrType | undefined;
  for (const seg of path) {
    if (seg.kind === "each") {
      const u = t && targetCore(t);
      if (!u || u.kind !== "array") return `[*] in ${pathText(path)} needs an array`;
      t = u.element;
      continue;
    }
    if (t) {
      const u = targetCore(t);
      if (u.kind !== "struct") return `${pathText(path)}: '${seg.name}' is not inside a struct`;
      owner = structs.get(u.struct);
      if (!owner) return `${pathText(path)}: unknown struct ${u.struct}`;
    }
    const f = flatFields(owner!.members).find(x => x.name === seg.name);
    if (!f) return `${pathText(path)}: ${owner!.id} has no field '${seg.name}'`;
    t = f.type;
  }
  return t ?? `empty layout path`;
}

/** A group's path names an array; its elements (through pointers) must be structs. */
function groupElement(t: IrType, structs: Map<string, IrStruct>): IrStruct | string {
  const u = targetCore(t);
  if (u.kind !== "array") return "a layout group's path must name an array";
  const e = targetCore(u.element);
  if (e.kind !== "struct") return "a layout group needs struct elements";
  return structs.get(e.struct) ?? `unknown struct ${e.struct}`;
}
