// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopResponse } from "#src/main/ipc-contract";
import { useWalkthroughProgress } from "#src/renderer/src/hooks/use-walkthrough-progress";
import {
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";
import { walkthroughSummary } from "./paged-walkthrough-fixtures";

let desktop: DesktopDouble | undefined;
afterEach(() => {
  desktop?.restore();
  desktop = undefined;
});
const progressPath = "/v1/reviews/insights/walkthrough/reading-progress";

function renderProgress(saved: number[], reviewedSectionIds: string[] = []) {
  return renderHook(() =>
    useWalkthroughProgress({
      profileId: "profile",
      reviewId: "review-42",
      reviewOpen: true,
      summary: {
        ...walkthroughSummary(),
        reviewedCount: reviewedSectionIds.length,
      },
      sections: ["s1", "s2"].map((sectionId) => ({
        sectionId,
        reviewed: reviewedSectionIds.includes(sectionId),
      })),
      onSelectSection: () => undefined,
      onSaved: () => saved.push(1),
    }),
  );
}

describe("useWalkthroughProgress", () => {
  it("marks a section at once and saves a digest/version-fenced intent", async () => {
    desktop = installDesktopDouble({
      [progressPath]: () => success({ version: 1 }),
    });
    const saved: number[] = [];
    const { result } = renderProgress(saved);
    act(() => result.current.toggleSectionReviewed?.("s1"));
    expect(result.current.progress.reviewedSectionIds).toEqual(["s1"]);
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(desktop.request.mock.calls[0]?.[0]).toMatchObject({
      path: progressPath,
      method: "POST",
      body: {
        profileId: "profile",
        reviewId: "review-42",
        digest: "a".repeat(64),
        expectedVersion: 0,
        mutation: { action: "set_reviewed", sectionId: "s1", value: true },
      },
    });
  });

  it("unmarks a reviewed section with one mutation", async () => {
    desktop = installDesktopDouble({
      [progressPath]: () => success({ version: 1 }),
    });
    const saved: number[] = [];
    const { result } = renderProgress(saved, ["s1", "s2"]);
    act(() => result.current.toggleSectionReviewed?.("s1"));
    expect(result.current.progress.reviewedSectionIds).toEqual(["s2"]);
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(desktop.request.mock.calls[0]?.[0]).toMatchObject({
      path: progressPath,
      body: {
        mutation: { action: "set_reviewed", sectionId: "s1", value: false },
      },
    });
  });

  it("serializes saves so an older response cannot overwrite a later intent", async () => {
    const answers: Array<(response: DesktopResponse) => void> = [];
    desktop = installDesktopDouble({
      [progressPath]: () =>
        new Promise<DesktopResponse>((resolve) => answers.push(resolve)),
    });
    const saved: number[] = [];
    const { result } = renderProgress(saved);
    act(() => result.current.toggleSectionReviewed?.("s1"));
    act(() => result.current.toggleSectionReviewed?.("s2"));
    await waitFor(() => expect(answers).toHaveLength(1));
    await act(async () => answers[0]?.(success({ version: 1 })));
    await waitFor(() => expect(answers).toHaveLength(2));
    expect(desktop.request.mock.calls[1]?.[0]).toMatchObject({
      body: { expectedVersion: 1 },
    });
    await act(async () => answers[1]?.(success({ version: 2 })));
    expect(result.current.progress.reviewedSectionIds).toEqual(["s1", "s2"]);
    expect(saved).toHaveLength(2);
  });
});
