/**
 * How to start the language server, from the `yaffle.server.*` settings. Pure (no `vscode`
 * import) so it can be unit tested.
 */
import * as path from "node:path";

export type ServerLaunch =
  | {
      kind: "module";
      /** Absolute path of a JavaScript (or TypeScript) module, run with Node over IPC. */
      module: string;
      /** Node executable; undefined: VS Code's own. */
      runtime: string | undefined;
      execArgv: string[];
    }
  | {
      kind: "executable";
      command: string;
      args: string[];
    };

const MODULE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);

/**
 * - empty `serverPath`: the server bundled with the extension;
 * - a `.js`/`.mjs`/`.cjs` (or `.ts`, run with `--conditions=development`) module: run with Node;
 * - anything else: an executable, started with `--stdio`.
 *
 * Relative paths resolve against the first workspace folder.
 */
export function resolveServerLaunch(options: {
  serverPath: string | undefined;
  runtime: string | undefined;
  bundledServer: string;
  workspaceRoot: string | undefined;
}): ServerLaunch {
  const runtime = options.runtime?.trim() || undefined;
  const raw = options.serverPath?.trim() ?? "";
  if (raw === "") {
    return { kind: "module", module: options.bundledServer, runtime, execArgv: [] };
  }
  const expanded = raw.startsWith("~/") ? path.join(process.env.HOME ?? "", raw.slice(2)) : raw;
  const resolved =
    path.isAbsolute(expanded) || !options.workspaceRoot
      ? expanded
      : path.resolve(options.workspaceRoot, expanded);
  const ext = path.extname(resolved).toLowerCase();
  if (MODULE_EXTENSIONS.has(ext)) {
    const isTs = ext === ".ts" || ext === ".mts" || ext === ".cts";
    return {
      kind: "module",
      module: resolved,
      runtime,
      execArgv: isTs ? ["--conditions=development"] : []
    };
  }
  // A bare command name (`yaffle-lsp`) is looked up on PATH; don't anchor it to the workspace.
  const command = raw.includes("/") || raw.includes("\\") ? resolved : raw;
  return { kind: "executable", command, args: [] };
}
