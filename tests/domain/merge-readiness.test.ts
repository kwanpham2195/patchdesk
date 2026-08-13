import { describe, expect, it } from "vitest";

import { evaluateMergeReadiness } from "../../src/domain/merge-readiness";

const passing = {
  overall: "passing" as const,
  checks: [
    {
      name: "unit",
      required: true as const,
      status: "completed" as const,
      conclusion: "success" as const,
    },
  ],
};

describe("merge readiness", () => {
  it("reports all hard blockers and requires acknowledgement for request-changes and P0/P1 warnings", () => {
    expect(
      evaluateMergeReadiness({
        isCurrentHead: false,
        isOpen: false,
        isDraft: true,
        mergeability: "conflicting",
        checks: {
          overall: "failing",
          checks: [
            {
              name: "unit",
              required: true,
              status: "completed",
              conclusion: "failure",
            },
          ],
        },
        hasGitHubReviewBlocker: true,
        hasRequestChanges: true,
        hasHighSeverityFinding: true,
      }),
    ).toEqual({
      _tag: "Blocked",
      blockers: [
        "stale_head",
        "closed",
        "draft",
        "conflicting",
        "required_check",
        "github_review",
      ],
      warnings: ["request_changes", "high_severity_finding"],
    });
    expect(
      evaluateMergeReadiness({
        isCurrentHead: true,
        isOpen: true,
        isDraft: false,
        mergeability: "mergeable",
        checks: passing,
        hasGitHubReviewBlocker: false,
        hasRequestChanges: true,
        hasHighSeverityFinding: true,
      }),
    ).toEqual({
      _tag: "NeedsAcknowledgement",
      blockers: [],
      warnings: ["request_changes", "high_severity_finding"],
    });
  });

  it("does not report GitHub-blocked or unknown mergeability as a conflict", () => {
    expect(
      evaluateMergeReadiness({
        isCurrentHead: true,
        isOpen: true,
        isDraft: false,
        mergeability: "blocked",
        checks: passing,
        hasGitHubReviewBlocker: false,
        hasRequestChanges: false,
        hasHighSeverityFinding: false,
      }),
    ).toEqual({ _tag: "Blocked", blockers: ["merge_blocked"], warnings: [] });
    expect(
      evaluateMergeReadiness({
        isCurrentHead: true,
        isOpen: true,
        isDraft: false,
        mergeability: "unknown",
        checks: passing,
        hasGitHubReviewBlocker: false,
        hasRequestChanges: false,
        hasHighSeverityFinding: false,
      }),
    ).toEqual({
      _tag: "Blocked",
      blockers: ["mergeability_unknown"],
      warnings: [],
    });
  });

  it("applies the configured Analysis policy only to current high-severity findings", () => {
    const base = {
      isCurrentHead: true,
      isOpen: true,
      isDraft: false,
      mergeability: "mergeable" as const,
      checks: passing,
      hasGitHubReviewBlocker: false,
      hasRequestChanges: false,
      hasHighSeverityFinding: false,
      analysisFindingCount: 1,
    };
    expect(
      evaluateMergeReadiness({ ...base, analysisMergePolicy: "advisory" }),
    ).toMatchObject({
      _tag: "NeedsAcknowledgement",
      warnings: ["analysis_finding"],
    });
    expect(
      evaluateMergeReadiness({
        ...base,
        analysisMergePolicy: "require_acknowledgement",
      }),
    ).toMatchObject({
      _tag: "NeedsAcknowledgement",
      warnings: ["analysis_finding"],
    });
    expect(
      evaluateMergeReadiness({
        ...base,
        analysisMergePolicy: "require_acknowledgement",
        analysisAcknowledged: true,
      }),
    ).toMatchObject({ _tag: "Ready" });
    expect(
      evaluateMergeReadiness({ ...base, analysisMergePolicy: "block" }),
    ).toMatchObject({ _tag: "Blocked", blockers: ["analysis_finding"] });
  });

  it("fails closed when required-check classification is unknown", () => {
    expect(
      evaluateMergeReadiness({
        isCurrentHead: true,
        isOpen: true,
        isDraft: false,
        mergeability: "mergeable",
        checks: {
          overall: "unknown",
          checks: [
            {
              name: "unit",
              required: "unknown",
              status: "completed",
              conclusion: "success",
            },
          ],
        },
        hasGitHubReviewBlocker: false,
        hasRequestChanges: false,
        hasHighSeverityFinding: false,
      }),
    ).toMatchObject({ _tag: "Blocked", blockers: ["required_check"] });
  });
});
