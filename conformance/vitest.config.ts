import { defineProject } from "vitest/config";

export default defineProject({
  resolve: { conditions: ["development"] },
  test: {
    name: "conformance",
    include: ["test/**/*.test.ts"],
    testTimeout: 300_000
  }
});
