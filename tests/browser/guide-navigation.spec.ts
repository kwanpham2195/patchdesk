import { expect, test, type Locator } from "playwright/test";
import { closeServer, serveRenderer, serverOrigin } from "./renderer-server";

async function expectPreviewReachable(preview: Locator): Promise<void> {
  await expect(preview).toBeVisible();
  expect(
    await preview.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      return (
        bounds.left >= 0 &&
        bounds.top >= 0 &&
        bounds.right <= innerWidth &&
        bounds.bottom <= innerHeight
      );
    }),
  ).toBe(true);
  const jump = preview.getByRole("button").first();
  expect(
    await jump.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      return node.contains(
        document.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        ),
      );
    }),
  ).toBe(true);
}

test("Guide keeps its resting rail compact and animates focus expansion without moving content", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${serverOrigin(server)}/#guide-fixture`);
    const rail = page.getByRole("button", { name: /^Jump to Guide group:/ });
    const strip = rail.locator("[data-guide-minimap-strip='g1']");
    const viewport = page.locator("[data-guide-viewport]");
    const before = await viewport.boundingBox();
    const positions = await rail
      .locator("[data-guide-minimap-strip]")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getBoundingClientRect().top),
      );
    let previous: number | undefined;
    for (const position of positions) {
      if (previous !== undefined)
        expect(Math.abs(position - previous - 8)).toBeLessThan(0.25);
      previous = position;
    }
    expect(
      await strip.evaluate((node) => node.getBoundingClientRect().width),
    ).toBeLessThan(9);
    const next = page.getByRole("button", { name: "Next Guide group" });
    await expect(next).toHaveCSS("opacity", "0");
    const middleWidth = await rail.evaluate(async (node) => {
      node.focus();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const marker = node.querySelector("[data-guide-minimap-strip='g1']");
      if (marker === null) throw new Error("Missing Guide marker");
      const animation = marker.getAnimations()[0];
      if (animation === undefined)
        throw new Error("Guide expansion did not animate");
      animation.pause();
      animation.currentTime =
        Number(animation.effect?.getTiming().duration) / 2;
      return marker.getBoundingClientRect().width;
    });
    expect(middleWidth).toBeGreaterThan(9);
    expect(middleWidth).toBeLessThan(24);
    await strip.evaluate((node) =>
      node.getAnimations().forEach((animation) => animation.finish()),
    );
    expect(
      await strip.evaluate((node) => node.getBoundingClientRect().width),
    ).toBe(24);
    await expect(next).toHaveCSS("opacity", "1");
    expect(await viewport.boundingBox()).toEqual(before);
    expect(await viewport.evaluate((node) => node.scrollTop)).toBe(0);
    await rail.press("Escape");
    await next.focus();
    await expect(next).toHaveCSS("opacity", "1");
    await next.press("Enter");
    await expect(
      page.locator("[data-guide-minimap-group='g2']"),
    ).toBeInViewport();
  } finally {
    await closeServer(server);
  }
});

test("Guide first, middle and last previews escape transformed ancestry and accept pointer and keyboard actions", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1440, height: 600 });
    await page.goto(`${serverOrigin(server)}/#guide-fixture`);
    await page.locator("[data-guide-reader]").evaluate((node) => {
      node.style.filter = "blur(0px)";
      node.style.transform = "translate(0px, 0px)";
    });
    const rail = page.getByRole("button", { name: /^Jump to Guide group:/ });
    const viewport = page.locator("[data-guide-viewport]");
    const initialScroll = await viewport.evaluate((node) => node.scrollTop);
    await rail.focus();
    for (const key of ["Home", "ArrowDown", "End"]) {
      await rail.press(key);
      const preview = page.getByRole("note", { name: /^Guide preview / });
      await expectPreviewReachable(preview);
      const bounds = await preview.boundingBox();
      if (bounds === null) throw new Error("Missing preview bounds");
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(600);
      expect(await viewport.evaluate((node) => node.scrollTop)).toBe(
        initialScroll,
      );
    }
    await rail.press("Escape");
    await expect(
      page.getByRole("note", { name: /^Guide preview / }),
    ).toHaveCount(0);
    await expect(rail).toBeFocused();
    const railBounds = await rail.boundingBox();
    if (railBounds === null) throw new Error("No Guide rail");
    await rail.hover({
      position: { x: railBounds.width / 2, y: railBounds.height / 2 },
    });
    const preview = page.getByRole("note", {
      name: "Guide preview Keep the recovery owner together",
    });
    await expectPreviewReachable(preview);
    const action = preview.getByRole("button", {
      name: "src/recovery.ts",
      exact: true,
    });
    await action.hover();
    await expect(preview).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 660 });
    await expectPreviewReachable(preview);
    await action.click();
    await expect(preview).toHaveCount(0);
    await expect(page.locator("[data-guide-file='g2/f1']")).toBeInViewport();
    await expect(
      page
        .getByRole("list", { name: "Keep the recovery owner together files" })
        .getByRole("button", { name: "File src/recovery.ts" }),
    ).toHaveAttribute("aria-expanded", "false");
    await rail.focus();
    await rail.press("Home");
    await page.keyboard.press("Tab");
    await expect(
      page
        .getByRole("note", { name: "Guide preview Recover pending requests" })
        .getByRole("button", { name: "src/recovery.ts", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(rail).toBeFocused();
  } finally {
    await closeServer(server);
  }
});

test("Guide keeps long names and preview text readable while navigating many groups", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 560, height: 900 });
    // The static fixture server serves paths verbatim, so select the variant after its document request.
    await page.addInitScript(() =>
      history.replaceState(null, "", "?guide-navigation#guide-fixture"),
    );
    await page.goto(`${serverOrigin(server)}/#guide-fixture`);
    const picker = page.getByRole("combobox", { name: "Choose Guide group" });
    await picker.focus();
    await picker.press("Enter");
    const option = page.getByRole("option", { name: /After refresh$/ });
    await option.scrollIntoViewIfNeeded();
    expect(
      await option.evaluate((node) => {
        const text = document
          .createTreeWalker(node, NodeFilter.SHOW_TEXT)
          .nextNode();
        if (text === null) throw new Error("Missing group name");
        const range = document.createRange();
        range.selectNode(text);
        const bounds = node.getBoundingClientRect();
        return [...range.getClientRects()].every(
          (rect) =>
            rect.left >= bounds.left &&
            rect.right <= bounds.right &&
            rect.top >= bounds.top &&
            rect.bottom <= bounds.bottom,
        );
      }),
    ).toBe(true);
    await option.click();
    await expect(picker).toContainText("After refresh");
    await page.getByRole("button", { name: "Files", exact: true }).click();
    const preview = page.getByRole("note", { name: /^Guide preview / });
    await expectPreviewReachable(preview);
    expect(
      await preview.evaluate((node) =>
        [...node.querySelectorAll("p")].every(
          (paragraph) =>
            paragraph.getBoundingClientRect().height >=
            Number.parseFloat(getComputedStyle(paragraph).lineHeight),
        ),
      ),
    ).toBe(true);
    await preview
      .getByRole("button", {
        name: "assets/retained/recovery/evidence/icon.png",
        exact: true,
      })
      .click();
    await expect(page.locator("[data-guide-file='g2/f5']")).toBeInViewport();
    await expect(preview).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 600 });
    // The standalone fixture has a fixed outer height; bound its Guide to the short window.
    await page.locator("[data-guide-reader]").evaluate((node) => {
      node.style.height = `${innerHeight - node.getBoundingClientRect().top - 24}px`;
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const viewport = page.locator("[data-guide-viewport]");
    const rail = page.getByRole("button", { name: /^Jump to Guide group:/ });
    await rail.focus();
    const before = await viewport.evaluate((node) => node.scrollTop);
    await rail.press("End");
    const others = page.getByRole("note", { name: "Guide preview Others" });
    await expectPreviewReachable(others);
    expect(await viewport.evaluate((node) => node.scrollTop)).toBe(before);
    const railBounds = await rail.boundingBox();
    const navBounds = await page
      .getByRole("navigation", { name: "Guide groups" })
      .boundingBox();
    if (railBounds === null || navBounds === null)
      throw new Error("Missing Guide navigation");
    expect(railBounds.y + railBounds.height).toBeGreaterThan(navBounds.y);
    expect(railBounds.y + railBounds.height).toBeLessThanOrEqual(
      navBounds.y + navBounds.height,
    );
    await rail.press("Enter");
    await expect(others).toHaveCount(0);
    await expect(
      page.locator("[data-guide-minimap-group='others']"),
    ).toBeInViewport();
  } finally {
    await closeServer(server);
  }
});

test("Guide restores compact Escape focus without suppressing the next wide rail preview", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 560, height: 900 });
    await page.goto(`${serverOrigin(server)}/#guide-fixture`);
    const files = page.getByRole("button", { name: "Files", exact: true });
    await files.click();
    const preview = page.getByRole("note", {
      name: "Guide preview Recover pending requests",
    });
    await preview
      .getByRole("button", { name: "src/recovery.ts", exact: true })
      .focus();
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    await expect(files).toBeFocused();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: /^Jump to Guide group:/ }).focus();
    await expect(preview).toBeVisible();
  } finally {
    await closeServer(server);
  }
});

test("Guide narrow navigation remains reachable inside a long file and selects human group destinations immediately", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 560, height: 600 });
    await page.goto(`${serverOrigin(server)}/#guide-fixture`);
    const picker = page.getByRole("combobox", { name: "Choose Guide group" });
    await expect(picker).toContainText("1. Recover pending requests");
    const first = page.getByRole("list", {
      name: "Recover pending requests files",
    });
    await first.getByRole("button", { name: "File src/recovery.ts" }).click();
    await page
      .getByRole("button", { name: "Reviewed Recover pending requests" })
      .click();
    const target = page.locator("[data-guide-file='g1/f1']");
    await target.evaluate((node) => {
      const viewport = node.closest("[data-guide-viewport]");
      if (viewport === null) throw new Error("No Guide viewport");
      viewport.scrollTop +=
        node.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top +
        800;
    });
    await expect(picker).toBeInViewport();
    await picker.focus();
    await picker.press("Enter");
    await page
      .getByRole("option", { name: /Keep the recovery owner together/ })
      .click();
    await expect(
      page.locator("[data-guide-minimap-group='g2']"),
    ).toBeInViewport();
    await expect(picker).toContainText("2. Keep the recovery owner together");
    await expect(
      page.getByRole("note", { name: /^Guide preview / }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Files", exact: true }).click();
    const preview = page.getByRole("note", {
      name: "Guide preview Keep the recovery owner together",
    });
    await expectPreviewReachable(preview);
    const guideWidth = await page
      .locator("[data-guide-reader]")
      .evaluate((node) => node.getBoundingClientRect().width);
    expect(
      await preview.evaluate((node) => node.getBoundingClientRect().width),
    ).toBeLessThanOrEqual(guideWidth);
    await preview
      .getByRole("button", { name: "src/recovery.ts", exact: true })
      .click();
    await expect(page.locator("[data-guide-file='g2/f1']")).toBeInViewport();
    await expect(preview).toHaveCount(0);
    await expect(
      first.getByRole("button", { name: "File src/recovery.ts" }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByRole("button", { name: "Reviewed Recover pending requests" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      first.getByRole("checkbox", { name: "Viewed src/recovery.ts" }),
    ).not.toBeChecked();
    await picker.focus();
    await picker.press("Enter");
    await page.getByRole("option", { name: /Others/ }).click();
    await expect(
      page.locator("[data-guide-minimap-group='others']"),
    ).toBeInViewport();
    await expect(picker).toContainText("3. Others");
    await picker.focus();
    await picker.press("Enter");
    await page
      .getByRole("option", { name: /Recover pending requests/ })
      .click();
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await page
      .getByRole("note", { name: "Guide preview Recover pending requests" })
      .getByRole("button", { name: "src/recovery.ts", exact: true })
      .click();
    await expect(target).toBeInViewport();
    expect(
      await target.evaluate((node) => {
        const viewport = node.closest("[data-guide-viewport]");
        if (viewport === null) throw new Error("No Guide viewport");
        return Math.abs(
          node.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top,
        );
      }),
    ).toBeLessThan(3);
  } finally {
    await closeServer(server);
  }
});
