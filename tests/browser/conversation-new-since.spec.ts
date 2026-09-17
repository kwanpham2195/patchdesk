import type { Server } from "node:http";
import { expect, test } from "playwright/test";
import { closeServer, serveRenderer, serverOrigin } from "./renderer-server";

// Jump to first new (#231) has to scroll a real overflow container, which jsdom cannot lay out.
test.describe("Conversation new since last looked", () => {
  let server: Server;
  test.beforeEach(async () => {
    server = await serveRenderer();
  });
  test.afterEach(async () => {
    await closeServer(server);
  });

  test("Jump to first new scrolls the earliest new comment into view", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${serverOrigin(server)}/#conversation-new-since-fixture`);
    await page.getByRole("tab", { name: "Conversation", exact: true }).click();
    const markers = page.getByLabel("New since you last looked");
    await expect(markers).toHaveCount(5);
    const firstNew = page.getByText("Comment 15:", { exact: false });
    await expect(firstNew).not.toBeInViewport();

    await page.getByRole("button", { name: "Jump to first new" }).click();

    await expect(firstNew).toBeInViewport();
  });
});
