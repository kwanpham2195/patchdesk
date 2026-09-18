// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BaseBranchListResponse } from "../../src/renderer/src/base-branch-contracts";
import { useBaseBranchCandidates } from "../../src/renderer/src/hooks/use-base-branch-candidates";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type Fetch = (query?: string) => Promise<BaseBranchListResponse | undefined>;

const ready = (branches: ReadonlyArray<string>): BaseBranchListResponse => ({
  state: "ready",
  current: "main",
  branches: [...branches],
  branchesTotalCount: branches.length,
  permission: "permitted",
});

function render(fetchBaseBranches: Fetch, open = true) {
  return renderHook(
    (props: { readonly open: boolean }) =>
      useBaseBranchCandidates({ open: props.open, fetchBaseBranches }),
    { initialProps: { open } },
  );
}

describe("useBaseBranchCandidates", () => {
  it("reads nothing until the dialog opens", () => {
    const fetchBaseBranches = vi.fn<Fetch>(async () => ready([]));
    render(fetchBaseBranches, false);
    expect(fetchBaseBranches).not.toHaveBeenCalled();
  });

  it("projects a ready read with the current base and the total", async () => {
    const fetchBaseBranches = vi.fn<Fetch>(async () => ready(["release/1.2"]));
    const rendered = render(fetchBaseBranches);
    await waitFor(() =>
      expect(rendered.result.current.readState).toEqual({
        _tag: "ready",
        permission: "permitted",
        current: "main",
        branches: ["release/1.2"],
        totalCount: 1,
      }),
    );
  });

  it("searches only once typing settles", async () => {
    vi.useFakeTimers();
    const fetchBaseBranches = vi.fn<Fetch>(async () => ready([]));
    const rendered = render(fetchBaseBranches);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchBaseBranches).toHaveBeenCalledExactlyOnceWith(undefined);
    act(() => rendered.result.current.setQuery("rel"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    act(() => rendered.result.current.setQuery("release"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(fetchBaseBranches).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(fetchBaseBranches).toHaveBeenCalledTimes(2);
    expect(fetchBaseBranches).toHaveBeenLastCalledWith("release");
  });

  it("drops a superseded response that lands after a newer one", async () => {
    let resolveFirst: (value: BaseBranchListResponse) => void = () => undefined;
    const fetchBaseBranches = vi
      .fn<Fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(async () => ready(["release/1.3"]));
    const rendered = render(fetchBaseBranches);
    await waitFor(() => expect(fetchBaseBranches).toHaveBeenCalledTimes(1));
    rendered.rerender({ open: false });
    rendered.rerender({ open: true });
    await waitFor(() =>
      expect(rendered.result.current.readState).toMatchObject({
        branches: ["release/1.3"],
      }),
    );
    await act(async () => resolveFirst(ready(["stale"])));
    expect(rendered.result.current.readState).toMatchObject({
      branches: ["release/1.3"],
    });
  });

  const failures = {
    github_auth: [{ state: "github_auth" }, { _tag: "github_auth" }],
    github_read: [{ state: "github_read" }, { _tag: "github_read" }],
    github_rate_limited: [
      { state: "github_rate_limited", resumeAt: "2026-09-17T10:00:00.000Z" },
      { _tag: "github_rate_limited", resumeAt: "2026-09-17T10:00:00.000Z" },
    ],
    github_forbidden: [
      { state: "github_forbidden", forbiddenReason: "saml" },
      { _tag: "github_forbidden", reason: "saml" },
    ],
  } satisfies Record<
    Exclude<BaseBranchListResponse["state"], "ready">,
    readonly [BaseBranchListResponse, Readonly<Record<string, string>>]
  >;

  for (const [tag, [response, readState]] of Object.entries(failures)) {
    it(`projects ${tag}`, async () => {
      const rendered = render(async () => response);
      await waitFor(() =>
        expect(rendered.result.current.readState).toEqual(readState),
      );
    });
  }

  it("treats an unparseable or rejected read as a read failure", async () => {
    const unparsed = render(async () => undefined);
    await waitFor(() =>
      expect(unparsed.result.current.readState).toEqual({
        _tag: "github_read",
      }),
    );
    const rejected = render(async () => {
      throw new Error("bridge failed");
    });
    await waitFor(() =>
      expect(rejected.result.current.readState).toEqual({
        _tag: "github_read",
      }),
    );
  });
});
