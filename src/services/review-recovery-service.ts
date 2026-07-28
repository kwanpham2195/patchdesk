import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewArtifactStorage } from "../adapters/storage/review-artifact-storage";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { IsoTimestamp, WorkspaceProfileId } from "../domain/ids";
import { ReviewPreparationJournal } from "./review-preparation-journal";
import { recoverOrphanedWorkbenchAttempt } from "./review-workbench";
import type { ReviewLifecycleGate } from "./review-lifecycle-gate";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";

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
      readonly diagnostics?: Pick<ReviewDiagnosticService, "record">;
      readonly lifecycleGate?: ReviewLifecycleGate;
    } = {},
  ) {}

  /** Quarantine invalid entries and convert owned-process-less attempts to Interrupted. */
  async reconcile(): Promise<{ readonly recovered: number; readonly failed: number }> {
    const profiles = await this.profiles.list();
    if (profiles._tag === "err") return { recovered: 0, failed: 1 };
    let recovered = 0;
    let failed = 0;
    for (const profile of profiles.value) {
      const result = this.options.lifecycleGate === undefined
        ? await this.reconcileProfile(profile.id)
        : await this.options.lifecycleGate.withProfileLock(profile.id, () => this.reconcileProfile(profile.id));
      recovered += result.recovered;
      failed += result.failed;
    }
    return { recovered, failed };
  }

  private async recordDiagnostic(event: RecoveryDiagnostic): Promise<void> {
    if (this.options.diagnostics !== undefined) {
      await this.options.diagnostics.record({
        profileId: event.profileId,
        category: "recovery",
        phase: event.reason,
        retryable: true,
        detail: event.entryName,
      });
      return;
    }
    if (this.options.recordDiagnostic !== undefined) {
      await this.options.recordDiagnostic(event);
      return;
    }
    if (this.options.paths === undefined) return;
    const root = this.options.paths.profileReviewsDirectory(event.profileId);
    try {
      await mkdir(root, { recursive: true });
      await appendFile(
        join(root, "diagnostics.jsonl"),
        `${JSON.stringify({ at: this.now(), kind: event.reason, entryName: event.entryName.slice(0, 160) })}\n`,
        "utf8",
      );
    } catch {
      // Invalid evidence remains quarantined even if diagnostics cannot be written.
    }
  }

  private async reconcileProfile(
    profileId: WorkspaceProfileId,
  ): Promise<{ readonly recovered: number; readonly failed: number }> {
    const scan = await this.sessions.scanSessionEntries(profileId);
    if (scan._tag === "err") {
      if (this.options.diagnostics !== undefined) {
        await this.options.diagnostics.record({
          profileId,
          category: "migration",
          phase: "session-scan",
          retryable: true,
          detail: "Review session migration could not scan local entries safely.",
        });
      }
      return { recovered: 0, failed: 1 };
    }
    let recovered = 0;
    let failed = 0;
    for (const invalid of scan.value.invalidEntries) {
      await this.recordDiagnostic({ profileId, entryName: invalid.entryName, reason: "invalid_session" });
      if (this.options.artifacts === undefined) {
        failed += 1;
        continue;
      }
      const quarantined = invalid.sessionId === undefined
        ? await this.options.artifacts.quarantineInvalidEntry(profileId, invalid.entryName)
        : await this.options.artifacts.quarantine(profileId, invalid.sessionId);
      if (quarantined._tag === "ok") {
        recovered += 1;
      } else {
        failed += 1;
        await this.options.diagnostics?.record({
          profileId,
          category: "migration",
          phase: "quarantine-failed",
          retryable: true,
          detail: "Invalid local review evidence could not be quarantined safely.",
        });
      }
    }
    for (const session of scan.value.sessions) {
      if (this.options.paths !== undefined) {
        const active = await ReviewPreparationJournal.activeFor(this.options.paths, profileId, session.id, this.options.diagnostics);
        if (active._tag === "err") {
          failed += 1;
          if (this.options.diagnostics !== undefined) {
            await this.options.diagnostics.record({
              profileId,
              sessionId: session.id,
              category: "recovery",
              phase: "preparation-active-read",
              retryable: true,
              detail: "Preparation state could not be reconciled safely.",
            });
          }
          continue;
        }
        if (active.value !== undefined) continue;
      }
      if (session.currentAttemptId === undefined) continue;
      const attempt = await this.sessions.loadAttempt(profileId, session.id, session.currentAttemptId);
      if (attempt._tag === "err") {
        failed += 1;
        if (this.options.diagnostics !== undefined) {
          await this.options.diagnostics.record({
            profileId,
            sessionId: session.id,
            category: "migration",
            phase: "attempt-reconcile",
            retryable: true,
            detail: "A stored review attempt could not be reconciled safely.",
          });
        }
        continue;
      }
      const result = recoverOrphanedWorkbenchAttempt({ session, attempt: attempt.value, recoveredAt: this.now() });
      if (result._tag === "err") {
        failed += 1;
        await this.options.diagnostics?.record({
          profileId,
          sessionId: session.id,
          category: "migration",
          phase: "attempt-recover",
          retryable: true,
          detail: "A stored review attempt could not be marked interrupted safely.",
        });
        continue;
      }
      const attemptSaved = await this.sessions.saveAttempt(profileId, session.id, result.value.attempt);
      if (attemptSaved._tag === "err") {
        failed += 1;
        await this.options.diagnostics?.record({
          profileId,
          sessionId: session.id,
          category: "migration",
          phase: "attempt-save",
          retryable: true,
          detail: "An interrupted review attempt could not be persisted.",
        });
        continue;
      }
      const sessionSaved = await this.sessions.save(result.value.session);
      if (sessionSaved._tag === "ok") {
        recovered += 1;
      } else {
        failed += 1;
        await this.options.diagnostics?.record({
          profileId,
          sessionId: session.id,
          category: "migration",
          phase: "session-save",
          retryable: true,
          detail: "The reconciled review session could not be persisted.",
        });
      }
    }
    return { recovered, failed };
  }
}
