import { createHash, randomUUID } from "node:crypto";

import type { GitHubDirectSummaryGateway, GitHubPendingReviewGateway, GitHubReader } from "../adapters/github/github-adapter";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { DirectSummaryReviewState } from "../domain/direct-summary-review";
import { parseGitHubLogin, type IsoTimestamp, type ReviewId, type WorkspaceProfileId } from "../domain/ids";
import type { PullRequestRef } from "../domain/pull-request";
import { err, ok, type Result } from "../domain/result";
import type { ReviewSession } from "../domain/review-session";
import type { GitHubReviewEvent } from "../domain/pending-review";
import type { ReviewWriteExpectation, ReviewWriteGate } from "./review-write-gate";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import { withReviewSessionMutationLock } from "./review-session-mutation-lock";

export type DirectSummaryReviewFailure =
  | "invalid_input"
  | "not_found"
  | "not_fresh"
  | "stale_head"
  | "permission_denied"
  | "pending_review_exists"
  | "rejected"
  | "unavailable"
  | "outcome_unknown"
  | "review_write_in_progress"
  | "self_approval_not_allowed";

export type DirectSummaryReviewProjection =
  | { readonly state: "idle" }
  | { readonly state: "confirmed"; readonly receipt: { readonly reviewId: string; readonly event: GitHubReviewEvent } }
  | { readonly state: "recovery_required"; readonly resolution: "check_required" | "manual_resolution_required" };

type Gateway = GitHubDirectSummaryGateway & Pick<GitHubPendingReviewGateway, "getViewerPendingReview"> & Pick<GitHubReader, "getPullRequest" | "resolveAuthenticatedAccount">;

/** Publishes exactly one non-pending GitHub review summary with durable recovery evidence. */
export class DirectSummaryReviewService {
  constructor(
    private readonly gate: Pick<ReviewWriteGate, "requireFresh" | "requireCurrentSession">,
    private readonly sessions: Pick<ReviewSessionStore, "load" | "save">,
    private readonly github: Gateway,
    private readonly now: () => IsoTimestamp,
    private readonly writeCoordinator: ReviewOperationCoordinator,
  ) {}

  async submit(input: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly expected: ReviewWriteExpectation;
    readonly event: GitHubReviewEvent;
    readonly body: string;
  }): Promise<Result<DirectSummaryReviewState, DirectSummaryReviewFailure>> {
    const body = input.body.trim();
    if (body.length === 0) return err("invalid_input");
    const key = `${input.profileId}:${input.reviewId}`;
    const acquired = this.writeCoordinator.acquire(key);
    if (!acquired) return err("review_write_in_progress");
        try {
      const fresh = await this.gate.requireFresh(input.profileId, input.reviewId, input.expected);
      if (fresh._tag === "err") return err(mapGateFailure(fresh.error.reason));
      const existing = fresh.value.session.directSummaryReview;
      if (existing?._tag === "OutcomeUnknown" || existing?._tag === "WriteInFlight") return err("outcome_unknown");
      const pr = sessionPr(fresh.value.session);
      const current = await this.github.getPullRequest({ profile: fresh.value.profile, pr });
      if (current._tag === "err") return err("unavailable");
      if (current.value.headSha !== fresh.value.session.key.headSha) return err("stale_head");
      const account = await this.github.resolveAuthenticatedAccount(fresh.value.profile);
      if (account._tag === "err") return err("unavailable");
      const login = parseGitHubLogin(account.value.account);
      if (login._tag === "err") return err("unavailable");
      if (input.event === "APPROVE" && current.value.author !== undefined && current.value.author.toLowerCase() === login.value.toLowerCase())
        return err("self_approval_not_allowed");
      const pending = await this.github.getViewerPendingReview({ profile: fresh.value.profile, pr, account: login.value });
      if (pending._tag === "err" || pending.value._tag === "Unavailable") return err("unavailable");
      if (pending.value._tag === "Pending") return err("pending_review_exists");
      const baseline = await this.github.getViewerDirectSummaryReviews({ profile: fresh.value.profile, pr, account: login.value });
      if (baseline._tag === "err" || !baseline.value.complete) return err("unavailable");
      const finalCurrent = await this.github.getPullRequest({ profile: fresh.value.profile, pr });
      if (finalCurrent._tag === "err") return err("unavailable");
      if (finalCurrent.value.headSha !== fresh.value.session.key.headSha) return err("stale_head");
      const finalPending = await this.github.getViewerPendingReview({ profile: fresh.value.profile, pr, account: login.value });
      if (finalPending._tag === "err" || finalPending.value._tag === "Unavailable") return err("unavailable");
      if (finalPending.value._tag === "Pending") return err("pending_review_exists");
      const operation = {
        requestId: randomUUID(),
        event: input.event,
        bodyDigest: digest(body),
        headSha: fresh.value.session.key.headSha,
        baselineReviewIds: baseline.value.reviews.map((review) => review.reviewId),
        startedAt: this.now(),
      };
      const inFlight: DirectSummaryReviewState = { _tag: "WriteInFlight", operation };
      if (!(await this.persist(fresh.value.session, inFlight))) return err("outcome_unknown");
      const written = await this.github.createDirectSummaryReview({ profile: fresh.value.profile, pr, headSha: fresh.value.session.key.headSha, event: input.event, body });
      if (written._tag === "err") {
        if (written.error.category === "unavailable") {
          await this.persist(fresh.value.session, { _tag: "OutcomeUnknown", operation, resolution: "check_required" });
          return err("outcome_unknown");
        }
        await this.clear(fresh.value.session);
        return err(written.error.category === "auth" ? "permission_denied" : written.error.category === "pending_review" ? "pending_review_exists" : "rejected");
      }
      const confirmed: DirectSummaryReviewState = { _tag: "Confirmed", receipt: written.value };
      if (!(await this.persist(fresh.value.session, confirmed))) {
        await this.persist(fresh.value.session, { _tag: "OutcomeUnknown", operation, resolution: "check_required" });
        return err("outcome_unknown");
      }
      return ok(confirmed);
    } finally {
      this.writeCoordinator.release(key);
    }
  }

  async reconcile(input: { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId }): Promise<Result<DirectSummaryReviewState | undefined, DirectSummaryReviewFailure>> {
    const key = `${input.profileId}:${input.reviewId}`;
    const acquired = this.writeCoordinator.acquire(key);
    if (!acquired) return err("review_write_in_progress");
        try {
    const current = await this.gate.requireCurrentSession(input.profileId, input.reviewId);
    if (current._tag === "err") return err(mapGateFailure(current.error.reason));
    const stored = current.value.session.directSummaryReview;
    if (stored === undefined || stored._tag === "Confirmed") return ok(stored);
    const account = await this.github.resolveAuthenticatedAccount(current.value.profile);
    if (account._tag === "err") return err("unavailable");
    const login = parseGitHubLogin(account.value.account);
    if (login._tag === "err") return err("unavailable");
    const read = await this.github.getViewerDirectSummaryReviews({ profile: current.value.profile, pr: sessionPr(current.value.session), account: login.value });
    if (read._tag === "err" || !read.value.complete) return err("unavailable");
    const baseline = new Set(stored.operation.baselineReviewIds);
    const candidates = read.value.reviews.filter((review) =>
      !baseline.has(review.reviewId) &&
      review.event === stored.operation.event &&
      review.headSha === stored.operation.headSha &&
      review.bodyDigest === stored.operation.bodyDigest &&
      submittedDuringOrAfter(review.submittedAt, stored.operation.startedAt),
    );
    // A matching review outside the bounded recovery window is evidence that
    // this read is not a complete absence proof. Keep the durable lock rather
    // than treating it as a safe no-write result and allowing a duplicate.
    if (candidates.some((review) => !submittedWithinRecoveryWindow(review.submittedAt, stored.operation.startedAt))) {
      const unresolved: DirectSummaryReviewState = { _tag: "OutcomeUnknown", operation: stored.operation, resolution: "manual_resolution_required" };
      if (!(await this.save(current.value.session, unresolved))) return err("unavailable");
      return ok(unresolved);
    }
    const matches = candidates;
    if (matches.length > 1) {
      const unresolved: DirectSummaryReviewState = { _tag: "OutcomeUnknown", operation: stored.operation, resolution: "manual_resolution_required" };
      if (!(await this.save(current.value.session, unresolved))) return err("unavailable");
      return ok(unresolved);
    }
    const match = matches[0];
    const next = match === undefined
      ? undefined
      : { _tag: "Confirmed" as const, receipt: match };
    if (!(await this.save(current.value.session, next))) return err("unavailable");
    return ok(next);
    } finally {
      this.writeCoordinator.release(key);
    }
  }

  private async persist(session: ReviewSession, state: DirectSummaryReviewState): Promise<boolean> {
    return this.save(session, state);
  }

  private async clear(session: ReviewSession): Promise<boolean> {
    return this.save(session, undefined);
  }

  private async save(session: ReviewSession, state: DirectSummaryReviewState | undefined): Promise<boolean> {
    return withReviewSessionMutationLock(`${session.key.profileId}:${session.id}`, async () => {
      const current = await this.sessions.load(session.key.profileId, session.id);
      if (current._tag === "err") return false;
      const next = {
        ...current.value,
        ...(state === undefined ? { directSummaryReview: undefined } : { directSummaryReview: state }),
        updatedAt: this.now(),
      };
      const saved = await this.sessions.save(next);
      return saved._tag === "ok";
    });
  }
}

export function projectDirectSummaryReview(state: DirectSummaryReviewState | undefined): DirectSummaryReviewProjection {
  if (state === undefined) return { state: "idle" };
  if (state._tag === "Confirmed") return { state: "confirmed", receipt: { reviewId: state.receipt.reviewId, event: state.receipt.event } };
  return { state: "recovery_required", resolution: state._tag === "OutcomeUnknown" ? state.resolution : "check_required" };
}

/** GitHub review timestamps have second precision while local intents retain milliseconds. */
function submittedDuringOrAfter(submittedAt: IsoTimestamp, startedAt: IsoTimestamp): boolean {
  return Math.floor(Date.parse(submittedAt) / 1_000) >= Math.floor(Date.parse(startedAt) / 1_000);
}
function submittedWithinRecoveryWindow(submittedAt: IsoTimestamp, startedAt: IsoTimestamp): boolean {
  return Date.parse(submittedAt) <= Date.parse(startedAt) + 5 * 60 * 1_000;
}

function digest(body: string): string { return createHash("sha256").update(body).digest("hex"); }
function sessionPr(session: ReviewSession): PullRequestRef { return { host: session.key.host, owner: session.key.owner, repo: session.key.repo, number: session.key.prNumber }; }
function mapGateFailure(reason: string): DirectSummaryReviewFailure {
  if (reason === "not_found") return "not_found";
  if (reason === "not_fresh") return "not_fresh";
  if (reason === "stale") return "stale_head";
  if (reason === "terminal") return "permission_denied";
  return "unavailable";
}
