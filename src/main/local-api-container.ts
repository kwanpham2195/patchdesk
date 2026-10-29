import { LocalRepositoryStore } from "#src/adapters/storage/local-repository-store";
import { LocalRepositoryService } from "#src/services/local-repository-service";
import { LocalRepositoryUpgrade } from "#src/services/local-repository-upgrade";
import { randomUUID } from "node:crypto";

import { buildLocalApiStores, type LocalApiStores } from "./local-api-stores";
import { createAvatarFetcher } from "./avatar-fetcher";
import {
  isGitHubDirectSummaryGateway,
  isGitHubMergeWriter,
  isGitHubPendingReviewGateway,
} from "./github-capability-guards";
import type {
  InsightCoordinatorSeam,
  LocalApiConfiguration,
  ReviewWorkbenchSeam,
} from "./local-api-configuration";
import { ReviewArtifactStorage } from "#src/adapters/storage/review-artifact-storage";
import { MergeOperationStore } from "#src/adapters/storage/merge-operation-store";
import { ReviewWriteOperationStore } from "#src/adapters/storage/review-write-operation-store";
import { LocalApplyOperationStore } from "#src/adapters/storage/local-apply-operation-store";
import type { InsightStore } from "#src/adapters/storage/insight-store";
import { RefreshOperationStore } from "#src/adapters/storage/refresh-operation-store";
import { ViewedFilesStore } from "#src/adapters/storage/viewed-files-store";
import { systemNow } from "#src/adapters/process/system-clock";
import type {
  GitHubDirectSummaryGateway,
  GitHubPendingReviewGateway,
  GitHubReader,
} from "#src/adapters/github/github-adapter";
import type { WorkspaceProfileConfig } from "#src/domain/workspace-profile";
import { definedProps } from "#src/domain/defined-props";
import { err, ok } from "#src/domain/result";
import { DashboardController } from "#src/services/dashboard-controller";
import { PublishedFeedbackService } from "#src/services/published-feedback-service";
import { InlineConversationService } from "#src/services/inline-conversation-service";
import { LabelService } from "#src/services/label-service";
import { AssigneeService } from "#src/services/assignee-service";
import { ReviewerService } from "#src/services/reviewer-service";
import { BaseBranchService } from "#src/services/base-branch-service";
import { DraftStateService } from "#src/services/draft-state-service";
import { PendingReviewService } from "#src/services/pending-review-service";
import { PullRequestImageService } from "#src/services/pull-request-image-service";
import { DirectSummaryReviewService } from "#src/services/direct-summary-review-service";
import { ReviewOperationCoordinator } from "#src/services/review-operation-coordinator";
import { AvatarSyncService } from "#src/services/avatar-sync-service";
import { ReviewWorkbenchController } from "#src/services/review-workbench-controller";
import { ReviewViewedFilesService } from "#src/services/review-viewed-files-service";
import { ReviewRefreshService } from "#src/services/review-refresh-service";
import { RefreshOperationService } from "#src/services/refresh-operation-service";
import { ReviewObservationService } from "#src/services/review-observation-service";
import { ReviewWriteRecoveryService } from "#src/services/review-write-recovery-service";
import { ReviewSessionPreparation } from "#src/services/review-session-preparation";
import { ReviewWorkbenchProjectionService } from "#src/services/review-workbench-projection";
import { ReviewCommitService } from "#src/services/review-commit-service";
import { ReviewPreparationJournal } from "#src/services/review-preparation-journal";
import { MergeWriteController } from "#src/services/merge-write-controller";
import { ReviewRecoveryService } from "#src/services/review-recovery-service";
import { ReviewWorktreeService } from "#src/services/review-worktree-service";
import { LocalCheckoutChangeDetector } from "#src/services/local-checkout-change-detector";
import { LocalReviewOpening } from "#src/services/local-review-opening";
import { LocalApplyService } from "#src/services/local-apply-service";
import { LocalApplySettlement } from "#src/services/local-apply-settlement";
import { LocalChangeIntentService } from "#src/services/local-change-intent-service";
import { LocalDraftService } from "#src/services/local-draft-service";
import { LocalPatchViewService } from "#src/services/local-patch-view-service";
import {
  createAgentExplanationId,
  createAgentRunRequestId,
  createLocalNoteId,
} from "#src/domain/ids";
import { AgentExplanationService } from "#src/services/agent-explanation-service";
import { AgentRunRequestService } from "#src/services/agent-run-request-service";
import { ReviewRetention } from "#src/services/review-retention";
import { LocalReviewSessionPreparation } from "#src/services/local-review-session-preparation";
import { ReviewDiffSourceService } from "#src/services/review-diff-source-service";
import { GuideProgressStore } from "#src/adapters/storage/guide-progress-store";
import { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import { GuideCapturedFilePages } from "#src/services/guide-captured-file-pages";
import { GuidePageService } from "#src/services/guide-result-pages";
import { GuideProgressService } from "#src/services/guide-result-progress";
import { GuideResultReader } from "#src/services/guide-result-reader";
import { WalkthroughProgressStore } from "#src/adapters/storage/walkthrough-progress-store";
import { WalkthroughResultReader } from "#src/services/walkthrough-result-reader";
import { WalkthroughProgressService } from "#src/services/walkthrough-result-progress";
import { WalkthroughPageService } from "#src/services/walkthrough-result-pages";
import { InsightSlotStatus } from "#src/services/insight-slot-status";
import { SidebarListingService } from "#src/services/sidebar-listing-service";
import { WatchedPullRequestService } from "#src/services/watched-pull-request-service";
import type { AppLogService } from "#src/services/app-log-service";
import { GitHubEnvironmentProbe } from "#src/services/github-environment-probe";
import { WorkspaceSetupService } from "#src/services/workspace-setup-service";

/** The narrow log seam every request-scoped writer needs. */
export type LogWriter = Pick<AppLogService, "write">;

/** Everything the loopback API's route modules are given. */
export type LocalApiContainer = {
  readonly configuration: LocalApiConfiguration;
  readonly parsedConfiguration: LocalApiStores["parsedConfiguration"];
  readonly logs: LocalApiStores["logs"];
  readonly commands: LocalApiStores["commands"];
  readonly diagnostics: LocalApiStores["diagnostics"];
  readonly github: GitHubReader;
  /** The Insight run lifecycle, built over `github`; absent leaves the Insight routes unavailable. */
  readonly insights: InsightCoordinatorSeam | undefined;
  readonly sessions: LocalApiStores["sessions"];
  /** Review records by profile; the MCP tools read another profile's to refuse `profile_changed`. */
  readonly reviews: LocalApiStores["reviews"];
  readonly storageManagement: LocalApiStores["storageManagement"];
  recordProfileReloadFailure(phase: string): Promise<void>;
  readonly configuredProfiles: ReadonlyArray<WorkspaceProfileConfig>;
  readonly dashboard: DashboardController;
  /** One per local API start, which is one per launch: the window its ready answer is held for. Settings and `patchdesk setup status` share it. */
  readonly githubEnvironment: GitHubEnvironmentProbe;
  readonly workspaceSetup: WorkspaceSetupService;
  readonly localRepositories: LocalRepositoryService;
  readonly recovery: ReviewRecoveryService;
  readonly reviewWorkbench: ReviewWorkbenchSeam;
  readonly localReviewOpening: LocalReviewOpening;
  /** Removes the sessions an Open Review moved past (#474, #478); the retention scheduler sweeps every profile through it. */
  readonly reviewRetention: ReviewRetention;
  readonly localApply: LocalApplyService;
  readonly localDrafts: LocalDraftService;
  /** The coding agent's explanations on diff lines of a local Review (#665). */
  readonly agentExplanations: AgentExplanationService;
  /** A shared local Review's Committed and Uncommitted patches, read from the session's stored files (#556). */
  readonly localPatchViews: LocalPatchViewService;
  readonly localChangeIntent: LocalChangeIntentService;
  /** Agent run requests over MCP and their approval in the app (ADR 0052). */
  readonly agentRunRequests: AgentRunRequestService;
  /** Bounded summary and page reads of the published Guide (GuideResultRoot1 only). */
  readonly guidePages: GuidePageService;
  /** Digest-keyed Guide reading progress. */
  readonly guideProgress: GuideProgressService;
  /** Bounded reads of published WalkthroughResultRoot1 only. */
  readonly walkthroughPages: WalkthroughPageService;
  /** Digest/version-fenced single-section progress mutations. */
  readonly walkthroughProgress: WalkthroughProgressService;
  /** Retained Insight reads for routes that compose from a stored result, such as the Brief's PR description. */
  readonly retainedInsights: Pick<InsightStore, "loadTyped">;
  readonly reviewDiffSources: ReviewDiffSourceService;
  readonly mergeWrites: MergeWriteController | undefined;
  readonly inlineConversations: InlineConversationService;
  readonly reviewWriteRecovery: ReviewWriteRecoveryService;
  readonly labelWrites: LabelService;
  readonly assigneeWrites: AssigneeService;
  readonly reviewerWrites: ReviewerService;
  readonly draftStateWrites: DraftStateService;
  readonly baseBranchWrites: BaseBranchService;
  readonly pendingReviews: PendingReviewService;
  readonly directSummaryReviews: DirectSummaryReviewService | undefined;
  readonly publishedFeedback: PublishedFeedbackService;
  readonly pullRequestImages: PullRequestImageService;
  readonly sidebarListing: SidebarListingService;
  readonly watchedPullRequests: WatchedPullRequestService;
  readonly reviewOperations: ReviewOperationCoordinator;
  readonly refreshOperations: RefreshOperationService;
  readonly viewedFiles: ReviewViewedFilesService;
};

/** Either the built container, or the startup refusal that stopped it. */
export type LocalApiContainerResult =
  | { readonly _tag: "ok"; readonly container: LocalApiContainer }
  | { readonly _tag: "invalid-configuration" }
  | { readonly _tag: "recovery-failed" };

/** Builds every service the loopback API's routes are registered against. */
export async function buildLocalApiContainer(
  configuration: LocalApiConfiguration,
): Promise<LocalApiContainerResult> {
  const built = await buildLocalApiStores(configuration);
  if (built._tag !== "ok") return built;
  const {
    parsedConfiguration,
    paths,
    logs,
    commands,
    credentials,
    github,
    readOnlyGit,
    localRevisions,
    resolveGitHubCli,
    diagnostics,
    profiles,
    recordProfileReloadFailure,
    sessions,
    reviews,
    remoteReviews,
    observationJournals,
    recentWriteJournals,
    reviewWriteGate,
    storageArtifacts,
    lifecycleGate,
    insights,
    watchedPullRequests,
    storageManagement,
  } = built.stores;
  const upgraded = await new LocalRepositoryUpgrade(
    paths,
    commands,
    logs,
  ).run();
  if (upgraded._tag === "err") return { _tag: "recovery-failed" };
  // Built here rather than by the caller so the Insight context pack reads
  // GitHub through this container's adapter and credential cache (issue #311).
  // Kept ahead of the recovery below, where the coordinator's own run recovery
  // used to sit when the desktop entry point built it.
  const insightCoordinator =
    configuration.insights === undefined
      ? undefined
      : await configuration.insights(github);
  // One owner of the managed refs and worktrees for recovery, preparation and retention.
  const worktrees = new ReviewWorktreeService(
    paths,
    readOnlyGit,
    credentials,
    resolveGitHubCli,
  );
  await ReviewPreparationJournal.recover(
    paths,
    worktrees,
    sessions,
    lifecycleGate,
    diagnostics,
  );
  const configuredProfiles = await profiles.list();
  if (configuredProfiles._tag === "err") return { _tag: "recovery-failed" };
  const reviewOperations =
    configuration.reviewOperations ?? new ReviewOperationCoordinator();
  const reviewWriteOperations = new ReviewWriteOperationStore(paths);
  const refreshOperationStore = new RefreshOperationStore(paths);
  const localApplyOperations = new LocalApplyOperationStore(paths);
  const reviewRetention = new ReviewRetention({
    paths,
    profiles,
    reviews,
    sessions,
    insights,
    mergeOperations: new MergeOperationStore(paths),
    localApplyOperations,
    writeOperations: reviewWriteOperations,
    refreshOperations: refreshOperationStore,
    worktrees,
    artifacts: storageArtifacts,
    git: readOnlyGit,
    lifecycleGate,
    coordinator: reviewOperations,
    now: systemNow,
    diagnostics,
  });

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
  // Shared with `reviewRefresh` below: one `AvatarSyncService` per profile
  // process, not one per consumer, so every caller warms and reads the same
  // on-disk cache.
  const avatarSync = new AvatarSyncService({
    paths,
    fetchAvatar: configuration.fetchAvatar ?? createAvatarFetcher(),
    log: logs,
  });
  const avatarRailDependencies = { paths, sync: avatarSync };
  const githubEnvironment = new GitHubEnvironmentProbe(commands);
  const dashboard = new DashboardController(
    profiles,
    github,
    readOnlyGit,
    paths,
    configuration.insightResources.uiReader,
    avatarRailDependencies,
  );
  const localRepositories = new LocalRepositoryService({
    profiles,
    catalog: new LocalRepositoryStore(paths),
    dashboard,
    git: readOnlyGit,
    paths,
    logs,
  });
  const reviewPreparation = new ReviewSessionPreparation({
    profiles,
    sessions,
    github,
    paths,
    now: systemNow,
    worktrees,
    artifacts: new ReviewArtifactStorage(paths, systemNow),
    lifecycleGate,
    diagnostics,
    notifier: configuration.desktopNotifier,
  });
  const viewedFiles = new ViewedFilesStore(paths, logs);
  const walkthroughReader = new WalkthroughResultReader(
    paths,
    configuration.insightResources.uiReader,
    logs,
  );
  const walkthroughProgress = new WalkthroughProgressService(
    new WalkthroughProgressStore(
      paths,
      new InsightArtifactStore(paths, configuration.insightResources.uiReader),
      configuration.insightResources.uiReader,
    ),
    walkthroughReader,
    reviewOperations,
    reviews,
    logs,
  );
  const walkthroughPages = new WalkthroughPageService(
    walkthroughReader,
    walkthroughProgress,
  );
  const reviewProjection = new ReviewWorkbenchProjectionService(
    profiles,
    sessions,
    reviews,
    insights,
    paths,
    reviewWriteOperations,
    viewedFiles,
    localApplyOperations,
    configuration.insightResources.jobs,
    walkthroughPages,
  );
  const inlineConversations = new InlineConversationService(
    reviewWriteGate,
    github,
    reviewOperations,
    systemNow,
    recentWriteJournals,
    reviewWriteOperations,
    configuration.desktopNotifier,
  );
  const reviewWriteRecovery = new ReviewWriteRecoveryService(
    reviewWriteGate,
    github,
    reviewWriteOperations,
    recentWriteJournals,
    reviewOperations,
    systemNow,
  );
  const labelWrites = new LabelService(
    reviewWriteGate,
    github,
    reviewOperations,
    systemNow,
    recentWriteJournals,
    reviewWriteOperations,
    configuration.desktopNotifier,
  );
  const pullRequestImages = new PullRequestImageService({
    paths,
    profiles,
    credentials,
    fetch: (url, init) => fetch(url, init),
    log: logs,
  });
  const assigneeWrites = new AssigneeService(
    reviewWriteGate,
    github,
    reviewOperations,
    systemNow,
    recentWriteJournals,
    reviewWriteOperations,
    avatarRailDependencies,
    configuration.desktopNotifier,
  );
  const reviewerWrites = new ReviewerService(
    reviewWriteGate,
    github,
    reviewOperations,
    systemNow,
    recentWriteJournals,
    reviewWriteOperations,
    avatarRailDependencies,
    configuration.desktopNotifier,
  );
  const draftStateWrites = new DraftStateService(
    reviewWriteGate,
    github,
    reviewOperations,
    systemNow,
    recentWriteJournals,
    reviewWriteOperations,
    configuration.desktopNotifier,
  );
  const baseBranchWrites = new BaseBranchService(
    reviewWriteGate,
    github,
    reviewOperations,
    systemNow,
    recentWriteJournals,
    reviewWriteOperations,
    configuration.desktopNotifier,
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
          configuration.desktopNotifier,
          logs,
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
          configuration.desktopNotifier,
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
    retention: reviewRetention,
    viewedFiles,
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
  const refreshOperations = new RefreshOperationService({
    operations: refreshOperationStore,
    reviews,
    refresh: reviewRefresh,
    coordinator: reviewOperations,
    now: systemNow,
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
      const refreshed = await refreshOperations.reconcileProfile(profile.id);
      if (refreshed._tag === "err") return { _tag: "recovery-failed" };
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
    systemNow,
    recentWriteJournals,
    reviewWriteOperations,
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
    profiles,
    paths,
  );
  const guideReader = new GuideResultReader(
    paths,
    configuration.insightResources.uiReader,
  );
  const guideProgress = new GuideProgressService(
    new GuideProgressStore(
      paths,
      new InsightArtifactStore(paths, configuration.insightResources.uiReader),
      configuration.insightResources.uiReader,
    ),
    guideReader,
    reviewOperations,
  );
  const guidePages = new GuidePageService(
    guideReader,
    guideProgress,
    new GuideCapturedFilePages(),
  );
  const slotStatus = new InsightSlotStatus(
    paths,
    configuration.insightResources.uiReader,
  );
  const sidebarListing = new SidebarListingService({
    repositories: localRepositories,
    reviews,
    insights,
    slots: slotStatus,
    diagnostics,
  });
  const reviewDiffSources = new ReviewDiffSourceService(
    profiles,
    sessions,
    configuration.readOnlyGit ?? readOnlyGit,
    worktrees,
  );
  const agentRunRequests = new AgentRunRequestService({
    reviews,
    insights,
    slots: slotStatus,
    profiles,
    coordinator: reviewOperations,
    now: systemNow,
    createRequestId: () => createAgentRunRequestId(randomUUID()),
    logs,
    ...definedProps({ notifier: configuration.desktopNotifier }),
  });
  const localReviewOpening = new LocalReviewOpening(
    new LocalReviewSessionPreparation({
      profiles,
      repositories: localRepositories,
      sessions,
      revisions: localRevisions,
      worktrees,
      artifacts: storageArtifacts,
      paths,
      git: readOnlyGit,
      lifecycleGate,
      now: systemNow,
      diagnostics,
    }),
    reviewProjection,
    {
      reviews,
      sessions,
      viewedFiles,
      artifacts: storageArtifacts,
      coordinator: reviewOperations,
      retention: reviewRetention,
      applySettlement: new LocalApplySettlement({
        operations: localApplyOperations,
        reviews,
        git: readOnlyGit,
        logs,
        now: systemNow,
      }),
      logs,
      agentRunRequests,
    },
    systemNow,
  );
  const reviewWorkbench =
    configuration.reviewWorkbench ??
    new ReviewWorkbenchController(reviewPreparation, reviewProjection, {
      reviews,
      sessions,
      artifacts: storageArtifacts,
      remote: remoteReviews,
      journals: observationJournals,
      coordinator: reviewOperations,
      refresh: reviewRefresh,
      observation: reviewObservation,
      commits: reviewCommits,
      localCheckout: localReviewOpening,
      localChanges: new LocalCheckoutChangeDetector({
        git: readOnlyGit,
        paths,
        profiles,
        sessions,
        logs,
      }),
      logs,
    });
  const localApply = new LocalApplyService({
    gate: reviewWriteGate,
    operations: localApplyOperations,
    insights,
    reviews,
    profiles,
    opening: localReviewOpening,
    coordinator: reviewOperations,
    git: readOnlyGit,
    paths,
    logs,
    now: systemNow,
  });
  // An Apply the previous run left unsettled is decided from file hashes before any request arrives.
  await localApply.recoverAll();
  const merger =
    configuration.mergeWriter ??
    (isGitHubMergeWriter(github) ? github : undefined);
  const mergeWrites =
    merger === undefined
      ? undefined
      : new MergeWriteController(
          {
            getMergeOutcome: github.getMergeOutcome.bind(github),
            getMergePolicy: github.getMergePolicy.bind(github),
            getPullRequest: github.getPullRequest.bind(github),
            getPullRequestDiff: github.getPullRequestDiff.bind(github),
            mergePullRequest: merger.mergePullRequest.bind(merger),
          },
          systemNow,
          new MergeOperationStore(paths),
          reviewWriteGate,
          { reviews, insights },
          reviewOperations,
          configuration.desktopNotifier,
          logs,
        );

  return {
    _tag: "ok",
    container: {
      configuration,
      parsedConfiguration,
      logs,
      commands,
      diagnostics,
      github,
      insights: insightCoordinator,
      sessions,
      reviews,
      storageManagement,
      recordProfileReloadFailure,
      configuredProfiles: configuredProfiles.value,
      dashboard,
      githubEnvironment,
      localRepositories,
      workspaceSetup: new WorkspaceSetupService({
        repositories: localRepositories,
        dashboard,
        git: readOnlyGit,
        commands,
        environment: githubEnvironment,
      }),
      recovery,
      reviewWorkbench,
      localReviewOpening,
      reviewRetention,
      localApply,
      localDrafts: new LocalDraftService({
        reviews,
        sessions,
        insights,
        coordinator: reviewOperations,
        now: systemNow,
        createNoteId: () => createLocalNoteId(randomUUID()),
      }),
      agentExplanations: new AgentExplanationService({
        reviews,
        sessions,
        coordinator: reviewOperations,
        now: systemNow,
        createExplanationId: () => createAgentExplanationId(randomUUID()),
      }),
      localPatchViews: new LocalPatchViewService({
        reviews,
        sessions,
        viewedFiles,
      }),
      localChangeIntent: new LocalChangeIntentService({
        reviews,
        coordinator: reviewOperations,
        now: systemNow,
      }),
      agentRunRequests,
      guidePages,
      guideProgress,
      walkthroughPages,
      walkthroughProgress,
      retainedInsights: insights,
      reviewDiffSources,
      mergeWrites,
      inlineConversations,
      reviewWriteRecovery,
      labelWrites,
      assigneeWrites,
      reviewerWrites,
      draftStateWrites,
      baseBranchWrites,
      pendingReviews,
      directSummaryReviews,
      publishedFeedback,
      pullRequestImages,
      sidebarListing,
      watchedPullRequests: new WatchedPullRequestService({
        profiles,
        store: watchedPullRequests,
        github,
        now: systemNow,
        notifier: configuration.desktopNotifier,
        onChange: configuration.watchedPullRequestChanged,
      }),
      reviewOperations,
      refreshOperations,
      viewedFiles: new ReviewViewedFilesService(
        reviews,
        viewedFiles,
        reviewOperations,
      ),
    },
  };
}
