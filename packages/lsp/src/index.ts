/**
 * @yaffle/lsp: the yaffle language server. `main.ts` is the `yaffle-lsp` executable; this module
 * is the embedding API (start the server on any connection, with any language service).
 */
export { startServer, YaffleServer, SERVER_NAME, SERVER_VERSION } from "./server.ts";
export type { CompileFunction, ServerOptions } from "./server.ts";
export type { ServiceFactory } from "./projects.ts";
export { CONFIG_FILE_NAME } from "./projects.ts";
export { fallbackLoadProjectConfig, resolveSettings, stripJsonComments } from "./config.ts";
export type { ConfigHost, LoadProjectConfig } from "./config.ts";
export { MemoryFileSystem, nodeFileSystem } from "./fs.ts";
export type { FileSystem } from "./fs.ts";
export { currentPlatform, fileUriToPath, normalizePath, pathToFileUri, UriMapper } from "./uri.ts";
export type { Platform } from "./uri.ts";
export { SEMANTIC_TOKENS_LEGEND, TOKEN_MODIFIERS, TOKEN_TYPES } from "./semanticTokens.ts";
export { snippetToPlain } from "./convert.ts";
export { alignAttributeLine, reindentAfterContinuation } from "./attributeAlign.ts";
export { ErrorReporter, SafeService, silentLogger } from "./safe.ts";
export type { Logger } from "./safe.ts";
export * from "./protocol.ts";
