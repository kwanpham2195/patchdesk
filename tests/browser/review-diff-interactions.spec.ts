import { expect, test, type Page } from "playwright/test";
import {
  closeServer,
  openDiff,
  serveRenderer,
  serverOrigin,
} from "./renderer-server";

async function scrollUntilActivePath(page: Page, path: string): Promise<void> {
  const viewport = page.locator(".review-diff-viewport");
  const box = await viewport.boundingBox();
  if (box === null) throw new Error("Review diff viewport was not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.mouse.wheel(0, 10_000);
  }

  const tree = page.locator("file-tree-container");
  // The diff scroll hook commits active-path updates in an animation frame.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.mouse.wheel(0, 1_000);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    if ((await tree.getAttribute("data-active-path")) === path) return;
  }
  throw new Error(`Scrolling did not activate ${path}`);
}

test("native diff scrolling passively follows the active file without changing finding state", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await openDiff(page, `${serverOrigin(server)}/#active-follow-fixture`);
    await page.getByRole("treeitem", { name: "b.ts" }).click();
    await expect(
      page.getByRole("region", { name: "Review diff" }),
    ).toHaveAttribute("data-selected-path", "src/b.ts");
    const focusAfterClick = await page.evaluate(
      () => document.activeElement?.localName,
    );

    await scrollUntilActivePath(page, "src/c.ts");
    await expect(
      page.locator('file-tree-container[data-active-path="src/c.ts"]'),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Review diff" }),
    ).toHaveAttribute("data-selected-path", "src/b.ts");
    // Focus legitimately stays wherever the click put it: nothing here --
    // not the click handler, not passive scroll-follow -- ever moves DOM
    // focus to the diff viewport. This is a differential check (the same
    // element right after the click as after scrolling), not a hardcoded
    // "ends on file-tree-container": on the pre-fix `key={activePath}` tree,
    // `focusAfterClick` itself was already "body", because the click's own
    // activePath update remounted the tree it had just placed focus on --
    // so asserting a specific end state would only prove "focus didn't
    // move" by coincidence, given that starting point. Once the tree stops
    // remounting on every active-file change, focus starts on
    // "file-tree-container" and this proves mouse-wheel-scrolling an
    // unrelated region (the diff viewport, not the tree) doesn't disturb it.
    expect(await page.evaluate(() => document.activeElement?.localName)).toBe(
      focusAfterClick,
    );
  } finally {
    await closeServer(server);
  }
});

test("the file tree does not remount when the active file changes via passive scroll-follow", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await openDiff(page, `${serverOrigin(server)}/#active-follow-fixture`);
    await expect(
      page.locator('file-tree-container[data-active-path="src/a.ts"]'),
    ).toBeVisible();

    // Capture a live reference to the tree's shadow host before the active
    // file changes. If `PierreFileTree` still keyed its inner model on the
    // active path, this change below would unmount and remount the whole
    // tree -- a brand new `<file-tree-container>` element, DOM identity and
    // all -- rather than reusing the same node.
    const containerBefore = await page
      .locator("file-tree-container")
      .elementHandle();
    if (containerBefore === null)
      throw new Error("Expected the file tree container to exist");

    await scrollUntilActivePath(page, "src/c.ts");
    await expect(
      page.locator('file-tree-container[data-active-path="src/c.ts"]'),
    ).toBeVisible();

    const containerAfter = await page
      .locator("file-tree-container")
      .elementHandle();
    if (containerAfter === null)
      throw new Error("Expected the file tree container to still exist");
    const isSameNode = await page.evaluate(
      ([before, after]) => before === after,
      [containerBefore, containerAfter],
    );
    expect(isSameNode).toBe(true);
  } finally {
    await closeServer(server);
  }
});

test("the active-file highlight replaces stale click selection instead of leaving two rows looking selected", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await openDiff(page, `${serverOrigin(server)}/#active-follow-fixture`);

    const rowBackgrounds = () =>
      page.evaluate(() => {
        const container = document.querySelector("file-tree-container");
        const shadow = container?.shadowRoot;
        if (shadow == null) throw new Error("Expected an open shadow root");
        const backgroundOf = (path: string): string | null => {
          const row = shadow.querySelector(`[data-item-path="${path}"]`);
          return row === null ? null : getComputedStyle(row).backgroundColor;
        };
        return {
          a: backgroundOf("src/a.ts"),
          b: backgroundOf("src/b.ts"),
          c: backgroundOf("src/c.ts"),
        };
      });

    // Real click selection: @pierre/trees' own click handling sets its
    // internal `data-item-selected="true"` on src/b.ts, which is also the
    // active file at this point, so exactly one row (b) should be
    // highlighted.
    await page.getByRole("treeitem", { name: "b.ts" }).click();
    await expect(
      page.getByRole("region", { name: "Review diff" }),
    ).toHaveAttribute("data-selected-path", "src/b.ts");
    const afterClick = await rowBackgrounds();
    expect(afterClick.b).not.toBe(afterClick.a);

    // Passive scroll-follow now moves the active file on to src/c.ts. Pierre
    // never updates its own click-selection state on its own, so without
    // this fix's stale-selection neutralization, b would still carry
    // `data-item-selected="true"` and keep looking highlighted alongside c.
    await scrollUntilActivePath(page, "src/c.ts");
    await expect(
      page.locator('file-tree-container[data-active-path="src/c.ts"]'),
    ).toBeVisible();

    await expect
      .poll(async () => {
        const settled = await rowBackgrounds();
        return settled.b === settled.a && settled.c !== settled.a;
      })
      .toBe(true);
  } finally {
    await closeServer(server);
  }
});

test("explicit tree keyboard navigation remains selection and diff navigation", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await openDiff(page, `${serverOrigin(server)}/#active-follow-fixture`);
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
    await closeServer(server);
  }
});

test("viewed toggles replace the collapse icon without changing file selection", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await openDiff(page, `${serverOrigin(server)}/#workbench-fixture`);

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
    await closeServer(server);
  }
});

test("inline finding text remains inside the diff viewport", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${serverOrigin(server)}/#workbench-fixture`);
    await page.getByRole("tab", { name: "Insights", exact: true }).click();
    const insights = page.getByRole("region", { name: "Review insights" });
    await expect(insights).toContainText("Insight fixture content.");
    const bounds = await insights.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  } finally {
    await closeServer(server);
  }
});

test("file-tree selection scrolls the all-files viewer to the chosen file", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await openDiff(page, `${serverOrigin(server)}/#workbench-fixture`);
    const diff = page.getByRole("region", { name: "Review diff" });
    const diffViewport = page.locator(".review-diff-viewport");

    await page.getByRole("treeitem", { name: "b.ts" }).click();

    await expect(diff).toHaveAttribute("data-selected-path", "src/b.ts");
    await expect
      .poll(() => diffViewport.evaluate((viewport) => viewport.scrollTop))
      .toBeGreaterThan(0);
  } finally {
    await closeServer(server);
  }
});

test("Threads section selection on the new side scrolls the diff and marks the anchored line", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await openDiff(page, `${serverOrigin(server)}/#active-follow-fixture`);
    const diff = page.getByRole("region", { name: "Review diff" });
    const diffViewport = page.locator(".review-diff-viewport");

    await page.getByRole("tab", { name: "Threads" }).click();
    await page.getByRole("button", { name: "new-side-thread-author" }).click();

    await expect(diff).toHaveAttribute("data-selected-path", "src/a.ts");
    // src/a.ts is already the file the diff shows before any selection, so
    // this only proves a real scroll (not a no-op re-render) because the
    // fixture's thread sits deep in the file (line 45 of 48): centering
    // that row on selection cannot land back at scrollTop 0.
    await expect
      .poll(() => diffViewport.evaluate((viewport) => viewport.scrollTop))
      .toBeGreaterThan(0);

    // Pierre's CodeView marks a selected row with `[data-selected-line]` and
    // carries the line number on `data-line`, inside an open shadow root
    // that Playwright's CSS locators pierce transparently -- confirmed
    // empirically (a throwaway probe test) before relying on it here.
    const marked = page.locator("[data-selected-line][data-line]");
    await expect(marked).toHaveCount(1);
    await expect(marked.first()).toHaveAttribute("data-line", "45");
    await expect(marked.first()).toHaveAttribute(
      "data-line-type",
      "change-addition",
    );
  } finally {
    await closeServer(server);
  }
});

test("Threads section selection on the old side scrolls the diff and marks the anchored line", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await openDiff(page, `${serverOrigin(server)}/#active-follow-fixture`);
    const diff = page.getByRole("region", { name: "Review diff" });
    const diffViewport = page.locator(".review-diff-viewport");

    await page.getByRole("tab", { name: "Threads" }).click();
    await page.getByRole("button", { name: "old-side-thread-author" }).click();

    await expect(diff).toHaveAttribute("data-selected-path", "src/b.ts");
    await expect
      .poll(() => diffViewport.evaluate((viewport) => viewport.scrollTop))
      .toBeGreaterThan(0);

    const marked = page.locator("[data-selected-line][data-line]");
    await expect(marked).toHaveCount(1);
    await expect(marked.first()).toHaveAttribute("data-line", "12");
    await expect(marked.first()).toHaveAttribute(
      "data-line-type",
      "change-deletion",
    );
  } finally {
    await closeServer(server);
  }
});

test("Threads section selection on a multi-line thread marks the whole anchored range", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await openDiff(page, `${serverOrigin(server)}/#active-follow-fixture`);
    const diff = page.getByRole("region", { name: "Review diff" });
    const diffViewport = page.locator(".review-diff-viewport");

    await page.getByRole("tab", { name: "Threads" }).click();
    await page.getByRole("button", { name: "multiline-thread-author" }).click();

    await expect(diff).toHaveAttribute("data-selected-path", "src/b.ts");
    await expect
      .poll(() => diffViewport.evaluate((viewport) => viewport.scrollTop))
      .toBeGreaterThan(0);

    // The fixture's thread anchors src/b.ts lines 30-33 (new side). Assert
    // every line in that inclusive range is marked, not merely that marking
    // happened somewhere -- a single-line regression in the range plumbing
    // would still leave `marked` non-empty.
    const marked = page.locator("[data-selected-line][data-line]");
    await expect(marked).toHaveCount(4);
    const lines = await marked.evaluateAll((elements) =>
      elements
        .map((element) => element.getAttribute("data-line"))
        .sort((a, b) => Number(a) - Number(b)),
    );
    expect(lines).toEqual(["30", "31", "32", "33"]);
  } finally {
    await closeServer(server);
  }
});

test("Threads section selection on a file below the fold scrolls the diff and marks the anchored line", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await openDiff(page, `${serverOrigin(server)}/#active-follow-fixture`);
    const diff = page.getByRole("region", { name: "Review diff" });
    const diffViewport = page.locator(".review-diff-viewport");
    const path = "src/c.ts";

    // src/c.ts is the third file of the active-follow fixture's patch. Every
    // file is handed to CodeView's item list at mount, but CodeView still
    // virtualizes its own rendering, so a file this far down has no header in
    // the DOM until something scrolls the viewport near it. Selecting its
    // thread must drive that scroll itself, through
    // `materializeAndScrollTo`'s scroll-to-selection path, not merely move
    // within content the viewport had already rendered.
    await expect(
      page.locator(`[data-review-diff-file-header="${path}"]`),
    ).toHaveCount(0);

    await page.getByRole("tab", { name: "Threads" }).click();
    await page.getByRole("button", { name: "deep-file-thread-author" }).click();

    await expect(diff).toHaveAttribute("data-selected-path", path);
    const header = page.locator(`[data-review-diff-file-header="${path}"]`);
    await expect(header).toBeVisible({ timeout: 5_000 });

    // As in "file-tree search selects a file deep in a large patch...",
    // scrollTop alone would not prove src/c.ts's header actually reached the
    // viewport: only a vertical overlap between the header's box and the
    // viewport's visible box does.
    const [headerBox, viewportBox] = await Promise.all([
      header.boundingBox(),
      diffViewport.boundingBox(),
    ]);
    if (headerBox === null || viewportBox === null) {
      throw new Error(
        "expected both the selected file's header and the diff viewport to report a layout box",
      );
    }
    expect(headerBox.y + headerBox.height).toBeGreaterThan(viewportBox.y);
    expect(headerBox.y).toBeLessThan(viewportBox.y + viewportBox.height);

    const marked = page.locator("[data-selected-line][data-line]");
    await expect(marked).toHaveCount(1);
    await expect(marked.first()).toHaveAttribute("data-line", "30");
    await expect(marked.first()).toHaveAttribute(
      "data-line-type",
      "change-addition",
    );
  } finally {
    await closeServer(server);
  }
});
