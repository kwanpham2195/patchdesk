import { expect, test, type Page } from "playwright/test";
import { closeServer, serveRenderer, serverOrigin } from "./renderer-server";

async function openWalkthroughFixture(
  page: Page,
  origin: string,
): Promise<void> {
  await page.goto(`${origin}/#walkthrough-fixture`);
  await page.getByRole("button", { name: "Generate walkthrough" }).click();
  const dialog = page.getByRole("dialog", { name: "Generate walkthrough" });
  await dialog.getByRole("combobox", { name: "Model" }).click();
  await page.getByRole("option", { name: "Design model" }).click();
  await dialog.getByRole("button", { name: "Generate walkthrough" }).click();
  await page.getByRole("button", { name: "Open walkthrough" }).click();
}

test("Walkthrough View options stay with their trigger while the reader scrolls", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await openWalkthroughFixture(page, serverOrigin(server));

    const reader = page
      .getByRole("region", { name: "Walkthrough reading surface" })
      .locator('[data-slot="scroll-area-viewport"]');
    await page.locator("[data-walkthrough-reader]").evaluate((element) => {
      Object.assign(element.style, { height: "600px", flex: "none" });
    });
    const trigger = page
      .locator('[data-walkthrough-diff-block="section-1::h1::0"]')
      .getByRole("button", { name: "View options" });
    await expect(trigger).toBeVisible();
    const contentSize = await reader.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(contentSize.scrollHeight).toBeGreaterThan(contentSize.clientHeight);

    await trigger.click();
    const popup = page.getByRole("dialog", { name: "View options" });
    await expect(popup).toBeVisible();
    await expect
      .poll(async () => {
        const [anchor, bounds] = await Promise.all([
          trigger.boundingBox(),
          popup.boundingBox(),
        ]);
        return anchor === null || bounds === null
          ? -Infinity
          : bounds.y - (anchor.y + anchor.height);
      })
      .toBeGreaterThanOrEqual(0);

    const triggerBeforeScroll = await trigger.boundingBox();
    const popupBeforeScroll = await popup.boundingBox();
    if (triggerBeforeScroll === null || popupBeforeScroll === null)
      throw new Error("Walkthrough View options have no layout box");
    expect(
      popupBeforeScroll.y -
        (triggerBeforeScroll.y + triggerBeforeScroll.height),
    ).toBeGreaterThanOrEqual(0);
    expect(
      popupBeforeScroll.y -
        (triggerBeforeScroll.y + triggerBeforeScroll.height),
    ).toBeLessThan(9);

    const readerBox = await reader.boundingBox();
    if (readerBox === null) throw new Error("Walkthrough reader has no box");
    await page.mouse.move(readerBox.x + 24, readerBox.y + readerBox.height / 2);
    await page.mouse.wheel(0, 100);
    await expect
      .poll(
        async () => (await reader.evaluate((element) => element.scrollTop)) > 0,
      )
      .toBe(true);

    const triggerAfterScroll = await trigger.boundingBox();
    const popupAfterScroll = await popup.boundingBox();
    if (triggerAfterScroll === null || popupAfterScroll === null)
      throw new Error("Walkthrough View options lost their layout box");
    expect(triggerAfterScroll.y).toBeLessThan(triggerBeforeScroll.y);
    expect(
      popupAfterScroll.y - (triggerAfterScroll.y + triggerAfterScroll.height),
    ).toBeGreaterThanOrEqual(0);
    expect(
      popupAfterScroll.y - (triggerAfterScroll.y + triggerAfterScroll.height),
    ).toBeLessThan(9);

    await reader.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(() =>
        reader.evaluate(
          (element) =>
            element.scrollTop + element.clientHeight >= element.scrollHeight,
        ),
      )
      .toBe(true);
    const [triggerRect, readerRect] = await Promise.all([
      trigger.evaluate((element) => element.getBoundingClientRect().toJSON()),
      reader.evaluate((element) => element.getBoundingClientRect().toJSON()),
    ]);
    expect(
      triggerRect.bottom <= readerRect.top ||
        triggerRect.top >= readerRect.bottom,
    ).toBe(true);
    await expect(popup).toBeHidden();
  } finally {
    await closeServer(server);
  }
});

test("Walkthrough View options flip above their trigger near the viewport bottom", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 300 });
    await openWalkthroughFixture(page, serverOrigin(server));

    const trigger = page
      .locator('[data-walkthrough-diff-block="section-1::h1::0"]')
      .getByRole("button", { name: "View options" });
    await expect(trigger).toBeVisible();
    await trigger.click();

    const popup = page.getByRole("dialog", { name: "View options" });
    await expect(popup).toBeVisible();
    const [triggerBounds, popupBounds] = await Promise.all([
      trigger.boundingBox(),
      popup.boundingBox(),
    ]);
    const viewport = page.viewportSize();
    if (triggerBounds === null || popupBounds === null || viewport === null)
      throw new Error("Walkthrough View options have no layout box");

    expect(popupBounds.y).toBeLessThan(triggerBounds.y);
    expect(
      triggerBounds.y - (popupBounds.y + popupBounds.height),
    ).toBeGreaterThan(-5);
    expect(triggerBounds.y - (popupBounds.y + popupBounds.height)).toBeLessThan(
      9,
    );
    expect(popupBounds.y).toBeGreaterThanOrEqual(0);
    expect(popupBounds.y + popupBounds.height).toBeLessThanOrEqual(
      viewport.height,
    );
    expect(
      triggerBounds.y + triggerBounds.height + popupBounds.height,
    ).toBeGreaterThan(viewport.height);
  } finally {
    await closeServer(server);
  }
});
