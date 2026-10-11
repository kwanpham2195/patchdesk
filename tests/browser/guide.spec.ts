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
      await changedLine.evaluate((node) =>
        node.scrollIntoView({ block: "nearest" }),
      );
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

test("Guide restores Reviewed, expansions and its content anchor after a tab switch and resize", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${serverOrigin(server)}/#guide-fixture`);
    const first = page.getByRole("list", {
      name: "Recover pending requests files",
    });
    await first.getByRole("button", { name: "File src/recovery.ts" }).click();
    await page
      .getByRole("button", { name: "Reviewed Recover pending requests" })
      .click();
    const second = page.getByRole("list", {
      name: "Keep the recovery owner together files",
    });
    await second.getByRole("button", { name: "File src/recovery.ts" }).click();
    const target = page.locator("[data-guide-file='g2/f1']");
    await expect
      .poll(() =>
        target.evaluate((node) => {
          const viewport = node.closest("[data-guide-viewport]");
          if (viewport === null) throw new Error("No Guide viewport");
          return node.getBoundingClientRect().height - viewport.clientHeight;
        }),
      )
      .toBeGreaterThan(0);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await target.evaluate((node) => {
      const viewport = node.closest("[data-guide-viewport]");
      if (viewport === null) throw new Error("No Guide viewport");
      viewport.scrollTop +=
        node.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.getByRole("tab", { name: "Diff", exact: true }).click();
    await page.getByRole("tab", { name: "Insights", exact: true }).click();
    await expect(
      first.getByRole("button", { name: "File src/recovery.ts" }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByRole("button", { name: "Reviewed Recover pending requests" }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.setViewportSize({ width: 560, height: 900 });
    await expect
      .poll(() =>
        target.evaluate((node) =>
          Math.abs(
            node.getBoundingClientRect().top -
              (node.closest("[data-guide-viewport]")?.getBoundingClientRect()
                .top ?? Infinity),
          ),
        ),
      )
      .toBeLessThan(3);
  } finally {
    await closeServer(server);
  }
});

test("Guide holds tab navigation after a memory-only save fault until Retry confirms progress", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.goto(`${serverOrigin(server)}/#guide-fixture`);
    await page
      .getByRole("button", { name: "Fail Guide reading saves" })
      .click();
    const reviewed = page.getByRole("button", {
      name: "Reviewed Recover pending requests",
    });
    await reviewed.click();
    await expect(
      page.getByRole("button", { name: "Retry reading progress" }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Diff", exact: true }).click();
    await expect(
      page.getByRole("tab", { name: "Insights", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(reviewed).toHaveAttribute("aria-pressed", "true");
    await page
      .getByRole("button", { name: "Fail Guide reading saves" })
      .click();
    await page.getByRole("button", { name: "Retry reading progress" }).click();
    await expect(
      page.getByRole("button", { name: "Retry reading progress" }),
    ).toHaveCount(0);
    await page.getByRole("tab", { name: "Diff", exact: true }).click();
    await expect(
      page.getByRole("tab", { name: "Diff", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  } finally {
    await closeServer(server);
  }
});

async function openGuideComposer(files: Locator): Promise<void> {
  const expansion = files.getByRole("button", { name: "File src/recovery.ts" });
  if ((await expansion.getAttribute("aria-expanded")) !== "true")
    await expansion.click();
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
    await first
      .getByRole("checkbox", { name: "Viewed src/recovery.ts" })
      .click();
    await expect(
      second.getByRole("checkbox", { name: "Viewed src/recovery.ts" }),
    ).toBeChecked();
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
      first.getByRole("checkbox", { name: "Viewed src/recovery.ts" }),
    ).not.toBeChecked();
    await openGuideComposer(first);
    await page.getByRole("button", { name: "Show outdated revision" }).click();
    await expect(
      page.getByRole("textbox", { name: "Note", exact: true }),
    ).toHaveCount(0);
    await expect(
      first.getByRole("checkbox", { name: "Viewed src/recovery.ts" }),
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

async function expectGuideContentContained(content: Locator): Promise<void> {
  await expect(content).toBeVisible();
  expect(
    await content.evaluate((node) => {
      const row = node.closest("[data-guide-file]");
      const viewport = node.closest("[data-guide-viewport]");
      if (row === null || viewport === null)
        throw new Error("Missing Guide content bounds");
      const rowBounds = row.getBoundingClientRect();
      const viewportBounds = viewport.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(node);
      const rectangles = [
        node.getBoundingClientRect(),
        ...range.getClientRects(),
      ];
      return rectangles.every(
        (rectangle) =>
          rectangle.width > 0 &&
          rectangle.height > 0 &&
          rectangle.left >= Math.max(rowBounds.left, viewportBounds.left) &&
          rectangle.right <= Math.min(rowBounds.right, viewportBounds.right) &&
          rectangle.top >= Math.max(rowBounds.top, viewportBounds.top) &&
          rectangle.bottom <= Math.min(rowBounds.bottom, viewportBounds.bottom),
      );
    }),
  ).toBe(true);
}

for (const width of [560, 960]) {
  test(`Guide keeps disabled filenames and refusal reasons readable at ${width}px`, async ({
    page,
  }) => {
    const server = await serveRenderer();
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${serverOrigin(server)}/#guide-fixture`);
      await page
        .getByRole("button", { name: "Show outdated revision" })
        .click();
      const rows = page.locator("[data-guide-file]");
      expect(await rows.count()).toBeGreaterThan(0);
      for (const row of await rows.all()) {
        await row.scrollIntoViewIfNeeded();
        const expansion = row.getByRole("button", { name: /^File / });
        await expectGuideContentContained(expansion);
        await expectGuideContentContained(expansion.locator("strong"));
        const reason = row.getByRole("note");
        await expect(reason).toHaveText(
          "This Guide shows an older or unverified revision, so generate Guide for the current revision to review files.",
        );
        await expectGuideContentContained(reason);
        await expect(row.getByRole("checkbox")).toBeDisabled();
      }
      const first = page.getByRole("list", {
        name: "Recover pending requests files",
      });
      const second = page.getByRole("list", {
        name: "Keep the recovery owner together files",
      });
      await first.getByRole("button", { name: "File src/recovery.ts" }).click();
      await expect(
        first.getByRole("group", { name: "Guide evidence src/recovery.ts" }),
      ).toContainText("restorePending()");
      await expect(
        second.getByRole("button", { name: "File src/recovery.ts" }),
      ).toHaveAttribute("aria-expanded", "false");
      await expect(first.locator("[data-utility-button]")).toHaveCount(0);
      await expect(first.getByRole("checkbox").first()).toBeDisabled();
      await expect(
        page.getByRole("textbox", { name: "Note", exact: true }),
      ).toHaveCount(0);
    } finally {
      await closeServer(server);
    }
  });
}

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
