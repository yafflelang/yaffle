/**
 * Elaboration contexts. The same code checks declarations (reporting diagnostics, generic type
 * parameters opaque) and lowers struct instances to IR (type parameters substituted).
 */
import type * as A from "./ast.ts";
import type { IrExpr, IrStructType, IrType, IrValueType } from "../ir/index.ts";
import type { SourceFile, Span } from "./source.ts";
import type {
  CondFrame,
  FieldSym,
  ModuleInfo,
  ParamSym,
  StructSym,
  TypeParamSym,
  UnionSym,
  AliasSym,
  LambdaParamSym
} from "./symbols.ts";

/** A generic type argument: its syntax plus the context it was written in. */
export interface TypeArgBinding {
  ast: A.TypeArg;
  /** Context for resolving names inside the argument. */
  scope: Ctx;
  /** Canonical key (JSON of the lowered type). */
  key: string;
  /** Display string, e.g. "Point", "char[4]". */
  display: string;
}

export interface Guard {
  expr: A.Expr;
  positive: boolean;
}

/** A use of a struct type (patched with implicit arguments after the requirements analysis). */
export interface UseSite {
  type: IrStructType;
  target: StructSym;
  typeArgs: TypeArgBinding[];
  /** Field order at the use (outer fields with order < position are available). */
  position: number;
  /** $names bound locally at this point, and the expression that passes each. */
  localBound: Map<string, IrExpr>;
  /** Inside an array element (so $index is available). */
  insideArray: boolean;
  file: SourceFile;
  span: Span;
  /** The field this use belongs to, for error paths. */
  fieldName: string;
  /** 1-based argument positions of declared `$` parameters the use omits (filled from bindings). */
  explicitHoles: number[];
}

interface BoundRead {
  name: string;
  file: SourceFile;
  span: Span;
  /** The implicit `param` expression to rename/type after analysis. */
  expr: IrExpr & { kind: "param" };
}

interface OuterRead {
  owner: StructSym;
  member: string;
  memberKind: "field" | "param";
  sym: FieldSym | ParamSym;
  file: SourceFile;
  span: Span;
  expr: IrExpr & { kind: "param" };
}

interface IndexRead {
  file: SourceFile;
  span: Span;
}

export interface LowerOutputs {
  boundReads: BoundRead[];
  outerReads: OuterRead[];
  indexReads: IndexRead[];
  uses: UseSite[];
  /** Codecs referenced (for async). */
  codecs: Set<string>;
}

/** Provisional names of implicit parameters before the requirements analysis assigns final ones. */
export const BOUND_PREFIX = "\u0000b:";
export const OUTER_PREFIX = "\u0000o:";

export function newOutputs(): LowerOutputs {
  return { boundReads: [], outerReads: [], indexReads: [], uses: [], codecs: new Set() };
}

export interface Ctx {
  module: ModuleInfo;
  /** The struct whose fields are in scope (undefined at module level: consts, aliases). */
  struct?: StructSym | undefined;
  /** Lexical owner for type lookup when there is no struct (unions, aliases). */
  owner?: StructSym | UnionSym | AliasSym;
  /** Emit diagnostics. */
  report: boolean;
  /** Record language-service information (references, expression types). */
  record: boolean;
  /** Generic substitution. Missing entries mean "opaque" (checking a generic declaration). */
  typeArgs: Map<TypeParamSym, TypeArgBinding>;
  /** Alias / union parameters being inlined. */
  paramArgs?: Map<ParamSym, IrExpr>;
  lambdas: Map<string, IrValueType>;
  /** Declarations of lambda parameters in scope (for references and hovers). */
  lambdaSyms?: Map<string, LambdaParamSym>;
  /** "read": earlier fields only. "write": every field. "const": no fields at all. */
  side: "read" | "write" | "const";
  /** Read side: fields with order < position are visible. */
  position: number;
  frames: CondFrame[];
  guards: Guard[];
  /** Type of `it`, if `it` is available. */
  it?: IrValueType;
  /** The field being declared (self-references become `it` in checks, errors elsewhere). */
  self?: FieldSym;
  /** In a check of `self`: references to self mean `it`. */
  selfIsIt?: boolean;
  /** Inside an array element type (for $index). */
  insideArray: boolean;
  out: LowerOutputs;
  /** Field IR types computed so far in the current struct. */
  fieldTypes: Map<FieldSym, { ir: IrType; value: IrValueType }>;
  /**
   * The struct position where struct-type uses are recorded. Differs from `struct`/`position`
   * while lowering inside an alias, union or generic argument (their names resolve elsewhere,
   * but the use belongs to the struct being lowered).
   */
  site?: UseSiteScope | undefined;
  /** Field name for use-site paths. */
  fieldName?: string;
}

export interface UseSiteScope {
  struct: StructSym;
  position: number;
  frames: CondFrame[];
  fieldName: string;
}

/** Where struct uses in `ctx` are recorded: `ctx.site`, or the current position in its struct. */
export function useSiteScope(ctx: Ctx): UseSiteScope | undefined {
  if (ctx.site) return ctx.site;
  if (!ctx.struct) return undefined;
  return {
    struct: ctx.struct,
    position: ctx.position,
    frames: ctx.frames,
    fieldName: ctx.fieldName ?? ""
  };
}
