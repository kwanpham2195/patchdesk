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
    // The Reviewers section is read-only the same way: reviewer rows still
    // render (both a verdict and a requested-but-unanswered row), but no
    // picker trigger is offered.
    await expect(rail.getByText("fixture-approved-reviewer")).toBeVisible();
    await expect(
      rail.locator('[data-slot="badge"]', { hasText: "Approved" }),
    ).toBeVisible();
    await expect(
      rail.getByRole("button", { name: "Manage reviewers" }),
    ).toHaveCount(0);
  });

  test("renders Reviewers above Assignees above Labels, listing assignees", async ({
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
    await expect(headings.nth(0)).toHaveText("Reviewers");
    await expect(headings.nth(1)).toHaveText("Assignees");
    await expect(headings.nth(2)).toHaveText("Labels");
    const assigneeRow = rail.getByRole("list", {
      name: "Pull request assignees",
    });
    await expect(assigneeRow.getByText("fixture-assignee")).toBeVisible();
    await expect(
      rail.getByRole("button", { name: "Manage assignees" }),
    ).toBeVisible();
  });

  // #21: reviewers, assignees, and picker candidates render real GitHub
  // avatars, resolved main-process-side and handed to the renderer only as
  // `data:` URIs (see `Avatar` in `ui/avatar.tsx`) -- never a remote
  // `avatarUrl`, which the renderer's CSP would refuse to load anyway.
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

  test("renders reviewer rows: a requested-but-unanswered row, a current verdict, and an outdated verdict marked as such without relying on colour alone", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-fixture`);
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    const reviewerList = rail.getByRole("list", {
      name: "Pull request reviewers",
    });
    await expect(reviewerList).toBeVisible();
    // A requested reviewer with no verdict yet reads as "Requested", not blank.
    const requestedRow = reviewerList.locator("li", {
      hasText: "fixture-reviewer",
    });
    await expect(requestedRow).toBeVisible();
    await expect(requestedRow.getByText("Requested")).toBeVisible();
    // A current, on-revision verdict carries no outdated marking.
    const approvedRow = reviewerList.locator("li", {
      hasText: "fixture-approved-reviewer",
    });
    await expect(
      approvedRow.locator('[data-slot="badge"]', { hasText: "Approved" }),
    ).toBeVisible();
    await expect(
      approvedRow.locator('[data-slot="badge"]', { hasText: "Outdated" }),
    ).toHaveCount(0);
    // An outdated verdict is marked in text, not only by colour.
    const outdatedRow = reviewerList.locator("li", {
      hasText: "fixture-outdated-reviewer",
    });
    await expect(
      outdatedRow.locator('[data-slot="badge"]', {
        hasText: "Changes requested",
      }),
    ).toBeVisible();
    await expect(
      outdatedRow.locator('[data-slot="badge"]', { hasText: "Outdated" }),
    ).toBeVisible();
  });

  test("states plainly, and distinctly from a failure, when no review has been requested or submitted", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-empty-reviewers-fixture`);
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    await expect(
      rail.getByText(
        "No review has been requested, and none has been submitted.",
      ),
    ).toBeVisible();
    await expect(rail.getByRole("alert")).toHaveCount(0);
  });

  test("reads a failed reviewer fetch as a failure, not as nobody reviewing", async ({
    page,
  }) => {
    await page.goto(
      `${origin(server)}/#workbench-reviewers-read-failure-fixture`,
    );
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    await expect(
      rail.getByText(
        "Patchdesk could not load this pull request's reviewers. Refresh to retry.",
      ),
    ).toBeVisible();
    await expect(rail.getByText("No review has been requested")).toHaveCount(0);
  });

  test("renders the viewer's own pending review as an additional, visually distinct row, while a prior verdict stays visible", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-reviewers-pending-fixture`);
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    const pendingRow = rail.locator('[aria-label="Your review in progress"]');
    await expect(pendingRow).toBeVisible();
    await expect(pendingRow.getByText("3 comments")).toBeVisible();
    await expect(pendingRow.getByText("draft", { exact: false })).toBeVisible();
    // The prior submitted verdict is still visible alongside the draft row.
    await expect(rail.getByText("fixture-approved-reviewer")).toBeVisible();
    await expect(
      rail.locator('[data-slot="badge"]', { hasText: "Approved" }),
    ).toBeVisible();
  });

  test("no pending row renders when there is no open pending review", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-fixture`);
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    await expect(
      rail.locator('[aria-label="Your review in progress"]'),
    ).toHaveCount(0);
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

  test("toggling a requested reviewer off removes the request", async ({
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
    const requestedCheckbox = page.getByRole("checkbox", {
      name: "fixture-reviewer",
    });
    await expect(requestedCheckbox).toHaveAttribute("aria-checked", "true");
    await requestedCheckbox.click();
    await expect(requestedCheckbox).toHaveAttribute("aria-checked", "false");
  });

  test("a failed reviewer write reverts and names the person", async ({
    page,
  }) => {
    await page.goto(
      `${origin(server)}/#workbench-reviewers-write-failure-fixture`,
    );
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    await rail.getByRole("button", { name: "Manage reviewers" }).click();
    const otherCheckbox = page.getByRole("checkbox", {
      name: "fixture-other-reviewer",
    });
    await otherCheckbox.click();
    await expect(otherCheckbox).toHaveAttribute("aria-checked", "false");
    await expect(
      page.getByText('Patchdesk could not ask "fixture-other-reviewer"', {
        exact: false,
      }),
    ).toBeVisible();
  });

  test("the reviewer picker is disabled and states the account cannot manage reviewers when permission is denied", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-reviewers-denied-fixture`);
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    await rail.getByRole("button", { name: "Manage reviewers" }).click();
    await expect(
      page.getByText(
        "This account cannot manage reviewers on this repository.",
      ),
    ).toBeVisible();
    const otherCheckbox = page.getByRole("checkbox", {
      name: "fixture-other-reviewer",
    });
    expect(await otherCheckbox.getAttribute("aria-disabled")).toBe("true");
  });

  test("the reviewer picker states an honest, unconfirmed caveat when permission is unknown", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-reviewers-unknown-fixture`);
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    await rail.getByRole("button", { name: "Manage reviewers" }).click();
    await expect(
      page.getByText(
        "Patchdesk could not confirm you can manage reviewers here — a change may be refused.",
      ),
    ).toBeVisible();
  });

  test("under Terminal state the Reviewers section is read-only: no picker trigger", async ({
    page,
  }) => {
    await page.goto(`${origin(server)}/#workbench-merged-fixture`);
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const rail = page.getByRole("complementary", {
      name: "Pull request metadata",
    });
    await expect(
      rail.getByRole("button", { name: "Manage reviewers" }),
    ).toHaveCount(0);
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
    await expect(collaboratorCheckbox).toHaveAttribute("aria-checked", "false");
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
    await page.getByRole("checkbox", { name: "fixture-collaborator" }).click();
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
  // Only the `AddressInfo` branch remains.
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
