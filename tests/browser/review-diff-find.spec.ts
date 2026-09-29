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
