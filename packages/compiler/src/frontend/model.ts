/**
 * The semantic model: what the checker learned about the source, kept for the language service
 * (references, expression types, per-field and per-struct results).
 */
import type * as A from "./ast.ts";
import type { IrBitField, IrExpr, IrField, IrStruct, IrType, IrValueType } from "../ir/index.ts";
import type { LowerOutputs, TypeArgBinding } from "./ctx.ts";
import type { Span } from "./source.ts";
import type { FieldSym, ModuleInfo, ParamSym, StructSym, Sym } from "./symbols.ts";

export interface SymRef {
  span: Span;
  sym: Sym;
  /** This occurrence is the declaration itself. */
  decl: boolean;
}

export interface FieldResult {
  sym: FieldSym;
  ir: IrField | IrBitField;
  /** Type of the field as lowered (IrBitField has no IrType: this is its declared type). */
  type: IrType;
  value: IrValueType;
  /** For bitfields: storage, shift, width. */
  bits?: {
    storage: string;
    shift: number;
    width: number;
    storageBits: number;
    /** The storage unit (bits member) this field belongs to. */
    unit: object;
    order: "lsb" | "msb";
  };
  /** Human-readable derivation, e.g. "entries.length". */
  deriveDisplay?: string;
  /** Where the auto derivation comes from ("array length of entries"). */
  deriveSource?: string;
  /** Inferred inverse of an `as` transform, for hovers. */
  inferredWrite?: string;
}

export interface StructResult {
  sym: StructSym;
  typeArgs: TypeArgBinding[];
  key: string;
  id: string;
  name: string;
  ir: IrStruct;
  out: LowerOutputs;
  fields: Map<FieldSym, FieldResult>;
  /** Param name → derivation of an explicit parameter from this struct's own fields (for callers). */
  paramDerivations: Map<string, IrExpr>;
  /** Fields consumed by a `from` stream of this struct (derived by the writer). */
  streamFields: Set<string>;
  /** `@hidden` fields without a derive, reported once all structs are checked. */
  hiddenCandidates: FieldResult[];
  /** True while being lowered (recursion guard). */
  done: boolean;
}

export class SemanticModel {
  readonly refs = new Map<string, SymRef[]>();
  readonly exprTypes = new Map<A.Expr, IrValueType>();
  /** Check-mode results per struct declaration. */
  readonly structs = new Map<StructSym, StructResult>();
  /** Every place binding each `$name`. */
  readonly bindingSites = new Map<string, (FieldSym | ParamSym)[]>();
  /** For each struct: the bound values it needs from callers (after the requirements analysis). */
  readonly needs = new Map<StructSym, { name: string; type: IrValueType; via: string }[]>();
  /** For `$name` reads: which binding sites can provide the value (by struct). */
  readonly boundSources = new Map<
    StructSym,
    Map<string, { site: FieldSym | ParamSym; path: string }[]>
  >();

  addRef(module: ModuleInfo, span: Span, sym: Sym, decl = false): void {
    let list = this.refs.get(module.path);
    if (!list) this.refs.set(module.path, (list = []));
    if (list.some(r => r.span.start === span.start && r.span.end === span.end && r.sym === sym))
      return;
    list.push({ span, sym, decl });
  }

  refsIn(path: string): SymRef[] {
    return this.refs.get(path) ?? [];
  }
}
