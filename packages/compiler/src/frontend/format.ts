/**
 * The yaffle formatter: canonical style printed from the AST.
 *
 * - 2-space indentation, no semicolons, one member per line.
 * - Consecutive fields are aligned in columns (type, name, `: storage`/`: width`, clauses,
 *   attributes, trailing comment) like the examples in DESIGN.md. A pointer's `*` hangs in front
 *   of the name column (`Record  records` / `Record *recPtrs`).
 * - Alignment the author already chose is kept: a column that is padded in the source keeps its
 *   source position (shifted by whatever the formatter changed before it on the line), lines
 *   aligned with each other stay aligned, and a line too wide for its group's column overflows
 *   with a single space instead of pushing the whole group right. Lines with no alignment at all
 *   (every column one space after the previous one) are aligned from scratch.
 * - Comments are preserved: leading comments stay above their member, trailing comments stay on
 *   the same line, and comment-only lines written under a trailing comment (same column) stay
 *   under it. A member containing comments in the middle is kept verbatim.
 * - Blank lines between members and declarations are preserved (at most one).
 * - `@` continuation lines are kept as continuation lines, under the first attribute of the
 *   field's first line, or under its name if that line has none.
 * - Enums, unions and layout blocks stay on one line if they were written on one line.
 *
 * Files with syntax errors are not formatted. Formatting is idempotent.
 */
import type * as A from "./ast.ts";
import type { Comment } from "./lexer.ts";
import { DiagnosticBag } from "./diagnostics.ts";
import { parse } from "./parser.ts";
import {
  printArraySuffix,
  printAttribute,
  printExpr,
  printInItems,
  printTypeRef
} from "./printer.ts";
import { SourceFile } from "./source.ts";

const INDENT = "  ";
const MAX_COMMENT_COLUMN = 60;
/** How much wider than the narrowest row a row may be to join a column aligned from scratch. */
const SCRATCH_SLACK = 4;
/** Longest line a construct written on one line is kept on one line for. */
const MAX_INLINE = 100;

export interface FormatResult {
  text: string;
  /** False if the file has syntax errors (text is returned unchanged). */
  formatted: boolean;
}

export interface FormatOptions {
  /** One level of indentation (default two spaces). */
  indent?: string;
}

export function formatSource(
  text: string,
  path = "/format.yfl",
  options: FormatOptions = {}
): FormatResult {
  const file = new SourceFile(path, text);
  const bag = new DiagnosticBag();
  const { module } = parse(file, bag);
  if (bag.items.some(d => d.severity === "error")) return { text, formatted: false };
  const f = new Formatter(file, module, options.indent ?? INDENT);
  return { text: f.run(), formatted: true };
}

interface Cell {
  text: string;
  /** Characters printed in front of the alignment point (the `*` of a pointer name). */
  hang: number;
  /** Source offset of the alignment point. */
  src?: number;
}

/** One output line of an alignment run. */
interface Row {
  /** Aligned columns (fields, switch cases, layout items); empty cells are skipped. */
  cells?: Cell[];
  /** Unaligned code (enum members, `@` continuation lines). */
  text?: string;
  /** `@` continuation line: starts at the position of column `underCol` of this row. */
  under?: Row;
  underCol?: number;
  /** Comment-only line continuing that row's trailing comment, at the same column. */
  commentOf?: Row;
  comment?: { text: string; src: number };
  /** Source column the row's positions are measured from (its member's first column). */
  base: number;
  /** Source line of the row. */
  line: number;
  /** Columns 1..scratchCols are aligned from scratch when the source has no alignment. */
  scratchCols?: number;
}

/** A row taking part in the alignment of one column. */
interface Part {
  row: Row;
  /** Leftmost position (one space after what precedes). */
  min: number;
  /** Position when the run is aligned from scratch. */
  canon: number;
  /** Position when the row doesn't fit its group's column. */
  overflow: number;
  /** Source position, relative to the row's base column. */
  raw?: number;
  /** True if the source has the minimal spacing here (no sign of alignment). */
  tight: boolean;
  /** Source position, shifted by what the formatter changed earlier on the line. */
  adj: number;
}

/**
 * Positions for one column of an alignment run.
 *
 * If the source shows no alignment (every row tight) the column is aligned from scratch, at the
 * widest row that is at most `slack` wider than the narrowest (wider rows overflow), and never
 * past `max`.
 *
 * Otherwise the source positions are kept (shifted by what changed earlier on each line): rows
 * at the same source position next to each other stay aligned, at the position the widest of
 * them needs, and a lone padded row keeps its position. Then, repeatedly, a lone tight row next
 * to an aligned group or a lone padded row joins it if it fits. The result is a fixed point of
 * this procedure, so formatting again changes nothing.
 */
function placeColumn(parts: Part[], max: number, slack: number): Map<Part, number> {
  if (!parts.length) return new Map();
  if (parts.every(p => p.tight)) return alignFromScratch(parts, max, slack);
  const at = new Map<Part, number>();
  for (let i = 0; i < parts.length;) {
    let j = i + 1;
    while (j < parts.length && parts[i]!.raw !== undefined && parts[j]!.raw === parts[i]!.raw) j++;
    const seg = parts.slice(i, j);
    const target = Math.max(...seg.map(p => Math.max(p.adj, p.min)));
    for (const p of seg) at.set(p, target);
    i = j;
  }
  for (;;) {
    const segs: Part[][] = [];
    for (const p of parts) {
      const last = segs[segs.length - 1];
      if (last && at.get(last[0]!) === at.get(p)) last.push(p);
      else segs.push([p]);
    }
    const aligned = (n: Part[] | undefined): n is Part[] =>
      !!n && (n.length > 1 || at.get(n[0]!)! > n[0]!.min);
    let moved = false;
    for (let k = 0; k < segs.length && !moved; k++) {
      const p = segs[k]!.length === 1 ? segs[k]![0]! : undefined;
      if (!p || at.get(p) !== p.min) continue;
      for (const n of [segs[k - 1], segs[k + 1]]) {
        if (aligned(n) && p.min <= at.get(n[0]!)!) {
          at.set(p, at.get(n[0]!)!);
          moved = true;
          break;
        }
      }
    }
    if (!moved) return at;
  }
}

function alignFromScratch(parts: Part[], max: number, slack: number): Map<Part, number> {
  const at = new Map<Part, number>();
  const narrowest = Math.min(...parts.map(p => p.canon));
  const fit = parts.filter(p => p.canon <= max && p.canon <= narrowest + slack);
  const target = Math.max(0, ...fit.map(p => p.canon));
  for (const p of parts) at.set(p, fit.includes(p) ? target : p.overflow);
  return at;
}

class Formatter {
  private readonly file: SourceFile;
  private readonly module: A.Module;
  private readonly comments: Comment[];
  private readonly used = new Set<Comment>();
  private out: string[] = [];

  private readonly indent: string;

  constructor(file: SourceFile, module: A.Module, indent: string) {
    this.indent = indent;
    this.file = file;
    this.module = module;
    this.comments = module.comments;
  }

  private get text(): string {
    return this.file.text;
  }

  run(): string {
    const decls = this.module.decls;
    let prevEnd = -1;
    let prevMultiline = false;
    for (let i = 0; i < decls.length; i++) {
      const d = decls[i]!;
      const leading = this.leadingComments(d.span.start, prevEnd);
      // emit into a side buffer first: blank lines depend on the emitted (not the source) layout
      const outer = this.out;
      const mine: string[] = [];
      this.out = mine;
      this.emitLeading(leading, "");
      const declStart = mine.length;
      const end = this.emitDecl(d, "");
      this.out = outer;
      const multiline = mine.length - declStart > 1;
      if (i > 0) {
        const first = leading[0]?.start ?? d.span.start;
        const prev = decls[i - 1]!;
        const bothImports = d.kind === "ImportDecl" && prev.kind === "ImportDecl";
        if (this.blankLineBetween(prevEnd, first) || (!bothImports && (prevMultiline || multiline)))
          this.out.push("");
      }
      this.out.push(...mine);
      prevEnd = end;
      prevMultiline = multiline;
    }
    // comments after the last declaration
    const rest = this.comments.filter(c => !this.used.has(c));
    if (rest.length && decls.length) {
      if (this.blankLineBetween(prevEnd, rest[0]!.start)) this.out.push("");
    }
    for (const c of rest) {
      this.used.add(c);
      this.emitComment(c, "");
    }
    let text = this.out.join("\n").replace(/[ \t]+$/gm, "");
    text = text.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
    return text.length ? text + "\n" : "";
  }

  // ── comments ─────────────────────────────────────────────────────────────

  private leadingComments(start: number, after: number): Comment[] {
    const out: Comment[] = [];
    for (const c of this.comments) {
      if (this.used.has(c)) continue;
      if (c.start > after && c.end <= start) {
        out.push(c);
        this.used.add(c);
      }
    }
    return out;
  }

  /** A comment that starts on the same line right after `end` (before the next token). */
  private trailingComment(end: number, limit: number): Comment | undefined {
    for (const c of this.comments) {
      if (this.used.has(c) || c.start < end || c.start >= limit) continue;
      const between = this.text.slice(end, c.start);
      if (/[\r\n]/.test(between) || /[^\s;,]/.test(between)) continue;
      if (c.kind === "block" && /[\r\n]/.test(c.text)) continue;
      this.used.add(c);
      return c;
    }
    return undefined;
  }

  private commentsInside(span: { start: number; end: number }): Comment[] {
    return this.comments.filter(
      c => !this.used.has(c) && c.start >= span.start && c.end <= span.end
    );
  }

  /** Leading comments, keeping (single) blank lines between them and before what follows. */
  private emitLeading(comments: Comment[], indent: string): void {
    comments.forEach((c, i) => {
      if (i > 0 && this.blankLineBetween(comments[i - 1]!.end, c.start)) this.out.push("");
      this.emitComment(c, indent);
    });
    const last = comments[comments.length - 1];
    if (last && this.blankLineBetween(last.end, this.nextCodeStart(last.end, this.text.length)))
      this.out.push("");
  }

  private emitComment(c: Comment, indent: string): void {
    if (c.kind === "line") {
      this.out.push(indent + c.text.trimEnd());
      return;
    }
    const lines = c.text.split(/\r?\n/);
    const startCol = this.file.positionAt(c.start).character;
    this.out.push(indent + lines[0]!.trimEnd());
    for (const l of lines.slice(1)) {
      // keep the comment's inner indentation relative to its first line
      const stripped = l.slice(Math.min(startCol, l.length - l.trimStart().length));
      this.out.push(indent + stripped.trimEnd());
    }
  }

  private blankLineBetween(a: number, b: number): boolean {
    if (a < 0) return false;
    const between = this.text.slice(a, b);
    return /\n[ \t]*\r?\n/.test(between);
  }

  /** Next token start after `pos` (approximation: first non-space, non-comment char). */
  private nextCodeStart(pos: number, limit: number): number {
    let i = pos;
    const t = this.text;
    while (i < limit) {
      const c = t[i]!;
      if (/\s/.test(c) || c === ";" || c === ",") {
        i++;
        continue;
      }
      if (c === "/" && t[i + 1] === "/") {
        while (i < limit && t[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && t[i + 1] === "*") {
        const e = t.indexOf("*/", i + 2);
        i = e < 0 ? limit : e + 2;
        continue;
      }
      return i;
    }
    return limit;
  }

  // ── declarations ─────────────────────────────────────────────────────────

  /** Emits a declaration; returns the end offset consumed (including a trailing comment). */
  private emitDecl(d: A.Decl, indent: string): number {
    const exp = d.exported ? "export " : "";
    const limit = this.nextCodeStart(d.span.end, this.text.length);
    const inner = this.commentsInside(d.span);
    switch (d.kind) {
      case "ImportDecl": {
        if (inner.length) return this.emitVerbatim(d.span, indent, limit);
        let s = "import ";
        if (d.namespace) s += `* as ${d.namespace.name}`;
        else
          s += `{ ${(d.names ?? []).map(n => (n.alias ? `${n.name.name} as ${n.alias.name}` : n.name.name)).join(", ")} }`;
        if (d.source) s += ` from ${JSON.stringify(d.source.value)}`;
        return this.emitLine(indent, s, d.span.end, limit);
      }
      case "ConstDecl": {
        if (inner.length) return this.emitVerbatim(d.span, indent, limit);
        const t = d.type ? printTypeRef(d.type) + " " : "";
        const s = `${exp}const ${t}${d.name.name}${d.arrays.map(printArraySuffix).join("")}${d.value ? ` = ${printExpr(d.value)}` : ""}`;
        return this.emitLine(indent, s, d.span.end, limit);
      }
      case "ExternFnDecl": {
        if (inner.length) return this.emitVerbatim(d.span, indent, limit);
        const s = `${exp}extern fn ${d.name.name}(${d.params.map(paramText).join(", ")})${d.returns ? ` -> ${printTypeRef(d.returns)}${d.returnArrays.map(printArraySuffix).join("")}` : ""}`;
        return this.emitLine(indent, s, d.span.end, limit);
      }
      case "ExternCodecDecl": {
        if (inner.length) return this.emitVerbatim(d.span, indent, limit);
        const params = d.params.length ? `(${d.params.map(paramText).join(", ")})` : "";
        const s = `${exp}extern ${d.async ? "async " : ""}codec ${d.name.name}${params}${attrsText(d.attrs)}`;
        return this.emitLine(indent, s, d.span.end, limit);
      }
      case "ExternTypeDecl": {
        if (inner.length) return this.emitVerbatim(d.span, indent, limit);
        const params = d.params.length ? `(${d.params.map(paramText).join(", ")})` : "";
        const s = `${exp}extern type ${d.name.name}${params}${d.valueType ? ` : ${printTypeRef(d.valueType)}` : ""}${attrsText(d.attrs)}`;
        return this.emitLine(indent, s, d.span.end, limit);
      }
      case "TypeAliasDecl": {
        if (inner.length) return this.emitVerbatim(d.span, indent, limit);
        const tps = d.typeParams.length ? `<${d.typeParams.map(t => t.name).join(", ")}>` : "";
        const params = d.params ? `(${d.params.map(paramText).join(", ")})` : "";
        const body = d.body ? ` = ${typeSpecText(d.body)}` : "";
        return this.emitLine(
          indent,
          `${exp}type ${d.name.name}${tps}${params}${body}`,
          d.span.end,
          limit
        );
      }
      case "EnumDecl":
        return this.emitEnum(d, indent, exp, limit);
      case "UnionDecl":
        return this.emitUnion(d, indent, exp, limit);
      case "StructDecl":
        return this.emitStruct(d, indent, exp, limit);
    }
  }

  /** A line of code with its trailing comment (kept at its source distance from the code). */
  private emitLine(indent: string, code: string, end: number, limit: number): number {
    const c = this.trailingComment(end, limit);
    if (!c) {
      this.out.push(indent + code);
      return end;
    }
    const line = this.lineOf(c.start);
    const lineText = this.text.slice(this.file.lineStarts[line]!);
    const row: Row = { base: lineText.length - lineText.trimStart().length, line };
    const at = Math.max(code.length + 1, this.sourcePos(row, c.start, 0, code.length, 2).adj);
    this.out.push(indent + code.padEnd(at) + c.text.trimEnd());
    let last = c.end;
    for (const k of this.commentContinuation(c)) {
      this.out.push(indent + " ".repeat(at) + k.text.trimEnd());
      last = k.end;
    }
    return last;
  }

  private col(offset: number): number {
    return this.file.positionAt(offset).character;
  }

  private lineOf(offset: number): number {
    return this.file.positionAt(offset).line;
  }

  /**
   * Where the source puts a column of `row` that follows output content of width `w`: its
   * position relative to the row's base column, whether the spacing before it is minimal
   * (`slack` spaces at most), and the position shifted by the change in width before it.
   */
  private sourcePos(
    row: Row,
    src: number | undefined,
    hang: number,
    w: number,
    slack: number
  ): { raw?: number; tight: boolean; adj: number } {
    const fallback = { tight: true, adj: w + 1 + hang };
    if (src === undefined || this.lineOf(src) !== row.line) return fallback;
    let end = src - hang;
    while (end > 0 && (this.text[end - 1] === " " || this.text[end - 1] === "\t")) end--;
    if (this.lineOf(end) !== row.line || end <= this.file.lineStarts[row.line]!) return fallback;
    const wSrc = this.col(end) - row.base;
    const s = this.col(src) - row.base;
    if (s < wSrc + 1 + hang) return fallback;
    return { raw: s, tight: s <= wSrc + slack + hang, adj: s + (w - wSrc) };
  }

  /** Comment-only lines right below a trailing line comment, starting at its column. */
  private commentContinuation(c: Comment): Comment[] {
    const out: Comment[] = [];
    if (c.kind !== "line") return out;
    const col = this.col(c.start);
    let prev = c;
    for (let i = this.comments.indexOf(c) + 1; i < this.comments.length; i++) {
      const n = this.comments[i]!;
      if (this.used.has(n) || n.kind !== "line") break;
      if (!/^[ \t]*\r?\n[ \t]*$/.test(this.text.slice(prev.end, n.start))) break;
      if (this.col(n.start) !== col) break;
      this.used.add(n);
      out.push(n);
      prev = n;
    }
    return out;
  }

  /** Attaches the trailing comment after `end` (and its continuation lines) to the last row. */
  private attachComment(rows: Row[], end: number, limit: number): number {
    const c = this.trailingComment(end, limit);
    if (!c) return end;
    const last = rows[rows.length - 1]!;
    last.comment = { text: c.text.trimEnd(), src: c.start };
    let e = c.end;
    for (const k of this.commentContinuation(c)) {
      rows.push({
        commentOf: last,
        comment: { text: k.text.trimEnd(), src: k.start },
        base: last.base,
        line: this.lineOf(k.start)
      });
      e = k.end;
    }
    return e;
  }

  /** Cells of a field: type, name, `: storage`/`: width`, clauses, same-line attributes. */
  private fieldCells(f: A.FieldDecl, exclude: Set<A.Attribute>): Cell[] {
    const type =
      (f.virtual ? "virtual " : "") +
      printTypeRef(f.type) +
      f.typeArrays.map(printArraySuffix).join("");
    const cells: Cell[] = [{ text: type, hang: 0, src: f.virtual?.start ?? f.type.span.start }];
    const name = f.name?.name
      ? `${f.pointer ? "*" : ""}${f.bound ? "$" : ""}${f.name.name}${f.arrays.map(printArraySuffix).join("")}`
      : "";
    cells.push({
      text: name,
      hang: f.pointer && name ? 1 : 0,
      ...(f.name ? { src: f.name.span.start - (f.bound ? 1 : 0) } : {})
    });
    const spec = f.storage ?? f.bitWidth;
    const colon = spec ? this.text.lastIndexOf(":", spec.span.start) : -1;
    cells.push({
      text: f.storage
        ? `: ${printTypeRef(f.storage)}`
        : f.bitWidth
          ? `: ${printExpr(f.bitWidth)}`
          : "",
      hang: 0,
      ...(colon >= 0 ? { src: colon } : {})
    });
    const clauses = clausesText(f.clauses);
    const starts = Object.values(f.clauses.spans).map(s => s!.start);
    cells.push({ text: clauses, hang: 0, ...(starts.length ? { src: Math.min(...starts) } : {}) });
    const attrs = f.attrs.filter(a => !exclude.has(a));
    cells.push({
      text: attrs.map(printAttribute).join(" "),
      hang: 0,
      ...(attrs.length ? { src: attrs[0]!.span.start } : {})
    });
    return cells;
  }

  /** The rows of a field: its first line and its `@` continuation lines. */
  private fieldRows(f: A.FieldDecl): Row[] | undefined {
    const groups = continuationGroups(this.text, f);
    const base = this.col(f.span.start);
    const cells = this.fieldCells(f, new Set(groups.flat()));
    const head: Row = { cells, base, line: this.lineOf(f.span.start), scratchCols: 1 };
    const underCol = cells[4]!.text ? 4 : cells[1]!.text ? 1 : cells[2]!.text ? 2 : -1;
    const rows = [head];
    for (const g of groups)
      rows.push({
        text: g.map(printAttribute).join(" "),
        under: head,
        underCol,
        base,
        line: this.lineOf(g[0]!.span.start)
      });
    // line comments ending the first line or a continuation line belong to that line; any
    // other comment inside the field keeps it verbatim
    const inner = this.commentsInside(f.span);
    const rowOf = (c: Comment) => rows.find(r => r.line === this.lineOf(c.start));
    for (const c of inner) {
      const row = rowOf(c);
      if (c.kind !== "line" || !row || row === rows[rows.length - 1] || row.comment)
        return undefined;
      row.comment = { text: c.text.trimEnd(), src: c.start };
    }
    for (const c of inner) this.used.add(c);
    return rows;
  }

  private emitVerbatim(
    span: { start: number; end: number },
    indent: string,
    limit: number
  ): number {
    for (const c of this.commentsInside(span)) this.used.add(c);
    const lines = this.text.slice(span.start, span.end).split(/\r?\n/);
    const baseCol = this.file.positionAt(span.start).character;
    const out = lines.map((l, i) =>
      i === 0 ? l : l.slice(Math.min(baseCol, l.length - l.trimStart().length))
    );
    const c = this.trailingComment(span.end, limit);
    out[out.length - 1] = out[out.length - 1]!.trimEnd() + (c ? " " + c.text.trimEnd() : "");
    for (const l of out) this.out.push(indent + l.trimEnd());
    return c ? c.end : span.end;
  }

  private emitEnum(d: A.EnumDecl, indent: string, exp: string, limit: number): number {
    const head = `${exp}enum ${d.name.name}${d.storage ? ` : ${printTypeRef(d.storage)}` : ""}${attrsText(d.attrs)}`;
    const inner = this.commentsInside(d.bodySpan);
    const memberText = (m: A.EnumMember) =>
      m.value ? `${m.name.name} = ${printExpr(m.value)}` : m.name.name;
    if (!inner.length && !isMultiline(this.text, d.bodySpan)) {
      const s = d.members.length
        ? `${head} { ${d.members.map(memberText).join(", ")} }`
        : `${head} {}`;
      return this.emitLine(indent, s, d.span.end, limit);
    }
    let prevEnd = this.open(indent, `${head} {`, d.bodySpan.start, d.bodySpan.end);
    const lines: Row[] = [];
    const flush = () => this.flushAligned(lines.splice(0), indent + this.indent);
    for (const m of d.members) {
      const leading = this.leadingComments(m.span.start, prevEnd);
      if (this.blankLineBetween(prevEnd, leading[0]?.start ?? m.span.start) && lines.length) {
        flush();
        this.out.push("");
      }
      if (leading.length) {
        flush();
        this.emitLeading(leading, indent + this.indent);
      }
      const lim = this.nextCodeStart(m.span.end, d.bodySpan.end);
      const rows: Row[] = [
        { text: memberText(m), base: this.col(m.span.start), line: this.lineOf(m.span.start) }
      ];
      prevEnd = this.attachComment(rows, m.span.end, lim);
      lines.push(...rows);
    }
    flush();
    this.emitInnerTail(d.bodySpan, prevEnd, indent + this.indent);
    return this.emitLine(indent, "}", d.span.end, limit);
  }

  private emitUnion(d: A.UnionDecl, indent: string, exp: string, limit: number): number {
    const tps = d.typeParams.length ? `<${d.typeParams.map(t => t.name).join(", ")}>` : "";
    const params = d.params ? `(${d.params.map(paramText).join(", ")})` : "";
    const head = `${exp}union ${d.name.name}${tps}${params}${attrsText(d.attrs)}`;
    const inner = this.commentsInside(d.bodySpan);
    if (!inner.length && !isMultiline(this.text, d.bodySpan)) {
      return this.emitLine(
        indent,
        d.variants.length ? `${head} { ${d.variants.map(printTypeRef).join("  ")} }` : `${head} {}`,
        d.span.end,
        limit
      );
    }
    let prevEnd = this.open(indent, `${head} {`, d.bodySpan.start, d.bodySpan.end);
    for (const v of d.variants) {
      const leading = this.leadingComments(v.span.start, prevEnd);
      if (this.blankLineBetween(prevEnd, leading[0]?.start ?? v.span.start)) this.out.push("");
      this.emitLeading(leading, indent + this.indent);
      const lim = this.nextCodeStart(v.span.end, d.bodySpan.end);
      prevEnd = this.emitLine(indent + this.indent, printTypeRef(v), v.span.end, lim);
    }
    this.emitInnerTail(d.bodySpan, prevEnd, indent + this.indent);
    return this.emitLine(indent, "}", d.span.end, limit);
  }

  private emitStruct(d: A.StructDecl, indent: string, exp: string, limit: number): number {
    const tps = d.typeParams.length ? `<${d.typeParams.map(t => t.name).join(", ")}>` : "";
    const params = d.params ? `(${d.params.map(paramText).join(", ")})` : "";
    const head = `${exp}struct ${d.name.name}${tps}${params}${attrsText(d.attrs)}`;
    // keep a short one-line struct on one line (`struct Blob(u32 n) { u8 data[n] }`)
    if (!isMultiline(this.text, d.bodySpan) && !this.commentsInside(d.bodySpan).length) {
      const body = this.inlineBody(d.members);
      if (body !== undefined) {
        const s = `${head} ${body}`;
        if (indent.length + s.length <= MAX_INLINE)
          return this.emitLine(indent, s, d.span.end, limit);
      }
    }
    const start = this.open(indent, `${head} {`, d.bodySpan.start, d.bodySpan.end);
    const end = this.emitMembers(d.members, indent + this.indent, start, d.bodySpan.end);
    this.emitInnerTail(d.bodySpan, end, indent + this.indent);
    return this.emitLine(indent, "}", d.span.end, limit);
  }

  /** Comments between the last member and the closing brace. */
  private emitInnerTail(body: { start: number; end: number }, after: number, indent: string): void {
    const rest = this.comments.filter(
      c => !this.used.has(c) && c.start >= after && c.end <= body.end
    );
    if (rest.length && this.blankLineBetween(after, rest[0]!.start)) this.out.push("");
    for (const c of rest) {
      this.used.add(c);
      this.emitComment(c, indent);
    }
  }

  /** An opening line ending in `{` (at offset `brace`), with a comment written after it. */
  private open(indent: string, code: string, brace: number, bodyEnd: number): number {
    return this.emitLine(indent, code, brace + 1, this.nextCodeStart(brace + 1, bodyEnd));
  }

  /** One-line rendering of a member written on one line, if it has one. */
  private inlineMember(m: A.Member): string | undefined {
    if (this.commentsInside(m.span).length || isMultiline(this.text, m.span)) return undefined;
    switch (m.kind) {
      case "FieldDecl":
        return formatFieldHead(m);
      case "LayoutMember":
        return layoutText(m, this.text);
      case "BlockMember": {
        const body = this.inlineBody(m.members);
        return body === undefined ? undefined : prefixAttrs(m.attrs) + body;
      }
      case "IfMember": {
        const then = this.inlineBody(m.then);
        if (then === undefined) return undefined;
        let s = `${prefixAttrs(m.attrs)}if (${m.condition ? printExpr(m.condition) : ""}) ${then}`;
        if (m.else) {
          const e =
            m.elseIf && m.else.length === 1 && m.else[0]!.kind === "IfMember"
              ? this.inlineMember(m.else[0]!)
              : this.inlineBody(m.else);
          if (e === undefined) return undefined;
          s += ` else ${e}`;
        }
        return s;
      }
      default:
        return undefined;
    }
  }

  private inlineBody(members: A.Member[]): string | undefined {
    const parts = members.map(m => this.inlineMember(m));
    if (parts.some(p => p === undefined)) return undefined;
    return parts.length ? `{ ${parts.join("  ")} }` : "{}";
  }

  // ── members ──────────────────────────────────────────────────────────────

  /** Emits a member list; returns the offset after the last consumed member/comment. */
  private emitMembers(members: A.Member[], indent: string, start: number, bodyEnd: number): number {
    let prevEnd = start;
    const run: Row[] = [];
    const flush = () => this.flushAligned(run.splice(0), indent);
    for (let i = 0; i < members.length; i++) {
      const m = members[i]!;
      const leading = this.leadingComments(m.span.start, prevEnd);
      const first = leading[0]?.start ?? m.span.start;
      const blank = i > 0 && this.blankLineBetween(prevEnd, first);
      if (blank || leading.length || m.kind !== "FieldDecl") flush();
      if (blank) this.out.push("");
      this.emitLeading(leading, indent);
      const lim = this.nextCodeStart(m.span.end, bodyEnd);
      const rows = m.kind === "FieldDecl" ? this.fieldRows(m) : undefined;
      if (rows) {
        prevEnd = this.attachComment(rows, m.span.end, lim);
        run.push(...rows);
        continue;
      }
      flush();
      prevEnd = this.emitMember(m, indent, lim);
    }
    flush();
    return prevEnd;
  }

  /** Prints an alignment run (see `placeColumn` for how columns are positioned). */
  private flushAligned(rows: Row[], indent: string): void {
    if (!rows.length) return;
    const pos = new Map<Row, number[]>();
    const width = new Map<Row, number>();
    const ncols = Math.max(0, ...rows.map(r => r.cells?.length ?? 0));
    for (const r of rows) {
      if (!r.cells) continue;
      pos.set(r, [0]);
      width.set(r, r.cells[0]!.text.length);
    }
    for (let k = 1; k < ncols; k++) {
      const parts: Part[] = [];
      for (const r of rows) {
        const c = r.cells?.[k];
        if (!c?.text) continue;
        const w = width.get(r)!;
        const min = w + 1 + c.hang;
        parts.push({
          row: r,
          min,
          canon: min,
          overflow: min,
          ...this.sourcePos(r, c.src, c.hang, w, 1)
        });
      }
      const slack = parts.every(p => k <= (p.row.scratchCols ?? 0)) ? SCRATCH_SLACK : 0;
      const at = placeColumn(parts, Infinity, slack);
      for (const p of parts) {
        const c = p.row.cells![k]!;
        const x = at.get(p)!;
        pos.get(p.row)![k] = x;
        width.set(p.row, x - c.hang + c.text.length);
      }
    }
    for (const r of rows) {
      if (r.text === undefined) continue;
      let x = 0;
      if (r.under) {
        const k = r.underCol ?? -1;
        x = k >= 0 ? (pos.get(r.under)![k] ?? 0) : r.under.cells![0]!.text.length + 1;
      }
      pos.set(r, [x]);
      width.set(r, x + r.text.length);
    }
    const parts: Part[] = [];
    for (const r of rows) {
      if (!r.comment || r.commentOf) continue;
      const w = width.get(r)!;
      const sp = this.sourcePos(r, r.comment.src, 0, w, 2);
      const overflow = sp.tight && sp.adj >= w + 1 && sp.adj <= w + 2 ? sp.adj : w + 2;
      parts.push({ row: r, min: w + 1, canon: w + 2, overflow, ...sp });
    }
    const commentAt = placeColumn(parts, MAX_COMMENT_COLUMN, Infinity);
    const commentPos = new Map<Row, number>();
    for (const p of parts) commentPos.set(p.row, commentAt.get(p)!);
    for (const r of rows) {
      if (r.commentOf) {
        this.out.push(indent + " ".repeat(commentPos.get(r.commentOf) ?? 0) + r.comment!.text);
        continue;
      }
      let s = "";
      if (r.cells) {
        r.cells.forEach((c, k) => {
          if (c.text) s = s.padEnd(pos.get(r)![k]! - c.hang) + c.text;
        });
      } else s = " ".repeat(pos.get(r)![0]!) + r.text;
      if (r.comment) s = s.padEnd(commentPos.get(r)!) + r.comment.text;
      this.out.push(indent + s);
    }
  }

  private emitMember(m: A.Member, indent: string, limit: number): number {
    switch (m.kind) {
      case "FieldDecl":
        return this.emitField(m, indent, limit);
      case "StructDecl":
        return this.emitStruct(m, indent, "", limit);
      case "EnumDecl":
        return this.emitEnum(m, indent, "", limit);
      case "UnionDecl":
        return this.emitUnion(m, indent, "", limit);
      case "BlockMember": {
        const inline = this.inlineMember(m);
        if (inline !== undefined && indent.length + inline.length <= MAX_INLINE)
          return this.emitLine(indent, inline, m.span.end, limit);
        const start = this.open(
          indent,
          `${prefixAttrs(m.attrs)}{`,
          m.bodySpan.start,
          m.bodySpan.end
        );
        const end = this.emitMembers(m.members, indent + this.indent, start, m.bodySpan.end);
        this.emitInnerTail(m.bodySpan, end, indent + this.indent);
        return this.emitLine(indent, "}", m.span.end, limit);
      }
      case "IfMember": {
        const inline = this.inlineMember(m);
        if (inline !== undefined && indent.length + inline.length <= MAX_INLINE)
          return this.emitLine(indent, inline, m.span.end, limit);
        return this.emitIf(m, indent, limit, `${indent}${prefixAttrs(m.attrs)}`);
      }
      case "SwitchMember": {
        let prevEnd = this.open(
          indent,
          `${prefixAttrs(m.attrs)}switch (${m.discriminant ? printExpr(m.discriminant) : ""}) {`,
          m.bodySpan.start,
          m.bodySpan.end
        );
        const sameLine: Row[] = [];
        const flushCases = () => this.flushAligned(sameLine.splice(0), indent + this.indent);
        for (const c of m.cases) {
          const leading = this.leadingComments(c.span.start, prevEnd);
          if (this.blankLineBetween(prevEnd, leading[0]?.start ?? c.span.start)) {
            flushCases();
            this.out.push("");
          }
          if (leading.length) flushCases();
          for (const lc of leading) this.emitComment(lc, indent + this.indent);
          const label = c.isDefault
            ? "default:"
            : `case ${c.values.map(v => printExpr(v)).join(", ")}:`;
          const only = c.members.length === 1 ? c.members[0]! : undefined;
          const lim = this.nextCodeStart(c.span.end, m.bodySpan.end);
          let cells: Cell[] | undefined;
          if (
            only &&
            !this.commentsInside(c.span).length &&
            !isMultiline(this.text, { start: c.span.start, end: only.span.end })
          ) {
            if (only.kind !== "FieldDecl") {
              const inline = this.inlineMember(only);
              if (inline !== undefined) cells = [{ text: inline, hang: 0, src: only.span.start }];
            } else if (!hasContinuation(this.text, only)) cells = this.fieldCells(only, new Set());
          }
          if (cells) {
            const rows: Row[] = [
              {
                cells: [{ text: label, hang: 0, src: c.span.start }, ...cells],
                base: this.col(c.span.start),
                line: this.lineOf(c.span.start),
                scratchCols: 2
              }
            ];
            prevEnd = this.attachComment(rows, c.span.end, lim);
            sameLine.push(...rows);
            continue;
          }
          flushCases();
          const tc = this.trailingComment(
            c.values.length
              ? c.values[c.values.length - 1]!.span.end + 1
              : c.span.start + label.length,
            c.members[0]?.span.start ?? lim
          );
          this.out.push(`${indent}${this.indent}${label}${tc ? " " + tc.text.trimEnd() : ""}`);
          prevEnd = this.emitMembers(
            c.members,
            indent + this.indent + this.indent,
            tc ? tc.end : c.span.start,
            c.span.end
          );
        }
        flushCases();
        this.emitInnerTail(m.bodySpan, prevEnd, indent + this.indent);
        return this.emitLine(indent, "}", m.span.end, limit);
      }
      case "BitsMember": {
        const attrs = m.attrs.filter(a => a.span.start > (m.storage?.span.end ?? 0));
        const prefix = m.attrs.filter(a => a.span.start < (m.storage?.span.start ?? 0));
        const start = this.open(
          indent,
          `${prefixAttrs(prefix)}bits ${m.storage ? printTypeRef(m.storage) : ""}${attrsText(attrs)} {`,
          m.bodySpan.start,
          m.bodySpan.end
        );
        const end = this.emitMembers(m.fields, indent + this.indent, start, m.bodySpan.end);
        this.emitInnerTail(m.bodySpan, end, indent + this.indent);
        return this.emitLine(indent, "}", m.span.end, limit);
      }
      case "LayoutMember": {
        if (!isMultiline(this.text, m.bodySpan) && !this.commentsInside(m.bodySpan).length) {
          return this.emitLine(indent, layoutText(m, this.text), m.span.end, limit);
        }
        let prevEnd = this.open(indent, "layout {", m.bodySpan.start, m.bodySpan.end);
        prevEnd = this.emitLayoutItems(m.items, indent + this.indent, prevEnd, m.bodySpan.end);
        this.emitInnerTail(m.bodySpan, prevEnd, indent + this.indent);
        return this.emitLine(indent, "}", m.span.end, limit);
      }
    }
  }

  /** Layout items, one per line (aligned); per-element groups nest. */
  private emitLayoutItems(
    items: A.LayoutItem[],
    indent: string,
    after: number,
    bodyEnd: number
  ): number {
    let prevEnd = after;
    const lines: Row[] = [];
    const flush = () => this.flushAligned(lines.splice(0), indent);
    for (const it of items) {
      const leading = this.leadingComments(it.span.start, prevEnd);
      if (this.blankLineBetween(prevEnd, leading[0]?.start ?? it.span.start)) {
        flush();
        this.out.push("");
      }
      if (leading.length) flush();
      this.emitLeading(leading, indent);
      const lim = this.nextCodeStart(it.span.end, bodyEnd);
      const g = it.group;
      if (g && (isMultiline(this.text, g.span) || this.commentsInside(g.span).length)) {
        flush();
        let p = this.open(
          indent,
          `${layoutPath(it)}${attrsText(it.attrs)} {`,
          g.span.start,
          g.span.end
        );
        p = this.emitLayoutItems(g.items, indent + this.indent, p, g.span.end);
        this.emitInnerTail(g.span, p, indent + this.indent);
        prevEnd = this.emitLine(indent, "}", it.span.end, lim);
        continue;
      }
      const attrs = it.attrs.map(printAttribute).join(" ");
      const group = g ? groupText(g, this.text) : "";
      const rows: Row[] = [
        {
          cells: [
            { text: layoutPath(it), hang: 0, src: it.span.start },
            {
              text: attrs && group ? `${attrs} ${group}` : attrs || group,
              hang: 0,
              ...(it.attrs.length
                ? { src: it.attrs[0]!.span.start }
                : g
                  ? { src: g.span.start }
                  : {})
            }
          ],
          base: this.col(it.span.start),
          line: this.lineOf(it.span.start)
        }
      ];
      prevEnd = this.attachComment(rows, it.span.end, lim);
      lines.push(...rows);
    }
    flush();
    return prevEnd;
  }

  private emitIf(m: A.IfMember, indent: string, limit: number, head: string): number {
    const start = this.open(
      "",
      `${head}if (${m.condition ? printExpr(m.condition) : ""}) {`,
      m.thenSpan.start,
      m.thenSpan.end
    );
    let end = this.emitMembers(m.then, indent + this.indent, start, m.thenSpan.end);
    this.emitInnerTail(m.thenSpan, end, indent + this.indent);
    if (!m.else) return this.emitLine(indent, "}", m.span.end, limit);
    if (m.elseIf && m.else.length === 1 && m.else[0]!.kind === "IfMember") {
      return this.emitIf(m.else[0]! as A.IfMember, indent, limit, `${indent}} else `);
    }
    const elseEnd = m.span.end;
    const brace = this.text.indexOf("{", m.elseSpan ? m.elseSpan.end : m.thenSpan.end);
    const elseStart =
      brace >= 0 && brace < elseEnd
        ? this.open(indent, "} else {", brace, elseEnd)
        : (this.out.push(`${indent}} else {`), m.thenSpan.end);
    end = this.emitMembers(m.else, indent + this.indent, elseStart, elseEnd);
    this.emitInnerTail({ start: elseStart, end: elseEnd }, end, indent + this.indent);
    return this.emitLine(indent, "}", m.span.end, limit);
  }

  /** A field outside an alignment run. */
  private emitField(f: A.FieldDecl, indent: string, limit: number): number {
    const rows = this.fieldRows(f);
    if (!rows) return this.emitVerbatim(f.span, indent, limit);
    const end = this.attachComment(rows, f.span.end, limit);
    this.flushAligned(rows, indent);
    return end;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function layoutPath(i: A.LayoutItem): string {
  return i.path === "this"
    ? "this"
    : i.path.map((s, k) => (s.kind === "each" ? "[*]" : (k ? "." : "") + s.name.name)).join("");
}

function layoutItemText(i: A.LayoutItem, text: string): string {
  return layoutPath(i) + attrsText(i.attrs) + (i.group ? " " + groupText(i.group, text) : "");
}

/** Items separated the way the author wrote them: with commas, or with two spaces. */
function itemsText(items: A.LayoutItem[], text: string): string {
  const commas = items.some((it, k) => {
    const next = items[k + 1];
    return !!next && text.slice(it.span.end, next.span.start).includes(",");
  });
  return items.map(i => layoutItemText(i, text)).join(commas || items.length < 2 ? ", " : "  ");
}

/** A one-line group: `{ pieces[*]  portals[*].points }`. */
function groupText(g: NonNullable<A.LayoutItem["group"]>, text: string): string {
  return g.items.length ? `{ ${itemsText(g.items, text)} }` : "{}";
}

function layoutText(m: A.LayoutMember, text: string): string {
  return `layout { ${itemsText(m.items, text)} }`;
}

function isMultiline(text: string, span: { start: number; end: number }): boolean {
  return /[\r\n]/.test(text.slice(span.start, span.end));
}

function paramText(p: A.ParamDecl): string {
  return `${p.type ? printTypeRef(p.type) + " " : ""}${p.bound ? "$" : ""}${p.name.name}${p.arrays.map(printArraySuffix).join("")}${p.default ? ` = ${printExpr(p.default)}` : ""}`;
}

function attrsText(attrs: A.Attribute[]): string {
  return attrs.length ? " " + attrs.map(printAttribute).join(" ") : "";
}

function prefixAttrs(attrs: A.Attribute[]): string {
  return attrs.length ? attrs.map(printAttribute).join(" ") + " " : "";
}

function clausesText(c: A.FieldClauses): string {
  const parts: string[] = [];
  if (c.at) parts.push(`at ${printExpr(c.at)}`);
  if (c.from) parts.push(`from ${printExpr(c.from)}`);
  if (c.asRead)
    parts.push(`as ${printExpr(c.asRead)}${c.asWrite ? ` = ${printExpr(c.asWrite)}` : ""}`);
  if (c.formula) parts.push(`= ${printExpr(c.formula)}`);
  if (c.defaultValue) parts.push(`?= ${printExpr(c.defaultValue)}`);
  if (c.inItems) parts.push(`in ${printInItems(c.inItems)}`);
  if (c.regex) parts.push(`in /${c.regex.pattern}/`);
  if (c.where) parts.push(`where ${printExpr(c.where)}`);
  return parts.join(" ");
}

function typeSpecText(s: A.TypeSpec): string {
  const cl = clausesText(s.clauses);
  return `${printTypeRef(s.type)}${s.arrays.map(printArraySuffix).join("")}${cl ? " " + cl : ""}${attrsText(s.attrs)}`;
}

/** [type column, rest] for a field, leaving out `exclude`d attributes (continuation lines). */
function fieldColumns(f: A.FieldDecl, exclude: Set<A.Attribute> = new Set()): [string, string] {
  const type =
    (f.virtual ? "virtual " : "") +
    printTypeRef(f.type) +
    f.typeArrays.map(printArraySuffix).join("");
  let name = `${f.pointer ? "*" : ""}${f.bound ? "$" : ""}${f.name?.name ?? ""}${f.arrays.map(printArraySuffix).join("")}`;
  if (f.storage) name += ` : ${printTypeRef(f.storage)}`;
  if (f.bitWidth) name += `${f.name ? " " : ""}: ${printExpr(f.bitWidth)}`;
  const cl = clausesText(f.clauses);
  if (cl) name += " " + cl;
  name += attrsText(f.attrs.filter(a => !exclude.has(a)));
  return [type, name.trim()];
}

/** Does the field have attributes on continuation lines? */
function hasContinuation(text: string, f: A.FieldDecl): boolean {
  return continuationGroups(text, f).length > 0;
}

/** Attribute groups on continuation lines (each line starting with @), after the first line. */
function continuationGroups(text: string, f: A.FieldDecl): A.Attribute[][] {
  const groups: A.Attribute[][] = [];
  let cur: A.Attribute[] | undefined;
  for (const a of f.attrs) {
    const before = text.slice(0, a.span.start);
    const lineStart = before.lastIndexOf("\n") + 1;
    const startsOwnLine =
      /^\s*$/.test(text.slice(lineStart, a.span.start)) &&
      a.span.start > f.type.span.start &&
      lineStart > f.span.start;
    if (startsOwnLine) {
      cur = [a];
      groups.push(cur);
    } else if (cur) cur.push(a);
  }
  return groups;
}

export function formatFieldHead(f: A.FieldDecl): string {
  const [t, n] = fieldColumns(f);
  return `${t} ${n}`.trimEnd();
}
