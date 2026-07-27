import type {
  DesktopRequest,
  DesktopResponse,
  PatchdeskDesktopApi,
} from "../main/ipc-contract";
import { workbenchFixtureData } from "../renderer/src/flows/app-fixtures";
import type { InboxResponse } from "../renderer/src/renderer-contracts";

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
  { repo: { host: "github.com", owner: "centraldigital", repo: "patchdesk" }, state: "ready" },
  { repo: { host: "github.com", owner: "centraldigital", repo: "customer-management" }, state: "has_open_prs" },
  { repo: { host: "github.com", owner: "centraldigital", repo: "archived-service", archived: true }, state: "archived" },
];

const sha = "abcdef1234567890abcdef1234567890abcdef12";

export function installDesignBridge(scenarioId: string | undefined): void {
  const requestedAppearance = new URLSearchParams(window.location.search).get("appearance");
  let appearance: "system" | "light" | "dark" = requestedAppearance === "light" ? "light" : "dark";
  let diffTheme = { light: "pierre-light", dark: "pierre-dark" };
  const api: PatchdeskDesktopApi = {
    request: async (input) => {
      if ("operation" in input) return operationResponse(input);
      return routeResponse(input, scenarioId, () => ({ appearance, diffTheme }), (next) => {
        appearance = next.appearance;
        diffTheme = next.diffTheme;
      });
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
  readSettings: () => { readonly appearance: "system" | "light" | "dark"; readonly diffTheme: { readonly light: string; readonly dark: string } },
  writeSettings: (value: { readonly appearance: "system" | "light" | "dark"; readonly diffTheme: { readonly light: string; readonly dark: string } }) => void,
): Promise<DesktopResponse> {
  const url = new URL(input.path, "http://patchdesk-design.local");
  const method = input.method ?? "GET";
  if (scenarioId === "inbox-loading" && (url.pathname === "/v1/inbox" || url.pathname === "/v1/dashboard"))
    return await new Promise<DesktopResponse>(() => undefined);
  if (scenarioId === "inbox-error" && (url.pathname === "/v1/inbox" || url.pathname === "/v1/dashboard"))
    return errorResponse(503, "unavailable");

  if (url.pathname === "/v1/profiles" && method === "GET") return ok([profile]);
  if (url.pathname === "/v1/profiles" && method !== "GET") return ok([profile]);
  if (url.pathname === "/v1/profiles/select") return ok({ profile });
  if (url.pathname === "/v1/inbox" || url.pathname === "/v1/dashboard") return ok(inboxForScenario(scenarioId));
  if (url.pathname === "/v1/settings" && method === "GET") return ok(readSettings());
  if (url.pathname === "/v1/settings" && method === "PATCH") {
    const body = record(input.body) ? input.body : {};
    const current = readSettings();
    const next = {
      appearance: body.appearance === "system" || body.appearance === "light" || body.appearance === "dark" ? body.appearance : current.appearance,
      diffTheme: isDiffTheme(body.diffTheme) ? body.diffTheme : current.diffTheme,
    };
    writeSettings(next);
    return ok(next);
  }
  if (url.pathname === "/v1/reviews/open") return ok(preparedWorkbench());
  if (url.pathname === "/v1/reviews/load") return ok(scenarioId === "review-completed" ? completedWorkbench() : preparedWorkbench(scenarioId === "review-running"));
  if (url.pathname === "/v1/reviews/models") return ok({ models: [{ id: "pi-design", label: "Design review model" }], defaultModel: "pi-design" });
  if (url.pathname === "/v1/reviews/run" || url.pathname === "/v1/runs/review-pr") return ok({ runId: "design-run-1", attemptId: "design-attempt-1" });
  if (url.pathname.startsWith("/v1/runs/")) return ok({ status: "running", elapsedMs: 12_000, step: "inspecting", message: "Reading the prepared snapshot" });
  if (url.pathname === "/v1/direct-entry/preview") return ok({ pr: { host: "github.com", owner: "centraldigital", repo: "patchdesk", number: 42 }, confirmation: { required: false } });
  if (url.pathname === "/v1/environment") return ok({ productName: "Patchdesk Design", version: "wireframe", architecture: "browser", distribution: "design-only", git: "mock", gh: "mock", githubAuth: "mock", runtime: "in-memory", modelConfiguration: "mock" });
  if (url.pathname === "/v1/storage") return ok({ sessions: [{ sessionId: "design-session", state: "completed", sizeBytes: 38_400, updatedAt: "2026-07-18T10:00:00.000Z" }], quarantined: [], cacheBytes: 12_800 });
  if (url.pathname === "/v1/watchlist/suggestions") return ok([{ host: "github.com", owner: "centraldigital", repo: "new-service" }]);
  if (url.pathname === "/v1/github/access") return ok({ state: "ready" });
  if (url.pathname === "/v1/reviews/refresh") return ok(completedWorkbench());
  if (url.pathname === "/v1/reviews/submit" || url.pathname === "/v1/reviews/pending" || url.pathname === "/v1/reviews/apply-batch" || url.pathname === "/v1/reviews/batch") return ok({ session: completedWorkbench().session, batch: { state: { _tag: "Local" }, updatedAt: "2026-07-18T10:00:00.000Z", attemptId: "design-attempt-1" }, draft: { state: { _tag: "SubmittedGitHubReview", reviewId: "design-review-42", event: "COMMENT" } }, reviewId: "design-review-42" });
  if (url.pathname === "/v1/reviews/merge") return ok({ session: completedWorkbench().session });
  if (url.pathname === "/v1/storage/discard" || url.pathname === "/v1/storage/quarantine/delete" || url.pathname === "/v1/storage/cache/clear" || url.pathname.startsWith("/v1/watchlist")) return ok({});
  return errorResponse(404, `Design mock does not implement ${method} ${url.pathname}`);
}

function inboxForScenario(scenarioId: string | undefined): InboxResponse {
  const rows = scenarioId === "inbox-empty" ? [] : [
    inboxRow(42, "Protect review writes", "fixture", ["needs_review"], { kind: "run_review", label: "Run review" }, "passing", undefined, { checks: [{ name: "unit", status: "completed", conclusion: "success", required: true }] }),
    inboxRow(118, "Review updated VIP snapshot replacement", "maintainer", ["updated_since_review", "needs_review"], { kind: "review_updates", label: "Review updates", baseSessionId: "design-session" }, "passing", { state: "completed", matchesCurrentHead: false }, { reviewState: "review_pending", checks: [{ name: "unit", status: "completed", conclusion: "success", required: true }, { name: "integration", status: "queued", required: true }] }),
    inboxRow(77, "Open saved local review", "reviewer", ["saved_review", "checks_failing"], { kind: "open_saved_review", label: "Open saved review", sessionId: "design-session" }, "failing", { state: "draft", matchesCurrentHead: true }, { reviewState: "changes_requested", checks: [{ name: "unit", status: "completed", conclusion: "failure", required: true }] }),
    inboxRow(31, "Review author response", "author", ["waiting_for_author", "draft"], { kind: "open_discussion", label: "Review author response", sessionId: "design-session" }, "pending", undefined, { isDraft: true, checks: [{ name: "unit", status: "queued", required: true }] }),
    inboxRow(19, "Continue active review", "reviewer", ["running"], { kind: "continue_review", label: "View review progress", sessionId: "design-session" }, "pending", { state: "running", matchesCurrentHead: true }),
    inboxRow(8, "Ready to merge dependency update", "bot", ["ready_to_merge"], { kind: "open_merge_readiness", label: "Open merge readiness", sessionId: "design-session" }, "passing", undefined, { reviewState: "approved", checks: [{ name: "unit", status: "completed", conclusion: "success", required: true }] }),
  ];
  return {
    profile,
    inbox: {
      rows,
      repositories: scenarioId === "inbox-empty" ? repositories.map((entry) => ({ ...entry, state: "no_open_prs" })) : repositories,
      dataFreshness: scenarioId === "inbox-cached" ? "cached" : "fresh",
      snapshot: { state: scenarioId === "inbox-cached" ? "failed_cached" : "current", refreshedAt: "2026-07-18T10:00:00.000Z" },
    },
  };
}

function inboxRow(
  number: number,
  title: string,
  author: string,
  categories: Array<"needs_review" | "updated_since_review" | "waiting_for_author" | "checks_failing" | "ready_to_merge" | "saved_review" | "running" | "draft">,
  recommendedAction: InboxResponse["inbox"]["rows"][number]["recommendedAction"],
  overall: "passing" | "failing" | "pending",
  latestReview?: Pick<NonNullable<InboxResponse["inbox"]["rows"][number]["latestReview"]>, "state" | "matchesCurrentHead">,
  options: { readonly isDraft?: boolean; readonly reviewState?: InboxResponse["inbox"]["rows"][number]["reviewState"]; readonly checks?: ReadonlyArray<unknown> } = {},
): InboxResponse["inbox"]["rows"][number] {
  return {
    identity: { host: "github.com", owner: "centraldigital", repo: "patchdesk", number },
    title,
    author,
    baseBranch: "main",
    headBranch: `feat/design-${number}`,
    currentHeadSha: sha,
    isDraft: options.isDraft ?? false,
    updatedAt: "2026-07-18T10:00:00.000Z",
    changeStats: { additions: number, deletions: Math.max(1, Math.floor(number / 4)), changedFiles: Math.max(1, Math.floor(number / 10)) },
    checks: { overall, checks: [...(options.checks ?? [])] },
    reviewState: options.reviewState ?? "none",
    mergeability: overall === "failing" ? "blocked" : "mergeable",
    ...(latestReview === undefined ? {} : { latestReview: { sessionId: "design-session", reviewedHeadSha: sha, state: latestReview.state, updatedAt: "2026-07-18T10:00:00.000Z", matchesCurrentHead: latestReview.matchesCurrentHead } }),
    categories,
    recommendedAction,
    dataFreshness: "fresh",
  };
}

function preparedWorkbench(running = false): unknown {
  return {
    state: "review_started",
    session: { id: "design-session", key: { profileId: profile.id, host: "github.com", owner: "centraldigital", repo: "patchdesk", prNumber: 42, headSha: sha }, ...(running ? { currentAttemptId: "design-attempt-1", state: "Running" } : {}) },
    pullRequest: { ref: { host: "github.com", owner: "centraldigital", repo: "patchdesk", number: 42 }, title: "Protect review writes", author: "fixture", headBranch: "feat/review", baseBranch: "main", headSha: sha },
    reviewedHeadSha: sha,
    currentHeadSha: sha,
    freshness: "fresh",
    refreshedAt: "2026-07-18T10:00:00.000Z",
    fullPatch: workbenchFixtureData.fullPatch,
    checks: workbenchFixtureData.checks,
    ...(running ? { runId: "design-run-1" } : {}),
  };
}

function completedWorkbench(): { readonly state: "completed"; readonly session: unknown; readonly result: unknown; readonly reviewScope: { readonly kind: "full" }; readonly fullPatch: string; readonly comparisonAvailability: "not_requested"; readonly pullRequest: unknown; readonly reviewedHeadSha: string; readonly freshness: "fresh"; readonly refreshedAt: string; readonly comments: unknown; readonly checks: unknown; readonly mergeReadiness: unknown; readonly draft: unknown } {
  return {
    state: "completed",
    session: { id: "design-session", key: { profileId: profile.id, host: "github.com", owner: "centraldigital", repo: "patchdesk", prNumber: 42, headSha: sha } },
    result: workbenchFixtureData.result,
    reviewScope: { kind: "full" },
    fullPatch: workbenchFixtureData.fullPatch,
    comparisonAvailability: "not_requested",
    pullRequest: workbenchFixtureData.pullRequest,
    reviewedHeadSha: sha,
    freshness: "fresh",
    refreshedAt: "2026-07-18T10:00:00.000Z",
    comments: workbenchFixtureData.comments,
    checks: workbenchFixtureData.checks,
    mergeReadiness: { _tag: "NeedsAcknowledgement", blockers: [], warnings: ["request_changes", "high_severity_finding"] },
    draft: workbenchFixtureData.editableDraft,
  };
}

function operationResponse(input: Extract<DesktopRequest, { readonly operation: string }>): DesktopResponse {
  if (input.operation === "selectDirectory") return ok({ path: input.defaultPath ?? "/Users/matthew/Work" });
  return ok({});
}

function ok(body: unknown): DesktopResponse { return { ok: true, status: 200, body, correlationId: "design" }; }
function errorResponse(status: number, error: string): DesktopResponse { return { ok: false, status, body: { error }, correlationId: "design" }; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function isDiffTheme(value: unknown): value is { readonly light: string; readonly dark: string } { return record(value) && typeof value.light === "string" && typeof value.dark === "string"; }
