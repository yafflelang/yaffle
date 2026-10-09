/** Go backend packaging: an inlined runtime (no dependency) and generation-time errors. */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateGo } from "../../../src/backends/go/index.ts";
import { runGo } from "../../../src/backends/go/conformance.ts";
import { ROOT, compileOk, hasGo } from "./harness.ts";

const SRC = `
export struct Point { u16 x  u16 y }
`;

describe("go: packaging", () => {
  it("needs runtimeModule to inline the runtime", () => {
    expect(() => generateGo(compileOk(SRC), { externs: {}, inlineRuntime: true })).toThrow(
      /runtimeModule/
    );
  });

  it("emits the runtime into yaffle/ with inlineRuntime", () => {
    const files = generateGo(compileOk(SRC), {
      externs: {},
      inlineRuntime: true,
      targetOptions: { package: "geo", runtimeModule: "example.com/tool/geo/yaffle" }
    });
    const paths = files.map(f => f.path);
    expect(paths).toContain("yaffle/reader.go");
    expect(paths.some(p => p.endsWith("_test.go"))).toBe(false);
    const main = files.find(f => f.path === "main.go")!.contents;
    expect(main).toMatch(/^package geo$/m);
    expect(main).toContain('"example.com/tool/geo/yaffle"');
  });

  (hasGo ? it : it.skip)("builds without any dependency when the runtime is inlined", async () => {
    const dir = join(ROOT, "packaging-inline");
    rmSync(dir, { recursive: true, force: true });
    const files = generateGo(compileOk(SRC), {
      externs: {},
      inlineRuntime: true,
      targetOptions: { package: "geo", runtimeModule: "example.com/tool/geo/yaffle" }
    });
    for (const f of files) {
      mkdirSync(join(dir, "geo", f.path, ".."), { recursive: true });
      writeFileSync(join(dir, "geo", f.path), f.contents);
    }
    writeFileSync(join(dir, "go.mod"), "module example.com/tool\n\ngo 1.22\n");
    writeFileSync(
      join(dir, "main.go"),
      `package main

import (
	"fmt"

	"example.com/tool/geo"
)

func main() {
	p, err := geo.ParsePoint([]byte{1, 0, 2, 0}, nil)
	if err != nil {
		panic(err)
	}
	fmt.Println(p.X, p.Y)
}
`
    );
    const r = await runGo(["run", "."], dir);
    expect(r.out.trim()).toBe("1 2");
  });
});
