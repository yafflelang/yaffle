/**
 * Error-tolerant recursive-descent parser for yaffle.
 *
 * Newline rules:
 * - Semicolons are optional. Members end at a line break, a `;`, or wherever the next member
 *   starts (`u64 n  u64 ofs` on one line is two fields).
 * - A line starting with `@` continues the previous field, unless that line contains a `{`
 *   (then the attributes prefix a block).
 * - A line starting with a clause keyword (`at`, `from`, `as`, `in`, `where`) or `=` continues the
 *   previous field. Binary operators continue an expression across lines.
 * - Inside parentheses and brackets, line breaks are ignored.
 */
import type * as A from "./ast.ts";
import { DiagnosticBag, type DiagnosticCode } from "./diagnostics.ts";
import { lex, type Comment, type Token, type TokenKind } from "./lexer.ts";
import type { SourceFile, Span } from "./source.ts";

const CLAUSE_WORDS = new Set(["at", "from", "as", "in", "where"]);
const DECL_WORDS = new Set([
  "struct",
  "enum",
  "union",
  "type",
  "extern",
  "const",
  "import",
  "export"
]);

interface BinOpInfo {
  prec: number;
  op: A.BinaryOp;
}

const BIN_OPS: Partial<Record<TokenKind, BinOpInfo>> = {
  "||": { prec: 1, op: "||" },
  "&&": { prec: 2, op: "&&" },
  "==": { prec: 3, op: "==" },
  "!=": { prec: 3, op: "!=" },
  "<": { prec: 3, op: "<" },
  "<=": { prec: 3, op: "<=" },
  ">": { prec: 3, op: ">" },
  ">=": { prec: 3, op: ">=" },
  "|": { prec: 4, op: "|" },
  "^": { prec: 5, op: "^" },
  "&": { prec: 6, op: "&" },
  "<<": { prec: 7, op: "<<" },
  ">>": { prec: 7, op: ">>" },
  "+": { prec: 8, op: "+" },
  "-": { prec: 8, op: "-" },
  "*": { prec: 9, op: "*" },
  "/": { prec: 9, op: "/" },
  "%": { prec: 9, op: "%" }
};
const IN_PREC = 3;

/** Operator precedence, for printers (higher binds tighter). */
export function binaryPrecedence(op: A.BinaryOp): number {
  for (const info of Object.values(BIN_OPS)) if (info && info.op === op) return info.prec;
  return 0;
}

export interface ParseResult {
  module: A.Module;
  diagnostics: DiagnosticBag;
}

export function parse(
  file: SourceFile,
  diagnostics: DiagnosticBag = new DiagnosticBag()
): ParseResult {
  const { tokens, comments } = lex(file, diagnostics);
  const parser = new Parser(file, tokens, comments, diagnostics);
  return { module: parser.parseModule(), diagnostics };
}

interface ExprFlags {
  /** Don't treat `in` as an operator at depth 0 (field clauses use `in` themselves). */
  noIn: boolean;
  /** Inside parentheses/brackets: line breaks are insignificant. */
  nested: boolean;
}

const TOP: ExprFlags = { noIn: true, nested: false };
const NESTED: ExprFlags = { noIn: false, nested: true };

class Parser {
  private p = 0;
  private lastEnd = 0;
  private lastErrorAt = -1;
  private readonly docs = new Map<number, string>();

  private readonly file: SourceFile;
  private readonly tokens: Token[];
  private readonly comments: Comment[];
  private readonly diags: DiagnosticBag;

  constructor(file: SourceFile, tokens: Token[], comments: Comment[], diags: DiagnosticBag) {
    this.file = file;
    this.tokens = tokens;
    this.comments = comments;
    this.diags = diags;
    // Doc comments attach to the next token if only whitespace (at most one line break) separates them.
    let ci = 0;
    let prevEnd = 0;
    for (const t of tokens) {
      const between: Comment[] = [];
      while (ci < comments.length && comments[ci]!.start < t.start) {
        if (comments[ci]!.start >= prevEnd) between.push(comments[ci]!);
        ci++;
      }
      const parts: string[] = [];
      let cursor = t.start;
      for (let k = between.length - 1; k >= 0; k--) {
        const c = between[k]!;
        const gap = file.text.slice(c.end, cursor);
        if (!/^\s*$/.test(gap) || (gap.match(/\n/g)?.length ?? 0) > 1 || !c.doc) break;
        parts.unshift(cleanDoc(c.text));
        cursor = c.start;
      }
      if (parts.length) this.docs.set(t.start, parts.join("\n"));
      prevEnd = t.end;
    }
  }

  // ── token helpers ────────────────────────────────────────────────────────

  private get tok(): Token {
    return this.tokens[this.p]!;
  }

  private peek(o = 1): Token {
    return this.tokens[Math.min(this.p + o, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const t = this.tokens[this.p]!;
    if (t.kind !== "eof") this.p++;
    this.lastEnd = t.end;
    return t;
  }

  private is(kind: TokenKind): boolean {
    return this.tok.kind === kind;
  }

  private isWord(word: string, t: Token = this.tok): boolean {
    return t.kind === "ident" && t.value === word;
  }

  private eat(kind: TokenKind): Token | undefined {
    if (this.tok.kind === kind) return this.next();
    return undefined;
  }

  private eatWord(word: string): Token | undefined {
    if (this.isWord(word)) return this.next();
    return undefined;
  }

  /** The token is on the same line as the previous one. */
  private sameLine(t: Token = this.tok): boolean {
    return !t.newlineBefore;
  }

  private error(span: Span, message: string, code: DiagnosticCode = "syntax-error"): void {
    if (span.start === this.lastErrorAt) return;
    this.lastErrorAt = span.start;
    this.diags.report(this.file, span, code, message);
  }

  /** Reports at the current token, or just after the previous token when the current one is on a later line. */
  private errorHere(message: string): void {
    const t = this.tok;
    if (t.kind === "eof" || t.newlineBefore) {
      this.error({ start: this.lastEnd, end: this.lastEnd }, message);
    } else {
      this.error({ start: t.start, end: t.end }, message);
    }
  }

  private describe(t: Token): string {
    if (t.kind === "eof") return "end of file";
    if (t.kind === "ident") return `'${t.value}'`;
    if (t.kind === "int" || t.kind === "float") return `number ${t.text}`;
    if (t.kind === "string") return "string";
    return `'${t.text}'`;
  }

  private expect(kind: TokenKind, what?: string): Token | undefined {
    if (this.tok.kind === kind) return this.next();
    this.errorHere(`Expected ${what ?? `'${kind}'`} but found ${this.describe(this.tok)}.`);
    return undefined;
  }

  /** Splits a `>>` token into two `>` (for nested generics). */
  private splitShift(): void {
    const t = this.tok;
    if (t.kind === ">>" || t.kind === ">=") {
      const first: Token = { ...t, kind: ">", end: t.start + 1, text: ">", value: ">" };
      const secondKind: TokenKind = t.kind === ">>" ? ">" : "=";
      const second: Token = {
        ...t,
        kind: secondKind,
        start: t.start + 1,
        text: secondKind,
        value: secondKind,
        newlineBefore: false
      };
      this.tokens.splice(this.p, 1, first, second);
    }
  }

  private span(start: number): Span {
    return { start, end: Math.max(start, this.lastEnd) };
  }

  private ident(t: Token): A.Ident {
    return { kind: "Ident", name: t.value, span: { start: t.start, end: t.end } };
  }

  /** The name of a `$name` token, without the `$` (its span starts after it). */
  private dollarIdent(t: Token): A.Ident {
    return { kind: "Ident", name: t.value, span: { start: t.start + 1, end: t.end } };
  }

  private missingIdent(): A.Ident {
    return { kind: "Ident", name: "", span: { start: this.lastEnd, end: this.lastEnd } };
  }

  private expectIdent(what: string): A.Ident {
    const t = this.tok;
    if (t.kind === "ident") return this.ident(this.next());
    this.errorHere(`Expected ${what} but found ${this.describe(t)}.`);
    return this.missingIdent();
  }

  /** Skips tokens until one of `kinds` (not consumed), a line break, or EOF. */
  private skipLine(stopKinds: TokenKind[] = []): void {
    const start = this.p;
    while (this.tok.kind !== "eof") {
      if (this.p > start && this.tok.newlineBefore) break;
      if (stopKinds.includes(this.tok.kind)) break;
      if (this.tok.kind === "{") {
        this.skipBalanced();
        continue;
      }
      this.next();
    }
  }

  /** Skips a balanced `{…}`, `(…)` or `[…]` group starting at the current token. */
  private skipBalanced(): void {
    const open = this.tok.kind;
    const close = open === "{" ? "}" : open === "(" ? ")" : "]";
    let depth = 0;
    while (this.tok.kind !== "eof") {
      const k = this.tok.kind;
      if (k === open) depth++;
      else if (k === close) {
        depth--;
        if (depth === 0) {
          this.next();
          return;
        }
      }
      this.next();
    }
  }

  private docFor(t: Token): string | undefined {
    return this.docs.get(t.start);
  }

  // ── module ───────────────────────────────────────────────────────────────

  parseModule(): A.Module {
    const decls: A.Decl[] = [];
    while (!this.is("eof")) {
      if (this.eat(";")) continue;
      const before = this.p;
      const d = this.parseDecl();
      if (d) decls.push(d);
      if (this.p === before) {
        // no progress: skip to the next likely declaration start
        this.next();
        while (
          !this.is("eof") &&
          !(this.tok.newlineBefore && this.tok.kind === "ident" && DECL_WORDS.has(this.tok.value))
        ) {
          if (this.tok.kind === "{") this.skipBalanced();
          else this.next();
        }
      }
    }
    return {
      kind: "Module",
      file: this.file,
      decls,
      comments: this.comments,
      span: { start: 0, end: this.file.text.length }
    };
  }

  private parseDecl(): A.Decl | undefined {
    const start = this.tok.start;
    const doc = this.docFor(this.tok);
    let exportSpan: Span | undefined;
    if (this.isWord("export")) {
      const t = this.next();
      exportSpan = { start: t.start, end: t.end };
    }
    const t = this.tok;
    if (t.kind !== "ident") {
      if (t.kind !== "error") {
        this.errorHere(
          `Expected a declaration (struct, enum, union, type, extern, const or import) but found ${this.describe(t)}.`
        );
      }
      return undefined;
    }
    const base = {
      exported: !!exportSpan,
      ...(exportSpan ? { exportSpan } : {}),
      ...(doc ? { doc } : {})
    };
    switch (t.value) {
      case "struct":
        return this.parseStruct(start, base);
      case "enum":
        return this.parseEnum(start, base);
      case "union":
        return this.parseUnion(start, base);
      case "type":
        return this.parseAlias(start, base);
      case "extern":
        return this.parseExtern(start, base);
      case "const":
        return this.parseConst(start, base);
      case "import": {
        if (exportSpan) this.error(exportSpan, "Imports can't be exported.");
        return this.parseImport(start);
      }
      default: {
        const n = this.peek();
        if (!n.newlineBefore && (n.kind === "ident" || n.kind === "dollar" || n.kind === "*")) {
          this.errorHere("Fields must be declared inside a struct.");
        } else if (["if", "switch", "bits", "layout"].includes(t.value)) {
          this.errorHere(`'${t.value}' is only allowed inside a struct.`);
        } else {
          this.errorHere(
            `Expected a declaration (struct, enum, union, type, extern, const or import) but found ${this.describe(t)}.`
          );
        }
        return undefined;
      }
    }
  }

  private parseImport(start: number): A.ImportDecl {
    const kw = this.next();
    const decl: A.ImportDecl = {
      kind: "ImportDecl",
      exported: false,
      keywordSpan: { start: kw.start, end: kw.end },
      span: { start, end: kw.end }
    };
    if (this.eat("*")) {
      if (!this.eatWord("as")) this.errorHere("Expected 'as' after 'import *'.");
      decl.namespace = this.expectIdent("a namespace name");
    } else if (this.eat("{")) {
      const names: A.ImportSpec[] = [];
      while (!this.is("}") && !this.is("eof")) {
        if (this.eat(",")) continue;
        if (this.tok.kind !== "ident") {
          this.errorHere(`Expected an imported name but found ${this.describe(this.tok)}.`);
          if (this.isWord("from") || this.tok.newlineBefore) break;
          this.next();
          continue;
        }
        if (this.isWord("from")) break;
        const s = this.tok.start;
        const name = this.ident(this.next());
        const spec: A.ImportSpec = { kind: "ImportSpec", name, span: name.span };
        if (this.eatWord("as")) {
          spec.alias = this.expectIdent("an alias name");
          spec.span = this.span(s);
        }
        names.push(spec);
      }
      this.expect("}");
      decl.names = names;
    } else {
      this.errorHere("Expected '{' or '*' after 'import'.");
    }
    if (this.eatWord("from")) {
      if (this.is("string")) {
        const s = this.next();
        decl.source = { kind: "String", value: s.value, span: { start: s.start, end: s.end } };
      } else this.errorHere("Expected a module path string after 'from'.");
    } else this.errorHere("Expected 'from \"path\"'.");
    decl.span = this.span(start);
    return decl;
  }

  private parseTypeParams(): A.Ident[] {
    const out: A.Ident[] = [];
    if (!this.is("<")) return out;
    this.next();
    while (!this.is(">") && !this.is("eof") && !this.is("{")) {
      if (this.eat(",")) continue;
      if (this.tok.kind === ">>") break;
      out.push(this.expectIdent("a type parameter name"));
      if (!this.is(",") && !this.is(">")) break;
    }
    this.splitShift();
    this.expect(">");
    return out;
  }

  private parseParams(): A.ParamDecl[] {
    const out: A.ParamDecl[] = [];
    this.expect("(");
    while (!this.is(")") && !this.is("eof")) {
      if (this.eat(",")) continue;
      if (this.is("{") || this.is("}")) break;
      const before = this.p;
      out.push(this.parseParam());
      if (this.p === before) this.next();
      if (!this.is(",") && !this.is(")")) {
        this.errorHere(`Expected ',' or ')' but found ${this.describe(this.tok)}.`);
        while (!this.is(",") && !this.is(")") && !this.is("eof") && !this.is("{")) this.next();
      }
    }
    this.expect(")");
    return out;
  }

  private parseParam(): A.ParamDecl {
    const start = this.tok.start;
    let type: A.TypeRef | undefined;
    if (this.tok.kind === "ident") type = this.parseTypeRef();
    else this.errorHere(`Expected a parameter type but found ${this.describe(this.tok)}.`);
    let bound = false;
    let name: A.Ident;
    if (this.tok.kind === "dollar") {
      bound = true;
      const t = this.next();
      name = this.dollarIdent(t);
    } else if (this.tok.kind === "ident") {
      name = this.ident(this.next());
    } else {
      this.errorHere(`Expected a parameter name but found ${this.describe(this.tok)}.`);
      name = this.missingIdent();
    }
    const arrays = this.parseArraySuffixes(true);
    const param: A.ParamDecl = { kind: "ParamDecl", bound, name, arrays, span: this.span(start) };
    if (type) param.type = type;
    if (this.eat("=")) {
      param.default = this.parseExpr(NESTED);
      param.span = this.span(start);
    }
    return param;
  }

  private parseStruct(
    start: number,
    base: { exported: boolean; exportSpan?: Span; doc?: string }
  ): A.StructDecl {
    const kw = this.next();
    const name = this.expectIdent("a struct name");
    const typeParams = this.parseTypeParams();
    const decl: A.StructDecl = {
      kind: "StructDecl",
      ...base,
      keywordSpan: { start: kw.start, end: kw.end },
      name,
      typeParams,
      attrs: [],
      members: [],
      bodySpan: { start: this.lastEnd, end: this.lastEnd },
      span: { start, end: this.lastEnd }
    };
    if (this.is("(")) decl.params = this.parseParams();
    decl.attrs = this.parseAttrsUntil(["{"]);
    if (this.is("{")) {
      const open = this.next();
      decl.members = this.parseMembers("struct");
      const close = this.expect("}", "'}' to close the struct");
      decl.bodySpan = { start: open.start, end: close ? close.end : this.lastEnd };
    } else {
      this.errorHere(`Expected '{' to start the struct body but found ${this.describe(this.tok)}.`);
    }
    decl.span = this.span(start);
    return decl;
  }

  private parseEnum(
    start: number,
    base: { exported: boolean; exportSpan?: Span; doc?: string }
  ): A.EnumDecl {
    const kw = this.next();
    const name = this.expectIdent("an enum name");
    const decl: A.EnumDecl = {
      kind: "EnumDecl",
      ...base,
      keywordSpan: { start: kw.start, end: kw.end },
      name,
      attrs: [],
      members: [],
      bodySpan: { start: this.lastEnd, end: this.lastEnd },
      span: { start, end: this.lastEnd }
    };
    if (this.eat(":")) {
      if (this.tok.kind === "ident") decl.storage = this.parseTypeRef();
      else this.errorHere("Expected a storage type after ':'.");
    }
    decl.attrs = this.parseAttrsUntil(["{"]);
    if (this.is("{")) {
      const open = this.next();
      while (!this.is("}") && !this.is("eof")) {
        if (this.eat(",") || this.eat(";")) continue;
        if (this.tok.kind !== "ident") {
          this.errorHere(`Expected an enum member name but found ${this.describe(this.tok)}.`);
          this.skipLine(["}", ","]);
          continue;
        }
        const ms = this.tok.start;
        const doc = this.docFor(this.tok);
        const mname = this.ident(this.next());
        const m: A.EnumMember = { kind: "EnumMember", name: mname, span: mname.span };
        if (doc) m.doc = doc;
        if (this.eat("=")) m.value = this.parseExpr(NESTED);
        m.span = this.span(ms);
        decl.members.push(m);
        if (!this.is(",") && !this.is(";") && !this.is("}") && !this.tok.newlineBefore) {
          this.errorHere(
            `Expected ',' or a new line after an enum member but found ${this.describe(this.tok)}.`
          );
          this.skipLine(["}", ","]);
        }
      }
      const close = this.expect("}", "'}' to close the enum");
      decl.bodySpan = { start: open.start, end: close ? close.end : this.lastEnd };
    } else {
      this.errorHere(`Expected '{' to start the enum body but found ${this.describe(this.tok)}.`);
    }
    decl.span = this.span(start);
    return decl;
  }

  private parseUnion(
    start: number,
    base: { exported: boolean; exportSpan?: Span; doc?: string }
  ): A.UnionDecl {
    const kw = this.next();
    const name = this.expectIdent("a union name");
    const typeParams = this.parseTypeParams();
    const decl: A.UnionDecl = {
      kind: "UnionDecl",
      ...base,
      keywordSpan: { start: kw.start, end: kw.end },
      name,
      typeParams,
      attrs: [],
      variants: [],
      bodySpan: { start: this.lastEnd, end: this.lastEnd },
      span: { start, end: this.lastEnd }
    };
    if (this.is("(")) decl.params = this.parseParams();
    decl.attrs = this.parseAttrsUntil(["{"]);
    if (this.is("{")) {
      const open = this.next();
      while (!this.is("}") && !this.is("eof")) {
        if (this.eat(",") || this.eat(";") || this.eat("|")) continue;
        if (this.tok.kind !== "ident") {
          this.errorHere(`Expected a variant type but found ${this.describe(this.tok)}.`);
          this.skipLine(["}"]);
          continue;
        }
        decl.variants.push(this.parseTypeRef());
      }
      const close = this.expect("}", "'}' to close the union");
      decl.bodySpan = { start: open.start, end: close ? close.end : this.lastEnd };
    } else {
      this.errorHere(`Expected '{' to start the union body but found ${this.describe(this.tok)}.`);
    }
    decl.span = this.span(start);
    return decl;
  }

  private parseAlias(
    start: number,
    base: { exported: boolean; exportSpan?: Span; doc?: string }
  ): A.TypeAliasDecl {
    const kw = this.next();
    const name = this.expectIdent("a type name");
    const typeParams = this.parseTypeParams();
    const decl: A.TypeAliasDecl = {
      kind: "TypeAliasDecl",
      ...base,
      keywordSpan: { start: kw.start, end: kw.end },
      name,
      typeParams,
      span: { start, end: this.lastEnd }
    };
    if (this.is("(")) decl.params = this.parseParams();
    if (this.expect("=", "'=' after the type name")) {
      if (this.tok.kind === "ident" && this.sameLine()) {
        const s = this.tok.start;
        const type = this.parseTypeRef();
        const arrays = this.parseArraySuffixes(false);
        const clauses: A.FieldClauses = { spans: {} };
        const attrs: A.Attribute[] = [];
        this.parseClausesAndAttrs(clauses, attrs, true);
        decl.body = { kind: "TypeSpec", type, arrays, clauses, attrs, span: this.span(s) };
      } else {
        this.errorHere(`Expected a type after '=' but found ${this.describe(this.tok)}.`);
      }
    }
    decl.span = this.span(start);
    return decl;
  }

  private parseExtern(
    start: number,
    base: { exported: boolean; exportSpan?: Span; doc?: string }
  ): A.Decl | undefined {
    const kw = this.next();
    const keywordSpan = { start: kw.start, end: kw.end };
    let asyncSpan: Span | undefined;
    if (this.isWord("async")) {
      const t = this.next();
      asyncSpan = { start: t.start, end: t.end };
    }
    if (this.isWord("fn")) {
      this.next();
      if (asyncSpan) this.error(asyncSpan, "Only codecs can be async.");
      const name = this.expectIdent("a function name");
      const params = this.is("(")
        ? this.parseParams()
        : (this.errorHere("Expected '(' after the function name."), []);
      const decl: A.ExternFnDecl = {
        kind: "ExternFnDecl",
        ...base,
        keywordSpan,
        name,
        params,
        returnArrays: [],
        span: this.span(start)
      };
      if (this.eat("->")) {
        if (this.tok.kind === "ident") {
          decl.returns = this.parseTypeRef();
          decl.returnArrays = this.parseArraySuffixes(false);
        } else this.errorHere("Expected a return type after '->'.");
      } else this.errorHere("Expected '-> type' after the parameters.");
      decl.span = this.span(start);
      return decl;
    }
    if (this.isWord("codec")) {
      this.next();
      const name = this.expectIdent("a codec name");
      const params = this.is("(") && this.sameLine() ? this.parseParams() : [];
      const attrs = this.parseTrailingAttrs();
      const decl: A.ExternCodecDecl = {
        kind: "ExternCodecDecl",
        ...base,
        keywordSpan,
        name,
        async: !!asyncSpan,
        params,
        attrs,
        span: this.span(start)
      };
      if (asyncSpan) decl.asyncSpan = asyncSpan;
      return decl;
    }
    if (this.isWord("type")) {
      this.next();
      if (asyncSpan) this.error(asyncSpan, "Only codecs can be async.");
      const name = this.expectIdent("a type name");
      const params = this.is("(") && this.sameLine() ? this.parseParams() : [];
      const decl: A.ExternTypeDecl = {
        kind: "ExternTypeDecl",
        ...base,
        keywordSpan,
        name,
        params,
        attrs: [],
        span: this.span(start)
      };
      if (this.eat(":")) {
        if (this.tok.kind === "ident") decl.valueType = this.parseTypeRef();
        else this.errorHere("Expected a value type after ':'.");
      } else this.errorHere("Expected ': type' (the value type) after the extern type name.");
      decl.attrs = this.parseTrailingAttrs();
      decl.span = this.span(start);
      return decl;
    }
    this.errorHere(
      `Expected 'fn', 'codec' or 'type' after 'extern' but found ${this.describe(this.tok)}.`
    );
    return undefined;
  }

  private parseConst(
    start: number,
    base: { exported: boolean; exportSpan?: Span; doc?: string }
  ): A.ConstDecl {
    const kw = this.next();
    const decl: A.ConstDecl = {
      kind: "ConstDecl",
      ...base,
      keywordSpan: { start: kw.start, end: kw.end },
      name: this.missingIdent(),
      arrays: [],
      span: { start, end: kw.end }
    };
    if (this.tok.kind === "ident" && this.peek().kind === "=") {
      // `const NAME = value` (type inferred)
      decl.name = this.ident(this.next());
    } else {
      if (this.tok.kind === "ident") decl.type = this.parseTypeRef();
      else this.errorHere("Expected a constant type.");
      decl.name = this.expectIdent("a constant name");
      decl.arrays = this.parseArraySuffixes(false);
    }
    if (this.expect("=", "'=' and the constant's value")) decl.value = this.parseExpr(TOP);
    decl.span = this.span(start);
    return decl;
  }

  /** Attributes up to (not including) one of `stop`, possibly spanning lines. */
  private parseAttrsUntil(stop: TokenKind[]): A.Attribute[] {
    const out: A.Attribute[] = [];
    while (this.is("attr")) {
      out.push(this.parseAttribute());
      if (stop.includes(this.tok.kind)) break;
    }
    return out;
  }

  /** Attributes on the same line (or `@` continuation lines). */
  private parseTrailingAttrs(): A.Attribute[] {
    const out: A.Attribute[] = [];
    while (this.is("attr")) out.push(this.parseAttribute());
    return out;
  }

  private parseAttribute(): A.Attribute {
    const t = this.next();
    const attr: A.Attribute = {
      kind: "Attribute",
      name: { kind: "Ident", name: t.value, span: { start: t.start, end: t.end } },
      span: { start: t.start, end: t.end }
    };
    if (this.is("(") && this.sameLine()) {
      const open = this.tok.start;
      attr.args = this.parseArgs();
      attr.argsSpan = this.span(open);
      attr.span = this.span(t.start);
    }
    return attr;
  }

  private parseArgs(): A.Arg[] {
    const out: A.Arg[] = [];
    this.expect("(");
    while (!this.is(")") && !this.is("eof")) {
      if (this.eat(",")) continue;
      if (this.is("}") || this.is("{") || this.is(";")) break;
      const s = this.tok.start;
      const before = this.p;
      let name: A.Ident | undefined;
      if (this.tok.kind === "ident" && this.peek().kind === ":") {
        name = this.ident(this.next());
        this.next();
      }
      const value = this.parseExpr(NESTED);
      const arg: A.Arg = { kind: "Arg", value, span: this.span(s) };
      if (name) arg.name = name;
      out.push(arg);
      if (this.p === before) this.next();
      if (!this.is(",") && !this.is(")")) {
        this.errorHere(`Expected ',' or ')' but found ${this.describe(this.tok)}.`);
        while (!this.is(",") && !this.is(")") && !this.is("eof") && !this.is("}") && !this.is("{"))
          this.next();
      }
    }
    this.expect(")");
    return out;
  }

  // ── types ────────────────────────────────────────────────────────────────

  parseTypeRef(): A.TypeRef {
    const start = this.tok.start;
    const name: A.Ident[] = [];
    if (this.tok.kind === "ident") name.push(this.ident(this.next()));
    else name.push(this.missingIdent());
    while (this.is(".") && this.peek().kind === "ident" && this.sameLine()) {
      this.next();
      name.push(this.ident(this.next()));
    }
    const ref: A.TypeRef = { kind: "TypeRef", name, span: this.span(start) };
    if (this.is("<") && this.sameLine()) {
      this.next();
      const typeArgs: A.TypeArg[] = [];
      while (!this.is(">") && !this.is(">>") && !this.is(">=") && !this.is("eof")) {
        if (this.eat(",")) continue;
        if (this.tok.kind !== "ident") {
          this.errorHere(`Expected a type argument but found ${this.describe(this.tok)}.`);
          break;
        }
        const s = this.tok.start;
        const type = this.parseTypeRef();
        const arrays = this.parseArraySuffixes(false);
        typeArgs.push({ kind: "TypeArg", type, arrays, span: this.span(s) });
        if (!this.is(",")) break;
      }
      this.splitShift();
      this.expect(">", "'>' to close the type arguments");
      ref.typeArgs = typeArgs;
    }
    if (this.is("(") && this.sameLine()) {
      const open = this.tok.start;
      ref.args = this.parseArgs();
      ref.argsSpan = this.span(open);
    }
    ref.span = this.span(start);
    return ref;
  }

  private parseArraySuffixes(allowNewline: boolean): A.ArraySuffix[] {
    const out: A.ArraySuffix[] = [];
    while (this.is("[") && (allowNewline || this.sameLine())) out.push(this.parseArraySuffix());
    return out;
  }

  private parseArraySuffix(): A.ArraySuffix {
    const open = this.next();
    if (this.is("]")) {
      this.next();
      return { kind: "ArraySuffix", mode: "rest", span: this.span(open.start) };
    }
    if (this.isWord("until") || this.isWord("before")) {
      const mode = this.next().value as "until" | "before";
      const expr = this.parseExpr(NESTED);
      this.expect("]");
      return { kind: "ArraySuffix", mode, expr, span: this.span(open.start) };
    }
    const expr = this.parseExpr(NESTED);
    if (!this.expect("]")) {
      while (!this.is("]") && !this.is("eof") && !this.tok.newlineBefore && !this.is("}"))
        this.next();
      this.eat("]");
    }
    return { kind: "ArraySuffix", mode: "count", expr, span: this.span(open.start) };
  }

  // ── members ──────────────────────────────────────────────────────────────

  private atMembersEnd(context: "struct" | "case"): boolean {
    if (this.is("}") || this.is("eof")) return true;
    if (context === "case" && (this.isWord("case") || this.isWord("default"))) return true;
    return false;
  }

  private parseMembers(context: "struct" | "case"): A.Member[] {
    const members: A.Member[] = [];
    while (!this.atMembersEnd(context)) {
      if (this.eat(";") || this.eat(",")) continue;
      const before = this.p;
      const m = this.parseMember(members, context);
      if (m) {
        if (Array.isArray(m)) members.push(...m);
        else members.push(m);
      }
      if (this.p === before) {
        if (this.tok.kind !== "error") this.errorHere(`Unexpected ${this.describe(this.tok)}.`);
        this.next();
        this.skipLine(["}", ";"]);
      } else if (
        !this.atMembersEnd(context) &&
        !this.tok.newlineBefore &&
        m &&
        !Array.isArray(m) &&
        m.kind === "FieldDecl" &&
        !this.is(";") &&
        !this.is(",") &&
        this.tok.kind !== "ident" &&
        !this.is("{") &&
        !this.is("attr")
      ) {
        // garbage after a field on the same line
        this.errorHere(`Unexpected ${this.describe(this.tok)} after the field.`);
        this.skipLine(["}", ";"]);
      }
    }
    return members;
  }

  private parseMember(
    prev: A.Member[],
    context: "struct" | "case"
  ): A.Member | A.Member[] | undefined {
    const t = this.tok;
    const doc = this.docFor(t);
    if (t.kind === "attr") {
      const start = t.start;
      const attrs = this.parsePrefixAttrs();
      return this.parseAfterPrefixAttrs(start, attrs, doc);
    }
    if (t.kind === "{") return this.parseBlock(t.start, []);
    if (t.kind === "=") {
      const last = prev[prev.length - 1];
      this.error(
        { start: t.start, end: t.end },
        last && last.kind === "FieldDecl"
          ? "A '=' line must follow its field directly."
          : "Expected a field before '='."
      );
      this.skipLine(["}", ";"]);
      return undefined;
    }
    if (t.kind === "ident") {
      switch (t.value) {
        case "struct":
        case "enum":
        case "union": {
          const n1 = this.peek(1);
          const n2 = this.peek(2);
          const isDecl =
            n1.kind === "ident" &&
            (n2.kind === "{" ||
              n2.kind === "<" ||
              n2.kind === "(" ||
              n2.kind === "attr" ||
              (t.value === "enum" && n2.kind === ":") ||
              n2.newlineBefore);
          if (isDecl) {
            const base = { exported: false, ...(doc ? { doc } : {}) };
            if (t.value === "struct") return this.parseStruct(t.start, base);
            if (t.value === "enum") return this.parseEnum(t.start, base);
            return this.parseUnion(t.start, base);
          }
          if (n1.kind === "ident") {
            // C style `struct Foo name` used as a field type
            this.next();
            return this.parseFields(t.start, [], doc);
          }
          break;
        }
        case "if":
          if (this.peek().kind === "(" || this.peek().kind !== "ident")
            return this.parseIf(t.start, []);
          break;
        case "switch":
          if (this.peek().kind === "(" || this.peek().kind === "{")
            return this.parseSwitch(t.start, []);
          break;
        case "virtual":
          if (this.peek().kind === "ident" && !this.peek().newlineBefore) {
            // `virtual u40 size = (hi << 32) | lo`: no bytes, the parts are derived
            const kw = this.next();
            const fields = this.parseFields(this.tok.start, [], doc);
            for (const f of fields) f.virtual = { start: kw.start, end: kw.end };
            if (fields[0]) fields[0].span = { start: t.start, end: fields[0].span.end };
            return fields;
          }
          break;
        case "layout":
          if (this.peek().kind === "{") return this.parseLayout(t.start);
          break;
        case "bits":
          if (
            this.peek().kind === "ident" &&
            (this.peek(2).kind === "{" || this.peek(2).kind === "attr")
          )
            return this.parseBits(t.start, []);
          break;
        case "case":
        case "default":
          if (context !== "case") {
            this.error({ start: t.start, end: t.end }, `'${t.value}' outside a switch.`);
            this.next();
            this.eat(":");
            return undefined;
          }
          return undefined;
        case "else":
          this.error({ start: t.start, end: t.end }, "'else' without a matching 'if'.");
          this.next();
          if (this.is("{")) this.skipBalanced();
          return undefined;
        case "import":
        case "extern":
        case "const":
        case "export":
          this.error(
            { start: t.start, end: t.end },
            `'${t.value}' declarations are only allowed at the top level.`
          );
          this.skipLine(["}"]);
          return undefined;
        default:
          if (CLAUSE_WORDS.has(t.value)) {
            const last = prev[prev.length - 1];
            if (last && last.kind === "FieldDecl") {
              // continuation should have been consumed by the field; this happens after a comment line etc.
              this.parseClausesAndAttrs(last.clauses, last.attrs, false);
              last.span = { start: last.span.start, end: this.lastEnd };
              return undefined;
            }
          }
      }
      return this.parseFields(t.start, [], doc);
    }
    return undefined;
  }

  /** Prefix attributes before a block, `if`, `switch` or `bits`; may span lines. */
  private parsePrefixAttrs(): A.Attribute[] {
    const out: A.Attribute[] = [];
    while (this.is("attr")) out.push(this.parseAttribute());
    return out;
  }

  private parseAfterPrefixAttrs(
    start: number,
    attrs: A.Attribute[],
    doc: string | undefined
  ): A.Member | A.Member[] | undefined {
    const t = this.tok;
    if (t.kind === "{") return this.parseBlock(start, attrs);
    if (this.isWord("if")) return this.parseIf(start, attrs);
    if (this.isWord("switch")) return this.parseSwitch(start, attrs);
    if (this.isWord("bits") && this.peek().kind === "ident") return this.parseBits(start, attrs);
    if (t.kind === "ident" && !this.atMembersEnd("case")) {
      // attributes before a field: accepted with an error (field attributes go after the declaration)
      const span = { start: attrs[0]!.span.start, end: attrs[attrs.length - 1]!.span.end };
      this.diags.report(
        this.file,
        span,
        "invalid-attribute-target",
        "Field attributes go after the field (e.g. `u32 x @align(4)`); prefix attributes are for blocks."
      );
      return this.parseFields(t.start, attrs, doc);
    }
    this.errorHere(
      `Expected '{', 'if', 'switch' or 'bits' after block attributes but found ${this.describe(t)}.`
    );
    return undefined;
  }

  private parseBlock(start: number, attrs: A.Attribute[]): A.BlockMember {
    const open = this.next();
    const members = this.parseMembers("struct");
    const close = this.expect("}", "'}' to close the block");
    return {
      kind: "BlockMember",
      attrs,
      members,
      bodySpan: { start: open.start, end: close ? close.end : this.lastEnd },
      span: this.span(start)
    };
  }

  /** `{ members }` or a single member, for if/else branches and case bodies. */
  private parseBranch(): { members: A.Member[]; span: Span } {
    if (this.is("{")) {
      const open = this.next();
      const members = this.parseMembers("struct");
      const close = this.expect("}", "'}' to close the block");
      return { members, span: { start: open.start, end: close ? close.end : this.lastEnd } };
    }
    const s = this.tok.start;
    if (this.atMembersEnd("struct")) {
      this.errorHere(`Expected '{' but found ${this.describe(this.tok)}.`);
      return { members: [], span: { start: this.lastEnd, end: this.lastEnd } };
    }
    const m = this.parseMember([], "struct");
    const members = m ? (Array.isArray(m) ? m : [m]) : [];
    return { members, span: this.span(s) };
  }

  private parseIf(start: number, attrs: A.Attribute[]): A.IfMember {
    this.next(); // if
    const node: A.IfMember = {
      kind: "IfMember",
      attrs,
      then: [],
      thenSpan: { start: this.lastEnd, end: this.lastEnd },
      elseIf: false,
      span: { start, end: this.lastEnd }
    };
    if (this.expect("(", "'(' after 'if'")) {
      node.condition = this.parseExpr(NESTED);
      if (!this.expect(")")) {
        while (!this.is(")") && !this.is("{") && !this.is("eof") && !this.tok.newlineBefore)
          this.next();
        this.eat(")");
      }
    } else if (!this.is("{")) {
      node.condition = this.parseExpr(TOP);
    }
    const thenB = this.parseBranch();
    node.then = thenB.members;
    node.thenSpan = thenB.span;
    if (this.isWord("else")) {
      const e = this.next();
      node.elseSpan = { start: e.start, end: e.end };
      if (this.isWord("if")) {
        const s = this.tok.start;
        node.else = [this.parseIf(s, [])];
        node.elseIf = true;
      } else {
        node.else = this.parseBranch().members;
      }
    }
    node.span = this.span(start);
    return node;
  }

  private parseSwitch(start: number, attrs: A.Attribute[]): A.SwitchMember {
    this.next(); // switch
    const node: A.SwitchMember = {
      kind: "SwitchMember",
      attrs,
      cases: [],
      bodySpan: { start: this.lastEnd, end: this.lastEnd },
      span: { start, end: this.lastEnd }
    };
    if (this.expect("(", "'(' after 'switch'")) {
      node.discriminant = this.parseExpr(NESTED);
      this.expect(")");
    }
    if (!this.is("{")) {
      this.errorHere(`Expected '{' to start the switch body but found ${this.describe(this.tok)}.`);
      node.span = this.span(start);
      return node;
    }
    const open = this.next();
    while (!this.is("}") && !this.is("eof")) {
      if (this.eat(";") || this.eat(",")) continue;
      const cs = this.tok.start;
      if (this.isWord("case")) {
        this.next();
        const values: A.Expr[] = [];
        while (!this.is(":") && !this.is("eof") && !this.is("}")) {
          const before = this.p;
          values.push(this.parseExpr({ noIn: false, nested: true }));
          if (!this.eat(",")) break;
          if (this.p === before) break;
        }
        if (!this.expect(":", "':' after the case value")) {
          this.skipLine([":", "}"]);
          this.eat(":");
        }
        const members = this.parseMembers("case");
        node.cases.push({
          kind: "SwitchCase",
          values,
          isDefault: false,
          members,
          span: this.span(cs)
        });
      } else if (this.isWord("default")) {
        this.next();
        this.expect(":", "':' after 'default'");
        const members = this.parseMembers("case");
        node.cases.push({
          kind: "SwitchCase",
          values: [],
          isDefault: true,
          members,
          span: this.span(cs)
        });
      } else {
        this.errorHere(`Expected 'case' or 'default' but found ${this.describe(this.tok)}.`);
        const before = this.p;
        // keep the members so the tree stays useful
        const members = this.parseMembers("case");
        if (members.length)
          node.cases.push({
            kind: "SwitchCase",
            values: [],
            isDefault: false,
            members,
            span: this.span(cs)
          });
        if (this.p === before) this.next();
      }
    }
    const close = this.expect("}", "'}' to close the switch");
    node.bodySpan = { start: open.start, end: close ? close.end : this.lastEnd };
    node.span = this.span(start);
    return node;
  }

  private parseBits(start: number, attrs: A.Attribute[]): A.BitsMember {
    this.next(); // bits
    const storage = this.parseTypeRef();
    const node: A.BitsMember = {
      kind: "BitsMember",
      attrs: [...attrs, ...this.parseAttrsUntil(["{"])],
      storage,
      fields: [],
      bodySpan: { start: this.lastEnd, end: this.lastEnd },
      span: { start, end: this.lastEnd }
    };
    if (!this.is("{")) {
      this.errorHere(`Expected '{' to start the bits body but found ${this.describe(this.tok)}.`);
      node.span = this.span(start);
      return node;
    }
    const open = this.next();
    while (!this.is("}") && !this.is("eof")) {
      if (this.eat(";") || this.eat(",")) continue;
      if (this.tok.kind !== "ident") {
        this.errorHere(`Expected a bitfield but found ${this.describe(this.tok)}.`);
        this.skipLine(["}"]);
        continue;
      }
      const before = this.p;
      const fields = this.parseFields(this.tok.start, [], this.docFor(this.tok));
      for (const f of fields) {
        if (f.kind === "FieldDecl") {
          if (!f.bitWidth && f.name)
            this.diags.report(
              this.file,
              f.span,
              "syntax-error",
              "A bitfield needs a width: `T name : bits`."
            );
          node.fields.push(f);
        }
      }
      if (this.p === before) this.next();
    }
    const close = this.expect("}", "'}' to close the bits block");
    node.bodySpan = { start: open.start, end: close ? close.end : this.lastEnd };
    node.span = this.span(start);
    return node;
  }

  private parseLayout(start: number): A.LayoutMember {
    this.next(); // layout
    const open = this.next(); // {
    const items = this.parseLayoutItems();
    const close = this.expect("}", "'}' to close the layout");
    return {
      kind: "LayoutMember",
      items,
      bodySpan: { start: open.start, end: close ? close.end : this.lastEnd },
      span: this.span(start)
    };
  }

  /** Layout items up to (not including) the closing `}`. Items end at `,`, `;`, a line break or the next path. */
  private parseLayoutItems(): A.LayoutItem[] {
    const items: A.LayoutItem[] = [];
    while (!this.is("}") && !this.is("eof")) {
      if (this.eat(",") || this.eat(";")) continue;
      const s = this.tok.start;
      if (this.tok.kind !== "ident") {
        this.errorHere(`Expected a layout path but found ${this.describe(this.tok)}.`);
        this.skipLine(["}", ","]);
        continue;
      }
      let path: A.LayoutSegment[] | "this";
      if (this.isWord("this")) {
        this.next();
        path = "this";
      } else {
        const segs: A.LayoutSegment[] = [];
        const first = this.next();
        segs.push({
          kind: "field",
          name: this.ident(first),
          span: { start: first.start, end: first.end }
        });
        for (;;) {
          if (
            this.is("[") &&
            this.peek().kind === "*" &&
            this.peek(2).kind === "]" &&
            this.sameLine()
          ) {
            const o = this.next();
            this.next();
            this.next();
            segs.push({ kind: "each", span: this.span(o.start) });
          } else if (this.is(".") && this.sameLine()) {
            this.next();
            const n = this.expectIdent("a field name");
            segs.push({ kind: "field", name: n, span: n.span });
            if (!n.name) break;
          } else if (this.is("[") && this.sameLine()) {
            this.errorHere("Layout paths use [*] for array elements.");
            this.skipBalanced();
          } else break;
        }
        path = segs;
      }
      const attrs = this.parseTrailingAttrs();
      const item: A.LayoutItem = { kind: "LayoutItem", path, attrs, span: this.span(s) };
      if (this.is("{") && this.sameLine()) {
        // per-element group: `volumes[*] { pieces[*]  portals[*].points }`
        const g = this.next();
        const inner = this.parseLayoutItems();
        const close = this.expect("}", "'}' to close the layout group");
        item.group = {
          items: inner,
          span: { start: g.start, end: close ? close.end : this.lastEnd }
        };
        item.span = this.span(s);
      }
      items.push(item);
      if (
        !this.is(",") &&
        !this.is(";") &&
        !this.is("}") &&
        !this.tok.newlineBefore &&
        this.tok.kind !== "ident"
      ) {
        this.errorHere(
          `Expected ',' or a new line after a layout item but found ${this.describe(this.tok)}.`
        );
        this.skipLine(["}", ","]);
      }
    }
    return items;
  }

  /** A field declaration, possibly with several comma-separated declarators (`u8 r, g, b`). */
  private parseFields(
    start: number,
    prefixAttrs: A.Attribute[],
    doc: string | undefined
  ): A.FieldDecl[] {
    const type = this.parseTypeRef();
    const typeArrays = this.parseArraySuffixes(false);
    const out: A.FieldDecl[] = [];
    out.push(this.parseDeclarator(start, type, typeArrays, prefixAttrs, doc));
    while (this.is(",") && this.sameLine()) {
      const n1 = this.peek(1);
      const n2 = this.peek(2);
      // `u8 a, u8 b` separates fields; `u8 a, b` declares another one
      const separator =
        n1.kind === "ident" &&
        !n1.newlineBefore &&
        (n2.kind === "ident" ||
          n2.kind === "dollar" ||
          n2.kind === "*" ||
          n2.kind === "<" ||
          n2.kind === "(") &&
        !(n2.kind === "ident" && CLAUSE_WORDS.has(n2.value)) &&
        !n2.newlineBefore;
      if (separator || n1.newlineBefore) break;
      this.next();
      out.push(this.parseDeclarator(this.tok.start, type, typeArrays, [], undefined));
    }
    return out;
  }

  private parseDeclarator(
    start: number,
    type: A.TypeRef,
    typeArrays: A.ArraySuffix[],
    prefixAttrs: A.Attribute[],
    doc: string | undefined
  ): A.FieldDecl {
    const field: A.FieldDecl = {
      kind: "FieldDecl",
      type,
      typeArrays,
      pointer: false,
      bound: false,
      arrays: [],
      clauses: { spans: {} },
      attrs: [...prefixAttrs],
      span: { start, end: this.lastEnd }
    };
    if (doc) field.doc = doc;
    if (this.is("*") && this.sameLine()) {
      const s = this.next();
      field.pointer = true;
      field.starSpan = { start: s.start, end: s.end };
    }
    const t = this.tok;
    if (t.kind === "dollar" && this.sameLine()) {
      field.bound = true;
      field.name = this.dollarIdent(this.next());
    } else if (
      t.kind === "ident" &&
      this.sameLine() &&
      !(
        CLAUSE_WORDS.has(t.value) &&
        this.peek().kind !== "[" &&
        this.peek().kind !== ":" &&
        this.looksLikeClause()
      )
    ) {
      field.name = this.ident(this.next());
    } else if (t.kind === ":" && this.sameLine()) {
      // unnamed bitfield
    } else {
      this.errorHere(`Expected a field name after the type but found ${this.describe(t)}.`);
    }
    field.arrays = this.parseArraySuffixes(false);
    if (this.is(":") && this.sameLine()) {
      this.next();
      if (field.pointer) {
        if (this.tok.kind === "ident") field.storage = this.parseTypeRef();
        else this.errorHere("Expected a pointer storage type after ':' (e.g. `: u64`).");
      } else {
        field.bitWidth = this.parseExpr(TOP);
      }
    }
    this.parseClausesAndAttrs(field.clauses, field.attrs, false);
    field.span = this.span(start);
    return field;
  }

  /** `u32 at …`: is the clause word actually a clause (vs. a field named `at`)? */
  private looksLikeClause(): boolean {
    const n = this.peek();
    // a field name is followed by end of line, `;`, `}`, `[`, `:`, `=`, an attribute or another clause
    if (n.newlineBefore) return false;
    if (n.kind === ";" || n.kind === "}" || n.kind === "eof" || n.kind === "=" || n.kind === "attr")
      return false;
    if (n.kind === "ident" && CLAUSE_WORDS.has(n.value)) return false;
    return true;
  }

  /**
   * Same-line attributes followed by `{` (or `if`/`switch`) prefix a block, not the field before
   * them: `u8 a  @align(4) { … }`. A field is never followed by `{`.
   */
  private attrsPrefixBlock(): boolean {
    let i = this.p;
    for (;;) {
      const t = this.tokens[i]!;
      // attributes on the next line belong to whatever that line starts (`u8 c @align(8)` then
      // `@padUntil(0x10) { … }`: the block's attributes, not this field's)
      if (t.kind !== "attr" || (i > this.p && t.newlineBefore)) break;
      i++;
      if (this.tokens[i]!.kind === "(" && !this.tokens[i]!.newlineBefore) {
        let depth = 0;
        for (; i < this.tokens.length; i++) {
          const k = this.tokens[i]!.kind;
          if (k === "(") depth++;
          else if (k === ")") {
            depth--;
            if (depth === 0) {
              i++;
              break;
            }
          } else if (k === "eof") return false;
        }
      }
    }
    const n = this.tokens[i]!;
    return (
      n.kind === "{" ||
      (n.kind === "ident" && (n.value === "if" || n.value === "switch") && !n.newlineBefore)
    );
  }

  /** Does the line starting at the current token contain a `{` at bracket depth 0? */
  private lineOpensBlock(): boolean {
    let depth = 0;
    for (let i = this.p; i < this.tokens.length; i++) {
      const t = this.tokens[i]!;
      if (i > this.p && t.newlineBefore && depth === 0) return false;
      if (t.kind === "eof") return false;
      if (t.kind === "(" || t.kind === "[") depth++;
      else if (t.kind === ")" || t.kind === "]") depth = Math.max(0, depth - 1);
      else if (t.kind === "{" && depth === 0) return true;
      else if (t.kind === "}" && depth === 0) return false;
    }
    return false;
  }

  private parseClausesAndAttrs(
    clauses: A.FieldClauses,
    attrs: A.Attribute[],
    inAlias: boolean
  ): void {
    for (;;) {
      const t = this.tok;
      if (t.kind === "attr") {
        if (t.newlineBefore ? this.lineOpensBlock() : this.attrsPrefixBlock()) break;
        attrs.push(this.parseAttribute());
        continue;
      }
      const s = t.start;
      if (t.kind === "=") {
        if (t.newlineBefore && inAlias) break;
        this.next();
        const e = this.parseRequiredExpr();
        if (clauses.asRead && !clauses.asWrite) {
          clauses.asWrite = e;
          clauses.spans.as = { start: clauses.spans.as?.start ?? s, end: this.lastEnd };
        } else {
          if (clauses.formula)
            this.error({ start: s, end: this.lastEnd }, "A field can have only one '=' formula.");
          clauses.formula = e;
          clauses.spans.formula = this.span(s);
        }
        continue;
      }
      // `?= expr`: optional input with a default
      if (t.kind === "?" && this.peek().kind === "=" && this.peek().start === t.end) {
        if (t.newlineBefore && inAlias) break;
        this.next();
        this.next();
        const e = this.parseRequiredExpr();
        if (clauses.defaultValue)
          this.error({ start: s, end: this.lastEnd }, "A field can have only one '?=' default.");
        clauses.defaultValue = e;
        clauses.spans.default = this.span(s);
        continue;
      }
      if (t.kind !== "ident" || !CLAUSE_WORDS.has(t.value)) break;
      if (t.newlineBefore && inAlias) break;
      this.next();
      switch (t.value) {
        case "at":
          if (clauses.at) this.error({ start: s, end: t.end }, "Duplicate 'at' clause.");
          clauses.at = this.parseRequiredExpr();
          clauses.spans.at = this.span(s);
          break;
        case "from":
          if (clauses.from) this.error({ start: s, end: t.end }, "Duplicate 'from' clause.");
          clauses.from = this.parseRequiredExpr();
          clauses.spans.from = this.span(s);
          break;
        case "as":
          if (clauses.asRead) this.error({ start: s, end: t.end }, "Duplicate 'as' clause.");
          clauses.asRead = this.parseRequiredExpr();
          clauses.spans.as = this.span(s);
          break;
        case "where":
          if (clauses.where)
            this.error(
              { start: s, end: t.end },
              "Duplicate 'where' clause; combine conditions with &&."
            );
          clauses.where = this.parseRequiredExpr();
          clauses.spans.where = this.span(s);
          break;
        case "in":
          if (this.is("regex")) {
            const r = this.next();
            clauses.regex = {
              kind: "Regex",
              pattern: r.value,
              span: { start: r.start, end: r.end }
            };
          } else if (this.is("(")) {
            const open = this.tok.start;
            clauses.inItems = this.parseInItems();
            clauses.inSpan = this.span(open);
          } else {
            this.errorHere("Expected '(' with values or a /regex/ after 'in'.");
          }
          clauses.spans.in = this.span(s);
          break;
      }
    }
  }

  private parseInItems(): A.InItem[] {
    const items: A.InItem[] = [];
    this.expect("(");
    while (!this.is(")") && !this.is("eof")) {
      if (this.eat(",")) continue;
      if (this.is("}") || this.is("{")) break;
      const before = this.p;
      const s = this.tok.start;
      const low = this.parseExpr(NESTED);
      if (this.eat("..")) {
        const high = this.parseExpr(NESTED);
        items.push({ kind: "InRange", low, high, span: this.span(s) });
      } else {
        items.push({ kind: "InValue", value: low, span: this.span(s) });
      }
      if (this.p === before) this.next();
      if (!this.is(",") && !this.is(")")) {
        this.errorHere(`Expected ',' or ')' but found ${this.describe(this.tok)}.`);
        while (!this.is(",") && !this.is(")") && !this.is("eof") && !this.is("}")) this.next();
      }
    }
    this.expect(")");
    return items;
  }

  // ── expressions ──────────────────────────────────────────────────────────

  /** A required top-level expression: refuses to swallow the next member when the line ends early. */
  private parseRequiredExpr(): A.Expr {
    if (this.tok.newlineBefore && this.looksLikeMemberStart()) {
      this.errorHere("Expected an expression.");
      return { kind: "Error", span: { start: this.lastEnd, end: this.lastEnd } };
    }
    return this.parseExpr(TOP);
  }

  private looksLikeMemberStart(): boolean {
    const t = this.tok;
    if (t.kind === "}" || t.kind === "attr" || t.kind === "{" || t.kind === "eof" || t.kind === ";")
      return true;
    if (t.kind !== "ident") return false;
    if (
      ["if", "switch", "struct", "layout", "bits", "case", "default", "enum", "union"].includes(
        t.value
      )
    )
      return true;
    const n = this.peek();
    if (n.newlineBefore) return false;
    return n.kind === "ident" || n.kind === "dollar" || n.kind === "*";
  }

  parseExpr(flags: ExprFlags): A.Expr {
    return this.parseCond(flags);
  }

  private parseCond(flags: ExprFlags): A.Expr {
    const test = this.parseBinary(0, flags);
    if (this.is("?") && !(this.peek().kind === "=" && this.peek().start === this.tok.end)) {
      this.next();
      const then = this.parseExpr({ noIn: false, nested: true });
      if (!this.expect(":", "':' in the conditional expression")) {
        return {
          kind: "Cond",
          test,
          then,
          else: { kind: "Error", span: { start: this.lastEnd, end: this.lastEnd } },
          span: this.span(test.span.start)
        };
      }
      const els = this.parseCond(flags);
      return {
        kind: "Cond",
        test,
        then,
        else: els,
        span: { start: test.span.start, end: els.span.end }
      };
    }
    return test;
  }

  private parseBinary(minPrec: number, flags: ExprFlags): A.Expr {
    let left = this.parseUnary(flags);
    for (;;) {
      const t = this.tok;
      if (t.kind === "ident" && t.value === "in") {
        if (flags.noIn && !flags.nested) break;
        if (t.newlineBefore && !flags.nested) break;
        if (IN_PREC <= minPrec) break;
        this.next();
        if (this.is("regex")) {
          const r = this.next();
          const regex: A.RegexLit = {
            kind: "Regex",
            pattern: r.value,
            span: { start: r.start, end: r.end }
          };
          left = {
            kind: "RegexMatch",
            value: left,
            regex,
            span: { start: left.span.start, end: r.end }
          };
        } else if (this.is("(")) {
          const items = this.parseInItems();
          left = { kind: "In", value: left, items, span: this.span(left.span.start) };
        } else {
          this.errorHere("Expected '(' with values or a /regex/ after 'in'.");
          left = { kind: "In", value: left, items: [], span: this.span(left.span.start) };
        }
        continue;
      }
      const info = BIN_OPS[t.kind];
      if (!info || info.prec <= minPrec) break;
      this.next();
      const right = this.parseBinary(info.prec, flags);
      left = {
        kind: "Binary",
        op: info.op,
        left,
        right,
        opSpan: { start: t.start, end: t.end },
        span: { start: left.span.start, end: right.span.end }
      };
    }
    return left;
  }

  private parseUnary(flags: ExprFlags): A.Expr {
    const t = this.tok;
    if (t.kind === "-" || t.kind === "!" || t.kind === "~" || t.kind === "+") {
      this.next();
      const operand = this.parseUnary(flags);
      return {
        kind: "Unary",
        op: t.kind,
        operand,
        span: { start: t.start, end: operand.span.end }
      };
    }
    return this.parsePostfix(flags);
  }

  private parsePostfix(flags: ExprFlags): A.Expr {
    let e = this.parsePrimary(flags);
    for (;;) {
      const t = this.tok;
      if (t.newlineBefore && !flags.nested) break;
      if (t.kind === ".") {
        this.next();
        const name =
          this.tok.kind === "ident"
            ? this.ident(this.next())
            : (this.errorHere("Expected a member name after '.'."), this.missingIdent());
        e = {
          kind: "Member",
          object: e,
          name,
          span: { start: e.span.start, end: Math.max(name.span.end, t.end) }
        };
        continue;
      }
      if (t.kind === "[") {
        this.next();
        if (this.is("*") && this.peek().kind === "]") {
          this.next();
          this.next();
          e = { kind: "Each", object: e, span: this.span(e.span.start) };
          continue;
        }
        if (this.is("..")) {
          this.next();
          const end = this.is("]") ? undefined : this.parseExpr(NESTED);
          this.expect("]");
          e = { kind: "Slice", object: e, ...(end ? { end } : {}), span: this.span(e.span.start) };
          continue;
        }
        const index = this.parseExpr(NESTED);
        if (this.eat("..")) {
          const end = this.is("]") ? undefined : this.parseExpr(NESTED);
          this.expect("]");
          e = {
            kind: "Slice",
            object: e,
            start: index,
            ...(end ? { end } : {}),
            span: this.span(e.span.start)
          };
          continue;
        }
        this.expect("]");
        e = { kind: "Index", object: e, index, span: this.span(e.span.start) };
        continue;
      }
      if (t.kind === "(") {
        const open = t.start;
        const args = this.parseArgs();
        e = {
          kind: "Call",
          callee: e,
          args,
          argsSpan: this.span(open),
          span: this.span(e.span.start)
        };
        continue;
      }
      break;
    }
    return e;
  }

  private parsePrimary(flags: ExprFlags): A.Expr {
    const t = this.tok;
    const span = { start: t.start, end: t.end };
    switch (t.kind) {
      case "int":
        this.next();
        return { kind: "Int", value: BigInt(t.value), raw: t.text, span };
      case "float":
        this.next();
        return { kind: "Float", value: Number(t.value), raw: t.text, span };
      case "string":
        this.next();
        return { kind: "String", value: t.value, span };
      case "hexbytes":
      case "b64bytes":
        this.next();
        return { kind: "Bytes", hex: t.value, raw: t.text, span };
      case "fourcc":
        this.next();
        return { kind: "FourCC", value: t.value, span };
      case "dollar":
        this.next();
        return { kind: "Dollar", name: t.value, span };
      case "(": {
        this.next();
        const inner = this.parseExpr(NESTED);
        this.expect(")");
        return { kind: "Paren", expr: inner, span: this.span(t.start) };
      }
      case "ident": {
        if (this.peek().kind === "=>") {
          this.next();
          this.next();
          const body = this.parseExpr({ noIn: flags.noIn, nested: flags.nested });
          return {
            kind: "Lambda",
            param: this.ident(t),
            body,
            span: { start: t.start, end: body.span.end }
          };
        }
        this.next();
        switch (t.value) {
          case "true":
            return { kind: "Bool", value: true, span };
          case "false":
            return { kind: "Bool", value: false, span };
          case "it":
            return { kind: "It", span };
          case "le":
          case "be":
            return { kind: "Endian", value: t.value, span };
          default:
            return { kind: "Name", name: t.value, span };
        }
      }
      default: {
        this.errorHere(`Expected an expression but found ${this.describe(t)}.`);
        const structural: TokenKind[] = [")", "]", "}", ",", ";", ":", "eof", "{", "attr"];
        if (!structural.includes(t.kind) && !t.newlineBefore) {
          this.next();
          return { kind: "Error", span };
        }
        return { kind: "Error", span: { start: this.lastEnd, end: this.lastEnd } };
      }
    }
  }
}

function cleanDoc(text: string): string {
  if (text.startsWith("///")) return text.slice(3).trim();
  return text
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split(/\r?\n/)
    .map(l => l.replace(/^\s*\*\s?/, "").trimEnd())
    .join("\n")
    .trim();
}
