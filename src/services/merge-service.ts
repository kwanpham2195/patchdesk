import type {
  GitHubMergeWriter,
  GitHubReader,
} from "../adapters/github/github-adapter";
import {
  analysisMergeInput,
  type MergeGateFinding,
} from "../domain/analysis-merge-findings";
import {
  evaluateMergeReadiness,
  type MergeReadiness,
  type MergeWarningCode,
} from "../domain/merge-readiness";
import type { GitSha } from "../domain/ids";
import type { PullRequestRef } from "../domain/pull-request";
import type { ReviewSession } from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import { GitHubRevisionIdentityReader } from "./github-revision-identity-reader";

export type MergeMethod = "merge" | "squash" | "rebase";

type MergeGateway = Pick<
  GitHubReader,
  "getMergePolicy" | "getPullRequest" | "getPullRequestDiff"
> &
  GitHubMergeWriter;

export type MergeFailure =
  | { readonly _tag: "MergeMethodUnsupported" }
  | { readonly _tag: "GitHubMergeReadFailed" }
  | { readonly _tag: "MergeBlocked"; readonly readiness: MergeReadiness }
  | {
      readonly _tag: "MergeAcknowledgementRequired";
      readonly readiness: MergeReadiness;
    }
  | { readonly _tag: "StaleHeadBlocksMerge"; readonly currentHeadSha: GitSha }
  | { readonly _tag: "RevisionChangedBlocksMerge" }
  | { readonly _tag: "RevisionUnavailableBlocksMerge" }
  | { readonly _tag: "GitHubMergeRejected" }
  | { readonly _tag: "GitHubMergeRateLimited" }
  | { readonly _tag: "GitHubMergeForbidden" }
  | { readonly _tag: "GitHubMergeOutcomeUnknown" };

/** Performs one explicit merge only after fresh PR evidence satisfies the selected readiness policy. */
export async function mergePullRequest(input: {
  readonly profile: WorkspaceProfileConfig;
  readonly session: ReviewSession;
  /**
   * The current Analysis Findings, dismissals already applied. Absent means
   * "no current Analysis", not "no Findings were checked" -- the caller reads
   * them with `mergeGateFindings`, which returns nothing for an Analysis that
   * does not belong to the revision being merged.
   */
  readonly result?: {
    readonly findings: ReadonlyArray<MergeGateFinding>;
  };
  readonly gateway: MergeGateway;
  readonly method: MergeMethod;
  readonly supportedMethods: ReadonlyArray<MergeMethod>;
  readonly acknowledgedWarningCodes: ReadonlyArray<MergeWarningCode>;
}): Promise<
  Result<
    { readonly readiness: MergeReadiness; readonly mergeCommitSha?: GitSha },
    MergeFailure
  >
> {
  if (!input.supportedMethods.includes(input.method))
    return err({ _tag: "MergeMethodUnsupported" });

  const pr = sessionPr(input.session);
  const revision = await new GitHubRevisionIdentityReader(input.gateway).read({
    profile: input.profile,
    pr,
    session: input.session,
  });
  if (revision._tag === "err" || revision.value._tag === "Unavailable")
    return err({ _tag: "RevisionUnavailableBlocksMerge" });
  if (revision.value._tag === "Changed")
    return err({ _tag: "RevisionChangedBlocksMerge" });

  // This is the final remote read before the explicit merge request. It binds
  // current readiness to the same immutable head/base pair proved above.
  const policy = await input.gateway.getMergePolicy({
    profile: input.profile,
    pr,
    expectedHeadSha: input.session.key.headSha,
  });
  if (policy._tag === "err") return err({ _tag: "GitHubMergeReadFailed" });
  if (policy.value.headSha !== input.session.key.headSha)
    return err({
      _tag: "StaleHeadBlocksMerge",
      currentHeadSha: policy.value.headSha,
    });
  if (policy.value.baseSha !== revision.value.identity.baseSha)
    return err({ _tag: "RevisionChangedBlocksMerge" });

  const readiness = evaluateMergeReadiness({
    isCurrentHead: true,
    isOpen: policy.value.isOpen,
    isDraft: policy.value.isDraft,
    mergeability: policy.value.complete ? policy.value.mergeability : "unknown",
    checks: policy.value.checks,
    // Only an explicit `review_required` is evidence that a review is
    // outstanding. Per the ADR "Derive merge readiness from applied rules",
    // `reviewDecision` is `null` — mapped to `unknown` — on a repository with
    // no classic required-reviews rule, including one whose pull request
    // already carries a genuine approval, so treating unknown as a blocker
    // would refuse every merge in such a repository.
    hasGitHubReviewBlocker: policy.value.reviewDecision === "review_required",
    hasRequestChanges: policy.value.reviewDecision === "changes_requested",
    // The Workbench merge badge counts the same Findings through the same
    // helper, so a dismissed Finding never separates what the badge offers
    // from what this gate allows.
    ...analysisMergeInput(
      input.result?.findings ?? [],
      input.profile.analysisMergePolicy,
    ),
  });
  if (readiness._tag === "Blocked")
    return err({ _tag: "MergeBlocked", readiness });
  if (
    !sameWarningCodes(
      readiness.warnings.map((warning) => warning.code),
      input.acknowledgedWarningCodes,
    )
  )
    return err({ _tag: "MergeAcknowledgementRequired", readiness });

  // No await occurs between this final canonical revision proof and the explicit merge request.
  const merged = await input.gateway.mergePullRequest({
    profile: input.profile,
    pr,
    headSha: input.session.key.headSha,
    method: input.method,
  });
  if (merged._tag === "err")
    return err({
      _tag:
        merged.error.category === "unavailable"
          ? "GitHubMergeOutcomeUnknown"
          : merged.error.category === "rate_limited"
            ? "GitHubMergeRateLimited"
            : merged.error.category === "forbidden"
              ? "GitHubMergeForbidden"
              : "GitHubMergeRejected",
    });
  const mergeCommitShaField =
    merged.value.mergeCommitSha === undefined
      ? {}
      : { mergeCommitSha: merged.value.mergeCommitSha };
  return ok({ readiness, ...mergeCommitShaField });
}

function sameWarningCodes(
  expected: ReadonlyArray<MergeWarningCode>,
  actual: ReadonlyArray<MergeWarningCode>,
): boolean {
  return (
    [...new Set(expected)].sort().join("\n") ===
    [...new Set(actual)].sort().join("\n")
  );
}

function sessionPr(session: ReviewSession): PullRequestRef {
  return {
    host: session.key.host,
    owner: session.key.owner,
    repo: session.key.repo,
    number: session.key.prNumber,
  };
}
