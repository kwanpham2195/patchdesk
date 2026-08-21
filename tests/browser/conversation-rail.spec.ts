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

  test("renders with a Labels section on the Conversation tab", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-fixture`);
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    await expect(rail).toBeVisible();
    await expect(
      rail.getByRole("heading", { name: "Labels", level: 2 }),
    ).toBeVisible();
    await expect(rail.getByText("bug")).toBeVisible();
    await expect(rail.getByText("needs-review")).toBeVisible();
    await expect(
      rail.getByRole("button", { name: "Manage labels" }),
    ).toBeVisible();
  });

  test("is absent on the Diff and Insights tabs, present only on Conversation", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-fixture`);
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    // The workbench defaults to the Diff tab.
    await expect(rail).toHaveCount(0);
    await page.getByRole("button", { name: "Insights", exact: true }).click();
    await expect(rail).toHaveCount(0);
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    await expect(rail).toBeVisible();
    await page.getByRole("button", { name: "Diff", exact: true }).click();
    await expect(rail).toHaveCount(0);
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

  test("states plainly when the pull request has no labels", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-empty-labels-fixture`);
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    await expect(rail.getByText("No labels.")).toBeVisible();
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

  test("under Terminal state every section is read-only: chips render, no settings control", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-merged-fixture`);
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    await expect(rail).toBeVisible();
    await expect(rail.getByText("bug")).toBeVisible();
    await expect(rail.getByText("needs-review")).toBeVisible();
    await expect(
      rail.getByRole("button", { name: "Manage labels" }),
    ).toHaveCount(0);
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
  // Only the `AddressInfo` branch remains. Same reasoning as
  // `tests/browser/accessibility.spec.ts`.
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
