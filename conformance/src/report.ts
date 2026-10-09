/** Text reports: the pass/fail matrix (case directory × target), failures and a summary. */
import type { CaseOutcome, ConformanceReport, DirOutcome, Status } from "./runner.ts";

export type Counts = Record<Status, number>;

/** Failure messages longer than this many lines are cut. */
const MAX_FAILURE_LINES = 40;

const SYMBOL: Record<Status, string> = { pass: "✓", fail: "✗", skip: "~" };

export function count(cases: CaseOutcome[]): Counts {
  const c: Counts = { pass: 0, fail: 0, skip: 0 };
  for (const x of cases) c[x.status]++;
  return c;
}

function allCases(report: ConformanceReport): CaseOutcome[] {
  return report.dirs.flatMap(d => d.cases);
}

function firstLine(text: string): string {
  return text.split("\n")[0]!;
}

/** "12/12", "10/12 ✗2", "0/12 skip", "9/12 ✗1 ~2" (✗ failed, ~ skipped). */
export function cell(c: Counts): string {
  const total = c.pass + c.fail + c.skip;
  if (total === 0) return "-";
  if (c.skip === total) return "skip";
  let s = `${c.pass}/${total}`;
  if (c.fail > 0) s += ` ✗${c.fail}`;
  if (c.skip > 0) s += ` ~${c.skip}`;
  return s;
}

export function formatMatrix(report: ConformanceReport): string {
  const targets = report.targets.map(t => t.target);
  const cellOf = (dirs: DirOutcome[]) => cell(count(dirs.flatMap(d => d.cases)));
  const header = ["case directory", ...targets];
  const body = [...new Set(report.dirs.map(d => d.dir))].map(id => [
    id,
    ...targets.map(t => cellOf(report.dirs.filter(d => d.dir === id && d.target === t)))
  ]);
  const total = ["total", ...targets.map(t => cellOf(report.dirs.filter(d => d.target === t)))];
  const rows = [header, ...body, total];
  const widths = header.map((_, i) => Math.max(...rows.map(r => [...r[i]!].length)));
  const line = (r: string[]) =>
    r
      .map((s, i) => s + " ".repeat(widths[i]! - [...s].length))
      .join("  ")
      .trimEnd();
  const sep = widths.map(w => "-".repeat(w)).join("  ");
  return [line(header), sep, ...body.map(line), sep, line(total)].join("\n");
}

function formatFailures(report: ConformanceReport): string {
  return allCases(report)
    .filter(c => c.status === "fail")
    .map(c => {
      let lines = (c.message ?? "").split("\n");
      if (lines.length > MAX_FAILURE_LINES)
        lines = [
          ...lines.slice(0, MAX_FAILURE_LINES),
          `… ${lines.length - MAX_FAILURE_LINES} more lines`
        ];
      return `✗ [${c.target}] ${c.dir} › ${c.name}\n${lines.map(l => `    ${l}`).join("\n")}`;
    })
    .join("\n");
}

/** Groups skip reasons, so 400 cases skipped for the same reason print as one line. */
export function formatSkips(report: ConformanceReport): string {
  const reasons = new Map<string, number>();
  for (const c of allCases(report)) {
    if (c.status !== "skip") continue;
    const key = `[${c.target}] ${firstLine(c.message ?? "skipped")}`;
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  return [...reasons].map(([r, n]) => `~ ${n} × ${r}`).join("\n");
}

function formatCases(report: ConformanceReport): string {
  return allCases(report)
    .map(c => {
      const reason = c.status === "skip" && c.message ? ` (${firstLine(c.message)})` : "";
      return `${SYMBOL[c.status]} [${c.target}] ${c.dir} › ${c.name}${reason}`;
    })
    .join("\n");
}

export function formatSummary(report: ConformanceReport): string {
  const c = count(allCases(report));
  const n = report.targets.length;
  const names = report.targets.map(t => t.target).join(", ") || "none";
  let s = `conformance: ${c.pass} passed, ${c.fail} failed, ${c.skip} skipped (${n} target${n === 1 ? "" : "s"}: ${names})`;
  for (const t of report.targets)
    if (t.unavailable !== undefined) s += `\n  ${t.target}: ${t.unavailable}`;
  return s;
}

export function formatReport(report: ConformanceReport, opts: { verbose?: boolean } = {}): string {
  const sections = [
    report.targets.length === 0
      ? "No backend adapters found (packages/compiler/src/backends/<target>/conformance.ts)."
      : formatMatrix(report)
  ];
  if (opts.verbose) sections.push(formatCases(report));
  for (const optional of [formatFailures(report), formatSkips(report)])
    if (optional !== "") sections.push(optional);
  sections.push(formatSummary(report));
  return sections.join("\n\n");
}
