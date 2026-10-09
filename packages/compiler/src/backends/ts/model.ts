/**
 * Program model for the TS backend: lookups plus the static analyses the emitters need
 * (placeables, static sizes, async-ness, field tables, type keys).
 */
import type {
  IrBitField,
  IrEnum,
  IrExpr,
  IrExtern,
  IrExternCodec,
  IrField,
  IrLayer,
  IrLayoutItem,
  IrLength,
  IrMember,
  IrProgram,
  IrStruct,
  IrType,
  IrValueType
} from "../../ir/index.ts";
import { visitExpr } from "../../ir/walk.ts";
import { typeName } from "./code.ts";
import { ExprCompiler, constCtx, type CExpr, type ExprCtx } from "./expr.ts";

/** A named value in a struct (an IrField or a named bitfield), in declaration order. */
export interface FieldRef {
  name: string;
  field?: IrField;
  bit?: IrBitField;
  /** Inside an `if` without else, an if/else branch, or a switch case. */
  conditional: boolean;
}

export class Model {
  readonly program: IrProgram;
  readonly structs = new Map<string, IrStruct>();
  readonly enums = new Map<string, IrEnum>();
  readonly externs = new Map<string, IrExtern>();
  private readonly placeableMemo = new Map<string, boolean>();
  private readonly fieldsMemo = new Map<string, FieldRef[]>();
  private readonly sizeMemo = new Map<string, number | null>();
  /** Type keys of `@ref` pointer targets: values of these types register as ref sites. */
  readonly refTargetKeys = new Set<string>();
  /** "structId.field" of bytes fields that `from arr[*].field` streams join (kept when hidden). */
  readonly streamPieces = new Set<string>();
  /** Structs that pointers or `at` fields can target: their inline values join the identity map. */
  readonly identityStructs = new Set<string>();

  constructor(input: IrProgram) {
    // Work on a copy: the model normalizes a few things in place.
    const program = structuredClone(input);
    this.program = program;
    for (const s of program.structs) this.structs.set(s.id, s);
    for (const e of program.enums) this.enums.set(e.id, e);
    for (const x of program.externs) this.externs.set(x.id, x);
    const noteTarget = (t: IrType): void => {
      const x = stripType(t);
      if (x.kind === "struct") this.identityStructs.add(x.struct);
      else if (x.kind === "array") noteTarget(x.element);
    };
    for (const s of program.structs) {
      this.walkTypes(s.members, t => {
        if (t.kind === "pointer") {
          if (t.ownership === "ref") this.refTargetKeys.add(this.typeKey(t.target));
          noteTarget(t.target);
        }
      });
      for (const m of allMembers(s.members)) {
        if (m.kind === "field" && m.placement) noteTarget(m.type);
      }
      for (const f of this.fields(s)) {
        let st = f.field?.from?.stream;
        while (st && st.kind === "slice") st = st.stream;
        if (st && st.kind === "each") {
          const piece = st.field;
          const arr = this.field(s, st.array)?.field;
          const t = arr && stripLayers(arr.type);
          const et = t && t.kind === "array" ? stripLayers(t.element) : undefined;
          if (et && et.kind === "struct") this.streamPieces.add(`${et.struct}.${piece}`);
        }
      }
    }
    this.normalizeTransforms();
  }

  /**
   * A transform whose value type is the exact intermediate `bigint` gets a concrete integer type
   * from the range of its read expression, so its TS type and JSON form are well defined
   * (number when the range is within 48 bits, bigint otherwise).
   */
  private normalizeTransforms(): void {
    const x = new ExprCompiler(this);
    for (const s of this.program.structs) {
      this.walkTypes(s.members, t => {
        if (t.kind !== "transform" || t.valueType.kind !== "bigint") return;
        const innerVt = this.readValueType(t.inner);
        // Only the range of the result matters: the code is never emitted.
        const stub = (type: IrValueType): CExpr => x.typed("x", type);
        const ctx: ExprCtx = {
          ...constCtx({ extern: () => "x", hoist: () => "x" }),
          field: (_n, type) => stub(type),
          param: (_n, type) => stub(type),
          it: () => stub(innerVt)
        };
        let range: [bigint, bigint] | undefined;
        try {
          range = x.compile(t.read, ctx).range;
        } catch {
          range = undefined;
        }
        if (range && range[0] >= -(1n << 47n) && range[1] < 1n << 47n) {
          t.valueType = { kind: "int", bits: 48, signed: true };
        } else if (range && range[0] >= 0n && range[1] < 1n << 48n) {
          t.valueType = { kind: "int", bits: 48, signed: false };
        } else {
          t.valueType = { kind: "int", bits: 64, signed: range ? range[0] < 0n : true };
        }
      });
    }
  }

  /** The value type produced by reading `t` (for `it`). */
  readValueType(t: IrType): IrValueType {
    switch (t.kind) {
      case "prim":
        if (t.prim[0] === "f")
          return { kind: "float", bits: Number(t.prim.slice(1)) as 16 | 32 | 64 };
        return { kind: "int", bits: Number(t.prim.slice(1)) as 8, signed: t.prim[0] === "i" };
      case "enum":
        return { kind: "enum", enum: t.enum };
      case "bool":
        return { kind: "bool" };
      case "string":
        return { kind: "string" };
      case "bytes":
        return { kind: "bytes" };
      case "struct":
        return { kind: "struct", struct: t.struct };
      case "transform":
        return t.valueType;
      case "layered":
        return this.readValueType(t.inner);
      case "array":
        return { kind: "array", element: this.readValueType(t.element) };
      default:
        return { kind: "bigint" };
    }
  }

  struct(id: string): IrStruct {
    const s = this.structs.get(id);
    if (!s) throw new Error(`unknown struct ${id}`);
    return s;
  }

  enum(id: string): IrEnum {
    const e = this.enums.get(id);
    if (!e) throw new Error(`unknown enum ${id}`);
    return e;
  }

  extern(id: string): IrExtern {
    const x = this.externs.get(id);
    if (!x) throw new Error(`unknown extern ${id}`);
    return x;
  }

  codec(id: string): IrExternCodec {
    const x = this.extern(id);
    if (x.kind !== "codec") throw new Error(`extern ${id} is not a codec`);
    return x;
  }

  /** TS identifier of a struct. */
  structName(id: string): string {
    return typeName(this.struct(id).name);
  }

  enumName(id: string): string {
    return typeName(this.enum(id).name);
  }

  /** Calls `f` for every type reachable from the members (not descending into other structs). */
  walkTypes(members: readonly IrMember[], f: (t: IrType) => void): void {
    const visit = (t: IrType): void => {
      f(t);
      switch (t.kind) {
        case "array":
          visit(t.element);
          break;
        case "pointer":
          visit(t.target);
          break;
        case "union":
          for (const v of t.variants) visit(v.type);
          break;
        case "transform":
        case "layered":
          visit(t.inner);
          break;
      }
    };
    for (const m of allMembers(members)) {
      if (m.kind === "field") visit(m.type);
      else if (m.kind === "bits") for (const b of m.fields) visit(b.type);
    }
  }

  /** Every named field of a struct, flattened in declaration order. */
  fields(s: IrStruct): FieldRef[] {
    const hit = this.fieldsMemo.get(s.id);
    if (hit) return hit;
    const out: FieldRef[] = [];
    const walk = (ms: readonly IrMember[], cond: boolean): void => {
      for (const m of ms) {
        if (m.kind === "field") out.push({ name: m.name, field: m, conditional: cond });
        else if (m.kind === "bits") {
          for (const b of m.fields)
            if (b.name !== null) out.push({ name: b.name, bit: b, conditional: cond });
        } else if (m.kind === "block") {
          walk(m.members, cond || m.condition !== undefined);
          if (m.else) walk(m.else, true);
        } else {
          for (const c of m.cases) walk(c.members, true);
          if (m.default) walk(m.default, true);
        }
      }
    };
    walk(s.members, false);
    this.fieldsMemo.set(s.id, out);
    return out;
  }

  field(s: IrStruct, name: string): FieldRef | undefined {
    return this.fields(s).find(f => f.name === name);
  }

  // ── placeables ────────────────────────────────────────────────────────────

  /** True if writing a value of this type can create placeables in the enclosing base region. */
  hasPlaceables(t: IrType): boolean {
    switch (t.kind) {
      case "pointer":
        return t.ownership === "owned";
      case "struct":
        return this.structHasPlaceables(t.struct);
      case "array":
        return t.elementPlacement !== undefined || this.hasPlaceables(t.element);
      case "union":
        return t.variants.some(v => this.hasPlaceables(v.type));
      case "transform":
        return this.hasPlaceables(t.inner);
      case "layered":
        return !t.layers.some(l => l.kind === "via") && this.hasPlaceables(t.inner);
      default:
        return false;
    }
  }

  /** True if the struct's members (not crossing its own base) create placeables. */
  structHasPlaceables(id: string): boolean {
    const hit = this.placeableMemo.get(id);
    if (hit !== undefined) return hit;
    const s = this.struct(id);
    this.placeableMemo.set(id, false);
    let v = false;
    if (!s.base && !s.layers.some(l => l.kind === "via")) {
      v = this.membersHavePlaceables(s.members);
    }
    this.placeableMemo.set(id, v);
    return v;
  }

  /** Same as structHasPlaceables but ignoring the struct's own `base` flag (its region contents). */
  membersHavePlaceables(ms: readonly IrMember[]): boolean {
    for (const m of allMembers(ms)) {
      if (m.kind !== "field") continue;
      if (m.placement || (!m.from && this.hasPlaceables(m.type))) return true;
    }
    return false;
  }

  /** True if an element of type `t` reads `$index` (its index in the array). */
  elementUsesIndex(t: IrType): boolean {
    switch (t.kind) {
      case "struct":
        return usesIndex(this.struct(t.struct));
      case "layered":
      case "transform":
        return this.elementUsesIndex(t.inner);
      case "pointer":
        return this.elementUsesIndex(t.target);
      case "union":
        return t.variants.some(v => this.elementUsesIndex(v.type));
      default:
        return false;
    }
  }

  // ── async ─────────────────────────────────────────────────────────────────

  isAsyncType(t: IrType): boolean {
    switch (t.kind) {
      case "struct":
        return this.struct(t.struct).async;
      case "array":
        return this.isAsyncType(t.element);
      case "pointer":
        return this.isAsyncType(t.target);
      case "union":
        return t.variants.some(v => this.isAsyncType(v.type));
      case "transform":
        return this.isAsyncType(t.inner);
      case "layered":
        return (
          t.layers.some(l => l.kind === "via" && this.codec(l.codec).async) ||
          this.isAsyncType(t.inner)
        );
      default:
        return false;
    }
  }

  // ── static sizes ──────────────────────────────────────────────────────────

  /** Inline size in bytes if it is the same for every value, else undefined. */
  staticSize(t: IrType): number | undefined {
    switch (t.kind) {
      case "prim":
        return primSize(t.prim);
      case "bool":
        return 1;
      case "enum":
        return primSize(this.enum(t.enum).storage);
      case "pointer":
        return primSize(t.storage);
      case "string": {
        const n = t.length.kind === "count" ? literalInt(t.length.expr) : undefined;
        return n === undefined ? undefined : n * t.unit;
      }
      case "bytes":
        return t.length.kind === "count" ? literalInt(t.length.expr) : undefined;
      case "array": {
        if (t.elementPlacement) return 0;
        const n = t.length.kind === "count" ? literalInt(t.length.expr) : undefined;
        const e = this.staticSize(t.element);
        return n === undefined || e === undefined ? undefined : n * e;
      }
      case "struct":
        return this.structStaticSize(t.struct);
      case "extern": {
        const x = this.extern(t.extern);
        return x.kind === "type" ? x.fixedSize : undefined;
      }
      case "transform":
        return this.staticSize(t.inner);
      case "layered": {
        const inner = this.staticSize(t.inner);
        return inner === undefined ? undefined : this.layersStatic(inner, t.layers);
      }
      case "union":
        return undefined;
    }
  }

  structStaticSize(id: string): number | undefined {
    if (this.sizeMemo.has(id)) return this.sizeMemo.get(id) ?? undefined;
    this.sizeMemo.set(id, null);
    const s = this.struct(id);
    let size = s.base ? undefined : this.membersStaticSize(s.members);
    if (size !== undefined) size = this.layersStatic(size, s.layers);
    this.sizeMemo.set(id, size ?? null);
    return size;
  }

  /** Static inline size of a member list (unconditional members only). */
  membersStaticSize(ms: readonly IrMember[]): number | undefined {
    let size = 0;
    for (const m of ms) {
      if (m.kind === "field") {
        if (m.placement || m.from || m.virtual) continue;
        const n = this.staticSize(m.type);
        if (n === undefined) return undefined;
        size += n;
      } else if (m.kind === "bits") size += primSize(m.storage);
      else if (m.kind === "block" && m.condition === undefined) {
        const inner = this.membersStaticSize(m.members);
        const n = inner === undefined ? undefined : this.layersStatic(inner, m.layers);
        if (n === undefined) return undefined;
        size += n;
      } else return undefined;
    }
    return size;
  }

  /** Applies size-changing layers with literal arguments; undefined if not static. */
  layersStatic(inner: number, layers: readonly IrLayer[]): number | undefined {
    let size: number | undefined = inner;
    for (const l of layers) {
      if (size === undefined) return undefined;
      if (l.kind === "size") size = literalInt(l.size);
      else if (l.kind === "padUntil") {
        const n = literalInt(l.size);
        size = n === undefined ? undefined : Math.max(n, size);
      } else if (l.kind === "padBefore" || l.kind === "padAfter") {
        const n = literalInt(l.count);
        size = n === undefined ? undefined : size + n;
      } else if (l.kind !== "endian" && l.kind !== "strict") return undefined;
    }
    return size;
  }

  // ── type keys ─────────────────────────────────────────────────────────────

  /** Canonical key of a type (identity of pointer targets, `@ref` matching). Ignores expressions. */
  typeKey(t: IrType): string {
    switch (t.kind) {
      case "prim":
        return t.prim + (t.endian === "inherit" ? "" : t.endian);
      case "bool":
        return "bool";
      case "string":
        return `str:${t.encoding}:${t.unit}:${t.endian}:${t.length.kind}`;
      case "bytes":
        return `bytes:${t.length.kind}`;
      case "array":
        return `[${this.typeKey(t.element)}:${t.length.kind}]`;
      case "struct":
        return this.struct(t.struct).name;
      case "enum":
        return `enum:${t.enum}`;
      case "pointer":
        return `*${this.typeKey(t.target)}`;
      case "extern":
        return `extern:${t.extern}`;
      case "union":
        return `union(${t.variants.map(v => v.name).join("|")})`;
      case "transform":
        return `as(${this.typeKey(t.inner)})`;
      case "layered":
        return `layers(${this.typeKey(t.inner)}:${t.layers.map(l => l.kind).join(",")})`;
    }
  }

  isRefTarget(t: IrType): boolean {
    return this.refTargetKeys.size > 0 && this.refTargetKeys.has(this.typeKey(t));
  }
}

export function primSize(p: string): number {
  return Number(p.slice(1)) / 8;
}

export function primIsBig(p: string): boolean {
  return p[0] !== "f" && Number(p.slice(1)) > 48;
}

export function literalInt(e: IrExpr): number | undefined {
  if (e.kind === "literal" && e.value.kind === "int") {
    const n = Number(e.value.value);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  if (e.kind === "convert") return literalInt(e.operand);
  return undefined;
}

/** True if a value type is represented as bigint in TS. */
export function isBigType(t: IrValueType): boolean {
  return t.kind === "int" && t.bits > 48;
}

/**
 * The `@size` layer inside the codec at `layers[idx]` that gives its decoded size: the next one
 * inwards, unless another codec comes first.
 */
export function decodedSizeLayer(
  layers: readonly IrLayer[],
  idx: number
): Extract<IrLayer, { kind: "size" }> | undefined {
  for (let k = idx - 1; k >= 0; k--) {
    const l = layers[k]!;
    if (l.kind === "via") return undefined;
    if (l.kind === "size") return l;
  }
  return undefined;
}

/** The type under any layers. */
export function stripLayers(t: IrType): IrType {
  while (t.kind === "layered") t = t.inner;
  return t;
}

/** The storage type under any layers and transforms. */
export function stripType(t: IrType): IrType {
  while (t.kind === "layered" || t.kind === "transform") t = t.inner;
  return t;
}

/** A transform without a reverse (possibly under layers). */
export function isOneWay(t: IrType): boolean {
  const x = stripLayers(t);
  return x.kind === "transform" && !x.write;
}

/** Calls `f` for every node of an expression. */
export function walkExpr(e: IrExpr, f: (e: IrExpr) => void): void {
  visitExpr(e, { expr: f });
}

/** True if some node of `e` satisfies `pred`. */
export function someExpr(e: IrExpr, pred: (e: IrExpr) => boolean): boolean {
  let found = false;
  walkExpr(e, x => {
    if (!found && pred(x)) found = true;
  });
  return found;
}

/** Every member, descending into blocks (both branches) and switch cases, in declaration order. */
export function* allMembers(ms: readonly IrMember[]): Generator<IrMember> {
  for (const m of ms) {
    yield m;
    if (m.kind === "block") {
      yield* allMembers(m.members);
      if (m.else) yield* allMembers(m.else);
    } else if (m.kind === "switch") {
      for (const c of m.cases) yield* allMembers(c.members);
      if (m.default) yield* allMembers(m.default);
    }
  }
}

/** Calls `f` for every derive expression of the members (fields and bitfields). */
export function forEachDerive(ms: readonly IrMember[], f: (e: IrExpr) => void): void {
  for (const m of allMembers(ms)) {
    if (m.kind === "field" && m.derive) f(m.derive);
    else if (m.kind === "bits") for (const b of m.fields) if (b.derive) f(b.derive);
  }
}

const EXTENT_BUILTINS = new Set(["sizeof", "offsetof", "encodedSize", "bytesof", "encode"]);

/**
 * Calls `f` with the field (or "this") of every sizeof/offsetof/encodedSize/bytesof/encode in
 * `e`, and the builtin's name.
 */
export function forEachExtentRef(e: IrExpr, f: (field: string, builtin: string) => void): void {
  walkExpr(e, x => {
    if (x.kind !== "call" || x.callee.kind !== "builtin") return;
    if (!EXTENT_BUILTINS.has(x.callee.name)) return;
    const a = x.args[0];
    if (a?.kind === "field") f(a.name, x.callee.name);
    else if (a?.kind === "this") f("this", x.callee.name);
  });
}

/** Fields whose position or size read-side expressions use (sizeof/offsetof/… on read). */
export function readSideExtents(s: IrStruct): Set<string> {
  const out = new Set<string>();
  const scan = (e: IrExpr): void => forEachExtentRef(e, name => out.add(name));
  forEachReadExpr(s, scan);
  forEachOrigin(s, scan);
  return out;
}

function forEachLengthExpr(l: IrLength, f: (e: IrExpr) => void): void {
  if (l.kind === "count") f(l.expr);
  else if (l.kind === "until" || l.kind === "before") f(l.terminator);
  else if (l.kind === "untilPredicate") f(l.predicate);
}

/** Calls `f` for every read-side expression of a type (lengths, arguments, transforms, layers). */
function forEachTypeReadExpr(t: IrType, f: (e: IrExpr) => void): void {
  switch (t.kind) {
    case "string":
    case "bytes":
      forEachLengthExpr(t.length, f);
      break;
    case "array":
      forEachLengthExpr(t.length, f);
      if (t.elementPlacement) f(t.elementPlacement);
      forEachTypeReadExpr(t.element, f);
      break;
    case "struct":
    case "extern":
      t.args.forEach(f);
      break;
    case "pointer":
      forEachTypeReadExpr(t.target, f);
      break;
    case "union":
      t.variants.forEach(v => forEachTypeReadExpr(v.type, f));
      break;
    case "transform":
      f(t.read);
      forEachTypeReadExpr(t.inner, f);
      break;
    case "layered":
      forEachLayerExpr(t.layers, f);
      forEachTypeReadExpr(t.inner, f);
      break;
  }
}

function forEachLayerExpr(ls: readonly IrLayer[], f: (e: IrExpr) => void): void {
  for (const l of ls) {
    if (l.kind === "size") f(l.size);
    else if (l.kind === "via") l.args.forEach(f);
    else if (l.kind === "align" || l.kind === "alignEnd") {
      f(l.to);
      if (l.offset) f(l.offset);
    } else if (l.kind === "padBefore" || l.kind === "padAfter") f(l.count);
    else if (l.kind === "padUntil") f(l.size);
    else if (l.kind === "endian") f(l.value);
    if ("fill" in l && l.fill.kind === "fn") f(l.fill.expr);
  }
}

/** Calls `f` for every read-side expression of a struct (everything but derives). */
export function forEachReadExpr(s: IrStruct, f: (e: IrExpr) => void): void {
  for (const m of allMembers(s.members)) {
    if (m.kind === "field") {
      forEachTypeReadExpr(m.type, f);
      if (m.placement) f(m.placement.offset);
      if (m.virtual) f(m.virtual.read);
      for (let st = m.from?.stream; st?.kind === "slice"; st = st.stream) {
        f(st.start);
        if (st.end) f(st.end);
      }
      m.checks.forEach(c => f(c.expr));
    } else if (m.kind === "bits") {
      for (const b of m.fields) {
        b.checks.forEach(c => f(c.expr));
        forEachTypeReadExpr(b.type, f);
      }
    } else if (m.kind === "block") {
      if (m.condition) f(m.condition);
      forEachLayerExpr(m.layers, f);
    } else f(m.discriminant);
  }
  forEachLayerExpr(s.layers, f);
}

/** Calls `f` for every pointer `@origin` expression of a struct. */
export function forEachOrigin(s: IrStruct, f: (e: IrExpr) => void): void {
  const visit = (t: IrType): void => {
    if (t.kind === "pointer") {
      if (t.origin) f(t.origin);
      visit(t.target);
    } else if (t.kind === "array") visit(t.element);
    else if (t.kind === "layered" || t.kind === "transform") visit(t.inner);
  };
  for (const m of allMembers(s.members)) if (m.kind === "field") visit(m.type);
}

const isIndex = (x: IrExpr): boolean => x.kind === "builtinValue" && x.name === "index";

/** True if the struct reads `$index` outside element placements (its own index in an array). */
export function usesIndex(s: IrStruct): boolean {
  let found = false;
  const scan = (e: IrExpr): void => {
    if (!found && someExpr(e, isIndex)) found = true;
  };
  // Element placements bind their own $index.
  const arrayType = (t: IrType): void => {
    if (t.kind === "array") {
      if (t.length.kind === "count") scan(t.length.expr);
      arrayType(t.element);
    } else if (t.kind === "layered" || t.kind === "transform") arrayType(t.inner);
  };
  for (const m of allMembers(s.members)) {
    if (m.kind === "field") {
      if (m.placement) scan(m.placement.offset);
      if (m.virtual) scan(m.virtual.read);
      m.checks.forEach(c => scan(c.expr));
      if (m.derive) scan(m.derive);
      if (m.type.kind === "array") arrayType(m.type);
      else forEachTypeReadExpr(m.type, scan);
    } else if (m.kind === "block") {
      if (m.condition) scan(m.condition);
    } else if (m.kind === "switch") scan(m.discriminant);
  }
  return found;
}

/** True if any expression of the layout items reads `$index`. */
export function layoutUsesIndex(items: readonly IrLayoutItem[]): boolean {
  let found = false;
  forEachLayoutArg(items, e => {
    if (!found && someExpr(e, isIndex)) found = true;
  });
  return found;
}

/** What a layout layer argument is: an alignment (≥ 1), a residue offset, or a padding count. */
export type LayoutArgKind = "align" | "offset" | "count";

/** Calls `fn` on every argument of the layers the layout items (and their groups) use. */
export function forEachLayoutArg(
  items: readonly IrLayoutItem[],
  fn: (e: IrExpr, what: LayoutArgKind) => void
): void {
  for (const it of items) {
    for (const l of it.layers) {
      if (l.kind === "align") {
        fn(l.to, "align");
        if (l.offset) fn(l.offset, "offset");
      } else if (l.kind === "alignEnd") fn(l.to, "align");
      else if (l.kind === "padBefore" || l.kind === "padAfter") fn(l.count, "count");
    }
    if (it.group) forEachLayoutArg(it.group.items, fn);
  }
}

/** The value type a read of `t` produces (for `it` and comparisons). */
export function valueTypeOf(model: Model, t: IrType): IrValueType {
  switch (t.kind) {
    case "prim":
      if (t.prim[0] === "f")
        return { kind: "float", bits: Number(t.prim.slice(1)) as 16 | 32 | 64 };
      return {
        kind: "int",
        bits: Number(t.prim.slice(1)) as 8 | 16 | 24 | 32 | 40 | 48 | 56 | 64,
        signed: t.prim[0] === "i"
      };
    case "bool":
      return { kind: "bool" };
    case "string":
      return { kind: "string" };
    case "bytes":
      return { kind: "bytes" };
    case "array":
      return { kind: "array", element: valueTypeOf(model, t.element) };
    case "struct":
      return { kind: "struct", struct: t.struct };
    case "enum":
      return { kind: "enum", enum: t.enum };
    case "pointer": {
      const inner = valueTypeOf(model, t.target);
      return t.nullValue !== undefined && !t.emptyIsNull ? { kind: "nullable", inner } : inner;
    }
    case "extern": {
      const x = model.extern(t.extern);
      return x.kind === "type" ? x.valueType : { kind: "bytes" };
    }
    case "union":
      return {
        kind: "union",
        variants: t.variants.map(v => ({ name: v.name, type: valueTypeOf(model, v.type) }))
      };
    case "transform":
      return t.valueType;
    case "layered":
      return valueTypeOf(model, t.inner);
  }
}
