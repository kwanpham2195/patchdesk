import type {
  GitHubPendingReviewGateway,
  GitHubReader,
  GitHubReviewWriter,
} from "../adapters/github/github-adapter";
import type { RecentWriteJournalStore } from "../adapters/storage/recent-write-journal-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  adoptObservedPendingReview,
  beginPendingReviewWrite,
  confirmPendingReviewWrite,
  isPendingReviewLocked,
  markPendingReviewOutcomeUnknown,
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
import type { ReviewSession } from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type {
  ReviewWriteExpectation,
  ReviewWriteGate,
} from "./review-write-gate";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import type { PullRequestRef } from "../domain/pull-request";
import type {
  GitHubComments,
  GitHubPublishedFeedback,
} from "../domain/github-context";
import type { RecentReviewWrite } from "./review-refresh-service";

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
  | "rejected"
  | "unavailable"
  | "rate_limited"
  | "outcome_unknown"
  | "review_write_in_progress"
  | "no_pending_review"
  | "pending_review_locked";

export type PendingReviewCommandResult = {
  readonly session: ReviewSession;
  readonly state: PendingReviewState;
};

/** The session-level fields `adoptObservedState` decides to update, if any. */
export type PendingReviewObservedAdoption = {
  readonly pendingReview?: PendingReviewState;
  readonly findingReviewReceipts?: ReadonlyArray<FindingReviewReceipt>;
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
      readonly review: {
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
    }
  | {
      readonly state: "recovery_required";
      readonly action: "start" | "add_thread" | "submit" | "discard";
    };

type Gateway = GitHubPendingReviewGateway &
  Pick<GitHubReader, "getPullRequest" | "resolveAuthenticatedAccount"> &
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
    private readonly recentWrites: Pick<RecentWriteJournalStore, "append">,
  ) {}

  /**
   * Convert a completed same-revision pending-review read into a session
   * transition. Observation owns persistence and its cross-store journal; this
   * method only owns pending-draft and Finding-receipt policy.
   */
  adoptObservedState(input: {
    readonly session: ReviewSession;
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
  }): Promise<
    Result<
      {
        readonly session: ReviewSession;
        readonly state: PendingReviewState;
        readonly unavailable: boolean;
      },
      PendingReviewServiceFailure
    >
  > {
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
  }): Promise<
    Result<
      {
        readonly session: ReviewSession;
        readonly state: PendingReviewState;
        readonly unavailable: boolean;
      },
      PendingReviewServiceFailure
    >
  > {
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
    if (
      session.pendingReview !== undefined &&
      samePendingReviewState(next, stored)
    ) {
      return ok({ session, state: next, unavailable: false });
    }
    const saved = await this.sessions.save({
      ...session,
      pendingReview: next,
      updatedAt: this.now(),
    });
    if (saved._tag === "err") {
      return ok({ session, state: stored, unavailable: true });
    }
    return ok({
      session: { ...session, pendingReview: next },
      state: next,
      unavailable: false,
    });
  }

  /** Reconcile when the caller already owns the shared Review lock. */
  async reconcileWithinReviewLock(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly recover?: boolean;
  }): Promise<
    Result<
      {
        readonly session: ReviewSession;
        readonly state: PendingReviewState;
        readonly unavailable: boolean;
      },
      PendingReviewServiceFailure
    >
  > {
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
                anchor: input.anchor,
              }
            : {
                _tag: "AddThread",
                requestId,
                reviewId: input.pendingReviewNodeId,
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
      session: ReviewSession,
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
      const current = await this.github.getPullRequest({
        profile,
        pr: sessionPr(session),
      });
      if (current._tag === "err") return err("unavailable");
      if (current.value.headSha !== session.key.headSha)
        return err("stale_head");
      return operation(profile, session);
    } finally {
      this.writeCoordinator.release(key);
    }
  }

  private async executeWrite(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    session: ReviewSession,
    state: PendingReviewState,
    operation: PendingReviewOperation,
    write: () => Promise<
      Result<
        PendingReviewThreadWrite | ViewerPendingReview | undefined,
        {
          readonly _tag: "GitHubWriteFailure";
          readonly category:
            | "auth"
            | "rejected"
            | "unavailable"
            | "pending_review"
            | "rate_limited";
          readonly message: string;
        }
      >
    >,
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
    const written = await write();
    if (written._tag === "err") {
      if (written.error.category === "unavailable") {
        // Timeout, lost response, or unconfirmable outcome: lock and require
        // read-side reconciliation; never retry automatically.
        const unknown = markPendingReviewOutcomeUnknown(begun.value);
        if (
          unknown._tag === "ok" &&
          !(await this.persist(session, unknown.value))
        ) {
          return err("outcome_unknown");
        }
        return err("outcome_unknown");
      }
      // GitHub flatly refused the request rather than leaving the outcome
      // ambiguous, so this locks and rejects the same as any other refusal;
      // only the reported failure code differs, so the maintainer sees an
      // accurate "rate-limited" message instead of a generic rejection.
      const rejected = rejectPendingReviewWrite(begun.value);
      if (rejected._tag === "ok") await this.persist(session, rejected.value);
      if (written.error.category === "rate_limited") return err("rate_limited");
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
    if (confirmed._tag === "err") return err("outcome_unknown");
    const receipts = nextFindingReceipts(
      session.findingReviewReceipts,
      begun.value,
      written.value,
      confirmed.value,
    );
    if (receipts === undefined) {
      const unknown = markPendingReviewOutcomeUnknown(begun.value);
      if (unknown._tag === "ok") await this.persist(session, unknown.value);
      return err("outcome_unknown");
    }
    // A confirmed receipt must be durable before success is reported.
    if (!(await this.persist(session, confirmed.value, receipts))) {
      const unknown = markPendingReviewOutcomeUnknown(begun.value);
      if (unknown._tag === "ok") await this.persist(session, unknown.value);
      return err("outcome_unknown");
    }
    // Best effort: the GitHub write already succeeded, so a durable journal
    // failure here must not fail the confirmed command. Sequential by
    // necessity, not oversight: RecentWriteJournalStore.append() does an
    // unsynchronized read-modify-write per call, so running these in
    // parallel (e.g. via Promise.all) would race against itself and could
    // silently drop entries when Discard journals more than one thread.
    for (const entry of journalEntriesFor(
      operation,
      state,
      written.value,
      confirmed.value,
    )) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- parallelizing these would race the store's read-modify-write and drop entries
      await this.recentWrites.append(profileId, reviewId, entry, this.now());
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

  private async persist(
    session: ReviewSession,
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
    return { state: "recovery_required", action };
  }
  if (state._tag === "None") return { state: "none" };
  return {
    state: "pending",
    count: state.review.comments.length,
    review: {
      nodeId: state.review.nodeId,
      headSha: state.review.headSha,
      comments: state.review.comments.map((comment) => ({
        threadId: comment.threadId,
        body: comment.body,
        path: comment.anchor.path,
        startLine: comment.anchor.startLine,
        line: comment.anchor.line,
        side: comment.anchor.side,
      })),
    },
  };
}

function sessionPr(session: ReviewSession): PullRequestRef {
  return {
    host: session.key.host,
    owner: session.key.owner,
    repo: session.key.repo,
    number: session.key.prNumber,
  };
}

function sameFindingSource(
  left: FindingReviewSource,
  right: FindingReviewSource | undefined,
): boolean {
  return (
    right !== undefined &&
    left.analysisRunId === right.analysisRunId &&
    left.findingId === right.findingId &&
    left.sessionId === right.sessionId &&
    left.headSha === right.headSha &&
    left.patchHash === right.patchHash
  );
}

function hasFindingReceipt(
  receipts: ReadonlyArray<FindingReviewReceipt> | undefined,
  finding: FindingReviewSource,
): boolean {
  return (receipts ?? []).some(
    (receipt) =>
      receipt.analysisRunId === finding.analysisRunId &&
      receipt.findingId === finding.findingId &&
      receipt.sessionId === finding.sessionId &&
      receipt.headSha === finding.headSha &&
      receipt.patchHash === finding.patchHash,
  );
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

function reconcileObservedFindingReceipts(input: {
  readonly receipts: ReadonlyArray<FindingReviewReceipt> | undefined;
  readonly pendingReview: PendingReviewState;
  readonly evidenceComplete: boolean;
  readonly comments: GitHubComments;
  readonly publishedFeedback?: GitHubPublishedFeedback;
}): ReadonlyArray<FindingReviewReceipt> {
  const receipts = input.receipts ?? [];
  if (!input.evidenceComplete) {
    return receipts.map((receipt) =>
      receipt.state === "pending"
        ? { ...receipt, state: "historical" as const }
        : receipt,
    );
  }
  const remoteThreadIds = new Set(
    input.comments.threads.map((thread) => thread.id),
  );
  const publishedIds = new Set<string>();
  for (const comment of input.publishedFeedback?.comments ?? []) {
    publishedIds.add(comment.id);
    if (comment.nodeId !== undefined) publishedIds.add(comment.nodeId);
  }
  const next: FindingReviewReceipt[] = [];
  for (const receipt of receipts) {
    const remainsPending =
      input.pendingReview._tag === "Pending" &&
      input.pendingReview.review.nodeId === receipt.pendingReviewNodeId &&
      input.pendingReview.review.comments.some(
        (comment) => comment.threadId === receipt.threadId,
      );
    if (remainsPending) {
      next.push({ ...receipt, state: "pending" });
      continue;
    }
    // Complete Conversation and published-feedback evidence still needs to
    // contain the exact known receipt identifier before it can keep a Finding
    // non-actionable. Anything less stays Historical and cannot re-enable it.
    if (
      remoteThreadIds.has(receipt.threadId) ||
      publishedIds.has(receipt.threadId)
    ) {
      next.push({ ...receipt, state: "historical" });
    }
  }
  return next;
}

/**
 * The typed own-write journal entries one confirmed pending-review write
 * proves. Start/AddThread journal the thread the adapter reports it created
 * (`createdThreadId`, never guessed locally). A confirmed Discard that
 * resolved to `None` journals each thread the pre-operation Pending draft
 * held, mirroring the renderer's `threadIdsOf()` derivation. Submit is
 * intentionally not journaled: no `RecentReviewWrite` variant represents
 * "pending threads became a published review".
 */
function journalEntriesFor(
  operation: PendingReviewOperation,
  priorState: PendingReviewState,
  written: PendingReviewThreadWrite | ViewerPendingReview | undefined,
  confirmed: PendingReviewState,
): ReadonlyArray<RecentReviewWrite> {
  if (
    (operation._tag === "Start" || operation._tag === "AddThread") &&
    written !== undefined &&
    "createdThreadId" in written
  ) {
    return [{ _tag: "PendingThread", threadId: written.createdThreadId }];
  }
  if (
    operation._tag === "Discard" &&
    confirmed._tag === "None" &&
    priorState._tag === "Pending"
  ) {
    return priorState.review.comments.map((comment) => ({
      _tag: "PendingThread" as const,
      threadId: comment.threadId,
    }));
  }
  return [];
}

function nextFindingReceipts(
  existing: ReadonlyArray<FindingReviewReceipt> | undefined,
  begun: PendingReviewState,
  written: PendingReviewThreadWrite | ViewerPendingReview | undefined,
  confirmed: PendingReviewState,
): ReadonlyArray<FindingReviewReceipt> | undefined {
  const receipts = existing ?? [];
  if (begun._tag !== "WriteInFlight") return undefined;
  const operation = begun.operation;
  const finding =
    operation._tag === "Start" || operation._tag === "AddThread"
      ? operation.finding
      : undefined;
  if (finding !== undefined) {
    if (
      written === undefined ||
      !("createdThreadId" in written) ||
      confirmed._tag !== "Pending"
    )
      return undefined;
    if (
      finding.sessionId === "" ||
      finding.headSha !== confirmed.review.headSha ||
      receipts.some(
        (receipt) =>
          receipt.analysisRunId === finding.analysisRunId &&
          receipt.findingId === finding.findingId &&
          receipt.sessionId === finding.sessionId &&
          receipt.headSha === finding.headSha &&
          receipt.patchHash === finding.patchHash,
      )
    )
      return undefined;
    if (
      !confirmed.review.comments.some(
        (comment) => comment.threadId === written.createdThreadId,
      )
    )
      return undefined;
    return [
      ...receipts,
      {
        ...finding,
        threadId: written.createdThreadId,
        pendingReviewNodeId: confirmed.review.nodeId,
        state: "pending",
      },
    ];
  }
  if (operation._tag === "Submit" && begun.review !== undefined) {
    return receipts.map((receipt) =>
      receipt.state === "pending" &&
      receipt.pendingReviewNodeId === begun.review?.nodeId
        ? { ...receipt, state: "published" as const }
        : receipt,
    );
  }
  if (operation._tag === "Discard" && begun.review !== undefined) {
    return receipts.filter(
      (receipt) =>
        receipt.state !== "pending" ||
        receipt.pendingReviewNodeId !== begun.review?.nodeId,
    );
  }
  return receipts;
}
