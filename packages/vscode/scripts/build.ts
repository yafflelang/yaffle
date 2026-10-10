/**
 * Builds the extension:
 *
 * - `syntaxes/yaffle.tmLanguage.json` from `src/grammar.ts`;
 * - `dist/extension.cjs`: the extension, bundled as CommonJS (what the VS Code extension host
 *   loads), with `vscode` external;
 * - `dist/server.mjs`: the language server (`@yafflelang/lsp` + the compiler), bundled as ESM and
 *   run by the extension with VS Code's Node.
 *
 * Sources are TypeScript with `.ts` imports, resolved with the `development` condition, so no
 * package needs a prior `tsc` build.
 *
 *   node scripts/build.ts [--minify]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import * as prettier from "prettier";
import { grammar } from "../src/grammar.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GRAMMAR_PATH = path.join(ROOT, "syntaxes", "yaffle.tmLanguage.json");

/** The grammar as JSON, formatted with the repository's Prettier settings. */
export async function grammarJson(): Promise<string> {
  const options = (await prettier.resolveConfig(GRAMMAR_PATH)) ?? {};
  return prettier.format(JSON.stringify(grammar), { ...options, parser: "json" });
}

/** Write the grammar JSON if it changed (atomically: tests may be reading it). */
async function writeGrammar(): Promise<void> {
  const json = await grammarJson();
  const current = fs.existsSync(GRAMMAR_PATH) ? fs.readFileSync(GRAMMAR_PATH, "utf8") : undefined;
  if (current === json) return;
  const tmp = `${GRAMMAR_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, GRAMMAR_PATH);
}

export async function build(
  options: { minify?: boolean; outdir?: string } = {}
): Promise<{ extension: string; server: string }> {
  const outdir = options.outdir ?? path.join(ROOT, "dist");
  await writeGrammar();

  const common: esbuild.BuildOptions = {
    bundle: true,
    platform: "node",
    target: "node20",
    conditions: ["development"],
    minify: options.minify ?? false,
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning"
  };
  const extension = path.join(outdir, "extension.cjs");
  const server = path.join(outdir, "server.mjs");
  await esbuild.build({
    ...common,
    entryPoints: [path.join(ROOT, "src", "extension.ts")],
    outfile: extension,
    format: "cjs",
    external: ["vscode"]
  });
  await esbuild.build({
    ...common,
    entryPoints: [path.join(ROOT, "..", "lsp", "src", "main.ts")],
    outfile: server,
    format: "esm",
    // The bundled CommonJS dependencies (vscode-languageserver) call require() for Node built-ins.
    banner: {
      js: 'import { createRequire as __yaffleCreateRequire } from "node:module";\nconst require = __yaffleCreateRequire(import.meta.url);'
    }
  });
  return { extension, server };
}

const invoked =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const out = await build({ minify: process.argv.includes("--minify") });
  process.stdout.write(
    `built ${path.relative(ROOT, out.extension)}, ${path.relative(ROOT, out.server)}\n`
  );
}
