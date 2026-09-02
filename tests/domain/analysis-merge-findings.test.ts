import { describe, expect, it } from "vitest";

import {
  analysisMergeInput,
  isAnalysisFindingHandled,
  mergeGateFindings,
} from "../../src/domain/analysis-merge-findings";
import type {
  ContentHash,
  FindingId,
  InsightRunId,
} from "../../src/domain/ids";
import type { FindingReviewReceipt } from "../../src/domain/pending-review";

// SAFETY: fixture ids; the brand marks a parsed safe slug and these are ones.
const firstFindingId = "finding-1" as FindingId;
const secondFindingId = "finding-2" as FindingId;
const runId = "insight-analysis-1-aaaaaaaaaaaa-x" as InsightRunId;
const revision = {
  // SAFETY: fixture identifiers whose runtime shapes match the branded types.
  sessionId: "session-1" as never,
  headSha: "a".repeat(40) as never,
  patchHash: "b".repeat(64) as never,
};

function receipt(
  findingId: FindingId,
  overrides: Partial<FindingReviewReceipt> = {},
): FindingReviewReceipt {
  return {
    analysisRunId: runId,
    findingId,
    ...revision,
    // SAFETY: plain strings already satisfy the branded thread and node id runtime shapes.
    threadId: "thread-1" as never,
    pendingReviewNodeId: "node" as never,
    state: "pending" as const,
    ...overrides,
  };
}

function record(
  findings: ReadonlyArray<{
    id: FindingId;
    severity: "P0" | "P1" | "P2" | "P3";
  }>,
) {
  // SAFETY: cast `as never` because the record stands in for a stored Insight
  // whose only fields this rule reads are the retained run, revision, and findings.
  return {
    schemaVersion: 2,
    reviewId: "review-1",
    type: "analysis",
    nextToken: 1,
    retained: {
      runId,
      revision,
      generatedAt: "2026-01-01T00:00:00.000Z",
      provenance: { provider: "pi", model: "m", reasoning: "medium" },
      value: {
        changeSummary: "",
        verdict: "comment",
        summary: "",
        findings: findings.map((finding) => ({
          ...finding,
          title: "t",
          explanation: "e",
          confidence: "high",
          mappingStatus: "mapped",
        })),
        validationPlan: [],
        assumptions: [],
      },
    },
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as never;
}

describe("isAnalysisFindingHandled", () => {
  it("reads dismissed or added-to-review as handled, and open as not", () => {
    expect(isAnalysisFindingHandled({ disposition: "open" })).toBe(false);
    expect(isAnalysisFindingHandled({})).toBe(false);
    expect(isAnalysisFindingHandled({ disposition: "dismissed" })).toBe(true);
    expect(
      isAnalysisFindingHandled({ disposition: "open", addedToReview: true }),
    ).toBe(true);
  });
});

describe("analysisMergeInput", () => {
  it("lists only open, unreviewed P0/P1 ids for readiness", () => {
    expect(
      analysisMergeInput(
        [
          { id: firstFindingId, severity: "P1", disposition: "open" },
          { id: secondFindingId, severity: "P0", disposition: "dismissed" },
          { id: "finding-3" as FindingId, severity: "P1", addedToReview: true },
          { id: "finding-4" as FindingId, severity: "P2", disposition: "open" },
        ],
        undefined,
      ),
    ).toEqual({ openHighSeverityFindingIds: [firstFindingId] });
  });
});

describe("mergeGateFindings", () => {
  it("marks a Finding added to the review from a receipt for the same run and revision", () => {
    const findings = mergeGateFindings(
      record([
        { id: firstFindingId, severity: "P1" },
        { id: secondFindingId, severity: "P1" },
      ]),
      revision,
      [receipt(firstFindingId)],
    );
    expect(findings.map((f) => [f.id, f.addedToReview])).toEqual([
      [firstFindingId, true],
      [secondFindingId, false],
    ]);
    expect(analysisMergeInput(findings, undefined)).toEqual({
      openHighSeverityFindingIds: [secondFindingId],
    });
  });

  // A receipt proves a thread for one exact Analysis run; a re-run's Finding
  // with the same id is not yet on the review.
  it("ignores a receipt from another run or revision", () => {
    const findings = mergeGateFindings(
      record([{ id: firstFindingId, severity: "P1" }]),
      revision,
      // SAFETY: fixture ids whose runtime shapes match the branded types.
      [
        receipt(firstFindingId, {
          analysisRunId: "insight-analysis-2-bbbbbbbbbbbb-x" as InsightRunId,
        }),
        receipt(firstFindingId, { patchHash: "c".repeat(64) as ContentHash }),
      ],
    );
    expect(findings.map((f) => f.addedToReview)).toEqual([false]);
  });
});
