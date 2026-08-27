import { describe, expect, it } from "vitest";

import {
  deriveCheckReasons,
  evaluateMergeReadiness,
} from "../../src/domain/merge-readiness";

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

// Every axis except the checks summary held at its non-blocking value, so a
// blocker in these cases can only have come from the checks rules.
const neutral = {
  isCurrentHead: true,
  isOpen: true,
  isDraft: false,
  mergeability: "mergeable" as const,
  hasGitHubReviewBlocker: false,
  hasRequestChanges: false,
  hasHighSeverityFinding: false,
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

  it("treats an unclassified check as neutral and blocks only on a required check that has not passed", () => {
    const unclassified = {
      name: "unit",
      required: "unknown" as const,
      status: "completed" as const,
    };
    // GitHub did not say whether this check is required. Per ADR 0027 that is
    // an undeterminable state, not a failure, so it must not block on its own.
    expect(
      evaluateMergeReadiness({
        ...neutral,
        checks: {
          overall: "unknown",
          checks: [{ ...unclassified, conclusion: "success" }],
        },
      }),
    ).toMatchObject({ _tag: "Ready", blockers: [] });
    // A required check that has not finished blocks whatever the overall says.
    expect(
      evaluateMergeReadiness({
        ...neutral,
        checks: {
          overall: "pending",
          checks: [{ name: "unit", required: true, status: "in_progress" }],
        },
      }),
    ).toMatchObject({ _tag: "Blocked", blockers: ["required_check"] });
  });

  // The merge gate never passes `hasFailingChecks`, so this pins that a check
  // GitHub does not require cannot refuse a merge, however red it is; the
  // Workbench badge passes it and gets its own, differently named blocker.
  it("blocks on a failing check that is not required only when the caller asks for that signal", () => {
    const redButOptional = {
      overall: "failing" as const,
      checks: [
        {
          name: "lint",
          required: false as const,
          status: "completed" as const,
          conclusion: "failure" as const,
        },
      ],
    };
    expect(
      evaluateMergeReadiness({ ...neutral, checks: redButOptional }),
    ).toEqual({ _tag: "Ready", blockers: [], warnings: [] });
    expect(
      evaluateMergeReadiness({
        ...neutral,
        checks: redButOptional,
        hasFailingChecks: true,
      }),
    ).toEqual({ _tag: "Blocked", blockers: ["failing_check"], warnings: [] });
  });
});

describe("check reasons", () => {
  // The panel and the badge must not disagree about checks. `required_check`
  // is emitted by `evaluateMergeReadiness`; the matching panel text is
  // emitted here. Both read the same predicate, so the two can only ever
  // appear together.
  it("names the required checks that failed and the ones that have not finished", () => {
    expect(
      deriveCheckReasons({
        overall: "pending",
        checks: [
          { name: "unit", required: true, status: "in_progress" },
          {
            name: "lint",
            required: true,
            status: "completed",
            conclusion: "failure",
          },
          {
            name: "docs",
            required: false,
            status: "completed",
            conclusion: "failure",
          },
        ],
      }),
    ).toEqual([
      {
        code: "checks",
        message: "Required check lint did not pass.",
        source: "checks",
        availability: "available",
        openOnGitHub: false,
      },
      {
        code: "checks",
        message: "Required check unit has not finished.",
        source: "checks",
        availability: "available",
        openOnGitHub: false,
      },
    ]);
  });

  // A required context GitHub named but no run ever reported reaches the
  // projection as `status: "unknown"`. That is a known fact about the policy,
  // not an undeterminable state, so it is reported as unfinished rather than
  // as a failure.
  it("reports a required context that never reported as unfinished, not failed", () => {
    expect(
      deriveCheckReasons({
        overall: "pending",
        checks: [{ name: "e2e", required: true, status: "unknown" }],
      }),
    ).toEqual([
      {
        code: "checks",
        message: "Required check e2e has not finished.",
        source: "checks",
        availability: "available",
        openOnGitHub: false,
      },
    ]);
  });

  // A repository with no branch-protection policy answers the protection
  // endpoint with 404, so every check comes back `required: false`. Claiming
  // "required checks have not passed" there asserts a requirement Patchdesk
  // can see is absent, which ADR 0027 forbids.
  it("does not claim a requirement when a red rollup carries nothing required", () => {
    expect(
      deriveCheckReasons({
        overall: "failing",
        checks: [
          {
            name: "lint",
            required: false,
            status: "completed",
            conclusion: "failure",
          },
        ],
      }),
    ).toEqual([
      {
        code: "checks",
        message: "A check on this pull request did not pass.",
        source: "checks",
        availability: "available",
        openOnGitHub: false,
      },
    ]);
  });

  it("says nothing about checks that are green or unclassified", () => {
    expect(
      deriveCheckReasons({
        overall: "passing",
        checks: [
          {
            name: "unit",
            required: true,
            status: "completed",
            conclusion: "success",
          },
        ],
      }),
    ).toEqual([]);
    expect(
      deriveCheckReasons({
        overall: "unknown",
        checks: [{ name: "unit", required: "unknown", status: "queued" }],
      }),
    ).toEqual([]);
  });

  it("lists at most three names and counts the rest", () => {
    expect(
      deriveCheckReasons({
        overall: "pending",
        checks: ["a", "b", "c", "d"].map((name) => ({
          name,
          required: true as const,
          status: "queued" as const,
        })),
      })[0]?.message,
    ).toBe("Required checks a, b, c and 1 more have not finished.");
  });

  // The tripwire, closed by construction: over every check shape the domain
  // types admit, a `required_check` blocker always comes with at least one
  // reason to render under it. Nothing here is hand-picked, so no fixture can
  // silently stop driving the branch it names.
  it("never blocks on required_check without a reason to show", () => {
    const statuses = ["queued", "in_progress", "completed", "unknown"] as const;
    const conclusions = [
      undefined,
      "success",
      "failure",
      "cancelled",
      "timed_out",
      "skipped",
      "neutral",
    ] as const;
    const requireds = [true, false, "unknown"] as const;
    const overalls = [
      "passing",
      "failing",
      "pending",
      "skipped",
      "unknown",
    ] as const;
    let blocked = 0;
    for (const status of statuses)
      for (const conclusion of conclusions)
        for (const required of requireds)
          for (const overall of overalls) {
            const check =
              conclusion === undefined
                ? { name: "unit", required, status }
                : { name: "unit", required, status, conclusion };
            const summary = { overall, checks: [check] };
            const readiness = evaluateMergeReadiness({
              ...neutral,
              checks: summary,
            });
            if (!readiness.blockers.includes("required_check")) continue;
            blocked += 1;
            expect(deriveCheckReasons(summary).length).toBeGreaterThan(0);
          }
    // Guards the loop itself: if the fixture space stopped producing the
    // blocker, every assertion above would vacuously pass.
    expect(blocked).toBeGreaterThan(0);
  });
});
