import { readFile } from "node:fs/promises";

import {
  parseContentHash,
  parseIsoTimestamp,
  parseRepoRelativePath,
  type ContentHash,
  type FindingId,
  type InsightRunId,
  type IsoTimestamp,
  type ReviewId,
  type WorkspaceProfileId,
} from "#src/domain/ids";
import {
  dismissInsightFinding,
  restoreInsightFinding,
  sameInsightRevision,
  type InsightRecord,
} from "#src/domain/insight-record";
import {
  renderSuggestionCommentBody,
  resolveSuggestionTarget,
} from "#src/domain/finding-suggestion";
import type {
  FindingReviewSource,
  PendingReviewAnchor,
} from "#src/domain/pending-review";
import { err, ok, type Result } from "#src/domain/result";
import {
  parseReviewResult,
  type ReviewResult,
} from "#src/domain/review-result";
import type { ReviewSession } from "#src/domain/review-session";
import type { InsightStore } from "#src/adapters/storage/insight-store";
import type { ReviewSessionStore } from "#src/adapters/storage/review-session-store";
import type { ReviewStore } from "#src/adapters/storage/review-store";
import type { InsightCoordinatorFailure } from "./insight-run-coordinator";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import { contentHash } from "./review-artifact-hash";

/**
 * The one pending-review write a verified Finding suggestion authorizes. The
 * anchor and the body are rebuilt here from the represented patch and the
 * retained Analysis, so no caller decides what reaches GitHub (issue #316).
 */
export type FindingSuggestionCommand = {
  readonly anchor: PendingReviewAnchor;
  readonly body: string;
  readonly finding: FindingReviewSource;
};

/** Names one retained Analysis Finding for a Finding-scoped command. */
export type AnalysisFindingRef = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly runId: InsightRunId;
  readonly findingId: FindingId;
};

/** One retained Analysis Finding, with the revision every Finding command is checked against. */
type CurrentAnalysisFinding = {
  readonly session: ReviewSession;
  readonly patchHash: ContentHash;
  readonly finding: ReviewResult["findings"][number];
};

/**
 * The Finding-scoped commands on a retained Analysis: Dismiss, Restore, and
 * the verified-suggestion command. Each takes the Review lock itself.
 */
export class InsightFindingCommands {
  constructor(
    private readonly reviews: Pick<ReviewStore, "load">,
    private readonly sessions: Pick<ReviewSessionStore, "load">,
    private readonly insights: Pick<InsightStore, "mutate" | "loadTyped">,
    private readonly operations: ReviewOperationCoordinator,
    private readonly now: () => IsoTimestamp,
    private readonly ensureOwned: (
      profileId: WorkspaceProfileId,
      reviewId: ReviewId,
    ) => Promise<Result<void, InsightCoordinatorFailure>>,
  ) {}

  async dismissFinding(
    input: AnalysisFindingRef & { readonly reason: string },
  ): Promise<
    Result<
      { readonly findingId: FindingId; readonly status: "dismissed" },
      InsightCoordinatorFailure
    >
  > {
    return this.operations.withReviewLock(input.profileId, input.reviewId, () =>
      this.changeFindingDismissal(input, "dismissed", (record, at) =>
        dismissInsightFinding(record, input.findingId, input.reason, at),
      ),
    );
  }

  /** Removes a Finding's dismissal under the same checks as Dismiss; the reason is dropped. */
  async restoreFinding(
    input: AnalysisFindingRef,
  ): Promise<
    Result<
      { readonly findingId: FindingId; readonly status: "open" },
      InsightCoordinatorFailure
    >
  > {
    return this.operations.withReviewLock(input.profileId, input.reviewId, () =>
      this.changeFindingDismissal(input, "open", (record, at) =>
        restoreInsightFinding(record, input.findingId, at),
      ),
    );
  }

  /** Dismiss and Restore both require the current retained Analysis, its run ID, and no active run. */
  private async changeFindingDismissal<Status extends "dismissed" | "open">(
    input: AnalysisFindingRef,
    status: Status,
    change: (
      record: InsightRecord<unknown>,
      at: IsoTimestamp,
    ) => Result<InsightRecord<unknown>, "invalid_reason" | "not_available">,
  ): Promise<
    Result<
      { readonly findingId: FindingId; readonly status: Status },
      InsightCoordinatorFailure
    >
  > {
    const current = await this.currentAnalysisFinding(input);
    if (current._tag === "err") return current;
    const timestamp = parseIsoTimestamp(this.now());
    if (timestamp._tag === "err") return err("storage_unavailable");
    const changed = await this.insights.mutate({
      profileId: input.profileId,
      reviewId: input.reviewId,
      type: "analysis",
      now: timestamp.value,
      operation: (record) => {
        const stored = record.retained;
        if (
          record.activeRun !== undefined ||
          stored === undefined ||
          stored.runId !== input.runId
        )
          return err("not_available" as const);
        const parsed = parseReviewResult(stored.value);
        if (
          parsed._tag === "err" ||
          !parsed.value.findings.some(
            (finding) => finding.id === input.findingId,
          )
        )
          return err("not_available" as const);
        return change(record, timestamp.value);
      },
    });
    if (changed._tag === "err") {
      if (changed.error === "invalid_reason") return err("invalid_request");
      if (changed.error === "not_available") return err("not_available");
      return err("storage_unavailable");
    }
    return ok({ findingId: input.findingId, status });
  }

  /**
   * The retained Analysis Finding one Finding-scoped command is about, refused
   * unless the Review still represents the revision that Analysis ran against.
   */
  private async currentAnalysisFinding(
    input: AnalysisFindingRef,
  ): Promise<Result<CurrentAnalysisFinding, InsightCoordinatorFailure>> {
    const ownership = await this.ensureOwned(input.profileId, input.reviewId);
    if (ownership._tag === "err") return ownership;
    const review = await this.reviews.load(input.profileId, input.reviewId);
    if (review._tag === "err") return err("storage_unavailable");
    if (review.value.status._tag === "Terminal") return err("terminal_review");
    const session = await this.sessions.load(
      input.profileId,
      review.value.currentSessionId,
    );
    if (session._tag === "err")
      return err(
        session.error.reason === "not_found"
          ? "not_found"
          : "storage_unavailable",
      );
    const currentHash = parseContentHash(
      await contentHash(session.value.patchPath),
    );
    if (currentHash._tag === "err") return err("storage_unavailable");
    const retained = await this.insights.loadTyped(
      input.profileId,
      input.reviewId,
      "analysis",
      parseReviewResult,
    );
    if (retained._tag === "err")
      return err(
        retained.error.reason === "not_found"
          ? "not_found"
          : "storage_unavailable",
      );
    const retainedRecord = retained.value.retained;
    if (retainedRecord === undefined || retainedRecord.runId !== input.runId)
      return err("not_found");
    if (
      !sameInsightRevision(retainedRecord.revision, {
        sessionId: session.value.id,
        headSha: session.value.key.headSha,
        patchHash: currentHash.value,
      })
    )
      return err("stale_request");
    const finding = retainedRecord.value.findings.find(
      (candidate) => candidate.id === input.findingId,
    );
    if (finding === undefined) return err("not_found");
    return ok({
      session: session.value,
      patchHash: currentHash.value,
      finding,
    });
  }

  /**
   * Rebuilds the GitHub anchor and comment body for one Finding's verified
   * replacement. The caller supplies identity only; the range comes from the
   * represented patch on disk, so a renderer cannot choose what is replaced.
   */
  async resolveFindingSuggestion(
    input: AnalysisFindingRef,
  ): Promise<Result<FindingSuggestionCommand, InsightCoordinatorFailure>> {
    return this.operations.withReviewLock(input.profileId, input.reviewId, () =>
      this.resolveFindingSuggestionUnlocked(input),
    );
  }

  private async resolveFindingSuggestionUnlocked(
    input: AnalysisFindingRef,
  ): Promise<Result<FindingSuggestionCommand, InsightCoordinatorFailure>> {
    const current = await this.currentAnalysisFinding(input);
    if (current._tag === "err") return current;
    const { finding, session } = current.value;
    const code = finding.suggestedReplacement?.code;
    // A Finding without a verified replacement keeps the ordinary comment
    // action; there is no suggestion command to answer with.
    if (code === undefined) return err("not_found");
    const patch = await readPatchText(session.patchPath);
    if (patch === undefined) return err("storage_unavailable");
    const target = resolveSuggestionTarget(patch, finding);
    if (target === undefined) return err("stale_request");
    const path = parseRepoRelativePath(target.path);
    if (path._tag === "err") return err("stale_request");
    return ok({
      anchor: {
        path: path.value,
        startLine: target.startLine,
        line: target.line,
        side: "new",
      },
      body: renderSuggestionCommentBody(
        finding.suggestedComment ?? finding.explanation,
        code,
      ),
      finding: {
        analysisRunId: input.runId,
        findingId: input.findingId,
        sessionId: session.id,
        headSha: session.key.headSha,
        patchHash: current.value.patchHash,
      },
    });
  }
}

/** The represented patch, or undefined when it can no longer be read. */
async function readPatchText(patchPath: string): Promise<string | undefined> {
  try {
    return await readFile(patchPath, "utf8");
  } catch {
    return undefined;
  }
}
