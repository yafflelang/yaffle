import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/runtime",
      "packages/compiler",
      "packages/lsp",
      "packages/vscode",
      "conformance"
    ],
    testTimeout: 30_000
  }
});
