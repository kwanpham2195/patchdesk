// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InboxFlow } from "../../src/renderer/src/flows/inbox-flow";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import type { Dashboard } from "../../src/renderer/src/renderer-models";

const sha = "a".repeat(40);
const patchHash = "b".repeat(64);
const savedRow = {
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
  latestReview: {
    reviewId: "review-1",
    reviewedHeadSha: sha,
    updatedAt: "2026-08-13T00:00:00.000Z",
    matchesCurrentHead: true,
  },
  categories: ["saved_review"],
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
  dashboard: { rows: [], repos: [] },
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

afterEach(() => {
  delete (window as unknown as { patchdesk?: unknown }).patchdesk;
  vi.restoreAllMocks();
});

describe("InboxFlow saved-review recovery", () => {
  it("falls back to opening by PR identity when the stored review cannot be loaded", async () => {
    const requests: Array<{ readonly path: string; readonly body?: unknown }> =
      [];
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: {
        request: async (input: { readonly path: string; readonly body?: unknown }) => {
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
    render(
      <InboxFlow
        destination="dashboard"
        dashboard={dashboard}
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
    expect(requests.map((request) => request.path)).toEqual([
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
