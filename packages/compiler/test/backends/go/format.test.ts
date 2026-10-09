/**
 * Go backend: the output is gofmt-stable and go vet clean. The formatter's spacing rules are
 * checked without a toolchain; the conformance schemas are run through gofmt and go vet when one is
 * available.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../../../src/index.ts";
import { gofmt } from "../../../src/backends/go/gofmt.ts";
import { harnessSource } from "../../../src/backends/go/harness.ts";
import { generateGoWithInfo } from "../../../src/backends/go/index.ts";
import { gofmtList, hasGo, makeModule, vet } from "./harness.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(here, "../../../../..");

function fmtBody(body: string): string {
  const src = `package p\n\nfunc f() {\n${body
    .split("\n")
    .map(l => `\t${l}`)
    .join("\n")}\n}\n`;
  const out = gofmt(src);
  return out
    .split("\n")
    .slice(3, -2)
    .map(l => l.replace(/^\t/, ""))
    .join("\n");
}

describe("go: gofmt emulation", () => {
  it("spaces binary operators like go/printer", () => {
    expect(fmtBody("x := (a + b)")).toBe("x := (a + b)");
    expect(fmtBody("x := h((a + b), 2)")).toBe("x := h((a + b), 2)");
    expect(fmtBody("x := h(a + b, c * 2)")).toBe("x := h(a+b, c*2)");
    expect(fmtBody("x := h1(a + b)")).toBe("x := h1(a + b)");
    expect(fmtBody("if r.Strict && ((u >> 4) & 15) != 0 {\n}")).toBe(
      "if r.Strict && ((u>>4)&15) != 0 {\n}"
    );
    expect(fmtBody('k := f(r, "A(" + x + ")")')).toBe('k := f(r, "A("+x+")")');
    expect(fmtBody("x := a*b + c")).toBe("x := a*b + c");
    expect(fmtBody("x := a + b + c")).toBe("x := a + b + c");
    expect(fmtBody("x := v[(a + 1)]")).toBe("x := v[(a + 1)]");
    expect(fmtBody("x := v[a + 1]")).toBe("x := v[a+1]");
    expect(fmtBody("x := T{A: a + 1, B: f(b + 1, 2)}")).toBe("x := T{A: a + 1, B: f(b+1, 2)}");
    expect(fmtBody("x := a - -b")).toBe("x := a - -b");
  });

  it("breaks one-line func literals that gofmt would break", () => {
    const long = `w.F(func() []byte { return w.EncodeAlone(func() yaffle.LEntry { return writeSomethingQuiteLong(w, value, endian) }) })`;
    expect(fmtBody(long)).toBe(
      [
        "w.F(func() []byte {",
        "\treturn w.EncodeAlone(func() yaffle.LEntry { return writeSomethingQuiteLong(w, value, endian) })",
        "})"
      ].join("\n")
    );
    expect(fmtBody("f(func() int { return 1 })")).toBe("f(func() int { return 1 })");
  });
});

const caseDirs = (): string[] => {
  const out: string[] = [];
  for (const sub of ["cases"]) {
    const root = join(REPO, "conformance", sub);
    for (const d of readdirSync(root)) out.push(join(root, d));
  }
  return out;
};

/** The Go externs of a case directory (yaffle.json `targets.go.externs`, paths resolved). */
function caseExterns(dir: string): Record<string, string> {
  const externs: Record<string, string> = {};
  const cfg = join(dir, "yaffle.json");
  if (!existsSync(cfg)) return externs;
  const j = JSON.parse(readFileSync(cfg, "utf8")) as {
    targets?: { go?: { externs?: Record<string, string> } };
  };
  for (const [k, v] of Object.entries(j.targets?.go?.externs ?? {})) externs[k] = resolve(dir, v);
  return externs;
}

const d = hasGo ? describe : describe.skip;

d("go: generated code for every conformance schema", () => {
  it("is gofmt-stable", async () => {
    const bad: string[] = [];
    for (const dir of caseDirs()) {
      const r = compile([join(dir, "schema.yfl")]);
      if (!r.program) continue;
      const externs = caseExterns(dir);
      // With the view-mode materializers: a superset of the default output.
      const targetOptions = { package: "gen", materialize: true };
      const gen = generateGoWithInfo(r.program, { externs, targetOptions });
      const name = `fmt-${dir.split("/").slice(-2).join("-")}`;
      const mod = makeModule(name, r.program, {
        externs,
        targetOptions,
        files: { "main.go": harnessSource(gen.roots, "yafflecase/gen") }
      });
      const list = (await gofmtList(mod.dir)).trim();
      if (list) bad.push(`${name}: ${list}`);
    }
    expect(bad).toEqual([]);
  }, 300_000);

  it("is go vet clean", async () => {
    for (const area of [
      "cases/layout",
      "cases/layout-fields",
      "cases/streams",
      "cases/generics",
      "cases/bitfields"
    ]) {
      const dir = join(REPO, "conformance", area);
      const r = compile([join(dir, "schema.yfl")]);
      const mod = makeModule(`vet-${area.replace("/", "-")}`, r.program!, {
        externs: caseExterns(dir),
        targetOptions: { materialize: true }
      });
      expect(await vet(mod), area).toBe("");
    }
  }, 300_000);
});
