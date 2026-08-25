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

  it("releases the Inbox refresh state after a failed manual refresh", async () => {
    const user = userEvent.setup();
    const originalVisibility = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    const refreshFailure = promise<void>();
    installDesktop({
      failInboxRefresh: true,
      inboxRefreshGate: refreshFailure.promise,
    });
    render(<App />);

    await screen.findByRole("heading", { name: "Maintainer inbox" });
    fireEvent.focus(window);
    const refresh = screen.getByRole("button", {
      name: "Refresh all watched repositories",
    });
    await user.click(refresh);
    expect(await screen.findByText("GitHub: Refreshing")).toBeTruthy();
    refreshFailure.resolve();
    await waitFor(() =>
      expect(
        screen.getByText("GitHub: Cached after refresh failure"),
      ).toBeTruthy(),
    );
    if (!(refresh instanceof HTMLButtonElement))
      throw new Error("Expected refresh control to be a button");
    expect(refresh.disabled).toBe(false);
    if (originalVisibility === undefined)
      Reflect.deleteProperty(document, "visibilityState");
    else Object.defineProperty(document, "visibilityState", originalVisibility);
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
    expect(paths).toEqual(["/v1/inbox?scope=open&pageSize=25"]);

    const select = screen.getByRole("combobox", { name: "Rows per page" });
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: "10" }));
    await waitFor(() =>
      expect(paths.at(-1)).toBe("/v1/inbox?scope=open&pageSize=10"),
    );
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

describe("App inbox scope switch", () => {
  it("holds the row list in a loading state instead of showing the previous scope's rows under the new scope's label", async () => {
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
          if (input.path === "/v1/inbox?scope=open&pageSize=25") {
            return {
              ok: true,
              status: 200,
              correlationId: "test",
              body: scopedInbox("open", 1, "Open PR title"),
            };
          }
          if (input.path === "/v1/inbox?scope=merged&pageSize=25") {
            await mergedGate.promise;
            return {
              ok: true,
              status: 200,
              correlationId: "test",
              body: scopedInbox("merged", 2, "Merged PR title"),
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

    await user.click(screen.getByRole("button", { name: "Merged" }));

    // The toggle reflects the requested scope immediately, so the click
    // still feels responsive.
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Merged" })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    // The refresh indicator — the app's existing loading affordance —
    // reflects the in-flight request.
    expect(await screen.findByText("GitHub: Refreshing")).toBeTruthy();
    // The previous (open) scope's row must not render under the "Merged"
    // label while the merged-scope response is still in flight, and the
    // new scope's row has not arrived yet either.
    expect(within(rowList).queryByText("#1 Open PR title")).toBeNull();
    expect(within(rowList).queryByText("#2 Merged PR title")).toBeNull();

    mergedGate.resolve();
    expect(await within(rowList).findByText("#2 Merged PR title")).toBeTruthy();
    expect(within(rowList).queryByText("#1 Open PR title")).toBeNull();
  });
});

/** A single-row inbox response for the given scope, valid against
 * `parseInboxResponse`'s schema. */
function scopedInbox(scope: "open" | "merged", number: number, title: string) {
  return {
    profile: {
      id: "profile",
      label: "Profile",
      githubHost: "github.com",
      ghAccount: "fixture",
    },
    inbox: {
      scope,
      pageSize: 25,
      rows: [
        {
          remoteState: scope,
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
          // The default queue in "open" scope is "my_inbox", which only
          // shows rows carrying one of these categories; "merged" scope
          // bypasses queue filtering entirely, so this only matters for the
          // open-scope row.
          categories: scope === "open" ? (["needs_review"] as const) : [],
          recommendedAction:
            scope === "open"
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

function installDesktop(
  options: {
    readonly failInboxRefresh?: boolean;
    readonly inboxRefreshGate?: Promise<void>;
  } = {},
): void {
  let inboxRequests = 0;
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: {
      request: async (input: { readonly path?: string }) => {
        if (input.path === "/v1/inbox?scope=open&pageSize=25") {
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
              : input.path === "/v1/inbox?scope=open&pageSize=25"
                ? inbox()
                : input.path === "/v1/reviews/load"
                  ? projection()
                  : {},
        };
      },
      onNavigate: () => () => undefined,
    },
  });
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
      scope: "open",
      pageSize: 25,
      rows: [],
      repositories: [],
      dataFreshness: "fresh",
    },
  };
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
