import type {
  GitHubMergeWriter,
  GitHubReader,
} from "../adapters/github/github-adapter";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { MergeOperationStore } from "../adapters/storage/merge-operation-store";
import {
  parseContentHash,
  parseGitSha,
  parseIsoTimestamp,
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type IsoTimestamp,
} from "../domain/ids";
import {
  confirmMergeOperation,
  markMergeOutcomeUnknown,
  rejectMergeOperation,
  requestMergeOperation,
} from "../domain/merge-operation";
import { markReviewTerminal } from "../domain/review";
import { err, ok, type Result } from "../domain/result";
import { mergePullRequest, type MergeMethod } from "./merge-service";
import { readObjectField } from "./read-object-field";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import type { ReviewWriteGate } from "./review-write-gate";

/** Main-process merge boundary; the renderer supplies only an already-confirmed method and acknowledgement. */
export class MergeWriteController {
  constructor(
    private readonly github: Pick<
      GitHubReader,
      "getMergePolicy" | "getPullRequest" | "getPullRequestDiff"
    > &
      GitHubMergeWriter,
    private readonly methods: ReadonlyArray<MergeMethod>,
    private readonly now: () => IsoTimestamp,
    private readonly operations: MergeOperationStore,
    private readonly writeGate: ReviewWriteGate,
    private readonly reviews: Pick<ReviewStore, "load" | "save">,
    private readonly writeCoordinator: ReviewOperationCoordinator,
  ) {}

  async merge(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the main-process merge route's own I/O boundary parser; readObjectField calls below run immediately and there is no earlier boundary.
    input: unknown,
  ): Promise<Result<unknown, { readonly reason: string }>> {
    const profileId = parseWorkspaceProfileId(
      readObjectField(input, "profileId"),
    );
    const sessionId = parseReviewSessionId(readObjectField(input, "sessionId"));
    const reviewId = parseReviewId(readObjectField(input, "reviewId"));
    const expectedHead = parseGitSha(readObjectField(input, "expectedHeadSha"));
    const expectedBase = parseGitSha(readObjectField(input, "expectedBaseSha"));
    const expectedPatch = parseContentHash(
      readObjectField(input, "expectedPatchHash"),
    );
    const expectedRevision = parseIsoTimestamp(
      readObjectField(input, "expectedRevision"),
    );
    const method = readObjectField(input, "method");
    const acknowledgedWarnings = readObjectField(input, "acknowledgedWarnings");
    if (
      profileId._tag === "err" ||
      sessionId._tag === "err" ||
      reviewId._tag === "err" ||
      expectedHead._tag === "err" ||
      expectedBase._tag === "err" ||
      expectedPatch._tag === "err" ||
      expectedRevision._tag === "err" ||
      !isMethod(method)
    )
      return err({ reason: "invalid_input" });
    const acknowledgement = parseAcknowledgement(
      acknowledgedWarnings,
      expectedHead.value,
      expectedBase.value,
      expectedPatch.value,
    );
    if (acknowledgement === undefined) return err({ reason: "invalid_input" });
    const key = `${profileId.value}:${reviewId.value}`;
    const acquired = this.writeCoordinator.acquire(key);
    if (!acquired) return err({ reason: "merge_in_progress" });
    try {
      const gated = await this.writeGate.requireFresh(
        profileId.value,
        reviewId.value,
        {
          sessionId: sessionId.value,
          headSha: expectedHead.value,
          patchHash: expectedPatch.value,
        },
      );
      if (gated._tag === "err") return err({ reason: gated.error.reason });
      if (
        gated.value.review.representedRemote?.refreshedAt !==
        expectedRevision.value
      )
        return err({ reason: "stale" });
      if (gated.value.session.pr.baseSha !== acknowledgement.revision.baseSha)
        return err({ reason: "stale" });
      const [profile, session] = [
        ok(gated.value.profile),
        ok(gated.value.session),
      ] as const;
      if (profile._tag === "err" || session._tag === "err")
        return err({ reason: "not_found" });
      const startedAt = this.now();
      const requested = requestMergeOperation({
        operationId: `merge-${startedAt.replace(/[^0-9]/g, "")}`,
        profileId: profileId.value,
        reviewId: reviewId.value,
        sessionId: sessionId.value,
        pr: {
          host: session.value.key.host,
          owner: session.value.key.owner,
          repo: session.value.key.repo,
          number: session.value.key.prNumber,
        },
        expectedHeadSha: session.value.key.headSha,
        method,
        acknowledgedWarningCodes: acknowledgement.warningCodes,
        startedAt,
      });
      if (requested._tag === "err") return err({ reason: "invalid_input" });
      const begun = await this.operations.begin(requested.value);
      if (begun._tag === "err")
        return err({
          reason:
            begun.error._tag === "MergeOperationExists"
              ? "merge_outcome_unknown"
              : "storage_failed",
        });
      const unknown = markMergeOutcomeUnknown(requested.value);
      if (
        unknown._tag === "err" ||
        (await this.operations.markOutcomeUnknown(unknown.value))._tag === "err"
      )
        return err({ reason: "storage_failed" });
      const merged = await mergePullRequest({
        profile: profile.value,
        session: session.value,
        gateway: this.github,
        method,
        supportedMethods: this.methods,
        acknowledgedWarningCodes: acknowledgement.warningCodes,
      });
      if (merged._tag === "err") {
        if (merged.error._tag === "GitHubMergeOutcomeUnknown")
          return err({ reason: "merge_outcome_unknown" });
        const rejected = rejectMergeOperation(
          unknown.value,
          mergeReason(merged.error._tag),
        );
        if (rejected._tag === "ok")
          await this.operations.reject(rejected.value);
        return err({ reason: mergeReason(merged.error._tag) });
      }
      const confirmed = confirmMergeOperation(
        unknown.value,
        startedAt,
        merged.value.mergeCommitSha,
      );
      if (
        confirmed._tag === "err" ||
        (await this.operations.confirm(confirmed.value))._tag === "err"
      )
        return err({ reason: "merge_outcome_unknown" });
      const currentReview = await this.reviews.load(
        profileId.value,
        requested.value.reviewId,
      );
      if (currentReview._tag !== "ok")
        return err({ reason: "merge_outcome_unknown" });
      const terminalReview = markReviewTerminal(
        currentReview.value,
        "merged",
        startedAt,
      );
      const savedReview = await this.reviews.save(
        terminalReview,
        currentReview.value.updatedAt,
      );
      if (savedReview._tag === "err")
        return err({ reason: "merge_outcome_unknown" });
      const removed = await this.operations.removeAfterSessionReceipt(
        profileId.value,
        sessionId.value,
      );
      return removed._tag === "ok"
        ? ok({ readiness: merged.value.readiness, review: terminalReview })
        : err({ reason: "merge_outcome_unknown" });
    } finally {
      this.writeCoordinator.release(key);
    }
  }
}

type MergeWarningAcknowledgement = {
  readonly revision: {
    readonly headSha: string;
    readonly baseSha: string;
    readonly patchHash: string;
  };
  readonly warningCodes: ReadonlyArray<
    "request_changes" | "high_severity_finding" | "analysis_finding"
  >;
};

function parseAcknowledgement(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the raw acknowledgement I/O boundary parser; readObjectField calls below run immediately and there is no earlier boundary.
  value: unknown,
  expectedHeadSha: string,
  expectedBaseSha: string,
  expectedPatchHash: string,
): MergeWarningAcknowledgement | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw external input at this exact I/O boundary; no earlier parser exists for this primitive shape.
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const revision = readObjectField(value, "revision");
  const warningCodes = readObjectField(value, "warningCodes");
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field (from readObjectField, typed unknown) at this exact I/O boundary; no earlier parser exists for this primitive shape.
    typeof revision !== "object" ||
    revision === null ||
    Array.isArray(revision) ||
    !Array.isArray(warningCodes) ||
    !warningCodes.every(isMergeWarningCode)
  )
    return undefined;
  const headSha = readObjectField(revision, "headSha");
  const baseSha = readObjectField(revision, "baseSha");
  const patchHash = readObjectField(revision, "patchHash");
  return headSha === expectedHeadSha &&
    baseSha === expectedBaseSha &&
    patchHash === expectedPatchHash
    ? {
        revision: { headSha, baseSha, patchHash },
        warningCodes: [...new Set(warningCodes)].sort(),
      }
    : undefined;
}

function isMergeWarningCode(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the warning-code I/O boundary type guard; there is no earlier boundary to move the parse to.
  value: unknown,
): value is MergeWarningAcknowledgement["warningCodes"][number] {
  return (
    value === "request_changes" ||
    value === "high_severity_finding" ||
    value === "analysis_finding"
  );
}

function isMethod(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the merge-method I/O boundary type guard; there is no earlier boundary to move the parse to.
  value: unknown,
): value is MergeMethod {
  return value === "merge" || value === "squash" || value === "rebase";
}
function mergeReason(tag: string): string {
  return tag === "MergeBlocked"
    ? "merge_blocked"
    : tag === "MergeAcknowledgementRequired"
      ? "merge_acknowledgement_required"
      : tag === "StaleHeadBlocksMerge" || tag === "RevisionChangedBlocksMerge"
        ? "stale_head"
        : tag === "RevisionUnavailableBlocksMerge"
          ? "not_fresh"
          : tag === "GitHubMergeRateLimited"
            ? "merge_rate_limited"
            : "merge_failed";
}
