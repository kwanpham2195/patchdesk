// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useSinceReviewMode } from "../../src/renderer/src/hooks/use-since-review-mode";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import type { SinceReviewDiffResponse } from "../../src/renderer/src/review-diff-contracts";

const head = "b".repeat(40);
const reviewed = "a".repeat(40);

function model(
  reviewCommit: string | undefined,
  commits: ReadonlyArray<string> = [reviewed, head],
): Parameters<typeof useSinceReviewMode>[0]["model"] {
  const entries: WorkbenchResponse["conversation"]["entries"] =
    reviewCommit === undefined
      ? []
      : [
          {
            _tag: "ReviewSummary",
            review: {
              id: "1",
              author: "viewer",
              body: "",
              event: "COMMENTED",
              submittedAt: "2026-08-01T00:00:00.000Z",
              canDismiss: false,
              commitId: reviewCommit,
            },
          },
        ];
  return {
    viewerLogin: "viewer",
    conversation: { prDescription: "", entries },
    commits: commits.map((sha) => ({
      sha,
      message: "Commit",
      author: "author",
      authoredAt: "2026-08-01T00:00:00.000Z",
      isHead: sha === head,
    })),
    revision: {
      reviewedHeadSha: head,
      freshness: "fresh",
      refreshedAt: "2026-08-01T00:00:00.000Z",
    },
  };
}

type Deferred = {
  readonly promise: Promise<SinceReviewDiffResponse>;
  readonly resolve: (value: SinceReviewDiffResponse) => void;
};
function deferred(): Deferred {
  let resolve!: (value: SinceReviewDiffResponse) => void;
  const promise = new Promise<SinceReviewDiffResponse>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("useSinceReviewMode", () => {
  it.each([
    { name: "no review", review: undefined, offered: false, disabled: false },
    {
      name: "a review on the head",
      review: head,
      offered: true,
      disabled: true,
    },
    {
      name: "a force-pushed review commit",
      review: "c".repeat(40),
      offered: true,
      disabled: true,
    },
    {
      name: "a review on an older head",
      review: reviewed,
      offered: true,
      disabled: false,
    },
  ])("offers the option for $name", ({ review, offered, disabled }) => {
    const { result } = renderHook(() =>
      useSinceReviewMode({
        model: model(review),
        commitSliceActive: false,
        loadSinceReviewDiff: vi.fn(),
      }),
    );

    expect(result.current.control !== undefined).toBe(offered);
    expect(result.current.control?.disabledReason !== undefined).toBe(disabled);
  });

  it("ignores a response from an earlier toggle once the mode is re-entered", async () => {
    const stale = deferred();
    const current = deferred();
    const load = vi
      .fn<() => Promise<SinceReviewDiffResponse>>()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);
    const { result } = renderHook(() =>
      useSinceReviewMode({
        model: model(reviewed),
        commitSliceActive: false,
        loadSinceReviewDiff: load,
      }),
    );

    act(() => result.current.control?.onChange(true));
    act(() => result.current.control?.onChange(false));
    act(() => result.current.control?.onChange(true));
    await act(async () => {
      stale.resolve({ baseSha: reviewed, headSha: head, patch: "stale" });
    });
    expect(result.current.state).toEqual({ _tag: "Loading" });

    await act(async () => {
      current.resolve({ baseSha: reviewed, headSha: head, patch: "current" });
    });
    expect(result.current.state).toEqual({ _tag: "Ready", patch: "current" });
  });

  it("fails a response for a different head", async () => {
    const { result } = renderHook(() =>
      useSinceReviewMode({
        model: model(reviewed),
        commitSliceActive: false,
        loadSinceReviewDiff: async () => ({
          baseSha: reviewed,
          headSha: "d".repeat(40),
          patch: "stale",
        }),
      }),
    );

    act(() => result.current.control?.onChange(true));

    await waitFor(() =>
      expect(result.current.state).toEqual({ _tag: "Failed" }),
    );
  });
});
