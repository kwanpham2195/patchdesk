// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import { bridge, restoreBridge } from "./review-workbench-bridge";
import { projection } from "./review-workbench-fixtures";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  restoreBridge();
});

describe("ReviewWorkbenchFlow draft-state action", () => {
  it("routes the author's PR overview action to the draft-state command", async () => {
    const request = bridge(async (input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { updatesAvailable: false };
      if (input.path === "/v1/reviews/draft-state/command")
        return { _tag: "DraftStateChanged", draft: false };
      throw new Error(input.path);
    });
    const pullRequest = projection().pullRequest;
    if (pullRequest === undefined)
      throw new Error("fixture pull request missing");
    render(
      <ReviewWorkbenchFlow
        workbench={projection({
          pullRequest: { ...pullRequest, author: "octocat", isDraft: true },
        })}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={vi.fn()}
        onNavigationStateChange={vi.fn()}
      />,
    );

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Open PR overview: checks passing" }),
    );
    await user.click(screen.getByRole("button", { name: "Ready for review" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/v1/reviews/draft-state/command",
          body: {
            profileId: "profile",
            reviewId: "review-42",
            command: { _tag: "SetDraftState", draft: false },
          },
        }),
      ),
    );
  });
});
