import type {
  DesktopRequest,
  DesktopResponse,
  PatchdeskDesktopApi,
} from "../main/ipc-contract";
import {
  createUnifiedReviewFixture,
  submissionFixtureData,
  workbenchFixtureData,
  type UnifiedReviewFixtureState,
} from "../renderer/src/flows/app-fixtures";
import type { InboxResponse, WorkbenchResponse } from "../renderer/src/renderer-contracts";

const profile = {
  id: "cfw",
  label: "CFW",
  githubHost: "github.com",
  ghAccount: "fixture-maintainer",
  workspaceRoots: ["/Users/matthew/Work"],
  ownerFilters: ["centraldigital"],
  rulePaths: ["AGENTS.md", ".agents/rules"],
};

const repositories = [
  {
    repo: { host: "github.com", owner: "centraldigital", repo: "patchdesk" },
    state: "ready",
  },
  {
    repo: {
      host: "github.com",
      owner: "centraldigital",
      repo: "customer-management",
    },
    state: "has_open_prs",
  },
  {
    repo: {
      host: "github.com",
      owner: "centraldigital",
      repo: "archived-service",
      archived: true,
    },
    state: "archived",
  },
];
const repositoriesWithArchived = repositories.map((entry) =>
  entry.state === "archived"
    ? { ...entry, repo: { ...entry.repo, archived: true } }
    : entry,
);

const sha = "abcdef1234567890abcdef1234567890abcdef12";

/**
 * Display-safe recovery fixture consumed by the Design app. The fixture holds
 * only a notice key, tone, and optional action key — no paths, IDs, attempts,
 * raw error text, lifecycle, storage, quarantine, worktree, or runtime terms.
 * The Design recovery routes must read this fixture; a duplicate inline map is
 * not allowed.
 */
export type DesignRecoveryFixture = {
  readonly noticeKey:
    | "preparing"
    | "ready_to_review"
    | "review_in_progress"
    | "review_interrupted"
    | "review_failed"
    | "needs_preparation";
  readonly tone: "neutral" | "positive" | "warning" | "destructive";
  readonly actionKey?:
    "run_review" | "reconnect" | "start_again" | "try_again" | "prepare_again";
};

export function designRecoveryFixtureFor(
  scenarioId: string | undefined,
): DesignRecoveryFixture {
  return recoveryFixtureFor(scenarioId);
}

export function designInboxRecoveryFixtureFor(
  prNumber: number,
): DesignRecoveryFixture {
  switch (prNumber) {
    case 42:
      return {
        noticeKey: "ready_to_review",
        tone: "positive",
        actionKey: "run_review",
      };
    case 118:
      return {
        noticeKey: "review_interrupted",
        tone: "warning",
        actionKey: "start_again",
      };
    case 77:
      return {
        noticeKey: "review_failed",
        tone: "warning",
        actionKey: "try_again",
      };
    case 31:
      return {
        noticeKey: "ready_to_review",
        tone: "positive",
        actionKey: "run_review",
      };
    case 19:
      return {
        noticeKey: "review_in_progress",
        tone: "positive",
        actionKey: "reconnect",
      };
    case 8:
      return {
        noticeKey: "needs_preparation",
        tone: "destructive",
        actionKey: "prepare_again",
      };
    default:
      return {
        noticeKey: "ready_to_review",
        tone: "positive",
        actionKey: "run_review",
      };
  }
}

export function installDesignBridge(scenarioId: string | undefined): void {
  const requestedAppearance = new URLSearchParams(window.location.search).get(
    "appearance",
  );
  let appearance: "system" | "light" | "dark" =
    requestedAppearance === "light" ? "light" : "dark";
  let diffTheme = { light: "pierre-light", dark: "pierre-dark" };
  const api: PatchdeskDesktopApi = {
    request: async (input) => {
      if ("operation" in input) return operationResponse(input);
      return routeResponse(
        input,
        scenarioId,
        () => ({ appearance, diffTheme }),
        (next) => {
          appearance = next.appearance;
          diffTheme = next.diffTheme;
        },
      );
    },
    openExternalHttps: async () => true,
    onNavigate: () => () => undefined,
    qaScrollDiagnosticsEnabled: false,
  };
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: api,
  });
}

async function routeResponse(
  input: Exclude<DesktopRequest, { readonly operation: string }>,
  scenarioId: string | undefined,
  readSettings: () => {
    readonly appearance: "system" | "light" | "dark";
    readonly diffTheme: { readonly light: string; readonly dark: string };
  },
  writeSettings: (value: {
    readonly appearance: "system" | "light" | "dark";
    readonly diffTheme: { readonly light: string; readonly dark: string };
  }) => void,
): Promise<DesktopResponse> {
  const url = new URL(input.path, "http://patchdesk-design.local");
  const method = input.method ?? "GET";
  if (
    scenarioId === "inbox-loading" &&
    (url.pathname === "/v1/inbox" || url.pathname === "/v1/dashboard")
  )
    return await new Promise<DesktopResponse>(() => undefined);
  if (
    scenarioId === "inbox-error" &&
    (url.pathname === "/v1/inbox" || url.pathname === "/v1/dashboard")
  )
    return errorResponse(503, "unavailable");

  if (url.pathname === "/v1/profiles" && method === "GET") return ok([profile]);
  if (url.pathname === "/v1/profiles" && method !== "GET") return ok([profile]);
  if (url.pathname === "/v1/profiles/select") return ok({ profile });
  if (url.pathname === "/v1/inbox" || url.pathname === "/v1/dashboard")
    return ok(inboxForScenario(scenarioId));
  if (url.pathname === "/v1/settings" && method === "GET")
    return ok(readSettings());
  if (url.pathname === "/v1/settings" && method === "PATCH") {
    const body = record(input.body) ? input.body : {};
    const current = readSettings();
    const next = {
      appearance:
        body.appearance === "system" ||
        body.appearance === "light" ||
        body.appearance === "dark"
          ? body.appearance
          : current.appearance,
      diffTheme: isDiffTheme(body.diffTheme)
        ? body.diffTheme
        : current.diffTheme,
    };
    writeSettings(next);
    return ok(next);
  }
  if (url.pathname === "/v1/reviews/open") return ok(unifiedReviewFixtureForScenario(scenarioId));
  if (url.pathname === "/v1/reviews/load") {
    if (isRecoveryWorkbenchScenario(scenarioId)) return ok(recoveryWorkbench(scenarioId));
    return ok(unifiedReviewFixtureForScenario(scenarioId));
  }
  if (url.pathname === "/v1/reviews/models") {
    if (
      scenarioId === "walkthrough-generate-dialog" ||
      scenarioId === "walkthrough-generating" ||
      scenarioId === "walkthrough-ready" ||
      scenarioId === "walkthrough-failed" ||
      scenarioId === "walkthrough-stale"
    ) {
      return ok({
        models: [{ id: "pi-design", label: "Design review model" }],
        defaultModel: "pi-design",
      });
    }
    return ok({ models: [], defaultModel: undefined });
  }
  if (
    url.pathname === "/v1/reviews/walkthrough/generate" &&
    method === "POST"
  ) {
    const body = record(input.body) ? input.body : {};
    const kind = typeof body.kind === "string" ? body.kind : "";
    if (kind === "failed") return errorResponse(503, "unavailable");
    if (kind === "stale") return errorResponse(409, "stale");
    return ok({ lifecycle: "ready", sections: walkthroughSections() });
  }
  if (
    url.pathname === "/v1/reviews/run" ||
    url.pathname === "/v1/runs/review-pr"
  )
    return ok({ runId: "design-run-1", attemptId: "design-attempt-1" });
  if (url.pathname.startsWith("/v1/runs/"))
    return ok({
      status: "running",
      elapsedMs: 12_000,
      step: "inspecting",
      message: "Reading the prepared snapshot",
    });
  if (url.pathname === "/v1/direct-entry/preview")
    return ok({
      pr: {
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        number: 42,
      },
      confirmation: { required: false },
    });
  if (url.pathname === "/v1/environment")
    return ok({
      productName: "Patchdesk Design",
      version: "wireframe",
      architecture: "browser",
      distribution: "design-only",
      git: "mock",
      gh: "mock",
      githubAuth: "mock",
      runtime: "in-memory",
      modelConfiguration: "mock",
    });
  if (
    url.pathname === "/v1/storage/cache/clear" ||
    url.pathname === "/v1/storage/clear-local-data"
  )
    return ok({});
  if (url.pathname === "/v1/watchlist/suggestions")
    return ok([
      { host: "github.com", owner: "centraldigital", repo: "new-service" },
    ]);
  if (url.pathname === "/v1/github/access") return ok({ state: "ready" });
  if (url.pathname === "/v1/reviews/refresh") return ok(unifiedReviewFixtureForScenario(scenarioId));
  if (url.pathname === "/v1/reviews/commit-diff") {
    const fixture = unifiedReviewFixtureForScenario(scenarioId);
    const commitSha = record(input.body) && typeof input.body.commitSha === "string" ? input.body.commitSha : fixture.commits[0]?.sha;
    const commit = fixture.commits.find((candidate) => candidate.sha === commitSha) ?? fixture.commits[0];
    if (commit === undefined) return errorResponse(404, "Commit fixture is unavailable");
    return ok({ commit, position: 1, total: 1, patch: fixture.fullPatch ?? "" });
  }
  if (
    url.pathname === "/v1/reviews/submit-batch" ||
    url.pathname === "/v1/reviews/apply-batch" ||
    url.pathname === "/v1/reviews/batch"
  )
    return ok({
      session: unifiedReviewFixtureForScenario(scenarioId).session,
      batch: {
        state: {
          _tag: "Submitted",
          reviewId: "design-review-42",
          event: "COMMENT",
        },
        updatedAt: "2026-07-18T10:00:00.000Z",
      },
      reviewId: "design-review-42",
    });
  if (url.pathname === "/v1/reviews/merge")
    return ok({ session: unifiedReviewFixtureForScenario(scenarioId).session });
  if (url.pathname.startsWith("/v1/watchlist")) return ok({});
  return errorResponse(
    404,
    `Design mock does not implement ${method} ${url.pathname}`,
  );
}

function unifiedReviewFixtureForScenario(scenarioId: string | undefined): WorkbenchResponse {
  const stateMap: Record<string, UnifiedReviewFixtureState> = {
    "review-files-default": "files-default",
    "review-files-finding-selected": "files-finding-selected",
    "review-files-commit-selected": "files-commit-selected",
    "review-updates-draft": "updates-draft",
    "review-draft-expanded": "draft-expanded",
    "review-needs-attention": "needs-attention",
    "review-pr-overview": "pr-overview",
    "review-merged": "merged",
    "review-closed": "closed",
    "insights-overview": "insights-overview",
    "analysis-running": "analysis-running",
    "analysis-current": "analysis-current",
    "analysis-outdated": "analysis-outdated",
    "analysis-failed": "analysis-failed",
    "analysis-replacement-running": "analysis-replacement-running",
    "analysis-replacement-failed": "analysis-replacement-failed",
    "walkthrough-current": "walkthrough-current",
    "walkthrough-outdated": "walkthrough-outdated",
    "publication-ready": "publication-ready",
    "publication-publishing": "publication-publishing",
    "publication-confirmed": "publication-confirmed",
    "publication-needs-confirmation": "publication-needs-confirmation",
    "published-feedback-collapsed": "published-feedback-collapsed",
    "published-feedback-expanded": "published-feedback-expanded",
  };
  return createUnifiedReviewFixture(stateMap[scenarioId ?? ""] ?? "files-default");
}

function isRecoveryWorkbenchScenario(scenarioId: string | undefined): boolean {
  return (
    scenarioId === "workbench-reconnect" ||
    scenarioId === "workbench-start-again" ||
    scenarioId === "workbench-try-again" ||
    scenarioId === "workbench-prepare-again"
  );
}

function recoveryWorkbench(scenarioId: string | undefined): unknown {
  const fixture = recoveryFixtureFor(scenarioId);
  return {
    state: "review_started",
    session: {
      id: "design-session",
      key: {
        profileId: profile.id,
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        prNumber: 42,
        headSha: sha,
      },
    },
    pullRequest: {
      ref: {
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        number: 42,
      },
      title: "Protect review writes",
      author: "fixture",
      headBranch: "feat/review",
      baseBranch: "main",
      headSha: sha,
      description:
        "Keep normal pull-request work available before optional local analysis.",
    },
    reviewedHeadSha: sha,
    currentHeadSha: sha,
    freshness: "fresh",
    refreshedAt: "2026-07-18T10:00:00.000Z",
    fullPatch: workbenchFixtureData.fullPatch,
    checks: workbenchFixtureData.checks,
    comments: workbenchFixtureData.comments,
    batch: submissionFixtureData.batch,
    mergeReadiness: {
      _tag: "NeedsAcknowledgement",
      blockers: [],
      warnings: ["request_changes"],
    },
    recoveryView: fixture,
  };
}

function recoveryFixtureFor(
  scenarioId: string | undefined,
): DesignRecoveryFixture {
  switch (scenarioId) {
    case "workbench-reconnect":
      return {
        noticeKey: "review_in_progress",
        tone: "positive",
        actionKey: "reconnect",
      };
    case "workbench-start-again":
      return {
        noticeKey: "review_interrupted",
        tone: "warning",
        actionKey: "start_again",
      };
    case "workbench-try-again":
      return {
        noticeKey: "review_failed",
        tone: "warning",
        actionKey: "try_again",
      };
    case "workbench-prepare-again":
      return {
        noticeKey: "needs_preparation",
        tone: "warning",
        actionKey: "prepare_again",
      };
    default:
      return {
        noticeKey: "ready_to_review",
        tone: "positive",
        actionKey: "run_review",
      };
  }
}

function inboxForScenario(scenarioId: string | undefined): InboxResponse {
  const isInboxRecovery = scenarioId === "inbox-recovery-states";
  const recoveryOptions = isInboxRecovery
    ? {
        42: {
          recovery: {
            noticeKey: "ready_to_review",
            tone: "positive" as const,
            actionKey: "run_review",
          },
        },
        118: {
          recovery: {
            noticeKey: "review_interrupted",
            tone: "warning" as const,
            actionKey: "start_again",
          },
        },
        77: {
          recovery: {
            noticeKey: "review_failed",
            tone: "warning" as const,
            actionKey: "try_again",
          },
        },
        31: {
          recovery: {
            noticeKey: "ready_to_review",
            tone: "positive" as const,
            actionKey: "run_review",
          },
        },
        19: {
          recovery: {
            noticeKey: "review_in_progress",
            tone: "positive" as const,
            actionKey: "reconnect",
          },
        },
        8: {
          recovery: {
            noticeKey: "needs_preparation",
            tone: "warning" as const,
            actionKey: "prepare_again",
          },
        },
      }
    : {};
  const baseRows =
    scenarioId === "inbox-empty"
      ? []
      : [
          inboxRow(
            42,
            "Protect review writes",
            "fixture",
            ["needs_review"],
            { kind: "run_review", label: "Run review" },
            "passing",
            undefined,
            {
              checks: [
                {
                  name: "unit",
                  status: "completed",
                  conclusion: "success",
                  required: true,
                },
              ],
              ...(recoveryOptions[42] ?? {}),
            },
          ),
          inboxRow(
            118,
            "Review updated VIP snapshot replacement",
            "maintainer",
            ["updated_since_review", "needs_review"],
            {
              kind: "review_updates",
              label: "Review updates",
              baseSessionId: "design-session",
            },
            "passing",
            { state: "completed", matchesCurrentHead: false },
            {
              reviewState: "review_pending",
              checks: [
                {
                  name: "unit",
                  status: "completed",
                  conclusion: "success",
                  required: true,
                },
                { name: "integration", status: "queued", required: true },
              ],
              ...(recoveryOptions[118] ?? {}),
            },
          ),
          inboxRow(
            77,
            "Open saved local review",
            "reviewer",
            ["saved_review", "checks_failing"],
            {
              kind: "open_saved_review",
              label: "Open Review",
              sessionId: "design-session",
            },
            "failing",
            { state: "draft", matchesCurrentHead: true },
            {
              reviewState: "changes_requested",
              checks: [
                {
                  name: "unit",
                  status: "completed",
                  conclusion: "failure",
                  required: true,
                },
              ],
              ...(recoveryOptions[77] ?? {}),
            },
          ),
          inboxRow(
            31,
            "Review author response",
            "author",
            ["waiting_for_author", "draft"],
            {
              kind: "open_discussion",
              label: "Review author response",
              sessionId: "design-session",
            },
            "pending",
            undefined,
            {
              isDraft: true,
              checks: [{ name: "unit", status: "queued", required: true }],
              ...(recoveryOptions[31] ?? {}),
            },
          ),
          inboxRow(
            19,
            "Continue active review",
            "reviewer",
            ["running"],
            {
              kind: "continue_review",
              label: "View review progress",
              sessionId: "design-session",
            },
            "pending",
            { state: "running", matchesCurrentHead: true },
            recoveryOptions[19] ?? {},
          ),
          inboxRow(
            8,
            "Ready to merge dependency update",
            "bot",
            ["ready_to_merge"],
            {
              kind: "open_merge_readiness",
              label: "Open merge readiness",
              sessionId: "design-session",
            },
            "passing",
            undefined,
            {
              reviewState: "approved",
              checks: [
                {
                  name: "unit",
                  status: "completed",
                  conclusion: "success",
                  required: true,
                },
              ],
              ...(recoveryOptions[8] ?? {}),
            },
          ),
        ];
  return {
    profile,
    inbox: {
      rows: baseRows,
      repositories:
        scenarioId === "inbox-empty"
          ? repositoriesWithArchived.map((entry) => ({
              ...entry,
              state: "no_open_prs",
            }))
          : repositoriesWithArchived,
      dataFreshness: scenarioId === "inbox-cached" ? "cached" : "fresh",
      snapshot: {
        state: scenarioId === "inbox-cached" ? "failed_cached" : "current",
        refreshedAt: "2026-07-18T10:00:00.000Z",
      },
    },
  };
}

function inboxRow(
  number: number,
  title: string,
  author: string,
  categories: Array<
    | "needs_review"
    | "updated_since_review"
    | "waiting_for_author"
    | "checks_failing"
    | "ready_to_merge"
    | "saved_review"
    | "running"
    | "draft"
  >,
  recommendedAction: InboxResponse["inbox"]["rows"][number]["recommendedAction"],
  overall: "passing" | "failing" | "pending",
  latestReview:
    | Pick<
        NonNullable<InboxResponse["inbox"]["rows"][number]["latestReview"]>,
        "state" | "matchesCurrentHead"
      >
    | undefined,
  options: {
    readonly isDraft?: boolean;
    readonly reviewState?: InboxResponse["inbox"]["rows"][number]["reviewState"];
    readonly checks?: ReadonlyArray<unknown>;
    readonly recovery?: {
      readonly noticeKey: string;
      readonly tone: "neutral" | "positive" | "warning" | "destructive";
      readonly actionKey?: string;
    };
  },
): InboxResponse["inbox"]["rows"][number] {
  const base = {
    identity: {
      host: "github.com",
      owner: "centraldigital",
      repo: "patchdesk",
      number,
    },
    title,
    author,
    baseBranch: "main",
    headBranch: `feat/design-${number}`,
    currentHeadSha: sha,
    isDraft: options.isDraft ?? false,
    updatedAt: "2026-07-18T10:00:00.000Z",
    changeStats: {
      additions: number,
      deletions: Math.max(1, Math.floor(number / 4)),
      changedFiles: Math.max(1, Math.floor(number / 10)),
    },
    checks: { overall, checks: [...(options.checks ?? [])] },
    reviewState: options.reviewState ?? "none",
    mergeability: overall === "failing" ? "blocked" : "mergeable",
    ...(latestReview === undefined
      ? {}
      : {
          latestReview: {
            sessionId: "design-session",
            reviewedHeadSha: sha,
            state: latestReview.state,
            updatedAt: "2026-07-18T10:00:00.000Z",
            matchesCurrentHead: latestReview.matchesCurrentHead,
          },
        }),
    categories,
    recommendedAction,
    dataFreshness: "fresh" as const,
  };
  if (options.recovery === undefined)
    return base as InboxResponse["inbox"]["rows"][number];
  return {
    ...base,
    recovery: options.recovery,
  } as InboxResponse["inbox"]["rows"][number];
}

function operationResponse(
  input: Extract<DesktopRequest, { readonly operation: string }>,
): DesktopResponse {
  if (input.operation === "selectDirectory")
    return ok({ path: input.defaultPath ?? "/Users/matthew/Work" });
  return ok({});
}

function walkthroughSections(): ReadonlyArray<unknown> {
  return [
    {
      id: "section-1",
      chapter: "Context",
      title: "Why this matters",
      prose:
        "The new recovery path keeps the saved snapshot but never starts a new run automatically. Walkthrough sections describe behavior before consequences and rely on stored evidence only.",
      hunkIds: ["h-1"],
    },
    {
      id: "section-2",
      chapter: "Behavior",
      title: "How reads are kept read-only",
      prose:
        "Patchdesk reads from the cached local review patch. No GitHub write happens at this stage and the snapshot is bound to the current head.",
      hunkIds: ["h-2"],
    },
    {
      id: "section-3",
      chapter: "Consequences",
      title: "What changes for the maintainer",
      prose:
        "You can mark sections reviewed and open the existing inline comment editor without leaving the takeover.",
      hunkIds: ["h-3"],
    },
  ];
}

function ok(body: unknown): DesktopResponse {
  return { ok: true, status: 200, body, correlationId: "design" };
}
function errorResponse(status: number, error: string): DesktopResponse {
  return { ok: false, status, body: { error }, correlationId: "design" };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function isDiffTheme(
  value: unknown,
): value is { readonly light: string; readonly dark: string } {
  return (
    record(value) &&
    typeof value.light === "string" &&
    typeof value.dark === "string"
  );
}
