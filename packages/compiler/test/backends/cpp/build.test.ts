/**
 * Packaging of the C++ target: `yaffle build --target cpp` output, the inlined runtime
 * (`inlineRuntime`: output that builds with no other include path), and deterministic output.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { build as buildProject, loadProjectConfig } from "yaffle";
import { generateCpp } from "../../../src/backends/cpp/index.ts";
import { CXX_FLAGS, cacheDir, runCommand } from "../../../src/backends/cpp/toolchain.ts";
import { program, toolchain } from "./harness.ts";

const SCHEMA = `
export struct Header {
  char tag[4] = "DEMO"
  u16 n
  u32 values[n]
}
`;

describe("C++ build output", () => {
  it("writes one header and one source per program through yaffle build", () => {
    const dir = mkdtempSync(join(tmpdir(), "yaffle-cpp-build-"));
    try {
      writeFileSync(join(dir, "demo.yfl"), SCHEMA);
      writeFileSync(
        join(dir, "yaffle.json"),
        JSON.stringify({
          sources: ["demo.yfl"],
          targets: { cpp: { out: "gen", namespace: "demo" } }
        })
      );
      const cfg = loadProjectConfig(join(dir, "yaffle.json"));
      expect(cfg.config).toBeDefined();
      const r = buildProject(
        { config: cfg.config!, rootDir: dir, configPath: join(dir, "yaffle.json") },
        "cpp"
      );
      expect(r.diagnostics.filter(d => d.severity === "error")).toEqual([]);
      expect(readdirSync(join(dir, "gen")).sort()).toEqual(["demo.cpp", "demo.hpp"]);
      const h = readFileSync(join(dir, "gen", "demo.hpp"), "utf8");
      expect(h).toContain("namespace demo {");
      expect(h).toContain("std::vector<std::uint32_t> values;");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is deterministic", () => {
    const p = program(SCHEMA);
    const a = generateCpp(p, { externs: {} }).files;
    const b = generateCpp(p, { externs: {} }).files;
    expect(a).toEqual(b);
  });

  it.skipIf(!toolchain)("builds with the inlined runtime only", { timeout: 300_000 }, async () => {
    const gen = generateCpp(program(SCHEMA), {
      externs: {},
      inlineRuntime: true,
      targetOptions: { file: "demo" }
    });
    const dir = join(cacheDir(), "tests", "inline-runtime");
    rmSync(dir, { recursive: true, force: true });
    for (const f of gen.files) {
      mkdirSync(join(dir, f.path, ".."), { recursive: true });
      writeFileSync(join(dir, f.path), f.contents);
    }
    writeFileSync(
      join(dir, "main.cpp"),
      `#include <cstdio>
#include "demo.hpp"
int main() {
  auto h = demo::Header::parse(yaffle::from_hex("44454d4f 0100 2a000000"));
  std::printf("%u %s\\n", h.values[0], yaffle::to_hex(demo::Header::serialize(h)).c_str());
}
`
    );
    const srcs = readdirSync(join(dir, "yaffle-runtime", "src")).map(f =>
      join(dir, "yaffle-runtime", "src", f)
    );
    const exe = join(dir, "demo");
    await runCommand(toolchain!.cxx, [
      ...CXX_FLAGS,
      "-O1",
      "-I",
      join(dir, "yaffle-runtime", "include"),
      "-I",
      dir,
      join(dir, "demo.cpp"),
      join(dir, "main.cpp"),
      ...srcs,
      "-o",
      exe
    ]);
    const out = await new Promise<string>((res, rej) =>
      execFile(exe, [], (err, stdout) => (err ? rej(err) : res(String(stdout))))
    );
    expect(out.trim()).toBe("42 44454d4f01002a000000");
  });
});
