import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";

/**
 * Fixture projections and mock-call readers shared by the Review workbench
 * tests: the mounted flow suite (`review-workbench-flow.ui.test.tsx`) and the
 * three hook suites that own its state machines
 * (`use-review-observation.test.ts`, `use-pending-review-actions.test.ts`,
 * `use-direct-summary-actions.test.ts`). One `projection()` keeps the hook
 * tests and the mounted test arguing over the same represented Review.
 */

export const sha = "a".repeat(40);
export const patchHash = "b".repeat(64);

/**
 * A deferred test-control Promise resolver: each call site resolves it with a
 * differently-shaped mocked observation/detection payload, so `unknown` here
 * is the honest type, not an unparsed I/O boundary value.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- see comment above
export type DeferredResolve = (value: unknown) => void;

/**
 * `request.mock.calls` entries are `[requestInput, ...]` where the mocked
 * bridge is always invoked with `{ path, body? }`; these narrow the otherwise
 * untyped mock-call argument to read the fields most assertions need. `body`
 * stays `unknown` on the way out because each test's mocked request carries a
 * differently-shaped body; that is fixture data this generic helper cannot
 * name, not an unparsed I/O boundary value.
 */
export function callPath(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- see comment above
  input: unknown,
): string | undefined {
  // SAFETY: the mocked bridge request is always invoked with an object
  // carrying at least a `path` string; this narrows the untyped mock-call
  // argument to read it.
  return (input as { readonly path?: string } | undefined)?.path;
}

/** Reads the request body off a mock call. See `callPath`. */
export function callBody(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- see comment above callPath
  input: unknown,
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- see comment above callPath
): unknown {
  // SAFETY: same invariant as `callPath` above; `body` is whatever the
  // calling code constructed for that request.
  return (input as { readonly body?: unknown } | undefined)?.body;
}

/** The one canonical open-Review projection every workbench test starts from. */
export function projection(
  overrides: Partial<WorkbenchResponse> = {},
): WorkbenchResponse {
  // SAFETY: this literal matches the `WorkbenchResponse` wire shape the flow
  // under test parses via `parseWorkbenchResponse`; it is fixture data, not a
  // runtime-decoded value.
  return {
    state: "review",
    viewerLogin: "octocat",
    review: { id: "review-42", status: "open" },
    session: {
      id: "session-a",
      key: {
        profileId: "profile",
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        prNumber: 42,
        headSha: sha,
      },
    },
    revision: {
      reviewedHeadSha: sha,
      currentHeadSha: sha,
      freshness: "fresh",
      refreshedAt: "2026-08-01T00:00:00.000Z",
      // SAFETY: `patchHash` is a branded hex-digest fixture; `as never` widens
      // the plain fixture string into the branded PatchHash type.
      patchHash: patchHash as never,
    },
    fullPatch:
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
    pullRequest: {
      ref: {
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        number: 42,
      },
      title: "Canonical workbench",
      author: "fixture",
      headBranch: "feature",
      baseBranch: "main",
      headSha: sha,
      isOpen: true,
      isDraft: false,
      reviewState: "none",
      mergeability: "mergeable",
      labels: [],
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
    commits: [],
    insights: {
      analysis: { status: "not_generated" },
      walkthrough: { status: "not_generated" },
    },
    conversation: { prDescription: "Represented description", entries: [] },
    checks: { overall: "passing", checks: [] },
    mergeReadiness: { _tag: "Ready", blockers: [], warnings: [] },
    mergeReasons: [],
    directSummary: { state: "idle" },
    ...overrides,
  } as WorkbenchResponse;
}

/** One pending-review projection per state the workbench can represent. */
export function pending(
  state: "none" | "pending" | "unavailable" | "recovery_required" = "pending",
): NonNullable<WorkbenchResponse["pendingReview"]> {
  if (state === "none") return { state };
  if (state === "unavailable") return { state, action: "refresh" };
  if (state === "recovery_required") return { state, action: "start" };
  return {
    state,
    count: 1,
    review: {
      nodeId: "PRR_1",
      headSha: sha,
      comments: [
        {
          threadId: "PRRT_1",
          body: "Finding",
          path: "src/a.ts",
          startLine: 1,
          line: 1,
          side: "new",
        },
      ],
    },
  };
}

export const analysisResult = {
  changeSummary: "The current change adds a guarded branch.",
  verdict: "comment" as const,
  summary: "The branch needs a boundary check.",
  findings: [
    {
      id: "finding-1",
      severity: "P1" as const,
      title: "Missing boundary check",
      file: "src/a.ts",
      lineStart: 1,
      lineEnd: 1,
      diffSide: "new" as const,
      explanation: "The added branch accepts an invalid value.",
      suggestedComment: "Reject invalid values before this branch.",
      confidence: "high" as const,
      mappingStatus: "mapped" as const,
    },
  ],
  validationPlan: ["Verify invalid values are rejected."],
  assumptions: [],
};

/** One retained Brief: cited Goal prose, one assumption, resolved labels. */
export const briefValue = {
  snapshot: {
    profileId: "profile",
    sessionId: "session-a",
    headSha: sha,
    patchHash,
  },
  citationStatus: "verified" as const,
  goal: [
    {
      text: "Every live comment write now confirms its outcome with one read-back.",
      citations: [
        {
          alias: "d1",
          kind: "description" as const,
          label: "The first paragraph of the pull request description.",
        },
        {
          alias: "h1",
          kind: "hunk" as const,
          label: "@@ -1 +1 @@",
          path: "src/a.ts",
        },
        {
          alias: "c1",
          kind: "commit" as const,
          label: "c6d5d41 confirm the write before reporting it",
        },
      ],
    },
  ],
  assumptions: [
    {
      text: "No issue is linked, so the Brief names no reporter.",
      demoted: false,
    },
  ],
};

/** The Brief Insight projection every Brief test starts from. */
export function briefInsight(
  overrides: Partial<NonNullable<WorkbenchResponse["insights"]["brief"]>> = {},
): NonNullable<WorkbenchResponse["insights"]["brief"]> {
  return {
    status: "current",
    artifactStatus: "verified",
    retained: {
      runId: "insight-brief-1-fixture",
      sessionId: "session-a",
      headSha: sha,
      generatedAt: "2026-08-01T00:00:00.000Z",
      provenance: {
        provider: "pi",
        model: "fixture-model",
        reasoning: "medium",
      },
      value: briefValue,
    },
    ...overrides,
  };
}

export const providerCatalog = {
  providers: [
    {
      id: "pi",
      label: "Pi",
      available: true,
      guidance: "Available for local review.",
    },
  ],
  models: [
    {
      provider: "pi",
      id: "fixture-model",
      label: "Fixture model",
      reasoning: ["medium"],
      defaultReasoning: "medium",
    },
  ],
};

/** A projection carrying a current Analysis with one Finding in `findingState`. */
export function withAnalysis(
  findingState: "actionable" | "pending_review",
  mappingStatus: "mapped" | "invalid_line" = "mapped",
): WorkbenchResponse {
  // SAFETY: `analysisReviewActions`/`pendingReview` here are wider fixture
  // shapes than the strict unions `projection()`'s parameter type expects;
  // this is fixture data, not a runtime-decoded value.
  return projection({
    insights: {
      analysis: {
        status: "current",
        artifactStatus: "verified",
        retained: {
          runId: "insight-analysis-1-fixture",
          sessionId: "session-a",
          headSha: sha,
          generatedAt: "2026-08-01T00:00:00.000Z",
          value: {
            ...analysisResult,
            findings: analysisResult.findings.map((finding) => ({
              ...finding,
              mappingStatus,
            })),
          },
        },
      },
      walkthrough: { status: "not_generated" },
    },
    analysisReviewActions: {
      findings: { "finding-1": { state: findingState } },
      canFinishWithAnalysisSummary: findingState === "pending_review",
    },
    pendingReview: pending(findingState === "actionable" ? "none" : "pending"),
  } as never);
}
