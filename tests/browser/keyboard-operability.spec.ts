import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { expect, test, type Locator, type Page } from "playwright/test";

// Keyboard operability for the audience ADR 0034 keeps: a sighted person
// driving Patchdesk with a keyboard and a mouse. Nothing here narrates to a
// screen reader -- these specs press real keys and assert where focus lands,
// which is product behaviour, not assistive-technology support.
//
// The suite exists because the ADR-0034 cleanup deleted
// `tests/browser/accessibility.spec.ts` whole, and that file held the only
// Playwright proof that the skip link, the Meta+K palette, the Settings
// modal, the Mermaid controls, the header refresh control, and the three
// rail pickers can be reached and driven without a mouse. The replacements
// below keep every keyboard assertion and drop every assertion that leaned
// on something the ADR removed on purpose (the `@axe-core/playwright` scan,
// `aria-live` narration, `sr-only` text, and the `prefers-reduced-motion` /
// `forced-colors` CSS rules).

test.describe("keyboard operability", () => {
  let server: Server;
  test.beforeEach(async () => {
    server = await serveRenderer();
  });
  test.afterEach(async () => {
    await close(server);
  });

  test("keyboard users can skip, navigate, and close quick navigation", async ({
    page,
  }) => {
    await installBridgeStub(page);
    await page.goto(origin(server));

    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("link", { name: "Skip to content" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();

    await page.keyboard.press("Meta+K");
    const palette = page.getByRole("dialog", { name: "Navigate Patchdesk" });
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });

  test("Settings modal has a named, trapped, independently scrollable surface", async ({
    page,
  }) => {
    await installBridgeStub(page);
    await page.goto(origin(server));

    // Open it from the keyboard, not with a click: Enter on the header
    // control is the path a keyboard user actually takes.
    const opener = page.getByRole("button", { name: "Settings", exact: true });
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();

    // Opening moves focus into the dialog, onto the selected tab.
    const general = dialog.getByRole("tab", { name: "General" });
    await expect(general).toHaveAttribute("aria-selected", "true");
    await expect(general).toBeFocused();

    // Trapped: Tab cycles inside the dialog and never escapes to a control
    // on the page behind it. Twelve presses is about twice round the
    // dialog's own ring, so this walks the whole cycle and comes back.
    const escapes: string[] = [];
    let wrappedRound = false;
    for (let press = 0; press < 12; press += 1) {
      await page.keyboard.press("Tab");
      const stop = await settledFocusStop(page, dialog);
      if (stop !== "inside") escapes.push(stop);
      if (await general.evaluate((tab) => tab === document.activeElement))
        wrappedRound = true;
    }
    expect(escapes).toEqual([]);
    // ...and the ring genuinely wraps rather than parking on a dead end.
    expect(wrappedRound).toBe(true);

    // The tablist is a roving-tabindex group with manual activation: an
    // arrow key moves focus between tabs without switching panel, and Enter
    // is what commits the move.
    await general.focus();
    await page.keyboard.press("ArrowRight");
    const workspace = dialog.getByRole("tab", { name: "Workspace" });
    await expect(workspace).toBeFocused();
    await expect(workspace).toHaveAttribute("aria-selected", "false");
    await page.keyboard.press("Enter");
    await expect(workspace).toHaveAttribute("aria-selected", "true");
    await expect(general).toHaveAttribute("aria-selected", "false");

    // The panel scrolls on its own; the page underneath does not move.
    const scrollViewport = page
      .getByTestId("settings-scroll-region")
      .locator('[data-slot="scroll-area-viewport"]');
    await expect(scrollViewport).toBeVisible();
    const pageScrollTop = await page.evaluate(() => window.scrollY);
    const scrolled = await scrollViewport.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop > 0;
    });
    expect(scrolled).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBe(pageScrollTop);

    // Escape dismisses it and hands focus back to the control that opened it.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test("rendered Mermaid controls stay independently keyboard accessible", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#mermaid-fixture`);
    const diagram = page.getByRole("button", { name: "Mermaid diagram" });
    const source = page.getByText("Mermaid source", { exact: true });
    // Wait for Mermaid to finish: until it does, the fallback branch renders
    // a different (already-open) <details>, and the assertions below would
    // be reading the wrong element.
    await expect(diagram).toBeVisible();
    await expect(source).toBeVisible();

    // The <summary> takes Enter on its own without opening the lightbox that
    // its sibling diagram button owns.
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
    await expect(
      page.getByRole("dialog", { name: "Image viewer" }),
    ).toHaveCount(0);

    // The diagram takes Enter, opens a real <dialog>, and Escape puts focus
    // back where it started.
    await diagram.focus();
    await page.keyboard.press("Enter");
    const lightbox = page.getByRole("dialog", { name: "Image viewer" });
    await expect(lightbox).toBeVisible();
    expect(await lightbox.evaluate((element) => element.tagName)).toBe(
      "DIALOG",
    );
    await page.keyboard.press("Escape");
    await expect(lightbox).toBeHidden();
    await expect(diagram).toBeFocused();
  });

  test("the rail's Labels picker is fully keyboard-reachable and operable", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-fixture`);
    await openConversationRail(page);

    const manageLabels = page.getByRole("button", { name: "Manage labels" });
    await expectReachableByTab(page, manageLabels);
    await page.keyboard.press("Enter");

    const docs = page.getByRole("checkbox", { name: "documentation" });
    await expect(docs).toBeVisible();
    await docs.focus();
    await expect(docs).toBeFocused();
    expect(await docs.getAttribute("aria-checked")).toBe("false");
    await page.keyboard.press("Space");
    await expect(docs).toHaveAttribute("aria-checked", "true");
  });

  test("the header refresh control is keyboard-reachable with an accessible name", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-fixture`);
    const refresh = page.getByRole("button", {
      name: "Refresh GitHub state",
      exact: true,
    });
    await expect(refresh).toBeVisible();
    await expect(refresh).toBeEnabled();

    // Reachable by Tab, not merely focusable by script: a `tabIndex={-1}`
    // control still answers `.focus()`, so the round trip below is what
    // proves a keyboard user can actually arrive here.
    await expectReachableByTab(page, refresh);

    // And it activates from the keyboard rather than needing a pointer. The
    // control stays named and enabled afterwards, which is how the header
    // stays usable for the next refresh.
    await page.keyboard.press("Enter");
    await expect(refresh).toBeVisible();
    await expect(refresh).toBeEnabled();
  });

  test("the rail's Assignees picker is fully keyboard-reachable and operable", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-fixture`);
    await openConversationRail(page);

    const manageAssignees = page.getByRole("button", {
      name: "Manage assignees",
    });
    await expectReachableByTab(page, manageAssignees);
    await page.keyboard.press("Enter");

    const collaborator = page.getByRole("checkbox", {
      name: "fixture-collaborator",
    });
    await expect(collaborator).toBeVisible();
    await collaborator.focus();
    await expect(collaborator).toBeFocused();
    expect(await collaborator.getAttribute("aria-checked")).toBe("false");
    await page.keyboard.press("Space");
    await expect(collaborator).toHaveAttribute("aria-checked", "true");
  });

  test("the Assignees empty-state self-assign shortcut is keyboard-reachable and operable", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-empty-assignees-fixture`);
    await openConversationRail(page);

    const assignSelf = page.getByRole("button", { name: "Assign yourself" });
    await expectReachableByTab(page, assignSelf);
    await page.keyboard.press("Enter");
    await expect(page.getByText("fixture-viewer")).toBeVisible();
  });

  test("the rail's Reviewers picker is fully keyboard-reachable and operable", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-fixture`);
    await openConversationRail(page);

    const manageReviewers = page.getByRole("button", {
      name: "Manage reviewers",
    });
    await expectReachableByTab(page, manageReviewers);
    await page.keyboard.press("Enter");

    const other = page.getByRole("checkbox", {
      name: "fixture-other-reviewer",
    });
    await expect(other).toBeVisible();
    await other.focus();
    await expect(other).toBeFocused();
    expect(await other.getAttribute("aria-checked")).toBe("false");
    await page.keyboard.press("Space");
    await expect(other).toHaveAttribute("aria-checked", "true");
  });
});

/**
 * Where Tab put focus, once the trap has finished moving it.
 *
 * Closing the ring takes Base UI two intermediate stops that no keyboard user
 * can operate: a hidden `[data-base-ui-focus-guard]` sentinel, and <body> for
 * the frame between the guard firing and focus arriving back at the top of
 * the dialog. Reading `document.activeElement` on either of those would be
 * reading mid-move, so this waits for the move to land -- and pressing Tab
 * again before it lands is what would really leak focus to the page behind.
 *
 * @returns `"inside"`, or a description of where focus escaped to.
 */
async function settledFocusStop(page: Page, dialog: Locator): Promise<string> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const stop = await dialog.evaluate((element) => {
      const focused = document.activeElement;
      if (focused === null || focused === document.body) return "moving";
      if (focused.closest("[data-base-ui-focus-guard]") !== null)
        return "moving";
      if (element.contains(focused)) return "inside";
      return `escaped to <${focused.tagName.toLowerCase()}> "${focused.textContent?.trim().slice(0, 40) ?? ""}"`;
    });
    if (stop !== "moving") return stop;
    if (Date.now() > deadline) return "focus never settled on any control";
    await page.waitForTimeout(20);
  }
}

/**
 * Prove `target` sits in the document's tab order, then leave it focused.
 *
 * Focusing it and asserting it is focused proves nothing: `HTMLElement#focus`
 * works on a `tabIndex={-1}` element too. Stepping back one stop with
 * Shift+Tab and forward again with Tab does prove it -- a control outside the
 * tab order is skipped on the way back, and focus lands on its neighbour
 * instead.
 */
async function expectReachableByTab(
  page: Page,
  target: Locator,
): Promise<void> {
  await target.focus();
  await expect(target).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(target).not.toBeFocused();
  await page.keyboard.press("Tab");
  await expect(target).toBeFocused();
}

/** Show the pull request metadata rail, which lives on the Conversation tab. */
async function openConversationRail(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "Pull request metadata" }),
  ).toBeVisible();
}

/**
 * Stand in for Electron's IPC bridge so the dashboard (rather than a fixture
 * hash) renders in a plain browser tab.
 */
async function installBridgeStub(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "patchdesk", {
      value: {
        async request(input: {
          readonly path?: string;
          readonly operation?: string;
        }) {
          if (input.path === "/v1/profiles")
            return { ok: true, status: 200, body: [], correlationId: "keys" };
          return { ok: true, status: 200, body: {}, correlationId: "keys" };
        },
        onMenuAction() {
          return () => undefined;
        },
      },
    });
  });
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
