// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { parseContentHash } from "../../src/domain/ids";
import { App, type ReviewWorkbenchLoader } from "../../src/renderer/src/app";
import {
  loadInboxViewPreferences,
  saveInboxViewPreferences,
} from "../../src/renderer/src/inbox-view-preferences";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import type { ReviewWorkbenchFlowProps } from "../../src/renderer/src/flows/review-workbench-flow";

const sha = "a".repeat(40);
const patchHash = contentHashFixture("b".repeat(64));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: undefined,
  });
});

describe("App Review route loading", () => {
  it("does not resolve Review or fixture code for Inbox and Settings", async () => {
    let reviewCalls = 0;
    let fixtureCalls = 0;
    const reviewLoader: ReviewWorkbenchLoader = async () => {
      reviewCalls += 1;
      return { default: () => <p>Unexpected review load</p> };
    };
    const fixtureLoader = async () => {
      fixtureCalls += 1;
      return { default: () => <p>Unexpected fixture load</p> };
    };
    installDesktop();
    render(
      <App
        initialState="empty"
        reviewWorkbenchLoader={reviewLoader}
        fixtureContentLoader={fixtureLoader}
      />,
    );
    await screen.findByRole("heading", { name: "Maintainer inbox" });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("dialog", { name: "Settings" });
    expect(reviewCalls).toBe(0);
    expect(fixtureCalls).toBe(0);
  });

  it("releases the Inbox refresh state after a failed manual refresh triggered from View → Refresh", async () => {
    const refreshFailure = promise<void>();
    const desktop = installDesktop({
      failInboxRefresh: true,
      inboxRefreshGate: refreshFailure.promise,
    });
    render(<App />);

    await screen.findByRole("heading", { name: "Maintainer inbox" });
    // There is no header refresh control (ADR 0032): the menu's View →
    // Refresh is the only manual trigger, reaching the renderer through the
    // desktop navigate channel exercised here.
    desktop.navigate("refresh");
    expect(await screen.findByText("GitHub: Refreshing")).toBeTruthy();
    refreshFailure.resolve();
    // `inboxFreshnessLabel` returns "Refreshing" whenever the refreshing
    // flag is still true, so finding this text also proves the flag was
    // released rather than left stuck true after the failure.
    await waitFor(() =>
      expect(
        screen.getByText("GitHub: Cached after refresh failure"),
      ).toBeTruthy(),
    );
  });

  it("requests the default rows-per-page on load, then clears the page token and requests the first page with the new size on change", async () => {
    const user = userEvent.setup();
    const paths: string[] = [];
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: {
        request: async (input: { readonly path?: string }) => {
          if (input.path?.startsWith("/v1/inbox")) paths.push(input.path);
          return {
            ok: true,
            status: 200,
            correlationId: "test",
            body:
              input.path === "/v1/profiles"
                ? [
                    {
                      id: "profile",
                      label: "Profile",
                      githubHost: "github.com",
                      ghAccount: "fixture",
                    },
                  ]
                : input.path?.startsWith("/v1/inbox")
                  ? inbox()
                  : {},
          };
        },
        onNavigate: () => () => undefined,
      },
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Maintainer inbox" });
    expect(paths).toEqual(["/v1/inbox?state=open&pageSize=25"]);

    const select = screen.getByRole("combobox", { name: "Rows per page" });
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: "10" }));
    await waitFor(() =>
      expect(paths.at(-1)).toBe("/v1/inbox?state=open&pageSize=10"),
    );
  });

  it("requests the saved page size once on mount, without a default-size fetch first", async () => {
    saveInboxViewPreferences("profile", { pageSize: 10 });
    const paths: string[] = [];
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: {
        request: async (input: { readonly path?: string }) => {
          if (input.path?.startsWith("/v1/inbox")) paths.push(input.path);
          return {
            ok: true,
            status: 200,
            correlationId: "test",
            body:
              input.path === "/v1/profiles"
                ? [
                    {
                      id: "profile",
                      label: "Profile",
                      githubHost: "github.com",
                      ghAccount: "fixture",
                    },
                  ]
                : input.path?.startsWith("/v1/inbox")
                  ? { ...inbox(), inbox: { ...inbox().inbox, pageSize: 10 } }
                  : {},
          };
        },
        onNavigate: () => () => undefined,
      },
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Maintainer inbox" });
    // Exactly one request, already sized from the saved preference — not the
    // default-size bootstrap request followed by a corrective refetch.
    expect(paths).toEqual(["/v1/inbox?state=open&pageSize=10"]);
  });

  it("loads a restored Review through InboxFlow and keeps route callbacks", async () => {
    const deferred = promise<React.ComponentType<ReviewWorkbenchFlowProps>>();
    let received: ReviewWorkbenchFlowProps | undefined;
    window.localStorage.setItem(
      "patchdesk.destination",
      "workbench:review-42:diff",
    );
    window.localStorage.setItem(
      "patchdesk.workbench-ui.v1.review-42",
      JSON.stringify({
        activeTab: "diff",
        section: "files",
        selectedPath: "src/a.ts",
      }),
    );
    installDesktop();
    render(
      <App
        reviewWorkbenchLoader={() =>
          deferred.promise.then((defaultComponent) => ({
            default: defaultComponent,
          }))
        }
      />,
    );
    expect(await screen.findByRole("status")).not.toBeNull();
    deferred.resolve((props) => {
      received = props;
      return (
        <>
          <button
            type="button"
            onClick={() => props.onNavigationStateChange("dirty_draft")}
          >
            Dirty
          </button>
          <button type="button" onClick={() => props.onNavigate("checks")}>
            Checks
          </button>
          <button
            type="button"
            onClick={() =>
              props.onUiStateChange?.({
                activeTab: "insights",
                section: "files",
                selectedPath: "src/b.ts",
              })
            }
          >
            Save position
          </button>
          <button
            type="button"
            onClick={() => props.onWorkbenchReplace(replacedProjection())}
          >
            Replace
          </button>
          <p>{props.workbench.pullRequest?.title}</p>
        </>
      );
    });
    expect(await screen.findByText("Review")).not.toBeNull();
    expect(received?.initialSection).toBe("diff");
    expect(received?.initialUiState).toEqual({
      activeTab: "diff",
      section: "files",
      selectedPath: "src/a.ts",
    });
    fireEvent.click(screen.getByRole("button", { name: "Checks" }));
    expect(window.localStorage.getItem("patchdesk.destination")).toBe(
      "workbench:review-42:diff",
    );
    expect(screen.getByText("Review")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save position" }));
    expect(
      JSON.parse(
        window.localStorage.getItem("patchdesk.workbench-ui.v1.review-42") ??
          "null",
      ),
    ).toEqual({
      activeTab: "insights",
      section: "files",
      selectedPath: "src/b.ts",
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(await screen.findByText("Replaced")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dirty" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Back to pending pull requests" }),
    );
    expect(
      await screen.findByText("Leave with an unsaved review draft?"),
    ).not.toBeNull();
  });

  it("shows a retryable Review chunk failure", async () => {
    let attempts = 0;
    const reviewLoader: ReviewWorkbenchLoader = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("chunk unavailable");
      return { default: () => <p>Recovered review</p> };
    };
    window.localStorage.setItem("patchdesk.destination", "workbench:review-42");
    installDesktop();
    render(<App reviewWorkbenchLoader={reviewLoader} />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "could not load the Review workbench",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Recovered review")).not.toBeNull();
    expect(attempts).toBe(2);
  });
});

describe("App inbox state switch", () => {
  it("holds the row list in a loading state instead of showing the previous state's rows under the new state's label", async () => {
    const user = userEvent.setup();
    const mergedGate = promise<void>();
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: {
        request: async (input: { readonly path?: string }) => {
          if (input.path === "/v1/profiles") {
            return {
              ok: true,
              status: 200,
              correlationId: "test",
              body: [
                {
                  id: "profile",
                  label: "Profile",
                  githubHost: "github.com",
                  ghAccount: "fixture",
                },
              ],
            };
          }
          if (input.path === "/v1/inbox?state=open&pageSize=25") {
            return {
              ok: true,
              status: 200,
              correlationId: "test",
              body: stateFilteredInbox("open", 1, "Open PR title"),
            };
          }
          if (input.path === "/v1/inbox?state=merged&pageSize=25") {
            await mergedGate.promise;
            return {
              ok: true,
              status: 200,
              correlationId: "test",
              body: stateFilteredInbox("merged", 2, "Merged PR title"),
            };
          }
          return { ok: true, status: 200, correlationId: "test", body: {} };
        },
        onNavigate: () => () => undefined,
      },
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Maintainer inbox" });
    const rowList = screen.getByRole("listbox", { name: "Pull requests" });
    expect(await within(rowList).findByText("#1 Open PR title")).toBeTruthy();

    const stateSelect = screen.getByRole("combobox", {
      name: "Pull request state",
    });
    await user.click(stateSelect);
    await user.click(await screen.findByRole("option", { name: "Merged" }));

    // The filter bar's state Select reflects the requested state
    // immediately, so the click still feels responsive.
    await waitFor(() => expect(stateSelect.textContent).toContain("Merged"));
    // The refresh indicator — the app's existing loading affordance —
    // reflects the in-flight request.
    expect(await screen.findByText("GitHub: Refreshing")).toBeTruthy();
    // The previous (open) state's row must not render under the "Merged"
    // label while the merged-state response is still in flight, and the
    // new state's row has not arrived yet either.
    expect(within(rowList).queryByText("#1 Open PR title")).toBeNull();
    expect(within(rowList).queryByText("#2 Merged PR title")).toBeNull();

    mergedGate.resolve();
    expect(await within(rowList).findByText("#2 Merged PR title")).toBeTruthy();
    expect(within(rowList).queryByText("#1 Open PR title")).toBeNull();
  });
});

describe("App repository picker", () => {
  it("selects the first watched repository by default, then the selection persists across a reload", async () => {
    const user = userEvent.setup();
    const desktop = installRepoDesktop();
    const { unmount } = render(<App />);
    await screen.findByRole("heading", { name: "Maintainer inbox" });
    // The bootstrap request never carries a repository; the correction
    // fetch that follows resolves it to the first watched repository.
    await waitFor(() =>
      expect(desktop.paths.at(-1)).toContain(`owner=${repoA.owner}`),
    );

    const combo = screen.getByRole("combobox", { name: "Repository" });
    expect(combo.textContent).toContain(`${repoA.owner}/${repoA.repo}`);
    await user.click(combo);
    await user.click(
      await screen.findByRole("option", {
        name: `${repoB.owner}/${repoB.repo}`,
      }),
    );
    await waitFor(() =>
      expect(desktop.paths.at(-1)).toContain(`owner=${repoB.owner}`),
    );
    expect(loadInboxViewPreferences("profile").selectedRepository).toEqual(
      repoB,
    );

    // Simulate an app restart: a fresh mount, same localStorage.
    unmount();
    desktop.paths.length = 0;
    render(<App />);
    await screen.findByRole("heading", { name: "Maintainer inbox" });
    await waitFor(() =>
      expect(desktop.paths.at(-1)).toContain(`owner=${repoB.owner}`),
    );
    expect(
      screen.getByRole("combobox", { name: "Repository" }).textContent,
    ).toContain(`${repoB.owner}/${repoB.repo}`);
  });

  it("falls back to the first watched repository, and never requests one outside the watchlist, when the stored selection is no longer watched", async () => {
    saveInboxViewPreferences("profile", {
      selectedRepository: {
        host: "github.com",
        owner: "removed-owner",
        repo: "removed-repo",
      },
    });
    const desktop = installRepoDesktop();
    render(<App />);
    await screen.findByRole("heading", { name: "Maintainer inbox" });
    await waitFor(() =>
      expect(desktop.paths.at(-1)).toContain(`owner=${repoA.owner}`),
    );
    expect(
      desktop.paths.some((path) => path.includes("owner=removed-owner")),
    ).toBe(false);
  });

  it("still shows the picker for exactly one watched repository", async () => {
    const desktop = installRepoDesktop([repoA]);
    render(<App />);
    await screen.findByRole("heading", { name: "Maintainer inbox" });
    await waitFor(() =>
      expect(desktop.paths.at(-1)).toContain(`owner=${repoA.owner}`),
    );
    expect(
      screen.getByRole("combobox", { name: "Repository" }).textContent,
    ).toContain(`${repoA.owner}/${repoA.repo}`);
  });

  it("holds the row list in a loading state while a repository change is in flight", async () => {
    const user = userEvent.setup();
    const gate = promise<void>();
    const desktop = installRepoDesktop(undefined, (path) =>
      path.includes(`repo=${repoB.repo}`) ? gate.promise : undefined,
    );
    render(<App />);
    await screen.findByRole("heading", { name: "Maintainer inbox" });
    const rowList = screen.getByRole("listbox", { name: "Pull requests" });
    expect(
      await within(rowList).findByText(`#1 ${repoA.owner}/${repoA.repo} PR`),
    ).toBeTruthy();

    await user.click(screen.getByRole("combobox", { name: "Repository" }));
    await user.click(
      await screen.findByRole("option", {
        name: `${repoB.owner}/${repoB.repo}`,
      }),
    );

    // The picker reflects the new repository immediately, so the click feels
    // responsive. The rows must not: repository A's rows presented under
    // repository B's name are the previous request's answer.
    await waitFor(() =>
      expect(desktop.paths.at(-1)).toContain(`repo=${repoB.repo}`),
    );
    // Re-queried, not reused: a repository change remounts the inbox (its
    // `key` is the repository), so the node captured above is detached.
    const pendingList = screen.getByRole("listbox", { name: "Pull requests" });
    expect(
      within(pendingList).queryByText(`#1 ${repoA.owner}/${repoA.repo} PR`),
    ).toBeNull();
    expect(pendingList.getAttribute("aria-busy")).toBe("true");

    gate.resolve();
    await waitFor(() =>
      expect(
        screen
          .getByRole("listbox", { name: "Pull requests" })
          .getAttribute("aria-busy"),
      ).not.toBe("true"),
    );
    expect(
      within(screen.getByRole("listbox", { name: "Pull requests" })).getByText(
        `#1 ${repoB.owner}/${repoB.repo} PR`,
      ),
    ).toBeTruthy();
  });

  it("holds the row list in a loading state while a filter the response never echoes is in flight", async () => {
    const user = userEvent.setup();
    const gate = promise<void>();
    const desktop = installRepoDesktop(undefined, (path) =>
      path.includes("awaitingMyReview=1") ? gate.promise : undefined,
    );
    render(<App />);
    await screen.findByRole("heading", { name: "Maintainer inbox" });
    const rowList = screen.getByRole("listbox", { name: "Pull requests" });
    expect(
      await within(rowList).findByText(`#1 ${repoA.owner}/${repoA.repo} PR`),
    ).toBeTruthy();

    // The response echoes only the state filter and the page size. It says
    // nothing about the preset or the label filter, so whether the rows on
    // screen are stale is a fact about the request that produced them, not
    // something the response can be asked.
    await user.click(
      screen.getByRole("button", { name: "Awaiting review from you" }),
    );

    await waitFor(() =>
      expect(desktop.paths.at(-1)).toContain("awaitingMyReview=1"),
    );
    // Re-queried rather than reused: the row list is replaced, not updated
    // in place, when the request behind it changes.
    const pendingList = screen.getByRole("listbox", { name: "Pull requests" });
    expect(
      within(pendingList).queryByText(`#1 ${repoA.owner}/${repoA.repo} PR`),
    ).toBeNull();
    expect(pendingList.getAttribute("aria-busy")).toBe("true");

    gate.resolve();
    await waitFor(() =>
      expect(
        screen
          .getByRole("listbox", { name: "Pull requests" })
          .getAttribute("aria-busy"),
      ).not.toBe("true"),
    );
    expect(
      within(screen.getByRole("listbox", { name: "Pull requests" })).getByText(
        `#1 ${repoA.owner}/${repoA.repo} PR`,
      ),
    ).toBeTruthy();
  });

  it("carries the Awaiting review from you preset across a repository change", async () => {
    const user = userEvent.setup();
    const desktop = installRepoDesktop();
    render(<App />);
    await screen.findByRole("heading", { name: "Maintainer inbox" });
    await waitFor(() =>
      expect(desktop.paths.at(-1)).toContain(`owner=${repoA.owner}`),
    );

    await user.click(
      screen.getByRole("button", { name: "Awaiting review from you" }),
    );
    await waitFor(() =>
      expect(desktop.paths.at(-1)).toContain("awaitingMyReview=1"),
    );

    await user.click(screen.getByRole("combobox", { name: "Repository" }));
    await user.click(
      await screen.findByRole("option", {
        name: `${repoB.owner}/${repoB.repo}`,
      }),
    );
    await waitFor(() =>
      expect(desktop.paths.at(-1)).toContain(`owner=${repoB.owner}`),
    );

    // Unlike the label filter, `user-review-requested:@me` means the same
    // thing in every repository, so a repository change must not clear it —
    // validation section 6 requires the preset to survive the change.
    expect(desktop.paths.at(-1)).toContain("awaitingMyReview=1");
    expect(loadInboxViewPreferences("profile").awaitingMyReview).toBe(true);
  });

  it("changing the selected repository resets the page cursor and clears the label filter, in exactly one request", async () => {
    const user = userEvent.setup();
    saveInboxViewPreferences("profile", {
      selectedLabels: ["bug"],
    });
    const desktop = installRepoDesktop();
    render(<App />);
    await screen.findByRole("heading", { name: "Maintainer inbox" });
    await waitFor(() =>
      expect(desktop.paths.at(-1)).toContain(`owner=${repoA.owner}`),
    );

    // Reach page 2, so a cursor is on record for repoA.
    await user.click(screen.getByLabelText("Go to next page"));
    await waitFor(() => expect(desktop.paths.at(-1)).toContain("page=page-1"));

    const requestsBeforeSwitch = desktop.paths.length;
    await user.click(screen.getByRole("combobox", { name: "Repository" }));
    await user.click(
      await screen.findByRole("option", {
        name: `${repoB.owner}/${repoB.repo}`,
      }),
    );
    await waitFor(() =>
      expect(desktop.paths.at(-1)).toContain(`owner=${repoB.owner}`),
    );

    expect(desktop.paths.length).toBe(requestsBeforeSwitch + 1);
    expect(desktop.paths.at(-1)).not.toContain("page=");
    const preferences = loadInboxViewPreferences("profile");
    expect(preferences.selectedLabels).toEqual([]);
  });
});

/** A single-row inbox response for the given state, valid against
 * `parseInboxResponse`'s schema. */
function stateFilteredInbox(
  state: "open" | "merged",
  number: number,
  title: string,
) {
  return {
    profile: {
      id: "profile",
      label: "Profile",
      githubHost: "github.com",
      ghAccount: "fixture",
    },
    inbox: {
      state,
      pageSize: 25,
      rows: [
        {
          remoteState: state,
          identity: {
            host: "github.com",
            owner: "owner",
            repo: "repo",
            number,
          },
          title,
          author: "author",
          baseBranch: "main",
          headBranch: "change",
          currentHeadSha: "a".repeat(40),
          isDraft: false,
          updatedAt: "2026-08-01T00:00:00.000Z",
          changeStats: {},
          checks: { overall: "unknown", checks: [] },
          reviewState: "none",
          mergeability: "unknown",
          labels: [],
          // The default queue in "open" state is "my_inbox", which only
          // shows rows carrying this category; "merged" state bypasses queue
          // filtering entirely, so this only matters for the open-state row.
          categories:
            state === "open" ? (["updated_since_review"] as const) : [],
          recommendedAction:
            state === "open"
              ? { kind: "run_review", label: "Run review" }
              : {
                  kind: "open_merged_review",
                  label: "View merged pull request",
                },
          dataFreshness: "fresh",
        },
      ],
      repositories: [],
      dataFreshness: "fresh",
    },
  };
}

/** Test double for the desktop navigate channel: lets a test fire the same
 * "refresh"/"settings" destinations the View menu sends over IPC, without a
 * real Electron main process. */
type DesktopNavigateDouble = {
  readonly navigate: (destination: "settings" | "refresh") => void;
};

function installDesktop(
  options: {
    readonly failInboxRefresh?: boolean;
    readonly inboxRefreshGate?: Promise<void>;
  } = {},
): DesktopNavigateDouble {
  let inboxRequests = 0;
  let navigateListener:
    | ((destination: "settings" | "refresh") => void)
    | undefined;
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: {
      request: async (input: { readonly path?: string }) => {
        if (input.path === "/v1/inbox?state=open&pageSize=25") {
          inboxRequests += 1;
          if (options.failInboxRefresh && inboxRequests > 1) {
            if (options.inboxRefreshGate !== undefined)
              await options.inboxRefreshGate;
            throw new Error("refresh failed");
          }
        }
        return {
          ok: true,
          status: 200,
          correlationId: "test",
          body:
            input.path === "/v1/profiles"
              ? [
                  {
                    id: "profile",
                    label: "Profile",
                    githubHost: "github.com",
                    ghAccount: "fixture",
                  },
                ]
              : input.path === "/v1/inbox?state=open&pageSize=25"
                ? inbox()
                : input.path === "/v1/reviews/load"
                  ? projection()
                  : {},
        };
      },
      onNavigate: (listener: (destination: "settings" | "refresh") => void) => {
        navigateListener = listener;
        return () => {
          navigateListener = undefined;
        };
      },
    },
  });
  return {
    navigate: (destination) => navigateListener?.(destination),
  };
}

function inbox() {
  return {
    profile: {
      id: "profile",
      label: "Profile",
      githubHost: "github.com",
      ghAccount: "fixture",
    },
    inbox: {
      state: "open",
      pageSize: 25,
      rows: [],
      repositories: [],
      dataFreshness: "fresh",
    },
  };
}

const repoA = { host: "github.com", owner: "acme", repo: "widgets" };
const repoB = { host: "github.com", owner: "acme", repo: "gadgets" };

/** A valid single-row inbox response for the given repository, optionally
 * carrying a `nextPageToken` so a test can page forward. */
function repoInboxResponse(
  repo: typeof repoA,
  watchlist: ReadonlyArray<typeof repoA>,
  options: { readonly nextPageToken?: string } = {},
) {
  const nextPageTokenField =
    options.nextPageToken === undefined
      ? {}
      : { nextPageToken: options.nextPageToken };
  return {
    profile: {
      id: "profile",
      label: "Profile",
      githubHost: "github.com",
      ghAccount: "fixture",
      repos: watchlist,
    },
    inbox: {
      state: "open",
      pageSize: 25,
      ...nextPageTokenField,
      rows: [
        {
          remoteState: "open",
          identity: { ...repo, number: 1 },
          title: `${repo.owner}/${repo.repo} PR`,
          author: "author",
          baseBranch: "main",
          headBranch: "change",
          currentHeadSha: "a".repeat(40),
          isDraft: false,
          updatedAt: "2026-08-01T00:00:00.000Z",
          changeStats: {},
          checks: { overall: "unknown", checks: [] },
          reviewState: "none",
          mergeability: "unknown",
          labels: [],
          categories: ["updated_since_review"],
          recommendedAction: { kind: "run_review", label: "Run review" },
          dataFreshness: "fresh",
        },
      ],
      repositories: [{ repo, state: "ready" }],
      dataFreshness: "fresh",
    },
  };
}

/** Test double for the desktop request channel with a two-(or one-)
 * repository watchlist, keyed by the `owner` and `page` query parameters
 * `inboxRequestPath` builds. Mirrors the server's hard rejection
 * (`DashboardController.inboxForActiveProfile`) for any repository outside
 * `watchlist`, so a misbehaving renderer fails loudly rather than being
 * silently humored. */
function installRepoDesktop(
  watchlist: ReadonlyArray<typeof repoA> = [repoA, repoB],
  /** Holds a matching inbox request open so a test can assert on the row
   * list while it is genuinely in flight. */
  gateFor: (path: string) => Promise<void> | undefined = () => undefined,
) {
  const paths: string[] = [];
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: {
      request: async (input: { readonly path?: string }) => {
        const path = input.path ?? "";
        if (path === "/v1/profiles") {
          return {
            ok: true,
            status: 200,
            correlationId: "test",
            body: [
              {
                id: "profile",
                label: "Profile",
                githubHost: "github.com",
                ghAccount: "fixture",
                repos: watchlist,
              },
            ],
          };
        }
        if (!path.startsWith("/v1/inbox"))
          return { ok: true, status: 200, correlationId: "test", body: {} };
        paths.push(path);
        await gateFor(path);
        const url = new URL(path, "http://localhost");
        const owner = url.searchParams.get("owner");
        const repoName = url.searchParams.get("repo");
        // No explicit repository (the bootstrap request) resolves the same
        // way the server does: the first watched repository.
        const repo =
          owner === null || repoName === null
            ? watchlist[0]
            : watchlist.find(
                (candidate) =>
                  candidate.owner === owner && candidate.repo === repoName,
              );
        if (repo === undefined)
          return {
            ok: false,
            status: 400,
            correlationId: "test",
            body: { error: "invalid_input" },
          };
        const page = url.searchParams.get("page");
        const body =
          page === "page-1"
            ? repoInboxResponse(repo, watchlist)
            : repoInboxResponse(repo, watchlist, { nextPageToken: "page-1" });
        return { ok: true, status: 200, correlationId: "test", body };
      },
      onNavigate: () => () => undefined,
    },
  });
  return { paths };
}

function projection(
  overrides: Partial<WorkbenchResponse> = {},
): WorkbenchResponse {
  return {
    state: "review",
    review: { id: "review-42", status: "open" },
    session: {
      id: "session-42",
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
      title: "Review",
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
    conversation: { prDescription: "", entries: [] },
    checks: { overall: "passing", checks: [] },
    mergeReadiness: { _tag: "Ready", blockers: [], warnings: [] },
    mergeReasons: [],
    ...overrides,
  } satisfies WorkbenchResponse;
}

function replacedProjection(): WorkbenchResponse {
  const value = projection();
  const pullRequest = value.pullRequest;
  if (pullRequest === undefined)
    throw new Error("Fixture is missing pull request");
  return projection({
    pullRequest: {
      ...pullRequest,
      title: "Replaced",
    },
  });
}

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function promise<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

function contentHashFixture(value: string) {
  const parsed = parseContentHash(value);
  if (parsed._tag === "err") throw new Error("Expected a content hash fixture");
  return parsed.value;
}
