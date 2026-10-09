/**
 * On-type alignment of `@` continuation lines (DESIGN.md, attributes): a line starting with `@`
 * continues the field above, and is conventionally aligned with that field's first postfix
 * attribute:
 *
 *     u64 offset   @align(8)
 *                  @padAfter(8)      ← typing `@` on a fresh line jumps here
 *
 * or, when the field's first line has no attribute, with its name (as the formatter does):
 *
 *     u32  version in (2..4)
 *          @padAfter(2)
 *
 * This is pure text layout (no language knowledge beyond strings and comments), so it lives in
 * the server rather than the language service.
 */

export interface AlignEdit {
  line: number;
  /** Replace characters [0, oldIndent) of the line with `newIndent`. */
  oldIndent: number;
  newIndent: string;
}

type GetLine = (line: number) => string | undefined;

function indentOf(text: string): string {
  return /^[ \t]*/.exec(text)![0];
}

/** Whether a line ends a block or a statement, so the next line can't continue it. */
function endsBlockOrStatement(text: string): boolean {
  return /[{};]\s*$/.test(text);
}

/** Index of the first `@` outside strings and comments that follows non-blank text, if any. */
function postfixAttributeColumn(text: string): number | undefined {
  let sawContent = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") return undefined;
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return undefined;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c) i += text[i] === "\\" ? 2 : 1;
      sawContent = true;
      continue;
    }
    if (c === "@") return sawContent ? i : undefined;
    if (c !== " " && c !== "\t") sawContent = true;
  }
  return undefined;
}

/**
 * Column of a field's name (`u32  version` → 7, `Record *recPtrs` → after the `*`), the formatter's
 * column for continuation lines of a field without attributes on its first line.
 */
function nameColumn(text: string): number | undefined {
  let i = indentOf(text).length;
  if (!/[A-Za-z_]/.test(text[i] ?? "")) return undefined;
  // the type: a dotted name with generic/struct arguments and array suffixes
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(" || c === "<" || c === "[") depth++;
    else if (c === ")" || c === ">" || c === "]") depth--;
    else if (depth === 0 && !/[A-Za-z0-9_.]/.test(c)) break;
  }
  while (text[i] === " " || text[i] === "\t") i++;
  if (text[i] === "*") i++;
  return /[A-Za-z_$]/.test(text[i] ?? "") ? i : undefined;
}

/**
 * Compute the re-indent for the line where `@` was just typed (`character` is just after the
 * `@`). Returns undefined when nothing should change.
 */
export function alignAttributeLine(
  getLine: GetLine,
  line: number,
  character: number
): AlignEdit | undefined {
  const current = getLine(line);
  if (current === undefined) return undefined;
  const typed = /^([ \t]*)@$/.exec(current.slice(0, character));
  if (!typed) return undefined;
  const indent = typed[1]!;

  // The field above, skipping blank lines and line comments.
  let prevLine = line - 1;
  let prev: string | undefined;
  for (; prevLine >= 0; prevLine--) {
    prev = getLine(prevLine);
    if (prev === undefined) return undefined;
    const t = prev.trim();
    if (t !== "" && !t.startsWith("//")) break;
  }
  if (prevLine < 0 || prev === undefined || endsBlockOrStatement(prev)) return undefined;

  const prevIndent = indentOf(prev);
  const column = prev.slice(prevIndent.length).startsWith("@")
    ? prevIndent.length
    : (postfixAttributeColumn(prev) ?? nameColumn(prev));
  if (column === undefined || column === indent.length) return undefined;
  const newIndent = prevIndent + " ".repeat(Math.max(0, column - prevIndent.length));
  if (newIndent === indent) return undefined;
  return { line, oldIndent: indent.length, newIndent };
}

/**
 * After Enter on an `@` continuation line, put the new line back at the field's indentation
 * (the next line is more often a new field than another attribute; typing `@` re-aligns it).
 *
 *     u64 offset   @align(8)
 *                  @padAfter(8)
 *     |                              ← the cursor lands here, not under `@padAfter`
 */
export function reindentAfterContinuation(getLine: GetLine, line: number): AlignEdit | undefined {
  const current = getLine(line);
  const prev = getLine(line - 1);
  if (current === undefined || prev === undefined) return undefined;
  const indent = indentOf(current);
  if (current.slice(indent.length).startsWith("@")) return undefined;
  if (!/^[ \t]*@/.test(prev) || /[{}]\s*$/.test(prev)) return undefined;
  // The field the continuation lines belong to: up past them and comments, not past a blank.
  let q = line - 2;
  for (; q >= 0; q--) {
    const text = getLine(q);
    if (text === undefined) return undefined;
    const t = text.trim();
    if (t === "") return undefined;
    if (!t.startsWith("@") && !t.startsWith("//")) break;
  }
  if (q < 0) return undefined;
  const field = getLine(q)!;
  if (endsBlockOrStatement(field)) return undefined;
  const newIndent = indentOf(field);
  if (newIndent === indent) return undefined;
  return { line, oldIndent: indent.length, newIndent };
}
