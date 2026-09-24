// @vitest-environment jsdom
import "./pierre-highlighter-mock";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import { bridge, restoreBridge } from "./review-workbench-bridge";
import {
  callBody,
  callPath,
  pending,
  projection,
  providerCatalog,
  sha,
} from "./review-workbench-fixtures";

const firstSha = "c".repeat(40);
const header =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n";
// Base line 8 is `}`. The first commit adds another `}` as its line 10 with no context; the head commit inserts i1 and i2 after base 5, so head line 10 is base 8's `}` at the end of its hunk: same text, no shared neighbours, different code.
const fullPatch =
  header +
  "@@ -3,6 +3,8 @@\n b3\n b4\n b5\n+i1\n+i2\n b6\n b7\n }\n@@ -9,0 +12,1 @@\n+}\n";
const commitPatches = new Map([
  [firstSha, header + "@@ -9,0 +10,1 @@\n+}\n"],
  [sha, header + "@@ -3,6 +3,8 @@\n b3\n b4\n b5\n+i1\n+i2\n b6\n b7\n }\n"],
]);
const commits = [
  { sha: firstSha, message: "Add a brace" },
  { sha, message: "Insert i1 and i2" },
].map((commit, index) => ({
  ...commit,
  author: "author",
  authoredAt: "2026-08-01T00:00:00.000Z",
  isHead: index === 1,
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  restoreBridge();
});

async function openCommit(message: string) {
  const request = bridge(async (input) => {
    if (input.path === "/v1/reviews/detect-updates")
      return { updatesAvailable: false };
    if (input.path === "/v1/insight-providers") return providerCatalog;
    if (input.path === "/v1/reviews/commit-diff") {
      // SAFETY: the flow always posts `{ commitSha }` to this route.
      const commitSha = (input.body as { readonly commitSha: string })
        .commitSha;
      const patch = commitPatches.get(commitSha);
      const commit = commits.find((candidate) => candidate.sha === commitSha);
      if (patch === undefined || commit === undefined)
        throw new Error(commitSha);
      return {
        commit,
        position: commits.indexOf(commit) + 1,
        total: commits.length,
        patch,
        fileCount: 1,
        additions: 1,
        deletions: 0,
      };
    }
    if (input.path === "/v1/reviews/pending-review/command")
      return { pendingReview: pending("pending") };
    throw new Error(input.path);
  });
  render(
    <ReviewWorkbenchFlow
      workbench={projection({
        fullPatch,
        pendingReview: pending("none"),
        commits,
      })}
      onWorkbenchReplace={vi.fn()}
      onWorkbenchPatch={vi.fn()}
      onNavigationStateChange={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Diff" }));
  await user.click(screen.getByRole("tab", { name: /^Commits/ }));
  await user.click(screen.getByRole("button", { name: new RegExp(message) }));
  const position = commits.findIndex((commit) => commit.message === message);
  await screen.findByText(new RegExp(`${position + 1} of ${commits.length}`));
  return { request, user };
}

function commentTargetFor(text: string): HTMLElement | undefined {
  return screen
    .queryAllByRole("button", { name: "Add comment on src/a.ts" })
    .find((button) => button.closest("li")?.textContent?.includes(text));
}

describe("ReviewWorkbenchFlow commit slice comments", () => {
  it("offers no comment in an older commit and says why", async () => {
    await openCommit("Add a brace");

    expect(
      screen.queryAllByRole("button", { name: "Add comment on src/a.ts" }),
    ).toEqual([]);
    expect(screen.getByRole("note")).toBeTruthy();
  });

  it("anchors a comment in the head commit to the same head line", async () => {
    const { request, user } = await openCommit("Insert i1 and i2");

    expect(screen.queryByRole("note")).toBeNull();
    const target = commentTargetFor("i1");
    if (target === undefined) throw new Error("missing comment action");
    await user.click(target);
    const composer = screen.getByRole("region", {
      name: "Inline comment composer",
    });
    await user.type(
      within(composer).getByRole("textbox", { name: "Inline comment" }),
      "On the inserted line",
    );
    await user.click(
      within(composer).getByRole("button", { name: "Start a review" }),
    );

    const command = request.mock.calls.find(
      ([input]) => callPath(input) === "/v1/reviews/pending-review/command",
    );
    expect(JSON.stringify(callBody(command?.[0]))).toContain(
      '"path":"src/a.ts","startLine":6,"line":6,"side":"new"',
    );
  });
});
