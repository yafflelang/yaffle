import { defineProject } from "vitest/config";

export default defineProject({
  resolve: { conditions: ["development"] },
  test: {
    name: "@yaffle/lsp",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // the integration tests run the real compiler
    testTimeout: 30_000
  }
});
