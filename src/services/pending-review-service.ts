import type {
  GitHubPendingReviewGateway,
  GitHubReader,
  GitHubReviewWriter,
} from "../adapters/github/github-adapter";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  beginPendingReviewWrite,
  confirmPendingReviewWrite,
  isPendingReviewLocked,
  markPendingReviewOutcomeUnknown,
  reconcilePendingReviewState,
  rejectPendingReviewWrite,
  type GitHubReviewEvent,
  type PendingReviewAnchor,
  type PendingReviewOperation,
  type PendingReviewState,
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
import type { ReviewWriteExpectation, ReviewWriteGate } from "./review-write-gate";
import type { PullRequestRef } from "../domain/pull-request";

export type StartPendingReviewInput = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly expected: ReviewWriteExpectation;
  readonly anchor: PendingReviewAnchor;
  readonly body: string;
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

export type PendingReviewServiceFailure =
  | "invalid_input"
  | "not_found"
  | "not_fresh"
  | "stale_head"
  | "permission_denied"
  | "rejected"
  | "unavailable"
  | "outcome_unknown"
  | "review_write_in_progress"
  | "no_pending_review"
  | "pending_review_locked";

export type PendingReviewCommandResult = {
  readonly session: ReviewSession;
  readonly state: PendingReviewState;
};

/** Read-only renderer projection; unavailable is never none. */
export type PendingReviewProjection =
  | { readonly state: "none" }
  | { readonly state: "unavailable"; readonly action: "refresh" | "check_github_again" }
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
  | { readonly state: "recovery_required"; readonly action: "start" | "add_thread" | "submit" };

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
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly gate: Pick<ReviewWriteGate, "requireFresh" | "requireCurrentSession">,
    private readonly sessions: Pick<ReviewSessionStore, "load" | "save">,
    private readonly github: Gateway,
    private readonly now: () => IsoTimestamp,
  ) {}

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
  }): Promise<Result<{ readonly session: ReviewSession; readonly state: PendingReviewState; readonly unavailable: boolean }, PendingReviewServiceFailure>> {
    const current = await this.gate.requireCurrentSession(input.profileId, input.reviewId);
    if (current._tag === "err") return err(mapGateFailure(current.error.reason));
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
    if (read._tag === "err") {
      return ok({ session, state: stored, unavailable: true });
    }
    let next: PendingReviewState;
    if (isPendingReviewLocked(stored)) {
      next = input.recover === true
        ? reconcilePendingReviewState(stored, read.value)
        : stored;
    } else {
      next = read.value._tag === "Pending"
        ? { _tag: "Pending", review: read.value.review }
        : { _tag: "None" };
    }
    if (samePendingReviewState(next, stored)) {
      return ok({ session, state: next, unavailable: false });
    }
    const saved = await this.sessions.save({ ...session, pendingReview: next, updatedAt: this.now() });
    if (saved._tag === "err") {
      return ok({ session, state: stored, unavailable: true });
    }
    return ok({ session: { ...session, pendingReview: next }, state: next, unavailable: false });
  }

  async start(input: StartPendingReviewInput): Promise<Result<PendingReviewCommandResult, PendingReviewServiceFailure>> {
    return this.serializedWrite(input.profileId, input.reviewId, input.expected, async (profile, session) => {
      const state = session.pendingReview ?? { _tag: "None" as const };
      const operation: PendingReviewOperation = {
        _tag: "Start",
        requestId: createPendingReviewRequestId(this.now()),
      };
      return this.executeWrite(session, state, operation, async () => {
        const created = await this.github.startPendingReviewWithThread({
          profile,
          pr: sessionPr(session),
          headSha: session.key.headSha,
          anchor: input.anchor,
          body: input.body,
        });
        return created._tag === "ok" ? ok(created.value) : err(created.error);
      });
    });
  }

  async addThread(input: AddPendingReviewThreadInput): Promise<Result<PendingReviewCommandResult, PendingReviewServiceFailure>> {
    return this.serializedWrite(input.profileId, input.reviewId, input.expected, async (profile, session) => {
      const state = session.pendingReview ?? { _tag: "None" as const };
      const operation: PendingReviewOperation = {
        _tag: "AddThread",
        requestId: createPendingReviewRequestId(this.now()),
        reviewId: input.pendingReviewNodeId,
        anchor: input.anchor,
      };
      return this.executeWrite(session, state, operation, async () => {
        const appended = await this.github.addPendingReviewThread({
          profile,
          pr: sessionPr(session),
          reviewId: input.pendingReviewNodeId,
          anchor: input.anchor,
          body: input.body,
        });
        return appended._tag === "ok" ? ok(appended.value) : err(appended.error);
      });
    });
  }

  async submit(input: SubmitPendingReviewInput): Promise<Result<PendingReviewCommandResult, PendingReviewServiceFailure>> {
    return this.serializedWrite(input.profileId, input.reviewId, input.expected, async (profile, session) => {
      const state = session.pendingReview ?? { _tag: "None" as const };
      if (state._tag !== "Pending") return err("no_pending_review");
      const operation: PendingReviewOperation = {
        _tag: "Submit",
        requestId: createPendingReviewRequestId(this.now()),
        reviewId: state.review.restId,
        event: input.event,
      };
      return this.executeWrite(session, state, operation, async () => {
        const submitted = await this.github.submitPendingReview({
          profile,
          pr: sessionPr(session),
          reviewId: state.review.restId,
          event: input.event,
          summaryBody: input.summaryBody,
        });
        // A confirmed submit removes the pending owner; the submitted feedback
        // becomes visible through the next explicit refresh.
        return submitted._tag === "ok" ? ok(undefined) : err(submitted.error);
      });
    });
  }

  private async serializedWrite(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    expected: ReviewWriteExpectation,
    operation: (profile: WorkspaceProfileConfig, session: ReviewSession) => Promise<Result<PendingReviewCommandResult, PendingReviewServiceFailure>>,
  ): Promise<Result<PendingReviewCommandResult, PendingReviewServiceFailure>> {
    const key = `${profileId}:${reviewId}`;
    if (this.inFlight.has(key)) return err("review_write_in_progress");
    this.inFlight.add(key);
    try {
      const fresh = await this.gate.requireFresh(profileId, reviewId, expected);
      if (fresh._tag === "err") return err(mapGateFailure(fresh.error.reason));
      const { profile, session } = fresh.value;
      // Final current-head check immediately before any write, matching the
      // direct-conversation boundary: the represented snapshot is fresh, and
      // the live head must still match it.
      const current = await this.github.getPullRequest({ profile, pr: sessionPr(session) });
      if (current._tag === "err") return err("unavailable");
      if (current.value.headSha !== session.key.headSha) return err("stale_head");
      return operation(profile, session);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async executeWrite(
    session: ReviewSession,
    state: PendingReviewState,
    operation: PendingReviewOperation,
    write: () => Promise<Result<ViewerPendingReview | undefined, { readonly _tag: "GitHubWriteFailure"; readonly category: "auth" | "rejected" | "unavailable" | "pending_review"; readonly message: string }>>,
  ): Promise<Result<PendingReviewCommandResult, PendingReviewServiceFailure>> {
    const begun = beginPendingReviewWrite(state, operation, this.now());
    if (begun._tag === "err") {
      return err(isPendingReviewLocked(state) ? "pending_review_locked" : "no_pending_review");
    }
    // Persist the operation intent before crossing the remote write boundary.
    if (!(await this.persist(session, begun.value))) return err("outcome_unknown");
    const written = await write();
    if (written._tag === "err") {
      if (written.error.category === "unavailable") {
        // Timeout, lost response, or unconfirmable outcome: lock and require
        // read-side reconciliation; never retry automatically.
        const unknown = markPendingReviewOutcomeUnknown(begun.value);
        if (unknown._tag === "ok" && !(await this.persist(session, unknown.value))) {
          return err("outcome_unknown");
        }
        return err("outcome_unknown");
      }
      const rejected = rejectPendingReviewWrite(begun.value);
      if (rejected._tag === "ok") await this.persist(session, rejected.value);
      return err(written.error.category === "auth" ? "permission_denied" : "rejected");
    }
    const confirmed = confirmPendingReviewWrite(begun.value, written.value);
    if (confirmed._tag === "err") return err("outcome_unknown");
    // A confirmed receipt must be durable before success is reported.
    if (!(await this.persist(session, confirmed.value))) {
      const unknown = markPendingReviewOutcomeUnknown(begun.value);
      if (unknown._tag === "ok") await this.persist(session, unknown.value);
      return err("outcome_unknown");
    }
    return ok({ session: { ...session, pendingReview: confirmed.value }, state: confirmed.value });
  }

  private async persist(session: ReviewSession, pendingReview: PendingReviewState): Promise<boolean> {
    const saved = await this.sessions.save({ ...session, pendingReview, updatedAt: this.now() });
    return saved._tag === "ok";
  }
}

/** Build the renderer projection from durable state and read availability. */
export function projectPendingReview(
  state: PendingReviewState,
  unavailable: boolean,
): PendingReviewProjection {
  if (unavailable) {
    return { state: "unavailable", action: isPendingReviewLocked(state) ? "check_github_again" : "refresh" };
  }
  if (state._tag === "WriteInFlight" || state._tag === "OutcomeUnknown") {
    return { state: "recovery_required", action: state.operation._tag === "Start" ? "start" : state.operation._tag === "AddThread" ? "add_thread" : "submit" };
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
  return { host: session.key.host, owner: session.key.owner, repo: session.key.repo, number: session.key.prNumber };
}

function samePendingReviewState(left: PendingReviewState, right: PendingReviewState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mapGateFailure(reason: string): PendingReviewServiceFailure {
  if (reason === "not_found") return "not_found";
  if (reason === "terminal" || reason === "stale") return "permission_denied";
  if (reason === "not_fresh") return "not_fresh";
  return "unavailable";
}
