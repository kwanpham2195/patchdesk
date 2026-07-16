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
  },
});
