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
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { bridge, restoreBridge } from "./review-workbench-bridge";
import { callBody, callPath, projection } from "./review-workbench-fixtures";

// jsdom has no constructable stylesheets; Pierre's CodeView, which renders inline notes, only needs the call to exist.
const stubbedReplaceSync = CSSStyleSheet.prototype.replaceSync === undefined;
beforeEach(() => {
  if (stubbedReplaceSync) CSSStyleSheet.prototype.replaceSync = () => undefined;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  restoreBridge();
  if (stubbedReplaceSync)
    Reflect.deleteProperty(CSSStyleSheet.prototype, "replaceSync");
});

function filePatch(path: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
}

const headSha = "1".repeat(40);
const firstSha = "2".repeat(40);
const commits = [
  { sha: headSha, message: "Second commit", isHead: true },
  { sha: firstSha, message: "First commit", isHead: false },
].map((commit) => ({
  ...commit,
  author: "author",
  authoredAt: "2026-08-01T00:00:00.000Z",
}));

/** A shared Review of src/a.ts in every view, on a branch of two commits, with one note on Combined. */
function sharedReview(source: WorkbenchResponse["session"]["key"]["source"]) {
  const base = projection();
  const paths = { patchHash: "c".repeat(64), paths: ["src/a.ts"] };
  return projection({
    session: { ...base.session, key: { ...base.session.key, source } },
    pullRequest: undefined,
    fullPatch: filePatch("src/a.ts"),
    viewedPaths: [],
    ...(source.kind === "local_branch"
      ? {
          patchViews: { combined: paths, committed: paths, uncommitted: paths },
          commits,
          commitTotal: commits.length,
        }
      : { commits: [] }),
    localDrafts: [
      {
        kind: "note",
        noteId: "note-1",
        sessionId: "session-a",
        view: "combined",
        path: "src/a.ts",
        side: "new",
        startLine: 1,
        line: 1,
        text: "Guard the empty case.",
        state: "unchanged",
      },
    ],
  });
}

function answerLocalReads() {
  return bridge((input) => {
    if (input.path === "/v1/reviews/detect-updates")
      return { updatesAvailable: false };
    if (input.path === "/v1/reviews/local-patch-view") {
      const { view } = input.body as { readonly view: string };
      return {
        sessionId: "session-a",
        view,
        patch: filePatch("src/a.ts"),
        patchHash: "d".repeat(64),
        viewedPaths: [],
      };
    }
    if (input.path === "/v1/reviews/diff-file")
      return { state: "unavailable", reason: "path_unavailable" };
    if (input.path === "/v1/reviews/commit-diff") {
      // SAFETY: the flow always posts `{ commitSha }` to this route.
      const { commitSha } = input.body as { readonly commitSha: string };
      const index = commits.findIndex((commit) => commit.sha === commitSha);
      if (index === -1) throw new Error(commitSha);
      return {
        commit: commits[index],
        position: index + 1,
        total: commits.length,
        patch: filePatch(`src/commit-${index + 1}.ts`),
        fileCount: 1,
        additions: 1,
        deletions: 1,
      };
    }
    throw new Error(input.path);
  });
}

function SharedReviewScreen({
  initial,
}: {
  readonly initial: WorkbenchResponse;
}): React.JSX.Element {
  const [workbench, setWorkbench] = useState(initial);
  return (
    <ReviewWorkbenchFlow
      workbench={workbench}
      onWorkbenchReplace={setWorkbench}
      onWorkbenchPatch={(patch) =>
        setWorkbench(
          (current) => ({ ...current, ...patch }) as WorkbenchResponse,
        )
      }
      onNavigationStateChange={vi.fn()}
    />
  );
}

describe("ReviewWorkbenchFlow commits on a shared local Review", () => {
  it("shows a picked commit's patch without notes, note authoring, or the Patch view control, and Browse returns to the view picked before", async () => {
    const request = answerLocalReads();
    // Pierre's CodeView suspends pointer events for 120 ms after a layout pass.
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    render(
      <SharedReviewScreen
        initial={sharedReview({
          kind: "local_branch",
          branch: "feature",
          baseBranch: "main",
        })}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Diff" }));
    await screen.findByRole("article", { name: "Note on src/a.ts:1" });
    await user.click(screen.getByRole("button", { name: "Uncommitted" }));
    await waitFor(() =>
      expect(screen.queryByText(/^Loading the .* view/)).toBeNull(),
    );

    await user.click(screen.getByRole("tab", { name: /^Commits/ }));
    const rows = within(screen.getByLabelText("Review commits"));
    expect(
      rows.getByRole("button", { name: /Second commit/ }).textContent,
    ).toContain("HEAD");
    const first = rows.getByRole("button", { name: /First commit/ });
    expect(first.textContent).not.toContain("HEAD");
    await user.click(first);

    await screen.findByText(/2 of 2/);
    const commitSlices = request.mock.calls
      .filter(([input]) => callPath(input) === "/v1/reviews/commit-diff")
      .map(([input]) => callBody(input));
    expect(commitSlices.at(-1)).toMatchObject({ commitSha: firstSha });
    expect(
      screen
        .getByRole("region", { name: "Review diff" })
        .getAttribute("data-selected-path"),
    ).toBe("src/commit-2.ts");
    expect(
      document
        .querySelector("[data-active-path]")
        ?.getAttribute("data-active-path"),
    ).toBe("src/commit-2.ts");
    expect(
      screen.queryByRole("article", { name: "Note on src/a.ts:1" }),
    ).toBeNull();
    expect(screen.queryAllByRole("button", { name: /^Add note on/ })).toEqual(
      [],
    );
    expect(screen.queryByRole("group", { name: "Patch view" })).toBeNull();
    expect(screen.getByRole("note")).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Browse" }));
    const views = await screen.findByRole("group", { name: "Patch view" });
    expect(
      within(views)
        .getByRole("button", { name: "Uncommitted" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await waitFor(() =>
      expect(
        screen
          .getByRole("region", { name: "Review diff" })
          .getAttribute("data-selected-path"),
      ).toBe("src/a.ts"),
    );
    expect(
      document
        .querySelector("[data-active-path]")
        ?.getAttribute("data-active-path"),
    ).toBe("src/a.ts");
  });

  it("opens an empty commit with metadata and no file, then Browse restores the prior view", async () => {
    bridge((input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { updatesAvailable: false };
      if (input.path === "/v1/reviews/local-patch-view") {
        const { view } = input.body as { readonly view: string };
        return {
          sessionId: "session-a",
          view,
          patch: filePatch("src/a.ts"),
          patchHash: "d".repeat(64),
          viewedPaths: [],
        };
      }
      if (input.path === "/v1/reviews/commit-diff")
        return {
          commit: { ...commits[0], message: "Checkpoint" },
          position: 1,
          total: 2,
          patch: "",
          fileCount: 0,
          additions: 0,
          deletions: 0,
        };
      if (input.path === "/v1/reviews/diff-file")
        return { state: "unavailable", reason: "path_unavailable" };
      throw new Error(input.path);
    });
    const initial = sharedReview({
      kind: "local_branch",
      branch: "feature",
      baseBranch: "main",
    });
    const user = userEvent.setup();
    render(
      <SharedReviewScreen
        initial={{
          ...initial,
          commits: commits.map((commit, index) =>
            index === 0 ? { ...commit, message: "Checkpoint" } : commit,
          ),
        }}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Diff" }));
    await user.click(screen.getByRole("button", { name: "Uncommitted" }));
    await waitFor(() =>
      expect(screen.queryByText(/^Loading the .* view/)).toBeNull(),
    );
    await user.click(screen.getByRole("tab", { name: /^Commits/ }));

    await screen.findByText(/1 of 2 · 0 files/);
    expect(
      screen.getByRole("button", { name: "Copy commit SHA" }),
    ).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByRole("treeitem")).toBeNull();
    expect(screen.queryByRole("region", { name: "Review diff" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Patch view" })).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Browse" }));
    const views = await screen.findByRole("group", { name: "Patch view" });
    expect(
      within(views)
        .getByRole("button", { name: "Uncommitted" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await waitFor(() =>
      expect(
        screen
          .getByRole("region", { name: "Review diff" })
          .getAttribute("data-selected-path"),
      ).toBe("src/a.ts"),
    );
  });

  it("shows only the error when a commit slice cannot be read, then returns to the full diff", async () => {
    bridge((input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { updatesAvailable: false };
      if (input.path === "/v1/reviews/commit-diff")
        throw new Error("Commit patch unreadable");
      if (input.path === "/v1/reviews/diff-file")
        return { state: "unavailable", reason: "path_unavailable" };
      throw new Error(input.path);
    });
    const user = userEvent.setup();
    render(
      <SharedReviewScreen
        initial={sharedReview({
          kind: "local_branch",
          branch: "feature",
          baseBranch: "main",
        })}
      />,
    );
    await user.click(screen.getByRole("tab", { name: /^Commits/ }));
    await screen.findByText("This commit diff could not be loaded.");
    expect(screen.queryByRole("region", { name: "Review diff" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Browse" }));
    expect(
      screen
        .getByRole("region", { name: "Review diff" })
        .getAttribute("data-selected-path"),
    ).toBe("src/a.ts");
  });

  it("shows no Commits section on a commit Review", async () => {
    answerLocalReads();
    const user = userEvent.setup();
    render(
      <SharedReviewScreen
        initial={sharedReview({ kind: "commit", commitSha: headSha })}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Diff" }));

    expect(screen.getByRole("tab", { name: "Browse" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /^Commits/ })).toBeNull();
  });
});
