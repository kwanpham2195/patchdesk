// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DesktopResponse,
  LocalApiDesktopRequest,
} from "../../src/main/ipc-contract";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import {
  useAddAllFindings,
  type AddAllFindingsOutcome,
} from "../../src/renderer/src/flows/use-add-all-findings";
import {
  useAnalysisReviewActions,
  type FindingAddResult,
} from "../../src/renderer/src/flows/use-analysis-review-actions";
import type { RunDirectCommand } from "../../src/renderer/src/flows/use-review-observation";
import {
  failure,
  installDesktopDouble,
  success,
} from "./fake-desktop-response";
import { analysisResult, sha, withAnalysis } from "./review-workbench-fixtures";

const COMMAND = "/v1/reviews/pending-review/command";
let restore: (() => void) | undefined;

afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

type SentCommand = {
  readonly command: {
    readonly _tag: string;
    readonly pendingReviewNodeId?: string;
    readonly anchor: {
      readonly path: string;
      readonly startLine: number;
      readonly line: number;
      readonly side: "new" | "old";
    };
    readonly body: string;
    readonly finding: { readonly findingId: string };
  };
};

type HeldRequest = {
  readonly sent: SentCommand;
  readonly respond: (response: DesktopResponse) => void;
};

const baseFinding = analysisResult.findings[0];
if (baseFinding === undefined) throw new Error("missing Finding fixture");
const findings = [1, 2, 3].map((line) => ({
  ...baseFinding,
  id: `finding-${line}`,
  title: `Boundary check ${line}`,
  lineStart: line,
  lineEnd: line,
  suggestedComment: `Reject invalid value ${line}.`,
}));

function threeFindingWorkbench(runId = "insight-analysis-1-fixture") {
  const base = withAnalysis("actionable");
  const retained = base.insights.analysis.retained;
  if (retained === undefined) throw new Error("missing analysis fixture");
  return {
    ...base,
    fullPatch:
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n-a\n-b\n-c\n+x\n+y\n+z\n",
    insights: {
      ...base.insights,
      analysis: {
        ...base.insights.analysis,
        retained: {
          ...retained,
          runId,
          value: { ...analysisResult, findings },
        },
      },
    },
    analysisReviewActions: {
      findings: Object.fromEntries(
        findings.map((finding) => [
          finding.id,
          { state: "actionable" as const },
        ]),
      ),
      canFinishWithAnalysisSummary: false,
    },
  } satisfies WorkbenchResponse;
}

/** Holds every pending-review command until the test answers it. */
function holdCommands() {
  const held: HeldRequest[] = [];
  const comments: Array<Record<string, string | number>> = [];
  const double = installDesktopDouble({
    [COMMAND]: (input: LocalApiDesktopRequest) =>
      new Promise<DesktopResponse>((respond) =>
        // SAFETY: the Finding Add path always posts this command body.
        held.push({ sent: input.body as SentCommand, respond }),
      ),
  });
  restore = double.restore;
  /** Answers one held command the way GitHub confirms a new pending thread. */
  const confirm = (request: HeldRequest | undefined): void => {
    if (request === undefined) throw new Error("no held command");
    const { anchor, body } = request.sent.command;
    comments.push({ threadId: `PRRT_${comments.length + 1}`, body, ...anchor });
    request.respond(
      success({
        pendingReview: {
          state: "pending",
          count: comments.length,
          review: { nodeId: "PRR_1", headSha: sha, comments: [...comments] },
        },
      }),
    );
  };
  return { held, confirm };
}

function renderBatch(workbench: WorkbenchResponse) {
  const onWorkbenchReplace = vi.fn<(next: WorkbenchResponse) => void>();
  const runDirectCommand: RunDirectCommand = async (operation) =>
    await operation();
  const rendered = renderHook(
    (props: { readonly workbench: WorkbenchResponse }) => {
      const { addFindingToPendingReview } = useAnalysisReviewActions({
        workbench: props.workbench,
        onWorkbenchReplace,
        runDirectCommand,
      });
      return useAddAllFindings({
        addFinding: addFindingToPendingReview,
        reviewScope: JSON.stringify([
          props.workbench.session.id,
          props.workbench.revision.reviewedHeadSha,
          props.workbench.revision.patchHash,
          props.workbench.insights.analysis.retained?.runId,
        ]),
      });
    },
    { initialProps: { workbench } },
  );
  const lastWorkbench = (): WorkbenchResponse | undefined =>
    onWorkbenchReplace.mock.calls.at(-1)?.[0];
  return { ...rendered, lastWorkbench };
}

function findingStates(workbench: WorkbenchResponse | undefined) {
  return Object.fromEntries(
    Object.entries(workbench?.analysisReviewActions?.findings ?? {}).map(
      ([id, status]) => [id, status.state],
    ),
  );
}

function startBatch(result: {
  readonly current: ReturnType<typeof useAddAllFindings>;
}): Promise<AddAllFindingsOutcome> {
  let outcome!: Promise<AddAllFindingsOutcome>;
  act(() => {
    outcome = result.current.addAll(findings);
  });
  return outcome;
}

describe("useAddAllFindings", () => {
  it("adds every Finding through the single-Finding path, one write at a time and in order", async () => {
    const { held, confirm } = holdCommands();
    const { result, lastWorkbench } = renderBatch(threeFindingWorkbench());

    const outcome = startBatch(result);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    expect(result.current.progress).toMatchObject({
      done: 0,
      total: 3,
      currentFindingId: "finding-1",
    });
    await act(async () => confirm(held[0]));
    await vi.waitFor(() => expect(held).toHaveLength(2));
    expect(result.current.progress).toMatchObject({
      done: 1,
      currentFindingId: "finding-2",
    });
    await act(async () => confirm(held[1]));
    await vi.waitFor(() => expect(held).toHaveLength(3));
    await act(async () => confirm(held[2]));

    await expect(outcome).resolves.toEqual({ _tag: "completed" });
    expect(
      held.map(({ sent }) => [
        sent.command._tag,
        sent.command.finding.findingId,
        sent.command.pendingReviewNodeId,
      ]),
    ).toEqual([
      ["Start", "finding-1", undefined],
      ["AddThread", "finding-2", "PRR_1"],
      ["AddThread", "finding-3", "PRR_1"],
    ]);
    expect(findingStates(lastWorkbench())).toEqual({
      "finding-1": "pending_review",
      "finding-2": "pending_review",
      "finding-3": "pending_review",
    });
    expect(result.current.progress).toBeUndefined();
  });

  it("stops at a refused write, keeping earlier Findings Added and later ones untouched", async () => {
    const { held, confirm } = holdCommands();
    const { result, lastWorkbench } = renderBatch(threeFindingWorkbench());

    const outcome = startBatch(result);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await act(async () => confirm(held[0]));
    await vi.waitFor(() => expect(held).toHaveLength(2));
    await act(async () =>
      held[1]?.respond(failure({ error: "permission_denied" }, 403)),
    );

    await expect(outcome).resolves.toMatchObject({
      _tag: "failed",
      findingId: "finding-2",
      message: expect.any(String),
    });
    expect(held).toHaveLength(2);
    expect(findingStates(lastWorkbench())).toEqual({
      "finding-1": "pending_review",
      "finding-2": "actionable",
      "finding-3": "actionable",
    });
  });

  it("stops after an outcome-unknown write and leaves the pending review locked for recovery", async () => {
    const { held, confirm } = holdCommands();
    const { result, lastWorkbench } = renderBatch(threeFindingWorkbench());

    const outcome = startBatch(result);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await act(async () => confirm(held[0]));
    await vi.waitFor(() => expect(held).toHaveLength(2));
    await act(async () =>
      held[1]?.respond(failure({ error: "outcome_unknown" }, 500)),
    );

    await expect(outcome).resolves.toMatchObject({
      _tag: "failed",
      findingId: "finding-2",
    });
    expect(held).toHaveLength(2);
    expect(lastWorkbench()?.pendingReview).toMatchObject({
      state: "recovery_required",
      action: "add_thread",
    });
    expect(findingStates(lastWorkbench())["finding-1"]).toBe("pending_review");
  });

  it("finishes the in-flight write after Stop and sends nothing more", async () => {
    const { held, confirm } = holdCommands();
    const { result, lastWorkbench } = renderBatch(threeFindingWorkbench());

    const outcome = startBatch(result);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    act(() => result.current.stop());
    expect(result.current.progress?.stopping).toBe(true);
    await act(async () => confirm(held[0]));

    await expect(outcome).resolves.toEqual({ _tag: "stopped", added: 1 });
    expect(held).toHaveLength(1);
    expect(findingStates(lastWorkbench())["finding-1"]).toBe("pending_review");
    expect(result.current.progress).toBeUndefined();
  });

  it.each([
    [
      "session",
      { session: { ...threeFindingWorkbench().session, id: "session-b" } },
    ],
    [
      "reviewed head",
      {
        revision: {
          ...threeFindingWorkbench().revision,
          reviewedHeadSha: "e".repeat(40),
        },
      },
    ],
    [
      "patch",
      {
        revision: {
          ...threeFindingWorkbench().revision,
          patchHash: "c".repeat(64) as never,
        },
      },
    ],
    [
      "Analysis run",
      {
        insights: threeFindingWorkbench("insight-analysis-2-fixture").insights,
      },
    ],
  ] as const)(
    "stops when the %s changes during a write, without counting that Finding or writing the rest",
    async (_scope, change) => {
      const { held, confirm } = holdCommands();
      const { result, rerender, lastWorkbench } = renderBatch(
        threeFindingWorkbench(),
      );

      const outcome = startBatch(result);
      await vi.waitFor(() => expect(held).toHaveLength(1));
      await act(async () => confirm(held[0]));
      await vi.waitFor(() => expect(held).toHaveLength(2));
      rerender({ workbench: { ...threeFindingWorkbench(), ...change } });
      await act(async () => confirm(held[1]));
      await act(async () => {});

      expect(held).toHaveLength(2);
      await expect(outcome).resolves.toEqual({
        _tag: "review_changed",
        added: 1,
        total: 3,
      });
      expect(findingStates(lastWorkbench())["finding-2"]).not.toBe(
        "pending_review",
      );
      expect(result.current.progress).toBeUndefined();
    },
  );

  it("stops before the next write when the Review changes between writes", async () => {
    const settle: Array<(result: FindingAddResult) => void> = [];
    const addFinding = vi.fn(
      () =>
        new Promise<FindingAddResult>((resolve) => {
          settle.push(resolve);
        }),
    );
    const { result, rerender } = renderHook(
      (props: { readonly reviewScope: string }) =>
        useAddAllFindings({ addFinding, reviewScope: props.reviewScope }),
      { initialProps: { reviewScope: "session-a" } },
    );

    const outcome = startBatch(result);
    await vi.waitFor(() => expect(settle).toHaveLength(1));
    rerender({ reviewScope: "session-b" });
    await act(async () => settle[0]?.("added"));

    expect(addFinding).toHaveBeenCalledTimes(1);
    await expect(outcome).resolves.toEqual({
      _tag: "review_changed",
      added: 1,
      total: 3,
    });
  });
});
