import { expect, test } from "playwright/test";
import { closeServer, serveRenderer, serverOrigin } from "./renderer-server";

test("Guide expands complete retained files independently and preserves evidence during generation", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${serverOrigin(server)}/#guide-fixture`);
    const first = page.getByRole("list", {
      name: "Recover pending requests files",
    });
    const second = page.getByRole("list", {
      name: "Keep the recovery owner together files",
    });
    const file = first.getByRole("button", { name: "File src/recovery.ts" });
    await expect(file).toHaveAttribute("aria-expanded", "false");
    await file.click();
    const evidence = first.getByRole("group", {
      name: "Guide evidence src/recovery.ts",
    });
    for (const line of [
      "old",
      "oldCleanup()",
      "restorePending()",
      "snapshotCleanup()",
      ...Array.from(
        { length: 80 },
        (_, index) => `snapshotSupport${index + 1}()`,
      ),
    ]) {
      const changedLine = evidence.getByText(line, { exact: true });
      await changedLine.scrollIntoViewIfNeeded();
      await expect(changedLine).toBeVisible();
    }
    await expect(evidence).toContainText("old mode 100644");
    await expect(evidence).toContainText("new mode 100755");
    await first
      .getByRole("button", { name: "File tests/recovery.test.ts" })
      .click();
    await expect(
      first.getByText("expectRecovered()", { exact: true }),
    ).toBeVisible();
    await expect(
      second.getByRole("button", { name: "File src/recovery.ts" }),
    ).toHaveAttribute("aria-expanded", "false");
    await second.getByRole("button", { name: "File src/recovery.ts" }).click();
    await file.click();
    await expect(
      second.getByRole("group", { name: "Guide evidence src/recovery.ts" }),
    ).toBeVisible();
    await expect(
      first.getByRole("group", { name: "Guide evidence src/recovery.ts" }),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "Show outdated revision" }).click();
    await expect(
      second
        .getByRole("group", { name: "Guide evidence src/recovery.ts" })
        .getByText("snapshotCleanup()", { exact: true }),
    ).toBeVisible();
    await second.getByRole("button", { name: "File src/new.ts" }).click();
    await expect(
      second.getByRole("group", { name: "Guide evidence src/new.ts" }),
    ).toContainText("rename from src/old.ts");
    const others = page.getByRole("list", { name: "Others files" });
    await others.getByRole("button", { name: "File src/deleted.ts" }).click();
    await expect(
      others.getByText("obsoleteSnapshot()", { exact: true }),
    ).toBeVisible();
    await others.getByRole("button", { name: "File assets/icon.png" }).click();
    await expect(
      others.getByRole("group", { name: "Guide evidence assets/icon.png" }),
    ).toContainText(
      "Binary files a/assets/icon.png and b/assets/icon.png differ",
    );
    await others.getByRole("button", { name: "File scripts/check.sh" }).click();
    await expect(
      others.getByRole("group", { name: "Guide evidence scripts/check.sh" }),
    ).toContainText("new mode 100755");

    await page
      .getByRole("button", { name: "Generate Guide with fake provider" })
      .click();
    await expect(
      second.getByRole("button", { name: "File src/recovery.ts" }),
    ).toHaveAttribute("aria-expanded", "true");
    await page
      .getByRole("button", { name: "Complete fake generation" })
      .click();
    await expect(
      second.getByRole("button", { name: "File src/recovery.ts" }),
    ).toHaveAttribute("aria-expanded", "false");
  } finally {
    await closeServer(server);
  }
});

for (const width of [1440, 560]) {
  test(`Guide explains beside its files at ${width}px without page overflow`, async ({
    page,
  }) => {
    const server = await serveRenderer();
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${serverOrigin(server)}/#guide-fixture`);
      const explanation = page.getByRole("region", {
        name: "Recover pending requests",
        exact: true,
      });
      const files = page.getByRole("list", {
        name: "Recover pending requests files",
      });
      await files.getByRole("button", { name: "File src/recovery.ts" }).click();
      await expect(
        files.getByText("restorePending()", { exact: true }),
      ).toBeVisible();
      const evidence = files.getByRole("group", {
        name: "Guide evidence src/recovery.ts",
      });
      await expect(evidence).toContainText("old mode 100644");
      await expect(evidence).toContainText("new mode 100755");
      const left = await explanation.boundingBox();
      const right = await files.boundingBox();
      if (left === null || right === null)
        throw new Error("Guide layout has no bounds");
      if (width > 768) {
        expect(right.x).toBeGreaterThan(left.x + left.width);
        expect(Math.abs(right.y - left.y)).toBeLessThan(2);
      } else {
        expect(right.y).toBeGreaterThan(left.y + left.height);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    } finally {
      await closeServer(server);
    }
  });
}
