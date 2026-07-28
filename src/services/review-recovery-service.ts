import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewArtifactStorage } from "../adapters/storage/review-artifact-storage";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { IsoTimestamp, WorkspaceProfileId } from "../domain/ids";
import { ReviewPreparationJournal } from "./review-preparation-journal";
import { recoverOrphanedWorkbenchAttempt } from "./review-workbench";

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
    } = {},
  ) {}

  /** Quarantine invalid entries and convert owned-process-less attempts to Interrupted. */
  async reconcile(): Promise<{ readonly recovered: number; readonly failed: number }> {
    const profiles = await this.profiles.list();
    if (profiles._tag === "err") return { recovered: 0, failed: 1 };
    let recovered = 0;
    let failed = 0;
    for (const profile of profiles.value) {
      const scan = await this.sessions.scanSessionEntries(profile.id);
      if (scan._tag === "err") {
        failed += 1;
        continue;
      }
      for (const invalid of scan.value.invalidEntries) {
        await this.options.recordDiagnostic?.({
          profileId: profile.id,
          entryName: invalid.entryName,
          reason: "invalid_session",
        });
        if (invalid.sessionId === undefined || this.options.artifacts === undefined) {
          failed += 1;
          continue;
        }
        const quarantined = await this.options.artifacts.quarantine(profile.id, invalid.sessionId);
        if (quarantined._tag === "ok") recovered += 1;
        else failed += 1;
      }
      for (const session of scan.value.sessions) {
        if (this.options.paths !== undefined) {
          const active = await ReviewPreparationJournal.activeFor(
            this.options.paths,
            profile.id,
            session.id,
          );
          if (active._tag === "err") {
            failed += 1;
            continue;
          }
          if (active.value !== undefined) continue;
        }
        if (session.currentAttemptId === undefined) continue;
        const attempt = await this.sessions.loadAttempt(profile.id, session.id, session.currentAttemptId);
        if (attempt._tag === "err") {
          failed += 1;
          continue;
        }
        const result = recoverOrphanedWorkbenchAttempt({ session, attempt: attempt.value, recoveredAt: this.now() });
        if (result._tag === "err") continue;
        const attemptSaved = await this.sessions.saveAttempt(profile.id, session.id, result.value.attempt);
        const sessionSaved = attemptSaved._tag === "ok" ? await this.sessions.save(result.value.session) : attemptSaved;
        if (sessionSaved._tag === "ok") recovered += 1;
        else failed += 1;
      }
    }
    return { recovered, failed };
  }
}
