/** AST navigation for the language service: the chain of nodes enclosing a position. */
import type * as A from "../frontend/ast.ts";

export type Node = A.AnyNode | A.InItem | A.LayoutSegment;

export function children(n: Node): Node[] {
  switch (n.kind) {
    case "Module":
      return n.decls;
    case "ImportDecl":
      return [
        ...(n.names ?? []),
        ...(n.namespace ? [n.namespace] : []),
        ...(n.source ? [n.source] : [])
      ];
    case "ImportSpec":
      return [n.name, ...(n.alias ? [n.alias] : [])];
    case "StructDecl":
      return [n.name, ...n.typeParams, ...(n.params ?? []), ...n.attrs, ...n.members];
    case "EnumDecl":
      return [n.name, ...(n.storage ? [n.storage] : []), ...n.attrs, ...n.members];
    case "EnumMember":
      return [n.name, ...(n.value ? [n.value] : [])];
    case "UnionDecl":
      return [n.name, ...n.typeParams, ...(n.params ?? []), ...n.attrs, ...n.variants];
    case "TypeAliasDecl":
      return [n.name, ...n.typeParams, ...(n.params ?? []), ...(n.body ? [n.body] : [])];
    case "TypeSpec":
      return [n.type, ...n.arrays, ...clauseNodes(n.clauses), ...n.attrs];
    case "ExternFnDecl":
      return [n.name, ...n.params, ...(n.returns ? [n.returns] : []), ...n.returnArrays];
    case "ExternCodecDecl":
      return [n.name, ...n.params, ...n.attrs];
    case "ExternTypeDecl":
      return [n.name, ...n.params, ...(n.valueType ? [n.valueType] : []), ...n.attrs];
    case "ConstDecl":
      return [...(n.type ? [n.type] : []), n.name, ...n.arrays, ...(n.value ? [n.value] : [])];
    case "ParamDecl":
      return [...(n.type ? [n.type] : []), n.name, ...n.arrays, ...(n.default ? [n.default] : [])];
    case "FieldDecl":
      return [
        n.type,
        ...n.typeArrays,
        ...(n.name ? [n.name] : []),
        ...n.arrays,
        ...(n.storage ? [n.storage] : []),
        ...(n.bitWidth ? [n.bitWidth] : []),
        ...clauseNodes(n.clauses),
        ...n.attrs
      ];
    case "BlockMember":
      return [...n.attrs, ...n.members];
    case "IfMember":
      return [...n.attrs, ...(n.condition ? [n.condition] : []), ...n.then, ...(n.else ?? [])];
    case "SwitchMember":
      return [...n.attrs, ...(n.discriminant ? [n.discriminant] : []), ...n.cases];
    case "SwitchCase":
      return [...n.values, ...n.members];
    case "BitsMember":
      return [...n.attrs, ...(n.storage ? [n.storage] : []), ...n.fields];
    case "LayoutMember":
      return n.items;
    case "LayoutItem":
      return [...(n.path === "this" ? [] : n.path), ...n.attrs, ...(n.group?.items ?? [])];
    case "TypeRef":
      return [...n.name, ...(n.typeArgs ?? []), ...(n.args ?? [])];
    case "TypeArg":
      return [n.type, ...n.arrays];
    case "ArraySuffix":
      return n.expr ? [n.expr] : [];
    case "Arg":
      return [...(n.name ? [n.name] : []), n.value];
    case "Attribute":
      return [n.name, ...(n.args ?? [])];
    case "InValue":
      return [n.value];
    case "InRange":
      return [n.low, n.high];
    case "field":
      return [n.name];
    case "each":
      return [];
    case "Member":
      return [n.object, n.name];
    case "Index":
      return [n.object, n.index];
    case "Slice":
      return [n.object, ...(n.start ? [n.start] : []), ...(n.end ? [n.end] : [])];
    case "Each":
      return [n.object];
    case "Call":
      return [n.callee, ...n.args];
    case "Unary":
      return [n.operand];
    case "Binary":
      return [n.left, n.right];
    case "Cond":
      return [n.test, n.then, n.else];
    case "In":
      return [n.value, ...n.items];
    case "RegexMatch":
      return [n.value, n.regex];
    case "Lambda":
      return [n.param, n.body];
    case "Paren":
      return [n.expr];
    default:
      return [];
  }
}

function clauseNodes(c: A.FieldClauses): Node[] {
  const out: Node[] = [];
  if (c.at) out.push(c.at);
  if (c.from) out.push(c.from);
  if (c.asRead) out.push(c.asRead);
  if (c.asWrite) out.push(c.asWrite);
  if (c.formula) out.push(c.formula);
  if (c.defaultValue) out.push(c.defaultValue);
  if (c.inItems) out.push(...c.inItems);
  if (c.regex) out.push(c.regex);
  if (c.where) out.push(c.where);
  return out;
}

/** Nodes enclosing `offset`, outermost first. `inclusive` treats the end offset as inside. */
export function nodePath(root: A.Module, offset: number, inclusive = true): Node[] {
  const path: Node[] = [root];
  let cur: Node = root;
  for (;;) {
    let next: Node | undefined;
    for (const c of children(cur)) {
      const s = c.span;
      if (offset >= s.start && (inclusive ? offset <= s.end : offset < s.end)) {
        // prefer the last match (later siblings start where earlier ones end)
        if (!next || s.start >= next.span.start) next = c;
      }
    }
    if (!next) return path;
    path.push(next);
    cur = next;
  }
}

export function findLast<T>(arr: readonly T[], pred: (x: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) return arr[i];
  return undefined;
}

export function isExpr(n: Node): n is A.Expr {
  return [
    "Int",
    "Float",
    "String",
    "Bytes",
    "FourCC",
    "Bool",
    "Endian",
    "Name",
    "Dollar",
    "It",
    "Member",
    "Index",
    "Slice",
    "Each",
    "Call",
    "Unary",
    "Binary",
    "Cond",
    "In",
    "RegexMatch",
    "Lambda",
    "Paren",
    "Error"
  ].includes(n.kind);
}
