/** Document/workspace symbols, semantic tokens, folding, inlay hints, code lenses. */
import type * as A from "../frontend/ast.ts";
import { lex } from "../frontend/lexer.ts";
import { printIrExpr } from "../frontend/printer.ts";
import type { FieldResult } from "../frontend/model.ts";
import type { ModuleInfo, Sym } from "../frontend/symbols.ts";
import type { IrExpr } from "../ir/index.ts";
import { displayValueType, hex, isIrField } from "../frontend/types.ts";
import type {
  CodeLens,
  DocumentSymbol,
  FoldingRange,
  InlayHint,
  Range,
  SemanticToken,
  SemanticTokenModifier,
  SemanticTokenType,
  SymbolKind,
  WorkspaceSymbol
} from "./api.ts";
import type { Analysis } from "./analysis.ts";
import { paramDeclText } from "./describe.ts";
import { children, type Node } from "./locate.ts";

// ── document symbols ──────────────────────────────────────────────────────────

export function documentSymbols(an: Analysis, mod: ModuleInfo): DocumentSymbol[] {
  const file = mod.file;
  const sym = (
    name: string,
    kind: SymbolKind,
    span: { start: number; end: number },
    sel: { start: number; end: number },
    detail?: string,
    kids?: DocumentSymbol[]
  ): DocumentSymbol => {
    const s: DocumentSymbol = {
      name: name || "?",
      kind,
      range: file.rangeOf(span),
      selectionRange: file.rangeOf(sel)
    };
    if (detail) s.detail = detail;
    if (kids?.length) s.children = kids;
    return s;
  };
  const fieldSyms = (members: A.Member[]): DocumentSymbol[] => {
    const out: DocumentSymbol[] = [];
    for (const m of members) {
      switch (m.kind) {
        case "FieldDecl":
          if (m.name) out.push(sym(m.name.name, "field", m.span, m.name.span, fieldDetail(an, m)));
          break;
        case "BitsMember":
          out.push(...fieldSyms(m.fields));
          break;
        case "BlockMember":
          out.push(...fieldSyms(m.members));
          break;
        case "IfMember":
          out.push(...fieldSyms(m.then), ...fieldSyms(m.else ?? []));
          break;
        case "SwitchMember":
          for (const c of m.cases) out.push(...fieldSyms(c.members));
          break;
        case "StructDecl":
        case "EnumDecl":
        case "UnionDecl":
          out.push(declSym(m)!);
          break;
        case "LayoutMember":
          break;
      }
    }
    return out;
  };
  const declSym = (d: A.Decl | A.StructDecl): DocumentSymbol | undefined => {
    switch (d.kind) {
      case "StructDecl":
        return sym(
          d.name.name,
          "struct",
          d.span,
          d.name.span,
          d.params ? `(${d.params.map(paramDeclText).join(", ")})` : undefined,
          fieldSyms(d.members)
        );
      case "EnumDecl":
        return sym(
          d.name.name,
          "enum",
          d.span,
          d.name.span,
          d.storage ? d.storage.name.map(n => n.name).join(".") : undefined,
          d.members.map(m => sym(m.name.name, "enumMember", m.span, m.name.span))
        );
      case "UnionDecl":
        return sym(d.name.name, "union", d.span, d.name.span);
      case "TypeAliasDecl":
        return sym(d.name.name, "type", d.span, d.name.span);
      case "ExternFnDecl":
      case "ExternCodecDecl":
      case "ExternTypeDecl":
        return sym(
          d.name.name,
          "extern",
          d.span,
          d.name.span,
          d.kind === "ExternFnDecl" ? "fn" : d.kind === "ExternCodecDecl" ? "codec" : "type"
        );
      case "ConstDecl":
        return sym(d.name.name, "const", d.span, d.name.span);
      case "ImportDecl":
        return undefined;
    }
  };
  return mod.ast.decls.map(declSym).filter((x): x is DocumentSymbol => !!x);
}

function fieldDetail(an: Analysis, f: A.FieldDecl): string | undefined {
  const s = an.fieldByDecl.get(f);
  const t = s && (an.fieldResult(s)?.value ?? s.valueType);
  return t ? displayValueType(t, an.el.displayName) : undefined;
}

export function workspaceSymbols(an: Analysis, query: string): WorkspaceSymbol[] {
  const out: WorkspaceSymbol[] = [];
  const q = query.toLowerCase();
  const matches = (name: string) => {
    if (!q) return true;
    const n = name.toLowerCase();
    let i = 0;
    for (const ch of n) if (ch === q[i]) i++;
    return i === q.length;
  };
  for (const mod of an.allModules()) {
    const visit = (doc: DocumentSymbol[], container?: string) => {
      for (const s of doc) {
        if (s.kind !== "field" && s.kind !== "enumMember" && matches(s.name)) {
          const w: WorkspaceSymbol = {
            name: s.name,
            kind: s.kind,
            location: { path: mod.path, range: s.selectionRange }
          };
          if (container) w.containerName = container;
          out.push(w);
        }
        if (s.children) visit(s.children, s.name);
      }
    };
    visit(documentSymbols(an, mod));
  }
  return out;
}

// ── semantic tokens ───────────────────────────────────────────────────────────

const KEYWORDS = new Set([
  "struct",
  "enum",
  "union",
  "type",
  "extern",
  "fn",
  "codec",
  "async",
  "const",
  "import",
  "export",
  "from",
  "if",
  "else",
  "switch",
  "case",
  "default",
  "layout",
  "bits",
  "at",
  "as",
  "in",
  "where",
  "until",
  "before",
  "true",
  "false",
  "it",
  "this",
  "le",
  "be",
  "virtual",
  "null"
]);

function symToken(s: Sym): { type: SemanticTokenType; mods: SemanticTokenModifier[] } {
  switch (s.kind) {
    case "struct":
      return { type: "struct", mods: [] };
    case "enum":
      return { type: "enum", mods: [] };
    case "enumMember":
      return { type: "enumMember", mods: ["readonly"] };
    case "union":
    case "alias":
    case "externType":
      return { type: "type", mods: [] };
    case "builtinType":
      return { type: "type", mods: ["defaultLibrary"] };
    case "externFn":
    case "codec":
      return { type: "function", mods: [] };
    case "builtinFn":
      return { type: "function", mods: ["defaultLibrary"] };
    case "const":
      return { type: "variable", mods: ["readonly"] };
    case "field":
      return { type: "property", mods: [] };
    case "param":
    case "lambdaParam":
      return { type: "parameter", mods: [] };
    case "typeParam":
      return { type: "typeParameter", mods: [] };
    case "namespace":
      return { type: "namespace", mods: [] };
  }
}

export function semanticTokens(an: Analysis, mod: ModuleInfo): SemanticToken[] {
  const file = mod.file;
  const refs = new Map<number, { end: number; sym: Sym; decl: boolean }>();
  for (const r of an.refs(mod.path)) {
    const prev = refs.get(r.span.start);
    if (!prev || r.decl) refs.set(r.span.start, { end: r.span.end, sym: r.sym, decl: r.decl });
  }
  const out: SemanticToken[] = [];
  const push = (
    start: number,
    end: number,
    type: SemanticTokenType,
    mods: SemanticTokenModifier[]
  ) => {
    // split multi-line spans per line (LSP tokens are single-line)
    let s = start;
    while (s < end) {
      const p = file.positionAt(s);
      const lineEnd =
        p.line + 1 < file.lineCount ? file.lineStarts[p.line + 1]! - 1 : file.text.length;
      const e = Math.min(end, lineEnd);
      const len = file.text.slice(s, e).replace(/\r$/, "").length;
      if (len > 0)
        out.push({ line: p.line, character: p.character, length: len, type, modifiers: mods });
      s = lineEnd + 1;
    }
  };
  const { tokens, comments } = lex(file);
  const items: {
    start: number;
    end: number;
    type: SemanticTokenType;
    mods: SemanticTokenModifier[];
  }[] = [];
  for (const c of comments)
    items.push({ start: c.start, end: c.end, type: "comment", mods: c.doc ? ["readonly"] : [] });
  for (const t of tokens) {
    switch (t.kind) {
      case "ident": {
        const r = refs.get(t.start);
        if (r && r.end === t.end) {
          const st = symToken(r.sym);
          items.push({
            start: t.start,
            end: t.end,
            type: st.type,
            mods: r.decl ? ["declaration", ...st.mods] : st.mods
          });
        } else if (KEYWORDS.has(t.value))
          items.push({ start: t.start, end: t.end, type: "keyword", mods: [] });
        break;
      }
      case "int":
      case "float":
        items.push({ start: t.start, end: t.end, type: "number", mods: [] });
        break;
      case "string":
      case "hexbytes":
      case "b64bytes":
      case "fourcc":
        items.push({ start: t.start, end: t.end, type: "string", mods: [] });
        break;
      case "regex":
        items.push({ start: t.start, end: t.end, type: "regexp", mods: [] });
        break;
      case "attr":
        items.push({ start: t.start, end: t.end, type: "decorator", mods: [] });
        break;
      case "dollar": {
        const builtin = ["endian", "offset", "end", "index"].includes(t.value);
        items.push({
          start: t.start,
          end: t.end,
          type: "variable",
          mods: builtin ? ["defaultLibrary", "readonly"] : ["readonly"]
        });
        break;
      }
      default:
        break;
    }
  }
  items.sort((a, b) => a.start - b.start);
  for (const it of items) push(it.start, it.end, it.type, it.mods);
  return out;
}

// ── folding ───────────────────────────────────────────────────────────────────

export function foldingRanges(mod: ModuleInfo): FoldingRange[] {
  const file = mod.file;
  const out: FoldingRange[] = [];
  const add = (span: { start: number; end: number }, kind?: FoldingRange["kind"]) => {
    const s = file.positionAt(span.start).line;
    const e = file.positionAt(span.end).line;
    if (e > s) out.push({ startLine: s, endLine: e, ...(kind ? { kind } : {}) });
  };
  const visit = (n: Node) => {
    switch (n.kind) {
      case "StructDecl":
      case "EnumDecl":
      case "UnionDecl":
      case "BlockMember":
      case "SwitchMember":
      case "BitsMember":
      case "LayoutMember":
        add(n.bodySpan);
        break;
      case "IfMember":
        add(n.thenSpan);
        if (n.else && !n.elseIf && n.elseSpan) add({ start: n.elseSpan.start, end: n.span.end });
        break;
      case "SwitchCase":
        add(n.span);
        break;
      default:
        break;
    }
    for (const c of children(n)) visit(c);
  };
  visit(mod.ast);
  for (const c of mod.ast.comments) if (c.kind === "block") add(c, "comment");
  // runs of line comments and imports
  const runs = (pred: (i: number) => boolean, kind: FoldingRange["kind"]) => {
    let start = -1;
    for (let i = 0; i <= file.lineCount; i++) {
      if (i < file.lineCount && pred(i)) {
        if (start < 0) start = i;
      } else {
        if (start >= 0 && i - 1 > start)
          out.push({ startLine: start, endLine: i - 1, ...(kind ? { kind } : {}) });
        start = -1;
      }
    }
  };
  runs(i => /^\s*\/\//.test(file.lineText(i)), "comment");
  runs(i => /^\s*import\b/.test(file.lineText(i)), "imports");
  out.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
  return out;
}

// ── inlay hints ───────────────────────────────────────────────────────────────

function inRange(range: Range, pos: { line: number; character: number }): boolean {
  if (pos.line < range.start.line || pos.line > range.end.line) return false;
  if (pos.line === range.start.line && pos.character < range.start.character) return false;
  if (pos.line === range.end.line && pos.character > range.end.character) return false;
  return true;
}

export function inlayHints(an: Analysis, mod: ModuleInfo, range: Range): InlayHint[] {
  const file = mod.file;
  const out: InlayHint[] = [];
  for (const s of an.structByDecl.values()) {
    if (s.module !== mod) continue;
    const r = an.structResult(s);
    if (!r) continue;
    for (const fr of r.fields.values()) {
      const f = fr.sym;
      if (!f.name) continue;
      const decl = f.decl;
      // derived formula after the field declaration (where an explicit `= …` would go)
      if (fr.ir.derive && fr.ir.deriveKind === "auto") {
        const lastArray = decl.arrays[decl.arrays.length - 1];
        const at = file.positionAt(
          lastArray ? lastArray.span.end : decl.name ? decl.name.span.end : decl.span.end
        );
        if (inRange(range, at)) {
          out.push({
            position: at,
            label: `= ${deriveLabel(fr)}`,
            tooltip: `Written automatically from the ${fr.deriveSource ?? "read side"}; \`${f.name}\` is not in the input type.`,
            paddingLeft: true
          });
        }
      }
      // a bytes field assembled from its `from` slices on write
      if (isIrField(fr.ir) && fr.ir.carrier === "slices") {
        const lastArray = decl.arrays[decl.arrays.length - 1];
        const at = file.positionAt(
          lastArray ? lastArray.span.end : decl.name ? decl.name.span.end : decl.span.end
        );
        const from = fr.deriveSource?.replace(/^assembled from its slices \(|\)$/g, "");
        if (inRange(range, at))
          out.push({
            position: at,
            label: `= slices of ${from ?? "it"}`,
            tooltip: `Assembled on write from the fields read from its slices (zeros elsewhere); \`${f.name}\` is not in the input type.`,
            paddingLeft: true
          });
      }
      // inferred transform reverse
      if (fr.inferredWrite && decl.clauses.asRead) {
        const at = file.positionAt(decl.clauses.asRead.span.end);
        if (inRange(range, at))
          out.push({
            position: at,
            label: `= ${fr.inferredWrite}`,
            tooltip: "Reverse worked out by the compiler.",
            paddingLeft: true
          });
      }
      // @size labels: decoded / on disk
      if (
        isIrField(fr.ir) &&
        fr.ir.type.kind === "layered" &&
        fr.ir.type.layers.some(l => l.kind === "via")
      ) {
        const layers = fr.ir.type.layers;
        const sizeAttrs = decl.attrs.filter(a => a.name.name === "size");
        let k = 0;
        layers.forEach((l, i) => {
          if (l.kind !== "size") return;
          const attr = sizeAttrs[k++];
          if (!attr) return;
          const inside = layers.slice(i + 1).some(x => x.kind === "via");
          const at = file.positionAt(attr.span.end);
          if (inRange(range, at))
            out.push({
              position: at,
              label: inside ? "decoded" : "on disk",
              kind: "type",
              paddingLeft: true
            });
        });
      }
    }
  }
  // parameter names for positional struct arguments
  const visitType = (t: A.TypeRef) => {
    if (!t.args?.length) return;
    const ref = an.refAt(mod.path, t.name[t.name.length - 1]!.span.start);
    const target = ref?.sym;
    if (
      !target ||
      (target.kind !== "struct" &&
        target.kind !== "alias" &&
        target.kind !== "union" &&
        target.kind !== "externType")
    )
      return;
    t.args.forEach((a, i) => {
      if (a.name) return;
      const p = target.params[i];
      if (!p) return;
      const u = a.value.kind === "Name" && a.value.name === p.name;
      if (u) return;
      const at = file.positionAt(a.span.start);
      if (inRange(range, at))
        out.push({ position: at, label: `${p.name}:`, kind: "parameter", paddingRight: true });
    });
  };
  const walk = (n: Node) => {
    if (n.kind === "TypeRef") visitType(n);
    for (const c of children(n)) walk(c);
  };
  walk(mod.ast);
  out.sort(
    (a, b) => a.position.line - b.position.line || a.position.character - b.position.character
  );
  return out;
}

// ── code lenses ───────────────────────────────────────────────────────────────

export function codeLenses(an: Analysis, mod: ModuleInfo): CodeLens[] {
  const out: CodeLens[] = [];
  for (const s of an.structByDecl.values()) {
    if (s.module !== mod) continue;
    const range = mod.file.rangeOf(s.decl.name.span);
    const lineRange: Range = {
      start: { line: range.start.line, character: 0 },
      end: { line: range.start.line, character: 0 }
    };
    for (const n of an.el.model.needs.get(s) ?? []) {
      const sources = (an.el.model.bindingSites.get(n.name) ?? []).map(site => ({
        path: site.module.path,
        range: site.module.file.rangeOf(site.nameSpan)
      }));
      out.push({
        range: lineRange,
        title: `needs: $${n.name} (${displayValueType(n.type, an.el.displayName)})`,
        command: {
          id: "yaffle.showBindingSources",
          arguments: [{ path: mod.path, binding: n.name, sources }]
        }
      });
    }
    const r = an.structResult(s);
    if (r && !s.typeParams.length) {
      const size = an.el.staticSize({ kind: "struct", struct: r.id, args: [] });
      if (size !== undefined)
        out.push({ range: lineRange, title: `size: ${hex(size)} (${size} bytes)` });
    }
  }
  out.sort((a, b) => a.range.start.line - b.range.start.line);
  return out;
}

/** Every `$name` occurrence in a module (for renaming bound values). */
export function dollarOccurrences(mod: ModuleInfo, name: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const visit = (n: Node) => {
    if (n.kind === "Dollar" && n.name === name)
      out.push({ start: n.span.start + 1, end: n.span.end });
    for (const c of children(n)) visit(c);
  };
  visit(mod.ast);
  return out;
}

/** Readable form of a derivation: sizes measured through codecs are named, others printed. */
function deriveLabel(fr: FieldResult): string {
  const d = fr.ir.derive;
  if (!d) return "";
  let usesSize = false;
  const text = printIrExpr(d);
  const visit = (e: IrExpr): void => {
    if (e.kind === "call" && e.callee.kind === "builtin" && e.callee.name === "encodedSize")
      usesSize = true;
    if (e.kind === "binary") {
      visit(e.left);
      visit(e.right);
    }
    if (e.kind === "convert") visit(e.operand);
  };
  visit(d);
  if (usesSize && fr.deriveSource) {
    const src = fr.deriveSource;
    const replaced = text.replace(/encodedSize\(([^,]+), \d+\)/, "\u0000");
    return replaced === "\u0000" ? src : replaced.replace("\u0000", `(${src})`);
  }
  return text;
}
