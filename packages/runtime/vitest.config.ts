import { defineProject } from "vitest/config";

export default defineProject({
  resolve: { conditions: ["development"] },
  test: { name: "@yaffle/runtime", include: ["test/**/*.test.ts", "src/**/*.test.ts"] }
});
