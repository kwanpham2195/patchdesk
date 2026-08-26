// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BusyProvider } from "../../src/renderer/src/hooks/use-busy";
import { InboxFlow } from "../../src/renderer/src/flows/inbox-flow";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import type { Dashboard } from "../../src/renderer/src/renderer-models";

const sha = "a".repeat(40);
const patchHash = "b".repeat(64);
const savedRow = {
  remoteState: "open" as const,
  identity: { host: "github.com", owner: "owner", repo: "repo", number: 1 },
  title: "PR",
  author: "author",
  baseBranch: "main",
  headBranch: "change",
  currentHeadSha: sha,
  isDraft: false,
  updatedAt: "2026-08-13T00:00:00.000Z",
  changeStats: {},
  checks: { overall: "unknown", checks: [] },
  reviewState: "none",
  mergeability: "unknown",
  labels: [],
  latestReview: {
    reviewId: "review-1",
    reviewedHeadSha: sha,
    updatedAt: "2026-08-13T00:00:00.000Z",
    matchesCurrentHead: true,
  },
  categories: ["updated_since_review"],
  recommendedAction: {
    kind: "open_saved_review",
    label: "Open Review",
    reviewId: "review-1",
  },
  dataFreshness: "fresh",
};

const dashboard: Dashboard = {
  profile: {
    id: "profile",
    label: "Profile",
    githubHost: "github.com",
    ghAccount: "fixture",
  },
  dashboard: { repos: [] },
};

const inbox = {
  profile: {
    id: "profile",
    label: "Profile",
    githubHost: "github.com",
    ghAccount: "fixture",
  },
  inbox: {
    rows: [savedRow],
    repositories: [],
    dataFreshness: "fresh",
  },
};

const projection: WorkbenchResponse = {
  state: "review",
  review: { id: "review-1", status: "open" },
  session: {
    id: "session-1",
    key: {
      profileId: "profile",
      host: "github.com",
      owner: "owner",
      repo: "repo",
      prNumber: 1,
      headSha: sha,
    },
  },
  revision: {
    reviewedHeadSha: sha,
    currentHeadSha: sha,
    freshness: "fresh",
    refreshedAt: "2026-08-01T00:00:00.000Z",
    // SAFETY: test fixture narrows a plain hex string to the branded
    // PatchHash type; only WorkbenchResponse's own parser enforces the brand.
    patchHash: patchHash as never,
  },
  fullPatch:
    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  pullRequest: {
    ref: { host: "github.com", owner: "owner", repo: "repo", number: 1 },
    title: "PR",
    author: "author",
    headBranch: "change",
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
};

function renderInboxFlow(ui: ReactNode): ReturnType<typeof render> {
  return render(<BusyProvider>{ui}</BusyProvider>);
}

afterEach(() => {
  cleanup();
  // SAFETY: removes the test-installed `window.patchdesk` stub between
  // tests; the global itself is declared optional elsewhere in the app.
  delete (window as { patchdesk?: unknown }).patchdesk;
  vi.restoreAllMocks();
});

/**
 * The review endpoints a test drove, in order. Scoped to `/v1/reviews/` on
 * purpose: the renderer also flushes `/v1/logs` through the same bridge, and
 * whether it lands mid-test depends on timing, so asserting over every captured
 * request made these cases order-dependent and intermittently red.
 */
function reviewRequestPaths(
  requests: ReadonlyArray<{ readonly path: string }>,
): ReadonlyArray<string> {
  return requests
    .map((request) => request.path)
    .filter((path) => path.startsWith("/v1/reviews/"));
}

describe("InboxFlow saved-review recovery", () => {
  it("falls back to opening by PR identity when the stored review cannot be loaded", async () => {
    const requests: Array<{ readonly path: string; readonly body?: unknown }> =
      [];
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: {
        request: async (input: {
          readonly path: string;
          readonly body?: unknown;
        }) => {
          requests.push(input);
          if (input.path === "/v1/reviews/load") {
            return {
              ok: false,
              status: 404,
              correlationId: "load",
              body: { error: "not_found" },
            };
          }
          if (input.path === "/v1/reviews/open") {
            return {
              ok: true,
              status: 200,
              correlationId: "open",
              body: projection,
            };
          }
          return { ok: true, status: 200, correlationId: input.path, body: {} };
        },
      },
    });
    const onOpenWorkbench = vi.fn();
    renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        dashboard={dashboard}
        // SAFETY: test fixture narrows a partial InboxResponse mock to the stricter renderer-contracts type; only the fields InboxFlow reads are set.
        inbox={inbox as never}
        state="success"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onSettings={vi.fn()}
        onOpenWorkbench={onOpenWorkbench}
      />,
    );
    fireEvent.click(screen.getByRole("option"));
    await waitFor(() => expect(onOpenWorkbench).toHaveBeenCalled());
    expect(reviewRequestPaths(requests)).toEqual([
      "/v1/reviews/load",
      "/v1/reviews/open",
    ]);
    const open = requests.find(
      (request) => request.path === "/v1/reviews/open",
    );
    expect(open?.body).toEqual({
      profileId: "profile",
      host: "github.com",
      owner: "owner",
      repo: "repo",
      number: 1,
    });
  });
});

describe("InboxFlow merged review opening", () => {
  it("sends only merged rows to the terminal-only endpoint", async () => {
    const requests: Array<{ readonly path: string; readonly body?: unknown }> =
      [];
    const mergedRow = {
      ...savedRow,
      remoteState: "merged" as const,
      categories: [],
      recommendedAction: {
        kind: "open_merged_review" as const,
        label: "View merged pull request" as const,
      },
    };
    // SAFETY: InboxFlow reads only the fixture fields supplied by this narrowed response.
    const mergedInbox = {
      ...inbox,
      inbox: { ...inbox.inbox, rows: [mergedRow] },
    } as never;
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: {
        request: async (input: {
          readonly path: string;
          readonly body?: unknown;
        }) => {
          requests.push(input);
          return {
            ok: true,
            status: 200,
            correlationId: input.path,
            body: projection,
          };
        },
      },
    });
    const onOpenWorkbench = vi.fn();
    renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        dashboard={dashboard}
        inbox={mergedInbox}
        state="success"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        inboxState="merged"
        onSettings={vi.fn()}
        onOpenWorkbench={onOpenWorkbench}
      />,
    );

    fireEvent.click(screen.getByRole("option"));

    await waitFor(() => expect(onOpenWorkbench).toHaveBeenCalledOnce());
    expect(reviewRequestPaths(requests)).toEqual(["/v1/reviews/open-merged"]);
  });
});

describe("InboxFlow rate-limited repo outcome", () => {
  it("names the rate limit, shows the resume time, and renders no retry button", () => {
    const resumeAt = "2026-08-01T05:00:00.000Z";
    const rateLimitedDashboard: Dashboard = {
      ...dashboard,
      dashboard: {
        repos: [
          {
            repo: { host: "github.com", owner: "owner", repo: "repo" },
            state: "github_rate_limited",
            resumeAt,
          },
        ],
      },
    };
    renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        dashboard={rateLimitedDashboard}
        // SAFETY: test fixture narrows a partial InboxResponse mock to the stricter renderer-contracts type; only the fields InboxFlow reads are set.
        inbox={inbox as never}
        state="error"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onSettings={vi.fn()}
        onOpenWorkbench={vi.fn()}
      />,
    );
    const formatted = new Date(resumeAt).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    const alert = screen
      .getAllByRole("alert")
      .find((candidate) => candidate.textContent?.includes("owner/repo"));
    expect(alert).not.toBeUndefined();
    expect(alert?.textContent).toContain("GitHub rate-limited this account");
    expect(alert?.textContent).toContain(formatted);
    expect(alert?.querySelector("button")).toBeNull();
  });

  it("shows the graceful fallback copy when no resumeAt is known", () => {
    const rateLimitedDashboard: Dashboard = {
      ...dashboard,
      dashboard: {
        repos: [
          {
            repo: { host: "github.com", owner: "owner", repo: "repo" },
            state: "github_rate_limited",
          },
        ],
      },
    };
    renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        dashboard={rateLimitedDashboard}
        // SAFETY: test fixture narrows a partial InboxResponse mock to the stricter renderer-contracts type; only the fields InboxFlow reads are set.
        inbox={inbox as never}
        state="error"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onSettings={vi.fn()}
        onOpenWorkbench={vi.fn()}
      />,
    );
    const alert = screen
      .getAllByRole("alert")
      .find((candidate) => candidate.textContent?.includes("owner/repo"));
    expect(alert).not.toBeUndefined();
    expect(alert?.textContent).toContain(
      "Patchdesk will resume automatically once the limit clears.",
    );
    expect(alert?.querySelector("button")).toBeNull();
  });
});

describe("InboxFlow forbidden repo outcome (plan 009)", () => {
  it("names the org, states the IP allow list condition, and renders no retry button — the exact live OmisePayments defect", () => {
    const forbiddenDashboard: Dashboard = {
      ...dashboard,
      dashboard: {
        repos: [
          {
            repo: {
              host: "github.com",
              owner: "OmisePayments",
              repo: "dynamic-onboarding-service",
            },
            state: "github_forbidden",
            forbiddenReason: "ip_allow_list",
          },
        ],
      },
    };
    renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        dashboard={forbiddenDashboard}
        // SAFETY: test fixture narrows a partial InboxResponse mock to the stricter renderer-contracts type; only the fields InboxFlow reads are set.
        inbox={inbox as never}
        state="error"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onSettings={vi.fn()}
        onOpenWorkbench={vi.fn()}
      />,
    );
    const alert = screen
      .getAllByRole("alert")
      .find((candidate) =>
        candidate.textContent?.includes(
          "OmisePayments/dynamic-onboarding-service",
        ),
      );
    expect(alert).not.toBeUndefined();
    expect(alert?.textContent).toContain("OmisePayments");
    expect(alert?.textContent).toContain("IP allow list");
    expect(alert?.querySelector("button")).toBeNull();
  });

  it("renders the unknown fallback copy and still shows no retry button when forbiddenReason is absent", () => {
    const forbiddenDashboard: Dashboard = {
      ...dashboard,
      dashboard: {
        repos: [
          {
            repo: { host: "github.com", owner: "owner", repo: "repo" },
            state: "github_forbidden",
          },
        ],
      },
    };
    renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        dashboard={forbiddenDashboard}
        // SAFETY: test fixture narrows a partial InboxResponse mock to the stricter renderer-contracts type; only the fields InboxFlow reads are set.
        inbox={inbox as never}
        state="error"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onSettings={vi.fn()}
        onOpenWorkbench={vi.fn()}
      />,
    );
    const alert = screen
      .getAllByRole("alert")
      .find((candidate) => candidate.textContent?.includes("owner/repo"));
    expect(alert).not.toBeUndefined();
    expect(alert?.textContent).toContain("did not say why");
    expect(alert?.querySelector("button")).toBeNull();
  });
});

describe("InboxFlow settings targeting", () => {
  it("opens the Workspace section from the first-run setup card", () => {
    const onSettings = vi.fn();
    renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        state="empty"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onSettings={onSettings}
        onOpenWorkbench={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open Settings to finish setup" }),
    );
    expect(onSettings).toHaveBeenCalledWith("workspace");
  });

  it("opens the Workspace section from the github_auth error banner", () => {
    const onSettings = vi.fn();
    const authDashboard: Dashboard = {
      ...dashboard,
      dashboard: {
        repos: [
          {
            repo: { host: "github.com", owner: "owner", repo: "repo" },
            state: "github_auth",
          },
        ],
      },
    };
    renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        dashboard={authDashboard}
        // SAFETY: test fixture narrows a partial InboxResponse mock to the stricter renderer-contracts type; only the fields InboxFlow reads are set.
        inbox={inbox as never}
        state="error"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onSettings={onSettings}
        onOpenWorkbench={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open Settings for GitHub access" }),
    );
    expect(onSettings).toHaveBeenCalledWith("workspace");
  });
});

describe("InboxFlow setup checklist", () => {
  function stubPatchdesk(
    handlers: Record<string, { readonly ok: true; readonly body: unknown }>,
  ): void {
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: {
        request: async (input: { readonly path: string }) => {
          const handler = handlers[input.path];
          if (handler === undefined)
            return {
              ok: true,
              status: 200,
              correlationId: input.path,
              body: {},
            };
          return {
            ok: handler.ok,
            status: 200,
            correlationId: input.path,
            body: handler.body,
          };
        },
      },
    });
  }

  it("shows both checks passing when GitHub access is available and local tools are ready", async () => {
    stubPatchdesk({
      "/v1/github/access": { ok: true, body: { state: "available" } },
      "/v1/environment": {
        ok: true,
        body: {
          git: "ready",
          gh: "ready",
          githubAuth: "ready",
          githubAccounts: [
            { host: "github.com", login: "patchdesk", active: true },
          ],
        },
      },
    });
    renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        state="empty"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onSettings={vi.fn()}
        onOpenWorkbench={vi.fn()}
      />,
    );
    expect(await screen.findByText("GitHub access confirmed.")).toBeTruthy();
    expect(await screen.findByText("Git is installed.")).toBeTruthy();
    expect(
      await screen.findByText("GitHub CLI (gh) is installed."),
    ).toBeTruthy();
    expect(
      await screen.findByText("GitHub CLI is authenticated."),
    ).toBeTruthy();
  });

  it("says the GitHub CLI needs installing when gh is missing, not that authentication is required", async () => {
    stubPatchdesk({
      "/v1/github/access": { ok: true, body: { state: "available" } },
      "/v1/environment": {
        ok: true,
        body: {
          git: "ready",
          gh: "missing",
          githubAuth: "unavailable",
          githubAccounts: [],
        },
      },
    });
    renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        state="empty"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onSettings={vi.fn()}
        onOpenWorkbench={vi.fn()}
      />,
    );
    expect(
      await screen.findByText(
        "GitHub CLI (gh) is not installed. Install the GitHub CLI, then re-check.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Not authenticated/)).toBeNull();
  });

  it("tells the user to run gh auth login for the Settings account when authentication is required", async () => {
    stubPatchdesk({
      "/v1/github/access": { ok: true, body: { state: "github_auth" } },
      "/v1/environment": {
        ok: true,
        body: {
          git: "ready",
          gh: "ready",
          githubAuth: "authentication_required",
          githubAccounts: [],
        },
      },
    });
    renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        state="empty"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onSettings={vi.fn()}
        onOpenWorkbench={vi.fn()}
      />,
    );
    const guidance = await screen.findAllByText(
      (_, element) =>
        element?.textContent ===
        "Not authenticated. Run gh auth login for the GitHub account entered in Settings, under Workspace, then re-check.",
    );
    // One from the "Confirm GitHub access" check, one from "Check local tools" —
    // each fetches its own state from a different endpoint.
    expect(guidance.length).toBe(2);
  });
});

describe("InboxFlow bootstrap outcome open-error alert", () => {
  it("keeps showing a stale 'Could not open review' error after the active profile clears and its reload fails", async () => {
    const runReviewRow = {
      ...savedRow,
      recommendedAction: {
        kind: "run_review" as const,
        label: "Run review" as const,
      },
    };
    // SAFETY: InboxFlow reads only the fixture fields supplied by this narrowed response.
    const runReviewInbox = {
      ...inbox,
      inbox: { ...inbox.inbox, rows: [runReviewRow] },
    } as never;
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: {
        request: async (input: { readonly path: string }) => {
          if (input.path === "/v1/reviews/open")
            return {
              ok: false,
              status: 500,
              correlationId: "open-fail",
              body: { error: "unavailable" },
            };
          return { ok: true, status: 200, correlationId: input.path, body: {} };
        },
      },
    });

    const { rerender } = renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        dashboard={dashboard}
        inbox={runReviewInbox}
        state="success"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onSettings={vi.fn()}
        onOpenWorkbench={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("option"));

    const expectedCopy =
      "Could not prepare owner/repo#1. The requested service is currently unavailable.";
    // Confirms the error landed in `InboxFlow`'s local `openError` state
    // while `InboxScreen` (dashboard/inbox still defined) is what renders it.
    await screen.findByText(expectedCopy);

    // Simulates the profile switch that follows in the real app: a `cleared`
    // dispatch clears `dashboard`/`inbox` and forces `screen: "loading"`,
    // then a `failed` dispatch (the new profile's `loadWorkspace()` throwing)
    // moves `screen` off `loading` without ever touching `openError` — it is
    // `InboxFlow`-local state that survives because `InboxFlow` renders
    // unkeyed at a stable position across this rerender.
    rerender(
      <BusyProvider>
        <InboxFlow
          destination="dashboard"
          state="error"
          refreshStatus="Current"
          onRefresh={vi.fn()}
          onSettings={vi.fn()}
          onOpenWorkbench={vi.fn()}
        />
      </BusyProvider>,
    );

    expect(await screen.findByText("First run")).toBeTruthy();
    expect(screen.getByText("Could not open review")).toBeTruthy();
    expect(screen.getByText(expectedCopy)).toBeTruthy();
  });
});
