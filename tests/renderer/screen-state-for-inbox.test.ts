import { describe, expect, it } from "vitest";

import { screenStateForInbox } from "../../src/renderer/src/screen-state-for-inbox";
import type { InboxResponse } from "../../src/renderer/src/renderer-contracts";
import type { Dashboard } from "../../src/renderer/src/renderer-models";

/**
 * `screenStateForInbox` decides the whole screen's state ("error",
 * "no_open_prs", "empty", "success") from the inbox and dashboard the app
 * just loaded (`app.tsx`). It reads only `dashboard.dashboard.repos[].state`,
 * `inbox.inbox.state`, and `inbox.inbox.rows.length` — everything else on
 * both fixtures below is omitted.
 *
 * These fixtures are cast rather than parsed through `parseInboxResponse`
 * because a full, schema-valid `InboxResponse` needs fields (`pageSize`,
 * `checks`, `recommendedAction`, ...) that this function never reads; adding
 * them here would only obscure which fields the branches actually depend on.
 */
function inboxWith(state: "open" | "merged", rowCount: number): InboxResponse {
  // SAFETY: test fixture narrows a partial InboxResponse mock to the
  // stricter renderer-contracts type; `screenStateForInbox` reads only
  // `inbox.state` and `inbox.rows.length`, so the rest of the real shape is
  // irrelevant to the function under test.
  return {
    profile: {
      id: "profile",
      label: "Profile",
      githubHost: "github.com",
      ghAccount: "fixture",
    },
    inbox: {
      state,
      rows: Array.from({ length: rowCount }, (_unused, index) => ({ index })),
    },
  } as never;
}

function dashboardWith(repoStates: ReadonlyArray<string>): Dashboard {
  return {
    profile: {
      id: "profile",
      label: "Profile",
      githubHost: "github.com",
      ghAccount: "fixture",
    },
    dashboard: {
      repos: repoStates.map((state) => ({
        repo: { host: "github.com", owner: "owner", repo: "repo" },
        state,
      })),
    },
  };
}

describe("screenStateForInbox", () => {
  it("returns error for each GitHub repo outcome, even with rows already loaded", () => {
    for (const outcome of [
      "github_auth",
      "github_read",
      "github_rate_limited",
      "github_forbidden",
    ]) {
      expect(
        screenStateForInbox(inboxWith("open", 1), dashboardWith([outcome])),
      ).toBe("error");
    }
  });

  it("returns no_open_prs for the open filter with the no_open_prs outcome and zero rows", () => {
    expect(
      screenStateForInbox(inboxWith("open", 0), dashboardWith(["no_open_prs"])),
    ).toBe("no_open_prs");
  });

  it("returns empty instead of no_open_prs when the state filter is merged", () => {
    expect(
      screenStateForInbox(
        inboxWith("merged", 0),
        dashboardWith(["no_open_prs"]),
      ),
    ).toBe("empty");
  });

  it("returns success instead of no_open_prs when rows are already loaded", () => {
    expect(
      screenStateForInbox(inboxWith("open", 1), dashboardWith(["no_open_prs"])),
    ).toBe("success");
  });

  it("returns empty when there are no rows and no error or no_open_prs outcome", () => {
    expect(
      screenStateForInbox(inboxWith("open", 0), dashboardWith(["ready"])),
    ).toBe("empty");
    expect(screenStateForInbox(inboxWith("open", 0), dashboardWith([]))).toBe(
      "empty",
    );
  });

  it("returns success when rows are loaded and no error outcome is present", () => {
    expect(
      screenStateForInbox(inboxWith("open", 3), dashboardWith(["ready"])),
    ).toBe("success");
  });
});
