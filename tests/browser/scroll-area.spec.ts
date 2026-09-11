import type { Server } from "node:http";
import { expect, test, type Page } from "playwright/test";
import { installTestDesktopBridge } from "./bridge-fixture";
import { closeServer, serveRenderer, serverOrigin } from "./renderer-server";

// Issue #126: `ScrollBar` styled itself with `data-vertical:` / `data-horizontal:`
// variants, which compile to attribute-presence selectors Base UI never emits --
// it emits `data-orientation="vertical"`. The width, height and border rules
// therefore never applied, leaving a 2px bar with a zero-width thumb. Only a
// real browser resolves that, so the proof is computed style rather than the
// class attribute.

/** `w-2.5` on a `box-sizing: border-box` element. */
const SCROLLBAR_WIDTH_PX = 10;

test.describe("scroll area scrollbar", () => {
  let server: Server;
  test.beforeEach(async () => {
    server = await serveRenderer();
  });
  test.afterEach(async () => {
    await closeServer(server);
  });

  test("an overflowing surface draws a full-width bar with a sized thumb", async ({
    page,
  }) => {
    await installTestDesktopBridge(page, { kind: "static" });
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(serverOrigin(server));

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    // Workspace is the longest settings section, so its panel overflows at
    // this window size -- and Base UI mounts the scrollbar only when it does.
    await dialog.getByRole("tab", { name: "Workspace" }).click();

    const region = page.getByTestId("settings-scroll-region");
    const viewport = region.locator('[data-slot="scroll-area-viewport"]');
    await expect(viewport).toBeVisible();
    await expect
      .poll(() =>
        viewport.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        ),
      )
      .toBe(true);

    const scrollbar = region.locator('[data-slot="scroll-area-scrollbar"]');
    await expect(scrollbar).toHaveAttribute("data-orientation", "vertical");
    await expect
      .poll(async () => (await measure(scrollbar)).width)
      .toBe(SCROLLBAR_WIDTH_PX);

    // The thumb fills the bar's inner width, so it is zero whenever the bar
    // collapses to its `p-px` padding -- the shape the bug had.
    const thumb = region.locator('[data-slot="scroll-area-thumb"]');
    const thumbBox = await measure(thumb);
    expect(thumbBox.width).toBeGreaterThan(0);
    expect(thumbBox.height).toBeGreaterThan(0);
  });
});

/** Resolved box of an element, in CSS pixels. */
function measure(
  locator: ReturnType<Page["locator"]>,
): Promise<{ readonly width: number; readonly height: number }> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      width: Number.parseFloat(style.width),
      height: Number.parseFloat(style.height),
    };
  });
}
