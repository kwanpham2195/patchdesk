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
  type InsightRunId,
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
  InsightStatus,
} from "../domain/insight";
import { parseUnifiedPatch } from "../domain/patch";
import {
  normalizeNarrativeWalkthrough,
  type NarrativeWalkthrough,
} from "../domain/narrative-walkthrough";
import type { MergeReadiness } from "../domain/merge-readiness";
import type {
  InsightFailureCategory,
  InsightFindingDismissal,
  InsightRecord,
  RetainedInsight,
  WalkthroughProgress,
} from "../domain/insight-record";
import {
  parseInsightProvider,
  parseInsightReasoning,
  type InsightProvenance,
  type InsightReasoning,
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
      | "fresh"
      | "updates_available"
      | "unavailable"
      | "not_refreshed";
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

/** Mutable draft of `ReviewWorkbenchProjection`, built in statements so each
 * optional field (`fullPatch`, `pullRequest`) is added only when it has a value. */
type MutableReviewWorkbenchProjection = {
  -readonly [K in keyof ReviewWorkbenchProjection]: ReviewWorkbenchProjection[K];
};
/** Mutable draft of `ReviewWorkbenchProjection["revision"]`, built in
 * statements so `patchHash`/`currentHeadSha` are added only when known. */
type MutableRevisionProjection = {
  -readonly [K in keyof ReviewWorkbenchProjection["revision"]]: ReviewWorkbenchProjection["revision"][K];
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

/** Live-read evidence `project` combines with the durable Session; absent when no GitHub read was attempted. */
type ProjectRemoteInput = {
  readonly current: Awaited<ReturnType<GitHubReader["getPullRequest"]>>;
  readonly conversation: Awaited<ReturnType<GitHubReader["loadConversation"]>>;
  readonly commits?: ReadonlyArray<PullRequestCommit>;
  readonly checks: Awaited<ReturnType<GitHubReader["getPullRequestChecks"]>>;
  readonly mergeEvidence?: GitHubMergeEvidence;
};
/** Mutable draft of `ProjectRemoteInput`, built in statements so the
 * optional `mergeEvidence` is added only when the snapshot carried one. */
type MutableProjectRemoteInput = {
  -readonly [K in keyof ProjectRemoteInput]: ProjectRemoteInput[K];
};

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
    const remote: MutableProjectRemoteInput = {
      current: { _tag: "ok", value: input.snapshot.pullRequest },
      conversation: ok(input.snapshot.conversation),
      commits: input.snapshot.commits,
      checks: { _tag: "ok", value: input.snapshot.checks },
    };
    if (input.snapshot.mergeEvidence !== undefined)
      remote.mergeEvidence = input.snapshot.mergeEvidence;
    return this.project(
      session.value.profile,
      session.value.session,
      remote,
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
    remote: ProjectRemoteInput | undefined,
    representedAt: IsoTimestamp,
    durableFreshness: ReviewFreshness,
    pendingReview?: {
      readonly state: PendingReviewState;
      readonly unavailable: boolean;
    },
  ): Promise<Result<ReviewWorkbenchProjection, WorkbenchProjectionFailure>> {
    const [fullPatch, storedInsights] = await Promise.all([
      readFile(session.patchPath, "utf8").catch(() => undefined),
      this.loadStoredInsights(session),
    ]);
    if (storedInsights._tag === "err") return storedInsights;
    const rawPatchHash =
      fullPatch === undefined
        ? undefined
        : createHash("sha256").update(fullPatch).digest("hex");
    // SAFETY: `createHash("sha256").digest("hex")` always yields a
    // 64-character lowercase hex string, which already satisfies
    // ContentHash's runtime shape (`parseContentHash` checks exactly
    // `/^[a-f0-9]{64}$/`).
    const patchHash =
      rawPatchHash === undefined ? undefined : (rawPatchHash as ContentHash);

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
    const stableReview = await this.reviews.load(
      session.key.profileId,
      reviewId,
    );
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
    )
      return err({ _tag: "SessionStorageUnavailable" });
    const reviewStatus =
      stableReview.value.status._tag === "Terminal"
        ? stableReview.value.status.state
        : ("open" as const);

    const analysisReviewActions = projectAnalysisReviewActions({
      analysis,
      session,
      freshness,
      patchHash,
      pendingReview: pendingReview?.state ?? session.pendingReview,
    });

    const revision: MutableRevisionProjection = {
      reviewedHeadSha: session.key.headSha,
      freshness,
      refreshedAt,
    };
    if (patchHash !== undefined) revision.patchHash = patchHash;
    if (currentHeadSha !== undefined) revision.currentHeadSha = currentHeadSha;

    const projection: MutableReviewWorkbenchProjection = {
      state: "review",
      review: { id: reviewId, status: reviewStatus },
      session: projectSession(session),
      revision,
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
    };
    if (fullPatch !== undefined) projection.fullPatch = fullPatch;
    if (pullRequest !== undefined) projection.pullRequest = pullRequest;
    return ok(projection);
  }

  private async loadStoredInsights(
    session: ReviewSession,
  ): Promise<Result<StoredInsightRecords, WorkbenchProjectionFailure>> {
    // A retained Walkthrough belongs to the Session that produced it. Never
    // validate it against the currently represented Session's patch: Refresh
    // intentionally changes that artifact while old reading evidence remains.
    const [analysis, walkthrough] = await Promise.all([
      this.insights.loadTyped(
        session.key.profileId,
        createReviewId(session.key),
        "analysis",
        parseRetainedAnalysis,
      ),
      this.loadWalkthroughRecord(session),
    ]);
    // A corrupt or schema-drifted Insight record is ignored: the Review still
    // opens and the Insight reads as not generated, so a re-run heals it.
    if (
      analysis._tag === "err" &&
      analysis.error.reason !== "not_found" &&
      analysis.error.reason !== "invalid_stored_value"
    )
      return err({ _tag: "SessionStorageUnavailable" });
    if (
      walkthrough._tag === "err" &&
      walkthrough.error.reason !== "not_found" &&
      walkthrough.error.reason !== "invalid_stored_value"
    )
      return err({ _tag: "SessionStorageUnavailable" });
    const analysisArtifact =
      analysis._tag === "ok" && analysis.value.retained !== undefined
        ? await this.readInsightScope(
            session.key.profileId,
            analysis.value.retained,
          )
        : undefined;
    const records: MutableStoredInsightRecords = {};
    if (analysis._tag === "ok") records.analysis = analysis.value;
    if (walkthrough._tag === "ok")
      records.walkthrough = walkthrough.value.record;
    if (analysisArtifact?.scope !== undefined)
      records.analysisScope = analysisArtifact.scope;
    if (analysisArtifact?.artifactStatus !== undefined)
      records.analysisArtifactStatus = analysisArtifact.artifactStatus;
    if (
      walkthrough._tag === "ok" &&
      walkthrough.value.artifactStatus !== undefined
    )
      records.walkthroughArtifactStatus = walkthrough.value.artifactStatus;
    return ok(records);
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
      {
        readonly reason: "not_found" | "invalid_stored_value" | "storage";
      }
    >
  > {
    const loaded = await this.insights.load(
      session.key.profileId,
      createReviewId(session.key),
      "walkthrough",
    );
    if (loaded._tag === "err") {
      if (loaded.error.reason === "not_found")
        return err({ reason: "not_found" });
      if (loaded.error.reason === "invalid_stored_value")
        return err({ reason: "invalid_stored_value" });
      return err({ reason: "storage" });
    }
    if (loaded.value.retained === undefined) {
      // SAFETY: `loaded.value.retained` is undefined here, so the generic
      // `RetainedInsight<NarrativeWalkthrough>` parameter names no runtime
      // data this branch actually inspects; only the `retained?` field's
      // absence, which is what the check above already confirmed, matters.
      return ok({
        record: loaded.value as InsightRecord<
          RetainedInsight<NarrativeWalkthrough>
        >,
      });
    }
    const base = parseRetainedBase(loaded.value.retained);
    if (base._tag === "err") return err({ reason: "invalid_stored_value" });
    const fallback = (): Result<
      {
        readonly record: InsightRecord<RetainedInsight<NarrativeWalkthrough>>;
        readonly artifactStatus: InsightArtifactStatus;
      },
      {
        readonly reason: "not_found" | "invalid_stored_value" | "storage";
      }
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

// Ordering: most-actionable-first. A maintainer reading this list top to
// bottom sees the reasons whose next action is on them (get another review,
// address feedback, resolve a named rule, update the branch, resolve
// conflicts, wait on a check) before reasons that are purely informational
// (has_hooks, unstable) or, worse, admittedly vague (the generic blocked
// fallback). The fallback is pushed last and only when nothing more specific
// was already collected, so it never buries a real answer under a vague one.
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

  const branchProtection = aggregate.policy?.branchProtection;
  // Only a positive classic branch-protection count matches an approval
  // requirement. Zero and rules that do not expose approval configuration are
  // unavailable evidence, not an exact policy claim.
  const classicCount =
    branchProtection?.state === "available" &&
    branchProtection.value.requiredApprovingReviewCount !== undefined &&
    branchProtection.value.requiredApprovingReviewCount > 0
      ? branchProtection.value.requiredApprovingReviewCount
      : undefined;

  const appliedRuleset = aggregate.policy?.appliedRuleset;
  const pullRequestRule =
    appliedRuleset?.state === "available"
      ? appliedRuleset.value.rules.find(
          (rule) => rule.pullRequestParameters !== undefined,
        )?.pullRequestParameters
      : undefined;
  // Same "only a positive count is evidence" rule as classic protection.
  const rulesetCount =
    pullRequestRule?.requiredApprovingReviewCount !== undefined &&
    pullRequestRule.requiredApprovingReviewCount > 0
      ? pullRequestRule.requiredApprovingReviewCount
      : undefined;
  // Ruleset evidence is preferred: on a repo governed by Rulesets the classic
  // `branches/{branch}/protection` endpoint legitimately 404s, so a
  // ruleset-sourced count is the more direct evidence when both exist.
  const requiredCount = rulesetCount ?? classicCount;
  const requiredCountSource =
    rulesetCount !== undefined
      ? ("ruleset_configuration" as const)
      : ("branch_protection" as const);

  const policyReadable =
    branchProtection?.state === "available" ||
    appliedRuleset?.state === "available";
  const blocked =
    aggregate.mergeStateStatus === "blocked" ||
    aggregate.mergeable === "blocked";

  const reasons: MergeDisplayReason[] = [];

  // `reviewDecision` reconciliation: GraphQL `reviewDecision` stays the gate
  // for whether a review is outstanding at all. It reflects live
  // approval/dismissal state that no static ruleset field can express, and a
  // live probe found it can under-report on a ruleset-governed repo (null,
  // mapped to "unknown", on a PR that already had a genuine approving review
  // from a non-last-pusher) — never over-report a requirement ruleset config
  // says doesn't exist. So ruleset evidence never invents a review
  // requirement by itself (this branch is still gated strictly on
  // `reviewDecision === "review_required"`) and never overrides an
  // "approved" decision; it only supplies a higher-confidence count/source
  // once the gate already says a review is outstanding.
  if (aggregate.reviewDecision === "review_required") {
    reasons.push({
      code: "review_required",
      message:
        requiredCount === undefined
          ? "Approval required by GitHub."
          : `${requiredCount} approving review${requiredCount === 1 ? "" : "s"} required by ${requiredCountSource === "ruleset_configuration" ? "ruleset configuration" : "branch protection"}.`,
      source:
        requiredCount === undefined ? "github_pr_state" : requiredCountSource,
      availability: requiredCount === undefined ? "partial" : "available",
      openOnGitHub: requiredCount === undefined,
    });
  } else if (aggregate.reviewDecision === "changes_requested") {
    reasons.push({
      code: "changes_requested",
      message: "Changes requested.",
      source: "github_pr_state",
      availability: "available",
      openOnGitHub: false,
    });
  }

  // GitHub says blocked and the ruleset says why: name the specific rules,
  // matching what GitHub's own UI renders for each.
  if (blocked && pullRequestRule?.requireLastPushApproval === true)
    reasons.push({
      code: "review_required",
      message:
        "New changes require approval from someone other than the last pusher.",
      source: "ruleset_configuration",
      availability: "available",
      openOnGitHub: false,
    });
  if (blocked && pullRequestRule?.requiredReviewThreadResolution === true)
    reasons.push({
      code: "blocked",
      message: "All review threads must be resolved before this can merge.",
      source: "ruleset_configuration",
      availability: "available",
      openOnGitHub: false,
    });

  if (aggregate.mergeStateStatus === "behind")
    reasons.push({
      code: "behind",
      message: "Update this branch with the base branch.",
      source: "github_pr_state",
      availability: "available",
      openOnGitHub: false,
    });

  if (
    aggregate.mergeStateStatus === "dirty" ||
    aggregate.mergeable === "conflicting"
  )
    reasons.push({
      code: "conflicts",
      message: "Resolve merge conflicts.",
      source: "github_pr_state",
      availability: "available",
      openOnGitHub: false,
    });

  if (checks.overall === "failing")
    reasons.push({
      code: "checks",
      message: "Required checks have not passed.",
      source: "checks",
      availability: "available",
      openOnGitHub: false,
    });

  // Both fall through GitHub's own `mergeStateStatus` without blocking the
  // merge; say so honestly instead of staying silent.
  if (aggregate.mergeStateStatus === "has_hooks")
    reasons.push({
      code: "blocked",
      message:
        "GitHub reports this pull request is mergeable; a required pre-receive hook has already run and passed.",
      source: "github_pr_state",
      availability: "available",
      openOnGitHub: false,
    });

  if (aggregate.mergeStateStatus === "unstable")
    reasons.push({
      code: "blocked",
      message:
        "GitHub reports non-required checks are failing. Required checks are passing, so this does not block the merge.",
      source: "github_pr_state",
      availability: "available",
      openOnGitHub: false,
    });

  // The generic fallback only fires when GitHub reports blocked and nothing
  // above already explained why — including the two named rules above, but
  // also any review/checks reason from another axis, since a maintainer
  // shown a specific reason does not need an additional vague one.
  if (blocked && reasons.length === 0)
    reasons.push({
      code: "blocked",
      message: policyReadable
        ? "GitHub reports this merge is blocked, but none of the readable merge rules explain why."
        : "Patchdesk could not read this repository's merge rules, so it cannot say why GitHub blocked this merge.",
      source: "github_pr_state",
      availability: policyReadable ? "available" : "partial",
      openOnGitHub: true,
    });

  return reasons;
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
/** Mutable draft of `StoredInsightRecords`, built in statements so each
 * optional field is added only when storage actually held it. */
type MutableStoredInsightRecords = {
  -readonly [K in keyof StoredInsightRecords]: StoredInsightRecords[K];
};

/** Mutable draft of `InsightProjection`, built in statements so each
 * optional field is added only when it has a value. */
type MutableInsightProjection<T> = {
  status: InsightStatus;
  artifactStatus?: InsightArtifactStatus;
  retained?: MutableRetainedProjection<T>;
  progress?: WalkthroughProgress;
  activeRun?: {
    runId?: InsightRunId;
    sessionId: ReviewSessionId;
    startedAt: IsoTimestamp;
  };
  replacementFailure?: MutableReplacementFailureProjection;
};
/** Mutable draft of `InsightProjection["retained"]`, built in statements so
 * the optional `scope` is added only when the caller supplied one. */
type MutableRetainedProjection<T> = {
  runId?: InsightRunId;
  sessionId: ReviewSessionId;
  headSha: GitSha;
  generatedAt: IsoTimestamp;
  value: T;
  scope?: InsightScopeProjection;
};
/** Mutable draft of `InsightProjection["replacementFailure"]`, built in
 * statements so the optional `category` is added only when known. */
type MutableReplacementFailureProjection = {
  runId?: InsightRunId;
  category?: InsightFailureCategory;
  model: string;
  reasoning: InsightReasoning;
  retryable: boolean;
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
  let retained: MutableRetainedProjection<T> | undefined;
  if (record?.retained !== undefined) {
    retained = {
      runId: record.retained.runId,
      sessionId: record.retained.revision.sessionId,
      headSha: record.retained.revision.headSha,
      generatedAt: record.retained.generatedAt,
      value: decorate(record.retained.value, record),
    };
    if (scope !== undefined) retained.scope = scope;
  }
  if (record?.activeRun !== undefined) {
    const projection: MutableInsightProjection<T> = {
      status: "running",
      activeRun: {
        runId: record.activeRun.id,
        sessionId: record.activeRun.revision.sessionId,
        startedAt: record.activeRun.startedAt,
      },
    };
    if (artifactStatus !== undefined) projection.artifactStatus = artifactStatus;
    if (record.walkthroughProgress !== undefined)
      projection.progress = record.walkthroughProgress;
    if (retained !== undefined) projection.retained = retained;
    return projection;
  }
  if (record?.replacementFailure !== undefined) {
    const replacementFailure: MutableReplacementFailureProjection = {
      runId: record.replacementFailure.runId,
      model: record.replacementFailure.model,
      reasoning: record.replacementFailure.reasoning,
      retryable: record.replacementFailure.retryable,
    };
    if (record.replacementFailure.category !== undefined)
      replacementFailure.category = record.replacementFailure.category;
    const projection: MutableInsightProjection<T> = {
      status: "failed",
      replacementFailure,
    };
    if (artifactStatus !== undefined) projection.artifactStatus = artifactStatus;
    if (record.walkthroughProgress !== undefined)
      projection.progress = record.walkthroughProgress;
    if (retained !== undefined) projection.retained = retained;
    return projection;
  }
  if (retained === undefined) {
    const projection: MutableInsightProjection<T> = { status: "not_generated" };
    if (record?.walkthroughProgress !== undefined)
      projection.progress = record.walkthroughProgress;
    return projection;
  }
  const retainedRecord = record?.retained;
  const isCurrent =
    retainedRecord?.revision.sessionId === session.id &&
    retainedRecord.revision.headSha === session.key.headSha &&
    retainedRecord.revision.patchHash === patchHash;
  const projection: MutableInsightProjection<T> = {
    status: isCurrent ? "current" : "outdated",
    retained,
  };
  if (artifactStatus !== undefined) projection.artifactStatus = artifactStatus;
  if (record?.walkthroughProgress !== undefined)
    projection.progress = record.walkthroughProgress;
  return projection;
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
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser for a retained Insight record's shared fields; there is no earlier boundary to run it at.
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
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser for a retained Insight's provenance field; there is no earlier boundary to run it at.
  input: unknown,
): Result<InsightProvenance, undefined> {
  const provider = parseInsightProvider(readObjectField(input, "provider"));
  const model = readObjectField(input, "model");
  const reasoning = parseInsightReasoning(readObjectField(input, "reasoning"));
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field (from readObjectField, typed unknown) at this exact I/O boundary; no earlier parser exists for this primitive shape.
  return typeof model === "string" &&
    model.trim().length > 0 &&
    model.length <= 200 &&
    provider._tag === "ok" &&
    reasoning._tag === "ok"
    ? ok({ provider: provider.value, model, reasoning: reasoning.value })
    : err(undefined);
}

function parseRetainedAnalysis(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser for a retained analysis Insight; there is no earlier boundary to run it at.
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
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser for a retained Walkthrough Insight; there is no earlier boundary to run it at.
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
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser for a degraded, artifact-less Walkthrough salvage; there is no earlier boundary to run it at.
  input: unknown,
  profileId: WorkspaceProfileId,
  retained: RetainedInsight<unknown>,
): NarrativeWalkthrough {
  // SAFETY: the `typeof`/`!== null` check below already confirms `input` is
  // a non-null object before the assertion narrows its field types to
  // `unknown` for the bounded reads that follow; it does not assert their
  // contents.
  const raw =
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw stored JSON at this exact I/O boundary predicate; no earlier parser exists for this primitive shape.
    typeof input === "object" && input !== null
      ? (input as {
          readonly title?: unknown;
          readonly focus?: unknown;
          readonly chapters?: unknown;
        })
      : {};
  const chapters = Array.isArray(raw.chapters)
    ? raw.chapters.slice(0, 12).map((chapter, chapterIndex) => {
        // SAFETY: the `typeof`/`!== null` check below already confirms
        // `chapter` is a non-null object before the assertion narrows its
        // field types to `unknown` for the bounded reads that follow; it
        // does not assert their contents.
        const value =
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw stored JSON at this exact I/O boundary predicate; no earlier parser exists for this primitive shape.
          typeof chapter === "object" && chapter !== null
            ? (chapter as {
                readonly title?: unknown;
                readonly sections?: unknown;
              })
            : {};
        const sections = Array.isArray(value.sections)
          ? value.sections.slice(0, 32).map((section, sectionIndex) => {
              // SAFETY: the `typeof`/`!== null` check below already
              // confirms `section` is a non-null object before the
              // assertion narrows its field types to `unknown` for the
              // bounded reads that follow; it does not assert their
              // contents.
              const item =
                // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw stored JSON at this exact I/O boundary predicate; no earlier parser exists for this primitive shape.
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
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser for one stored prose field; there is no earlier boundary to run it at.
  value: unknown,
  maxLength: number,
  fallback: string,
): string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field at this exact I/O boundary; no earlier parser exists for this primitive shape.
  return typeof value === "string" && value.trim().length > 0
    ? value.slice(0, maxLength)
    : fallback;
}
