import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { expect, test } from "playwright/test";

// The pull-request metadata rail (#9/#10/#11): a sticky right-hand rail on
// the Conversation tab holding a Labels section, absent on Diff and
// Insights by construction (`ReviewWorkbench` only ever builds and passes
// the rail element into `<Conversation>`).

test.describe("pull request metadata rail", () => {
  let server: Server;
  test.beforeEach(async () => {
    server = await serveRenderer();
  });
  test.afterEach(async () => {
    await close(server);
  });

  test("the Labels picker opens from the rail and toggles a label", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-fixture`);
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    await rail.getByRole("button", { name: "Manage labels" }).click();
    const docsCheckbox = page.getByRole("checkbox", {
      name: "documentation",
    });
    await expect(docsCheckbox).toBeVisible();
    expect(await docsCheckbox.getAttribute("aria-checked")).toBe("false");
    await docsCheckbox.click();
    await expect(docsCheckbox).toHaveAttribute("aria-checked", "true");
  });

  test("stacks below the timeline at a narrow viewport and sits beside it at a wide one", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 960, height: 900 });
    await page.goto(`${origin(server)}/#workbench-fixture`);
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const column = page.locator("[data-conversation-reading-column]");
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    await expect(rail).toBeVisible();
    const [narrowColumn, narrowRail] = await Promise.all([
      column.boundingBox(),
      rail.boundingBox(),
    ]);
    if (narrowColumn === null || narrowRail === null)
      throw new Error("reading column or rail did not lay out");
    // Stacked: the rail sits fully beneath the reading column.
    expect(narrowRail.y).toBeGreaterThanOrEqual(
      narrowColumn.y + narrowColumn.height - 1,
    );

    await page.setViewportSize({ width: 1440, height: 900 });
    const [wideColumn, wideRail] = await Promise.all([
      column.boundingBox(),
      rail.boundingBox(),
    ]);
    if (wideColumn === null || wideRail === null)
      throw new Error("reading column or rail did not lay out");
    // Beside: the rail sits to the right of the reading column, starting at
    // roughly the same height (both begin the row via `items-start`).
    expect(wideRail.x).toBeGreaterThanOrEqual(wideColumn.x + wideColumn.width);
    expect(Math.abs(wideRail.y - wideColumn.y)).toBeLessThanOrEqual(2);
    // The reading column never gets squeezed below its max width.
    expect(wideColumn.width).toBeLessThanOrEqual(680);
  });

  test("stays in view while the timeline scrolls underneath it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${origin(server)}/#conversation-rail-fixture`);
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    await expect(rail).toBeVisible();

    const scroller = page.locator("[data-review-conversation]");
    const column = page.locator("[data-conversation-reading-column]");
    // Scroll partway first: once `position: sticky` has actually engaged,
    // the rail's own top offset (relative to the viewport) settles at a
    // fixed value -- comparing against the *unscrolled* position would also
    // catch the one-time layout shift from scrolling past the row's own top
    // padding, which is expected and not what this test is about.
    await scroller.evaluate((element) => {
      element.scrollTop = 300;
    });
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBe(300);
    const partway = await rail.boundingBox();
    const columnAtPartway = await column.boundingBox();
    if (partway === null || columnAtPartway === null)
      throw new Error("rail or reading column did not lay out");

    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(300);
    const scrolledFurther = await rail.boundingBox();
    const columnScrolledFurther = await column.boundingBox();
    if (scrolledFurther === null || columnScrolledFurther === null)
      throw new Error("rail or reading column did not lay out");

    // The timeline underneath it genuinely moved...
    expect(
      Math.abs(columnScrolledFurther.y - columnAtPartway.y),
    ).toBeGreaterThan(10);
    // ...while the rail, already stuck, did not.
    expect(Math.abs(scrolledFurther.y - partway.y)).toBeLessThanOrEqual(2);
  });

  test("renders a cached avatar as an <img>, falls back to initials without one, and never points a rail element at a remote src", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-fixture`);
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });

    // `fixture-assignee` (the rail's own assignee row) has a resolved
    // avatar and renders an `<img>`, not an initials badge.
    const assigneeRow = rail.getByRole("list", {
      name: "Pull request assignees",
    });
    const assigneeItem = assigneeRow.locator("li", {
      hasText: "fixture-assignee",
    });
    await expect(assigneeItem.locator('img[data-slot="avatar"]')).toHaveCount(
      1,
    );
    await expect(assigneeItem.locator('span[data-slot="avatar"]')).toHaveCount(
      0,
    );

    // `fixture-approved-reviewer` has a resolved avatar too; the
    // requested-but-unanswered `fixture-reviewer` row does not, and falls
    // back to its initials badge.
    const reviewerList = rail.getByRole("list", {
      name: "Pull request reviewers",
    });
    const approvedRow = reviewerList.locator("li", {
      hasText: "fixture-approved-reviewer",
    });
    await expect(approvedRow.locator('img[data-slot="avatar"]')).toHaveCount(1);
    const requestedRow = reviewerList.locator("li", {
      hasText: "fixture-reviewer",
      hasNotText: "fixture-approved-reviewer",
    });
    await expect(
      requestedRow.locator('span[data-slot="avatar"]'),
    ).toBeVisible();
    await expect(requestedRow.locator('img[data-slot="avatar"]')).toHaveCount(
      0,
    );

    // Every avatar image in the rail is a `data:` URI; none ever carries a
    // remote (http/https) `src` -- the renderer's CSP would refuse to load
    // one anyway, but this proves the rail never even tries.
    const avatarImages = rail.locator('img[data-slot="avatar"]');
    const avatarCount = await avatarImages.count();
    expect(avatarCount).toBeGreaterThan(0);
    for (let index = 0; index < avatarCount; index += 1) {
      const src = await avatarImages.nth(index).getAttribute("src");
      expect(src).toMatch(/^data:/);
    }
  });

  test("the Reviewers picker groups suggested reviewers above candidates, states no reviewer number, filters by search, and requests someone", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-fixture`);
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    await rail.getByRole("button", { name: "Manage reviewers" }).click();
    // No cap is stated anywhere, unlike the assignee picker's ten-person cap.
    await expect(page.getByText(/up to \d+ reviewer/i)).toHaveCount(0);
    const suggestedGroup = page.getByRole("group", {
      name: "Suggested reviewers",
    });
    await expect(suggestedGroup).toBeVisible();
    await expect(
      suggestedGroup.getByText("fixture-suggested-reviewer"),
    ).toBeVisible();
    await expect(
      suggestedGroup.getByText("Authored this change"),
    ).toBeVisible();
    const requestedCheckbox = page.getByRole("checkbox", {
      name: "fixture-reviewer",
    });
    const otherCheckbox = page.getByRole("checkbox", {
      name: "fixture-other-reviewer",
    });
    expect(await requestedCheckbox.getAttribute("aria-checked")).toBe("true");
    expect(await otherCheckbox.getAttribute("aria-checked")).toBe("false");

    await page
      .getByRole("searchbox", { name: "Search reviewer candidates" })
      .fill("other");
    await expect(requestedCheckbox).toHaveCount(0);
    await expect(otherCheckbox).toBeVisible();

    await otherCheckbox.click();
    await expect(otherCheckbox).toHaveAttribute("aria-checked", "true");
  });

  test("states plainly when nobody is assigned, and offers a self-assign shortcut", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-empty-assignees-fixture`);
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    await expect(rail.getByText("Nobody is assigned.")).toBeVisible();
    const assignSelf = rail.getByRole("button", { name: "Assign yourself" });
    await expect(assignSelf).toBeVisible();
    await assignSelf.click();
    await expect(rail.getByText("Nobody is assigned.")).toHaveCount(0);
    await expect(rail.getByText("fixture-viewer")).toBeVisible();
  });

  test("the Assignees picker opens, states the ten-assignee limit, filters by search, and toggles someone on", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-fixture`);
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    await rail.getByRole("button", { name: "Manage assignees" }).click();
    await expect(
      page.getByText("GitHub allows up to 10 assignees on a pull request."),
    ).toBeVisible();
    const assigneeCheckbox = page.getByRole("checkbox", {
      name: "fixture-assignee",
    });
    const collaboratorCheckbox = page.getByRole("checkbox", {
      name: "fixture-collaborator",
    });
    await expect(assigneeCheckbox).toBeVisible();
    expect(await assigneeCheckbox.getAttribute("aria-checked")).toBe("true");
    expect(await collaboratorCheckbox.getAttribute("aria-checked")).toBe(
      "false",
    );

    await page
      .getByRole("searchbox", { name: "Search assignable people" })
      .fill("collab");
    await expect(assigneeCheckbox).toHaveCount(0);
    await expect(collaboratorCheckbox).toBeVisible();

    await collaboratorCheckbox.click();
    await expect(collaboratorCheckbox).toHaveAttribute("aria-checked", "true");
  });
});

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
function origin(server: Server): string {
  const address = server.address();
  if (address === null || !("port" in Object(address)))
    throw new Error("missing address");
  // SAFETY: `Server#address()` returns `string | AddressInfo | null`; the
  // check above rules out `null` and rules out the `string` (pipe/socket
  // path) branch, since a JS string wrapper never carries a `port` property.
  // Only the `AddressInfo` branch remains.
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
