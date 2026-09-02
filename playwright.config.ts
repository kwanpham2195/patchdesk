import { defineConfig } from "playwright/test";

export default defineConfig({
  // One worker: the 1,000-file performance proof measures wall-clock
  // interaction latency, so nothing else may compete for this machine.
  workers: 1,
  testDir: "./tests/browser",
  timeout: 30_000,
  use: { browserName: "chromium", headless: true },
  // The performance proof runs first, in its own browser, because a scheduling
  // pause left over from earlier specs' heavy fixtures read as a 200 ms budget
  // failure on CI; the dependency is what orders the two projects.
  projects: [
    {
      name: "performance",
      testMatch: "**/performance.spec.ts",
    },
    {
      name: "suite",
      testMatch: "**/*.spec.ts",
      testIgnore: "**/performance.spec.ts",
      dependencies: ["performance"],
    },
  ],
});
