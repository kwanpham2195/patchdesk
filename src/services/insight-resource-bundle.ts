import {
  acquireInsightArtifactJobWorker,
  type InsightArtifactJobWorker,
} from "#src/adapters/storage/insight-artifact-job-worker";
import { resolve } from "node:path";

import { prepareGuideInputs } from "#src/adapters/storage/guide-preparation-job";
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

type Reader = typeof readBoundedInsightArtifactFile;

// Concurrent reads a caller class may have in flight; overload returns read/io like the reader's own cap.
const uiReadQuota = 4;
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
  /** Status and listing reads for the local API, at most 4 in flight. */
  readonly uiReader: Reader;
  /** Run-authority and coordinator reads, at most 4 in flight. */
  readonly authorityReader: Reader;
  /** Reads for one run, at most 2 in flight per run id; all callers share 16. */
  runReader(runId: string): Reader;
  readonly jobs: Pick<
    InsightArtifactJobWorker,
    "hashFile" | "capturePatch" | "prepareGuide"
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
  /** Closes admission and awaits both worker terminations. */
  dispose(): Promise<Result<void, StorageFailure>>;
};

type Workers = {
  readonly reader: Pick<InsightArtifactWorker, "read" | "dispose">;
  readonly jobs: Pick<
    InsightArtifactJobWorker,
    "hashFile" | "capturePatch" | "prepareGuide" | "dispose"
  >;
};

/** Acquires both workers at startup; one failing disposes the other and no in-process fallback exists. */
export async function acquireInsightResourceBundle(
  readerEntry: URL,
  jobEntry: URL,
): Promise<Result<InsightResourceBundle, StorageFailure>> {
  const [reader, jobs] = await Promise.all([
    acquireInsightArtifactWorker(readerEntry),
    acquireInsightArtifactJobWorker(jobEntry),
  ]);
  if (reader._tag === "ok" && jobs._tag === "ok")
    return ok(createBundle({ reader: reader.value, jobs: jobs.value }));
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
export function createInProcessInsightResourceBundle(): InsightResourceBundle {
  const disposed = () => Promise.resolve(ok(undefined));
  return createBundle({
    reader: { read: readBoundedInsightArtifactFile, dispose: disposed },
    jobs: {
      hashFile: hashUtf8FileSha256,
      capturePatch: captureInsightPatch,
      prepareGuide: prepareGuideInputs,
      dispose: disposed,
    },
  });
}

const storageIoFailure: StorageFailure = {
  _tag: "StorageFailure",
  operation: "read",
  reason: "io",
};

type Counter = { count: number; readonly limit: number };

function createBundle(workers: Workers): InsightResourceBundle {
  let closed = false;
  let totalReads = 0;
  const ui: Counter = { count: 0, limit: uiReadQuota };
  const authority: Counter = { count: 0, limit: authorityReadQuota };
  const runs = new Map<string, Counter>();
  const holders = new Set<string>();
  const scopes = new Map<string, Map<string, Active>>();
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
    };
  }

  function leasedReader(
    counterFor: () => Counter,
    onIdle?: () => void,
  ): Reader {
    return async (ownedRoot, path) => {
      const release = lease(counterFor());
      if (release === undefined) {
        onIdle?.();
        return err(storageIoFailure);
      }
      try {
        return await workers.reader.read(ownedRoot, path);
      } finally {
        release();
        onIdle?.();
      }
    };
  }

  return {
    uiReader: leasedReader(() => ui),
    authorityReader: leasedReader(() => authority),
    runReader(runId) {
      const counter = (): Counter => {
        const existing = runs.get(runId);
        if (existing !== undefined) return existing;
        const created: Counter = { count: 0, limit: runReadQuota };
        runs.set(runId, created);
        return created;
      };
      return leasedReader(counter, () => {
        if (runs.get(runId)?.count === 0) runs.delete(runId);
      });
    },
    jobs: {
      hashFile: (path) => workers.jobs.hashFile(path),
      capturePatch: (input, options) =>
        workers.jobs.capturePatch(input, options),
      prepareGuide: (input, options) =>
        workers.jobs.prepareGuide(input, options),
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
    async dispose() {
      closed = true;
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
