import { useRef, useState } from "react";

import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parsePullRequestNumber,
} from "../../../domain/ids";
import type { MergeReadiness } from "../../../domain/merge-readiness";
import type { PullRequestRef } from "../../../domain/pull-request";
import { PatchdeskApiError, requestJson } from "../api-client";
import type { PullRequestOverviewMerge } from "../components/pr-overview-sheet";
import {
  parseMergeReceipt,
  parseWorkbenchResponse,
  type MergeReceipt,
  type WorkbenchResponse,
} from "../renderer-contracts";
import type { RunDirectCommand } from "./use-review-observation";

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

type MergeConfirmation = {
  readonly state: "confirmed" | "confirmed_refresh_required";
  readonly mergeCommitSha?: string;
};

/** Owns merge eligibility, capability calls, recovery, and terminal reload. */
export function useReviewMergeAction({
  workbench,
  onWorkbenchReplace,
  runDirectCommand,
}: ReviewMergeActionInput): ReviewMergeActionResult {
  const mergeInFlightRef = useRef<Promise<MergeConfirmation> | undefined>(
    undefined,
  );
  const recoveryInFlightRef = useRef<Promise<void> | undefined>(undefined);
  const confirmedRef = useRef<MergeConfirmation | undefined>(undefined);
  const uncertainRef = useRef(false);
  const [confirmedRefreshRequired, setConfirmedRefreshRequired] =
    useState(false);
  const externalPullRequest = pullRequestExternalRef(workbench);
  const mergeActionBase =
    (workbench.review.status === "open" &&
      workbench.revision.freshness === "fresh" &&
      workbench.revision.patchHash !== undefined) ||
    (workbench.review.status === "merged" && confirmedRefreshRequired)
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
          onRecoverMerge: (): Promise<void> => {
            if (recoveryInFlightRef.current !== undefined)
              return recoveryInFlightRef.current;
            const recovery = (async (): Promise<void> => {
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
              if (
                confirmedRef.current !== undefined &&
                next.review.status !== "merged"
              )
                throw new Error("Recovered Review is not terminal");
              if (confirmedRef.current === undefined) {
                uncertainRef.current = false;
              } else {
                confirmedRef.current = {
                  ...confirmedRef.current,
                  state: "confirmed",
                };
                setConfirmedRefreshRequired(false);
              }
              onWorkbenchReplace(next);
            })();
            recoveryInFlightRef.current = recovery;
            void recovery.then(
              () => {
                if (recoveryInFlightRef.current === recovery)
                  recoveryInFlightRef.current = undefined;
              },
              () => {
                if (recoveryInFlightRef.current === recovery)
                  recoveryInFlightRef.current = undefined;
              },
            );
            return recovery;
          },
          onMerge: (
            method: "merge" | "squash" | "rebase",
            warningCodes: ReadonlyArray<string>,
          ): Promise<MergeConfirmation> => {
            if (confirmedRef.current !== undefined)
              return Promise.resolve(confirmedRef.current);
            if (mergeInFlightRef.current !== undefined)
              return mergeInFlightRef.current;
            if (uncertainRef.current)
              return Promise.reject(
                new Error(
                  "GitHub could not confirm the merge; check GitHub status before another merge.",
                ),
              );
            const merge = (async (): Promise<MergeConfirmation> => {
              try {
                const rawReceipt = await runDirectCommand(() =>
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
                const receipt = parseMergeReceipt(rawReceipt);
                if (receipt === undefined)
                  throw new Error(
                    "Patchdesk could not confirm the merge response. Check GitHub status before another merge.",
                  );

                setConfirmedRefreshRequired(true);
                onWorkbenchReplace({
                  ...workbench,
                  review: { ...workbench.review, status: "merged" },
                });
                const receiptFields = mergeCommitFields(receipt);
                try {
                  const refreshed = await requestJson("/v1/reviews/load", {
                    method: "POST",
                    body: {
                      profileId: workbench.session.key.profileId,
                      reviewId: workbench.review.id,
                    },
                  });
                  const next = parseWorkbenchResponse(refreshed);
                  if (next === undefined || next.review.status !== "merged")
                    throw new Error("Invalid terminal Review projection");
                  const confirmation = {
                    state: "confirmed" as const,
                    ...receiptFields,
                  };
                  confirmedRef.current = confirmation;
                  setConfirmedRefreshRequired(false);
                  onWorkbenchReplace(next);
                  return confirmation;
                } catch {
                  const confirmation = {
                    state: "confirmed_refresh_required" as const,
                    ...receiptFields,
                  };
                  confirmedRef.current = confirmation;
                  return confirmation;
                }
              } catch (cause: unknown) {
                if (
                  !(
                    cause instanceof PatchdeskApiError &&
                    cause.kind === "merge_in_progress"
                  )
                )
                  uncertainRef.current = true;
                throw cause;
              }
            })();
            mergeInFlightRef.current = merge;
            void merge.then(
              () => {
                if (mergeInFlightRef.current === merge)
                  mergeInFlightRef.current = undefined;
              },
              () => {
                if (mergeInFlightRef.current === merge)
                  mergeInFlightRef.current = undefined;
              },
            );
            return merge;
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

function mergeCommitFields(receipt: MergeReceipt): {
  readonly mergeCommitSha?: string;
} {
  return receipt.mergeCommitSha === undefined
    ? {}
    : { mergeCommitSha: receipt.mergeCommitSha };
}
