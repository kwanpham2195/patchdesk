// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopResponse } from "../../src/main/ipc-contract";

import {
  useWatchlistToggle,
  RepositoryChecklist,
  type WatchlistEntry,
} from "../../src/renderer/src/flows/settings-workspace-repositories";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
  type DesktopRoute,
} from "./fake-desktop-response";

const repoA: WatchlistEntry = {
  host: "github.com",
  owner: "acme",
  repo: "alpha",
  localPath: "/workspace/alpha",
};
const repoB: WatchlistEntry = {
  host: "github.com",
  owner: "acme",
  repo: "beta",
  localPath: "/workspace/beta",
};
const WORKSPACE_ID = "acme-workspace";
const repoAKey = "github.com/acme/alpha";
const repoBKey = "github.com/acme/beta";

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
});

describe("useWatchlistToggle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends ticks made close together as one batch for the named workspace, then reloads once", async () => {
    const bodies: unknown[] = [];
    let reloads = 0;
    installWatchlistRoute((input) => {
      bodies.push(input.body);
      return success({});
    });
    const { result } = renderHook(() =>
      useWatchlistToggle(WORKSPACE_ID, async () => {
        reloads += 1;
      }),
    );

    act(() => {
      result.current.toggleRepo(repoA, false);
      result.current.toggleRepo(repoB, true);
    });
    expect(result.current.draftWatchedByKey).toEqual(
      new Map([
        [repoAKey, true],
        [repoBKey, false],
      ]),
    );
    expect(bodies).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(bodies).toEqual([
      {
        profileId: WORKSPACE_ID,
        add: [
          {
            host: "github.com",
            owner: "acme",
            repo: "alpha",
            localPath: "/workspace/alpha",
          },
        ],
        remove: [{ host: "github.com", owner: "acme", repo: "beta" }],
      },
    ]);
    expect(reloads).toBe(1);
    expect(result.current.draftWatchedByKey.size).toBe(0);
    expect(result.current.pendingKeys.size).toBe(0);
  });

  it("sends nothing when a row is ticked back before its batch leaves", async () => {
    let requests = 0;
    installWatchlistRoute(() => {
      requests += 1;
      return success({});
    });
    const { result } = renderHook(() =>
      useWatchlistToggle(WORKSPACE_ID, async () => undefined),
    );

    act(() => {
      result.current.toggleRepo(repoA, false);
      result.current.toggleRepo(repoA, false);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(requests).toBe(0);
    expect(result.current.draftWatchedByKey.get(repoAKey)).toBe(false);
  });

  it("reverts every row of a failed batch and reports the error on each", async () => {
    installWatchlistRoute(() => failure({ error: "storage" }));
    const { result } = renderHook(() =>
      useWatchlistToggle(WORKSPACE_ID, async () => undefined),
    );

    act(() => {
      result.current.setWatched([repoA, repoB], true, () => false);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.draftWatchedByKey.size).toBe(0);
    expect(result.current.errorsByKey.get(repoAKey)).toBe(
      "Patchdesk could not save the local review state.",
    );
    expect(result.current.errorsByKey.has(repoBKey)).toBe(true);
  });

  it("holds a tick made during a batch until that batch settles, then sends it", async () => {
    const firstGate = deferredResponse();
    const bodies: unknown[] = [];
    installWatchlistRoute((input) => {
      bodies.push(input.body);
      return bodies.length === 1 ? firstGate.promise : success({});
    });
    const { result } = renderHook(() =>
      useWatchlistToggle(WORKSPACE_ID, async () => undefined),
    );

    act(() => {
      result.current.setWatched([repoA], true, () => false);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      result.current.toggleRepo(repoB, false);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(bodies).toHaveLength(1);
    expect(result.current.pendingKeys).toEqual(new Set([repoAKey]));

    await act(async () => {
      firstGate.resolve(success({}));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({
      add: [{ repo: "beta" }],
      remove: [],
    });
  });

  it("still saves ticks when the checklist closes inside the batch delay", async () => {
    let requests = 0;
    installWatchlistRoute(() => {
      requests += 1;
      return success({});
    });
    const { result, unmount } = renderHook(() =>
      useWatchlistToggle(WORKSPACE_ID, async () => undefined),
    );

    act(() => {
      result.current.toggleRepo(repoA, false);
    });
    unmount();

    expect(requests).toBe(1);
  });
});

describe("RepositoryChecklist", () => {
  it("keeps one row's batch and failure scoped away from another repository row", async () => {
    const requestGate = deferredResponse();
    installWatchlistRoute(() => requestGate.promise);

    function Harness(): React.JSX.Element {
      const toggle = useWatchlistToggle(WORKSPACE_ID, async () => undefined);
      return (
        <RepositoryChecklist
          entries={[repoA, repoB]}
          isWatched={() => false}
          pendingKeys={toggle.pendingKeys}
          errorsByKey={toggle.errorsByKey}
          draftWatchedByKey={toggle.draftWatchedByKey}
          onToggle={toggle.toggleRepo}
          ariaLabel="Repositories"
        />
      );
    }
    render(<Harness />);
    const rowA = screen.getByText("acme/alpha").closest("label");
    const rowB = screen.getByText("acme/beta").closest("label");
    if (rowA === null || rowB === null)
      throw new Error("Expected both repository rows.");

    fireEvent.click(within(rowA).getByRole("checkbox"));
    expect(
      await within(rowA).findByRole("status", { name: "Updating acme/alpha" }),
    ).toBeTruthy();
    expect(within(rowB).queryByRole("status")).toBeNull();
    expect(within(rowB).queryByRole("alert")).toBeNull();
    expect(
      within(rowB).getByRole("checkbox").getAttribute("aria-checked"),
    ).toBe("false");

    await act(async () => requestGate.resolve(failure({ error: "storage" })));
    expect(await within(rowA).findByRole("alert")).toBeTruthy();
    expect(within(rowB).queryByRole("alert")).toBeNull();
    expect(within(rowB).queryByRole("status")).toBeNull();
  });

  it("keeps pending and error status beside the affected checkbox", () => {
    render(
      <RepositoryChecklist
        entries={[repoA]}
        isWatched={() => false}
        pendingKeys={new Set([repoAKey])}
        errorsByKey={
          new Map([[repoAKey, "Patchdesk could not update this repository."]])
        }
        draftWatchedByKey={new Map([[repoAKey, true]])}
        onToggle={() => undefined}
        ariaLabel="Repositories"
      />,
    );

    const row = screen.getByText("acme/alpha").closest("label");
    if (row === null) throw new Error("Expected a repository checklist row.");
    expect(within(row).getByRole("checkbox").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      within(row).getByRole("status", { name: "Updating acme/alpha" }),
    ).toBeTruthy();
    expect(within(row).getByRole("alert")).toBeTruthy();
    expect(within(row).queryByRole("button")).toBeNull();
  });
});

function installWatchlistRoute(route: DesktopRoute): void {
  desktop = installDesktopDouble({
    "/v1/watchlist": route,
  });
}

type DeferredDesktopResponse = {
  readonly promise: Promise<DesktopResponse>;
  readonly resolve: (response: DesktopResponse) => void;
};

function deferredResponse(): DeferredDesktopResponse {
  let resolvePromise: ((response: DesktopResponse) => void) | undefined;
  const promise = new Promise<DesktopResponse>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (response) => {
      if (resolvePromise === undefined)
        throw new Error("Deferred response was not initialized.");
      resolvePromise(response);
    },
  };
}
