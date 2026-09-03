// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BusyProvider } from "../../src/renderer/src/hooks/use-busy";
import { InboxFlow } from "../../src/renderer/src/flows/inbox-flow";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import type { Dashboard } from "../../src/renderer/src/renderer-models";
import {
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";
import {
  asJsonBody,
  dashboard,
  deferred,
  inbox,
  openErrorAlert,
  openRowTitle,
  projection,
  renderInboxFlow,
  reviewRequestPaths,
  rowBusy,
  savedRow,
  sentRequests,
  SHARED_INBOX_ROUTES,
} from "./inbox-flow-fixtures";
import type { RawJsonValue } from "../../src/domain/json";

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
  vi.restoreAllMocks();
});

describe("InboxFlow saved-review recovery", () => {
  it("falls back to opening by PR identity when the stored review cannot be loaded", async () => {
    desktop = installDesktopDouble({
      ...SHARED_INBOX_ROUTES,
      "/v1/reviews/load": () => ({
        ok: false,
        status: 404,
        correlationId: "load",
        body: { error: "not_found" },
      }),
      "/v1/reviews/open": () => ({
        ok: true,
        status: 200,
        correlationId: "open",
        body: asJsonBody(projection),
      }),
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
    // The inbox chrome the first-run flow replaces; see "finishes setup in
    // place" below, which asserts its absence during setup.
    expect(screen.getByRole("button", { name: "More filters" })).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Pull request state" }),
    ).toBeTruthy();

    openRowTitle();
    await waitFor(() => expect(onOpenWorkbench).toHaveBeenCalled());
    expect(reviewRequestPaths(desktop)).toEqual([
      "/v1/reviews/load",
      "/v1/reviews/open",
    ]);
    const open = sentRequests(desktop).find(
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
    const mergedRow = {
      ...savedRow,
      remoteState: "merged" as const,
      categories: [],
      recommendedAction: { kind: "open_merged_review" as const },
    };
    // SAFETY: InboxFlow reads only the fixture fields supplied by this narrowed response.
    const mergedInbox = {
      ...inbox,
      inbox: { ...inbox.inbox, rows: [mergedRow] },
    } as never;
    desktop = installDesktopDouble({
      ...SHARED_INBOX_ROUTES,
      "/v1/reviews/open-merged": () => success(asJsonBody(projection)),
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

    openRowTitle();

    await waitFor(() => expect(onOpenWorkbench).toHaveBeenCalledOnce());
    expect(reviewRequestPaths(desktop)).toEqual(["/v1/reviews/open-merged"]);
  });
});

const RATE_LIMIT_RESUME_AT = "2026-08-01T05:00:00.000Z";

describe("InboxFlow unreadable repo outcome", () => {
  // The copy each of these outcomes carries is the rule
  // `inbox-read-failure-copy.test.ts` owns, for every reason and both
  // resume-time cases. Two things it cannot see are left here: that this
  // alert passes the outcome's own reason and resume time to that rule, and
  // the render rule ADRs 0023 and 0024 set — no retry affordance is ever
  // offered for a read that asking again cannot fix. One row per outcome tag
  // is enough for the second: the retry affordance branches on the tag
  // alone, never on `forbiddenReason` or `resumeAt`.
  it.each([
    [
      "a forbidden read",
      { state: "github_forbidden", forbiddenReason: "ip_allow_list" },
      "IP allow list",
    ],
    [
      "a rate-limited read",
      { state: "github_rate_limited", resumeAt: RATE_LIMIT_RESUME_AT },
      // The formatted resume time, not the shared sentence: only this half
      // proves the outcome's own `resumeAt` reached the copy rule.
      new Date(RATE_LIMIT_RESUME_AT).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }),
    ],
  ] satisfies ReadonlyArray<
    [string, Omit<Dashboard["dashboard"]["repos"][number], "repo">, string]
  >)("explains %s and offers no retry", (_name, outcome, fragment) => {
    renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        dashboard={{
          ...dashboard,
          dashboard: {
            repos: [
              {
                repo: { host: "github.com", owner: "owner", repo: "repo" },
                ...outcome,
              },
            ],
          },
        }}
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
    expect(alert?.textContent).toContain(fragment);
    expect(alert?.querySelector("button")).toBeNull();
  });
});

describe("InboxFlow settings targeting", () => {
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

describe("InboxFlow first run", () => {
  function stubPatchdesk(
    handlers: Readonly<Record<string, RawJsonValue>>,
  ): void {
    desktop = installDesktopDouble({
      ...SHARED_INBOX_ROUTES,
      ...Object.fromEntries(
        Object.entries(handlers).map(([path, body]) => [
          path,
          () => success(body),
        ]),
      ),
    });
  }

  const READY_ENVIRONMENT: RawJsonValue = {
    git: "ready",
    gh: "ready",
    githubAuth: "ready",
    // The same account the `dashboard` fixture's profile carries, so the
    // panel reports the resolved account instead of an unauthenticated one.
    githubAccounts: [{ host: "github.com", login: "fixture", active: true }],
  };

  it("finishes setup in place: the account step, then the folders and repositories step", async () => {
    stubPatchdesk({
      "/v1/environment": READY_ENVIRONMENT,
      "/v1/watchlist/suggestions": [],
    });
    renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        dashboard={dashboard}
        // SAFETY: test fixture narrows a partial InboxResponse mock to the stricter renderer-contracts type; only the fields InboxFlow reads are set.
        inbox={{ ...inbox, inbox: { ...inbox.inbox, rows: [] } } as never}
        state="empty"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onSettings={vi.fn()}
        onOpenWorkbench={vi.fn()}
      />,
    );
    const flow = screen.getByRole("region", { name: "Set up your workspace" });
    expect(
      within(flow).getByRole("region", { name: "1. Reviewing as" }),
    ).toBeTruthy();
    // The fixture profile already carries an account, so the folders step is
    // open rather than waiting behind it.
    expect(
      within(flow).getByRole("region", {
        name: "2. Folders and repositories",
      }),
    ).toBeTruthy();
    expect(await within(flow).findByLabelText("Folder 1")).toBeTruthy();
    expect(screen.queryByText("Choose an account first.")).toBeNull();
    // The flow replaces the screen rather than sitting above it: none of the
    // inbox chrome is on screen for a workspace with nothing to list yet.
    // The counterpart assertion — that this toolbar IS there once the inbox
    // loads — is in "falls back to opening by PR identity" above.
    expect(screen.queryByRole("button", { name: "More filters" })).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Pull request state" }),
    ).toBeNull();
    expect(screen.queryByRole("listbox", { name: "Pull requests" })).toBeNull();
  });

  it("reports a missing Git only when the environment probe says so", async () => {
    const missingGit =
      "Git is not installed. Install Git for this platform, then re-check.";
    stubPatchdesk({
      "/v1/environment": READY_ENVIRONMENT,
      "/v1/watchlist/suggestions": [],
    });
    renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        dashboard={dashboard}
        // SAFETY: test fixture narrows a partial InboxResponse mock to the stricter renderer-contracts type; only the fields InboxFlow reads are set.
        inbox={{ ...inbox, inbox: { ...inbox.inbox, rows: [] } } as never}
        state="empty"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onSettings={vi.fn()}
        onOpenWorkbench={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("region", { name: "Set up your workspace" }),
    ).toBeTruthy();
    // The disclosure only renders once the probe has reported an account, so
    // waiting for it is waiting for the environment reading the Git line
    // would come from.
    expect(
      await screen.findByRole("button", { name: "Use a different account" }),
    ).toBeTruthy();
    expect(screen.queryByText(missingGit)).toBeNull();

    cleanup();
    desktop?.restore();
    stubPatchdesk({
      "/v1/environment": { ...READY_ENVIRONMENT, git: "missing" },
      "/v1/watchlist/suggestions": [],
    });
    renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        dashboard={dashboard}
        // SAFETY: test fixture narrows a partial InboxResponse mock to the stricter renderer-contracts type; only the fields InboxFlow reads are set.
        inbox={{ ...inbox, inbox: { ...inbox.inbox, rows: [] } } as never}
        state="empty"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onSettings={vi.fn()}
        onOpenWorkbench={vi.fn()}
      />,
    );
    const setup = await screen.findByRole("region", {
      name: "Set up your workspace",
    });
    expect(await within(setup).findByRole("status")).toBeTruthy();
  });
});

describe("InboxFlow bootstrap outcome open-error alert", () => {
  it("clears a stale 'Could not open review' error after the active profile changes or clears", async () => {
    const runReviewRow = {
      ...savedRow,
      recommendedAction: { kind: "run_review" as const },
    };
    // SAFETY: InboxFlow reads only the fixture fields supplied by this narrowed response.
    const runReviewInbox = {
      ...inbox,
      inbox: { ...inbox.inbox, rows: [runReviewRow] },
    } as never;
    desktop = installDesktopDouble({
      ...SHARED_INBOX_ROUTES,
      "/v1/reviews/open": () => ({
        ok: false,
        status: 500,
        correlationId: "open-fail",
        body: { error: "unavailable" },
      }),
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

    openRowTitle();

    // The original profile still renders its row-opening error. The alert,
    // rather than the repeated title text, is the observable contract.
    const raisedAlert = await waitFor(() => {
      const alert = openErrorAlert();
      if (alert === undefined) throw new Error("Expected an opening error");
      return alert;
    });
    expect(raisedAlert).toBeTruthy();

    const changedDashboard = {
      ...dashboard,
      profile: { ...dashboard.profile, id: "changed-profile" },
    };
    const changedInbox = {
      ...inbox,
      profile: { ...inbox.profile, id: "changed-profile" },
    };
    rerender(
      <BusyProvider>
        <InboxFlow
          destination="dashboard"
          dashboard={changedDashboard}
          // SAFETY: InboxFlow reads only the fixture fields supplied by this narrowed response.
          inbox={changedInbox as never}
          state="success"
          refreshStatus="Current"
          onRefresh={vi.fn()}
          onSettings={vi.fn()}
          onOpenWorkbench={vi.fn()}
        />
      </BusyProvider>,
    );

    // A new profile owns a new Pull requests scope, so it cannot inherit the
    // former profile's opening failure.
    await waitFor(() => expect(openErrorAlert()).toBeUndefined());

    // A `cleared` dispatch then clears `dashboard`/`inbox` and forces
    // `screen: "loading"`; a failed reload moves the screen off loading while
    // the local opening state still exists. First run must not inherit it.
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

    expect(
      await screen.findByRole("heading", { name: "Pull requests" }),
    ).toBeTruthy();
    expect(openErrorAlert()).toBeUndefined();
  });
});
describe("InboxFlow stored-review error ownership", () => {
  it("restores profile A's saved-review error after a profile B opening attempt", async () => {
    const profileBOpen = deferred<ReturnType<typeof success>>();
    desktop = installDesktopDouble({
      ...SHARED_INBOX_ROUTES,
      "/v1/reviews/load": () => ({
        ok: false,
        status: 500,
        correlationId: "saved-review-fail",
        body: { error: "unavailable" },
      }),
      "/v1/reviews/open": () => profileBOpen.promise,
    });
    const runReviewRow = {
      ...savedRow,
      latestReview: undefined,
      recommendedAction: { kind: "run_review" as const },
    };
    const profileB = {
      ...dashboard,
      profile: { ...dashboard.profile, id: "profile-b" },
    };
    const profileBInbox = {
      ...inbox,
      profile: { ...inbox.profile, id: "profile-b" },
      inbox: { ...inbox.inbox, rows: [runReviewRow] },
    };
    const { rerender } = renderInboxFlow(
      <InboxFlow
        destination="workbench"
        reviewId="saved-review"
        dashboard={dashboard}
        // SAFETY: InboxFlow reads only the fixture fields supplied here.
        inbox={inbox as never}
        state="success"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onSettings={vi.fn()}
        onOpenWorkbench={vi.fn()}
      />,
    );

    await waitFor(() => expect(openErrorAlert()).toBeDefined());

    rerender(
      <BusyProvider>
        <InboxFlow
          destination="dashboard"
          dashboard={profileB}
          // SAFETY: InboxFlow reads only the fixture fields supplied here.
          inbox={profileBInbox as never}
          state="success"
          refreshStatus="Current"
          onRefresh={vi.fn()}
          onSettings={vi.fn()}
          onOpenWorkbench={vi.fn()}
        />
      </BusyProvider>,
    );
    openRowTitle();
    expect(reviewRequestPaths(desktop)).toEqual([
      "/v1/reviews/load",
      "/v1/reviews/open",
    ]);

    rerender(
      <BusyProvider>
        <InboxFlow
          destination="dashboard"
          dashboard={dashboard}
          // SAFETY: InboxFlow reads only the fixture fields supplied here.
          inbox={inbox as never}
          state="success"
          refreshStatus="Current"
          onRefresh={vi.fn()}
          onSettings={vi.fn()}
          onOpenWorkbench={vi.fn()}
        />
      </BusyProvider>,
    );

    expect(openErrorAlert()).toBeDefined();
    expect(rowBusy(screen.getByRole("option"))).toBe(false);
  });
});

describe("InboxFlow profile-scoped Review opening", () => {
  it("admits the same pull request separately for a new profile and ignores the old profile's late result", async () => {
    const first = deferred<ReturnType<typeof success>>();
    const second = deferred<ReturnType<typeof success>>();
    let requestCount = 0;
    desktop = installDesktopDouble({
      ...SHARED_INBOX_ROUTES,
      "/v1/reviews/open": () => {
        requestCount += 1;
        return requestCount === 1 ? first.promise : second.promise;
      },
    });
    const runReviewRow = {
      ...savedRow,
      latestReview: undefined,
      recommendedAction: { kind: "run_review" as const },
    };
    // SAFETY: InboxFlow reads only the fixture fields supplied by this narrowed response.
    const runReviewInbox = {
      ...inbox,
      inbox: { ...inbox.inbox, rows: [runReviewRow] },
    } as never;
    const opened: WorkbenchResponse[] = [];
    const { rerender } = renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        dashboard={dashboard}
        inbox={runReviewInbox}
        state="success"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onSettings={vi.fn()}
        onOpenWorkbench={(value) => opened.push(value)}
      />,
    );

    openRowTitle();
    expect(reviewRequestPaths(desktop)).toEqual(["/v1/reviews/open"]);

    const changedDashboard = {
      ...dashboard,
      profile: { ...dashboard.profile, id: "changed-profile" },
    };
    const changedInbox = {
      ...inbox,
      profile: { ...inbox.profile, id: "changed-profile" },
      inbox: { ...inbox.inbox, rows: [runReviewRow] },
    };
    rerender(
      <BusyProvider>
        <InboxFlow
          destination="dashboard"
          dashboard={changedDashboard}
          // SAFETY: InboxFlow reads only the fixture fields supplied by this narrowed response.
          inbox={changedInbox as never}
          state="success"
          refreshStatus="Current"
          onRefresh={vi.fn()}
          onSettings={vi.fn()}
          onOpenWorkbench={(value) => opened.push(value)}
        />
      </BusyProvider>,
    );

    const changedProfileRow = screen.getByRole("option");
    expect(rowBusy(changedProfileRow)).toBe(false);
    openRowTitle(changedProfileRow);
    expect(reviewRequestPaths(desktop)).toEqual([
      "/v1/reviews/open",
      "/v1/reviews/open",
    ]);
    expect(
      sentRequests(desktop)
        .filter((request) => request.path === "/v1/reviews/open")
        .map((request) => request.body),
    ).toEqual([
      expect.objectContaining({ profileId: dashboard.profile.id }),
      expect.objectContaining({ profileId: "changed-profile" }),
    ]);

    first.resolve(success(asJsonBody(projection)));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(opened).toEqual([]);

    second.resolve(
      success(
        asJsonBody({
          ...projection,
          review: { ...projection.review, id: "changed-review" },
        }),
      ),
    );
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]?.review.id).toBe("changed-review");
  });
});

describe("InboxFlow Review opening ownership", () => {
  it("admits one same-tick request for the same row across every entry point", async () => {
    const load = deferred<ReturnType<typeof success>>();
    desktop = installDesktopDouble({
      ...SHARED_INBOX_ROUTES,
      "/v1/reviews/load": () => load.promise,
    });
    const opened: WorkbenchResponse[] = [];
    renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        dashboard={dashboard}
        // SAFETY: InboxFlow reads only the fixture fields supplied here.
        inbox={inbox as never}
        state="success"
        refreshStatus="Current"
        onRefresh={() => undefined}
        onSettings={() => undefined}
        onOpenWorkbench={(value) => opened.push(value)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    openRowTitle();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    window.dispatchEvent(new Event("patchdesk:inbox-action"));

    expect(reviewRequestPaths(desktop)).toEqual(["/v1/reviews/load"]);
    const openingRow = screen.getByRole("option");
    expect(rowBusy(openingRow)).toBe(true);
    expect(
      within(openingRow).getByRole("status", { name: "Loading" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Opening…/ }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("progressbar", { name: "Opening Review…" }),
    ).toBeTruthy();

    load.resolve(success(asJsonBody(projection)));
    await waitFor(() => expect(opened).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
  });

  it("keeps unrelated rows interactive and clears concurrent openings by owning key under reverse settlement", async () => {
    const first = deferred<ReturnType<typeof success>>();
    const second = deferred<ReturnType<typeof success>>();
    let requestNumber = 0;
    desktop = installDesktopDouble({
      ...SHARED_INBOX_ROUTES,
      "/v1/reviews/open": () => {
        requestNumber += 1;
        return requestNumber === 1 ? first.promise : second.promise;
      },
    });
    const firstRow = {
      ...savedRow,
      latestReview: undefined,
      recommendedAction: { kind: "run_review" },
    };
    const secondRow = {
      ...firstRow,
      identity: { ...firstRow.identity, number: 2 },
      title: "Second PR",
    };
    const concurrentInbox = {
      ...inbox,
      inbox: { ...inbox.inbox, rows: [firstRow, secondRow] },
    };
    renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        dashboard={dashboard}
        // SAFETY: InboxFlow reads only the fixture fields supplied here.
        inbox={concurrentInbox as never}
        state="success"
        refreshStatus="Current"
        onRefresh={() => undefined}
        onSettings={() => undefined}
        onOpenWorkbench={() => undefined}
      />,
    );

    const [rowOne, rowTwo] = screen.getAllByRole("option");
    if (rowOne === undefined || rowTwo === undefined)
      throw new Error("Expected two inbox rows");
    openRowTitle(rowOne);
    expect(rowBusy(rowOne)).toBe(true);
    expect(rowBusy(rowTwo)).toBe(false);
    openRowTitle(rowTwo);
    expect(reviewRequestPaths(desktop)).toEqual([
      "/v1/reviews/open",
      "/v1/reviews/open",
    ]);
    expect(rowBusy(rowOne)).toBe(true);
    expect(rowBusy(rowTwo)).toBe(true);

    second.resolve(success(asJsonBody(projection)));
    await waitFor(() => expect(rowBusy(rowTwo)).toBe(false));
    expect(rowBusy(rowOne)).toBe(true);
    expect(
      screen.getByRole("progressbar", { name: "Opening Review…" }),
    ).toBeTruthy();

    first.resolve(success(asJsonBody(projection)));
    await waitFor(() => expect(rowBusy(rowOne)).toBe(false));
    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
  });
});
