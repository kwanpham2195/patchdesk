import type {
  GitHubMergeWriter,
  GitHubReader,
} from "../adapters/github/github-adapter";
import { evaluateMergeReadiness, type MergeReadiness } from "../domain/merge-readiness";
import type { GitSha, IsoTimestamp } from "../domain/ids";
import type { PullRequestRef } from "../domain/pull-request";
import { markSessionMerged, type ReviewSession } from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";

export type MergeMethod = "merge" | "squash" | "rebase";

type MergeGateway = Pick<GitHubReader, "getMergePolicy"> &
  GitHubMergeWriter;

export type MergeFailure =
  | { readonly _tag: "MergeMethodUnsupported" }
  | { readonly _tag: "GitHubMergeReadFailed" }
  | { readonly _tag: "MergeBlocked"; readonly readiness: MergeReadiness }
  | { readonly _tag: "MergeAcknowledgementRequired"; readonly readiness: MergeReadiness }
  | { readonly _tag: "StaleHeadBlocksMerge"; readonly currentHeadSha: GitSha }
  | { readonly _tag: "GitHubMergeFailed" };

/** Performs one explicit merge only after fresh PR evidence satisfies the selected readiness policy. */
export async function mergePullRequest(input: {
  readonly profile: WorkspaceProfileConfig;
  readonly session: ReviewSession;
  readonly result?: { readonly findings: ReadonlyArray<{ readonly severity: "P0" | "P1" | "P2" | "P3" }> };
  readonly gateway: MergeGateway;
  readonly method: MergeMethod;
  readonly supportedMethods: ReadonlyArray<MergeMethod>;
  readonly acknowledgedWarnings: boolean;
  readonly now: IsoTimestamp;
}): Promise<Result<{ readonly session: ReviewSession; readonly readiness: MergeReadiness }, MergeFailure>> {
  if (!input.supportedMethods.includes(input.method))
    return err({ _tag: "MergeMethodUnsupported" });

  const pr = sessionPr(input.session);
  // This is the final remote read before the explicit merge request. A partial
  // answer is intentionally represented as unknown mergeability and blocks.
  const policy = await input.gateway.getMergePolicy({ profile: input.profile, pr, expectedHeadSha: input.session.key.headSha });
  if (policy._tag === "err") return err({ _tag: "GitHubMergeReadFailed" });
  if (policy.value.headSha !== input.session.key.headSha)
    return err({ _tag: "StaleHeadBlocksMerge", currentHeadSha: policy.value.headSha });

  const readiness = evaluateMergeReadiness({
    isCurrentHead: true,
    isOpen: policy.value.isOpen,
    isDraft: policy.value.isDraft,
    mergeability: policy.value.complete ? policy.value.mergeability : "unknown",
    checks: policy.value.checks,
    hasGitHubReviewBlocker: policy.value.reviewDecision === "review_required" || policy.value.reviewDecision === "unknown",
    hasRequestChanges: policy.value.reviewDecision === "changes_requested",
    hasHighSeverityFinding: (input.result?.findings ?? []).some(
      (finding) => finding.severity === "P0" || finding.severity === "P1",
    ),
    analysisFindingCount: (input.result?.findings ?? []).filter(
      (finding) => finding.severity === "P0" || finding.severity === "P1",
    ).length,
    ...(input.profile.analysisMergePolicy === undefined ? {} : { analysisMergePolicy: input.profile.analysisMergePolicy }),
    analysisAcknowledged: input.acknowledgedWarnings,
  });
  if (readiness._tag === "Blocked") return err({ _tag: "MergeBlocked", readiness });
  if (readiness._tag === "NeedsAcknowledgement" && !input.acknowledgedWarnings)
    return err({ _tag: "MergeAcknowledgementRequired", readiness });

  // No await occurs between this final current-head check and the explicit merge request.
  const merged = await input.gateway.mergePullRequest({
    profile: input.profile,
    pr,
    headSha: input.session.key.headSha,
    method: input.method,
  });
  if (merged._tag === "err") return err({ _tag: "GitHubMergeFailed" });
  const updated = markSessionMerged(input.session, input.now);
  if (updated._tag === "err") return err({ _tag: "GitHubMergeFailed" });
  return ok({
    readiness,
    session: {
      ...updated.value,
      mergeDecision: {
        mergedAt: input.now,
        ...(merged.value.mergeCommitSha === undefined
          ? {}
          : { mergeCommitSha: merged.value.mergeCommitSha }),
      },
    },
  });
}

function sessionPr(session: ReviewSession): PullRequestRef {
  return {
    host: session.key.host,
    owner: session.key.owner,
    repo: session.key.repo,
    number: session.key.prNumber,
  };
}
