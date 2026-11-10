// Every place a release version lives. check-release-version.ts reads these to verify a tag, and
// release.ts writes them to cut a release, so adding a manifest here covers both.
import { readFileSync } from "node:fs";

export interface VersionField {
  label: string;
  path: string;
  read(text: string): string | undefined;
  write(text: string, version: string): string;
}

// A key path inside a JSON file. Written back the way npm and prettier format package.json.
function json(label: string, path: string, keys: string[]): VersionField {
  const parent = (text: string) => {
    let node = JSON.parse(text) as Record<string, unknown>;
    const root = node;
    for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
    return { root, node, key: keys.at(-1)! };
  };
  return {
    label,
    path,
    read(text) {
      const { node, key } = parent(text);
      const value = node?.[key];
      return typeof value === "string" ? value : undefined;
    },
    write(text, version) {
      const { root, node, key } = parent(text);
      if (typeof node?.[key] !== "string") throw new Error(`${path}: ${keys.join(".")} not found`);
      node[key] = version;
      return JSON.stringify(root, null, 2) + "\n";
    }
  };
}

// The first match of a pattern whose group 1 is the version.
function text(label: string, path: string, pattern: RegExp): VersionField {
  const indexed = new RegExp(pattern.source, pattern.flags + "d");
  return {
    label,
    path,
    read: text => indexed.exec(text)?.[1],
    write(text, version) {
      const span = indexed.exec(text)?.indices?.[1];
      if (!span) throw new Error(`${path}: ${pattern} not found`);
      return text.slice(0, span[0]) + version + text.slice(span[1]);
    }
  };
}

export const fields: VersionField[] = [
  json("@yafflelang/runtime", "packages/runtime/package.json", ["version"]),
  json("yaffle", "packages/compiler/package.json", ["version"]),
  json("yaffle's dependency on @yafflelang/runtime", "packages/compiler/package.json", [
    "dependencies",
    "@yafflelang/runtime"
  ]),
  json("@yafflelang/lsp's dependency on yaffle", "packages/lsp/package.json", [
    "dependencies",
    "yaffle"
  ]),
  json("conformance's dependency on yaffle", "conformance/package.json", [
    "dependencies",
    "yaffle"
  ]),
  json("conformance's dependency on @yafflelang/runtime", "conformance/package.json", [
    "dependencies",
    "@yafflelang/runtime"
  ]),
  text("crate yaffle", "packages/runtime-rust/Cargo.toml", /^version\s*=\s*"([^"]+)"/m),
  text("PyPI yaffle", "packages/runtime-python/pyproject.toml", /^version\s*=\s*"([^"]+)"/m),
  text(
    "yaffle.__version__",
    "packages/runtime-python/yaffle/__init__.py",
    /^__version__ = "([^"]+)"/m
  ),
  text(
    "NuGet Yaffle.Runtime",
    "packages/runtime-csharp/src/Yaffle.Runtime/Yaffle.Runtime.csproj",
    /<Version>([^<]+)<\/Version>/
  ),
  text(
    "Maven org.yafflelang:yaffle-runtime",
    "packages/runtime-java/pom.xml",
    /<artifactId>yaffle-runtime<\/artifactId>\s*<version>([^<]+)<\/version>/
  )
];

export const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// Lines describing each field that isn't at `version`; empty when everything matches.
export function mismatches(version: string): string[] {
  return fields.flatMap(field => {
    const found = field.read(readFileSync(field.path, "utf8"));
    return found === version
      ? []
      : [`${field.label} (${field.path}) is ${found ?? "missing"}, expected ${version}`];
  });
}
