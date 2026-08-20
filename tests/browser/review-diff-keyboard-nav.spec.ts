import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { expect, test, type Locator, type Page } from "playwright/test";

// This suite proves the focus discipline behind `,`/`.` file navigation and
// `[`/`]` hunk navigation -- the actual point of these slices, per
// review-diff-keyboard-nav.ts. Unit tests already cover
// `shouldIgnoreReviewNavKey`, `adjacentFilePath`, and `adjacentHunkAnchor`
// in isolation (tests/renderer/review-diff-keyboard-nav.test.ts); what only
// a real browser can prove is that the global listeners, wired into the
// real diff surface, actually defer to a real text field and a real
// dialog, and that a jump's real scroll geometry doesn't retrigger the
// stale-recompute trap documented in review-diff-view.tsx.

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

test("the fixed panel header follows `.` keyboard file navigation, not just the last click", async ({
  page,
}) => {
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    // #active-follow-fixture's three files each carry 48 changed lines (far
    // taller than #workbench-fixture's, which combined nearly fit in one
    // 900px viewport). A `.` jump there lands ambiguously close to the
    // documented "recompute-the-previous-file" trap in review-diff-view.tsx
    // (an unrelated, pre-existing quirk out of scope for this fix), so this
    // regression needs a fixture with real scroll distance between files to
    // prove the header genuinely settles on the jumped-to file.
    await page.goto(`${origin(server)}/#active-follow-fixture`);
    const diffViewport = page.locator(".review-diff-viewport");
    await expect(diffViewport).toBeVisible();
    await diffViewport.focus();
    await expect(diffViewport).toBeFocused();

    // This fixture's DiffWorkbench mount never sets `diffTitle`, so the
    // fixed header falls through to activePath/selectedPath -- the exact
    // path this regression covers. `selectFile` (the click path) is never
    // invoked here, only the `.` keyboard jump, so a header still reading
    // `selectedPath` would stay frozen on src/a.ts instead of following the
    // jump to src/b.ts.
    const header = page.locator("[data-diff-workbench-header-path]");
    await expect(header).toHaveText("src/a.ts");

    await page.keyboard.press(".");
    await expect
      .poll(() => headerOverlapsViewport(page, diffViewport, "src/b.ts"))
      .toBe(true);
    await expect(header).toHaveText("src/b.ts");
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

test("`]` and `[` jump between hunks, stopping (not wrapping) at either end, including across a file boundary", async ({
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

    const boundary = page.locator("[data-review-diff-hunk-nav-boundary]");
    const overlapsViewport = (path: string) =>
      headerOverlapsViewport(page, diffViewport, path);

    // The fixture's two files each carry exactly one hunk, so `]`/`[`
    // behaves like file navigation here in terms of which file surfaces --
    // but it proves the hunk-anchor machinery (a `type: "line"` scroll
    // target, not `type: "item"`) and, since src/b.ts's only hunk starts at
    // line 1 of a newly-entered file, this is exactly the landing geometry
    // documented as the trap in review-diff-view.tsx: the `align: "start"`
    // line jump can land short of that file's own top, so a second press
    // reading back scroll-derived state instead of the dedicated
    // `hunkNavCurrentAnchor` ref would silently re-jump to src/b.ts's hunk
    // instead of reporting the boundary.
    await expect.poll(() => overlapsViewport("src/a.ts")).toBe(true);

    await page.keyboard.press("]");
    await expect.poll(() => overlapsViewport("src/b.ts")).toBe(true);
    await expect(boundary).toHaveCount(0);

    // Already at the last hunk: stop, don't wrap and don't silently re-jump
    // to the same (or any other) hunk.
    await page.keyboard.press("]");
    await expect(boundary).toHaveText("Already at the last hunk.");
    await expect.poll(() => overlapsViewport("src/b.ts")).toBe(true);

    await page.keyboard.press("[");
    await expect.poll(() => overlapsViewport("src/a.ts")).toBe(true);
    await expect(boundary).toHaveCount(0);

    // Already at the first hunk: stop, don't wrap.
    await page.keyboard.press("[");
    await expect(boundary).toHaveText("Already at the first hunk.");
    await expect.poll(() => overlapsViewport("src/a.ts")).toBe(true);

    // Repeated presses in the same direction must keep advancing, not
    // re-jump to whatever the previous press already landed on. Walk
    // forward across the same boundary twice in a row from a fresh first
    // press to prove that.
    await page.keyboard.press("]");
    await expect.poll(() => overlapsViewport("src/b.ts")).toBe(true);
    await page.keyboard.press("]");
    await expect(boundary).toHaveText("Already at the last hunk.");
  } finally {
    await close(server);
  }
});

test("typing `[` in the comment composer inserts the character instead of navigating", async ({
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

    await page.keyboard.press("[");

    // Inserted into the composer, not consumed as a navigation key.
    await expect(composer).toHaveValue("[");
    // No navigation attempted at all -- not even a "stop at the boundary"
    // announcement (this fixture's first file is the current one, so a real
    // "previous hunk" jump target -- src/b.ts, whose only hunk is the
    // adjacent target once seeded -- was not yet resolved, but the guard
    // must reject the keystroke before any of that runs).
    expect(await scrollTop()).toBe(before);
    await expect(
      page.locator("[data-review-diff-hunk-nav-boundary]"),
    ).toHaveCount(0);
  } finally {
    await close(server);
  }
});

test("`}` announces there are no unresolved comments, without moving the viewport, on a diff with none", async ({
  page,
}) => {
  // #workbench-fixture's `CanonicalFixtureWorkbench` mount never sets
  // `conversation.inline` (only `prDescription`/`entries`; see
  // `canonicalWorkbenchModel` in app-fixtures.tsx), so this diff genuinely
  // has zero live comment threads -- the real "nothing to jump to" case, not
  // a contrived one. Wiring a live thread into a fixture route for the
  // skip-resolved/repeated-advance/focus-lands assertions would require
  // editing that same large, shared fixture file, which carries unrelated
  // pre-existing oxlint findings across its ~9 other call sites that
  // `pnpm precommit`'s lint-staged gate checks whole-file; clearing them is
  // out of this slice's size ceiling, so `adjacentCommentAnchor`,
  // `commentNavAnnouncement`, `buildCommentOrder` (skip-resolved, document
  // order, same-line distinctness), and `findCommentThreadCard`/
  // `focusCommentThreadCard` (including the found-but-not-yet-focusable
  // retry) carry that proof instead, in
  // tests/renderer/review-diff-keyboard-nav.test.ts.
  const server = await serveRenderer();
  try {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await page.goto(`${origin(server)}/#workbench-fixture`);
    const diffViewport = page.locator(".review-diff-viewport");
    await expect(diffViewport).toBeVisible();
    await diffViewport.focus();
    await expect(diffViewport).toBeFocused();

    const scrollTop = () =>
      diffViewport.evaluate((viewport) => viewport.scrollTop);
    const before = await scrollTop();
    const status = page.locator("[data-review-diff-comment-nav-status]");

    await page.keyboard.press("}");
    await expect(status).toHaveText("No unresolved comments.");
    expect(await scrollTop()).toBe(before);

    // `{` reports the same thing, not a mirrored "first"/"last" boundary --
    // there is nothing to be at either end of.
    await page.keyboard.press("{");
    await expect(status).toHaveText("No unresolved comments.");
    expect(await scrollTop()).toBe(before);
  } finally {
    await close(server);
  }
});

test("typing `{` in the comment composer inserts the character instead of navigating", async ({
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

    await page.keyboard.press("{");

    // Inserted into the composer, not consumed as a navigation key.
    await expect(composer).toHaveValue("{");
    // No navigation attempted at all -- not even a status announcement.
    expect(await scrollTop()).toBe(before);
    await expect(
      page.locator("[data-review-diff-comment-nav-status]"),
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
