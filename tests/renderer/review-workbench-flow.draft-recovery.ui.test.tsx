// @vitest-environment jsdom
import "./pierre-highlighter-mock";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent, {
  PointerEventsCheckLevel,
} from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { changeScopeFromPatch } from "../../src/domain/change-scope";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import { bridge, Refusal, restoreBridge } from "./review-workbench-bridge";
import { pending, projection, sha } from "./review-workbench-fixtures";

/**
 * A safely refused inline draft outlives the Diff tab, which unmounts on a tab
 * switch and remounts on a new head (#526). The hook suite covers the drafts
 * themselves; only the mounted workbench shows they survive both.
 */

const NEW_HEAD = "c".repeat(40);
// The new head moved the change: line 1 is no longer in the diff, and the added line is now 3.
const NEW_HEAD_PATCH =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2,2 +2,2 @@\n two\n-old\n+newer\n";

const DOCS_DIFF =
  "diff --git a/docs/guide.md b/docs/guide.md\n--- a/docs/guide.md\n+++ b/docs/guide.md\n@@ -1 +1 @@\n-old\n+new\n";
// The head commit, so the slice takes comments: a draft stranded there could be restored onto the guide.
const DOCS_COMMIT = {
  sha,
  message: "Touch the guide",
  author: "author",
  authoredAt: "2026-08-01T00:00:00.000Z",
  isHead: true,
};

function review(): WorkbenchResponse {
  // SAFETY: `pending("none")` is a wider fixture shape than the strict `pendingReview` union.
  return projection({ pendingReview: pending("none") as never });
}

/** src/a.ts and docs/guide.md in two Scope buckets, and a head commit that touched only the guide. */
function reviewWithDocs(): WorkbenchResponse {
  const base = review();
  const fullPatch = `${base.fullPatch ?? ""}${DOCS_DIFF}`;
  const scope = changeScopeFromPatch(fullPatch);
  return {
    ...base,
    fullPatch,
    // The wire type the projection carries is mutable; the domain's is not.
    scope: { ...scope, buckets: [...scope.buckets] },
    commits: [DOCS_COMMIT],
  };
}

function failedCard(): HTMLElement | null {
  return screen.queryByRole("article", { name: "Pending review write failed" });
}

function refreshedToNewHead(): WorkbenchResponse {
  const base = review();
  return {
    ...base,
    revision: {
      ...base.revision,
      reviewedHeadSha: NEW_HEAD,
      currentHeadSha: NEW_HEAD,
    },
    fullPatch: NEW_HEAD_PATCH,
  };
}

function flow(workbench: WorkbenchResponse): React.JSX.Element {
  return (
    <ReviewWorkbenchFlow
      workbench={workbench}
      onWorkbenchReplace={vi.fn()}
      onWorkbenchPatch={vi.fn()}
      onNavigationStateChange={vi.fn()}
    />
  );
}

// Pierre's CodeView suspends pointer events for 120 ms after a layout pass.
function setupCodeViewUser(): ReturnType<typeof userEvent.setup> {
  return userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
}

async function selectAddedLine(
  user: ReturnType<typeof userEvent.setup>,
  line: number,
): Promise<void> {
  const add = (
    await screen.findAllByRole("button", { name: "Add comment on src/a.ts" })
  ).at(-1);
  if (add === undefined) throw new Error("missing added-line comment action");
  add.dataset.lineNumber = String(line);
  add.dataset.lineSide = "additions";
  await user.click(add);
}

async function refuseDraftOnDiff(
  user: ReturnType<typeof userEvent.setup>,
  body: string,
): Promise<void> {
  await user.click(screen.getByRole("tab", { name: "Diff" }));
  await selectAddedLine(user, 1);
  const composer = screen.getByRole("region", {
    name: "Inline comment composer",
  });
  await user.type(
    within(composer).getByRole("textbox", { name: "Inline comment" }),
    body,
  );
  await user.click(
    within(composer).getByRole("button", { name: "Start a review" }),
  );
  await screen.findByRole("article", { name: "Pending review write failed" });
}

// jsdom has no constructable stylesheets; Pierre's CodeView only needs the call to exist.
const stubbedReplaceSync = CSSStyleSheet.prototype.replaceSync === undefined;
beforeEach(() => {
  if (stubbedReplaceSync) CSSStyleSheet.prototype.replaceSync = () => undefined;
  bridge(async (input) => {
    if (input.path === "/v1/reviews/detect-updates")
      return { updatesAvailable: false };
    if (input.path === "/v1/reviews/pending-review/command")
      return new Refusal(422, { error: "github_rejected" });
    if (input.path === "/v1/reviews/commit-diff")
      return {
        commit: DOCS_COMMIT,
        position: 1,
        total: 1,
        patch: DOCS_DIFF,
        fileCount: 1,
        additions: 1,
        deletions: 1,
      };
    throw new Error(input.path);
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  restoreBridge();
  if (stubbedReplaceSync)
    Reflect.deleteProperty(CSSStyleSheet.prototype, "replaceSync");
});

describe("a refused inline draft in the mounted workbench", () => {
  it("shows its failed card again after a switch to Conversation and back to Diff", async () => {
    const user = setupCodeViewUser();
    render(flow(review()));
    await refuseDraftOnDiff(user, "Draft kept across tabs");

    await user.click(screen.getByRole("tab", { name: "Conversation" }));
    await user.click(screen.getByRole("tab", { name: "Diff" }));

    expect(
      (
        await screen.findByRole("article", {
          name: "Pending review write failed",
        })
      ).textContent,
    ).toContain("Draft kept across tabs");
  });

  it("offers it after a Refresh to a new head removed its lines, and restores it on a newly selected line", async () => {
    const user = setupCodeViewUser();
    const view = render(flow(review()));
    await refuseDraftOnDiff(user, "Draft kept across a new head");

    view.rerender(flow(refreshedToNewHead()));
    await user.click(screen.getByRole("tab", { name: "Diff" }));
    expect(screen.getByRole("region", { name: "Saved draft" })).toBeTruthy();
    await selectAddedLine(user, 3);

    await waitFor(() =>
      expect(
        (
          screen.getByRole("textbox", {
            name: "Inline comment",
          }) as HTMLTextAreaElement
        ).value,
      ).toBe("Draft kept across a new head"),
    );
    expect(screen.queryByRole("region", { name: "Saved draft" })).toBeNull();
  });

  it("hides it while a Scope bucket hides its file, without offering it elsewhere, and shows it again when the bucket clears", async () => {
    const user = setupCodeViewUser();
    render(flow(reviewWithDocs()));
    await refuseDraftOnDiff(user, "Draft kept through a Scope filter");

    screen.getByRole("button", { name: "Scope filter" }).focus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("menuitemradio", { name: /Docs/ }));
    await waitFor(() => expect(failedCard()).toBeNull());
    expect(screen.queryByRole("region", { name: "Saved draft" })).toBeNull();

    screen.getByRole("button", { name: "Scope filter" }).focus();
    await user.keyboard("{Enter}");
    await user.click(
      screen.getByRole("menuitemradio", { name: "Clear scope" }),
    );
    expect(
      (
        await screen.findByRole("article", {
          name: "Pending review write failed",
        })
      ).textContent,
    ).toContain("Draft kept through a Scope filter");
  });

  it("hides it in a commit slice that lacks its lines, and shows it again back on the full diff", async () => {
    const user = setupCodeViewUser();
    render(flow(reviewWithDocs()));
    await refuseDraftOnDiff(user, "Draft kept through a commit slice");

    await user.click(screen.getByRole("tab", { name: /^Commits/ }));
    await user.click(screen.getByRole("button", { name: /Touch the guide/ }));
    await screen.findByText(/1 of 1/);
    expect(failedCard()).toBeNull();
    expect(screen.queryByRole("region", { name: "Saved draft" })).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Browse" }));
    expect(
      (
        await screen.findByRole("article", {
          name: "Pending review write failed",
        })
      ).textContent,
    ).toContain("Draft kept through a commit slice");
  });
});
