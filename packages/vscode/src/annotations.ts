/**
 * Rendering of decoded sample annotations (from `yaffle/decodeSample`) as end-of-line
 * decorations. Pure (no `vscode` import) so it can be unit tested.
 */
import type { LspRange, SampleAnnotationDto } from "@yaffle/lsp/protocol";

export interface RenderedAnnotation {
  uri: string;
  range: LspRange;
  /** Text shown after the field: `= 17`. */
  text: string;
  /** Markdown hover. */
  hover: string;
}

const MAX_VALUES = 4;
const MAX_TEXT = 80;
/** Rows in the hover table. */
const MAX_ROWS = 20;

function hex(n: number): string {
  return "0x" + n.toString(16);
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + "…" : text;
}

function rangeKey(uri: string, r: LspRange): string {
  return `${uri}#${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}`;
}

/**
 * Group annotations by field (a field inside an array element is annotated once per element)
 * and render one decoration per field.
 */
export function renderAnnotations(annotations: SampleAnnotationDto[]): RenderedAnnotation[] {
  const groups = new Map<string, SampleAnnotationDto[]>();
  for (const a of annotations) {
    const key = rangeKey(a.uri, a.range);
    const list = groups.get(key);
    if (list) list.push(a);
    else groups.set(key, [a]);
  }
  const out: RenderedAnnotation[] = [];
  for (const list of groups.values()) {
    const first = list[0]!;
    const values = list.slice(0, MAX_VALUES).map(a => a.value);
    const more = list.length > MAX_VALUES ? `, … (${list.length} values)` : "";
    const text = clip(`= ${values.join(", ")}${more}`);
    const rows = list
      .slice(0, MAX_ROWS)
      .map(
        a =>
          `| \`${a.value.replace(/[|`]/g, "\\$&")}\` | ${hex(a.offset)} (${a.offset}) | ${a.size} |`
      );
    const hover = [
      list.length === 1 ? `**${first.value}**` : `**${list.length} values**`,
      "",
      "| value | offset | size |",
      "|---|---|---|",
      ...rows,
      ...(list.length > MAX_ROWS ? ["| … | | |"] : [])
    ].join("\n");
    out.push({ uri: first.uri, range: first.range, text, hover });
  }
  return out;
}
