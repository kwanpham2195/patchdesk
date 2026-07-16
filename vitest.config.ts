import { defineConfig } from "vitest/config";

/** Configures isolated Node tests for privileged-boundary behavior. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
