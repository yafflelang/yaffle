import { defineProject } from "vitest/config";

export default defineProject({
  resolve: { conditions: ["development"] },
  test: {
    name: "yaffle",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // generated code is typechecked and imported: slow on a busy machine
    testTimeout: 30_000,
    hookTimeout: 60_000
  }
});
