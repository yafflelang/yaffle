/**
 * Canonical JSON comparison (docs/CONFORMANCE.md §3): exact deep equality, with object key order
 * significant (fields come in declaration order) and readable path-based diffs.
 */

export interface JsonDifference {
  /** JSON Pointer of the differing value. */
  pointer: string;
  kind: "value" | "type" | "missing" | "extra" | "length" | "order";
  expected?: unknown;
  actual?: unknown;
  note?: string;
}

/** Escapes one JSON Pointer token (RFC 6901). */
export function escapePointerToken(token: string | number): string {
  return String(token).replace(/~/g, "~0").replace(/\//g, "~1");
}

export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`JSON Pointer must start with "/": ${pointer}`);
  return pointer
    .slice(1)
    .split("/")
    .map(t => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** Resolves a JSON Pointer. Returns { found: false } if any step is missing. */
export function getPointer(doc: unknown, pointer: string): { found: boolean; value?: unknown } {
  let cur: unknown = doc;
  for (const token of parsePointer(pointer)) {
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return { found: false };
      const i = Number(token);
      if (i >= cur.length) return { found: false };
      cur = cur[i];
    } else if (cur !== null && typeof cur === "object" && Object.hasOwn(cur, token)) {
      cur = (cur as Record<string, unknown>)[token];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: cur };
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Compares two canonical JSON values. Returns every difference found (up to `limit`). */
export function diffJson(expected: unknown, actual: unknown, limit = 20): JsonDifference[] {
  const out: JsonDifference[] = [];
  const add = (d: JsonDifference) => {
    if (out.length < limit) out.push(d);
  };
  const walk = (e: unknown, a: unknown, ptr: string): void => {
    if (out.length >= limit) return;
    const te = typeName(e);
    const ta = typeName(a);
    if (te !== ta) {
      add({ pointer: ptr, kind: "type", expected: e, actual: a, note: `${te} vs ${ta}` });
    } else if (te === "array") {
      const ea = e as unknown[];
      const aa = a as unknown[];
      if (ea.length !== aa.length) {
        const note = `array length ${ea.length} vs ${aa.length}`;
        add({ pointer: ptr, kind: "length", expected: ea.length, actual: aa.length, note });
      }
      for (let i = 0; i < Math.min(ea.length, aa.length); i++) walk(ea[i], aa[i], `${ptr}/${i}`);
    } else if (te === "object") {
      const eo = e as Record<string, unknown>;
      const ao = a as Record<string, unknown>;
      const at = (k: string) => `${ptr}/${escapePointerToken(k)}`;
      const common = Object.keys(eo).filter(k => Object.hasOwn(ao, k));
      const commonActual = Object.keys(ao).filter(k => Object.hasOwn(eo, k));
      for (const k of Object.keys(eo))
        if (!Object.hasOwn(ao, k)) add({ pointer: at(k), kind: "missing", expected: eo[k] });
      for (const k of Object.keys(ao))
        if (!Object.hasOwn(eo, k)) add({ pointer: at(k), kind: "extra", actual: ao[k] });
      for (const k of common) walk(eo[k], ao[k], at(k));
      if (common.join("\u0000") !== commonActual.join("\u0000")) {
        const note = "fields are not in declaration order";
        add({ pointer: ptr, kind: "order", expected: common, actual: commonActual, note });
      }
    } else if (!Object.is(e, a)) {
      // Object.is distinguishes 0 and -0 (canonical JSON writes -0 as the string "-0").
      add({ pointer: ptr, kind: "value", expected: e, actual: a });
    }
  };
  walk(expected, actual, "");
  return out;
}

export function jsonEqual(expected: unknown, actual: unknown): boolean {
  return diffJson(expected, actual, 1).length === 0;
}

function show(v: unknown): string {
  const s = Object.is(v, -0) ? "-0 (number)" : (JSON.stringify(v) ?? String(v));
  return s.length > 120 ? `${s.slice(0, 120)}… (${s.length} chars)` : s;
}

export function formatDifferences(diffs: JsonDifference[]): string {
  return diffs
    .map(d => {
      const at = d.pointer === "" ? "(root)" : d.pointer;
      switch (d.kind) {
        case "missing":
          return `${at}: missing (expected ${show(d.expected)})`;
        case "extra":
          return `${at}: unexpected field (got ${show(d.actual)})`;
        case "order":
          return `${at}: ${d.note}: expected [${(d.expected as string[]).join(", ")}], got [${(d.actual as string[]).join(", ")}]`;
        case "length":
        case "type":
          return `${at}: ${d.note}; expected ${show(d.expected)}, got ${show(d.actual)}`;
        default:
          return `${at}: expected ${show(d.expected)}, got ${show(d.actual)}`;
      }
    })
    .join("\n");
}
