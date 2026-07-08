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
    // Ledger tests share one Postgres database; run serially to keep
    // per-org isolation assertions deterministic.
    fileParallelism: false,
  },
});
