/**
 * A post-pass that makes generated Go code gofmt-stable where emitting it right by construction
 * is impractical:
 *
 *  - spacing around binary operators, which go/printer decides from the expression's nesting
 *    depth and the mix of precedences (`(a + b) * c` vs `f(a+b, c)`);
 *  - one-line function literals that go/printer would break over several lines (header + body
 *    longer than 100 columns).
 *
 * It parses the subset of Go the backend emits (expressions, simple statements, control flow,
 * function literals, composite literals) and only rewrites whitespace. A function it can't parse
 * is left as it is.
 */

type Tok = {
  k: "id" | "kw" | "num" | "str" | "char" | "op" | "nl";
  t: string;
  s: number;
  e: number;
  line: number;
};

const KEYWORDS = new Set(
  "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var".split(
    " "
  )
);

/** Operators and punctuation, longest first. */
const OPS = (
  "<<= >>= &^= ... && || <- ++ -- == != <= >= := += -= *= /= %= &= |= ^= << >> &^ " +
  "+ - * / % & | ^ < > = ! ( ) { } [ ] , ; : . ~"
).split(" ");

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "\n") {
      out.push({ k: "nl", t: "\n", s: i, e: i + 1, line });
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const j = src.indexOf("*/", i + 2);
      const end = j < 0 ? n : j + 2;
      for (let k = i; k < end; k++) if (src[k] === "\n") line++;
      i = end;
      continue;
    }
    const s = i;
    if (/[A-Za-z_]/.test(c)) {
      while (i < n && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      const t = src.slice(s, i);
      out.push({ k: KEYWORDS.has(t) ? "kw" : "id", t, s, e: i, line });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      while (i < n && /[0-9A-Za-z_.]/.test(src[i]!)) {
        if (
          (src[i] === "e" || src[i] === "E" || src[i] === "p" || src[i] === "P") &&
          (src[i + 1] === "+" || src[i + 1] === "-") &&
          !/^0[xX]/.test(src.slice(s, i + 1))
        )
          i += 2;
        else if ((src[i] === "p" || src[i] === "P") && (src[i + 1] === "+" || src[i + 1] === "-"))
          i += 2;
        else i++;
      }
      out.push({ k: "num", t: src.slice(s, i), s, e: i, line });
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      out.push({ k: "str", t: src.slice(s, i), s, e: i, line });
      continue;
    }
    if (c === "`") {
      const j = src.indexOf("`", i + 1);
      const end = j < 0 ? n : j + 1;
      for (let k = i; k < end; k++) if (src[k] === "\n") line++;
      out.push({ k: "str", t: src.slice(s, end), s, e: end, line });
      i = end;
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n && src[i] !== "'") {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      out.push({ k: "char", t: src.slice(s, i), s, e: i, line });
      continue;
    }
    const op = OPS.find(o => src.startsWith(o, i));
    if (!op) throw new Error(`gofmt: unexpected character ${c}`);
    out.push({ k: "op", t: op, s, e: i + op.length, line });
    i += op.length;
  }
  return out;
}

// ── AST ─────────────────────────────────────────────────────────────────────

type Node =
  | { kind: "leaf"; s: number; e: number }
  | {
      kind: "binary";
      op: string;
      opTok: Tok;
      x: Node;
      y: Node;
      s: number;
      e: number;
      blank?: boolean;
    }
  | { kind: "paren"; x: Node; s: number; e: number }
  | { kind: "call"; fun: Node; args: Node[]; s: number; e: number }
  | { kind: "index"; x: Node; idx: Node[]; s: number; e: number }
  | { kind: "slice"; x: Node; parts: (Node | null)[]; s: number; e: number }
  | { kind: "sel"; x: Node; s: number; e: number }
  | { kind: "unary"; op: string; x: Node; s: number; e: number }
  | { kind: "star"; x: Node; s: number; e: number }
  | { kind: "assert"; x: Node; s: number; e: number }
  | {
      kind: "func";
      head: [number, number];
      lbrace: Tok;
      rbrace: Tok;
      body: Stmt[];
      s: number;
      e: number;
      expand?: boolean;
    }
  | { kind: "composite"; type: Node | null; elts: Node[]; s: number; e: number }
  | { kind: "kv"; key: Node; value: Node; s: number; e: number }
  | { kind: "type"; s: number; e: number };

type Stmt = { exprs: [Node, number][]; blocks: Stmt[][]; s: number; e: number; lineSpan: boolean };

/** Binary operator precedences (the Go spec's). */
const PREC: Record<string, number> = Object.fromEntries(
  ["||", "&&", "== != < <= > >=", "+ - | ^", "* / % << >> & &^"].flatMap((ops, i) =>
    ops.split(" ").map(op => [op, i + 1])
  )
);

const ASSIGN = new Set("= := += -= *= /= %= &= |= ^= <<= >>= &^=".split(" "));

class Parser {
  i = 0;
  exprLev = 0;
  readonly toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  peek(o = 0): Tok | undefined {
    return this.toks[this.i + o];
  }
  is(t: string): boolean {
    const p = this.peek();
    return p !== undefined && (p.k === "op" || p.k === "kw") && p.t === t;
  }
  next(): Tok {
    const t = this.toks[this.i++];
    if (!t) throw new Error("gofmt: unexpected end");
    return t;
  }
  expect(t: string): Tok {
    const x = this.next();
    if (x.t !== t) throw new Error(`gofmt: expected ${t}, got ${x.t}`);
    return x;
  }
  /** Inside parens/brackets/braces of expressions newlines are not separators. */
  skipNl(): void {
    while (this.peek()?.k === "nl") this.i++;
  }
  /** Skips from an opening token to its matching closing one. */
  skipBalanced(open: string, close: string): void {
    this.expect(open);
    for (let depth = 1; depth > 0;) {
      const x = this.next();
      if (x.t === open) depth++;
      else if (x.t === close) depth--;
    }
  }

  // ── types (skipped as opaque spans) ──
  parseType(): Node {
    const s = this.peek()!.s;
    this.skipType();
    return { kind: "type", s, e: this.toks[this.i - 1]!.e };
  }
  skipType(): void {
    const t = this.peek();
    if (!t) return;
    switch (t.t) {
      case "*":
      case "chan":
        this.next();
        this.skipType();
        return;
      case "[":
      case "map":
        if (t.t === "map") this.next();
        this.skipBalanced("[", "]");
        this.skipType();
        return;
      case "func":
        this.next();
        this.skipBalanced("(", ")");
        this.skipResult();
        return;
      case "struct":
      case "interface":
        this.next();
        this.skipBalanced("{", "}");
        return;
      case "(":
        this.skipBalanced("(", ")");
        return;
    }
    this.next(); // ident
    while (this.is(".")) {
      this.next();
      this.next();
    }
    if (this.is("[")) this.skipBalanced("[", "]");
  }
  /** A function result: nothing, a type, or a parenthesized list (stops before `{`). */
  skipResult(): void {
    const t = this.peek();
    if (
      !t ||
      t.t === "{" ||
      t.k === "nl" ||
      t.t === ")" ||
      t.t === "," ||
      t.t === "]" ||
      t.t === "}"
    )
      return;
    if (t.t === "(") {
      this.skipBalanced("(", ")");
      return;
    }
    this.skipType();
  }

  // ── expressions ──
  parseExpr(): Node {
    return this.parseBinary(1);
  }
  parseBinary(prec1: number): Node {
    let x = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (!t || t.k !== "op") return x;
      const p = PREC[t.t];
      if (p === undefined || p < prec1) return x;
      this.next();
      this.skipNl();
      const y = this.parseBinary(p + 1);
      x = { kind: "binary", op: t.t, opTok: t, x, y, s: x.s, e: y.e };
    }
  }
  parseUnary(): Node {
    const t = this.peek()!;
    if (
      t.k === "op" &&
      (t.t === "+" || t.t === "-" || t.t === "!" || t.t === "^" || t.t === "&" || t.t === "<-")
    ) {
      this.next();
      const x = this.parseUnary();
      return { kind: "unary", op: t.t, x, s: t.s, e: x.e };
    }
    if (t.k === "op" && t.t === "*") {
      this.next();
      const x = this.parseUnary();
      return { kind: "star", x, s: t.s, e: x.e };
    }
    if (t.k === "kw" && t.t === "range") {
      this.next();
      const x = this.parseExpr();
      return { kind: "unary", op: "range", x, s: t.s, e: x.e };
    }
    return this.parsePrimary();
  }
  parseOperand(): Node {
    const t = this.peek()!;
    if (t.k === "id" || t.k === "num" || t.k === "str" || t.k === "char") {
      this.next();
      return { kind: "leaf", s: t.s, e: t.e };
    }
    if (t.t === "(") {
      this.next();
      this.exprLev++;
      this.skipNl();
      const x = this.parseExprOrType();
      this.skipNl();
      const r = this.expect(")");
      this.exprLev--;
      return { kind: "paren", x, s: t.s, e: r.e };
    }
    if (t.t === "func") {
      this.next();
      this.skipBalanced("(", ")");
      this.skipResult();
      const headEnd = this.toks[this.i - 1]!.e;
      if (!this.is("{")) return { kind: "type", s: t.s, e: headEnd };
      const lbrace = this.next();
      const saveLev = this.exprLev;
      this.exprLev = 0;
      const body = this.parseStmtList();
      this.exprLev = saveLev;
      const rbrace = this.expect("}");
      return { kind: "func", head: [t.s, headEnd], lbrace, rbrace, body, s: t.s, e: rbrace.e };
    }
    if (t.t === "[" || t.t === "map" || t.t === "struct" || t.t === "interface" || t.t === "chan") {
      return this.parseType();
    }
    throw new Error(`gofmt: unexpected ${t.t}`);
  }
  parseExprOrType(): Node {
    const t = this.peek()!;
    if (t.t === "[" || t.t === "map" || t.t === "chan")
      return this.parsePrimaryFrom(this.parseType());
    return this.parseExpr();
  }
  isLiteralType(x: Node): boolean {
    return x.kind === "leaf" || x.kind === "sel" || x.kind === "type" || x.kind === "index";
  }
  parsePrimary(): Node {
    return this.parsePrimaryFrom(this.parseOperand());
  }
  parsePrimaryFrom(x: Node): Node {
    for (;;) {
      const t = this.peek();
      if (!t || t.k !== "op") return x;
      if (t.t === ".") {
        this.next();
        if (this.is("(")) {
          this.next();
          this.skipType();
          const r = this.expect(")");
          x = { kind: "assert", x, s: x.s, e: r.e };
        } else {
          const id = this.next();
          x = { kind: "sel", x, s: x.s, e: id.e };
        }
      } else if (t.t === "[") {
        this.next();
        this.exprLev++;
        const parts: (Node | null)[] = [];
        let isSlice = false;
        const idx: Node[] = [];
        if (this.is(":")) parts.push(null);
        else {
          const first = this.parseExprOrType();
          parts.push(first);
          idx.push(first);
        }
        while (this.is(":") || this.is(",")) {
          const sep = this.next();
          if (sep.t === ":") {
            isSlice = true;
            if (this.is("]") || this.is(":")) parts.push(null);
            else parts.push(this.parseExpr());
          } else {
            const n = this.parseExprOrType();
            idx.push(n);
          }
        }
        this.exprLev--;
        const r = this.expect("]");
        x = isSlice
          ? { kind: "slice", x, parts, s: x.s, e: r.e }
          : { kind: "index", x, idx, s: x.s, e: r.e };
      } else if (t.t === "(") {
        this.next();
        this.exprLev++;
        const args: Node[] = [];
        this.skipNl();
        while (!this.is(")")) {
          args.push(this.parseExprOrType());
          if (this.is("...")) this.next();
          this.skipNl();
          if (this.is(",")) {
            this.next();
            this.skipNl();
          }
        }
        this.exprLev--;
        const r = this.expect(")");
        x = { kind: "call", fun: x, args, s: x.s, e: r.e };
      } else if (
        t.t === "{" &&
        this.isLiteralType(x) &&
        (this.exprLev >= 0 || (x.kind !== "leaf" && x.kind !== "sel"))
      ) {
        x = this.parseComposite(x);
      } else return x;
    }
  }
  parseComposite(type: Node | null): Node {
    const l = this.expect("{");
    this.exprLev++;
    const elts: Node[] = [];
    this.skipNl();
    while (!this.is("}")) {
      let v: Node = this.is("{") ? this.parseComposite(null) : this.parseExprOrType();
      if (this.is(":")) {
        this.next();
        this.skipNl();
        const val = this.is("{") ? this.parseComposite(null) : this.parseExprOrType();
        v = { kind: "kv", key: v, value: val, s: v.s, e: val.e };
      }
      elts.push(v);
      this.skipNl();
      if (this.is(",")) {
        this.next();
        this.skipNl();
      }
    }
    this.exprLev--;
    const r = this.expect("}");
    return { kind: "composite", type, elts, s: type ? type.s : l.s, e: r.e };
  }

  // ── statements ──
  parseStmtList(): Stmt[] {
    const out: Stmt[] = [];
    for (;;) {
      this.skipSep();
      const t = this.peek();
      if (!t || t.t === "}" || (t.k === "kw" && (t.t === "case" || t.t === "default"))) return out;
      out.push(this.parseStmt());
    }
  }
  skipSep(): void {
    while (this.peek() && (this.peek()!.k === "nl" || this.is(";"))) this.i++;
  }
  parseBlock(): Stmt[] {
    this.expect("{");
    const body = this.parseStmtList();
    this.expect("}");
    return body;
  }
  stmt(s: number, exprs: [Node, number][], blocks: Stmt[][] = []): Stmt {
    const last = this.toks[this.i - 1]!;
    const first = this.toks.find(t => t.s === s);
    return { exprs, blocks, s, e: last.e, lineSpan: !!first && first.line !== last.line };
  }
  parseSimple(): [Node, number][] {
    const exprs: Node[] = [this.parseExprOrType()];
    while (this.is(",")) {
      this.next();
      exprs.push(this.parseExprOrType());
    }
    const t = this.peek();
    if (t && t.k === "op" && ASSIGN.has(t.t)) {
      this.next();
      const rhs: Node[] = [this.parseExprOrType()];
      while (this.is(",")) {
        this.next();
        rhs.push(this.parseExprOrType());
      }
      const depth = exprs.length > 1 && rhs.length > 1 ? 2 : 1;
      return [...exprs, ...rhs].map(e => [e, depth] as [Node, number]);
    }
    if (t && t.k === "op" && (t.t === "++" || t.t === "--")) {
      this.next();
      return exprs.map(e => [e, 2] as [Node, number]);
    }
    if (t && t.t === ":" && exprs.length === 1 && exprs[0]!.kind === "leaf") {
      this.next(); // label
      return [];
    }
    return exprs.map(e => [e, 1] as [Node, number]);
  }
  parseStmt(): Stmt {
    const t = this.peek()!;
    const s = t.s;
    if (t.k === "kw") {
      switch (t.t) {
        case "if": {
          this.next();
          const lev = this.exprLev;
          this.exprLev = -1;
          let exprs = this.parseSimple();
          if (this.is(";")) {
            this.next();
            exprs = [...exprs, ...this.parseSimple()];
          }
          this.exprLev = lev;
          const blocks = [this.parseBlock()];
          if (this.is("else")) {
            this.next();
            if (this.is("if")) blocks.push([this.parseStmt()]);
            else blocks.push(this.parseBlock());
          }
          return this.stmt(s, exprs, blocks);
        }
        case "for": {
          this.next();
          const lev = this.exprLev;
          this.exprLev = -1;
          const exprs: [Node, number][] = [];
          if (!this.is("{")) {
            if (!this.is(";")) exprs.push(...this.parseSimple());
            if (this.is(";")) {
              this.next();
              if (!this.is(";")) exprs.push(...this.parseSimple());
              this.expect(";");
              if (!this.is("{")) exprs.push(...this.parseSimple());
            }
          }
          this.exprLev = lev;
          return this.stmt(s, exprs, [this.parseBlock()]);
        }
        case "switch": {
          this.next();
          const lev = this.exprLev;
          this.exprLev = -1;
          let exprs: [Node, number][] = [];
          if (!this.is("{")) {
            exprs = this.parseSimple();
            if (this.is(";")) {
              this.next();
              if (!this.is("{")) exprs = [...exprs, ...this.parseSimple()];
            }
          }
          this.exprLev = lev;
          this.expect("{");
          const blocks: Stmt[][] = [];
          for (;;) {
            this.skipSep();
            if (this.is("}")) break;
            const ct = this.next();
            const cexprs: [Node, number][] = [];
            if (ct.t === "case") {
              cexprs.push([this.parseExprOrType(), 1]);
              while (this.is(",")) {
                this.next();
                this.skipNl();
                cexprs.push([this.parseExprOrType(), 1]);
              }
            }
            this.expect(":");
            const body = this.parseStmtList();
            blocks.push([
              { exprs: cexprs, blocks: [], s: ct.s, e: ct.e, lineSpan: false },
              ...body
            ]);
          }
          this.expect("}");
          return this.stmt(s, exprs, blocks);
        }
        case "return": {
          this.next();
          const exprs: [Node, number][] = [];
          const p = this.peek();
          if (p && p.k !== "nl" && p.t !== "}" && p.t !== ";") {
            exprs.push([this.parseExprOrType(), 1]);
            while (this.is(",")) {
              this.next();
              exprs.push([this.parseExprOrType(), 1]);
            }
          }
          return this.stmt(s, exprs);
        }
        case "break":
        case "continue":
        case "fallthrough":
          this.next();
          if (this.peek()?.k === "id") this.next();
          return this.stmt(s, []);
        case "var": {
          this.next();
          this.next(); // name
          while (this.is(",")) {
            this.next();
            this.next();
          }
          if (!this.is("=")) this.skipType();
          const exprs: [Node, number][] = [];
          if (this.is("=")) {
            this.next();
            exprs.push([this.parseExprOrType(), 1]);
            while (this.is(",")) {
              this.next();
              exprs.push([this.parseExprOrType(), 1]);
            }
          }
          return this.stmt(s, exprs);
        }
        case "go":
        case "defer": {
          this.next();
          return this.stmt(s, [[this.parseExpr(), 1]]);
        }
      }
    }
    if (t.t === "{") return this.stmt(s, [], [this.parseBlock()]);
    return this.stmt(s, this.parseSimple());
  }
}

// ── go/printer's spacing rules ──────────────────────────────────────────────

function walkBinary(e: Extract<Node, { kind: "binary" }>): {
  has4: boolean;
  has5: boolean;
  maxProblem: number;
} {
  let has4 = false;
  let has5 = false;
  let maxProblem = 0;
  const p = PREC[e.op]!;
  if (p === 4) has4 = true;
  if (p === 5) has5 = true;
  for (const side of [e.x, e.y]) {
    if (side.kind === "binary") {
      if (PREC[side.op]! < p) continue;
      const r = walkBinary(side);
      has4 ||= r.has4;
      has5 ||= r.has5;
      maxProblem = Math.max(maxProblem, r.maxProblem);
    }
  }
  if (e.y.kind === "star" && e.op === "/") maxProblem = 5;
  if (e.y.kind === "unary") {
    const pair = e.op + e.y.op;
    if (pair === "/*" || pair === "&&" || pair === "&^") maxProblem = 5;
    else if ((pair === "++" || pair === "--") && maxProblem < 4) maxProblem = 4;
  }
  return { has4, has5, maxProblem };
}

function cutoff(e: Extract<Node, { kind: "binary" }>, depth: number): number {
  const { has4, has5, maxProblem } = walkBinary(e);
  if (maxProblem > 0) return maxProblem + 1;
  if (has4 && has5) return depth === 1 ? 5 : 4;
  return depth === 1 ? 6 : 4;
}

function diffPrec(x: Node, prec: number): number {
  return x.kind === "binary" && PREC[x.op] === prec ? 0 : 1;
}

class Formatter {
  readonly funcs: Extract<Node, { kind: "func" }>[] = [];
  readonly binaries: Extract<Node, { kind: "binary" }>[] = [];
  readonly src: string;
  constructor(src: string) {
    this.src = src;
  }

  expr(n: Node, depth: number): void {
    switch (n.kind) {
      case "binary": {
        const prec = PREC[n.op]!;
        n.blank = prec < cutoff(n, depth);
        this.binaries.push(n);
        this.expr(n.x, depth + diffPrec(n.x, prec));
        this.expr(n.y, depth + 1);
        return;
      }
      case "paren":
        this.expr(n.x, Math.max(1, depth - 1));
        return;
      case "call": {
        const d = n.args.length > 1 ? depth + 1 : depth;
        this.expr(n.fun, d);
        for (const a of n.args) this.expr(a, d);
        return;
      }
      case "index":
        this.expr(n.x, 1);
        for (const i of n.idx) this.expr(i, depth + 1);
        return;
      case "slice":
        this.expr(n.x, 1);
        for (const p of n.parts) if (p) this.expr(p, depth + 1);
        return;
      case "sel":
      case "assert":
        this.expr(n.x, depth);
        return;
      case "unary":
        this.expr(n.x, depth);
        return;
      case "star":
        this.expr(n.x, 1);
        return;
      case "func":
        this.funcs.push(n);
        this.stmts(n.body);
        return;
      case "composite":
        for (const e of n.elts) this.expr(e, 1);
        return;
      case "kv":
        this.expr(n.key, 1);
        this.expr(n.value, 1);
        return;
      default:
        return;
    }
  }

  stmts(list: Stmt[]): void {
    for (const s of list) {
      for (const [e, d] of s.exprs) this.expr(e, d);
      for (const b of s.blocks) this.stmts(b);
    }
  }

  /**
   * Length of the text from s to e after the spacing changes (Infinity if it spans lines or holds
   * a func literal that is broken up).
   */
  size(s: number, e: number): number {
    const text = this.src.slice(s, e);
    if (text.includes("\n")) return Infinity;
    let n = text.length;
    for (const b of this.binaries) {
      if (b.opTok.s < s || b.opTok.e > e) continue;
      const before = this.src.slice(b.x.e, b.opTok.s).length;
      const after = this.src.slice(b.opTok.e, b.y.s).length;
      n += (b.blank ? 2 : 0) - before - after;
    }
    for (const f of this.funcs) if (f.s >= s && f.e <= e && f.expand) return Infinity;
    return n;
  }
}

type Edit = { s: number; e: number; text: string };

/** Formats the function bodies and var initializers of a generated Go file. */
export function gofmt(src: string): string {
  const toks = tokenize(src);
  const lineStarts: number[] = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === "\n") lineStarts.push(k + 1);
  const indentOf = (line: number): number => {
    let n = 0;
    for (let k = lineStarts[line]!; src[k] === "\t"; k++) n++;
    return n;
  };
  const edits: Edit[] = [];
  for (let i = 0; i < toks.length;) {
    const t = toks[i]!;
    const atLineStart = i === 0 || toks[i - 1]!.k === "nl";
    if (atLineStart && t.k === "kw" && (t.t === "func" || t.t === "var")) {
      const end = formatDecl(src, toks, i, indentOf, edits);
      if (end !== undefined) {
        i = end;
        continue;
      }
    }
    i++;
  }
  edits.sort((a, b) => b.s - a.s);
  let out = src;
  for (const ed of edits) out = out.slice(0, ed.s) + ed.text + out.slice(ed.e);
  return out;
}

/**
 * Collects the edits of the top-level `func` or `var` declaration at token i and returns the index
 * of the token after it, or undefined when it can't be parsed (it is left as it is).
 */
function formatDecl(
  src: string,
  toks: Tok[],
  i: number,
  indentOf: (line: number) => number,
  edits: Edit[]
): number | undefined {
  const p = new Parser(toks);
  p.i = i;
  const f = new Formatter(src);
  try {
    if (p.next().t === "func") {
      if (p.is("(")) p.skipBalanced("(", ")"); // receiver
      p.next(); // name
      if (p.is("[")) p.skipBalanced("[", "]"); // type parameters
      p.skipBalanced("(", ")");
      p.skipResult();
      f.stmts(p.parseBlock());
    } else {
      p.next(); // name
      if (!p.is("=")) p.skipType();
      if (p.is("=")) {
        p.next();
        f.expr(p.parseExprOrType(), 1);
      }
    }
  } catch {
    return undefined;
  }
  // One-line func literals that go/printer would break up (innermost first).
  for (const fn of [...f.funcs].sort((a, b) => b.s - a.s)) {
    if (fn.lbrace.line !== fn.rbrace.line) continue;
    const header = src.slice(fn.head[0], fn.head[1]).length;
    let body = 0;
    fn.body.forEach((st, k) => {
      if (k > 0) body += 2;
      body += f.size(st.s, st.e);
    });
    if (fn.body.length > 5 || header + body > 100) fn.expand = true;
  }
  for (const b of f.binaries) {
    const want = b.blank ? " " : "";
    edits.push({ s: b.x.e, e: b.opTok.s, text: want });
    edits.push({ s: b.opTok.e, e: b.y.s, text: want });
  }
  // An expanded literal is indented like its source line, plus one per expanded literal around it
  // on that line.
  for (const fn of f.funcs) {
    const first = fn.body[0];
    const last = fn.body[fn.body.length - 1];
    if (!fn.expand || !first || !last) continue;
    const line = fn.lbrace.line;
    let base = indentOf(line);
    for (const o of f.funcs)
      if (o !== fn && o.expand && o.lbrace.line === line && o.s < fn.s && o.e > fn.e) base++;
    const tabs = "\t".repeat(base);
    edits.push({ s: fn.lbrace.e, e: first.s, text: `\n${tabs}\t` });
    edits.push({ s: last.e, e: fn.rbrace.s, text: `\n${tabs}` });
  }
  return p.i;
}
