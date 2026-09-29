// @vitest-environment jsdom
import "./pierre-highlighter-mock";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { chooseChanges, chooseViewedAction } from "./diff-toolbar-menus";
import { bridge, restoreBridge } from "./review-workbench-bridge";
import { projection } from "./review-workbench-fixtures";

afterEach(() => {
  cleanup();
  localStorage.clear();
  restoreBridge();
});

function filePatch(path: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
}

/** A shared local Review whose Combined view changes two files, and whose last Refresh changed only src/round.ts. */
function refreshedSharedReview(): WorkbenchResponse {
  const base = projection();
  const patchView = { patchHash: "c".repeat(64), paths: [] };
  return projection({
    session: {
      ...base.session,
      key: {
        ...base.session.key,
        source: {
          kind: "local_branch",
          branch: "feature",
          baseRef: "refs/heads/main",
        },
      },
    },
    pullRequest: undefined,
    fullPatch: `${filePatch("src/earlier.ts")}${filePatch("src/round.ts")}`,
    viewedPaths: [],
    patchViews: {
      combined: patchView,
      committed: patchView,
      uncommitted: patchView,
    },
    sinceLastRefresh: "available",
  });
}

function shownFiles(): ReadonlyArray<string> {
  return ["src/earlier.ts", "src/round.ts"].filter(
    (path) =>
      screen.queryAllByText(new RegExp(path.replaceAll(".", "\\."))).length > 0,
  );
}

describe("ReviewWorkbenchFlow Since last Refresh", () => {
  it("shows only the last Refresh's files, keeps their Viewed marks unsaved, and returns to Combined", async () => {
    const requests: unknown[] = [];
    const viewedSaves: unknown[] = [];
    bridge((input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { updatesAvailable: false };
      if (input.path === "/v1/reviews/local-since-last-refresh") {
        requests.push(input.body);
        return { sessionId: "session-a", patch: filePatch("src/round.ts") };
      }
      if (input.path === "/v1/reviews/viewed-files") {
        viewedSaves.push(input.body);
        return { paths: [] };
      }
      if (input.path === "/v1/reviews/diff-file")
        return { state: "unavailable", reason: "path_unavailable" };
      throw new Error(input.path);
    });
    render(
      <ReviewWorkbenchFlow
        workbench={refreshedSharedReview()}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Diff" }));
    await waitFor(() =>
      expect(shownFiles()).toEqual(["src/earlier.ts", "src/round.ts"]),
    );

    await chooseChanges(user, "Since last Refresh");

    await waitFor(() => expect(shownFiles()).toEqual(["src/round.ts"]));
    expect(requests).toEqual([
      { profileId: "profile", reviewId: "review-42", sessionId: "session-a" },
    ]);
    expect(
      screen.getByRole("button", { name: "Changes" }).textContent,
    ).toContain("Since last Refresh");
    await chooseViewedAction(user, "Mark all viewed");
    await screen.findByRole("button", { name: "1/1 viewed" });
    expect(viewedSaves).toEqual([]);
    await chooseChanges(user, "Combined");
    await waitFor(() =>
      expect(shownFiles()).toEqual(["src/earlier.ts", "src/round.ts"]),
    );
    expect(
      screen.getByRole("button", { name: "Changes" }).textContent,
    ).toContain("Combined");
  });
});
