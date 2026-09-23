import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

/** Configures isolated Node tests for privileged-boundary behavior. */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/renderer/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Fixture routes exist to render screens for live checks, not to be covered.
      exclude: ["src/renderer/src/flows/fixtures/**"],
      reporter: ["text-summary", "html"],
    },
  },
});
