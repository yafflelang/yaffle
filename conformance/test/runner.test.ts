/** Tests of the runner itself, with fake adapters and temporary case directories. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Case, CaseResult } from "../src/adapter.ts";
import { loadAdapters, loadCompiler, main, parseArgs } from "../src/cli.ts";
import {
  checkAvailable,
  discoverAdapters,
  findAdapterModules,
  loadAdapter,
  type DiscoveredAdapter
} from "../src/discover.ts";
import {
  cell,
  count,
  formatMatrix,
  formatReport,
  formatSkips,
  formatSummary
} from "../src/report.ts";
import {
  checkExpectations,
  isNotImplemented,
  judgeCase,
  planConformance,
  runConformance,
  runDir,
  runPlan,
  type CompileFn,
  type RunnerOptions
} from "../src/runner.ts";
import { fakeAdapter, makeCaseRoot, okCompile, perfectResult, tempDir } from "./fake.ts";

const BASIC = [
  { name: "parse", root: "A", bytes: "01", json: { x: 1 } },
  { name: "serialize", root: "A", input: { x: 2 }, bytes: "02" },
  { name: "error", root: "A", bytes: "", error: { phase: "parse", code: "EOF", path: ["x"] } },
  { name: "no roundtrip", root: "A", bytes: "ff", json: { x: 255 }, roundtrip: false }
];

function adapters(...a: ReturnType<typeof fakeAdapter>[]): DiscoveredAdapter[] {
  return a.map(x => ({ target: x.target, module: "(fake)", adapter: x }));
}

/** Runner options for a temporary case root, with no environment and an ok compiler. */
function options(root: string, extra: Partial<RunnerOptions> = {}): RunnerOptions {
  return {
    repoRoot: root,
    caseRoots: [{ path: root, prefix: "" }],
    compile: okCompile,
    env: {},
    workRoot: join(root, ".out"),
    ...extra
  };
}

async function run(opts: {
  cases?: unknown;
  dirs?: Parameters<typeof makeCaseRoot>[0];
  adapter?: ReturnType<typeof fakeAdapter>;
  compile?: CompileFn;
  env?: Record<string, string>;
}) {
  const root = makeCaseRoot(opts.dirs ?? { d: { cases: opts.cases ?? BASIC } });
  const adapter = opts.adapter ?? fakeAdapter("fake");
  const report = await runConformance(
    options(root, {
      adapters: adapters(adapter),
      compile: opts.compile ?? okCompile,
      env: opts.env ?? {}
    })
  );
  const byName = Object.fromEntries(report.dirs.flatMap(d => d.cases).map(c => [c.name, c]));
  return { report, byName, adapter, root };
}

describe("runner", () => {
  it("passes every case with a perfect adapter", async () => {
    const { report, adapter } = await run({});
    expect(count(report.dirs[0]!.cases)).toEqual({ pass: 4, fail: 0, skip: 0 });
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.cases.map(c => c.name)).toEqual([
      "parse",
      "serialize",
      "error",
      "no roundtrip"
    ]);
    expect(adapter.calls[0]!.externs).toEqual({});
  });

  it("skips everything while compile() is not implemented", async () => {
    const { byName, adapter } = await run({
      compile: () => {
        throw new Error("compile not implemented yet");
      }
    });
    expect(byName.parse!.status).toBe("skip");
    expect(byName.parse!.message).toMatch(/not implemented/);
    expect(adapter.calls).toHaveLength(0);
  });

  it("fails cases when the schema has errors", async () => {
    const { byName } = await run({
      compile: () => ({
        diagnostics: [
          {
            severity: "error",
            code: "unknown-name",
            message: "unknown type Foo",
            path: "/x/schema.yfl",
            range: { start: { line: 2, character: 4 } }
          }
        ]
      })
    });
    expect(byName.parse!.status).toBe("fail");
    expect(byName.parse!.message).toContain("/x/schema.yfl:3:5: unknown-name: unknown type Foo");
  });

  it("skips when the frontend reports unsupported features", async () => {
    const { byName } = await run({
      compile: () => ({
        diagnostics: [{ severity: "error", code: "not-implemented", message: "bitfields" }]
      })
    });
    expect(byName.parse!.status).toBe("skip");
  });

  it("fails when compile() throws something else", async () => {
    const { byName } = await run({
      compile: () => {
        throw new Error("kaboom");
      }
    });
    expect(byName.parse!.status).toBe("fail");
    expect(byName.parse!.message).toMatch(/kaboom/);
  });

  it("compiles each directory once for all targets", async () => {
    const root = makeCaseRoot({ d: { cases: BASIC } });
    let compiles = 0;
    const report = await runConformance(
      options(root, {
        caseRoots: [{ path: root, prefix: "x" }],
        adapters: adapters(fakeAdapter("one"), fakeAdapter("two")),
        compile: files => {
          compiles++;
          expect(files).toEqual([join(root, "d", "schema.yfl")]);
          return okCompile(files);
        }
      })
    );
    expect(compiles).toBe(1);
    expect(report.dirs.map(d => `${d.target}:${d.dir}`)).toEqual(["one:x/d", "two:x/d"]);
  });

  it("skips unavailable adapters and adapters that are not implemented", async () => {
    const root = makeCaseRoot({ d: { cases: BASIC } });
    const report = await runConformance(
      options(root, {
        adapters: [
          { target: "gone", module: "(fake)", unavailable: "gone: toolchain not available" },
          ...adapters(
            fakeAdapter("lazy", undefined, { throws: new Error("ts backend not implemented yet") })
          )
        ]
      })
    );
    const statuses = report.dirs.flatMap(d => d.cases.map(c => `${c.target}:${c.status}`));
    expect(new Set(statuses)).toEqual(new Set(["gone:skip", "lazy:skip"]));
    expect(report.targets).toEqual([
      { target: "gone", unavailable: "gone: toolchain not available" },
      { target: "lazy" }
    ]);
  });

  it("fails every case when the adapter crashes", async () => {
    const { byName } = await run({
      adapter: fakeAdapter("bad", undefined, { throws: new TypeError("x is undefined") })
    });
    expect(byName.parse!.status).toBe("fail");
    expect(byName.parse!.message).toMatch(/adapter.run threw/);
  });

  it("fails cases without a result and skips cases the adapter skips", async () => {
    const { byName } = await run({
      adapter: fakeAdapter("f", c =>
        c.name === "parse"
          ? undefined
          : c.name === "error"
            ? { name: c.name, ok: false, skipped: "async not supported" }
            : perfectResult(c)
      )
    });
    expect(byName.parse!.status).toBe("fail");
    expect(byName.parse!.message).toMatch(/no result/);
    expect(byName.error!.status).toBe("skip");
    expect(byName.error!.message).toBe("async not supported");
    expect(byName.serialize!.status).toBe("pass");
  });

  it("re-checks the JSON and shows a diff", async () => {
    const { byName } = await run({
      adapter: fakeAdapter("f", c =>
        c.name === "parse"
          ? { name: c.name, ok: true, json: { x: 2 }, bytes: "01" }
          : perfectResult(c)
      )
    });
    expect(byName.parse!.status).toBe("fail");
    expect(byName.parse!.message).toContain("/x: expected 1, got 2");
  });

  it("re-checks serialized bytes and round trips", async () => {
    const { byName } = await run({
      adapter: fakeAdapter("f", c =>
        c.name === "serialize"
          ? { name: c.name, ok: true, bytes: "03" }
          : c.name === "parse"
            ? { name: c.name, ok: true, json: { x: 1 }, bytes: "0100" }
            : perfectResult(c)
      )
    });
    expect(byName.serialize!.message).toContain("bytes differ at offset 0");
    expect(byName.parse!.message).toMatch(/round trip .*serialize\(fromJson\(json\)\)/);
    expect(byName.parse!.message).toContain("expected 1 bytes, got 2");
  });

  it("does not check round trips that are turned off", async () => {
    const { byName } = await run({
      adapter: fakeAdapter("f", c => ({ ...perfectResult(c), bytes: "00" }))
    });
    expect(byName["no roundtrip"]!.status).toBe("pass");
  });

  it("checks error codes and paths", async () => {
    const wrongCode = await run({
      adapter: fakeAdapter("f", c =>
        c.error
          ? { name: c.name, ok: true, error: { phase: "parse", code: "CHECK", path: ["x"] } }
          : perfectResult(c)
      )
    });
    expect(wrongCode.byName.error!.status).toBe("fail");
    expect(wrongCode.byName.error!.message).toContain(
      "expected parse error EOF, got parse error CHECK at x"
    );
    const wrongPath = await run({
      adapter: fakeAdapter("f", c =>
        c.error
          ? { name: c.name, ok: true, error: { phase: "parse", code: "EOF", path: ["y", 0] } }
          : perfectResult(c)
      )
    });
    expect(wrongPath.byName.error!.message).toContain("expected the error at [x], got [y, 0]");
    const succeeded = await run({
      adapter: fakeAdapter("f", c =>
        c.error ? { name: c.name, ok: false, json: { x: 1 } } : perfectResult(c)
      )
    });
    expect(succeeded.byName.error!.message).toContain("but it succeeded");
    const unexpected = await run({
      adapter: fakeAdapter("f", c =>
        c.name === "parse"
          ? { name: c.name, ok: false, error: { phase: "parse", code: "EOF", path: [], offset: 1 } }
          : perfectResult(c)
      )
    });
    expect(unexpected.byName.parse!.message).toContain("unexpected parse error EOF (offset 1)");
  });

  it("trusts the adapter's verdict when it gives no details", async () => {
    const { byName } = await run({
      adapter: fakeAdapter("f", c => ({
        name: c.name,
        ok: c.name !== "serialize",
        message: "nope"
      }))
    });
    expect(byName.parse!.status).toBe("pass");
    expect(byName.error!.status).toBe("pass");
    expect(byName.serialize!.status).toBe("fail");
    expect(byName.serialize!.message).toBe("nope");
  });

  it("applies the filter from the environment", async () => {
    const { report, adapter } = await run({
      env: { YAFFLE_CONFORMANCE_FILTER: "d/parse,d/error" }
    });
    expect(report.dirs[0]!.cases.map(c => c.name)).toEqual(["parse", "error"]);
    expect(adapter.calls[0]!.cases.map(c => c.name)).toEqual(["parse", "error"]);
    const none = await run({ env: { YAFFLE_CONFORMANCE_FILTER: "nothing-matches" } });
    expect(none.report.dirs).toEqual([]);
  });

  it("restricts targets from the environment", async () => {
    const root = makeCaseRoot({ d: { cases: BASIC } });
    const plan = await planConformance(
      options(root, {
        adapters: adapters(fakeAdapter("ts"), fakeAdapter("rust")),
        env: { YAFFLE_CONFORMANCE_TARGETS: "rust" }
      })
    );
    expect(plan.adapters.map(a => a.target)).toEqual(["rust"]);
  });

  it("passes file slices to adapters as scratch files", async () => {
    const { byName, adapter } = await run({
      dirs: {
        d: {
          cases: [
            {
              name: "have",
              root: "A",
              bytes: { file: "data/have.bin", offset: 1 },
              expect: [{ pointer: "/x", equals: 2 }]
            }
          ],
          files: { "data/have.bin": new Uint8Array([1, 2, 3]) }
        }
      },
      adapter: fakeAdapter("f", c => ({ name: c.name, ok: true, json: { x: 2 }, bytes: "0203" }))
    });
    expect(byName.have!.status).toBe("pass");
    expect(adapter.calls[0]!.cases.map(c => c.name)).toEqual(["have"]);
    const file = (adapter.calls[0]!.cases[0]!.bytes as { file: string }).file;
    expect(file).toMatch(/slice-0\.bin$/);
  });

  it("checks expectations on the actual JSON", async () => {
    const json = { list: [1, 2, 3], blob: "00112233", name: "ARCV", nested: { a: 1 } };
    expect(
      checkExpectations(json, [
        { pointer: "/list", length: 3 },
        { pointer: "/blob", byteLength: 4, startsWith: "0011" },
        { pointer: "/nested", equals: { a: 1 } },
        { pointer: "/name", length: 4 }
      ])
    ).toEqual([]);
    const fails = checkExpectations(json, [
      { pointer: "/list", length: 2 },
      { pointer: "/blob", byteLength: 3 },
      { pointer: "/name", byteLength: 2 },
      { pointer: "/nested", equals: { a: 2 } },
      { pointer: "/name", startsWith: "X" },
      { pointer: "/gone", equals: 1 },
      { pointer: "/nested", length: 1 }
    ]);
    expect(fails).toEqual([
      "/list: expected length 2, got 3",
      "/blob: expected 3 bytes, got 4",
      "/name: expected a hex string",
      "/nested/a: expected 2, got 1",
      '/name: expected a string starting with "X", got "ARCV"',
      "/gone: not found",
      "/nested: expected length 1, got a object"
    ]);
  });

  it("needs JSON from the adapter to check expectations", () => {
    const c: Case = { name: "x", root: "A", bytes: "00", expect: [{ pointer: "/a", equals: 1 }] };
    const r: CaseResult = { name: "x", ok: true };
    expect(judgeCase(c, { case: c, inputHex: "00" }, r).message).toMatch(/no JSON/);
  });

  it("checks value round trips like JSON round trips", () => {
    const c: Case = { name: "x", root: "A", bytes: "0011", json: {}, roundtrip: "value" };
    const v = judgeCase(
      c,
      { case: c, inputHex: "0011" },
      { name: "x", ok: true, json: {}, bytes: "0012" }
    );
    expect(v.status).toBe("fail");
    expect(v.message).toContain("serialize(parse(bytes))");
  });

  it("fails every case of an invalid directory", async () => {
    const { byName } = await run({
      dirs: { d: { cases: [{ name: "a", root: "A", bytes: "0", json: {} }] } }
    });
    expect(byName.a!.status).toBe("fail");
    expect(byName.a!.message).toMatch(/invalid case directory/);
    const empty = await run({ dirs: { d: { cases: "nope" } } });
    expect(empty.byName["(case directory)"]!.status).toBe("fail");
  });

  it("passes the target's externs from yaffle.json", async () => {
    const yaffle = JSON.stringify({
      sources: ["schema.yfl"],
      targets: {
        fake: { out: "o", externs: { xor: "../ext/xor.ts" } },
        other: { out: "o", externs: { xor: "../ext/xor.rs" } }
      }
    });
    const { adapter, root } = await run({
      dirs: {
        d: { cases: BASIC, files: { "yaffle.json": yaffle } },
        ext: { cases: [], files: { "xor.ts": "", "xor.rs": "" } }
      }
    });
    expect(adapter.calls[0]!.externs).toEqual({ xor: join(root, "ext", "xor.ts") });
  });

  it("runs a plan directory by directory", async () => {
    const root = makeCaseRoot({ a: { cases: BASIC }, b: { cases: BASIC.slice(0, 1) } });
    const plan = await planConformance(options(root, { adapters: adapters(fakeAdapter("f")) }));
    const seen: string[] = [];
    const report = await runPlan(plan, d => seen.push(d.dir));
    expect(seen).toEqual(["a", "b"]);
    expect(report.dirs).toHaveLength(2);
    const single = await runDir(plan, plan.dirs[1]!, plan.adapters[0]!);
    expect(single.cases).toHaveLength(1);
  });

  it("recognizes not-implemented errors", () => {
    expect(isNotImplemented("compile not implemented yet")).toBe(true);
    expect(isNotImplemented("Not Implemented: views")).toBe(true);
    expect(isNotImplemented("unexpected token")).toBe(false);
  });
});

describe("adapter discovery", () => {
  it("finds and loads conformance.ts modules", async () => {
    const dir = tempDir();
    const modules: Record<string, string> = {
      good: `export const adapter = { target: "good", available: async () => true, run: async () => [] };\n`,
      bad: `export const adapter = { target: "bad" };\n`,
      offline: `export const adapter = { target: "offline", available: async () => false, run: async () => [] };\n`,
      broken: `throw new Error("syntax-ish");\n`
    };
    mkdirSync(join(dir, "none"));
    for (const [name, source] of Object.entries(modules)) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "conformance.ts"), source);
    }
    expect(findAdapterModules(dir).map(m => m.target)).toEqual([
      "bad",
      "broken",
      "good",
      "offline"
    ]);
    const found = await discoverAdapters(dir);
    const by = Object.fromEntries(found.map(f => [f.target, f]));
    expect(by.good!.unavailable).toBeUndefined();
    expect(by.good!.adapter!.target).toBe("good");
    expect(by.bad!.unavailable).toMatch(/does not export/);
    expect(by.offline!.unavailable).toMatch(/toolchain not available/);
    expect(by.broken!.unavailable).toMatch(/failed to load/);
    expect((await discoverAdapters(dir, ["good"])).map(f => f.target)).toEqual(["good"]);
    expect(await discoverAdapters(join(dir, "nope"))).toEqual([]);
    expect((await loadAdapter("x", join(dir, "nope.ts"))).unavailable).toMatch(/failed to load/);
  });

  it("survives available() throwing", async () => {
    const a = fakeAdapter("t", undefined, {
      available: async () => {
        throw new Error("no nix");
      }
    });
    const d = await checkAvailable({ target: "t", module: "m", adapter: a });
    expect(d.unavailable).toMatch(/available\(\) failed: no nix/);
  });

  it("finds the real backends", () => {
    const backends = join(
      import.meta.dirname,
      "..",
      "..",
      "packages",
      "compiler",
      "src",
      "backends"
    );
    expect(findAdapterModules(backends).map(m => m.target)).toContain("ts");
  });
});

describe("reports", () => {
  it("formats cells", () => {
    expect(cell({ pass: 3, fail: 0, skip: 0 })).toBe("3/3");
    expect(cell({ pass: 1, fail: 2, skip: 1 })).toBe("1/4 ✗2 ~1");
    expect(cell({ pass: 0, fail: 0, skip: 5 })).toBe("skip");
    expect(cell({ pass: 0, fail: 0, skip: 0 })).toBe("-");
  });
  it("prints a matrix, failures, grouped skips and a summary", async () => {
    const root = makeCaseRoot({ alpha: { cases: BASIC }, beta: { cases: BASIC } });
    const report = await runConformance(
      options(root, {
        adapters: [
          ...adapters(
            fakeAdapter("ts", c =>
              c.name === "parse" ? { name: c.name, ok: true, json: { x: 9 } } : perfectResult(c)
            )
          ),
          { target: "rust", module: "(fake)", unavailable: "rust: toolchain not available" }
        ]
      })
    );
    const m = formatMatrix(report);
    expect(m).toMatch(/case directory\s+ts\s+rust/);
    expect(m).toMatch(/alpha\s+3\/4 ✗1\s+skip/);
    expect(m).toMatch(/total\s+6\/8 ✗2\s+skip/);
    expect(formatSkips(report)).toBe("~ 8 × [rust] rust: toolchain not available");
    expect(formatSummary(report)).toContain("6 passed, 2 failed, 8 skipped");
    const full = formatReport(report, { verbose: true });
    expect(full).toContain("✗ [ts] alpha › parse");
    expect(full).toContain("/x: expected 1, got 9");
    expect(full).toContain("✓ [ts] beta › serialize");
  });
  it("says when there are no adapters", () => {
    expect(formatReport({ targets: [], dirs: [] })).toContain("No backend adapters found");
  });
});

describe("cli", () => {
  it("parses arguments into the environment", () => {
    const o = parseArgs(["--filter", "a,b", "--targets=ts", "-v", "--json"], { X: "1" });
    expect(o.env).toEqual({
      X: "1",
      YAFFLE_CONFORMANCE_FILTER: "a,b",
      YAFFLE_CONFORMANCE_TARGETS: "ts"
    });
    expect(o.verbose && o.json).toBe(true);
    expect(() => parseArgs(["--bogus"], {})).toThrow(/unknown argument/);
    expect(() => parseArgs(["--filter"], {})).toThrow(/needs a value/);
  });
  it("parses --compiler and repeated --adapter", () => {
    const o = parseArgs(["--compiler", "x/index.ts", "--adapter=a.ts", "--adapter", "b.ts"], {});
    expect(o.compiler).toBe("x/index.ts");
    expect(o.adapters).toEqual(["a.ts", "b.ts"]);
  });
  it("loads an alternative compiler and adapters from module paths", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "compiler.ts"),
      `export function compile() { return { diagnostics: [] }; }\n`
    );
    writeFileSync(join(dir, "nocompile.ts"), `export const x = 1;\n`);
    writeFileSync(
      join(dir, "adapter.ts"),
      `export const adapter = { target: "fake", available: async () => true, run: async () => [] };\n`
    );
    const compile = await loadCompiler(join(dir, "compiler.ts"));
    expect(compile([])).toEqual({ diagnostics: [] });
    await expect(loadCompiler(join(dir, "nocompile.ts"))).rejects.toThrow(
      /does not export compile/
    );
    const [a] = await loadAdapters([join(dir, "adapter.ts")]);
    expect(a!.target).toBe("fake");
    expect(a!.unavailable).toBeUndefined();
    const [missing] = await loadAdapters([join(dir, "missing.ts")]);
    expect(missing!.unavailable).toMatch(/failed to load/);
  });
  it("prints usage", async () => {
    let out = "";
    expect(await main(["--help"], {}, s => (out += s))).toBe(0);
    expect(out).toContain("usage:");
    expect(await main(["--nope"], {}, s => (out += s))).toBe(2);
  });
  it("lists the repository's case directories", async () => {
    let out = "";
    const code = await main(["--list"], {}, s => (out += s));
    expect(out).toMatch(/\d+ case directories, \d+ cases/);
    expect(code).toBe(0);
  });
});

describe("view mode (docs/CONFORMANCE.md §7)", () => {
  function viewAdapter(target: string, respond?: Parameters<typeof fakeAdapter>[1]) {
    const a = fakeAdapter(target, respond);
    a.capabilities = { views: true };
    return a;
  }

  it("adds a <target>:view target for adapters that support views", async () => {
    const root = makeCaseRoot({ d: { cases: BASIC } });
    const plan = await planConformance(
      options(root, { adapters: adapters(viewAdapter("ts"), fakeAdapter("rust")) })
    );
    expect(plan.adapters.map(a => a.target)).toEqual(["ts", "ts:view", "rust"]);
  });

  it("can be turned off and filtered like any target", async () => {
    const root = makeCaseRoot({ d: { cases: BASIC } });
    const targets = async (env: Record<string, string>) =>
      (
        await planConformance(
          options(root, { adapters: adapters(viewAdapter("ts"), viewAdapter("rust")), env })
        )
      ).adapters.map(a => a.target);
    expect(await targets({ YAFFLE_CONFORMANCE_VIEWS: "0" })).toEqual(["ts", "rust"]);
    expect(await targets({ YAFFLE_CONFORMANCE_TARGETS: "rust:view" })).toEqual(["rust:view"]);
    expect(await targets({ YAFFLE_CONFORMANCE_TARGETS: "rust" })).toEqual(["rust", "rust:view"]);
  });

  it("runs parse cases with mode 'view', skips serialize-only cases, and judges like parse mode", async () => {
    const adapter = viewAdapter("ts");
    const root = makeCaseRoot({ d: { cases: BASIC } });
    const report = await runConformance(options(root, { adapters: adapters(adapter) }));
    const view = report.dirs.find(d => d.target === "ts:view")!;
    expect(count(view.cases)).toEqual({ pass: 3, fail: 0, skip: 1 });
    expect(view.cases.find(c => c.name === "serialize")!.message).toMatch(/view mode/);
    expect(adapter.calls.map(c => c.mode)).toEqual(["parse", "view"]);
    expect(adapter.calls[1]!.cases.map(c => c.name)).toEqual(["parse", "error", "no roundtrip"]);
  });

  it("fails a view whose no-op commit changes the bytes", async () => {
    const adapter = viewAdapter("ts", (c, input) => {
      const r = perfectResult(c);
      if (input.mode === "view" && c.name === "parse") r.bytes = "02";
      return r;
    });
    const root = makeCaseRoot({ d: { cases: BASIC } });
    const report = await runConformance(options(root, { adapters: adapters(adapter) }));
    const view = report.dirs.find(d => d.target === "ts:view")!;
    expect(view.cases.find(c => c.name === "parse")!.status).toBe("fail");
    const parse = report.dirs.find(d => d.target === "ts")!;
    expect(parse.cases.find(c => c.name === "parse")!.status).toBe("pass");
  });
});

describe("scratch output", () => {
  async function workDirKept(env: Record<string, string>, fail: boolean) {
    const root = makeCaseRoot({ d: { cases: BASIC } });
    const adapter = fakeAdapter("ts", c => {
      const r = perfectResult(c);
      if (fail && c.name === "parse") r.json = { x: 99 };
      return r;
    });
    await runConformance(options(root, { adapters: adapters(adapter), env }));
    return existsSync(join(root, ".out", "ts", "d"));
  }

  it("deletes a passing directory's work dir", async () => {
    expect(await workDirKept({}, false)).toBe(false);
  });

  it("keeps a failing directory's work dir for debugging", async () => {
    expect(await workDirKept({}, true)).toBe(true);
  });

  it("keeps everything with YAFFLE_CONFORMANCE_KEEP=1", async () => {
    expect(await workDirKept({ YAFFLE_CONFORMANCE_KEEP: "1" }, false)).toBe(true);
  });
});
