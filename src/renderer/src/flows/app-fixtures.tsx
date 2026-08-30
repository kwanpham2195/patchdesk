import { DiffWorkbench } from "../components/diff-workbench";
import { CompactMergeCommand } from "../components/compact-merge-command";
import { PullRequestDescription } from "../components/pull-request-description";
import type { MergeReadiness } from "../../../domain/merge-readiness";
import { parsePullRequestInput } from "../../../domain/pull-request";
import type { WorkbenchResponse } from "../renderer-contracts";
import { CanonicalFixtureWorkbench } from "./fixtures/canonical-fixture-workbench";
import type { NavigationState } from "./fixtures/navigation-state";
import {
  fixtureAssigneeActionsCapExceeded,
  fixtureAssigneeActionsDenied,
  fixtureAssigneeActionsReadFailure,
  fixtureAssigneeActionsUnknown,
  fixtureAssigneeActionsWriteFailure,
  fixtureReviewerActionsDenied,
  fixtureReviewerActionsEmpty,
  fixtureReviewerActionsReadFailure,
  fixtureReviewerActionsUnknown,
  fixtureReviewerActionsWriteFailure,
} from "./fixtures/rail-fixture-actions";
import { WalkthroughFixture } from "./fixtures/walkthrough-fixture";
import {
  activeFollowFixtureData,
  fixturePatch,
  longConversationFixtureEntries,
  longWorkbenchFixtureData,
  workbenchFixtureData,
} from "./fixtures/workbench-fixture-data";

type FixtureRenderer = (
  onNavigationStateChange: (state: NavigationState) => void,
) => React.ReactNode;

export function AppFixtureContent({
  hash,
  onNavigationStateChange,
}: {
  readonly hash: string;
  readonly onNavigationStateChange: (state: NavigationState) => void;
}): React.ReactNode {
  const render = fixtureRenderers.get(hash);
  return render === undefined ? undefined : render(onNavigationStateChange);
}

// One entry per fixture hash -- adding a fixture is a one-line addition here
// rather than another branch in a growing if/else chain. `fixture-routes.ts`
// still owns the allow-list (`fixtureHashes`) that gates fixture mode; a hash
// missing there never reaches this lookup. A Map rather than a plain object
// so `AppFixtureContent` needs no key assertion: `Map#get` already answers
// `FixtureRenderer | undefined` for an arbitrary string, which is exactly
// what an unrecognized hash is.
const fixtureRenderers = new Map<string, FixtureRenderer>(
  Object.entries({
    "#mermaid-fixture": () => {
      const parsedPullRequest = parsePullRequestInput(
        "https://github.com/centraldigital/patchdesk/pull/42",
      );
      if (parsedPullRequest._tag === "err")
        throw new Error("Fixture pull request is invalid");
      return (
        <div className="mx-auto max-w-3xl p-6">
          <PullRequestDescription
            markdown={"```mermaid\ngraph TD\n  A[Open] --> B[Review]\n```"}
            pullRequest={parsedPullRequest.value}
          />
        </div>
      );
    },
    "#diff-fixture": () => (
      <DiffWorkbench
        patch={fixturePatch}
        finding={{ file: "src/b.ts", lineStart: 1, diffSide: "new" }}
      />
    ),
    "#walkthrough-fixture": (onNavigationStateChange) => (
      <WalkthroughFixture onNavigationStateChange={onNavigationStateChange} />
    ),
    "#workbench-fixture": (onNavigationStateChange) => (
      <CanonicalFixtureWorkbench
        data={workbenchFixtureData}
        onNavigationStateChange={onNavigationStateChange}
      />
    ),
    "#long-workbench-fixture": (onNavigationStateChange) => (
      <CanonicalFixtureWorkbench
        data={longWorkbenchFixtureData}
        onNavigationStateChange={onNavigationStateChange}
      />
    ),
    "#active-follow-fixture": (onNavigationStateChange) => (
      <CanonicalFixtureWorkbench
        data={activeFollowFixtureData}
        onNavigationStateChange={onNavigationStateChange}
      />
    ),
    "#workbench-empty-labels-fixture": (onNavigationStateChange) => (
      <CanonicalFixtureWorkbench
        data={{
          ...workbenchFixtureData,
          pullRequest: { ...workbenchFixtureData.pullRequest, labels: [] },
        }}
        onNavigationStateChange={onNavigationStateChange}
      />
    ),
    "#workbench-empty-assignees-fixture": (onNavigationStateChange) => (
      <CanonicalFixtureWorkbench
        data={{
          ...workbenchFixtureData,
          pullRequest: { ...workbenchFixtureData.pullRequest, assignees: [] },
        }}
        onNavigationStateChange={onNavigationStateChange}
      />
    ),
    "#workbench-assignees-denied-fixture": (onNavigationStateChange) => (
      <CanonicalFixtureWorkbench
        data={{
          ...workbenchFixtureData,
          pullRequest: { ...workbenchFixtureData.pullRequest, assignees: [] },
        }}
        onNavigationStateChange={onNavigationStateChange}
        assigneeActions={fixtureAssigneeActionsDenied}
      />
    ),
    "#workbench-assignees-unknown-fixture": (onNavigationStateChange) => (
      <CanonicalFixtureWorkbench
        data={{
          ...workbenchFixtureData,
          pullRequest: { ...workbenchFixtureData.pullRequest, assignees: [] },
        }}
        onNavigationStateChange={onNavigationStateChange}
        assigneeActions={fixtureAssigneeActionsUnknown}
      />
    ),
    "#workbench-assignees-write-failure-fixture": (onNavigationStateChange) => (
      <CanonicalFixtureWorkbench
        data={workbenchFixtureData}
        onNavigationStateChange={onNavigationStateChange}
        assigneeActions={fixtureAssigneeActionsWriteFailure}
      />
    ),
    "#workbench-assignees-cap-fixture": (onNavigationStateChange) => (
      <CanonicalFixtureWorkbench
        data={workbenchFixtureData}
        onNavigationStateChange={onNavigationStateChange}
        assigneeActions={fixtureAssigneeActionsCapExceeded}
      />
    ),
    "#workbench-assignees-read-failure-fixture": (onNavigationStateChange) => (
      <CanonicalFixtureWorkbench
        data={workbenchFixtureData}
        onNavigationStateChange={onNavigationStateChange}
        assigneeActions={fixtureAssigneeActionsReadFailure}
      />
    ),
    "#workbench-empty-reviewers-fixture": (onNavigationStateChange) => (
      <CanonicalFixtureWorkbench
        data={{
          ...workbenchFixtureData,
          pullRequest: {
            ...workbenchFixtureData.pullRequest,
            requestedReviewers: [],
          },
        }}
        onNavigationStateChange={onNavigationStateChange}
        reviewerActions={fixtureReviewerActionsEmpty}
      />
    ),
    "#workbench-reviewers-denied-fixture": (onNavigationStateChange) => (
      <CanonicalFixtureWorkbench
        data={workbenchFixtureData}
        onNavigationStateChange={onNavigationStateChange}
        reviewerActions={fixtureReviewerActionsDenied}
      />
    ),
    "#workbench-reviewers-unknown-fixture": (onNavigationStateChange) => (
      <CanonicalFixtureWorkbench
        data={workbenchFixtureData}
        onNavigationStateChange={onNavigationStateChange}
        reviewerActions={fixtureReviewerActionsUnknown}
      />
    ),
    "#workbench-reviewers-write-failure-fixture": (onNavigationStateChange) => (
      <CanonicalFixtureWorkbench
        data={workbenchFixtureData}
        onNavigationStateChange={onNavigationStateChange}
        reviewerActions={fixtureReviewerActionsWriteFailure}
      />
    ),
    "#workbench-reviewers-read-failure-fixture": (onNavigationStateChange) => (
      <CanonicalFixtureWorkbench
        data={workbenchFixtureData}
        onNavigationStateChange={onNavigationStateChange}
        reviewerActions={fixtureReviewerActionsReadFailure}
      />
    ),
    "#workbench-reviewers-pending-fixture": (onNavigationStateChange) => (
      <CanonicalFixtureWorkbench
        data={workbenchFixtureData}
        onNavigationStateChange={onNavigationStateChange}
        modelOverrides={{
          pendingReview: {
            state: "pending",
            count: 3,
            review: {
              nodeId: "PR_fixture_pending",
              headSha: workbenchFixtureData.pullRequest.headSha,
              comments: [],
            },
          },
        }}
      />
    ),
    "#workbench-merged-fixture": (onNavigationStateChange) => (
      <CanonicalFixtureWorkbench
        data={workbenchFixtureData}
        onNavigationStateChange={onNavigationStateChange}
        modelOverrides={{
          review: { id: "fixture-review", status: "merged" },
        }}
      />
    ),
    "#workbench-refresh-unavailable-fixture": (onNavigationStateChange) => (
      <CanonicalFixtureWorkbench
        data={workbenchFixtureData}
        onNavigationStateChange={onNavigationStateChange}
        modelOverrides={{
          revision: {
            reviewedHeadSha: workbenchFixtureData.pullRequest.headSha,
            currentHeadSha: workbenchFixtureData.pullRequest.headSha,
            freshness: "unavailable",
            refreshedAt: "2026-07-17T00:00:00.000Z",
          },
        }}
      />
    ),
    "#workbench-updates-available-fixture": (onNavigationStateChange) => (
      <CanonicalFixtureWorkbench
        data={workbenchFixtureData}
        onNavigationStateChange={onNavigationStateChange}
        modelOverrides={{
          revision: {
            reviewedHeadSha: workbenchFixtureData.pullRequest.headSha,
            currentHeadSha: workbenchFixtureData.pullRequest.headSha,
            freshness: "updates_available",
            refreshedAt: "2026-07-17T00:00:00.000Z",
          },
        }}
      />
    ),
    "#conversation-rail-fixture": (onNavigationStateChange) => (
      <CanonicalFixtureWorkbench
        data={workbenchFixtureData}
        onNavigationStateChange={onNavigationStateChange}
        modelOverrides={{
          conversation: {
            prDescription: "",
            entries: longConversationFixtureEntries,
          },
        }}
      />
    ),
    "#blocked-merge-fixture": (onNavigationStateChange) =>
      renderMergeReadinessFixture(
        "#blocked-merge-fixture",
        onNavigationStateChange,
      ),
    "#acknowledgement-merge-fixture": (onNavigationStateChange) =>
      renderMergeReadinessFixture(
        "#acknowledgement-merge-fixture",
        onNavigationStateChange,
      ),
    "#overview-detail-fixture": (onNavigationStateChange) =>
      renderMergeReadinessFixture(
        "#overview-detail-fixture",
        onNavigationStateChange,
      ),
    "#submission-fixture": () => (
      <p className="p-6 text-sm text-muted-foreground">
        Use the Review workbench to manage a GitHub pending review.
      </p>
    ),
    "#merge-fixture": () => (
      <div className="mx-auto max-w-3xl p-6">
        <CompactMergeCommand
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
          onRecoverMerge={async () => undefined}
          onMerge={async () => ({
            state: "confirmed",
            mergeCommitSha: "abcdef",
          })}
        />
      </div>
    ),
  } satisfies Record<string, FixtureRenderer>),
);

// `#blocked-merge-fixture`, `#acknowledgement-merge-fixture`, and
// `#overview-detail-fixture` share one merge-readiness model shaped three
// ways, so this stays a single function the lookup's three entries call
// rather than three near-duplicate inline renderers.
function renderMergeReadinessFixture(
  hash:
    | "#blocked-merge-fixture"
    | "#acknowledgement-merge-fixture"
    | "#overview-detail-fixture",
  onNavigationStateChange: (state: NavigationState) => void,
): React.ReactNode {
  const blocked = hash === "#blocked-merge-fixture";
  const detail = hash === "#overview-detail-fixture";
  const data =
    hash === "#acknowledgement-merge-fixture"
      ? longWorkbenchFixtureData
      : workbenchFixtureData;
  const readiness: MergeReadiness = blocked
    ? { _tag: "Blocked", blockers: [], warnings: [] }
    : {
        _tag: "NeedsAcknowledgement",
        blockers: [],
        warnings: ["request_changes", "analysis_finding"],
      };
  // SAFETY: `readiness` is a MergeReadiness domain value built two lines
  // above; its `blockers`/`warnings` are readonly arrays of a narrower
  // literal-union blocker/warning code, which the renderer-contract type
  // widens to plain `string[]`. Every element is already a valid member of
  // that wider type, so the cast only relaxes readonly-ness and literal
  // narrowing, not the runtime shape.
  const mergeReadiness = readiness as WorkbenchResponse["mergeReadiness"];
  const mergeReasons = blocked
    ? [
        {
          code: "review_required" as const,
          message: "Approval required by GitHub.",
          source: "github_pr_state" as const,
          availability: "partial" as const,
          openOnGitHub: true,
        },
        {
          code: "checks" as const,
          message: "Required checks have not passed.",
          source: "checks" as const,
          availability: "available" as const,
          openOnGitHub: true,
        },
      ]
    : [];
  const parsedPullRequest = parsePullRequestInput(
    "https://github.com/centraldigital/patchdesk/pull/42",
  );
  if (parsedPullRequest._tag === "err")
    throw new Error("Fixture pull request is invalid");
  return (
    <CanonicalFixtureWorkbench
      data={data}
      onNavigationStateChange={onNavigationStateChange}
      modelOverrides={
        detail
          ? {
              conversation: {
                prDescription: "",
                entries: [
                  {
                    _tag: "ReviewSummary" as const,
                    review: {
                      id: "published-1",
                      author: "fixture-maintainer",
                      body: "Published review body",
                      event: "COMMENTED" as const,
                      submittedAt: "2026-07-17T00:00:00.000Z",
                      canDismiss: false,
                    },
                  },
                ],
              },
            }
          : { mergeReadiness, mergeReasons }
      }
      {...(detail
        ? {}
        : {
            mergeAction: {
              readiness,
              mergeReasons,
              pullRequest: parsedPullRequest.value,
              context: {
                repo: `${data.pullRequest.ref.owner}/${data.pullRequest.ref.repo}`,
                prNumber: data.pullRequest.ref.number,
                title: data.pullRequest.title,
                base: data.pullRequest.baseBranch,
                head: data.pullRequest.headBranch,
                headSha: data.pullRequest.headSha,
              },
              methods: ["squash", "merge", "rebase"] as const,
              onRecoverMerge: async () => undefined,
              onMerge: async () => ({ state: "confirmed" as const }),
            },
          })}
    />
  );
}
