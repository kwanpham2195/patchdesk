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
import { ReviewArtifactStorage } from "../adapters/storage/review-artifact-storage";
import { MergeOperationStore } from "../adapters/storage/merge-operation-store";
import { ReviewWriteOperationStore } from "../adapters/storage/review-write-operation-store";
import { LocalApplyOperationStore } from "../adapters/storage/local-apply-operation-store";
import type { InsightStore } from "../adapters/storage/insight-store";
import { RefreshOperationStore } from "../adapters/storage/refresh-operation-store";
import { ViewedFilesStore } from "../adapters/storage/viewed-files-store";
import { WorkspaceOriginFinder } from "../adapters/github/workspace-origin-finder";
import { systemNow } from "../adapters/process/system-clock";
import type {
  GitHubDirectSummaryGateway,
  GitHubPendingReviewGateway,
  GitHubReader,
} from "../adapters/github/github-adapter";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import { err, ok } from "../domain/result";
import { DashboardController } from "../services/dashboard-controller";
import { PublishedFeedbackService } from "../services/published-feedback-service";
import { InlineConversationService } from "../services/inline-conversation-service";
import { LabelService } from "../services/label-service";
import { AssigneeService } from "../services/assignee-service";
import { ReviewerService } from "../services/reviewer-service";
import { BaseBranchService } from "../services/base-branch-service";
import { DraftStateService } from "../services/draft-state-service";
import { PendingReviewService } from "../services/pending-review-service";
import { PullRequestImageService } from "../services/pull-request-image-service";
import { DirectSummaryReviewService } from "../services/direct-summary-review-service";
import { ReviewOperationCoordinator } from "../services/review-operation-coordinator";
import { AvatarSyncService } from "../services/avatar-sync-service";
import { ReviewWorkbenchController } from "../services/review-workbench-controller";
import { ReviewViewedFilesService } from "../services/review-viewed-files-service";
import { ReviewRefreshService } from "../services/review-refresh-service";
import { RefreshOperationService } from "../services/refresh-operation-service";
import { ReviewObservationService } from "../services/review-observation-service";
import { ReviewWriteRecoveryService } from "../services/review-write-recovery-service";
import { ReviewSessionPreparation } from "../services/review-session-preparation";
import { ReviewWorkbenchProjectionService } from "../services/review-workbench-projection";
import { ReviewCommitService } from "../services/review-commit-service";
import { ReviewPreparationJournal } from "../services/review-preparation-journal";
import { MergeWriteController } from "../services/merge-write-controller";
import { ReviewRecoveryService } from "../services/review-recovery-service";
import { ReviewWorktreeService } from "../services/review-worktree-service";
import { LocalReviewOpening } from "../services/local-review-opening";
import { LocalApplyService } from "../services/local-apply-service";
import { LocalApplySettlement } from "../services/local-apply-settlement";
import { LocalChangeIntentService } from "../services/local-change-intent-service";
import { LocalDraftService } from "../services/local-draft-service";
import { createLocalNoteId } from "../domain/ids";
import { ReviewRetention } from "../services/review-retention";
import { LocalReviewSessionPreparation } from "../services/local-review-session-preparation";
import { ReviewDiffSourceService } from "../services/review-diff-source-service";
import { SidebarListingService } from "../services/sidebar-listing-service";
import { WatchedPullRequestService } from "../services/watched-pull-request-service";
import type { AppLogService } from "../services/app-log-service";

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
  readonly storageManagement: LocalApiStores["storageManagement"];
  recordProfileReloadFailure(phase: string): Promise<void>;
  readonly configuredProfiles: ReadonlyArray<WorkspaceProfileConfig>;
  readonly dashboard: DashboardController;
  readonly recovery: ReviewRecoveryService;
  readonly reviewWorkbench: ReviewWorkbenchSeam;
  readonly localReviewOpening: LocalReviewOpening;
  /** Removes the sessions an Open Review moved past (#474, #478); the retention scheduler sweeps every profile through it. */
  readonly reviewRetention: ReviewRetention;
  readonly localApply: LocalApplyService;
  readonly localDrafts: LocalDraftService;
  readonly localChangeIntent: LocalChangeIntentService;
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
  const dashboard = new DashboardController(
    profiles,
    github,
    configuration.origins ?? new WorkspaceOriginFinder(commands),
    paths,
    commands,
    avatarRailDependencies,
  );
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
  const reviewProjection = new ReviewWorkbenchProjectionService(
    profiles,
    sessions,
    reviews,
    insights,
    paths,
    reviewWriteOperations,
    viewedFiles,
    localApplyOperations,
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
    operations: new RefreshOperationStore(paths),
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
  );
  const sidebarListing = new SidebarListingService({ reviews, diagnostics });
  const reviewDiffSources = new ReviewDiffSourceService(
    profiles,
    sessions,
    configuration.readOnlyGit ?? readOnlyGit,
  );
  const localReviewOpening = new LocalReviewOpening(
    new LocalReviewSessionPreparation({
      profiles,
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
      storageManagement,
      recordProfileReloadFailure,
      configuredProfiles: configuredProfiles.value,
      dashboard,
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
      localChangeIntent: new LocalChangeIntentService({
        reviews,
        coordinator: reviewOperations,
        now: systemNow,
      }),
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
