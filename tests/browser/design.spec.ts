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
    await expect(
      page.getByRole("heading", { name: "Interactive visual prototype" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Inbox default/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Review completed/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Settings \(recovery\)/ }),
    ).toBeVisible();
  } finally {
    await close(server);
  }
});

test("default inbox scenario renders the shared product surface", async ({
  page,
}) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=inbox-default`);
    await expect(
      page.getByRole("heading", { name: "Maintainer inbox" }),
    ).toBeVisible();
    await expect(page.getByText("Protect review writes")).toBeVisible();
    await expect(
      page.getByText("Review updated VIP snapshot replacement"),
    ).toBeVisible();
    await page.locator('[role="option"]').first().click();
    await expect(page.getByLabel("Review workbench")).toBeVisible();
  } finally {
    await close(server);
  }
});

test("settings scenario keeps configuration local", async ({ page }) => {
  await page.setViewportSize({ width: 1064, height: 1478 });
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=settings-recovery`);
    await expect(
      page.getByRole("heading", { name: /Settings/ }).first(),
    ).toBeVisible();
    await page.getByRole("tab", { name: "General" }).click();
    await expect(page.getByRole("tab", { name: "General" })).toHaveAttribute(
      "data-active",
    );
    await page.getByRole("tab", { name: "Data & recovery" }).click();
    await expect(page.getByTestId("local-review-data-card")).toBeVisible();
    await expect(page.getByTestId("clear-local-data-button")).toBeVisible();
  } finally {
    await close(server);
  }
});

test("design scenarios cover loading, error, cached, prepared, and running states", async ({
  page,
}) => {
  const cases = [
    "inbox-loading",
    "inbox-error",
    "inbox-cached",
    "review-prepared",
    "review-running",
  ] as const;
  for (const scenario of cases) {
    const server = await serveDesign();
    try {
      await page.goto(`${origin(server)}/?scenario=${scenario}`);
      if (scenario === "inbox-loading")
        await expect(page.getByLabel("Loading dashboard")).toBeAttached();
      if (scenario === "inbox-error")
        await expect(
          page.getByText(
            "Patchdesk could not read the active profile or GitHub dashboard.",
          ),
        ).toBeVisible();
      if (scenario === "inbox-cached")
        await expect(
          page.getByText("GitHub: Cached after refresh failure"),
        ).toBeVisible();
      if (scenario === "review-prepared")
        await expect(
          page.getByRole("button", { name: "Run analysis" }),
        ).toBeVisible();
      if (scenario === "review-running")
        await expect(
          page.getByText("Review in progress").first(),
        ).toBeVisible();
    } finally {
      await close(server);
    }
  }
});

test("design surfaces remain readable at the approved desktop and light-theme size", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = await serveDesign();
  try {
    await page.goto(
      `${origin(server)}/?scenario=inbox-default&appearance=light`,
    );
    await expect(
      page.getByRole("heading", { name: "Maintainer inbox" }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute(
      "data-appearance",
      "light",
    );
  } finally {
    await close(server);
  }
});

test("prepared workbench target opens Files with a single analysis action", async ({
  page,
}) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=review-prepared`);
    await expect(page.getByTestId("design-review-prepared")).toBeVisible();
    await expect(page.getByText("Snapshot · no GitHub writes")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Checks · Failing" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Generate walkthrough" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Run analysis" }),
    ).toBeVisible();
    await expect(page.getByText("Files").first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Refresh GitHub state" }),
    ).toHaveCount(0);
  } finally {
    await close(server);
  }
});

test("completed workbench target groups the journey into Understand, Decide, and Publish", async ({
  page,
}) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=review-completed`);
    await expect(page.getByTestId("design-review-completed")).toBeVisible();
    await expect(page.getByTestId("design-understand")).toBeVisible();
    await expect(page.getByTestId("design-decide")).toBeVisible();
    await expect(page.getByTestId("design-publish")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Publish review" }),
    ).toHaveCount(0);
  } finally {
    await close(server);
  }
});

test("prepared review scenario opens local PR overview from the checks control", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1611, height: 976 });
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=review-prepared`);
    await expect(page.getByTestId("design-review-prepared")).toBeVisible();
    await page.getByRole("button", { name: "Checks · Failing" }).click();
    await expect(
      page.getByRole("dialog", { name: "PR overview" }),
    ).toBeVisible();
    await expect(page.getByText("Required").first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Refresh GitHub state" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Refresh GitHub state" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "GitHub state refreshed locally." }),
    ).toBeVisible();
  } finally {
    await close(server);
  }
});

test("dialog scenarios open the confirmation body on load", async ({
  page,
}) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=dialog-submit`);
    await expect(
      page.getByRole("heading", { name: "Apply this review batch to GitHub?" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create pending review" }),
    ).toBeVisible();
    await page.goto(`${origin(server)}/?scenario=dialog-merge`);
    await expect(
      page.getByRole("heading", { name: "Confirm merge" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Confirm merge" }),
    ).toBeVisible();
  } finally {
    await close(server);
  }
});

test("publish confirmation target names saved actions and merge warnings", async ({
  page,
}) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=dialog-submit`);
    await expect(page.getByTestId("design-submit-confirmation")).toContainText(
      "2 inline comments · 1 reply · 1 thread change",
    );

    await page.goto(`${origin(server)}/?scenario=dialog-merge`);
    await expect(page.getByTestId("design-merge-confirmation")).toContainText(
      "Required checks are failing",
    );
    await expect(
      page.getByRole("checkbox", {
        name: "I acknowledge that required checks are failing",
      }),
    ).toBeVisible();
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
  ])
    expect(ids.has(id)).toBe(true);
});

test("every permanent scenario opens and uses friendly recovery copy", async ({
  page,
}) => {
  for (const scenario of designScenarios) {
    const server = await serveDesign();
    const errors: Array<string> = [];
    const onConsole = (message: ConsoleMessage): void => {
      if (message.type() === "error") errors.push(message.text());
    };
    page.on("console", onConsole);
    try {
      await page.goto(`${origin(server)}/?scenario=${scenario.id}`, {
        waitUntil: "load",
      });
      await expect(page).toHaveTitle(
        new RegExp(
          `${escapeRegExp(scenario.title)}\\s*·\\s*Patchdesk Design|Patchdesk Design · ${escapeRegExp(scenario.title)}`,
        ),
      );
      await page.waitForTimeout(50);
      const visibleText = await page.locator("body").innerText();
      for (const term of FORBIDDEN_TERMS) {
        expect(
          visibleText.toLowerCase().includes(term),
          `${scenario.id} should not show forbidden term "${term}"`,
        ).toBe(false);
      }
      expect(errors, `${scenario.id} should not log console errors`).toEqual(
        [],
      );
    } finally {
      page.off("console", onConsole);
      await close(server);
    }
  }
});

test("workbench recovery scenarios show one action and never internal terms", async ({
  page,
}) => {
  const cases: ReadonlyArray<{
    readonly id: string;
    readonly button: string;
    readonly notice: string;
    readonly snapshotReadable: boolean;
  }> = [
    {
      id: "workbench-reconnect",
      button: "Reconnect",
      notice: "Review in progress",
      snapshotReadable: true,
    },
    {
      id: "workbench-start-again",
      button: "Restart interrupted analysis",
      notice: "Review was interrupted",
      snapshotReadable: true,
    },
    {
      id: "workbench-try-again",
      button: "Retry failed analysis",
      notice: "Review couldn't finish",
      snapshotReadable: true,
    },
    {
      id: "workbench-prepare-again",
      button: "Prepare again",
      notice: "Review needs preparation",
      snapshotReadable: false,
    },
  ];
  for (const { id, button, notice, snapshotReadable } of cases) {
    const server = await serveDesign();
    try {
      await page.goto(`${origin(server)}/?scenario=${id}`);
      await expect(page.getByTestId(id)).toBeVisible();
      await expect(page.getByRole("button", { name: button })).toBeVisible();
      await expect(page.getByTestId("back-to-inbox")).toBeVisible();
      await expect(page.getByTestId("view-snapshot")).toHaveCount(
        snapshotReadable ? 1 : 0,
      );
      await expect(page.getByText(notice)).toBeVisible();
      const text = await page.locator("body").innerText();
      for (const term of FORBIDDEN_TERMS) {
        expect(
          text.toLowerCase().includes(term),
          `${id} should not show forbidden term "${term}"`,
        ).toBe(false);
      }
    } finally {
      await close(server);
    }
  }
});

test("inbox recovery scenarios expose the recovery chip and omit forbidden terms", async ({
  page,
}) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=inbox-recovery-states`);
    await expect(page.getByTestId("inbox-recovery-stage")).toBeVisible();
    await expect(
      page.getByTestId("recovery-chip-ready_to_review").first(),
    ).toBeVisible();
    await expect(
      page.getByTestId("recovery-chip-needs_preparation").first(),
    ).toBeVisible();
    const text = await page.locator("body").innerText();
    for (const term of FORBIDDEN_TERMS) {
      expect(
        text.toLowerCase().includes(term),
        `inbox-recovery-states should not show forbidden term "${term}"`,
      ).toBe(false);
    }
  } finally {
    await close(server);
  }
});

test("settings overlay renders both cleanup confirmations with retention copy", async ({
  page,
}) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=settings-recovery`);
    await page.getByRole("tab", { name: "Data & recovery" }).click();
    await page.getByTestId("clear-local-data-button").click();
    await expect(
      page.getByTestId("cleanup-dialog-clear_local_review_data"),
    ).toBeVisible();
    await expect(
      page.getByText(
        "This removes completed and failed local reviews. An active review and diagnostic reports stay.",
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Clear cache" }).click();
    await expect(page.getByTestId("cleanup-dialog-clear_cache")).toBeVisible();
    await expect(
      page.getByText("Your saved reviews and diagnostic reports stay."),
    ).toBeVisible();
  } finally {
    await close(server);
  }
});

test("walkthrough generate dialog keeps model overrides behind advanced options", async ({
  page,
}) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=walkthrough-generate-dialog`);
    const dialog = page.getByTestId("walkthrough-generate-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByText("Generate a read-only walkthrough")).toBeVisible();
    await expect(page.getByRole("button", { name: "Advanced options" })).toBeVisible();
    await expect(dialog.getByRole("combobox")).toHaveCount(0);
    await page.getByRole("button", { name: "Advanced options" }).click();
    await expect(dialog.getByRole("combobox", { name: "Model" })).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "Reasoning" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await close(server);
  }
});

test("walkthrough-ready exposes a reading rail with read controls and Back to files", async ({
  page,
}) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=walkthrough-ready`);
    await expect(
      page.getByRole("region", { name: "Walkthrough chapters" }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Support coverage" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Mark section as read" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Regenerate walkthrough" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Add inline draft comment" }),
    ).toHaveCount(0);
    await expect(page.getByTestId("walkthrough-reading-surface")).toBeVisible();
    await expect(page.locator('[data-layout="rail"]')).toHaveClass(
      /lg:grid-cols-/,
    );
    await expect(page.getByTestId("back-to-files")).toBeVisible();
    await expect(page.locator("[data-layout=rail]")).toBeVisible();
  } finally {
    await close(server);
  }
});

test("walkthrough edge states keep one lifecycle action and no reading surface", async ({
  page,
}) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=walkthrough-failed`);
    await expect(page.getByTestId("walkthrough-failed")).toBeVisible();
    await expect(page.getByTestId("walkthrough-primary-action")).toHaveText(
      "Retry generation",
    );
    await expect(page.getByRole("button", { name: "Retry generation" })).toHaveCount(1);
    await expect(page.getByTestId("walkthrough-reading-surface")).toHaveCount(0);

    await page.goto(`${origin(server)}/?scenario=walkthrough-stale`);
    await expect(page.getByTestId("walkthrough-stale")).toBeVisible();
    await expect(page.getByRole("button", { name: "Regenerate walkthrough" })).toHaveCount(1);
    await expect(page.getByText("Why this snapshot matters")).toHaveCount(0);
    await expect(page.getByTestId("walkthrough-reading-surface")).toHaveCount(0);
  } finally {
    await close(server);
  }
});

test("walkthrough-generating shows progress and read-only assurance", async ({
  page,
}) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=walkthrough-generating`);
    await expect(
      page.getByRole("alert").getByText("Generating walkthrough…"),
    ).toBeVisible();
    await expect(page.getByText("read-only").first()).toBeVisible();
  } finally {
    await close(server);
  }
});

test("walkthrough interaction: dialog → generating → ready, navigate, mark read, Support, Back to files", async ({
  page,
}) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=walkthrough-generate-dialog`);
    const dialog = page.getByTestId("walkthrough-generate-dialog");
    await expect(dialog).toBeVisible();
    await expect(
      page.getByText("Generate a read-only walkthrough"),
    ).toBeVisible();
    await expect(dialog.getByRole("combobox")).toHaveCount(0);
    await page.getByTestId("generate-walkthrough-confirm").click();
    await expect(
      page.getByTestId("walkthrough-generating-alert"),
    ).toBeVisible();
    await expect(
      page
        .getByTestId("walkthrough-generating-alert")
        .getByText("Generating walkthrough…"),
    ).toBeVisible();
    await expect(
      page.getByTestId("walkthrough-generating-steps"),
    ).toBeVisible();
    await expect(page.getByText("Read-only walkthrough ready")).toBeVisible({
      timeout: 5_000,
    });
    await expect(
      page.getByRole("region", { name: "Walkthrough chapters" }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Support coverage" }),
    ).toBeVisible();
    await expect(page.locator("[data-layout=rail]")).toBeVisible();
    await page.getByTestId("section-next").click();
    await expect(
      page.getByRole("heading", { name: "How reads stay read-only" }),
    ).toBeVisible();
    await page.getByTestId("mark-section-as-read").click();
    await expect(page.getByTestId("mark-section-as-read")).toHaveText(
      "Read",
    );
    await page.getByTestId("mark-support-as-read").click();
    await expect(page.getByTestId("mark-support-as-read")).toHaveText(
      "Read",
    );
    await page.getByTestId("back-to-files").click({ force: true });
    await expect(page.getByTestId("files-mode-stage")).toBeVisible({
      timeout: 5_000,
    });
  } finally {
    await close(server);
  }
});

test("walkthrough-failed retry returns to generating and reaches ready", async ({
  page,
}) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=walkthrough-failed`);
    await expect(page.getByTestId("walkthrough-failed")).toBeVisible();
    await page.getByTestId("walkthrough-primary-action").click();
    await expect(
      page.getByTestId("walkthrough-generating-alert"),
    ).toBeVisible();
    await expect(page.getByText("Read-only walkthrough ready")).toBeVisible({
      timeout: 5_000,
    });
  } finally {
    await close(server);
  }
});

test("walkthrough-stale regenerate returns to generating and reaches ready", async ({
  page,
}) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=walkthrough-stale`);
    await expect(page.getByTestId("walkthrough-stale")).toBeVisible();
    await page.getByTestId("walkthrough-primary-action").click();
    await expect(page.getByTestId("walkthrough-generate-dialog")).toBeVisible();
    await page.getByTestId("generate-walkthrough-confirm").click();
    await expect(
      page.getByTestId("walkthrough-generating-alert"),
    ).toBeVisible();
    await expect(page.getByText("Read-only walkthrough ready")).toBeVisible({
      timeout: 5_000,
    });
  } finally {
    await close(server);
  }
});

test("walkthrough keyboard navigation moves between sections", async ({
  page,
}) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=walkthrough-ready`);
    await expect(
      page.getByRole("heading", { name: "Why this snapshot matters" }),
    ).toBeVisible();
    await page.getByTestId("section-next").focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("heading", { name: "How reads stay read-only" }),
    ).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(
      page.getByRole("heading", { name: "Why this snapshot matters" }),
    ).toBeVisible();
  } finally {
    await close(server);
  }
});

test("dialog-clear-local-data opens Settings on General first, then exposes cleanup dialog", async ({
  page,
}) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=dialog-clear-local-data`);
    await expect(
      page.locator("[role=dialog]").filter({ hasText: "Settings" }).first(),
    ).toBeVisible();
    await expect(page.getByTestId("settings-section-general")).toBeVisible();
    await expect(
      page.getByTestId("cleanup-dialog-clear_local_review_data"),
    ).toBeVisible();
    await expect(
      page.getByText(
        "This removes completed and failed local reviews. An active review and diagnostic reports stay.",
      ),
    ).toBeVisible();
  } finally {
    await close(server);
  }
});

test("settings-recovery opens Settings on General and reaches the cleanup card", async ({
  page,
}) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=settings-recovery`);
    await expect(
      page.getByRole("heading", { name: /Settings/ }).first(),
    ).toBeVisible();
    await expect(page.getByTestId("settings-section-general")).toBeVisible();
    await page.getByRole("tab", { name: "Data & recovery" }).click();
    await expect(page.getByTestId("local-review-data-card")).toBeVisible();
    await page.getByRole("button", { name: "Load activity" }).click();
    await expect(
      page.getByRole("list", { name: "Review activity log" }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Workspace" }).click();
    await expect(page.getByRole("region", { name: "Watchlist" })).toBeVisible();
  } finally {
    await close(server);
  }
});

test("design recovery routes consume the bridge fixture and omit forbidden terms", async ({
  page,
}) => {
  const cases: ReadonlyArray<{
    readonly id: string;
    readonly button: string;
    readonly notice: string;
    readonly snapshotReadable: boolean;
  }> = [
    {
      id: "workbench-reconnect",
      button: "Reconnect",
      notice: "Review in progress",
      snapshotReadable: true,
    },
    {
      id: "workbench-start-again",
      button: "Restart interrupted analysis",
      notice: "Review was interrupted",
      snapshotReadable: true,
    },
    {
      id: "workbench-try-again",
      button: "Retry failed analysis",
      notice: "Review couldn't finish",
      snapshotReadable: true,
    },
    {
      id: "workbench-prepare-again",
      button: "Prepare again",
      notice: "Review needs preparation",
      snapshotReadable: false,
    },
  ];
  for (const { id, button, notice, snapshotReadable } of cases) {
    const server = await serveDesign();
    try {
      await page.goto(`${origin(server)}/?scenario=${id}`);
      await expect(page.getByTestId(id)).toBeVisible();
      await expect(page.getByRole("button", { name: button })).toBeVisible();
      await expect(page.getByTestId("back-to-inbox")).toBeVisible();
      await expect(page.getByTestId("view-snapshot")).toHaveCount(
        snapshotReadable ? 1 : 0,
      );
      await expect(page.getByText(notice)).toBeVisible();
      const text = await page.locator("body").innerText();
      for (const term of FORBIDDEN_TERMS) {
        expect(
          text.toLowerCase().includes(term),
          `${id} should not show forbidden term "${term}"`,
        ).toBe(false);
      }
    } finally {
      await close(server);
    }
  }
});

test("inbox recovery scenario reads fixtures from the bridge and exposes six rows", async ({
  page,
}) => {
  const server = await serveDesign();
  try {
    await page.goto(`${origin(server)}/?scenario=inbox-recovery-states`);
    await expect(page.getByTestId("inbox-recovery-stage")).toBeVisible();
    for (const prNumber of [42, 118, 77, 31, 19, 8]) {
      await expect(
        page.getByTestId(`inbox-recovery-row-${prNumber}`),
      ).toBeVisible();
    }
  } finally {
    await close(server);
  }
});

async function serveDesign(): Promise<Server> {
  const designRoot = join(process.cwd(), "release/design");
  const server = createServer(async (request, response) => {
    const pathname = new URL(
      request.url ?? "/",
      "http://patchdesk-design.local",
    ).pathname;
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
  if (address === null || typeof address === "string")
    throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
