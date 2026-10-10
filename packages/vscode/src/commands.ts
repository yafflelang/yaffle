/** Identifiers contributed in package.json (pure: no `vscode` import). */
import { ShowBindingSourcesCommand } from "@yafflelang/lsp/protocol";

export const LANGUAGE_ID = "yaffle";

export const COMMANDS = {
  showIr: "yaffle.showIr",
  decodeSample: "yaffle.decodeSample",
  suggestLayout: "yaffle.suggestLayout",
  clearSample: "yaffle.clearSample",
  restartServer: "yaffle.restartServer",
  showOutput: "yaffle.showOutput",
  showBindingSources: ShowBindingSourcesCommand
} as const;
