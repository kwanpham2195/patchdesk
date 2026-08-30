// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PatchdeskApiError } from "../../src/renderer/src/api-client";
import type { GithubListResponse } from "../../src/renderer/src/github-read-failure-copy";
import {
  useGithubItemPicker,
  type GithubItemPickerActions,
} from "../../src/renderer/src/hooks/use-github-item-picker";

/**
 * The state machine the three rail pickers share. Each `it` names one
 * decision the pickers used to prove by mounting three components and
 * clicking three checkboxes; the pickers' own suites now only prove they are
 * wired to this hook.
 *
 * The hook never touches `window.patchdesk`; callback triples stand in for
 * each picker's local-API adapter.
 */

/** A stand-in for the row shape each picker toggles (`{id, login}`, `{id, name}`). */
type Item = { readonly id: string; readonly login: string };

/** The stand-in list response: the shared envelope plus one `ready` payload. */
type ListResponse = GithubListResponse & {
  readonly items?: ReadonlyArray<Item>;
  readonly totalCount?: number;
};

/**
 * A stable empty `attached`. The hook compares the prop by identity, exactly
 * as the pickers' `attachedLabels`/`attachedAssignees` props are compared, so
 * a fresh array literal on every render would re-baseline on every render.
 */
const NOTHING_ATTACHED: ReadonlyArray<string> = [];

const octocat: Item = { id: "U_1", login: "octocat" };
const hubot: Item = { id: "U_2", login: "hubot" };

const readyResponse: ListResponse = {
  state: "ready",
  items: [octocat, hubot],
  totalCount: 2,
  permission: "permitted",
};

/** The stand-in `state: "ready"` payload, standing in for `{labels, totalCount}` and its two siblings. */
type ListReady = {
  readonly items: ReadonlyArray<Item>;
  readonly totalCount: number;
};

// Module scope: the hook's fetch effect depends on `projectReady`, so a new
// identity each render would refetch forever.
const projectReady = (response: ListResponse): ListReady => {
  const items = response.items ?? [];
  return { items, totalCount: response.totalCount ?? items.length };
};

const keyOf = (item: Item): string => item.login;

const describeWriteFailure = (item: Item, nextAttached: boolean): string =>
  nextAttached
    ? `Patchdesk could not assign "${item.login}".`
    : `Patchdesk could not unassign "${item.login}".`;

function actionsFixture(
  overrides: Partial<GithubItemPickerActions<Item, ListResponse>> = {},
) {
  return {
    fetchList: vi.fn(async () => readyResponse),
    add: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    ...overrides,
  };
}

/** Renders the hook and opens the popover, so the list has been fetched. */
async function renderOpened(
  actions: GithubItemPickerActions<Item, ListResponse> | undefined,
  attached: ReadonlyArray<string> = NOTHING_ATTACHED,
) {
  const rendered = renderHook(
    (props: { readonly attached: ReadonlyArray<string> }) =>
      useGithubItemPicker({
        attached: props.attached,
        actions,
        keyOf,
        projectReady,
        describeWriteFailure,
      }),
    { initialProps: { attached } },
  );
  act(() => rendered.result.current.setOpen(true));
  await waitFor(() =>
    expect(rendered.result.current.readState._tag).not.toBe("loading"),
  );
  return rendered;
}

afterEach(() => {
  // Unmount every `renderHook` result before the file ends: each mounted hook
  // holds a pending search-debounce timer, and a timer that outlives jsdom's
  // teardown re-enters React with no `window` left to read. Vitest runs with
  // `globals: false`, so Testing Library registers no automatic cleanup.
  cleanup();
  vi.useRealTimers();
});

describe("useGithubItemPicker", () => {
  it("fetches nothing until the popover opens, then projects the list", async () => {
    const actions = actionsFixture();
    const rendered = renderHook(() =>
      useGithubItemPicker({
        attached: NOTHING_ATTACHED,
        actions,
        keyOf,
        projectReady,
        describeWriteFailure,
      }),
    );
    expect(actions.fetchList).not.toHaveBeenCalled();
    expect(rendered.result.current.readState._tag).toBe("loading");
    act(() => rendered.result.current.setOpen(true));
    await waitFor(() =>
      expect(rendered.result.current.readState).toEqual({
        _tag: "ready",
        permission: "permitted",
        items: [octocat, hubot],
        totalCount: 2,
      }),
    );
    expect(actions.fetchList).toHaveBeenCalledWith(undefined);
  });

  it("fails the permission closed to 'unknown' when the service sent no evidence", async () => {
    const actions = actionsFixture({
      fetchList: vi.fn(async () => ({
        state: "ready" as const,
        items: [octocat],
      })),
    });
    const rendered = await renderOpened(actions);
    expect(rendered.result.current.permission).toBe("unknown");
    // A missing total is the returned row count, not zero: nothing is
    // reported as truncated that GitHub did not say was truncated.
    expect(rendered.result.current.readState).toEqual({
      _tag: "ready",
      permission: "unknown",
      items: [octocat],
      totalCount: 1,
    });
  });

  it.each([
    {
      name: "a rate limit keeps its resume time",
      response: {
        state: "github_rate_limited" as const,
        resumeAt: "2026-08-26T10:00:00.000Z",
      },
      expected: {
        _tag: "github_rate_limited",
        resumeAt: "2026-08-26T10:00:00.000Z",
      },
    },
    {
      name: "a forbidden read keeps its specific reason",
      response: {
        state: "github_forbidden" as const,
        forbiddenReason: "saml" as const,
      },
      expected: { _tag: "github_forbidden", reason: "saml" },
    },
    {
      name: "a forbidden read with no reason stays reasonless",
      response: { state: "github_forbidden" as const },
      expected: { _tag: "github_forbidden" },
    },
    {
      name: "an auth failure is not a read failure",
      response: { state: "github_auth" as const },
      expected: { _tag: "github_auth" },
    },
    {
      name: "an unparsable response reads as a read failure, not an empty list",
      response: undefined,
      expected: { _tag: "github_read" },
    },
  ])(
    "reports the read failure by name: $name",
    async ({ response, expected }) => {
      const rendered = await renderOpened(
        actionsFixture({ fetchList: vi.fn(async () => response) }),
      );
      expect(rendered.result.current.readState).toEqual(expected);
      expect(rendered.result.current.permission).toBe("unknown");
    },
  );

  it("reads a thrown fetch as a read failure, not an empty list", async () => {
    const rendered = await renderOpened(
      actionsFixture({
        fetchList: vi.fn(async () => {
          throw new Error("network down");
        }),
      }),
    );
    expect(rendered.result.current.readState._tag).toBe("github_read");
  });

  it("refuses every write when the service reported 'denied'", async () => {
    const actions = actionsFixture({
      fetchList: vi.fn(async () => ({
        ...readyResponse,
        permission: "denied" as const,
      })),
    });
    const rendered = await renderOpened(actions, ["octocat"]);
    expect(rendered.result.current.permission).toBe("denied");
    act(() => rendered.result.current.toggle(hubot, true));
    act(() => rendered.result.current.toggle(octocat, false));
    expect(actions.add).not.toHaveBeenCalled();
    expect(actions.remove).not.toHaveBeenCalled();
    // The refusal is not an optimistic change either: nothing moved.
    expect(rendered.result.current.isAttached(hubot)).toBe(false);
    expect(rendered.result.current.isAttached(octocat)).toBe(true);
  });

  it("still offers writes when the permission is only 'unknown'", async () => {
    const actions = actionsFixture({
      fetchList: vi.fn(async () => ({
        ...readyResponse,
        permission: "unknown" as const,
      })),
    });
    const rendered = await renderOpened(actions);
    act(() => rendered.result.current.toggle(hubot, true));
    expect(actions.add).toHaveBeenCalledWith(hubot);
  });

  it("shows an added item as attached before the write settles, and issues the add", async () => {
    const actions = actionsFixture();
    const rendered = await renderOpened(actions);
    expect(rendered.result.current.isAttached(hubot)).toBe(false);
    act(() => rendered.result.current.toggle(hubot, true));
    expect(rendered.result.current.isAttached(hubot)).toBe(true);
    expect(actions.add).toHaveBeenCalledWith(hubot);
    expect(actions.remove).not.toHaveBeenCalled();
  });

  it("shows a removed item as detached before the write settles, and issues the remove", async () => {
    const actions = actionsFixture();
    const rendered = await renderOpened(actions, ["octocat"]);
    expect(rendered.result.current.isAttached(octocat)).toBe(true);
    act(() => rendered.result.current.toggle(octocat, false));
    expect(rendered.result.current.isAttached(octocat)).toBe(false);
    expect(actions.remove).toHaveBeenCalledWith(octocat);
    expect(actions.add).not.toHaveBeenCalled();
  });

  it("drops the optimistic override once the authoritative attached list agrees", async () => {
    const actions = actionsFixture();
    const rendered = await renderOpened(actions);
    act(() => rendered.result.current.toggle(hubot, true));
    await waitFor(() => expect(actions.add).toHaveBeenCalledOnce());
    rendered.rerender({ attached: ["hubot"] });
    expect(rendered.result.current.isAttached(hubot)).toBe(true);
    // And once the authoritative list disagrees again — someone else
    // unassigned them — the picker follows it rather than its own old guess.
    rendered.rerender({ attached: [] });
    expect(rendered.result.current.isAttached(hubot)).toBe(false);
  });

  it("reverts a failed add and names the item instead of silently reverting", async () => {
    const actions = actionsFixture({
      add: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    const rendered = await renderOpened(actions);
    act(() => rendered.result.current.toggle(hubot, true));
    await waitFor(() =>
      expect(rendered.result.current.isAttached(hubot)).toBe(false),
    );
    expect(rendered.result.current.writeError).toBe(
      'Patchdesk could not assign "hubot".',
    );
  });

  it("reverts a failed remove and names the item", async () => {
    const actions = actionsFixture({
      remove: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    const rendered = await renderOpened(actions, ["octocat"]);
    act(() => rendered.result.current.toggle(octocat, false));
    await waitFor(() =>
      expect(rendered.result.current.isAttached(octocat)).toBe(true),
    );
    expect(rendered.result.current.writeError).toBe(
      'Patchdesk could not unassign "octocat".',
    );
  });

  it("appends the API error's own reason, so a cap or an allow list is named", async () => {
    const actions = actionsFixture({
      add: vi.fn(async () => {
        throw new PatchdeskApiError(
          "assignee_cap_exceeded",
          400,
          false,
          "corr-cap",
          "GitHub limits a pull request to ten assignees.",
        );
      }),
    });
    const rendered = await renderOpened(actions);
    act(() => rendered.result.current.toggle(hubot, true));
    await waitFor(() =>
      expect(rendered.result.current.writeError).toBe(
        'Patchdesk could not assign "hubot". GitHub limits a pull request to ten assignees.',
      ),
    );
    // A rejected write never reclassifies the account: the read path's
    // 'permitted' still stands, so the picker keeps offering a retry.
    expect(rendered.result.current.permission).toBe("permitted");
  });

  it("clears the last failure when the next toggle starts", async () => {
    const add = vi
      .fn<(item: Item) => Promise<void>>()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue(undefined);
    const rendered = await renderOpened(actionsFixture({ add }));
    act(() => rendered.result.current.toggle(hubot, true));
    await waitFor(() =>
      expect(rendered.result.current.writeError).toBeTruthy(),
    );
    act(() => rendered.result.current.toggle(hubot, true));
    expect(rendered.result.current.writeError).toBeUndefined();
  });

  it("marks an item busy for the length of its write and ignores a second toggle meanwhile", async () => {
    let settleAdd: () => void = () => undefined;
    const add = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          settleAdd = resolve;
        }),
    );
    const rendered = await renderOpened(actionsFixture({ add }));
    act(() => rendered.result.current.toggle(hubot, true));
    expect(rendered.result.current.isBusy(hubot)).toBe(true);
    // A second toggle while the first is in flight must not issue a second
    // write, nor flip the optimistic state back.
    act(() => rendered.result.current.toggle(hubot, false));
    expect(add).toHaveBeenCalledOnce();
    expect(rendered.result.current.isAttached(hubot)).toBe(true);
    // Only this item is busy; the rest of the list stays toggleable.
    expect(rendered.result.current.isBusy(octocat)).toBe(false);
    await act(async () => {
      settleAdd();
    });
    await waitFor(() =>
      expect(rendered.result.current.isBusy(hubot)).toBe(false),
    );
  });

  it("admits one same-item mutation per tick while different items remain concurrent", async () => {
    let settle: () => void = () => undefined;
    const add = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const rendered = await renderOpened(actionsFixture({ add }));
    act(() => {
      rendered.result.current.toggle(hubot, true);
      rendered.result.current.toggle(hubot, true);
      rendered.result.current.toggle(octocat, true);
    });
    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenNthCalledWith(1, hubot);
    expect(add).toHaveBeenNthCalledWith(2, octocat);
    await act(async () => settle());
  });

  it("never lets a slow, stale response overwrite a newer one", async () => {
    let resolveFirst: (value: ListResponse) => void = () => undefined;
    const first = new Promise<ListResponse>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchList = vi
      .fn<(query: string | undefined) => Promise<ListResponse | undefined>>()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(async () => ({
        state: "ready",
        items: [hubot],
        totalCount: 1,
        permission: "permitted",
      }));
    const actions = actionsFixture({ fetchList });
    const rendered = renderHook(() =>
      useGithubItemPicker({
        attached: NOTHING_ATTACHED,
        actions,
        keyOf,
        projectReady,
        describeWriteFailure,
      }),
    );
    act(() => rendered.result.current.setOpen(true));
    await waitFor(() => expect(fetchList).toHaveBeenCalledTimes(1));
    // A second request starts while the first is still pending.
    act(() => rendered.result.current.setOpen(false));
    act(() => rendered.result.current.setOpen(true));
    await waitFor(() => expect(fetchList).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(rendered.result.current.readState).toEqual({
        _tag: "ready",
        permission: "permitted",
        items: [hubot],
        totalCount: 1,
      }),
    );
    // The stale first response lands last, and is dropped.
    await act(async () => {
      resolveFirst({
        state: "ready",
        items: [octocat],
        totalCount: 1,
        permission: "permitted",
      });
    });
    expect(rendered.result.current.readState).toEqual({
      _tag: "ready",
      permission: "permitted",
      items: [hubot],
      totalCount: 1,
    });
  });

  it("sends the search query to the fetch only once typing settles", async () => {
    vi.useFakeTimers();
    const actions = actionsFixture();
    const rendered = renderHook(() =>
      useGithubItemPicker({
        attached: NOTHING_ATTACHED,
        actions,
        keyOf,
        projectReady,
        describeWriteFailure,
      }),
    );
    await act(async () => {
      rendered.result.current.setOpen(true);
    });
    expect(actions.fetchList).toHaveBeenCalledExactlyOnceWith(undefined);
    act(() => rendered.result.current.setQuery("hu"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    act(() => rendered.result.current.setQuery("hub"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    // 300 ms after the first keystroke and 150 ms after the second: each one
    // restarted the window, so neither has reached the server.
    expect(actions.fetchList).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    // One request for the settled query, not one per keystroke.
    expect(actions.fetchList).toHaveBeenCalledTimes(2);
    expect(actions.fetchList).toHaveBeenLastCalledWith("hub");
  });

  it("neither reads nor writes when the Review can no longer accept this write", () => {
    const rendered = renderHook(() =>
      useGithubItemPicker({
        attached: NOTHING_ATTACHED,
        actions: undefined,
        keyOf,
        projectReady,
        describeWriteFailure,
      }),
    );
    act(() => rendered.result.current.setOpen(true));
    // No list to read, and no write to issue: the picker renders nothing.
    expect(rendered.result.current.readState._tag).toBe("loading");
    act(() => rendered.result.current.toggle(hubot, true));
    expect(rendered.result.current.isAttached(hubot)).toBe(false);
    expect(rendered.result.current.writeError).toBeUndefined();
  });
});
