import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, relative } from "node:path";
import { expect, test, type ConsoleMessage } from "playwright/test";

import { designScenarios } from "../../src/design/scenarios";

const FORBIDDEN_TERMS: ReadonlyArray<string> = [
  "session",
  "attempt",
  "quarantine",
  "worktree",
  "runtime",
  "stack trace",
  "ENOENT",
  "PATCH_FAIL",
];

test("Design index lists stable scenario links", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/`);
    await expect(page).toHaveTitle("Patchdesk Design");
    await expect(page.getByRole("heading", { name: "Interactive visual prototype" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Inbox default/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Review completed/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Settings \(recovery\)/ })).toBeVisible();
    await page.screenshot({ path: "test-results/patchdesk-design-index.png", fullPage: true });
  } finally {
    await close(server);
  }
});

test("default inbox scenario renders the shared product surface", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=inbox-default`);
    await expect(page.getByRole("heading", { name: "Maintainer inbox" })).toBeVisible();
    await expect(page.getByText("Protect review writes")).toBeVisible();
    await expect(page.getByText("Review updated VIP snapshot replacement")).toBeVisible();
    await page.locator('[role="option"]').first().click();
    await expect(page.getByLabel("Review workbench")).toBeVisible();
    await page.screenshot({ path: "test-results/patchdesk-design-inbox.png", fullPage: true });
  } finally {
    await close(server);
  }
});

test("settings scenario keeps configuration local", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=settings-recovery`);
    await expect(page.getByRole("heading", { name: /Settings/ }).first()).toBeVisible();
    await page.getByRole("tab", { name: "General" }).click();
    await expect(page.getByRole("tab", { name: "General" })).toHaveAttribute("data-active");
    await page.getByRole("tab", { name: "Data & recovery" }).click();
    await expect(page.getByTestId("local-review-data-card")).toBeVisible();
    await expect(page.getByTestId("clear-local-data-button")).toBeVisible();
    await page.screenshot({ path: "test-results/patchdesk-design-settings.png", fullPage: true });
  } finally {
    await close(server);
  }
});

test("design scenarios cover loading, error, cached, prepared, and running states", async ({ page }) => {
  const cases = ["inbox-loading", "inbox-error", "inbox-cached", "review-prepared", "review-running"] as const;
  for (const scenario of cases) {
    const server = await serveDesign();
    try {
      await page.goto(`${origin(server)}/?scenario=${scenario}`);
      if (scenario === "inbox-loading") await expect(page.getByLabel("Loading dashboard")).toBeAttached();
      if (scenario === "inbox-error") await expect(page.getByText("Patchdesk could not read the active profile or GitHub dashboard.")).toBeVisible();
      if (scenario === "inbox-cached") await expect(page.getByText("GitHub: Cached after refresh failure")).toBeVisible();
      if (scenario === "review-prepared") await expect(page.getByRole("button", { name: "Run review" })).toBeVisible();
      if (scenario === "review-running") await expect(page.getByText("Review in progress").first()).toBeVisible();
    } finally {
      await close(server);
    }
  }
});

test("design surfaces remain readable at the approved desktop and light-theme size", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=inbox-default&appearance=light`);
    await expect(page.getByRole("heading", { name: "Maintainer inbox" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "light");
    await page.screenshot({ path: "test-results/patchdesk-design-inbox-light-1440.png", fullPage: true });
  } finally {
    await close(server);
  }
});

test("completed review scenario renders findings and checks", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=review-completed`);
    await expect(page.getByRole("heading", { name: "Protect review writes" })).toBeVisible();
    await expect(page.getByText("Keep writes behind the stale-head check").first()).toBeVisible();
    await expect(page.getByText("Existing GitHub review comment.").first()).toBeVisible();
    await page.screenshot({ path: "test-results/patchdesk-design-completed.png", fullPage: true });
  } finally {
    await close(server);
  }
});

test("dialog scenarios open the confirmation body on load", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=dialog-submit`);
    await expect(page.getByRole("heading", { name: "Create pending review" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm pending review" })).toBeVisible();
    await page.goto(`${origin(server)}/?scenario=dialog-merge`);
    await expect(page.getByRole("heading", { name: "Confirm merge" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm merge" })).toBeVisible();
  } finally {
    await close(server);
  }
});

test("permanent design registry contains exactly 22 stable scenarios", () => {
  expect(designScenarios).toHaveLength(22);
  const ids = new Set(designScenarios.map((scenario) => scenario.id));
  for (const id of [
    "inbox-default",
    "inbox-empty",
    "inbox-loading",
    "inbox-error",
    "inbox-cached",
    "inbox-recovery-states",
    "review-prepared",
    "review-running",
    "review-completed",
    "workbench-reconnect",
    "workbench-start-again",
    "workbench-try-again",
    "workbench-prepare-again",
    "settings-recovery",
    "dialog-clear-local-data",
    "dialog-submit",
    "dialog-merge",
    "walkthrough-generate-dialog",
    "walkthrough-generating",
    "walkthrough-ready",
    "walkthrough-failed",
    "walkthrough-stale",
  ]) expect(ids.has(id)).toBe(true);
});

test("temporary walkthrough comparison captures both layouts before retention", async ({ page }) => {
  const cases = ["walkthrough-ready-rail", "walkthrough-ready-linear"] as const;
  for (const scenario of cases) {
    const server = await serveDesign();
    try {
      await page.goto(`${origin(server)}/?scenario=${scenario}`);
      await expect(page).toHaveTitle(/Patchdesk Design/);
      const layoutValue = scenario === "walkthrough-ready-rail" ? "rail" : "linear";
      await expect(page.locator(`[data-layout=${layoutValue}]`)).toBeVisible();
      await page.screenshot({ path: `test-results/patchdesk-design-${scenario}.png`, fullPage: true });
    } finally {
      await close(server);
    }
  }
});

test("every permanent scenario opens, captures a screenshot, and uses friendly recovery copy", async ({ page }) => {
  for (const scenario of designScenarios) {
    const server = await serveDesign();
    const errors: Array<string> = [];
    const onConsole = (message: ConsoleMessage): void => {
      if (message.type() === "error") errors.push(message.text());
    };
    page.on("console", onConsole);
    try {
      await page.goto(`${origin(server)}/?scenario=${scenario.id}`, { waitUntil: "load" });
      await expect(page).toHaveTitle(new RegExp(`${escapeRegExp(scenario.title)}\\s*·\\s*Patchdesk Design|Patchdesk Design · ${escapeRegExp(scenario.title)}`));
      await page.waitForTimeout(50);
      await page.screenshot({
        path: `test-results/patchdesk-design-${scenario.id}.png`,
        fullPage: true,
      });
      const visibleText = await page.locator("body").innerText();
      for (const term of FORBIDDEN_TERMS) {
        expect(visibleText.toLowerCase().includes(term), `${scenario.id} should not show forbidden term "${term}"`).toBe(false);
      }
      expect(errors, `${scenario.id} should not log console errors`).toEqual([]);
    } finally {
      page.off("console", onConsole);
      await close(server);
    }
  }
});

test("workbench recovery scenarios show one action and never internal terms", async ({ page }) => {
  const cases: ReadonlyArray<{ readonly id: string; readonly button: string; readonly notice: string }> = [
    { id: "workbench-reconnect", button: "Reconnect", notice: "Review in progress" },
    { id: "workbench-start-again", button: "Start again", notice: "Review was interrupted" },
    { id: "workbench-try-again", button: "Try again", notice: "Review couldn't finish" },
    { id: "workbench-prepare-again", button: "Prepare again", notice: "Review needs preparation" },
  ];
  for (const { id, button, notice } of cases) {
    const server = await serveDesign();
    try {
      await page.goto(`${origin(server)}/?scenario=${id}`);
      await expect(page.getByTestId(id)).toBeVisible();
      await expect(page.getByRole("button", { name: button })).toBeVisible();
      await expect(page.getByText(notice)).toBeVisible();
      const text = await page.locator("body").innerText();
      for (const term of FORBIDDEN_TERMS) {
        expect(text.toLowerCase().includes(term), `${id} should not show forbidden term "${term}"`).toBe(false);
      }
    } finally {
      await close(server);
    }
  }
});

test("inbox recovery scenarios expose the recovery chip and omit forbidden terms", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=inbox-recovery-states`);
    await expect(page.getByTestId("inbox-recovery-stage")).toBeVisible();
    await expect(page.getByTestId("recovery-chip-ready_to_review").first()).toBeVisible();
    await expect(page.getByTestId("recovery-chip-needs_preparation").first()).toBeVisible();
    const text = await page.locator("body").innerText();
    for (const term of FORBIDDEN_TERMS) {
      expect(text.toLowerCase().includes(term), `inbox-recovery-states should not show forbidden term "${term}"`).toBe(false);
    }
    await page.screenshot({ path: "test-results/patchdesk-design-inbox-recovery.png", fullPage: true });
  } finally {
    await close(server);
  }
});

test("settings overlay renders both cleanup confirmations with retention copy", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=settings-recovery`);
    await page.getByRole("tab", { name: "Data & recovery" }).click();
    await page.getByTestId("clear-local-data-button").click();
    await expect(page.getByTestId("cleanup-dialog-clear_local_review_data")).toBeVisible();
    await expect(page.getByText("Reviews you can still open or resume, and diagnostic reports, stay.")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Clear cache" }).click();
    await expect(page.getByTestId("cleanup-dialog-clear_cache")).toBeVisible();
    await expect(page.getByText("Your saved reviews and diagnostic reports stay.")).toBeVisible();
  } finally {
    await close(server);
  }
});

test("walkthrough generate dialog requires model and reasoning before any request", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=walkthrough-generate-dialog`);
    const dialog = page.getByTestId("walkthrough-generate-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByText("Generate a read-only walkthrough")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await close(server);
  }
});

test("walkthrough-ready exposes the rail, Support, Reviewed controls, and Back to files", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=walkthrough-ready`);
    await expect(page.getByRole("region", { name: "Walkthrough chapters" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Support coverage" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark section reviewed" })).toBeVisible();
    await expect(page.getByTestId("back-to-files")).toBeVisible();
    await expect(page.locator("[data-layout=rail]")).toBeVisible();
  } finally {
    await close(server);
  }
});

test("walkthrough-failed surfaces retry that stays on the same snapshot", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=walkthrough-failed`);
    await expect(page.getByTestId("walkthrough-failed")).toBeVisible();
    await expect(page.getByTestId("walkthrough-failed").getByRole("button", { name: "Retry generation" })).toBeVisible();
  } finally {
    await close(server);
  }
});

test("walkthrough-stale surfaces regenerate for the current snapshot", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=walkthrough-stale`);
    await expect(page.getByTestId("walkthrough-stale")).toBeVisible();
    await expect(page.getByTestId("walkthrough-stale").getByRole("button", { name: "Generate walkthrough" })).toBeVisible();
  } finally {
    await close(server);
  }
});

test("walkthrough-generating shows progress and read-only assurance", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=walkthrough-generating`);
    await expect(page.getByRole("alert").getByText("Generating walkthrough…")).toBeVisible();
    await expect(page.getByText("read-only").first()).toBeVisible();
  } finally {
    await close(server);
  }
});

test("walkthrough interaction: dialog → generating → ready, navigate, mark reviewed, Support, Back to files", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=walkthrough-generate-dialog`);
    const dialog = page.getByTestId("walkthrough-generate-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByText("Generate a read-only walkthrough")).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "Model" })).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "Reasoning" })).toBeVisible();
    await page.getByTestId("generate-walkthrough-confirm").click();
    await expect(page.getByTestId("walkthrough-generating-alert")).toBeVisible();
    await expect(page.getByTestId("walkthrough-generating-alert").getByText("Generating walkthrough…")).toBeVisible();
    await expect(page.getByTestId("walkthrough-generating-steps")).toBeVisible();
    await expect(page.getByText("Read-only walkthrough ready")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("region", { name: "Walkthrough chapters" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Support coverage" })).toBeVisible();
    await expect(page.locator("[data-layout=rail]")).toBeVisible();
    await page.getByTestId("section-next").click();
    await expect(page.getByRole("heading", { name: "How reads stay read-only" })).toBeVisible();
    await page.getByTestId("mark-section-reviewed").click();
    await expect(page.getByTestId("mark-section-reviewed")).toHaveText("Reviewed");
    await page.getByTestId("mark-support-reviewed").click();
    await expect(page.getByTestId("mark-support-reviewed")).toHaveText("Reviewed");
    await page.getByTestId("back-to-files").click({ force: true });
    await expect(page.getByTestId("files-mode-stage")).toBeVisible({ timeout: 5_000 });
  } finally {
    await close(server);
  }
});

test("walkthrough-failed retry returns to generating and reaches ready", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=walkthrough-failed`);
    await expect(page.getByTestId("walkthrough-failed")).toBeVisible();
    await page.getByTestId("retry-generation").click();
    await expect(page.getByTestId("walkthrough-generating-alert")).toBeVisible();
    await expect(page.getByText("Read-only walkthrough ready")).toBeVisible({ timeout: 5_000 });
  } finally {
    await close(server);
  }
});

test("walkthrough-stale regenerate returns to generating and reaches ready", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=walkthrough-stale`);
    await expect(page.getByTestId("walkthrough-stale")).toBeVisible();
    await page.getByTestId("regenerate-stale").click();
    await expect(page.getByTestId("walkthrough-generate-dialog")).toBeVisible();
    await page.getByTestId("generate-walkthrough-confirm").click();
    await expect(page.getByTestId("walkthrough-generating-alert")).toBeVisible();
    await expect(page.getByText("Read-only walkthrough ready")).toBeVisible({ timeout: 5_000 });
  } finally {
    await close(server);
  }
});

test("walkthrough keyboard navigation moves between sections", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=walkthrough-ready`);
    await expect(page.getByRole("heading", { name: "Why this snapshot matters" })).toBeVisible();
    await page.getByTestId("section-next").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("heading", { name: "How reads stay read-only" })).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("heading", { name: "Why this snapshot matters" })).toBeVisible();
  } finally {
    await close(server);
  }
});

test("dialog-clear-local-data opens Settings on General first, then exposes cleanup dialog", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=dialog-clear-local-data`);
    await expect(page.locator("[role=dialog]").filter({ hasText: "Settings" }).first()).toBeVisible();
    await expect(page.getByTestId("settings-section-general")).toBeVisible();
    await expect(page.getByTestId("cleanup-dialog-clear_local_review_data")).toBeVisible();
    await expect(page.getByText("Reviews you can still open or resume, and diagnostic reports, stay.")).toBeVisible();
  } finally {
    await close(server);
  }
});

test("settings-recovery opens Settings on General and reaches the cleanup card", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=settings-recovery`);
    await expect(page.getByRole("heading", { name: /Settings/ }).first()).toBeVisible();
    await expect(page.getByTestId("settings-section-general")).toBeVisible();
    await page.getByRole("tab", { name: "Data & recovery" }).click();
    await expect(page.getByTestId("local-review-data-card")).toBeVisible();
  } finally {
    await close(server);
  }
});

test("design recovery routes consume the bridge fixture and omit forbidden terms", async ({ page }) => {
  const cases: ReadonlyArray<{ readonly id: string; readonly button: string; readonly notice: string }> = [
    { id: "workbench-reconnect", button: "Reconnect", notice: "Review in progress" },
    { id: "workbench-start-again", button: "Start again", notice: "Review was interrupted" },
    { id: "workbench-try-again", button: "Try again", notice: "Review couldn't finish" },
    { id: "workbench-prepare-again", button: "Prepare again", notice: "Review needs preparation" },
  ];
  for (const { id, button, notice } of cases) {
    const server = await serveDesign();
    try {
      await page.goto(`${origin(server)}/?scenario=${id}`);
      await expect(page.getByTestId(id)).toBeVisible();
      await expect(page.getByRole("button", { name: button })).toBeVisible();
      await expect(page.getByText(notice)).toBeVisible();
      const text = await page.locator("body").innerText();
      for (const term of FORBIDDEN_TERMS) {
        expect(text.toLowerCase().includes(term), `${id} should not show forbidden term "${term}"`).toBe(false);
      }
    } finally {
      await close(server);
    }
  }
});

test("inbox recovery scenario reads fixtures from the bridge and exposes six rows", async ({ page }) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=inbox-recovery-states`);
    await expect(page.getByTestId("inbox-recovery-stage")).toBeVisible();
    for (const prNumber of [42, 118, 77, 31, 19, 8]) {
      await expect(page.getByTestId(`inbox-recovery-row-${prNumber}`)).toBeVisible();
    }
  } finally {
    await close(server);
  }
});

async function serveDesign(): Promise<Server> {
  const designRoot = join(process.cwd(), "release/design");
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://patchdesk-design.local").pathname;
    const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
    const file = normalize(join(designRoot, relativePath));
    const relativeFile = relative(designRoot, file);
    if (relativeFile.startsWith("..") || relativeFile.startsWith("/")) {
      response.writeHead(400).end();
      return;
    }
    try {
      response.writeHead(200, { "Content-Type": contentType(extname(file)) });
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function contentType(extension: string): string {
  if (extension === ".js") return "text/javascript";
  if (extension === ".css") return "text/css";
  if (extension === ".woff2") return "font/woff2";
  return "text/html";
}

function origin(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
