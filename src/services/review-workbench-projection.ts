import { createHash } from "node:crypto";
import type { GitHubReader } from "../adapters/github/github-adapter";
import { readFile } from "node:fs/promises";

import type { InsightStore } from "../adapters/storage/insight-store";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { ReviewFreshness } from "../domain/review";
import type { ReviewRemoteSnapshot } from "../adapters/storage/review-remote-store";
import type {
  CheckSummary,
  Conversation,
  GitHubMergeEvidence,
  MergeDisplayReason,
  PullRequestCommit,
  PullRequestSummary,
} from "../domain/github-context";
import {
  createReviewId,
  parseContentHash,
  parseGitSha,
  parseInsightRunId,
  parseIsoTimestamp,
  parseReviewSessionId,
  type GitHubHost,
  type GitHubOwner,
  type GitSha,
  type IsoTimestamp,
  type PullRequestNumber,
  type ReviewId,
  type ContentHash,
  type GitHubRepoName,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../domain/ids";
import type {
  InsightArtifactStatus,
  InsightProjection,
  InsightScopeProjection,
} from "../domain/insight";
import { parseUnifiedPatch } from "../domain/patch";
import {
  normalizeNarrativeWalkthrough,
  type NarrativeWalkthrough,
} from "../domain/narrative-walkthrough";
import type { MergeReadiness } from "../domain/merge-readiness";
import type {
  InsightFindingDismissal,
  InsightRecord,
  RetainedInsight,
} from "../domain/insight-record";
import {
  parseInsightProvider,
  parseInsightReasoning,
  type InsightProvenance,
} from "../domain/insight-provider";
import type { PendingReviewProjection } from "./pending-review-service";
import {
  projectDirectSummaryReview,
  type DirectSummaryReviewProjection,
} from "./direct-summary-review-service";
import { projectPendingReview } from "./pending-review-service";
import type { PendingReviewState } from "../domain/pending-review";
import { parseReviewResult, type ReviewResult } from "../domain/review-result";
import type { ReviewSession } from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import { readObjectField } from "./read-object-field";

/** Renderer-safe Session identity. It deliberately omits patch/worktree paths and durable internals. */
export type WorkbenchSessionProjection = {
  readonly id: ReviewSessionId;
  readonly key: {
    readonly profileId: WorkspaceProfileId;
    readonly host: GitHubHost;
    readonly owner: GitHubOwner;
    readonly repo: GitHubRepoName;
    readonly prNumber: PullRequestNumber;
    readonly headSha: GitSha;
  };
};
export type AnalysisFindingReviewStatus =
  | { readonly state: "actionable" }
  | { readonly state: "pending_review" }
  | { readonly state: "published" }
  | { readonly state: "locked" };

export type AnalysisReviewActionsProjection = {
  readonly findings: Readonly<Record<string, AnalysisFindingReviewStatus>>;
  readonly canFinishWithAnalysisSummary: boolean;
};

export type ReviewWorkbenchProjection = {
  readonly state: "review";
  readonly review: {
    readonly id: ReviewId;
    readonly status: "open" | "merged" | "closed";
  };
  readonly session: WorkbenchSessionProjection;
  readonly revision: {
    readonly reviewedHeadSha: GitSha;
    readonly patchHash?: ContentHash;
    readonly currentHeadSha?: GitSha;
    readonly freshness:
      "fresh" | "updates_available" | "unavailable" | "not_refreshed";
    readonly refreshedAt: IsoTimestamp;
  };
  readonly fullPatch?: string;
  readonly pullRequest?: PullRequestSummary;
  readonly commits: ReadonlyArray<PullRequestCommit>;
  readonly insights: {
    readonly analysis: InsightProjection<ReviewResult>;
    readonly walkthrough: InsightProjection<NarrativeWalkthrough>;
  };
  readonly analysisReviewActions: AnalysisReviewActionsProjection;
  readonly pendingReview?: PendingReviewProjection;
  readonly directSummary?: DirectSummaryReviewProjection;
  /** Advisory only; the direct-summary service rechecks the account and PR author before writing. */
  readonly directSummaryDecision: "allowed" | "blocked_author" | "unknown";
  readonly conversation: Conversation;
  readonly checks: CheckSummary;
  readonly mergeReadiness: MergeReadiness;
  readonly mergeReasons: ReadonlyArray<MergeDisplayReason>;
};

export type LoadWorkbenchInput = {
  readonly profileId: WorkspaceProfileId;
  readonly sessionId: ReviewSessionId;
};

export type WorkbenchProjectionFailure =
  | { readonly _tag: "ProfileNotFound" }
  | { readonly _tag: "SessionNotFound" }
  | { readonly _tag: "ReviewNotFound" }
  | { readonly _tag: "SessionStorageUnavailable" };

/**
 * Read-side owner of the renderer-safe model for the exact snapshot held by
 * the durable Review. It never performs live GitHub reads or session-only
 * projection.
 */
export class ReviewWorkbenchProjectionService {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly sessions: ReviewSessionStore,
    private readonly reviews: Pick<ReviewStore, "load">,
    private readonly insights: Pick<InsightStore, "loadTyped" | "load">,
  ) {}

  /** Projects the exact remote snapshot represented by the durable Review. */
  async loadRepresented(input: {
    readonly profileId: WorkspaceProfileId;
    readonly sessionId: ReviewSessionId;
    readonly snapshot: ReviewRemoteSnapshot;
    readonly refreshedAt: IsoTimestamp;
    readonly freshness: ReviewFreshness;
    readonly pendingReview?: {
      readonly state: PendingReviewState;
      readonly unavailable: boolean;
    };
  }): Promise<Result<ReviewWorkbenchProjection, WorkbenchProjectionFailure>> {
    const session = await this.loadSession({
      profileId: input.profileId,
      sessionId: input.sessionId,
    });
    if (session._tag === "err") return session;
    return this.project(
      session.value.profile,
      session.value.session,
      {
        current: { _tag: "ok", value: input.snapshot.pullRequest },
        conversation: ok(input.snapshot.conversation),
        commits: input.snapshot.commits,
        checks: { _tag: "ok", value: input.snapshot.checks },
        ...(input.snapshot.mergeEvidence === undefined
          ? {}
          : { mergeEvidence: input.snapshot.mergeEvidence }),
      },
      input.refreshedAt,
      input.freshness,
      input.pendingReview,
    );
  }

  private async loadSession(input: LoadWorkbenchInput): Promise<
    Result<
      {
        readonly profile: WorkspaceProfileConfig;
        readonly session: ReviewSession;
      },
      WorkbenchProjectionFailure
    >
  > {
    const [profile, session] = await Promise.all([
      this.profiles.load(input.profileId),
      this.sessions.load(input.profileId, input.sessionId),
    ]);
    if (profile._tag === "err") return err({ _tag: "ProfileNotFound" });
    if (session._tag === "err") return err({ _tag: "SessionNotFound" });
    return ok({ profile: profile.value, session: session.value });
  }

  private async project(
    profile: WorkspaceProfileConfig,
    session: ReviewSession,
    remote:
      | {
          readonly current: Awaited<ReturnType<GitHubReader["getPullRequest"]>>;
          readonly conversation: Awaited<
            ReturnType<GitHubReader["loadConversation"]>
          >;
          readonly commits?: ReadonlyArray<PullRequestCommit>;
          readonly checks: Awaited<
            ReturnType<GitHubReader["getPullRequestChecks"]>
          >;
          readonly mergeEvidence?: GitHubMergeEvidence;
        }
      | undefined,
    representedAt: IsoTimestamp,
    durableFreshness: ReviewFreshness,
    pendingReview?: {
      readonly state: PendingReviewState;
      readonly unavailable: boolean;
    },
  ): Promise<Result<ReviewWorkbenchProjection, WorkbenchProjectionFailure>> {
    const fullPatch = await readFile(session.patchPath, "utf8").catch(() => undefined);
    const storedInsights = await this.loadStoredInsights(session);
    if (storedInsights._tag === "err") return storedInsights;
    const patchHash =
      fullPatch === undefined
        ? undefined
        : createHash("sha256").update(fullPatch).digest("hex");

    const current = remote?.current;
    const currentHeadSha =
      current?._tag === "ok" ? current.value.headSha : undefined;
    const pullRequest =
      current?._tag === "ok"
        ? current.value
        : session.prContext === undefined
          ? undefined
          : {
              ref: {
                host: session.key.host,
                owner: session.key.owner,
                repo: session.key.repo,
                number: session.key.prNumber,
              },
              ...session.prContext,
              headSha: session.key.headSha,
              isDraft: session.pr.isDraft,
              isOpen: session.pr.isOpen,
              reviewState: "unknown" as const,
              mergeability: "unknown" as const,
              labels: [],
              updatedAt: session.updatedAt,
            };
    const checks: CheckSummary =
      remote?.checks?._tag === "ok"
        ? remote.checks.value
        : { overall: "unknown", checks: [] };
    const conversation: Conversation =
      remote?.conversation?._tag === "ok"
        ? remote.conversation.value
        : { prDescription: "", entries: [] };
    const freshness =
      durableFreshness._tag === "Fresh"
          ? ("fresh" as const)
          : durableFreshness._tag === "RevisionChanged"
            ? ("updates_available" as const)
            : ("unavailable" as const);
    const refreshedAt = representedAt;
    const mergeReadiness =
      current?._tag === "ok" && remote?.checks?._tag === "ok"
        ? evaluateReadiness(current.value, remote.checks.value, session)
        : {
            _tag: "Blocked" as const,
            blockers: ["stale_head" as const],
            warnings: [],
          };
    const mergeReasons = deriveMergeReasons(
      current?._tag === "ok" ? current.value : undefined,
      remote?.mergeEvidence,
      checks,
    );
    const analysis = projectStoredInsight(
      storedInsights.value.analysis,
      session,
      patchHash,
      (value, record) => projectAnalysisFindings(value, record),
      storedInsights.value.analysisScope,
      storedInsights.value.analysisArtifactStatus,
    );
    const walkthrough = projectStoredInsight(
      storedInsights.value.walkthrough,
      session,
      patchHash,
      undefined,
      undefined,
      storedInsights.value.walkthroughArtifactStatus,
    );
    const reviewId = createReviewId(session.key);
    const stableReview = await this.reviews.load(session.key.profileId, reviewId);
    if (stableReview._tag === "err")
      return stableReview.error.reason === "not_found"
        ? err({ _tag: "ReviewNotFound" })
        : err({ _tag: "SessionStorageUnavailable" });
    if (
      stableReview.value.id !== reviewId ||
      stableReview.value.identity.profileId !== session.key.profileId ||
      stableReview.value.identity.host !== session.key.host ||
      stableReview.value.identity.owner !== session.key.owner ||
      stableReview.value.identity.repo !== session.key.repo ||
      stableReview.value.identity.prNumber !== session.key.prNumber ||
      stableReview.value.currentSessionId !== session.id ||
      stableReview.value.currentHeadSha !== session.key.headSha
    ) return err({ _tag: "SessionStorageUnavailable" });
    const reviewStatus = stableReview.value.status._tag === "Terminal"
      ? stableReview.value.status.state
      : ("open" as const);

    const analysisReviewActions = projectAnalysisReviewActions({
      analysis,
      session,
      freshness,
      patchHash: patchHash as ContentHash | undefined,
      pendingReview: pendingReview?.state ?? session.pendingReview,
    });

    return ok({
      state: "review",
      review: { id: reviewId, status: reviewStatus },
      session: projectSession(session),
      revision: {
        reviewedHeadSha: session.key.headSha,
        ...(patchHash === undefined
          ? {}
          : { patchHash: patchHash as ContentHash }),
        ...(currentHeadSha === undefined ? {} : { currentHeadSha }),
        freshness,
        refreshedAt,
      },
      ...(fullPatch === undefined ? {} : { fullPatch }),
      ...(pullRequest === undefined ? {} : { pullRequest }),
      commits: remote?.commits ?? [],
      insights: {
        analysis,
        walkthrough,
      },
      analysisReviewActions,
      pendingReview: projectPendingReview(
        pendingReview?.state ?? session.pendingReview ?? { _tag: "None" },
        pendingReview?.unavailable ?? session.pendingReview === undefined,
      ),
      directSummary: projectDirectSummaryReview(session.directSummaryReview),
      directSummaryDecision: directSummaryDecision(profile, pullRequest),
      conversation,
      checks,
      mergeReadiness,
      mergeReasons,
    });
  }

  private async loadStoredInsights(
    session: ReviewSession,
  ): Promise<Result<StoredInsightRecords, WorkbenchProjectionFailure>> {
    const analysis = await this.insights.loadTyped(
      session.key.profileId,
      createReviewId(session.key),
      "analysis",
      parseRetainedAnalysis,
    );
    // A retained Walkthrough belongs to the Session that produced it. Never
    // validate it against the currently represented Session's patch: Refresh
    // intentionally changes that artifact while old reading evidence remains.
    const walkthrough = await this.loadWalkthroughRecord(session);
    if (analysis._tag === "err" && analysis.error.reason !== "not_found")
      return err({ _tag: "SessionStorageUnavailable" });
    if (walkthrough._tag === "err" && walkthrough.error.reason !== "not_found")
      return err({ _tag: "SessionStorageUnavailable" });
    const analysisArtifact =
      analysis._tag === "ok" && analysis.value.retained !== undefined
        ? await this.readInsightScope(
            session.key.profileId,
            analysis.value.retained,
          )
        : undefined;
    return ok({
      ...(analysis._tag === "ok" ? { analysis: analysis.value } : {}),
      ...(walkthrough._tag === "ok"
        ? { walkthrough: walkthrough.value.record }
        : {}),
      ...(analysisArtifact?.scope === undefined
        ? {}
        : { analysisScope: analysisArtifact.scope }),
      ...(analysisArtifact?.artifactStatus === undefined
        ? {}
        : { analysisArtifactStatus: analysisArtifact.artifactStatus }),
      ...(walkthrough._tag === "ok" &&
      walkthrough.value.artifactStatus !== undefined
        ? { walkthroughArtifactStatus: walkthrough.value.artifactStatus }
        : {}),
    });
  }

  private async readInsightScope(
    profileId: WorkspaceProfileId,
    retained: RetainedInsight<ReviewResult>,
  ): Promise<{
    readonly scope?: InsightScopeProjection;
    readonly artifactStatus: InsightArtifactStatus;
  }> {
    const retainedSession = await this.sessions.load(
      profileId,
      retained.revision.sessionId,
    );
    if (retainedSession._tag === "err") return { artifactStatus: "mismatch" };
    const patch = await readFile(retainedSession.value.patchPath, "utf8").catch(
      () => undefined,
    );
    if (patch === undefined) return { artifactStatus: "mismatch" };
    const actualHash = createHash("sha256").update(patch).digest("hex");
    if (actualHash !== retained.revision.patchHash)
      return { artifactStatus: "mismatch" };
    const files = parseUnifiedPatch(patch);
    return {
      artifactStatus: "verified",
      scope: {
        baseShort: (retainedSession.value.pr.baseSha ?? "unknown").slice(0, 7),
        headShort: retained.revision.headSha.slice(0, 7),
        commitCount: 0,
        fileCount: files.length,
        additions: files.reduce((total, file) => total + file.additions, 0),
        deletions: files.reduce((total, file) => total + file.deletions, 0),
        changedFiles: files.map((file) => ({
          path: file.newPath,
          additions: file.additions,
          deletions: file.deletions,
        })),
      },
    };
  }

  private async loadWalkthroughRecord(session: ReviewSession): Promise<
    Result<
      {
        readonly record: InsightRecord<RetainedInsight<NarrativeWalkthrough>>;
        readonly artifactStatus?: InsightArtifactStatus;
      },
      { readonly reason: "not_found" | "storage" }
    >
  > {
    const loaded = await this.insights.load(
      session.key.profileId,
      createReviewId(session.key),
      "walkthrough",
    );
    if (loaded._tag === "err") {
      return loaded.error.reason === "not_found"
        ? err({ reason: "not_found" })
        : err({ reason: "storage" });
    }
    if (loaded.value.retained === undefined) {
      return ok({
        record: loaded.value as InsightRecord<
          RetainedInsight<NarrativeWalkthrough>
        >,
      });
    }
    const base = parseRetainedBase(loaded.value.retained);
    if (base._tag === "err") return err({ reason: "storage" });
    const fallback = (): Result<
      {
        readonly record: InsightRecord<RetainedInsight<NarrativeWalkthrough>>;
        readonly artifactStatus: InsightArtifactStatus;
      },
      { readonly reason: "not_found" | "storage" }
    > => {
      const value = readableWalkthroughWithoutArtifact(
        readObjectField(loaded.value.retained, "value"),
        session.key.profileId,
        base.value,
      );
      return ok({
        record: { ...loaded.value, retained: { ...base.value, value } },
        artifactStatus: "mismatch",
      });
    };
    const retainedSession = await this.sessions.load(
      session.key.profileId,
      base.value.revision.sessionId,
    );
    if (retainedSession._tag === "err") return fallback();
    const retainedPatch = await readFile(
      retainedSession.value.patchPath,
      "utf8",
    ).catch(() => undefined);
    if (retainedPatch === undefined) return fallback();
    const actualHash = createHash("sha256").update(retainedPatch).digest("hex");
    if (actualHash !== base.value.revision.patchHash) return fallback();
    const parsed = parseRetainedWalkthrough(
      loaded.value.retained,
      retainedPatch,
      session.key.profileId,
    );
    if (parsed._tag === "err") return err({ reason: "storage" });
    return ok({
      record: { ...loaded.value, retained: parsed.value },
      artifactStatus: "verified",
    });
  }


}

function projectAnalysisReviewActions(input: {
  readonly analysis: InsightProjection<ReviewResult>;
  readonly session: ReviewSession;
  readonly freshness: ReviewWorkbenchProjection["revision"]["freshness"];
  readonly patchHash: ContentHash | undefined;
  readonly pendingReview: PendingReviewState | undefined;
}): AnalysisReviewActionsProjection {
  const retained = input.analysis.retained;
  const current =
    retained !== undefined &&
    retained.runId !== undefined &&
    input.analysis.status === "current" &&
    input.analysis.artifactStatus === "verified" &&
    input.freshness === "fresh" &&
    input.patchHash !== undefined &&
    retained.sessionId === input.session.id &&
    retained.headSha === input.session.key.headSha;
  if (
    !current ||
    retained === undefined ||
    retained.runId === undefined ||
    input.patchHash === undefined
  )
    return { findings: {}, canFinishWithAnalysisSummary: false };
  const locked =
    input.pendingReview?._tag === "WriteInFlight" ||
    input.pendingReview?._tag === "OutcomeUnknown";
  const receipts = input.session.findingReviewReceipts ?? [];
  const findings: Record<string, AnalysisFindingReviewStatus> = {};
  for (const finding of retained.value.findings) {
    if (finding.disposition === "dismissed") continue;
    const receipt = receipts.find(
      (candidate) =>
        candidate.analysisRunId === retained.runId &&
        candidate.findingId === finding.id &&
        candidate.sessionId === input.session.id &&
        candidate.headSha === input.session.key.headSha &&
        candidate.patchHash === input.patchHash,
    );
    const unresolved =
      input.pendingReview?._tag === "Pending" &&
      input.pendingReview.unresolvedFinding?.analysisRunId === retained.runId &&
      input.pendingReview.unresolvedFinding.findingId === finding.id &&
      input.pendingReview.unresolvedFinding.sessionId === input.session.id &&
      input.pendingReview.unresolvedFinding.headSha ===
        input.session.key.headSha &&
      input.pendingReview.unresolvedFinding.patchHash === input.patchHash;
    findings[finding.id] =
      receipt === undefined
        ? locked || unresolved
          ? { state: "locked" }
          : { state: "actionable" }
        : receipt.state === "pending"
          ? { state: "pending_review" }
          : { state: "published" };
  }
  const pendingReviewNodeId =
    input.pendingReview?._tag === "Pending"
      ? input.pendingReview.review.nodeId
      : undefined;
  return {
    findings,
    canFinishWithAnalysisSummary:
      pendingReviewNodeId !== undefined &&
      receipts.some(
        (receipt) =>
          receipt.state === "pending" &&
          receipt.pendingReviewNodeId === pendingReviewNodeId &&
          receipt.analysisRunId === retained.runId &&
          receipt.sessionId === input.session.id &&
          receipt.headSha === input.session.key.headSha &&
          receipt.patchHash === input.patchHash,
      ),
  };
}

function directSummaryDecision(
  profile: WorkspaceProfileConfig,
  pullRequest: PullRequestSummary | undefined,
): "allowed" | "blocked_author" | "unknown" {
  if (pullRequest?.author === undefined || profile.ghAccount.length === 0)
    return "unknown";
  return pullRequest.author.toLowerCase() === profile.ghAccount.toLowerCase()
    ? "blocked_author"
    : "allowed";
}

function projectSession(session: ReviewSession): WorkbenchSessionProjection {
  return {
    id: session.id,
    key: {
      profileId: session.key.profileId,
      host: session.key.host,
      owner: session.key.owner,
      repo: session.key.repo,
      prNumber: session.key.prNumber,
      headSha: session.key.headSha,
    },
  };
}


function deriveMergeReasons(
  current: PullRequestSummary | undefined,
  evidence: GitHubMergeEvidence | undefined,
  checks: CheckSummary,
): ReadonlyArray<MergeDisplayReason> {
  const aggregate =
    evidence ??
    (current === undefined
      ? undefined
      : {
          mergeable: current.mergeability,
          mergeStateStatus: "unavailable" as const,
          reviewDecision:
            current.reviewState === "approved"
              ? ("approved" as const)
              : current.reviewState === "changes_requested"
                ? ("changes_requested" as const)
                : current.reviewState === "review_pending"
                  ? ("review_required" as const)
                  : ("unknown" as const),
        });
  if (aggregate === undefined) return [];
  const protection = aggregate.policy?.branchProtection;
  // Only a positive classic branch-protection count matches an approval
  // requirement. Zero and rules that do not expose approval configuration are
  // unavailable evidence, not an exact policy claim.
  const requiredCount =
    protection?.state === "available" &&
    protection.value.requiredApprovingReviewCount !== undefined &&
    protection.value.requiredApprovingReviewCount > 0
      ? protection.value.requiredApprovingReviewCount
      : undefined;
  const policySource =
    requiredCount === undefined
      ? ("github_pr_state" as const)
      : ("branch_protection" as const);
  if (aggregate.reviewDecision === "review_required") {
    return [
      {
        code: "review_required",
        message:
          requiredCount === undefined
            ? "Approval required by GitHub."
            : `${requiredCount} approving review${requiredCount === 1 ? "" : "s"} required by branch protection.`,
        source: policySource,
        availability: requiredCount === undefined ? "partial" : "available",
        openOnGitHub: requiredCount === undefined,
      },
    ];
  }
  if (aggregate.reviewDecision === "changes_requested")
    return [
      {
        code: "changes_requested",
        message: "Changes requested.",
        source: "github_pr_state",
        availability: "available",
        openOnGitHub: false,
      },
    ];
  if (aggregate.mergeStateStatus === "behind")
    return [
      {
        code: "behind",
        message: "Update this branch with the base branch.",
        source: "github_pr_state",
        availability: "available",
        openOnGitHub: false,
      },
    ];
  if (
    aggregate.mergeStateStatus === "dirty" ||
    aggregate.mergeable === "conflicting"
  )
    return [
      {
        code: "conflicts",
        message: "Resolve merge conflicts.",
        source: "github_pr_state",
        availability: "available",
        openOnGitHub: false,
      },
    ];
  if (checks.overall === "failing")
    return [
      {
        code: "checks",
        message: "Required checks have not passed.",
        source: "checks",
        availability: "available",
        openOnGitHub: false,
      },
    ];
  if (
    aggregate.mergeStateStatus === "blocked" ||
    aggregate.mergeable === "blocked"
  )
    return [
      {
        code: "blocked",
        message: "GitHub merge requirements are not satisfied.",
        source: "github_pr_state",
        availability: requiredCount === undefined ? "partial" : "available",
        openOnGitHub: true,
      },
    ];
  return [];
}

function evaluateReadiness(
  current: PullRequestSummary,
  checks: CheckSummary,
  session: ReviewSession,
): MergeReadiness {
  const blockers: MergeReadiness["blockers"][number][] = [];
  if (current.headSha !== session.key.headSha) blockers.push("stale_head");
  if (!current.isOpen) blockers.push("closed");
  if (current.isDraft) blockers.push("draft");
  if (current.mergeability === "conflicting") blockers.push("conflicting");
  if (current.mergeability === "blocked") blockers.push("merge_blocked");
  if (current.mergeability === "unknown") blockers.push("mergeability_unknown");
  if (checks.overall === "failing") blockers.push("required_check");
  if (current.reviewState === "review_pending") blockers.push("github_review");
  const warnings: MergeReadiness["warnings"][number][] = [];
  if (current.reviewState === "changes_requested")
    warnings.push("request_changes");
  return {
    _tag:
      blockers.length > 0
        ? "Blocked"
        : warnings.length > 0
          ? "NeedsAcknowledgement"
          : "Ready",
    blockers,
    warnings,
  };
}

type StoredInsightRecords = {
  readonly analysis?: InsightRecord<RetainedInsight<ReviewResult>>;
  readonly walkthrough?: InsightRecord<RetainedInsight<NarrativeWalkthrough>>;
  readonly analysisScope?: InsightScopeProjection;
  readonly analysisArtifactStatus?: InsightArtifactStatus;
  readonly walkthroughArtifactStatus?: InsightArtifactStatus;
};

function projectStoredInsight<T>(
  record: InsightRecord<RetainedInsight<T>> | undefined,
  session: ReviewSession,
  patchHash: string | undefined,
  decorate: (value: T, record: InsightRecord<RetainedInsight<T>>) => T = (
    value,
  ) => value,
  scope?: InsightScopeProjection,
  artifactStatus?: InsightArtifactStatus,
): InsightProjection<T> {
  const retained =
    record?.retained === undefined
      ? undefined
      : {
          runId: record.retained.runId,
          sessionId: record.retained.revision.sessionId,
          headSha: record.retained.revision.headSha,
          generatedAt: record.retained.generatedAt,
          value: decorate(record.retained.value, record),
          ...(scope === undefined ? {} : { scope }),
        };
  if (record?.activeRun !== undefined) {
    return {
      status: "running",
      ...(artifactStatus === undefined ? {} : { artifactStatus }),
      ...(record.walkthroughProgress === undefined
        ? {}
        : { progress: record.walkthroughProgress }),
      ...(retained === undefined ? {} : { retained }),
      activeRun: {
        runId: record.activeRun.id,
        sessionId: record.activeRun.revision.sessionId,
        startedAt: record.activeRun.startedAt,
      },
    };
  }
  if (record?.replacementFailure !== undefined) {
    return {
      status: "failed",
      ...(artifactStatus === undefined ? {} : { artifactStatus }),
      ...(record.walkthroughProgress === undefined
        ? {}
        : { progress: record.walkthroughProgress }),
      ...(retained === undefined ? {} : { retained }),
      replacementFailure: {
        runId: record.replacementFailure.runId,
        ...(record.replacementFailure.category === undefined
          ? {}
          : { category: record.replacementFailure.category }),
        model: record.replacementFailure.model,
        reasoning: record.replacementFailure.reasoning,
        retryable: record.replacementFailure.retryable,
      },
    };
  }
  if (retained === undefined)
    return {
      status: "not_generated",
      ...(record?.walkthroughProgress === undefined
        ? {}
        : { progress: record.walkthroughProgress }),
    };
  const retainedRecord = record?.retained;
  const isCurrent =
    retainedRecord?.revision.sessionId === session.id &&
    retainedRecord.revision.headSha === session.key.headSha &&
    retainedRecord.revision.patchHash === patchHash;
  return {
    status: isCurrent ? "current" : "outdated",
    ...(artifactStatus === undefined ? {} : { artifactStatus }),
    ...(record?.walkthroughProgress === undefined
      ? {}
      : { progress: record.walkthroughProgress }),
    retained,
  };
}

function projectAnalysisFindings(
  value: ReviewResult,
  record: InsightRecord<RetainedInsight<ReviewResult>>,
): ReviewResult {
  const dismissed = new Set(
    (record.dismissals ?? []).map(
      (entry: InsightFindingDismissal) => entry.findingId,
    ),
  );
  return {
    ...value,
    findings: value.findings.map((finding) => ({
      ...finding,
      disposition: dismissed.has(finding.id) ? "dismissed" : "open",
    })),
  };
}

function parseRetainedBase(
  input: unknown,
): Result<RetainedInsight<unknown>, undefined> {
  const revision = readObjectField(input, "revision");
  const runId = parseInsightRunId(readObjectField(input, "runId"));
  const sessionId = parseReviewSessionId(
    readObjectField(revision, "sessionId"),
  );
  const headSha = parseGitSha(readObjectField(revision, "headSha"));
  const patchHash = parseContentHash(readObjectField(revision, "patchHash"));
  const generatedAt = parseIsoTimestamp(readObjectField(input, "generatedAt"));
  const provenance = parseRetainedProvenance(
    readObjectField(input, "provenance"),
  );
  if (
    [runId, sessionId, headSha, patchHash, generatedAt, provenance].some(
      (value) => value._tag === "err",
    )
  )
    return err(undefined);
  if (
    runId._tag === "err" ||
    sessionId._tag === "err" ||
    headSha._tag === "err" ||
    patchHash._tag === "err" ||
    generatedAt._tag === "err" ||
    provenance._tag === "err"
  )
    return err(undefined);
  return ok({
    runId: runId.value,
    revision: {
      sessionId: sessionId.value,
      headSha: headSha.value,
      patchHash: patchHash.value,
    },
    generatedAt: generatedAt.value,
    provenance: provenance.value,
    value: undefined,
  });
}

function parseRetainedProvenance(
  input: unknown,
): Result<InsightProvenance, undefined> {
  const provider = parseInsightProvider(readObjectField(input, "provider"));
  const model = readObjectField(input, "model");
  const reasoning = parseInsightReasoning(readObjectField(input, "reasoning"));
  return typeof model === "string" &&
    model.trim().length > 0 &&
    model.length <= 200 &&
    provider._tag === "ok" &&
    reasoning._tag === "ok"
    ? ok({ provider: provider.value, model, reasoning: reasoning.value })
    : err(undefined);
}

function parseRetainedAnalysis(
  input: unknown,
): Result<RetainedInsight<ReviewResult>, undefined> {
  const base = parseRetainedBase(input);
  if (base._tag === "err") return base;
  const value = parseReviewResult(readObjectField(input, "value"));
  return value._tag === "err"
    ? err(undefined)
    : ok({ ...base.value, value: value.value });
}

function parseRetainedWalkthrough(
  input: unknown,
  patch: string,
  profileId: WorkspaceProfileId,
): Result<RetainedInsight<NarrativeWalkthrough>, undefined> {
  const base = parseRetainedBase(input);
  if (base._tag === "err") return base;
  const normalized = normalizeNarrativeWalkthrough(
    readObjectField(input, "value"),
    patch,
    {
      profileId,
      sessionId: base.value.revision.sessionId,
      headSha: base.value.revision.headSha,
      patchHash: base.value.revision.patchHash,
    },
  );
  return normalized._tag === "err"
    ? err(undefined)
    : ok({ ...base.value, value: normalized.value });
}

/** Preserve bounded prose while removing coordinates that no longer have trusted bytes. */
function readableWalkthroughWithoutArtifact(
  input: unknown,
  profileId: WorkspaceProfileId,
  retained: RetainedInsight<unknown>,
): NarrativeWalkthrough {
  const raw =
    typeof input === "object" && input !== null
      ? (input as {
          readonly title?: unknown;
          readonly focus?: unknown;
          readonly chapters?: unknown;
        })
      : {};
  const chapters = Array.isArray(raw.chapters)
    ? raw.chapters.slice(0, 12).map((chapter, chapterIndex) => {
        const value =
          typeof chapter === "object" && chapter !== null
            ? (chapter as {
                readonly title?: unknown;
                readonly sections?: unknown;
              })
            : {};
        const sections = Array.isArray(value.sections)
          ? value.sections.slice(0, 32).map((section, sectionIndex) => {
              const item =
                typeof section === "object" && section !== null
                  ? (section as {
                      readonly title?: unknown;
                      readonly prose?: unknown;
                    })
                  : {};
              return {
                id: `section-${chapterIndex + 1}-${sectionIndex + 1}`,
                title: boundedArtifactText(item.title, 160, "Untitled section"),
                prose: boundedArtifactText(
                  item.prose,
                  4_000,
                  "Stored section text is unavailable.",
                ),
                hunkIds: [],
                hunks: [],
              };
            })
          : [];
        return {
          id: `chapter-${chapterIndex + 1}`,
          title: boundedArtifactText(value.title, 80, "Untitled chapter"),
          sections,
        };
      })
    : [];
  return {
    snapshot: { profileId, ...retained.revision },
    citationStatus: "unverified",
    title: boundedArtifactText(raw.title, 200, "Stored Walkthrough"),
    focus: boundedArtifactText(
      raw.focus,
      2_000,
      "Stored source evidence is unavailable.",
    ),
    chapters,
    support: { id: "support", title: "Support", hunkIds: [], hunks: [] },
  };
}

function boundedArtifactText(
  value: unknown,
  maxLength: number,
  fallback: string,
): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.slice(0, maxLength)
    : fallback;
}
