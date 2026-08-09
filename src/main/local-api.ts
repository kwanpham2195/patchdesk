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
  union,
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
import { MergeOperationStore } from "../adapters/storage/merge-operation-store";
import { ReviewArtifactStorage } from "../adapters/storage/review-artifact-storage";
import { InsightStore } from "../adapters/storage/insight-store";
import { PublicationAuthorizationStore } from "../adapters/storage/publication-authorization-store";
import { AnalysisCompletionService } from "../services/analysis-completion-service";
import {
  StorageManagementService,
  type TrashMover,
} from "../services/storage-management-service";
import { GitHubAdapter } from "../adapters/github/github-adapter";
import { CommandRunner } from "../adapters/github/command-runner";
import { WorkspaceOriginFinder } from "../adapters/github/workspace-origin-finder";
import type {
  GitHubMergeWriter,
  GitHubPendingReviewGateway,
  GitHubReader,
  GitHubReviewWriter,
} from "../adapters/github/github-adapter";
import type { OriginFinder } from "../services/dashboard-service";
import { DashboardController } from "../services/dashboard-controller";
import { ReviewWriteController } from "../services/review-write-controller";
import { ReviewBatchController } from "../services/review-batch-controller";
import { AnalysisDraftService } from "../services/analysis-draft-service";
import { PublicationPreviewService } from "../services/publication-preview-service";
import { PublishedFeedbackService, type PublishedFeedbackFailure } from "../services/published-feedback-service";
import { InlineConversationService, type DirectConversationCommand } from "../services/inline-conversation-service";
import type { ReviewWriteExpectation } from "../services/review-write-gate";
import { PendingReviewService, projectPendingReview, type PendingReviewProjection } from "../services/pending-review-service";
import type { PendingReviewAnchor } from "../domain/pending-review";
import type { RecentReviewWrite } from "../services/review-refresh-service";
import { UnifiedReviewMigration } from "../services/unified-review-migration";
import { LegacyBatchDiscardMigration } from "../services/legacy-batch-discard-migration";
import { ReviewWorkbenchController } from "../services/review-workbench-controller";
import { ReviewRefreshService } from "../services/review-refresh-service";
import { ReviewSessionPreparation } from "../services/review-session-preparation";
import { ReviewWorkbenchProjectionService } from "../services/review-workbench-projection";
import { ReviewCommitService } from "../services/review-commit-service";
import { ReviewPreparationJournal } from "../services/review-preparation-journal";
import { MergeWriteController } from "../services/merge-write-controller";
import { ReviewCompletionService } from "../services/review-completion-service";
import { projectSafeRun } from "../services/run-projection";
import { ReviewRunRegistry } from "../services/review-run-registry";
import { ReviewRunCoordinator } from "../services/review-run-coordinator";
import { ReviewRecoveryService } from "../services/review-recovery-service";
import { ReviewDiagnosticService } from "../services/review-diagnostic-service";
import { AppLogService } from "../services/app-log-service";
import { ReviewLifecycleGate } from "../services/review-lifecycle-gate";
import { ReviewContextService } from "../services/review-context-service";
import { ReviewWorktreeService, type GitReadExecutor } from "../services/review-worktree-service";
import { ReviewComparisonService } from "../services/review-comparison-service";
import { ReviewExecutionService, REVIEW_REASONING_LEVELS } from "../services/review-execution-service";
import { ReviewHeadVerifier } from "../services/review-head-verifier";
import { ReviewWriteGate } from "../services/review-write-gate";
import { ReviewDiffSourceService } from "../services/review-diff-source-service";
import type { InsightRunCoordinator } from "../services/insight-run-coordinator";
import { readObjectField } from "../services/read-object-field";
import type { PiRuntimeModelCatalog } from "../adapters/pi/pi-runtime-model-catalog";
import {
  ReviewWorkflowStarter,
  type ReviewWorkflowInvoker,
} from "../services/review-workflow-starter";
import { err, ok, type Result } from "../domain/result";
import type { SafeRunProjection } from "../services/run-projection";
import { parseContentHash, parseFindingId, parseGitHubReviewNodeId, parseGitHubThreadId, parseGitSha, parseInsightRunId, parseIsoTimestamp, parsePublicationAuthorizationId, parseRepoRelativePath, parseReviewId, parseReviewSessionId, parseWorkspaceProfileId, type GitHubReviewNodeId, type ReviewId, type ReviewSessionId, type WorkspaceProfileId } from "../domain/ids";
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
  profileId: pipe(string(), minLength(1)), host: pipe(string(), minLength(1)), owner: pipe(string(), minLength(1)), repo: pipe(string(), minLength(1)), number: pipe(number(), integer(), minValue(1)),
  mode: optional(picklist(["full", "incremental"])), baseSessionId: optional(pipe(string(), minLength(1))), previousSessionId: optional(pipe(string(), minLength(1))),
});
const reviewLoadSchema = union([
  strictObject({ profileId: pipe(string(), minLength(1)), reviewId: pipe(string(), minLength(1)) }),
  strictObject({ profileId: pipe(string(), minLength(1)), sessionId: pipe(string(), minLength(1)) }),
]);
const recentReviewWriteSchema = variant("_tag", [
  strictObject({ _tag: picklist(["Comment"] as const), commentId: pipe(string(), minLength(1)), reviewId: optional(pipe(string(), minLength(1))) }),
  strictObject({ _tag: picklist(["ThreadState"] as const), threadId: pipe(string(), minLength(1)), state: picklist(["open", "resolved"] as const) }),
]);
const reviewUpdateSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  recentWrites: optional(array(recentReviewWriteSchema)),
});
const reviewCommitDiffSchema = strictObject({ profileId: pipe(string(), minLength(1)), reviewId: pipe(string(), minLength(1)), commitSha: pipe(string(), minLength(7)) });
const insightCompletionSchema = variant("_tag", [
  strictObject({ _tag: picklist(["SaveAsReviewDraft"] as const) }),
  strictObject({ _tag: picklist(["OpenPreviewWhenComplete"] as const) }),
  strictObject({ _tag: picklist(["PublishWhenComplete"] as const), event: picklist(["APPROVE", "COMMENT", "REQUEST_CHANGES"]), authorizationId: pipe(string(), minLength(1)) }),
]);
const insightRunSchema = strictObject({ profileId: pipe(string(), minLength(1)), reviewId: pipe(string(), minLength(1)), type: picklist(["analysis", "walkthrough"]), model: pipe(string(), minLength(1)), reasoning: picklist(["low", "medium", "high"]), completion: optional(insightCompletionSchema) });
const insightCancelSchema = strictObject({ profileId: pipe(string(), minLength(1)), reviewId: pipe(string(), minLength(1)), type: picklist(["analysis", "walkthrough"]), runId: pipe(string(), minLength(1)) });
const insightFindingSchema = strictObject({ profileId: pipe(string(), minLength(1)), reviewId: pipe(string(), minLength(1)), runId: pipe(string(), minLength(1)), reason: optional(pipe(string(), minLength(1), maxLength(500))) });
const analysisDraftSchema = strictObject({ profileId: pipe(string(), minLength(1)), reviewId: pipe(string(), minLength(1)), sessionId: pipe(string(), minLength(1)), analysisRunId: pipe(string(), minLength(1)), expectedRevision: pipe(string(), minLength(1)) });
const analysisDraftMutationSchema = strictObject({ ...analysisDraftSchema.entries, acknowledgement: optional(boolean()) });
const publicationPreviewSchema = strictObject({ profileId: pipe(string(), minLength(1)), reviewId: pipe(string(), minLength(1)), sessionId: pipe(string(), minLength(1)), expectedHeadSha: optional(pipe(string(), minLength(40))), expectedPatchHash: optional(pipe(string(), minLength(64))), expectedRevision: pipe(string(), minLength(1)), event: picklist(["APPROVE", "COMMENT", "REQUEST_CHANGES"]) });
const publicationRecoverySchema = strictObject({ profileId: pipe(string(), minLength(1)), reviewId: pipe(string(), minLength(1)) });
const publishedCommentEditSchema = strictObject({ profileId: pipe(string(), minLength(1)), reviewId: pipe(string(), minLength(1)), commentId: pipe(string(), minLength(1)), body: string() });
const publishedCommentDeleteSchema = strictObject({ profileId: pipe(string(), minLength(1)), reviewId: pipe(string(), minLength(1)), commentId: pipe(string(), minLength(1)), confirmation: boolean() });
const publishedReviewDismissSchema = strictObject({ profileId: pipe(string(), minLength(1)), reviewId: pipe(string(), minLength(1)), publishedReviewId: pipe(string(), minLength(1)), message: string(), confirmation: boolean() });

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
  /** Main-process-owned finite Flue invocation; renderer requests never provide workflow paths. */
  readonly workflowInvoker?: ReviewWorkflowInvoker;
  /** Models advertised by the active Flue/Pi runtime. Model identifiers stay main-process owned. */
  readonly supportedReviewModels?: ReadonlyArray<string>;
  /** Main-process-only source of currently enabled Pi models. */
  readonly modelCatalog?: PiRuntimeModelCatalog;
  /** Test-only adapter; production never accepts mutable run state over HTTP. */
  readonly runProjection?: (input: {
    readonly runId: string;
    readonly sessionId: string;
    readonly attemptId: string;
  }) => SafeRunProjection;
  /** Main-process-owned Trash capability. Production wires shell.trashItem. */
  readonly trash?: TrashMover;
  /** Test-only read-only git seam used by storage cache clear. */
  readonly readOnlyGit?: GitReadExecutor;
  /** Composition-root lifecycle gate shared by every durable review mutation. */
  readonly lifecycleGate?: ReviewLifecycleGate;
  /** Composition-root diagnostic service shared by every failure boundary. */
  readonly diagnostics?: ReviewDiagnosticService;
  /** Composition-root local log stream; defaults to a fresh on-disk service. */
  readonly logs?: Pick<AppLogService, "write" | "tail">;
  /** Main-process-owned durable Review Insight lifecycle seam. */
  readonly insights?: Pick<InsightRunCoordinator, "start" | "cancel" | "observe" | "dismissFinding" | "addFinding"> & Partial<Pick<InsightRunCoordinator, "updateWalkthroughProgress" | "configureCompletion">>;
  readonly analysisDraft?: Pick<AnalysisDraftService, "seedCurrent" | "previewMergeCurrent" | "previewReplaceCurrent" | "mergeCurrent" | "replaceCurrent" | "addFindingCurrent">;
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
  const runs = new ReviewRunRegistry();
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
  const diagnostics = configuration.diagnostics ?? new ReviewDiagnosticService(
    paths,
    () => new Date().toISOString(),
  );
  const profiles = new ProfileStore(paths);
  const recordProfileReloadFailure = async (phase: string): Promise<void> => {
    const config = await profiles.loadConfig();
    if (config._tag !== "ok" || config.value.lastSelectedProfileId === undefined) return;
    const profileId = parseWorkspaceProfileId(config.value.lastSelectedProfileId);
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
  const remoteReviews = new ReviewRemoteStore(paths, reviews);
  const reviewWriteGate = new ReviewWriteGate(profiles, reviews, sessions, remoteReviews);
  const storageArtifacts = new ReviewArtifactStorage(
    paths,
    () => new Date().toISOString() as never,
  );
  const lifecycleGate = configuration.lifecycleGate ?? new ReviewLifecycleGate();
  const storageManagement = new StorageManagementService({
    profiles,
    sessions,
    artifacts: storageArtifacts,
    paths,
    lifecycleGate,
    diagnostics,
    ...(configuration.trash === undefined ? {} : { trash: configuration.trash }),
    git: configuration.readOnlyGit ?? readOnlyGit,
    now: () => new Date().toISOString() as never,
  });
  await ReviewPreparationJournal.recover(
    paths,
    new ReviewWorktreeService(paths, readOnlyGit),
    sessions,
    lifecycleGate,
    diagnostics,
  );
  const insights = new InsightStore(paths);
  const migration = new UnifiedReviewMigration(sessions, reviews, { paths, remote: remoteReviews, insights });
  // Adopt legacy session-owned artifacts before publication recovery. The
  // recovery gate intentionally requires stable Review ownership, so running
  // recovery first would leave a Submitted legacy session unrecovered until a
  // later request (and make first launch appear to lose its publication).
  const configuredProfiles = await profiles.list();
  if (configuredProfiles._tag === "err") return { _tag: "migration-failed" };
  for (const profile of configuredProfiles.value) {
    const migrated = await migration.migrateProfile(profile.id);
    if (migrated._tag === "err") return { _tag: "migration-failed" };
  }
  // The approved legacy-batch discard runs after Review adoption and before
  // publication recovery: recovery must never reconcile, retry, or transform
  // evidence the product owner chose to discard. The migration is local-only.
  const batchDiscard = new LegacyBatchDiscardMigration(sessions, { paths, diagnostics });
  for (const profile of configuredProfiles.value) {
    const discarded = await batchDiscard.migrateProfile(profile.id);
    if (discarded._tag === "err") return { _tag: "migration-failed" };
  }
  const recovery = new ReviewRecoveryService(
    profiles,
    sessions,
    () => new Date().toISOString() as never,
    { paths, artifacts: storageArtifacts, diagnostics, lifecycleGate, reviewGate: reviewWriteGate, mergeOperations: new MergeOperationStore(paths), github },
  );
  await recovery.reconcile();
  logs.write({
    process: "main",
    level: "info",
    topic: "lifecycle",
    message: "Local API started",
  });
  const dashboard = new DashboardController(
    profiles,
    github,
    configuration.origins ?? new WorkspaceOriginFinder(commands),
    paths,
  );
  const publicationAuthorizations = new PublicationAuthorizationStore(paths);
  const analysisCompletion = new AnalysisCompletionService(publicationAuthorizations);
  const writer =
    configuration.reviewWriter ??
    (isGitHubReviewWriter(github) ? github : undefined);
  const reviewWrites =
    writer === undefined
      ? undefined
      : new ReviewWriteController(
          profiles,
          sessions,
          {
            getPullRequest: github.getPullRequest.bind(github),
            getPullRequestComments: github.getPullRequestComments.bind(github),
            createPendingReview: writer.createPendingReview.bind(writer),
            submitPendingReview: writer.submitPendingReview.bind(writer),
            ...(writer.createThreadReply === undefined ? {} : { createThreadReply: writer.createThreadReply.bind(writer) }),
            ...(writer.setReviewThreadState === undefined ? {} : { setReviewThreadState: writer.setReviewThreadState.bind(writer) }),
          },
          () => new Date().toISOString() as never,
          analysisCompletion,
          reviewWriteGate,
        );
  const reviewBatches = new ReviewBatchController(
    sessions,
    () => new Date().toISOString() as never,
    { reviews, insights, publicationAuthorizations },
  );
  const analysisDrafts = configuration.analysisDraft ?? new AnalysisDraftService({ sessions, insights, reviews, remote: remoteReviews });
  if (configuration.insights?.configureCompletion !== undefined && reviewWrites !== undefined && analysisDrafts !== undefined) {
    configuration.insights.configureCompletion(async (input) => {
      const seeded = await analysisDrafts.seedCurrent({ profileId: input.profileId, reviewId: input.reviewId, sessionId: input.sessionId, analysisRunId: input.analysisRunId, expectedRevision: input.expectedDraftRevision, now: new Date().toISOString() as never });
      if (seeded._tag === "err") {
        if (input.completion._tag === "PublishWhenComplete") await analysisCompletion.revoke({ profileId: input.profileId, reviewId: input.reviewId, authorizationId: input.completion.authorizationId, reason: seeded.error.reason === "draft_not_empty" ? "draft_not_empty" : "needs_attention" });
        return;
      }
      if (input.completion._tag !== "PublishWhenComplete") return;
      const rebound = await analysisCompletion.rebindDraftRevision({ profileId: input.profileId, reviewId: input.reviewId, sessionId: input.sessionId, headSha: input.expectedHeadSha, patchHash: input.expectedPatchHash, analysisRunId: input.analysisRunId, expectedDraftRevision: input.expectedDraftRevision, event: input.completion.event, authorizationId: input.completion.authorizationId, nextDraftRevision: seeded.value.updatedAt });
      if (rebound._tag === "err") {
        await analysisCompletion.revoke({ profileId: input.profileId, reviewId: input.reviewId, authorizationId: input.completion.authorizationId, reason: "needs_attention" });
        return;
      }
      const published = await reviewWrites.confirmPublication({ profileId: input.profileId, reviewId: input.reviewId, sessionId: input.sessionId, expectedHeadSha: input.expectedHeadSha, expectedPatchHash: input.expectedPatchHash, analysisRunId: input.analysisRunId, expectedRevision: seeded.value.updatedAt, acknowledgement: true, authorizationId: input.completion.authorizationId, event: input.completion.event });
      if (published._tag === "err") await analysisCompletion.revoke({ profileId: input.profileId, reviewId: input.reviewId, authorizationId: input.completion.authorizationId, reason: "needs_attention" });
    });
  }
  const publicationPreviews = new PublicationPreviewService(profiles, sessions, github, reviewWriteGate);
  const reviewPreparation = new ReviewSessionPreparation({
    profiles,
    sessions,
    github,
    paths,
    now: () => new Date().toISOString() as never,
    worktrees: new ReviewWorktreeService(paths, readOnlyGit),
    context: new ReviewContextService(),
    comparisons: new ReviewComparisonService(
      paths,
      readOnlyGit,
      () => new Date().toISOString() as never,
    ),
    artifacts: new ReviewArtifactStorage(
      paths,
      () => new Date().toISOString() as never,
    ),
    lifecycleGate,
    diagnostics,
  });
  const reviewProjection = new ReviewWorkbenchProjectionService(
    profiles,
    sessions,
    github,
    () => new Date().toISOString() as never,
    { paths, runs, preparation: ReviewPreparationJournal, diagnostics },
    reviews,
    insights,
  );
  const inlineConversations = new InlineConversationService(reviewWriteGate, github);
  const pendingReviews = isGitHubPendingReviewGateway(github)
    ? new PendingReviewService(reviewWriteGate, sessions, github as GitHubPendingReviewGateway & GitHubReader & GitHubReviewWriter, () => new Date().toISOString() as never)
    : undefined;
  const reviewRefresh = new ReviewRefreshService({
    profiles,
    reviews,
    sessions,
    remote: remoteReviews,
    github,
    preparation: reviewPreparation,
    now: () => new Date().toISOString() as never,
    publicationAuthorizations,
    ...(pendingReviews === undefined ? {} : { pendingReview: pendingReviews }),
    project: ({ profileId, sessionId, snapshot, refreshedAt, pendingReview }) => reviewProjection.loadRepresented({
      profileId,
      sessionId,
      snapshot,
      refreshedAt,
      ...(pendingReview === undefined ? {} : { pendingReview }),
    }),
  });
  const publishedFeedback = new PublishedFeedbackService(reviewWriteGate, github, async ({ profileId, reviewId }) => {
    const refreshed = await reviewRefresh.refresh({ profileId, reviewId });
    return refreshed._tag === "ok" ? ok(undefined) : err(refreshed.error);
  });
  const reviewCommits = new ReviewCommitService(reviews, remoteReviews, sessions, readOnlyGit);
  const reviewWorkbench = new ReviewWorkbenchController(
    reviewPreparation,
    reviewProjection,
    { reviews, remote: remoteReviews, refresh: reviewRefresh, commits: reviewCommits, migration },
    pendingReviews,
  );
  const reviewCompletion = new ReviewCompletionService(
    paths,
    () => new Date().toISOString() as never,
    lifecycleGate,
  );
  const reviewDiffSources = new ReviewDiffSourceService(
    profiles,
    sessions,
    readOnlyGit,
  );
  const workflowStarter =
    configuration.workflowInvoker === undefined
      ? undefined
      : new ReviewWorkflowStarter(sessions, configuration.workflowInvoker);
  const modelCatalog: PiRuntimeModelCatalog = configuration.modelCatalog ?? {
    async get() {
      const models = (configuration.supportedReviewModels ?? [])
        .filter((id) => id.length > 0)
        .map((id) => ({ id, label: id }));
      return models.length === 0
        ? err({ _tag: "PiRuntimeModelCatalogUnavailable" as const })
        : ok({ models, ...(models[0] === undefined ? {} : { defaultModel: models[0].id }) });
    },
  };
  const reviewExecution = new ReviewExecutionService(
    sessions,
    paths,
    modelCatalog,
    () => new Date().toISOString() as never,
    new ReviewHeadVerifier(profiles, sessions, github, () => new Date().toISOString()),
    lifecycleGate,
    { reviews },
  );
  const runCoordinator =
    workflowStarter === undefined
      ? undefined
      : new ReviewRunCoordinator(workflowStarter, runs);
  const merger =
    configuration.mergeWriter ??
    (isGitHubMergeWriter(github) ? github : undefined);
  const mergeWrites =
    merger === undefined
      ? undefined
      : new MergeWriteController(
          profiles,
          sessions,
          {
            getMergePolicy: github.getMergePolicy.bind(github),
            mergePullRequest: merger.mergePullRequest.bind(merger),
          },
          ["squash", "merge", "rebase"],
          () => new Date().toISOString() as never,
          new MergeOperationStore(paths),
          reviewWriteGate,
          reviews,
        );
  app.get("/v1/profiles", async (context) => {
    const result = await dashboard.listProfiles();
    if (result._tag === "err") await recordProfileReloadFailure("profile-reload-list");
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
  app.get("/v1/dashboard", async (context) => {
    const result = await dashboard.dashboardForActiveProfile();
    if (result._tag === "err") await recordProfileReloadFailure("profile-reload-dashboard");
    return response(context, result);
  });
  app.post("/v1/dashboard/refresh/repository", async (context) =>
    response(
      context,
      await dashboard.refreshWatchlistRepo(await jsonBody(context)),
    ),
  );
  app.get("/v1/inbox", async (context) => {
    const result = await dashboard.inboxForActiveProfile();
    if (result._tag === "err") await recordProfileReloadFailure("profile-reload-inbox");
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
      modelConfiguration: await modelConfigurationState(modelCatalog),
    });
  });
  app.post("/v1/direct-entry/preview", async (context) => {
    const body = await jsonBody(context);
    return body === undefined
      ? context.json({ error: "invalid_input" }, 400)
      : response(context, await dashboard.previewDirectEntry(body));
  });
  app.post("/v1/runs/review-pr", async (context) => {
    if (
      workflowStarter === undefined &&
      configuration.runProjection === undefined
    ) {
      return context.json({ error: "workflow_unavailable" }, 503);
    }
    const body = await jsonBody(context);
    const parsed = safeParse(
      object({
        profileId: pipe(string(), minLength(1)),
        sessionId: pipe(string(), minLength(1)),
        attemptId: pipe(string(), minLength(1)),
      }),
      body,
    );
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const run =
      runCoordinator?.start(parsed.output) ?? runs.create(parsed.output);
    return context.json(run, 202);
  });
  app.post("/v1/runs/reconnect", async (context) => {
    const body = await jsonBody(context);
    const parsed = safeParse(
      object({ profileId: pipe(string(), minLength(1)), sessionId: pipe(string(), minLength(1)) }),
      body,
    );
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    const sessionId = parseReviewSessionId(parsed.output.sessionId);
    if (profileId._tag === "err" || sessionId._tag === "err") return context.json({ error: "invalid_input" }, 400);
    const session = await sessions.load(profileId.value, sessionId.value);
    if (session._tag === "err") return context.json({ error: "not_found" }, 404);
    const attemptId = session.value.currentAttemptId;
    if (attemptId === undefined) return context.json({ error: "run_not_owned" }, 403);
    const owned = runs.find({ sessionId: sessionId.value, attemptId });
    if (owned === undefined) return context.json({ error: "run_not_owned" }, 403);
    return context.json({ runId: owned.runId, attemptId }, 202);
  });
  app.get("/v1/reviews/models", async (context) => {
    const catalog = await modelCatalog.get();
    if (catalog._tag === "err") return context.json({ error: "catalog_unavailable" }, 503);
    return context.json({
      models: catalog.value.models,
      providers: catalog.value.providers,
      reasoning: REVIEW_REASONING_LEVELS,
      defaultModel: catalog.value.defaultModel,
      defaultReasoning: "medium",
    });
  });
  app.post("/v1/reviews/run", async (context) => {
    if (runCoordinator === undefined) {
      return context.json({ error: "workflow_unavailable" }, 503);
    }
    const body = await jsonBody(context);
    const started = await reviewExecution.start(body);
    if (started._tag === "err") {
      const status = started.error.reason === "not_found" || started.error.reason === "profile_not_found"
        ? 404
        : started.error.reason === "head_changed"
          ? 409
          : started.error.reason === "github_read" || started.error.reason === "storage" || started.error.reason === "catalog_unavailable"
            ? 503
            : 400;
      return context.json({ error: started.error.reason }, status);
    }
    const run = runCoordinator.start(started.value);
    return context.json({
      runId: run.runId,
      attemptId: started.value.attemptId,
      model: started.value.model,
      reasoning: started.value.reasoning,
    }, 202);
  });
  app.post("/v1/reviews/apply-batch", async (context) =>
    reviewWrites === undefined
      ? context.json({ error: "review_write_unavailable" }, 503)
      : response(context, await reviewWrites.applyBatch(await jsonBody(context))),
  );
  app.post("/v1/reviews/publication/confirm", async (context) =>
    reviewWrites === undefined
      ? context.json({ error: "review_write_unavailable" }, 503)
      : response(context, await reviewWrites.confirmPublication(await jsonBody(context))),
  );
  app.post("/v1/reviews/inline-conversations/command", async (context) => inlineConversationResponse(context, inlineConversations, await jsonBody(context)));
  app.post("/v1/reviews/pending-review/command", async (context) => pendingReviewCommandResponse(context, pendingReviews, sessions, await jsonBody(context)));
  app.post("/v1/reviews/pending-review/recover", async (context) => pendingReviewRecoverResponse(context, pendingReviews, await jsonBody(context)));
  app.post("/v1/reviews/published-comments/edit", async (context) => publishedFeedbackResponse(context, publishedFeedback, "edit", await jsonBody(context)));
  app.post("/v1/reviews/published-comments/delete", async (context) => publishedFeedbackResponse(context, publishedFeedback, "delete", await jsonBody(context)));
  app.post("/v1/reviews/published-reviews/dismiss", async (context) => publishedFeedbackResponse(context, publishedFeedback, "dismiss", await jsonBody(context)));
  app.post("/v1/reviews/submit-batch", async (context) =>
    reviewWrites === undefined
      ? context.json({ error: "review_write_unavailable" }, 503)
      : response(
          context,
          await reviewWrites.submitBatch(await jsonBody(context)),
        ),
  );
  app.post("/v1/reviews/open", async (context) => {
    const parsed = safeParse(reviewOpenSchema, await jsonBody(context));
    return parsed.success
      ? response(context, await reviewWorkbench.open(parsed.output))
      : context.json({ error: "invalid_input" }, 400);
  });
  app.get("/v1/reviews", async (context) => {
    const profileId = parseWorkspaceProfileId(context.req.query("profileId"));
    if (profileId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    const adopted = await migration.migrateProfile(profileId.value);
    if (adopted._tag === "err") return context.json({ error: "storage" }, 500);
    const listed = await new ReviewSessionStore(paths).listSessions(
      profileId.value,
    );
    if (listed._tag === "err") return context.json({ error: "storage" }, 500);
    return context.json({
      sessions: listed.value.map((session) => ({
        id: session.id,
        profileId: session.key.profileId,
        owner: session.key.owner,
        repo: session.key.repo,
        prNumber: session.key.prNumber,
        title: session.prContext?.title,
        state: session.state._tag,
        batchState: session.batchContent?.state._tag,
        updatedAt: session.updatedAt,
      })),
    });
  });
  app.post("/v1/reviews/load", async (context) => {
    const parsed = safeParse(reviewLoadSchema, await jsonBody(context));
    return parsed.success
      ? response(context, await reviewWorkbench.load(parsed.output))
      : context.json({ error: "invalid_input" }, 400);
  });
  app.post("/v1/reviews/publication/preview", async (context) => publicationPreviewResponse(context, publicationPreviews, await jsonBody(context)));
  app.post("/v1/reviews/publication/recover", async (context) => {
    const parsed = safeParse(publicationRecoverySchema, await jsonBody(context));
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    const reviewId = parseReviewId(parsed.output.reviewId);
    if (profileId._tag === "err" || reviewId._tag === "err") return context.json({ error: "invalid_input" }, 400);

    // Recovery only reconciles durable evidence and reprojects this Review. It
    // deliberately has no publication writer and never retries a remote write.
    const before = await reviewWorkbench.load({ profileId: profileId.value, reviewId: reviewId.value });
    if (before._tag === "err") return response(context, before);
    const reconciled = await recovery.reconcilePublication(profileId.value, reviewId.value);
    const projected = await reviewWorkbench.load({ profileId: profileId.value, reviewId: reviewId.value });
    if (projected._tag === "err") return response(context, projected);
    return context.json({
      ...projected.value,
      recovery: {
        status: reconciled.failed === 0 ? "reconciled" : "needs_confirmation",
        recovered: reconciled.recovered,
        failed: reconciled.failed,
      },
    });
  });
  app.post("/v1/reviews/insights/analysis/run", async (context) => insightRunResponse(context, configuration.insights, "analysis", await jsonBody(context)));
  app.post("/v1/reviews/insights/walkthrough/run", async (context) => insightRunResponse(context, configuration.insights, "walkthrough", await jsonBody(context)));
  app.post("/v1/reviews/insights/analysis/cancel", async (context) => insightCancelResponse(context, configuration.insights, "analysis", await jsonBody(context)));
  app.post("/v1/reviews/insights/walkthrough/cancel", async (context) => insightCancelResponse(context, configuration.insights, "walkthrough", await jsonBody(context)));
  app.post("/v1/reviews/insights/analysis/findings/:findingId/dismiss", async (context) => insightFindingResponse(context, configuration.insights, "dismiss", context.req.param("findingId"), await jsonBody(context)));
  app.post("/v1/reviews/insights/analysis/findings/:findingId/add", async (context) => insightFindingResponse(context, configuration.insights, "add", context.req.param("findingId"), await jsonBody(context)));
  app.post("/v1/reviews/insights/walkthrough/progress", async (context) => insightWalkthroughProgressResponse(context, configuration.insights, await jsonBody(context)));
  app.get("/v1/reviews/insights/runs/:runId", async (context) => {
    if (configuration.insights === undefined) return context.json({ error: "workflow_unavailable" }, 503);
    const profileId = parseWorkspaceProfileId(context.req.query("profileId"));
    const reviewId = parseReviewId(context.req.query("reviewId"));
    const runId = parseInsightRunId(context.req.param("runId"));
    const type = parseInsightType(context.req.query("type"));
    if (profileId._tag === "err" || reviewId._tag === "err" || runId._tag === "err" || type === undefined) return context.json({ error: "invalid_input" }, 400);
    return insightResultResponse(context, await configuration.insights.observe({ profileId: profileId.value, reviewId: reviewId.value, type, runId: runId.value }));
  });
  app.post("/v1/reviews/detect-updates", async (context) => {
    const parsed = safeParse(reviewUpdateSchema, await jsonBody(context));
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    // The route is the sole authority for detection-request parsing: typed
    // ids are refined here, and the controller receives only typed input.
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    const reviewId = parseReviewId(parsed.output.reviewId);
    if (profileId._tag === "err" || reviewId._tag === "err") return context.json({ error: "invalid_input" }, 400);
    const recentWrites: Array<RecentReviewWrite> = [];
    for (const entry of parsed.output.recentWrites ?? []) {
      if (entry._tag === "Comment") {
        recentWrites.push({
          _tag: "Comment",
          commentId: entry.commentId,
          ...(entry.reviewId === undefined ? {} : { reviewId: entry.reviewId }),
        });
      } else {
        const parsedThreadId = parseGitHubThreadId(entry.threadId);
        if (parsedThreadId._tag === "err") return context.json({ error: "invalid_input" }, 400);
        recentWrites.push({ _tag: "ThreadState", threadId: parsedThreadId.value, state: entry.state });
      }
    }
    return response(context, await reviewWorkbench.detectUpdates({
      profileId: profileId.value,
      reviewId: reviewId.value,
      ...(recentWrites.length === 0 ? {} : { recentWrites }),
    }));
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
  app.post("/v1/reviews/batch", async (context) =>
    response(context, await reviewBatches.update(await jsonBody(context))),
  );
  app.post("/v1/reviews/draft/seed-analysis", async (context) => seedAnalysisDraftResponse(context, analysisDrafts, await jsonBody(context)));
  app.post("/v1/reviews/draft/merge-preview", async (context) => analysisDraftPreviewResponse(context, analysisDrafts, "merge", await jsonBody(context)));
  app.post("/v1/reviews/draft/replace-preview", async (context) => analysisDraftPreviewResponse(context, analysisDrafts, "replace", await jsonBody(context)));
  app.post("/v1/reviews/draft/merge", async (context) => analysisDraftMutationResponse(context, analysisDrafts, "merge", await jsonBody(context)));
  app.post("/v1/reviews/draft/replace", async (context) => analysisDraftMutationResponse(context, analysisDrafts, "replace", await jsonBody(context)));
  app.post("/v1/reviews/draft/findings/:findingId/add", async (context) => analysisDraftFindingResponse(context, analysisDrafts, context.req.param("findingId"), await jsonBody(context)));

  app.post("/v1/reviews/complete", async (context) =>
    response(context, await reviewCompletion.complete(await jsonBody(context))),
  );
  app.post("/v1/reviews/merge", async (context) =>
    mergeWrites === undefined
      ? context.json({ error: "merge_unavailable" }, 503)
      : response(context, await mergeWrites.merge(await jsonBody(context))),
  );
  app.post("/v1/storage/clear-local-data", async (context) => {
    const body = await jsonBody(context);
    const parsed = safeParse(
      object({ profileId: pipe(string(), minLength(1)) }),
      body,
    );
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    if (profileId._tag === "err") return context.json({ error: "invalid_input" }, 400);
    return storageResponse(context, await storageManagement.clearLocalData(profileId.value));
  });
  app.post("/v1/storage/cache/clear", async (context) => {
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
      await storageManagement.clearCache(profileId.value),
    );
  });
  app.get("/v1/logs", async (context) => {
    const rawAfter = context.req.query("after");
    const rawLimit = context.req.query("limit");
    const after = rawAfter === undefined || !/^\d+$/.test(rawAfter) ? undefined : Number(rawAfter);
    const limit = rawLimit === undefined || !/^\d+$/.test(rawLimit) ? undefined : Number(rawLimit);
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
      logs.write({
        process: "renderer",
        level: candidate.output.level,
        topic: candidate.output.topic,
        message: candidate.output.message,
        ...(candidate.output.meta === undefined ? {} : { meta: candidate.output.meta }),
        ...(candidate.output.profileId === undefined ? {} : { profileId: candidate.output.profileId }),
        ...(candidate.output.sessionId === undefined ? {} : { sessionId: candidate.output.sessionId }),
        ...(candidate.output.correlationId === undefined ? {} : { correlationId: candidate.output.correlationId }),
      });
      accepted += 1;
    }
    return context.json({ accepted });
  });
  app.get("/v1/diagnostics", async (context) => {
    const profileId = parseWorkspaceProfileId(context.req.query("profileId"));
    if (profileId._tag === "err") return context.json({ error: "invalid_input" }, 400);
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
    if (profileId._tag === "err") return context.json({ error: "invalid_input" }, 400);
    const sessionId = parsed.output.sessionId === undefined ? undefined : parseReviewSessionId(parsed.output.sessionId);
    if (sessionId?._tag === "err") return context.json({ error: "invalid_input" }, 400);
    const bundle = await diagnostics.exportSupportBundle({
      profileId: profileId.value,
      ...(sessionId?._tag === "ok" ? { sessionId: sessionId.value } : {}),
    });
    return bundle._tag === "ok"
      ? context.json(bundle.value)
      : context.json({ error: "diagnostics_unavailable" }, 503);
  });
  app.get("/v1/runs/:runId", (context) => {
    const sessionId = context.req.query("sessionId");
    const attemptId = context.req.query("attemptId");
    if (sessionId === undefined) return context.json({ error: "run_not_owned" }, 403);
    const runId = context.req.param("runId");
    const owner = attemptId === undefined
      ? runs.findByRunId(runId)
      : { runId, sessionId, attemptId };
    if (owner === undefined) return context.json({ error: "run_not_owned" }, 403);
    const observed = runCoordinator?.observe(owner);
    const run = "runId" in owner && "projection" in owner
      ? ok(owner)
      : runs.get(owner.runId, owner);
    if (run._tag === "err" || observed?._tag === "err")
      return context.json({ error: "run_not_owned" }, 403);
    const projected = projectSafeRun(
      configuration.runProjection?.({
        runId: run.value.runId,
        sessionId,
        attemptId: run.value.attemptId,
      }) ?? (observed?._tag === "ok" ? observed.value : run.value.projection),
    );
    return projected._tag === "ok"
      ? context.json(projected.value)
      : context.json({ error: "invalid_run" }, 500);
  });

  const { server, port } = await listenOnLoopback(app);
  const url = new URL(`http://${localhostHostname}:${port}/`);

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
function logLocalApiRequests(logs: Pick<AppLogService, "write">): MiddlewareHandler {
  return async (context, next) => {
    const startedAt = performance.now();
    await next();
    const path = context.req.path;
    if (path === "/health" || path === "/v1/logs") return;
    const status = context.res.status;
    const durationMs = Math.round(performance.now() - startedAt);
    const correlationId = context.req.header("x-patchdesk-correlation-id");
    logs.write({
      process: "main",
      level: status >= 500 ? "error" : status >= 400 ? "warn" : "debug",
      topic: "http",
      message: `${context.req.method} ${path}`,
      meta: { status, durationMs, ...(correlationId === undefined ? {} : { correlationId }) },
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
    return JSON.parse(new TextDecoder().decode(combined)) as unknown;
  } catch {
    return undefined;
  }
}


async function modelConfigurationState(modelCatalog: PiRuntimeModelCatalog): Promise<"configured" | "missing"> {
  const catalog = await modelCatalog.get();
  return catalog._tag === "ok" && catalog.value.configured ? "configured" : "missing";
}

function isGitHubReviewWriter(value: unknown): value is GitHubReviewWriter {
  return (
    typeof value === "object" &&
    value !== null &&
    "createPendingReview" in value &&
    "submitPendingReview" in value
  );
}
function isGitHubPendingReviewGateway(value: unknown): value is GitHubPendingReviewGateway {
  return (
    typeof value === "object" &&
    value !== null &&
    "getViewerPendingReview" in value &&
    "startPendingReviewWithThread" in value &&
    "addPendingReviewThread" in value &&
    "submitPendingReview" in value &&
    "resolveAuthenticatedAccount" in value
  );
}
function isGitHubMergeWriter(value: unknown): value is GitHubMergeWriter {
  return (
    typeof value === "object" && value !== null && "mergePullRequest" in value
  );
}

type PendingReviewCommandDto =
  | {
      readonly _tag: "Start";
      readonly expected: ReviewWriteExpectation;
      readonly anchor: PendingReviewAnchor;
      readonly body: string;
    }
  | {
      readonly _tag: "AddThread";
      readonly expected: ReviewWriteExpectation;
      readonly pendingReviewNodeId: GitHubReviewNodeId;
      readonly anchor: PendingReviewAnchor;
      readonly body: string;
    }
  | {
      readonly _tag: "Submit";
      readonly expected: ReviewWriteExpectation;
      readonly event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
      readonly summaryBody: string;
    };

async function pendingReviewCommandResponse(context: Context, service: PendingReviewService | undefined, sessions: ReviewSessionStore, body: unknown): Promise<Response> {
  if (service === undefined) return context.json({ error: "review_write_unavailable" }, 503);
  const parsed = parsePendingReviewCommand(body);
  if (parsed === undefined) return context.json({ error: "invalid_input" }, 400);
  const result = parsed.command._tag === "Start"
    ? await service.start({ profileId: parsed.profileId, reviewId: parsed.reviewId, expected: parsed.command.expected, anchor: parsed.command.anchor, body: parsed.command.body })
    : parsed.command._tag === "AddThread"
      ? await service.addThread({ profileId: parsed.profileId, reviewId: parsed.reviewId, expected: parsed.command.expected, pendingReviewNodeId: parsed.command.pendingReviewNodeId, anchor: parsed.command.anchor, body: parsed.command.body })
      : await service.submit({ profileId: parsed.profileId, reviewId: parsed.reviewId, expected: parsed.command.expected, event: parsed.command.event, summaryBody: parsed.command.summaryBody });
  if (result._tag === "ok") {
    return context.json({ pendingReview: projectPendingReview(result.value.state, false) });
  }
  const projection = await storedPendingReviewProjection(sessions, parsed.profileId, parsed.command.expected.sessionId);
  return context.json({
    error: result.error,
    ...(projection === undefined ? {} : { pendingReview: projection }),
  }, pendingReviewFailureStatus(result.error));
}

async function pendingReviewRecoverResponse(context: Context, service: PendingReviewService | undefined, body: unknown): Promise<Response> {
  if (service === undefined) return context.json({ error: "review_write_unavailable" }, 503);
  const profileId = parseWorkspaceProfileId(readObjectField(body, "profileId"));
  const reviewId = parseReviewId(readObjectField(body, "reviewId"));
  if (profileId._tag === "err" || reviewId._tag === "err") return context.json({ error: "invalid_input" }, 400);
  const result = await service.reconcile({ profileId: profileId.value, reviewId: reviewId.value, recover: true });
  if (result._tag === "ok") {
    return context.json({ pendingReview: projectPendingReview(result.value.state, result.value.unavailable) });
  }
  return context.json({ error: result.error }, pendingReviewFailureStatus(result.error));
}

async function storedPendingReviewProjection(sessions: ReviewSessionStore, profileId: WorkspaceProfileId, sessionId: ReviewSessionId): Promise<PendingReviewProjection | undefined> {
  const loaded = await sessions.load(profileId, sessionId);
  if (loaded._tag === "err") return undefined;
  return projectPendingReview(loaded.value.pendingReview ?? { _tag: "None" }, false);
}

function pendingReviewFailureStatus(failure: string): 400 | 404 | 409 | 503 {
  if (failure === "invalid_input") return 400;
  if (failure === "not_found") return 404;
  if (failure === "not_fresh" || failure === "stale_head" || failure === "permission_denied" || failure === "rejected" || failure === "review_write_in_progress" || failure === "no_pending_review" || failure === "pending_review_locked") return 409;
  if (failure === "unavailable" || failure === "outcome_unknown") return 503;
  return 400;
}

function parsePendingReviewCommand(body: unknown): { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly command: PendingReviewCommandDto } | undefined {
  const profileId = parseWorkspaceProfileId(readObjectField(body, "profileId"));
  const reviewId = parseReviewId(readObjectField(body, "reviewId"));
  const raw = readObjectField(body, "command");
  const tag = readObjectField(raw, "_tag");
  const expected = parseReviewWriteExpectation(readObjectField(raw, "expected"));
  if (profileId._tag === "err" || reviewId._tag === "err" || tag === undefined || expected === undefined) return undefined;
  if (tag === "Start" || tag === "AddThread") {
    const anchor = parsePendingReviewAnchor(readObjectField(raw, "anchor"));
    const bodyValue = readObjectField(raw, "body");
    if (anchor === undefined || typeof bodyValue !== "string" || bodyValue.trim().length === 0) return undefined;
    if (tag === "Start") return { profileId: profileId.value, reviewId: reviewId.value, command: { _tag: "Start", expected, anchor, body: bodyValue } };
    const pendingReviewNodeId = readObjectField(raw, "pendingReviewNodeId");
    if (typeof pendingReviewNodeId !== "string") return undefined;
    const parsedNodeId = parseGitHubReviewNodeId(pendingReviewNodeId);
    if (parsedNodeId._tag === "err") return undefined;
    return { profileId: profileId.value, reviewId: reviewId.value, command: { _tag: "AddThread", expected, pendingReviewNodeId: parsedNodeId.value, anchor, body: bodyValue } };
  }
  if (tag === "Submit") {
    const event = readObjectField(raw, "event");
    const summaryBody = readObjectField(raw, "summaryBody");
    if ((event !== "APPROVE" && event !== "COMMENT" && event !== "REQUEST_CHANGES") || typeof summaryBody !== "string") return undefined;
    return { profileId: profileId.value, reviewId: reviewId.value, command: { _tag: "Submit", expected, event, summaryBody } };
  }
  return undefined;
}

function parseReviewWriteExpectation(raw: unknown): ReviewWriteExpectation | undefined {
  const sessionId = parseReviewSessionId(readObjectField(raw, "sessionId"));
  const headSha = parseGitSha(readObjectField(raw, "headSha"));
  const patchHash = parseContentHash(readObjectField(raw, "patchHash"));
  return sessionId._tag === "err" || headSha._tag === "err" || patchHash._tag === "err"
    ? undefined
    : { sessionId: sessionId.value, headSha: headSha.value, patchHash: patchHash.value };
}

function parsePendingReviewAnchor(raw: unknown): PendingReviewAnchor | undefined {
  const path = readObjectField(raw, "path");
  const startLine = readObjectField(raw, "startLine");
  const line = readObjectField(raw, "line");
  const side = readObjectField(raw, "side");
  if (typeof path !== "string" || typeof startLine !== "number" || !Number.isInteger(startLine) || startLine < 1 || typeof line !== "number" || !Number.isInteger(line) || line < startLine || (side !== "new" && side !== "old")) return undefined;
  const parsedPath = parseRepoRelativePath(path);
  if (parsedPath._tag === "err") return undefined;
  return { path: parsedPath.value, startLine, line, side };
}

async function inlineConversationResponse(context: Context, service: InlineConversationService, body: unknown): Promise<Response> {  const parsed = parseInlineConversationCommand(body);
  if (parsed === undefined) return context.json({ error: "invalid_input" }, 400);
  const result = await service.execute(parsed);
  if (result._tag === "ok") return context.json(result.value);
  const status = result.error === "not_found" ? 404 : result.error === "not_fresh" || result.error === "permission_denied" || result.error === "confirmation_required" ? 409 : result.error === "pending_review" ? 409 : result.error === "github_read_failed" || result.error === "github_write_failed" ? 503 : 400;
  return context.json({ error: result.error }, status);
}

function parseInlineConversationCommand(body: unknown): { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly command: DirectConversationCommand } | undefined {
  const profileId = parseWorkspaceProfileId(readObjectField(body, "profileId"));
  const reviewId = parseReviewId(readObjectField(body, "reviewId"));
  const raw = readObjectField(body, "command");
  const tag = readObjectField(raw, "_tag");
  const expectedRaw = readObjectField(raw, "expected");
  const sessionId = parseReviewSessionId(readObjectField(expectedRaw, "sessionId"));
  const headSha = parseGitSha(readObjectField(expectedRaw, "headSha"));
  const patchHash = parseContentHash(readObjectField(expectedRaw, "patchHash"));
  if (profileId._tag === "err" || reviewId._tag === "err" || sessionId._tag === "err" || headSha._tag === "err" || patchHash._tag === "err" || typeof tag !== "string") {
    console.error("Inline conversation command parse failed", {
      profileOk: profileId._tag,
      reviewOk: reviewId._tag,
      sessionOk: sessionId._tag,
      headShaOk: headSha._tag,
      patchHashOk: patchHash._tag,
      tagType: typeof tag,
      rawCommand: JSON.stringify(raw),
    });
    return undefined;
  }
  const expected = { sessionId: sessionId.value, headSha: headSha.value, patchHash: patchHash.value };
  const value = (name: string): string | undefined => {
    const candidate = readObjectField(raw, name);
    return typeof candidate === "string" ? candidate : undefined;
  };
  let command: DirectConversationCommand | undefined;
  if (tag === "CreateComment") {
    const anchor = readObjectField(raw, "anchor");
    const path = readObjectField(anchor, "path"); const startLine = readObjectField(anchor, "startLine"); const line = readObjectField(anchor, "line"); const side = readObjectField(anchor, "side"); const bodyValue = value("body");
    if (typeof path === "string" && typeof startLine === "number" && Number.isInteger(startLine) && typeof line === "number" && Number.isInteger(line) && (side === "new" || side === "old") && bodyValue !== undefined) command = { _tag: "CreateComment", expected, anchor: { path, startLine, line, side }, body: bodyValue };
  } else if (tag === "Reply") {
    const threadId = value("threadId"); const bodyValue = value("body");
    if (threadId !== undefined && parseGitHubThreadId(threadId)._tag === "ok" && bodyValue !== undefined) command = { _tag: "Reply", expected, threadId, body: bodyValue };
  } else if (tag === "SetThreadState") {
    const threadId = value("threadId"); const state = readObjectField(raw, "state");
    if (threadId !== undefined && parseGitHubThreadId(threadId)._tag === "ok" && (state === "open" || state === "resolved")) command = { _tag: "SetThreadState", expected, threadId, state };
  } else if (tag === "EditComment") {
    const commentId = value("commentId"); const bodyValue = value("body");
    if (commentId !== undefined && bodyValue !== undefined) command = { _tag: "EditComment", expected, commentId, body: bodyValue };
  } else if (tag === "DeleteComment") {
    const commentId = value("commentId"); const confirmation = readObjectField(raw, "confirmation");
    if (commentId !== undefined && typeof confirmation === "boolean") command = { _tag: "DeleteComment", expected, commentId, confirmation };
  }
  return command === undefined ? undefined : { profileId: profileId.value, reviewId: reviewId.value, command };
}

async function publishedFeedbackResponse(context: Context, service: PublishedFeedbackService, action: "edit" | "delete" | "dismiss", body: unknown): Promise<Response> {
  const result = action === "edit" ? await parsePublishedEdit(service, body) : action === "delete" ? await parsePublishedDelete(service, body) : await parsePublishedDismiss(service, body);
  if (result._tag === "err") {
    if (result.error === "invalid_input") return context.json({ error: result.error }, 400);
    const status = result.error === "not_found" ? 404 : result.error === "not_fresh" || result.error === "confirmation_required" || result.error === "permission_denied" ? 409 : result.error === "github_read_failed" || result.error === "refresh_required" ? 503 : 400;
    return context.json({ error: result.error }, status);
  }
  return context.json({ status: "ok" });
}

async function parsePublishedEdit(service: PublishedFeedbackService, body: unknown): Promise<Result<void, "invalid_input" | PublishedFeedbackFailure>> {
  const parsed = safeParse(publishedCommentEditSchema, body);
  if (!parsed.success) return err("invalid_input");
  const profileId = parseWorkspaceProfileId(parsed.output.profileId); const reviewId = parseReviewId(parsed.output.reviewId);
  return profileId._tag === "err" || reviewId._tag === "err" ? err("invalid_input") : service.editComment({ profileId: profileId.value, reviewId: reviewId.value, commentId: parsed.output.commentId, body: parsed.output.body });
}

async function parsePublishedDelete(service: PublishedFeedbackService, body: unknown): Promise<Result<void, "invalid_input" | PublishedFeedbackFailure>> {
  const parsed = safeParse(publishedCommentDeleteSchema, body);
  if (!parsed.success) return err("invalid_input");
  const profileId = parseWorkspaceProfileId(parsed.output.profileId); const reviewId = parseReviewId(parsed.output.reviewId);
  return profileId._tag === "err" || reviewId._tag === "err" ? err("invalid_input") : service.deleteComment({ profileId: profileId.value, reviewId: reviewId.value, commentId: parsed.output.commentId, confirmation: parsed.output.confirmation });
}

async function parsePublishedDismiss(service: PublishedFeedbackService, body: unknown): Promise<Result<void, "invalid_input" | PublishedFeedbackFailure>> {
  const parsed = safeParse(publishedReviewDismissSchema, body);
  if (!parsed.success) return err("invalid_input");
  const profileId = parseWorkspaceProfileId(parsed.output.profileId); const reviewId = parseReviewId(parsed.output.reviewId);
  return profileId._tag === "err" || reviewId._tag === "err" ? err("invalid_input") : service.dismissReview({ profileId: profileId.value, reviewId: reviewId.value, publishedReviewId: parsed.output.publishedReviewId, message: parsed.output.message, confirmation: parsed.output.confirmation });
}

async function publicationPreviewResponse(context: Context, service: PublicationPreviewService, body: unknown): Promise<Response> {
  const parsed = safeParse(publicationPreviewSchema, body);
  if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  const sessionId = parseReviewSessionId(parsed.output.sessionId);
  const expectedRevision = parseIsoTimestamp(parsed.output.expectedRevision);
  if (profileId._tag === "err" || reviewId._tag === "err" || sessionId._tag === "err" || expectedRevision._tag === "err") return context.json({ error: "invalid_input" }, 400);
  const result = await service.preview({ profileId: profileId.value, reviewId: reviewId.value, sessionId: sessionId.value, ...(parsed.output.expectedHeadSha === undefined ? {} : { expectedHeadSha: parsed.output.expectedHeadSha }), ...(parsed.output.expectedPatchHash === undefined ? {} : { expectedPatchHash: parsed.output.expectedPatchHash }), expectedRevision: expectedRevision.value, event: parsed.output.event });
  if (result._tag === "ok") return context.json(result.value);
  const status = result.error === "profile_not_found" || result.error === "session_not_found" ? 404 : result.error === "revision_conflict" || result.error === "stale_head" || result.error === "needs_attention" ? 409 : result.error === "github_read_failed" ? 503 : 400;
  return context.json({ error: result.error }, status);
}

async function insightRunResponse(context: Context, coordinator: LocalApiConfiguration["insights"], type: InsightType, body: unknown): Promise<Response> {
  if (coordinator === undefined) return context.json({ error: "workflow_unavailable" }, 503);
  const parsed = safeParse(insightRunSchema, body);
  if (!parsed.success || parsed.output.type !== type) return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  if (profileId._tag === "err" || reviewId._tag === "err") return context.json({ error: "invalid_input" }, 400);
  const completion = parsed.output.completion === undefined ? undefined : parsed.output.completion._tag === "PublishWhenComplete"
    ? (() => { const authorizationId = parsePublicationAuthorizationId(parsed.output.completion.authorizationId); return authorizationId._tag === "err" ? undefined : { ...parsed.output.completion, authorizationId: authorizationId.value } as const; })()
    : parsed.output.completion;
  if (parsed.output.completion?._tag === "PublishWhenComplete" && completion === undefined) return context.json({ error: "invalid_input" }, 400);
  const result = await coordinator.start({ profileId: profileId.value, reviewId: reviewId.value, type, model: parsed.output.model, reasoning: parsed.output.reasoning, ...(completion === undefined ? {} : { completion }) });
  return insightResultResponse(context, result, 202);
}

async function insightCancelResponse(context: Context, coordinator: LocalApiConfiguration["insights"], type: InsightType, body: unknown): Promise<Response> {
  if (coordinator === undefined) return context.json({ error: "workflow_unavailable" }, 503);
  const parsed = safeParse(insightCancelSchema, body);
  if (!parsed.success || parsed.output.type !== type) return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  const runId = parseInsightRunId(parsed.output.runId);
  if (profileId._tag === "err" || reviewId._tag === "err" || runId._tag === "err") return context.json({ error: "invalid_input" }, 400);
  const result = await coordinator.cancel({ profileId: profileId.value, reviewId: reviewId.value, type, runId: runId.value });
  return insightResultResponse(context, result);
}

function insightResultResponse(
  context: Context,
  result: Awaited<ReturnType<NonNullable<LocalApiConfiguration["insights"]>["observe"]>> | Awaited<ReturnType<NonNullable<LocalApiConfiguration["insights"]>["start"]>> | Awaited<ReturnType<NonNullable<LocalApiConfiguration["insights"]>["cancel"]>> | Awaited<ReturnType<NonNullable<LocalApiConfiguration["insights"]>["dismissFinding"]>> | Awaited<ReturnType<NonNullable<LocalApiConfiguration["insights"]>["addFinding"]>>
  | Awaited<ReturnType<InsightRunCoordinator["updateWalkthroughProgress"]>>,
  successStatus: 200 | 202 = 200,
): Response {
  if (result._tag === "ok") return context.json(result.value, successStatus);
  const status = result.error === "invalid_request" || result.error === "model_unavailable" ? 400
    : result.error === "ownership_mismatch" ? 403
      : result.error === "not_found" ? 404
      : result.error === "terminal_review" || result.error === "already_running" || result.error === "not_active" || result.error === "stale_request" || result.error === "not_available" || result.error === "draft_unavailable" ? 409
        : 503;
  return context.json({ error: result.error }, status);
}

async function insightWalkthroughProgressResponse(context: Context, coordinator: LocalApiConfiguration["insights"], body: unknown): Promise<Response> {
  if (coordinator === undefined || coordinator.updateWalkthroughProgress === undefined) return context.json({ error: "workflow_unavailable" }, 503);
  const parsed = safeParse(strictObject({ profileId: string(), reviewId: string(), runId: string(), reviewedSectionIds: array(string()), supportReviewed: boolean(), currentSectionId: optional(string()) }), body);
  if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  const runId = parseInsightRunId(parsed.output.runId);
  if (profileId._tag === "err" || reviewId._tag === "err" || runId._tag === "err") return context.json({ error: "invalid_input" }, 400);
  const result = await coordinator.updateWalkthroughProgress({ profileId: profileId.value, reviewId: reviewId.value, runId: runId.value, progress: { reviewedSectionIds: parsed.output.reviewedSectionIds, supportReviewed: parsed.output.supportReviewed, ...(parsed.output.currentSectionId === undefined ? {} : { currentSectionId: parsed.output.currentSectionId }) } });
  return insightResultResponse(context, result);
}

async function insightFindingResponse(context: Context, coordinator: LocalApiConfiguration["insights"], action: "add" | "dismiss", findingIdInput: string, body: unknown): Promise<Response> {
  if (coordinator === undefined) return context.json({ error: "workflow_unavailable" }, 503);
  const parsed = safeParse(insightFindingSchema, body);
  const findingId = parseFindingId(findingIdInput);
  if (!parsed.success || findingId._tag === "err" || (action === "dismiss" && parsed.output.reason === undefined)) return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  const runId = parseInsightRunId(parsed.output.runId);
  if (profileId._tag === "err" || reviewId._tag === "err" || runId._tag === "err") return context.json({ error: "invalid_input" }, 400);
  const result = action === "dismiss"
    ? coordinator.dismissFinding === undefined
      ? err("storage_unavailable" as const)
      : await coordinator.dismissFinding({ profileId: profileId.value, reviewId: reviewId.value, runId: runId.value, findingId: findingId.value, reason: parsed.output.reason ?? "" })
    : coordinator.addFinding === undefined
      ? err("storage_unavailable" as const)
      : await coordinator.addFinding({ profileId: profileId.value, reviewId: reviewId.value, runId: runId.value, findingId: findingId.value });
  return insightResultResponse(context, result);
}

type ParsedAnalysisDraftRequest = { readonly profileId: ReturnType<typeof parseWorkspaceProfileId> extends Result<infer T, unknown> ? T : never; readonly reviewId: ReturnType<typeof parseReviewId> extends Result<infer T, unknown> ? T : never; readonly sessionId: ReturnType<typeof parseReviewSessionId> extends Result<infer T, unknown> ? T : never; readonly analysisRunId: ReturnType<typeof parseInsightRunId> extends Result<infer T, unknown> ? T : never; readonly expectedRevision: ReturnType<typeof parseIsoTimestamp> extends Result<infer T, unknown> ? T : never };

function parseAnalysisDraftRequest(body: unknown): Result<ParsedAnalysisDraftRequest, "invalid_input"> {
  const parsed = safeParse(analysisDraftSchema, body);
  if (!parsed.success) return err("invalid_input");
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  const sessionId = parseReviewSessionId(parsed.output.sessionId);
  const analysisRunId = parseInsightRunId(parsed.output.analysisRunId);
  const expectedRevision = parseIsoTimestamp(parsed.output.expectedRevision);
  return profileId._tag === "err" || reviewId._tag === "err" || sessionId._tag === "err" || analysisRunId._tag === "err" || expectedRevision._tag === "err" ? err("invalid_input") : ok({ profileId: profileId.value, reviewId: reviewId.value, sessionId: sessionId.value, analysisRunId: analysisRunId.value, expectedRevision: expectedRevision.value });
}

function analysisDraftFailureResponse(context: Context, failure: { readonly reason: string; readonly merge?: unknown; readonly replacement?: unknown }): Response {
  if (failure.reason === "draft_not_empty") return context.json({ error: failure.reason, merge: failure.merge, replacement: failure.replacement }, 409);
  const status = failure.reason === "not_found" ? 404 : failure.reason === "stale_request" ? 409 : failure.reason === "invalid_input" ? 400 : 503;
  return context.json({ error: failure.reason }, status);
}

async function seedAnalysisDraftResponse(context: Context, service: Pick<AnalysisDraftService, "seedCurrent">, body: unknown): Promise<Response> {
  const parsed = parseAnalysisDraftRequest(body);
  if (parsed._tag === "err") return context.json({ error: parsed.error }, 400);
  const result = await service.seedCurrent({ ...parsed.value, now: new Date().toISOString() as never });
  return result._tag === "ok" ? context.json(result.value) : analysisDraftFailureResponse(context, result.error);
}

async function analysisDraftPreviewResponse(context: Context, service: Pick<AnalysisDraftService, "previewMergeCurrent" | "previewReplaceCurrent">, action: "merge" | "replace", body: unknown): Promise<Response> {
  const parsed = parseAnalysisDraftRequest(body);
  if (parsed._tag === "err") return context.json({ error: parsed.error }, 400);
  const result = action === "merge" ? await service.previewMergeCurrent({ ...parsed.value, now: new Date().toISOString() as never }) : await service.previewReplaceCurrent({ ...parsed.value, now: new Date().toISOString() as never });
  return result._tag === "ok" ? context.json(result.value) : analysisDraftFailureResponse(context, result.error);
}

async function analysisDraftFindingResponse(context: Context, service: Pick<AnalysisDraftService, "addFindingCurrent">, findingIdInput: string, body: unknown): Promise<Response> {
  const parsed = parseAnalysisDraftRequest(body);
  const findingId = parseFindingId(findingIdInput);
  if (parsed._tag === "err" || findingId._tag === "err") return context.json({ error: "invalid_input" }, 400);
  const result = await service.addFindingCurrent({ ...parsed.value, findingId: findingId.value, now: new Date().toISOString() as never });
  return result._tag === "ok" ? context.json(result.value) : analysisDraftFailureResponse(context, result.error);
}

async function analysisDraftMutationResponse(context: Context, service: Pick<AnalysisDraftService, "mergeCurrent" | "replaceCurrent">, action: "merge" | "replace", body: unknown): Promise<Response> {
  const parsed = safeParse(analysisDraftMutationSchema, body);
  if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
  const base = parseAnalysisDraftRequest(parsed.output);
  if (base._tag === "err") return context.json({ error: "invalid_input" }, 400);
  const result = action === "merge"
    ? await service.mergeCurrent({ ...base.value, now: new Date().toISOString() as never })
    : await service.replaceCurrent({ ...base.value, acknowledgement: parsed.output.acknowledgement === true, now: new Date().toISOString() as never });
  return result._tag === "ok" ? context.json(result.value) : analysisDraftFailureResponse(context, result.error);
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
  if (tag === "ProfileNotFound" || tag === "SessionNotFound") {
    return context.json({ error: "not_found" }, 404);
  }
  if (tag === "ProfileUnavailable" || tag === "StorageUnavailable") {
    return context.json({ error: "storage_unavailable" }, 503);
  }
  if (tag === "SessionRunning" || tag === "SessionImmutable" || tag === "SessionNotDiscardable") {
    return context.json({ error: tag }, 409);
  }
  if (tag === "InvalidQuarantineEntryName") {
    return context.json({ error: "invalid_input" }, 400);
  }
  if (tag === "TrashUnavailable") {
    return context.json({ error: "trash_unavailable" }, 503);
  }
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
