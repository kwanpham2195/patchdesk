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
import type { MergeOperationStore } from "../adapters/storage/merge-operation-store";
import type { GitHubReader } from "../adapters/github/github-adapter";
import { markSessionMerged } from "../domain/review-session";
import { rejectMergeOperation } from "../domain/merge-operation";

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
      readonly mergeOperations?: MergeOperationStore;
      readonly github?: Pick<GitHubReader, "getMergeOutcome">;
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
    if (this.options.mergeOperations !== undefined && this.options.github !== undefined) {
      const pending = await this.options.mergeOperations.listPending(profileId);
      if (pending._tag === "ok") {
        const profile = await this.profiles.load(profileId);
        if (profile._tag === "err") return { recovered: 0, failed: 1 };
        for (const operation of pending.value) {
          const outcome = await this.options.github.getMergeOutcome({ profile: profile.value, pr: operation.pr });
          if (outcome._tag === "err") {
            await this.options.diagnostics?.record({ profileId, sessionId: operation.sessionId, category: "recovery", phase: "merge-outcome-read", retryable: true, detail: "Merge outcome could not be reconciled safely." });
            continue;
          }
          if (outcome.value.state === "merged") {
            const session = await this.sessions.load(profileId, operation.sessionId);
            if (session._tag === "err") continue;
            const merged = markSessionMerged(session.value, outcome.value.mergedAt);
            if (merged._tag === "err") continue;
            const saved = await this.sessions.save({ ...merged.value, mergeDecision: { mergedAt: outcome.value.mergedAt, ...(outcome.value.mergeCommitSha === undefined ? {} : { mergeCommitSha: outcome.value.mergeCommitSha }) } });
            if (saved._tag === "ok") await this.options.mergeOperations.removeAfterSessionReceipt(profileId, operation.sessionId);
            continue;
          }
          const rejected = rejectMergeOperation(operation, outcome.value.state === "open" ? "merge_failed" : "merge_blocked");
          if (rejected._tag === "ok") await this.options.mergeOperations.reject(rejected.value);
        }
      }
    }
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
      if (session.state._tag !== "Running" || session.currentAttemptId === undefined) continue;
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
