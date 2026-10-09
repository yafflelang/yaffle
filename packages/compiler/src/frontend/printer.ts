/**
 * Printers: AST expressions and types back to canonical yaffle source (formatter, messages,
 * quick fixes), and IR expressions to a readable yaffle-like form (hovers, inlay hints).
 */
import type * as A from "./ast.ts";
import { binaryPrecedence } from "./parser.ts";
import type { IrExpr, IrLiteral } from "../ir/index.ts";
import { hexIfLarge, literalToString } from "./types.ts";

export interface PrintOptions {
  /** Replace `it` with this name. */
  itName?: string;
}

const UNARY_PREC = 10;
const POSTFIX_PREC = 11;

function exprPrec(e: A.Expr): number {
  switch (e.kind) {
    case "Cond":
    case "Lambda":
      return 0;
    case "Binary":
      return binaryPrecedence(e.op);
    case "In":
    case "RegexMatch":
      return 3;
    case "Unary":
      return UNARY_PREC;
    default:
      return POSTFIX_PREC;
  }
}

export function printExpr(e: A.Expr, opts: PrintOptions = {}): string {
  const p = (x: A.Expr, minPrec: number): string => {
    const s = printExpr(x, opts);
    return exprPrec(x) < minPrec ? `(${s})` : s;
  };
  switch (e.kind) {
    case "Int":
      return e.raw;
    case "Float":
      return e.raw;
    case "String":
      return quoteString(e.value);
    case "Bytes":
      return e.raw;
    case "FourCC":
      return `'${e.value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    case "Bool":
      return String(e.value);
    case "Endian":
      return e.value;
    case "Name":
      return e.name;
    case "Dollar":
      return `$${e.name}`;
    case "It":
      return opts.itName ?? "it";
    case "Member":
      return `${p(e.object, POSTFIX_PREC)}.${e.name.name}`;
    case "Index":
      return `${p(e.object, POSTFIX_PREC)}[${printExpr(e.index, opts)}]`;
    case "Slice":
      return `${p(e.object, POSTFIX_PREC)}[${e.start ? printExpr(e.start, opts) : ""}..${e.end ? printExpr(e.end, opts) : ""}]`;
    case "Each":
      return `${p(e.object, POSTFIX_PREC)}[*]`;
    case "Call":
      return `${p(e.callee, POSTFIX_PREC)}(${e.args.map(a => printArg(a, opts)).join(", ")})`;
    case "Unary":
      return `${e.op}${p(e.operand, UNARY_PREC)}`;
    case "Binary": {
      const prec = binaryPrecedence(e.op);
      return `${p(e.left, prec)} ${e.op} ${p(e.right, prec + 1)}`;
    }
    case "Cond":
      return `${p(e.test, 1)} ? ${printExpr(e.then, opts)} : ${printExpr(e.else, opts)}`;
    case "In":
      return `${p(e.value, 4)} in ${printInItems(e.items, opts)}`;
    case "RegexMatch":
      return `${p(e.value, 4)} in /${e.regex.pattern}/`;
    case "Lambda":
      return `${e.param.name} => ${printExpr(e.body, opts)}`;
    case "Paren":
      return `(${printExpr(e.expr, opts)})`;
    case "Error":
      return "?";
  }
}

function printArg(a: A.Arg, opts: PrintOptions = {}): string {
  return a.name ? `${a.name.name}: ${printExpr(a.value, opts)}` : printExpr(a.value, opts);
}

export function printInItems(items: A.InItem[], opts: PrintOptions = {}): string {
  return `(${items
    .map(it =>
      it.kind === "InValue"
        ? printExpr(it.value, opts)
        : `${printExpr(it.low, opts)}..${printExpr(it.high, opts)}`
    )
    .join(", ")})`;
}

function quoteString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c === 0) out += "\\0";
    else if (c < 0x20 || c === 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + '"';
}

export function printTypeRef(t: A.TypeRef): string {
  let s = t.name.map(n => n.name).join(".");
  if (t.typeArgs) s += `<${t.typeArgs.map(printTypeArg).join(", ")}>`;
  if (t.args) s += `(${t.args.map(a => printArg(a)).join(", ")})`;
  return s;
}

function printTypeArg(t: A.TypeArg): string {
  return printTypeRef(t.type) + t.arrays.map(printArraySuffix).join("");
}

export function printArraySuffix(a: A.ArraySuffix): string {
  if (a.mode === "rest") return "[]";
  if (a.mode === "until" || a.mode === "before")
    return `[${a.mode} ${a.expr ? printExpr(a.expr) : ""}]`;
  return `[${a.expr ? printExpr(a.expr) : ""}]`;
}

export function printAttribute(a: A.Attribute): string {
  return a.args ? `@${a.name.name}(${a.args.map(x => printArg(x)).join(", ")})` : `@${a.name.name}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// IR expressions → yaffle-like display
// ─────────────────────────────────────────────────────────────────────────────

function isNullCall(e: IrExpr): boolean {
  return e.kind === "call" && e.callee.kind === "builtin" && e.callee.name === "isNull";
}

function irPrec(e: IrExpr): number {
  // printed as `x == null` / `x != null`
  if (isNullCall(e) || (e.kind === "unary" && e.op === "!" && isNullCall(e.operand))) return 3;
  switch (e.kind) {
    case "lambda":
      return 0;
    case "cond":
      return 0;
    case "binary":
      return binaryPrecedence(e.op);
    case "in":
    case "regex":
      return 3;
    case "unary":
      return UNARY_PREC;
    case "convert":
      return irPrec(e.operand);
    default:
      return POSTFIX_PREC;
  }
}

export interface IrPrintOptions {
  itName?: string;
  /** Names for implicit params, e.g. bound params print as `$version`. */
  paramName?: (name: string) => string;
}

export function printIrExpr(e: IrExpr, opts: IrPrintOptions = {}): string {
  const p = (x: IrExpr, minPrec: number): string => {
    const s = printIrExpr(x, opts);
    return irPrec(x) < minPrec ? `(${s})` : s;
  };
  switch (e.kind) {
    case "literal":
      return printIrLiteral(e.value);
    case "field":
      return e.name;
    case "param":
      if (opts.paramName) return opts.paramName(e.name);
      if (e.name === "endian") return "$endian";
      if (e.name.startsWith("\u0000b:")) return "$" + e.name.slice(3);
      if (e.name.startsWith("\u0000o:")) return e.name.slice(e.name.lastIndexOf(".") + 1);
      return e.name;
    case "it":
      return opts.itName ?? "it";
    case "lambdaParam":
      return e.name;
    case "builtinValue":
      return `$${e.name}`;
    case "member":
      return `${p(e.object, POSTFIX_PREC)}.${e.name}`;
    case "index":
      return `${p(e.object, POSTFIX_PREC)}[${printIrExpr(e.index, opts)}]`;
    case "map":
      return `${p(e.array, POSTFIX_PREC)}[*].${e.field}`;
    case "unary":
      // `!isNull(x)` is `x != null`
      if (
        e.op === "!" &&
        e.operand.kind === "call" &&
        e.operand.callee.kind === "builtin" &&
        e.operand.callee.name === "isNull" &&
        e.operand.args.length === 1
      )
        return `${p(e.operand.args[0]!, 4)} != null`;
      return `${e.op}${p(e.operand, UNARY_PREC)}`;
    case "binary": {
      // `encodedLength(s, u, enc) / u` is the length in code units: `s.length`
      if (
        e.op === "/" &&
        e.left.kind === "call" &&
        e.left.callee.kind === "builtin" &&
        e.left.callee.name === "encodedLength" &&
        e.right.kind === "literal" &&
        e.left.args[1]?.kind === "literal" &&
        JSON.stringify(e.right.value) === JSON.stringify(e.left.args[1].value)
      ) {
        return printIrExpr(e.left, opts);
      }
      const prec = binaryPrecedence(e.op);
      return `${p(e.left, prec)} ${e.op} ${p(e.right, prec + 1)}`;
    }
    case "cond":
      return `${p(e.test, 1)} ? ${printIrExpr(e.then, opts)} : ${printIrExpr(e.else, opts)}`;
    case "call": {
      if (e.callee.kind === "builtin") {
        const n = e.callee.name;
        if (n === "len" && e.args.length === 1) return `${p(e.args[0]!, POSTFIX_PREC)}.length`;
        if (n === "encodedLength" && e.args.length >= 1)
          return `${p(e.args[0]!, POSTFIX_PREC)}.length`;
        if (n === "isNull" && e.args.length === 1) return `${p(e.args[0]!, 4)} == null`;
        return `${n}(${e.args.map(a => printIrExpr(a, opts)).join(", ")})`;
      }
      return `${e.callee.extern}(${e.args.map(a => printIrExpr(a, opts)).join(", ")})`;
    }
    case "in":
      return `${p(e.value, 4)} in (${e.items
        .map(it =>
          it.kind === "value"
            ? printIrExpr(it.value, opts)
            : `${printIrExpr(it.low, opts)}..${printIrExpr(it.high, opts)}`
        )
        .join(", ")})`;
    case "regex":
      return `${p(e.value, 4)} in /${e.pattern}/`;
    case "convert":
      return printIrExpr(e.operand, opts);
    case "this":
      return "this";
    case "lambda":
      return `${e.param} => ${printIrExpr(e.body, opts)}`;
  }
}

function printIrLiteral(l: IrLiteral): string {
  if (l.kind === "enum") {
    const short = l.enum.split(".").pop() ?? l.enum;
    return `${short}.${l.member}`;
  }
  if (l.kind === "int") return hexIfLarge(BigInt(l.value));
  return literalToString(l);
}
