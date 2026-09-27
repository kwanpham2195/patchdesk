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

import { changeScopeFromPatch } from "../../src/domain/change-scope";
import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import type { LocalDraftEntry } from "../../src/renderer/src/local-draft-contracts";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { bridge, restoreBridge } from "./review-workbench-bridge";
import { projection } from "./review-workbench-fixtures";

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

/** src/a.ts and docs/guide.md each changed on line 1, so the Scope filter has a Source and a Docs bucket. */
const combinedPatch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/docs/guide.md b/docs/guide.md",
  "--- a/docs/guide.md",
  "+++ b/docs/guide.md",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

const noteOnA: LocalDraftEntry = {
  kind: "note",
  noteId: "note-1",
  sessionId: "session-a",
  view: "combined",
  path: "src/a.ts",
  side: "new",
  startLine: 1,
  line: 1,
  text: "Guard the empty case.",
};

const draftedFinding: LocalDraftEntry = {
  kind: "finding",
  findingId: "finding-1",
  analysisRunId: "run-1",
  sessionId: "session-a",
  view: "combined",
  path: "docs/guide.md",
  side: "new",
  startLine: 1,
  line: 1,
  title: "Stale example",
  suggests: false,
};

/** A shared Review whose Combined view is `combinedPatch`, and whose other views touch no file. */
function sharedReview(
  localDrafts: ReadonlyArray<LocalDraftEntry>,
): WorkbenchResponse {
  const base = projection();
  const scope = changeScopeFromPatch(combinedPatch);
  const combined = {
    patchHash: "c".repeat(64),
    paths: ["docs/guide.md", "src/a.ts"],
  };
  const untouched = { patchHash: "d".repeat(64), paths: [] };
  return projection({
    session: {
      ...base.session,
      key: {
        ...base.session.key,
        source: { kind: "local_branch", branch: "feature", baseBranch: "main" },
      },
    },
    pullRequest: undefined,
    fullPatch: combinedPatch,
    scope: { ...scope, buckets: [...scope.buckets] },
    viewedPaths: [],
    patchViews: { combined, committed: untouched, uncommitted: untouched },
    localDrafts: [...localDrafts],
  });
}

/** Answers an Uncommitted read with an empty patch: the checkout has no uncommitted changes. */
function answerLocalReads(): void {
  bridge((input) => {
    if (input.path === "/v1/reviews/detect-updates")
      return { updatesAvailable: false };
    if (input.path === "/v1/reviews/local-patch-view")
      return {
        sessionId: "session-a",
        view: "uncommitted",
        patch: "",
        patchHash: "e".repeat(64),
        viewedPaths: [],
      };
    if (input.path === "/v1/reviews/diff-file")
      return { state: "unavailable", reason: "path_unavailable" };
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

/** The Browse tree's rows, read from the file tree's shadow root. */
function browsedPaths(): ReadonlyArray<string> {
  const tree = document
    .querySelector("file-tree-container")
    ?.shadowRoot?.querySelectorAll("[data-item-path]");
  if (tree === undefined) throw new Error("Expected a Browse file tree");
  return [...tree].map((row) => row.getAttribute("data-item-path") ?? "");
}

function draftRows(): ReadonlyArray<HTMLElement> {
  return within(
    screen.getByRole("list", { name: "Local drafts" }),
  ).getAllByRole("listitem");
}

function reasonOf(row: HTMLElement): string | undefined {
  return (
    row
      .querySelector("[data-local-draft-reason]")
      ?.getAttribute("data-local-draft-reason") ?? undefined
  );
}

/** The line numbers Pierre marks as the selected range, read from each diff container's shadow root. */
function markedLines(): ReadonlyArray<string> {
  return [...document.querySelectorAll("diffs-container")].flatMap((host) =>
    [
      ...(host.shadowRoot?.querySelectorAll(
        "[data-line][data-selected-line]",
      ) ?? []),
    ].map((line) => line.getAttribute("data-line") ?? ""),
  );
}

// Pierre's CodeView suspends pointer events for 120 ms after a layout pass.
function setupCodeViewUser(): ReturnType<typeof userEvent.setup> {
  return userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
}

describe("ReviewWorkbenchFlow Notes list placement", () => {
  it("lists every draft with the reason it is not inline when the shown view is empty, and selecting one moves nothing", async () => {
    answerLocalReads();
    const user = setupCodeViewUser();
    render(
      <SharedReviewScreen initial={sharedReview([noteOnA, draftedFinding])} />,
    );
    await user.click(screen.getByRole("tab", { name: "Diff" }));
    await user.click(screen.getByRole("button", { name: "Uncommitted" }));
    await waitFor(() =>
      expect(screen.queryByText(/^Loading the .* view/)).toBeNull(),
    );
    await user.click(screen.getByRole("tab", { name: /^Notes/ }));

    const rows = draftRows();
    expect(rows.map(reasonOf)).toEqual([
      "outside_hunk",
      "finding_off_combined",
    ]);
    expect(
      screen.queryByRole("button", { name: /^Show .* in the diff$/ }),
    ).toBeNull();
    const [noteRow] = rows;
    if (noteRow === undefined) throw new Error("missing note row");
    await user.click(within(noteRow).getByText("Guard the empty case."));
    expect(
      screen.getByRole("tab", { name: /^Notes/ }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Uncommitted" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.queryByRole("article", { name: "Note on src/a.ts:1" }),
    ).toBeNull();
  });

  it("reveals a note whose file a Scope filter hides: the filter clears and the diff marks its lines", async () => {
    answerLocalReads();
    const user = setupCodeViewUser();
    render(<SharedReviewScreen initial={sharedReview([noteOnA])} />);
    await user.click(screen.getByRole("tab", { name: "Diff" }));
    screen.getByRole("button", { name: "Scope filter" }).focus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("menuitemradio", { name: /Docs/ }));
    expect(browsedPaths()).toEqual(["docs/", "docs/guide.md"]);
    await user.click(screen.getByRole("tab", { name: /^Notes/ }));

    await user.click(
      screen.getByRole("button", {
        name: "Show note at src/a.ts:1 in the diff",
      }),
    );

    await user.click(screen.getByRole("tab", { name: "Browse" }));
    expect(browsedPaths()).toContain("src/a.ts");
    const diff = screen.getByRole("region", { name: "Review diff" });
    expect(diff.getAttribute("data-selected-path")).toBe("src/a.ts");
    await screen.findByRole("article", { name: "Note on src/a.ts:1" });
    expect(markedLines()).toEqual(["1"]);
  });
});
