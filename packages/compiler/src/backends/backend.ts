import type { IrProgram } from "../ir/index.ts";

export interface GeneratedFile {
  /** Path relative to the output directory, forward slashes. */
  path: string;
  contents: string;
}

export interface BackendOptions {
  /**
   * Extern implementations: extern name → module/path for this target (yaffle.json
   * `targets.<lang>.externs`), already resolved relative to the output directory where needed.
   */
  externs: Record<string, string>;
  /** Inline the runtime into the output instead of importing it (no dependencies). */
  inlineRuntime?: boolean;
  /** Target-specific options from yaffle.json `targets.<lang>`. */
  targetOptions?: Record<string, unknown>;
}

export interface Backend {
  /** Target name used in yaffle.json and `--target`, e.g. "ts", "rust". */
  name: string;
  generate(program: IrProgram, options: BackendOptions): GeneratedFile[];
}
