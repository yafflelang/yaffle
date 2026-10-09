/** Runs the C++ runtime's own unit tests (packages/runtime-cpp/test). */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runtimeDir } from "../../../src/backends/cpp/index.ts";
import {
  CXX_FLAGS,
  cacheDir,
  runtimeArchive,
  runCommand
} from "../../../src/backends/cpp/toolchain.ts";
import { toolchain } from "./harness.ts";

describe.skipIf(!toolchain)("C++ runtime", () => {
  it("passes its unit tests", { timeout: 600_000 }, async () => {
    const tc = toolchain!;
    const lib = await runtimeArchive(tc, "-O1");
    const dir = join(cacheDir(), "tests", "runtime");
    mkdirSync(dir, { recursive: true });
    const exe = join(dir, `runtime_test.${process.pid}`);
    await runCommand(tc.cxx, [
      ...CXX_FLAGS,
      "-O1",
      "-I",
      join(runtimeDir(), "include"),
      join(runtimeDir(), "test", "runtime_test.cpp"),
      lib,
      "-o",
      exe
    ]);
    const out = await new Promise<string>((resolve, reject) =>
      execFile(exe, [], (err, stdout) =>
        err ? reject(new Error(stdout || err.message)) : resolve(stdout)
      )
    );
    expect(out).toMatch(/\d+ tests, 0 failed/);
  });
});
