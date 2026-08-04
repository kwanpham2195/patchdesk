import type { GitHubReader, GitHubReviewWriter } from "../adapters/github/github-adapter";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import { createEmptyReviewBatch, type GitHubReviewEvent, type ReviewBatch } from "../domain/review-batch";
import { parseContentHash, parseGitSha, parseInsightRunId, parseIsoTimestamp, parsePublicationAuthorizationId, parseReviewId, parseReviewSessionId, parseWorkspaceProfileId, type IsoTimestamp } from "../domain/ids";
import type { ReviewSession } from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type { AnalysisCompletionService } from "./analysis-completion-service";
import type { ReviewWriteGate } from "./review-write-gate";
import { applyReviewBatch, submitReviewBatch } from "./review-submission-service";
import { readObjectField } from "./read-object-field";

export type ReviewWriteResponse = {
  readonly session: unknown;
  readonly batch?: unknown;
};

export type ReviewWriteControllerFailure = { readonly reason: string };

/** Main-process orchestration for explicit renderer review-write actions. It owns profile/session loading and persistence. */
export class ReviewWriteController {
  private readonly inFlight = new Set<string>();

  constructor(
    _profiles: ProfileStore,
    private readonly sessions: ReviewSessionStore,
    private readonly github: Pick<GitHubReader, "getPullRequest"> & Partial<Pick<GitHubReader, "getPullRequestComments">> & GitHubReviewWriter,
    private readonly now: () => IsoTimestamp,
    private readonly completion?: Pick<AnalysisCompletionService, "consumeForPublication" | "consume">,
    private readonly writeGate?: ReviewWriteGate,
  ) {}

  async submitBatch(input: unknown): Promise<Result<ReviewWriteResponse, ReviewWriteControllerFailure>> {
    const event = readObjectField(input, "event");
    if (!isReviewEvent(event)) return err({ reason: "invalid_input" });
    return this.withLoadedBatch(input, async ({ profile, session, batch }) => {
      const submitted = await submitReviewBatch({ profile, session, batch, event, gateway: this.github, now: this.now(), persist: async (next) => (await this.sessions.save(next))._tag === "ok" });
      if (submitted._tag === "ok") {
        const persisted = await this.sessions.save(submitted.value.session);
        return persisted._tag === "ok"
          ? ok({ session: submitted.value.session, batch: submitted.value.batch })
          : err({ reason: "storage_failed" });
      }
      await this.persistFailure(submitted.error);
      return err({ reason: failureReason(submitted.error._tag) });
    });
  }

  async confirmPublication(input: unknown): Promise<Result<ReviewWriteResponse, ReviewWriteControllerFailure>> {
    const suppliedAuthorizationId = readObjectField(input, "authorizationId");
    const completion = this.completion;
    if (suppliedAuthorizationId === undefined || completion === undefined) {
      const applied = await this.applyBatch(input);
      if (applied._tag === "err") return applied;
      const batch = applied.value.batch as NonNullable<ReviewSession["batchContent"]> | undefined;
      if (batch === undefined) return err({ reason: "review_write_failed" });
      const next = { ...(typeof input === "object" && input !== null ? input : {}), expectedRevision: batch.updatedAt };
      const submitted = await this.submitBatch(next);
      return submitted._tag === "ok" ? this.rotateToSuccessorDraft({ session: submitted.value.session as ReviewSession, batch: submitted.value.batch as ReviewBatch }) : submitted;
    }
    return this.withLoadedBatch(input, async ({ profile, session, batch }) => {
      const profileId = parseWorkspaceProfileId(readObjectField(input, "profileId"));
      const reviewId = parseReviewId(readObjectField(input, "reviewId"));
      const sessionId = parseReviewSessionId(readObjectField(input, "sessionId"));
      const authorizationId = parsePublicationAuthorizationId(suppliedAuthorizationId);
      const event = readObjectField(input, "event");
      const analysisRunId = parseInsightRunId(readObjectField(input, "analysisRunId"));
      const patchHash = parseContentHash(readObjectField(input, "expectedPatchHash"));
      const expectedDraftRevision = parseIsoTimestamp(readObjectField(input, "expectedRevision"));
      if (profileId._tag === "err" || reviewId._tag === "err" || sessionId._tag === "err" || authorizationId._tag === "err" || !isReviewEvent(event)) return err({ reason: "invalid_input" });
      if (this.writeGate !== undefined && (analysisRunId._tag !== "ok" || patchHash._tag !== "ok" || expectedDraftRevision._tag !== "ok" || completion.consume === undefined)) return err({ reason: "invalid_input" });
      const consumed = completion.consume !== undefined && analysisRunId._tag === "ok" && patchHash._tag === "ok" && expectedDraftRevision._tag === "ok"
        ? await completion.consume({ profileId: profileId.value, reviewId: reviewId.value, sessionId: sessionId.value, headSha: session.key.headSha, patchHash: patchHash.value, analysisRunId: analysisRunId.value, expectedDraftRevision: expectedDraftRevision.value, event, authorizationId: authorizationId.value, consumedAt: this.now() })
        : await completion.consumeForPublication({ profileId: profileId.value, reviewId: reviewId.value, sessionId: sessionId.value, headSha: session.key.headSha, event, authorizationId: authorizationId.value, consumedAt: this.now() });
      if (consumed._tag === "err") return err({ reason: consumed.error });
      const applied = await applyReviewBatch({ profile, session, batch, gateway: this.github, now: this.now(), persist: async (next) => (await this.sessions.save(next))._tag === "ok" });
      if (applied._tag === "err") {
        await this.persistFailure(applied.error);
        return err({ reason: failureReason(applied.error._tag) });
      }
      const submitted = await submitReviewBatch({ profile, session: applied.value.session, batch: applied.value.batch, event, gateway: this.github, now: this.now(), persist: async (next) => (await this.sessions.save(next))._tag === "ok" });
      if (submitted._tag === "err") {
        await this.persistFailure(submitted.error);
        return err({ reason: failureReason(submitted.error._tag) });
      }
      // submitReviewBatch has already durably recorded the submitted evidence.
      // Install the successor and archive that evidence in one final session
      // replacement; if this save fails, the submitted marker remains
      // recoverable instead of being mistaken for a fresh local draft.
      return this.rotateToSuccessorDraft({ session: submitted.value.session, batch: submitted.value.batch });
    });
  }

  /** A confirmed publication archives its submitted evidence on the session and
   * installs a durable empty draft for the next local review. */
  private async rotateToSuccessorDraft(
    submitted: { readonly session: ReviewSession; readonly batch: ReviewBatch },
  ): Promise<Result<ReviewWriteResponse, ReviewWriteControllerFailure>> {
    const session = submitted.session;
    const successor = createEmptyReviewBatch({ sessionId: session.id ?? submitted.batch.sessionId, createdAt: this.now() });
    const nextSession: ReviewSession = {
      ...session,
      batch: { state: successor.state },
      batchContent: successor,
      archivedReceipts: [...(session.archivedReceipts ?? []), ...submitted.batch.receipts],
      updatedAt: successor.updatedAt,
    };
    const saved = await this.sessions.save(nextSession);
    return saved._tag === "ok"
      ? ok({ session: nextSession, batch: successor })
      : err({ reason: "storage_failed" });
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

  private async withLoadedBatch(input: unknown, operation: (value: { readonly profile: WorkspaceProfileConfig; readonly session: ReviewSession; readonly batch: NonNullable<ReviewSession["batchContent"]> }) => Promise<Result<ReviewWriteResponse, ReviewWriteControllerFailure>>): Promise<Result<ReviewWriteResponse, ReviewWriteControllerFailure>> {
    const profileId = parseWorkspaceProfileId(readObjectField(input, "profileId"));
    const sessionId = parseReviewSessionId(readObjectField(input, "sessionId"));
    const expectedRevision = parseIsoTimestamp(readObjectField(input, "expectedRevision"));
    const reviewId = parseReviewId(readObjectField(input, "reviewId"));
    const expectedHead = parseGitSha(readObjectField(input, "expectedHeadSha"));
    const expectedPatch = parseContentHash(readObjectField(input, "expectedPatchHash"));
    if (profileId._tag === "err" || sessionId._tag === "err" || reviewId._tag === "err" || expectedHead._tag === "err" || expectedPatch._tag === "err" || expectedRevision._tag === "err" || readObjectField(input, "acknowledgement") !== true || this.writeGate === undefined) return err({ reason: "invalid_input" });
    const key = `${profileId.value}:${reviewId.value}`;
    if (this.inFlight.has(key)) return err({ reason: "review_write_in_progress" });
    this.inFlight.add(key);
    try {
      const gated = await this.writeGate.requireFresh(profileId.value, reviewId.value, { sessionId: sessionId.value, headSha: expectedHead.value, patchHash: expectedPatch.value, draftRevision: expectedRevision.value });
      if (gated._tag === "err") return err({ reason: gated.error.reason });
      const [profile, session] = [ok(gated.value.profile), ok(gated.value.session)] as const;
      if (profile._tag === "err") return err({ reason: "profile_not_found" });
      if (session._tag === "err") return err({ reason: "session_not_found" });
      const batch = session.value.batchContent;
      if (batch === undefined || batch.updatedAt !== expectedRevision.value) return err({ reason: "revision_conflict" });
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
  return tag === "GitHubWriteRejected" || tag === "GitHubSubmitFailed" || tag === "BatchWriteRejected"
    ? "github_rejected"
    : tag === "StaleHeadBlocksWrite"
      ? "stale_head"
      : "review_write_failed";
}
