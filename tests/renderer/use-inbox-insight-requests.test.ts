// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import { useInboxInsightRequests } from "../../src/renderer/src/flows/use-inbox-insight-requests";
import { inboxInsightRequestKey } from "../../src/renderer/src/inbox-insight-request";
import { saveInsightRunPreference } from "../../src/renderer/src/insight-run-preferences";
import type {
  InboxRow,
  WorkbenchResponse,
} from "../../src/renderer/src/renderer-contracts";
import type { Dashboard } from "../../src/renderer/src/renderer-models";
import {
  installDesktopDouble,
  success,
  type DesktopDouble,
  type DesktopRoute,
} from "./fake-desktop-response";

const sha = "a".repeat(40);
const patchHash = "b".repeat(64);

const dashboard: Dashboard = {
  profile: {
    id: "profile",
    label: "Profile",
    githubHost: "github.com",
    ghAccount: "maintainer",
  },
  dashboard: { repos: [] },
};

const unreviewedRow: InboxRow = {
  remoteState: "open",
  identity: { host: "github.com", owner: "owner", repo: "repo", number: 7 },
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
  categories: [],
  recommendedAction: { kind: "run_review" },
  dataFreshness: "fresh",
};

const savedRow: InboxRow = {
  ...unreviewedRow,
  latestReview: {
    reviewId: "review-saved",
    reviewedHeadSha: sha,
    updatedAt: "2026-08-13T00:00:00.000Z",
    matchesCurrentHead: true,
  },
  recommendedAction: { kind: "open_saved_review", reviewId: "review-saved" },
};

/** The smallest workbench projection `/v1/reviews/open` can answer with. */
const preparedWorkbench = (): WorkbenchResponse =>
  // SAFETY: this fixture literal supplies every WorkbenchResponse field the
  // parser requires, with valid wire-format identity values.
  ({
    state: "review",
    viewerLogin: "fixture",
    review: { id: "review-prepared", status: "open" },
    session: {
      id: "session-a",
      key: {
        profileId: "profile",
        host: "github.com",
        owner: "owner",
        repo: "repo",
        prNumber: 7,
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
      ref: { host: "github.com", owner: "owner", repo: "repo", number: 7 },
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
    conversation: { prDescription: "Description", entries: [] },
    checks: { overall: "passing", checks: [] },
    mergeReadiness: { _tag: "Ready", blockers: [], warnings: [] },
    mergeReasons: [],
  }) as WorkbenchResponse;

type Call = {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
};

function asJsonBody(value: WorkbenchResponse): RawJsonValue {
  // SAFETY: the fixture holds only JSON-compatible data.
  return structuredClone(value) as RawJsonValue;
}

let desktop: DesktopDouble | undefined;

/** Routes prepare, run, and poll; the poll answers `running` `runningPolls` times before `completed`. */
function installBridge(options: {
  readonly runningPolls?: number;
  readonly terminalStatus?: "completed" | "failed";
}): Call[] {
  const calls: Call[] = [];
  let polls = 0;
  const record: DesktopRoute = (input) => {
    calls.push({
      method: input.method ?? "GET",
      path: input.path,
      body: input.body,
    });
    if (input.path === "/v1/reviews/open")
      return success(asJsonBody(preparedWorkbench()));
    if (input.path.endsWith("/run"))
      return success({ runId: "run-1", type: "brief", status: "queued" });
    polls += 1;
    if (polls <= (options.runningPolls ?? 0))
      return success({ runId: "run-1", type: "brief", status: "running" });
    if (options.terminalStatus === "failed")
      return success({
        runId: "run-1",
        type: "brief",
        status: "failed",
        failureReason: "failed",
      });
    return success({ runId: "run-1", type: "brief", status: "completed" });
  };
  desktop = installDesktopDouble({
    "/v1/reviews/open": record,
    "/v1/reviews/insights/brief/run": record,
    "/v1/reviews/insights/runs/run-1": record,
  });
  return calls;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  desktop?.restore();
  desktop = undefined;
  window.localStorage.clear();
});

describe("useInboxInsightRequests", () => {
  it("prepares a never-opened pull request, starts the run, polls it, then refreshes the row", async () => {
    saveInsightRunPreference("profile", "brief", {
      provider: "pi",
      model: "fixture-model",
      reasoning: "medium",
    });
    const calls = installBridge({ runningPolls: 1 });
    const onRowRefresh = vi.fn();
    const { result } = renderHook(() =>
      useInboxInsightRequests({ dashboard, onRowRefresh }),
    );
    const key = inboxInsightRequestKey(unreviewedRow, "brief");

    act(() => result.current.requestInsight(unreviewedRow, "brief"));
    expect(result.current.insightRequests.get(key)).toEqual({
      status: "preparing",
    });
    await waitFor(() =>
      expect(result.current.insightRequests.get(key)).toEqual({
        status: "running",
      }),
    );
    await waitFor(() => expect(onRowRefresh).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    expect(result.current.insightRequests.get(key)).toBeUndefined();
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /v1/reviews/open",
      "POST /v1/reviews/insights/brief/run",
      "GET /v1/reviews/insights/runs/run-1?profileId=profile&reviewId=review-prepared&type=brief",
      "GET /v1/reviews/insights/runs/run-1?profileId=profile&reviewId=review-prepared&type=brief",
    ]);
    expect(calls[1]?.body).toEqual({
      profileId: "profile",
      reviewId: "review-prepared",
      type: "brief",
      provider: "pi",
      model: "fixture-model",
      reasoning: "medium",
    });
  });

  it("uses the row's saved review without preparing one", async () => {
    saveInsightRunPreference("profile", "brief", {
      provider: "pi",
      model: "fixture-model",
      reasoning: "medium",
    });
    const calls = installBridge({});
    const onRowRefresh = vi.fn();
    const { result } = renderHook(() =>
      useInboxInsightRequests({ dashboard, onRowRefresh }),
    );

    act(() => result.current.requestInsight(savedRow, "brief"));
    expect(
      result.current.insightRequests.get(
        inboxInsightRequestKey(savedRow, "brief"),
      ),
    ).toEqual({ status: "starting" });
    await waitFor(() => expect(onRowRefresh).toHaveBeenCalledTimes(1));
    expect(calls.map(({ path }) => path)).not.toContain("/v1/reviews/open");
    expect(calls[0]?.body).toMatchObject({ reviewId: "review-saved" });
  });

  it("sends one request for two clicks on the same row and kind", async () => {
    saveInsightRunPreference("profile", "brief", {
      provider: "pi",
      model: "fixture-model",
      reasoning: "medium",
    });
    const calls = installBridge({});
    const onRowRefresh = vi.fn();
    const { result } = renderHook(() =>
      useInboxInsightRequests({ dashboard, onRowRefresh }),
    );

    act(() => {
      result.current.requestInsight(savedRow, "brief");
      result.current.requestInsight(savedRow, "brief");
    });
    await waitFor(() => expect(onRowRefresh).toHaveBeenCalledTimes(1));
    expect(calls.filter(({ path }) => path.endsWith("/run"))).toHaveLength(1);
  });

  it("falls back to the Analysis preference for a kind without its own", async () => {
    saveInsightRunPreference("profile", "analysis", {
      provider: "codex-cli-account",
      model: "analysis-model",
      reasoning: "high",
    });
    const calls = installBridge({});
    const { result } = renderHook(() =>
      useInboxInsightRequests({ dashboard, onRowRefresh: vi.fn() }),
    );
    expect(result.current.insightRequestAvailability).toEqual({
      brief: true,
      analysis: true,
      walkthrough: true,
    });

    act(() => result.current.requestInsight(savedRow, "brief"));
    await waitFor(() =>
      expect(calls.some(({ path }) => path.endsWith("/run"))).toBe(true),
    );
    expect(calls[0]?.body).toMatchObject({
      provider: "codex-cli-account",
      model: "analysis-model",
      reasoning: "high",
    });
  });

  it("offers nothing and sends nothing without a saved preference", () => {
    desktop = installDesktopDouble({});
    const { result } = renderHook(() =>
      useInboxInsightRequests({ dashboard, onRowRefresh: vi.fn() }),
    );
    expect(result.current.insightRequestAvailability).toEqual({
      brief: false,
      analysis: false,
      walkthrough: false,
    });

    act(() => result.current.requestInsight(savedRow, "brief"));
    expect(result.current.insightRequests.size).toBe(0);
    expect(desktop.request).not.toHaveBeenCalled();
  });

  it("keeps a failed run as an error on the row and does not refresh", async () => {
    saveInsightRunPreference("profile", "brief", {
      provider: "pi",
      model: "fixture-model",
      reasoning: "medium",
    });
    installBridge({ terminalStatus: "failed" });
    const onRowRefresh = vi.fn();
    const { result } = renderHook(() =>
      useInboxInsightRequests({ dashboard, onRowRefresh }),
    );

    act(() => result.current.requestInsight(savedRow, "brief"));
    await waitFor(() =>
      expect(
        result.current.insightRequests.get(
          inboxInsightRequestKey(savedRow, "brief"),
        ),
      ).toEqual({ status: "error", error: "Brief failed (failed)." }),
    );
    expect(onRowRefresh).not.toHaveBeenCalled();
  });
});
