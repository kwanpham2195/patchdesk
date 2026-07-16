import type { GitHubReader, GitHubReviewWriter } from "../adapters/github/github-adapter";
import { ProfileStore } from "../adapters/storage/profile-store";
import { ReviewSessionStore } from "../adapters/storage/review-session-store";
import { parseReviewDraft, type GitHubReviewEvent, type ReviewDraft } from "../domain/review-draft";
import { parseReviewSessionId, parseWorkspaceProfileId, type IsoTimestamp } from "../domain/ids";
import type { ReviewSession } from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import { createPendingReview, submitPendingReview } from "./review-submission-service";

export type ReviewWriteResponse = {
  readonly session: unknown;
  readonly draft: unknown;
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
    const event = field(input, "event");
    const summaryBody = field(input, "summaryBody");
    if (!isReviewEvent(event) || typeof summaryBody !== "string") return err({ reason: "invalid_input" });
    return this.withLoaded(input, async ({ profile, session, draft }) => {
      const submitted = await submitPendingReview({ profile, session, draft, event, summaryBody, gateway: this.github, now: this.now() });
      if (submitted._tag === "ok") {
        const persisted = await this.sessions.save(submitted.value.session);
        return persisted._tag === "ok" ? ok(submitted.value) : err({ reason: "storage_failed" });
      }
      await this.persistFailure(submitted.error);
      return err({ reason: failureReason(submitted.error._tag) });
    });
  }

  private async withLoaded(
    input: unknown,
    operation: (value: { readonly profile: WorkspaceProfileConfig; readonly session: ReviewSession; readonly draft: ReviewDraft }) => Promise<Result<ReviewWriteResponse, ReviewWriteControllerFailure>>,
  ): Promise<Result<ReviewWriteResponse, ReviewWriteControllerFailure>> {
    const profileId = parseWorkspaceProfileId(field(input, "profileId"));
    const sessionId = parseReviewSessionId(field(input, "sessionId"));
    const draft = parseReviewDraft(field(input, "draft"));
    if (profileId._tag === "err" || sessionId._tag === "err" || draft._tag === "err") return err({ reason: "invalid_input" });
    if (draft.value.sessionId !== sessionId.value) return err({ reason: "invalid_input" });
    const key = `${profileId.value}:${sessionId.value}`;
    if (this.inFlight.has(key)) return err({ reason: "review_write_in_progress" });
    this.inFlight.add(key);
    try {
      const [profile, session] = await Promise.all([this.profiles.load(profileId.value), this.sessions.load(profileId.value, sessionId.value)]);
      if (profile._tag === "err") return err({ reason: "profile_not_found" });
      if (session._tag === "err") return err({ reason: "session_not_found" });
      if (session.value.currentAttemptId !== draft.value.attemptId) return err({ reason: "draft_attempt_mismatch" });
      const durableDraft = session.value.draftContent;
      if (durableDraft !== undefined && !sameDraft(durableDraft, draft.value)) return err({ reason: "draft_changed_since_load" });
      const durableSession = durableDraft === undefined ? { ...session.value, draft: { state: draft.value.state }, draftContent: draft.value } : session.value;
      return operation({ profile: profile.value, session: durableSession, draft: durableDraft ?? draft.value });
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async persistFailure(error: unknown): Promise<void> {
    if (typeof error !== "object" || error === null || !("session" in error)) return;
    const session = (error as { readonly session?: unknown }).session;
    if (session !== undefined) await this.sessions.save(session);
  }
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && name in value ? (value as Record<string, unknown>)[name] : undefined;
}

function isReviewEvent(value: unknown): value is GitHubReviewEvent {
  return value === "APPROVE" || value === "COMMENT" || value === "REQUEST_CHANGES";
}

function failureReason(tag: string): string {
  return tag === "GitHubWriteRejected" || tag === "GitHubSubmitFailed" ? "github_rejected" : tag === "StaleHeadBlocksWrite" ? "stale_head" : "review_write_failed";
}

function sameDraft(left: ReviewDraft, right: ReviewDraft): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
