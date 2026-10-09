#!/usr/bin/env node
/**
 * `yaffle-lsp`: the yaffle language server executable.
 *
 *   yaffle-lsp --stdio                 (default when no transport is given)
 *   yaffle-lsp --node-ipc | --socket=<port> | --pipe=<name>
 *   yaffle-lsp --service <module>      use another LanguageService implementation
 *   yaffle-lsp --version | --help
 *
 * `--service` (or the YAFFLE_LSP_SERVICE environment variable) names a module exporting
 * `createLanguageService(host)`, and optionally `compile` and `loadProjectConfig`, in place of
 * the compiler's. The end-to-end tests run the server on a fake service this way.
 */
import { pathToFileURL } from "node:url";
import * as nodePath from "node:path";
import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import * as compiler from "yaffle";
import type { LoadProjectConfig } from "./config.ts";
import type { ServiceFactory } from "./projects.ts";
import { quietLogger } from "./safe.ts";
import {
  type CompileFunction,
  SERVER_NAME,
  SERVER_VERSION,
  type ServerOptions,
  startServer
} from "./server.ts";
import { errorMessage } from "./util.ts";

const USAGE = `Usage: ${SERVER_NAME} [--stdio | --node-ipc | --socket=<port> | --pipe=<name>] [--service <module>]`;

async function serverOptions(serviceModule: string | undefined): Promise<ServerOptions> {
  if (!serviceModule) {
    return {
      createService: compiler.createLanguageService,
      compile: compiler.compile,
      loadProjectConfig: compiler.loadProjectConfig
    };
  }
  const url = pathToFileURL(nodePath.resolve(serviceModule)).href;
  const mod = (await import(url)) as Record<string, unknown>;
  const factory = mod.createLanguageService ?? mod.default;
  if (typeof factory !== "function") {
    throw new Error(`${serviceModule} does not export createLanguageService(host)`);
  }
  const options: ServerOptions = { createService: factory as ServiceFactory };
  if (typeof mod.compile === "function") options.compile = mod.compile as CompileFunction;
  if (typeof mod.loadProjectConfig === "function") {
    options.loadProjectConfig = mod.loadProjectConfig as LoadProjectConfig;
  }
  return options;
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  let serviceModule = process.env.YAFFLE_LSP_SERVICE || undefined;
  const serviceIndex = argv.findIndex(a => a === "--service" || a.startsWith("--service="));
  if (serviceIndex >= 0) {
    const arg = argv[serviceIndex]!;
    serviceModule = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[serviceIndex + 1];
    if (!serviceModule) throw new Error(`--service needs a module path\n${USAGE}`);
  }
  // createConnection reads the transport from process.argv.
  const transports = ["--stdio", "--node-ipc", "--socket", "--pipe"];
  if (!argv.some(a => transports.some(t => a === t || a.startsWith(`${t}=`)))) {
    process.argv.push("--stdio");
  }

  const options = await serverOptions(serviceModule);
  const connection = createConnection(ProposedFeatures.all);
  // A bug anywhere must not take the server down: log it and keep serving.
  const log = quietLogger(connection.console);
  process.on("uncaughtException", error => {
    log.error(`yaffle: uncaught exception: ${error.stack ?? String(error)}`);
  });
  process.on("unhandledRejection", reason => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    log.error(`yaffle: unhandled rejection: ${detail}`);
  });
  startServer(connection, options);
  connection.listen();
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${SERVER_NAME}: ${errorMessage(error)}\n`);
  process.exit(1);
});
