import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { IsoTimestamp } from "../domain/ids";
import { recoverOrphanedWorkbenchAttempt } from "./review-workbench";

/** Reconciles persisted running attempts once on startup without relaunching them. */
export class ReviewRecoveryService {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly sessions: ReviewSessionStore,
    private readonly now: () => IsoTimestamp,
  ) {}

  async reconcile(): Promise<{ readonly recovered: number; readonly failed: number }> {
    const profiles = await this.profiles.list();
    if (profiles._tag === "err") return { recovered: 0, failed: 1 };
    let recovered = 0;
    let failed = 0;
    for (const profile of profiles.value) {
      const sessions = await this.sessions.listSessions(profile.id);
      if (sessions._tag === "err") { failed += 1; continue; }
      for (const session of sessions.value) {
        if (session.state._tag !== "Running" || session.currentAttemptId === undefined) continue;
        const attempt = await this.sessions.loadAttempt(profile.id, session.id, session.currentAttemptId);
        if (attempt._tag === "err") { failed += 1; continue; }
        const result = recoverOrphanedWorkbenchAttempt({ session, attempt: attempt.value, recoveredAt: this.now() });
        if (result._tag === "err") continue;
        const attemptSaved = await this.sessions.saveAttempt(profile.id, session.id, result.value.attempt);
        const sessionSaved = attemptSaved._tag === "ok" ? await this.sessions.save(result.value.session) : attemptSaved;
        if (sessionSaved._tag === "ok") recovered += 1; else failed += 1;
      }
    }
    return { recovered, failed };
  }
}
