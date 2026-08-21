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
    // The Assignees section is read-only the same way: the assignee still
    // renders, but neither the picker trigger nor the self-assign shortcut
    // is offered.
    await expect(rail.getByText("fixture-assignee")).toBeVisible();
    await expect(
      rail.getByRole("button", { name: "Manage assignees" }),
    ).toHaveCount(0);
    await expect(
      rail.getByRole("button", { name: "Assign yourself" }),
    ).toHaveCount(0);
  });

  test("renders an Assignees section above Labels, listing assignees with initials badges", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-fixture`);
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    const headings = rail.getByRole("heading", { level: 2 });
    await expect(headings.nth(0)).toHaveText("Assignees");
    await expect(headings.nth(1)).toHaveText("Labels");
    const assigneeRow = rail.getByText("fixture-assignee");
    await expect(assigneeRow).toBeVisible();
    await expect(
      rail.getByRole("button", { name: "Manage assignees" }),
    ).toBeVisible();
    // An initials badge (`Avatar` with no `dataUri`) renders next to the row.
    await expect(
      rail.locator('[data-slot="avatar"]', { hasText: "F" }),
    ).toBeVisible();
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

  test("the self-assign shortcut is absent when the assign permission is denied", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-assignees-denied-fixture`);
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    await expect(rail.getByText("Nobody is assigned.")).toBeVisible();
    await expect(
      rail.getByRole("button", { name: "Assign yourself" }),
    ).toHaveCount(0);
  });

  test("the self-assign shortcut is caveated when the assign permission is unknown", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-assignees-unknown-fixture`);
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    await expect(
      rail.getByRole("button", { name: "Assign yourself" }),
    ).toBeVisible();
    await expect(
      rail.getByText(
        "Patchdesk could not confirm you can manage assignees here — a change may be refused.",
      ),
    ).toBeVisible();
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

  test("a failed assignee write reverts and names the person", async ({
    page,
  }) => {
    await page.goto(
      `${origin(server)}/#workbench-assignees-write-failure-fixture`,
    );
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    await rail.getByRole("button", { name: "Manage assignees" }).click();
    const collaboratorCheckbox = page.getByRole("checkbox", {
      name: "fixture-collaborator",
    });
    await collaboratorCheckbox.click();
    await expect(collaboratorCheckbox).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(
      page.getByText('Patchdesk could not assign "fixture-collaborator".', {
        exact: false,
      }),
    ).toBeVisible();
  });

  test("surfaces the ten-assignee limit when GitHub rejects a write for it", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-assignees-cap-fixture`);
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    await rail.getByRole("button", { name: "Manage assignees" }).click();
    await page
      .getByRole("checkbox", { name: "fixture-collaborator" })
      .click();
    await expect(
      page.getByText("GitHub limits a pull request to ten assignees.", {
        exact: false,
      }),
    ).toBeVisible();
  });

  test("reads a failed assignable-people fetch as a failure, not an empty list", async ({
    page,
  }) => {
    await page.goto(
      `${origin(server)}/#workbench-assignees-read-failure-fixture`,
    );
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    await rail.getByRole("button", { name: "Manage assignees" }).click();
    await expect(
      page.getByText(
        "Patchdesk could not load this repository's assignable people. Reopen this menu to retry.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("checkbox")).toHaveCount(0);
  });

  test("renders a label's description in the picker, and nothing extra for a label without one", async ({
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
    await expect(page.getByText("Something isn't working")).toBeVisible();
    // Exactly one label in the fixture catalog carries a description.
    await expect(page.locator('[data-slot="label-description"]')).toHaveCount(
      1,
    );
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
