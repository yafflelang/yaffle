/**
 * Program model for the Python backend: lookups plus the static analyses the emitters need
 * (placeables, static sizes, field tables, type keys, identity structs). It makes the same
 * decisions as the TS backend's model.
 */
import type {
  IrBitField,
  IrEnum,
  IrExpr,
  IrExtern,
  IrExternCodec,
  IrField,
  IrLayer,
  IrMember,
  IrProgram,
  IrStreamExpr,
  IrStruct,
  IrType,
  IrValueType
} from "../../ir/index.ts";

/** A named value in a struct (an IrField or a named bitfield), in declaration order. */
export interface FieldRef {
  name: string;
  field?: IrField;
  bit?: IrBitField;
  /** Inside an `if` without else, an if/else branch, or a switch case. */
  conditional: boolean;
}

export type Range = [bigint, bigint];

export class Model {
  readonly program: IrProgram;
  readonly structs = new Map<string, IrStruct>();
  readonly enums = new Map<string, IrEnum>();
  readonly externs = new Map<string, IrExtern>();
  private readonly placeableMemo = new Map<string, boolean>();
  private readonly fieldsMemo = new Map<string, FieldRef[]>();
  private readonly sizeMemo = new Map<string, number | null>();
  /** Type keys of `@ref` pointer targets: values of these types register as ref sites. */
  private readonly refTargetKeys = new Set<string>();
  /** "structId.field" of bytes fields that `from arr[*].field` streams join (kept when hidden). */
  readonly streamPieces = new Set<string>();
  /** Structs that pointers or `at` fields can target: their inline values join the identity map. */
  readonly identityStructs = new Set<string>();

  constructor(input: IrProgram) {
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
        if (t.kind !== "pointer") return;
        if (t.ownership === "ref") this.refTargetKeys.add(this.typeKey(t.target));
        noteTarget(t.target);
      });
      for (const m of allMembers(s.members)) {
        if (m.kind === "field" && m.placement) noteTarget(m.type);
      }
      for (const f of this.fields(s)) {
        let st: IrStreamExpr | undefined = f.field?.from?.stream;
        while (st?.kind === "slice") st = st.stream;
        if (st?.kind !== "each") continue;
        const arr = this.field(s, st.array)?.field;
        const es = arr && elementStructOf(arr.type);
        if (es) this.streamPieces.add(`${es}.${st.field}`);
      }
    }
  }

  /**
   * A transform whose value type is the exact intermediate `bigint` gets a concrete integer type
   * from the range of its read expression (as the TS target does), so its JSON form is defined.
   */
  normalizeTransforms(rangeOf: (e: IrExpr, it: IrValueType) => Range | undefined): void {
    for (const s of this.program.structs) {
      this.walkTypes(s.members, t => {
        if (t.kind !== "transform" || t.valueType.kind !== "bigint") return;
        let range: Range | undefined;
        try {
          range = rangeOf(t.read, this.readValueType(t.inner));
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

  /** The type of `it` in a transform being normalized (anything but plain data is `bigint`). */
  private readValueType(t: IrType): IrValueType {
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
    const v =
      !s.base && !s.layers.some(l => l.kind === "via") && this.membersHavePlaceables(s.members);
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
  private membersStaticSize(ms: readonly IrMember[]): number | undefined {
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
  private layersStatic(inner: number, layers: readonly IrLayer[]): number | undefined {
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

/** Every member at any depth (block bodies, else branches, switch cases), in declaration order. */
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

/** The type under any layers. */
export function unlayer(t: IrType): IrType {
  while (t.kind === "layered") t = t.inner;
  return t;
}

/** The storage type under any layers and transforms. */
export function stripType(t: IrType): IrType {
  while (t.kind === "layered" || t.kind === "transform") t = t.inner;
  return t;
}

/** The element struct of an array type (under layers), if any. */
export function elementStructOf(t: IrType): string | undefined {
  const a = unlayer(t);
  if (a.kind !== "array") return undefined;
  const e = unlayer(a.element);
  return e.kind === "struct" ? e.struct : undefined;
}

export function primSize(p: string): number {
  return Number(p.slice(1)) / 8;
}

export function literalInt(e: IrExpr): number | undefined {
  if (e.kind === "literal" && e.value.kind === "int") {
    const n = Number(e.value.value);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  if (e.kind === "convert") return literalInt(e.operand);
  return undefined;
}

/** Calls `f` for every sub-expression (pre-order). */
export function walkExpr(e: IrExpr, f: (e: IrExpr) => void): void {
  f(e);
  switch (e.kind) {
    case "member":
      walkExpr(e.object, f);
      break;
    case "index":
      walkExpr(e.object, f);
      walkExpr(e.index, f);
      break;
    case "map":
      walkExpr(e.array, f);
      break;
    case "unary":
      walkExpr(e.operand, f);
      break;
    case "binary":
      walkExpr(e.left, f);
      walkExpr(e.right, f);
      break;
    case "cond":
      walkExpr(e.test, f);
      walkExpr(e.then, f);
      walkExpr(e.else, f);
      break;
    case "call":
      for (const a of e.args) walkExpr(a, f);
      break;
    case "in":
      walkExpr(e.value, f);
      for (const it of e.items) {
        if (it.kind === "value") walkExpr(it.value, f);
        else {
          walkExpr(it.low, f);
          walkExpr(it.high, f);
        }
      }
      break;
    case "regex":
      walkExpr(e.value, f);
      break;
    case "convert":
      walkExpr(e.operand, f);
      break;
    case "lambda":
      walkExpr(e.body, f);
      break;
  }
}

/** True if any sub-expression satisfies `pred`. */
export function someExpr(e: IrExpr, pred: (e: IrExpr) => boolean): boolean {
  let found = false;
  walkExpr(e, x => {
    if (!found && pred(x)) found = true;
  });
  return found;
}
