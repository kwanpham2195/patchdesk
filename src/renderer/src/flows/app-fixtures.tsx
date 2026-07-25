import { useState } from "react";
import { requestJson } from "../api-client";
import { CompletedReviewWorkbench } from "../components/completed-review-workbench";
import { DiffWorkbench } from "../components/diff-workbench";
import { MergeConfirmationDialog } from "../components/merge-confirmation-dialog";
import { ReviewSubmissionDialog } from "../components/review-submission-dialog";
import { SafeRunPanel } from "../components/safe-run-panel";

type NavigationState = "clear" | "dirty_draft" | "write_pending";

export function AppFixtureContent({
  hash,
  onNavigationStateChange,
}: {
  readonly hash: string;
  readonly onNavigationStateChange: (state: NavigationState) => void;
}): React.ReactNode {
  if (hash === "#diff-fixture")
    return (
      <DiffWorkbench
        patch={fixturePatch}
        finding={{ file: "src/b.ts", lineStart: 1, diffSide: "new" }}
      />
    );
  if (hash === "#performance-fixture")
    return (
      <DiffWorkbench
        patch={buildLargePatchFixture()}
        finding={{
          file: "src/generated/file-0999.ts",
          lineStart: 1,
          diffSide: "new",
        }}
      />
    );
  if (hash === "#run-fixture")
    return (
      <div className="p-6">
        <RunFixturePanel />
      </div>
    );
  if (hash === "#workbench-fixture" || hash === "#long-workbench-fixture") {
    const fixture =
      hash === "#long-workbench-fixture"
        ? longWorkbenchFixtureData
        : workbenchFixtureData;
    return (
      <CompletedReviewWorkbench
        model={{
          source: { profileId: "fixture", sessionId: "fixture-session" },
          result: fixture.result as never,
          reviewScope: { kind: "full" },
          fullPatch: fixture.fullPatch,
          comparisonAvailability: "not_requested",
          pullRequest: fixture.pullRequest as never,
          reviewedHeadSha: "abcdef1234567890abcdef1234567890abcdef12",
          freshness: "fresh",
          refreshedAt: "2026-07-17T00:00:00.000Z",
          comments: fixture.comments as never,
          checks: fixture.checks,
          history: workbenchFixtureData.history,
        }}
        actions={{
          reportNavigationState: onNavigationStateChange,
        }}
      />
    );
  }
  if (
    hash === "#submission-fixture" ||
    hash === "#submission-rejection-fixture"
  )
    return (
      <div className="mx-auto max-w-3xl p-6">
        <ReviewSubmissionDialog
          draft={submissionFixtureData.draft as never}
          findings={submissionFixtureData.findings as never}
          onCreatePending={async () => {
            if (hash === "#submission-rejection-fixture")
              throw new Error("fixture rejection");
            return { reviewId: "9001" };
          }}
          onSubmitPending={async () => ({ reviewId: "9001" })}
        />
      </div>
    );
  if (hash === "#merge-fixture")
    return (
      <div className="mx-auto max-w-3xl p-6">
        <MergeConfirmationDialog
          readiness={{
            _tag: "NeedsAcknowledgement",
            blockers: [],
            warnings: ["request_changes", "high_severity_finding"],
          }}
          context={{
            repo: "centraldigital/patchdesk",
            prNumber: 42,
            title: "Protect review writes",
            base: "sit",
            head: "feat/review",
            headSha: "abcdef1234567890",
          }}
          methods={["squash", "merge"]}
          onMerge={async () => ({ mergeCommitSha: "abcdef" })}
        />
      </div>
    );
  return undefined;
}

function RunFixturePanel(): React.JSX.Element {
  const [runId, setRunId] = useState<string>();
  return (
    <SafeRunPanel
      profileId="fixture"
      sessionId="fixture-session"
      attemptId="001"
      {...(runId === undefined ? {} : { runId })}
      onStart={async () => {
        const value = await requestJson("/v1/runs/review-pr", {
          method: "POST",
          body: {
            profileId: "fixture",
            sessionId: "fixture-session",
            attemptId: "001",
          },
        });
        if (record(value) && typeof value.runId === "string")
          setRunId(value.runId);
      }}
    />
  );
}

const fixturePatch = buildFixturePatch();
function buildFixturePatch(): string {
  const changedLines = Array.from(
    { length: 48 },
    (_, index) => `-old-${index + 1}\n+new-${index + 1}`,
  ).join("\n");
  return `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,48 +1,48 @@
${changedLines}
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-old
+new
`;
}
function buildLargePatchFixture(): string {
  const files: Array<string> = [];
  const oldLine = `-${"old-value-".padEnd(79, "x")}`;
  const newLine = `+${"new-value-".padEnd(79, "y")}`;
  for (let index = 0; index < 1_000; index += 1) {
    const number = String(index).padStart(4, "0");
    const path = `src/generated/file-${number}.ts`;
    const changes: Array<string> = [];
    for (let line = 0; line < 64; line += 1) changes.push(oldLine, newLine);
    files.push(
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,64 +1,64 @@\n${changes.join("\n")}\n`,
    );
  }
  return files.join("");
}

const workbenchFixtureData = {
  fullPatch: fixturePatch,
  pullRequest: {
    ref: {
      host: "github.com",
      owner: "centraldigital",
      repo: "patchdesk",
      number: 42,
    },
    title: "Protect review writes",
    author: "fixture",
    headBranch: "feat/review",
    baseBranch: "sit",
    headSha: "abcdef1234567890abcdef1234567890abcdef12",
    isOpen: true,
    isDraft: false,
    reviewState: "none",
    mergeability: "mergeable",
    labels: [],
    updatedAt: "2026-07-17T00:00:00.000Z",
  },
  result: {
    changeSummary: "Review completed for Patchdesk workbench",
    verdict: "comment",
    summary: "One mapped finding and one finding that needs manual placement.",
    findings: [
      {
        id: "mapped",
        severity: "P1",
        title: "Keep writes behind the stale-head check",
        file: "src/b.ts",
        lineStart: 1,
        diffSide: "new",
        explanation:
          "A GitHub adapter must never bypass the current head check.",
        suggestedComment: "Keep the stale-head check at the write boundary.",
        confidence: "high",
        mappingStatus: "mapped",
      },
      {
        id: "unmapped",
        severity: "P2",
        title: "Document the manual placement",
        explanation: "This review point has no verified diff coordinate.",
        confidence: "medium",
        mappingStatus: "unmapped",
      },
    ],
    validationPlan: [
      "pnpm test -- --run review-workbench",
      "pnpm test:e2e -- --grep completed-review",
    ],
    assumptions: [
      "The head SHA remains current while this local draft is edited.",
    ],
  },
  editableDraft: {
    sessionId: "fixture-session",
    attemptId: "001",
    state: { _tag: "LocalDraft" },
    summaryBody:
      "One mapped finding and one finding that needs manual placement.",
    suggestedEvent: "COMMENT",
    comments: [
      {
        findingId: "mapped",
        include: true,
        originalSuggestedBody:
          "Keep the stale-head check at the write boundary.",
        body: "Keep the stale-head check at the write boundary.",
        path: "src/b.ts",
        line: 1,
        diffSide: "new",
        postability: "postable",
      },
    ],
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
  },
  comments: {
    threads: [
      {
        id: "thread-1",
        state: "open" as const,
        location: { path: "src/b.ts", line: 1 },
        comments: [
          {
            id: "comment-1",
            author: "reviewer",
            body: "Existing GitHub review comment.",
            createdAt: "2026-07-16T00:00:00.000Z" as never,
            url: "https://github.com/centraldigital/patchdesk/pull/1#discussion_r1",
          },
        ],
      },
    ],
  },
  checks: {
    overall: "failing" as const,
    checks: [
      {
        name: "unit",
        required: true as const,
        status: "completed" as const,
        conclusion: "failure" as const,
        url: "https://github.com/centraldigital/patchdesk/actions/runs/1",
      },
      { name: "docs", required: false as const, status: "queued" as const },
    ],
  },
  history: [
    { id: "001", state: "ReviewCompleted" as const },
    { id: "002", state: "ReviewFailed" as const },
    { id: "003", state: "Stale" as const },
    { id: "004", state: "Discarded" as const },
    { id: "005", state: "Merged" as const },
    { id: "006", state: "IgnoredLateResult" as const },
  ],
};
const longFixturePath =
  "src/features/review-workbench/components/extremely-long-directory-name-without-shortcuts/authoritative-review-write-coordination-and-recovery-surface.ts";
const longFixtureTitle =
  "Protect the authoritative review write boundary when a pull request title contains localized text, identifiers, and enough detail to exceed the available header width";
const longWorkbenchFixtureData = {
  ...workbenchFixtureData,
  fullPatch: `diff --git a/${longFixturePath} b/${longFixturePath}\n--- a/${longFixturePath}\n+++ b/${longFixturePath}\n@@ -1 +1 @@\n-old\n+new\n`,
  pullRequest: {
    ...workbenchFixtureData.pullRequest,
    ref: {
      ...workbenchFixtureData.pullRequest.ref,
      owner: "centraldigital-platform-engineering-maintainers",
      repo: "patchdesk-desktop-review-workbench-with-a-long-repository-name",
    },
    title: longFixtureTitle,
    author: "reviewer-with-a-long-github-handle-for-layout-validation",
    headBranch:
      "feat/CFW-1234-preserve-authoritative-review-coordination-across-desktop-restarts",
    baseBranch: "release/2026-07-operational-readiness-and-accessibility",
  },
  result: {
    ...workbenchFixtureData.result,
    findings: workbenchFixtureData.result.findings.map((finding, index) =>
      index === 0
        ? {
            ...finding,
            file: longFixturePath,
            title:
              "Keep every pending GitHub write attached to the exact authoritative revision even when the finding title is unusually descriptive",
            explanation:
              "This deliberately long explanation proves that detailed review guidance wraps without making the action rail or navigation pane wider than the viewport.",
          }
        : finding,
    ),
    validationPlan: [
      "pnpm test -- --run tests/services/review-write-controller-with-authoritative-revision-and-recovery.test.ts",
      "pnpm test:e2e -- --grep completed-review-long-localized-content-and-responsive-navigation",
      "authoritativeReviewWriteCoordinationAndRecoverySurfaceWithoutNaturalBreakpointsMustRemainReadableInsideTheInspector",
    ],
  },
  comments: {
    threads: workbenchFixtureData.comments.threads.map((thread) => ({
      ...thread,
      location: { path: longFixturePath, line: 1 },
      comments: thread.comments.map((comment) => ({
        ...comment,
        author: "reviewer-with-a-long-github-handle-for-layout-validation",
        body: "Existing GitHub review comment with enough detail to wrap across several lines while retaining the complete author, timestamp, and discussion content for assistive technology.",
      })),
    })),
  },
  checks: {
    ...workbenchFixtureData.checks,
    checks: workbenchFixtureData.checks.checks.map((check, index) =>
      index === 0
        ? {
            ...check,
            name: "required-review-workbench-authoritative-write-and-restart-recovery-validation",
          }
        : check,
    ),
  },
};
const submissionFixtureData = {
  draft: {
    state: { _tag: "LocalDraft" },
    summaryBody: "Request changes before merge.",
    comments: [
      {
        findingId: "p1",
        include: true,
        path: "src/services/review-submission-service.ts",
        line: 34,
        body: "Keep the stale-head check at the write boundary.",
        postability: "postable",
      },
      {
        findingId: "unmapped",
        include: true,
        path: "src/services/review-submission-service.ts",
        line: 55,
        body: "This has no verified GitHub location.",
        postability: "invalid_line",
      },
    ],
  },
  findings: [{ id: "p1", severity: "P1" }],
};
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
