// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { App, type ReviewWorkbenchLoader } from "../../src/renderer/src/app";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import type { ReviewWorkbenchFlowProps } from "../../src/renderer/src/flows/review-workbench-flow";

const sha = "a".repeat(40);
const patchHash = "b".repeat(64);

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

function installDesktop(): void {
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: {
      request: async (input: { readonly path?: string }) => ({
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
            : input.path === "/v1/inbox"
              ? inbox()
              : input.path === "/v1/reviews/load"
                ? projection()
                : {},
      }),
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
    inbox: { rows: [], repositories: [], dataFreshness: "fresh" },
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
      patchHash: patchHash as never,
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
  } as WorkbenchResponse;
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
    } as WorkbenchResponse["pullRequest"],
  });
}

function promise<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve,
  };
}
