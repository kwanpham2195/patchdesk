import { buildLocalApiStores, type LocalApiStores } from "./local-api-stores";
import { createAvatarFetcher } from "./avatar-fetcher";
import {
  isGitHubDirectSummaryGateway,
  isGitHubMergeWriter,
  isGitHubPendingReviewGateway,
} from "./github-capability-guards";
import type { LocalApiConfiguration } from "./local-api-configuration";
import { ReviewArtifactStorage } from "../adapters/storage/review-artifact-storage";
import { MergeOperationStore } from "../adapters/storage/merge-operation-store";
import { ReviewWriteOperationStore } from "../adapters/storage/review-write-operation-store";
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
import { PendingReviewService } from "../services/pending-review-service";
import { DirectSummaryReviewService } from "../services/direct-summary-review-service";
import { ReviewOperationCoordinator } from "../services/review-operation-coordinator";
import { AvatarSyncService } from "../services/avatar-sync-service";
import { ReviewWorkbenchController } from "../services/review-workbench-controller";
import { ReviewRefreshService } from "../services/review-refresh-service";
import { ReviewObservationService } from "../services/review-observation-service";
import { ReviewWriteRecoveryService } from "../services/review-write-recovery-service";
import { ReviewSessionPreparation } from "../services/review-session-preparation";
import { ReviewWorkbenchProjectionService } from "../services/review-workbench-projection";
import { ReviewCommitService } from "../services/review-commit-service";
import { ReviewPreparationJournal } from "../services/review-preparation-journal";
import { MergeWriteController } from "../services/merge-write-controller";
import { ReviewRecoveryService } from "../services/review-recovery-service";
import { ReviewContextService } from "../services/review-context-service";
import { ReviewWorktreeService } from "../services/review-worktree-service";
import { ReviewDiffSourceService } from "../services/review-diff-source-service";
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
  readonly sessions: LocalApiStores["sessions"];
  readonly storageManagement: LocalApiStores["storageManagement"];
  recordProfileReloadFailure(phase: string): Promise<void>;
  readonly configuredProfiles: ReadonlyArray<WorkspaceProfileConfig>;
  readonly dashboard: DashboardController;
  readonly recovery: ReviewRecoveryService;
  readonly reviewWorkbench: ReviewWorkbenchController;
  readonly reviewDiffSources: ReviewDiffSourceService;
  readonly mergeWrites: MergeWriteController | undefined;
  readonly inlineConversations: InlineConversationService;
  readonly reviewWriteRecovery: ReviewWriteRecoveryService;
  readonly labelWrites: LabelService;
  readonly assigneeWrites: AssigneeService;
  readonly reviewerWrites: ReviewerService;
  readonly pendingReviews: PendingReviewService;
  readonly directSummaryReviews: DirectSummaryReviewService | undefined;
  readonly publishedFeedback: PublishedFeedbackService;
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
    storageManagement,
  } = built.stores;
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
  const reviewWriteOperations = new ReviewWriteOperationStore(paths);

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
    reviewWriteOperations,
  );
  const inlineConversations = new InlineConversationService(
    reviewWriteGate,
    github,
    reviewOperations,
    systemNow,
    recentWriteJournals,
    reviewWriteOperations,
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
    reviewWriteOperations,
    avatarRailDependencies,
  );
  const reviewerWrites = new ReviewerService(
    reviewWriteGate,
    github,
    reviewOperations,
    systemNow,
    recentWriteJournals,
    reviewWriteOperations,
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

  return {
    _tag: "ok",
    container: {
      configuration,
      parsedConfiguration,
      logs,
      commands,
      diagnostics,
      github,
      sessions,
      storageManagement,
      recordProfileReloadFailure,
      configuredProfiles: configuredProfiles.value,
      dashboard,
      recovery,
      reviewWorkbench,
      reviewDiffSources,
      mergeWrites,
      inlineConversations,
      reviewWriteRecovery,
      labelWrites,
      assigneeWrites,
      reviewerWrites,
      pendingReviews,
      directSummaryReviews,
      publishedFeedback,
    },
  };
}
