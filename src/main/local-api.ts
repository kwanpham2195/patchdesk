import { serve, type ServerType } from "@hono/node-server";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  optional,
  array,
  boolean,
  check,
  safeParse,
  literal,
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
  type InferOutput,
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
import {
  GitHubCliCredentials,
  type GitHubCredentials,
} from "../adapters/github/github-credentials";
import {
  CommandRunner,
  type CommandRequest,
  runWithRequestAbortSignal,
} from "../adapters/github/command-runner";
import { listAuthenticatedGitHubAccounts } from "../adapters/github/github-auth-accounts";
import { WorkspaceOriginFinder } from "../adapters/github/workspace-origin-finder";
import { discoverExecutable } from "../adapters/process/executable-discovery";
import { systemNow } from "../adapters/process/system-clock";
import type {
  GitHubDirectSummaryGateway,
  GitHubMergeWriter,
  GitHubPendingReviewGateway,
  GitHubReader,
  GitHubReadFailure,
  GitHubReviewWriter,
} from "../adapters/github/github-adapter";
import type { RepositoryLabelListing } from "../domain/github-context";
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
import {
  LabelService,
  type LabelCommand,
  type LabelListFailure,
  type LabelListOutcome,
} from "../services/label-service";
import {
  AssigneeService,
  type AssigneeCommand,
  type AssigneeListFailure,
  type AssigneeListOutcome,
} from "../services/assignee-service";
import {
  ReviewerService,
  type ReviewerCommand,
  type ReviewerListFailure,
  type ReviewerListOutcome,
} from "../services/reviewer-service";
import type { ReviewWriteExpectation } from "../services/review-write-gate";
import {
  PendingReviewService,
  projectPendingReview,
  type PendingReviewProjection,
} from "../services/pending-review-service";
import {
  anchorSchema,
  findingSourceSchema,
  parseFindingReviewSourceFields,
  parsePendingReviewAnchorFields,
  type FindingReviewSource,
  type PendingReviewAnchor,
} from "../domain/pending-review";
import { definedProps } from "../domain/defined-props";
import {
  DirectSummaryReviewService,
  projectDirectSummaryReview,
} from "../services/direct-summary-review-service";
import { ReviewOperationCoordinator } from "../services/review-operation-coordinator";
import type { RecentReviewWrite } from "../domain/recent-review-write";
import {
  AvatarSyncService,
  type AvatarFetcher,
} from "../services/avatar-sync-service";
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
import { startRetentionSweepScheduler } from "./retention-sweep-scheduler";
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
  DEFAULT_INBOX_PAGE_SIZE,
  INBOX_PAGE_SIZES,
  MAX_INBOX_FILTER_LABELS,
  MAX_INBOX_FILTER_LABEL_LENGTH,
  type InboxFilter,
  type InboxPageSize,
} from "../domain/maintainer-inbox";
import {
  parseContentHash,
  parseFindingId,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitHubReviewNodeId,
  parseGitHubThreadId,
  parseGitSha,
  parseInsightRunId,
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type GitHubReviewNodeId,
  type ReviewId,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../domain/ids";
import type { InboxRepositoryRef } from "../services/maintainer-inbox-service";
import type { InsightType } from "../domain/insight-record";
import { rawJsonValueSchema, type RawJsonValue } from "../domain/json";

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
  strictObject({
    _tag: picklist(["LabelChange"] as const),
    added: array(string()),
    removed: array(string()),
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
const labelRefSchema = strictObject({
  id: pipe(string(), minLength(1)),
  name: pipe(string(), minLength(1)),
});
const labelCommandSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  command: variant("_tag", [
    strictObject({
      _tag: picklist(["AddLabels"] as const),
      labels: pipe(array(labelRefSchema), minLength(1)),
    }),
    strictObject({
      _tag: picklist(["RemoveLabels"] as const),
      labels: pipe(array(labelRefSchema), minLength(1)),
    }),
  ]),
});
const assigneeRefSchema = strictObject({
  id: pipe(string(), minLength(1)),
  login: pipe(string(), minLength(1)),
});
const assigneeCommandSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  command: variant("_tag", [
    strictObject({
      _tag: picklist(["AddAssignees"] as const),
      assignees: pipe(array(assigneeRefSchema), minLength(1)),
    }),
    strictObject({
      _tag: picklist(["RemoveAssignees"] as const),
      assignees: pipe(array(assigneeRefSchema), minLength(1)),
    }),
    strictObject({
      _tag: picklist(["AssignSelf"] as const),
    }),
  ]),
});
const reviewerRefSchema = strictObject({
  id: pipe(string(), minLength(1)),
  login: pipe(string(), minLength(1)),
});
const reviewerCommandSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  command: variant("_tag", [
    strictObject({
      _tag: picklist(["RequestReviewers"] as const),
      reviewers: pipe(array(reviewerRefSchema), minLength(1)),
    }),
    strictObject({
      _tag: picklist(["RemoveReviewers"] as const),
      reviewers: pipe(array(reviewerRefSchema), minLength(1)),
    }),
  ]),
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
  /** Test-only profile credential seam; production resolves the configured gh account. */
  readonly githubCredentials?: GitHubCredentials;
  /**
   * Test-only `gh` executable resolver seam. Production discovers `gh` fresh
   * on every managed fetch (via `discoverExecutable`, which adds the macOS
   * Desktop PATH fallback) so a credential helper Git spawns through
   * `/bin/sh` can find it even when Electron was launched from Finder.
   */
  readonly resolveGitHubCli?: () => Promise<string | undefined>;
  /** Composition-root lifecycle gate shared by every durable review mutation. */
  readonly lifecycleGate?: ReviewLifecycleGate;
  /** Composition-root coordinator shared by all Review-scoped mutations. */
  readonly reviewOperations?: ReviewOperationCoordinator;
  /** Composition-root diagnostic service shared by every failure boundary. */
  readonly diagnostics?: ReviewDiagnosticService;
  /** Composition-root local log stream; defaults to a fresh on-disk service. */
  readonly logs?: Pick<AppLogService, "write" | "tail">;
  /** Test-only avatar download seam; production keeps the real network fetcher. */
  readonly fetchAvatar?: AvatarFetcher;
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

const defaultGitReadTimeoutMs = 15_000;
const managedFetchTimeoutMs = 120_000;

/** Creates the main-process Git seam with profile environments and a longer managed-fetch timeout. */
export function createReadOnlyGitExecutor(
  commands: Pick<CommandRunner, "runText">,
): GitReadExecutor {
  return {
    async run(
      argv: ReadonlyArray<string>,
      environment?: Readonly<Record<string, string>>,
    ) {
      let request: CommandRequest = {
        argv,
        timeoutMs: argv.includes("fetch")
          ? managedFetchTimeoutMs
          : defaultGitReadTimeoutMs,
      };
      if (environment !== undefined) request = { ...request, environment };
      const output = await commands.runText(request);
      return output._tag === "ok"
        ? ok({ stdout: output.value })
        : err({ _tag: "GitReadFailed" as const });
    },
  };
}

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
  const commands = new CommandRunner(undefined, (stderr) => {
    // Fires only when a nonzero-exit command failure matched neither a
    // structured signal nor any regex predicate — genuine gh-wording drift
    // worth a human noticing. AppLogService.write already masks credential
    // shapes and bounds message length.
    logs.write({
      process: "main",
      level: "warn",
      topic: "command-runner",
      message: "unclassified command failure",
      meta: { stderr },
    });
  });
  const credentials =
    configuration.githubCredentials ?? new GitHubCliCredentials(commands);
  const github =
    configuration.github ?? new GitHubAdapter(commands, credentials);
  const readOnlyGit = createReadOnlyGitExecutor(commands);
  const resolveGitHubCli =
    configuration.resolveGitHubCli ?? (() => discoverExecutable("gh"));
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
  const storageArtifacts = new ReviewArtifactStorage(paths, systemNow);
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
    now: systemNow,
  };
  const storageManagement = new StorageManagementService(
    configuration.trash === undefined
      ? storageManagementInput
      : { ...storageManagementInput, trash: configuration.trash },
  );
  await ReviewPreparationJournal.recover(
    paths,
    new ReviewWorktreeService(
      paths,
      readOnlyGit,
      credentials,
      resolveGitHubCli,
    ),
    sessions,
    lifecycleGate,
    diagnostics,
  );
  const configuredProfiles = await profiles.list();
  if (configuredProfiles._tag === "err") return { _tag: "recovery-failed" };
  const reviewOperations =
    configuration.reviewOperations ?? new ReviewOperationCoordinator();

  const recovery = new ReviewRecoveryService(profiles, sessions, systemNow, {
    paths,
    artifacts: storageArtifacts,
    diagnostics,
    lifecycleGate,
    mergeOperations: new MergeOperationStore(paths),
    reviews,
    operationCoordinator: reviewOperations,
    github,
  });
  const dashboard = new DashboardController(
    profiles,
    github,
    configuration.origins ?? new WorkspaceOriginFinder(commands),
    paths,
    commands,
  );
  const reviewPreparation = new ReviewSessionPreparation({
    profiles,
    sessions,
    github,
    paths,
    now: systemNow,
    worktrees: new ReviewWorktreeService(
      paths,
      readOnlyGit,
      credentials,
      resolveGitHubCli,
    ),
    context: new ReviewContextService(),
    artifacts: new ReviewArtifactStorage(paths, systemNow),
    lifecycleGate,
    diagnostics,
  });
  const reviewProjection = new ReviewWorkbenchProjectionService(
    profiles,
    sessions,
    reviews,
    insights,
    paths,
  );
  const inlineConversations = new InlineConversationService(
    reviewWriteGate,
    github,
    reviewOperations,
    systemNow,
    recentWriteJournals,
  );
  const labelWrites = new LabelService(
    reviewWriteGate,
    github,
    reviewOperations,
    systemNow,
    recentWriteJournals,
  );
  // Shared with `reviewRefresh` below: one `AvatarSyncService` per profile
  // process, not one per consumer, so every caller warms and reads the same
  // on-disk cache.
  const avatarSync = new AvatarSyncService({
    paths,
    fetchAvatar: configuration.fetchAvatar ?? createAvatarFetcher(),
    log: logs,
  });
  const avatarRailDependencies = { paths, sync: avatarSync };
  const assigneeWrites = new AssigneeService(
    reviewWriteGate,
    github,
    reviewOperations,
    systemNow,
    recentWriteJournals,
    avatarRailDependencies,
  );
  const reviewerWrites = new ReviewerService(
    reviewWriteGate,
    github,
    reviewOperations,
    systemNow,
    recentWriteJournals,
    avatarRailDependencies,
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
          systemNow,
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
          systemNow,
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
    now: systemNow,
    operationCoordinator: reviewOperations,
    pendingReview: pendingReviews,
    recentWrites: recentWriteJournals,
    log: logs,
    avatars: avatarSync,
    project: ({
      profileId,
      sessionId,
      snapshot,
      refreshedAt,
      freshness,
      pendingReview,
    }) => {
      const projectInput = {
        profileId,
        sessionId,
        snapshot,
        refreshedAt,
        freshness,
      };
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
    now: systemNow,
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
      logs,
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
          systemNow,
          new MergeOperationStore(paths),
          reviewWriteGate,
          { reviews, insights },
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
  app.get("/v1/inbox", async (context) =>
    runWithRequestAbortSignal(context.req.raw.signal, async () => {
      // The filter is a structured, enumerated value — each field is
      // validated against a literal union here, exactly as `state` was
      // validated here. The renderer never sends a GitHub search
      // qualifier string; `buildInboxSearchQuery` in
      // `maintainer-inbox-service.ts` is the only place that composes one.
      const state = context.req.query("state") ?? "open";
      if (state !== "open" && state !== "merged")
        return response(context, err({ reason: "invalid_input" }));
      const pageSize = parseInboxPageSize(context.req.query("pageSize"));
      if (pageSize === undefined)
        return response(context, err({ reason: "invalid_input" }));
      const repository = parseInboxRepositoryQuery(
        context.req.query("host"),
        context.req.query("owner"),
        context.req.query("repo"),
      );
      if (repository === "invalid")
        return response(context, err({ reason: "invalid_input" }));
      const labels = parseInboxLabelsQuery(context.req.queries("label") ?? []);
      if (labels === "invalid")
        return response(context, err({ reason: "invalid_input" }));
      const awaitingMyReview = parseInboxBooleanQuery(
        context.req.query("awaitingMyReview"),
      );
      if (awaitingMyReview === "invalid")
        return response(context, err({ reason: "invalid_input" }));
      const labelsField = labels.length === 0 ? {} : { labels };
      const awaitingMyReviewField = awaitingMyReview
        ? { awaitingMyReview }
        : {};
      const filter: InboxFilter = {
        state,
        ...labelsField,
        ...awaitingMyReviewField,
      };
      const page = context.req.query("page");
      const result = await dashboard.inboxForActiveProfile(
        repository,
        page === undefined
          ? { filter, pageSize }
          : { filter, pageSize, pageToken: page },
      );
      if (result._tag === "err")
        await recordProfileReloadFailure("profile-reload-inbox");
      return response(context, result);
    }),
  );
  // Repository-scoped, never Review-scoped: `GET /v1/reviews/labels` cannot
  // serve the Pull requests screen's label filter because it resolves the
  // repository through a Review session (`requireCurrentSession`), and the
  // screen has no `reviewId`. This route reads `github.listRepositoryLabels`
  // directly rather than through `LabelService` — labels for a filter
  // picker never need that service's write gate or its resolved permission,
  // and the inbox is read-only.
  app.get("/v1/inbox/labels", async (context) =>
    runWithRequestAbortSignal(context.req.raw.signal, async () => {
      const repository = parseInboxRepositoryQuery(
        context.req.query("host"),
        context.req.query("owner"),
        context.req.query("repo"),
      );
      if (repository === "invalid")
        return response(context, err({ reason: "invalid_input" }));
      // Validated against the active profile's watchlist before any GitHub
      // call, exactly as `GET /v1/inbox` validates its own `repository`
      // query params — without this a renderer could read labels from any
      // repository the active token can see, not just a watched one.
      const resolved = await dashboard.activeProfileRepository(repository);
      if (resolved._tag === "err") return response(context, resolved);
      if (resolved.value.repository === undefined)
        return context.json({ state: "ready", labels: [], totalCount: 0 });
      return repositoryLabelListResponse(
        context,
        await github.listRepositoryLabels({
          profile: resolved.value.profile,
          repo: resolved.value.repository,
        }),
      );
    }),
  );
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
    const [git, gh, ghAuth, githubAccounts] = await Promise.all([
      commands.runText({ argv: ["git", "--version"], timeoutMs: 5_000 }),
      commands.runText({ argv: ["gh", "--version"], timeoutMs: 5_000 }),
      commands.runText({ argv: ["gh", "auth", "status"], timeoutMs: 10_000 }),
      listAuthenticatedGitHubAccounts(commands, 10_000),
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
      githubAccounts,
      runtime: "bundled",
    });
  });
  app.post("/v1/reviews/inline-conversations/command", async (context) =>
    inlineConversationResponse(
      context,
      inlineConversations,
      parseInlineConversationCommand(await jsonBody(context), logs),
    ),
  );
  app.post("/v1/reviews/labels/command", async (context) =>
    labelResponse(context, labelWrites, await jsonBody(context)),
  );
  app.get("/v1/reviews/labels", async (context) => {
    const profileId = parseWorkspaceProfileId(context.req.query("profileId"));
    const reviewId = parseReviewId(context.req.query("reviewId"));
    if (profileId._tag === "err" || reviewId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    return labelListResponse(
      context,
      await labelWrites.list({
        profileId: profileId.value,
        reviewId: reviewId.value,
      }),
    );
  });
  app.post("/v1/reviews/assignees/command", async (context) =>
    assigneeResponse(context, assigneeWrites, await jsonBody(context)),
  );
  app.get("/v1/reviews/assignees", async (context) => {
    const profileId = parseWorkspaceProfileId(context.req.query("profileId"));
    const reviewId = parseReviewId(context.req.query("reviewId"));
    if (profileId._tag === "err" || reviewId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    const rawQuery = context.req.query("query");
    const queryField =
      rawQuery !== undefined && rawQuery.length > 0 ? { query: rawQuery } : {};
    return assigneeListResponse(
      context,
      await assigneeWrites.list({
        profileId: profileId.value,
        reviewId: reviewId.value,
        ...queryField,
      }),
    );
  });
  app.post("/v1/reviews/reviewers/command", async (context) =>
    reviewerResponse(context, reviewerWrites, await jsonBody(context)),
  );
  app.get("/v1/reviews/reviewers", async (context) => {
    const profileId = parseWorkspaceProfileId(context.req.query("profileId"));
    const reviewId = parseReviewId(context.req.query("reviewId"));
    if (profileId._tag === "err" || reviewId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    const rawQuery = context.req.query("query");
    const queryField =
      rawQuery !== undefined && rawQuery.length > 0 ? { query: rawQuery } : {};
    return reviewerListResponse(
      context,
      await reviewerWrites.list({
        profileId: profileId.value,
        reviewId: reviewId.value,
        ...queryField,
      }),
    );
  });
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
  app.post("/v1/reviews/open-merged", async (context) => {
    const parsed = safeParse(reviewOpenSchema, await jsonBody(context));
    return parsed.success
      ? response(context, await reviewWorkbench.openMerged(parsed.output))
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
      } else if (entry._tag === "DirectSummaryReview") {
        recentWrites.push({
          _tag: "DirectSummaryReview",
          reviewId: entry.reviewId,
        });
      } else {
        recentWrites.push({
          _tag: "LabelChange",
          added: entry.added,
          removed: entry.removed,
        });
      }
    }
    const detectUpdatesInput = {
      profileId: profileId.value,
      reviewId: reviewId.value,
    };
    return runWithRequestAbortSignal(context.req.raw.signal, async () =>
      response(
        context,
        await reviewWorkbench.detectUpdates(
          recentWrites.length === 0
            ? detectUpdatesInput
            : { ...detectUpdatesInput, recentWrites },
        ),
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
        -readonly [
          K in "meta" | "profileId" | "sessionId" | "correlationId"
        ]?: LogEntryInput[K];
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

  const retentionScheduler = startRetentionSweepScheduler({
    profiles: configuredProfiles.value,
    storageManagement,
    enabled: configuration.retentionSweep ?? false,
    diagnostics,
  });

  return {
    _tag: "started",
    server: {
      capability: parsedConfiguration.output.capability,
      url,
      async stop(): Promise<void> {
        await retentionScheduler.stop();
        await closeServer(server);
      },
    },
  };
}

const rendererLogEntrySchema = strictObject({
  level: picklist(["debug", "info", "warn", "error"]),
  topic: pipe(string(), minLength(1), maxLength(48)),
  message: pipe(string(), minLength(1), maxLength(512)),
  meta: optional(record(string(), rawJsonValueSchema)),
  profileId: optional(pipe(string(), minLength(1), maxLength(180))),
  sessionId: optional(pipe(string(), minLength(1), maxLength(180))),
  correlationId: optional(pipe(string(), minLength(1), maxLength(120))),
});
type LogWriter = Pick<AppLogService, "write">;
/** Logs every authenticated loopback request; the log endpoints and health never log themselves. */
function logLocalApiRequests(logs: LogWriter): MiddlewareHandler {
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
    // The query string carries the opaque, credential-free pagination
    // token (see the plan's Shared Contract), so it is safe to log; without
    // it every inbox request line reads as a bare `GET /v1/inbox` with no
    // way to see which page was requested.
    const query = new URL(context.req.url).search;
    logs.write({
      process: "main",
      level: status >= 500 ? "error" : status >= 400 ? "warn" : "debug",
      topic: "http",
      message: `${context.req.method} ${path}${query}`,
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

async function jsonBody(context: Context): Promise<RawJsonValue | undefined> {
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
    // `RawJsonValue` (the JSON value grammar) so every caller must still
    // validate the parsed body's shape before use.
    return JSON.parse(new TextDecoder().decode(combined)) as RawJsonValue;
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

function pendingReviewFailureStatus(
  failure: string,
): 400 | 403 | 404 | 409 | 503 {
  if (failure === "invalid_input") return 400;
  if (failure === "not_found") return 404;
  if (failure === "forbidden") return 403;
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

const reviewWriteExpectationSchema = object({
  sessionId: string(),
  headSha: string(),
  patchHash: string(),
});

/**
 * The wire shapes of the two pending-review payloads that also live in a
 * durable artifact. Both take their fields from the domain's own schemas so
 * route and stored record cannot drift apart, and both relax `strictObject`
 * to `object`: a request body may carry keys this route does not read, which
 * the field-by-field reads they replaced ignored.
 */
const pendingReviewAnchorSchema = object(anchorSchema.entries);
const findingReviewSourceSchema = object(findingSourceSchema.entries);

const reviewEventSchema = picklist(["APPROVE", "COMMENT", "REQUEST_CHANGES"]);

/**
 * A comment body has to hold something other than whitespace. The trim is
 * only the test — the body is stored exactly as the client sent it.
 */
const commentBodySchema = pipe(
  string(),
  check((value) => value.trim().length > 0),
);

const directSummaryCommandSchema = object({
  profileId: string(),
  reviewId: string(),
  expected: reviewWriteExpectationSchema,
  event: reviewEventSchema,
  body: commentBodySchema,
});

const pendingReviewCommandSchema = object({
  profileId: string(),
  reviewId: string(),
  command: variant("_tag", [
    object({
      _tag: literal("Start"),
      expected: reviewWriteExpectationSchema,
      anchor: pendingReviewAnchorSchema,
      body: commentBodySchema,
      finding: optional(findingReviewSourceSchema),
    }),
    object({
      _tag: literal("AddThread"),
      expected: reviewWriteExpectationSchema,
      pendingReviewNodeId: string(),
      anchor: pendingReviewAnchorSchema,
      body: commentBodySchema,
      finding: optional(findingReviewSourceSchema),
    }),
    object({
      _tag: literal("Submit"),
      expected: reviewWriteExpectationSchema,
      event: reviewEventSchema,
      // No emptiness rule, unlike a comment body: a review verdict may be
      // submitted with no summary at all.
      summaryBody: string(),
    }),
    object({
      _tag: literal("Discard"),
      expected: reviewWriteExpectationSchema,
      // Discard is destructive: the command must carry the explicit
      // confirmation, so `false` is as invalid as an absent field.
      confirmation: literal(true),
    }),
  ]),
});

function parseDirectSummaryCommand(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema parsing on the raw body immediately.
  body: unknown,
):
  | {
      readonly profileId: WorkspaceProfileId;
      readonly reviewId: ReviewId;
      readonly expected: ReviewWriteExpectation;
      readonly event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
      readonly body: string;
    }
  | undefined {
  const parsed = safeParse(directSummaryCommandSchema, body);
  if (!parsed.success) return undefined;
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  const expected = parseReviewWriteExpectation(parsed.output.expected);
  return profileId._tag === "err" ||
    reviewId._tag === "err" ||
    expected === undefined
    ? undefined
    : {
        profileId: profileId.value,
        reviewId: reviewId.value,
        expected,
        event: parsed.output.event,
        body: parsed.output.body,
      };
}

function parsePendingReviewCommand(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema parsing on the raw body immediately.
  body: unknown,
):
  | {
      readonly profileId: WorkspaceProfileId;
      readonly reviewId: ReviewId;
      readonly command: PendingReviewCommandDto;
    }
  | undefined {
  const parsed = safeParse(pendingReviewCommandSchema, body);
  if (!parsed.success) return undefined;
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  const expected = parseReviewWriteExpectation(parsed.output.command.expected);
  if (
    profileId._tag === "err" ||
    reviewId._tag === "err" ||
    expected === undefined
  )
    return undefined;
  const command = parsePendingReviewCommandDto(parsed.output.command, expected);
  return command === undefined
    ? undefined
    : { profileId: profileId.value, reviewId: reviewId.value, command };
}

/**
 * Turns one shape-checked pending-review command into its DTO, applying the
 * identifier rules the schema cannot express. `Submit` and `Discard` carry
 * none; the two thread-writing commands share an anchor and an optional
 * Finding authorization, so they share this parse.
 */
function parsePendingReviewCommandDto(
  command: InferOutput<typeof pendingReviewCommandSchema>["command"],
  expected: ReviewWriteExpectation,
): PendingReviewCommandDto | undefined {
  if (command._tag === "Submit")
    return {
      _tag: "Submit",
      expected,
      event: command.event,
      summaryBody: command.summaryBody,
    };
  if (command._tag === "Discard")
    return { _tag: "Discard", expected, confirmation: true };
  const anchor = parsePendingReviewAnchorFields(command.anchor);
  const finding =
    command.finding === undefined
      ? undefined
      : parseFindingReviewSourceFields(command.finding);
  if (
    anchor === undefined ||
    (command.finding !== undefined && finding === undefined)
  )
    return undefined;
  const authorization = definedProps({ finding });
  if (command._tag === "Start")
    return {
      _tag: "Start",
      expected,
      anchor,
      body: command.body,
      ...authorization,
    };
  const nodeId = parseGitHubReviewNodeId(command.pendingReviewNodeId);
  return nodeId._tag === "err"
    ? undefined
    : {
        _tag: "AddThread",
        expected,
        pendingReviewNodeId: nodeId.value,
        anchor,
        body: command.body,
        ...authorization,
      };
}

function parseReviewWriteExpectation(
  input: InferOutput<typeof reviewWriteExpectationSchema>,
): ReviewWriteExpectation | undefined {
  const sessionId = parseReviewSessionId(input.sessionId);
  const headSha = parseGitSha(input.headSha);
  const patchHash = parseContentHash(input.patchHash);
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

/**
 * The eight write-failure reasons every review write route shares.
 * `LabelWriteFailure`, `AssigneeWriteFailure`, `ReviewerWriteFailure` and
 * `DirectConversationFailure` all contain exactly these; each service's own
 * extra reasons stay out of this union and travel in `overrides` instead.
 */
type ReviewWriteFailureReason =
  | "invalid_input"
  | "not_found"
  | "permission_denied"
  | "forbidden"
  | "github_read_failed"
  | "github_write_failed"
  | "rate_limited"
  | "review_write_in_progress";

/** The HTTP statuses a refused review write answers with. */
type ReviewWriteFailureStatus = 400 | 403 | 404 | 409 | 503;

type SharedReviewWriteFailureStatuses = {
  readonly [Reason in ReviewWriteFailureReason]: ReviewWriteFailureStatus;
};

const sharedReviewWriteFailureStatus: SharedReviewWriteFailureStatuses = {
  not_found: 404,
  // `forbidden` is GitHub refusing the account; `permission_denied` is this
  // Review's own write gate refusing the attempt (see each service's
  // `mapGateFailure`), a conflict refreshing clears — hence 409, not 403.
  forbidden: 403,
  permission_denied: 409,
  review_write_in_progress: 409,
  github_read_failed: 503,
  github_write_failed: 503,
  rate_limited: 503,
  // A rule the service enforces locally, before contacting GitHub at all.
  invalid_input: 400,
};

/**
 * Maps one review write failure to its status, so the four write routes
 * answer the shared reasons identically. `overrides` carries the reasons only
 * one service can report; the compiler demands an entry for every reason the
 * caller's union holds beyond the shared eight, so a new reason on any of
 * those services fails the build here instead of falling through to 400.
 */
function mapReviewWriteFailureStatus<Extra extends string = never>(
  // `NoInfer` reads `Extra` off `overrides` alone; inferring it from the
  // reason would let an unlisted reason widen `Extra` to itself and pass.
  reason: ReviewWriteFailureReason | NoInfer<Extra>,
  overrides: Readonly<Record<Extra, ReviewWriteFailureStatus>>,
): ReviewWriteFailureStatus {
  const statuses = { ...sharedReviewWriteFailureStatus, ...overrides };
  return statuses[reason];
}

async function inlineConversationResponse(
  context: Context,
  service: InlineConversationService,
  parsed: ParsedInlineConversationCommand | undefined,
): Promise<Response> {
  if (parsed === undefined)
    return context.json({ error: "invalid_input" }, 400);
  const result = await service.execute(parsed);
  if (result._tag === "ok") return context.json(result.value);
  return context.json(
    { error: result.error },
    // The three conversation-only reasons are all conflicts with the state
    // the client wrote against.
    mapReviewWriteFailureStatus(result.error, {
      not_fresh: 409,
      pending_review: 409,
      confirmation_required: 409,
    }),
  );
}
type ParsedInlineConversationCommand = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly command: DirectConversationCommand;
};
function parseInlineConversationCommand(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
  logs: LogWriter,
): ParsedInlineConversationCommand | undefined {
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
  const profileOk = profileId._tag;
  const reviewOk = reviewId._tag;
  const sessionOk = sessionId._tag;
  const headShaOk = headSha._tag;
  const patchHashOk = patchHash._tag;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field (from readObjectField, typed unknown) at this exact I/O boundary; no earlier parser exists for this primitive shape.
  const tagType = typeof tag;
  if (
    profileOk === "err" ||
    reviewOk === "err" ||
    sessionOk === "err" ||
    headShaOk === "err" ||
    patchHashOk === "err" ||
    tagType !== "string"
  ) {
    logs.write({
      process: "main",
      level: "warn",
      topic: "http",
      message: "inline conversation command parse failed",
      meta: { profileOk, reviewOk, sessionOk, headShaOk, patchHashOk, tagType },
    });
    return undefined;
  }
  const expected = {
    sessionId: sessionId.value,
    headSha: headSha.value,
    patchHash: patchHash.value,
  };
  const parsed = safeParse(inlineConversationCommandSchema, raw);
  if (!parsed.success) return undefined;
  const command = parsed.output;
  // The one rule left that no schema can state: a thread identifier has to be
  // one GitHub can address.
  if (
    (command._tag === "Reply" || command._tag === "SetThreadState") &&
    parseGitHubThreadId(command.threadId)._tag === "err"
  )
    return undefined;
  return {
    profileId: profileId.value,
    reviewId: reviewId.value,
    command: { ...command, expected },
  };
}

/**
 * Looser than `pendingReviewAnchorSchema`: this route places a comment
 * against whatever line pair the client read off the diff, without the
 * pending review's `startLine >= 1` and `line >= startLine` rules, and keeps
 * the plain-string path `DirectConversationCommand` declares.
 */
const inlineConversationAnchorSchema = object({
  path: string(),
  startLine: pipe(number(), integer()),
  line: pipe(number(), integer()),
  side: picklist(["new", "old"]),
});

/**
 * `expected` is absent from every member on purpose: the caller reads and
 * brands it first, so it can report which field failed before this runs.
 */
const inlineConversationCommandSchema = variant("_tag", [
  object({
    _tag: literal("CreateComment"),
    anchor: inlineConversationAnchorSchema,
    body: string(),
  }),
  object({ _tag: literal("Reply"), threadId: string(), body: string() }),
  object({
    _tag: literal("SetThreadState"),
    threadId: string(),
    state: picklist(["open", "resolved"]),
  }),
  object({ _tag: literal("EditComment"), commentId: string(), body: string() }),
  object({
    _tag: literal("DeleteComment"),
    commentId: string(),
    // Any boolean, not only `true`: unlike a pending-review discard, this
    // route answers an unconfirmed delete with `confirmation_required`
    // rather than refusing the command as malformed.
    confirmation: boolean(),
  }),
]);

async function labelResponse(
  context: Context,
  service: LabelService,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Response> {
  const parsed = safeParse(labelCommandSchema, body);
  if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  if (profileId._tag === "err" || reviewId._tag === "err")
    return context.json({ error: "invalid_input" }, 400);
  const command: LabelCommand = parsed.output.command;
  const result = await service.execute({
    profileId: profileId.value,
    reviewId: reviewId.value,
    command,
  });
  if (result._tag === "ok") return context.json(result.value);
  // `LabelWriteFailure` is exactly the shared eight, so no overrides.
  return context.json(
    { error: result.error },
    mapReviewWriteFailureStatus(result.error, {}),
  );
}

/**
 * Shapes a repository-wide label read directly from `GitHubReadFailure` for
 * `GET /v1/inbox/labels` — this route reads through
 * `github.listRepositoryLabels` directly rather than a service, so there is
 * no review-resolution half to fail outright, unlike `labelListResponse`
 * below. `permission` is omitted: the inbox's label filter is read-only and
 * never resolves it.
 */
function repositoryLabelListResponse(
  context: Context,
  result: Result<RepositoryLabelListing, GitHubReadFailure>,
): Response {
  if (result._tag === "ok")
    return context.json({
      state: "ready",
      labels: result.value.labels,
      totalCount: result.value.totalCount,
    });
  const failure = result.error;
  if (failure._tag === "GitHubRateLimited") {
    const resumeAtField =
      failure.resumeAt === undefined ? {} : { resumeAt: failure.resumeAt };
    return context.json({ state: "github_rate_limited", ...resumeAtField });
  }
  if (failure._tag === "GitHubForbidden")
    return context.json({
      state: "github_forbidden",
      forbiddenReason: failure.reason,
    });
  if (failure._tag === "GitHubAuthenticationFailed")
    return context.json({ state: "github_auth" });
  return context.json({ state: "github_read" });
}

/**
 * Shapes a repository label listing the same way `GET /v1/inbox` shapes
 * per-repo failure state: a GitHub read failure (auth/rate-limit/forbidden)
 * is data in a 200 response, not an HTTP error, so its specific reason
 * survives to the renderer. Only the review-resolution half — the review
 * itself missing or refused — becomes an HTTP error, mirroring
 * `labelResponse`'s write-path status mapping.
 */
function labelListResponse(
  context: Context,
  result: Result<LabelListOutcome, LabelListFailure>,
): Response {
  if (result._tag === "err")
    return context.json(
      { error: result.error },
      result.error === "not_found" ? 404 : 409,
    );
  const outcome = result.value;
  if (outcome._tag === "ready")
    return context.json({
      state: "ready",
      labels: outcome.labels,
      totalCount: outcome.totalCount,
      permission: outcome.permission,
    });
  if (outcome._tag === "github_rate_limited") {
    const resumeAtField =
      outcome.resumeAt === undefined ? {} : { resumeAt: outcome.resumeAt };
    return context.json({ state: "github_rate_limited", ...resumeAtField });
  }
  if (outcome._tag === "github_forbidden")
    return context.json({
      state: "github_forbidden",
      forbiddenReason: outcome.reason,
    });
  return context.json({ state: outcome._tag });
}

async function assigneeResponse(
  context: Context,
  service: AssigneeService,
  body: RawJsonValue | undefined,
): Promise<Response> {
  const parsed = safeParse(assigneeCommandSchema, body);
  if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  if (profileId._tag === "err" || reviewId._tag === "err")
    return context.json({ error: "invalid_input" }, 400);
  const command: AssigneeCommand = parsed.output.command;
  const result = await service.execute({
    profileId: profileId.value,
    reviewId: reviewId.value,
    command,
  });
  if (result._tag === "ok") return context.json(result.value);
  return context.json(
    { error: result.error },
    // "assignee_cap_exceeded" joins "invalid_input" at 400: another rule the
    // service enforces locally, not a GitHub-reported conflict.
    mapReviewWriteFailureStatus(result.error, { assignee_cap_exceeded: 400 }),
  );
}

/**
 * Shapes an assignable-user listing the same way `labelListResponse` shapes
 * a repository label listing: a GitHub read failure (auth/rate-limit/forbidden)
 * is data in a 200 response, not an HTTP error, so its specific reason
 * survives to the renderer. Only the review-resolution half — the review
 * itself missing or refused — becomes an HTTP error, mirroring
 * `assigneeResponse`'s write-path status mapping.
 */
function assigneeListResponse(
  context: Context,
  result: Result<AssigneeListOutcome, AssigneeListFailure>,
): Response {
  if (result._tag === "err")
    return context.json(
      { error: result.error },
      result.error === "not_found" ? 404 : 409,
    );
  const outcome = result.value;
  if (outcome._tag === "ready")
    return context.json({
      state: "ready",
      users: outcome.users,
      totalCount: outcome.totalCount,
      permission: outcome.permission,
    });
  if (outcome._tag === "github_rate_limited") {
    const resumeAtField =
      outcome.resumeAt === undefined ? {} : { resumeAt: outcome.resumeAt };
    return context.json({ state: "github_rate_limited", ...resumeAtField });
  }
  if (outcome._tag === "github_forbidden")
    return context.json({
      state: "github_forbidden",
      forbiddenReason: outcome.reason,
    });
  return context.json({ state: outcome._tag });
}

async function reviewerResponse(
  context: Context,
  service: ReviewerService,
  body: RawJsonValue | undefined,
): Promise<Response> {
  const parsed = safeParse(reviewerCommandSchema, body);
  if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  if (profileId._tag === "err" || reviewId._tag === "err")
    return context.json({ error: "invalid_input" }, 400);
  const command: ReviewerCommand = parsed.output.command;
  const result = await service.execute({
    profileId: profileId.value,
    reviewId: reviewId.value,
    command,
  });
  if (result._tag === "ok") return context.json(result.value);
  // `ReviewerWriteFailure` is exactly the shared eight: no reviewer cap
  // exists to enforce, so unlike assignees there is nothing to override.
  return context.json(
    { error: result.error },
    mapReviewWriteFailureStatus(result.error, {}),
  );
}

/**
 * Shapes a reviewer listing the same way `assigneeListResponse` shapes an
 * assignable-user listing: a GitHub read failure (auth/rate-limit/forbidden)
 * is data in a 200 response, not an HTTP error, so its specific reason
 * survives to the renderer. Only the review-resolution half — the review
 * itself missing or refused — becomes an HTTP error, mirroring
 * `reviewerResponse`'s write-path status mapping.
 */
function reviewerListResponse(
  context: Context,
  result: Result<ReviewerListOutcome, ReviewerListFailure>,
): Response {
  if (result._tag === "err")
    return context.json(
      { error: result.error },
      result.error === "not_found" ? 404 : 409,
    );
  const outcome = result.value;
  if (outcome._tag === "ready")
    return context.json({
      state: "ready",
      reviewers: outcome.reviewers,
      suggested: outcome.suggested,
      candidates: outcome.candidates,
      candidatesTotalCount: outcome.candidatesTotalCount,
      permission: outcome.permission,
    });
  if (outcome._tag === "github_rate_limited") {
    const resumeAtField =
      outcome.resumeAt === undefined ? {} : { resumeAt: outcome.resumeAt };
    return context.json({ state: "github_rate_limited", ...resumeAtField });
  }
  if (outcome._tag === "github_forbidden")
    return context.json({
      state: "github_forbidden",
      forbiddenReason: outcome.reason,
    });
  return context.json({ state: outcome._tag });
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

/** A missing value means the default; anything else must be one of the listed sizes exactly. */
function parseInboxPageSize(
  value: string | undefined,
): InboxPageSize | undefined {
  if (value === undefined) return DEFAULT_INBOX_PAGE_SIZE;
  return INBOX_PAGE_SIZES.find((size) => String(size) === value);
}

/**
 * Parses the `GET /v1/inbox` repository query params. All three are omitted
 * together when the renderer has not learned the active profile's watchlist
 * yet (the bootstrap request); `DashboardController.inboxForActiveProfile`
 * falls back to the profile's first watched repository in that case. A
 * request that supplies any of the three but fails to parse as a genuine
 * GitHub host/owner/repo is malformed, not omitted, so it is rejected here
 * rather than silently falling back — the watchlist-membership check itself
 * lives in the controller, which already holds the active profile.
 */
function parseInboxRepositoryQuery(
  host: string | undefined,
  owner: string | undefined,
  repo: string | undefined,
): InboxRepositoryRef | undefined | "invalid" {
  if (host === undefined && owner === undefined && repo === undefined)
    return undefined;
  const parsedHost = parseGitHubHost(host);
  const parsedOwner = parseGitHubOwner(owner);
  const parsedRepo = parseGitHubRepoName(repo);
  if (
    parsedHost._tag === "err" ||
    parsedOwner._tag === "err" ||
    parsedRepo._tag === "err"
  )
    return "invalid";
  return {
    host: parsedHost.value,
    owner: parsedOwner.value,
    repo: parsedRepo.value,
  };
}

/**
 * Validates the `GET /v1/inbox` `label` query param(s) — repeatable, one per
 * selected label — into the structured filter `buildInboxSearchQuery`
 * composes into `label:"NAME"` qualifiers. Bounded by count and length so
 * the composed query cannot exceed GitHub's 256-character search cap, and
 * stripped of the double quote a label name would otherwise use to break
 * out of its own qualifier. This is the injection boundary ADR 0031/0032
 * name: the renderer sends label names, never GitHub search-qualifier text.
 */
/**
 * Validates a boolean `GET /v1/inbox` filter param — today the "Awaiting
 * review from you" preset. Absent means off; only the spellings a
 * `URLSearchParams` caller would produce are accepted, and anything else is
 * `invalid_input` rather than a silent false, so a typo in the query string
 * is reported instead of quietly widening the listing.
 */
function parseInboxBooleanQuery(
  value: string | undefined,
): boolean | "invalid" {
  if (value === undefined) return false;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return "invalid";
}

function parseInboxLabelsQuery(
  values: ReadonlyArray<string>,
): ReadonlyArray<string> | "invalid" {
  if (values.length > MAX_INBOX_FILTER_LABELS) return "invalid";
  const labels: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (
      trimmed.length === 0 ||
      trimmed.length > MAX_INBOX_FILTER_LABEL_LENGTH ||
      containsQuoteOrControlCharacter(trimmed)
    )
      return "invalid";
    labels.push(trimmed);
  }
  return labels;
}

/** Rejects the double quote a label would otherwise use to break out of its
 * own `label:"NAME"` qualifier, and any control character (including
 * newlines) — a real GitHub label name has no legitimate use for either. */
function containsQuoteOrControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (value[i] === '"' || code <= 0x1f || code === 0x7f) return true;
  }
  return false;
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

/** The statuses `response` answers a failed result with. */
type ResponseFailureStatus = 400 | 401 | 403 | 404 | 409 | 503;

/**
 * Every failure reason `response` can put on the wire, and the status it
 * answers with. Enumerated from the thirty `response(...)` call sites and
 * the error types their producers declare. A table rather than the substring
 * ladder it replaces, because that ladder decided several of these by
 * accident — `merge_forbidden` reached 403 by containing "forbidden" — so
 * renaming a reason silently moved its status. Every status below is the one
 * that ladder produced.
 */
const responseFailureStatus = new Map<string, ResponseFailureStatus>([
  ["not_found", 404],
  ["github_auth", 401],
  ["authentication_required", 401],
  ["merge_forbidden", 403],
  // Conflicts with state the client wrote against, or with a write already
  // running. `revision_conflict` is declared by `ReviewWorkbenchFailure` and
  // constructed nowhere; it stays so producing it later keeps this status.
  ["head_changed", 409],
  ["merge_in_progress", 409],
  ["merge_outcome_unknown", 409],
  ["not_fresh", 409],
  ["revision_conflict", 409],
  ["stale_head", 409],
  ["terminal", 409],
  ["github_read", 503],
  ["merge_rate_limited", 503],
  ["rate_limited", 503],
  ["runtime_unavailable", 503],
  ["storage", 503],
  ["storage_failed", 503],
  // Reported as a malformed request today, and only `invalid_input` belongs
  // here: `stale` is the conflict its sibling `stale_head` answers with 409,
  // `merge_blocked` and `merge_acknowledgement_required` are refusals,
  // `invalid_result` and `merge_failed` are upstream failures, and
  // `timed_out` never reaches the renderer's 504 branch. Correcting any of
  // them changes what the renderer shows, so each needs its own change.
  ["invalid_input", 400],
  ["invalid_result", 400],
  ["merge_acknowledgement_required", 400],
  ["merge_blocked", 400],
  ["merge_failed", 400],
  ["stale", 400],
  ["timed_out", 400],
]);

/**
 * The default answers a reason no producer declares — `MergeWriteController`
 * types its failure as a bare `string`, so this cannot be a total function.
 */
function statusForReason(reason: string): ResponseFailureStatus {
  return responseFailureStatus.get(reason) ?? 400;
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

/** GitHub avatar URLs accept `?s=<pixels>`; a small size keeps cached files tiny. */
const AVATAR_FETCH_SIZE_PX = 64;
/** Bounds one avatar download so a slow or hanging host can never stall a sync. */
const AVATAR_FETCH_TIMEOUT_MS = 3_000;

/**
 * Plain-HTTP avatar downloader for `AvatarSyncService`. Deliberately not the
 * gh-CLI-backed `GitHubAdapter`: avatar images are public, unauthenticated
 * URLs, so this uses the same bare `fetch` already used for the health
 * check above and the desktop bridge, bounded by an abort timeout.
 */
function createAvatarFetcher(): AvatarFetcher {
  return async (avatarUrl) => {
    let target: string;
    try {
      const sized = new URL(avatarUrl);
      sized.searchParams.set("s", String(AVATAR_FETCH_SIZE_PX));
      target = sized.toString();
    } catch {
      return undefined;
    }
    const response = await fetch(target, {
      signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return { bytes: new Uint8Array(await response.arrayBuffer()) };
  };
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

/**
 * `server.close()`'s callback only fires once every open connection has
 * ended -- Node never force-closes sockets on its own. A keep-alive client
 * (e.g. the renderer logger's debounced `POST /v1/logs`) can hold a
 * connection open indefinitely, which would otherwise make shutdown hang.
 *
 * `ServerType` is `net.Server | Http2Server | Http2SecureServer`, and only
 * `net.Server`'s `http.Server` subtype declares `closeIdleConnections()` /
 * `closeAllConnections()` (added in Node 18.2). `Http2Server` and
 * `Http2SecureServer` extend `net.Server`/`tls.Server` directly and do not
 * declare them, so they're not callable on `ServerType` as a whole. Narrow
 * with `in` (a real runtime check, not a cast) rather than forcing the type.
 */
async function closeServer(server: ServerType): Promise<void> {
  if ("closeIdleConnections" in server) {
    server.closeIdleConnections();
  }

  const closed = new Promise<void>((resolve, reject) => {
    server.close((cause) => {
      if (cause === undefined) {
        resolve();
        return;
      }

      reject(cause);
    });
  });

  // Give any in-flight request a brief window to finish normally, then force
  // whatever connections remain closed so shutdown is always bounded. 500ms
  // is well under Node's 5s default keepAliveTimeout (the actual cause of
  // the hang) and far more than a same-machine loopback request needs.
  const graceMs = 500;
  const forceClose = setTimeout(() => {
    if ("closeAllConnections" in server) {
      server.closeAllConnections();
    }
  }, graceMs);

  try {
    await closed;
  } finally {
    clearTimeout(forceClose);
  }
}
