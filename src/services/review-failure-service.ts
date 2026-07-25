import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  parseReviewAttemptId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type IsoTimestamp,
} from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import { readObjectField } from "./read-object-field";

/**
 * Persists a failed live run so the session becomes visibly runnable again.
 * Clearing currentAttemptId is deliberate: the ready card and the normal
 * start path take over, and resume never re-enters a dead run.
 */
export class ReviewFailureService {
  constructor(private readonly paths: PatchdeskPaths, private readonly now: () => IsoTimestamp) {}

  async fail(input: unknown): Promise<Result<{ readonly failed: true }, { readonly reason: string }>> {
    const profileId = parseWorkspaceProfileId(readObjectField(input, "profileId"));
    const sessionId = parseReviewSessionId(readObjectField(input, "sessionId"));
    const attemptId = parseReviewAttemptId(readObjectField(input, "attemptId"));
    const message = readObjectField(input, "message");
    const rawCategory = readObjectField(input, "category");
    const category = rawCategory === "flue" || rawCategory === "storage" ? rawCategory : "unknown";
    if (
      profileId._tag === "err" || sessionId._tag === "err" || attemptId._tag === "err" ||
      typeof message !== "string" || message.length === 0
    ) return err({ reason: "invalid_input" });

    const store = new ReviewSessionStore(this.paths);
    const [session, attempt] = await Promise.all([
      store.load(profileId.value, sessionId.value),
      store.loadAttempt(profileId.value, sessionId.value, attemptId.value),
    ]);
    if (session._tag === "err" || attempt._tag === "err") return err({ reason: "not_found" });
    if (
      session.value.currentAttemptId !== attemptId.value ||
      session.value.state._tag !== "Running" ||
      (attempt.value.state._tag !== "Starting" && attempt.value.state._tag !== "Running")
    ) return err({ reason: "not_current" });

    const error = { category, message };
    const failedAt = this.now();
    const failedAttempt = { ...attempt.value, state: { _tag: "Failed" as const, error }, completedAt: failedAt };
    const { currentAttemptId: _cleared, ...sessionRest } = session.value;
    void _cleared;
    const failedSession = {
      ...sessionRest,
      state: { _tag: "ReviewFailed" as const, attemptId: attemptId.value, error },
      updatedAt: failedAt,
    };
    const savedAttempt = await store.saveAttempt(profileId.value, sessionId.value, failedAttempt);
    const savedSession = savedAttempt._tag === "ok" ? await store.save(failedSession) : savedAttempt;
    return savedSession._tag === "ok" ? ok({ failed: true as const }) : err({ reason: "storage_failed" });
  }
}