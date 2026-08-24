import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parsePullRequestNumber,
} from "../../../domain/ids";
import type { MergeReadiness } from "../../../domain/merge-readiness";
import type { PullRequestRef } from "../../../domain/pull-request";
import { requestJson } from "../api-client";
import type { PullRequestOverviewMerge } from "../components/pr-overview-sheet";
import {
  parseWorkbenchResponse,
  type WorkbenchResponse,
} from "../renderer-contracts";

type RunDirectCommand = <T>(operation: () => Promise<T>) => Promise<T>;

function pullRequestExternalRef(
  model: WorkbenchResponse,
): PullRequestRef | undefined {
  const host = parseGitHubHost(model.session.key.host);
  const owner = parseGitHubOwner(model.session.key.owner);
  const repo = parseGitHubRepoName(model.session.key.repo);
  const number = parsePullRequestNumber(model.session.key.prNumber);
  if (
    host._tag === "err" ||
    owner._tag === "err" ||
    repo._tag === "err" ||
    number._tag === "err"
  )
    return undefined;
  return {
    host: host.value,
    owner: owner.value,
    repo: repo.value,
    number: number.value,
  };
}

export type ReviewMergeActionInput = {
  readonly workbench: WorkbenchResponse;
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
  readonly runDirectCommand: RunDirectCommand;
};

export type ReviewMergeActionResult = {
  readonly mergeAction: PullRequestOverviewMerge | undefined;
};

/** Owns merge eligibility, capability calls, recovery, and terminal reload. */
export function useReviewMergeAction({
  workbench,
  onWorkbenchReplace,
  runDirectCommand,
}: ReviewMergeActionInput): ReviewMergeActionResult {
  const externalPullRequest = pullRequestExternalRef(workbench);
  const mergeActionBase =
    workbench.review.status === "open" &&
    workbench.revision.freshness === "fresh" &&
    workbench.revision.patchHash !== undefined
      ? {
          // SAFETY: the workbench projection's `mergeReadiness` is the wire
          // serialization of a domain `MergeReadiness` value that only ever
          // originates from `evaluateMergeReadiness`; the wire schema widens
          // `blockers`/`warnings` to `string[]` for forward-compatible
          // parsing, but the emitted values are always drawn from
          // `MergeReadiness`'s literal unions.
          readiness: workbench.mergeReadiness as MergeReadiness,
          context: {
            repo: `${workbench.session.key.owner}/${workbench.session.key.repo}`,
            prNumber: workbench.session.key.prNumber,
            title:
              workbench.pullRequest?.title ??
              `Pull request #${workbench.session.key.prNumber}`,
            base: workbench.pullRequest?.baseBranch ?? "unknown",
            head: workbench.pullRequest?.headBranch ?? "unknown",
            headSha: workbench.revision.reviewedHeadSha,
          },
          methods: ["squash", "merge", "rebase"] as const,
          onRecoverMerge: async () => {
            const recovered = await requestJson("/v1/reviews/merge/recover", {
              method: "POST",
              body: {
                profileId: workbench.session.key.profileId,
                reviewId: workbench.review.id,
              },
            });
            const next = parseWorkbenchResponse(recovered);
            if (next === undefined)
              throw new Error("Invalid recovered Review projection");
            onWorkbenchReplace(next);
          },
          onMerge: async (
            method: "merge" | "squash" | "rebase",
            warningCodes: ReadonlyArray<string>,
          ) => {
            await runDirectCommand(() =>
              requestJson("/v1/reviews/merge", {
                method: "POST",
                body: {
                  profileId: workbench.session.key.profileId,
                  reviewId: workbench.review.id,
                  sessionId: workbench.session.id,
                  expectedHeadSha: workbench.revision.reviewedHeadSha,
                  expectedBaseSha: workbench.pullRequest?.baseSha ?? "",
                  expectedPatchHash: workbench.revision.patchHash,
                  expectedRevision: workbench.revision.refreshedAt,
                  method,
                  acknowledgedWarnings: {
                    revision: {
                      headSha: workbench.revision.reviewedHeadSha,
                      baseSha: workbench.pullRequest?.baseSha ?? "",
                      patchHash: workbench.revision.patchHash,
                    },
                    warningCodes,
                  },
                },
              }),
            );
            const refreshed = await requestJson("/v1/reviews/load", {
              method: "POST",
              body: {
                profileId: workbench.session.key.profileId,
                reviewId: workbench.review.id,
              },
            });
            const next = parseWorkbenchResponse(refreshed);
            if (next === undefined)
              throw new Error("Invalid terminal Review projection");
            onWorkbenchReplace(next);
            return {};
          },
        }
      : undefined;
  const mergeActionWithReasons =
    mergeActionBase === undefined || workbench.mergeReasons === undefined
      ? mergeActionBase
      : { ...mergeActionBase, mergeReasons: workbench.mergeReasons };
  const mergeAction: PullRequestOverviewMerge | undefined =
    mergeActionWithReasons === undefined || externalPullRequest === undefined
      ? mergeActionWithReasons
      : { ...mergeActionWithReasons, pullRequest: externalPullRequest };

  return { mergeAction };
}
