// @vitest-environment jsdom
import "./pierre-highlighter-mock";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent, {
  PointerEventsCheckLevel,
} from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import { LocalNoteCard } from "../../src/renderer/src/components/local-note-card";
import { buildLocalNoteAnnotations } from "../../src/renderer/src/components/review-workbench-annotations";
import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import type { LocalDraftEntry } from "../../src/renderer/src/local-draft-contracts";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import {
  failure,
  installDesktopDouble,
  success,
} from "./fake-desktop-response";
import { callBody, callPath, projection } from "./review-workbench-fixtures";

const REFRESH = "/v1/reviews/local-refresh";
let restore: (() => void) | undefined;

afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const note: LocalDraftEntry = {
  kind: "note",
  noteId: "note-1",
  sessionId: "session-a",
  path: "src/a.ts",
  side: "new",
  startLine: 1,
  line: 1,
  text: "Guard the empty case.",
};

const finding = {
  kind: "finding" as const,
  analysisRunId: "insight-analysis-1-fixture",
  sessionId: "session-a",
  path: "src/b.ts",
  side: "new" as const,
  startLine: 4,
  line: 4,
  suggests: false,
};

function workingTreeReview(
  sessionId: string,
  localDrafts: ReadonlyArray<LocalDraftEntry>,
): WorkbenchResponse {
  const base = projection();
  // SAFETY: fixture data in the wire shape `parseWorkbenchResponse` accepts; the working-tree source replaces the pull request fields.
  return projection({
    ...base,
    session: {
      ...base.session,
      id: sessionId,
      key: {
        ...base.session.key,
        source: { kind: "working_tree", branch: "main" },
      },
    },
    pullRequest: undefined,
    localDrafts,
  } as never);
}

/** The flow over a working-tree Review, replacing it the way the Review screen does. */
function LocalReviewScreen(): React.JSX.Element {
  const [workbench, setWorkbench] = useState(() =>
    workingTreeReview("session-a", [note]),
  );
  return (
    <ReviewWorkbenchFlow
      workbench={workbench}
      onWorkbenchReplace={setWorkbench}
      onWorkbenchPatch={(patch) =>
        setWorkbench(
          (current) => ({ ...current, ...patch }) as WorkbenchResponse,
        )
      }
      onNavigationStateChange={() => undefined}
    />
  );
}

function installRoutes(
  refresh: () => ReturnType<typeof success> | ReturnType<typeof failure>,
) {
  const double = installDesktopDouble({
    "/v1/reviews/detect-updates": () => success({ updatesAvailable: false }),
    "/v1/insight-providers": () => failure({ error: "storage" }, 503),
    // Context hydration is not under test; an unreadable file keeps the patch as it is.
    "/v1/reviews/diff-file": () => failure({ error: "not_found" }, 404),
    [REFRESH]: refresh,
  });
  restore = double.restore;
  return double;
}

function refreshCalls(double: ReturnType<typeof installDesktopDouble>) {
  return double.request.mock.calls.flatMap(([input]) =>
    callPath(input) === REFRESH ? [callBody(input)] : [],
  );
}

describe("Local drafts inline after a Refresh", () => {
  it("renders only the notes anchored in the displayed session, each with its state", () => {
    const workbench = workingTreeReview("session-b", [
      { ...note, sessionId: "session-b", state: "changed" },
      {
        ...note,
        noteId: "note-2",
        startLine: 7,
        line: 7,
        state: "needs_attention",
      },
    ]);
    render(
      <>
        {buildLocalNoteAnnotations(workbench, undefined).map((annotation) =>
          annotation.localNote === undefined ? null : (
            <LocalNoteCard key={annotation.id} {...annotation.localNote} />
          ),
        )}
      </>,
    );

    const cards = screen.getAllByRole("article");
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
      "Note on src/a.ts:1",
    ]);
    expect(cards[0]?.textContent).toContain("Changed since your note");
  });
});

describe("Refresh on a local Review", () => {
  it("reads the checkout again, shows the new session, and labels each draft with what the Refresh decided", async () => {
    const refreshed = workingTreeReview("session-b", [
      { ...note, sessionId: "session-b", state: "changed" },
      {
        ...finding,
        findingId: "finding-1",
        title: "Unused import",
        state: "needs_attention",
      },
      {
        ...finding,
        findingId: "finding-2",
        title: "Off-by-one bound",
        state: "applied",
      },
    ]);
    // SAFETY: the projection fixture is plain JSON data; the bridge carries it as the raw body the renderer parses.
    const double = installRoutes(() => success(refreshed as RawJsonValue));
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    render(<LocalReviewScreen />);

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await user.click(screen.getByRole("tab", { name: "Insights" }));
    await user.click(screen.getByRole("tab", { name: /^Analysis/ }));
    const items = within(
      await screen.findByRole("list", { name: "Local drafts" }),
    ).getAllByRole("listitem");

    expect(refreshCalls(double)).toEqual([
      { profileId: "profile", reviewId: "review-42" },
    ]);
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Changed since your note"),
      expect.stringContaining("Needs attention"),
      expect.stringContaining("Applied in Patchdesk"),
    ]);
  });

  it("names the checkout's branch when Refresh is refused after a branch switch, and keeps the review", async () => {
    const double = installRoutes(() =>
      failure({ error: "branch_mismatch", currentBranch: "other" }, 409),
    );
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    render(<LocalReviewScreen />);

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("other");
    expect(refreshCalls(double)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveProperty(
      "disabled",
      false,
    );
  });
});
