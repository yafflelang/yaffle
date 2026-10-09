import type { IrProgram } from "yaffle/ir";

/**
 * The conformance contract between the runner (conformance/src) and every backend's adapter
 * (packages/compiler/src/backends/<target>/conformance.ts). See docs/CONFORMANCE.md.
 */

/** Error codes, docs/CONFORMANCE.md §4. */
export const ERROR_CODES = [
  "EOF",
  "CHECK",
  "RANGE",
  "UNION",
  "CODEC",
  "INPUT",
  "DERIVE",
  "REF",
  "OVERLAP"
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Bytes of a case: a hex string, or a file. See docs/CONFORMANCE.md §2. */
export type CaseBytes =
  | string
  | {
      /**
       * In cases.json: relative to the case directory.
       * What adapters receive: always an absolute path (the runner resolves it, and writes slices
       * to a scratch file).
       */
      file: string;
      /** Runner only: start of a slice of the file. Adapters never see it. */
      offset?: number;
      /** Runner only: length of a slice of the file. Adapters never see it. */
      length?: number;
    };

/** A check the runner applies to the actual canonical JSON of a parse case. */
export interface JsonExpectation {
  /** JSON Pointer (RFC 6901) into the actual JSON. "" is the whole document. */
  pointer: string;
  /** Deep-equal to this canonical JSON value. */
  equals?: unknown;
  /** The value is an array (or string) of this length. */
  length?: number;
  /** The value is a hex string of this many bytes. */
  byteLength?: number;
  /** The value is a string starting with this prefix (e.g. the first bytes of a hex blob). */
  startsWith?: string;
}

/**
 * How a parse case is round-tripped (docs/CONFORMANCE.md §2):
 * - `true` / `"json"`: serialize(fromJson(json)) must equal the input bytes, where `json` is the
 *   actual canonical JSON (which equals the expected JSON when the case has one).
 * - `"value"`: serialize(parse(bytes)) must equal the input bytes, in the same process, so codec
 *   reuse (IR.md §3.6) applies.
 * - `false`: no round trip.
 */
export type RoundTrip = boolean | "json" | "value";

/** One entry of a case directory's cases.json. See docs/CONFORMANCE.md §2. */
export interface Case {
  name: string;
  /** The exported struct to parse or serialize. */
  root: string;
  /** Root parameters, canonical JSON (explicit, bound without `$`, and `endian`). */
  args?: Record<string, unknown>;
  /** Hex string, or a file. Adapters always get hex or an absolute path. */
  bytes?: CaseBytes;
  /** Expected canonical JSON of the parse result. */
  json?: unknown;
  /** Serialize-only case: canonical JSON input. */
  input?: unknown;
  /** Default true for parse cases. */
  roundtrip?: RoundTrip;
  /** Parse (and serialize) in strict mode. */
  strict?: boolean;
  error?: { phase: "parse" | "serialize"; code: ErrorCode | string; path?: (string | number)[] };
  /** Runner only: checks on the actual JSON (for large inputs, instead of `json`). */
  expect?: JsonExpectation[];
  /** Free text, ignored by adapters. */
  description?: string;
}

/** Details of an error an adapter observed (thrown by generated code). */
export interface CaseError {
  phase: "parse" | "serialize";
  code: string;
  path?: (string | number)[];
  offset?: number;
  message?: string;
}

export interface CaseResult {
  name: string;
  /** The adapter's own verdict. The runner re-checks `json`, `bytes` and `error` when present. */
  ok: boolean;
  /** Why it failed (diff, error message). */
  message?: string;
  /**
   * Set when the adapter cannot run this case at all (a feature its target doesn't support yet).
   * The runner reports the case as skipped with this reason, whatever `ok` says.
   */
  skipped?: string;
  /** Actual canonical JSON produced (parse cases). Adapters should always return it. */
  json?: unknown;
  /**
   * Actual bytes produced, as lowercase hex: the serialize output (serialize cases), or the round
   * trip output (parse cases). Adapters may leave it out when it would be huge (large file inputs),
   * and then only `ok` counts.
   */
  bytes?: string;
  /** The error raised, if any (expected or not). */
  error?: CaseError;
}

export interface AdapterRunInput {
  /** Absolute path of the case directory. */
  caseDir: string;
  /** IR of the case's schema.yfl, produced by the frontend. */
  program: IrProgram;
  /** The cases, normalized by the runner: hex without spaces, files as absolute paths. */
  cases: Case[];
  /** A scratch directory owned by this run (per target and case directory). */
  workDir: string;
  /**
   * Extern implementations for this adapter's target: extern name → absolute path of the host
   * module, from the case directory's yaffle.json (`targets.<target>.externs`, resolved relative
   * to that yaffle.json). Empty when the case directory has no yaffle.json. See
   * docs/CONFORMANCE.md §5 for the per-target conventions.
   */
  externs: Record<string, string>;
  /**
   * "parse" (default): the cases as written. "view" (only for adapters whose `capabilities.views`
   * is true, docs/CONFORMANCE.md §7): run every parse case through the target's lazy view instead.
   * - `json` is the canonical JSON read through the view (every field accessed through it).
   * - `bytes` is the output of committing the view with no edits.
   * - Errors are the ones reading through the view raises.
   * Serialize-only cases are not sent in view mode.
   */
  mode?: "parse" | "view";
}

/** Implemented by every backend at packages/compiler/src/backends/<target>/conformance.ts. */
export interface ConformanceAdapter {
  target: string;
  /** Optional features. `views: true` makes the runner also run every parse case in view mode. */
  capabilities?: { views?: boolean };
  /** Whether the target's toolchain is usable here (e.g. cargo via `nix shell`). */
  available(): Promise<boolean>;
  /**
   * Generate code for `program`, run every case, and return one result per case (same names).
   * Throwing an error whose message contains "not implemented" makes the runner skip the whole
   * case directory for this target; any other throw fails every case of the directory.
   */
  run(input: AdapterRunInput): Promise<CaseResult[]>;
}
