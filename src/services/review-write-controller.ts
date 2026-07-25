import type { GitHubReader, GitHubReviewWriter } from "../adapters/github/github-adapter";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { GitHubReviewEvent, ReviewDraft } from "../domain/review-draft";
import { parseIsoTimestamp, parseReviewSessionId, parseWorkspaceProfileId, type IsoTimestamp } from "../domain/ids";
import type { ReviewSession } from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import { createPendingReview, submitPendingReview } from "./review-submission-service";
import { applyReviewBatch } from "./review-submission-service";
import { readObjectField } from "./read-object-field";

export type ReviewWriteResponse = {
  readonly session: unknown;
  readonly draft?: unknown;
  readonly batch?: unknown;
};

export type ReviewWriteControllerFailure = { readonly reason: string };

/** Main-process orchestration for explicit renderer review-write actions. It owns profile/session loading and persistence. */
export class ReviewWriteController {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly profiles: ProfileStore,
    private readonly sessions: ReviewSessionStore,
    private readonly github: Pick<GitHubReader, "getPullRequest"> & GitHubReviewWriter,
    private readonly now: () => IsoTimestamp,
  ) {}

  async createPending(input: unknown): Promise<Result<ReviewWriteResponse, ReviewWriteControllerFailure>> {
    return this.withLoaded(input, async ({ profile, session, draft }) => {
      const created = await createPendingReview({ profile, session, draft, gateway: this.github, now: this.now() });
      if (created._tag === "ok") {
        const persisted = await this.sessions.save(created.value.session);
        return persisted._tag === "ok" ? ok(created.value) : err({ reason: "storage_failed" });
      }
      await this.persistFailure(created.error);
      return err({ reason: failureReason(created.error._tag) });
    });
  }

  async submitPending(input: unknown): Promise<Result<ReviewWriteResponse, ReviewWriteControllerFailure>> {
    const event = readObjectField(input, "event");
    if (!isReviewEvent(event)) return err({ reason: "invalid_input" });
    return this.withLoaded(input, async ({ profile, session, draft }) => {
      const submitted = await submitPendingReview({ profile, session, draft, event, summaryBody: draft.summaryBody, gateway: this.github, now: this.now() });
      if (submitted._tag === "ok") {
        const persisted = await this.sessions.save(submitted.value.session);
        return persisted._tag === "ok" ? ok(submitted.value) : err({ reason: "storage_failed" });
      }
      await this.persistFailure(submitted.error);
      return err({ reason: failureReason(submitted.error._tag) });
    });
  }

  async applyBatch(input: unknown): Promise<Result<ReviewWriteResponse, ReviewWriteControllerFailure>> {
    return this.withLoadedBatch(input, async ({ profile, session, batch }) => {
      const applied = await applyReviewBatch({ profile, session, batch, gateway: this.github, now: this.now(), persist: async (next) => (await this.sessions.save(next))._tag === "ok" });
      if (applied._tag === "ok") return ok({ session: applied.value.session, batch: applied.value.batch });
      if (applied.error._tag === "StaleHeadBlocksWrite") {
        await this.sessions.save(applied.error.session);
      }
      return err({ reason: failureReason(applied.error._tag) });
    });
  }

  private async withLoaded(
    input: unknown,
    operation: (value: { readonly profile: WorkspaceProfileConfig; readonly session: ReviewSession; readonly draft: ReviewDraft }) => Promise<Result<ReviewWriteResponse, ReviewWriteControllerFailure>>,
  ): Promise<Result<ReviewWriteResponse, ReviewWriteControllerFailure>> {
    const profileId = parseWorkspaceProfileId(readObjectField(input, "profileId"));
    const sessionId = parseReviewSessionId(readObjectField(input, "sessionId"));
    const expectedRevision = parseIsoTimestamp(readObjectField(input, "expectedRevision"));
    if (profileId._tag === "err" || sessionId._tag === "err" || expectedRevision._tag === "err" || readObjectField(input, "acknowledgement") !== true) return err({ reason: "invalid_input" });
    const key = `${profileId.value}:${sessionId.value}`;
    if (this.inFlight.has(key)) return err({ reason: "review_write_in_progress" });
    this.inFlight.add(key);
    try {
      const [profile, session] = await Promise.all([this.profiles.load(profileId.value), this.sessions.load(profileId.value, sessionId.value)]);
      if (profile._tag === "err") return err({ reason: "profile_not_found" });
      if (session._tag === "err") return err({ reason: "session_not_found" });
      const durableDraft = session.value.draftContent;
      if (durableDraft === undefined) return err({ reason: "draft_not_found" });
      if (session.value.currentAttemptId !== durableDraft.attemptId) return err({ reason: "draft_attempt_mismatch" });
      if (durableDraft.updatedAt !== expectedRevision.value) return err({ reason: "revision_conflict" });
      return operation({ profile: profile.value, session: session.value, draft: durableDraft });
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async withLoadedBatch(input: unknown, operation: (value: { readonly profile: WorkspaceProfileConfig; readonly session: ReviewSession; readonly batch: NonNullable<ReviewSession["batchContent"]> }) => Promise<Result<ReviewWriteResponse, ReviewWriteControllerFailure>>): Promise<Result<ReviewWriteResponse, ReviewWriteControllerFailure>> {
    const profileId = parseWorkspaceProfileId(readObjectField(input, "profileId"));
    const sessionId = parseReviewSessionId(readObjectField(input, "sessionId"));
    const expectedRevision = parseIsoTimestamp(readObjectField(input, "expectedRevision"));
    if (profileId._tag === "err" || sessionId._tag === "err" || expectedRevision._tag === "err" || readObjectField(input, "acknowledgement") !== true) return err({ reason: "invalid_input" });
    const key = `${profileId.value}:${sessionId.value}`;
    if (this.inFlight.has(key)) return err({ reason: "review_write_in_progress" });
    this.inFlight.add(key);
    try {
      const [profile, session] = await Promise.all([this.profiles.load(profileId.value), this.sessions.load(profileId.value, sessionId.value)]);
      if (profile._tag === "err") return err({ reason: "profile_not_found" });
      if (session._tag === "err") return err({ reason: "session_not_found" });
      const batch = session.value.batchContent;
      if (batch === undefined || batch.updatedAt !== expectedRevision.value || session.value.currentAttemptId !== batch.attemptId) return err({ reason: "revision_conflict" });
      return operation({ profile: profile.value, session: session.value, batch });
    } finally { this.inFlight.delete(key); }
  }

  private async persistFailure(error: unknown): Promise<void> {
    if (typeof error !== "object" || error === null || !("session" in error)) return;
    const session = (error as { readonly session?: unknown }).session;
    if (session !== undefined) await this.sessions.save(session);
  }
}


function isReviewEvent(value: unknown): value is GitHubReviewEvent {
  return value === "APPROVE" || value === "COMMENT" || value === "REQUEST_CHANGES";
}

function failureReason(tag: string): string {
  return tag === "GitHubWriteRejected" || tag === "GitHubSubmitFailed" ? "github_rejected" : tag === "StaleHeadBlocksWrite" ? "stale_head" : "review_write_failed";
}
