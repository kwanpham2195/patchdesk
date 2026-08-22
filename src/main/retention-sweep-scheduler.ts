import type { WorkspaceProfileId } from "../domain/ids";
import type { ReviewDiagnosticService } from "../services/review-diagnostic-service";
import type { StorageManagementService } from "../services/storage-management-service";

/** Retention sweep interval once per 24 hours while the app runs. */
export const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type RetentionSweepScheduler = {
  stop(): Promise<void>;
};

/** Starts an owned retention sweep loop whose active work settles before stop completes. */
export function startRetentionSweepScheduler(input: {
  readonly profiles: ReadonlyArray<{ readonly id: WorkspaceProfileId }>;
  readonly storageManagement: Pick<StorageManagementService, "sweepRetained">;
  readonly enabled: boolean;
  readonly diagnostics?: Pick<ReviewDiagnosticService, "record">;
}): RetentionSweepScheduler {
  if (!input.enabled) return { stop: async () => undefined };

  let stopped = false;
  let activeRun: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  const run = (): void => {
    if (stopped || activeRun !== undefined) return;
    const runPromise = sweepProfiles(input);
    const trackedRun = runPromise.finally(() => {
      if (activeRun === trackedRun) activeRun = undefined;
    });
    activeRun = trackedRun;
    void trackedRun;
  };

  run();
  const timer = setInterval(run, RETENTION_SWEEP_INTERVAL_MS);
  timer.unref();

  return {
    stop(): Promise<void> {
      if (stopPromise !== undefined) return stopPromise;
      stopped = true;
      clearInterval(timer);
      stopPromise = activeRun ?? Promise.resolve();
      return stopPromise;
    },
  };
}

async function sweepProfiles(input: {
  readonly profiles: ReadonlyArray<{ readonly id: WorkspaceProfileId }>;
  readonly storageManagement: Pick<StorageManagementService, "sweepRetained">;
  readonly diagnostics?: Pick<ReviewDiagnosticService, "record">;
}): Promise<void> {
  await Promise.all(
    input.profiles.map(async (profile) => {
      try {
        const result = await input.storageManagement.sweepRetained(profile.id);
        if (result._tag === "err")
          await recordSweepFailure(input.diagnostics, profile.id);
      } catch {
        await recordSweepFailure(input.diagnostics, profile.id);
      }
    }),
  );
}

async function recordSweepFailure(
  diagnostics: Pick<ReviewDiagnosticService, "record"> | undefined,
  profileId: WorkspaceProfileId,
): Promise<void> {
  if (diagnostics === undefined) return;
  try {
    await diagnostics.record({
      profileId,
      category: "cleanup",
      phase: "retention_sweep",
      retryable: true,
      detail: "profile sweep failed",
    });
  } catch {
    // Retention diagnostics are best effort and must not escape the scheduler.
  }
}
