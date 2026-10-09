/**
 * Case and target selection from the environment:
 *
 * - `YAFFLE_CONFORMANCE_FILTER`: comma-separated patterns matched against `<dir>/<case name>`
 *   (e.g. `primitives/u24 max`, `streams`). A pattern with `*` is a glob (`*` = any run of
 *   characters); otherwise it matches as a substring. A leading `!` excludes. A case runs if it
 *   matches at least one include pattern (or there are none) and no exclude pattern.
 * - `YAFFLE_CONFORMANCE_TARGETS`: comma-separated target names (e.g. `ts,rust`).
 */

export interface CaseFilter {
  include: string[];
  exclude: string[];
}

function split(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(s => s !== "");
}

export function parseFilter(value: string | undefined): CaseFilter {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const p of split(value)) {
    if (p.startsWith("!")) {
      if (p.length > 1) exclude.push(p.slice(1));
    } else include.push(p);
  }
  return { include, exclude };
}

export function parseTargets(value: string | undefined): string[] | undefined {
  const t = split(value);
  return t.length === 0 ? undefined : t;
}

function globToRegExp(glob: string): RegExp {
  const body = glob
    .split("*")
    .map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

export function matchPattern(pattern: string, subject: string): boolean {
  if (pattern.includes("*")) return globToRegExp(pattern).test(subject);
  return subject.includes(pattern);
}

export function caseSelected(filter: CaseFilter, dirId: string, caseName: string): boolean {
  const subject = `${dirId}/${caseName}`;
  if (filter.exclude.some(p => matchPattern(p, subject) || matchPattern(p, dirId))) return false;
  if (filter.include.length === 0) return true;
  return filter.include.some(
    p => matchPattern(p, subject) || (p.includes("*") && matchPattern(p, dirId))
  );
}
