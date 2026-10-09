/**
 * Source text with a line map. AST nodes store character offsets; this converts them to the
 * 0-based line/character positions (UTF-16 code units) used by diagnostics, the IR and the LSP.
 */
import type { Position, Range } from "../service/api.ts";

/** A half-open character offset span [start, end). */
export interface Span {
  start: number;
  end: number;
}

export class SourceFile {
  readonly path: string;
  readonly text: string;
  readonly lineStarts: number[];

  constructor(path: string, text: string) {
    this.path = path;
    this.text = text;
    this.lineStarts = computeLineStarts(text);
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }

  positionAt(offset: number): Position {
    const o = Math.max(0, Math.min(offset, this.text.length));
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid]! <= o) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: o - this.lineStarts[lo]! };
  }

  offsetAt(position: Position): number {
    if (position.line < 0) return 0;
    if (position.line >= this.lineStarts.length) return this.text.length;
    const start = this.lineStarts[position.line]!;
    const next =
      position.line + 1 < this.lineStarts.length
        ? this.lineStarts[position.line + 1]!
        : this.text.length;
    return Math.max(start, Math.min(start + position.character, next));
  }

  rangeOf(span: Span): Range {
    return { start: this.positionAt(span.start), end: this.positionAt(span.end) };
  }

  spanOf(range: Range): Span {
    return { start: this.offsetAt(range.start), end: this.offsetAt(range.end) };
  }

  lineText(line: number): string {
    const start = this.lineStarts[line] ?? this.text.length;
    const end = line + 1 < this.lineStarts.length ? this.lineStarts[line + 1]! : this.text.length;
    return this.text.slice(start, end).replace(/\r?\n$/, "");
  }

  lineOf(offset: number): number {
    return this.positionAt(offset).line;
  }
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) starts.push(i + 1);
    else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    }
  }
  return starts;
}

/** Extends a span leftwards over spaces and tabs (for edits that delete it). */
export function widenLeft(file: SourceFile, span: Span): Span {
  let start = span.start;
  while (start > 0 && (file.text[start - 1] === " " || file.text[start - 1] === "\t")) start--;
  return { start, end: span.end };
}
