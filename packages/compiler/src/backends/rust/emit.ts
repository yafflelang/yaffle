/** Indents a block of lines by one level (or `levels`). */
export function indent(lines: string[], levels = 1): string[] {
  const pad = "    ".repeat(levels);
  return lines.map(l => (l === "" ? l : pad + l));
}
