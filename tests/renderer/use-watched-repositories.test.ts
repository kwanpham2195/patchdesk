// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useWatchedRepositories } from "../../src/renderer/src/flows/settings-workspace-repositories";
import type { Profile } from "../../src/renderer/src/renderer-models";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
  type DesktopOperationRoute,
  type DesktopRoute,
} from "./fake-desktop-response";

const watched = { host: "github.example.test", owner: "acme", repo: "api" };
const profile: Profile = {
  id: "acme-workspace",
  label: "ACME",
  githubHost: "github.example.test",
  ghAccount: "patchdesk",
  repos: [watched],
};

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
});

describe("useWatchedRepositories", () => {
  it("adds owner/repo on the workspace's host for the workspace on screen, then reloads", async () => {
    const watchlist = vi.fn<DesktopRoute>(() => success({}));
    desktop = installDesktopDouble({ "/v1/watchlist": watchlist });
    const reload = vi.fn(async () => undefined);
    const { result } = renderHook(() =>
      useWatchedRepositories(profile, reload),
    );

    let added = false;
    await act(async () => {
      added = await result.current.add("  acme/web ");
    });

    expect(added).toBe(true);
    expect(watchlist).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "PUT",
        body: {
          profileId: "acme-workspace",
          add: [{ host: "github.example.test", owner: "acme", repo: "web" }],
          remove: [],
        },
      }),
    );
    expect(reload).toHaveBeenCalled();
  });

  it.each([
    { input: "acme", error: "Enter a repository as owner/repo." },
    { input: "acme/api/extra", error: "Enter a repository as owner/repo." },
    { input: "acme/api", error: "acme/api is already watched." },
  ])("refuses $input without sending it", async ({ input, error }) => {
    desktop = installDesktopDouble({});
    const { result } = renderHook(() =>
      useWatchedRepositories(profile, async () => undefined),
    );

    let added = true;
    await act(async () => {
      added = await result.current.add(input);
    });

    expect(added).toBe(false);
    expect(result.current.addError).toBe(error);
    expect(desktop.request).not.toHaveBeenCalled();
  });

  it("stops watching a repository for the workspace on screen", async () => {
    const watchlist = vi.fn<DesktopRoute>(() => success({}));
    desktop = installDesktopDouble({ "/v1/watchlist": watchlist });
    const reload = vi.fn(async () => undefined);
    const { result } = renderHook(() =>
      useWatchedRepositories(profile, reload),
    );

    act(() => result.current.remove(watched));

    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(watchlist).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { profileId: "acme-workspace", add: [], remove: [watched] },
      }),
    );
  });

  it("saves the picked folder as the repository's checkout, then reloads", async () => {
    const checkout = vi.fn<DesktopRoute>(() => success({}));
    desktop = installDesktopDouble(
      { "/v1/watchlist/checkout": checkout },
      { operations: { selectDirectory: () => success({ path: "/code/api" }) } },
    );
    const reload = vi.fn(async () => undefined);
    const { result } = renderHook(() =>
      useWatchedRepositories(profile, reload),
    );

    act(() => result.current.chooseCheckout(watched));

    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(checkout).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "PUT",
        body: {
          profileId: "acme-workspace",
          ...watched,
          localPath: "/code/api",
        },
      }),
    );
  });

  it("saves and reloads nothing when the folder picker is cancelled", async () => {
    const picker = vi.fn<DesktopOperationRoute>(() => success({ path: null }));
    desktop = installDesktopDouble(
      {},
      { operations: { selectDirectory: picker } },
    );
    const reload = vi.fn(async () => undefined);
    const { result } = renderHook(() =>
      useWatchedRepositories(profile, reload),
    );

    act(() => result.current.chooseCheckout(watched));

    await waitFor(() => expect(picker).toHaveBeenCalled());
    await waitFor(() => expect(result.current.pendingKeys.size).toBe(0));
    expect(reload).not.toHaveBeenCalled();
    expect(result.current.errorsByKey.size).toBe(0);
  });

  it.each([
    {
      code: "checkout_origin_mismatch",
      message: "That checkout's origin is not acme/api.",
    },
    {
      code: "checkout_not_a_repository",
      message: "That folder is not inside a git checkout.",
    },
  ])(
    "shows the $code refusal on the repository's row",
    async ({ code, message }) => {
      desktop = installDesktopDouble(
        { "/v1/watchlist/checkout": () => failure({ error: code }, 400) },
        {
          operations: {
            selectDirectory: () => success({ path: "/code/other" }),
          },
        },
      );
      const reload = vi.fn(async () => undefined);
      const { result } = renderHook(() =>
        useWatchedRepositories(profile, reload),
      );

      act(() => result.current.chooseCheckout(watched));

      await waitFor(() =>
        expect(
          result.current.errorsByKey.get("github.example.test/acme/api"),
        ).toBe(message),
      );
      expect(reload).not.toHaveBeenCalled();
    },
  );
});
