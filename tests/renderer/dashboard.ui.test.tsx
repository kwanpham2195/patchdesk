// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
      {
        repo: {
          host: "github.com",
          owner: "centraldigital",
          repo: "archived",
          archived: true,
        },
        state: "archived",
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
  it("disables direct PR entry until the active profile loads", () => {
    installApi({ dashboardPending: true });
    render(<App />);

    expect(
      screen
        .getByRole("button", { name: "Preview pull request" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("loads profile, watchlist, rows, and archived outcome from authenticated API responses", async () => {
    installApi();
    render(<App />);
    expect((await screen.findAllByText(/Real dashboard row/)).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("centraldigital/patchdesk").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/Archived repository/)).toBeTruthy();
    expect(screen.queryByText(/Submit review|Merge pull request/i)).toBeNull();
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

  it("explains when Discover finds no new repositories", async () => {
    installApi({ suggestionsValue: [] });
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Discover" }));

    expect(
      await screen.findByText(
        "No new repositories found in the configured workspace roots.",
      ),
    ).toBeTruthy();
  });

  it("recovers a failed dashboard load through the visible retry action", async () => {
    const fetch = installApi({ dashboardFailures: 1 });
    const user = userEvent.setup();
    render(<App />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Dashboard could not be loaded",
    );
    await user.click(screen.getByRole("button", { name: "Retry dashboard" }));
    expect((await screen.findAllByText(/Real dashboard row/)).length).toBeGreaterThan(0);
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

  it("uses the server preview target before selecting and opening a direct PR", async () => {
    const fetch = installApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.type(
      screen.getByLabelText("Pull request reference"),
      "octo/service#3",
    );
    const previewButton = screen.getByRole("button", {
      name: "Preview pull request",
    });
    await user.click(previewButton);
    expect(
      await screen.findByRole("dialog", { name: "Switch workspace profile" }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Keep current profile" }),
    );
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "Switch workspace profile" }),
    ).toBeNull();
    expect(document.activeElement).toBe(previewButton);

    await user.click(previewButton);
    await user.click(
      screen.getByRole("button", {
        name: "Switch profile and open pull request",
      }),
    );
    expect(
      fetch.mock.calls.some(
        ([input, init]) =>
          String(input).includes("v1/profiles/select") &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(true);
  });

  it("opens a normal direct entry immediately and lets users keep their current profile", async () => {
    const fetch = installApi({ confirmationRequired: false });
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.type(
      screen.getByLabelText("Pull request reference"),
      "octo/service#3",
    );
    await user.click(
      screen.getByRole("button", { name: "Preview pull request" }),
    );
    expect(
      await screen.findByText("Could not prepare octo/service#3."),
    ).toBeTruthy();
    expect(
      fetch.mock.calls.some(([input]) =>
        String(input).includes("v1/profiles/select"),
      ),
    ).toBe(false);
  });

  it("refreshes only the selected watchlist repository", async () => {
    const fetch = installApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);

    await user.click(
      screen.getByRole("button", { name: "Refresh centraldigital/patchdesk" }),
    );

    expect(
      fetch.mock.calls.some(
        ([input, init]) =>
          String(input).includes("v1/dashboard/refresh/repository") &&
          (init as RequestInit | undefined)?.method === "POST" &&
          String((init as RequestInit).body).includes("patchdesk"),
      ),
    ).toBe(true);
  });

  it("uses the native directory picker before saving a repository path", async () => {
    const fetch = installApi({ selectedDirectory: "/workspace/patchdesk" });
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(
      screen.getByRole("button", {
        name: "Choose folder for centraldigital/patchdesk",
      }),
    );
    expect(
      (
        screen.getByLabelText(
          "Local path for centraldigital/patchdesk",
        ) as HTMLInputElement
      ).value,
    ).toBe("/workspace/patchdesk");
    await user.click(
      screen.getByRole("button", {
        name: "Save path for centraldigital/patchdesk",
      }),
    );

    expect(
      fetch.mock.calls.some(
        ([input, init]) =>
          String(input).includes("v1/watchlist/path") &&
          (init as RequestInit | undefined)?.method === "PATCH" &&
          String((init as RequestInit).body).includes("/workspace/patchdesk"),
      ),
    ).toBe(true);
  });

  it("announces native directory-picker cancellation without changing the saved path", async () => {
    installApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const path = screen.getByLabelText(
      "Local path for centraldigital/patchdesk",
    ) as HTMLInputElement;
    expect(path.value).toBe("");
    await user.click(
      screen.getByRole("button", {
        name: "Choose folder for centraldigital/patchdesk",
      }),
    );

    expect(screen.getByRole("status").textContent).toContain(
      "Folder selection cancelled. The existing repository path was not changed.",
    );
    expect(path.value).toBe("");
  });

  it("turns missing environment prerequisites into actionable setup guidance", async () => {
    installApi({
      environmentValue: {
        productName: "Patchdesk",
        version: "0.1.0",
        architecture: "arm64",
        distribution: "unsigned_internal",
        git: "missing",
        gh: "missing",
        githubAuth: "missing",
        runtime: "bundled",
        modelConfiguration: "missing",
      },
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.click(screen.getByRole("button", { name: "Settings" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Setup action required");
    expect(alert.textContent).toContain("Git and GitHub CLI must be available");
    expect(alert.textContent).toContain(
      "Authenticate the configured GitHub CLI account",
    );
    expect(alert.textContent).toContain(
      "Configure a model provider before running a review",
    );
    expect(
      screen.getByRole("button", { name: "Recheck environment" }),
    ).toBeTruthy();
  });

  it("confirms watchlist removal and explains that history remains local", async () => {
    const fetch = installApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(
      screen.getByRole("button", { name: "Remove centraldigital/patchdesk" }),
    );
    expect(
      screen.getByRole("alertdialog", {
        name: "Remove centraldigital/patchdesk from the watchlist?",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("Saved review history and drafts remain on this Mac."),
    ).toBeTruthy();
    expect(
      fetch.mock.calls.some(
        ([input, init]) =>
          String(input).includes("v1/watchlist") &&
          (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "Confirm removal" }));
    expect(
      fetch.mock.calls.some(
        ([input, init]) =>
          String(input).includes("v1/watchlist") &&
          (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(true);
  });

  it("keeps removal open and prevents duplicate requests while deletion is pending", async () => {
    let resolveRemoval: ((response: Response) => void) | undefined;
    const removeResponse = new Promise<Response>((resolve) => {
      resolveRemoval = resolve;
    });
    const fetch = installApi({ removeResponse });
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(
      screen.getByRole("button", { name: "Remove centraldigital/patchdesk" }),
    );
    const confirm = screen.getByRole("button", { name: "Confirm removal" });
    await user.click(confirm);

    expect(confirm.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("alertdialog", {
        name: "Remove centraldigital/patchdesk from the watchlist?",
      }),
    ).toBeTruthy();
    expect(
      fetch.mock.calls.filter(
        ([input, init]) =>
          String(input).includes("v1/watchlist") &&
          (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toHaveLength(1);

    resolveRemoval?.(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("keeps the repository and explains a failed removal", async () => {
    installApi({ removeStatus: 500 });
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(
      screen.getByRole("button", { name: "Remove centraldigital/patchdesk" }),
    );
    await user.click(screen.getByRole("button", { name: "Confirm removal" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The requested service is currently unavailable.",
    );
    expect(
      screen.getAllByText("centraldigital/patchdesk").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("alertdialog", {
        name: "Remove centraldigital/patchdesk from the watchlist?",
      }),
    ).toBeTruthy();
  });

  it("shows product version, architecture, and internal distribution status in Settings", async () => {
    const user = userEvent.setup();
    installApi();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      await screen.findByRole("heading", { name: "About Patchdesk" }),
    ).toBeTruthy();
    expect(screen.getByText("Version 0.1.0")).toBeTruthy();
    expect(screen.getByText("arm64")).toBeTruthy();
    expect(screen.getByText("Unsigned internal build")).toBeTruthy();
    expect(screen.queryByText("Setup action required")).toBeNull();
  });

  it("reopens the exact persisted history session without starting another review", async () => {
    const fetch = installApi({
      reviewRecords: [
        {
          id: "session-123",
          profileId: "cfw",
          owner: "centraldigital",
          repo: "patchdesk",
          prNumber: 42,
          title: "Stored review title",
          state: "ReviewCompleted",
          draftState: "LocalDraft",
          updatedAt: "2026-07-17T12:00:00.000Z",
        },
      ],
      loadedWorkbench: completedWorkbench,
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.click(screen.getByRole("button", { name: "History" }));
    expect(
      await screen.findByRole("heading", {
        name: /centraldigital\/patchdesk#42 · Stored review title/,
      }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open saved review" }));

    expect(
      await screen.findByRole("heading", { name: "Stored review title" }),
    ).toBeTruthy();
    expect(
      fetch.mock.calls.some(
        ([input, init]) =>
          String(input).includes("v1/reviews/load") &&
          (init as RequestInit | undefined)?.method === "POST" &&
          String((init as RequestInit).body).includes(
            '"sessionId":"session-123"',
          ),
      ),
    ).toBe(true);
    expect(
      fetch.mock.calls.some(([input]) =>
        String(input).includes("v1/runs/review-pr"),
      ),
    ).toBe(false);
  });

  it("shows a dedicated loading state while local review records are read", async () => {
    installApi({ reviewRecordsPending: true });
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.click(screen.getByRole("button", { name: "History" }));
    expect(
      await screen.findByRole("status", {
        name: "Loading local review records",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("No matching local review records.")).toBeNull();
  });

  it("keeps valid history visible when one stored record is malformed", async () => {
    installApi({
      reviewRecords: [
        {
          id: "session-123",
          profileId: "cfw",
          owner: "centraldigital",
          repo: "patchdesk",
          prNumber: 42,
          title: "Stored review title",
          state: "ReviewCompleted",
          updatedAt: "2026-07-17T12:00:00.000Z",
        },
        { id: "broken-record" },
      ],
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.click(screen.getByRole("button", { name: "History" }));
    expect(
      await screen.findByRole("heading", { name: /Stored review title/ }),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "1 local review record could not be read",
    );
  });

  it("shows an actionable history error when local records cannot be loaded", async () => {
    installApi({ reviewRecordsStatus: 500 });
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText(/Real dashboard row/);
    await user.click(screen.getByRole("button", { name: "History" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Local review records could not be loaded",
    );
    expect(
      screen.getByRole("button", {
        name: "Retry loading local review records",
      }),
    ).toBeTruthy();
  });

  it("restores an exact persisted workbench destination after restart", async () => {
    window.localStorage.setItem(
      "patchdesk.destination",
      "workbench:session-123",
    );
    const fetch = installApi({ loadedWorkbench: completedWorkbench });
    const user = userEvent.setup();
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Stored review title" }),
    ).toBeTruthy();
    expect(
      fetch.mock.calls.some(
        ([input, init]) =>
          String(input).includes("v1/reviews/load") &&
          String((init as RequestInit | undefined)?.body).includes(
            '"sessionId":"session-123"',
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

  it("uses one guarded transition before leaving an unsaved review draft", async () => {
    window.localStorage.setItem(
      "patchdesk.destination",
      "workbench:session-123",
    );
    installApi({ loadedWorkbench: completedWorkbench });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Stored review title" });
    await user.click(screen.getByRole("button", { name: "Edit review draft" }));
    fireEvent.change(screen.getByLabelText("Review summary"), {
      target: { value: "Unsaved local edit" },
    });
    await waitFor(() =>
      expect(window.patchdesk.request).toHaveBeenCalledWith({
        operation: "setNavigationState",
        state: "dirty_draft",
      }),
    );

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(
      screen.queryByRole("dialog", { name: "Navigate Patchdesk" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "History", hidden: true }),
    );
    expect(
      screen.getByRole("alertdialog", {
        name: "Leave with an unsaved review draft?",
      }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Stay on this review" }),
    );
    expect(
      screen.getByRole("heading", {
        name: "Stored review title",
        hidden: true,
      }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "History", hidden: true }),
    );
    await user.click(
      screen.getByRole("button", { name: "Discard changes and leave" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Review history" }),
    ).toBeTruthy();
    expect(window.patchdesk.request).toHaveBeenCalledWith({
      operation: "setNavigationState",
      state: "clear",
    });
    expect(window.localStorage.getItem("patchdesk.destination")).toBe(
      "history",
    );
  });

  it("routes the native Settings command through the dirty-draft guard", async () => {
    window.localStorage.setItem(
      "patchdesk.destination",
      "workbench:session-123",
    );
    let nativeNavigate: ((destination: "settings") => void) | undefined;
    installApi({
      loadedWorkbench: completedWorkbench,
      captureNavigation(listener) {
        nativeNavigate = listener;
      },
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Stored review title" });
    await user.click(screen.getByRole("button", { name: "Edit review draft" }));
    fireEvent.change(screen.getByLabelText("Review summary"), {
      target: { value: "Unsaved native navigation edit" },
    });

    nativeNavigate?.("settings");
    expect(
      await screen.findByRole("alertdialog", {
        name: "Leave with an unsaved review draft?",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
  });
});

const completedWorkbench = {
  state: "completed",
  session: {
    id: "session-123",
    key: {
      profileId: "cfw",
      owner: "centraldigital",
      repo: "patchdesk",
      prNumber: 42,
      headSha: "abcdef1234567890abcdef1234567890abcdef12",
    },
  },
  result: {
    changeSummary: "Stored review",
    verdict: "comment",
    summary: "Stored local result",
    findings: [],
    validationPlan: [],
    assumptions: [],
  },
  draft: {
    updatedAt: "2026-07-17T12:00:00.000Z",
    summaryBody: "Stored draft",
    comments: [],
    state: { _tag: "LocalDraft" },
  },
  comments: { threads: [] },
  checks: { overall: "passing", checks: [] },
  history: [],
  reviewScope: { kind: "full" },
  comparisonAvailability: "not_requested",
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
  reviewedHeadSha: "abcdef1234567890abcdef1234567890abcdef12",
  currentHeadSha: "abcdef1234567890abcdef1234567890abcdef12",
  freshness: "fresh",
  refreshedAt: "2026-07-17T12:00:00.000Z",
  mergeReadiness: { _tag: "Ready", blockers: [], warnings: [] },
} as const;

function installApi(
  options: {
    readonly confirmationRequired?: boolean;
    readonly dashboardPending?: boolean;
    readonly dashboardFailures?: number;
    readonly dashboardValue?: unknown;
    readonly suggestionsValue?: unknown;
    readonly environmentValue?: unknown;
    readonly selectedDirectory?: string;
    readonly removeResponse?: Promise<Response>;
    readonly removeStatus?: number;
    readonly reviewRecords?: ReadonlyArray<unknown>;
    readonly reviewRecordsPending?: boolean;
    readonly reviewRecordsStatus?: number;
    readonly loadedWorkbench?: unknown;
    readonly captureNavigation?: (
      listener: (destination: "settings") => void,
    ) => void;
  } = {},
): ReturnType<typeof vi.fn> {
  let remainingDashboardFailures = options.dashboardFailures ?? 0;
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
    if (path.includes("v1/watchlist") && init?.method === "DELETE") {
      if (options.removeResponse !== undefined)
        return await options.removeResponse;
      if (options.removeStatus !== undefined)
        return new Response(JSON.stringify({ error: "unavailable" }), {
          status: options.removeStatus,
          headers: { "Content-Type": "application/json" },
        });
    }
    if (options.dashboardPending === true && (path.includes("v1/dashboard") || path.includes("v1/inbox")))
      return await new Promise<Response>(() => {});
    if ((path.includes("v1/dashboard") || path.includes("v1/inbox")) && remainingDashboardFailures > 0) {
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
            : path.includes("direct-entry")
              ? {
                  pr: { owner: "octo", repo: "service", number: 3 },
                  confirmation: {
                    required: options.confirmationRequired ?? true,
                    targetProfileId: "enterprise",
                  },
                }
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
        checks: { overall: row.summary.checkSummary?.overall ?? "unknown", checks: [] },
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
