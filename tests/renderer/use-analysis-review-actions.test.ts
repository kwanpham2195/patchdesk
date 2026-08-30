// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import type { DesktopResponse } from "../../src/main/ipc-contract";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { useAnalysisReviewActions } from "../../src/renderer/src/flows/use-analysis-review-actions";
import type { RunDirectCommand } from "../../src/renderer/src/flows/use-review-observation";
import {
  failure,
  installDesktopDouble,
  success,
} from "./fake-desktop-response";
import {
  analysisResult,
  callPath,
  patchHash,
  pending,
  sha,
  withAnalysis,
} from "./review-workbench-fixtures";

const COMMAND = "/v1/reviews/pending-review/command";
let restore: (() => void) | undefined;

afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

function confirmedProjection() {
  return {
    state: "pending" as const,
    count: 1,
    review: {
      nodeId: "PRR_1",
      headSha: sha,
      comments: [
        {
          threadId: "PRRT_confirmed",
          body: "Reject invalid values before this branch.",
          path: "src/a.ts",
          startLine: 1,
          line: 1,
          side: "new" as const,
        },
      ],
    },
  };
}

function renderActions(workbench: WorkbenchResponse) {
  const onWorkbenchReplace = vi.fn();
  const runDirectCommand: RunDirectCommand = async (operation) =>
    await operation();
  const rendered = renderHook(() =>
    useAnalysisReviewActions({
      workbench,
      onWorkbenchReplace,
      runDirectCommand,
    }),
  );
  return { ...rendered, onWorkbenchReplace };
}

describe("useAnalysisReviewActions", () => {
  it("keeps both Findings confirmed when cumulative Add receipts settle in reverse order", async () => {
    const first = analysisResult.findings[0];
    if (first === undefined) throw new Error("missing first Finding");
    const second = {
      ...first,
      id: "finding-2",
      lineStart: 2,
      lineEnd: 2,
      title: "Second boundary check",
      suggestedComment: "Reject the second invalid value.",
    };
    const base = withAnalysis("actionable");
    const retained = base.insights.analysis.retained;
    if (retained === undefined) throw new Error("missing analysis fixture");
    const initial = {
      ...base,
      insights: {
        ...base.insights,
        analysis: {
          ...base.insights.analysis,
          retained: {
            ...retained,
            value: {
              ...analysisResult,
              findings: [first, second],
            },
          },
        },
      },
      analysisReviewActions: {
        findings: {
          "finding-1": { state: "actionable" as const },
          "finding-2": { state: "actionable" as const },
        },
        canFinishWithAnalysisSummary: false,
      },
    };
    const responses: Array<(value: DesktopResponse) => void> = [];
    const double = installDesktopDouble({
      "/v1/logs": () => success(null),
      [COMMAND]: () =>
        new Promise<DesktopResponse>((resolve) => responses.push(resolve)),
    });
    restore = double.restore;
    const { result, onWorkbenchReplace } = renderActions(initial);

    let firstRequest!: Promise<void>;
    let secondRequest!: Promise<void>;
    act(() => {
      firstRequest = result.current.addFindingToPendingReview(first);
      secondRequest = result.current.addFindingToPendingReview(second);
    });
    expect(responses).toHaveLength(2);
    const firstComment = confirmedProjection().review.comments[0];
    if (firstComment === undefined) throw new Error("missing comment fixture");
    const secondComment = {
      ...firstComment,
      threadId: "PRRT_second",
      body: second.suggestedComment,
      startLine: 2,
      line: 2,
    };
    await act(async () => {
      responses[1]?.(
        success({
          pendingReview: {
            ...confirmedProjection(),
            count: 2,
            review: {
              ...confirmedProjection().review,
              comments: [firstComment, secondComment],
            },
          },
        }),
      );
      await secondRequest;
      responses[0]?.(success({ pendingReview: confirmedProjection() }));
      await firstRequest;
    });

    const final = onWorkbenchReplace.mock.calls.at(
      -1,
    )?.[0] as WorkbenchResponse;
    expect(final.pendingReview).toMatchObject({ state: "pending", count: 2 });
    expect(final.analysisReviewActions?.findings).toMatchObject({
      "finding-1": { state: "pending_review" },
      "finding-2": { state: "pending_review" },
    });
  });

  it.each([
    [
      "malformed success",
      "session",
      success({ pendingReview: { state: "none" } }),
    ],
    [
      "outcome-unknown failure",
      "session",
      failure({ error: "outcome_unknown" }, 500),
    ],
    [
      "malformed success",
      "patch hash",
      success({ pendingReview: { state: "none" } }),
    ],
    [
      "outcome-unknown failure",
      "patch hash",
      failure({ error: "outcome_unknown" }, 500),
    ],
  ] as const)(
    "ignores obsolete %s after a %s change",
    async (_name, changedScope, response) => {
      let release: (value: DesktopResponse) => void = () => {
        throw new Error("response release was not initialized");
      };
      const deferred = new Promise<DesktopResponse>((resolve) => {
        release = resolve;
      });
      const double = installDesktopDouble({
        "/v1/logs": () => success(null),
        [COMMAND]: () => deferred,
      });
      restore = double.restore;
      const initial = withAnalysis("actionable");
      const next: WorkbenchResponse =
        changedScope === "session"
          ? { ...initial, session: { ...initial.session, id: "session-b" } }
          : {
              ...initial,
              revision: {
                ...initial.revision,
                patchHash: "c".repeat(64),
              },
            };
      const onWorkbenchReplace = vi.fn();
      const runDirectCommand: RunDirectCommand = async (operation) =>
        await operation();
      const rendered = renderHook(
        ({ workbench }: { readonly workbench: WorkbenchResponse }) =>
          useAnalysisReviewActions({
            workbench,
            onWorkbenchReplace,
            runDirectCommand,
          }),
        { initialProps: { workbench: initial } },
      );
      const finding = analysisResult.findings[0];
      if (finding === undefined) throw new Error("missing Finding fixture");
      let request: Promise<void> | undefined;
      act(() => {
        request = rendered.result.current.addFindingToPendingReview(finding);
      });
      rendered.rerender({ workbench: next });
      await act(async () => release(response));
      if (request === undefined) throw new Error("missing Finding request");
      await expect(request).resolves.toBeUndefined();
      expect(onWorkbenchReplace).not.toHaveBeenCalled();
    },
  );

  it("does not overwrite a newer pending projection with a stale lower receipt missing its target", async () => {
    const first = analysisResult.findings[0];
    if (first === undefined) throw new Error("missing Finding");
    const second = {
      ...first,
      id: "finding-2",
      lineStart: 2,
      lineEnd: 2,
      suggestedComment: "Reject the second invalid value.",
    };
    const base = withAnalysis("actionable");
    const retained = base.insights.analysis.retained;
    if (retained === undefined) throw new Error("missing analysis fixture");
    const initial = {
      ...base,
      insights: {
        ...base.insights,
        analysis: {
          ...base.insights.analysis,
          retained: {
            ...retained,
            value: { ...analysisResult, findings: [first, second] },
          },
        },
      },
      analysisReviewActions: {
        findings: {
          "finding-1": { state: "actionable" as const },
          "finding-2": { state: "actionable" as const },
        },
        canFinishWithAnalysisSummary: false,
      },
    };
    let call = 0;
    const firstComment = confirmedProjection().review.comments[0];
    if (firstComment === undefined) throw new Error("missing comment fixture");
    const secondComment = {
      ...firstComment,
      threadId: "PRRT_second",
      body: second.suggestedComment,
      startLine: 2,
      line: 2,
    };
    const double = installDesktopDouble({
      "/v1/logs": () => success(null),
      [COMMAND]: () => {
        call += 1;
        return call === 1
          ? success({ pendingReview: confirmedProjection() })
          : success({
              pendingReview: {
                ...confirmedProjection(),
                review: {
                  ...confirmedProjection().review,
                  comments: [secondComment],
                },
              },
            });
      },
    });
    restore = double.restore;
    const { result, onWorkbenchReplace } = renderActions(initial);
    await act(async () => {
      await result.current.addFindingToPendingReview(first);
      await expect(
        result.current.addFindingToPendingReview(second),
      ).rejects.toThrow(/stale Finding evidence/i);
    });
    const final = onWorkbenchReplace.mock.calls.at(
      -1,
    )?.[0] as WorkbenchResponse;
    expect(final.pendingReview).toMatchObject({ state: "pending", count: 1 });
    expect(final.analysisReviewActions?.findings["finding-2"]?.state).toBe(
      "locked",
    );
  });

  it("applies the exact command projection immediately without reloading the Review", async () => {
    const commandProjection = confirmedProjection();
    const double = installDesktopDouble({
      "/v1/logs": () => success(null),
      [COMMAND]: () => success({ pendingReview: commandProjection }),
    });
    restore = double.restore;
    const initial = withAnalysis("actionable");
    const { result, onWorkbenchReplace } = renderActions(initial);
    const finding = analysisResult.findings[0];
    if (finding === undefined) throw new Error("missing Finding fixture");

    await act(async () => {
      await result.current.addFindingToPendingReview(finding);
    });

    expect(onWorkbenchReplace).toHaveBeenCalledWith({
      ...initial,
      pendingReview: commandProjection,
      analysisReviewActions: {
        findings: { "finding-1": { state: "pending_review" } },
        canFinishWithAnalysisSummary: true,
      },
    });
    expect(double.request.mock.calls.map(([input]) => callPath(input))).toEqual(
      [COMMAND],
    );
    expect(double.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: COMMAND,
        body: expect.objectContaining({
          command: expect.objectContaining({
            _tag: "Start",
            expected: { sessionId: "session-a", headSha: sha, patchHash },
            finding: expect.objectContaining({ findingId: "finding-1" }),
          }),
        }),
      }),
    );
  });

  it("bounds malformed success as recovery-required without optimistic confirmation", async () => {
    const double = installDesktopDouble({
      "/v1/logs": () => success(null),
      [COMMAND]: () =>
        success({
          pendingReview: { ...confirmedProjection(), unexpected: true },
        }),
    });
    restore = double.restore;
    const initial = withAnalysis("actionable");
    const { result, onWorkbenchReplace } = renderActions(initial);
    const finding = analysisResult.findings[0];
    if (finding === undefined) throw new Error("missing Finding fixture");

    await act(async () => {
      await expect(
        result.current.addFindingToPendingReview(finding),
      ).rejects.toThrow(/could not confirm/i);
    });

    expect(onWorkbenchReplace).toHaveBeenCalledWith({
      ...initial,
      pendingReview: { state: "recovery_required", action: "start" },
    });
    expect(
      onWorkbenchReplace.mock.calls.some(
        ([value]) =>
          (value as WorkbenchResponse).analysisReviewActions?.findings[
            "finding-1"
          ]?.state === "pending_review",
      ),
    ).toBe(false);
    expect(double.request).toHaveBeenCalledTimes(1);
  });

  it("keeps deterministic command failure retryable and leaves represented state intact", async () => {
    const double = installDesktopDouble({
      "/v1/logs": () => success(null),
      [COMMAND]: () => failure({ error: "permission_denied" }, 403),
    });
    restore = double.restore;
    const initial = withAnalysis("actionable");
    const { result, onWorkbenchReplace } = renderActions(initial);
    const finding = analysisResult.findings[0];
    if (finding === undefined) throw new Error("missing Finding fixture");

    await act(async () => {
      await expect(
        result.current.addFindingToPendingReview(finding),
      ).rejects.toThrow();
    });

    expect(onWorkbenchReplace).not.toHaveBeenCalled();
  });

  it("locks pending-review mutation after outcome-unknown without confirming evidence", async () => {
    const double = installDesktopDouble({
      "/v1/logs": () => success(null),
      [COMMAND]: () => failure({ error: "outcome_unknown" }, 500),
    });
    restore = double.restore;
    const initial = withAnalysis("actionable");
    const { result, onWorkbenchReplace } = renderActions(initial);
    const finding = analysisResult.findings[0];
    if (finding === undefined) throw new Error("missing Finding fixture");

    await act(async () => {
      await expect(
        result.current.addFindingToPendingReview(finding),
      ).rejects.toThrow();
    });

    expect(onWorkbenchReplace).toHaveBeenLastCalledWith({
      ...initial,
      pendingReview: { state: "recovery_required", action: "start" },
    });
  });

  it("uses a valid recovery projection carried by an outcome-unknown failure", async () => {
    const recovered = confirmedProjection();
    const double = installDesktopDouble({
      "/v1/logs": () => success(null),
      [COMMAND]: () =>
        failure(
          {
            error: "outcome_unknown",
            pendingReview: recovered,
          } satisfies RawJsonValue,
          500,
        ),
    });
    restore = double.restore;
    const initial = withAnalysis("actionable");
    const { result, onWorkbenchReplace } = renderActions(initial);
    const finding = analysisResult.findings[0];
    if (finding === undefined) throw new Error("missing Finding fixture");

    await act(async () => {
      await result.current.addFindingToPendingReview(finding);
    });

    expect(onWorkbenchReplace).toHaveBeenCalledWith({
      ...initial,
      pendingReview: recovered,
      analysisReviewActions: {
        findings: { "finding-1": { state: "pending_review" } },
        canFinishWithAnalysisSummary: true,
      },
    });
  });

  it("rejects a well-shaped projection that does not confirm the requested comment", async () => {
    const double = installDesktopDouble({
      "/v1/logs": () => success(null),
      [COMMAND]: () =>
        success({
          pendingReview: {
            ...confirmedProjection(),
            review: {
              ...confirmedProjection().review,
              comments: [
                {
                  ...confirmedProjection().review.comments[0],
                  body: "A different comment",
                },
              ],
            },
          },
        }),
    });
    restore = double.restore;
    const initial = {
      ...withAnalysis("actionable"),
      pendingReview: pending("none"),
    };
    const { result, onWorkbenchReplace } = renderActions(initial);
    const finding = analysisResult.findings[0];
    if (finding === undefined) throw new Error("missing Finding fixture");

    await act(async () => {
      await expect(
        result.current.addFindingToPendingReview(finding),
      ).rejects.toThrow(/could not confirm/i);
    });

    expect(onWorkbenchReplace).toHaveBeenLastCalledWith({
      ...initial,
      pendingReview: { state: "recovery_required", action: "start" },
    });
  });
});
