import type { LogEntryInput } from "#src/domain/log-entry";
import {
  acquireInsightArtifactJobWorker,
  type InsightArtifactJobWorker,
} from "#src/adapters/storage/insight-artifact-job-worker";
import { resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

import { prepareGuideInputs } from "#src/adapters/storage/guide-preparation-job";
import { prepareWalkthroughInputs } from "#src/adapters/storage/walkthrough-preparation-job";
import { validateWalkthroughResult } from "#src/adapters/storage/walkthrough-result-job";
import { validateGuideResult } from "#src/adapters/storage/guide-result-job";
import { hashUtf8FileSha256 } from "#src/adapters/storage/insight-artifact-job-protocol";
import { captureInsightPatch } from "#src/adapters/storage/insight-patch-capture-job";
import { readBoundedInsightArtifactFile } from "#src/adapters/storage/insight-artifact-files";
import {
  acquireInsightArtifactWorker,
  type InsightArtifactWorker,
} from "#src/adapters/storage/insight-artifact-worker";
import type { StorageFailure } from "#src/adapters/storage/json-file";
import { err, ok, type Result } from "#src/domain/result";
import type { Active } from "./insight-run-coordinator";
import type { AppLogService } from "./app-log-service";

type Reader = (
  ownedRoot: string,
  path: string,
  options?: { readonly signal?: AbortSignal },
) => ReturnType<typeof readBoundedInsightArtifactFile>;

// UI overload waits; authority and run callers retain their existing read/io refusal.
const uiReadQuota = 4;
const uiWaiterQuota = 64;
const authorityReadQuota = 4;
const runReadQuota = 2;
const totalReadQuota = 16;
const capturePermits = 1;
const generationPermits = 2;

type PermitFailure = "aborted" | "closed" | "nested";
type PermitLease = { release(): void };
type PermitWaiter = {
  readonly holder: string;
  readonly settle: (result: Result<PermitLease, PermitFailure>) => void;
};

/** Process-owned reader quotas, permits and both artifact workers. */
export type InsightResourceBundle = {
  readonly diagnostic?: (entry: LogEntryInput) => void;
  /** At most 4 active UI reads and 64 FIFO waiters; cancellation returns read/io. */
  readonly uiReader: Reader;
  /** Propagates a request's lifetime through the storage graph without changing stored-value APIs. */
  withReadSignal<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T>;
  /** Run-authority and coordinator reads, at most 4 in flight. */
  readonly authorityReader: Reader;
  /** Reads for one run, at most 2 in flight per run id; all callers share 16. */
  runReader(runId: string): Reader;
  readonly jobs: Pick<
    InsightArtifactJobWorker,
    | "hashFile"
    | "capturePatch"
    | "prepareGuide"
    | "validateGuide"
    | "prepareWalkthrough"
    | "validateWalkthrough"
  >;
  /**
   * Abortable FIFO permits keyed by holder. A holder that already holds or
   * waits for any permit gets `nested`, so nobody holds one while waiting for
   * another.
   */
  readonly permits: {
    capture(
      holder: string,
      signal?: AbortSignal,
    ): Promise<Result<PermitLease, PermitFailure>>;
    generation(
      holder: string,
      signal?: AbortSignal,
    ): Promise<Result<PermitLease, PermitFailure>>;
  };
  /**
   * In-process run ownership, one map per storage scope (its data directory), so equal deterministic run IDs in two
   * scopes never collide. The production coordinator and Guide preparation over the same scope share one map; a
   * disposable diagnostic scope gets its own, invisible to the coordinator.
   */
  readonly ownership: {
    forScope(dataDirectory: string): Map<string, Active>;
  };
  /**
   * Long-running owned work (a Guide generation with its paid child). `dispose` aborts it without recording a
   * cancellation, joins it, and only then terminates the workers it may still be using.
   */
  readonly work: {
    track(abort: () => void, work: Promise<unknown>): void;
  };
  /** Aborts and joins tracked work, then closes admission and awaits both worker terminations. */
  dispose(): Promise<Result<void, StorageFailure>>;
};

type Workers = {
  readonly reader: Pick<InsightArtifactWorker, "read" | "dispose">;
  readonly jobs: Pick<
    InsightArtifactJobWorker,
    | "hashFile"
    | "capturePatch"
    | "prepareGuide"
    | "validateGuide"
    | "prepareWalkthrough"
    | "validateWalkthrough"
    | "dispose"
  >;
};

/** Acquires both workers at startup; one failing disposes the other and no in-process fallback exists. */
export async function acquireInsightResourceBundle(
  readerEntry: URL,
  jobEntry: URL,
  logs: Pick<AppLogService, "write">,
): Promise<Result<InsightResourceBundle, StorageFailure>> {
  const [reader, jobs] = await Promise.all([
    acquireInsightArtifactWorker(readerEntry),
    acquireInsightArtifactJobWorker(jobEntry),
  ]);
  if (reader._tag === "ok" && jobs._tag === "ok")
    return ok(createBundle({ reader: reader.value, jobs: jobs.value }, logs));
  await Promise.all([
    reader._tag === "ok" ? reader.value.dispose() : undefined,
    jobs._tag === "ok" ? jobs.value.dispose() : undefined,
  ]);
  return err(
    reader._tag === "err"
      ? reader.error
      : jobs._tag === "err"
        ? jobs.error
        : storageIoFailure,
  );
}

/** Test seam: runs the physical reader and hash in-process behind the same quotas; the desktop uses `acquireInsightResourceBundle`. */
export function createInProcessInsightResourceBundle(
  logs?: Pick<AppLogService, "write">,
  reader: Reader = readBoundedInsightArtifactFile,
): InsightResourceBundle {
  const disposed = () => Promise.resolve(ok(undefined));
  return createBundle(
    {
      reader: { read: reader, dispose: disposed },
      jobs: {
        hashFile: hashUtf8FileSha256,
        capturePatch: captureInsightPatch,
        prepareGuide: prepareGuideInputs,
        validateGuide: validateGuideResult,
        prepareWalkthrough: prepareWalkthroughInputs,
        validateWalkthrough: validateWalkthroughResult,
        dispose: disposed,
      },
    },
    logs,
  );
}

const storageIoFailure: StorageFailure = {
  _tag: "StorageFailure",
  operation: "read",
  reason: "io",
};

type Counter = { count: number; readonly limit: number };

function createBundle(
  workers: Workers,
  logs: Pick<AppLogService, "write"> | undefined,
): InsightResourceBundle {
  let closed = false;
  let totalReads = 0;
  const ui: Counter = { count: 0, limit: uiReadQuota };
  const readSignal = new AsyncLocalStorage<AbortSignal>();
  const uiWaiters: Array<{
    readonly settle: (release: (() => void) | undefined) => void;
  }> = [];
  const authority: Counter = { count: 0, limit: authorityReadQuota };
  const runs = new Map<string, Counter>();
  const holders = new Set<string>();
  const scopes = new Map<string, Map<string, Active>>();
  const tracked = new Set<{
    readonly abort: () => void;
    readonly work: Promise<unknown>;
  }>();
  const capture = createPermitPool(capturePermits, holders);
  const generation = createPermitPool(generationPermits, holders);

  function lease(counter: Counter): (() => void) | undefined {
    if (
      closed ||
      totalReads >= totalReadQuota ||
      counter.count >= counter.limit
    )
      return undefined;
    counter.count += 1;
    totalReads += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      counter.count -= 1;
      totalReads -= 1;
      grantUiWaiters();
    };
  }

  function grantUiWaiters(): void {
    while (!closed && uiWaiters.length > 0) {
      const release = lease(ui);
      if (release === undefined) return;
      uiWaiters.shift()?.settle(release);
    }
  }

  function waitForUiLease(signal: AbortSignal | undefined) {
    return new Promise<(() => void) | undefined>((resolve) => {
      const waiter = {
        settle(release: (() => void) | undefined) {
          signal?.removeEventListener("abort", onAbort);
          resolve(release);
        },
      };
      function onAbort(): void {
        const index = uiWaiters.indexOf(waiter);
        if (index < 0) return;
        uiWaiters.splice(index, 1);
        waiter.settle(undefined);
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      uiWaiters.push(waiter);
    });
  }

  function leasedReader(
    counterFor: () => Counter,
    caller: "ui" | "authority" | "run",
    onIdle?: () => void,
  ): Reader {
    return async (ownedRoot, path, options) => {
      const signal = options?.signal ?? readSignal.getStore();
      if (signal?.aborted) return err(storageIoFailure);
      const counter = counterFor();
      let release = lease(counter);
      if (
        release === undefined &&
        caller === "ui" &&
        !closed &&
        uiWaiters.length < uiWaiterQuota
      )
        release = await waitForUiLease(signal);
      if (release === undefined) {
        if (signal?.aborted) return err(storageIoFailure);
        logs?.write({
          process: "main",
          level: "warn",
          topic: "insight-artifact-read",
          message: "Insight artifact read refused",
          meta: {
            category: closed ? "closed" : "quota_exhausted",
            caller,
            activeReads: counter.count,
            totalReads,
          },
        });
        onIdle?.();
        return err(storageIoFailure);
      }
      try {
        if (signal?.aborted) return err(storageIoFailure);
        // Worker reads cannot be interrupted; retain their lease until they finish.
        const result = await workers.reader.read(ownedRoot, path);
        if (signal?.aborted) return err(storageIoFailure);
        if (result._tag === "err" && result.error.reason === "io")
          logs?.write({
            process: "main",
            level: "warn",
            topic: "insight-artifact-read",
            message: "Insight artifact read failed",
            meta: {
              category: "reader_io",
              caller,
              activeReads: counter.count,
              totalReads,
            },
          });
        return result;
      } finally {
        release();
        onIdle?.();
      }
    };
  }

  return {
    diagnostic: (entry) => logs?.write(entry),
    uiReader: leasedReader(() => ui, "ui"),
    withReadSignal: (signal, action) => readSignal.run(signal, action),
    authorityReader: leasedReader(() => authority, "authority"),
    runReader(runId) {
      const counter = (): Counter => {
        const existing = runs.get(runId);
        if (existing !== undefined) return existing;
        const created: Counter = { count: 0, limit: runReadQuota };
        runs.set(runId, created);
        return created;
      };
      return leasedReader(counter, "run", () => {
        if (runs.get(runId)?.count === 0) runs.delete(runId);
      });
    },
    jobs: {
      hashFile: (path) => workers.jobs.hashFile(path),
      capturePatch: (input, options) =>
        workers.jobs.capturePatch(input, options),
      prepareGuide: (input, options) =>
        workers.jobs.prepareGuide(input, options),
      validateGuide: (input, options) =>
        workers.jobs.validateGuide(input, options),
      prepareWalkthrough: (input, options) =>
        workers.jobs.prepareWalkthrough(input, options),
      validateWalkthrough: (input, options) =>
        workers.jobs.validateWalkthrough(input, options),
    },
    ownership: {
      forScope(dataDirectory) {
        const key = resolve(dataDirectory);
        const existing = scopes.get(key);
        if (existing !== undefined) return existing;
        const created = new Map<string, Active>();
        scopes.set(key, created);
        return created;
      },
    },
    permits: {
      capture: (holder, signal) => capture.acquire(holder, signal),
      generation: (holder, signal) => generation.acquire(holder, signal),
    },
    work: {
      track(abort, work) {
        const entry = { abort, work };
        tracked.add(entry);
        void work.finally(() => tracked.delete(entry));
        if (closed) abort();
      },
    },
    async dispose() {
      closed = true;
      for (const waiter of uiWaiters.splice(0)) waiter.settle(undefined);
      const joining = [...tracked];
      for (const entry of joining) entry.abort();
      await Promise.allSettled(joining.map((entry) => entry.work));
      capture.close();
      generation.close();
      const [reader, jobs] = await Promise.all([
        workers.reader.dispose(),
        workers.jobs.dispose(),
      ]);
      return reader._tag === "err" ? reader : jobs;
    },
  };
}

function createPermitPool(capacity: number, holders: Set<string>) {
  let free = capacity;
  let closed = false;
  const waiters: PermitWaiter[] = [];

  function grantWaiting(): void {
    while (free > 0) {
      const waiter = waiters.shift();
      if (waiter === undefined) return;
      free -= 1;
      waiter.settle(ok(permitFor(waiter.holder)));
    }
  }

  function permitFor(holder: string): PermitLease {
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        holders.delete(holder);
        free += 1;
        grantWaiting();
      },
    };
  }

  return {
    acquire(
      holder: string,
      signal?: AbortSignal,
    ): Promise<Result<PermitLease, PermitFailure>> {
      if (closed) return Promise.resolve(err("closed"));
      if (signal?.aborted === true) return Promise.resolve(err("aborted"));
      if (holders.has(holder)) return Promise.resolve(err("nested"));
      holders.add(holder);
      return new Promise((resolve) => {
        const waiter: PermitWaiter = {
          holder,
          settle(result) {
            signal?.removeEventListener("abort", onAbort);
            resolve(result);
          },
        };
        function onAbort(): void {
          waiters.splice(waiters.indexOf(waiter), 1);
          holders.delete(holder);
          waiter.settle(err("aborted"));
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        waiters.push(waiter);
        grantWaiting();
      });
    },
    close(): void {
      closed = true;
      for (const waiter of waiters.splice(0)) {
        holders.delete(waiter.holder);
        waiter.settle(err("closed"));
      }
    },
  };
}
