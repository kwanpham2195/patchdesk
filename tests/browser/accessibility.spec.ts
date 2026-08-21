import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
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
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    window.localStorage.setItem("patchdesk.appearance.v1", "light");
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

type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;
type AxeViolation = AxeResults["violations"][number];
type AxeViolationNode = AxeViolation["nodes"][number];

// Pierre's <diffs-container> (selector "diffs-container", or ".visual-diff"
// when axe needs ancestor context for uniqueness -- Pierre applies that
// class straight onto the custom element) renders the complete Shiki
// syntax-token catalog inside its own shadow root, keyed to CSS custom
// properties (`--diffs-token-light`/`--diffs-token-dark`) that Pierre's
// theme engine owns. Some of those token colors cannot satisfy WCAG
// contrast against every selected theme without overriding that engine,
// which is out of scope here -- this is the one finding this filter
// legitimately suppresses. A blanket `.exclude("diffs-container")` used to
// hide the whole custom element from every rule, which also hid Patchdesk's
// own markup that Pierre slots inside it (annotation cards, review
// controls). Axe now scans the entire page, including everything inside
// <diffs-container>; only color-contrast findings are checked further, and
// only the ones whose target actually crosses into a shadow root are
// dropped. axe-core represents a shadow-piercing target as a `[hostSelector,
// selectorInsideShadowRoot]` pair (see axe-core's `UnlabelledFrameSelector`
// type) instead of a plain selector string; Pierre's diff viewer is the only
// shadow-DOM element this app renders, so any color-contrast node using that
// shape is necessarily inside Pierre's shadow root, regardless of which
// selector text axe picked for the host.
function isPierreShadowTokenNode(node: AxeViolationNode): boolean {
  return Array.isArray(node.target[0]);
}

async function seriousProductViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    )
    .flatMap((violation): AxeViolation[] => {
      if (violation.id !== "color-contrast") return [violation];
      const nodes = violation.nodes.filter(
        (node) => !isPierreShadowTokenNode(node),
      );
      return nodes.length === 0 ? [] : [{ ...violation, nodes }];
    });
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
    await forceLightAppearance(page);
    expect(await seriousProductViolations(page)).toEqual([]);
  });
}

async function forceLightAppearance(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const root = document.documentElement;
    root.classList.remove("dark");
    document
      .querySelectorAll(".dark")
      .forEach((element) => element.classList.remove("dark"));
    root.dataset.appearance = "light";
    root.style.colorScheme = "light";
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await Promise.all(
      document
        .getAnimations()
        .map(
          async (animation) => await animation.finished.catch(() => undefined),
        ),
    );
  });
}

test("axe now catches Patchdesk's own violations even when they render inside <diffs-container>", async ({
  page,
}) => {
  await page.goto(`${origin(renderer)}/#workbench-fixture`);
  await forceLightAppearance(page);
  // This icon-only button is Patchdesk's own markup, rendered as a real
  // light-DOM child of Pierre's <diffs-container> (via its "header-custom"
  // slot) -- not shadow-root content. The old blanket
  // `.exclude("diffs-container")` hid all of it, including this element,
  // from every rule. It has to be the icon-only chevron rather than the
  // "Viewed" pill next to it: the pill carries a visible text label, so
  // stripping its aria-label still leaves it named and can't be driven
  // nameless. Confirm the scan is clean before we break anything, so the
  // assertion below is not passing by coincidence.
  const collapseToggle = page.locator(
    'diffs-container button[aria-label="Collapse file src/a.ts"]',
  );
  await expect(collapseToggle).toHaveCount(1);
  expect(await seriousProductViolations(page)).toEqual([]);
  await collapseToggle.evaluate((element) => element.removeAttribute("aria-label"));
  const violations = await seriousProductViolations(page);
  expect(violations.some((violation) => violation.id === "button-name")).toBe(
    true,
  );
});

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
  const unselectedOption = dialog
    .locator('[data-slot="command-item"][data-selected="false"]')
    .first();
  const lastAction = dialog.getByRole("option", {
    name: "Open selected pull request",
  });

  await expect(list).toBeVisible();
  await expect(selectedOption).toHaveCount(1);
  expect(
    await selectedOption.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  ).not.toEqual(
    await unselectedOption.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  );
  expect(
    await list.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
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
    throw new Error(
      "quick navigation did not render its list and final action",
    );
  }
  expect(actionBox.y).toBeGreaterThanOrEqual(listBox.y);
  expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(
    listBox.y + listBox.height,
  );
});

test("Settings modal has a named, trapped, independently scrollable surface", async ({
  page,
}) => {
  await page.goto(origin(renderer));
  const opener = page.getByRole("button", { name: "Settings", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "General" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(dialog.getByRole("tab", { name: "General" })).toBeFocused();
  await expect(await seriousProductViolations(page)).toEqual([]);
  await dialog.getByRole("tab", { name: "Workspace" }).click();
  await expect(dialog.getByRole("tab", { name: "Workspace" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const scrollViewport = page
    .getByTestId("settings-scroll-region")
    .locator('[data-slot="scroll-area-viewport"]');
  await expect(scrollViewport).toBeVisible();
  const pageScrollTop = await page.evaluate(() => window.scrollY);
  const scrollResult = await scrollViewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return { scrollTop: element.scrollTop, canScroll: element.scrollTop > 0 };
  });
  expect(scrollResult.canScroll).toBe(true);
  expect(await page.evaluate(() => window.scrollY)).toBe(pageScrollTop);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("walkthrough takeover exposes rail, Reviewed controls, and quiet reader chrome", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() =>
    localStorage.setItem("patchdesk.appearance.v1", "light"),
  );
  await page.goto(`${origin(renderer)}/#walkthrough-fixture`);
  await page.getByRole("button", { name: "Generate walkthrough" }).click();
  const dialog = page.getByTestId("walkthrough-generate-dialog");
  await dialog.getByRole("combobox", { name: "Model" }).click();
  await page.getByRole("option", { name: "Design model" }).click();
  await dialog.getByTestId("walkthrough-confirm").click();
  await expect(
    page.getByRole("button", { name: "Open walkthrough" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open walkthrough" }).click();
  await expect(
    page.getByRole("region", { name: "Walkthrough chapters" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Keep the review local" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Previous section" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Next section" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Mark section reviewed" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Support" }).click();
  await expect(
    page.getByRole("button", { name: "Mark Support reviewed" }),
  ).toBeVisible();
  const walkthroughDiff = page.locator(
    '[data-walkthrough-diff-block="section-1::h1::0"]',
  );
  await expect(
    walkthroughDiff.getByRole("button", {
      name: "Add local comment on src/a.ts",
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Keep the review local" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next section" }).click();
  await expect(
    page.getByRole("heading", { name: "Follow the changed path" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Next section" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Previous section" }),
  ).toBeEnabled();
  await forceLightAppearance(page);
  await page.waitForTimeout(50);
  await forceLightAppearance(page);
  await expect(await seriousProductViolations(page)).toEqual([]);
  const takeover = page.locator("[data-walkthrough-takeover]");
  await takeover.focus();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "Follow the changed path" }),
  ).toBeFocused();
});

test("forced colors and reduced motion preserve the workbench interaction surface", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });

  await page.goto(`${origin(renderer)}/#workbench-fixture`);
  const overview = page.getByRole("button", { name: "PR overview" });
  await overview.focus();
  await expect(overview).toBeFocused();
  const outline = await overview.evaluate(
    (element) => getComputedStyle(element).outlineStyle,
  );
  expect(outline).not.toBe("none");
  expect(await seriousProductViolations(page)).toEqual([]);
});

test("rendered Mermaid controls stay independently keyboard accessible", async ({
  page,
}) => {
  await page.goto(`${origin(renderer)}/#mermaid-fixture`);
  const diagram = page.getByRole("button", { name: "Mermaid diagram" });
  const source = page.getByText("Mermaid source", { exact: true });
  await expect(diagram).toBeVisible();
  await expect(source).toBeVisible();

  await source.focus();
  await expect(source).toBeFocused();
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      source.evaluate(
        // SAFETY: `source` resolves the "Mermaid source" text, which
        // pull-request-description.tsx only ever renders inside a
        // <summary>; a <summary>'s parent is always its owning <details>.
        (element) => (element.parentElement as HTMLDetailsElement).open,
      ),
    )
    .toBe(true);
  await expect(page.getByRole("dialog", { name: "Image viewer" })).toHaveCount(
    0,
  );
  expect(await seriousProductViolations(page)).toEqual([]);

  await diagram.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Image viewer" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.tagName)).toBe("DIALOG");
  expect(
    await dialog.evaluate(
      // SAFETY: the assertion immediately above confirms this element's
      // tagName is "DIALOG", so it is an HTMLDialogElement.
      (element) => (element as HTMLDialogElement).open,
    ),
  ).toBe(true);
  expect(await seriousProductViolations(page)).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(diagram).toBeFocused();
});

test("400 percent zoom equivalent keeps constrained review controls reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(`${origin(renderer)}/#workbench-fixture`);
  await expect(page.getByRole("button", { name: "Insights" })).toBeVisible();
  await expect(page.getByRole("button", { name: "PR overview" })).toBeVisible();
  const horizontalOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
});

test("the pull request metadata rail is free of serious axe violations", async ({
  page,
}) => {
  await page.goto(`${origin(renderer)}/#workbench-fixture`);
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "Pull request metadata" }),
  ).toBeVisible();
  await forceLightAppearance(page);
  expect(await seriousProductViolations(page)).toEqual([]);
});

test("the rail's Labels picker is fully keyboard-reachable and operable", async ({
  page,
}) => {
  await page.goto(`${origin(renderer)}/#workbench-fixture`);
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  const manageLabels = page.getByRole("button", { name: "Manage labels" });
  await manageLabels.focus();
  await expect(manageLabels).toBeFocused();
  await page.keyboard.press("Enter");
  const docsCheckbox = page.getByRole("checkbox", { name: "documentation" });
  await expect(docsCheckbox).toBeVisible();
  await docsCheckbox.focus();
  await expect(docsCheckbox).toBeFocused();
  expect(await docsCheckbox.getAttribute("aria-checked")).toBe("false");
  await page.keyboard.press("Space");
  await expect(docsCheckbox).toHaveAttribute("aria-checked", "true");
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
      const contents = await readFile(file);
      response
        .writeHead(200, {
          "Content-Type":
            extname(file) === ".js"
              ? "text/javascript"
              : extname(file) === ".css"
                ? "text/css"
                : "text/html",
        })
        .end(contents);
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
    throw new Error("address");
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
