/**
 * The corpus: every conformance case schema must compile without errors, and the IR must pass
 * the validator.
 */
import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.ts";
import { expectValidIr, fmt } from "../helpers.ts";
import { formatSource } from "../../src/frontend/format.ts";
import { readFileSync } from "node:fs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const files = [...globSync("conformance/cases/**/schema.yfl", { cwd: root })].sort();

describe("corpus: conformance schemas", () => {
  it("finds the corpus", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const f of files) {
    it(`compiles ${f}`, () => {
      const r = compile([root + f]);
      expect(r.diagnostics.filter(d => d.severity === "error").map(fmt)).toEqual([]);
      expect(r.program).toBeDefined();
      expectValidIr(r.program!);
      expect(r.program!.roots.length).toBeGreaterThan(0);
    });
  }

  it("formats every corpus file idempotently", () => {
    const all = [...globSync("conformance/cases/**/*.yfl", { cwd: root })];
    for (const f of all) {
      const text = readFileSync(root + f, "utf8");
      const once = formatSource(text);
      expect(once.formatted, f).toBe(true);
      expect(formatSource(once.text).text, f).toBe(once.text);
    }
  });
});
