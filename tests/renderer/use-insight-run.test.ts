// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";

import { useInsightRun } from "../../src/renderer/src/hooks/use-insight-run";

const sha = "a".repeat(40);
const patchHash = "b".repeat(64);
const reviewProjection = (): WorkbenchResponse =>
  ({
    state: "review",
    review: { id: "review-42", status: "open" },
    session: {
      id: "session-a",
      key: {
        profileId: "profile",
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        prNumber: 42,
        headSha: sha,
      },
    },
    revision: {
      reviewedHeadSha: sha,
      currentHeadSha: sha,
      freshness: "fresh",
      refreshedAt: "2026-08-01T00:00:00.000Z",
      patchHash,
    },
    fullPatch:
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
    pullRequest: {
      ref: {
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        number: 42,
      },
      title: "Canonical workbench",
      author: "fixture",
      headBranch: "feature",
      baseBranch: "main",
      headSha: sha,
      isOpen: true,
      isDraft: false,
      reviewState: "none",
      mergeability: "mergeable",
      labels: [],
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
    commits: [],
    insights: {
      analysis: { status: "not_generated" },
      walkthrough: { status: "not_generated" },
    },
    conversation: { prDescription: "Description", entries: [] },
    checks: { overall: "passing", checks: [] },
    mergeReadiness: { _tag: "Ready", blockers: [], warnings: [] },
    mergeReasons: [],
  }) as WorkbenchResponse;

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

type RequestInput = { readonly path: string; readonly body?: unknown };

/** The Insight run record the faux `/run` and poll routes hand back. */
type InsightRunFixture = {
  readonly runId: string;
  readonly type: string;
  readonly status: string;
};

/** Every response body the faux desktop bridge returns in this suite. */
type BridgeBody = InsightRunFixture | WorkbenchResponse;

function installBridge(
  handler: (input: RequestInput) => Promise<BridgeBody> | BridgeBody,
): RequestInput[] {
  const calls: RequestInput[] = [];
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: {
      request: async (input: RequestInput) => {
        calls.push(input);
        return {
          ok: true,
          status: 200,
          correlationId: input.path,
          body: await handler(input),
        };
      },
    },
  });
  return calls;
}

const started = {
  runId: "run-a",
  type: "analysis" as const,
  status: "running" as const,
};

afterEach(() => {
  Reflect.deleteProperty(window, "patchdesk");
});

describe("useInsightRun", () => {
  it("accepts one run and gives it one polling owner", async () => {
    const start = deferred<InsightRunFixture>();
    const poll = deferred<InsightRunFixture>();
    const calls = installBridge((input) => {
      if (input.path.endsWith("/run")) return start.promise;
      if (input.path.includes("/runs/")) return poll.promise;
      throw new Error(input.path);
    });
    const { result } = renderHook(() =>
      useInsightRun({
        profileId: "profile",
        reviewId: "review-42",
        type: "analysis",
      }),
    );

    act(() => {
      result.current.run("pi", "fixture-model", "medium");
      result.current.run("pi", "fixture-model", "medium");
    });
    expect(calls.filter(({ path }) => path.endsWith("/run"))).toHaveLength(1);
    await act(async () => {
      start.resolve(started);
      await start.promise;
    });
    expect(calls.filter(({ path }) => path.includes("/runs/"))).toHaveLength(1);
    poll.resolve({ ...started, status: "running" });
  });

  it("delivers terminal completion to the latest callback once", async () => {
    const start = deferred<InsightRunFixture>();
    const load = deferred<WorkbenchResponse>();
    const calls = installBridge((input) => {
      if (input.path.endsWith("/run")) return start.promise;
      if (input.path.includes("/runs/"))
        return { ...started, status: "completed" };
      if (input.path === "/v1/reviews/load") return load.promise;
      throw new Error(input.path);
    });
    const firstPatch: Array<unknown> = [];
    const secondPatch: Array<unknown> = [];
    const firstCompleted: Array<boolean> = [];
    const secondCompleted: Array<boolean> = [];
    const { result, rerender } = renderHook(
      ({ patch, completed }) =>
        useInsightRun({
          profileId: "profile",
          reviewId: "review-42",
          type: "analysis",
          onInsightPatch: (_type, value) => patch.push(value),
          onCompleted: () => completed.push(true),
        }),
      {
        initialProps: { patch: firstPatch, completed: firstCompleted },
      },
    );

    act(() => result.current.run("pi", "fixture-model", "medium"));
    await act(async () => {
      start.resolve(started);
      await start.promise;
    });
    rerender({ patch: secondPatch, completed: secondCompleted });
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls.some(({ path }) => path === "/v1/reviews/load")).toBe(true);
    await act(async () => {
      load.resolve(reviewProjection());
      await load.promise;
    });
    await waitFor(() => expect(secondPatch).toHaveLength(1));
    expect(firstPatch).toHaveLength(0);
    expect(secondCompleted).toHaveLength(1);
    expect(firstCompleted).toHaveLength(0);
    expect(result.current.status).toBe("completed");
  });

  it("suppresses an old poll and terminal reload after Review identity changes", async () => {
    const start = deferred<InsightRunFixture>();
    const poll = deferred<InsightRunFixture>();
    let pollCount = 0;
    const calls = installBridge((input) => {
      if (input.path.endsWith("/run")) return start.promise;
      if (input.path.includes("/runs/")) {
        pollCount += 1;
        return pollCount === 1
          ? poll.promise
          : new Promise<BridgeBody>(() => undefined);
      }
      throw new Error(input.path);
    });
    const patches: Array<unknown> = [];
    const { result, rerender } = renderHook(
      ({ reviewId }) =>
        useInsightRun({
          profileId: "profile",
          reviewId,
          type: "analysis",
          onInsightPatch: (_type, value) => patches.push(value),
        }),
      { initialProps: { reviewId: "review-42" } },
    );

    act(() => result.current.run("pi", "fixture-model", "medium"));
    await act(async () => {
      start.resolve(started);
      await start.promise;
    });
    expect(calls.filter(({ path }) => path.includes("/runs/"))).toHaveLength(1);
    rerender({ reviewId: "review-43" });
    await act(async () => {
      poll.resolve({ ...started, status: "completed" });
      await poll.promise;
    });
    expect(
      calls.filter(({ path }) => path === "/v1/reviews/load"),
    ).toHaveLength(0);
    expect(patches).toHaveLength(0);
  });

  it("suppresses a late poll and terminal reload after unmount", async () => {
    const start = deferred<InsightRunFixture>();
    const poll = deferred<InsightRunFixture>();
    const calls = installBridge((input) => {
      if (input.path.endsWith("/run")) return start.promise;
      if (input.path.includes("/runs/")) return poll.promise;
      throw new Error(input.path);
    });
    const patches: Array<unknown> = [];
    const { result, unmount } = renderHook(() =>
      useInsightRun({
        profileId: "profile",
        reviewId: "review-42",
        type: "analysis",
        onInsightPatch: (_type, value) => patches.push(value),
      }),
    );
    act(() => result.current.run("pi", "fixture-model", "medium"));
    await act(async () => {
      start.resolve(started);
      await start.promise;
    });
    expect(calls.filter(({ path }) => path.includes("/runs/"))).toHaveLength(1);
    unmount();
    await act(async () => {
      poll.resolve({ ...started, status: "completed" });
      await poll.promise;
    });
    expect(
      calls.filter(({ path }) => path === "/v1/reviews/load"),
    ).toHaveLength(0);
    expect(patches).toHaveLength(0);
  });

  it("does not let an old run overwrite a newer active run", async () => {
    const oldStart = deferred<InsightRunFixture>();
    const newStart = deferred<InsightRunFixture>();
    const oldPoll = deferred<InsightRunFixture>();
    const newPoll = deferred<InsightRunFixture>();
    let runNumber = 0;
    let pollNumber = 0;
    const calls = installBridge((input) => {
      if (input.path.endsWith("/run")) {
        runNumber += 1;
        return runNumber === 1 ? oldStart.promise : newStart.promise;
      }
      if (input.path.includes("/runs/")) {
        pollNumber += 1;
        return pollNumber === 1 ? oldPoll.promise : newPoll.promise;
      }
      if (input.path === "/v1/reviews/load") return reviewProjection();
      throw new Error(input.path);
    });
    const oldPatches: Array<unknown> = [];
    const newPatches: Array<unknown> = [];
    const old = renderHook(() =>
      useInsightRun({
        profileId: "profile",
        reviewId: "review-42",
        type: "analysis",
        onInsightPatch: (_type, value) => oldPatches.push(value),
      }),
    );
    act(() => old.result.current.run("pi", "fixture-model", "medium"));
    await act(async () => {
      oldStart.resolve({ ...started, runId: "run-old" });
      await oldStart.promise;
    });
    old.unmount();

    const newer = renderHook(() =>
      useInsightRun({
        profileId: "profile",
        reviewId: "review-43",
        type: "analysis",
        onInsightPatch: (_type, value) => newPatches.push(value),
      }),
    );
    act(() => newer.result.current.run("pi", "fixture-model", "medium"));
    await act(async () => {
      newStart.resolve({ ...started, runId: "run-new" });
      await newStart.promise;
    });
    await act(async () => {
      oldPoll.resolve({ ...started, runId: "run-old", status: "completed" });
      await oldPoll.promise;
    });
    expect(
      calls.filter(({ path }) => path === "/v1/reviews/load"),
    ).toHaveLength(0);
    expect(oldPatches).toHaveLength(0);

    await act(async () => {
      newPoll.resolve({ ...started, runId: "run-new", status: "completed" });
      await newPoll.promise;
    });
    await waitFor(() => expect(newPatches).toHaveLength(1));
    expect(oldPatches).toHaveLength(0);
    newer.unmount();
  });

  it("keeps cancellation errors visible without fabricated completion", async () => {
    const start = deferred<InsightRunFixture>();
    const completed: Array<boolean> = [];
    const calls = installBridge((input) => {
      if (input.path.endsWith("/run")) return start.promise;
      if (input.path.endsWith("/cancel"))
        return Promise.reject(new Error("cancel unavailable"));
      if (input.path.includes("/runs/")) return new Promise(() => undefined);
      throw new Error(input.path);
    });
    const { result } = renderHook(() =>
      useInsightRun({
        profileId: "profile",
        reviewId: "review-42",
        type: "analysis",
        onCompleted: () => completed.push(true),
      }),
    );
    act(() => result.current.run("pi", "fixture-model", "medium"));
    await act(async () => {
      start.resolve(started);
      await start.promise;
    });
    act(() => result.current.cancel());
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(completed).toHaveLength(0);
    expect(calls.filter(({ path }) => path.endsWith("/cancel"))).toHaveLength(
      1,
    );
  });
});
