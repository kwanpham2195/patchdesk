import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { expect, test } from "playwright/test";

test("review navigator presents the Pierre file tree", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#workbench-fixture`);

    const navigation = page.getByRole("complementary", {
      name: "Review navigation",
    });
    await expect(navigation.locator("file-tree-container")).toHaveCount(1);
    await expect(navigation.getByRole("treeitem", { name: "a.ts" })).toBeVisible();
  } finally {
    await close(server);
  }
});

test("compact Pierre controls persist and collapsed finding targets reopen", async ({
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
    await page
      .getByRole("button", { name: "Collapse application sidebar" })
      .click();
    await page.getByRole("button", { name: "Hide review navigator" }).click();
    await page.getByRole("button", { name: "Hide details" }).click();

    await expect(diff).toHaveAttribute("data-diff-style", "split");
    await expect(diff).toHaveAttribute("data-file-mode", "selected");
    await expect(
      page.getByRole("complementary", { name: "Review navigation" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("complementary", { name: "Review result and actions" }),
    ).toHaveCount(0);
    await expect(page.locator(".app-frame")).toHaveAttribute(
      "data-app-rail-open",
      "false",
    );

    await page.reload();
    await expect(
      page.getByRole("region", { name: "Review diff" }),
    ).toHaveAttribute("data-diff-style", "split");
    await expect(page.locator(".app-frame")).toHaveAttribute(
      "data-app-rail-open",
      "false",
    );
  } finally {
    await close(server);
  }
});

test("application shell keeps a fixed compact desktop density", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#workbench-fixture`);

    const metrics = await page.evaluate(() => {
      const titlebar = document.querySelector(".app-titlebar");
      const sidebar = document.querySelector(
        '.app-frame > [data-slot="sidebar"]',
      );
      if (titlebar === null || sidebar === null)
        throw new Error("Expected the application shell");
      return {
        titlebarHeight: titlebar.getBoundingClientRect().height,
        sidebarWidth: sidebar.getBoundingClientRect().width,
        overflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      };
    });

    expect(metrics.titlebarHeight).toBe(48);
    expect(metrics.sidebarWidth).toBe(232);
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
    await expect(page.locator("[data-review-diff-loaded-file-count]")).toHaveAttribute(
      "data-review-diff-loaded-file-count",
      "2",
    );
    await expect(
      page.getByRole("button", { name: /Load more files/ }),
    ).toHaveCount(0);

    const diffViewport = page.locator(".review-diff-viewport");
    const box = await diffViewport.boundingBox();
    if (box === null) throw new Error("Review diff viewport was not visible");
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
    await page.getByRole("button", { name: "Keep writes behind the stale-head check" }).click();
    await expect(page.getByRole("region", { name: "Review diff" })).toHaveAttribute(
      "data-selected-path",
      "src/b.ts",
    );
    await expect(page.getByText("Finding mapped · new lines 1–1")).toBeVisible();

    const viewport = page.locator(".review-diff-viewport");
    const box = await viewport.boundingBox();
    if (box === null) throw new Error("Review diff viewport was not visible");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.mouse.wheel(0, 10_000);
    }
    await expect(page.locator("[data-review-diff-loaded-file-count]")).toHaveAttribute(
      "data-review-diff-loaded-file-count",
      "3",
    );
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await page.mouse.wheel(0, 1_000);
      await page.waitForTimeout(100);
      if (
        (await page.locator("file-tree-container").getAttribute("data-active-path")) ===
        "src/c.ts"
      ) {
        break;
      }
    }
    await expect(page.locator('file-tree-container[data-active-path="src/c.ts"]')).toBeVisible();
    await expect(page.getByRole("region", { name: "Review diff" })).toHaveAttribute(
      "data-selected-path",
      "src/b.ts",
    );
    await expect(page.getByText("Finding mapped · new lines 1–1")).toBeVisible();
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
    await expect(page.locator("[data-review-diff-loaded-file-count]")).toHaveAttribute(
      "data-review-diff-loaded-file-count",
      "2",
    );
    await expect(page.getByRole("button", { name: /Load more files/ })).toHaveCount(0);

    const viewport = page.locator(".review-diff-viewport");
    const box = await viewport.boundingBox();
    if (box === null) throw new Error("Review diff viewport was not visible");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 10_000);
    await expect(page.locator("[data-review-diff-loaded-file-count]")).toHaveAttribute(
      "data-review-diff-loaded-file-count",
      "3",
    );
    await page.mouse.wheel(0, 3_000);
    await expect(page.locator('file-tree-container[data-active-path="src/c.ts"]')).toBeVisible();
    await expect(page.getByRole("button", { name: /Load more files/ })).toHaveCount(0);
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
    await expect(page.getByRole("region", { name: "Review diff" })).toHaveAttribute(
      "data-selected-path",
      "src/b.ts",
    );
    await treeItem.press("ArrowUp");
    await expect(page.getByRole("region", { name: "Review diff" })).toHaveAttribute(
      "data-selected-path",
      "src/b.ts",
    );
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

test("inline finding text remains inside the diff viewport", async ({ page }) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#workbench-fixture`);
    await page.getByRole("treeitem", { name: "b.ts" }).click();

    const finding = page.locator("[data-review-inline-finding='mapped']");
    await expect(finding).toBeVisible();
    const bounds = await finding.evaluate((element) => {
      const findingBounds = element.getBoundingClientRect();
      const viewportBounds = element.closest(".review-diff-viewport")?.getBoundingClientRect();
      if (viewportBounds === undefined || viewportBounds === null) {
        throw new Error("Expected inline finding in the diff viewport");
      }
      return { right: findingBounds.right, viewportRight: viewportBounds.right };
    });
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportRight + 1);
    const explanation = finding.locator("p");
    await expect(explanation).toHaveCSS("white-space", "normal");
    const explanationWidth = await explanation.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(explanationWidth.scrollWidth).toBeLessThanOrEqual(explanationWidth.clientWidth);
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
    expect(
      await diffViewport.evaluate((viewport) => viewport.scrollTop),
    ).toBeGreaterThan(0);
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

    const headerStats = page
      .locator("[data-file-header-change-stats]")
      .first();
    await expect(headerStats).toHaveAttribute("data-additions", "48");
    await expect(headerStats).toHaveAttribute("data-deletions", "48");

    await page.getByRole("button", { name: "Split", exact: true }).click();
    await expect(headerStats).toHaveAttribute("data-additions", "48");
    await expect(headerStats).toHaveAttribute("data-deletions", "48");

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
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

    await expect(diff).toHaveScreenshot("pierre-unified.png", {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.01,
    });

    await page.getByRole("button", { name: "Split", exact: true }).click();
    await expect(diff).toHaveScreenshot("pierre-split.png", {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.01,
    });
  } finally {
    await close(server);
  }
});

test("completed-review workbench keeps drafts local and unmapped findings unpostable", async ({
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
      page.getByRole("region", { name: "Completed review workbench" }),
    ).toBeVisible();
    await expect(page.getByText("2 findings · 1 mapped")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Fix queue" })).toHaveCount(0);
    await expect(page.getByLabel("Filter findings by severity")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Findings" })).toHaveCount(0);
    await page.getByRole("button", { name: "Keep writes behind the stale-head check" }).click();
    await expect(page.locator('[data-review-inline-finding="mapped"]')).toContainText(
      "Keep writes behind the stale-head check",
    );
    await page.getByRole("button", { name: "Copy validation plan" }).click();
    await expect(
      page.getByText("Validation plan copied locally."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: /create pending review|submit pending review|prepare merge confirmation|confirm merge/i,
      }),
    ).toHaveCount(0);
    await page.screenshot({
      path: "test-results/milestone-9-browser.png",
      fullPage: true,
    });
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
    ).toBeHidden();
    await expect(
      page.getByRole("complementary", { name: "Review result and actions" }),
    ).toBeVisible();
    await expect(page.getByText("Review result")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
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
      const actions = page.getByRole("complementary", {
        name: "Review result and actions",
      });
      await expect(navigation).toBeVisible();
      await expect(actions).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Files", exact: true }),
      ).toBeHidden();
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
      const pageHeightOverflow = await page.evaluate(
        () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
      );
      expect(pageHeightOverflow).toBeLessThanOrEqual(1);
      const diffScroll = await page.locator(".review-diff-viewport").evaluate(
        (viewport) => viewport.scrollHeight > viewport.clientHeight,
      );
      expect(diffScroll).toBe(true);
      const inspectorOverflow = await actions
        .locator('[data-slot="scroll-area-viewport"]')
        .evaluate((viewport) => viewport.scrollWidth - viewport.clientWidth);
      expect(inspectorOverflow).toBeLessThanOrEqual(1);
      await page.screenshot({
        path: `test-results/workbench-completed-${width}.png`,
        fullPage: true,
      });
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
          "centraldigital-platform-engineering-maintainers/patchdesk-desktop-review-workbench-with-a-long-repository-name#42",
          { exact: false },
        ),
      ).toBeVisible();
      await page.getByRole("button", { name: "Files", exact: true }).click();
      const navigation = page.getByRole("dialog", {
        name: "Files",
      });
      await expect(
        navigation.getByRole("treeitem", { name: "authoritative-review-write-coordination-and-recovery-surface.ts" }),
      ).toBeVisible();
      await page.keyboard.press("Escape");

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
  if (address === null || typeof address === "string")
    throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
