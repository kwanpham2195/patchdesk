import { useState } from "react";
import { requestJson } from "../api-client";
import { CompletedReviewWorkbench } from "../components/completed-review-workbench";
import { DiffWorkbench } from "../components/diff-workbench";
import { MergeConfirmationDialog } from "../components/merge-confirmation-dialog";
import { ReviewBatchPanel } from "../components/review-batch-panel";
import { SafeRunPanel } from "../components/safe-run-panel";
import type { ReviewBatch } from "../../../domain/review-batch";

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
  if (hash === "#walkthrough-fixture")
    return (
      <WalkthroughFixture onNavigationStateChange={onNavigationStateChange} />
    );
  if (
    hash === "#workbench-fixture" ||
    hash === "#long-workbench-fixture" ||
    hash === "#active-follow-fixture"
  ) {
    const fixture =
      hash === "#long-workbench-fixture"
        ? longWorkbenchFixtureData
        : hash === "#active-follow-fixture"
          ? activeFollowFixtureData
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
        }}
        actions={{
          reportNavigationState: onNavigationStateChange,
        }}
      />
    );
  }
  if (hash === "#submission-fixture") return <SubmissionFixture />;
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

function WalkthroughFixture({
  onNavigationStateChange,
}: {
  readonly onNavigationStateChange: (state: NavigationState) => void;
}): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [lifecycle, setLifecycle] = useState<"idle" | "generating" | "ready">(
    "idle",
  );
  const [model, setModel] = useState<string>();
  const [reasoning, setReasoning] = useState<"low" | "medium" | "high">(
    "medium",
  );
  const [generateRequests, setGenerateRequests] = useState(0);
  const [draftAdded, setDraftAdded] = useState(false);
  const [reviewedSectionIds, setReviewedSectionIds] = useState<
    ReadonlyArray<string>
  >([]);
  const [supportReviewed, setSupportReviewed] = useState(false);
  const walkthrough = {
    snapshot: {
      profileId: "fixture",
      sessionId: "fixture-session",
      headSha: "abcdef1234567890abcdef1234567890abcdef12",
      patchHash: "b".repeat(64),
    },
    title: "Read-only walkthrough fixture",
    focus: "The focused review path remains separate from Files mode.",
    chapters: [
      {
      id: "chapter-1",
      title: "Read first",
        sections: [
          {
        id: "section-1",
        title: "Keep the review local",
            prose:
              "This fixture proves a manual, read-only walkthrough without starting a review run.",
        hunkIds: ["h1"],
            hunks: [
              {
                id: "h1",
                path: "src/a.ts",
                header: "@@ -1 +1 @@",
                raw: "@@ -1 +1 @@\\n-old\\n+new",
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
              },
            ],
          },
          {
        id: "section-2",
        title: "Follow the changed path",
            prose:
              "The chapter rail keeps the next section available without leaving the saved Files surface.",
        hunkIds: ["h2"],
            hunks: [
              {
                id: "h2",
                path: "src/b.ts",
                header: "@@ -1 +1 @@",
                raw: "@@ -1 +1 @@\\n-old\\n+new",
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
              },
            ],
          },
        ],
      },
    ],
    support: {
      id: "support" as const,
      title: "Support" as const,
      hunkIds: ["h3"],
      hunks: [
        {
          id: "h3",
          path: "src/c.ts",
          header: "@@ -1 +1 @@",
          raw: "@@ -1 +1 @@\\n-old\\n+new",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
        },
      ],
    },
  };
  const projection =
    lifecycle === "ready"
      ? {
          lifecycle: "ready" as const,
          noticeKey: "walkthrough-ready" as const,
          walkthrough,
        }
    : lifecycle === "generating"
        ? {
            lifecycle: "generating" as const,
            noticeKey: "walkthrough-generating" as const,
          }
        : {
            lifecycle: "idle" as const,
            noticeKey: "walkthrough-idle" as const,
          };
  const walkthroughActions = {
    dialogOpen,
    projection,
    models: [{ id: "pi-design", label: "Design model" }],
    model,
    reasoning,
    catalogUnavailable: false,
    onOpenDialog: () => setDialogOpen(true),
    onCloseDialog: () => setDialogOpen(false),
    onModelChange: setModel,
    onReasoningChange: setReasoning,
    onConfirm: () => {
      setDialogOpen(false);
      setGenerateRequests((current) => current + 1);
      setLifecycle("generating");
      window.setTimeout(() => setLifecycle("ready"), 50);
    },
    onRetry: () => setLifecycle("generating"),
    onRegenerate: () => setLifecycle("generating"),
    busy: lifecycle === "generating",
    onMarkSectionReviewed: (sectionId: string) =>
      setReviewedSectionIds((current) =>
        current.includes(sectionId) ? current : [...current, sectionId],
      ),
    onMarkSupportReviewed: () => setSupportReviewed(true),
    onSelectSection: () => undefined,
    reviewedSectionIds,
    supportReviewed,
  };
  return (
    <div data-walkthrough-generate-requests={generateRequests}>
      <CompletedReviewWorkbench
        model={{
          source: { profileId: "fixture", sessionId: "fixture-session" },
          result: workbenchFixtureData.result as never,
          reviewScope: { kind: "full" },
          fullPatch: walkthroughFixturePatch,
          comparisonAvailability: "not_requested",
          pullRequest: workbenchFixtureData.pullRequest as never,
          reviewedHeadSha: "abcdef1234567890abcdef1234567890abcdef12",
          freshness: "fresh",
          refreshedAt: "2026-07-17T00:00:00.000Z",
          batch: submissionFixtureData.batch as never,
          comments: workbenchFixtureData.comments as never,
          checks: workbenchFixtureData.checks,
        }}
        actions={{
          reportNavigationState: onNavigationStateChange,
          walkthrough: walkthroughActions as never,
          batchActions: {
            addInlineComment: async () => setDraftAdded(true),
          } as never,
        }}
      />
      {draftAdded ? <p role="status">Draft added to review batch</p> : null}
    </div>
  );
}

export function SubmissionFixture({
  defaultApplyOpen = false,
}: {
  readonly defaultApplyOpen?: boolean;
} = {}): React.JSX.Element {
  const [batch, setBatch] = useState<ReviewBatch>(
    submissionFixtureData.batch as unknown as ReviewBatch,
  );
  return (
    <div className="mx-auto max-w-3xl p-6">
      <ReviewBatchPanel
        batch={batch as never}
        writeBlocked={false}
        defaultApplyOpen={defaultApplyOpen}
        actions={{
          addInlineComment: async () => undefined,
          removeItem: async () => undefined,
          addThreadReply: async () => undefined,
          setThreadState: async () => undefined,
          apply: async () =>
            setBatch((current) => ({
              ...current,
              state: { _tag: "PendingReview" as const, reviewId: "9001" },
            })),
          submit: async (event) =>
            setBatch((current) => ({
              ...current,
              state: { _tag: "Submitted" as const, reviewId: "9001", event },
              suggestedEvent: event,
            })),
        }}
      />
    </div>
  );
}

function RunFixturePanel(): React.JSX.Element {
  const [runId, setRunId] = useState<string>();
  return (
    <SafeRunPanel
      profileId="fixture"
      sessionId="fixture-session"
      attemptId="001"
      recoveryView={{
        noticeKey: "ready_to_review",
        tone: "positive",
        actionKey: "run_review",
      }}
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
const walkthroughFixturePatch = `${fixturePatch}diff --git a/src/c.ts b/src/c.ts\n--- a/src/c.ts\n+++ b/src/c.ts\n@@ -1 +1 @@\n-old\n+new\n`;
const activeFollowFixturePatch = buildActiveFollowPatch();
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

function buildActiveFollowPatch(): string {
  return Array.from({ length: 3 }, (_, fileIndex) => {
    const path = `src/${String.fromCharCode(97 + fileIndex)}.ts`;
    const lines = Array.from(
      { length: 48 },
      (_, lineIndex) =>
        `-old-${fileIndex}-${lineIndex}\n+new-${fileIndex}-${lineIndex}`,
    ).join("\n");
    return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,48 +1,48 @@\n${lines}\n`;
  }).join("");
}

// eslint-disable-next-line react-refresh/only-export-components -- Design reuses this deterministic completed-workbench payload.
export const workbenchFixtureData = {
  fullPatch: fixturePatch,
  pullRequest: {
    ref: {
      host: "github.com",
      owner: "centraldigital",
      repo: "patchdesk",
      number: 42,
    },
    title: "Protect review writes",
    description:
      "## Review path\n\n<details open><summary>Deployment notes</summary><p>Keep this preview readable.</p></details>\n\n```mermaid\ngraph TD\n  A[Open] --> B[Review]\n```",
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
};
const activeFollowFixtureData = {
  ...workbenchFixtureData,
  fullPatch: activeFollowFixturePatch,
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
// eslint-disable-next-line react-refresh/only-export-components -- Design reuses this deterministic submission payload.
export const submissionFixtureData = {
  batch: {
    sessionId: "fixture-session",
    state: { _tag: "Local" as const },
    summaryBody: "Request changes before merge.",
    suggestedEvent: "COMMENT" as const,
    items: [
      {
        _tag: "InlineComment" as const,
        id: "p1" as never,
        provenance: { _tag: "human" as const },
        source: "manual" as const,
        include: true,
        anchor: {
          path: "src/services/review-submission-service.ts" as never,
          startLine: 34,
        line: 34,
          side: "new" as const,
        },
        body: "Keep the stale-head check at the write boundary.",
        postability: "postable",
      },
    ],
    receipts: [],
    createdAt: "2026-07-18T10:00:00.000Z" as never,
    updatedAt: "2026-07-18T10:00:00.000Z" as never,
  },
};
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
