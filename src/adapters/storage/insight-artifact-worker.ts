import { Worker } from "node:worker_threads";
import * as v from "valibot";

import { err, ok, type Result } from "#src/domain/result";
import type { readBoundedInsightArtifactFile } from "./insight-artifact-files";
import type { StorageFailure } from "./json-file";
import {
  insightArtifactWorkerReplySchema,
  insightArtifactWorkerRequestSchema,
  type InsightArtifactWorkerRequest,
} from "./insight-artifact-worker-protocol";

/** One desktop-owned read-only worker; disposal closes admission and awaits termination. */
export type InsightArtifactWorker = {
  /** Overload, closure and transport failure return read/io, never absence. */
  readonly read: typeof readBoundedInsightArtifactFile;
  /** Settles all admitted reads and awaits the same termination on repeated disposal. */
  dispose(): Promise<Result<void, StorageFailure>>;
};

type PendingRead = {
  readonly request: InsightArtifactWorkerRequest;
  readonly resolve: (result: Result<Uint8Array, StorageFailure>) => void;
};

// A metadata read holds one descriptor; four waiting callers bound retained messages/promises.
const maxPendingReads = 4;
const startupWaitMs = 5_000;

/** Acquires one handler-ready worker without retry or an in-process fallback. */
export async function acquireInsightArtifactWorker(
  entry: URL,
): Promise<Result<InsightArtifactWorker, StorageFailure>> {
  let worker: Worker;
  try {
    worker = new Worker(entry, {
      name: "insight-artifact-reader",
      trackUnmanagedFds: true,
    });
  } catch {
    return transportFailure();
  }

  let state: "starting" | "ready" | "closed" = "starting";
  let active: PendingRead | undefined;
  const pending: PendingRead[] = [];
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
    const reply = v.safeParse(insightArtifactWorkerReplySchema, input);
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
    active = undefined;
    current.resolve(reply.output.result);
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
    read(ownedRoot, path) {
      if (
        state !== "ready" ||
        pending.length >= maxPendingReads ||
        nextId > Number.MAX_SAFE_INTEGER
      )
        return Promise.resolve(transportFailure());
      const request = v.safeParse(insightArtifactWorkerRequestSchema, {
        kind: "read",
        id: nextId,
        ownedRoot,
        path,
      });
      if (!request.success) return Promise.resolve(transportFailure());
      nextId += 1;
      return new Promise<Result<Uint8Array, StorageFailure>>((resolve) => {
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
