import { Worker } from "node:worker_threads";
import * as v from "valibot";

import { parseContentHash, type ContentHash } from "#src/domain/ids";
import { err, ok, type Result } from "#src/domain/result";
import type { StorageFailure } from "./json-file";
import {
  insightArtifactJobReplySchema,
  insightArtifactJobRequestSchema,
  type InsightArtifactJobRequest,
  patchCaptureFailure,
  type InsightPatchCaptureInput,
  type InsightPatchCaptureResult,
} from "./insight-artifact-job-protocol";

/** One desktop-owned job worker; disposal closes admission and awaits termination. */
export type InsightArtifactJobWorker = {
  /** Streams one file in bounded blocks; overload, closure and transport failure return read/io. */
  hashFile(path: string): Promise<Result<ContentHash, StorageFailure>>;
  /** Queued abort removes the job; active abort settles only after the worker's owned cleanup. */
  capturePatch(
    input: InsightPatchCaptureInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<InsightPatchCaptureResult>;
  /** Settles all admitted jobs and awaits the same termination on repeated disposal. */
  dispose(): Promise<Result<void, StorageFailure>>;
};

type PendingJob = {
  readonly request: Exclude<InsightArtifactJobRequest, { kind: "cancel" }>;
  readonly receive: (
    reply: Exclude<
      v.InferOutput<typeof insightArtifactJobReplySchema>,
      { kind: "ready" }
    >,
  ) => boolean;
  readonly fail: () => void;
  readonly abort: () => void;
  readonly release: () => void;
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
    current?.release();
    current?.fail();
    for (const queued of pending.splice(0)) {
      queued.release();
      queued.fail();
    }
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
    if (!current.receive(reply.output)) {
      failTransport();
      return;
    }
    current.release();
    active = undefined;
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
        if (request.output.kind !== "hash_file") {
          resolve(transportFailure());
          return;
        }
        pending.push({
          request: request.output,
          receive(reply) {
            if (reply.kind !== "hash_file") return false;
            if (reply.result._tag === "err") {
              resolve(err(reply.result.error));
              return true;
            }
            const hash = parseContentHash(reply.result.value);
            if (hash._tag === "err") return false;
            resolve(hash);
            return true;
          },
          fail: () => resolve(transportFailure()),
          abort: () => resolve(transportFailure()),
          release: () => undefined,
        });
        dispatch();
      });
    },
    capturePatch(input, options = {}) {
      if (options.signal?.aborted)
        return Promise.resolve(patchCaptureFailure("aborted"));
      if (
        state !== "ready" ||
        pending.length >= maxPendingJobs ||
        nextId > Number.MAX_SAFE_INTEGER
      )
        return Promise.resolve(patchCaptureFailure("transport"));
      const parsed = v.safeParse(insightArtifactJobRequestSchema, {
        kind: "capture_patch",
        id: nextId,
        input,
      });
      if (!parsed.success || parsed.output.kind !== "capture_patch")
        return Promise.resolve(patchCaptureFailure("invalid_source"));
      nextId += 1;
      const request = parsed.output;
      return new Promise<InsightPatchCaptureResult>((resolve) => {
        const job: PendingJob = {
          request,
          receive(reply) {
            if (reply.kind !== "capture_patch") return false;
            resolve(reply.result);
            return true;
          },
          fail: () => resolve(patchCaptureFailure("transport")),
          abort: () => resolve(patchCaptureFailure("aborted")),
          release: () => options.signal?.removeEventListener("abort", onAbort),
        };
        function onAbort(): void {
          const index = pending.indexOf(job);
          if (index >= 0) {
            pending.splice(index, 1);
            job.release();
            job.abort();
            return;
          }
          if (active !== job || state !== "ready") return;
          try {
            worker.postMessage({ kind: "cancel", id: request.id });
          } catch {
            failTransport();
          }
        }
        options.signal?.addEventListener("abort", onAbort, { once: true });
        pending.push(job);
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
