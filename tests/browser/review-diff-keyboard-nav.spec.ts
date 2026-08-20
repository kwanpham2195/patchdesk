import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { expect, test, type Locator, type Page } from "playwright/test";

// This suite proves the focus discipline behind `,`/`.` file navigation --
// the actual point of this slice, per review-diff-keyboard-nav.ts. Unit
// tests already cover `shouldIgnoreReviewNavKey` and `adjacentFilePath` in
// isolation (tests/renderer/review-diff-keyboard-nav.test.ts); what only a
// real browser can prove is that the global listener, wired into the real
// diff surface, actually defers to a real text field and a real dialog.

test("`.` and `,` jump between files, stopping (not wrapping) at either end", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#workbench-fixture`);
    const diffViewport = page.locator(".review-diff-viewport");
    await expect(diffViewport).toBeVisible();
    await diffViewport.focus();
    await expect(diffViewport).toBeFocused();

    const boundary = page.locator("[data-review-diff-file-nav-boundary]");
    const overlapsViewport = (path: string) =>
      headerOverlapsViewport(page, diffViewport, path);

    // The workbench fixture's #workbench-fixture patch has exactly two
    // files (src/a.ts, src/b.ts); scrollTop starts at 0, so src/a.ts is the
    // nearest file to the initial scroll position -- the first press should
    // move forward from there, not from some other notion of "first file".
    await expect.poll(() => overlapsViewport("src/a.ts")).toBe(true);

    await page.keyboard.press(".");
    await expect.poll(() => overlapsViewport("src/b.ts")).toBe(true);
    await expect(boundary).toHaveCount(0);

    // Already at the last file: stop, don't wrap to the first file.
    await page.keyboard.press(".");
    await expect(boundary).toHaveText("Already at the last file.");
    await expect.poll(() => overlapsViewport("src/b.ts")).toBe(true);

    await page.keyboard.press(",");
    await expect.poll(() => overlapsViewport("src/a.ts")).toBe(true);
    await expect(boundary).toHaveCount(0);

    // Already at the first file: stop, don't wrap to the last file.
    await page.keyboard.press(",");
    await expect(boundary).toHaveText("Already at the first file.");
    await expect.poll(() => overlapsViewport("src/a.ts")).toBe(true);
  } finally {
    await close(server);
  }
});

test("typing `.` in the comment composer inserts the character instead of navigating", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#workbench-fixture`);
    const diffViewport = page.locator(".review-diff-viewport");
    await expect(diffViewport).toBeVisible();
    // Pierre's CodeView finishes wiring its own hover tracking a moment
    // after mount; hovering a line before that is ready leaves the gutter
    // button's box at zero size with nothing to recompute it.
    await page.waitForTimeout(500);

    // Open the real inline composer via the gutter's "Add comment" control,
    // the same one a maintainer uses: hover a rendered diff line (Pierre's
    // CodeView positions the gutter button from its own hover tracking, so
    // it reports a zero-size box until a line under it has been hovered for
    // real), then force the click -- Patchdesk's own sticky per-file header
    // sits at the same coordinates in this custom element's hit-test order
    // even once the button has a real, visible box.
    const line = page.locator('div[data-line-type="change-deletion"]').nth(5);
    const addComment = page
      .locator('button[aria-label^="Add comment on"]')
      .first();
    await line.hover();
    await addComment.click({ force: true });

    const composer = page.getByRole("textbox", { name: "Inline comment" });
    await expect(composer).toBeVisible();
    await expect(composer).toBeFocused();

    const scrollTop = () => diffViewport.evaluate((viewport) => viewport.scrollTop);
    const before = await scrollTop();

    await page.keyboard.press(".");

    // Inserted into the composer, not consumed as a navigation key.
    await expect(composer).toHaveValue(".");
    // No navigation attempted at all -- not even a "stop at the boundary"
    // announcement (this fixture's first file is the current one, so a real
    // "next file" jump was available and would have moved the viewport).
    expect(await scrollTop()).toBe(before);
    await expect(
      page.locator("[data-review-diff-file-nav-boundary]"),
    ).toHaveCount(0);
  } finally {
    await close(server);
  }
});

test("Cmd+, still opens Settings", async ({ page }) => {
  const server = await serveRenderer();
  try {
    await page.goto(origin(server));
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toHaveCount(0);
    await page.keyboard.press("Meta+,");
    await expect(settings).toBeVisible();
  } finally {
    await close(server);
  }
});

async function headerOverlapsViewport(
  page: Page,
  diffViewport: Locator,
  path: string,
): Promise<boolean> {
  const header = page.locator(`[data-review-diff-file-header="${path}"]`);
  const [headerBox, viewportBox] = await Promise.all([
    header.boundingBox(),
    diffViewport.boundingBox(),
  ]);
  if (headerBox === null || viewportBox === null) return false;
  // scrollTop alone does not prove the right file surfaced (see the
  // equivalent comment in review-workbench.spec.ts's selection-scroll test):
  // only a vertical overlap between the header's box and the viewport's
  // visible box proves the header itself reached the viewport.
  return (
    headerBox.y + headerBox.height > viewportBox.y &&
    headerBox.y < viewportBox.y + viewportBox.height
  );
}

async function serveRenderer(): Promise<Server> {
  const rendererRoot = join(process.cwd(), "out/renderer");
  const server = createServer(async (request, response) => {
    const path =
      request.url === undefined || request.url === "/"
        ? "index.html"
        : request.url;
    const file = normalize(join(rendererRoot, path));
    if (!file.startsWith(rendererRoot)) {
      response.writeHead(400).end();
      return;
    }
    try {
      response
        .writeHead(200, {
          "Content-Type":
            extname(file) === ".js"
              ? "text/javascript"
              : extname(file) === ".css"
                ? "text/css"
                : "text/html",
        })
        .end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}
function isAddressInfo(address: string | AddressInfo): address is AddressInfo {
  return Object.prototype.hasOwnProperty.call(address, "port");
}
function origin(server: Server): string {
  const address = server.address();
  if (address === null || !isAddressInfo(address))
    throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
