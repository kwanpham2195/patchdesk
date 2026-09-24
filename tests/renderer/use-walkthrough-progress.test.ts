// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { DesktopResponse } from "../../src/main/ipc-contract";
import { useWalkthroughProgress } from "../../src/renderer/src/hooks/use-walkthrough-progress";
import type { ReviewWorkbenchPatch } from "../../src/renderer/src/flows/use-review-observation";
import {
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";
import { withWalkthrough } from "./review-workbench-fixtures";

let desktop: DesktopDouble | undefined;
afterEach(() => {
  desktop?.restore();
  desktop = undefined;
});

const progressPath = "/v1/reviews/insights/walkthrough/progress";

function renderProgress(patches: ReviewWorkbenchPatch[]) {
  return renderHook(() =>
    useWalkthroughProgress({
      profileId: "profile",
      reviewId: "review-42",
      reviewOpen: true,
      walkthrough: withWalkthrough().insights.walkthrough,
      onWorkbenchPatch: (patch) => patches.push(patch),
    }),
  );
}

describe("useWalkthroughProgress", () => {
  it("marks a section at once, saves the whole progress, and patches the workbench", async () => {
    desktop = installDesktopDouble({
      [progressPath]: () => success({ status: "saved" }),
    });
    const patches: ReviewWorkbenchPatch[] = [];
    const { result } = renderProgress(patches);

    act(() => result.current.markSectionReviewed?.("section-1"));

    expect(result.current.progress.reviewedSectionIds).toEqual(["section-1"]);
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(desktop.request.mock.calls[0]?.[0]).toMatchObject({
      path: progressPath,
      method: "POST",
      body: {
        profileId: "profile",
        reviewId: "review-42",
        runId: "walkthrough-1",
        reviewedSectionIds: ["section-1"],
        supportReviewed: false,
      },
    });
    expect(patches[0]?.insights?.walkthrough).toMatchObject({
      retained: { runId: "walkthrough-1" },
      progress: { reviewedSectionIds: ["section-1"], supportReviewed: false },
    });
  });

  it("does not patch the workbench with an older save that answers last", async () => {
    const answers: Array<(response: DesktopResponse) => void> = [];
    desktop = installDesktopDouble({
      [progressPath]: () =>
        new Promise<DesktopResponse>((resolve) => answers.push(resolve)),
    });
    const patches: ReviewWorkbenchPatch[] = [];
    const { result } = renderProgress(patches);

    act(() => result.current.markSectionReviewed?.("section-1"));
    act(() => result.current.markSupportReviewed?.());
    await waitFor(() => expect(answers).toHaveLength(2));
    await act(async () => answers[1]?.(success({ status: "saved" })));
    await act(async () => answers[0]?.(success({ status: "saved" })));

    expect(patches).toHaveLength(1);
    expect(patches[0]?.insights?.walkthrough?.progress).toEqual({
      reviewedSectionIds: ["section-1"],
      supportReviewed: true,
    });
  });
});
