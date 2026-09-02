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
import { afterEach, describe, expect, it } from "vitest";
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
const repoAKey = "github.com/acme/alpha";
const repoBKey = "github.com/acme/beta";

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
});

describe("useWatchlistToggle", () => {
  it("synchronously rejects a duplicate toggle for the same repository", async () => {
    const requestGate = deferredResponse();
    let requestCount = 0;
    installWatchlistRoute(() => {
      requestCount += 1;
      return requestGate.promise;
    });
    const { result } = renderHook(() =>
      useWatchlistToggle(async () => undefined),
    );
    let firstRequest: Promise<void> | undefined;
    let duplicateRequest: Promise<void> | undefined;

    act(() => {
      firstRequest = result.current.toggleRepo(repoA, false);
      duplicateRequest = result.current.toggleRepo(repoA, false);
    });

    expect(requestCount).toBe(1);
    expect(result.current.pendingKeys).toEqual(new Set([repoAKey]));
    expect(result.current.draftWatchedByKey.get(repoAKey)).toBe(true);

    await act(async () => {
      requestGate.resolve(success({}));
      await requireRequest(firstRequest);
      await requireRequest(duplicateRequest);
    });
  });

  it("runs toggles for different repositories concurrently", async () => {
    const requestGate = deferredResponse();
    let requestCount = 0;
    installWatchlistRoute(() => {
      requestCount += 1;
      return requestGate.promise;
    });
    const { result } = renderHook(() =>
      useWatchlistToggle(async () => undefined),
    );
    let firstRequest: Promise<void> | undefined;
    let secondRequest: Promise<void> | undefined;

    act(() => {
      firstRequest = result.current.toggleRepo(repoA, false);
      secondRequest = result.current.toggleRepo(repoB, false);
    });

    expect(requestCount).toBe(2);
    expect(result.current.pendingKeys).toEqual(new Set([repoAKey, repoBKey]));
    expect(result.current.draftWatchedByKey).toEqual(
      new Map([
        [repoAKey, true],
        [repoBKey, true],
      ]),
    );

    await act(async () => {
      requestGate.resolve(success({}));
      await Promise.all([
        requireRequest(firstRequest),
        requireRequest(secondRequest),
      ]);
    });
  });

  it("keeps the exact repository pending when requests settle in reverse order", async () => {
    const firstGate = deferredResponse();
    const secondGate = deferredResponse();
    const gates = [firstGate, secondGate];
    let requestCount = 0;
    installWatchlistRoute(() => {
      const gate = gates[requestCount];
      requestCount += 1;
      if (gate === undefined) throw new Error("Unexpected watchlist request.");
      return gate.promise;
    });
    const { result } = renderHook(() =>
      useWatchlistToggle(async () => undefined),
    );
    let firstRequest: Promise<void> | undefined;
    let secondRequest: Promise<void> | undefined;

    act(() => {
      firstRequest = result.current.toggleRepo(repoA, false);
      secondRequest = result.current.toggleRepo(repoB, false);
    });

    await act(async () => {
      secondGate.resolve(failure({ error: "storage" }));
      await requireRequest(secondRequest);
    });

    expect(result.current.pendingKeys).toEqual(new Set([repoAKey]));
    expect(result.current.draftWatchedByKey).toEqual(
      new Map([[repoAKey, true]]),
    );
    expect(result.current.errorsByKey.get(repoBKey)).toBe(
      "Patchdesk could not save the local review state.",
    );

    await act(async () => {
      firstGate.resolve(success({}));
      await requireRequest(firstRequest);
    });

    expect(result.current.pendingKeys.size).toBe(0);
    expect(result.current.draftWatchedByKey.size).toBe(0);
    expect(result.current.errorsByKey.has(repoAKey)).toBe(false);
    expect(result.current.errorsByKey.has(repoBKey)).toBe(true);
  });
});

describe("RepositoryChecklist", () => {
  it("keeps one live request and failure scoped away from another repository row", async () => {
    const requestGate = deferredResponse();
    installWatchlistRoute(() => requestGate.promise);

    function Harness(): React.JSX.Element {
      const toggle = useWatchlistToggle(async () => undefined);
      return (
        <RepositoryChecklist
          entries={[repoA, repoB]}
          isWatched={() => false}
          pendingKeys={toggle.pendingKeys}
          errorsByKey={toggle.errorsByKey}
          draftWatchedByKey={toggle.draftWatchedByKey}
          onToggle={(entry, watched) => toggle.toggleRepo(entry, watched)}
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
      within(rowA).getByRole("status", { name: "Updating acme/alpha" }),
    ).toBeTruthy();
    expect(
      within(rowA).getByRole("checkbox").hasAttribute("data-disabled"),
    ).toBe(true);
    expect(within(rowB).queryByRole("status")).toBeNull();
    expect(within(rowB).queryByRole("alert")).toBeNull();
    expect(
      within(rowB).getByRole("checkbox").hasAttribute("data-disabled"),
    ).toBe(false);
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
    // Every watchlist request is logged, and the logger flushes on a timer
    // that races the end of the test; route the flush so the double does
    // not refuse it.
    "/v1/logs": () => success(null),
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

async function requireRequest(
  request: Promise<void> | undefined,
): Promise<void> {
  if (request === undefined) throw new Error("Expected a watchlist request.");
  await request;
}
