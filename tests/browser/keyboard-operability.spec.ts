import type { Server } from "node:http";
import { expect, test, type Locator, type Page } from "playwright/test";
import { installTestDesktopBridge } from "./bridge-fixture";
import { closeServer, serveRenderer, serverOrigin } from "./renderer-server";

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
    await closeServer(server);
  });

  test("keyboard users can skip, navigate, and close quick navigation", async ({
    page,
  }) => {
    await installTestDesktopBridge(page, { kind: "static" });
    await page.goto(serverOrigin(server));

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
    await installTestDesktopBridge(page, { kind: "static" });
    await page.goto(serverOrigin(server));

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
    await page.goto(`${serverOrigin(server)}/#mermaid-fixture`);
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

  // What each rail picker does once it has focus -- where focus lands on
  // open, Tab between rows, Space toggling the focused row, Escape closing
  // and handing focus back to the trigger -- is proved at RTL, in
  // `tests/renderer/label-picker.ui.test.tsx` and its assignee and reviewer
  // siblings. Those mount one picker on its own, so the one thing they cannot
  // show is that the whole page's focus order arrives at a picker at all.
  // That is what this walk is for, and why one test covers all three pickers:
  // they sit in the same rail, reached the same way.
  test("a keyboard user reaches a rail picker through the page's own tab order", async ({
    page,
  }) => {
    await page.goto(`${serverOrigin(server)}/#workbench-fixture`);
    await openConversationRail(page);

    // Start from the first stop a keyboard user lands on, then press Tab until
    // the rail's Labels trigger takes focus.
    await page.getByRole("link", { name: "Skip to content" }).focus();
    const manageLabels = page.getByRole("button", { name: "Manage labels" });
    const triggerFocused = (): Promise<boolean> =>
      manageLabels.evaluate((element) => element === document.activeElement);

    const visited: string[] = [];
    while (visited.length < 80 && !(await triggerFocused())) {
      await page.keyboard.press("Tab");
      visited.push(await focusedDescription(page));
    }
    expect(
      await triggerFocused(),
      `Tab visited ${visited.length} stops without reaching the rail's Labels trigger: ${visited.join(" -> ")}`,
    ).toBe(true);

    // Arriving is half of it; the trigger also opens from the keyboard.
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("checkbox", { name: "documentation" }),
    ).toBeVisible();
  });

  test("the header refresh control is keyboard-reachable with an accessible name", async ({
    page,
  }) => {
    await page.goto(`${serverOrigin(server)}/#workbench-fixture`);
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

  test("the Assignees empty-state self-assign shortcut is keyboard-reachable and operable", async ({
    page,
  }) => {
    await page.goto(
      `${serverOrigin(server)}/#workbench-empty-assignees-fixture`,
    );
    await openConversationRail(page);

    const assignSelf = page.getByRole("button", { name: "Assign yourself" });
    await expectReachableByTab(page, assignSelf);
    await page.keyboard.press("Enter");
    await expect(page.getByText("fixture-viewer")).toBeVisible();
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

/** Names the focused element, so a tab walk that never arrives says where it went. */
async function focusedDescription(page: Page): Promise<string> {
  return page.evaluate(() => {
    const focused = document.activeElement;
    if (focused === null) return "<none>";
    const name =
      focused.getAttribute("aria-label") ??
      focused.textContent?.trim().slice(0, 30) ??
      "";
    return `<${focused.tagName.toLowerCase()}> "${name}"`;
  });
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
  await page.getByRole("tab", { name: "Conversation", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "Pull request metadata" }),
  ).toBeVisible();
}
