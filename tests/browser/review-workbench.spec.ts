import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { expect, test } from "playwright/test";

test("production walkthrough stays manual, supports review actions, and keeps the reader chrome quiet", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#walkthrough-fixture`);
    await expect(
      page.locator("[data-walkthrough-generate-requests]"),
    ).toHaveAttribute("data-walkthrough-generate-requests", "0");
    await page.getByRole("button", { name: "Generate walkthrough" }).click();
    const dialog = page.getByTestId("walkthrough-generate-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox", { name: "Model" }).click();
    await page.getByRole("option", { name: "Design model" }).click();
    await dialog.getByRole("combobox", { name: "Reasoning" }).click();
    await page.getByRole("option", { name: "High" }).click();
    await dialog.getByTestId("walkthrough-confirm").click();
    await expect(
      page.getByRole("button", { name: "Open walkthrough" }),
    ).toBeVisible();
    await expect(
      page.locator("[data-walkthrough-generate-requests]"),
    ).toHaveAttribute("data-walkthrough-generate-requests", "1");

    await page.getByRole("button", { name: "Open walkthrough" }).click();
    await expect(
      page.getByRole("button", { name: "Back to files" }),
    ).toHaveCount(0);
    await expect(page.getByText("Citations verified")).toHaveCount(0);
    await expect(page.getByText("Reading")).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Walkthrough chapters" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Keep the review local" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Previous section" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Next section" }),
    ).toBeEnabled();
    await expect(
      page.getByRole("region", { name: "Walkthrough chapters" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Mark section reviewed" }).click();
    await expect(
      page.getByRole("button", { name: "Section reviewed" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Support" }).click();
    await page.getByRole("button", { name: "Mark Support reviewed" }).click();
    await expect(
      page.getByRole("button", { name: "Support reviewed" }),
    ).toBeVisible();
    const walkthroughDiff = page.locator(
      '[data-walkthrough-diff-block="section-1::h1::0"]',
    );
    await expect(
      walkthroughDiff.getByRole("button", {
        name: "Add local comment on src/a.ts",
      }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Next section" }).click();
    await expect(
      page.getByRole("heading", { name: "Follow the changed path" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Previous section" }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Next section" }),
    ).toBeDisabled();

    await page.reload();
    await expect(
      page.getByRole("button", { name: "Generate walkthrough" }),
    ).toBeVisible();
    await expect(
      page.locator("[data-walkthrough-generate-requests]"),
    ).toHaveAttribute("data-walkthrough-generate-requests", "0");
  } finally {
    await close(server);
  }
});

test("Settings stays a centered General-first overlay on dashboard, Inbox, and workbench", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    for (const fixture of ["", "#workbench-fixture"]) {
      await page.goto(`${origin(server)}/${fixture}`);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("tab", { name: "General" }),
      ).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("settings-scroll-region")).toBeVisible();
      await dialog.getByRole("button", { name: "Close" }).click();
      await expect(dialog).toBeHidden();
    }

    await page.goto(origin(server));
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(
      page
        .getByRole("dialog", { name: "Settings" })
        .getByRole("tab", { name: "General" }),
    ).toHaveAttribute("aria-selected", "true");
  } finally {
    await close(server);
  }
});

test("review navigator presents the Pierre file tree", async ({ page }) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#workbench-fixture`);

    const navigation = page.getByRole("complementary", {
      name: "Review navigation",
    });
    await expect(navigation.locator("file-tree-container")).toHaveCount(1);
    await expect(
      navigation.getByRole("treeitem", { name: "a.ts" }),
    ).toBeVisible();
  } finally {
    await close(server);
  }
});

test("Pierre controls persist and the review navigator can collapse", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#workbench-fixture`);
    const diff = page.getByRole("region", { name: "Review diff" });

    await page.getByRole("button", { name: "Split", exact: true }).click();
    await page.getByRole("button", { name: "Wrap", exact: true }).click();
    await page.getByRole("button", { name: "Selected", exact: true }).click();
    await page.getByRole("button", { name: "Hide review navigator" }).click();

    await expect(diff).toHaveAttribute("data-diff-style", "split");
    await expect(diff).toHaveAttribute("data-file-mode", "selected");
    await expect(
      page.getByRole("complementary", { name: "Review navigation" }),
    ).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("region", { name: "Review diff" }),
    ).toHaveAttribute("data-diff-style", "split");
    await expect(
      page.getByRole("region", { name: "Review diff" }),
    ).toHaveAttribute("data-file-mode", "selected");
  } finally {
    await close(server);
  }
});

test("Patchdesk has no application sidebar and keeps the desktop width", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#workbench-fixture`);
    await expect(
      page.getByRole("region", { name: "Review diff" }),
    ).toBeVisible();

    const metrics = await page.evaluate(() => {
      const titlebar = document.querySelector(".app-titlebar");
      const sidebar = document.querySelector(
        '.app-frame > [data-slot="sidebar"]',
      );
      const diff = document.querySelector('[aria-label="Review diff"]');
      if (diff === null) throw new Error("Expected the review diff");
      return {
        hasTitlebar: titlebar !== null,
        hasSidebar: sidebar !== null,
        diffWidth: diff.getBoundingClientRect().width,
        overflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      };
    });

    expect(metrics.hasTitlebar).toBe(true);
    expect(metrics.hasSidebar).toBe(false);
    expect(metrics.diffWidth).toBeGreaterThan(1_000);
    expect(metrics.overflow).toBeLessThanOrEqual(1);
  } finally {
    await close(server);
  }
});

test("all-files stream appends when the diff scroll reaches its end", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#workbench-fixture`);
    await expect(
      page.getByRole("checkbox", { name: "Mark file src/a.ts as viewed" }),
    ).toBeVisible();
    await expect(
      page.locator("[data-review-diff-loaded-file-count]"),
    ).toHaveAttribute("data-review-diff-loaded-file-count", "2");
    await expect(
      page.getByRole("button", { name: /Load more files/ }),
    ).toHaveCount(0);

    const diffViewport = page.locator(".review-diff-viewport");
    const box = await diffViewport.boundingBox();
    if (box === null) throw new Error("Review diff viewport was not visible");
    const layout = await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>(
        ".review-diff-viewport",
      );
      if (viewport === null)
        throw new Error("Review diff viewport was not found");
      return {
        documentOverflow:
          document.documentElement.scrollHeight -
          document.documentElement.clientHeight,
        diffOverflow: viewport.scrollHeight - viewport.clientHeight,
      };
    });
    expect(layout.documentOverflow).toBeLessThanOrEqual(1);
    expect(layout.diffOverflow).toBeGreaterThan(0);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.mouse.wheel(0, 10_000);
    }

    await expect(
      page.getByRole("button", { name: /Load more files/ }),
    ).toHaveCount(0);
    const viewportScroll = await diffViewport.evaluate((viewport) => ({
      clientHeight: viewport.clientHeight,
      scrollHeight: viewport.scrollHeight,
      scrollTop: viewport.scrollTop,
    }));
    expect(viewportScroll.scrollHeight).toBeGreaterThan(
      viewportScroll.clientHeight,
    );
    expect(viewportScroll.scrollTop).toBeGreaterThan(0);

    const workbenchToolbar = page.locator("[data-review-workbench-toolbar]");
    const diffToolbar = page.locator("[data-review-diff-toolbar]");
    const workbenchToolbarBox = await workbenchToolbar.boundingBox();
    const diffToolbarBox = await diffToolbar.boundingBox();
    if (workbenchToolbarBox === null || diffToolbarBox === null) {
      throw new Error("Review toolbars were not visible");
    }
    expect(diffToolbarBox.y).toBeGreaterThanOrEqual(
      workbenchToolbarBox.y + workbenchToolbarBox.height - 1,
    );
  } finally {
    await close(server);
  }
});

test("native diff scrolling passively follows the active file without changing finding state", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#active-follow-fixture`);
    await page.getByRole("treeitem", { name: "b.ts" }).click();
    await expect(
      page.getByRole("region", { name: "Review diff" }),
    ).toHaveAttribute("data-selected-path", "src/b.ts");

    const viewport = page.locator(".review-diff-viewport");
    const box = await viewport.boundingBox();
    if (box === null) throw new Error("Review diff viewport was not visible");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.mouse.wheel(0, 10_000);
    }
    await expect(
      page.locator("[data-review-diff-loaded-file-count]"),
    ).toHaveAttribute("data-review-diff-loaded-file-count", "3");
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await page.mouse.wheel(0, 1_000);
      await page.waitForTimeout(100);
      if (
        (await page
          .locator("file-tree-container")
          .getAttribute("data-active-path")) === "src/c.ts"
      ) {
        break;
      }
    }
    await expect(
      page.locator('file-tree-container[data-active-path="src/c.ts"]'),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Review diff" }),
    ).toHaveAttribute("data-selected-path", "src/b.ts");
    expect(
      await page.evaluate(() => document.activeElement?.localName),
    ).not.toBe("file-tree-container");
  } finally {
    await close(server);
  }
});

test("streamed files can become the passive active path", async ({ page }) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#active-follow-fixture`);
    await expect(
      page.locator("[data-review-diff-loaded-file-count]"),
    ).toHaveAttribute("data-review-diff-loaded-file-count", "2");
    await expect(
      page.getByRole("button", { name: /Load more files/ }),
    ).toHaveCount(0);

    const viewport = page.locator(".review-diff-viewport");
    const box = await viewport.boundingBox();
    if (box === null) throw new Error("Review diff viewport was not visible");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 10_000);
    await expect(
      page.locator("[data-review-diff-loaded-file-count]"),
    ).toHaveAttribute("data-review-diff-loaded-file-count", "3");
    await page.mouse.wheel(0, 3_000);
    await expect(
      page.locator('file-tree-container[data-active-path="src/c.ts"]'),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Load more files/ }),
    ).toHaveCount(0);
  } finally {
    await close(server);
  }
});

test("explicit tree keyboard navigation remains selection and diff navigation", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#active-follow-fixture`);
    const treeItem = page.getByRole("treeitem", { name: "b.ts" });
    await treeItem.click();
    await expect(
      page.getByRole("region", { name: "Review diff" }),
    ).toHaveAttribute("data-selected-path", "src/b.ts");
    await treeItem.press("ArrowUp");
    await expect(
      page.getByRole("region", { name: "Review diff" }),
    ).toHaveAttribute("data-selected-path", "src/b.ts");
  } finally {
    await close(server);
  }
});

test("viewed toggles replace the collapse icon without changing file selection", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#workbench-fixture`);

    const viewed = page.getByRole("checkbox", {
      name: "Mark file src/a.ts as viewed",
    });
    await viewed.click();
    const shown = page.getByRole("checkbox", { name: "Show file src/a.ts" });
    await expect(shown).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "Mark all viewed" }).click();
    await page.getByRole("button", { name: "Show all" }).click();
    await expect(
      page.getByRole("checkbox", { name: "Mark file src/a.ts as viewed" }),
    ).toBeVisible();
  } finally {
    await close(server);
  }
});

test("inline finding text remains inside the diff viewport", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#workbench-fixture`);
    await page.getByRole("button", { name: "Insights", exact: true }).click();
    const insights = page.getByRole("region", { name: "Review insights" });
    await expect(insights).toContainText("Insight fixture content.");
    const bounds = await insights.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  } finally {
    await close(server);
  }
});

test("file-tree selection scrolls the all-files viewer to the chosen file", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#workbench-fixture`);
    const diff = page.getByRole("region", { name: "Review diff" });
    const diffViewport = page.locator(".review-diff-viewport");

    await page.getByRole("treeitem", { name: "b.ts" }).click();

    await expect(diff).toHaveAttribute("data-selected-path", "src/b.ts");
    await expect
      .poll(() => diffViewport.evaluate((viewport) => viewport.scrollTop))
      .toBeGreaterThan(0);
  } finally {
    await close(server);
  }
});

test("file-tree search selects a file deep in a large patch and scrolls its header into view despite concurrent item churn", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#performance-fixture`);
    const diff = page.getByRole("region", { name: "Review diff" });
    const diffViewport = page.locator(".review-diff-viewport");
    const path = "src/generated/file-0050.ts";

    // Index 50 stays well under the all-files direct-selection guard
    // (`targetIndex > 128` in review-diff-view.tsx), so a failure here
    // proves the scroll-to-selection retry chain, not that guard.
    await page.locator("[data-file-tree-search-input]").fill("file-0050");
    const target = page.getByRole("treeitem", { name: "file-0050.ts" });
    await expect(target).toBeVisible();

    // Progressive hydration mutates `items` (a dependency of the
    // scroll-to-selection effect) on its own schedule as files stream in,
    // which is what let that effect's retry chain get cancelled mid-flight.
    // Toggling an already-loaded file's "viewed" state churns `items` the
    // same way, so hammering it on nearly every frame reproduces that race
    // deterministically instead of hoping a real hydration tick lands at
    // the wrong moment.
    await page.evaluate(() => {
      const checkbox = document.querySelector<HTMLElement>(
        '[data-review-diff-file-header] [role="checkbox"]',
      );
      if (checkbox === null) {
        throw new Error("expected an already-loaded file's viewed checkbox");
      }
      let frame = 0;
      const churn = (): void => {
        checkbox.click();
        frame += 1;
        if (frame < 90) requestAnimationFrame(churn);
      };
      requestAnimationFrame(churn);
    });
    await target.click();

    await expect(diff).toHaveAttribute("data-selected-path", path);
    const header = page.locator(`[data-review-diff-file-header="${path}"]`);
    await expect(header).toBeVisible({ timeout: 5_000 });

    const [headerBox, viewportBox] = await Promise.all([
      header.boundingBox(),
      diffViewport.boundingBox(),
    ]);
    if (headerBox === null || viewportBox === null) {
      throw new Error(
        "expected both the selected file's header and the diff viewport to report a layout box",
      );
    }
    // scrollTop alone does not prove the right file surfaced: churn can
    // move it for reasons unrelated to this selection while file-0050's
    // header stays off the visible viewport. Only a vertical overlap
    // between the header's box and the viewport's visible box proves the
    // header itself reached the viewport.
    expect(headerBox.y + headerBox.height).toBeGreaterThan(viewportBox.y);
    expect(headerBox.y).toBeLessThan(viewportBox.y + viewportBox.height);
  } finally {
    await close(server);
  }
});

test("Pierre headers retain per-file totals while the navigator stays compact", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_280, height: 800 });
    await page.goto(`${origin(server)}/#workbench-fixture`);

    await expect(page.getByRole("treeitem", { name: "a.ts" })).toBeVisible();

    const headerStats = page.locator("[data-file-header-change-stats]").first();
    await expect(headerStats).toHaveAttribute("data-additions", "48");
    await expect(headerStats).toHaveAttribute("data-deletions", "48");

    await page.getByRole("button", { name: "Split", exact: true }).click();
    await expect(headerStats).toHaveAttribute("data-additions", "48");
    await expect(headerStats).toHaveAttribute("data-deletions", "48");

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  } finally {
    await close(server);
  }
});

test("Pierre unified and split surfaces retain their visual diff language", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#workbench-fixture`);
    const diff = page.getByRole("region", { name: "Review diff" });

    await expect(diff).toHaveAttribute("data-diff-style", "unified");

    await page.getByRole("button", { name: "Split", exact: true }).click();
    await expect(diff).toHaveAttribute("data-diff-style", "split");
  } finally {
    await close(server);
  }
});

test("completed-review workbench keeps PR actions in the overview drawer", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    const rendererOrigin = origin(server);
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: rendererOrigin,
      });
    await page.goto(`${rendererOrigin}/#workbench-fixture`);
    await expect(
      page.getByRole("region", { name: "Review workbench" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "PR overview" }).click();
    const overview = page.getByRole("dialog", { name: "PR overview" });
    await expect(overview).toBeVisible();
    for (const section of [
      "Revision",
      "Checks",
      "Review status",
      "Merge readiness",
    ]) {
      await expect(
        overview.getByRole("button", { name: section }),
      ).toBeVisible();
    }
    await expect(
      page.getByRole("region", { name: "Review diff" }),
    ).toBeVisible();
  } finally {
    await close(server);
  }
});

test("PR overview overlays without viewport overflow and scrolls independently", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    for (const width of [960, 1_280, 1_440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin(server)}/#long-workbench-fixture`);
      const diff = page.getByRole("region", { name: "Review diff" });
      const diffWidthBefore = (await diff.boundingBox())?.width;
      await page.getByRole("button", { name: "PR overview" }).click();
      const overview = page.getByRole("dialog", { name: "PR overview" });
      await expect(overview).toBeVisible();
      const diffWidthAfter = (await diff.boundingBox())?.width;
      expect(diffWidthAfter).toBe(diffWidthBefore);
      await overview.getByRole("button", { name: "Checks" }).click();
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
      const pageHeightOverflow = await page.evaluate(
        () =>
          document.documentElement.scrollHeight -
          document.documentElement.clientHeight,
      );
      expect(pageHeightOverflow).toBeLessThanOrEqual(1);
      const scroll = await overview
        .locator("[data-pr-overview-scroll]")
        .evaluate((element) => ({
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
        }));
      expect(scroll.scrollHeight).toBeGreaterThanOrEqual(scroll.clientHeight);
      await page.keyboard.press("Escape");
      await expect(overview).toBeHidden();
      await expect(
        page.getByRole("button", { name: "PR overview" }),
      ).toBeFocused();
    }
  } finally {
    await close(server);
  }
});

test("PR overview shows a blocked merge state without a duplicate alert", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#blocked-merge-fixture`);
    await page.getByRole("button", { name: "PR overview" }).click();
    const overview = page.getByRole("dialog", { name: "PR overview" });
    await expect(overview).toBeVisible();
    await expect(overview.getByText("Blocked")).toBeVisible();
    await expect(
      overview.getByText("Required checks have not passed."),
    ).toBeVisible();
    await expect(overview.getByText("Checks · available")).toBeVisible();
    await expect(
      overview.getByRole("button", { name: "Open on GitHub" }),
    ).toBeVisible();
    await expect(
      overview.getByRole("button", { name: "Prepare merge confirmation" }),
    ).toHaveCount(0);
    await expect(overview.getByText("Merge blocked")).toHaveCount(0);
  } finally {
    await close(server);
  }
});

test("PR overview reaches the confirmation dialog from an acknowledgement-required state", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#acknowledgement-merge-fixture`);
    await page.getByRole("button", { name: "PR overview" }).click();
    const overview = page.getByRole("dialog", { name: "PR overview" });
    await expect(overview).toBeVisible();
    await expect(overview.getByText("Warnings")).toBeVisible();
    await expect(overview.getByText("Changes requested.")).toBeVisible();
    await expect(
      overview.getByText(
        "A current Analysis finding requires acknowledgement before merge.",
      ),
    ).toBeVisible();
    await expect(overview.getByText("request_changes")).toHaveCount(0);
    await expect(overview.getByText("analysis_finding")).toHaveCount(0);
    await expect(
      overview.getByRole("button", { name: "Prepare merge confirmation" }),
    ).toHaveCount(0);
    const acknowledgement = overview.getByRole("checkbox", {
      name: "I acknowledge: request changes, analysis finding.",
    });
    await acknowledgement.check();
    await expect(
      overview.getByRole("button", { name: "Merge", exact: true }),
    ).toBeEnabled();
  } finally {
    await close(server);
  }
});

test("constrained completed review keeps navigation and actions reachable", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 960, height: 900 });
    await page.goto(`${origin(server)}/#workbench-fixture`);

    await expect(
      page.getByRole("complementary", { name: "Review navigation" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "PR overview" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
  } finally {
    await close(server);
  }
});

test("completed review preserves three-pane geometry at 1280 and 1440", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    for (const width of [1_280, 1_440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin(server)}/#active-follow-fixture`);
      const navigation = page.getByRole("complementary", {
        name: "Review navigation",
      });
      await expect(navigation).toBeVisible();
      await expect(
        page.getByRole("button", { name: "PR overview" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Files", exact: true }),
      ).toHaveCount(0);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
      const pageHeightOverflow = await page.evaluate(
        () =>
          document.documentElement.scrollHeight -
          document.documentElement.clientHeight,
      );
      expect(pageHeightOverflow).toBeLessThanOrEqual(1);
      const diffScroll = await page
        .locator(".review-diff-viewport")
        .evaluate((viewport) => viewport.scrollHeight > viewport.clientHeight);
      expect(diffScroll).toBe(true);
    }
  } finally {
    await close(server);
  }
});

test("long workbench content keeps full values accessible without viewport overflow", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    const title =
      "Protect the authoritative review write boundary when a pull request title contains localized text, identifiers, and enough detail to exceed the available header width";
    for (const width of [960, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin(server)}/#long-workbench-fixture`);

      const heading = page.getByRole("heading", { name: title });
      await expect(heading).toBeVisible();
      await expect(heading).toHaveAttribute("title", title);
      await expect(
        page.getByText(
          "centraldigital-platform-engineering-maintainers/patchdesk-desktop-review-workbench-with-a-long-repository-name",
          { exact: false },
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("treeitem", {
          name: "authoritative-review-write-coordination-and-recovery-surface.ts",
        }),
      ).toBeVisible();

      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    }
  } finally {
    await close(server);
  }
});

async function serveRenderer(): Promise<Server> {
  const rendererRoot = join(process.cwd(), "out/renderer");
  const server = createServer(async (request, response) => {
    const path =
      request.url === undefined || request.url === "/"
        ? "index.html"
        : request.url;
    const file = normalize(join(rendererRoot, path));
    if (!file.startsWith(rendererRoot)) {
      response.writeHead(400).end();
      return;
    }
    try {
      response
        .writeHead(200, {
          "Content-Type":
            extname(file) === ".js"
              ? "text/javascript"
              : extname(file) === ".css"
                ? "text/css"
                : "text/html",
        })
        .end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}
function origin(server: Server): string {
  const address = server.address();
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows Node's net.Server.address() union (AddressInfo | string | null) to the TCP shape this loopback helper needs; there is no schema for a stdlib return type.
  if (address === null || typeof address === "string")
    throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
