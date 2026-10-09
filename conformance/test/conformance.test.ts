/**
 * Runs every conformance case on every available backend (docs/CONFORMANCE.md).
 *
 * One test per (target, case directory, case). A case directory is compiled once and run per
 * target in a beforeAll. Cases skip (with the reason) when a toolchain is missing, and in view mode
 * when they are serialize-only.
 *
 * Filters: YAFFLE_CONFORMANCE_FILTER, YAFFLE_CONFORMANCE_TARGETS (see conformance/src/filter.ts).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { planConformance, runDir, selectedCases, type DirOutcome } from "../src/runner.ts";

const plan = await planConformance();

describe("case directories", () => {
  it("exist", () => {
    expect(plan.dirs.length).toBeGreaterThan(0);
  });
  for (const dir of plan.dirs) {
    it(`${dir.id} is well-formed`, () => {
      expect(dir.problems, dir.problems.join("\n")).toEqual([]);
    });
  }
});

describe("backend adapters", () => {
  if (plan.adapters.length === 0) {
    it.skip("none found at packages/compiler/src/backends/<target>/conformance.ts", () => {});
  }
  for (const a of plan.adapters) {
    it(`${a.target} loads`, ctx => {
      if (a.unavailable !== undefined && /toolchain not available/.test(a.unavailable))
        ctx.skip(a.unavailable);
      expect(a.unavailable, a.unavailable).toBeUndefined();
    });
  }
});

for (const target of plan.adapters) {
  describe(target.target, () => {
    for (const dir of plan.dirs) {
      const cases = selectedCases(plan, dir);
      if (cases.length === 0) continue;
      describe(dir.id, () => {
        let outcome: DirOutcome | undefined;
        beforeAll(async () => {
          outcome = await runDir(plan, dir, target);
        }, 900_000);
        for (const c of cases) {
          it(c.name, ctx => {
            const o = outcome?.cases.find(x => x.name === c.name);
            if (o === undefined) expect.fail("no outcome (the directory run failed)");
            if (o.status === "skip") ctx.skip(o.message);
            if (o.status === "fail") expect.fail(o.message ?? "failed");
          });
        }
      });
    }
  });
}
