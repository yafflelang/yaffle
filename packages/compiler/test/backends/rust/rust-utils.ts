/** Helpers for the Rust backend tests: build a harness crate from fixtures and run operations. */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IrProgram } from "../../../src/ir/index.ts";
import {
  buildHarness,
  runOps,
  type HarnessModule,
  type Op,
  type OpResult
} from "../../../src/backends/rust/harness.ts";
import { rustPath } from "../../../src/backends/rust/toolchain.ts";

export const hasRust = await rustPath().then(
  p => p !== undefined,
  () => false
);

export function scratch(name: string): string {
  const dir = join(
    process.env["YAFFLE_RUST_TEST_DIR"] ?? join(tmpdir(), "yaffle-rust-tests"),
    name
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface Fixture {
  name: string;
  program: IrProgram;
  externs?: Record<string, string>;
  views?: boolean;
}

export interface Built {
  run(ops: Op[]): Promise<OpResult[]>;
  /** Runs one op and returns its value (throws on error). */
  value(op: Op): Promise<unknown>;
  /** Runs one op and returns its error (throws on success). */
  error(
    op: Op
  ): Promise<{ code: string; path: (string | number)[]; offset: number; message: string }>;
  bin: string;
  log: string;
  warnings: number;
}

export async function build(
  crateName: string,
  fixtures: Fixture[],
  o: { sources?: Record<string, string>; tests?: string; release?: boolean } = {}
): Promise<Built> {
  const modules: HarnessModule[] = fixtures.map(f => ({
    name: f.name,
    program: f.program,
    ...(f.externs ? { externs: f.externs } : {}),
    ...(f.views ? { views: true } : {})
  }));
  const spec = {
    dir: scratch(crateName),
    crateName,
    modules,
    ...(o.sources ? { sources: o.sources } : {}),
    ...(o.tests ? { tests: o.tests } : {})
  };
  const r = await buildHarness(spec, o.release ?? false);
  if (!r.ok) throw new Error(`cargo build failed:\n${r.log.slice(0, 20000)}`);
  const run = (ops: Op[]) => runOps(r.bin, ops);
  return {
    run,
    bin: r.bin,
    log: r.log,
    warnings: r.warnings,
    async value(op) {
      const [res] = await run([op]);
      if (!res) throw new Error("no result");
      if (!res.ok)
        throw new Error(
          `${op.op} failed: ${res.error.code} ${JSON.stringify(res.error.path)} ${res.error.message}`
        );
      return res.value;
    },
    async error(op) {
      const [res] = await run([op]);
      if (!res) throw new Error("no result");
      if (res.ok) throw new Error(`${op.op} succeeded: ${JSON.stringify(res.value)}`);
      return res.error;
    }
  };
}

export function hex(bytes: number[] | Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString("hex");
}
