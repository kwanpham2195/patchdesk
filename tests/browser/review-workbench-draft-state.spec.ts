import { expect, test } from "playwright/test";
import { closeServer, serveRenderer, serverOrigin } from "./renderer-server";

test("PR overview offers the author's draft toggle in both draft states", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.goto(`${serverOrigin(server)}/#workbench-draft-fixture`);
    await page
      .getByRole("button", { name: "Open PR overview: checks" })
      .click();

    const overview = page.getByRole("dialog", { name: "PR overview" });
    const publish = overview.getByRole("button", { name: "Ready for review" });
    await expect(publish).toBeVisible();

    await publish.click();
    const convert = overview.getByRole("button", { name: "Convert to draft" });
    await expect(convert).toBeVisible();
    await expect(publish).toBeHidden();

    await convert.click();
    await expect(publish).toBeVisible();
  } finally {
    await closeServer(server);
  }
});
