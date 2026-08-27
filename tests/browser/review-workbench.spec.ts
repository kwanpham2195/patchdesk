import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
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

test("review navigator resize handle keyboard-resizes the pane, resets on double-click, and the width survives reload", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#workbench-fixture`);

    const navigation = page.getByRole("complementary", {
      name: "Review navigation",
    });
    const handle = page.getByRole("separator", {
      name: "Resize review navigator",
    });
    await expect(handle).toBeVisible();
    await expect(handle).toHaveAttribute("aria-orientation", "vertical");
    await expect(handle).toHaveAttribute("aria-valuenow", "18");
    await expect(handle).toHaveAttribute("aria-valuemin", "14");
    await expect(handle).toHaveAttribute("aria-valuemax", "34");

    const initialBox = await navigation.boundingBox();
    if (initialBox === null) throw new Error("navigator has no layout box");
    expect(Math.round(initialBox.width)).toBe(288); // 18rem default at a 16px root

    await handle.focus();
    for (let i = 0; i < 5; i += 1) await page.keyboard.press("ArrowRight");
    await expect(handle).toHaveAttribute("aria-valuenow", "23");
    const widenedBox = await navigation.boundingBox();
    if (widenedBox === null) throw new Error("navigator has no layout box");
    expect(Math.round(widenedBox.width)).toBe(368); // 18rem + 5 steps

    await page.keyboard.press("Home");
    await expect(handle).toHaveAttribute("aria-valuenow", "14");
    const minBox = await navigation.boundingBox();
    if (minBox === null) throw new Error("navigator has no layout box");
    expect(Math.round(minBox.width)).toBe(224); // clamped to the 14rem minimum

    await page.keyboard.press("End");
    await expect(handle).toHaveAttribute("aria-valuenow", "34");
    const maxBox = await navigation.boundingBox();
    if (maxBox === null) throw new Error("navigator has no layout box");
    expect(Math.round(maxBox.width)).toBe(544); // clamped to the 34rem maximum

    await handle.dblclick();
    await expect(handle).toHaveAttribute("aria-valuenow", "18");

    for (let i = 0; i < 3; i += 1) await page.keyboard.press("ArrowRight");
    await expect(handle).toHaveAttribute("aria-valuenow", "21");

    await page.reload();
    const reloadedHandle = page.getByRole("separator", {
      name: "Resize review navigator",
    });
    await expect(reloadedHandle).toHaveAttribute("aria-valuenow", "21");
    const reloadedBox = await page
      .getByRole("complementary", { name: "Review navigation" })
      .boundingBox();
    if (reloadedBox === null) throw new Error("navigator has no layout box");
    expect(Math.round(reloadedBox.width)).toBe(336); // persisted 21rem survives reload

    await page.getByRole("button", { name: "Hide review navigator" }).click();
    await expect(
      page.getByRole("separator", { name: "Resize review navigator" }),
    ).toHaveCount(0);
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
    const focusAfterClick = await page.evaluate(
      () => document.activeElement?.localName,
    );

    const viewport = page.locator(".review-diff-viewport");
    const box = await viewport.boundingBox();
    if (box === null) throw new Error("Review diff viewport was not visible");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.mouse.wheel(0, 10_000);
    }
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
    await close(server);
  }
});

test("the file tree does not remount when the active file changes via passive scroll-follow", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#active-follow-fixture`);
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

    const viewport = page.locator(".review-diff-viewport");
    const box = await viewport.boundingBox();
    if (box === null) throw new Error("Review diff viewport was not visible");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // A single big wheel jump can land before the active-file effect has
    // caught up. Under whole-suite load, the margin that used to cover that
    // gap -- the loaded-file-count waits and materializeAndScrollTo's
    // append-and-retry chain, both removed by 26391b4 now that CodeView gets
    // every file at mount -- is gone, leaving a single two-frame attempt
    // against Playwright's default 5s expect timeout with no polling. Nudge
    // the same way the still-passing sibling test above ("native diff
    // scrolling passively follows...") does: repeat the wheel and re-check,
    // instead of betting everything on one big scroll landing in time.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.mouse.wheel(0, 10_000);
    }
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
    await close(server);
  }
});

test("the active-file highlight replaces stale click selection instead of leaving two rows looking selected", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#active-follow-fixture`);

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
    const viewport = page.locator(".review-diff-viewport");
    const box = await viewport.boundingBox();
    if (box === null) throw new Error("Review diff viewport was not visible");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // Same settle-polling as "the file tree does not remount..." above: a
    // single big wheel jump can land before the active-file effect has
    // caught up, and under whole-suite load there is no longer any timing
    // margin borrowed from the removed loaded-file-count waits and
    // materializeAndScrollTo retry chain to cover that gap. Nudge like the
    // still-passing "native diff scrolling passively follows..." sibling
    // test does.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.mouse.wheel(0, 10_000);
    }
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

    await expect
      .poll(async () => {
        const settled = await rowBackgrounds();
        return settled.b === settled.a && settled.c !== settled.a;
      })
      .toBe(true);
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

test("Threads section selection on the new side scrolls the diff and marks the anchored line", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#active-follow-fixture`);
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
    await close(server);
  }
});

test("Threads section selection on the old side scrolls the diff and marks the anchored line", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#active-follow-fixture`);
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
    await close(server);
  }
});

test("Threads section selection on a multi-line thread marks the whole anchored range", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#active-follow-fixture`);
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
    await close(server);
  }
});

test("Threads section selection on a file below the fold scrolls the diff and marks the anchored line", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#active-follow-fixture`);
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

    // A failure here proves the scroll-to-selection effect
    // (`materializeAndScrollTo`, driven from review-diff-view.tsx) works
    // under item churn, full stop.
    await page.locator("[data-file-tree-search-input]").fill("file-0050");
    const target = page.getByRole("treeitem", { name: "file-0050.ts" });
    await expect(target).toBeVisible();

    // The scroll-to-selection effect depends on `items` and restarts --
    // cancelling its own prior in-flight attempt via the cleanup
    // `materializeAndScrollTo` returns -- whenever `items`'s identity
    // changes. Per-file hydration mutates `items` on its own schedule as
    // each file's real content swaps in, which is what can race a restart
    // against a real scroll. Toggling an already-loaded file's "viewed"
    // state churns `items` the same way, so hammering it on nearly every
    // frame reproduces that race deterministically instead of hoping a real
    // hydration tick lands at the wrong moment.
    await page.evaluate(() => {
      const checkbox = document.querySelector<HTMLElement>(
        '[data-review-diff-file-header] [role="checkbox"]',
      );
      if (checkbox === null) {
        throw new Error("expected an already-loaded file's viewed checkbox");
      }
      delete document.documentElement.dataset.reviewDiffChurnDone;
      let frame = 0;
      const churn = (): void => {
        checkbox.click();
        frame += 1;
        if (frame < 90) {
          requestAnimationFrame(churn);
        } else {
          document.documentElement.dataset.reviewDiffChurnDone = "true";
        }
      };
      requestAnimationFrame(churn);
    });
    await target.click();

    await expect(diff).toHaveAttribute("data-selected-path", path);

    // The scroll-to-selection effect restarts on every `items` change (see
    // the comment above), so it cannot complete while the churn loop above
    // is still mutating `items` on nearly every frame -- only once churn
    // itself finishes does the effect's last restart get an uninterrupted
    // run. Under whole-suite load this fixture's hydration is slower, so the
    // churn loop's 90 rAF frames take longer in wall-clock time than in an
    // isolated run, eating into the single two-frame attempt's margin
    // against Playwright's default 5s expect timeout -- the loaded-file-count
    // waits and materializeAndScrollTo's own append-and-retry chain that used
    // to cover this were removed by 26391b4. Wait on the churn loop's own
    // completion signal -- a real condition the test controls, not a blind
    // timeout bump -- before expecting the header, so the header check below
    // gets its full 5s against a settled `items` instead of racing churn.
    await page.waitForFunction(
      () => document.documentElement.dataset.reviewDiffChurnDone === "true",
    );

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

test("switching the diff theme no longer rebuilds CodeView, and the reader stays on the same file", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#performance-fixture`);
    const diff = page.getByRole("region", { name: "Review diff" });
    const diffViewport = page.locator(".review-diff-viewport");
    const path = "src/generated/file-0050.ts";

    // As in "file-tree search selects a file deep in a large patch...",
    // scroll to a file far enough down that it starts outside CodeView's
    // rendered window.
    await page.locator("[data-file-tree-search-input]").fill("file-0050");
    const target = page.getByRole("treeitem", { name: "file-0050.ts" });
    await expect(target).toBeVisible();
    await target.click();
    await expect(diff).toHaveAttribute("data-selected-path", path);

    const header = page.locator(`[data-review-diff-file-header="${path}"]`);
    await expect(header).toBeVisible({ timeout: 5_000 });
    const landedOnFile = async (): Promise<boolean> => {
      const [headerBox, viewportBox] = await Promise.all([
        header.boundingBox(),
        diffViewport.boundingBox(),
      ]);
      if (headerBox === null || viewportBox === null) return false;
      // scrollTop alone would not prove file-0050's header actually reached
      // the viewport: only a vertical overlap between the header's box and
      // the viewport's visible box does.
      return (
        headerBox.y + headerBox.height > viewportBox.y &&
        headerBox.y < viewportBox.y + viewportBox.height
      );
    };
    expect(await landedOnFile()).toBe(true);

    // Before slice 6, changing the light diff theme rewrote
    // `themePreferences.light`, part of `CodeView`'s own React key alongside
    // `fileMode` and `appearance` -- tearing `CodeView` down and rebuilding
    // it, which discarded its scroll position. That is what
    // `restoreFilePathRef`/the `useLayoutEffect` above it in
    // `review-diff-view.tsx` exists to repair, and this test originally
    // proved that repair by using a theme switch as its rebuild trigger
    // deliberately (a `fileMode` round trip was ruled out at the time:
    // "Selected" mode only ever shows one file, so returning from it
    // restores trivially through `selectionScrollProgress` regardless of
    // whether the repair effect does anything).
    //
    // Slice 6 moved `theme`/`themeType` off the key onto Pierre's own
    // options path (`codeViewOptions`, forwarded through
    // `instance.setOptions()`), so a theme switch no longer rebuilds
    // `CodeView` at all -- confirmed by "switching the diff appearance
    // genuinely re-colours the rendered code" below, which shows the same
    // options path repaints every token whether or not a rebuild happens.
    // With no rebuild, this test's outcome (the reader stays on
    // file-0050) is now trivially true and no longer exercises
    // `restoreFilePathRef` here.
    //
    // Checked whether a `fileMode` round trip ("All files" -> "Selected" ->
    // "All files", the only trigger left in `codeViewKey` now that it is
    // just `viewerKey`) could take over as the rebuild trigger instead: it
    // cannot. With `restoreFilePathRef`'s restore temporarily disabled,
    // that round trip still landed back on the selected file every time,
    // because `selectionScrollProgress` -- the same pre-existing effect
    // ruled out above -- re-scrolls to `selectedPath` on every `fileMode`
    // change unconditionally, and "Selected" mode's toolbar button is
    // disabled whenever nothing is selected, so a `fileMode` change with no
    // `selectedPath` to fall back on is not reachable through the UI
    // either. No reachable trigger distinguishes `restoreFilePathRef`
    // working from it doing nothing, so this repo currently has no test
    // that exercises it -- it is not deleted (`review-diff-view.tsx` is
    // still in scope for future rebuild triggers that key might grow), but
    // it should be treated as unreachable, not as covered, until one is
    // added.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox", { name: "Light diff theme" }).click();
    await page.getByRole("option", { name: "Pierre Light Soft" }).click();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();

    // No rebuild means no scroll reset to repair; file-0050's header simply
    // never leaves the viewport.
    await expect(header).toBeVisible({ timeout: 5_000 });
    await expect.poll(landedOnFile).toBe(true);
  } finally {
    await close(server);
  }
});

test("switching the diff appearance genuinely re-colours the rendered code", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#performance-fixture`);
    const diff = page.getByRole("region", { name: "Review diff" });
    await expect(diff).toBeVisible();

    // Pierre's `File` renderer bakes BOTH a light and a dark hex value onto
    // every syntax token as `--diffs-token-light`/`--diffs-token-dark`
    // inline custom properties (see `node_modules/@pierre/diffs/dist/style.js`:
    // `[data-line] span { color: light-dark(var(--diffs-token-light, ...),
    // var(--diffs-token-dark, ...)) }`), and lets the shadow host's
    // `color-scheme` -- driven by `options.themeType` -- pick between them.
    // Reading the browser's own resolved `color`, not either custom
    // property or any attribute, is what proves the picked value actually
    // changed on screen; a class or attribute could flip without the reader
    // seeing a different colour. Each rendered file lives inside its own
    // open shadow root (`<diffs-container>`), several of them nested under
    // the virtualized viewport, so finding a token means piercing into
    // whichever one has painted content so far.
    const firstTokenColor = () =>
      page.evaluate(() => {
        const pierce = (root: Document | ShadowRoot): Element | null => {
          const direct = root.querySelector(
            '[data-line] span[style*="--diffs-token-light"]',
          );
          if (direct !== null) return direct;
          for (const el of Array.from(root.querySelectorAll("*"))) {
            if (el.shadowRoot != null) {
              const found = pierce(el.shadowRoot);
              if (found !== null) return found;
            }
          }
          return null;
        };
        const span = pierce(document);
        return span === null ? null : getComputedStyle(span).color;
      });

    await expect.poll(firstTokenColor, { timeout: 5_000 }).not.toBeNull();
    const before = await firstTokenColor();

    // `appearance` is no longer part of `codeViewKey` (see the comment on
    // `codeViewKey` in `review-diff-view.tsx`), so this switch re-options
    // Pierre's existing `CodeView` instance in place rather than rebuilding
    // it -- this assertion is the proof that the options path alone still
    // repaints every token.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox", { name: "Appearance" }).click();
    await page.getByRole("option", { name: "Dark", exact: true }).click();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();

    // Give the re-optioned `CodeView` a moment to re-render and pick the
    // dark half of each token's baked-in pair back up; poll rather than
    // assert once.
    await expect.poll(firstTokenColor, { timeout: 5_000 }).not.toBe(before);
  } finally {
    await close(server);
  }
});

test("keyboard input scrolls the diff viewport once it is focusable", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#performance-fixture`);
    const diffViewport = page.locator(".review-diff-viewport");
    await expect(diffViewport).toBeVisible();

    // Load-bearing on the fix itself: Pierre's own CodeView.setup()
    // defaults the container to tabindex="-1" (script-focusable via
    // .focus(), but not reachable by sequential Tab navigation) whenever no
    // tabindex is already present, so a scroll-after-.focus() check alone
    // would pass even without this fix. tabindex="0" plus a named
    // role="region" are what actually make the viewport a real keyboard tab
    // stop with an accessible name.
    await expect(diffViewport).toHaveAttribute("tabindex", "0");
    await expect(
      page.getByRole("region", { name: "Diff content" }),
    ).toHaveCount(1);

    const overflow = () =>
      diffViewport.evaluate(
        (viewport) => viewport.scrollHeight - viewport.clientHeight,
      );
    // The performance fixture is a ~1000-file synthetic patch, so genuine
    // overflow well past this low bar is present from the first render.
    await expect.poll(overflow).toBeGreaterThan(500);

    const scrollTop = () =>
      diffViewport.evaluate((viewport) => viewport.scrollTop);
    // Pierre's CodeView is virtualized: a ResizeObserver on the sticky
    // container (`handleResize` / `resolveAnchoredScrollTop` in
    // @pierre/diffs/dist/components/CodeView.js) can re-anchor scrollTop as
    // items mount/unmount, occasionally reverting a single key's nudge
    // before the next frame. Retry the press instead of asserting after one
    // fixed wait, for the same reason 55a137f retries past Pierre's
    // post-scroll pointer-event suspension rather than guessing a sleep.
    // This proves the browser's native key-scroll wiring works without
    // fighting Pierre's own scroll compensation, which this fix must not
    // touch (the repo already rejected code that does, see fcd2bc9).
    const pressUntil = async (
      key: string,
      matches: (current: number, before: number) => boolean,
    ): Promise<number> => {
      const before = await scrollTop();
      await expect
        .poll(
          async () => {
            await page.keyboard.press(key);
            return matches(await scrollTop(), before);
          },
          { timeout: 3_000 },
        )
        .toBe(true);
      return scrollTop();
    };

    // Home alone feeds an assertion about WHERE the viewport ended up, not
    // just that it moved, so pressUntil's "any change in the right
    // direction" wait condition is too weak for it: Pierre's virtualizer can
    // revert part of a key's native jump on a later frame as it re-anchors
    // (see comment above), and pressUntil's poll can return on that
    // transient, not-yet-corrected position. pressUntilSettled instead keeps
    // re-pressing the key until two consecutive reads agree, i.e. the
    // position has actually stopped moving.
    //
    // This is deliberately NOT reused for End (see the comment at afterEnd
    // below): End scrolling toward the bottom lands among files that have
    // not finished hydrating yet, and each one's real content can render at
    // a different height than its placeholder, which keeps shifting
    // scrollHeight out from under a "wait for scrollTop to stop changing"
    // loop -- two consecutive equal reads there can mean "no file near here
    // has hydrated in a while", not "truly at rest", making that signal
    // actively misleading for End. Scrolling up toward already-rendered,
    // already-hydrated content triggers no such shift, so it is a sound
    // settle signal for Home specifically.
    const pressUntilSettled = async (key: string): Promise<number> => {
      let previous = await scrollTop();
      let observedMovement = false;
      let stableStreak = 0;
      await expect
        .poll(
          async () => {
            await page.keyboard.press(key);
            const current = await scrollTop();
            // A press's native scroll can land on the compositor a frame
            // after this synchronous read returns, so the very first
            // post-press read sometimes still reports the pre-press value.
            // Treating that as "settled" would be the exact bug being fixed
            // here (declaring victory before the key has done anything), so
            // equality only counts once at least one real change has been
            // observed. A single repeated read isn't enough either: this
            // fixture's virtualizer can also pause at a genuine intermediate
            // position (observed: two identical reads at ~1868 that then
            // continued on toward 0 on a later press), so settling requires
            // several consecutive identical reads, not just one pair.
            if (observedMovement && current === previous) {
              stableStreak += 1;
            } else {
              stableStreak = 0;
            }
            if (current !== previous) observedMovement = true;
            previous = current;
            return stableStreak >= 3;
          },
          { timeout: 8_000 },
        )
        .toBe(true);
      return scrollTop();
    };

    await diffViewport.focus();
    await expect(diffViewport).toBeFocused();

    // This fixture's linked finding sits on file-0999, the last file, so the
    // mount-time scroll-to-finding effect drives the viewport away from the
    // top before any key is pressed -- 0 is not a valid baseline here. (It
    // used to be, by accident: under progressive loading file-0999 stayed
    // absent long enough that the scroll never fired. Now that every file is
    // in `items` from the first frame, it fires like any other finding
    // link.) Wait for that mount-time scroll to settle, then read whatever
    // position it actually lands on -- reading mid-scroll would make the
    // first key's "did it move" comparison meaningless.
    let priorScrollTop: number | undefined;
    await expect
      .poll(async () => {
        const current = await scrollTop();
        const settled = current === priorScrollTop;
        priorScrollTop = current;
        return settled;
      })
      .toBe(true);
    const initialScrollTop = priorScrollTop;
    if (initialScrollTop === undefined) {
      throw new Error("expected a settled initial scrollTop");
    }

    // Focus + PageDown is the load-bearing proof: with no tabIndex, this
    // press would leave scrollTop exactly at initialScrollTop forever
    // (verified by temporarily reverting the fix, see commit message).
    await pressUntil("PageDown", (c, b) => c > b);
    expect(await scrollTop()).toBeGreaterThan(initialScrollTop);

    // The rest of this test's PageDown/PageUp/End/Home dance is designed to
    // run from a stable, already-hydrated position (pre-26391b4 that was
    // true at scrollTop 0 for free). It is not true where the fix above just
    // proved a keypress lands: `initialScrollTop` sits near file-0999's
    // position, i.e. near the diff's tail, where per-file hydration can
    // still be shifting scrollHeight moment to moment (see the comment on
    // afterEnd below). Left there, afterSecondPageDown and afterEnd both fall
    // within a few dozen pixels of the same shifting maxScrollTop, so
    // hydration noise -- not a real regression -- can invert the
    // afterEnd/afterSecondPageDown comparison below. Relocate to the top
    // first (already-hydrated, stable content) so that comparison is decided
    // by End actually reaching the tail, not by which of two near-identical,
    // still-moving values happened to read higher.
    await pressUntilSettled("Home");

    await pressUntil("ArrowDown", (c, b) => c > b);
    const afterSecondPageDown = await pressUntil("PageDown", (c, b) => c > b);
    await pressUntil("PageUp", (c, b) => c < b);
    const afterEnd = await pressUntil("End", (c, b) => c > b);
    // End should reach materially further than a page-up/page-down dance
    // did, proving it is not merely replaying the previous key's effect.
    //
    // This comparison's wait condition has the same "any movement" shape
    // flagged for Home below, but is not the same flake risk: the pre-End
    // position here (after PageUp) is a modest few-page-heights value, not
    // the near-maximum position Home starts from after End, so Pierre's
    // few-pixel re-anchoring correction cannot plausibly invert this
    // comparison the way it inverted Home's. A settle-based wait was tried
    // here too and made things worse: every one of this fixture's ~1,000
    // files is in the diff's item list from the first render, but each
    // file's real content still hydrates asynchronously, one at a time
    // (`hydrateFiles` in review-diff-view.tsx), and a file's hydrated
    // content can render at a different height than its pre-hydration
    // placeholder. So scrollHeight keeps shifting for a while after mount
    // as files hydrate near the bottom, and "wait until scrollTop stops
    // changing" chases a target that keeps moving on its own schedule and
    // can declare a false settle mid-hydration (observed: afterEnd landing
    // anywhere from ~400 to ~1200 across otherwise-identical runs, well
    // short of a real bottom). Left on pressUntil's original wait
    // condition, which only needs a single genuine jump past
    // afterSecondPageDown to hold.
    expect(afterEnd).toBeGreaterThan(afterSecondPageDown);

    const afterHome = await pressUntilSettled("Home");
    // Home is not asserted to land at exactly 0: after a large scroll
    // excursion Pierre's virtualizer can settle a few pixels off true top
    // as it re-measures rendered items, which is layout behavior unrelated
    // to this fix's key-focusability change.
    //
    // This used to be `expect(afterHome).toBeLessThan(afterPageUp)`, fed by
    // `pressUntil("Home", (c, b) => c < b)` -- satisfied by ANY decrease
    // from the pre-Home (near-bottom) position, so it could return long
    // before the virtualizer's re-anchoring actually settled. Observed
    // flaky failures included afterHome=14964 against afterPageUp=1253, and
    // afterHome=209 against afterPageUp=40: a barely-moved value that still
    // happened to satisfy "less than" whichever position the page-up step
    // had reached. pressUntilSettled fixes the wait condition itself (wait
    // for the position to stop changing, not for a single decrease), and a
    // fixed, small pixel threshold -- independent of any other poll's
    // result, and not scaled to a scrollHeight that this same fixture can
    // still be shifting as its ~1,000 files finish hydrating -- keeps the
    // assertion meaningful: it still fails if Home does nothing (stays at a
    // multi-hundred/thousand-pixel scroll position) or only moves a little
    // (one PageUp-sized step is itself already ~800px).
    expect(afterHome).toBeLessThan(300);

    const afterSpace = await pressUntil("Space", (c, b) => c > b);
    await pressUntil("Shift+Space", (c) => c < afterSpace);
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

test("the header refresh control is reachable when GitHub state is fresh", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.goto(`${origin(server)}/#workbench-fixture`);
    const freshRefresh = page.getByRole("button", {
      name: "Refresh GitHub state",
    });
    await expect(freshRefresh).toBeVisible();
    await expect(freshRefresh).toBeEnabled();
  } finally {
    await close(server);
  }
});

test("the header refresh control is reachable when GitHub state is unavailable, and the sheet no longer drives refresh", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.goto(`${origin(server)}/#workbench-refresh-unavailable-fixture`);
    await expect(page.getByText("Remote state unavailable")).toBeVisible();
    const unavailableRefresh = page.getByRole("button", {
      name: "Refresh GitHub state",
    });
    await expect(unavailableRefresh).toBeVisible();
    await expect(unavailableRefresh).toBeEnabled();
    // The sheet no longer drives refresh -- it only reads state.
    await page.getByRole("button", { name: "PR overview" }).click();
    const overview = page.getByRole("dialog", { name: "PR overview" });
    await expect(overview).toBeVisible();
    await expect(
      overview.getByRole("button", { name: "Refresh GitHub state" }),
    ).toHaveCount(0);
  } finally {
    await close(server);
  }
});

test("the amber Updates available indicator renders as a signal without its own button", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.goto(`${origin(server)}/#workbench-updates-available-fixture`);
    const indicator = page.locator("[data-review-new-version-indicator]");
    await expect(indicator).toBeVisible();
    await expect(indicator).toHaveAttribute("role", "status");
    await expect(indicator).toHaveText("Updates available");
    await expect(indicator.getByRole("button")).toHaveCount(0);
    // Refresh lives in exactly one place now: the header control beside it.
    await expect(
      page.getByRole("button", { name: "Refresh GitHub state" }),
    ).toBeVisible();
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
function isAddressInfo(address: string | AddressInfo): address is AddressInfo {
  return Object.prototype.hasOwnProperty.call(address, "port");
}
function origin(server: Server): string {
  const address = server.address();
  if (address === null || !isAddressInfo(address))
    throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
