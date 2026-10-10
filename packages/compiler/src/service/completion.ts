/**
 * Scope-aware completion and signature help. The context comes from the AST (enclosing struct
 * and member) refined by lexing the text before the cursor (unclosed brackets, clause keywords),
 * which keeps working on half-typed code.
 */
import type * as A from "../frontend/ast.ts";
import { ATTRIBUTES, attributeSignature, type AttrTarget } from "../frontend/attributes.ts";
import { BUILTIN_FUNCTIONS, LAMBDA_BUILTINS } from "../frontend/expr.ts";
import { lex, type Token } from "../frontend/lexer.ts";
import { SourceFile } from "../frontend/source.ts";
import type { DeclSym, FieldSym, ModuleInfo, StructSym } from "../frontend/symbols.ts";
import { BUILTIN_TYPE_NAMES, displayValueType } from "../frontend/types.ts";
import type { IrValueType } from "../ir/index.ts";
import type { CompletionItem, CompletionKind, Position, SignatureHelp } from "./api.ts";
import type { Analysis } from "./analysis.ts";
import { builtinTypeDoc, paramDeclText, signatureOf } from "./describe.ts";
import { findLast, nodePath, type Node } from "./locate.ts";

const MEMBER_KEYWORDS = ["if", "switch", "bits", "layout", "struct", "enum", "union", "virtual"];
const TOP_KEYWORDS = ["struct", "enum", "union", "type", "extern", "const", "import", "export"];

interface Ctx {
  an: Analysis;
  mod: ModuleInfo;
  text: string;
  offset: number;
  path: Node[];
  struct?: StructSym;
  field?: FieldSym;
}

export function getCompletions(an: Analysis, path: string, pos: Position): CompletionItem[] {
  const mod = an.module(path);
  if (!mod) return [];
  const file = mod.file;
  const text = file.text;
  const offset = file.offsetAt(pos);
  if (inCommentOrString(mod, offset)) return [];
  const wordMatch = /[A-Za-z_][A-Za-z0-9_]*$/.exec(text.slice(0, offset));
  const word = wordMatch ? wordMatch[0] : "";
  const wordStart = offset - word.length;
  const prevChar = text[wordStart - 1] ?? "";
  const nodes = nodePath(mod.ast, Math.max(0, wordStart), true);
  const structDecl = findLast(
    nodes,
    n => n.kind === "StructDecl" && offset > n.bodySpan.start && offset <= n.bodySpan.end
  ) as A.StructDecl | undefined;
  const struct = structDecl ? an.structByDecl.get(structDecl) : undefined;
  const fieldDecl = findLast(nodes, n => n.kind === "FieldDecl") as A.FieldDecl | undefined;
  const ctx: Ctx = { an, mod, text, offset: wordStart, path: nodes };
  if (struct) ctx.struct = struct;
  let fsym = fieldDecl ? an.fieldByDecl.get(fieldDecl) : undefined;
  if (!fsym && struct && structDecl) {
    // the cursor may be past the field's span (`u32 n = |`): the field starting this member
    const ms = memberStartOffset(text, wordStart, structDecl.bodySpan.start + 1);
    const first = text.slice(ms).search(/\S/);
    const at = first < 0 ? ms : ms + first;
    fsym = struct.fields.find(f => f.decl.span.start === at);
  }
  if (fsym) ctx.field = fsym;

  if (prevChar === "@") return attributeItems(attrTarget(ctx, structDecl, fieldDecl, wordStart));
  if (prevChar === "$") return boundItems(an, struct);
  if (prevChar === ".") return memberItems(ctx, wordStart - 1);

  const imp = findLast(nodes, n => n.kind === "ImportDecl") as A.ImportDecl | undefined;
  if (imp) return importItems(an, mod, imp, wordStart);

  const layout = findLast(nodes, n => n.kind === "LayoutMember") as A.LayoutMember | undefined;
  if (layout && struct && offset > layout.bodySpan.start) {
    const scope = layoutScope(an, struct, nodes, offset) ?? struct;
    return [
      ...scope.fields.filter(f => f.name).map(f => item(f.name, "field", fieldDetail(an, f))),
      item(
        "this",
        "keyword",
        scope === struct ? "the struct's own inline bytes" : "the element's own inline bytes"
      )
    ];
  }

  if (!structDecl) return topLevelItems(ctx, offset, wordStart);
  return structBodyItems(ctx, structDecl, struct, wordStart);
}

/** At the top level, or inside a declaration other than a struct. */
function topLevelItems(ctx: Ctx, offset: number, wordStart: number): CompletionItem[] {
  const { an, mod, text } = ctx;
  const decl = findLast(
    ctx.path,
    n =>
      n.kind === "EnumDecl" ||
      n.kind === "UnionDecl" ||
      n.kind === "TypeAliasDecl" ||
      n.kind === "ConstDecl" ||
      n.kind === "ExternFnDecl" ||
      n.kind === "ExternCodecDecl" ||
      n.kind === "ExternTypeDecl"
  );
  if (decl && decl.kind !== "EnumDecl" && !atLineStart(text, wordStart)) {
    const lc = lineContext(text, wordStart, decl.span.start);
    return lc.kind === "expr" ? valueItems(ctx, "const", 0, false) : typeItems(an, mod, undefined);
  }
  if (decl && decl.kind === "EnumDecl" && offset > decl.bodySpan.start) return [];
  return [...TOP_KEYWORDS.map(k => item(k, "keyword")), ...topSnippets()];
}

/** Inside a struct body: decided by the member's text from its start up to the cursor. */
function structBodyItems(
  ctx: Ctx,
  structDecl: A.StructDecl,
  struct: StructSym | undefined,
  wordStart: number
): CompletionItem[] {
  const { an, mod, text } = ctx;
  const memberStart = memberStartOffset(text, wordStart, structDecl.bodySpan.start + 1);
  const lc = lineContext(text, wordStart, memberStart);
  switch (lc.kind) {
    case "member":
      return [
        ...typeItems(an, mod, struct),
        ...MEMBER_KEYWORDS.map(k => item(k, "keyword")),
        ...memberSnippets()
      ];
    case "type":
      return typeItems(an, mod, struct);
    case "name":
      return [];
    case "storage":
      return typeItems(an, mod, struct).filter(
        i => i.kind === "primitive" && /^[ui]\d+(le|be)?$/.test(i.label)
      );
    case "clause":
      return ["at", "from", "as", "in", "where"].map(k => item(k, "keyword", clauseDoc(k)));
    case "attrArg":
      return attrArgItems(ctx, lc.attr!, lc.argIndex ?? 0, lc.named);
    case "caseValue": {
      const sw = findLast(ctx.path, n => n.kind === "SwitchMember") as A.SwitchMember | undefined;
      const disc = sw?.discriminant ? an.el.model.exprTypes.get(sw.discriminant) : undefined;
      const e = disc?.kind === "enum" ? an.el.enumsById.get(disc.enum) : undefined;
      if (e)
        return e.members.map(m =>
          item(m.name, "enumMember", `${e.name}.${m.name} = ${m.value ?? "?"}`)
        );
      return valueItems(ctx, "read", positionAt(ctx, struct), false);
    }
    case "expr": {
      const values = valueItems(ctx, lc.write ? "write" : "read", positionAt(ctx, struct), !!lc.it);
      // right after `[` of an array declarator: the length keywords
      const before = text.slice(memberStart, wordStart);
      if (/\[\s*$/.test(before) && !/[=]/.test(before)) {
        return [
          item("until", "keyword", "until value (consumed) or until <condition on it> (inclusive)"),
          item(
            "before",
            "keyword",
            "before value: stop before an element equal to it (not consumed)"
          ),
          ...values
        ];
      }
      return values;
    }
  }
}

/** The element struct of the innermost layout group around `offset`. */
function layoutScope(
  an: Analysis,
  struct: StructSym,
  nodes: Node[],
  offset: number
): StructSym | undefined {
  let scope: StructSym | undefined = struct;
  let found = false;
  for (const n of nodes) {
    if (n.kind !== "LayoutItem" || !n.group || n.path === "this") continue;
    if (offset <= n.group.span.start || offset >= n.group.span.end) continue;
    let t: IrValueType | undefined;
    for (const seg of n.path) {
      if (!scope) return undefined;
      if (seg.kind === "each") {
        if (t?.kind === "nullable") t = t.inner;
        t = t?.kind === "array" ? t.element : undefined;
        continue;
      }
      if (t) {
        if (t.kind === "nullable") t = t.inner;
        if (t.kind !== "struct") return undefined;
        scope = an.el.instancesById.get(t.struct)?.sym;
        if (!scope) return undefined;
      }
      const f: FieldSym | undefined = scope.fieldsByName.get(seg.name.name)?.[0];
      if (!f) return undefined;
      t = an.fieldResult(f)?.value ?? f.valueType;
    }
    if (t?.kind === "nullable") t = t.inner;
    if (t?.kind === "array") t = t.element;
    if (t?.kind === "nullable") t = t.inner;
    if (t?.kind !== "struct") return undefined;
    scope = an.el.instancesById.get(t.struct)?.sym;
    found = true;
  }
  return found ? scope : undefined;
}

/** Lambda parameters in scope at the cursor (`map(records, r => r.|)`), with their types. */
function lambdasAt(ctx: Ctx): { name: string; type?: IrValueType; detail: string }[] {
  const out: { name: string; type?: IrValueType; detail: string }[] = [];
  for (const n of ctx.path) {
    if (n.kind !== "Lambda") continue;
    if (ctx.offset < n.body.span.start - 1) continue;
    const t = ctx.an.el.model.exprTypes.get(n);
    out.push({
      name: n.param.name,
      ...(t ? { type: t } : {}),
      detail: t ? displayValueType(t, ctx.an.el.displayName) : "lambda parameter"
    });
  }
  // half-typed lambdas the parser didn't attach: `x => ` before the cursor on this line
  const ls = ctx.text.lastIndexOf("\n", ctx.offset - 1) + 1;
  for (const m of ctx.text.slice(ls, ctx.offset).matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=>/g))
    if (!out.some(o => o.name === m[1])) out.push({ name: m[1]!, detail: "lambda parameter" });
  return out;
}

function positionAt(ctx: Ctx, struct: StructSym | undefined): number {
  if (!struct) return 0;
  if (ctx.field && ctx.field.owner === struct) return ctx.field.order;
  // the next field after the cursor
  const next = struct.fields.find(f => f.decl.span.start >= ctx.offset);
  return next ? next.order : struct.fields.length;
}

function item(
  label: string,
  kind: CompletionKind,
  detail?: string,
  extra: Partial<CompletionItem> = {}
): CompletionItem {
  const it: CompletionItem = { label, kind, ...extra };
  if (detail) it.detail = detail;
  return it;
}

function inCommentOrString(mod: ModuleInfo, offset: number): boolean {
  for (const c of mod.ast.comments)
    if (offset > c.start && (offset < c.end || (c.kind === "line" && offset === c.end)))
      return true;
  // strings: lex the current line
  const file = mod.file;
  const line = file.positionAt(offset).line;
  const start = file.lineStarts[line]!;
  const f = new SourceFile("/x", file.text.slice(start, offset));
  const toks = lex(f).tokens;
  const last = toks[toks.length - 2];
  if (
    last &&
    (last.kind === "string" ||
      last.kind === "fourcc" ||
      last.kind === "hexbytes" ||
      last.kind === "regex") &&
    last.end === offset - start
  ) {
    const raw = last.text;
    const closed =
      raw.length > 1 &&
      (raw.endsWith('"') || raw.endsWith("'") || (last.kind === "regex" && raw.endsWith("/")));
    return !closed;
  }
  return false;
}

function atLineStart(text: string, offset: number): boolean {
  const ls = text.lastIndexOf("\n", offset - 1) + 1;
  return /^\s*$/.test(text.slice(ls, offset));
}

/** Start of the member containing `offset`: the first line of a logical member (continuation lines included). */
function memberStartOffset(text: string, offset: number, bodyStart: number): number {
  let ls = text.lastIndexOf("\n", offset - 1) + 1;
  if (ls < bodyStart) ls = bodyStart;
  // continuation lines (starting with @ or a clause keyword, or inside open brackets) belong to the previous line
  for (;;) {
    const lineText = text.slice(ls, offset);
    if (ls <= bodyStart) break;
    const trimmed = lineText.trimStart();
    const eol = text.indexOf("\n", ls);
    const fullLine = text.slice(ls, eol < 0 ? text.length : eol);
    // an @ line containing `{` (at bracket depth 0) prefixes a block instead of continuing a field
    const opensBlock =
      /^\s*@/.test(fullLine) &&
      lex(new SourceFile("/x", fullLine)).tokens.some(
        (t, i, all) =>
          t.kind === "{" &&
          bracketDepth(fullLine.slice(0, t.start)) === 0 &&
          i > 0 &&
          all[0]!.kind === "attr"
      );
    const cont =
      /^(@|at\b|from\b|as\b|in\b|where\b|=(?!=)|[-+*/%&|^?:]|\.|\))/.test(trimmed) && !opensBlock;
    const openBefore = bracketDepth(text.slice(bodyStart, ls)) > 0;
    if (!cont && !openBefore) break;
    const prev = text.lastIndexOf("\n", ls - 2) + 1;
    if (prev < bodyStart) {
      ls = bodyStart;
      break;
    }
    ls = prev;
  }
  // a `;` or `{` on the line starts a new member
  const seg = text.slice(ls, offset);
  const lastSep = Math.max(seg.lastIndexOf(";"), seg.lastIndexOf("{"), seg.lastIndexOf("}"));
  if (lastSep >= 0 && bracketDepth(seg.slice(0, lastSep)) === 0 && !/\(/.test(seg.slice(lastSep)))
    return ls + lastSep + 1;
  return ls;
}

function bracketDepth(s: string): number {
  let d = 0;
  for (const t of lex(new SourceFile("/x", s)).tokens) {
    if (t.kind === "(" || t.kind === "[") d++;
    else if (t.kind === ")" || t.kind === "]") d = Math.max(0, d - 1);
  }
  return d;
}

interface LineContext {
  kind: "member" | "type" | "name" | "storage" | "clause" | "expr" | "attrArg" | "caseValue";
  write?: boolean;
  it?: boolean;
  attr?: string;
  argIndex?: number;
  /** `@align(4, from: |)`: the named argument being written. */
  named?: string;
}

/** What the cursor completes, from the tokens between the member start and the cursor. */
function lineContext(text: string, offset: number, start: number): LineContext {
  const toks = lex(new SourceFile("/x", text.slice(start, offset))).tokens.filter(
    t => t.kind !== "eof"
  );
  if (!toks.length) return { kind: "member" };
  // innermost unclosed bracket
  const stack: { tok: Token; index: number; commas: number }[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind === "(" || t.kind === "[") stack.push({ tok: t, index: i, commas: 0 });
    else if (t.kind === ")" || t.kind === "]") stack.pop();
    else if (t.kind === "," && stack.length) stack[stack.length - 1]!.commas++;
  }
  const isCase =
    toks[0]!.kind === "ident" && (toks[0]!.value === "case" || toks[0]!.value === "default");
  if (stack.length) {
    const top = stack[stack.length - 1]!;
    const before = toks[top.index - 1];
    if (top.tok.kind === "(" && before?.kind === "attr") {
      // the current argument's tokens: `name :` makes it a named argument
      let k = toks.length - 1;
      while (k > top.index && toks[k]!.kind !== ",") k--;
      const arg = toks.slice(k + 1);
      const named =
        arg.length >= 2 && arg[0]!.kind === "ident" && arg[1]!.kind === ":"
          ? arg[0]!.value
          : undefined;
      return {
        kind: "attrArg",
        attr: before.value,
        argIndex: top.commas,
        ...(named ? { named } : {})
      };
    }
    if (top.tok.kind === "(" && before?.kind === "ident" && ["if", "switch"].includes(before.value))
      return { kind: "expr" };
    // inside a field's clause?
    const clause = lastClause(toks.slice(0, top.index));
    return {
      kind: "expr",
      write: clause === "=" && !afterAs(toks.slice(0, top.index)),
      it: clause === "as" || clause === "where" || clause === "in" || clause === "="
    };
  }
  if (isCase) {
    const colon = toks.findIndex(t => t.kind === ":");
    if (colon < 0) return { kind: "caseValue" };
    return lineContext(text, offset, start + toks[colon]!.end);
  }
  const clause = lastClause(toks);
  if (clause)
    return {
      kind: "expr",
      write: clause === "=" && !afterAs(toks),
      it: clause === "as" || clause === "where" || clause === "="
    };
  const last = toks[toks.length - 1]!;
  const sameAsCursor = last.end === offset - start;
  const idents = toks.filter(t => t.kind === "ident" || t.kind === "dollar");
  // `Type` (typing the type) → type; `Type name ` → clause keywords; `Type ` → nothing useful (name)
  if (toks.length === 1 && sameAsCursor && last.kind === "ident") return { kind: "member" };
  // `T *name : |` → the pointer's storage type; `T name : |` → a bit width
  if (last.kind === ":")
    return toks.some(t => t.kind === "*") ? { kind: "storage" } : { kind: "expr" };
  // generic arguments `T<|`
  if (toks.filter(t => t.kind === "<").length > toks.filter(t => t.kind === ">").length)
    return { kind: "type" };
  // `T |`, `T *|`: the field's name (anything goes)
  if (last.kind === "*") return { kind: "name" };
  if (
    toks.every(
      t =>
        t.kind === "ident" || t.kind === "." || t.kind === "<" || t.kind === ">" || t.kind === ","
    ) &&
    idents.length <= 1
  )
    return sameAsCursor ? { kind: "type" } : { kind: "name" };
  if (sameAsCursor && last.kind === "ident" && idents.length >= 3) return { kind: "clause" };
  if (!sameAsCursor && idents.length >= 2) return { kind: "clause" };
  if (sameAsCursor && idents.length === 2) return { kind: "clause" };
  return { kind: "type" };
}

function lastClause(toks: Token[]): string | undefined {
  let depth = 0;
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i]!;
    if (t.kind === ")" || t.kind === "]") depth++;
    else if (t.kind === "(" || t.kind === "[") depth = Math.max(0, depth - 1);
    if (depth) continue;
    if (t.kind === "=") return "=";
    if (t.kind === "ident" && ["at", "from", "as", "in", "where"].includes(t.value) && i >= 2)
      return t.value;
  }
  return undefined;
}

function afterAs(toks: Token[]): boolean {
  // `as read = write`: the write side sees every field too, so this only matters for `it`
  return toks.some(t => t.kind === "ident" && t.value === "as") && false;
}

function clauseDoc(k: string): string {
  switch (k) {
    case "at":
      return "at expr — place the field at an offset from the base";
    case "from":
      return "from stream — parse from a stream";
    case "as":
      return "as expr [= inverse] — transform (it = raw)";
    case "in":
      return "in (values) / in /regex/ — check";
    case "where":
      return "where cond — check (it = the value)";
  }
  return "";
}

function fieldDetail(an: Analysis, f: FieldSym): string {
  const t = an.fieldResult(f)?.value ?? f.valueType;
  return t ? displayValueType(t, an.el.displayName) : "field";
}

// ── item sources ─────────────────────────────────────────────────────────────

function typeItems(an: Analysis, mod: ModuleInfo, struct: StructSym | undefined): CompletionItem[] {
  const out: CompletionItem[] = [];
  const seen = new Set<string>();
  const add = (it: CompletionItem) => {
    if (seen.has(it.label)) return;
    seen.add(it.label);
    out.push(it);
  };
  let o: StructSym | undefined = struct;
  while (o) {
    for (const tp of o.typeParams) add(item(tp.name, "type", "type parameter"));
    for (const [n, d] of o.nested) add(declItem(an, n, d));
    o = o.parent;
  }
  for (const [n, d] of mod.decls) if (isTypeDecl(d)) add(declItem(an, n, d));
  for (const [n, b] of mod.imports)
    if (b.target && isTypeDecl(b.target)) add(declItem(an, n, b.target));
  for (const [n] of mod.namespaces) add(item(n, "module", "namespace"));
  for (const n of BUILTIN_TYPE_NAMES)
    add(item(n, "primitive", builtinTypeDoc(n), { sortText: "z" + n }));
  return out;
}

function isTypeDecl(d: DeclSym): boolean {
  return (
    d.kind === "struct" ||
    d.kind === "enum" ||
    d.kind === "union" ||
    d.kind === "alias" ||
    d.kind === "externType"
  );
}

function declItem(an: Analysis, name: string, d: DeclSym): CompletionItem {
  const kind: CompletionKind =
    d.kind === "struct"
      ? "struct"
      : d.kind === "enum"
        ? "enum"
        : d.kind === "const"
          ? "const"
          : d.kind === "externFn"
            ? "function"
            : d.kind === "codec"
              ? "codec"
              : "type";
  const it = item(name, kind, signatureOf(d, an));
  if (d.doc) it.documentation = d.doc;
  return it;
}

function valueItems(
  ctx: Ctx,
  side: "read" | "write" | "const",
  position: number,
  allowIt: boolean
): CompletionItem[] {
  const { an, mod, struct } = ctx;
  const out: CompletionItem[] = [];
  const seen = new Set<string>();
  const add = (it: CompletionItem) => {
    if (seen.has(it.label)) return;
    seen.add(it.label);
    out.push(it);
  };
  if (struct && side !== "const") {
    for (const f of struct.fields) {
      if (!f.name || f === ctx.field) continue;
      if (side === "read" && f.order >= position) continue;
      add(
        item(f.name, "field", fieldDetail(an, f), {
          sortText: "a" + String(f.order).padStart(4, "0")
        })
      );
    }
    for (const p of struct.params)
      add(item(p.name, "parameter", paramDeclText(p.decl), { sortText: "b" + p.name }));
    let o = struct.parent;
    while (o) {
      for (const f of o.fields)
        if (f.name)
          add(
            item(f.name, "field", `${fieldDetail(an, f)} (from ${o.name})`, {
              sortText: "c" + f.name
            })
          );
      for (const p of o.params)
        add(
          item(p.name, "parameter", `${paramDeclText(p.decl)} (from ${o.name})`, {
            sortText: "c" + p.name
          })
        );
      o = o.parent;
    }
  }
  if (allowIt) add(item("it", "keyword", "this field's own value", { sortText: "a" }));
  for (const l of lambdasAt(ctx))
    add(item(l.name, "parameter", `${l.detail} (lambda parameter)`, { sortText: "a0" }));
  for (const [n, d] of mod.decls) {
    if (d.kind === "const" || d.kind === "enum" || d.kind === "externFn")
      add({ ...declItem(an, n, d), sortText: "d" + n });
  }
  for (const [n, b] of mod.imports) {
    if (
      b.target &&
      (b.target.kind === "const" || b.target.kind === "enum" || b.target.kind === "externFn")
    )
      add({ ...declItem(an, n, b.target), sortText: "d" + n });
  }
  if (side !== "const") {
    for (const [n, f] of Object.entries(BUILTIN_FUNCTIONS)) {
      add(
        item(n, "builtin", f.signature, {
          documentation: f.doc,
          insertText: LAMBDA_BUILTINS.has(n) ? `${n}(\${1:array}, \${2:x} => \${3})` : `${n}($1)`,
          insertTextFormat: "snippet",
          sortText: "e" + n
        })
      );
    }
  }
  for (const k of ["true", "false", "le", "be"])
    add(item(k, "keyword", undefined, { sortText: "f" + k }));
  if (side !== "const")
    add(item("null", "keyword", "compare a @nullable pointer: x != null", { sortText: "fnull" }));
  return out;
}

function boundItems(an: Analysis, struct: StructSym | undefined): CompletionItem[] {
  const out: CompletionItem[] = [
    item("endian", "bound", "$endian: byte order in effect (le | be)"),
    item("offset", "bound", "$offset: current position from the base"),
    item("end", "bound", "$end: end of the enclosing region"),
    item("index", "bound", "$index: index in the enclosing array")
  ];
  // only bindings that can be in effect here: the struct's own (fields and `$` params), and
  // those of structs whose instances (transitively) contain this one
  const reaching = struct ? structsReaching(an, struct) : undefined;
  for (const [name, all] of an.el.model.bindingSites) {
    const sites = all.filter(s => !reaching || reaching.has(s.owner as StructSym));
    if (!sites.length) continue;
    const t = an.el.boundType(name);
    const where = sites.map(s => `${s.owner.name}.${s.name}`).join(", ");
    out.push(
      item(
        name,
        "bound",
        `${t ? displayValueType(t, an.el.displayName) : "?"} — bound by ${where}`,
        { sortText: "a" + name }
      )
    );
  }
  return out;
}

/** `target` and the structs whose instances can contain an instance of it (through any use). */
function structsReaching(an: Analysis, target: StructSym): Set<StructSym> {
  const usedBy = new Map<StructSym, Set<StructSym>>();
  for (const m of an.allModules()) {
    const visit = (s: StructSym) => {
      let uses: StructSym[] = [];
      try {
        uses = an.el.structResult(s).out.uses.map(u => u.target);
      } catch {
        // generic or broken: no uses
      }
      for (const u of uses) {
        let set = usedBy.get(u);
        if (!set) usedBy.set(u, (set = new Set()));
        set.add(s);
      }
      for (const d of s.nested.values()) if (d.kind === "struct") visit(d);
    };
    for (const d of m.decls.values()) if (d.kind === "struct") visit(d);
  }
  const out = new Set<StructSym>([target]);
  const work = [target];
  while (work.length) {
    const s = work.pop()!;
    for (const p of usedBy.get(s) ?? []) {
      if (out.has(p)) continue;
      out.add(p);
      work.push(p);
    }
  }
  return out;
}

function attrTarget(
  ctx: Ctx,
  structDecl: A.StructDecl | undefined,
  field: A.FieldDecl | undefined,
  offset: number
): AttrTarget {
  const nodes = ctx.path;
  const enumD = findLast(nodes, n => n.kind === "EnumDecl") as A.EnumDecl | undefined;
  if (enumD && offset < enumD.bodySpan.start) return "enum";
  const codec = findLast(nodes, n => n.kind === "ExternCodecDecl");
  if (codec) return "codec";
  const et = findLast(nodes, n => n.kind === "ExternTypeDecl");
  if (et) return "externType";
  if (findLast(nodes, n => n.kind === "TypeAliasDecl")) return "alias";
  if (findLast(nodes, n => n.kind === "LayoutMember")) return "layoutItem";
  if (structDecl && offset < structDecl.bodySpan.start) return "struct";
  if (field && offset > field.type.span.end) return "field";
  if (findLast(nodes, n => n.kind === "BitsMember") && !field) return "bits";
  if (!structDecl) {
    const s = findLast(nodes, n => n.kind === "StructDecl") as A.StructDecl | undefined;
    if (s && offset < s.bodySpan.start) return "struct";
  }
  // at the start of a member line: block attributes, unless the line continues a field
  const text = ctx.text;
  const ls = text.lastIndexOf("\n", offset - 2) + 1;
  const prevLineEnd = ls - 1;
  const prevLs = text.lastIndexOf("\n", prevLineEnd - 1) + 1;
  const prevLine = text.slice(prevLs, prevLineEnd).trim();
  if (
    /^[A-Za-z_]/.test(prevLine) &&
    !/[{};]\s*$/.test(prevLine) &&
    !/^(if|switch|bits|layout|struct)\b/.test(prevLine)
  )
    return "field";
  return "block";
}

function attributeItems(target: AttrTarget): CompletionItem[] {
  return Object.values(ATTRIBUTES)
    .filter(a => a.targets.includes(target))
    .map(a => {
      const snippet = a.args.length
        ? `${a.name}(${a.args
            .filter(x => !x.optional)
            .map((x, i) => `\${${i + 1}:${x.name}}`)
            .join(", ")})`
        : a.name;
      return item(a.name, "attribute", attributeSignature(a), {
        documentation: a.doc,
        insertText: snippet,
        insertTextFormat: a.args.length ? "snippet" : "plain"
      });
    });
}

function attrArgItems(ctx: Ctx, attr: string, argIndex: number, named?: string): CompletionItem[] {
  const spec = ATTRIBUTES[attr];
  if (spec && named) {
    const n = spec.named?.find(x => x.name === named) ?? spec.args.find(x => x.name === named);
    if (n?.kind === "word") return (n.words ?? []).map(w => item(w, "keyword", namedWordDoc(w)));
    return valueItems(ctx, "read", positionAt(ctx, ctx.struct), false);
  }
  // after the first argument: `strict` and the named arguments
  const extras: CompletionItem[] = [];
  if (spec && argIndex >= 1) {
    if (spec.strictWord)
      extras.push(
        item("strict", "keyword", "check this padding's fill on read", { sortText: "0strict" })
      );
    for (const n of spec.named ?? [])
      extras.push(
        item(`${n.name}:`, "keyword", n.name === "from" ? "from: file | base" : "offset: n", {
          insertText: n.words ? `${n.name}: \${1|${n.words.join(",")}|}` : `${n.name}: \${1:n}`,
          insertTextFormat: "snippet",
          sortText: "0" + n.name
        })
      );
  }
  const arg = spec?.args[argIndex];
  if (!spec || !arg)
    return [...extras, ...valueItems(ctx, "read", positionAt(ctx, ctx.struct), false)];
  if (arg.kind === "fill")
    return [...extras, ...valueItems(ctx, "read", positionAt(ctx, ctx.struct), false)];
  if (arg.kind === "word") return (arg.words ?? []).map(w => item(w, "keyword"));
  if (arg.kind === "string") return ["utf8", "ascii", "latin1"].map(w => item(`"${w}"`, "keyword"));
  if (arg.kind === "codec") {
    const out: CompletionItem[] = [];
    for (const m of ctx.an.allModules()) {
      for (const [n, d] of m.decls) {
        if (d.kind === "codec" && (m === ctx.mod || ctx.mod.imports.has(n)))
          out.push(declItem(ctx.an, n, d));
      }
    }
    for (const [n, b] of ctx.mod.imports)
      if (b.target?.kind === "codec" && !out.some(o => o.label === n))
        out.push(declItem(ctx.an, n, b.target));
    return out;
  }
  const items = valueItems(ctx, "read", positionAt(ctx, ctx.struct), false);
  if (arg.kind === "endian")
    return [item("le", "keyword", "little-endian"), item("be", "keyword", "big-endian"), ...items];
  return items;
}

function memberItems(ctx: Ctx, dotOffset: number): CompletionItem[] {
  const { an, mod, text } = ctx;
  // the expression before the dot: a.b[*].c
  const ls = text.lastIndexOf("\n", dotOffset - 1) + 1;
  const chainText =
    /([A-Za-z_$][A-Za-z0-9_]*(?:\[\*\]|\[[^\]]*\])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\*\]|\[[^\]]*\])?)*)$/.exec(
      text.slice(ls, dotOffset)
    );
  if (!chainText) return [];
  const parts = chainText[1]!.split(".");
  const first = parts[0]!.replace(/\[.*\]$/, "");
  // static paths: enum, namespace, struct nesting
  const decl = mod.decls.get(first) ?? mod.imports.get(first)?.target;
  const ns = mod.namespaces.get(first);
  if (parts.length === 1) {
    if (decl?.kind === "enum")
      return decl.members.map(m =>
        item(m.name, "enumMember", `${decl.name}.${m.name} = ${m.value ?? "?"}`)
      );
    if (ns?.target) return [...ns.target.decls].map(([n, d]) => declItem(an, n, d));
    if (decl?.kind === "struct") return [...decl.nested].map(([n, d]) => declItem(an, n, d));
  }
  // layout paths and value paths: walk field types
  const struct = ctx.struct;
  if (!struct) return [];
  let t: IrValueType | undefined;
  const lambda = lambdasAt(ctx).find(l => l.name === first);
  const firstField = struct.fieldsByName.get(first)?.[0];
  if (lambda) t = lambda.type;
  else if (firstField) t = an.fieldResult(firstField)?.value ?? firstField.valueType;
  else {
    const p = struct.params.find(x => x.name === first);
    if (p) t = p.valueType;
  }
  if (parts[0]!.endsWith("]") && t?.kind === "array") t = t.element;
  for (const part of parts.slice(1)) {
    if (!t) return [];
    const name = part.replace(/\[.*\]$/, "");
    t = memberType(an, t, name);
    if (part.endsWith("]") && t?.kind === "array") t = t.element;
  }
  if (!t) return [];
  if (t.kind === "nullable") t = t.inner;
  if (t.kind === "array" || t.kind === "bytes" || t.kind === "string")
    return [item("length", "field", "element count / code units / bytes")];
  if (t.kind === "struct") {
    const inst = an.el.instancesById.get(t.struct);
    const r = inst && (an.el.results.get(t.struct) ?? an.el.model.structs.get(inst.sym));
    if (!inst) return [];
    return inst.sym.fields
      .filter(f => f.name)
      .map(f => {
        const ft = r?.fields.get(f)?.value;
        return item(f.name, "field", ft ? displayValueType(ft, an.el.displayName) : undefined);
      });
  }
  return [];
}

function namedWordDoc(w: string): string {
  if (w === "file") return "from the start of the file (or decoded region, or stream)";
  if (w === "base") return "from the nearest @base (the default)";
  return "";
}

function memberType(an: Analysis, t: IrValueType, name: string): IrValueType | undefined {
  if (t.kind === "nullable") t = t.inner;
  if (t.kind !== "struct") return undefined;
  const inst = an.el.instancesById.get(t.struct);
  if (!inst) return undefined;
  const f = inst.sym.fieldsByName.get(name)?.[0];
  if (!f) return undefined;
  const r = an.el.results.get(t.struct);
  return r?.fields.get(f)?.value ?? f.valueType;
}

function importItems(
  an: Analysis,
  mod: ModuleInfo,
  imp: A.ImportDecl,
  offset: number
): CompletionItem[] {
  const entry = mod.importDecls.find(d => d.decl === imp);
  const target = entry?.target;
  if (!target) return [];
  if (imp.source && offset >= imp.source.span.start) return [];
  const taken = new Set((imp.names ?? []).map(n => n.name.name));
  return [...target.decls].filter(([n]) => !taken.has(n)).map(([n, d]) => declItem(an, n, d));
}

function topSnippets(): CompletionItem[] {
  return [
    item("struct …", "snippet", "struct declaration", {
      insertText: "struct ${1:Name} {\n\t$0\n}",
      insertTextFormat: "snippet"
    }),
    item("export struct …", "snippet", "exported struct (gets parse/serialize)", {
      insertText: "export struct ${1:Name} {\n\t$0\n}",
      insertTextFormat: "snippet"
    }),
    item("enum …", "snippet", "enum declaration", {
      insertText: "enum ${1:Name} : ${2:u8} {\n\t$0\n}",
      insertTextFormat: "snippet"
    }),
    item("import …", "snippet", "import names from a module", {
      insertText: 'import { $2 } from "$1"',
      insertTextFormat: "snippet"
    }),
    item("extern codec …", "snippet", "codec implemented by the host", {
      insertText: "extern codec ${1:name}",
      insertTextFormat: "snippet"
    }),
    item("extern fn …", "snippet", "function implemented by the host", {
      insertText: "extern fn ${1:name}(${2}) -> ${3:u32}",
      insertTextFormat: "snippet"
    })
  ];
}

function memberSnippets(): CompletionItem[] {
  return [
    item("if …", "snippet", "conditional fields", {
      insertText: "if (${1:condition}) {\n\t$0\n}",
      insertTextFormat: "snippet"
    }),
    item("switch …", "snippet", "discriminated fields", {
      insertText: "switch (${1:tag}) {\n\tcase ${2:value}: $0\n}",
      insertTextFormat: "snippet"
    }),
    item("bits …", "snippet", "bitfields in a storage unit", {
      insertText: "bits ${1:u8} {\n\t$0\n}",
      insertTextFormat: "snippet"
    }),
    item("layout …", "snippet", "order of this struct's pointer targets on write", {
      insertText: "layout {\n\t$0\n}",
      insertTextFormat: "snippet"
    }),
    item("virtual …", "snippet", "a value with no bytes, split into earlier fields on write", {
      insertText: "virtual ${1:u64} ${2:name} = (${3:high} << ${4:32}) | ${5:low}",
      insertTextFormat: "snippet"
    })
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Signature help
// ─────────────────────────────────────────────────────────────────────────────

export function getSignatureHelp(
  an: Analysis,
  path: string,
  pos: Position
): SignatureHelp | undefined {
  const mod = an.module(path);
  if (!mod) return undefined;
  const offset = mod.file.offsetAt(pos);
  // lex from a few lines back
  const startLine = Math.max(0, pos.line - 8);
  const start = mod.file.lineStarts[startLine]!;
  const toks = lex(new SourceFile("/x", mod.file.text.slice(start, offset))).tokens.filter(
    t => t.kind !== "eof"
  );
  const stack: { index: number; commas: number; names: string[] }[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind === "(") stack.push({ index: i, commas: 0, names: [] });
    else if (t.kind === ")") stack.pop();
    else if (t.kind === "," && stack.length) stack[stack.length - 1]!.commas++;
    else if (
      t.kind === "ident" &&
      toks[i + 1]?.kind === ":" &&
      stack.length &&
      (toks[i - 1]?.kind === "(" || toks[i - 1]?.kind === ",")
    ) {
      stack[stack.length - 1]!.names[stack[stack.length - 1]!.commas] = t.value;
    }
  }
  const top = stack[stack.length - 1];
  if (!top) return undefined;
  const callee = toks[top.index - 1];
  if (!callee) return undefined;
  const named = top.names[top.commas];
  const mk = (
    label: string,
    params: { label: string; documentation?: string }[],
    doc?: string
  ): SignatureHelp => {
    let active = top.commas;
    if (named) {
      const i = params.findIndex(
        p =>
          p.label.split(/\s+/).pop()?.replace(/^\$/, "").replace(/\[.*$/, "").replace(/\?$/, "") ===
          named
      );
      if (i >= 0) active = i;
    }
    return {
      signatures: [{ label, parameters: params, ...(doc ? { documentation: doc } : {}) }],
      activeSignature: 0,
      activeParameter: Math.min(active, Math.max(0, params.length - 1))
    };
  };
  if (callee.kind === "attr") {
    const spec = ATTRIBUTES[callee.value];
    if (!spec) return undefined;
    const params: { label: string; documentation?: string }[] = spec.args.map(a => ({
      label: a.optional ? `${a.name}?` : a.name
    }));
    if (spec.strictWord) params.push({ label: "strict?" });
    for (const n of spec.named ?? [])
      params.push({
        label: `${n.name}: ${n.words ? n.words.join(" | ") : "n"}`,
        documentation:
          n.name === "from" ? "where alignment is measured from" : "align this many bytes ahead"
      });
    const help = mk(attributeSignature(spec), params, spec.doc);
    // `strict` and named arguments are matched by name, not position
    const cur = toks.slice(top.index + 1);
    const lastComma = cur.map(t => t.kind).lastIndexOf(",");
    const argToks = cur.slice(lastComma + 1);
    const word = argToks[0]?.kind === "ident" ? argToks[0].value : undefined;
    const byName = named ?? (word === "strict" ? "strict" : undefined);
    if (byName) {
      const i = params.findIndex(p => p.label.replace(/[?:].*$/, "") === byName);
      if (i >= 0) help.activeParameter = i;
    }
    return help;
  }
  if (callee.kind !== "ident") return undefined;
  const name = callee.value;
  if (BUILTIN_FUNCTIONS[name]) {
    const b = BUILTIN_FUNCTIONS[name];
    return mk(
      b.signature,
      b.params.map(p => ({ label: p })),
      b.doc
    );
  }
  // look up the declaration (lexically from the cursor)
  const nodes = nodePath(mod.ast, offset);
  const structDecl = findLast(nodes, n => n.kind === "StructDecl") as A.StructDecl | undefined;
  let d: DeclSym | undefined;
  let s = structDecl ? an.structByDecl.get(structDecl) : undefined;
  while (s && !d) {
    d = s.nested.get(name);
    s = s.parent;
  }
  d ??= mod.decls.get(name) ?? mod.imports.get(name)?.target;
  if (!d) return undefined;
  switch (d.kind) {
    case "struct":
    case "union":
    case "alias":
    case "externFn":
    case "codec":
    case "externType": {
      const params = d.params.map(p => ({ label: paramDeclText(p.decl) }));
      const label =
        d.kind === "struct" || d.kind === "union" || d.kind === "alias"
          ? `${d.name}(${params.map(p => p.label).join(", ")})`
          : signatureOf(d, an);
      return mk(label, params, d.doc);
    }
    default:
      return undefined;
  }
}
