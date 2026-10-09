import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../../src/cli/cli.ts";
import type { Backend } from "../../src/backends/index.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yaffle-cli-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, text: string): string {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
}

function run(
  args: string[],
  extra: Partial<CliIo> = {}
): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const io: CliIo = {
    stdout: s => (out += s),
    stderr: s => (err += s),
    cwd: dir,
    color: false,
    ...extra
  };
  const code = runCli(args, io);
  return { code, out, err };
}

const GOOD = "export struct Table {\n  u32 count\n  u8  data[count]\n}\n";
const BAD = "export struct Table {\n  u32 count\n  u8  data[cnt]\n}\n";

describe("cli: general", () => {
  it("prints help and version", () => {
    const h = run(["--help"]);
    expect(h.code).toBe(0);
    expect(h.out).toContain("yaffle check");
    expect(run(["--version"]).out).toBe("yaffle 0.1.0\n");
    expect(run([]).code).toBe(2);
  });

  it("rejects unknown commands", () => {
    const r = run(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown command 'frobnicate'");
  });
});

describe("cli: check", () => {
  it("succeeds on valid files", () => {
    write("a.yfl", GOOD);
    const r = run(["check", "a.yfl"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 file checked: 0 errors, 0 warnings");
  });

  it("prints diagnostics with location, code frame and carets", () => {
    write("a.yfl", BAD);
    const r = run(["check", "a.yfl"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "a.yfl:3:12: error [unknown-name] Unknown name 'cnt'. Did you mean 'count'?"
    );
    expect(r.err).toContain("\n3 |   u8  data[cnt]");
    expect(r.err).toContain("\n  |            ^^^");
    expect(r.err).toContain("fix: Change to 'count'");
    expect(r.err).toContain("1 file checked: 1 error, 0 warnings");
  });

  it("uses colour when asked", () => {
    write("a.yfl", BAD);
    const r = run(["check", "a.yfl"], { color: true });
    expect(r.err).toContain("\u001b[31merror\u001b[39m");
    expect(run(["check", "a.yfl", "--no-color"], { color: true }).err).not.toContain("\u001b[");
  });

  it("warnings don't fail the check", () => {
    write("a.yfl", "export struct S { u32 n = d.length * 8  u8 d[(n + 7) / 8] }\n");
    const r = run(["check", "a.yfl"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("warning [lossy-formula]");
  });

  it("checks a project found from the working directory", () => {
    write("yaffle.json", JSON.stringify({ sources: ["formats/**/*.yfl"] }));
    write("formats/a.yfl", GOOD);
    write("formats/sub/b.yfl", BAD);
    const r = run(["check"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(join("formats", "sub", "b.yfl") + ":3:12");
    expect(r.err).toContain("2 files checked: 1 error");
  });

  it("checks a project given with --project", () => {
    write(
      "p/yaffle.json",
      JSON.stringify({ sources: ["*.yfl"], targets: { ts: { out: "gen", externs: {} } } })
    );
    write("p/a.yfl", "extern codec zstd\nexport struct S { u8 x }\n");
    const r = run(["check", "--project", "p/yaffle.json"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain(
      "warning [extern-missing-implementation] Extern 'zstd' has no implementation for target 'ts'"
    );
  });

  it("reports an invalid yaffle.json", () => {
    write("yaffle.json", '{ "sources": 3 }');
    const r = run(["check"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("config-error");
    expect(r.err).toContain('"sources" must be an array');
  });

  it("needs files or a project", () => {
    const r = run(["check"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("no yaffle.json found");
  });

  it("reports missing files", () => {
    const r = run(["check", "nope.yfl"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("import-not-found");
  });
});

describe("cli: ir", () => {
  it("prints the IR as JSON, pretty JSON or text", () => {
    write("a.yfl", GOOD);
    const compact = run(["ir", "a.yfl"]);
    expect(compact.code).toBe(0);
    const p = JSON.parse(compact.out);
    expect(p.version).toBe(1);
    expect(p.roots[0].name).toBe("Table");
    expect(compact.out.trim().split("\n").length).toBe(1);
    expect(run(["ir", "a.yfl", "--pretty"]).out).toContain('\n  "version": 1,');
    expect(run(["ir", "a.yfl", "--text"]).out).toContain(
      "count: u32  = data.length [auto]  input absent"
    );
  });

  it("fails with diagnostics on errors", () => {
    write("a.yfl", BAD);
    const r = run(["ir", "a.yfl"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("unknown-name");
  });

  it("needs a file", () => {
    expect(run(["ir"]).code).toBe(2);
  });
});

describe("cli: fmt", () => {
  const UGLY = "struct S{u8 a;u32be crc\n}\n";
  it("--check lists files that would change", () => {
    const f = write("a.yfl", UGLY);
    const r = run(["fmt", "--check", "a.yfl"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("a.yfl\n");
    expect(readFileSync(f, "utf8")).toBe(UGLY);
  });

  it("formats files in place", () => {
    const f = write("a.yfl", UGLY);
    const r = run(["fmt", "a.yfl"]);
    expect(r.code).toBe(0);
    expect(readFileSync(f, "utf8")).toBe("struct S {\n  u8    a\n  u32be crc\n}\n");
    expect(run(["fmt", "--check", "a.yfl"]).code).toBe(0);
  });

  it("--stdout prints instead of writing", () => {
    const f = write("a.yfl", UGLY);
    const r = run(["fmt", "--stdout", "a.yfl"]);
    expect(r.out).toBe("struct S {\n  u8    a\n  u32be crc\n}\n");
    expect(readFileSync(f, "utf8")).toBe(UGLY);
  });

  it("skips files with syntax errors", () => {
    write("a.yfl", "struct S { u8 a[ }");
    const r = run(["fmt", "a.yfl"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("skipped a.yfl (syntax errors)");
  });

  it("formats the project's sources by default", () => {
    write("yaffle.json", JSON.stringify({ sources: ["**/*.yfl"] }));
    const f = write("x/a.yfl", UGLY);
    expect(run(["fmt"]).code).toBe(0);
    expect(readFileSync(f, "utf8")).toContain("u32be crc");
  });
});

describe("cli: build", () => {
  const fake: Backend = {
    name: "fake",
    generate(program, options) {
      return [
        { path: "index.txt", contents: program.roots.map(r => r.name).join(",") },
        { path: "sub/externs.json", contents: JSON.stringify(options.externs) }
      ];
    }
  };

  it("runs the configured targets", () => {
    write(
      "yaffle.json",
      JSON.stringify({
        sources: ["*.yfl"],
        targets: { fake: { out: "gen", externs: { pathHash: "./src/hash.ts", zstd: "zstd-pkg" } } }
      })
    );
    write(
      "a.yfl",
      "extern fn pathHash(char p[]) -> u32\nextern codec zstd\nexport struct S { char p[4]  u32 h = pathHash(p) }\n"
    );
    const r = run(["build"], { backends: { fake } });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("wrote 2 files for fake to gen");
    expect(readFileSync(join(dir, "gen/index.txt"), "utf8")).toBe("S");
    // relative extern modules are rewritten relative to the output directory
    expect(JSON.parse(readFileSync(join(dir, "gen/sub/externs.json"), "utf8"))).toEqual({
      pathHash: "../src/hash.ts",
      zstd: "zstd-pkg"
    });
  });

  it("--target and --out override the configuration", () => {
    write("yaffle.json", JSON.stringify({ sources: ["*.yfl"], targets: { fake: { out: "gen" } } }));
    write("a.yfl", GOOD);
    const r = run(["build", "--target", "fake", "--out", "elsewhere"], { backends: { fake } });
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "elsewhere/index.txt"))).toBe(true);
    expect(existsSync(join(dir, "gen"))).toBe(false);
  });

  it("builds files without a project given --target and --out", () => {
    write("a.yfl", GOOD);
    const r = run(["build", "a.yfl", "--target", "fake", "--out", "o"], { backends: { fake } });
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "o/index.txt"), "utf8")).toBe("Table");
  });

  it("doesn't run backends when there are errors", () => {
    write("yaffle.json", JSON.stringify({ sources: ["*.yfl"], targets: { fake: { out: "gen" } } }));
    write("a.yfl", BAD);
    const r = run(["build"], { backends: { fake } });
    expect(r.code).toBe(1);
    expect(existsSync(join(dir, "gen"))).toBe(false);
  });

  it("reports unknown targets and failing backends", () => {
    write("yaffle.json", JSON.stringify({ sources: ["*.yfl"], targets: { nope: { out: "gen" } } }));
    write("a.yfl", GOOD);
    expect(run(["build"], { backends: { fake } }).err).toContain(
      "Unknown target 'nope'. Available: fake."
    );
    const boom: Backend = {
      name: "boom",
      generate: () => {
        throw new Error("kaput");
      }
    };
    write("yaffle.json", JSON.stringify({ sources: ["*.yfl"], targets: { boom: { out: "gen" } } }));
    const r = run(["build"], { backends: { boom } });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Backend 'boom' failed: kaput");
  });

  it("needs a project or explicit target and out", () => {
    write("a.yfl", GOOD);
    expect(run(["build", "a.yfl"]).code).toBe(2);
  });
});

describe("cli: as a process", () => {
  const main = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
  const exec = (args: string[]) =>
    spawnSync(process.execPath, ["--conditions=development", main, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" }
    });

  it("exits 0 for valid sources and 1 for errors", () => {
    write("good.yfl", GOOD);
    write("bad.yfl", BAD);
    const ok = exec(["check", "good.yfl"]);
    expect(ok.status).toBe(0);
    const bad = exec(["check", "bad.yfl"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("bad.yfl:3:12: error [unknown-name]");
  });

  it("prints IR to stdout", () => {
    write("good.yfl", GOOD);
    const r = exec(["ir", "good.yfl", "--text"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("struct Table [Table]");
  });
});
