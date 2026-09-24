import type { NotificationSettings } from "../domain/contracts";
import type { LogEntryInput } from "../domain/log-entry";
import type { Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type { ReviewOperationCoordinator } from "../services/review-operation-coordinator";
import type { WatchedPullRequestService } from "../services/watched-pull-request-service";

export type WatchedPullRequestScheduler = {
  /** Restarts the wait from now when the interval changed; a tick in flight still finishes once. */
  reschedule(intervalMinutes: NotificationSettings["intervalMinutes"]): void;
  stop(): Promise<void>;
};

type WatchedPullRequestSchedulerInput = {
  readonly profiles: ReadonlyArray<WorkspaceProfileConfig>;
  readonly watched: Pick<WatchedPullRequestService, "poll">;
  readonly coordinator: Pick<ReviewOperationCoordinator, "hasActiveOperation">;
  /** The interval at start; `reschedule` replaces it. */
  readonly intervalMinutes: NotificationSettings["intervalMinutes"];
  /** Read on every tick: with notifications off, nothing asks GitHub. */
  readonly settings: () => Promise<
    Result<NotificationSettings, "config_unreadable">
  >;
  readonly enabled: boolean;
  readonly logs: { write(input: LogEntryInput): void };
};

/**
 * Polls every watched pull request while the app runs (ADR 0045): once at
 * start, then every `intervalMinutes` until `reschedule` changes it. A tick
 * with notifications off asks GitHub nothing, a profile with a GitHub write or
 * write recovery in flight waits for the next tick, and a failed tick is not
 * retried early.
 */
export function startWatchedPullRequestScheduler(
  input: WatchedPullRequestSchedulerInput,
): WatchedPullRequestScheduler {
  if (!input.enabled)
    return { reschedule: () => undefined, stop: async () => undefined };

  let stopped = false;
  let activeRun: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  const run = (): void => {
    if (stopped || activeRun !== undefined) return;
    const trackedRun = pollProfiles(input).finally(() => {
      if (activeRun === trackedRun) activeRun = undefined;
    });
    activeRun = trackedRun;
  };

  const every = (minutes: number): NodeJS.Timeout => {
    const timer = setInterval(run, minutes * 60_000);
    timer.unref();
    return timer;
  };

  run();
  let intervalMinutes = input.intervalMinutes;
  let timer = every(intervalMinutes);

  return {
    reschedule(next): void {
      // Every settings save sends the interval, so an unchanged one must not push the next tick back.
      if (stopped || next === intervalMinutes) return;
      clearInterval(timer);
      intervalMinutes = next;
      timer = every(next);
    },
    stop(): Promise<void> {
      if (stopPromise !== undefined) return stopPromise;
      stopped = true;
      clearInterval(timer);
      stopPromise = activeRun ?? Promise.resolve();
      return stopPromise;
    },
  };
}

async function pollProfiles(
  input: WatchedPullRequestSchedulerInput,
): Promise<void> {
  const settings = await input.settings();
  if (settings._tag === "err" || !settings.value.enabled) {
    log(input, "skipped", {
      reason: settings._tag === "err" ? settings.error : "disabled",
    });
    return;
  }
  await Promise.all(
    input.profiles.map((profile) => pollProfile(input, profile)),
  );
}

async function pollProfile(
  input: WatchedPullRequestSchedulerInput,
  profile: WorkspaceProfileConfig,
): Promise<void> {
  if (input.coordinator.hasActiveOperation(profile.id)) {
    log(input, "skipped", { profileId: profile.id, reason: "write_active" });
    return;
  }
  try {
    const outcome = await input.watched.poll(profile);
    if (outcome._tag === "polled")
      log(input, "polled", {
        profileId: profile.id,
        notified: outcome.notified,
        inaccessible: outcome.inaccessible,
      });
    else if (outcome._tag === "failed")
      log(input, "skipped", { profileId: profile.id, reason: outcome.reason });
  } catch {
    log(input, "skipped", { profileId: profile.id, reason: "defect" });
  }
}

function log(
  input: WatchedPullRequestSchedulerInput,
  message: "polled" | "skipped",
  meta: Readonly<Record<string, string | number>>,
): void {
  input.logs.write({
    process: "main",
    level: "debug",
    topic: "watched-pull-requests",
    message,
    meta,
  });
}
