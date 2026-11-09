// Checks that every package the release workflow publishes is at the version named by the tag.
//   node .github/scripts/check-release-version.ts v0.0.2
// Prints the version (without the leading "v") on success, so the workflow can capture it.
import { readFileSync } from "node:fs";

const tag = process.argv[2] ?? "";
const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
if (!match) {
  console.error(`Expected a tag like v1.2.3 or v1.2.3-rc.1, got "${tag}"`);
  process.exit(1);
}
const version = match[1];

const read = (path: string) => readFileSync(path, "utf8");
const json = (path: string) =>
  JSON.parse(read(path)) as { version?: string; dependencies?: Record<string, string> };
const first = (path: string, pattern: RegExp) => pattern.exec(read(path))?.[1];

const found: [string, string | undefined][] = [
  [
    "@yafflelang/runtime (packages/runtime/package.json)",
    json("packages/runtime/package.json").version
  ],
  ["yaffle (packages/compiler/package.json)", json("packages/compiler/package.json").version],
  [
    "yaffle's dependency on @yafflelang/runtime",
    json("packages/compiler/package.json").dependencies?.["@yafflelang/runtime"]
  ],
  [
    "crate yaffle (Cargo.toml)",
    first("packages/runtime-rust/Cargo.toml", /^version\s*=\s*"([^"]+)"/m)
  ],
  [
    "PyPI yaffle (pyproject.toml)",
    first("packages/runtime-python/pyproject.toml", /^version\s*=\s*"([^"]+)"/m)
  ],
  [
    "NuGet Yaffle.Runtime (Yaffle.Runtime.csproj)",
    first(
      "packages/runtime-csharp/src/Yaffle.Runtime/Yaffle.Runtime.csproj",
      /<Version>([^<]+)<\/Version>/
    )
  ],
  [
    "Maven org.yafflelang:yaffle-runtime (pom.xml)",
    first(
      "packages/runtime-java/pom.xml",
      /<artifactId>yaffle-runtime<\/artifactId>\s*<version>([^<]+)<\/version>/
    )
  ]
];

const wrong = found.filter(([, v]) => v !== version);
for (const [what, v] of wrong) console.error(`${what} is ${v ?? "missing"}, expected ${version}`);
if (wrong.length > 0) process.exit(1);
console.log(version);
