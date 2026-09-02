import { defineConfig } from "playwright/test";
import { timingBudget } from "./tests/browser/timing-budget";

export default defineConfig({
  // One worker: the performance proof measures wall-clock interaction latency
  // against the budget in tests/browser/timing-budget.ts, so nothing else may
  // compete for this machine.
  workers: 1,
  testDir: "./tests/browser",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  expect: { timeout: timingBudget.expectTimeoutMs },
  use: { browserName: "chromium", headless: true },
});
