// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useReviewDiffHydration } from "../../src/renderer/src/hooks/use-review-diff-hydration";
import type { RawJsonValue } from "../../src/domain/json";

const patchA =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
const patchB =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old-b\n+new-b\n";
const patchBoth = `${patchA}\n${patchB.replaceAll("src/a.ts", "src/b.ts")}`;

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

function ready(oldText = "old", newText = "new") {
  return {
    state: "ready" as const,
    oldFile: { name: "src/a.ts", contents: `${oldText}\n` },
    newFile: { name: "src/a.ts", contents: `${newText}\n` },
  };
}

function installBridge(
  response: () => Promise<RawJsonValue> | RawJsonValue,
): Array<{ readonly path: string; readonly body?: RawJsonValue }> {
  const calls: Array<{ readonly path: string; readonly body?: RawJsonValue }> =
    [];
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: {
      request: async (input: {
        readonly path: string;
        readonly body?: RawJsonValue;
      }) => {
        calls.push(input);
        return {
          ok: true,
          status: 200,
          correlationId: input.path,
          body: await response(),
        };
      },
    },
  });
  return calls;
}

// The mocked `request` for a single `diff-file` call, typed to the one field
// these tests actually branch on (`path`) instead of leaving `body` unknown.
type MockDiffFileRequestInput = {
  readonly path: string;
  readonly body?: { readonly path?: string };
};

afterEach(() => {
  // SAFETY: removes the test-installed `window.patchdesk` stub between
  // tests; the global itself is declared optional elsewhere in the app.
  delete (window as { patchdesk?: unknown }).patchdesk;
});

describe("useReviewDiffHydration", () => {
  it("shares one concurrent bridge request for duplicate paths", async () => {
    const source = deferred<RawJsonValue>();
    const calls = installBridge(() => source.promise);
    const { result } = renderHook(() =>
      useReviewDiffHydration({
        patch: patchA,
        sourceSession: { profileId: "profile", sessionId: "session-a" },
      }),
    );

    let firstHydration!: Promise<void>;
    let secondHydration!: Promise<void>;
    act(() => {
      firstHydration = result.current.hydrateFiles(["src/a.ts"]);
      secondHydration = result.current.hydrateFiles(["src/a.ts"]);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      path: "/v1/reviews/diff-file",
      body: { profileId: "profile", sessionId: "session-a", path: "src/a.ts" },
    });
    await act(async () => {
      source.resolve(ready());
      await Promise.all([firstHydration, secondHydration]);
    });
    expect(result.current.hydratedFiles.has("src/a.ts")).toBe(true);
  });

  it("rejects a late response from an old patch generation", async () => {
    const oldSource = deferred<RawJsonValue>();
    const calls = installBridge(() => oldSource.promise);
    const { result, rerender } = renderHook(
      ({ patch, sessionId }) =>
        useReviewDiffHydration({
          patch,
          sourceSession: { profileId: "profile", sessionId },
        }),
      { initialProps: { patch: patchA, sessionId: "session-a" } },
    );

    let hydration!: Promise<void>;
    act(() => {
      hydration = result.current.hydrateFiles(["src/a.ts"]);
    });
    rerender({ patch: patchB, sessionId: "session-b" });
    await act(async () => {
      oldSource.resolve(ready());
      await hydration;
    });
    expect(calls).toHaveLength(1);
    expect(result.current.hydratedFiles.size).toBe(0);
    expect(result.current.contextStatus).toBe("idle");
  });

  it("keeps selected-path status owned while switching from A to B", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const calls = installBridge(() => {
      throw new Error("unexpected bridge response");
    });
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: {
        request: async (input: MockDiffFileRequestInput) => {
          calls.push(input);
          const body = input.body;
          return {
            ok: true,
            status: 200,
            correlationId: input.path,
            body:
              body?.path === "src/a.ts"
                ? await first.promise
                : await second.promise,
          };
        },
      },
    });
    const { result, rerender } = renderHook(
      ({ selectedPath }) =>
        useReviewDiffHydration({
          patch: patchBoth,
          sourceSession: { profileId: "profile", sessionId: "session-a" },
          selectedPath,
        }),
      { initialProps: { selectedPath: "src/a.ts" } },
    );
    expect(result.current.contextStatus).toBe("loading");
    rerender({ selectedPath: "src/b.ts" });
    expect(result.current.contextStatus).toBe("loading");
    await act(async () => {
      first.resolve(ready());
      await first.promise;
    });
    expect(result.current.contextStatus).toBe("loading");
    await act(async () => {
      second.resolve(ready("old-b", "new-b"));
      await second.promise;
    });
    await waitFor(() => expect(result.current.contextStatus).toBe("ready"));
    expect(result.current.hydratedFiles.has("src/b.ts")).toBe(true);
  });

  it("does not retry a failed path until the generation changes", async () => {
    let requestNumber = 0;
    const retry = deferred<RawJsonValue>();
    const calls = installBridge(() => {
      requestNumber += 1;
      return requestNumber === 1
        ? { state: "unavailable", reason: "missing source" }
        : retry.promise;
    });
    const { result, rerender } = renderHook(
      ({ patch }) =>
        useReviewDiffHydration({
          patch,
          sourceSession: { profileId: "profile", sessionId: "session-a" },
        }),
      { initialProps: { patch: patchA } },
    );

    await act(async () => {
      await result.current.hydrateFiles(["src/a.ts"]);
    });
    await act(async () => {
      await result.current.hydrateFiles(["src/a.ts"]);
    });
    expect(calls).toHaveLength(1);

    rerender({ patch: patchB });
    let retryHydration!: Promise<void>;
    act(() => {
      retryHydration = result.current.hydrateFiles(["src/a.ts"]);
    });
    expect(calls).toHaveLength(2);
    await act(async () => {
      retry.resolve(ready("old-b", "new-b"));
      await retryHydration;
    });
    expect(result.current.hydratedFiles.has("src/a.ts")).toBe(true);
  });

  it("coalesces concurrent hydration responses into a single render", async () => {
    const firstFile = deferred<unknown>();
    const secondFile = deferred<unknown>();
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: {
        request: async (input: MockDiffFileRequestInput) => {
          const body = input.body;
          return {
            ok: true,
            status: 200,
            correlationId: input.path,
            body:
              body?.path === "src/a.ts"
                ? await firstFile.promise
                : await secondFile.promise,
          };
        },
      },
    });
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useReviewDiffHydration({
        patch: patchBoth,
        sourceSession: { profileId: "profile", sessionId: "session-a" },
      });
    });

    let hydration!: Promise<void>;
    act(() => {
      hydration = result.current.hydrateFiles(["src/a.ts", "src/b.ts"]);
    });
    const renderCountBeforeResponses = renderCount;

    // Both responses resolve in the same synchronous tick, so their .then
    // handlers run back-to-back on the microtask queue: the coalescing
    // scheduler should collapse them into exactly one flush/render, not two.
    await act(async () => {
      firstFile.resolve(ready());
      secondFile.resolve(ready("old-b", "new-b"));
      await hydration;
    });

    expect(renderCount).toBe(renderCountBeforeResponses + 1);
    expect(result.current.hydratedFiles.has("src/a.ts")).toBe(true);
    expect(result.current.hydratedFiles.has("src/b.ts")).toBe(true);
  });

  it("drops a stale-generation response that resolves alongside an in-generation one", async () => {
    const staleSource = deferred<unknown>();
    const freshSource = deferred<unknown>();
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: {
        request: async (input: MockDiffFileRequestInput) => {
          const body = input.body;
          return {
            ok: true,
            status: 200,
            correlationId: input.path,
            body:
              body?.path === "src/a.ts"
                ? await staleSource.promise
                : await freshSource.promise,
          };
        },
      },
    });
    const { result, rerender } = renderHook(
      ({ patch, sessionId }) =>
        useReviewDiffHydration({
          patch,
          sourceSession: { profileId: "profile", sessionId },
        }),
      { initialProps: { patch: patchA, sessionId: "session-a" } },
    );

    let staleHydration!: Promise<void>;
    act(() => {
      staleHydration = result.current.hydrateFiles(["src/a.ts"]);
    });
    rerender({ patch: patchBoth, sessionId: "session-b" });

    let freshHydration!: Promise<void>;
    act(() => {
      freshHydration = result.current.hydrateFiles(["src/b.ts"]);
    });

    await act(async () => {
      staleSource.resolve(ready());
      freshSource.resolve(ready("old-b", "new-b"));
      await Promise.all([staleHydration, freshHydration]);
    });

    expect(result.current.hydratedFiles.has("src/a.ts")).toBe(false);
    expect(result.current.hydratedFiles.has("src/b.ts")).toBe(true);
  });
});
