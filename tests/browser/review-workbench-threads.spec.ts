import { expect, test } from "playwright/test";
import { closeServer, serveRenderer, serverOrigin } from "./renderer-server";

test("long Threads path stays contained at the minimum navigator width", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${serverOrigin(server)}/#active-follow-fixture`);

    const handle = page.getByRole("separator", {
      name: "Resize review navigator",
    });
    await handle.focus();
    await page.keyboard.press("Home");
    await expect(handle).toHaveAttribute("aria-valuenow", "14");

    await page.getByRole("tab", { name: "Threads" }).click();
    const card = page.getByRole("button", {
      name: "new-side-thread-author",
    });
    const path = card.locator("span").last();
    await path.evaluate((element) => {
      element.textContent = `${"src/long-unbroken-segment/".repeat(12)}review-boundary.ts:45`;
    });

    const metrics = await path.evaluate((element) => {
      const card = element.parentElement;
      if (card === null) {
        throw new Error("Expected the Threads path card");
      }
      const parent = card.parentElement;
      if (parent === null) {
        throw new Error("Expected the Threads path card and list");
      }
      return {
        pathClientWidth: element.clientWidth,
        pathScrollWidth: element.scrollWidth,
        textOverflow: getComputedStyle(element).textOverflow,
        cardClientWidth: card.clientWidth,
        cardScrollWidth: card.scrollWidth,
        parentClientWidth: parent.clientWidth,
        parentScrollWidth: parent.scrollWidth,
      };
    });

    expect(metrics.pathScrollWidth).toBeGreaterThan(metrics.pathClientWidth);
    expect(metrics.textOverflow).toBe("ellipsis");
    expect(metrics.cardScrollWidth).toBeLessThanOrEqual(
      metrics.cardClientWidth,
    );
    expect(metrics.parentScrollWidth).toBeLessThanOrEqual(
      metrics.parentClientWidth,
    );
  } finally {
    await closeServer(server);
  }
});
