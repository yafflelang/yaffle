/**
 * Runs the Python unit test suites: the runtime (packages/runtime-python/tests) and the Python
 * externs (conformance/externs/python).
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runtimePackageRoot } from "../../../src/backends/python/index.ts";
import { runPython } from "../../../src/backends/python/python.ts";
import { HAVE_PYTHON, REPO } from "./harness.ts";

async function unittest(dir: string): Promise<string> {
  const r = await runPython(["-m", "unittest", "discover", "-s", dir, "-v"], {
    pythonPath: [runtimePackageRoot()],
    cwd: dir
  });
  expect(r.code, r.stderr).toBe(0);
  return r.stderr;
}

describe.skipIf(!HAVE_PYTHON)("Python unit tests", () => {
  it("yaffle_runtime", async () => {
    const out = await unittest(join(runtimePackageRoot(), "tests"));
    expect(out).toMatch(/Ran \d+ tests/);
  });
  it("conformance externs", async () => {
    expect(await unittest(join(REPO, "conformance/externs/python"))).toMatch(/OK/);
  });
});
