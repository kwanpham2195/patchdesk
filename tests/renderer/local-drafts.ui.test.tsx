// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { AnalysisReader } from "../../src/renderer/src/components/analysis-reader";
import { useLocalDrafts } from "../../src/renderer/src/flows/use-local-drafts";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { installDesktopDouble, success } from "./fake-desktop-response";
import {
  callBody,
  callPath,
  projection,
  withAnalysis,
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
        source: { kind: "working_tree", branch: "main" },
      },
    },
    pullRequest: undefined,
    analysisReviewActions: undefined,
    localDrafts: [],
  } as never);
}

/** The Analysis reader wired to the real Local draft hook, applying its patches the way the workbench does. */
function DraftingReader(): React.JSX.Element | null {
  const [workbench, setWorkbench] = useState(workingTreeReview);
  const localDrafts = useLocalDrafts({
    workbench,
    onWorkbenchPatch: (patch) =>
      setWorkbench(
        (current) => ({ ...current, ...patch }) as WorkbenchResponse,
      ),
  });
  const retained = workbench.insights.analysis.retained;
  if (retained === undefined || localDrafts === undefined) return null;
  return (
    <AnalysisReader
      result={retained.value}
      evidencePatch={workbench.fullPatch ?? ""}
      localDrafts={localDrafts}
    />
  );
}

describe("Local drafts in the Analysis reader", () => {
  it("adds a Finding to draft from its row and removes it from the list", async () => {
    const double = installDesktopDouble({
      [ADD]: () => success({ localDrafts: [drafted] }),
      [REMOVE]: () => success({ localDrafts: [] }),
    });
    restore = double.restore;
    const user = userEvent.setup();
    render(<DraftingReader />);

    await user.click(screen.getByRole("button", { name: "Add to draft" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Remove from draft" }),
      ).toBeTruthy(),
    );
    const list = screen.getByRole("list", { name: "Local drafts" });
    expect(list.textContent).toContain("src/a.ts:1");
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Remove src/a.ts:1 from drafts" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add to draft" })).toBeTruthy(),
    );
    expect(
      double.request.mock.calls.map(([input]) => [
        callPath(input),
        callBody(input),
      ]),
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
});
