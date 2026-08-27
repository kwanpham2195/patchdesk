import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseWorkspaceProfileId,
  type InvalidDomainValue,
  type WorkspaceProfileId,
} from "../../src/domain/ids";
import { err, ok, type Result } from "../../src/domain/result";
import { startRetentionSweepScheduler } from "../../src/main/retention-sweep-scheduler";
import type {
  StorageManagementFailure,
  StorageManagementService,
} from "../../src/services/storage-management-service";
import type { ReviewDiagnosticService } from "../../src/services/review-diagnostic-service";

// The sweep interval is written out here rather than imported from the
// scheduler, so this test pins the once-per-24-hours rule instead of
// restating whatever the implementation happens to hold.
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

type SweepResult = Awaited<
  ReturnType<StorageManagementService["sweepRetained"]>
>;
type DiagnosticResult = Awaited<ReturnType<ReviewDiagnosticService["record"]>>;
type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

const profileId = unwrap(parseWorkspaceProfileId("cfw"));
const secondProfileId = unwrap(parseWorkspaceProfileId("opn"));

function unwrap<T>(result: Result<T, InvalidDomainValue>): T {
  if (result._tag === "ok") return result.value;
  throw new Error("Invalid test fixture");
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => {
    throw new Error("Deferred promise resolver was not initialized");
  };
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function storageManagement(
  sweepRetained: (profileId: WorkspaceProfileId) => Promise<SweepResult>,
): Pick<StorageManagementService, "sweepRetained"> {
  return { sweepRetained };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("retention sweep scheduler", () => {
  it("does not start work when disabled and makes stop safe", async () => {
    vi.useFakeTimers();
    const sweepRetained = vi.fn(async (): Promise<SweepResult> =>
      ok(undefined),
    );
    const scheduler = startRetentionSweepScheduler({
      profiles: [{ id: profileId }],
      storageManagement: storageManagement(sweepRetained),
      enabled: false,
    });

    await scheduler.stop();
    await scheduler.stop();

    expect(sweepRetained).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs one immediate sweep when enabled", async () => {
    vi.useFakeTimers();
    const sweepRetained = vi.fn(async (): Promise<SweepResult> =>
      ok(undefined),
    );
    const scheduler = startRetentionSweepScheduler({
      profiles: [{ id: profileId }],
      storageManagement: storageManagement(sweepRetained),
      enabled: true,
    });

    await scheduler.stop();

    expect(sweepRetained).toHaveBeenCalledTimes(1);
    expect(sweepRetained).toHaveBeenCalledWith(profileId);
  });

  it("starts one subsequent sweep for an interval tick", async () => {
    vi.useFakeTimers();
    const sweepRetained = vi.fn(async (): Promise<SweepResult> =>
      ok(undefined),
    );
    const scheduler = startRetentionSweepScheduler({
      profiles: [{ id: profileId }],
      storageManagement: storageManagement(sweepRetained),
      enabled: true,
    });

    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    await scheduler.stop();

    expect(sweepRetained).toHaveBeenCalledTimes(2);
  });

  it("unrefs the interval handle", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const sweepRetained = vi.fn(async (): Promise<SweepResult> =>
      ok(undefined),
    );
    const scheduler = startRetentionSweepScheduler({
      profiles: [{ id: profileId }],
      storageManagement: storageManagement(sweepRetained),
      enabled: true,
    });

    await scheduler.stop();

    const timer = setIntervalSpy.mock.results[0]?.value;
    expect(timer).toBeDefined();
    expect(timer?.hasRef()).toBe(false);
  });

  it("does not overlap interval sweeps", async () => {
    vi.useFakeTimers();
    const firstSweep = deferred<SweepResult>();
    let calls = 0;
    const sweepRetained = vi.fn(
      (_profileId: WorkspaceProfileId): Promise<SweepResult> => {
        calls += 1;
        return calls === 1
          ? firstSweep.promise
          : Promise.resolve(ok(undefined));
      },
    );
    const scheduler = startRetentionSweepScheduler({
      profiles: [{ id: profileId }],
      storageManagement: storageManagement(sweepRetained),
      enabled: true,
    });

    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(sweepRetained).toHaveBeenCalledTimes(1);

    firstSweep.resolve(ok(undefined));
    await firstSweep.promise;
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    await scheduler.stop();

    expect(sweepRetained).toHaveBeenCalledTimes(2);
  });

  it("clears future ticks when stopped", async () => {
    vi.useFakeTimers();
    const sweepRetained = vi.fn(async (): Promise<SweepResult> =>
      ok(undefined),
    );
    const scheduler = startRetentionSweepScheduler({
      profiles: [{ id: profileId }],
      storageManagement: storageManagement(sweepRetained),
      enabled: true,
    });

    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 2);

    expect(sweepRetained).toHaveBeenCalledTimes(1);
  });

  it("waits for an active sweep before completing stop", async () => {
    vi.useFakeTimers();
    const activeSweep = deferred<SweepResult>();
    const sweepRetained = vi.fn(
      (): Promise<SweepResult> => activeSweep.promise,
    );
    const scheduler = startRetentionSweepScheduler({
      profiles: [{ id: profileId }],
      storageManagement: storageManagement(sweepRetained),
      enabled: true,
    });
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(stopped).toBe(false);
    activeSweep.resolve(ok(undefined));
    await stopping;

    expect(stopped).toBe(true);
  });

  it("returns the same completion promise for repeated stop calls", async () => {
    vi.useFakeTimers();
    const activeSweep = deferred<SweepResult>();
    const sweepRetained = vi.fn(
      (): Promise<SweepResult> => activeSweep.promise,
    );
    const scheduler = startRetentionSweepScheduler({
      profiles: [{ id: profileId }],
      storageManagement: storageManagement(sweepRetained),
      enabled: true,
    });

    const firstStop = scheduler.stop();
    const secondStop = scheduler.stop();
    activeSweep.resolve(ok(undefined));

    await expect(secondStop).resolves.toBeUndefined();
    await expect(firstStop).resolves.toBeUndefined();
    expect(secondStop).toBe(firstStop);
  });

  it("records retryable diagnostics for returned per-profile failures", async () => {
    vi.useFakeTimers();
    const diagnosticResult: DiagnosticResult = ok({
      schemaVersion: 1,
      incidentId: "incident-1",
      at: "2026-08-01T00:00:00.000Z",
      category: "cleanup",
      phase: "retention_sweep",
      profileId: "cfw",
      retryable: true,
      detail: "profile sweep failed",
    });
    const record = vi.fn(
      async (
        _input: Parameters<ReviewDiagnosticService["record"]>[0],
      ): Promise<DiagnosticResult> => diagnosticResult,
    );
    const storageUnavailable: StorageManagementFailure = {
      _tag: "StorageUnavailable",
    };
    const sweepRetained = vi.fn(
      async (id: WorkspaceProfileId): Promise<SweepResult> =>
        id === profileId ? err(storageUnavailable) : ok(undefined),
    );
    const scheduler = startRetentionSweepScheduler({
      profiles: [{ id: profileId }, { id: secondProfileId }],
      storageManagement: storageManagement(sweepRetained),
      enabled: true,
      diagnostics: { record },
    });

    await scheduler.stop();

    expect(record).toHaveBeenCalledWith({
      profileId,
      category: "cleanup",
      phase: "retention_sweep",
      retryable: true,
      detail: "profile sweep failed",
    });
  });

  it("contains rejected sweeps and diagnostic failures", async () => {
    vi.useFakeTimers();
    const record = vi.fn(async () => {
      throw new Error("diagnostic unavailable");
    });
    const sweepRetained = vi.fn(async (): Promise<SweepResult> => {
      throw new Error("sweep unavailable");
    });
    const scheduler = startRetentionSweepScheduler({
      profiles: [{ id: profileId }],
      storageManagement: storageManagement(sweepRetained),
      enabled: true,
      diagnostics: { record },
    });

    await expect(scheduler.stop()).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledTimes(1);
  });
});
