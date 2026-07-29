import { defineConfig } from "playwright/test";

export default defineConfig({
  // Keep the 1,000-file selection proof below its 200 ms ceiling while heavy
  // Settings/walkthrough fixtures run in the same browser suite.
  workers: 1,
  testDir: "./tests/browser",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  use: { browserName: "chromium", headless: true },
});
