// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useCommitDiff, type CommitDiffLoader } from "../../src/renderer/src/hooks/use-commit-diff";

const response = (sha: string) => ({
  commit: { sha, message: "Commit", author: "author", authoredAt: "2026-08-01T00:00:00.000Z", isHead: sha === "b".repeat(40) },
  position: 1,
  total: 2,
  patch: "diff --git a/a.ts b/a.ts\n",
  fileCount: 1,
  additions: 0,
  deletions: 0,
});

type Deferred<T> = { readonly promise: Promise<T>; readonly resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("useCommitDiff", () => {
  it("ignores a late response from a previous commit selection", async () => {
    const first = deferred<ReturnType<typeof response>>();
    const second = deferred<ReturnType<typeof response>>();
    const load: CommitDiffLoader = (sha) => sha === "a".repeat(40) ? first.promise : second.promise;
    const { result, rerender } = renderHook(({ sha, revision }) => useCommitDiff({ selectedSha: sha, revisionKey: revision, loadCommitDiff: load }), {
      initialProps: { sha: "a".repeat(40), revision: "head-a" },
    });

    expect(result.current).toEqual({ _tag: "Loading", sha: "a".repeat(40) });
    rerender({ sha: "b".repeat(40), revision: "head-a" });
    expect(result.current).toEqual({ _tag: "Loading", sha: "b".repeat(40) });
    await act(async () => { first.resolve(response("a".repeat(40))); await first.promise; });
    expect(result.current).toEqual({ _tag: "Loading", sha: "b".repeat(40) });
    await act(async () => { second.resolve(response("b".repeat(40))); await second.promise; });
    await waitFor(() => expect(result.current).toEqual({ _tag: "Ready", projection: response("b".repeat(40)) }));
  });

  it("fails a response whose commit identity does not match the selected SHA", async () => {
    const load: CommitDiffLoader = async () => response("b".repeat(40));
    const { result } = renderHook(() => useCommitDiff({ selectedSha: "a".repeat(40), revisionKey: "head-a", loadCommitDiff: load }));
    await waitFor(() => expect(result.current).toEqual({ _tag: "Failed", sha: "a".repeat(40) }));
  });

  it("clears a selected commit when the represented revision changes", async () => {
    const load: CommitDiffLoader = async (sha) => response(sha);
    const { result, rerender } = renderHook(({ sha, revision }) => useCommitDiff({ selectedSha: sha, revisionKey: revision, loadCommitDiff: load }), {
      initialProps: { sha: "a".repeat(40), revision: "head-a" },
    });
    await waitFor(() => expect(result.current._tag).toBe("Ready"));
    rerender({ sha: "a".repeat(40), revision: "head-b" });
    await waitFor(() => expect(result.current).toEqual({ _tag: "Idle" }));
  });
});
