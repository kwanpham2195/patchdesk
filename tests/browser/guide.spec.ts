import { expect, test, type Locator } from "playwright/test";
import { closeServer, serveRenderer, serverOrigin } from "./renderer-server";

test("Guide expands complete retained files independently and preserves evidence during generation", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${serverOrigin(server)}/#guide-fixture`);
    const first = page.getByRole("list", {
      name: "Recover pending requests files",
    });
    const second = page.getByRole("list", {
      name: "Keep the recovery owner together files",
    });
    const file = first.getByRole("button", { name: "File src/recovery.ts" });
    await expect(file).toHaveAttribute("aria-expanded", "false");
    await file.click();
    const evidence = first.getByRole("group", {
      name: "Guide evidence src/recovery.ts",
    });
    for (const line of [
      "old",
      "oldCleanup()",
      "restorePending()",
      "snapshotCleanup()",
      ...Array.from(
        { length: 80 },
        (_, index) => `snapshotSupport${index + 1}()`,
      ),
    ]) {
      const changedLine = evidence.getByText(line, { exact: true });
      await changedLine.scrollIntoViewIfNeeded();
      await expect(changedLine).toBeVisible();
    }
    await expect(evidence).toContainText("old mode 100644");
    await expect(evidence).toContainText("new mode 100755");
    await first
      .getByRole("button", { name: "File tests/recovery.test.ts" })
      .click();
    await expect(
      first.getByText("expectRecovered()", { exact: true }),
    ).toBeVisible();
    await expect(
      second.getByRole("button", { name: "File src/recovery.ts" }),
    ).toHaveAttribute("aria-expanded", "false");
    await second.getByRole("button", { name: "File src/recovery.ts" }).click();
    await file.click();
    await expect(
      second.getByRole("group", { name: "Guide evidence src/recovery.ts" }),
    ).toBeVisible();
    await expect(
      first.getByRole("group", { name: "Guide evidence src/recovery.ts" }),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "Show outdated revision" }).click();
    await expect(
      second
        .getByRole("group", { name: "Guide evidence src/recovery.ts" })
        .getByText("snapshotCleanup()", { exact: true }),
    ).toBeVisible();
    await second.getByRole("button", { name: "File src/new.ts" }).click();
    await expect(
      second.getByRole("group", { name: "Guide evidence src/new.ts" }),
    ).toContainText("rename from src/old.ts");
    const others = page.getByRole("list", { name: "Others files" });
    await others.getByRole("button", { name: "File src/deleted.ts" }).click();
    await expect(
      others.getByText("obsoleteSnapshot()", { exact: true }),
    ).toBeVisible();
    await others.getByRole("button", { name: "File assets/icon.png" }).click();
    await expect(
      others.getByRole("group", { name: "Guide evidence assets/icon.png" }),
    ).toContainText(
      "Binary files a/assets/icon.png and b/assets/icon.png differ",
    );
    await others.getByRole("button", { name: "File scripts/check.sh" }).click();
    await expect(
      others.getByRole("group", { name: "Guide evidence scripts/check.sh" }),
    ).toContainText("new mode 100755");

    await page
      .getByRole("button", { name: "Generate Guide with fake provider" })
      .click();
    await expect(
      second.getByRole("button", { name: "File src/recovery.ts" }),
    ).toHaveAttribute("aria-expanded", "true");
    await page
      .getByRole("button", { name: "Complete fake generation" })
      .click();
    await expect(
      second.getByRole("button", { name: "File src/recovery.ts" }),
    ).toHaveAttribute("aria-expanded", "false");
  } finally {
    await closeServer(server);
  }
});

async function openGuideComposer(files: Locator): Promise<void> {
  await files.getByRole("button", { name: "File src/recovery.ts" }).click();
  const cell = files
    .locator('[data-column-number="1"][data-line-type="change-addition"]')
    .first();
  const gutter = files.locator("[data-utility-button]").first();
  await expect
    .poll(async () => {
      await cell.hover();
      return gutter.isVisible();
    })
    .toBe(true);
  await gutter.click();
}

test("Guide shares notes and Viewed with repeated appearances and Diff, then disables stale evidence", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${serverOrigin(server)}/#guide-fixture`);
    const first = page.getByRole("list", {
      name: "Recover pending requests files",
    });
    const second = page.getByRole("list", {
      name: "Keep the recovery owner together files",
    });
    await openGuideComposer(first);
    await page
      .getByRole("textbox", { name: "Note", exact: true })
      .fill("Check interrupted recovery.");
    await page.getByRole("button", { name: "Add note" }).click();
    await expect(first.getByRole("article", { name: /Note on/ })).toContainText(
      "Check interrupted recovery.",
    );
    await second.getByRole("button", { name: "File src/recovery.ts" }).click();
    await expect(
      second.getByRole("article", { name: /Note on/ }),
    ).toContainText("Check interrupted recovery.");
    await first.getByRole("button", { name: "Viewed src/recovery.ts" }).click();
    await expect(
      second.getByRole("button", { name: "Viewed src/recovery.ts" }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("tab", { name: "Diff", exact: true }).click();
    const viewed = page.getByRole("checkbox", {
      name: "Show file src/recovery.ts",
    });
    await expect(viewed).toBeChecked();
    await viewed.click();
    await expect(page.getByRole("article", { name: /Note on/ })).toContainText(
      "Check interrupted recovery.",
    );
    await page.getByRole("tab", { name: "Insights", exact: true }).click();
    await expect(
      first.getByRole("button", { name: "Viewed src/recovery.ts" }),
    ).toHaveAttribute("aria-pressed", "false");
    await openGuideComposer(first);
    await page.getByRole("button", { name: "Show outdated revision" }).click();
    await expect(
      page.getByRole("textbox", { name: "Note", exact: true }),
    ).toHaveCount(0);
    await expect(
      first.getByRole("button", { name: "Viewed src/recovery.ts" }),
    ).toBeDisabled();
    await expect(
      first.getByRole("group", { name: "Guide evidence src/recovery.ts" }),
    ).toContainText("restorePending()");
    await expect(first.locator("[data-utility-button]")).toHaveCount(0);
  } finally {
    await closeServer(server);
  }
});

test("Guide retains a refused pending draft in another appearance and Diff without remote writes", async ({
  page,
}) => {
  const server = await serveRenderer();
  const remoteRequests: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.protocol.startsWith("http") &&
      !["localhost", "127.0.0.1"].includes(url.hostname)
    ) {
      remoteRequests.push(url.href);
      await route.abort();
    } else await route.continue();
  });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${serverOrigin(server)}/#guide-fixture`);
    await page
      .getByRole("button", { name: "Use pending review fixture" })
      .click();
    const first = page.getByRole("list", {
      name: "Recover pending requests files",
    });
    const second = page.getByRole("list", {
      name: "Keep the recovery owner together files",
    });
    await openGuideComposer(first);
    await page
      .getByRole("textbox", { name: "Inline comment" })
      .fill("Check retry ordering.");
    await page.getByRole("button", { name: "Start a review" }).click();
    await expect(
      first.getByRole("article", { name: "Pending review write failed" }),
    ).toContainText("Check retry ordering.");
    await second.getByRole("button", { name: "File src/recovery.ts" }).click();
    await expect(
      second.getByRole("article", { name: "Pending review write failed" }),
    ).toContainText("Check retry ordering.");
    await page.getByRole("tab", { name: "Diff", exact: true }).click();
    await page
      .getByRole("article", { name: "Pending review write failed" })
      .getByRole("button", { name: "Edit draft" })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Inline comment" }),
    ).toHaveValue("Check retry ordering.");
    expect(remoteRequests).toEqual([]);
  } finally {
    await closeServer(server);
  }
});

for (const width of [1440, 560]) {
  test(`Guide explains beside its files at ${width}px without page overflow`, async ({
    page,
  }) => {
    const server = await serveRenderer();
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${serverOrigin(server)}/#guide-fixture`);
      const explanation = page.getByRole("region", {
        name: "Recover pending requests",
        exact: true,
      });
      const files = page.getByRole("list", {
        name: "Recover pending requests files",
      });
      await files.getByRole("button", { name: "File src/recovery.ts" }).click();
      await expect(
        files.getByText("restorePending()", { exact: true }),
      ).toBeVisible();
      const evidence = files.getByRole("group", {
        name: "Guide evidence src/recovery.ts",
      });
      await expect(evidence).toContainText("old mode 100644");
      await expect(evidence).toContainText("new mode 100755");
      const left = await explanation.boundingBox();
      const right = await files.boundingBox();
      if (left === null || right === null)
        throw new Error("Guide layout has no bounds");
      if (width > 768) {
        expect(right.x).toBeGreaterThan(left.x + left.width);
        expect(Math.abs(right.y - left.y)).toBeLessThan(2);
      } else {
        expect(right.y).toBeGreaterThan(left.y + left.height);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    } finally {
      await closeServer(server);
    }
  });
}
