import { expect, test } from "playwright/test";
import { closeServer, serveRenderer, serverOrigin } from "./renderer-server";

test("PR overview merge command contains long context and keeps controls actionable", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    for (const width of [1_440, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${serverOrigin(server)}/#acknowledgement-merge-fixture`);
      // Reusing the exact fixture URL does not itself reset React state after
      // the first merge, so reload before measuring the next viewport.
      await page.reload();
      await page
        .getByRole("button", { name: "Open PR overview: checks" })
        .click();

      const overview = page.getByRole("dialog", { name: "PR overview" });
      const section = overview.getByRole("region", { name: "Merge command" });
      const mergeAction = section.getByRole("group", { name: "Merge action" });
      const controls = mergeAction.locator("..");
      await expect(section).toBeVisible();
      await expect(
        section.getByText(
          /centraldigital-platform-engineering-maintainers\/patchdesk-desktop-review-workbench/,
        ),
      ).toBeVisible();

      const [sectionBox, controlsBox, actionBox] = await Promise.all([
        section.boundingBox(),
        controls.boundingBox(),
        mergeAction.boundingBox(),
      ]);
      if (sectionBox === null || controlsBox === null || actionBox === null) {
        throw new Error("Expected merge command layout boxes");
      }
      const sectionMetrics = await section.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        layoutDirection:
          element.firstElementChild === null
            ? "missing"
            : getComputedStyle(element.firstElementChild).flexDirection,
      }));
      const isContained = (box: typeof controlsBox): boolean =>
        box.x >= sectionBox.x - 1 &&
        box.x + box.width <= sectionBox.x + sectionBox.width + 1;
      expect(sectionMetrics.scrollWidth).toBeLessThanOrEqual(
        sectionMetrics.clientWidth,
      );
      expect(isContained(controlsBox)).toBe(true);
      expect(isContained(actionBox)).toBe(true);
      expect(sectionMetrics.layoutDirection).toBe("column");

      const method = mergeAction.getByRole("combobox");
      const merge = section.getByRole("button", { name: "Merge" });
      await expect(method).toBeVisible();
      await expect(method).toBeEnabled();
      await expect(merge).toBeVisible();
      await expect(merge).toBeDisabled();

      await section.getByRole("checkbox", { name: /I acknowledge:/ }).click();
      await expect(merge).toBeEnabled();
      await method.click();
      await page.getByRole("option", { name: "merge", exact: true }).click();
      await expect(method).toHaveText(/merge/);
      await merge.click();
      await expect(
        overview.getByRole("status", { name: "Merged" }),
      ).toBeVisible();
    }
  } finally {
    await closeServer(server);
  }
});
