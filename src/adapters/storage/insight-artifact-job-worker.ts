import { Worker } from "node:worker_threads";
import * as v from "valibot";

import { parseContentHash, type ContentHash } from "#src/domain/ids";
import { err, ok, type Result } from "#src/domain/result";
import type { StorageFailure } from "./json-file";
import {
  insightArtifactJobReplySchema,
  insightArtifactJobRequestSchema,
  type InsightArtifactJobRequest,
} from "./insight-artifact-job-protocol";

/** One desktop-owned job worker; disposal closes admission and awaits termination. */
export type InsightArtifactJobWorker = {
  /** Streams one file in bounded blocks; overload, closure and transport failure return read/io. */
  hashFile(path: string): Promise<Result<ContentHash, StorageFailure>>;
  /** Settles all admitted jobs and awaits the same termination on repeated disposal. */
  dispose(): Promise<Result<void, StorageFailure>>;
};

type PendingJob = {
  readonly request: InsightArtifactJobRequest;
  readonly resolve: (result: Result<ContentHash, StorageFailure>) => void;
};

// Queued jobs hold only a path and a promise; the worker runs one at a time.
const maxPendingJobs = 64;
const startupWaitMs = 5_000;

/** Acquires one handler-ready job worker without retry or an in-process fallback. */
export async function acquireInsightArtifactJobWorker(
  entry: URL,
): Promise<Result<InsightArtifactJobWorker, StorageFailure>> {
  let worker: Worker;
  try {
    worker = new Worker(entry, {
      name: "insight-artifact-jobs",
      trackUnmanagedFds: true,
    });
  } catch {
    return transportFailure();
  }

  let state: "starting" | "ready" | "closed" = "starting";
  let active: PendingJob | undefined;
  const pending: PendingJob[] = [];
  let nextId = 1;
  let termination: Promise<Result<void, StorageFailure>> | undefined;
  let settleReady: (result: Result<void, StorageFailure>) => void = () =>
    undefined;
  const ready = new Promise<Result<void, StorageFailure>>((resolve) => {
    settleReady = resolve;
  });
  const startupTimer = setTimeout(failTransport, startupWaitMs);

  function terminate(): Promise<Result<void, StorageFailure>> {
    termination ??= (async () => {
      try {
        await worker.terminate();
        return ok(undefined);
      } catch {
        return transportFailure();
      }
    })();
    return termination;
  }

  function failTransport(): void {
    if (state === "closed") return;
    const wasStarting = state === "starting";
    state = "closed";
    clearTimeout(startupTimer);
    if (wasStarting) settleReady(transportFailure());
    const current = active;
    active = undefined;
    current?.resolve(transportFailure());
    for (const queued of pending.splice(0)) queued.resolve(transportFailure());
    // terminate always resolves a Result; dispose/startup failure awaits this same promise.
    void terminate();
  }

  function dispatch(): void {
    if (state !== "ready" || active !== undefined) return;
    const queued = pending.shift();
    if (queued === undefined) return;
    active = queued;
    try {
      worker.postMessage(queued.request);
    } catch {
      failTransport();
    }
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node structured-clone replies enter untyped at this transport boundary.
  worker.on("message", (input: unknown) => {
    if (state === "closed") return;
    const reply = v.safeParse(insightArtifactJobReplySchema, input);
    if (!reply.success) {
      failTransport();
      return;
    }
    if (reply.output.kind === "ready") {
      if (state !== "starting") {
        failTransport();
        return;
      }
      state = "ready";
      clearTimeout(startupTimer);
      settleReady(ok(undefined));
      return;
    }
    const current = active;
    if (
      state !== "ready" ||
      current === undefined ||
      current.request.id !== reply.output.id
    ) {
      failTransport();
      return;
    }
    const result = reply.output.result;
    let settled: Result<ContentHash, StorageFailure>;
    if (result._tag === "err") settled = err(result.error);
    else {
      const hash = parseContentHash(result.value);
      if (hash._tag === "err") {
        failTransport();
        return;
      }
      settled = hash;
    }
    active = undefined;
    current.resolve(settled);
    dispatch();
  });
  worker.on("error", failTransport);
  worker.on("exit", failTransport);
  worker.on("messageerror", failTransport);

  const started = await ready;
  if (started._tag === "err") {
    await terminate();
    return started;
  }
  return ok({
    hashFile(path) {
      if (
        state !== "ready" ||
        pending.length >= maxPendingJobs ||
        nextId > Number.MAX_SAFE_INTEGER
      )
        return Promise.resolve(transportFailure());
      const request = v.safeParse(insightArtifactJobRequestSchema, {
        kind: "hash_file",
        id: nextId,
        path,
      });
      if (!request.success) return Promise.resolve(transportFailure());
      nextId += 1;
      return new Promise<Result<ContentHash, StorageFailure>>((resolve) => {
        pending.push({ request: request.output, resolve });
        dispatch();
      });
    },
    async dispose() {
      failTransport();
      return await terminate();
    },
  });
}

function transportFailure(): Result<never, StorageFailure> {
  return err({ _tag: "StorageFailure", operation: "read", reason: "io" });
}
