import { expect, test } from "playwright/test";
import {
  chooseDiffOptions,
  closeServer,
  openDiff,
  serveRenderer,
  serverOrigin,
} from "./renderer-server";

// `new-2-47` is the added text on line 48 of src/c.ts, the last line of the
// fixture's last file, so reaching it takes a scroll past two virtualized files.
const LAST_LINE_TEXT = "new-2-47";

test("⌘F in All files expands a Viewed file, lands on the match, and marks its line until Escape", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await openDiff(page, `${serverOrigin(server)}/#active-follow-fixture`);
    const viewedCount = page.getByRole("button", { name: /^\d+\/\d+ viewed$/ });
    await viewedCount.click();
    await page.getByRole("menuitem", { name: "Mark all viewed" }).click();
    // ⌘F is ignored while focus is still inside the closing menu.
    await expect(page.getByRole("menu")).toHaveCount(0);

    await page.keyboard.press("ControlOrMeta+f");
    const field = page.getByRole("textbox", { name: "Find in diff" });
    await expect(field).toBeFocused();
    await field.fill(LAST_LINE_TEXT);
    await field.press("Enter");

    const status = page.locator("[data-review-diff-navigation-status]");
    await expect(status).toHaveAttribute("data-navigation-kind", "find");
    await expect(status).toHaveAttribute("data-navigation-path", "src/c.ts");
    await expect(status).toHaveAttribute("data-navigation-line", "48");
    await expect(
      page.getByRole("search", { name: "Find in diff" }),
    ).toContainText("1 of 1");
    // Only src/c.ts left Viewed, so it is the one file drawing its line 48.
    const row = page.locator(
      '[data-line-type="change-addition"][data-line="48"]',
    );
    await expect(row).toHaveCount(1);
    await expect
      .poll(() =>
        row.evaluate((element) => getComputedStyle(element).boxShadow),
      )
      .not.toBe("none");
    await expect(
      page.getByRole("checkbox", { name: "Mark file src/c.ts as viewed" }),
    ).toBeVisible();

    await field.press("Escape");
    await expect(
      page.getByRole("search", { name: "Find in diff" }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        row.evaluate((element) => getComputedStyle(element).boxShadow),
      )
      .toBe("none");
  } finally {
    await closeServer(server);
  }
});

test("⌘F in Selected selects the file that holds the match", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await openDiff(page, `${serverOrigin(server)}/#active-follow-fixture`);
    await page.getByRole("treeitem", { name: "a.ts" }).click();
    await chooseDiffOptions(page, { fileMode: "Selected" });
    const diff = page.getByRole("region", { name: "Review diff" });
    await expect(diff).toHaveAttribute("data-selected-path", "src/a.ts");
    // ⌘F is ignored while focus is still inside the closing View options popover.
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.keyboard.press("ControlOrMeta+f");
    const field = page.getByRole("textbox", { name: "Find in diff" });
    await field.fill(LAST_LINE_TEXT);
    await field.press("Enter");

    await expect(diff).toHaveAttribute("data-selected-path", "src/c.ts");
    await expect(
      page.locator("[data-review-diff-navigation-status]"),
    ).toHaveAttribute("data-navigation-line", "48");
  } finally {
    await closeServer(server);
  }
});

// A line in the middle of the next file, and the last line of the last file.
for (const { text, path, line } of [
  { text: "new-1-30", path: "src/b.ts", line: "31" },
  { text: LAST_LINE_TEXT, path: "src/c.ts", line: "48" },
]) {
  test(`⌘F into ${path} lands line ${line} on screen on the first Enter`, async ({
    page,
  }) => {
    const server = await serveRenderer();
    try {
      await page.setViewportSize({ width: 1_440, height: 900 });
      await openDiff(page, `${serverOrigin(server)}/#active-follow-fixture`);

      await page.keyboard.press("ControlOrMeta+f");
      const field = page.getByRole("textbox", { name: "Find in diff" });
      await field.fill(text);
      await field.press("Enter");
      await expect(
        page.locator("[data-review-diff-navigation-status]"),
      ).toHaveAttribute("data-navigation-path", path);
      // Landing reports the file active; with no file chosen that selects it,
      // and a selection scroll to its header used to run within these frames.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
          ),
      );

      const row = page
        .locator(`[data-line-type="change-addition"][data-line="${line}"]`)
        .filter({ hasText: text });
      const viewport = page.locator(".review-diff-viewport");
      await expect
        .poll(async () => {
          const [rowBox, viewportBox] = await Promise.all([
            row.boundingBox(),
            viewport.boundingBox(),
          ]);
          return (
            rowBox !== null &&
            viewportBox !== null &&
            rowBox.y >= viewportBox.y &&
            rowBox.y + rowBox.height <= viewportBox.y + viewportBox.height
          );
        })
        .toBe(true);
    } finally {
      await closeServer(server);
    }
  });
}

test("closing find with its button returns focus to the Browse row ⌘F was pressed on", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await openDiff(page, `${serverOrigin(server)}/#active-follow-fixture`);
    // The row sits in the tree's shadow root, so the document names only its host as focused.
    const row = page.getByRole("treeitem", { name: "b.ts" });
    await row.click();
    await expect(row).toBeFocused();

    await page.keyboard.press("ControlOrMeta+f");
    await page.getByRole("textbox", { name: "Find in diff" }).fill("new-1");
    await page.getByRole("button", { name: "Close find" }).click();

    await expect(
      page.getByRole("search", { name: "Find in diff" }),
    ).toHaveCount(0);
    await expect(row).toBeFocused();
  } finally {
    await closeServer(server);
  }
});
