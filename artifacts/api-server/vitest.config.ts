import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["workspace"],
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    // Tests share one Postgres database and one auth rate-limit window; run
    // serially so counts and per-user isolation stay deterministic.
    fileParallelism: false,
  },
});
