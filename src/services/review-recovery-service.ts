import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewArtifactStorage } from "../adapters/storage/review-artifact-storage";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { createReviewId, type IsoTimestamp, type ReviewId, type WorkspaceProfileId } from "../domain/ids";
import { ReviewPreparationJournal } from "./review-preparation-journal";
import { recoverOrphanedWorkbenchAttempt } from "./review-workbench";
import type { ReviewLifecycleGate } from "./review-lifecycle-gate";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";
import type { MergeOperationStore } from "../adapters/storage/merge-operation-store";
import type { MergeOperation } from "../domain/merge-operation";
import type { GitHubReader } from "../adapters/github/github-adapter";
import { markSessionMerged, type ReviewSession } from "../domain/review-session";
import { rejectMergeOperation } from "../domain/merge-operation";
import { createEmptyReviewBatch, type ReviewBatch, type RemoteWriteReceipt, type BatchOperation } from "../domain/review-batch";
import { renderReviewBatchBody } from "./review-submission-service";
import type { GitHubComments, GitHubPublishedFeedback } from "../domain/github-context";
import type { PullRequestRef } from "../domain/pull-request";
import type { ReviewWriteGate } from "./review-write-gate";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";

export type RecoveryDiagnostic = {
  readonly profileId: WorkspaceProfileId;
  readonly entryName: string;
  readonly reason: "invalid_session";
};

/** Reconciles durable recovery evidence once on startup without relaunching work. */
export class ReviewRecoveryService {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly sessions: ReviewSessionStore,
    private readonly now: () => IsoTimestamp,
    private readonly options: {
      readonly paths?: PatchdeskPaths;
      readonly artifacts?: ReviewArtifactStorage;
      readonly recordDiagnostic?: (event: RecoveryDiagnostic) => Promise<void>;
      readonly diagnostics?: Pick<ReviewDiagnosticService, "record">;
      readonly lifecycleGate?: ReviewLifecycleGate;
      /** Stable Review owner used to reject terminal and non-current sessions. */
      readonly reviewGate?: Pick<ReviewWriteGate, "requireCurrentSession">;
      readonly mergeOperations?: Pick<MergeOperationStore, "listPending" | "load" | "removeAfterSessionReceipt" | "reject">;
      readonly operationCoordinator?: ReviewOperationCoordinator;
      /** Read owner for both merge and publication outcome reconciliation. */
      readonly github?: Partial<Pick<GitHubReader, "getMergeOutcome" | "getPullRequestComments" | "getPullRequestPublishedFeedback" | "resolveAuthenticatedAccount">>;
    } = {},
  ) {}

  /**
   * Reconcile one publication without invoking a writer. Unknown evidence is
   * deliberately returned as failed, so the API cannot report success merely
   * because the recovery request itself completed.
   */
  async reconcilePublication(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<{ readonly recovered: number; readonly failed: number }> {
    const operation = () => this.options.operationCoordinator === undefined
      ? this.reconcilePublicationForProfile(profileId, reviewId)
      : this.options.operationCoordinator.withReviewLock(profileId, reviewId, () => this.reconcilePublicationForProfile(profileId, reviewId));
    const result = this.options.lifecycleGate === undefined
      ? await operation()
      : await this.options.lifecycleGate.withProfileLock(profileId, operation);
    return result;
  }

  /** Quarantine invalid entries and convert owned-process-less attempts to Interrupted. */
  /** Reconcile this Review's durable merge and publication evidence. */
  async reconcileReview(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<{ readonly recovered: number; readonly failed: number }> {
    const operation = async () => {
      const current = this.options.reviewGate === undefined
        ? undefined
        : await this.options.reviewGate.requireCurrentSession(profileId, reviewId);
      if (current?._tag === "err") {
        return { recovered: 0, failed: current.error.reason === "storage" ? 1 : 0 };
      }
      const merge = await this.reconcileMergeOperations(
        profileId,
        current?._tag === "ok" ? current.value.session.id : undefined,
      );
      const publication = await this.reconcilePublicationForProfile(profileId, reviewId);
      return {
        recovered: merge.recovered + publication.recovered,
        failed: merge.failed + publication.failed,
      };
    };
    const withReviewLock = () => this.options.operationCoordinator === undefined
      ? operation()
      : this.options.operationCoordinator.withReviewLock(profileId, reviewId, operation);
    return this.options.lifecycleGate === undefined
      ? await withReviewLock()
      : await this.options.lifecycleGate.withProfileLock(profileId, withReviewLock);
  }

  /** Quarantine invalid entries and convert owned-process-less attempts to Interrupted. */
  async reconcile(): Promise<{ readonly recovered: number; readonly failed: number }> {
    const profiles = await this.profiles.list();
    if (profiles._tag === "err") return { recovered: 0, failed: 1 };
    let recovered = 0;
    let failed = 0;
    for (const profile of profiles.value) {
      const result = this.options.lifecycleGate === undefined
        ? await this.reconcileProfile(profile.id)
        : await this.options.lifecycleGate.withProfileLock(profile.id, () => this.reconcileProfile(profile.id));
      recovered += result.recovered;
      failed += result.failed;
    }
    return { recovered, failed };
  }

  private async recordDiagnostic(event: RecoveryDiagnostic): Promise<void> {
    if (this.options.diagnostics !== undefined) {
      await this.options.diagnostics.record({
        profileId: event.profileId,
        category: "recovery",
        phase: event.reason,
        retryable: true,
        detail: event.entryName,
      });
      return;
    }
    if (this.options.recordDiagnostic !== undefined) {
      await this.options.recordDiagnostic(event);
      return;
    }
    if (this.options.paths === undefined) return;
    const root = this.options.paths.profileReviewsDirectory(event.profileId);
    try {
      await mkdir(root, { recursive: true });
      await appendFile(
        join(root, "diagnostics.jsonl"),
        `${JSON.stringify({ at: this.now(), kind: event.reason, entryName: event.entryName.slice(0, 160) })}\n`,
        "utf8",
      );
    } catch {
      // Invalid evidence remains quarantined even if diagnostics cannot be written.
    }
  }

  private async reconcilePublicationForProfile(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<{ readonly recovered: number; readonly failed: number }> {
    const profile = await this.profiles.load(profileId);
    if (profile._tag === "err") return { recovered: 0, failed: 1 };
    const owned = this.options.reviewGate === undefined
      ? undefined
      : await this.options.reviewGate.requireCurrentSession(profileId, reviewId);
    if (owned?._tag === "err") {
      // Missing Review ownership is expected before first-run migration. It
      // must not fall back to session-key recovery or mutate legacy state.
      return { recovered: 0, failed: owned.error.reason === "terminal" || owned.error.reason === "stale" || owned.error.reason === "not_found" ? 0 : 1 };
    }
    let session: ReviewSession | undefined;
    if (owned?._tag === "ok") {
      session = owned.value.session;
    } else {
      const scanned = await this.sessions.scanSessionEntries(profileId);
      if (scanned._tag === "err") return { recovered: 0, failed: 1 };
      session = scanned.value.sessions.find((candidate) => createReviewId(candidate.key) === reviewId);
    }
    if (session === undefined) return { recovered: 0, failed: 0 };
    return this.reconcilePublicationSession(profile.value, session);
  }

  /** Reconcile a specific stored session without changing its ownership. */
  private async reconcilePublicationSession(
    profile: WorkspaceProfileConfig,
    session: ReviewSession,
  ): Promise<{ readonly recovered: number; readonly failed: number }> {
    if (session.batchContent === undefined) return { recovered: 0, failed: 0 };
    const batch = session.batchContent;
    if (batch.state._tag === "Submitted") {
      // The submit marker is durable before the successor replacement. A
      // storage failure at that final boundary must therefore be repaired
      // locally, without requiring another GitHub read or write.
      const nextSession = installSuccessorDraft(session, batch, this.now());
      const saved = await this.sessions.save(nextSession);
      return saved._tag === "ok" ? { recovered: 1, failed: 0 } : { recovered: 0, failed: 1 };
    }
    const reader = this.options.github;
    if (reader === undefined) return { recovered: 0, failed: 1 };
    const state = batch.state;
    if (state._tag !== "Applying" && !(state._tag === "PartialFailure" && (state.failure.category === "outcome_unknown" || state.failure.category === "unavailable"))) return { recovered: 0, failed: 0 };
    const pr: PullRequestRef = { host: session.key.host, owner: session.key.owner, repo: session.key.repo, number: session.key.prNumber };
    const [comments, publishedFeedback] = await Promise.all([
      reader.getPullRequestComments === undefined
        ? Promise.resolve({ _tag: "ok" as const, value: { threads: [], complete: true } as GitHubComments })
        : reader.getPullRequestComments({ profile, pr }),
      reader.getPullRequestPublishedFeedback === undefined
        ? Promise.resolve(undefined)
        : reader.getPullRequestPublishedFeedback({ profile, pr }),
    ]);
    if (comments._tag === "err" || comments.value.complete === false || (publishedFeedback !== undefined && (publishedFeedback._tag === "err" || publishedFeedback.value.complete === false))) {
      return { recovered: 0, failed: 1 };
    }
    // Submission reconciliation requires GitHub's authenticated identity, not
    // merely the configured account string. Missing identity proof fails closed.
    const requiresAuthorProof = state.operation._tag === "Reply" || state.operation._tag === "SubmitPendingReview";
    const authenticatedAccount = requiresAuthorProof
      ? reader.resolveAuthenticatedAccount === undefined
        ? undefined
        : await reader.resolveAuthenticatedAccount(profile)
      : undefined;
    if (requiresAuthorProof && (authenticatedAccount === undefined || authenticatedAccount._tag === "err")) return { recovered: 0, failed: 1 };
    const evidence = publicationEvidence(
      batch,
      state.operation,
      comments.value,
      publishedFeedback === undefined ? undefined : publishedFeedback.value,
      authenticatedAccount?._tag === "ok" ? authenticatedAccount.value.account : profile.ghAccount,
    );
    if (evidence === undefined) return { recovered: 0, failed: 1 };
    const receipts = hasReceiptForOperation(batch, state.operation)
      ? batch.receipts
      : [...batch.receipts, evidence.receipt];
    const nextBatch = nextReconciledBatch(batch, receipts, evidence.submitted);
    const nextSession: typeof session = evidence.submitted === undefined
      ? {
          ...session,
          batch: { state: nextBatch.state },
          batchContent: nextBatch,
          updatedAt: this.now(),
        }
      : (() => {
          // Reconciliation is a successful publication boundary: retain the
          // ordered receipts as evidence, then make a distinct empty draft
          // available for subsequent local feedback.
          return installSuccessorDraft({ ...session, submittedReview: evidence.submitted }, { ...batch, receipts }, this.now());
        })();
    const saved = await this.sessions.save(nextSession);
    return saved._tag === "ok" ? { recovered: 1, failed: 0 } : { recovered: 0, failed: 1 };
  }

  private async reconcileMergeOperations(
    profileId: WorkspaceProfileId,
    sessionId?: ReviewSession["id"],
  ): Promise<{ readonly recovered: number; readonly failed: number }> {
    if (this.options.mergeOperations === undefined || this.options.github?.getMergeOutcome === undefined) {
      return { recovered: 0, failed: 0 };
    }
    const pending = sessionId === undefined
      ? await this.options.mergeOperations.listPending(profileId)
      : await this.options.mergeOperations.load(profileId, sessionId).then((operation) =>
          operation._tag === "ok"
            ? { _tag: "ok" as const, value: [operation.value] }
            : operation.error.reason === "not_found"
              ? { _tag: "ok" as const, value: [] }
              : operation,
        );
    if (pending._tag === "err") return { recovered: 0, failed: 1 };
    const profile = await this.profiles.load(profileId);
    if (profile._tag === "err") return { recovered: 0, failed: 1 };
    let recovered = 0;
    let failed = 0;
    for (const operation of pending.value) {
      const result = await this.reconcileMergeOperation(profile.value, operation);
      recovered += result.recovered;
      failed += result.failed;
    }
    return { recovered, failed };
  }

  private async reconcileMergeOperation(
    profile: WorkspaceProfileConfig,
    operation: MergeOperation,
  ): Promise<{ readonly recovered: number; readonly failed: number }> {
    const outcome = await this.options.github?.getMergeOutcome?.({ profile, pr: operation.pr });
    if (outcome === undefined || outcome._tag === "err") return { recovered: 0, failed: 1 };
    if (outcome.value.state === "merged") {
      const session = await this.sessions.load(operation.profileId, operation.sessionId);
      if (session._tag === "err") return { recovered: 0, failed: 1 };
      const merged = markSessionMerged(session.value, outcome.value.mergedAt);
      if (merged._tag === "err") return { recovered: 0, failed: 1 };
      const saved = await this.sessions.save({
        ...merged.value,
        mergeDecision: {
          mergedAt: outcome.value.mergedAt,
          ...(outcome.value.mergeCommitSha === undefined ? {} : { mergeCommitSha: outcome.value.mergeCommitSha }),
        },
      });
      if (saved._tag === "err") return { recovered: 0, failed: 1 };
      const removed = await this.options.mergeOperations?.removeAfterSessionReceipt(operation.profileId, operation.sessionId);
      return removed?._tag === "ok" ? { recovered: 1, failed: 0 } : { recovered: 0, failed: 1 };
    }
    const rejected = rejectMergeOperation(operation, outcome.value.state === "open" ? "merge_failed" : "merge_blocked");
    if (rejected._tag === "err") return { recovered: 0, failed: 1 };
    const saved = await this.options.mergeOperations?.reject(rejected.value);
    return saved?._tag === "ok" ? { recovered: 1, failed: 0 } : { recovered: 0, failed: 1 };
  }

  private async reconcileProfile(
    profileId: WorkspaceProfileId,
  ): Promise<{ readonly recovered: number; readonly failed: number }> {
    const merge = await this.reconcileMergeOperations(profileId);
    const scan = await this.sessions.scanSessionEntries(profileId);
    if (scan._tag === "err") {
      if (this.options.diagnostics !== undefined) {
        await this.options.diagnostics.record({
          profileId,
          category: "migration",
          phase: "session-scan",
          retryable: true,
          detail: "Review session migration could not scan local entries safely.",
        });
      }
      return { recovered: 0, failed: 1 };
    }
    let recovered = merge.recovered;
    let failed = merge.failed;
    // Recovery owns each legacy session's durable publication evidence. Do not
    // resolve through the stable Review pointer here: a newer session can be
    // current while an older session still has a Submitted or Applying batch.
    // The explicit reconcilePublication API retains its current-session gate.
    const canReadPublication = this.options.github?.getPullRequestComments !== undefined || this.options.github?.getPullRequestPublishedFeedback !== undefined;
    const eligible = scan.value.sessions.filter((session) => {
      const state = session.batchContent?.state;
      return state?._tag === "Submitted" || (canReadPublication && (
        state?._tag === "Applying" ||
        (state?._tag === "PartialFailure" && (state.failure.category === "outcome_unknown" || state.failure.category === "unavailable"))
      ));
    });
    if (eligible.length > 0) {
      const profile = await this.profiles.load(profileId);
      if (profile._tag === "err") return { recovered, failed: failed + 1 };
      for (const session of eligible) {
        const publication = await this.reconcilePublicationSession(profile.value, session);
        recovered += publication.recovered;
        failed += publication.failed;
      }
    }
    for (const invalid of scan.value.invalidEntries) {
      await this.recordDiagnostic({ profileId, entryName: invalid.entryName, reason: "invalid_session" });
      if (this.options.artifacts === undefined) {
        failed += 1;
        continue;
      }
      const quarantined = invalid.sessionId === undefined
        ? await this.options.artifacts.quarantineInvalidEntry(profileId, invalid.entryName)
        : await this.options.artifacts.quarantine(profileId, invalid.sessionId);
      if (quarantined._tag === "ok") {
        recovered += 1;
      } else {
        failed += 1;
        await this.options.diagnostics?.record({
          profileId,
          category: "migration",
          phase: "quarantine-failed",
          retryable: true,
          detail: "Invalid local review evidence could not be quarantined safely.",
        });
      }
    }
    for (const session of scan.value.sessions) {
      if (this.options.paths !== undefined) {
        const active = await ReviewPreparationJournal.activeFor(this.options.paths, profileId, session.id, this.options.diagnostics);
        if (active._tag === "err") {
          failed += 1;
          if (this.options.diagnostics !== undefined) {
            await this.options.diagnostics.record({
              profileId,
              sessionId: session.id,
              category: "recovery",
              phase: "preparation-active-read",
              retryable: true,
              detail: "Preparation state could not be reconciled safely.",
            });
          }
          continue;
        }
        if (active.value !== undefined) continue;
      }
      if (session.state._tag !== "Running" || session.currentAttemptId === undefined) continue;
      const attempt = await this.sessions.loadAttempt(profileId, session.id, session.currentAttemptId);
      if (attempt._tag === "err") {
        failed += 1;
        if (this.options.diagnostics !== undefined) {
          await this.options.diagnostics.record({
            profileId,
            sessionId: session.id,
            category: "migration",
            phase: "attempt-reconcile",
            retryable: true,
            detail: "A stored review attempt could not be reconciled safely.",
          });
        }
        continue;
      }
      const result = recoverOrphanedWorkbenchAttempt({ session, attempt: attempt.value, recoveredAt: this.now() });
      if (result._tag === "err") {
        failed += 1;
        await this.options.diagnostics?.record({
          profileId,
          sessionId: session.id,
          category: "migration",
          phase: "attempt-recover",
          retryable: true,
          detail: "A stored review attempt could not be marked interrupted safely.",
        });
        continue;
      }
      const attemptSaved = await this.sessions.saveAttempt(profileId, session.id, result.value.attempt);
      if (attemptSaved._tag === "err") {
        failed += 1;
        await this.options.diagnostics?.record({
          profileId,
          sessionId: session.id,
          category: "migration",
          phase: "attempt-save",
          retryable: true,
          detail: "An interrupted review attempt could not be persisted.",
        });
        continue;
      }
      const sessionSaved = await this.sessions.save(result.value.session);
      if (sessionSaved._tag === "ok") {
        recovered += 1;
      } else {
        failed += 1;
        await this.options.diagnostics?.record({
          profileId,
          sessionId: session.id,
          category: "migration",
          phase: "session-save",
          retryable: true,
          detail: "The reconciled review session could not be persisted.",
        });
      }
    }
    return { recovered, failed };
  }
}

function installSuccessorDraft(session: ReviewSession, batch: ReviewBatch, createdAt: IsoTimestamp): ReviewSession {
  const archivedReceipts = [...(session.archivedReceipts ?? [])];
  const archivedKeys = new Set(archivedReceipts.map(receiptKey));
  for (const receipt of batch.receipts) {
    const key = receiptKey(receipt);
    if (!archivedKeys.has(key)) {
      archivedReceipts.push(receipt);
      archivedKeys.add(key);
    }
  }
  const successor = createEmptyReviewBatch({ sessionId: session.id, createdAt });
  return {
    ...session,
    batch: { state: successor.state },
    batchContent: successor,
    ...(archivedReceipts.length === 0 ? {} : { archivedReceipts }),
    updatedAt: successor.updatedAt,
  };
}

function receiptKey(receipt: RemoteWriteReceipt): string {
  if (receipt._tag === "PendingReviewCreated") return `pending:${receipt.reviewId}:${receipt.itemIds.join(",")}`;
  if (receipt._tag === "ReplyCreated") return `reply:${receipt.itemId}:${receipt.commentId}`;
  return `thread:${receipt.itemId}:${receipt.state}`;
}

type PublicationEvidence = {
  readonly receipt: RemoteWriteReceipt;
  readonly submitted?: NonNullable<ReviewSession["submittedReview"]>;
};

function publicationEvidence(
  batch: ReviewBatch,
  operation: BatchOperation,
  comments: GitHubComments,
  publishedFeedback: GitHubPublishedFeedback | undefined,
  authenticatedAccount: string | undefined,
): PublicationEvidence | undefined {
  if (operation._tag === "Reply") {
    const item = batch.items.find((candidate) => candidate.id === operation.itemId);
    if (item?._tag !== "ThreadReply") return undefined;
    const thread = comments.threads.find((candidate) => candidate.id === item.threadId);
    const startedAt = operation.startedAt;
    const priorCommentIds = operation.priorCommentIds;
    // A matching author/body/time is not durable proof: the same reply may
    // have existed before this operation. The write marker must include the
    // operation's pre-write thread snapshot, and recovery accepts only an ID
    // absent from that snapshot.
    if (startedAt === undefined || priorCommentIds === undefined) return undefined;
    const prior = new Set(priorCommentIds);
    // The operation-specific pre-write ID snapshot is the durable boundary.
    // GitHub may normalize createdAt to the same second as startedAt, so the
    // timestamp cannot be used as a strict ordering proof here. A comment
    // absent from the pre-write IDs is new for this operation; an existing ID
    // is never accepted, even when its body and author match.
    const comment = thread?.comments.find((candidate) => candidate.author === authenticatedAccount && candidate.body === item.body && !prior.has(candidate.id));
    return comment === undefined ? undefined : { receipt: { _tag: "ReplyCreated", itemId: item.id, commentId: comment.id } };
  }
  if (operation._tag === "ThreadState") {
    const item = batch.items.find((candidate) => candidate.id === operation.itemId);
    if (item?._tag !== "ThreadState") return undefined;
    const thread = comments.threads.find((candidate) => candidate.id === item.threadId);
    const expected = item.action === "resolve" ? "resolved" : "open";
    return thread?.state === expected
      ? { receipt: { _tag: "ThreadStateChanged", itemId: item.id, state: expected } }
      : undefined;
  }
  // A create timeout has no durable remote identifier and therefore has no
  // safe reconciliation evidence. Only the submit operation has a durable
  // review id marker that can identify the resulting review.
  if (operation._tag !== "SubmitPendingReview" || publishedFeedback === undefined || authenticatedAccount === undefined) return undefined;
  const expectedEvent = operation.event === "APPROVE" ? "APPROVED" : operation.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED";
  const review = publishedFeedback.reviews.find((candidate) =>
    candidate.id === operation.reviewId &&
    candidate.author === authenticatedAccount &&
    candidate.body === renderReviewBatchBody(batch) &&
    candidate.event === expectedEvent,
  );
  if (review === undefined) return undefined;
  const pendingReceipt = batch.receipts.find((receipt): receipt is Extract<RemoteWriteReceipt, { readonly _tag: "PendingReviewCreated" }> => receipt._tag === "PendingReviewCreated" && receipt.reviewId === operation.reviewId);
  if (pendingReceipt === undefined) return undefined;
  const inline = batch.items.filter((item): item is Extract<ReviewBatch["items"][number], { readonly _tag: "InlineComment" }> => item._tag === "InlineComment" && pendingReceipt.itemIds.includes(item.id));
  const allCommentsPresent = inline.every((item) => publishedFeedback.comments.some((comment) =>
    comment.author === authenticatedAccount &&
    comment.body === item.body &&
    comment.location?.path === item.anchor.path &&
    comment.location.line === item.anchor.startLine &&
    comment.reviewId === review.id,
  ));
  if (!allCommentsPresent) return undefined;
  const submittedAt = review.submittedAt;
  return {
    receipt: { _tag: "PendingReviewCreated", reviewId: review.id, itemIds: pendingReceipt.itemIds },
    submitted: { reviewId: review.id, event: operation.event, submittedAt },
  };
}

function hasReceiptForOperation(batch: ReviewBatch, operation: BatchOperation): boolean {
  return batch.receipts.some((receipt) => {
    if (operation._tag === "CreatePendingReview") {
      return receipt._tag === "PendingReviewCreated" && receipt.itemIds.length === operation.itemIds.length && operation.itemIds.every((id) => receipt.itemIds.includes(id));
    }
    if (operation._tag === "SubmitPendingReview") {
      return receipt._tag === "PendingReviewCreated" && receipt.reviewId === operation.reviewId;
    }
    return (receipt._tag === "ReplyCreated" || receipt._tag === "ThreadStateChanged") && receipt.itemId === operation.itemId;
  });
}

function nextReconciledBatch(
  batch: ReviewBatch,
  receipts: ReadonlyArray<RemoteWriteReceipt>,
  submitted: PublicationEvidence["submitted"],
): ReviewBatch {
  if (submitted !== undefined) return { ...batch, receipts, state: { _tag: "Submitted", reviewId: submitted.reviewId, event: submitted.event }, updatedAt: batch.updatedAt };
  const pending = receipts.find((receipt): receipt is Extract<RemoteWriteReceipt, { readonly _tag: "PendingReviewCreated" }> => receipt._tag === "PendingReviewCreated");
  const remaining = batch.items.some((item) => (item._tag === "ThreadReply" || item._tag === "ThreadState") && item.include && !receipts.some((receipt) => receipt._tag !== "PendingReviewCreated" && receipt.itemId === item.id));
  const state = remaining
    ? { _tag: "Local" as const }
    : pending === undefined
      ? { _tag: "Completed" as const }
      : { _tag: "PendingReview" as const, reviewId: pending.reviewId };
  return { ...batch, receipts, state, updatedAt: batch.updatedAt };
}
