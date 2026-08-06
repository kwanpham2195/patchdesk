// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/src/app";

const dashboard = {
  profile: {
    id: "cfw",
    label: "CFW",
    githubHost: "github.com",
    ghAccount: "pmquan2cfw",
  },
  dashboard: {
    rows: [
      {
        summary: {
          ref: { number: 42 },
          title: "Real dashboard row",
          author: "reviewer",
          checkSummary: { overall: "passing" },
        },
        priority: "review_requested",
        badges: ["review requested"],
      },
    ],
    repos: [
      {
        repo: {
          host: "github.com",
          owner: "centraldigital",
          repo: "patchdesk",
        },
        state: "ready",
      },
    ],
  },
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("dashboard renderer API flow", () => {
  it("loads profile, watchlist, rows, and repo state from authenticated API responses", async () => {
    installApi();
    render(<App />);
    expect(
      (await screen.findAllByText(/Real dashboard row/)).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText("centraldigital/patchdesk").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/patchdesk/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Archived repository/)).toBeNull();
    expect(screen.queryByText(/Submit review|Merge pull request/i)).toBeNull();
  });

  it("keeps Watchlist management in Workspace Settings instead of the queue surface", async () => {
    const fetch = installApi({
      suggestionsValue: [
        { host: "github.com", owner: "centraldigital", repo: "new-service", localPath: "/workspace/new-service" },
      ],
      selectedDirectory: "/workspace/patchdesk",
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);

    expect(screen.queryByRole("region", { name: "Watchlist" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: "Workspace" }));

    const watchlist = screen.getByRole("region", { name: "Watchlist" });
    expect(
      within(watchlist).getByRole("button", { name: "Refresh discovery" }),
    ).toBeTruthy();
    expect(
      within(watchlist).queryByLabelText("Repository"),
    ).toBeNull();
    expect(
      await within(watchlist).findByText("centraldigital/new-service"),
    ).toBeTruthy();

    // Toggle the checkbox to add the repo to the watchlist
    const checkbox = within(watchlist).getByRole("checkbox");
    await user.click(checkbox);
    expect(
      fetch.mock.calls.some(
        ([input, init]) =>
          String(input).includes("v1/watchlist") &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(true);
    expect(
      fetch.mock.calls.some(([input]) =>
        String(input).includes("v1/watchlist/suggestions"),
      ),
    ).toBe(true);
  });

  it("shows an ordered first-run path with a real Settings action", async () => {
    installApi({
      dashboardValue: { ...dashboard, dashboard: { rows: [], repos: [] } },
    });
    const user = userEvent.setup();
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Set up Patchdesk" }),
    ).toBeTruthy();
    expect(screen.getByText("1. Confirm GitHub access")).toBeTruthy();
    expect(screen.getByText("2. Check local tools")).toBeTruthy();
    expect(screen.getByText("3. Add your first repository")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Open Settings to finish setup" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeTruthy();
  });

  it("clears an active workbench before switching profiles", async () => {
    window.localStorage.setItem(
      "patchdesk.destination",
      "workbench:review-123",
    );
    installApi({ loadedWorkbench: completedWorkbench });
    const user = userEvent.setup();
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Stored review title" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: "Workspace" }));
    const activeProfile = screen.getByRole("combobox", {
      name: "Active profile",
    });
    await user.click(activeProfile);
    await waitFor(() =>
      expect(activeProfile.getAttribute("aria-expanded")).toBe("true"),
    );
    await user.click(await screen.findByRole("option", { name: "Enterprise" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Stored review title" }),
      ).toBeNull(),
    );
    expect(window.localStorage.getItem("patchdesk.destination")).toBe(
      "dashboard",
    );
  });

  it("clears dashboard and inbox data when a selected profile reload fails", async () => {
    const fetch = installApi({ profileSwitchReloadFailures: 2 });
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: "Workspace" }));
    const activeProfile = screen.getByRole("combobox", {
      name: "Active profile",
    });
    await user.click(activeProfile);
    await waitFor(() =>
      expect(activeProfile.getAttribute("aria-expanded")).toBe("true"),
    );
    await user.click(await screen.findByRole("option", { name: "Enterprise" }));

    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([input, init]) =>
            String(input).includes("v1/profiles/select") &&
            init?.method === "POST",
        ),
      ).toBe(true),
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(
      await screen.findByText("Dashboard could not be loaded"),
    ).toBeTruthy();
    expect(screen.queryByText("Real dashboard row")).toBeNull();
    expect(screen.queryByText("centraldigital/patchdesk")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Retry dashboard" }),
    ).toBeTruthy();
  });

  it("returns focus to the persistent Navigate opener after command-palette Settings", async () => {
    installApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    const navigate = screen.getByRole("button", { name: /Navigate/ });
    await user.click(navigate);
    await user.click(screen.getByRole("option", { name: "Settings" }));
    expect(
      await screen.findByRole("dialog", { name: "Settings" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.activeElement).toBe(navigate));
  });

  it("opens the global Settings overlay without changing the inbox route", async () => {
    installApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      await screen.findByRole("dialog", { name: "Settings" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "General" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getAllByText(/Real dashboard row/).length).toBeGreaterThan(0);
  });

  it("recovers a failed dashboard load through the visible retry action", async () => {
    const fetch = installApi({ dashboardFailures: 1 });
    const user = userEvent.setup();
    render(<App />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Dashboard could not be loaded",
    );
    await user.click(screen.getByRole("button", { name: "Retry dashboard" }));
    expect(
      (await screen.findAllByText(/Real dashboard row/)).length,
    ).toBeGreaterThan(0);
    expect(
      fetch.mock.calls.filter(
        ([input]) => new URL(String(input)).pathname === "/v1/inbox",
      ),
    ).toHaveLength(2);
  });

  it("explains missing GitHub authentication and routes recovery through Settings", async () => {
    installApi({
      dashboardValue: {
        ...dashboard,
        dashboard: {
          rows: [],
          repos: [
            {
              repo: {
                host: "github.com",
                owner: "centraldigital",
                repo: "patchdesk",
              },
              state: "github_auth",
            },
          ],
        },
      },
    });
    const user = userEvent.setup();
    render(<App />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "GitHub authentication is required before Patchdesk can refresh pull requests",
    );
    await user.click(
      screen.getByRole("button", { name: "Open Settings for GitHub access" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeTruthy();
  });

  it("opens Settings from the current inbox shell", async () => {
    installApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      await screen.findByRole("dialog", { name: "Settings" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "General" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("refreshes Inbox once from the visible action without using the removed endpoint", async () => {
    const fetch = installApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    const inboxReadsBefore = fetch.mock.calls.filter(
      ([input]) => new URL(String(input)).pathname === "/v1/inbox",
    ).length;

    await user.click(
      screen.getByRole("button", { name: "Refresh all watched repositories" }),
    );

    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(
          ([input]) => new URL(String(input)).pathname === "/v1/inbox",
        ),
      ).toHaveLength(inboxReadsBefore + 1),
    );
    expect(
      fetch.mock.calls.some(
        ([input]) => new URL(String(input)).pathname === "/v1/inbox/refresh",
      ),
    ).toBe(false);
  });

  it("uses the native directory picker before saving a workspace root", async () => {
    const fetch = installApi({ selectedDirectory: "/workspace/patchdesk" });
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: "Workspace" }));
    await user.click(
      screen.getByRole("button", { name: "Add workspace root" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Choose folder" }),
    );
    expect(
      (screen.getByLabelText("workspace root 1") as HTMLInputElement).value,
    ).toBe("/workspace/patchdesk");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(
      fetch.mock.calls.some(
        ([input, init]) =>
          String(input).includes("v1/profiles") &&
          (init as RequestInit | undefined)?.method === "PUT" &&
          String((init as RequestInit).body).includes("/workspace/patchdesk"),
      ),
    ).toBe(true);
  });

  it("keeps the workspace root unchanged when directory selection is cancelled", async () => {
    installApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: "Workspace" }));
    await user.click(
      screen.getByRole("button", { name: "Add workspace root" }),
    );
    const path = screen.getByLabelText("workspace root 1") as HTMLInputElement;
    await user.click(
      screen.getByRole("button", { name: "Choose folder" }),
    );
    expect(path.value).toBe("");
  });

  it("keeps environment diagnostics out of Settings", async () => {
    installApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByText("Environment diagnostics")).toBeNull();
  });

  it("confirms local review-data cleanup and keeps exact retention copy", async () => {
    const fetch = installApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: "Data & recovery" }));
    await user.click(
      screen.getByRole("button", { name: "Clear local review data" }),
    );
    expect(
      screen.getByText(
        "This removes completed and failed local reviews. An active review and diagnostic reports stay.",
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear local data" }));
    expect(
      fetch.mock.calls.some(
        ([input, init]) =>
          String(input).includes("v1/storage/clear-local-data") &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(true);
  });

  it("returns to the inbox after local review-data cleanup deletes the open review", async () => {
    window.localStorage.setItem(
      "patchdesk.destination",
      "workbench:review-123",
    );
    installApi({ loadedWorkbench: completedWorkbench });
    const user = userEvent.setup();
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Stored review title" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: "Data & recovery" }));
    await user.click(
      screen.getByRole("button", { name: "Clear local review data" }),
    );
    await user.click(screen.getByRole("button", { name: "Clear local data" }));

    expect(
      await screen.findByRole("heading", { name: "Maintainer inbox" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Stored review title" }),
    ).toBeNull();
    expect(window.localStorage.getItem("patchdesk.destination")).toBe(
      "dashboard",
    );
  });

  it("keeps cache cleanup explicit and separate from local review data", async () => {
    const fetch = installApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: "Data & recovery" }));
    await user.click(screen.getByRole("button", { name: "Clear cache" }));
    expect(
      screen.getByText(
        "This removes rebuildable local files. Your saved reviews and diagnostic reports stay.",
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear cache" }));
    expect(
      fetch.mock.calls.some(
        ([input, init]) =>
          String(input).includes("v1/storage/cache/clear") &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(true);
  });

  it("shows only redacted review activity from Settings", async () => {
    const fetch = installApi({
      activityEvents: [
        {
          at: "2026-07-29T00:00:00.000Z",
          category: "run",
          phase: "workflow-failed",
          retryable: true,
          durationMs: 17_000,
          detail: "review_execution_failed",
        },
      ],
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: "Data & recovery" }));
    await user.click(screen.getByRole("button", { name: "Load activity" }));

    expect(
      await screen.findByRole("list", { name: "Review activity log" }),
    ).toBeTruthy();
    expect(screen.getByText("Workflow Failed")).toBeTruthy();
    expect(screen.getByText("review_execution_failed")).toBeTruthy();
    expect(
      fetch.mock.calls.some(([input]) =>
        String(input).includes("v1/diagnostics?profileId=cfw"),
      ),
    ).toBe(true);
  });

  it("returns to the inbox after closing Settings", async () => {
    installApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      await screen.findByRole("dialog", { name: "Settings" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getAllByText(/Real dashboard row/).length).toBeGreaterThan(0);
  });

  it("keeps product metadata out of Settings", async () => {
    const user = userEvent.setup();
    installApi();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByText("Environment diagnostics")).toBeNull();
    expect(screen.queryByText("unsigned_internal")).toBeNull();
  });

  it("restores an exact persisted workbench destination after restart", async () => {
    window.localStorage.setItem(
      "patchdesk.destination",
      "workbench:review-123",
    );
    const fetch = installApi({ loadedWorkbench: completedWorkbench });
    const user = userEvent.setup();
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Stored review title" }),
    ).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Browse" })).toBeTruthy();
    expect(
      fetch.mock.calls.some(
        ([input, init]) =>
          String(input).includes("v1/reviews/load") &&
          String((init as RequestInit | undefined)?.body).includes(
            '"reviewId":"review-123"',
          ),
      ),
    ).toBe(true);
    expect(
      fetch.mock.calls.some(([input]) =>
        String(input).includes("v1/runs/review-pr"),
      ),
    ).toBe(false);

    await user.click(
      screen.getByRole("button", { name: "Back to pending pull requests" }),
    );
    const dashboardHeading = await screen.findByRole("heading", {
      name: "Maintainer inbox",
    });
    await waitFor(() => expect(document.activeElement).toBe(dashboardHeading));
    expect(document.title).toBe("Maintainer inbox · Patchdesk");
    expect(window.localStorage.getItem("patchdesk.destination")).toBe(
      "dashboard",
    );
    expect(
      fetch.mock.calls.some(([input]) =>
        String(input).includes("v1/runs/review-pr"),
      ),
    ).toBe(false);
  });
});

const completedWorkbench = {
  state: "review",
  review: { id: "review-123", status: "open" },
  session: {
    id: "session-123",
    key: {
      profileId: "cfw",
      host: "github.com",
      owner: "centraldigital",
      repo: "patchdesk",
      prNumber: 42,
      headSha: "abcdef1234567890abcdef1234567890abcdef12",
    },
  },
  revision: {
    reviewedHeadSha: "abcdef1234567890abcdef1234567890abcdef12",
    currentHeadSha: "abcdef1234567890abcdef1234567890abcdef12",
    freshness: "fresh",
    refreshedAt: "2026-07-17T12:00:00.000Z",
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
    title: "Stored review title",
    author: "reviewer",
    headBranch: "feat/stored",
    baseBranch: "sit",
    headSha: "abcdef1234567890abcdef1234567890abcdef12",
    isOpen: true,
    isDraft: false,
    reviewState: "none",
    mergeability: "mergeable",
    labels: [],
    updatedAt: "2026-07-17T12:00:00.000Z",
  },
  commits: [],
  insights: {
    analysis: {
      status: "current",
      retained: {
        sessionId: "session-123",
        headSha: "abcdef1234567890abcdef1234567890abcdef12",
        generatedAt: "2026-07-17T12:00:00.000Z",
        value: {
          changeSummary: "Stored review",
          verdict: "comment",
          summary: "Stored local result",
          findings: [],
          validationPlan: [],
          assumptions: [],
        },
      },
    },
    walkthrough: { status: "not_generated" },
  },
  draft: {
    sessionId: "session-123",
    updatedAt: "2026-07-17T12:00:00.000Z",
    summaryBody: "Stored draft",
    suggestedEvent: "COMMENT",
    items: [],
    receipts: [],
    createdAt: "2026-07-17T12:00:00.000Z",
    state: { _tag: "Local" },
  },
  publishedFeedback: { reviews: [], comments: [] },
  comments: { threads: [] },
  checks: { overall: "passing", checks: [] },
  mergeReadiness: { _tag: "Ready", blockers: [], warnings: [] },
} as const;

function installApi(
  options: {
    readonly dashboardPending?: boolean;
    readonly dashboardFailures?: number;
    readonly profileSwitchReloadFailures?: number;
    readonly dashboardValue?: unknown;
    readonly suggestionsValue?: unknown;
    readonly environmentValue?: unknown;
    readonly selectedDirectory?: string;
    readonly removeResponse?: Promise<Response>;
    readonly removeStatus?: number;
    readonly reviewRecords?: ReadonlyArray<unknown>;
    readonly reviewRecordsPending?: boolean;
    readonly reviewRecordsStatus?: number;
    readonly activityEvents?: ReadonlyArray<unknown>;
    readonly loadedWorkbench?: unknown;
    readonly captureNavigation?: (
      listener: (destination: "settings") => void,
    ) => void;
  } = {},
): ReturnType<typeof vi.fn> {
  let remainingDashboardFailures = options.dashboardFailures ?? 0;
  let remainingProfileSwitchReloadFailures =
    options.profileSwitchReloadFailures ?? 0;
  let profileSelectionSucceeded = false;
  const request = vi.fn(
    async (request: {
      readonly path?: string;
      readonly method?: string;
      readonly body?: unknown;
      readonly operation?: string;
    }) => {
      if (request.operation === "setNavigationState") {
        return { ok: true, status: 200, body: {}, correlationId: "test" };
      }
      if (request.operation === "selectDirectory") {
        return {
          ok: true,
          status: 200,
          body: { path: options.selectedDirectory ?? null },
          correlationId: "test",
        };
      }
      if (request.path === undefined) throw new Error("Expected an API path");
      const response = await fetch(`http://patchdesk.local${request.path}`, {
        ...(request.method === undefined ? {} : { method: request.method }),
        ...(request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
      });
      return {
        ok: response.ok,
        status: response.status,
        body: await response.json(),
        correlationId: "test",
      };
    },
  );
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: {
      request,
      onNavigate(listener: (destination: "settings") => void) {
        options.captureNavigation?.(listener);
        return () => undefined;
      },
    },
  });
  const fetch = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const path = String(input);
    if (path.includes("v1/reviews?") && options.reviewRecordsPending === true)
      return await new Promise<Response>(() => undefined);
    if (
      path.includes("v1/reviews?") &&
      options.reviewRecordsStatus !== undefined
    )
      return new Response(JSON.stringify({ error: "unavailable" }), {
        status: options.reviewRecordsStatus,
        headers: { "Content-Type": "application/json" },
      });
    if (path.includes("v1/profiles/select") && init?.method === "POST") {
      profileSelectionSucceeded = true;
      return new Response(JSON.stringify({ selected: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (path.includes("v1/watchlist") && init?.method === "DELETE") {
      if (options.removeResponse !== undefined)
        return await options.removeResponse;
      if (options.removeStatus !== undefined)
        return new Response(JSON.stringify({ error: "unavailable" }), {
          status: options.removeStatus,
          headers: { "Content-Type": "application/json" },
        });
    }
    if (
      options.dashboardPending === true &&
      (path.includes("v1/dashboard") || path.includes("v1/inbox"))
    )
      return await new Promise<Response>(() => {});
    if (
      profileSelectionSucceeded &&
      (path.includes("v1/profiles") ||
        path.includes("v1/dashboard") ||
        path.includes("v1/inbox")) &&
      remainingProfileSwitchReloadFailures > 0
    ) {
      remainingProfileSwitchReloadFailures -= 1;
      return new Response(
        JSON.stringify({ error: "profile reload unavailable" }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    if (
      (path.includes("v1/dashboard") || path.includes("v1/inbox")) &&
      remainingDashboardFailures > 0
    ) {
      remainingDashboardFailures -= 1;
      return new Response(JSON.stringify({ error: "unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    const body = path.includes("v1/reviews/load")
      ? (options.loadedWorkbench ?? {})
      : path.includes("v1/reviews?")
        ? { sessions: options.reviewRecords ?? [] }
        : path.includes("v1/watchlist/suggestions")
          ? (options.suggestionsValue ?? [])
          : path.includes("v1/environment")
            ? (options.environmentValue ?? {
                productName: "Patchdesk",
                version: "0.1.0",
                architecture: "arm64",
                distribution: "unsigned_internal",
                git: "ready",
                gh: "ready",
                githubAuth: "ready",
                runtime: "bundled",
                modelConfiguration: "configured",
              })
            : path.includes("v1/diagnostics?")
              ? { events: options.activityEvents ?? [] }
              : path.includes("v1/storage")
                ? { sessions: [], quarantined: [], cacheBytes: 0 }
                : path.includes("v1/profiles") && !path.includes("select")
                  ? [
                      {
                        id: "cfw",
                        label: "CFW",
                        githubHost: "github.com",
                        ghAccount: "pmquan2cfw",
                      },
                      {
                        id: "enterprise",
                        label: "Enterprise",
                        githubHost: "github.example.test",
                        ghAccount: "enterprise-user",
                      },
                    ]
                  : path.includes("v1/inbox")
                      ? inboxFromDashboard(
                          isDashboardFixture(options.dashboardValue)
                            ? options.dashboardValue
                            : dashboard,
                        )
                      : (options.dashboardValue ?? dashboard);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function inboxFromDashboard(value: typeof dashboard): unknown {
  return {
    profile: value.profile,
    inbox: {
      rows: value.dashboard.rows.map((row) => ({
        identity: {
          host: value.profile.githubHost,
          owner: "centraldigital",
          repo: "patchdesk",
          number: row.summary.ref.number,
        },
        title: row.summary.title,
        author: row.summary.author,
        baseBranch: "sit",
        headBranch: "fixture",
        currentHeadSha: "abcdef1234567890abcdef1234567890abcdef12",
        updatedAt: "2026-07-18T00:00:00.000Z",
        isDraft: row.badges.includes("draft"),
        changeStats: { additions: 0, deletions: 0, changedFiles: 0 },
        checks: {
          overall: row.summary.checkSummary?.overall ?? "unknown",
          checks: [],
        },
        reviewState: "none",
        mergeability: "unknown",
        categories: ["needs_review"],
        recommendedAction: { kind: "run_review", label: "Run review" },
        dataFreshness: "fresh",
      })),
      repositories: value.dashboard.repos,
      dataFreshness: "fresh",
    },
  };
}

function isDashboardFixture(value: unknown): value is typeof dashboard {
  return (
    typeof value === "object" &&
    value !== null &&
    "profile" in value &&
    "dashboard" in value
  );
}
