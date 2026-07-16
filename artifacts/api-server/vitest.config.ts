import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["workspace"],
  },
  test: {
    // Most suites exercise flows that begin with a signup; the flag is
    // fail-closed in real deployments and only enabled here for tests.
    // signup-disabled.test.ts deletes/overrides it per-case.
    env: { ALLOW_PUBLIC_SIGNUP: "true" },
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    // Tests share one Postgres database and one auth rate-limit window; run
    // serially so counts and per-user isolation stay deterministic.
    fileParallelism: false,
  },
});
