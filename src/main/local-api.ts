import { serve, type ServerType } from "@hono/node-server";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  optional,
  array,
  boolean,
  safeParse,
  minLength,
  number,
  integer,
  minValue,
  maxLength,
  object,
  picklist,
  pipe,
  record,
  string,
  strictObject,
  unknown,
  variant,
} from "valibot";

import { APP_CAPABILITY_HEADER, type AppCapability } from "./ipc-contract";
import { hasMatchingAppCapability } from "./app-capability";
import type { LocalApiStartupResult } from "./app-lifecycle";
import { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { ProfileStore } from "../adapters/storage/profile-store";
import { ReviewSessionStore } from "../adapters/storage/review-session-store";
import { ReviewStore } from "../adapters/storage/review-store";
import { ReviewRemoteStore } from "../adapters/storage/review-remote-store";
import { ReviewObservationJournalStore } from "../adapters/storage/review-observation-journal-store";
import { RecentWriteJournalStore } from "../adapters/storage/recent-write-journal-store";
import { MergeOperationStore } from "../adapters/storage/merge-operation-store";
import { ReviewArtifactStorage } from "../adapters/storage/review-artifact-storage";
import { InsightStore } from "../adapters/storage/insight-store";
import {
  StorageManagementService,
  type TrashMover,
} from "../services/storage-management-service";
import { GitHubAdapter } from "../adapters/github/github-adapter";
import { CommandRunner } from "../adapters/github/command-runner";
import { WorkspaceOriginFinder } from "../adapters/github/workspace-origin-finder";
import type {
  GitHubDirectSummaryGateway,
  GitHubMergeWriter,
  GitHubPendingReviewGateway,
  GitHubReader,
  GitHubReviewWriter,
} from "../adapters/github/github-adapter";
import type { OriginFinder } from "../services/dashboard-service";
import { DashboardController } from "../services/dashboard-controller";
import {
  PublishedFeedbackService,
  type PublishedFeedbackFailure,
} from "../services/published-feedback-service";
import {
  InlineConversationService,
  type DirectConversationCommand,
} from "../services/inline-conversation-service";
import type { ReviewWriteExpectation } from "../services/review-write-gate";
import {
  PendingReviewService,
  projectPendingReview,
  type PendingReviewProjection,
} from "../services/pending-review-service";
import type {
  FindingReviewSource,
  PendingReviewAnchor,
} from "../domain/pending-review";
import {
  DirectSummaryReviewService,
  projectDirectSummaryReview,
} from "../services/direct-summary-review-service";
import { ReviewOperationCoordinator } from "../services/review-operation-coordinator";
import type { RecentReviewWrite } from "../services/review-refresh-service";
import { ReviewWorkbenchController } from "../services/review-workbench-controller";
import { ReviewRefreshService } from "../services/review-refresh-service";
import { ReviewObservationService } from "../services/review-observation-service";
import { ReviewSessionPreparation } from "../services/review-session-preparation";
import { ReviewWorkbenchProjectionService } from "../services/review-workbench-projection";
import { ReviewCommitService } from "../services/review-commit-service";
import { ReviewPreparationJournal } from "../services/review-preparation-journal";
import { MergeWriteController } from "../services/merge-write-controller";
import { ReviewRecoveryService } from "../services/review-recovery-service";
import { ReviewDiagnosticService } from "../services/review-diagnostic-service";
import { AppLogService } from "../services/app-log-service";
import type { LogEntryInput } from "../domain/log-entry";
import { ReviewLifecycleGate } from "../services/review-lifecycle-gate";
import { ReviewContextService } from "../services/review-context-service";
import {
  ReviewWorktreeService,
  type GitReadExecutor,
} from "../services/review-worktree-service";
import { ReviewWriteGate } from "../services/review-write-gate";
import { ReviewDiffSourceService } from "../services/review-diff-source-service";
import type { InsightRunCoordinator } from "../services/insight-run-coordinator";
import type { InsightProviderCatalog } from "../services/insight-provider-catalog";
import { readObjectField } from "../services/read-object-field";
import type { PiRuntimeModelCatalog } from "../adapters/pi/pi-runtime-model-catalog";
import { err, ok, type Result } from "../domain/result";
import {
  parseContentHash,
  parseFindingId,
  parseGitHubReviewNodeId,
  parseGitHubThreadId,
  parseGitSha,
  parseInsightRunId,
  parseRepoRelativePath,
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type GitHubReviewNodeId,
  type ReviewId,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../domain/ids";
import type { InsightType } from "../domain/insight-record";

const localApiConfigurationSchema = object({
  allowedOrigin: pipe(string(), minLength(1)),
  developmentOrigin: optional(pipe(string(), minLength(1))),
  capability: pipe(string(), minLength(1)),
  appMetadata: optional(
    object({
      productName: pipe(string(), minLength(1)),
      version: pipe(string(), minLength(1)),
      architecture: pipe(string(), minLength(1)),
      distribution: picklist(["development", "unsigned_internal"]),
    }),
  ),
});

const localhostHostname = "127.0.0.1";
const reviewOpenSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  host: pipe(string(), minLength(1)),
  owner: pipe(string(), minLength(1)),
  repo: pipe(string(), minLength(1)),
  number: pipe(number(), integer(), minValue(1)),
});
const reviewLoadSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
});
const recentReviewWriteSchema = variant("_tag", [
  strictObject({
    _tag: picklist(["Comment"] as const),
    commentId: pipe(string(), minLength(1)),
    reviewId: optional(pipe(string(), minLength(1))),
  }),
  strictObject({
    _tag: picklist(["ThreadState"] as const),
    threadId: pipe(string(), minLength(1)),
    state: picklist(["open", "resolved"] as const),
  }),
  strictObject({
    _tag: picklist(["PendingThread"] as const),
    threadId: pipe(string(), minLength(1)),
  }),
  strictObject({
    _tag: picklist(["DirectSummaryReview"] as const),
    reviewId: pipe(string(), minLength(1)),
  }),
]);
const reviewUpdateSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  recentWrites: optional(array(recentReviewWriteSchema)),
});
const reviewCommitDiffSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  commitSha: pipe(string(), minLength(7)),
});
const insightRunSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  type: picklist(["analysis", "walkthrough"]),
  provider: picklist(["pi", "codex-cli-account"]),
  model: pipe(string(), minLength(1), maxLength(200)),
  reasoning: picklist(["minimal", "low", "medium", "high", "xhigh"]),
});
const insightCancelSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  type: picklist(["analysis", "walkthrough"]),
  runId: pipe(string(), minLength(1)),
});
const insightFindingSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  runId: pipe(string(), minLength(1)),
  reason: optional(pipe(string(), minLength(1), maxLength(500))),
});
const publishedCommentEditSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  commentId: pipe(string(), minLength(1)),
  body: string(),
});
const publishedCommentDeleteSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  commentId: pipe(string(), minLength(1)),
  confirmation: boolean(),
});
const publishedReviewDismissSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  publishedReviewId: pipe(string(), minLength(1)),
  message: string(),
  confirmation: boolean(),
});

/** Configuration required to bind the authenticated loopback API. */
export type LocalApiConfiguration = {
  readonly allowedOrigin: string;
  /** Vite's fixed renderer origin, accepted only by the unpackaged desktop app. */
  readonly developmentOrigin?: string | undefined;
  readonly capability: AppCapability;
  readonly appMetadata?:
    | {
        readonly productName: string;
        readonly version: string;
        readonly architecture: string;
        readonly distribution: "development" | "unsigned_internal";
      }
    | undefined;
  /** Explicit seams used only by local integration tests; production uses real main-process adapters. */
  readonly github?: GitHubReader;
  /** Test-only write seam. A reader alone must never enable review-write routes. */
  readonly reviewWriter?: GitHubReviewWriter;
  /** Test-only merge seam. Production gets this capability from the main-process adapter. */
  readonly mergeWriter?: GitHubMergeWriter;
  readonly origins?: OriginFinder;
  readonly paths?: PatchdeskPaths;
  /** Main-process-only source of currently enabled Pi models. */
  readonly modelCatalog?: PiRuntimeModelCatalog;
  /** Main-process-only provider catalog; Codex activation is explicit and authenticated. */
  readonly insightProviders?: Pick<
    InsightProviderCatalog,
    "passive" | "activateCodex"
  >;
  /** Main-process-owned Trash capability. Production wires shell.trashItem. */
  readonly trash?: TrashMover;
  /** Test-only read-only git seam used by storage cache clear. */
  readonly readOnlyGit?: GitReadExecutor;
  /** Composition-root lifecycle gate shared by every durable review mutation. */
  readonly lifecycleGate?: ReviewLifecycleGate;
  /** Composition-root coordinator shared by all Review-scoped mutations. */
  readonly reviewOperations?: ReviewOperationCoordinator;
  /** Composition-root diagnostic service shared by every failure boundary. */
  readonly diagnostics?: ReviewDiagnosticService;
  /** Composition-root local log stream; defaults to a fresh on-disk service. */
  readonly logs?: Pick<AppLogService, "write" | "tail">;
  /** Main-process-owned durable Review Insight lifecycle seam. */
  readonly insights?: Pick<
    InsightRunCoordinator,
    "start" | "cancel" | "observe" | "dismissFinding"
  > &
    Partial<
      Pick<InsightRunCoordinator, "updateWalkthroughProgress" | "addFinding">
    >;
  /**
   * Enables the automatic retention sweep after startup and every 24 hours.
   * Main-process-only; local integration tests keep it off.
   */
  readonly retentionSweep?: boolean;
};

/** A running local API that owns its HTTP server lifecycle. */
export type LocalApiServer = {
  readonly capability: AppCapability;
  readonly url: URL;
  stop(): Promise<void>;
};

/** Starts the Hono API on a random loopback port with capability and origin checks. */
export async function startLocalApiServer(
  configuration: LocalApiConfiguration,
): Promise<LocalApiStartupResult<LocalApiServer>> {
  const parsedConfiguration = safeParse(
    localApiConfigurationSchema,
    configuration,
  );
  if (!parsedConfiguration.success) {
    return { _tag: "invalid-configuration" };
  }

  const app = new Hono();
  app.use("*", corsForRenderer(parsedConfiguration.output));
  app.use("*", requireLocalApiAccess(parsedConfiguration.output));
  const paths = configuration.paths ?? PatchdeskPaths.default();
  const logs = configuration.logs ?? new AppLogService(paths);
  app.use("*", logLocalApiRequests(logs));
  app.get("/health", (context) => context.json({ status: "ok" }));
  const commands = new CommandRunner();
  const github = configuration.github ?? new GitHubAdapter(commands);
  const readOnlyGit = {
    async run(argv: ReadonlyArray<string>) {
      const output = await commands.runText({ argv, timeoutMs: 15_000 });
      return output._tag === "ok"
        ? ok({ stdout: output.value })
        : err({ _tag: "GitReadFailed" as const });
    },
  };
  const diagnostics =
    configuration.diagnostics ??
    new ReviewDiagnosticService(paths, () => new Date().toISOString());
  const profiles = new ProfileStore(paths);
  const recordProfileReloadFailure = async (phase: string): Promise<void> => {
    const config = await profiles.loadConfig();
    if (
      config._tag !== "ok" ||
      config.value.lastSelectedProfileId === undefined
    )
      return;
    const profileId = parseWorkspaceProfileId(
      config.value.lastSelectedProfileId,
    );
    if (profileId._tag !== "ok") return;
    await diagnostics.record({
      profileId: profileId.value,
      category: "recovery",
      phase,
      retryable: true,
      detail: "The selected profile could not reload its workspace data.",
    });
  };
  const sessions = new ReviewSessionStore(paths);
  const reviews = new ReviewStore(paths);
  const remoteReviews = new ReviewRemoteStore(paths);
  const observationJournals = new ReviewObservationJournalStore(paths);
  const recentWriteJournals = new RecentWriteJournalStore(paths);
  const reviewWriteGate = new ReviewWriteGate(
    profiles,
    reviews,
    sessions,
    remoteReviews,
    observationJournals,
  );
  const storageArtifacts = new ReviewArtifactStorage(
    paths,
    // SAFETY: Date.prototype.toISOString() always returns a valid ISO 8601
    // instant, satisfying the branded IsoTimestamp contract this callback fills.
    () => new Date().toISOString() as never,
  );
  const lifecycleGate =
    configuration.lifecycleGate ?? new ReviewLifecycleGate();
  const insights = new InsightStore(paths);
  const storageManagementInput = {
    profiles,
    sessions,
    reviews,
    insights,
    mergeOperations: new MergeOperationStore(paths),
    artifacts: storageArtifacts,
    paths,
    lifecycleGate,
    diagnostics,
    git: configuration.readOnlyGit ?? readOnlyGit,
    // SAFETY: Date.prototype.toISOString() always returns a valid ISO 8601
    // instant, satisfying the branded IsoTimestamp contract this callback fills.
    now: () => new Date().toISOString() as never,
  };
  const storageManagement = new StorageManagementService(
    configuration.trash === undefined
      ? storageManagementInput
      : { ...storageManagementInput, trash: configuration.trash },
  );
  await ReviewPreparationJournal.recover(
    paths,
    new ReviewWorktreeService(paths, readOnlyGit),
    sessions,
    lifecycleGate,
    diagnostics,
  );
  const configuredProfiles = await profiles.list();
  if (configuredProfiles._tag === "err") return { _tag: "recovery-failed" };
  const reviewOperations =
    configuration.reviewOperations ?? new ReviewOperationCoordinator();

  const recovery = new ReviewRecoveryService(
    profiles,
    sessions,
    // SAFETY: Date.prototype.toISOString() always returns a valid ISO 8601
    // instant, satisfying the branded IsoTimestamp contract this callback fills.
    () => new Date().toISOString() as never,
    {
      paths,
      artifacts: storageArtifacts,
      diagnostics,
      lifecycleGate,
      mergeOperations: new MergeOperationStore(paths),
      reviews,
      operationCoordinator: reviewOperations,
      github,
    },
  );
  const dashboard = new DashboardController(
    profiles,
    github,
    configuration.origins ?? new WorkspaceOriginFinder(commands),
    paths,
  );
  const reviewPreparation = new ReviewSessionPreparation({
    profiles,
    sessions,
    github,
    paths,
    // SAFETY: Date.prototype.toISOString() always returns a valid ISO 8601
    // instant, satisfying the branded IsoTimestamp contract this callback fills.
    now: () => new Date().toISOString() as never,
    worktrees: new ReviewWorktreeService(paths, readOnlyGit),
    context: new ReviewContextService(),
    artifacts: new ReviewArtifactStorage(
      paths,
      // SAFETY: Date.prototype.toISOString() always returns a valid ISO 8601
      // instant, satisfying the branded IsoTimestamp contract this callback fills.
      () => new Date().toISOString() as never,
    ),
    lifecycleGate,
    diagnostics,
  });
  const reviewProjection = new ReviewWorkbenchProjectionService(
    profiles,
    sessions,
    reviews,
    insights,
  );
  const inlineConversations = new InlineConversationService(
    reviewWriteGate,
    github,
    reviewOperations,
    // SAFETY: Date.prototype.toISOString() always returns a valid ISO 8601
    // instant, satisfying the branded IsoTimestamp contract this callback fills.
    () => new Date().toISOString() as never,
    recentWriteJournals,
  );
  const pendingReviewGateway = isGitHubPendingReviewGateway(github)
    ? github
    : undefined;
  const pendingReviews =
    pendingReviewGateway !== undefined
      ? new PendingReviewService(
          reviewWriteGate,
          sessions,
          pendingReviewGateway,
          // SAFETY: Date.prototype.toISOString() always returns a valid ISO
          // 8601 instant, satisfying the branded IsoTimestamp contract this
          // callback fills.
          () => new Date().toISOString() as never,
          reviewOperations,
          recentWriteJournals,
        )
      : undefined;
  if (pendingReviewGateway === undefined || pendingReviews === undefined)
    return { _tag: "recovery-failed" };
  const directSummaryReviews =
    isGitHubDirectSummaryGateway(github) && isGitHubPendingReviewGateway(github)
      ? new DirectSummaryReviewService(
          reviewWriteGate,
          sessions,
          // SAFETY: this branch's guard confirms `github` structurally
          // implements both gateway interfaces on top of `GitHubReader`.
          github as GitHubDirectSummaryGateway &
            GitHubPendingReviewGateway &
            GitHubReader,
          // SAFETY: Date.prototype.toISOString() always returns a valid ISO
          // 8601 instant, satisfying the branded IsoTimestamp contract this
          // callback fills.
          () => new Date().toISOString() as never,
          reviewOperations,
          recentWriteJournals,
        )
      : undefined;
  const reviewRefresh = new ReviewRefreshService({
    profiles,
    reviews,
    sessions,
    remote: remoteReviews,
    github,
    preparation: reviewPreparation,
    // SAFETY: Date.prototype.toISOString() always returns a valid ISO 8601
    // instant, satisfying the branded IsoTimestamp contract this callback fills.
    now: () => new Date().toISOString() as never,
    operationCoordinator: reviewOperations,
    pendingReview: pendingReviews,
    recentWrites: recentWriteJournals,
    project: ({
      profileId,
      sessionId,
      snapshot,
      refreshedAt,
      freshness,
      pendingReview,
    }) => {
      const projectInput = { profileId, sessionId, snapshot, refreshedAt, freshness };
      return reviewProjection.loadRepresented(
        pendingReview === undefined
          ? projectInput
          : { ...projectInput, pendingReview },
      );
    },
  });
  const reviewObservation = new ReviewObservationService({
    profiles,
    reviews,
    sessions,
    remote: remoteReviews,
    journals: observationJournals,
    recentWrites: recentWriteJournals,
    github: pendingReviewGateway,
    pendingReview: pendingReviews,
    coordinator: reviewOperations,
    // SAFETY: Date.prototype.toISOString() always returns a valid ISO 8601
    // instant, satisfying the branded IsoTimestamp contract this callback fills.
    now: () => new Date().toISOString() as never,
    project: ({
      profileId,
      sessionId,
      snapshot,
      refreshedAt,
      freshness,
      pendingReview,
    }) =>
      reviewProjection.loadRepresented({
        profileId,
        sessionId,
        snapshot,
        refreshedAt,
        freshness,
        pendingReview,
      }),
  });

  {
    for (const profile of configuredProfiles.value) {
      const journals = await observationJournals.listReviewIds(profile.id);
      if (journals._tag === "err") return { _tag: "recovery-failed" };
      for (const reviewId of journals.value) {
        const recovered = await reviewObservation.recover({
          profileId: profile.id,
          reviewId,
        });
        if (recovered._tag === "err") return { _tag: "recovery-failed" };
      }
    }
  }
  await recovery.reconcile();
  logs.write({
    process: "main",
    level: "info",
    topic: "lifecycle",
    message: "Local API started",
  });

  const publishedFeedback = new PublishedFeedbackService(
    reviewWriteGate,
    github,
    reviewOperations,
    async ({ profileId, reviewId }) => {
      const refreshed = await reviewRefresh.refresh({ profileId, reviewId });
      return refreshed._tag === "ok" ? ok(undefined) : err(refreshed.error);
    },
  );
  const reviewCommits = new ReviewCommitService(
    reviews,
    remoteReviews,
    sessions,
    readOnlyGit,
  );
  const reviewDiffSources = new ReviewDiffSourceService(
    profiles,
    sessions,
    configuration.readOnlyGit ?? readOnlyGit,
  );
  const reviewWorkbench = new ReviewWorkbenchController(
    reviewPreparation,
    reviewProjection,
    {
      reviews,
      sessions,
      artifacts: storageArtifacts,
      remote: remoteReviews,
      journals: observationJournals,
      recentWrites: recentWriteJournals,
      coordinator: reviewOperations,
      refresh: reviewRefresh,
      observation: reviewObservation,
      commits: reviewCommits,
    },
  );
  const merger =
    configuration.mergeWriter ??
    (isGitHubMergeWriter(github) ? github : undefined);
  const mergeWrites =
    merger === undefined
      ? undefined
      : new MergeWriteController(
          {
            getMergePolicy: github.getMergePolicy.bind(github),
            getPullRequest: github.getPullRequest.bind(github),
            getPullRequestDiff: github.getPullRequestDiff.bind(github),
            mergePullRequest: merger.mergePullRequest.bind(merger),
          },
          ["squash", "merge", "rebase"],
          // SAFETY: Date.prototype.toISOString() always returns a valid ISO
          // 8601 instant, satisfying the branded IsoTimestamp contract this
          // callback fills.
          () => new Date().toISOString() as never,
          new MergeOperationStore(paths),
          reviewWriteGate,
          reviews,
          reviewOperations,
        );
  app.get("/v1/profiles", async (context) => {
    const result = await dashboard.listProfiles();
    if (result._tag === "err")
      await recordProfileReloadFailure("profile-reload-list");
    return response(context, result);
  });
  app.post("/v1/profiles", async (context) =>
    response(context, await dashboard.saveProfile(await jsonBody(context))),
  );
  app.put("/v1/profiles", async (context) =>
    response(context, await dashboard.saveProfile(await jsonBody(context))),
  );
  app.post("/v1/profiles/select", async (context) => {
    const body = await jsonBody(context);
    const id = readObjectField(body, "id");
    const selected = await dashboard.selectProfile(id);
    if (selected._tag === "err") {
      const profileId = parseWorkspaceProfileId(id);
      if (profileId._tag === "ok") {
        await diagnostics.record({
          profileId: profileId.value,
          category: "recovery",
          phase: "profile-switch",
          retryable: true,
          detail: "Profile selection failed.",
        });
      }
    }
    return response(context, selected);
  });
  app.get("/v1/settings", async (context) =>
    response(context, await dashboard.getSettings()),
  );
  app.patch("/v1/settings", async (context) =>
    response(context, await dashboard.updateSettings(await jsonBody(context))),
  );
  app.get("/v1/inbox", async (context) => {
    const result = await dashboard.inboxForActiveProfile();
    if (result._tag === "err")
      await recordProfileReloadFailure("profile-reload-inbox");
    return response(context, result);
  });
  app.post("/v1/watchlist", async (context) =>
    response(
      context,
      await dashboard.addWatchlistRepo(await jsonBody(context)),
    ),
  );
  app.patch("/v1/watchlist/path", async (context) =>
    response(context, await dashboard.setLocalPath(await jsonBody(context))),
  );
  app.delete("/v1/watchlist", async (context) =>
    response(
      context,
      await dashboard.removeWatchlistRepo(await jsonBody(context)),
    ),
  );

  app.get("/v1/watchlist/suggestions", async (context) =>
    response(context, await dashboard.discoverWorkspaceRepos()),
  );
  app.post("/v1/github/access", async (context) =>
    response(context, await dashboard.testGitHubAccess()),
  );
  app.get("/v1/environment", async (context) => {
    const [git, gh, ghAuth] = await Promise.all([
      commands.runText({ argv: ["git", "--version"], timeoutMs: 5_000 }),
      commands.runText({ argv: ["gh", "--version"], timeoutMs: 5_000 }),
      commands.runText({ argv: ["gh", "auth", "status"], timeoutMs: 10_000 }),
    ]);
    return context.json({
      ...(parsedConfiguration.output.appMetadata ?? {
        productName: "Patchdesk",
        version: "development",
        architecture: process.arch,
        distribution: "development" as const,
      }),
      git: git._tag === "ok" ? "ready" : "missing",
      gh: gh._tag === "ok" ? "ready" : "missing",
      githubAuth:
        ghAuth._tag === "ok"
          ? "ready"
          : ghAuth.error._tag === "CommandAuthenticationRequired"
            ? "authentication_required"
            : "unavailable",
      runtime: "bundled",
    });
  });
  app.post("/v1/direct-entry/preview", async (context) => {
    const body = await jsonBody(context);
    return body === undefined
      ? context.json({ error: "invalid_input" }, 400)
      : response(context, await dashboard.previewDirectEntry(body));
  });
  app.post("/v1/reviews/inline-conversations/command", async (context) =>
    inlineConversationResponse(
      context,
      inlineConversations,
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/pending-review/command", async (context) =>
    pendingReviewCommandResponse(
      context,
      pendingReviews,
      sessions,
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/pending-review/recover", async (context) =>
    pendingReviewRecoverResponse(
      context,
      pendingReviews,
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/direct-summary/submit", async (context) =>
    directSummarySubmitResponse(
      context,
      directSummaryReviews,
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/direct-summary/recover", async (context) =>
    directSummaryRecoverResponse(
      context,
      directSummaryReviews,
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/published-comments/edit", async (context) =>
    publishedFeedbackResponse(
      context,
      publishedFeedback,
      "edit",
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/published-comments/delete", async (context) =>
    publishedFeedbackResponse(
      context,
      publishedFeedback,
      "delete",
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/published-reviews/dismiss", async (context) =>
    publishedFeedbackResponse(
      context,
      publishedFeedback,
      "dismiss",
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/open", async (context) => {
    const parsed = safeParse(reviewOpenSchema, await jsonBody(context));
    return parsed.success
      ? response(context, await reviewWorkbench.open(parsed.output))
      : context.json({ error: "invalid_input" }, 400);
  });
  app.post("/v1/reviews/load", async (context) => {
    const parsed = safeParse(reviewLoadSchema, await jsonBody(context));
    return parsed.success
      ? response(context, await reviewWorkbench.load(parsed.output))
      : context.json({ error: "invalid_input" }, 400);
  });
  app.post("/v1/reviews/merge/recover", async (context) => {
    const parsed = safeParse(reviewLoadSchema, await jsonBody(context));
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    const reviewId = parseReviewId(parsed.output.reviewId);
    if (profileId._tag === "err" || reviewId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    const reconciled = await recovery.reconcileReview(
      profileId.value,
      reviewId.value,
    );
    if (reconciled.failed > 0)
      return context.json({ error: "outcome_unknown" }, 409);
    return response(context, await reviewWorkbench.load(parsed.output));
  });
  app.get("/v1/insight-providers", async (context) => {
    if (configuration.insightProviders === undefined)
      return context.json({ error: "provider_unavailable" }, 503);
    return response(context, await configuration.insightProviders.passive());
  });
  app.post("/v1/insight-providers/codex/models", async (context) => {
    if (configuration.insightProviders === undefined)
      return context.json({ error: "provider_unavailable" }, 503);
    return response(
      context,
      await configuration.insightProviders.activateCodex(),
    );
  });
  app.post("/v1/reviews/insights/analysis/run", async (context) =>
    insightRunResponse(
      context,
      configuration.insights,
      "analysis",
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/insights/walkthrough/run", async (context) =>
    insightRunResponse(
      context,
      configuration.insights,
      "walkthrough",
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/insights/analysis/cancel", async (context) =>
    insightCancelResponse(
      context,
      configuration.insights,
      "analysis",
      await jsonBody(context),
    ),
  );
  app.post("/v1/reviews/insights/walkthrough/cancel", async (context) =>
    insightCancelResponse(
      context,
      configuration.insights,
      "walkthrough",
      await jsonBody(context),
    ),
  );
  app.post(
    "/v1/reviews/insights/analysis/findings/:findingId/dismiss",
    async (context) =>
      insightFindingResponse(
        context,
        configuration.insights,
        "dismiss",
        context.req.param("findingId"),
        await jsonBody(context),
      ),
  );
  app.post("/v1/reviews/insights/walkthrough/progress", async (context) =>
    insightWalkthroughProgressResponse(
      context,
      configuration.insights,
      await jsonBody(context),
    ),
  );
  app.get("/v1/reviews/insights/runs/:runId", async (context) => {
    if (configuration.insights === undefined)
      return context.json({ error: "workflow_unavailable" }, 503);
    const profileId = parseWorkspaceProfileId(context.req.query("profileId"));
    const reviewId = parseReviewId(context.req.query("reviewId"));
    const runId = parseInsightRunId(context.req.param("runId"));
    const type = parseInsightType(context.req.query("type"));
    if (
      profileId._tag === "err" ||
      reviewId._tag === "err" ||
      runId._tag === "err" ||
      type === undefined
    )
      return context.json({ error: "invalid_input" }, 400);
    return insightResultResponse(
      context,
      await configuration.insights.observe({
        profileId: profileId.value,
        reviewId: reviewId.value,
        type,
        runId: runId.value,
      }),
    );
  });
  app.post("/v1/reviews/detect-updates", async (context) => {
    const parsed = safeParse(reviewUpdateSchema, await jsonBody(context));
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    // The route is the sole authority for detection-request parsing: typed
    // ids are refined here, and the controller receives only typed input.
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    const reviewId = parseReviewId(parsed.output.reviewId);
    if (profileId._tag === "err" || reviewId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    const recentWrites: Array<RecentReviewWrite> = [];
    for (const entry of parsed.output.recentWrites ?? []) {
      if (entry._tag === "Comment") {
        recentWrites.push(
          entry.reviewId === undefined
            ? { _tag: "Comment", commentId: entry.commentId }
            : {
                _tag: "Comment",
                commentId: entry.commentId,
                reviewId: entry.reviewId,
              },
        );
      } else if (entry._tag === "PendingThread") {
        const parsedThreadId = parseGitHubThreadId(entry.threadId);
        if (parsedThreadId._tag === "err")
          return context.json({ error: "invalid_input" }, 400);
        recentWrites.push({
          _tag: "PendingThread",
          threadId: parsedThreadId.value,
        });
      } else if (entry._tag === "ThreadState") {
        const parsedThreadId = parseGitHubThreadId(entry.threadId);
        if (parsedThreadId._tag === "err")
          return context.json({ error: "invalid_input" }, 400);
        recentWrites.push({
          _tag: "ThreadState",
          threadId: parsedThreadId.value,
          state: entry.state,
        });
      } else {
        recentWrites.push({
          _tag: "DirectSummaryReview",
          reviewId: entry.reviewId,
        });
      }
    }
    const detectUpdatesInput = {
      profileId: profileId.value,
      reviewId: reviewId.value,
    };
    return response(
      context,
      await reviewWorkbench.detectUpdates(
        recentWrites.length === 0
          ? detectUpdatesInput
          : { ...detectUpdatesInput, recentWrites },
      ),
    );
  });
  app.post("/v1/reviews/refresh", async (context) => {
    const parsed = safeParse(reviewUpdateSchema, await jsonBody(context));
    return parsed.success
      ? response(context, await reviewWorkbench.refresh(parsed.output))
      : context.json({ error: "invalid_input" }, 400);
  });
  app.post("/v1/reviews/commit-diff", async (context) => {
    const parsed = safeParse(reviewCommitDiffSchema, await jsonBody(context));
    return parsed.success
      ? response(context, await reviewWorkbench.commitDiff(parsed.output))
      : context.json({ error: "invalid_input" }, 400);
  });
  app.post("/v1/reviews/diff-file", async (context) =>
    response(context, await reviewDiffSources.load(await jsonBody(context))),
  );
  app.post("/v1/reviews/merge", async (context) =>
    mergeWrites === undefined
      ? context.json({ error: "merge_unavailable" }, 503)
      : response(context, await mergeWrites.merge(await jsonBody(context))),
  );
  const storageCleanup = async (
    context: Context,
    action: "cache" | "local-data",
  ): Promise<Response> => {
    const body = await jsonBody(context);
    const parsed = safeParse(
      object({ profileId: pipe(string(), minLength(1)) }),
      body,
    );
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    if (profileId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    return storageResponse(
      context,
      action === "cache"
        ? await storageManagement.clearCache(profileId.value)
        : await storageManagement.clearLocalData(profileId.value),
    );
  };
  app.post("/v1/storage/cache/clear", async (context) =>
    storageCleanup(context, "cache"),
  );
  app.post("/v1/storage/clear-local-data", async (context) =>
    storageCleanup(context, "local-data"),
  );
  app.get("/v1/logs", async (context) => {
    const rawAfter = context.req.query("after");
    const rawLimit = context.req.query("limit");
    const after =
      rawAfter === undefined || !/^\d+$/.test(rawAfter)
        ? undefined
        : Number(rawAfter);
    const limit =
      rawLimit === undefined || !/^\d+$/.test(rawLimit)
        ? undefined
        : Number(rawLimit);
    return context.json(logs.tail(after, limit));
  });
  app.post("/v1/logs", async (context) => {
    const body = await jsonBody(context);
    const parsed = safeParse(object({ entries: array(unknown()) }), body);
    if (!parsed.success || parsed.output.entries.length === 0) {
      return context.json({ error: "invalid_input" }, 400);
    }
    let accepted = 0;
    for (const raw of parsed.output.entries.slice(0, 100)) {
      const candidate = safeParse(rendererLogEntrySchema, raw);
      if (!candidate.success) continue;
      const optionalLogFields: {
        -readonly [K in
          | "meta"
          | "profileId"
          | "sessionId"
          | "correlationId"]?: LogEntryInput[K];
      } = {};
      if (candidate.output.meta !== undefined)
        optionalLogFields.meta = candidate.output.meta;
      if (candidate.output.profileId !== undefined)
        optionalLogFields.profileId = candidate.output.profileId;
      if (candidate.output.sessionId !== undefined)
        optionalLogFields.sessionId = candidate.output.sessionId;
      if (candidate.output.correlationId !== undefined)
        optionalLogFields.correlationId = candidate.output.correlationId;
      logs.write({
        process: "renderer",
        level: candidate.output.level,
        topic: candidate.output.topic,
        message: candidate.output.message,
        ...optionalLogFields,
      });
      accepted += 1;
    }
    return context.json({ accepted });
  });
  app.get("/v1/diagnostics", async (context) => {
    const profileId = parseWorkspaceProfileId(context.req.query("profileId"));
    if (profileId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    const events = await diagnostics.recent(profileId.value);
    return events._tag === "ok"
      ? context.json({ events: events.value })
      : context.json({ error: "diagnostics_unavailable" }, 503);
  });
  app.post("/v1/diagnostics/support-bundle", async (context) => {
    const body = await jsonBody(context);
    const parsed = safeParse(
      object({
        profileId: pipe(string(), minLength(1)),
        sessionId: optional(pipe(string(), minLength(1))),
      }),
      body,
    );
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    if (profileId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    const sessionId =
      parsed.output.sessionId === undefined
        ? undefined
        : parseReviewSessionId(parsed.output.sessionId);
    if (sessionId?._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    const bundle = await diagnostics.exportSupportBundle(
      sessionId?._tag === "ok"
        ? { profileId: profileId.value, sessionId: sessionId.value }
        : { profileId: profileId.value },
    );
    return bundle._tag === "ok"
      ? context.json(bundle.value)
      : context.json({ error: "diagnostics_unavailable" }, 503);
  });

  const { server, port } = await listenOnLoopback(app);
  const url = new URL(`http://${localhostHostname}:${port}/`);

  scheduleRetentionSweeps(
    configuredProfiles.value,
    storageManagement,
    configuration.retentionSweep ?? false,
    diagnostics,
  );

  return {
    _tag: "started",
    server: {
      capability: parsedConfiguration.output.capability,
      url,
      async stop(): Promise<void> {
        await closeServer(server);
      },
    },
  };
}

/** Retention sweep interval once per 24 hours while the app runs. */
export const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Runs the retention sweep once immediately after the local API starts and
 * again once per 24 hours. Fire-and-forget: failures never surface to the
 * caller, and an unref'd timer never holds the app or tests open.
 */
function scheduleRetentionSweeps(
  profiles: ReadonlyArray<{ readonly id: WorkspaceProfileId }>,
  storageManagement: StorageManagementService,
  enabled: boolean,
  diagnostics: Pick<ReviewDiagnosticService, "record"> | undefined,
): void {
  if (!enabled) return;
  const run = (): void => {
    for (const profile of profiles) {
      void storageManagement
        .sweepRetained(profile.id)
        .then((result) => {
          if (result._tag === "err") {
            void diagnostics?.record({
              profileId: profile.id,
              category: "cleanup",
              phase: "retention_sweep",
              retryable: true,
              detail: "profile sweep failed",
            });
          }
        })
        .catch(() => {});
    }
  };
  run();
  const timer = setInterval(run, RETENTION_SWEEP_INTERVAL_MS);
  timer.unref();
}

const rendererLogEntrySchema = strictObject({
  level: picklist(["debug", "info", "warn", "error"]),
  topic: pipe(string(), minLength(1), maxLength(48)),
  message: pipe(string(), minLength(1), maxLength(512)),
  meta: optional(record(string(), unknown())),
  profileId: optional(pipe(string(), minLength(1), maxLength(180))),
  sessionId: optional(pipe(string(), minLength(1), maxLength(180))),
  correlationId: optional(pipe(string(), minLength(1), maxLength(120))),
});

/** Logs every authenticated loopback request; the log endpoints and health never log themselves. */
function logLocalApiRequests(
  logs: Pick<AppLogService, "write">,
): MiddlewareHandler {
  return async (context, next) => {
    const startedAt = performance.now();
    await next();
    const path = context.req.path;
    if (path === "/health" || path === "/v1/logs") return;
    const status = context.res.status;
    const durationMs = Math.round(performance.now() - startedAt);
    const correlationId = context.req.header("x-patchdesk-correlation-id");
    const meta =
      correlationId === undefined
        ? { status, durationMs }
        : { status, durationMs, correlationId };
    logs.write({
      process: "main",
      level: status >= 500 ? "error" : status >= 400 ? "warn" : "debug",
      topic: "http",
      message: `${context.req.method} ${path}`,
      meta,
    });
  };
}

function corsForRenderer(
  configuration: LocalApiConfiguration,
): MiddlewareHandler {
  return async (context, next) => {
    const origin = context.req.header("Origin");
    if (isAllowedOrigin(configuration, origin)) {
      context.header("Access-Control-Allow-Origin", origin);
      context.header("Vary", "Origin");
      context.header(
        "Access-Control-Allow-Headers",
        `Content-Type, ${APP_CAPABILITY_HEADER}`,
      );
      context.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      );
    }
    if (context.req.method === "OPTIONS") return context.body(null, 204);
    await next();
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- this is the server's one raw HTTP-body I/O boundary; each route handler runs its own schema against the result immediately, so there is no single concrete type to return here.
async function jsonBody(context: Context): Promise<unknown> {
  const maximumBytes = 1024 * 1024;
  const declaredLength = Number(context.req.header("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes)
    return undefined;
  const stream = context.req.raw.body;
  if (stream === null) return undefined;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    // SAFETY: JSON.parse's return type is `any`; this cast narrows it to
    // `unknown` so every caller must validate the parsed body before use.
    return JSON.parse(new TextDecoder().decode(combined)) as unknown;
  } catch {
    return undefined;
  }
}

function isGitHubDirectSummaryGateway(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- structural capability detection on the already-constructed internal `github` adapter, not external/untrusted input; there is no earlier I/O boundary to parse at.
  value: unknown,
): value is GitHubDirectSummaryGateway {
  return (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows an internal adapter object for optional-capability `in` checks below; not external input to decode.
    typeof value === "object" &&
    value !== null &&
    "getViewerDirectSummaryReviews" in value &&
    "createDirectSummaryReview" in value
  );
}
function isGitHubPendingReviewGateway(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- structural capability detection on the already-constructed internal `github` adapter, not external/untrusted input; there is no earlier I/O boundary to parse at.
  value: unknown,
): value is GitHubPendingReviewGateway & GitHubReader & GitHubReviewWriter {
  return (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows an internal adapter object for optional-capability `in` checks below; not external input to decode.
    typeof value === "object" &&
    value !== null &&
    "getViewerPendingReview" in value &&
    "startPendingReviewWithThread" in value &&
    "addPendingReviewThread" in value &&
    "submitPendingReview" in value &&
    "resolveAuthenticatedAccount" in value
  );
}
function isGitHubMergeWriter(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- structural capability detection on the already-constructed internal `merger` adapter, not external/untrusted input; there is no earlier I/O boundary to parse at.
  value: unknown,
): value is GitHubMergeWriter {
  return (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows an internal adapter object for an optional-capability `in` check below; not external input to decode.
    typeof value === "object" && value !== null && "mergePullRequest" in value
  );
}

type PendingReviewCommandDto =
  | {
      readonly _tag: "Start";
      readonly expected: ReviewWriteExpectation;
      readonly anchor: PendingReviewAnchor;
      readonly body: string;
      readonly finding?: FindingReviewSource;
    }
  | {
      readonly _tag: "AddThread";
      readonly expected: ReviewWriteExpectation;
      readonly pendingReviewNodeId: GitHubReviewNodeId;
      readonly anchor: PendingReviewAnchor;
      readonly body: string;
      readonly finding?: FindingReviewSource;
    }
  | {
      readonly _tag: "Submit";
      readonly expected: ReviewWriteExpectation;
      readonly event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
      readonly summaryBody: string;
    }
  | {
      readonly _tag: "Discard";
      readonly expected: ReviewWriteExpectation;
      readonly confirmation: true;
    };

async function pendingReviewCommandResponse(
  context: Context,
  service: PendingReviewService | undefined,
  sessions: ReviewSessionStore,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Response> {
  if (service === undefined)
    return context.json({ error: "review_write_unavailable" }, 503);
  const parsed = parsePendingReviewCommand(body);
  if (parsed === undefined)
    return context.json({ error: "invalid_input" }, 400);
  const result =
    parsed.command._tag === "Start"
      ? await service.start(
          parsed.command.finding === undefined
            ? {
                profileId: parsed.profileId,
                reviewId: parsed.reviewId,
                expected: parsed.command.expected,
                anchor: parsed.command.anchor,
                body: parsed.command.body,
              }
            : {
                profileId: parsed.profileId,
                reviewId: parsed.reviewId,
                expected: parsed.command.expected,
                anchor: parsed.command.anchor,
                body: parsed.command.body,
                finding: parsed.command.finding,
              },
        )
      : parsed.command._tag === "AddThread"
        ? await service.addThread(
            parsed.command.finding === undefined
              ? {
                  profileId: parsed.profileId,
                  reviewId: parsed.reviewId,
                  expected: parsed.command.expected,
                  pendingReviewNodeId: parsed.command.pendingReviewNodeId,
                  anchor: parsed.command.anchor,
                  body: parsed.command.body,
                }
              : {
                  profileId: parsed.profileId,
                  reviewId: parsed.reviewId,
                  expected: parsed.command.expected,
                  pendingReviewNodeId: parsed.command.pendingReviewNodeId,
                  anchor: parsed.command.anchor,
                  body: parsed.command.body,
                  finding: parsed.command.finding,
                },
          )
        : parsed.command._tag === "Submit"
          ? await service.submit({
              profileId: parsed.profileId,
              reviewId: parsed.reviewId,
              expected: parsed.command.expected,
              event: parsed.command.event,
              summaryBody: parsed.command.summaryBody,
            })
          : await service.discard({
              profileId: parsed.profileId,
              reviewId: parsed.reviewId,
              expected: parsed.command.expected,
              confirmation: parsed.command.confirmation,
            });
  if (result._tag === "ok") {
    return context.json({
      pendingReview: projectPendingReview(result.value.state, false),
    });
  }
  const projection = await storedPendingReviewProjection(
    sessions,
    parsed.profileId,
    parsed.command.expected.sessionId,
  );
  return context.json(
    projection === undefined
      ? { error: result.error }
      : { error: result.error, pendingReview: projection },
    pendingReviewFailureStatus(result.error),
  );
}

async function pendingReviewRecoverResponse(
  context: Context,
  service: PendingReviewService | undefined,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Response> {
  if (service === undefined)
    return context.json({ error: "review_write_unavailable" }, 503);
  const profileId = parseWorkspaceProfileId(readObjectField(body, "profileId"));
  const reviewId = parseReviewId(readObjectField(body, "reviewId"));
  if (profileId._tag === "err" || reviewId._tag === "err")
    return context.json({ error: "invalid_input" }, 400);
  const result = await service.reconcile({
    profileId: profileId.value,
    reviewId: reviewId.value,
    recover: true,
  });
  if (result._tag === "ok") {
    return context.json({
      pendingReview: projectPendingReview(
        result.value.state,
        result.value.unavailable,
      ),
    });
  }
  return context.json(
    { error: result.error },
    pendingReviewFailureStatus(result.error),
  );
}

async function storedPendingReviewProjection(
  sessions: ReviewSessionStore,
  profileId: WorkspaceProfileId,
  sessionId: ReviewSessionId,
): Promise<PendingReviewProjection | undefined> {
  const loaded = await sessions.load(profileId, sessionId);
  if (loaded._tag === "err") return undefined;
  return projectPendingReview(
    loaded.value.pendingReview ?? { _tag: "None" },
    false,
  );
}

function pendingReviewFailureStatus(failure: string): 400 | 404 | 409 | 503 {
  if (failure === "invalid_input") return 400;
  if (failure === "not_found") return 404;
  if (
    failure === "not_fresh" ||
    failure === "stale_head" ||
    failure === "permission_denied" ||
    failure === "self_approval_not_allowed" ||
    failure === "rejected" ||
    failure === "review_write_in_progress" ||
    failure === "no_pending_review" ||
    failure === "pending_review_locked" ||
    failure === "pending_review_exists"
  )
    return 409;
  if (
    failure === "unavailable" ||
    failure === "outcome_unknown" ||
    failure === "rate_limited"
  )
    return 503;
  return 400;
}

async function directSummarySubmitResponse(
  context: Context,
  service: DirectSummaryReviewService | undefined,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Response> {
  if (service === undefined)
    return context.json({ error: "review_write_unavailable" }, 503);
  const parsed = parseDirectSummaryCommand(body);
  if (parsed === undefined)
    return context.json({ error: "invalid_input" }, 400);
  const result = await service.submit(parsed);
  return result._tag === "ok"
    ? context.json({ directSummary: projectDirectSummaryReview(result.value) })
    : context.json(
        { error: result.error },
        pendingReviewFailureStatus(result.error),
      );
}

async function directSummaryRecoverResponse(
  context: Context,
  service: DirectSummaryReviewService | undefined,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Response> {
  if (service === undefined)
    return context.json({ error: "review_write_unavailable" }, 503);
  const profileId = parseWorkspaceProfileId(readObjectField(body, "profileId"));
  const reviewId = parseReviewId(readObjectField(body, "reviewId"));
  if (profileId._tag === "err" || reviewId._tag === "err")
    return context.json({ error: "invalid_input" }, 400);
  const result = await service.reconcile({
    profileId: profileId.value,
    reviewId: reviewId.value,
  });
  return result._tag === "ok"
    ? context.json({ directSummary: projectDirectSummaryReview(result.value) })
    : context.json(
        { error: result.error },
        pendingReviewFailureStatus(result.error),
      );
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
function parseDirectSummaryCommand(body: unknown):
  | {
      readonly profileId: WorkspaceProfileId;
      readonly reviewId: ReviewId;
      readonly expected: ReviewWriteExpectation;
      readonly event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
      readonly body: string;
    }
  | undefined {
  const profileId = parseWorkspaceProfileId(readObjectField(body, "profileId"));
  const reviewId = parseReviewId(readObjectField(body, "reviewId"));
  const expected = parseReviewWriteExpectation(
    readObjectField(body, "expected"),
  );
  const event = readObjectField(body, "event");
  const summary = readObjectField(body, "body");
  if (
    profileId._tag === "err" ||
    reviewId._tag === "err" ||
    expected === undefined ||
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field (from readObjectField, typed unknown) at this exact I/O boundary; no earlier parser exists for this primitive shape.
    typeof summary !== "string" ||
    summary.trim().length === 0 ||
    (event !== "APPROVE" && event !== "COMMENT" && event !== "REQUEST_CHANGES")
  )
    return undefined;
  return {
    profileId: profileId.value,
    reviewId: reviewId.value,
    expected,
    event,
    body: summary,
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
function parsePendingReviewCommand(body: unknown):
  | {
      readonly profileId: WorkspaceProfileId;
      readonly reviewId: ReviewId;
      readonly command: PendingReviewCommandDto;
    }
  | undefined {
  const profileId = parseWorkspaceProfileId(readObjectField(body, "profileId"));
  const reviewId = parseReviewId(readObjectField(body, "reviewId"));
  const raw = readObjectField(body, "command");
  const tag = readObjectField(raw, "_tag");
  const expected = parseReviewWriteExpectation(
    readObjectField(raw, "expected"),
  );
  if (
    profileId._tag === "err" ||
    reviewId._tag === "err" ||
    tag === undefined ||
    expected === undefined
  )
    return undefined;
  if (tag === "Start" || tag === "AddThread") {
    const anchor = parsePendingReviewAnchor(readObjectField(raw, "anchor"));
    const bodyValue = readObjectField(raw, "body");
    if (
      anchor === undefined ||
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field (from readObjectField, typed unknown) at this exact I/O boundary; no earlier parser exists for this primitive shape.
      typeof bodyValue !== "string" ||
      bodyValue.trim().length === 0
    )
      return undefined;
    const finding = readObjectField(raw, "finding");
    const parsedFinding =
      finding === undefined ? undefined : parseFindingReviewSource(finding);
    if (finding !== undefined && parsedFinding === undefined) return undefined;
    if (tag === "Start")
      return {
        profileId: profileId.value,
        reviewId: reviewId.value,
        command:
          parsedFinding === undefined
            ? { _tag: "Start", expected, anchor, body: bodyValue }
            : {
                _tag: "Start",
                expected,
                anchor,
                body: bodyValue,
                finding: parsedFinding,
              },
      };
    const pendingReviewNodeId = readObjectField(raw, "pendingReviewNodeId");
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field (from readObjectField, typed unknown) at this exact I/O boundary; no earlier parser exists for this primitive shape.
    if (typeof pendingReviewNodeId !== "string") return undefined;
    const parsedNodeId = parseGitHubReviewNodeId(pendingReviewNodeId);
    if (parsedNodeId._tag === "err") return undefined;
    return {
      profileId: profileId.value,
      reviewId: reviewId.value,
      command:
        parsedFinding === undefined
          ? {
              _tag: "AddThread",
              expected,
              pendingReviewNodeId: parsedNodeId.value,
              anchor,
              body: bodyValue,
            }
          : {
              _tag: "AddThread",
              expected,
              pendingReviewNodeId: parsedNodeId.value,
              anchor,
              body: bodyValue,
              finding: parsedFinding,
            },
    };
  }
  if (tag === "Submit") {
    const event = readObjectField(raw, "event");
    const summaryBody = readObjectField(raw, "summaryBody");
    if (
      (event !== "APPROVE" &&
        event !== "COMMENT" &&
        event !== "REQUEST_CHANGES") ||
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field (from readObjectField, typed unknown) at this exact I/O boundary; no earlier parser exists for this primitive shape.
      typeof summaryBody !== "string"
    )
      return undefined;
    return {
      profileId: profileId.value,
      reviewId: reviewId.value,
      command: { _tag: "Submit", expected, event, summaryBody },
    };
  }
  if (tag === "Discard") {
    // Discard is destructive: the DTO must carry the explicit confirmation.
    if (readObjectField(raw, "confirmation") !== true) return undefined;
    return {
      profileId: profileId.value,
      reviewId: reviewId.value,
      command: { _tag: "Discard", expected, confirmation: true },
    };
  }
  return undefined;
}

function parseFindingReviewSource(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  raw: unknown,
): FindingReviewSource | undefined {
  const analysisRunId = parseInsightRunId(
    readObjectField(raw, "analysisRunId"),
  );
  const findingId = parseFindingId(readObjectField(raw, "findingId"));
  const sessionId = parseReviewSessionId(readObjectField(raw, "sessionId"));
  const headSha = parseGitSha(readObjectField(raw, "headSha"));
  const patchHash = parseContentHash(readObjectField(raw, "patchHash"));
  return analysisRunId._tag === "err" ||
    findingId._tag === "err" ||
    sessionId._tag === "err" ||
    headSha._tag === "err" ||
    patchHash._tag === "err"
    ? undefined
    : {
        analysisRunId: analysisRunId.value,
        findingId: findingId.value,
        sessionId: sessionId.value,
        headSha: headSha.value,
        patchHash: patchHash.value,
      };
}

function parseReviewWriteExpectation(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  raw: unknown,
): ReviewWriteExpectation | undefined {
  const sessionId = parseReviewSessionId(readObjectField(raw, "sessionId"));
  const headSha = parseGitSha(readObjectField(raw, "headSha"));
  const patchHash = parseContentHash(readObjectField(raw, "patchHash"));
  return sessionId._tag === "err" ||
    headSha._tag === "err" ||
    patchHash._tag === "err"
    ? undefined
    : {
        sessionId: sessionId.value,
        headSha: headSha.value,
        patchHash: patchHash.value,
      };
}

function parsePendingReviewAnchor(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  raw: unknown,
): PendingReviewAnchor | undefined {
  const path = readObjectField(raw, "path");
  const startLine = readObjectField(raw, "startLine");
  const line = readObjectField(raw, "line");
  const side = readObjectField(raw, "side");
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field (from readObjectField, typed unknown) at this exact I/O boundary; no earlier parser exists for this primitive shape.
    typeof path !== "string" ||
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field (from readObjectField, typed unknown) at this exact I/O boundary; no earlier parser exists for this primitive shape.
    typeof startLine !== "number" ||
    !Number.isInteger(startLine) ||
    startLine < 1 ||
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field (from readObjectField, typed unknown) at this exact I/O boundary; no earlier parser exists for this primitive shape.
    typeof line !== "number" ||
    !Number.isInteger(line) ||
    line < startLine ||
    (side !== "new" && side !== "old")
  )
    return undefined;
  const parsedPath = parseRepoRelativePath(path);
  if (parsedPath._tag === "err") return undefined;
  return { path: parsedPath.value, startLine, line, side };
}

async function inlineConversationResponse(
  context: Context,
  service: InlineConversationService,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Response> {
  const parsed = parseInlineConversationCommand(body);
  if (parsed === undefined)
    return context.json({ error: "invalid_input" }, 400);
  const result = await service.execute(parsed);
  if (result._tag === "ok") return context.json(result.value);
  const status =
    result.error === "not_found"
      ? 404
      : result.error === "not_fresh" ||
          result.error === "permission_denied" ||
          result.error === "confirmation_required" ||
          result.error === "pending_review" ||
          result.error === "review_write_in_progress"
        ? 409
        : result.error === "github_read_failed" ||
            result.error === "github_write_failed" ||
            result.error === "rate_limited"
          ? 503
          : 400;
  return context.json({ error: result.error }, status);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
function parseInlineConversationCommand(body: unknown):
  | {
      readonly profileId: WorkspaceProfileId;
      readonly reviewId: ReviewId;
      readonly command: DirectConversationCommand;
    }
  | undefined {
  const profileId = parseWorkspaceProfileId(readObjectField(body, "profileId"));
  const reviewId = parseReviewId(readObjectField(body, "reviewId"));
  const raw = readObjectField(body, "command");
  const tag = readObjectField(raw, "_tag");
  const expectedRaw = readObjectField(raw, "expected");
  const sessionId = parseReviewSessionId(
    readObjectField(expectedRaw, "sessionId"),
  );
  const headSha = parseGitSha(readObjectField(expectedRaw, "headSha"));
  const patchHash = parseContentHash(readObjectField(expectedRaw, "patchHash"));
  if (
    profileId._tag === "err" ||
    reviewId._tag === "err" ||
    sessionId._tag === "err" ||
    headSha._tag === "err" ||
    patchHash._tag === "err" ||
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field (from readObjectField, typed unknown) at this exact I/O boundary; no earlier parser exists for this primitive shape.
    typeof tag !== "string"
  ) {
    console.error("Inline conversation command parse failed", {
      profileOk: profileId._tag,
      reviewOk: reviewId._tag,
      sessionOk: sessionId._tag,
      headShaOk: headSha._tag,
      patchHashOk: patchHash._tag,
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- reads the runtime type name for a diagnostic log message only, not to narrow/validate the value.
      tagType: typeof tag,
      rawCommand: JSON.stringify(raw),
    });
    return undefined;
  }
  const expected = {
    sessionId: sessionId.value,
    headSha: headSha.value,
    patchHash: patchHash.value,
  };
  const value = (name: string): string | undefined => {
    const candidate = readObjectField(raw, name);
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field (from readObjectField, typed unknown) at this exact I/O boundary; no earlier parser exists for this primitive shape.
    return typeof candidate === "string" ? candidate : undefined;
  };
  let command: DirectConversationCommand | undefined;
  if (tag === "CreateComment") {
    const anchor = readObjectField(raw, "anchor");
    const path = readObjectField(anchor, "path");
    const startLine = readObjectField(anchor, "startLine");
    const line = readObjectField(anchor, "line");
    const side = readObjectField(anchor, "side");
    const bodyValue = value("body");
    if (
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field (from readObjectField, typed unknown) at this exact I/O boundary; no earlier parser exists for this primitive shape.
      typeof path === "string" &&
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field (from readObjectField, typed unknown) at this exact I/O boundary; no earlier parser exists for this primitive shape.
      typeof startLine === "number" &&
      Number.isInteger(startLine) &&
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field (from readObjectField, typed unknown) at this exact I/O boundary; no earlier parser exists for this primitive shape.
      typeof line === "number" &&
      Number.isInteger(line) &&
      (side === "new" || side === "old") &&
      bodyValue !== undefined
    )
      command = {
        _tag: "CreateComment",
        expected,
        anchor: { path, startLine, line, side },
        body: bodyValue,
      };
  } else if (tag === "Reply") {
    const threadId = value("threadId");
    const bodyValue = value("body");
    if (
      threadId !== undefined &&
      parseGitHubThreadId(threadId)._tag === "ok" &&
      bodyValue !== undefined
    )
      command = { _tag: "Reply", expected, threadId, body: bodyValue };
  } else if (tag === "SetThreadState") {
    const threadId = value("threadId");
    const state = readObjectField(raw, "state");
    if (
      threadId !== undefined &&
      parseGitHubThreadId(threadId)._tag === "ok" &&
      (state === "open" || state === "resolved")
    )
      command = { _tag: "SetThreadState", expected, threadId, state };
  } else if (tag === "EditComment") {
    const commentId = value("commentId");
    const bodyValue = value("body");
    if (commentId !== undefined && bodyValue !== undefined)
      command = { _tag: "EditComment", expected, commentId, body: bodyValue };
  } else if (tag === "DeleteComment") {
    const commentId = value("commentId");
    const confirmation = readObjectField(raw, "confirmation");
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field (from readObjectField, typed unknown) at this exact I/O boundary; no earlier parser exists for this primitive shape.
    if (commentId !== undefined && typeof confirmation === "boolean")
      command = { _tag: "DeleteComment", expected, commentId, confirmation };
  }
  return command === undefined
    ? undefined
    : { profileId: profileId.value, reviewId: reviewId.value, command };
}

async function publishedFeedbackResponse(
  context: Context,
  service: PublishedFeedbackService,
  action: "edit" | "delete" | "dismiss",
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Response> {
  const result =
    action === "edit"
      ? await parsePublishedEdit(service, body)
      : action === "delete"
        ? await parsePublishedDelete(service, body)
        : await parsePublishedDismiss(service, body);
  if (result._tag === "err") {
    if (result.error === "invalid_input")
      return context.json({ error: result.error }, 400);
    const status =
      result.error === "not_found"
        ? 404
        : result.error === "not_fresh" ||
            result.error === "confirmation_required" ||
            result.error === "permission_denied"
          ? 409
          : result.error === "github_read_failed" ||
              result.error === "refresh_required"
            ? 503
            : 400;
    return context.json({ error: result.error }, status);
  }
  return context.json({ status: "ok" });
}

async function parsePublishedEdit(
  service: PublishedFeedbackService,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Result<void, "invalid_input" | PublishedFeedbackFailure>> {
  const parsed = safeParse(publishedCommentEditSchema, body);
  if (!parsed.success) return err("invalid_input");
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  return profileId._tag === "err" || reviewId._tag === "err"
    ? err("invalid_input")
    : service.editComment({
        profileId: profileId.value,
        reviewId: reviewId.value,
        commentId: parsed.output.commentId,
        body: parsed.output.body,
      });
}

async function parsePublishedDelete(
  service: PublishedFeedbackService,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Result<void, "invalid_input" | PublishedFeedbackFailure>> {
  const parsed = safeParse(publishedCommentDeleteSchema, body);
  if (!parsed.success) return err("invalid_input");
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  return profileId._tag === "err" || reviewId._tag === "err"
    ? err("invalid_input")
    : service.deleteComment({
        profileId: profileId.value,
        reviewId: reviewId.value,
        commentId: parsed.output.commentId,
        confirmation: parsed.output.confirmation,
      });
}

async function parsePublishedDismiss(
  service: PublishedFeedbackService,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Result<void, "invalid_input" | PublishedFeedbackFailure>> {
  const parsed = safeParse(publishedReviewDismissSchema, body);
  if (!parsed.success) return err("invalid_input");
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  return profileId._tag === "err" || reviewId._tag === "err"
    ? err("invalid_input")
    : service.dismissReview({
        profileId: profileId.value,
        reviewId: reviewId.value,
        publishedReviewId: parsed.output.publishedReviewId,
        message: parsed.output.message,
        confirmation: parsed.output.confirmation,
      });
}

async function insightRunResponse(
  context: Context,
  coordinator: LocalApiConfiguration["insights"],
  type: InsightType,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Response> {
  if (coordinator === undefined)
    return context.json({ error: "workflow_unavailable" }, 503);
  const parsed = safeParse(insightRunSchema, body);
  if (!parsed.success || parsed.output.type !== type)
    return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  if (profileId._tag === "err" || reviewId._tag === "err")
    return context.json({ error: "invalid_input" }, 400);
  const result = await coordinator.start({
    profileId: profileId.value,
    reviewId: reviewId.value,
    type,
    provider: parsed.output.provider,
    model: parsed.output.model,
    reasoning: parsed.output.reasoning,
  });
  return insightResultResponse(context, result, 202);
}

async function insightCancelResponse(
  context: Context,
  coordinator: LocalApiConfiguration["insights"],
  type: InsightType,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Response> {
  if (coordinator === undefined)
    return context.json({ error: "workflow_unavailable" }, 503);
  const parsed = safeParse(insightCancelSchema, body);
  if (!parsed.success || parsed.output.type !== type)
    return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  const runId = parseInsightRunId(parsed.output.runId);
  if (
    profileId._tag === "err" ||
    reviewId._tag === "err" ||
    runId._tag === "err"
  )
    return context.json({ error: "invalid_input" }, 400);
  const result = await coordinator.cancel({
    profileId: profileId.value,
    reviewId: reviewId.value,
    type,
    runId: runId.value,
  });
  return insightResultResponse(context, result);
}

function insightResultResponse(
  context: Context,
  result:
    | Awaited<
        ReturnType<NonNullable<LocalApiConfiguration["insights"]>["observe"]>
      >
    | Awaited<
        ReturnType<NonNullable<LocalApiConfiguration["insights"]>["start"]>
      >
    | Awaited<
        ReturnType<NonNullable<LocalApiConfiguration["insights"]>["cancel"]>
      >
    | Awaited<
        ReturnType<
          NonNullable<LocalApiConfiguration["insights"]>["dismissFinding"]
        >
      >
    | Awaited<ReturnType<InsightRunCoordinator["updateWalkthroughProgress"]>>,
  successStatus: 200 | 202 = 200,
): Response {
  if (result._tag === "ok") return context.json(result.value, successStatus);
  const status =
    result.error === "invalid_request" || result.error === "model_unavailable"
      ? 400
      : result.error === "ownership_mismatch"
        ? 403
        : result.error === "not_found"
          ? 404
          : result.error === "terminal_review" ||
              result.error === "already_running" ||
              result.error === "not_active" ||
              result.error === "stale_request" ||
              result.error === "not_available"
            ? 409
            : 503;
  return context.json({ error: result.error }, status);
}

async function insightWalkthroughProgressResponse(
  context: Context,
  coordinator: LocalApiConfiguration["insights"],
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Response> {
  if (
    coordinator === undefined ||
    coordinator.updateWalkthroughProgress === undefined
  )
    return context.json({ error: "workflow_unavailable" }, 503);
  const parsed = safeParse(
    strictObject({
      profileId: string(),
      reviewId: string(),
      runId: string(),
      reviewedSectionIds: array(string()),
      supportReviewed: boolean(),
      currentSectionId: optional(string()),
    }),
    body,
  );
  if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  const runId = parseInsightRunId(parsed.output.runId);
  if (
    profileId._tag === "err" ||
    reviewId._tag === "err" ||
    runId._tag === "err"
  )
    return context.json({ error: "invalid_input" }, 400);
  const progress =
    parsed.output.currentSectionId === undefined
      ? {
          reviewedSectionIds: parsed.output.reviewedSectionIds,
          supportReviewed: parsed.output.supportReviewed,
        }
      : {
          reviewedSectionIds: parsed.output.reviewedSectionIds,
          supportReviewed: parsed.output.supportReviewed,
          currentSectionId: parsed.output.currentSectionId,
        };
  const result = await coordinator.updateWalkthroughProgress({
    profileId: profileId.value,
    reviewId: reviewId.value,
    runId: runId.value,
    progress,
  });
  return insightResultResponse(context, result);
}

async function insightFindingResponse(
  context: Context,
  coordinator: LocalApiConfiguration["insights"],
  action: "dismiss",
  findingIdInput: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Response> {
  if (coordinator === undefined)
    return context.json({ error: "workflow_unavailable" }, 503);
  const parsed = safeParse(insightFindingSchema, body);
  const findingId = parseFindingId(findingIdInput);
  if (
    !parsed.success ||
    findingId._tag === "err" ||
    (action === "dismiss" && parsed.output.reason === undefined)
  )
    return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  const runId = parseInsightRunId(parsed.output.runId);
  if (
    profileId._tag === "err" ||
    reviewId._tag === "err" ||
    runId._tag === "err"
  )
    return context.json({ error: "invalid_input" }, 400);
  const result =
    coordinator.dismissFinding === undefined
      ? err("storage_unavailable" as const)
      : await coordinator.dismissFinding({
          profileId: profileId.value,
          reviewId: reviewId.value,
          runId: runId.value,
          findingId: findingId.value,
          reason: parsed.output.reason ?? "",
        });
  return insightResultResponse(context, result);
}

function parseInsightType(value: string | undefined): InsightType | undefined {
  return value === "analysis" || value === "walkthrough" ? value : undefined;
}

function response(
  context: Context,
  result:
    | { readonly _tag: "ok"; readonly value: unknown }
    | { readonly _tag: "err"; readonly error: { readonly reason: string } },
): Response {
  return result._tag === "ok"
    ? context.json(result.value)
    : context.json(
        { error: result.error.reason },
        statusForReason(result.error.reason),
      );
}

type StorageRouteFailure = {
  readonly _tag:
    | "ProfileNotFound"
    | "ProfileUnavailable"
    | "StorageUnavailable"
    | "SessionRunning"
    | "SessionImmutable"
    | "SessionNotDiscardable"
    | "SessionProtected"
    | "SessionNotFound"
    | "InvalidQuarantineEntryName"
    | "TrashUnavailable";
};

function storageResponse(
  context: Context,
  result:
    | { readonly _tag: "ok"; readonly value: unknown }
    | { readonly _tag: "err"; readonly error: StorageRouteFailure },
): Response {
  if (result._tag === "ok") return context.json(result.value);
  const tag = result.error._tag;
  if (tag === "ProfileNotFound" || tag === "SessionNotFound")
    return context.json({ error: "not_found" }, 404);
  if (tag === "ProfileUnavailable" || tag === "StorageUnavailable")
    return context.json({ error: "storage_unavailable" }, 503);
  if (
    tag === "SessionRunning" ||
    tag === "SessionImmutable" ||
    tag === "SessionNotDiscardable" ||
    tag === "SessionProtected"
  )
    return context.json({ error: tag }, 409);
  if (tag === "InvalidQuarantineEntryName")
    return context.json({ error: "invalid_input" }, 400);
  if (tag === "TrashUnavailable")
    return context.json({ error: "trash_unavailable" }, 503);
  return context.json({ error: "storage" }, 503);
}

function statusForReason(
  reason: string,
): 400 | 401 | 404 | 409 | 422 | 500 | 502 | 503 {
  if (reason === "not_found" || reason.endsWith("_not_found")) return 404;
  if (reason.includes("auth")) return 401;
  if (
    reason === "revision_conflict" ||
    reason === "stale_head" ||
    reason === "head_changed" ||
    reason === "terminal" ||
    reason === "not_fresh" ||
    reason === "merge_outcome_unknown" ||
    reason.endsWith("_in_progress")
  )
    return 409;
  if (reason === "github_rejected") return 422;
  if (reason.includes("ambiguous")) return 502;
  if (reason === "github_read" || reason === "storage") return 503;
  if (reason.includes("storage")) return 503;
  if (reason.includes("unavailable")) return 503;
  if (reason.includes("rate_limited")) return 503;
  return 400;
}

/** Checks the health route through the same capability boundary used by preload callers. */
export async function healthCheckLocalApi(
  server: Pick<LocalApiServer, "capability" | "url">,
  allowedOrigin: string,
): Promise<boolean> {
  const response = await fetch(new URL("health", server.url), {
    headers: {
      [APP_CAPABILITY_HEADER]: server.capability,
      Origin: allowedOrigin,
    },
  });

  return response.status === 200;
}

function requireLocalApiAccess(
  configuration: LocalApiConfiguration,
): MiddlewareHandler {
  return async (context, next) => {
    const capability = context.req.header(APP_CAPABILITY_HEADER);
    if (capability === undefined) {
      return context.json({ error: "Missing local API capability" }, 401);
    }

    if (!hasMatchingAppCapability(configuration.capability, capability)) {
      return context.json({ error: "Invalid local API capability" }, 403);
    }

    const origin = context.req.header("Origin");
    const fetchMode = context.req.header("Sec-Fetch-Mode");
    if (!isAllowedOrigin(configuration, origin) || fetchMode === "navigate") {
      return context.json({ error: "Origin is not allowed" }, 403);
    }

    await next();
  };
}

function isAllowedOrigin(
  configuration: LocalApiConfiguration,
  origin: string | undefined,
): boolean {
  return (
    origin === configuration.allowedOrigin ||
    origin === configuration.developmentOrigin
  );
}

async function listenOnLoopback(
  app: Hono,
): Promise<{ readonly port: number; readonly server: ServerType }> {
  return await new Promise((resolve, reject) => {
    const rejectListen = (cause: Error): void => {
      reject(cause);
    };
    const server: ServerType = serve(
      {
        fetch: app.fetch,
        hostname: localhostHostname,
        port: 0,
      },
      (address) => {
        server.off("error", rejectListen);
        resolve({ port: address.port, server });
      },
    );
    server.once("error", rejectListen);
  });
}

async function closeServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((cause) => {
      if (cause === undefined) {
        resolve();
        return;
      }

      reject(cause);
    });
  });
}
