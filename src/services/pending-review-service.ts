import type {
  GitHubPendingReviewGateway,
  GitHubReader,
  GitHubReviewWriter,
} from "../adapters/github/github-adapter";
import type { ConfirmedWriteJournal } from "../adapters/storage/recent-write-journal-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  adoptObservedPendingReview,
  beginPendingReviewWrite,
  confirmPendingReviewWrite,
  isPendingReviewLocked,
  markPendingReviewOutcomeUnknown,
  matchPendingReviewThread,
  reconcilePendingReviewState,
  rejectPendingReviewWrite,
  type GitHubReviewEvent,
  type FindingReviewReceipt,
  type FindingReviewSource,
  type PendingReviewAnchor,
  type PendingReviewOperation,
  type PendingReviewState,
  type PendingReviewThreadWrite,
  type PendingReviewRead,
  type ViewerPendingReview,
} from "../domain/pending-review";
import {
  createPendingReviewRequestId,
  parseGitHubLogin,
  type ReviewId,
  type WorkspaceProfileId,
  type IsoTimestamp,
} from "../domain/ids";
import type { PullRequestReviewSession } from "../domain/review-session";
import type { GitHubWriteFailure } from "../domain/github-write";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import {
  requireCurrentHead,
  type ReviewWriteExpectation,
  type ReviewWriteGate,
} from "./review-write-gate";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import {
  postDesktopNotification,
  type DesktopNotifier,
} from "./desktop-notifier";
import type { PullRequestRef } from "../domain/pull-request";
import type {
  GitHubComments,
  GitHubPublishedFeedback,
} from "../domain/github-context";
import { journalEntriesFor } from "./pending-review-journal";
import {
  hasFindingReceipt,
  nextFindingReceipts,
  reconcileObservedFindingReceipts,
  releaseGoneFindingReceipts,
  sameFindingSource,
  type FindingReceiptEvidence,
} from "./pending-review-finding-receipts";
import type { AppLogService } from "./app-log-service";

export type StartPendingReviewInput = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly expected: ReviewWriteExpectation;
  readonly anchor: PendingReviewAnchor;
  readonly body: string;
  readonly finding?: FindingReviewSource;
};

export type AddPendingReviewThreadInput = StartPendingReviewInput & {
  readonly pendingReviewNodeId: ViewerPendingReview["nodeId"];
};

export type SubmitPendingReviewInput = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly expected: ReviewWriteExpectation;
  readonly event: GitHubReviewEvent;
  readonly summaryBody: string;
};

export type DiscardPendingReviewInput = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly expected: ReviewWriteExpectation;
  readonly confirmation: true;
};

export type PendingReviewServiceFailure =
  | "invalid_input"
  | "not_found"
  | "not_fresh"
  | "stale_head"
  | "permission_denied"
  | "forbidden"
  | "rejected"
  | "pending_review"
  | "unavailable"
  | "rate_limited"
  | "outcome_unknown"
  | "review_write_in_progress"
  | "no_pending_review"
  | "pending_review_gone"
  | "pending_review_locked";

export type PendingReviewCommandResult = {
  readonly session: PullRequestReviewSession;
  readonly state: PendingReviewState;
};

/** A reconciled Review; `unavailable` means GitHub was not read, never None. */
type PendingReviewReconciled = {
  readonly session: PullRequestReviewSession;
  readonly state: PendingReviewState;
  readonly unavailable: boolean;
};

/** The one thread a Start or AddThread meant to create, as the write sent it. */
type PendingReviewThreadIntent = {
  readonly profile: WorkspaceProfileConfig;
  readonly anchor: PendingReviewAnchor;
  readonly body: string;
};

/** What the reconciling read proved about a `pending_review` refusal. */
type PendingReviewConflictOutcome =
  | { readonly _tag: "Landed"; readonly write: PendingReviewThreadWrite }
  | { readonly _tag: "Refused"; readonly observed: PendingReviewRead }
  | { readonly _tag: "Uncertain" };

/** The session-level fields `adoptObservedState` decides to update, if any. */
export type PendingReviewObservedAdoption = {
  readonly pendingReview?: PendingReviewState;
  readonly findingReviewReceipts?: ReadonlyArray<FindingReviewReceipt>;
};

type PendingReviewOwnerProjection = {
  readonly nodeId: string;
  readonly headSha: string;
  readonly comments: ReadonlyArray<{
    readonly threadId: string;
    readonly body: string;
    readonly path: string;
    readonly startLine: number;
    readonly line: number;
    readonly side: "new" | "old";
  }>;
};

/** Read-only renderer projection; unavailable is never none. */
export type PendingReviewProjection =
  | { readonly state: "none" }
  | {
      readonly state: "unavailable";
      readonly action: "refresh" | "check_github_again";
    }
  | {
      readonly state: "pending";
      readonly count: number;
      readonly review: PendingReviewOwnerProjection;
    }
  | {
      readonly state: "recovery_required";
      readonly action: "start" | "add_thread" | "submit" | "discard";
      readonly review: PendingReviewOwnerProjection | null;
    };

type Gateway = GitHubPendingReviewGateway &
  Pick<
    GitHubReader,
    | "getPullRequest"
    | "resolveAuthenticatedAccount"
    | "getPullRequestComments"
    | "getPullRequestPublishedFeedback"
  > &
  Pick<GitHubReviewWriter, "submitPendingReview">;
/**
 * Owns the viewer's GitHub pending review lifecycle: reconcile (import at
 * open/refresh, recover at Check GitHub again), start with its first thread,
 * append a thread, and submit. Every write persists a typed operation intent
 * before the remote boundary and a confirmed receipt before success; timeouts
 * and lost responses become OutcomeUnknown and are never retried automatically.
 */
export class PendingReviewService {
  constructor(
    private readonly gate: Pick<
      ReviewWriteGate,
      "requireFresh" | "requireCurrentSession"
    >,
    private readonly sessions: Pick<ReviewSessionStore, "load" | "save">,
    private readonly github: Gateway,
    private readonly now: () => IsoTimestamp,
    private readonly writeCoordinator: ReviewOperationCoordinator,
    private readonly recentWrites: ConfirmedWriteJournal,
    private readonly notifier?: DesktopNotifier,
    private readonly log?: Pick<AppLogService, "write">,
  ) {}

  /**
   * Convert a completed same-revision pending-review read into a session
   * transition. Observation owns persistence and its cross-store journal; this
   * method only owns pending-draft and Finding-receipt policy.
   */
  adoptObservedState(input: {
    readonly session: PullRequestReviewSession;
    readonly observed: PendingReviewRead;
    readonly evidenceComplete: boolean;
    readonly comments: GitHubComments;
    readonly publishedFeedback?: GitHubPublishedFeedback;
  }): PendingReviewObservedAdoption {
    if (
      input.session.pendingReview === undefined &&
      input.observed._tag === "Unavailable"
    )
      return input.session.findingReviewReceipts === undefined
        ? {}
        : { findingReviewReceipts: input.session.findingReviewReceipts };
    const current = input.session.pendingReview ?? { _tag: "None" as const };
    const pendingReview = adoptObservedPendingReview(current, input.observed);
    if (isPendingReviewLocked(current)) {
      return input.session.findingReviewReceipts === undefined
        ? { pendingReview }
        : {
            pendingReview,
            findingReviewReceipts: input.session.findingReviewReceipts,
          };
    }
    const receipts = reconcileObservedFindingReceipts(
      input.publishedFeedback === undefined
        ? {
            receipts: input.session.findingReviewReceipts,
            pendingReview,
            evidenceComplete: input.evidenceComplete,
            comments: input.comments,
          }
        : {
            receipts: input.session.findingReviewReceipts,
            pendingReview,
            evidenceComplete: input.evidenceComplete,
            comments: input.comments,
            publishedFeedback: input.publishedFeedback,
          },
    );
    return receipts.length === 0
      ? { pendingReview }
      : { pendingReview, findingReviewReceipts: receipts };
  }

  /**
   * Reconcile the viewer's pending review. Initial open and explicit Refresh
   * call with recover=false (confirmed states import; locked states stay
   * locked). Check GitHub again calls with recover=true to resolve a locked
   * operation. A failed read is unavailable, never None.
   */
  async reconcile(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly recover?: boolean;
  }): Promise<Result<PendingReviewReconciled, PendingReviewServiceFailure>> {
    return this.writeCoordinator.withReviewLock(
      input.profileId,
      input.reviewId,
      () => this.reconcileUnlocked(input),
    );
  }

  private async reconcileUnlocked(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly recover?: boolean;
    readonly evidence?: FindingReceiptEvidence;
  }): Promise<Result<PendingReviewReconciled, PendingReviewServiceFailure>> {
    const current = await this.gate.requireCurrentSession(
      input.profileId,
      input.reviewId,
    );
    if (current._tag === "err")
      return err(mapGateFailure(current.error.reason));
    const session = current.value.session;
    const profile = current.value.profile;
    const stored = session.pendingReview ?? { _tag: "None" as const };
    const account = await this.github.resolveAuthenticatedAccount(profile);
    if (account._tag === "err") {
      return ok({ session, state: stored, unavailable: true });
    }
    const parsedAccount = parseGitHubLogin(account.value.account);
    if (parsedAccount._tag === "err") {
      return ok({ session, state: stored, unavailable: true });
    }
    const read = await this.github.getViewerPendingReview({
      profile,
      pr: sessionPr(session),
      account: parsedAccount.value,
    });
    if (read._tag === "err" || read.value._tag === "Unavailable") {
      return ok({ session, state: stored, unavailable: true });
    }
    let next: PendingReviewState;
    if (isPendingReviewLocked(stored)) {
      next =
        input.recover === true
          ? reconcilePendingReviewState(stored, read.value)
          : stored;
    } else {
      next = adoptObservedPendingReview(stored, read.value);
    }
    // A locked operation may still own a receipt's thread, so only an
    // unlocked Review releases receipts; recovery settles the lock first.
    const released =
      input.evidence === undefined || isPendingReviewLocked(stored)
        ? undefined
        : releaseGoneFindingReceipts({
            receipts: session.findingReviewReceipts,
            observed: read.value,
            evidence: input.evidence,
          });
    const releasedAny =
      released !== undefined && released.pendingReviewNodeIds.length > 0;
    if (
      session.pendingReview !== undefined &&
      samePendingReviewState(next, stored) &&
      !releasedAny
    ) {
      return ok({ session, state: next, unavailable: false });
    }
    const receipts = releasedAny
      ? released.receipts
      : session.findingReviewReceipts;
    const {
      findingReviewReceipts: _previousReceipts,
      ...sessionWithoutReceipts
    } = session;
    void _previousReceipts;
    const nextSession: PullRequestReviewSession =
      receipts === undefined || receipts.length === 0
        ? { ...sessionWithoutReceipts, pendingReview: next }
        : {
            ...sessionWithoutReceipts,
            pendingReview: next,
            findingReviewReceipts: receipts,
          };
    // Compare-and-swap against the session this reconcile read, so a write
    // that landed during the GitHub reads is reported instead of overwritten.
    const saved = await this.sessions.save(
      { ...nextSession, updatedAt: this.now() },
      session.updatedAt,
    );
    if (saved._tag === "err") {
      return ok({ session, state: stored, unavailable: true });
    }
    if (releasedAny)
      this.log?.write({
        process: "main",
        level: "info",
        topic: "pending-review",
        message: "pending review gone on GitHub; released its Finding receipts",
        profileId: input.profileId,
        sessionId: session.id,
        meta: {
          reviewId: input.reviewId,
          pendingReviewNodeIds: [...released.pendingReviewNodeIds],
          cleared: released.cleared,
          published: released.published,
        },
      });
    return ok({ session: nextSession, state: next, unavailable: false });
  }

  /**
   * Reconcile when the caller already owns the shared Review lock. Refresh
   * passes the thread evidence it read so receipts of a pending review deleted
   * on GitHub are released (#419).
   */
  async reconcileWithinReviewLock(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly evidence: FindingReceiptEvidence;
  }): Promise<Result<PendingReviewReconciled, PendingReviewServiceFailure>> {
    return this.reconcileUnlocked(input);
  }

  async start(
    input: StartPendingReviewInput,
  ): Promise<Result<PendingReviewCommandResult, PendingReviewServiceFailure>> {
    return this.serializedWrite(
      input.profileId,
      input.reviewId,
      input.expected,
      async (profile, session) => {
        if (
          input.finding !== undefined &&
          (input.finding.sessionId !== session.id ||
            input.finding.headSha !== session.key.headSha)
        )
          return err("invalid_input");
        if (session.pendingReview === undefined) return err("unavailable");
        if (
          input.finding !== undefined &&
          hasFindingReceipt(session.findingReviewReceipts, input.finding)
        )
          return err("pending_review_locked");
        const state = session.pendingReview;
        const requestId = createPendingReviewRequestId(this.now());
        const operation: PendingReviewOperation =
          input.finding === undefined
            ? { _tag: "Start", requestId }
            : { _tag: "Start", requestId, finding: input.finding };
        return this.executeWrite(
          input.profileId,
          input.reviewId,
          session,
          state,
          operation,
          async () => {
            const created = await this.github.startPendingReviewWithThread({
              profile,
              pr: sessionPr(session),
              headSha: session.key.headSha,
              anchor: input.anchor,
              body: input.body,
            });
            return created._tag === "ok"
              ? ok(created.value)
              : err(created.error);
          },
          { profile, anchor: input.anchor, body: input.body },
        );
      },
    );
  }

  async addThread(
    input: AddPendingReviewThreadInput,
  ): Promise<Result<PendingReviewCommandResult, PendingReviewServiceFailure>> {
    return this.serializedWrite(
      input.profileId,
      input.reviewId,
      input.expected,
      async (profile, session) => {
        if (
          input.finding !== undefined &&
          (input.finding.sessionId !== session.id ||
            input.finding.headSha !== session.key.headSha)
        )
          return err("invalid_input");
        if (session.pendingReview === undefined) return err("unavailable");
        const state = session.pendingReview;
        if (
          input.finding !== undefined &&
          state._tag === "Pending" &&
          (sameFindingSource(input.finding, state.unresolvedFinding) ||
            hasFindingReceipt(session.findingReviewReceipts, input.finding))
        )
          return err("pending_review_locked");
        const requestId = createPendingReviewRequestId(this.now());
        const operation: PendingReviewOperation =
          input.finding === undefined
            ? {
                _tag: "AddThread",
                requestId,
                reviewId: input.pendingReviewNodeId,
                body: input.body,
                anchor: input.anchor,
              }
            : {
                _tag: "AddThread",
                requestId,
                reviewId: input.pendingReviewNodeId,
                body: input.body,
                anchor: input.anchor,
                finding: input.finding,
              };
        return this.executeWrite(
          input.profileId,
          input.reviewId,
          session,
          state,
          operation,
          async () => {
            const appended = await this.github.addPendingReviewThread({
              profile,
              pr: sessionPr(session),
              reviewId: input.pendingReviewNodeId,
              anchor: input.anchor,
              body: input.body,
            });
            return appended._tag === "ok"
              ? ok(appended.value)
              : err(appended.error);
          },
          // GitHub answers a GraphQL refusal under HTTP 200 and
          // `classifyGraphqlSignal` never produces CommandPendingReview, so
          // an append reaches this only through the shared HTTP status path.
          // Reconciling it costs one read and keeps both thread writes
          // answering the same way.
          { profile, anchor: input.anchor, body: input.body },
        );
      },
    );
  }

  async submit(
    input: SubmitPendingReviewInput,
  ): Promise<Result<PendingReviewCommandResult, PendingReviewServiceFailure>> {
    return this.serializedWrite(
      input.profileId,
      input.reviewId,
      input.expected,
      async (profile, session) => {
        if (session.pendingReview === undefined) return err("unavailable");
        const state = session.pendingReview;
        if (state._tag !== "Pending") return err("no_pending_review");
        if (await this.settleGonePendingReview(input, profile, session, state))
          return err("pending_review_gone");
        const operation: PendingReviewOperation = {
          _tag: "Submit",
          requestId: createPendingReviewRequestId(this.now()),
          reviewId: state.review.restId,
          event: input.event,
        };
        return this.executeWrite(
          input.profileId,
          input.reviewId,
          session,
          state,
          operation,
          async () => {
            const submitted = await this.github.submitPendingReview({
              profile,
              pr: sessionPr(session),
              reviewId: state.review.restId,
              event: input.event,
              summaryBody: input.summaryBody,
            });
            // A confirmed submit removes the pending owner; the submitted
            // feedback becomes visible through the next explicit refresh.
            return submitted._tag === "ok"
              ? ok(undefined)
              : err(submitted.error);
          },
        );
      },
    );
  }

  /**
   * Submitting a pending review deleted on GitHub answers 404, which is
   * outcome-unknown and would lock the Review for good (#419). When GitHub
   * confirms the recorded review is gone, reconcile to what it holds and
   * release its Finding receipts instead of sending the write. The pending
   * review is read before the thread evidence, so a deletion between the two
   * reads cannot make a receipt's thread look published.
   */
  private async settleGonePendingReview(
    input: Pick<SubmitPendingReviewInput, "profileId" | "reviewId">,
    profile: WorkspaceProfileConfig,
    session: PullRequestReviewSession,
    recorded: Extract<PendingReviewState, { readonly _tag: "Pending" }>,
  ): Promise<boolean> {
    const pr = sessionPr(session);
    const account = await this.github.resolveAuthenticatedAccount(profile);
    if (account._tag === "err") return false;
    const login = parseGitHubLogin(account.value.account);
    if (login._tag === "err") return false;
    const read = await this.github.getViewerPendingReview({
      profile,
      pr,
      account: login.value,
    });
    if (
      read._tag === "err" ||
      read.value._tag === "Unavailable" ||
      (read.value._tag === "Pending" &&
        read.value.review.nodeId === recorded.review.nodeId)
    )
      return false;
    const [comments, publishedFeedback] = await Promise.all([
      this.github.getPullRequestComments({ profile, pr }),
      this.github.getPullRequestPublishedFeedback?.({ profile, pr }),
    ]);
    const evidence =
      comments._tag === "err" || publishedFeedback?._tag === "err"
        ? undefined
        : publishedFeedback === undefined
          ? { comments: comments.value }
          : {
              comments: comments.value,
              publishedFeedback: publishedFeedback.value,
            };
    const reconciled = await this.reconcileUnlocked(
      evidence === undefined ? input : { ...input, evidence },
    );
    return (
      reconciled._tag === "ok" &&
      !reconciled.value.unavailable &&
      !(
        reconciled.value.state._tag === "Pending" &&
        reconciled.value.state.review.nodeId === recorded.review.nodeId
      )
    );
  }

  async discard(
    input: DiscardPendingReviewInput,
  ): Promise<Result<PendingReviewCommandResult, PendingReviewServiceFailure>> {
    if (input.confirmation !== true) return err("invalid_input");
    return this.serializedWrite(
      input.profileId,
      input.reviewId,
      input.expected,
      async (profile, session) => {
        if (session.pendingReview === undefined) return err("unavailable");
        const state = session.pendingReview;
        if (state._tag !== "Pending") return err("no_pending_review");
        const operation: PendingReviewOperation = {
          _tag: "Discard",
          requestId: createPendingReviewRequestId(this.now()),
          reviewId: state.review.restId,
        };
        return this.executeWrite(
          input.profileId,
          input.reviewId,
          session,
          state,
          operation,
          async () => {
            // dbacd62-proven contract: the normal DELETE response is the
            // confirmed absence receipt; a timeout or lost response is an
            // unavailable outcome and is never retried automatically.
            const discarded = await this.github.discardPendingReview({
              profile,
              pr: sessionPr(session),
              reviewId: state.review.restId,
            });
            return discarded._tag === "ok"
              ? ok(undefined)
              : err(discarded.error);
          },
        );
      },
    );
  }

  private async serializedWrite(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    expected: ReviewWriteExpectation,
    operation: (
      profile: WorkspaceProfileConfig,
      session: PullRequestReviewSession,
    ) => Promise<
      Result<PendingReviewCommandResult, PendingReviewServiceFailure>
    >,
  ): Promise<Result<PendingReviewCommandResult, PendingReviewServiceFailure>> {
    const key = `${profileId}:${reviewId}`;
    const acquired = this.writeCoordinator.acquire(key);
    if (!acquired) return err("review_write_in_progress");
    try {
      const fresh = await this.gate.requireFresh(profileId, reviewId, expected);
      if (fresh._tag === "err") return err(mapGateFailure(fresh.error.reason));
      const { profile, session } = fresh.value;
      // Final current-head check immediately before any write, matching the
      // direct-conversation boundary: the represented snapshot is fresh, and
      // the live head must still match it.
      const current = await requireCurrentHead(this.github, profile, session);
      if (current._tag === "err")
        return err(
          current.error.reason === "github_read" ? "unavailable" : "stale_head",
        );
      return operation(profile, session);
    } finally {
      this.writeCoordinator.release(key);
    }
  }

  private async executeWrite(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    session: PullRequestReviewSession,
    state: PendingReviewState,
    operation: PendingReviewOperation,
    write: () => Promise<
      Result<
        PendingReviewThreadWrite | ViewerPendingReview | undefined,
        GitHubWriteFailure
      >
    >,
    conflict?: PendingReviewThreadIntent,
  ): Promise<Result<PendingReviewCommandResult, PendingReviewServiceFailure>> {
    const begun = beginPendingReviewWrite(state, operation, this.now());
    if (begun._tag === "err") {
      return err(
        isPendingReviewLocked(state)
          ? "pending_review_locked"
          : "no_pending_review",
      );
    }
    // Persist the operation intent before crossing the remote write boundary.
    if (!(await this.persist(session, begun.value)))
      return err("outcome_unknown");
    let written = await write();
    if (
      written._tag === "err" &&
      written.error.category === "pending_review" &&
      conflict !== undefined
    ) {
      const resolved = await this.resolvePendingReviewConflict(
        session,
        conflict,
      );
      if (resolved._tag === "Landed") written = ok(resolved.write);
      if (resolved._tag === "Uncertain")
        return err(
          await this.lockOutcomeUnknown(reviewId, session, begun.value),
        );
      if (resolved._tag === "Refused") {
        // GitHub holds a pending review that is not this write's: the write
        // did not land. Record the owner the read proved so the Review stops
        // claiming there is none, and name the collision in the failure.
        const rejected = rejectPendingReviewWrite(begun.value);
        if (rejected._tag === "ok")
          await this.persistRejection(
            reviewId,
            session,
            adoptObservedPendingReview(rejected.value, resolved.observed),
          );
        return err("pending_review");
      }
    }
    if (written._tag === "err") {
      if (written.error.category === "unavailable") {
        // Timeout, lost response, or unconfirmable outcome: lock and require
        // read-side reconciliation; never retry automatically.
        return err(
          await this.lockOutcomeUnknown(reviewId, session, begun.value),
        );
      }
      // GitHub flatly refused the request rather than leaving the outcome
      // ambiguous, so this locks and rejects the same as any other refusal;
      // only the reported failure code differs, so the maintainer sees an
      // accurate "rate-limited" message instead of a generic rejection.
      const rejected = rejectPendingReviewWrite(begun.value);
      if (rejected._tag === "ok")
        await this.persistRejection(reviewId, session, rejected.value);
      if (written.error.category === "rate_limited") return err("rate_limited");
      if (written.error.category === "forbidden") return err("forbidden");
      if (written.error.category === "pending_review")
        return err("pending_review");
      return err(
        written.error.category === "auth" ? "permission_denied" : "rejected",
      );
    }
    const writtenReview =
      written.value === undefined
        ? undefined
        : "review" in written.value
          ? written.value.review
          : written.value;
    const confirmed = confirmPendingReviewWrite(begun.value, writtenReview);
    if (confirmed._tag === "err")
      return err(await this.lockOutcomeUnknown(reviewId, session, begun.value));
    const receipts = nextFindingReceipts(
      session.findingReviewReceipts,
      begun.value,
      written.value,
      confirmed.value,
    );
    if (receipts === undefined)
      return err(await this.lockOutcomeUnknown(reviewId, session, begun.value));
    // A confirmed receipt must be durable before success is reported.
    if (!(await this.persist(session, confirmed.value, receipts)))
      return err(await this.lockOutcomeUnknown(reviewId, session, begun.value));
    for (const entry of journalEntriesFor(
      operation,
      state,
      written.value,
      confirmed.value,
    )) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- parallelizing these would race the store's read-modify-write and drop entries
      await this.recentWrites.appendConfirmed(
        profileId,
        reviewId,
        entry,
        this.now(),
      );
    }
    const {
      findingReviewReceipts: _previousReceipts,
      ...sessionWithoutReceipts
    } = session;
    void _previousReceipts;
    const sessionUpdate = {
      ...sessionWithoutReceipts,
      pendingReview: confirmed.value,
    };
    return ok({
      session:
        receipts.length === 0
          ? sessionUpdate
          : { ...sessionUpdate, findingReviewReceipts: receipts },
      state: confirmed.value,
    });
  }

  /** Keep the intent and lock the Review for read-side recovery (ADR 0035). */
  private async lockOutcomeUnknown(
    reviewId: ReviewId,
    session: PullRequestReviewSession,
    begun: PendingReviewState,
  ): Promise<PendingReviewServiceFailure> {
    const unknown = markPendingReviewOutcomeUnknown(begun);
    if (unknown._tag === "ok") await this.persist(session, unknown.value);
    // The persisted in-flight intent already locks the Review, so notify even if this save failed.
    postDesktopNotification(this.notifier, {
      _tag: "WriteNeedsRecovery",
      reviewId,
      pullRequest: sessionPr(session),
    });
    return "outcome_unknown";
  }

  // A failed save leaves WriteInFlight on disk, which locks the Review until recovery.
  private async persistRejection(
    reviewId: ReviewId,
    session: PullRequestReviewSession,
    rejected: PendingReviewState,
  ): Promise<void> {
    if (await this.persist(session, rejected)) return;
    postDesktopNotification(this.notifier, {
      _tag: "WriteNeedsRecovery",
      reviewId,
      pullRequest: sessionPr(session),
    });
  }

  /**
   * What a `pending_review` refusal of a Start or AddThread really means.
   * GitHub answers the same 422 whether it already held the viewer's pending
   * review or the first request landed and the renderer's transport resent it
   * (ADR 0046), so the refusal alone is not evidence the write failed. One
   * read of the viewer's pending review decides: it holds the intended
   * thread, it holds someone else's work, or it proves nothing and the write
   * stays uncertain.
   */
  private async resolvePendingReviewConflict(
    session: PullRequestReviewSession,
    intent: PendingReviewThreadIntent,
  ): Promise<PendingReviewConflictOutcome> {
    const account = await this.github.resolveAuthenticatedAccount(
      intent.profile,
    );
    if (account._tag === "err") return { _tag: "Uncertain" };
    const login = parseGitHubLogin(account.value.account);
    if (login._tag === "err") return { _tag: "Uncertain" };
    const read = await this.github.getViewerPendingReview({
      profile: intent.profile,
      pr: sessionPr(session),
      account: login.value,
    });
    if (read._tag === "err" || read.value._tag === "Unavailable")
      return { _tag: "Uncertain" };
    // GitHub refused because a pending review exists, so a read finding none
    // contradicts the refusal: one of the two is stale and the outcome is not
    // established. Incomplete evidence stays check-required (ADR 0035).
    if (read.value._tag === "None") return { _tag: "Uncertain" };
    const matched = matchPendingReviewThread(
      read.value.review,
      intent.anchor,
      intent.body,
    );
    if (matched._tag === "Ambiguous") return { _tag: "Uncertain" };
    return matched._tag === "Match"
      ? {
          _tag: "Landed",
          write: {
            review: read.value.review,
            createdThreadId: matched.threadId,
          },
        }
      : { _tag: "Refused", observed: read.value };
  }

  private async persist(
    session: PullRequestReviewSession,
    pendingReview: PendingReviewState,
    findingReviewReceipts = session.findingReviewReceipts,
  ): Promise<boolean> {
    const {
      findingReviewReceipts: _previousReceipts,
      ...sessionWithoutReceipts
    } = session;
    void _previousReceipts;
    const sessionUpdate = {
      ...sessionWithoutReceipts,
      pendingReview,
      updatedAt: this.now(),
    };
    const saved = await this.sessions.save(
      findingReviewReceipts === undefined || findingReviewReceipts.length === 0
        ? sessionUpdate
        : { ...sessionUpdate, findingReviewReceipts },
    );
    return saved._tag === "ok";
  }
}

/** Build the renderer projection from durable state and read availability. */
export function projectPendingReview(
  state: PendingReviewState,
  unavailable: boolean,
): PendingReviewProjection {
  if (unavailable) {
    return {
      state: "unavailable",
      action: isPendingReviewLocked(state) ? "check_github_again" : "refresh",
    };
  }
  if (state._tag === "WriteInFlight" || state._tag === "OutcomeUnknown") {
    const action =
      state.operation._tag === "Start"
        ? ("start" as const)
        : state.operation._tag === "AddThread"
          ? ("add_thread" as const)
          : state.operation._tag === "Submit"
            ? ("submit" as const)
            : ("discard" as const);
    return {
      state: "recovery_required",
      action,
      review:
        state.review === undefined
          ? null
          : projectPendingReviewOwner(state.review),
    };
  }
  if (state._tag === "None") return { state: "none" };
  return {
    state: "pending",
    count: state.review.comments.length,
    review: projectPendingReviewOwner(state.review),
  };
}

function projectPendingReviewOwner(
  review: ViewerPendingReview,
): PendingReviewOwnerProjection {
  return {
    nodeId: review.nodeId,
    headSha: review.headSha,
    comments: review.comments.map((comment) => ({
      threadId: comment.threadId,
      body: comment.body,
      path: comment.anchor.path,
      startLine: comment.anchor.startLine,
      line: comment.anchor.line,
      side: comment.anchor.side,
    })),
  };
}

function sessionPr(session: PullRequestReviewSession): PullRequestRef {
  return {
    host: session.key.host,
    owner: session.key.owner,
    repo: session.key.repo,
    number: session.key.source.prNumber,
  };
}

function samePendingReviewState(
  left: PendingReviewState,
  right: PendingReviewState,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mapGateFailure(reason: string): PendingReviewServiceFailure {
  if (reason === "not_found") return "not_found";
  if (reason === "terminal" || reason === "stale") return "permission_denied";
  if (reason === "not_fresh") return "not_fresh";
  return "unavailable";
}
