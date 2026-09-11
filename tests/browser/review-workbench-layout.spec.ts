import { expect, test } from "playwright/test";
import {
  closeServer,
  openDiff,
  serveRenderer,
  serverOrigin,
} from "./renderer-server";

test("Patchdesk mounts no shadcn Sidebar, and the diff fills the column its neighbours leave", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await openDiff(page, `${serverOrigin(server)}/#workbench-fixture`);
    await expect(
      page.getByRole("region", { name: "Review diff" }),
    ).toBeVisible();

    const metrics = await page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector(selector);
        if (element === null) throw new Error(`Expected ${selector}`);
        const { left, right, width } = element.getBoundingClientRect();
        return { left, right, width };
      };
      return {
        hasTitlebar: document.querySelector(".app-titlebar") !== null,
        // shadcn's Sidebar primitive stamps this slot on its root. It was
        // prototyped and abandoned (f37eda65 deleted its leftover CSS), and
        // #119 shipped a hand-rolled <aside id="visited-pull-requests">
        // instead, so no Patchdesk chrome may mount it anywhere in the tree.
        hasShadcnSidebar:
          document.querySelector('[data-slot="sidebar"]') !== null,
        diff: box('[aria-label="Review diff"]'),
        grid: box("[data-review-diff-layout]"),
        navigator: box('[aria-label="Review navigation"]'),
        handle: box("[data-review-navigator-resize-handle]"),
        visited: box("#visited-pull-requests"),
        overflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      };
    });

    expect(metrics.hasTitlebar).toBe(true);
    expect(metrics.hasShadcnSidebar).toBe(false);

    // The diff owns the grid's third column outright: its left edge meets the
    // resize handle's right edge and its right edge meets the grid's, so
    // nothing is wedged in beside it and none of the column goes unused. This
    // replaces a `diffWidth > 1000` floor that stood in for the same property
    // through arithmetic over every column width around it, and so failed (at
    // 866) the moment #119 added a 256px column, with nothing actually broken.
    expect(
      Math.abs(metrics.diff.left - metrics.handle.right),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(metrics.diff.right - metrics.grid.right),
    ).toBeLessThanOrEqual(1);

    // The reading surface stays the widest thing on screen -- wider than both
    // persistent left columns put together -- which is the desktop-width claim
    // the pixel floor was reaching for, stated against the layout rather than
    // against one viewport's arithmetic.
    expect(metrics.diff.width).toBeGreaterThan(
      metrics.navigator.width + metrics.visited.width,
    );

    expect(metrics.overflow).toBeLessThanOrEqual(1);
  } finally {
    await closeServer(server);
  }
});
