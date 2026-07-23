import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";

let renderer: Server;
test.beforeAll(async () => {
  renderer = await serve();
});
test.afterAll(async () => {
  await close(renderer);
});
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "patchdesk", {
      value: {
        async request(input: {
          readonly path?: string;
          readonly operation?: string;
        }) {
          if (input.operation !== undefined)
            return { ok: true, status: 200, body: {}, correlationId: "a11y" };
          if (input.path === "/v1/profiles")
            return { ok: true, status: 200, body: [], correlationId: "a11y" };
          return { ok: true, status: 200, body: {}, correlationId: "a11y" };
        },
        onNavigate() {
          return () => undefined;
        },
      },
    });
  });
});

async function seriousProductViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    // Pierre deliberately supports the complete Shiki catalog. Individual
    // syntax tokens live inside its shadow root and cannot all satisfy one
    // contrast rule without masking the selected theme. Patchdesk's review
    // controls and non-color status language are tested as the product seam.
    .exclude("diffs-container")
    .analyze();
  return results.violations.filter(
    (violation) =>
      violation.impact === "critical" || violation.impact === "serious",
  );
}

for (const fixture of [
  "",
  "#workbench-fixture",
  "#submission-fixture",
  "#merge-fixture",
]) {
  test(`axe has no serious Patchdesk violations for ${fixture || "dashboard"}`, async ({
    page,
  }) => {
    await page.goto(`${origin(renderer)}/${fixture}`);
    expect(await seriousProductViolations(page)).toEqual([]);
  });
}

test("keyboard users can skip, navigate, and close quick navigation", async ({
  page,
}) => {
  await page.goto(origin(renderer));
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await page.keyboard.press("Meta+K");
  await expect(
    page.getByRole("dialog", { name: "Navigate Patchdesk" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Navigate Patchdesk" }),
  ).toBeHidden();
});

test("quick navigation scrolls results through the final action", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 480 });
  await page.goto(origin(renderer));
  await page.getByRole("button", { name: /Navigate/ }).click();

  const dialog = page.getByRole("dialog", { name: "Navigate Patchdesk" });
  const list = dialog.locator('[data-slot="command-list"]');
  const selectedOption = dialog.locator(
    '[data-slot="command-item"][data-selected="true"]',
  );
  const unselectedOption = dialog.locator(
    '[data-slot="command-item"][data-selected="false"]',
  ).first();
  const lastAction = dialog.getByRole("option", {
    name: "Open selected pull request",
  });

  await expect(list).toBeVisible();
  await expect(selectedOption).toHaveCount(1);
  expect(
    await selectedOption.evaluate((element) => getComputedStyle(element).backgroundColor),
  ).not.toEqual(
    await unselectedOption.evaluate((element) => getComputedStyle(element).backgroundColor),
  );
  expect(
    await list.evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBe(true);

  await lastAction.scrollIntoViewIfNeeded();
  await expect(lastAction).toBeVisible();

  const [listBox, actionBox] = await Promise.all([
    list.boundingBox(),
    lastAction.boundingBox(),
  ]);
  expect(listBox).not.toBeNull();
  expect(actionBox).not.toBeNull();
  if (listBox === null || actionBox === null) {
    throw new Error("quick navigation did not render its list and final action");
  }
  expect(actionBox.y).toBeGreaterThanOrEqual(listBox.y);
  expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(listBox.y + listBox.height);
});

test("forced colors and reduced motion preserve the workbench interaction surface", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.goto(`${origin(renderer)}/#workbench-fixture`);
  const editDraft = page.getByRole("button", { name: "Edit review draft" });
  await editDraft.focus();
  await expect(editDraft).toBeFocused();
  const outline = await editDraft.evaluate(
    (element) => getComputedStyle(element).outlineStyle,
  );
  expect(outline).not.toBe("none");
  expect(await seriousProductViolations(page)).toEqual([]);
});

test("400 percent zoom equivalent keeps constrained review controls reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(`${origin(renderer)}/#workbench-fixture`);
  await expect(
    page.getByRole("button", { name: "Files and findings" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit review draft" }),
  ).toBeVisible();
  const horizontalOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
});

async function serve(): Promise<Server> {
  const root = join(process.cwd(), "out/renderer");
  const server = createServer(async (request, response) => {
    const file = normalize(
      join(
        root,
        request.url === undefined || request.url === "/"
          ? "index.html"
          : request.url,
      ),
    );
    if (!file.startsWith(root)) {
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
  if (address === null || typeof address === "string")
    throw new Error("address");
  return `http://127.0.0.1:${address.port}`;
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
