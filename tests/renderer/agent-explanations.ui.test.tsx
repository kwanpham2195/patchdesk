// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { AgentExplanationCard } from "../../src/renderer/src/components/agent-explanation-card";
import { buildAgentExplanationAnnotations } from "../../src/renderer/src/components/review-workbench-annotations";
import { useAgentExplanationDismiss } from "../../src/renderer/src/flows/use-agent-explanation-dismiss";
import type { AgentExplanationEntry } from "../../src/renderer/src/local-draft-contracts";
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
  withoutViews,
} from "./review-workbench-fixtures";

const DISMISS = "/v1/reviews/agent-explanations/dismiss";
let restore: (() => void) | undefined;

afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const explanation: AgentExplanationEntry = {
  explanationId: "explanation-1",
  sessionId: "session-a",
  path: "src/a.ts",
  side: "new",
  startLine: 1,
  line: 1,
  text: "I guessed this timeout.",
  createdAt: "2026-09-30T00:00:00.000Z",
};

/** A local Review's explanation cards, built and wired the way the Diff tab builds them, over the real Dismiss hook. */
function InlineExplanations({
  status,
}: {
  readonly status: WorkbenchResponse["review"]["status"];
}): React.JSX.Element {
  const [workbench, setWorkbench] = useState(() =>
    projection({
      review: { id: "review-42", status },
      agentExplanations: [explanation],
    }),
  );
  const dismiss = useAgentExplanationDismiss({
    workbench,
    runDirectCommand: (operation) => operation(),
    onWorkbenchPatch: (patch) =>
      setWorkbench(
        (current) => ({ ...current, ...patch }) as WorkbenchResponse,
      ),
  });
  return (
    <>
      {buildAgentExplanationAnnotations(
        workbench.agentExplanations ?? [],
        dismiss,
        withoutViews(workbench.session.id),
      ).map((annotation) =>
        annotation.agentExplanation === undefined ? null : (
          <AgentExplanationCard
            key={annotation.id}
            {...annotation.agentExplanation}
          />
        ),
      )}
    </>
  );
}

describe("Agent explanations on a local Review (#665)", () => {
  it("dismisses an explanation, keeping it with the reason when the first Dismiss is refused", async () => {
    const answers = [
      failure({ error: "in_progress" }, 409),
      success({ agentExplanations: [] }),
    ];
    const double = installDesktopDouble({
      [DISMISS]: () => answers.shift() ?? failure({ error: "storage" }, 503),
    });
    restore = double.restore;
    const user = userEvent.setup();
    render(<InlineExplanations status="open" />);
    const card = screen.getByRole("article", {
      name: "Agent explanation on src/a.ts:1",
    });

    await user.click(within(card).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(within(card).getByRole("alert")).toBeDefined());
    await user.click(within(card).getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("article", {
          name: "Agent explanation on src/a.ts:1",
        }),
      ).toBeNull(),
    );

    const dismissed = double.request.mock.calls.flatMap(([input]) =>
      callPath(input) === DISMISS ? [callBody(input)] : [],
    );
    expect(dismissed).toEqual([
      {
        profileId: "profile",
        reviewId: "review-42",
        sessionId: "session-a",
        explanationId: "explanation-1",
      },
      {
        profileId: "profile",
        reviewId: "review-42",
        sessionId: "session-a",
        explanationId: "explanation-1",
      },
    ]);
  });

  it("offers no Dismiss on a merged Review", () => {
    render(<InlineExplanations status="merged" />);

    const card = screen.getByRole("article", {
      name: "Agent explanation on src/a.ts:1",
    });
    expect(within(card).queryByRole("button")).toBeNull();
  });
});
