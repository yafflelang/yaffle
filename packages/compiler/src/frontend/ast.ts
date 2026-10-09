/**
 * The yaffle AST. Every node has a `span` (character offsets into its source file). The parser is
 * error tolerant: missing pieces are `undefined` (or an `Error` expression / empty identifier), so
 * a broken file still yields a tree the language service can work with.
 */
import type { Comment } from "./lexer.ts";
import type { SourceFile, Span } from "./source.ts";

export interface NodeBase {
  span: Span;
}

export interface Ident extends NodeBase {
  kind: "Ident";
  /** Empty when missing (error recovery). */
  name: string;
}

export interface Module extends NodeBase {
  kind: "Module";
  file: SourceFile;
  decls: Decl[];
  comments: Comment[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Declarations
// ─────────────────────────────────────────────────────────────────────────────

export type Decl =
  | ImportDecl
  | StructDecl
  | EnumDecl
  | UnionDecl
  | TypeAliasDecl
  | ExternFnDecl
  | ExternCodecDecl
  | ExternTypeDecl
  | ConstDecl;

export interface DeclBase extends NodeBase {
  exported: boolean;
  /** The `export` keyword. */
  exportSpan?: Span;
  /** Text of a preceding `/** … *\/` or `///` doc comment. */
  doc?: string;
  /** The declaration keyword (`struct`, `enum`, …). */
  keywordSpan: Span;
}

export interface ImportSpec extends NodeBase {
  kind: "ImportSpec";
  name: Ident;
  alias?: Ident;
}

export interface ImportDecl extends NodeBase {
  kind: "ImportDecl";
  exported: false;
  keywordSpan: Span;
  /** `import { a, b as c } from "…"` */
  names?: ImportSpec[];
  /** `import * as ns from "…"` */
  namespace?: Ident;
  source?: StringLit;
  doc?: string;
}

export interface StructDecl extends DeclBase {
  kind: "StructDecl";
  name: Ident;
  typeParams: Ident[];
  /** undefined: no parameter list. */
  params?: ParamDecl[];
  /** Attributes between the name and `{`. */
  attrs: Attribute[];
  members: Member[];
  /** From `{` to `}`. */
  bodySpan: Span;
}

export interface ParamDecl extends NodeBase {
  kind: "ParamDecl";
  type?: TypeRef;
  /** `u32 $version` */
  bound: boolean;
  name: Ident;
  arrays: ArraySuffix[];
  default?: Expr;
}

export interface EnumDecl extends DeclBase {
  kind: "EnumDecl";
  name: Ident;
  storage?: TypeRef;
  attrs: Attribute[];
  members: EnumMember[];
  bodySpan: Span;
}

export interface EnumMember extends NodeBase {
  kind: "EnumMember";
  name: Ident;
  value?: Expr;
  doc?: string;
}

export interface UnionDecl extends DeclBase {
  kind: "UnionDecl";
  name: Ident;
  typeParams: Ident[];
  params?: ParamDecl[];
  attrs: Attribute[];
  variants: TypeRef[];
  bodySpan: Span;
}

export interface TypeAliasDecl extends DeclBase {
  kind: "TypeAliasDecl";
  name: Ident;
  typeParams: Ident[];
  params?: ParamDecl[];
  body?: TypeSpec;
}

/** The right-hand side of a `type` alias: a field declaration without a name. */
export interface TypeSpec extends NodeBase {
  kind: "TypeSpec";
  type: TypeRef;
  arrays: ArraySuffix[];
  clauses: FieldClauses;
  attrs: Attribute[];
}

export interface ExternFnDecl extends DeclBase {
  kind: "ExternFnDecl";
  name: Ident;
  params: ParamDecl[];
  returns?: TypeRef;
  returnArrays: ArraySuffix[];
}

export interface ExternCodecDecl extends DeclBase {
  kind: "ExternCodecDecl";
  name: Ident;
  async: boolean;
  asyncSpan?: Span;
  params: ParamDecl[];
  attrs: Attribute[];
}

export interface ExternTypeDecl extends DeclBase {
  kind: "ExternTypeDecl";
  name: Ident;
  params: ParamDecl[];
  valueType?: TypeRef;
  attrs: Attribute[];
}

export interface ConstDecl extends DeclBase {
  kind: "ConstDecl";
  type?: TypeRef;
  name: Ident;
  arrays: ArraySuffix[];
  value?: Expr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Struct members
// ─────────────────────────────────────────────────────────────────────────────

export type Member =
  | FieldDecl
  | BlockMember
  | IfMember
  | SwitchMember
  | BitsMember
  | LayoutMember
  | StructDecl
  | EnumDecl
  | UnionDecl;

export interface FieldClauses {
  /** `at expr` */
  at?: Expr;
  /** `from stream` */
  from?: Expr;
  /** `?= expr`: optional input with a default. */
  defaultValue?: Expr;
  /** `= expr` (not after `as`) */
  formula?: Expr;
  /** `as expr` */
  asRead?: Expr;
  /** `as expr = expr`: the write side. */
  asWrite?: Expr;
  /** `in (…)` */
  inItems?: InItem[];
  /** Span of the `in (…)` list including parentheses. */
  inSpan?: Span;
  /** `in /re/` */
  regex?: RegexLit;
  /** `where expr` */
  where?: Expr;
  /** Spans of each clause from its keyword to its end, for quick fixes. */
  spans: Partial<Record<"at" | "from" | "formula" | "default" | "as" | "in" | "where", Span>>;
}

export interface FieldDecl extends NodeBase {
  kind: "FieldDecl";
  type: TypeRef;
  /** `T[n] *name`: array suffixes written right after the type (the pointer target for pointers). */
  typeArrays: ArraySuffix[];
  /** `T *name : storage` */
  pointer: boolean;
  starSpan?: Span;
  /** `T $name` */
  bound: boolean;
  /** `virtual T name = expr`: no bytes; the value is read from the formula. */
  virtual?: Span;
  /** undefined: unnamed (reserved bitfield `u8 : 3`, or missing). */
  name?: Ident;
  arrays: ArraySuffix[];
  /** Pointer storage type after `:`. */
  storage?: TypeRef;
  /** Bitfield width after `:`. */
  bitWidth?: Expr;
  clauses: FieldClauses;
  /** Postfix attributes (including `@` continuation lines). */
  attrs: Attribute[];
  doc?: string;
}

export interface BlockMember extends NodeBase {
  kind: "BlockMember";
  attrs: Attribute[];
  members: Member[];
  bodySpan: Span;
}

export interface IfMember extends NodeBase {
  kind: "IfMember";
  attrs: Attribute[];
  condition?: Expr;
  then: Member[];
  thenSpan: Span;
  /** `else { … }` members; an `else if` is a single IfMember here with `elseIf` set. */
  else?: Member[];
  elseIf: boolean;
  elseSpan?: Span;
}

export interface SwitchMember extends NodeBase {
  kind: "SwitchMember";
  attrs: Attribute[];
  discriminant?: Expr;
  cases: SwitchCase[];
  bodySpan: Span;
}

export interface SwitchCase extends NodeBase {
  kind: "SwitchCase";
  /** Empty for `default`. */
  values: Expr[];
  isDefault: boolean;
  members: Member[];
}

export interface BitsMember extends NodeBase {
  kind: "BitsMember";
  /** Prefix attributes and attributes between the storage type and `{`. */
  attrs: Attribute[];
  storage?: TypeRef;
  fields: FieldDecl[];
  bodySpan: Span;
}

export interface LayoutMember extends NodeBase {
  kind: "LayoutMember";
  items: LayoutItem[];
  bodySpan: Span;
}

export type LayoutSegment =
  { kind: "field"; name: Ident; span: Span } | { kind: "each"; span: Span };

export interface LayoutItem extends NodeBase {
  kind: "LayoutItem";
  /** "this", or a path. */
  path: LayoutSegment[] | "this";
  attrs: Attribute[];
  /**
   * `volumes[*] { pieces[*]  portals[*].points }`: for each element of the array
   * the path names, place the nested items (paths relative to the element) in order.
   */
  group?: { items: LayoutItem[]; span: Span };
}

// ─────────────────────────────────────────────────────────────────────────────
// Types, arrays, attributes
// ─────────────────────────────────────────────────────────────────────────────

export interface TypeRef extends NodeBase {
  kind: "TypeRef";
  /** Qualified name parts: `lib.Record` → [lib, Record]. */
  name: Ident[];
  typeArgs?: TypeArg[];
  args?: Arg[];
  argsSpan?: Span;
}

export interface TypeArg extends NodeBase {
  kind: "TypeArg";
  type: TypeRef;
  arrays: ArraySuffix[];
}

export interface ArraySuffix extends NodeBase {
  kind: "ArraySuffix";
  mode: "count" | "until" | "before" | "rest";
  expr?: Expr;
}

export interface Arg extends NodeBase {
  kind: "Arg";
  name?: Ident;
  value: Expr;
}

export interface Attribute extends NodeBase {
  kind: "Attribute";
  /** Name without `@`; its span covers `@name`. */
  name: Ident;
  args?: Arg[];
  argsSpan?: Span;
}

// ─────────────────────────────────────────────────────────────────────────────
// Expressions
// ─────────────────────────────────────────────────────────────────────────────

export type Expr =
  | IntLit
  | FloatLit
  | StringLit
  | BytesLit
  | FourCCLit
  | BoolLit
  | EndianLit
  | NameExpr
  | DollarExpr
  | ItExpr
  | MemberExpr
  | IndexExpr
  | SliceExpr
  | EachExpr
  | CallExpr
  | UnaryExpr
  | BinaryExpr
  | CondExpr
  | InExpr
  | RegexMatchExpr
  | LambdaExpr
  | ParenExpr
  | ErrorExpr;

export interface IntLit extends NodeBase {
  kind: "Int";
  value: bigint;
  raw: string;
}
export interface FloatLit extends NodeBase {
  kind: "Float";
  value: number;
  raw: string;
}
export interface StringLit extends NodeBase {
  kind: "String";
  value: string;
}
export interface BytesLit extends NodeBase {
  kind: "Bytes";
  hex: string;
  raw: string;
}
export interface FourCCLit extends NodeBase {
  kind: "FourCC";
  value: string;
}
export interface BoolLit extends NodeBase {
  kind: "Bool";
  value: boolean;
}
export interface EndianLit extends NodeBase {
  kind: "Endian";
  value: "le" | "be";
}
export interface NameExpr extends NodeBase {
  kind: "Name";
  name: string;
}
export interface DollarExpr extends NodeBase {
  kind: "Dollar";
  /** Without `$`. */
  name: string;
}
export interface ItExpr extends NodeBase {
  kind: "It";
}
export interface MemberExpr extends NodeBase {
  kind: "Member";
  object: Expr;
  name: Ident;
}
export interface IndexExpr extends NodeBase {
  kind: "Index";
  object: Expr;
  index: Expr;
}
export interface SliceExpr extends NodeBase {
  kind: "Slice";
  object: Expr;
  start?: Expr;
  end?: Expr;
}
/** `arr[*]` */
export interface EachExpr extends NodeBase {
  kind: "Each";
  object: Expr;
}
export interface CallExpr extends NodeBase {
  kind: "Call";
  callee: Expr;
  args: Arg[];
  argsSpan: Span;
}
export interface UnaryExpr extends NodeBase {
  kind: "Unary";
  op: "-" | "!" | "~" | "+";
  operand: Expr;
}
export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "<<"
  | ">>"
  | "&"
  | "|"
  | "^"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "&&"
  | "||";
export interface BinaryExpr extends NodeBase {
  kind: "Binary";
  op: BinaryOp;
  left: Expr;
  right: Expr;
  opSpan: Span;
}
export interface CondExpr extends NodeBase {
  kind: "Cond";
  test: Expr;
  then: Expr;
  else: Expr;
}
export type InItem =
  | { kind: "InValue"; value: Expr; span: Span }
  | { kind: "InRange"; low: Expr; high: Expr; span: Span };
export interface InExpr extends NodeBase {
  kind: "In";
  value: Expr;
  items: InItem[];
}
export interface RegexLit extends NodeBase {
  kind: "Regex";
  pattern: string;
}
export interface RegexMatchExpr extends NodeBase {
  kind: "RegexMatch";
  value: Expr;
  regex: RegexLit;
}
export interface LambdaExpr extends NodeBase {
  kind: "Lambda";
  param: Ident;
  body: Expr;
}
export interface ParenExpr extends NodeBase {
  kind: "Paren";
  expr: Expr;
}
export interface ErrorExpr extends NodeBase {
  kind: "Error";
}

export type AnyNode =
  | Module
  | Decl
  | Member
  | ParamDecl
  | EnumMember
  | ImportSpec
  | TypeSpec
  | TypeRef
  | TypeArg
  | ArraySuffix
  | Arg
  | Attribute
  | SwitchCase
  | LayoutItem
  | Expr
  | Ident
  | RegexLit;

/** Calls `fn` on every direct child expression of `e`. */
export function forEachChildExpr(e: Expr, fn: (child: Expr) => void): void {
  switch (e.kind) {
    case "Member":
      fn(e.object);
      break;
    case "Index":
      fn(e.object);
      fn(e.index);
      break;
    case "Slice":
      fn(e.object);
      if (e.start) fn(e.start);
      if (e.end) fn(e.end);
      break;
    case "Each":
      fn(e.object);
      break;
    case "Call":
      fn(e.callee);
      for (const a of e.args) fn(a.value);
      break;
    case "Unary":
      fn(e.operand);
      break;
    case "Binary":
      fn(e.left);
      fn(e.right);
      break;
    case "Cond":
      fn(e.test);
      fn(e.then);
      fn(e.else);
      break;
    case "In":
      fn(e.value);
      for (const it of e.items) {
        if (it.kind === "InValue") fn(it.value);
        else {
          fn(it.low);
          fn(it.high);
        }
      }
      break;
    case "RegexMatch":
      fn(e.value);
      break;
    case "Lambda":
      fn(e.body);
      break;
    case "Paren":
      fn(e.expr);
      break;
    default:
      break;
  }
}

/** Walks an expression tree depth-first (pre-order). Return false from `fn` to skip children. */
export function walkExpr(e: Expr, fn: (e: Expr) => boolean | void): void {
  if (fn(e) === false) return;
  forEachChildExpr(e, c => walkExpr(c, fn));
}

/** Does `e` or any of its sub-expressions satisfy `pred`? */
export function someExpr(e: Expr, pred: (x: Expr) => boolean): boolean {
  let found = false;
  walkExpr(e, x => {
    if (!found && pred(x)) found = true;
    return !found;
  });
  return found;
}

/** Strips parentheses. */
export function unparen(e: Expr): Expr {
  while (e.kind === "Paren") e = e.expr;
  return e;
}

/** The dotted name of a type reference (`ns.Type`). */
export function typeRefName(t: TypeRef): string {
  return t.name.map(n => n.name).join(".");
}
