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
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalNotesList } from "../../src/renderer/src/components/local-notes-list";
import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import type { LocalDraftControls } from "../../src/renderer/src/flows/use-local-drafts";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import {
  failure,
  installDesktopDouble,
  success,
} from "./fake-desktop-response";
import {
  callBody,
  callPath,
  projection,
  withAnalysis,
  withoutViews,
} from "./review-workbench-fixtures";

const ADD = "/v1/reviews/local-drafts/add";
const REMOVE = "/v1/reviews/local-drafts/remove";
let restore: (() => void) | undefined;

afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const drafted = {
  kind: "finding" as const,
  findingId: "finding-1",
  analysisRunId: "insight-analysis-1-fixture",
  sessionId: "session-a",
  view: "combined" as const,
  path: "src/a.ts",
  side: "new" as const,
  startLine: 1,
  line: 1,
  title: "Missing boundary check",
  suggests: false,
};

function workingTreeReview(): WorkbenchResponse {
  const base = withAnalysis("actionable");
  // SAFETY: fixture data in the wire shape `parseWorkbenchResponse` accepts; the working-tree source replaces the pull request fields.
  return projection({
    ...base,
    session: {
      ...base.session,
      key: {
        ...base.session.key,
        source: { kind: "local_branch", branch: "main", baseBranch: "develop" },
      },
    },
    pullRequest: undefined,
    analysisReviewActions: undefined,
    localDrafts: [],
  } as never);
}

/** The flow over a local Review with a current Analysis, applying its patches the way the Review screen does. */
function DraftingReview(): React.JSX.Element {
  const [workbench, setWorkbench] = useState(workingTreeReview);
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

describe("Local drafts on a local Review", () => {
  it("adds a Finding to draft from its Analysis row and removes it from the Notes list", async () => {
    const double = installDesktopDouble({
      "/v1/reviews/detect-updates": () => success({ updatesAvailable: false }),
      "/v1/insight-providers": () => failure({ error: "storage" }, 503),
      // Context hydration is not under test; an unreadable file keeps the patch as it is.
      "/v1/reviews/diff-file": () => failure({ error: "not_found" }, 404),
      [ADD]: () => success({ localDrafts: [drafted] }),
      [REMOVE]: () => success({ localDrafts: [] }),
    });
    restore = double.restore;
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    render(<DraftingReview />);

    await user.click(screen.getByRole("tab", { name: "Insights" }));
    await user.click(screen.getByRole("tab", { name: /^Analysis/ }));
    await user.click(
      await screen.findByRole("button", { name: "Add to draft" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Remove from draft" }),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Diff" }));
    await user.click(screen.getByRole("tab", { name: /^Notes/ }));
    const list = screen.getByRole("list", { name: "Local drafts" });
    expect(list.textContent).toContain("src/a.ts:1");
    await user.click(
      within(list).getByRole("button", {
        name: "Remove finding at src/a.ts:1 from drafts",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Local drafts" })).toBeNull(),
    );

    await user.click(screen.getByRole("tab", { name: "Insights" }));
    expect(
      await screen.findByRole("button", { name: "Add to draft" }),
    ).toBeTruthy();
    expect(
      double.request.mock.calls.flatMap(([input]) =>
        [ADD, REMOVE].includes(callPath(input) ?? "")
          ? [[callPath(input), callBody(input)]]
          : [],
      ),
    ).toEqual([
      [
        ADD,
        {
          profileId: "profile",
          reviewId: "review-42",
          sessionId: "session-a",
          runId: "insight-analysis-1-fixture",
          findingId: "finding-1",
        },
      ],
      [
        REMOVE,
        {
          profileId: "profile",
          reviewId: "review-42",
          sessionId: "session-a",
          runId: "insight-analysis-1-fixture",
          findingId: "finding-1",
        },
      ],
    ]);
  });

  it("names each Remove in the Notes list by kind when a note and a Finding share lines", async () => {
    const remove = vi.fn<LocalDraftControls["remove"]>(async () => undefined);
    const note = {
      kind: "note" as const,
      noteId: "note-1",
      sessionId: "session-a",
      view: "combined" as const,
      path: "src/a.ts",
      side: "new" as const,
      startLine: 1,
      line: 1,
      text: "Guard the empty case.",
    };
    render(
      <LocalNotesList
        controls={{
          entries: [drafted, note],
          draftedFindingIds: new Set(["finding-1"]),
          canAdd: true,
          canRemove: true,
          pending: new Set(),
          add: async () => undefined,
          remove,
          loadAgentPrompt: async () => "",
          forFinding: () => ({ drafted: true, pending: false }),
        }}
        placement={withoutViews("session-a")}
        onReveal={vi.fn()}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", {
        name: "Remove note at src/a.ts:1 from drafts",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Remove finding at src/a.ts:1 from drafts",
      }),
    );

    expect(remove.mock.calls.map(([entry]) => entry.kind)).toEqual([
      "note",
      "finding",
    ]);
  });
});
