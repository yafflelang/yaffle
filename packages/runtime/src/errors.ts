/**
 * Errors. Every failure the runtime or generated code reports is a `YaffleError` with a stable
 * `code` (docs/CONFORMANCE.md §4), the `path` from the root (field names and array indices) and an
 * absolute byte `offset` (-1 on write).
 */

export type ErrorCode =
  "EOF" | "CHECK" | "RANGE" | "UNION" | "CODEC" | "INPUT" | "DERIVE" | "REF" | "OVERLAP";

export type PathSegment = string | number;

export class YaffleError extends Error {
  readonly code: ErrorCode;
  /** Field names and array indices from the root. Filled in while the error propagates. */
  readonly path: PathSegment[];
  /** Absolute byte offset for read errors, -1 for write errors. */
  offset: number;
  /** The message without path and offset decoration. */
  readonly detail: string;
  /** For `UNION` errors: the error of every variant, in order. */
  readonly causes: YaffleError[] | undefined;
  /** The path is complete (set by the writer for errors after layout, which know their path). */
  sealed = false;

  constructor(
    code: ErrorCode,
    detail: string,
    offset = -1,
    path: PathSegment[] = [],
    causes?: YaffleError[]
  ) {
    super(detail);
    this.name = "YaffleError";
    this.code = code;
    this.detail = detail;
    this.offset = offset;
    this.path = path;
    this.causes = causes;
    this.message = this.describe();
  }

  /** Renders `CODE at a.b[3] (offset 0x10): detail`. */
  describe(): string {
    const where = this.path.length ? ` at ${formatPath(this.path)}` : "";
    const off = this.offset >= 0 ? ` (offset 0x${this.offset.toString(16)})` : "";
    return `${this.code}${where}${off}: ${this.detail}`;
  }

  /** Adds an outer path segment (used while unwinding through generated code). */
  prefix(...segments: PathSegment[]): this {
    if (this.sealed) return this;
    this.path.unshift(...segments);
    this.message = this.describe();
    return this;
  }
}

export function formatPath(path: readonly PathSegment[]): string {
  let s = "";
  for (const seg of path) {
    if (typeof seg === "number") s += `[${seg}]`;
    else s += s ? `.${seg}` : seg;
  }
  return s;
}

/** Throws a `YaffleError`. */
export function fail(code: ErrorCode, detail: string, offset = -1): never {
  throw new YaffleError(code, detail, offset);
}

/** Drops the placeholders generated code passes for "no segment": "" and negative indices. */
export function cleanPath(segments: readonly PathSegment[]): PathSegment[] {
  return segments.filter(s => (typeof s === "number" ? s >= 0 : s !== ""));
}

/**
 * Re-throws `e` with path segments prepended when it is a `YaffleError`. Anything else (host
 * exceptions, internal control-flow signals such as `NeedBytes`) passes through unchanged.
 */
export function rethrowAt(e: unknown, ...segments: PathSegment[]): never {
  if (e instanceof YaffleError) e.prefix(...cleanPath(segments));
  throw e;
}

/** Re-throws `e` with its complete path from the root (no further prefixes are added). */
export function rethrowWithPath(e: unknown, path: readonly PathSegment[]): never {
  if (e instanceof YaffleError && !e.sealed) {
    e.prefix(...cleanPath(path));
    e.sealed = true;
  }
  throw e;
}

/** Wraps a host failure (codec, extern) as a `YaffleError` unless it already is one or a control signal. */
export function wrapHostError(e: unknown, code: ErrorCode, what: string, offset = -1): never {
  if (e instanceof YaffleError || isControlSignal(e)) throw e;
  const msg = e instanceof Error ? e.message : String(e);
  throw new YaffleError(code, `${what}: ${msg}`, offset);
}

/** Marks internal control-flow exceptions, which must never be converted into YaffleErrors. */
export const CONTROL = Symbol.for("yaffle.control");

export function isControlSignal(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { [CONTROL]?: boolean })[CONTROL] === true;
}

export type SafeResult<T> = { ok: true; value: T } | { ok: false; error: YaffleError };

/** Runs `fn` and converts a thrown `YaffleError` into `{ ok: false, error }`. */
export function safe<T>(fn: () => T): SafeResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return failure(e);
  }
}

export async function safeAsync<T>(fn: () => Promise<T>): Promise<SafeResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return failure(e);
  }
}

function failure(e: unknown): { ok: false; error: YaffleError } {
  if (e instanceof YaffleError) return { ok: false, error: e };
  throw e;
}
