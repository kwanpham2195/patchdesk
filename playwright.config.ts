import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  use: { browserName: "chromium", headless: true },
});
